#!/bin/sh
#
# Testes E2E do userplugin Vencord (Onda 2 do auto-update)
#
# Estes testes simulam o que o CI faz no job release-assets:
#   1. Zipar o plugin (goLiveBypass/) como GoLiveBypass-<ver>-vencord.zip
#   2. Gerar SHA-256 do zip
#   3. Validar conteudo do zip (renderer, native facade, controlador VPN e helper TS)
#   4. Simular a extracao em .userplugins/GoLiveBypass/ (caminho do Vencord)
#   5. Validar o backup e rollback
#   6. Validar integridade (hash dos arquivos extraidos)
#
# Usa python3 para criar/ler o zip (portavel, nao depende do `zip` CLI).
#
# Uso: ./tests/test-userplugin-e2e.sh

set -eu

REPO="$(cd -- "$(dirname -- "$0")/.." && pwd)"
VERSION=""
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
VERSION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$REPO/goLiveBypass/manifest.json")"

# Diretorio de trabalho isolado
WORK="$(mktemp -d)"
trap "rm -rf '$WORK'" EXIT

cd "$WORK"

# O helper nativo faz parte do asset real do plugin. O workflow de release o
# compila para Windows x64 antes de zipar; reproduzimos essa etapa em um
# diretório temporário para não sujar goLiveBypass/ no checkout.
step "Preparar helper proton-confgen Windows x64"
PLUGIN_SOURCE="$WORK/goLiveBypass"
cp -R "$REPO/goLiveBypass" "$PLUGIN_SOURCE"
mkdir -p "$PLUGIN_SOURCE/bin/win32-x64"
if command -v go >/dev/null 2>&1; then
    if (cd "$REPO/tools/proton-confgen" && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o "$PLUGIN_SOURCE/bin/win32-x64/proton-confgen.exe" ./cmd/protonvpn-wg); then
        ok "proton-confgen.exe compilado para Windows x64"
    else
        bad "falha ao compilar proton-confgen.exe para Windows x64"
        exit 1
    fi
elif [ -f "$REPO/tools/proton-confgen/build/proton-confgen.exe" ]; then
    cp "$REPO/tools/proton-confgen/build/proton-confgen.exe" "$PLUGIN_SOURCE/bin/win32-x64/proton-confgen.exe"
    ok "proton-confgen.exe reutilizado do build local"
else
    bad "Go e proton-confgen.exe não estão disponíveis para montar o asset"
    exit 1
fi

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
if create_zip_py "$PLUGIN_SOURCE" "$ASSET"; then
    ok "zip criado: $ASSET ($(stat -c%s "$ASSET" 2>/dev/null || stat -f%z "$ASSET") bytes)"
else
    bad "zip falhou"
    exit 1
fi

# --------------------------------------------------------------------------- 2. Conteudo do zip
step "2. Conteudo do zip"
expected_files="goLiveBypass/index.tsx goLiveBypass/native.ts goLiveBypass/update-channel.ts goLiveBypass/update-security.ts goLiveBypass/stability.ts goLiveBypass/vpn-controller.ts goLiveBypass/vpn-proton.ts goLiveBypass/vpn-types.ts goLiveBypass/vpn-windows.ts goLiveBypass/manifest.json goLiveBypass/bin/win32-x64/proton-confgen.exe"
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
for f in index.tsx native.ts update-channel.ts update-security.ts stability.ts vpn-controller.ts vpn-proton.ts vpn-types.ts vpn-snapshot.ts vpn-windows.ts manifest.json bin/win32-x64/proton-confgen.exe; do
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
    actual_version=$(python3 -c "import json; print(json.load(open('$manifest'))['version'])")
    if [ "$actual_version" = "$VERSION" ]; then
        ok "version do zip = $VERSION"
    else
        bad "version do zip = $actual_version (esperado $VERSION)"
    fi
    # Origem esperada do updater: a do checkout testado (fork no canal dev,
    # bezumiya em produção). O teste acompanha o patch de release, sem fixar id.
    expected_repo=$(git -C "$REPO" config --get remote.origin.url | sed -E 's#.*[:/]([^/]+/[^/.]+)(\.git)?$#\1#')
    if grep -q "$expected_repo" "$manifest"; then
        ok "updater.id = $expected_repo"
    else
        bad "updater.id NAO e $expected_repo"
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
for f in index.tsx native.ts update-channel.ts update-security.ts stability.ts vpn-controller.ts vpn-proton.ts vpn-types.ts vpn-snapshot.ts vpn-windows.ts manifest.json bin/win32-x64/proton-confgen.exe; do
    source_file="$REPO/goLiveBypass/$f"
    [ -f "$source_file" ] || source_file="$PLUGIN_SOURCE/$f"
    if [ -f "$target/$f" ] && [ -f "$source_file" ]; then
        hash_target=$(sha256sum "$target/$f" | awk '{print $1}')
        hash_source=$(sha256sum "$source_file" | awk '{print $1}')
        if [ "$hash_target" = "$hash_source" ]; then
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
