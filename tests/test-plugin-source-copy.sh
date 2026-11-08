#!/bin/sh
# Regressao do instalador: toda fonte importada precisa chegar ao mesmo userplugin antes do build.
set -eu

REPO="$(cd -- "$(dirname -- "$0")/.." && pwd)"
TMP="$(mktemp -d -t golive-plugin-copy.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

PLUGIN_FILES="goLiveBypass/index.tsx goLiveBypass/native.ts goLiveBypass/plugin-build.ts goLiveBypass/plugin-log.ts goLiveBypass/bug-report.ts goLiveBypass/update-channel.ts goLiveBypass/update-security.ts goLiveBypass/stability.ts goLiveBypass/proton-manual-selection.ts goLiveBypass/vpn-controller.ts goLiveBypass/vpn-proton.ts goLiveBypass/vpn-types.ts goLiveBypass/vpn-snapshot.ts goLiveBypass/vpn-snapshot-worker.ts goLiveBypass/vpn-windows.ts goLiveBypass/vpn-linux.ts goLiveBypass/manifest.json"
export PLUGIN_FILES

# A fonte da verdade dos módulos é a importação estática do plugin, não uma lista duplicada
# neste harness. Incluímos index.tsx e native.ts porque o instalador copia os dois entrypoints;
# a união transitiva captura qualquer módulo local novo antes que a lista fique incompleta.
REPO="$REPO" node <<'NODE'
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repo = process.env.REPO;
const root = path.join(repo, "goLiveBypass");
const extensions = [".ts", ".tsx", ".json"];
const resolveLocal = (from, specifier) => {
    const base = path.resolve(path.dirname(from), specifier);
    for (const candidate of [base, ...extensions.map(ext => `${base}${ext}`), ...extensions.map(ext => path.join(base, `index${ext}`))]) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
    return null;
};
const importsOf = file => {
    const source = fs.readFileSync(file, "utf8");
    const result = [];
    const re = /\b(?:import|export)\s+(?:[^"'()]*?\sfrom\s+)?["']([^"']+)["']/g;
    for (const match of source.matchAll(re)) {
        if (!match[1].startsWith(".")) continue;
        const resolved = resolveLocal(file, match[1]);
        if (resolved) result.push(resolved);
    }
    return result;
};
const visited = new Set();
const visit = file => {
    if (visited.has(file)) return;
    visited.add(file);
    for (const imported of importsOf(file)) visit(imported);
};
for (const entry of ["index.tsx", "native.ts"]) visit(path.join(root, entry));
const required = [...visited].map(file => path.relative(repo, file).replaceAll(path.sep, "/")).sort();
const requiredBasenames = new Set(required.map(file => path.basename(file)));
const shell = fs.readFileSync(path.join(repo, "installer/golivebypass-installer.sh"), "utf8");
const shellList = shell.match(/^PLUGIN_FILES="([^"]+)"/m)?.[1]?.split(/\s+/).filter(Boolean) ?? [];
const powershell = fs.readFileSync(path.join(repo, "installer/GoLiveBypass-Installer.ps1"), "utf8");
const powershellBlock = powershell.match(/\$PluginFiles = @\(([\s\S]*?)^\)/m)?.[1] ?? "";
const powershellList = [...powershellBlock.matchAll(/'([^']+)'/g)].map(match => match[1]);
const native = fs.readFileSync(path.join(root, "native.ts"), "utf8");
const nativeBlock = native.match(/function requiredFilesForPlatform\([\s\S]*?^\}/m)?.[0] ?? "";
const nativeList = [...nativeBlock.matchAll(/"([^"]+)"/g)].map(match => match[1]);
for (const [label, listed] of [["standalone", shellList], ["powershell", powershellList], ["native", nativeList]]) {
    const listedBasenames = new Set(listed.map(file => path.basename(file)));
    const missing = [...requiredBasenames].filter(file => !listedBasenames.has(file)).sort();
    assert.deepEqual(missing, [], `${label} omite imports locais transitivos: ${missing.join(", ")}`);
}
console.log(`ok - imports locais transitivos cobertos (${required.length} arquivos): ${required.join(", ")}`);
NODE

# Carrega somente as funcoes puras do instalador; o CLI principal nunca roda no harness.
FUNCTIONS="$TMP/functions.sh"
awk '/^validate_plugin_source_tree\(\)/,/^# De onde vem o plugin instalado/ { print }' \
    "$REPO/installer/golivebypass-installer.sh" > "$FUNCTIONS"
# sync_mod_deps e log_build_context ficam logo acima de build_mod e fazem parte do build.
awk '/^sync_mod_deps\(\)/,/^remove_plugin_source\(\)/ {
    if ($0 !~ /^remove_plugin_source\(\)/) print
}' "$REPO/installer/golivebypass-installer.sh" >> "$FUNCTIONS"
cat >> "$FUNCTIONS" <<'EOF'
PLUGIN_DIR_NAME="goLiveBypass"
step() { :; }
warn() { :; }
installer_log() { :; }
checkout_mod() { printf '%s\n' Equicord; }
fail() { printf '%s\n' "$*" >&2; exit 97; }
EOF

make_source() {
    source="$1"
    mkdir -p "$source"
    for file in $PLUGIN_FILES; do
        printf 'module %s\n' "$(basename "$file")" > "$source/$(basename "$file")"
    done
}

SOURCE="$TMP/source"
ROOT="$TMP/Equicord"
make_source "$SOURCE"
mkdir -p "$ROOT/node_modules"

# O build fake falha se qualquer required file nao estiver no mesmo diretorio do plugin.
mkdir -p "$TMP/bin"
cat > "$TMP/bin/pnpm" <<'EOF'
#!/bin/sh
set -eu
# O build sempre e precedido pela sincronizacao das dependencias.
[ "${1:-}" = install ] && exit 0
[ "${1:-}" = build ] || exit 2
for file in $PLUGIN_FILES; do
    test -s "$ROOT/src/userplugins/$PLUGIN_DIR_NAME/$(basename "$file")" || {
        printf 'missing %s\n' "$file" >&2
        exit 3
    }
done
printf 'fake pnpm build ok\n'
EOF
chmod +x "$TMP/bin/pnpm"

# Copia completa e build: cobre estabilidade.ts e vpn-types.ts, os imports do relato.
ROOT="$ROOT" PLUGIN_DIR_NAME=goLiveBypass PLUGIN_SOURCE="$SOURCE" \
    PATH="$TMP/bin:$PATH" sh -eu -c ". '$FUNCTIONS'; copy_plugin_from_repo '$ROOT'; build_mod '$ROOT'"

for file in $PLUGIN_FILES; do
    test -s "$ROOT/src/userplugins/goLiveBypass/$(basename "$file")"
done
printf '%s\n' 'ok - copia completa atende o build fake'

# Uma fonte local incompleta deve falhar explicitamente, mesmo quando o destino ja tem um
# modulo stale com o mesmo nome; nunca aceitar uma arvore parcial para compilar.
INCOMPLETE="$TMP/incomplete"
make_source "$INCOMPLETE"
rm -f "$INCOMPLETE/stability.ts"
STALE_ROOT="$TMP/Stale"
mkdir -p "$STALE_ROOT/src/userplugins/goLiveBypass"
printf 'stale\n' > "$STALE_ROOT/src/userplugins/goLiveBypass/stability.ts"
if ROOT="$STALE_ROOT" PLUGIN_DIR_NAME=goLiveBypass PLUGIN_SOURCE="$INCOMPLETE" \
    sh -eu -c ". '$FUNCTIONS'; copy_plugin_from_repo '$STALE_ROOT'" >"$TMP/fail.out" 2>&1; then
    printf '%s\n' 'fail - arvore incompleta foi aceita' >&2
    exit 1
fi
grep -F 'Nao achei stability.ts' "$TMP/fail.out" >/dev/null
printf '%s\n' 'ok - copia incompleta falha antes do build'
