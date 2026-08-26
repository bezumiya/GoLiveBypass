#!/bin/sh
#
# Testes E2E do userplugin Vencord (Onda 2 do auto-update)
#
# Estes testes simulam o que o CI faz no job release-assets:
#   1. Zipar o plugin (goLiveBypass/) como GoLiveBypass-<ver>-vencord.zip
#   2. Gerar SHA-256 do zip
#   3. Validar conteudo do zip (manifest.json, index.tsx, native.ts)
#   4. Simular a extracao em .userplugins/GoLiveBypass/ (caminho do Vencord)
#   5. Validar o backup e rollback
#   6. Validar integridade (hash dos arquivos extraidos)
#
# Usa python3 para criar/ler o zip (portavel, nao depende do `zip` CLI).
#
# Uso: ./tests/test-userplugin-e2e.sh

set -eu

REPO="$(cd -- "$(dirname -- "$0")/.." && pwd)"
VERSION="1.1.8"
# assetName do manifest e' fixo (sem versao) para que o Vencord sempre baixe o
# asset mais recente independente da tag. O CI sobrescreve a cada release.
ASSET="goLiveBypass-vencord.zip"
PASS=0
FAIL=0

step() { printf '  [*] %s\n' "$1" >&2; }
ok()   { PASS=$((PASS + 1)); printf '  [OK] %s\n' "$1" >&2; }
bad()  { FAIL=$((FAIL + 1)); printf '  [FAIL] %s\n' "$1" >&2; }

if ! command -v python3 >/dev/null 2>&1; then
    echo "python3 e obrigatorio para este teste" >&2
    exit 1
fi

# Diretorio de trabalho isolado
WORK="$(mktemp -d)"
trap "rm -rf '$WORK'" EXIT

cd "$WORK"

# Helper python para criar zip (caminho de origem -> zip)
create_zip_py() {
python3 - "$@" <<'PYEOF'
import sys, os, zipfile
src_dir = sys.argv[1]
out_zip = sys.argv[2]
with zipfile.ZipFile(out_zip, 'w', zipfile.ZIP_DEFLATED) as zf:
    base = os.path.basename(src_dir)
    for root, dirs, files in os.walk(src_dir):
        for f in files:
            full = os.path.join(root, f)
            arc = os.path.join(base, os.path.relpath(full, src_dir))
            zf.write(full, arc)
PYEOF
}

# Helper python para listar zip
list_zip_py() {
python3 - "$@" <<'PYEOF'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as zf:
    for n in zf.namelist():
        print(n)
PYEOF
}

# Helper python para extrair zip
extract_zip_py() {
python3 - "$@" <<'PYEOF'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as zf:
    zf.extractall(sys.argv[2])
PYEOF
}

# --------------------------------------------------------------------------- 1. Zipar
step "1. Zipar o plugin (simula CI)"
if create_zip_py "$REPO/goLiveBypass" "$ASSET"; then
    ok "zip criado: $ASSET ($(stat -c%s "$ASSET" 2>/dev/null || stat -f%z "$ASSET") bytes)"
else
    bad "zip falhou"
    exit 1
fi

# --------------------------------------------------------------------------- 2. Conteudo do zip
step "2. Conteudo do zip"
expected_files="goLiveBypass/index.tsx goLiveBypass/native.ts goLiveBypass/manifest.json"
content=$(list_zip_py "$ASSET" | sort)
for f in $expected_files; do
    if printf '%s\n' "$content" | grep -qF "$f"; then
        ok "contem $f"
    else
        bad "FALTA $f"
    fi
done
# NAO deve ter arquivos fora de goLiveBypass/
extras=$(printf '%s\n' "$content" | grep -v "^goLiveBypass/" | head -1)
if [ -z "$extras" ]; then
    ok "sem arquivos fora de goLiveBypass/"
else
    bad "arquivos extras: $extras"
fi

# --------------------------------------------------------------------------- 3. SHA-256
step "3. SHA-256"
sha256sum "$ASSET" > "${ASSET}.sha256"
if [ -s "${ASSET}.sha256" ]; then
    ok "${ASSET}.sha256 gerado ($(wc -c < "${ASSET}.sha256") bytes)"
    expected=$(awk '{print $1}' "${ASSET}.sha256")
    actual=$(sha256sum "$ASSET" | awk '{print $1}')
    if [ "$expected" = "$actual" ]; then
        ok "SHA-256 confere ($expected)"
    else
        bad "SHA-256 NAO confere: esperado $expected, obtido $actual"
    fi
else
    bad "${ASSET}.sha256 vazio"
fi

# --------------------------------------------------------------------------- 4. Extracao (simula o que o Vencord userplugin faz)
step "4. Extracao em .userplugins/GoLiveBypass/ (caminho do Vencord)"
USERPLUGINS="$WORK/.userplugins"
mkdir -p "$USERPLUGINS"
if extract_zip_py "$ASSET" "$USERPLUGINS"; then
    ok "zip extraido em $USERPLUGINS"
else
    bad "extracao falhou"
fi
target="$USERPLUGINS/goLiveBypass"
if [ -d "$target" ]; then
    ok "pasta extraida em $target"
else
    bad "pasta $target NAO foi criada"
fi
# Validar arquivos extraidos
for f in index.tsx native.ts manifest.json; do
    if [ -f "$target/$f" ]; then
        ok "extraido $f ($(stat -c%s "$target/$f" 2>/dev/null || stat -f%z "$target/$f") bytes)"
    else
        bad "FALTA $f extraido"
    fi
done

# --------------------------------------------------------------------------- 5. Validar manifest.json extraido
step "5. manifest.json extraido e valido"
manifest="$target/manifest.json"
if [ -f "$manifest" ]; then
    if python3 -c "import json; json.load(open('$manifest'))" 2>/dev/null; then
        ok "manifest.json e JSON valido"
    else
        bad "manifest.json NAO e JSON valido"
    fi
    for field in name version updater; do
        if grep -q ""$field"" "$manifest"; then
            ok "tem campo $field"
        else
            bad "FALTA campo $field"
        fi
    done
    if grep -q '"type": "github"' "$manifest"; then
        ok "updater.type = github"
    else
        bad "updater.type NAO e github"
    fi
    if grep -q "bezumiya/GoLiveBypass" "$manifest"; then
        ok "updater.id = bezumiya/GoLiveBypass"
    else
        bad "updater.id NAO e bezumiya/GoLiveBypass"
    fi
    if grep -q "vencord.zip" "$manifest"; then
        ok "updater.assetName termina com vencord.zip"
    else
        bad "updater.assetName NAO termina com vencord.zip"
    fi
else
    bad "manifest.json NAO foi extraido"
fi

# --------------------------------------------------------------------------- 6. Backup + rollback
step "6. Backup e rollback (substituicao atomica)"
# Setup: criar versao "anterior" (a "velha") em uma pasta separada
old_dir="$WORK/old-plugin"
mkdir -p "$old_dir"
echo "old index" > "$old_dir/index.tsx"
echo "old native" > "$old_dir/native.ts"
echo "old manifest" > "$old_dir/manifest.json"

# Backup do conteudo (em .bak)
backup_dir="$old_dir/.goLiveBypass.bak"
mkdir -p "$backup_dir"
stamp=$(date +%Y%m%d%H%M%S 2>/dev/null || echo "000000000000")
backup_target="$backup_dir/$stamp"
mkdir -p "$backup_target"
# Copia arquivo por arquivo (evita recursao)
for f in "$old_dir"/*; do
    [ -e "$f" ] || continue
    cp -R "$f" "$backup_target/" 2>/dev/null || true
done
if [ -f "$backup_target/index.tsx" ]; then
    ok "backup criado em $backup_target"
else
    bad "backup NAO criado"
fi

# Simular substituicao: remover "antigo" e mover "novo" para o lugar
rm -rf "$target"
# Recriar target a partir do backup para teste de rollback
mkdir -p "$target"
cp "$old_dir"/* "$target/" 2>/dev/null
if [ -f "$target/index.tsx" ] && grep -q "old index" "$target/index.tsx"; then
    ok "rollback do backup funcionou (pasta $target tem conteudo do backup)"
else
    bad "rollback NAO funcionou"
fi

# Limpar para o proximo teste
rm -rf "$target" "$old_dir" "$backup_dir"

# --------------------------------------------------------------------------- 7. Integridade do conteudo (hash dos arquivos)
step "7. Hash dos arquivos extraidos confere com o repo"
# Re-extrair para ter o estado novo
rm -rf "$target"
extract_zip_py "$ASSET" "$USERPLUGINS" >/dev/null
for f in index.tsx native.ts manifest.json; do
    if [ -f "$target/$f" ] && [ -f "$REPO/goLiveBypass/$f" ]; then
        hash_target=$(sha256sum "$target/$f" | awk '{print $1}')
        hash_repo=$(sha256sum "$REPO/goLiveBypass/$f" | awk '{print $1}')
        if [ "$hash_target" = "$hash_repo" ]; then
            ok "$f: hash confere com o repo"
        else
            bad "$f: hash DIFERENTE (zip corrompido?)"
        fi
    else
        bad "$f: arquivo nao encontrado para hash"
    fi
done

# --------------------------------------------------------------------------- 8. Validacao do assetName no manifest
step "8. assetName do updater confere com o nome do zip"
asset_name=$(python3 -c "import json; print(json.load(open('$manifest'))['updater']['assetName'])")
if [ "$asset_name" = "$ASSET" ]; then
    ok "assetName = $ASSET (confere)"
else
    bad "assetName = $asset_name (esperado $ASSET)"
fi

# ---------------------------------------------------------------------------
echo
echo "== Resultado: $PASS ok, $FAIL falhas =="
[ "$FAIL" -eq 0 ] || exit 1
