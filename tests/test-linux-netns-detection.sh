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
  ip netns del "$target" 2>/dev/null || true
  ip netns del "$prefix" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

# ip netns usa este caminho fixo; o mount namespace mantém a operação isolada do host.
mount --make-rprivate /
mount -t tmpfs golive-netns-test /run/netns
mount -t tmpfs golive-netns-config /etc/netns

# Carrega exatamente o helper do standalone, sem executar o restante do instalador.
awk '/^netns_exists\(\) \{/{capture=1} capture {print} capture && /^}/{exit}' \
  "$root/standalone/golivebypass-standalone.sh" > "$work/helper.sh"
awk '/^teardown_wireguard_netns\(\) \{/{capture=1} capture {print} capture && /^}/{exit}' \
  "$root/standalone/golivebypass-standalone.sh" >> "$work/helper.sh"
source "$work/helper.sh"
step() { :; }
ok() { :; }
elevate() { "$@"; }

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

printf 'Linux netns detection: pure name, NSID, prefix rejection, reuse and teardown — OK\n'
