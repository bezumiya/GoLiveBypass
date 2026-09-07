#!/usr/bin/env bash
# Executor opt-in para VMs libvirt preparadas pelo laboratorio. Ele nao cria
# imagens, nao instala uma distribuicao no host e nao recebe tokens Proton.
#
# Uso:
#   ./tests/test-linux-vm.sh --list
#   VM_DOMAIN=golive-ubuntu-24.04 ./tests/test-linux-vm.sh --quick
#   VM_DOMAIN=golive-fedora-43 VM_INSTALL=1 ./tests/test-linux-vm.sh --full
#   VM_DOMAIN=golive-debian-12 PROTON_VM_HOOK=./lab/proton-hook ./tests/test-linux-vm.sh --full
#
# A sessao Premium, quando usada, fica sob responsabilidade do hook local. O
# hook recebe apenas <domain> <ssh-target>; nunca recebe uma chave ou e gravado
# pelo executor.

set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "$0")/.." && pwd)"
MODE="quick"
VM_DOMAIN="${VM_DOMAIN:-}"
VM_USER="${VM_USER:-golive}"
VM_HOST="${VM_HOST:-}"
VM_PORT="${VM_PORT:-22}"
VM_INSTALL="${VM_INSTALL:-0}"
VM_SSH_KEY="${VM_SSH_KEY:-}"
PROTON_VM_HOOK="${PROTON_VM_HOOK:-}"
KEEP_VM="${KEEP_VM:-1}"
PASS=0
FAIL=0
SKIP=0

usage() {
    cat >&2 <<'USAGE'
Uso: tests/test-linux-vm.sh [--list] [--quick|--full]

  --list                    lista dominios libvirt golive-* e sai
  --quick                   preflight + compatibilidade (padrao)
  --full                    inclui --ensure-dependencies dentro da VM

Variaveis:
  VM_DOMAIN=NAME            dominio libvirt; sem ele usa golive-* em execucao
  VM_USER=USER              usuario SSH da VM (padrao: golive)
  VM_HOST=ADDRESS           endereco; sem ele tenta virsh domifaddr --source agent
  VM_PORT=PORT              porta SSH (padrao: 22)
  VM_INSTALL=0|1             atalho para quick/full
  VM_SSH_KEY=FILE            chave SSH opcional (nao e lida nem exibida)
  PROTON_VM_HOOK=FILE        hook local para a sessao Premium (opcional)
USAGE
}

LIST_ONLY=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        --list) LIST_ONLY=1 ;;
        --quick) MODE=quick ;;
        --full) MODE=full ;;
        -h|--help) usage; exit 0 ;;
        *) printf 'Opcao desconhecida: %s\n' "$1" >&2; usage; exit 2 ;;
    esac
    shift
done
[[ "$VM_INSTALL" == "1" ]] && MODE=full

command -v virsh >/dev/null 2>&1 || { printf 'virsh nao encontrado; VM runner omitido.\n' >&2; exit 2; }

mapfile -t ALL_DOMAINS < <(virsh list --all --name 2>/dev/null | sed '/^[[:space:]]*$/d')
if (( LIST_ONLY )); then
    printf '%s\n' "${ALL_DOMAINS[@]}" | sed '/^$/d'
    exit 0
fi

if [[ -n "$VM_DOMAIN" ]]; then
    DOMAINS=("$VM_DOMAIN")
else
    DOMAINS=()
    for domain in "${ALL_DOMAINS[@]}"; do
        [[ "$domain" == golive-* ]] && DOMAINS+=("$domain")
    done
fi
if ((${#DOMAINS[@]} == 0)); then
    printf '[SKIP] nenhuma VM registrada (prepare dominios golive-* antes do laboratorio)\n' >&2
    exit 0
fi

HOST_DEFAULT_ROUTE=""
if command -v ip >/dev/null 2>&1; then
    HOST_DEFAULT_ROUTE="$(ip -o route show default 2>/dev/null || true)"
fi

log() { printf '%s\n' "$*" >&2; }
ok() { PASS=$((PASS + 1)); log "  [OK] $*"; }
bad() { FAIL=$((FAIL + 1)); log "  [FAIL] $*"; }
skip() { SKIP=$((SKIP + 1)); log "  [SKIP] $*"; }

ssh_options=(-o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new)
[[ -n "$VM_SSH_KEY" ]] && ssh_options+=(-i "$VM_SSH_KEY")
ssh_run() {
    local target="$1"; shift
    ssh "${ssh_options[@]}" -p "$VM_PORT" "$target" "$@"
}

resolve_host() {
    local domain="$1" address
    if [[ -n "$VM_HOST" ]]; then
        printf '%s\n' "$VM_HOST"
        return 0
    fi
    address="$(virsh domifaddr "$domain" --source agent 2>/dev/null | awk '/ipv4/ { sub(/\/.*/, "", $4); print $4; exit }')"
    [[ -n "$address" ]] || return 1
    printf '%s\n' "$address"
}

remote_fixture() {
    local target="$1" remote_root="$2"
    ssh_run "$target" "mkdir -p '$remote_root/home/.config/discord/app-9.9.9/resources' && printf 'vm fixture\\n' > '$remote_root/home/.config/discord/app-9.9.9/resources/app.asar'"
}

remote_script() {
    local target="$1" remote_root="$2"
    # Transfere somente o shell e o runner de preflight. O AppImage, se usado,
    # e copiado separadamente pelo chamador e removido ao final.
    tar -C "$ROOT" -czf - standalone/golivebypass-standalone.sh | \
        ssh "${ssh_options[@]}" -p "$VM_PORT" "$target" "mkdir -p '$remote_root/repo' && tar -xzf - -C '$remote_root/repo'"
}

run_domain() {
    local domain="$1" host target remote_root preflight post appimage_remote
    remote_root="/tmp/golive-vm-${USER:-runner}-$$"
    if ! host="$(resolve_host "$domain")"; then
        skip "$domain sem endereco via virsh agent (defina VM_HOST)"
        return
    fi
    target="$VM_USER@$host"
    if ! virsh domstate "$domain" 2>/dev/null | grep -qi running; then
        skip "$domain desligada (o runner nao inicia VMs automaticamente)"
        return
    fi
    log "== VM $domain ($target, modo=$MODE) =="
    if ! ssh_run "$target" true >/dev/null 2>&1; then
        bad "$domain SSH indisponivel"
        return
    fi
    if ! remote_script "$target" "$remote_root"; then
        bad "$domain nao recebeu o shell"
        return
    fi
    if ! remote_fixture "$target" "$remote_root"; then
        bad "$domain nao criou fixture Discord"
        return
    fi

    if ! preflight="$(ssh_run "$target" "GOLIVE_GUI=1 HOME='$remote_root/home' '$remote_root/repo/standalone/golivebypass-standalone.sh' --real-home '$remote_root/home' --preflight --json" 2>&1)"; then
        bad "$domain preflight falhou: $(printf '%s' "$preflight" | tail -5 | tr '\n' ' ')"
    elif printf '%s' "$preflight" | grep -q '"platform":"linux"' && printf '%s' "$preflight" | grep -q '"required":\["wg","ip","curl"\]'; then
        ok "$domain preflight Linux"
    else
        bad "$domain preflight sem contrato esperado"
    fi

    if [[ "$MODE" == "full" ]]; then
        if post="$(ssh_run "$target" "GOLIVE_GUI=1 HOME='$remote_root/home' '$remote_root/repo/standalone/golivebypass-standalone.sh' --real-home '$remote_root/home' --ensure-dependencies" 2>&1)"; then
            ok "$domain reparo de dependencias"
            if printf '%s' "$post" | grep -q 'Dependencias Linux instaladas e verificadas'; then
                ok "$domain comandos wg/ip/curl verificados"
            else
                bad "$domain reparo nao confirmou os comandos"
            fi
        else
            bad "$domain reparo falhou: $(printf '%s' "$post" | tail -8 | tr '\n' ' ')"
        fi
    else
        skip "$domain reparo omitido (--quick)"
    fi

    if [[ -n "$PROTON_VM_HOOK" ]]; then
        if [[ -x "$PROTON_VM_HOOK" ]]; then
            if "$PROTON_VM_HOOK" "$domain" "$target"; then
                ok "$domain hook Premium concluido (resultado mantido no laboratorio)"
            else
                bad "$domain hook Premium retornou erro"
            fi
        else
            bad "PROTON_VM_HOOK nao e executavel: $PROTON_VM_HOOK"
        fi
    else
        skip "$domain sessao Premium nao executada (defina PROTON_VM_HOOK)"
    fi

    # A verificacao da rota do host e sempre local e informativa; a VM nao pode
    # substituir a rota default do host para simular isolamento por aplicativo.
    if command -v ip >/dev/null 2>&1; then
        local after_route
        after_route="$(ip -o route show default 2>/dev/null || true)"
        if [[ "$after_route" == "$HOST_DEFAULT_ROUTE" ]]; then
            ok "$domain rota default do host preservada"
        else
            bad "$domain alterou a rota default do host"
        fi
    fi

    # Nunca deixa credenciais, perfis ou artefatos de sessao na VM.
    ssh_run "$target" "rm -rf '$remote_root'" >/dev/null 2>&1 || log "  [WARN] limpeza remota pendente em $domain"
}

for domain in "${DOMAINS[@]}"; do
    run_domain "$domain"
done

log "== Resultado VM: $PASS ok, $FAIL falhas, $SKIP skips =="
((FAIL == 0))
