#!/bin/sh
#
# Regressao do log LOCAL dos instaladores (escopo B: observabilidade local/manual, sem
# telemetria remota).
#
# Cobre, para o instalador .sh (execucao real das funcoes extraidas) e para o .ps1
# (conferencia estatica, porque o CI Linux nao tem pwsh):
#   1. installer.log local em JSONL com ts/nivel/componente/evento/fase e data allowlisted;
#   2. redaction fail-closed (chave proibida vira <redacted>, caminho pessoal vira <path>,
#      chave desconhecida e descartada);
#   3. limite/rotacao de 256 KiB mantendo linhas JSONL completas;
#   4. ausencia de POST/token/payload legado includeLogs (e nenhuma chamada de curl/wget);
#   5. #293 distinguivel: mod detectado sem checkout => checkout_rejected por codigo,
#      gate preservado (nao substitui app.asar) e falha registrada.
#
# Uso:
#   ./tests/test-installer-log.sh

set -eu

REPO="$(cd -- "$(dirname -- "$0")/.." && pwd)"
SH_INSTALLER="$REPO/installer/golivebypass-installer.sh"
PS_INSTALLER="$REPO/installer/GoLiveBypass-Installer.ps1"

PASS=0
FAIL=0

ok() { PASS=$((PASS + 1)); printf '  [OK] %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  [FAIL] %s\n' "$1"; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Extrai a secao de log (funcoes + fail) por marcadores estaveis.
LOG_SECTION="$TMP/log-section.sh"
sed -n '/^# =* log local$/,/^# =* \/log local$/p' "$SH_INSTALLER" > "$LOG_SECTION"
if [ "$(grep -c '^installer_log()' "$LOG_SECTION")" -lt 1 ] || [ "$(grep -c '^fail()' "$LOG_SECTION")" -lt 1 ]; then
    printf '  [FAIL] nao consegui extrair a secao de log do instalador .sh\n'
    exit 1
fi

HARNESS="$TMP/harness.sh"
{
    cat "$LOG_SECTION"
    # awk extrai a funcao real (a mesma que o instalador chama no caminho da #293).
    awk '/^find_checkout\(\) \{/,/^\}$/' "$SH_INSTALLER"
    cat <<'EOF'
C_RED=""; C_DIM=""; C_OFF=""
SOURCE=""
# Stubs da descoberta: nenhum checkout provado em lugar nenhum, mas um mod ja injetado.
is_checkout() { return 1; }
checkout_from_injection() { return 1; }
checkout_on_disk() { return 1; }
installed_mod() { printf 'Equicord\n'; }
EOF
} > "$HARNESS"

# Fake curl/wget no PATH: nenhum POST pode acontecer em nenhum caminho do log.
FAKEBIN="$TMP/fakebin"
mkdir -p "$FAKEBIN"
for bin in curl wget; do
    printf '#!/bin/sh\ntouch "%s/called-%s"\nexit 1\n' "$TMP" "$bin" > "$FAKEBIN/$bin"
    chmod +x "$FAKEBIN/$bin"
done
PATH="$FAKEBIN:$PATH"
export PATH

printf '\n== 1. installer.log local em JSONL ==\n'

LOG_DIR="$TMP/data"
# shellcheck disable=SC1090
(
    set -eu
    GLB_INSTALLER_LOG_DIR="$LOG_DIR"
    . "$HARNESS"
    installer_log info installer.detect.started detect mode install
)

LOG_FILE="$LOG_DIR/installer.log"
if [ -f "$LOG_FILE" ]; then
    ok "cria installer.log no diretorio de dados"
else
    bad "nao criou $LOG_FILE"
fi

first="$(head -1 "$LOG_FILE" 2>/dev/null || true)"
case "$first" in
    *'"schema_version":1'*) ok "linha tem schema_version=1" ;; *) bad "sem schema_version: $first" ;;
esac
case "$first" in
    *'"level":"info"'*) ok "linha tem level" ;; *) bad "sem level: $first" ;;
esac
case "$first" in
    *'"component":"installer.linux"'*) ok "linha tem component do instalador Linux" ;; *) bad "sem component: $first" ;;
esac
case "$first" in
    *'"event":"installer.detect.started"'*) ok "linha tem event" ;; *) bad "sem event: $first" ;;
esac
case "$first" in
    *'"phase":"detect"'*) ok "linha tem phase" ;; *) bad "sem phase: $first" ;;
esac
case "$first" in
    *'"ts":"20'*) ok "linha tem timestamp ISO-8601" ;; *) bad "sem ts: $first" ;;
esac
if grep -qE '"ts":"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z"' "$LOG_FILE"; then
    ok "ts ISO-8601 UTC com milissegundos"
else
    bad "ts sem milissegundos: $first"
fi

printf '\n== 2. redaction fail-closed ==\n'
# shellcheck disable=SC1090
(
    set -eu
    GLB_INSTALLER_LOG_DIR="$LOG_DIR"
    . "$HARNESS"
    installer_log warn installer.checkout_rejected detect reason "erro em /home/alice/Equicord/dist" token "abc123" senha "s3cr3t" campo_desconhecido "x"
)
last="$(tail -1 "$LOG_FILE")"
case "$last" in
    *'/home/alice'*|*abc123*|*s3cr3t*) bad "valor sensivel vazou para o log: $last" ;;
    *) ok "nenhum valor sensivel vaza" ;;
esac
case "$last" in
    *'<path>'*) ok "caminho absoluto vira <path>" ;;
    *) bad "caminho nao foi redigido: $last" ;;
esac
case "$last" in
    *'"token":"<redacted>"'*) ok "chave proibida token vira <redacted>" ;;
    *) bad "token nao foi redigido: $last" ;;
esac
case "$last" in
    *'"senha":"<redacted>"'*) ok "chave proibida senha vira <redacted>" ;;
    *) bad "senha nao foi redigida: $last" ;;
esac
case "$last" in
    *campo_desconhecido*) bad "chave desconhecida nao foi descartada: $last" ;;
    *) ok "chave desconhecida e descartada" ;;
esac

# UNC / caminho de rede e caminho POSIX fora de /home tambem sao redigidos.
# shellcheck disable=SC1090
(
    set -eu
    GLB_INSTALLER_LOG_DIR="$LOG_DIR"
    . "$HARNESS"
    installer_log warn installer.checkout_rejected detect reason 'checkout em \\\\servidor\\Users\\alice\\Equicord e /opt/Equicord/dist'
)
last="$(tail -1 "$LOG_FILE")"
case "$last" in
    *'alice'*|*'/opt/'*|*'servidor'*) bad "caminho absoluto/UNC vazou: $last" ;;
    *) ok "caminho UNC e POSIX fora de /home sao redigidos" ;;
esac

# Cabecalho de autenticacao, URL com credencial e e-mail tambem sao redigidos.
# shellcheck disable=SC1090
(
    set -eu
    GLB_INSTALLER_LOG_DIR="$LOG_DIR"
    . "$HARNESS"
    installer_log warn installer.probe probe reason 'Authorization: Bearer eyJhbGciOi.abc.def em https://alice:s3cr3t@example.test/x contato alice@example.com'
)
last="$(tail -1 "$LOG_FILE")"
for leak in 'eyJhbGciOi' 's3cr3t' 'alice@example.com' 'example.test/x'; do
    case "$last" in
        *"$leak"*) bad "vazou '$leak': $last" ;;
        *) ok "nao vaza '$leak'" ;;
    esac
done
case "$last" in
    *'Authorization=<redacted>'*|*'Authorization: <redacted>'*) ok "cabecalho Authorization consome a credencial" ;;
    *) bad "cabecalho Authorization nao foi redigido: $last" ;;
esac
case "$last" in
    *'<redacted-url>'*) ok "URL com credencial vira <redacted-url>" ;;
    *) bad "URL credenciada nao redigida: $last" ;;
esac
case "$last" in
    *'<email>'*) ok "e-mail vira <email>" ;;
    *) bad "e-mail nao redigido: $last" ;;
esac

printf '\n== 2b. falha de escrita nao quebra o fluxo ==\n'
# Diretorio impossivel (arquivo comum no lugar da pasta): installer_log tem que
# devolver sucesso e nao derrubar o instalador sob set -e.
: > "$TMP/not-a-dir"
rc_log=0
# shellcheck disable=SC1090
(
    set -eu
    GLB_INSTALLER_LOG_DIR="$TMP/not-a-dir"
    . "$HARNESS"
    installer_log info installer.probe running count 1
    printf 'flow-continued\n'
) > "$TMP/writefail.out" 2>&1 || rc_log=$?
if [ "$rc_log" -eq 0 ] && grep -q 'flow-continued' "$TMP/writefail.out"; then
    ok "falha de escrita no log nao interrompe o fluxo"
else
    bad "falha de escrita quebrou o fluxo (rc=$rc_log): $(cat "$TMP/writefail.out")"
fi

printf '\n== 3. limite/rotacao ==\n'
LOG_DIR2="$TMP/data2"
mkdir -p "$LOG_DIR2"
# Semeia o arquivo acima do teto (linhas JSONL completas) e escreve UM evento: e o
# caminho exato de rotacao (limite atingido antes do append), sem custo de milhares
# de eventos.
awk 'BEGIN{ for (i=0;i<3000;i++) printf "{\"filler\":\"%0500d\"}\n", i }' > "$LOG_DIR2/installer.log"
seeded_size="$(wc -c < "$LOG_DIR2/installer.log" | tr -d ' ')"
# shellcheck disable=SC1090
(
    set -eu
    GLB_INSTALLER_LOG_DIR="$LOG_DIR2"
    . "$HARNESS"
    installer_log info installer.sentinel running count 1
)
LOG_FILE2="$LOG_DIR2/installer.log"
size="$(wc -c < "$LOG_FILE2" | tr -d ' ')"
if [ "$seeded_size" -gt 262144 ] && [ "$size" -le 262144 ]; then
    ok "rotacao trima para <=256 KiB (semeado=$seeded_size, final=$size)"
else
    bad "rotacao nao respeitou <=256 KiB (semeado=$seeded_size, final=$size)"
fi
if grep -qv '^{' "$LOG_FILE2"; then
    bad "rotacao deixou linha parcial no arquivo"
else
    ok "todas as linhas seguem JSONL completo (sem linha parcial)"
fi
if tail -1 "$LOG_FILE2" | grep -q 'installer.sentinel'; then
    ok "evento mais recente sobrevive a rotacao"
else
    bad "ultimo evento sumiu na rotacao"
fi

printf '\n== 4. ausencia de POST/token/payload legado ==\n'
if grep -Eq 'BUG_API|api\.skyplaceia|includeLogs|Invoke-SendAutoReport|Invoke-BugReport|-X POST|--post-data|report_send|report_error' "$SH_INSTALLER" "$PS_INSTALLER"; then
    bad "instalador ainda contem caminho de envio remoto"
else
    ok "nenhum token/API/POST/payload legado nos instaladores"
fi
if grep -q 'Invoke-SendAutoReport\|report_error\|report_send\|should_report' "$PS_INSTALLER" "$SH_INSTALLER"; then
    bad "restou chamada de relatorio automatico"
else
    ok "chamadas de relatorio automatico removidas"
fi

printf '\n== 5. #293 distinguivel (mod detectado sem checkout) ==\n'
LOG_DIR293="$TMP/data293"
rc=0
# shellcheck disable=SC1090
( set -eu; GLB_INSTALLER_LOG_DIR="$LOG_DIR293"; . "$HARNESS"; find_checkout ) >/dev/null 2>&1 || rc=$?
if [ "$rc" -eq 1 ]; then
    ok "gate preservado: find_checkout falha (nao substitui app.asar)"
else
    bad "find_checkout devolveu rc=$rc (esperado 1)"
fi
LOG293="$LOG_DIR293/installer.log"
if grep -q '"event":"installer.checkout_rejected"' "$LOG293" && grep -q 'MOD_INSTALLED_WITHOUT_CHECKOUT' "$LOG293"; then
    ok "#293 distinguivel por codigo (MOD_INSTALLED_WITHOUT_CHECKOUT)"
else
    bad "log nao distingue o cenario da #293"
fi
if grep -q '"event":"installer.failed"' "$LOG293"; then
    ok "falha registrada em installer.failed"
else
    bad "falta installer.failed"
fi
if grep -q '/home/' "$LOG293"; then
    bad "log da #293 vazou caminho pessoal"
else
    ok "log da #293 sem caminho pessoal"
fi
if [ -f "$TMP/called-curl" ] || [ -f "$TMP/called-wget" ]; then
    bad "caminho de falha tentou POST"
else
    ok "caminho de falha nao tenta POST"
fi

printf '\n== 6. build do mod: dependencias sincronizadas e contexto da falha ==\n'
# Checkout atualizado (git pull/updater do mod) com node_modules antigo: o Equicord liga
# verifyDepsBeforeRun e o `pnpm build` sem terminal falhava sem dizer nada. O instalador
# precisa sincronizar antes de todo build e, se o build falhar mesmo assim, deixar no log
# versoes e estado do checkout, sem caminho.
BUILD_HARNESS="$TMP/build-harness.sh"
{
    cat "$LOG_SECTION"
    for fn in sync_mod_deps log_build_context build_mod; do
        awk "/^$fn\\(\\) \\{/,/^\\}\$/" "$SH_INSTALLER"
    done
    cat <<'EOF'
C_RED=""; C_DIM=""; C_OFF=""
step() { :; }
checkout_mod() { printf 'Equicord\n'; }
node() { printf 'v22.11.0\n'; }
# pnpm falso: registra as chamadas; PNPM_FAIL lista as que devem falhar (frozen, install, build).
pnpm() {
    printf '%s\n' "$*" >> "$PNPM_CALLS"
    case "$*" in
        --version) printf '12.8.1\n'; return 0 ;;
        *--frozen-lockfile*) case " $PNPM_FAIL " in *" frozen "*) return 1 ;; esac ;;
        install*) case " $PNPM_FAIL " in *" install "*) return 1 ;; esac ;;
        build) case " $PNPM_FAIL " in *" build "*) return 1 ;; esac ;;
    esac
    return 0
}
EOF
} > "$BUILD_HARNESS"

# $1 = nome do caso, $2 = falhas do pnpm falso. Deixa $BROOT, $BLOG, $BCALLS e $brc.
run_build_case() {
    BROOT="$TMP/home/alice/Equicord-$1"
    mkdir -p "$BROOT/node_modules"
    printf '{"name":"equicord","packageManager":"pnpm@12.16.1"}\n' > "$BROOT/package.json"
    BLOG="$TMP/data-build-$1"
    BCALLS="$TMP/pnpm-calls-$1"
    : > "$BCALLS"
    brc=0
    # shellcheck disable=SC1090
    ( set -eu; GLB_INSTALLER_LOG_DIR="$BLOG"; PNPM_CALLS="$BCALLS"; PNPM_FAIL="$2"
      . "$BUILD_HARNESS"; build_mod "$BROOT" ) >/dev/null 2>"$TMP/build-$1.err" || brc=$?
}

run_build_case ok ""
if [ "$brc" -eq 0 ] && [ "$(sed -n 1p "$BCALLS")" = "install --frozen-lockfile --config.confirm-modules-purge=false" ] \
    && [ "$(sed -n 2p "$BCALLS")" = "build" ]; then
    ok "node_modules presente: sincroniza com --frozen-lockfile antes do build"
else
    bad "build sem sincronizar antes (rc=$brc): $(tr '\n' ';' < "$BCALLS")"
fi

run_build_case lock "frozen"
if [ "$brc" -eq 0 ] && [ "$(sed -n 2p "$BCALLS")" = "install --config.confirm-modules-purge=false" ] \
    && [ "$(sed -n 3p "$BCALLS")" = "build" ]; then
    ok "lockfile fora do package.json: cai no install comum e compila"
else
    bad "reserva do install nao rodou (rc=$brc): $(tr '\n' ';' < "$BCALLS")"
fi

run_build_case build "build"
BLOGF="$BLOG/installer.log"
if [ "$brc" -eq 1 ] && grep -q 'pnpm build falhou (exit=1)' "$TMP/build-build.err"; then
    ok "falha do build informa o codigo de saida"
else
    bad "falha do build sem exit (rc=$brc): $(cat "$TMP/build-build.err")"
fi
ctx="$(grep '"event":"installer.build_context"' "$BLOGF" 2>/dev/null || true)"
case "$ctx" in
    *'"pnpm_version":"12.8.1"'*'"pnpm_esperado":"pnpm@12.16.1"'*'"node_version":"v22.11.0"'*'"node_modules":true'*'"deps_sync":"ok"'*'"exit_code":1'*)
        ok "installer.build_context traz versoes, node_modules, deps_sync e exit" ;;
    *) bad "contexto do build incompleto: $ctx" ;;
esac
if grep -q 'alice' "$BLOGF"; then
    bad "contexto do build vazou caminho pessoal"
else
    ok "contexto do build sem caminho pessoal"
fi

run_build_case deps "frozen install"
ctx="$(grep '"event":"installer.build_context"' "$BLOG/installer.log" 2>/dev/null || true)"
if [ "$brc" -eq 1 ] && ! grep -qx build "$BCALLS" && case "$ctx" in *'"deps_sync":"falhou"'*) true ;; *) false ;; esac; then
    ok "install que falha nas duas tentativas para antes do build e registra deps_sync=falhou"
else
    bad "falha do install mal registrada (rc=$brc): $ctx"
fi

printf '\n----------------------------------------\n'
printf '  %s: %s passaram, %s falharam\n' "$(basename "$0")" "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0
