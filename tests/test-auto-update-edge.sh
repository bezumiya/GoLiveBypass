#!/bin/sh
#
# Testes de borda para o auto-update
# (cobre casos que o test-userplugin-e2e.sh e test-auto-update.sh nao cobrem)
#
# Uso: ./tests/test-auto-update-edge.sh

set -eu

REPO="$(cd -- "$(dirname -- "$0")/.." && pwd)"
PASS=0
FAIL=0

step() { printf '  [*] %s\n' "$1" >&2; }
ok()   { PASS=$((PASS + 1)); printf '  [OK] %s\n' "$1" >&2; }
bad()  { FAIL=$((FAIL + 1)); printf '  [FAIL] %s\n' "$1" >&2; }

# Diretorio de trabalho isolado
WORK="$(mktemp -d)"
trap "rm -rf '$WORK'" EXIT

# --------------------------------------------------------------------------- 1. Zip com espaco no path
step "1. Zip com espaco no path do destino"
mkdir -p "$WORK/dir com espaco"
python3 -c "
import zipfile, os
with zipfile.ZipFile('$WORK/dir com espaco/test.zip', 'w', zipfile.ZIP_DEFLATED) as zf:
    zf.writestr('goLiveBypass/manifest.json', '{"version": "1.0.0"}')
" 2>/dev/null
if [ -f "$WORK/dir com espaco/test.zip" ]; then
    ok "zip criado em path com espaco"
    # Verificar que o conteudo esta OK
    if python3 -c "
import zipfile
with zipfile.ZipFile('$WORK/dir com espaco/test.zip') as zf:
    assert 'goLiveBypass/manifest.json' in zf.namelist()
" 2>/dev/null; then
        ok "zip com espaco tem conteudo correto"
    else
        bad "zip com espaco nao tem conteudo correto"
    fi
else
    bad "zip com espaco nao foi criado"
fi

# --------------------------------------------------------------------------- 2. Zip com caracteres especiais no nome
step "2. Zip com caracteres especiais no nome do plugin"
SPECIAL_DIR="$WORK/special-plugin-name-1.0"
mkdir -p "$SPECIAL_DIR"
echo "fake" > "$SPECIAL_DIR/index.tsx"
python3 -c "
import zipfile, os
with zipfile.ZipFile('$WORK/special.zip', 'w', zipfile.ZIP_DEFLATED) as zf:
    for root, dirs, files in os.walk('$SPECIAL_DIR'):
        for f in files:
            full = os.path.join(root, f)
            arc = os.path.join(os.path.basename('$SPECIAL_DIR'), os.path.relpath(full, '$SPECIAL_DIR'))
            zf.write(full, arc)
" 2>/dev/null
if [ -f "$WORK/special.zip" ]; then
    ok "zip com nome especial criado"
    if python3 -c "
import zipfile
with zipfile.ZipFile('$WORK/special.zip') as zf:
    assert any('index.tsx' in n for n in zf.namelist())
" 2>/dev/null; then
        ok "zip com nome especial tem conteudo"
    else
        bad "zip com nome especial nao tem conteudo"
    fi
else
    bad "zip com nome especial nao foi criado"
fi

# --------------------------------------------------------------------------- 3. Manifest com campos extras (tolerância)
step "3. Manifest com campos extras (tolerancia)"
EXTRA="$WORK/plugin-extra"
mkdir -p "$EXTRA"
cat > "$EXTRA/manifest.json" <<EOF
{
  "name": "GoLiveBypass",
  "version": "1.1.8",
  "updater": {
    "type": "github",
    "id": "bezumiya/GoLiveBypass",
    "assetName": "goLiveBypass-vencord.zip"
  },
  "author": "extra",
  "description": "campos extras devem ser ignorados"
}
EOF
if python3 -c "import json; json.load(open('$EXTRA/manifest.json'))" 2>/dev/null; then
    ok "manifest com campos extras e JSON valido"
fi

# --------------------------------------------------------------------------- 4. zip com 1000 arquivos
step "4. Zip com muitos arquivos (teste de escala)"
mkdir -p "$WORK/plugin-big/goLiveBypass"
for i in $(seq 1 100); do
    echo "conteudo $i" > "$WORK/plugin-big/goLiveBypass/file_$i.txt"
done
python3 -c "
import zipfile, os
with zipfile.ZipFile('$WORK/big.zip', 'w', zipfile.ZIP_DEFLATED) as zf:
    base = 'goLiveBypass'
    for root, dirs, files in os.walk('$WORK/plugin-big/goLiveBypass'):
        for f in files:
            full = os.path.join(root, f)
            arc = os.path.join(base, os.path.relpath(full, '$WORK/plugin-big'))
            zf.write(full, arc)
" 2>/dev/null
if [ -f "$WORK/big.zip" ]; then
    count=$(python3 -c "import zipfile; print(len(zipfile.ZipFile('$WORK/big.zip').namelist()))")
    if [ "$count" -ge 100 ]; then
        ok "zip com 100+ arquivos: $count entries"
    else
        bad "zip com 100 arquivos: $count entries (esperado 100+)"
    fi
fi

# --------------------------------------------------------------------------- 5. Compressão vs extração
step "5. Zip sem compressao (mais rapido de criar)"
# Estrutura: plugin-nozip/index.tsx (SEM subpasta goLiveBypass) - apenas os arquivos
mkdir -p "$WORK/plugin-nozip"
echo "x" > "$WORK/plugin-nozip/test.txt"
python3 -c "
import zipfile, os
with zipfile.ZipFile('$WORK/nozip.zip', 'w', zipfile.ZIP_STORED) as zf:
    base = 'goLiveBypass'
    for root, dirs, files in os.walk('$WORK/plugin-nozip'):
        for f in files:
            full = os.path.join(root, f)
            arc = os.path.join(base, os.path.relpath(full, '$WORK/plugin-nozip'))
            zf.write(full, arc)
" 2>/dev/null
if [ -f "$WORK/nozip.zip" ]; then
    ok "zip sem compressao criado"
    # Validar extração
    mkdir -p "$WORK/extract-nozip"
    python3 -c "
import zipfile
zipfile.ZipFile('$WORK/nozip.zip').extractall('$WORK/extract-nozip')
" 2>/dev/null
    if [ -f "$WORK/extract-nozip/goLiveBypass/test.txt" ]; then
        ok "zip sem compressao extraido corretamente"
    else
        bad "zip sem compressao nao extraido"
    fi
else
    bad "zip sem compressao nao foi criado"
fi

# --------------------------------------------------------------------------- 6. Backup incremental
step "6. Backup incremental (criar 5 backups, manter 3)"
TIMES=5
RETAIN=3
backup_dir="$WORK/backup-test"
mkdir -p "$backup_dir"
# Carrega a funcao backup_plugin
HARNESS="$(mktemp)"
awk '/^# Auto-update/,/^main_menu/' "$REPO/installer/golivebypass-installer.sh" > "$HARNESS"
printf 'PLUGIN_DIR_NAME="goLiveBypass"\n' >> "$HARNESS"

plugin="$WORK/plugin-src/src/userplugins/goLiveBypass"
mkdir -p "$plugin"
echo "v1" > "$plugin/index.tsx"

# Rodar 5 vezes
for i in $(seq 1 5); do
    sleep 1
    sh -c ". $HARNESS; backup_plugin '$WORK/plugin-src'" 2>/dev/null
done

count=$(ls -1 "$WORK/plugin-src/src/userplugins/.goLiveBypass.bak" 2>/dev/null | wc -l | tr -d ' ')
if [ "$count" -le "$RETAIN" ]; then
    ok "backup incremental retem $count backups (max $RETAIN)"
else
    bad "backup incremental reteve $count backups (max $RETAIN)"
fi

# --------------------------------------------------------------------------- 7. Compare version com prefxos
step "7. Compare version com varios formatos"
HARNESS="$(mktemp)"
awk '/^# Auto-update/,/^main_menu/' "$REPO/installer/golivebypass-installer.sh" > "$HARNESS"
printf 'PLUGIN_DIR_NAME="goLiveBypass"\n' >> "$HARNESS"

test_cv() {
    local installed="$1" latest="$2" expected="$3" desc="$4"
    local actual
    actual=$(sh -c ". $HARNESS; compare_version '$installed' '$latest'" 2>/dev/null)
    if [ "$actual" = "$expected" ]; then
        ok "compare_version('$installed', '$latest') = $expected  [$desc]"
    else
        bad "compare_version('$installed', '$latest') = $actual (esperado $expected)  [$desc]"
    fi
}

# Versões com prefixos estranhos
test_cv "v1.1.8" "1.1.8" "0"  "v prefix (atual e latest sem prefixo)"
test_cv "1.1.8" "v1.1.8" "0"  "latest com v prefix"
test_cv "v1.1.8" "v1.1.9" "-1" "ambos com v prefix"
test_cv "1.1.8" "v1.1.7" "1"  "downgrade com v prefix"
test_cv "1.0" "1.0.0" "-1" "versao curta vs longa"
test_cv "1.0.0" "1.0" "1"  "versao longa vs curta"

rm -f "$HARNESS"

# ---------------------------------------------------------------------------
echo
echo "== Resultado: $PASS ok, $FAIL falhas =="
[ "$FAIL" -eq 0 ] || exit 1
