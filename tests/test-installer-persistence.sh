#!/bin/sh
#
# Regressao do modo TEMPORARIO do instalador do plugin.
#
# Relato: escolhendo "Temporario", a injecao nao era desfeita ao fechar o Discord — o
# instalador avisava "O Discord ja estava injetado antes de eu rodar, entao nao vou
# desfazer isso" e ficava por isso mesmo. Causa: $weInjected era lido no fim de
# Invoke-Install e nunca atribuido. A atribuicao original
# ($weInjected = -not (Test-InjectedFromCheckout $root)) sumiu quando o bloco de
# multi-selecao de alvos entrou no lugar dela, e a leitura ficou para tras. Nulo e falso
# em PowerShell, entao o ramo do aviso era sempre o escolhido e Wait-DiscordExit nunca
# rodava: o modo temporario virava permanente.
#
# Cobre as duas metades:
#   1. o instalador .sh, exercitando do_install de verdade com os efeitos colaterais
#      trocados por stubs;
#   2. o instalador .ps1, por conferencia estatica — o CI Linux nao tem pwsh (o
#      test-auto-update.ps1 roda em runner Windows).
#
# Uso:
#   ./tests/test-installer-persistence.sh

set -eu

REPO="$(cd -- "$(dirname -- "$0")/.." && pwd)"
PASS=0
FAIL=0

ok() { PASS=$((PASS + 1)); printf '  [OK] %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  [FAIL] %s\n' "$1"; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# --------------------------------------------------------------------- .sh

HARNESS="$TMP/do-install.sh"
{
    awk '/^do_install\(\) \{/,/^\}$/' "$REPO/installer/golivebypass-installer.sh"
    cat <<'EOF'

# --- stubs: nada toca disco, rede ou Discord. O log e o que o teste observa. ---
LOG="${GLB_LOG:?}"
: > "$LOG"
anota() { printf '%s\n' "$1" >> "$LOG"; }

RAIZ_FAKE="/checkout/Equicord"
# Codigo de retorno: 0 = o Discord ja carrega deste checkout, 1 = precisa injetar.
JA_INJETADO="${GLB_JA_INJETADO:-1}"

select_target() { printf '%s\n' "$RAIZ_FAKE"; }
select_persistence() { return "$GLB_PERMANENTE"; }
ensure_toolchain() { :; }
install_plugin_source() { :; }
build_mod() { :; }
injected_from_checkout() { return "$JA_INJETADO"; }
stop_discord() { :; }
inject_mod() { anota inject; }
injected_flatpak_id() { return 1; }
injected_resources() { printf '%s\n' "$RAIZ_FAKE/dist/desktop"; }
set_plugin_settings() { anota settings; }
start_discord() { :; }
wait_discord_exit() { anota wait; }
step() { :; }
warn() { :; }
ok() { :; }
fail() { printf 'fail inesperado: %s\n' "$1" >&2; exit 9; }

# Cores: definidas no cabecalho do instalador, que nao entra no extrato.
C_DIM=""
C_OFF=""
EOF
} > "$HARNESS"

# select_persistence responde 0 = permanente, 1 = temporario (o contrato do script real).
roda() { # $1 = 0 permanente / 1 temporario, $2 = 0 ja carrega deste checkout / 1 precisa injetar
    GLB_LOG="$TMP/log.txt" GLB_PERMANENTE="$1" GLB_JA_INJETADO="$2" \
        sh -c ". '$HARNESS'; do_install '$TMP/root'" >"$TMP/stdout.txt" 2>&1 \
        || { cat "$TMP/stdout.txt" >&2; return 1; }
}

printf '\n== 1. Instalador Linux (do_install real) ==\n'

roda 1 1
grep -qx inject "$TMP/log.txt" && ok "temporario / instalacao nova: injeta" \
                               || bad "temporario / instalacao nova: nao injetou"
grep -qx wait "$TMP/log.txt" && ok "temporario / instalacao nova: espera o Discord fechar para desfazer" \
                             || bad "temporario / instalacao nova: nunca desfaz (injecao fica permanente)"

roda 0 1
grep -qx inject "$TMP/log.txt" && ok "permanente / instalacao nova: injeta" \
                               || bad "permanente / instalacao nova: nao injetou"
grep -qx wait "$TMP/log.txt" && bad "permanente: esperou para desfazer (nao deveria)" \
                             || ok "permanente: nao espera, a injecao fica"

# --------------------------------------------------------------------- .ps1

printf '\n== 2. Instalador Windows (conferencia estatica) ==\n'

PS1="$REPO/installer/GoLiveBypass-Installer.ps1"

# A atribuicao precisa existir e vir ANTES da leitura. E o defeito exato do relato: a
# leitura ficou, a atribuicao sumiu.
linha_atrib="$(grep -n '^[[:space:]]*\$weInjected = ' "$PS1" | head -1 | cut -d: -f1)"
linha_leitura="$(grep -n 'if (\$weInjected)' "$PS1" | head -1 | cut -d: -f1)"

if [ -n "$linha_atrib" ]; then
    ok "PS1 atribui \$weInjected (linha $linha_atrib)"
else
    bad "PS1 le \$weInjected sem nunca atribuir: o modo temporario nao desfaz"
fi

if [ -n "$linha_leitura" ]; then
    ok "PS1 consulta \$weInjected no modo temporario (linha $linha_leitura)"
else
    bad "PS1 nao consulta mais \$weInjected no modo temporario"
fi

if [ -n "$linha_atrib" ] && [ -n "$linha_leitura" ] && [ "$linha_atrib" -lt "$linha_leitura" ]; then
    ok "PS1 grava \$weInjected antes de ler (sem isso o temporario vira permanente)"
else
    bad "PS1 le \$weInjected antes de gravar"
fi

# O .ps1 precisa continuar esperando o Discord fechar de fato.
grep -q 'Wait-DiscordExit \$root' "$PS1" && ok "PS1 chama Wait-DiscordExit no modo temporario" \
                                          || bad "PS1 perdeu a chamada a Wait-DiscordExit"

printf '\n'
if [ "$FAIL" -eq 0 ]; then
    printf 'RESULTADO: %d OK, 0 FALHAS\n' "$PASS"
else
    printf 'RESULTADO: %d OK, %d FALHA(S)\n' "$PASS" "$FAIL"
fi
[ "$FAIL" -eq 0 ]
