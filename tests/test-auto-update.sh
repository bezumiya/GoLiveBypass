#!/bin/sh
#
# Testes do auto-update do instalador GoLiveBypass
#
# O auto-update adiciona 2 modos novos:
#   --check-update: so consulta o GitHub, nao mexe
#   --update: aplica update se houver versao nova
#
# Estes testes validam:
#   1. sintaxe do instalador (sh -n) em sh, dash, bash
#   2. modos novos reconhecidos pelo arg parsing
#   3. funcoes de auto-update definidas
#   4. manifest.json presente com version e updater
#   5. funcoes puras (compare_version, installed_plugin_version, backup_plugin)
#
# Uso: ./tests/test-auto-update.sh

set -eu

REPO="$(cd -- "$(dirname -- "$0")/.." && pwd)"
PASS=0
FAIL=0

step() { printf '  [*] %s\n' "$1" >&2; }
ok()   { PASS=$((PASS + 1)); printf '  [OK] %s\n' "$1" >&2; }
bad()  { FAIL=$((FAIL + 1)); printf '  [FAIL] %s\n' "$1" >&2; }

# Cria um checkout fake do Vencord/Equicord com o plugin ja copiado
make_fake_checkout_with_plugin() {
    local root="$1"
    local version="${2:-1.1.8}"
    rm -rf "$root"
    mkdir -p "$root/src/userplugins/goLiveBypass"
    # Cria o manifest.json com a versao especificada
    cat > "$root/src/userplugins/goLiveBypass/manifest.json" <<EOF
{
  "name": "GoLiveBypass",
  "version": "$version",
  "updater": {
    "type": "github",
    "id": "bezumiya/GoLiveBypass",
    "assetName": "goLiveBypass-vencord.zip"
  }
}
EOF
    # Cria os outros arquivos do plugin
    echo "fake" > "$root/src/userplugins/goLiveBypass/index.tsx"
    echo "fake" > "$root/src/userplugins/goLiveBypass/native.ts"
}

# Extrai as funcoes de auto-update para um harness (sem main)
extract_update_functions() {
    awk '
        /^# Auto-update via GitHub Releases/ { found=1 }
        found && /^main_menu\(\) \{/ { exit }
        found { print }
    ' "$REPO/installer/golivebypass-installer.sh"
    # backup_plugin() usa PLUGIN_DIR_NAME (constante global) que nao esta no harness.
    printf "PLUGIN_DIR_NAME=\"goLiveBypass\"\n"
    printf "GITHUB_REPO=\"bezumiya/GoLiveBypass\"\n"
    printf "GITHUB_API=\"https://api.github.com/repos/bezumiya/GoLiveBypass\"\n"
    printf "GITHUB_UA=\"GoLiveBypass-Installer\"\n"
}

# --------------------------------------------------------------------------- 1. Sintaxe
echo
echo "== 1. Sintaxe do instalador com auto-update =="
for shell in sh dash bash; do
    if sh -c "command -v $shell" >/dev/null 2>&1; then
        if sh -c "$shell -n $REPO/installer/golivebypass-installer.sh" 2>/dev/null; then
            ok "sintaxe $shell (local)"
        else
            bad "sintaxe $shell (local)"
        fi
    fi
done

# --------------------------------------------------------------------------- 2. PLUGIN_FILES inclui manifest.json
echo
echo "== 2. PLUGIN_FILES inclui manifest.json =="
if grep -F "manifest.json" "$REPO/installer/golivebypass-installer.sh" >/dev/null 2>&1; then
    ok "manifest.json listado em PLUGIN_FILES"
else
    bad "manifest.json NAO listado em PLUGIN_FILES"
fi

# --------------------------------------------------------------------------- 3. Modos novos reconhecidos
echo
echo "== 3. Modos --check-update e --update reconhecidos =="
if grep -F -e --check-update "$REPO/installer/golivebypass-installer.sh" >/dev/null 2>&1; then
    ok "modo --check-update presente"
else
    bad "modo --check-update NAO presente"
fi
if grep -F -e --update "$REPO/installer/golivebypass-installer.sh" >/dev/null 2>&1; then
    ok "modo --update presente"
else
    bad "modo --update NAO presente"
fi

# --------------------------------------------------------------------------- 4. Funcoes de auto-update definidas
echo
echo "== 4. Funcoes de auto-update definidas =="
for fn in github_latest_release installed_plugin_version compare_version backup_plugin do_check_update do_update do_update_from_zip; do
    if grep -E "^${fn}\(\) \{" "$REPO/installer/golivebypass-installer.sh" >/dev/null 2>&1; then
        ok "funcao $fn() definida"
    else
        bad "funcao $fn() NAO definida"
    fi
done

# --------------------------------------------------------------------------- 5. Manifest.json do plugin
echo
echo "== 5. goLiveBypass/manifest.json existe e tem campos =="
if [ -f "$REPO/goLiveBypass/manifest.json" ]; then
    ok "manifest.json presente"
    if grep -F -e '"version"' "$REPO/goLiveBypass/manifest.json" >/dev/null 2>&1; then
        ver=$(grep -oE '"version"[[:space:]]*:[[:space:]]*"[^"]+"' "$REPO/goLiveBypass/manifest.json" | head -1 | sed 's/.*"\([^"]*\)".*/\1/')
        ok "manifest.json tem version=$ver"
    else
        bad "manifest.json NAO tem campo version"
    fi
    if grep -F -e '"updater"' "$REPO/goLiveBypass/manifest.json" >/dev/null 2>&1; then
        ok "manifest.json tem updater"
    else
        bad "manifest.json NAO tem campo updater"
    fi
else
    bad "manifest.json NAO existe em goLiveBypass/"
fi

# --------------------------------------------------------------------------- 6. compare_version (semver)
echo
echo "== 6. compare_version (semver) =="
HARNESS="$(mktemp)"
extract_update_functions > "$HARNESS"

test_compare() {
    local installed="$1" latest="$2" expected="$3" desc="$4"
    local actual
    actual=$(sh -c ". $HARNESS; compare_version '$installed' '$latest'")
    if [ "$actual" = "$expected" ]; then
        ok "compare_version($installed, $latest) = $expected  [$desc]"
    else
        bad "compare_version($installed, $latest) = $actual (esperado $expected)  [$desc]"
    fi
}

test_compare "1.1.8" "1.1.8" "0"  "mesma versao"
test_compare "1.1.8" "1.1.9" "-1" "patch update"
test_compare "1.1.8" "1.2.0" "-1" "minor update"
test_compare "1.1.8" "2.0.0" "-1" "major update"
test_compare "1.1.9" "1.1.8" "1"  "downgrade"
test_compare "1.2.0" "1.1.8" "1"  "minor downgrade"
test_compare ""      "1.1.8" "-1" "instalado vazio"
test_compare "1.1.8" ""      "0"  "latest vazio"
test_compare "1.9.0" "1.10.0" "-1" "10 > 9 (sort -V)"
test_compare "1.10.0" "1.9.0" "1"  "1.10 > 1.9"

# --------------------------------------------------------------------------- 7. installed_plugin_version
echo
echo "== 7. installed_plugin_version =="

# Teste 1: manifest presente
TMP="$(mktemp -d)"
make_fake_checkout_with_plugin "$TMP/repo" "2.0.0"
ver=$(sh -c ". $HARNESS; installed_plugin_version '$TMP/repo/src/userplugins/goLiveBypass'")
if [ "$ver" = "2.0.0" ]; then
    ok "installed_plugin_version le manifest.json corretamente (2.0.0)"
else
    bad "installed_plugin_version: esperado 2.0.0, obtido '$ver'"
fi
rm -rf "$TMP"

# Teste 2: manifest ausente
TMP="$(mktemp -d)"
mkdir -p "$TMP/empty"
ver=$(sh -c ". $HARNESS; installed_plugin_version '$TMP/empty'")
if [ -z "$ver" ]; then
    ok "installed_plugin_version retorna vazio sem manifest"
else
    bad "installed_plugin_version: esperado vazio, obtido '$ver'"
fi
rm -rf "$TMP"

# --------------------------------------------------------------------------- 8. backup_plugin
echo
echo "== 8. backup_plugin =="

TMP="$(mktemp -d)"
make_fake_checkout_with_plugin "$TMP/repo" "1.1.8"
sh -c ". $HARNESS; backup_plugin '$TMP/repo'" 2>/dev/null
backup_dir="$TMP/repo/src/userplugins/.goLiveBypass.bak"
if [ -d "$backup_dir" ] && ls -1 "$backup_dir" 2>/dev/null | grep -q .; then
    ok "backup_plugin criou pasta de backup com timestamp"
else
    bad "backup_plugin NAO criou backup"
fi

# Teste de retencao: rodar 4x e ver que mantem so 3
TMP="$(mktemp -d)"
make_fake_checkout_with_plugin "$TMP/repo" "1.1.8"
backup_dir="$TMP/repo/src/userplugins/.goLiveBypass.bak"
sh -c "
. $HARNESS
backup_plugin '$TMP/repo'
sleep 1
backup_plugin '$TMP/repo'
sleep 1
backup_plugin '$TMP/repo'
sleep 1
backup_plugin '$TMP/repo'
" 2>/dev/null
count=$(ls -1 "$backup_dir" 2>/dev/null | wc -l | tr -d ' ')
if [ "$count" -le 3 ]; then
    ok "backup_plugin retem no maximo 3 backups (encontrou $count)"
else
    bad "backup_plugin retem $count backups (esperado <=3)"
fi
rm -rf "$TMP"

rm -f "$HARNESS"

# --------------------------------------------------------------------------- 9. Uso documentado
echo
echo "== 9. Documentacao do auto-update =="
if head -30 "$REPO/installer/golivebypass-installer.sh" | grep -F -e --check-update >/dev/null 2>&1; then
    ok "uso do instalador menciona --check-update"
else
    bad "uso do instalador NAO menciona --check-update"
fi
if head -30 "$REPO/installer/golivebypass-installer.sh" | grep -F -e --update >/dev/null 2>&1; then
    ok "uso do instalador menciona --update"
else
    bad "uso do instalador NAO menciona --update"
fi

# ---------------------------------------------------------------------------
echo
echo "== Resultado: $PASS ok, $FAIL falhas =="
[ "$FAIL" -eq 0 ] || exit 1
