#!/usr/bin/env bash
# Verifica a detecção do namespace WireGuard em um mount/net namespace descartável.
# Nenhuma entrada de /run/netns do host é usada.
set -euo pipefail

root=$(cd -- "$(dirname -- "$0")/.." && pwd)
if [[ ${1:-} != --isolated ]]; then
  exec unshare -Urnm bash "$0" --isolated
fi

# Uma chamada manual com --isolated não pode operar no namespace do host.
if [[ $(readlink /proc/1/ns/mnt) == $(readlink /proc/self/ns/mnt) || \
      $(readlink /proc/1/ns/net) == $(readlink /proc/self/ns/net) ]]; then
  printf 'teste abortado: mount/network namespace não está isolado\n' >&2
  exit 1
fi

work=$(mktemp -d)
target="golive-netns-test-$$"
prefix="${target}-old"
cleanup() {
  [ -n "${glb_pid:-}" ] && kill "$glb_pid" 2>/dev/null || true
  [ -n "${glb_launcher:-}" ] && kill "$glb_launcher" 2>/dev/null || true
  ip netns del "$target" 2>/dev/null || true
  ip netns del "$prefix" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

# Carrega a implementacao do standalone antes de cobrir /run com tmpfs (o repo pode
# viver sob /run/media e o helper precisa continuar acessivel no mount namespace).
STANDALONE_SRC="$work/standalone.sh"
cp "$root/standalone/golivebypass-standalone.sh" "$STANDALONE_SRC"

# ip netns usa este caminho fixo; o mount namespace mantém a operação isolada do host.
mount --make-rprivate /
mount -t tmpfs golive-netns-test /run
mkdir -p /run/netns /etc/netns
mount -t tmpfs golive-netns-test-ns /run/netns
mount -t tmpfs golive-netns-config /etc/netns

# Carrega exatamente os helpers do standalone: deteccao por lista, por identidade
# nsfs e teardown autoritativo (as funcoes que dependem de resolve_binary nao
# sao chamadas aqui).
sed -n '/^# \/var\/run\/netns pode ser 0700/,/^# ---------------------------------------------------------------------------/p' \
  "$STANDALONE_SRC" | sed '$d' > "$work/helper.sh"
# O teardown real passou a encerrar tambem o daemon do WireGuard de usuario: o bloco inteiro
# entra no helper (as funcoes que dependem de resolve_binary nao sao chamadas aqui).
sed -n '/^# ======================= WireGuard de usuario (wireguard-go)/,/^# O preflight nao carrega o modulo:/p' \
  "$STANDALONE_SRC" | sed '$d' >> "$work/helper.sh"
awk '/^teardown_wireguard_netns\(\) \{/{capture=1} capture {print} capture && /^}/{exit}' \
  "$STANDALONE_SRC" >> "$work/helper.sh"
source "$work/helper.sh"
step() { :; }
ok() { :; }
elevate() { "$@"; }

# Sem daemon iniciado neste teste, o pidfile nao existe e o encerramento sai imediato.
INSTALL_DIR="$work/dados"

NETNS_NAME="$target"
ip netns add "$prefix"
if netns_exists; then
  printf 'prefixo de namespace aceito indevidamente\n' >&2
  exit 1
fi

# O formato normal não traz NSID; a guarda deve permitir a reutilização. O ciclo
# também chama o teardown real do standalone, dez vezes, para detectar resíduos.
for cycle in {1..10}; do
  ip netns add "$target"
  [[ $(ip netns list) == *"$target"* ]]
  if ! netns_exists; then
    ip netns add "$target"
  fi

  # Com NSID, iproute2 acrescenta "(id: N)" ao primeiro campo.
  if [[ "$cycle" -eq 1 ]]; then
    ip netns set "$target" 42
    ip netns list | grep -Fq "$target (id: 42)"
  fi
  netns_exists

  teardown_wireguard_netns
  ! netns_exists
  teardown_wireguard_netns
done

# #449: com /run/netns 0700, `ip netns list` como usuario nao enumera o namespace.
# A identidade gravada na ativacao prova o namespace por um processo, sem root.
ip netns add "$target"
ip netns exec "$target" sh -c 'echo $$ > "$1"; exec sleep 60' sh "$work/pid" &
glb_launcher=$!
for _ in $(seq 1 50); do
  if [ -s "$work/pid" ]; then break; fi
  sleep 0.1
done
glb_pid="$(cat "$work/pid")"
glb_ident="$(stat -L -c '%d:%i' "/proc/$glb_pid/ns/net")"
mkdir -p "$INSTALL_DIR"
printf '%s\n' "$glb_ident" > "$INSTALL_DIR/netns.inode"
chmod 700 /run/netns
IP_BINARY=/bin/false
if ! netns_exists; then
  printf 'netns ativo nao detectado por identidade com /run/netns 0700\n' >&2
  exit 1
fi
if ! netns_identity_pid_matches "$glb_ident"; then
  printf 'identidade nsfs do processo nao confere\n' >&2
  exit 1
fi
unset IP_BINARY
kill "$glb_pid" "$glb_launcher" 2>/dev/null || true
teardown_wireguard_netns
if netns_exists; then
  printf 'teardown deixou o namespace ativo\n' >&2
  exit 1
fi

printf 'Linux netns detection: pure name, NSID, prefix rejection, reuse and teardown — OK\n'
