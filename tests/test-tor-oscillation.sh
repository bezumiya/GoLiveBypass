#!/bin/sh
#
# Testes de regressao do issue #87: "loading infinito ao assistir a tela
# estando mto tempo com discord aberto".
#
# Quando o Tor oscila (morre/volta) no meio de uma sessao longa, o refresh
# do bypass demorava ate 12s para confirmar que o Tor voltou (probe 6s +
# exitCountry 6s), segurando o gateway Discord durante esse tempo. O Discord
# mostrava "load infinito" ate o Tor voltar e o refresh terminar.
#
# Esta PR:
# 1. Reduz o probe do detectTor no refreshExit (modo tor) para 3s
# 2. currentExit em modo tor espera o refresh terminar (TOR_HOLD_BUDGET_MS)
#    se refreshingExit estiver rodando, em vez de recursar contra o gateway
#
# Roda em container (podman ou docker) com nodejs, carregando o
# golivebypass.js em sandbox VM. Sem Tor real: usamos probes mockados.
#
# Uso:
#   ./tests/test-tor-oscillation.sh
#   RUNTIME=docker ./tests/test-tor-oscillation.sh

set -eu

REPO="$(cd -- "$(dirname -- "$0")/.." && pwd)"
RUNTIME="${RUNTIME:-podman}"
IMG="artixlinux/artixlinux:latest"
PASS=0
FAIL=0

if ! command -v "$RUNTIME" >/dev/null 2>&1; then
    echo "Preciso do $RUNTIME para rodar os testes." >&2
    exit 1
fi

step() { printf '\n== %s ==\n' "$1"; }
ok()   { PASS=$((PASS + 1)); printf '  [OK] %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); printf '  [FAIL] %s\n' "$1"; }

# Cria a estrutura de arquivos FAKE_RES no host (que e' montada no container como /fake-res)
FAKE_RES_HOST="/home/pdl/tmp/discord-fake-test"
mkdir -p "$FAKE_RES_HOST/resources/_app.asar"
cat > "$FAKE_RES_HOST/resources/_app.asar/package.json" <<'JSONEOF'
{"name": "discord", "main": "index.js"}
JSONEOF
echo "// fake" > "$FAKE_RES_HOST/resources/_app.asar/index.js"
cat > "$FAKE_RES_HOST/resources/settings.json" <<'JSONEOF'
{"enabled": true, "proxy": "", "routeMode": "tor", "torAddr": "127.0.0.1:9050", "excludedCountries": "BR"}
JSONEOF

# O test runner (.cjs) ja' foi criado em /tmp/tor-oscillation-test.cjs
# Roda no container
out="$("$RUNTIME" run --rm --pull=missing --user 0 \
    -v "$REPO:/repo:ro" \
    -v "$FAKE_RES_HOST:/fake-res" \
    -v "/tmp/tor-oscillation-test.cjs:/tmp/tor-oscillation-test.cjs:ro" \
    "$IMG" sh -c '
    pacman -Sy --noconfirm --needed nodejs >/dev/null 2>&1 || { echo "FALHA_DEPS"; exit 1; }
    FAKE_RES_BASE=/fake-res BYPASS=/repo/standalone/golivebypass.js node /tmp/tor-oscillation-test.cjs
    rc=$?
    exit $rc
' 2>&1)"

echo "$out" | grep -E "\[OK\]|\[FAIL\]|RESULTADO|FALHA_" | sed 's/^\[GoLiveBypass\] //'

if printf '%s' "$out" | grep -q "RESULTADO: TUDO OK"; then
    ok "tor oscilante (issue #87): refresh rapido + gateway recupera"
else
    bad "tor oscilante falhou"
fi

echo
echo "== Resultado: $PASS ok, $FAIL falhas =="
[ "$FAIL" -eq 0 ] || exit 1
