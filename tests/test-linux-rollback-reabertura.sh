#!/bin/sh
# Regressão de #405/#421/#422: depois de uma ativação que falha, o rollback reabre o
# Discord fora do túnel, mas conferia a reabertura com wait_discord_started, que exige
# o PID dentro do namespace que ele mesmo acabou de remover. Resultado: "nao consegui
# reabrir o Discord automaticamente" com o Discord aberto na tela, e a causa real
# (o Discord nativo morrendo no túnel, ex.: "GPU process isn't usable") ficava no
# journal da unidade systemd, fora do log do launcher. O que se prova aqui, com shims:
#
#   1. a reabertura no host é confirmada pelo processo, sem exigir namespace;
#   2. sem processo nenhum, o aviso de falha da reabertura continua;
#   3. o journal da unidade do Discord nativo vai para o log do launcher e a última
#      linha dele vira a "saida do launcher" citada na falha da ativação.
#
# Uso: sh tests/test-linux-rollback-reabertura.sh

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

FUNCS="rollback_activation wait_discord_host_started append_discord_unit_journal falha_lancamento_mensagem"
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
have() { case "$1" in journalctl) return 0 ;; *) return 1 ;; esac; }
sleep() { :; }
warn() { printf 'warn:%s\n' "$1" >>"$TRACE"; }
netns_exists() { return 1; }
discord_running() { return 1; }
teardown_wireguard_netns() { :; }
# start_discord do rollback: so marca que o host recebeu a abertura.
start_discord() { printf 'start:%s host_only=%s\n' "$1" "$START_DISCORD_HOST_ONLY" >>"$TRACE"; [ "${ABRE:-1}" = 1 ] && : >"$TMP_PID"; return 0; }
# PID no host depois da abertura; nunca dentro de namespace (ele nao existe mais).
discord_pid_flav() { [ -f "$TMP_PID" ] && printf '4242\n'; }
discord_netns_pid_flav() { return 1; }
wait_discord_started() { printf 'wait_discord_started chamado\n' >>"$TRACE"; return 1; }
elevate() { "$@"; }
journalctl() {
    printf '%s\n' "Starting app." "Discord 1.0.168" "GPU process isn't usable. Goodbye."
}
EOF
    for fn in $FUNCS; do extract "$fn"; printf '\n'; done
    cat <<'EOF'
case "$CASO" in
    reabre|nao-reabre)
        ACTIVATION_ROLLBACK_PENDING=1
        ACTIVATION_ROLLBACK_REOPEN=1
        ACTIVATION_NETNS_TOUCH_STARTED=1
        ACTIVATION_ROLLBACK_TARGET="/home/u/.config/discord/app-1.0.168/resources|discord|bootstrap|"
        START_DISCORD_HOST_ONLY=0
        rollback_activation
        ;;
    journal)
        START_DISCORD_UNIT="discord-vpn-1700000000"
        START_DISCORD_LOG="$DISCORD_LOG"
        WAIT_DISCORD_MOTIVO="sem-processo"
        printf '[2026-11-09T15:48:43-03:00] backend=wayland wayland=wayland-1 session=wayland portal=ausente\n' >"$DISCORD_LOG"
        printf 'Running as unit: discord-vpn-1700000000.service\n' >>"$DISCORD_LOG"
        append_discord_unit_journal
        falha_lancamento_mensagem "/home/u/.config/discord/app-1.0.168/resources|discord|bootstrap|"
        ;;
esac
EOF
} >"$HARNESS"

roda() {
    TRACE="$TMP/trace-$1"; : >"$TRACE"
    TMP_PID="$TMP/pid-$1"; rm -f "$TMP_PID"
    TRACE="$TRACE" TMP_PID="$TMP_PID" CASO="$2" ABRE="$3" DISCORD_LOG="$TMP/discord-$1.log" bash "$HARNESS"
}

printf '\n== rollback: reabertura do Discord no host ==\n'
roda reabre reabre 1 >/dev/null
if grep -q 'warn:Rollback: Discord reaberto sem bypass' "$TMP/trace-reabre" \
    && ! grep -q 'nao consegui reabrir' "$TMP/trace-reabre"; then
    ok "Discord reaberto fora do tunel e confirmado pelo processo"
else
    bad "reabertura no host nao foi confirmada: $(cat "$TMP/trace-reabre")"
fi
if grep -q 'wait_discord_started chamado' "$TMP/trace-reabre"; then
    bad "rollback ainda confere a reabertura exigindo o namespace removido"
else
    ok "rollback nao exige mais o namespace para confirmar"
fi
if grep -q 'host_only=1' "$TMP/trace-reabre"; then
    ok "reabertura feita em modo host-only"
else
    bad "reabertura nao foi host-only: $(cat "$TMP/trace-reabre")"
fi

roda nao-reabre nao-reabre 0 >/dev/null
if grep -q 'warn:Rollback: nao consegui reabrir o Discord automaticamente.' "$TMP/trace-nao-reabre"; then
    ok "sem processo, o aviso de falha da reabertura continua"
else
    bad "faltou o aviso quando o Discord nao reabre: $(cat "$TMP/trace-nao-reabre")"
fi

printf '\n== falha da ativacao: journal da unidade no log do launcher ==\n'
saida="$(roda journal journal 1)"
if grep -q "^\[journal discord-vpn-1700000000\] GPU process isn't usable. Goodbye.$" "$TMP/discord-journal.log"; then
    ok "journal da unidade copiado para o log do Discord"
else
    bad "journal nao foi para o log: $(cat "$TMP/discord-journal.log")"
fi
case "$saida" in
    *"saida do launcher: GPU process isn't usable. Goodbye.;"*) ok "mensagem de falha cita a ultima linha do Discord" ;;
    *) bad "mensagem de falha sem a saida do Discord: $saida" ;;
esac

if [ "$fail" -ne 0 ]; then
    printf '\nFALHOU\n'
    exit 1
fi
printf '\nOK\n'
