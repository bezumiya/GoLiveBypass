#!/bin/sh
#
# Vesktop + checkout Vencord: o build do Vencord nao gera dist/vesktop.asar, entao o patch
# direto (copiar asar) nunca funcionou para o Vesktop. O instalador agora grava o "Vencord
# Location" do proprio Vesktop (state.json -> vencordDir). Este teste chama patch_parallel_one()
# contra checkouts/clientes fake, sem rede, sem Discord e sem tocar no flatpak da maquina.
#
# Extrai as funcoes do installer/golivebypass-installer.sh ate o "banner" (como os outros
# testes do instalador) e roda em dash. Precisa de dash e node (o instalador ja exige node).
#
# Uso:
#   ./tests/test-vesktop-vencord-dir.sh

set -eu

REPO="$(cd -- "$(dirname -- "$0")/.." && pwd)"
SHELL_BIN="${SHELL_BIN:-dash}"
command -v "$SHELL_BIN" >/dev/null 2>&1 || { echo "Preciso do $SHELL_BIN." >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "Preciso do node." >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT INT TERM
HARNESS="$TMP/harness.sh"
awk '/^banner$/{exit} {print}' "$REPO/installer/golivebypass-installer.sh" | tr -d '\r' > "$HARNESS"
cat >> "$HARNESS" <<'H_EOF'

# O flatpak real da maquina fica de fora: o teste so confere o caminho do state.json.
have() { [ "$1" != flatpak ] && command -v "$1" >/dev/null 2>&1; }

falhas=0
check() {
    if [ "$2" -eq 0 ]; then printf '  [OK] %s\n' "$1"; else falhas=$((falhas + 1)); printf '  [FAIL] %s\n' "$1"; fi
}
json() { node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const v=process.argv[2].split(".").reduce((o,k)=>o==null?o:o[k], s); process.stdout.write(v===undefined?"<undefined>":typeof v==="string"?v:JSON.stringify(v))' "$1" "$2"; }

base="$T"
root="$base/Vencord"
mkdir -p "$root/dist"
printf '{"name":"vencord"}' > "$root/package.json"
printf '// build' > "$root/dist/vencordDesktopMain.js"

# 1) Vesktop nativo: grava vencordDir e preserva o resto do state.json
nativo="$base/opt/Vesktop/resources"
mkdir -p "$nativo" "$HOME/.config/vesktop"
printf 'app.asar original' > "$nativo/app.asar"
printf '{"firstLaunch":false,"windowBounds":{"x":10}}' > "$HOME/.config/vesktop/state.json"
rc=0; out="$(patch_parallel_one "$root" "$nativo" 2>&1)" || rc=$?
state="$HOME/.config/vesktop/state.json"
check "Vencord+Vesktop nativo passa (rc=0)" "$([ "$rc" -eq 0 ] && echo 0 || echo 1)"
check "state.json aponta vencordDir para o dist do checkout" "$([ "$(json "$state" vencordDir)" = "$root/dist" ] && echo 0 || echo 1)"
check "firstLaunch preservado" "$([ "$(json "$state" firstLaunch)" = "false" ] && echo 0 || echo 1)"
check "windowBounds preservado" "$([ "$(json "$state" windowBounds.x)" = "10" ] && echo 0 || echo 1)"
check "app.asar do Vesktop intacto" "$([ "$(cat "$nativo/app.asar")" = "app.asar original" ] && echo 0 || echo 1)"
check "nenhum _app.asar criado" "$([ ! -e "$nativo/_app.asar" ] && echo 0 || echo 1)"
case "$out" in *"vesktop.asar"*) check "nao fala mais em dist/vesktop.asar" 1 ;; *) check "nao fala mais em dist/vesktop.asar" 0 ;; esac
check "plugin ativado no settings do Vencord DENTRO do Vesktop" "$([ "$(json "$HOME/.config/vesktop/settings/settings.json" plugins.GoLiveBypass.enabled)" = "true" ] && echo 0 || echo 1)"

# 2) Rodar de novo da o mesmo resultado
rc=0; patch_parallel_one "$root" "$nativo" >/dev/null 2>&1 || rc=$?
check "segunda execucao idempotente" "$([ "$rc" -eq 0 ] && [ "$(json "$state" vencordDir)" = "$root/dist" ] && [ "$(json "$state" firstLaunch)" = "false" ] && echo 0 || echo 1)"

# 3) state.json corrompido nao derruba o instalador
printf '{oops' > "$state"
rc=0; patch_parallel_one "$root" "$nativo" >/dev/null 2>&1 || rc=$?
check "state.json corrompido vira objeto com vencordDir" "$([ "$rc" -eq 0 ] && [ "$(json "$state" vencordDir)" = "$root/dist" ] && echo 0 || echo 1)"

# 4) XDG_CONFIG_HOME respeitado no nativo
XDG_CONFIG_HOME="$base/xdg"; export XDG_CONFIG_HOME
rc=0; patch_parallel_one "$root" "$nativo" >/dev/null 2>&1 || rc=$?
check "usa \$XDG_CONFIG_HOME/vesktop/state.json" "$([ "$rc" -eq 0 ] && [ "$(json "$XDG_CONFIG_HOME/vesktop/state.json" vencordDir)" = "$root/dist" ] && echo 0 || echo 1)"
unset XDG_CONFIG_HOME

# 5) Vesktop flatpak: state.json no HOME do sandbox
fp="$base/var/lib/flatpak/app/dev.vencord.Vesktop/x86_64/stable/active/files/bin/vesktop/resources"
mkdir -p "$fp"; printf 'app.asar original' > "$fp/app.asar"
rc=0; patch_parallel_one "$root" "$fp" >/dev/null 2>&1 || rc=$?
fpstate="$HOME/.var/app/dev.vencord.Vesktop/config/vesktop/state.json"
check "Vesktop flatpak grava em ~/.var/app/<id>/config/vesktop/state.json" "$([ "$rc" -eq 0 ] && [ "$(json "$fpstate" vencordDir)" = "$root/dist" ] && echo 0 || echo 1)"
check "app.asar do flatpak intacto" "$([ "$(cat "$fp/app.asar")" = "app.asar original" ] && echo 0 || echo 1)"
check "plugin ativado no settings do Vesktop flatpak" "$([ "$(json "$HOME/.var/app/dev.vencord.Vesktop/config/vesktop/settings/settings.json" plugins.GoLiveBypass.enabled)" = "true" ] && echo 0 || echo 1)"

# 6) Sem build: falha dizendo para rodar o pnpm build e nao grava nada
semroot="$base/VencordSemBuild"; mkdir -p "$semroot/dist"; printf '{"name":"vencord"}' > "$semroot/package.json"
outro="$base/outro/vesktop/resources"; mkdir -p "$outro"; printf 'x' > "$outro/app.asar"
HOME_ANTES="$HOME"; HOME="$base/home2"; mkdir -p "$HOME"
rc=0; out="$(patch_parallel_one "$semroot" "$outro" 2>&1)" || rc=$?
check "sem build falha (rc != 0)" "$([ "$rc" -ne 0 ] && echo 0 || echo 1)"
case "$out" in *"pnpm build"*) check "sem build pede pnpm build" 0 ;; *) check "sem build pede pnpm build" 1 ;; esac
check "sem build nao cria state.json" "$([ ! -e "$HOME/.config/vesktop/state.json" ] && echo 0 || echo 1)"
HOME="$HOME_ANTES"

# 7) Sem interacao (--yes), com Vesktop nativo + flatpak: os DOIS saem marcados como paralelos
ASSUME_YES=1
alvos="$(escolher_alvos_inject "" "$(printf '%s\n%s' "$nativo" "$fp")" Vencord)"
check "--yes devolve os dois clientes paralelos" "$([ "$(printf '%s\n' "$alvos" | grep -c '^P|')" -eq 2 ] && echo 0 || echo 1)"
check "nenhuma linha sem prefixo" "$([ "$(printf '%s\n' "$alvos" | grep -vc '^[OP]|')" -eq 0 ] && echo 0 || echo 1)"
alvos="$(escolher_alvos_inject "$(printf '%s\n%s' /a/Discord/resources /b/DiscordPTB/resources)" "$nativo" Vencord)"
check "--yes devolve os dois Discords oficiais" "$([ "$(printf '%s\n' "$alvos" | grep -c '^O|')" -eq 2 ] && echo 0 || echo 1)"
ASSUME_YES=0

echo "RESULTADO_INTERNO: $falhas"
exit "$falhas"
H_EOF

mkdir -p "$TMP/home"
HOME="$TMP/home" T="$TMP" "$SHELL_BIN" "$HARNESS" > "$TMP/out.txt" 2>/dev/null || true
grep -E '\[OK\]|\[FAIL\]' "$TMP/out.txt" || true
if grep -q '^RESULTADO_INTERNO: 0$' "$TMP/out.txt"; then
    echo "== Resultado: Vesktop + Vencord via vencordDir ok ($SHELL_BIN) =="
else
    echo "== Resultado: FALHAS no Vesktop + Vencord ($SHELL_BIN) =="
    exit 1
fi
