#!/bin/sh
# Regressão da #416: Discord Flatpak (Bazzite) aberto dentro do namespace WireGuard,
# mas a ativação esperava 20 s, dizia "uma instancia ficou fora do namespace" e
# fechava o cliente.
#
# O `flatpak ps` do reporter tinha duas instâncias de com.discordapp.Discord: uma
# mais nova fora do namespace, listada primeiro (child-pid 38747, sem netns), e a
# principal dentro (38712, `ip netns identify` = discord-vpn). A confirmação lia só a
# primeira linha do `flatpak ps`. O que se prova aqui, hermeticamente (flatpak, ip e
# stat são shims):
#
#   1. com instâncias fora listadas antes da principal, a espera confirma;
#   2. o status reporta inNamespace com o PID da instância que está no namespace;
#   3. sem nenhuma instância no namespace, a espera falha como fora-do-namespace e o
#      `flatpak ps` vai para o log com o marcador que a mensagem de falha ignora;
#   4. o fallback para a coluna pid (Flatpak antigo sem child-pid) continua valendo.
#
# Uso: sh tests/test-linux-flatpak-instancias-netns.sh

set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$ROOT/standalone/golivebypass-standalone.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail=0
ok() { printf '  [OK] %s\n' "$1"; }
bad() { printf '  [FALHA] %s\n' "$1"; fail=1; }

extract() {
    sed -n "/^$1() {/,/^}/p" "$SCRIPT"
}

FUNCS="normalize_pid flatpak_pid_for_id flatpak_pids_for_id discord_pid_flav discord_pid_in_netns \
discord_pid_in_netns_elevated discord_netns_pid_flav wait_discord_started falha_lancamento_mensagem"
for fn in $FUNCS; do
    if [ -z "$(extract "$fn")" ]; then
        printf '  [FALHA] nao extraí a função %s do standalone\n' "$fn"
        exit 1
    fi
done

HARNESS="$TMP/harness.sh"
{
    cat <<'EOF'
#!/bin/bash
set -u
have() { case "$1" in flatpak|ip|stat) return 0 ;; *) return 1 ;; esac; }
id() { [ "${1:-}" = -u ] && { printf '1000\n'; return 0; }; command id "$@"; }
sleep() { :; }
elevate() { printf 'elevate:%s\n' "$*" >>"$TRACE"; "$@"; }
elevate_readonly() { "$@"; }
manual_pid_for_target() { return 1; }
# Linhas na ordem do relato: instancias fora do namespace antes da principal.
flatpak() {
    [ "$1" = ps ] || return 1
    case "$2" in
        --columns=child-pid,application)
            [ "${NO_CHILD_PID:-0}" = 1 ] && return 1
            printf '%s\n' "$FLATPAK_ROWS" ;;
        --columns=pid,application)
            printf '%s\n' "$FLATPAK_ROWS" ;;
        --columns=instance,pid,child-pid,application)
            printf '%s\n' '1234 900 901 com.discordapp.Discord' ;;
    esac
}
ip() {
    if [ "$1" = netns ] && [ "$2" = identify ]; then
        case " $INSIDE_PIDS " in *" $3 "*) printf 'discord-vpn\n' ;; *) printf '\n' ;; esac
        return 0
    fi
    return 1
}
stat() {
    local alvo pid
    for alvo in "$@"; do :; done
    case "$alvo" in
        /run/netns/discord-vpn) printf '5:4026533000\n' ;;
        /proc/*/ns/net)
            pid="${alvo#/proc/}"; pid="${pid%%/*}"
            case " $INSIDE_PIDS " in *" $pid "*) printf '5:4026533000\n' ;; *) printf '5:4026532000\n' ;; esac ;;
        *) return 1 ;;
    esac
}
NETNS_NAME=discord-vpn
NONINTERACTIVE=0
EOF
    for fn in $FUNCS; do extract "$fn"; done
    cat <<'EOF'
case "$MODE" in
    wait)
        rc=0
        wait_discord_started "$TARGET" || rc=$?
        printf 'rc=%s motivo=%s\n' "$rc" "$WAIT_DISCORD_MOTIVO"
        ;;
    status)
        flav=discord; id=com.discordapp.Discord; resources=/res
        in_namespace=nao
        if discord_pid="$(discord_pid_flav "$flav" "$id" "$resources" 2>/dev/null)"; then
            if netns_pid="$(discord_netns_pid_flav "$flav" "$id" "$resources")"; then
                in_namespace=sim
                discord_pid="$netns_pid"
            fi
        fi
        printf 'inNamespace=%s pid=%s\n' "$in_namespace" "$discord_pid"
        ;;
    falha)
        wait_discord_started "$TARGET" || true
        falha_lancamento_mensagem "$TARGET"
        ;;
esac
EOF
} >"$HARNESS"

TARGET='/var/lib/flatpak/app/com.discordapp.Discord/current/active/files/discord/resources|discord|flatpak|com.discordapp.Discord'
ROWS='38747 com.discordapp.Discord
38712 com.discordapp.Discord
777 org.outro.App'

run() {
    env MODE="$1" TARGET="$TARGET" FLATPAK_ROWS="$ROWS" INSIDE_PIDS="$2" TRACE="$TMP/trace" \
        START_DISCORD_LOG="${3:-}" NO_CHILD_PID="${NO_CHILD_PID:-0}" bash "$HARNESS" 2>&1
}

# --- 1. instancias fora primeiro, principal no namespace ---
out="$(run wait 38712)"
[ "$out" = "rc=0 motivo=confirmado" ] \
    && ok "confirma a instancia principal mesmo com instancias fora listadas antes dela" \
    || bad "espera com instancias fora primeiro: esperado confirmado, veio '$out'"
[ ! -s "$TMP/trace" ] \
    && ok "confirmacao sem privilegio, sem acionar o elevate" \
    || bad "elevate acionado sem necessidade: $(cat "$TMP/trace")"

# --- 2. status ---
out="$(run status 38712)"
[ "$out" = "inNamespace=sim pid=38712" ] \
    && ok "status reporta inNamespace=sim com o PID da instancia no namespace" \
    || bad "status: esperado 'inNamespace=sim pid=38712', veio '$out'"

# --- 3. nenhuma instancia no namespace ---
LOG="$TMP/discord-vpn.log"
printf '%s\n' '[2026-11-07T16:51:27-03:00] launch=flatpak-direct app=com.discordapp.Discord' \
    'saida real do launcher' >"$LOG"
out="$(run wait 999 "$LOG")"
[ "$out" = "rc=1 motivo=fora-do-namespace" ] \
    && ok "sem instancia no namespace a espera continua falhando (fora-do-namespace)" \
    || bad "espera sem instancia no namespace: veio '$out'"
grep -q 'launch=flatpak-ps 1234 900 901 com.discordapp.Discord' "$LOG" \
    && ok "falha registra o flatpak ps no log do Discord" \
    || bad "flatpak ps ausente do log: $(cat "$LOG")"
printf '%s\n' '[2026-11-07T16:51:27-03:00] launch=flatpak-direct app=com.discordapp.Discord' \
    'saida real do launcher' >"$LOG"
out="$(run falha 999 "$LOG")"
case "$out" in
    *"saida do launcher: saida real do launcher;"*) ok "mensagem de falha ignora as linhas do flatpak ps" ;;
    *) bad "mensagem de falha pegou a linha errada: $out" ;;
esac

# --- 4. Flatpak sem a coluna child-pid ---
out="$(NO_CHILD_PID=1 run wait 38712)"
[ "$out" = "rc=0 motivo=confirmado" ] \
    && ok "fallback para a coluna pid confirma a instancia no namespace" \
    || bad "fallback pid: veio '$out'"

[ "$fail" -eq 0 ] && printf '  test-linux-flatpak-instancias-netns: OK\n'
exit "$fail"
