#!/bin/sh
#
# Teste E2E: simula o job release-assets do CI
#
# Cria o zip, gera SHA-256, e valida que o conteudo esta correto.
# Complementa o test-userplugin-e2e.sh com a perspectiva do CI.
#
# Uso: ./tests/test-ci-release.sh

set -eu

REPO="$(cd -- "$(dirname -- "$0")/.." && pwd)"
PASS=0
FAIL=0

step() { printf '  [*] %s\n' "$1" >&2; }
ok()   { PASS=$((PASS + 1)); printf '  [OK] %s\n' "$1" >&2; }
bad()  { FAIL=$((FAIL + 1)); printf '  [FAIL] %s\n' "$1" >&2; }

if ! command -v python3 >/dev/null 2>&1; then
    echo "python3 e obrigatorio" >&2
    exit 1
fi

# Diretorio de trabalho isolado
WORK="$(mktemp -d)"
trap "rm -rf '$WORK'" EXIT

# Simular o CI para diferentes versoes
for VERSION in 1.1.8 1.2.0 2.0.0; do
    step "Simular CI para versao $VERSION"
    cd "$WORK"

    # Setup: copiar arquivos como se fosse o checkout
    cp -R "$REPO/goLiveBypass" "."
    cp "$REPO/standalone/golivebypass.js" "."

    # 1. Determinar variaveis
    bypass_basename="GoLiveBypass-${VERSION}-bypass"
    vencord_basename="goLiveBypass-vencord"  # fixo, igual ao assetName do manifest

    # 2. Atualizar manifest com a versao (sed do CI)
    if sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" goLiveBypass/manifest.json; then
        ok "manifest.json atualizado para version=$VERSION"
    else
        bad "sed falhou"
        continue
    fi

    # 3. Verificar que o manifest tem a versao correta
    actual_version=$(grep -oE '"version"[[:space:]]*:[[:space:]]*"[^"]+"' goLiveBypass/manifest.json | sed 's/.*"\([^"]*\)"$/\1/')
    if [ "$actual_version" = "$VERSION" ]; then
        ok "manifest.json tem version=$actual_version"
    else
        bad "manifest.json tem version=$actual_version (esperado $VERSION)"
    fi

    # 4. Criar zip do userplugin (mesmo nome em qualquer versao)
    if python3 -c "
import sys, os, zipfile
src = sys.argv[1]
out = sys.argv[2]
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as zf:
    base = os.path.basename(src)
    for root, dirs, files in os.walk(src):
        for f in files:
            full = os.path.join(root, f)
            arc = os.path.join(base, os.path.relpath(full, src))
            zf.write(full, arc)
" goLiveBypass "${vencord_basename}.zip" 2>/dev/null; then
        ok "${vencord_basename}.zip criado"
    else
        bad "zip falhou"
        continue
    fi

    # 5. Verificar que o manifest dentro do zip tem a versao correta
    zip_version=$(python3 -c "
import zipfile, sys
with zipfile.ZipFile(sys.argv[1]) as zf:
    with zf.open('goLiveBypass/manifest.json') as f:
        content = f.read().decode()
import json
print(json.loads(content)['version'])
" "${vencord_basename}.zip" 2>/dev/null)
    if [ "$zip_version" = "$VERSION" ]; then
        ok "manifest dentro do zip tem version=$zip_version"
    else
        bad "manifest dentro do zip tem version=$zip_version (esperado $VERSION)"
    fi

    # 6. SHA-256
    sha256sum "${vencord_basename}.zip" > "${vencord_basename}.zip.sha256"
    if [ -s "${vencord_basename}.zip.sha256" ]; then
        ok "${vencord_basename}.zip.sha256 gerado"
    else
        bad "sha256 falhou"
    fi

    # 7. assetName do manifest e o nome do zip devem bater
    asset_name=$(python3 -c "
import json
with open('goLiveBypass/manifest.json') as f:
    m = json.load(f)
print(m['updater']['assetName'])
")
    expected_zip="${vencord_basename}.zip"
    if [ "$asset_name" = "$expected_zip" ]; then
        ok "assetName = $asset_name (bate com o zip publicado)"
    else
        bad "assetName = $asset_name (esperado $expected_zip)"
    fi

    # 8. Bypass standalone (com versao no nome)
    cp golivebypass.js "${bypass_basename}.js"
    if [ -f "${bypass_basename}.js" ]; then
        ok "${bypass_basename}.js criado ($(stat -c%s "${bypass_basename}.js" 2>/dev/null || stat -f%z "${bypass_basename}.js") bytes)"
    else
        bad "bypass nao copiado"
    fi
    sha256sum "${bypass_basename}.js" > "${bypass_basename}.js.sha256"
    if [ -s "${bypass_basename}.js.sha256" ]; then
        ok "${bypass_basename}.js.sha256 gerado"
    else
        bad "sha256 do bypass falhou"
    fi

    # Limpar para a proxima iteracao
    cd "$WORK"
    rm -rf goLiveBypass "${vencord_basename}.zip"* "${bypass_basename}.js"* golivebypass.js
done

# 9. Validacao adicional: o assetName do manifest no repo e' o esperado
step "assetName no repo confere com a convencao do CI"
expected="goLiveBypass-vencord.zip"
actual=$(grep -oE '"assetName"[[:space:]]*:[[:space:]]*"[^"]+"' "$REPO/goLiveBypass/manifest.json" | sed 's/.*"\([^"]*\)"$/\1/')
if [ "$actual" = "$expected" ]; then
    ok "assetName = $actual"
else
    bad "assetName = $actual (esperado $expected)"
fi

# ---------------------------------------------------------------------------
echo
echo "== Resultado: $PASS ok, $FAIL falhas =="
[ "$FAIL" -eq 0 ] || exit 1
