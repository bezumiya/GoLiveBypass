#!/usr/bin/env bash
# Roda no macOS (qualquer arquitetura, inclusive Intel). Popula resources/bin com
# wireguard-go e wg UNIVERSAIS (x86_64 + arm64 via lipo) e o wg-quick (script).
# Assim o .dmg universal roda tanto em Intel quanto em Apple Silicon.
set -euo pipefail

DEST="$(cd "$(dirname "$0")/.." && pwd)/resources/bin"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$DEST"

# Versões fixadas: as mesmas dos binários commitados (conferidos por resources/bin/SHA256SUMS)
WIREGUARD_GO_VERSION=0.0.20250522
WIREGUARD_TOOLS_VERSION=1.0.20260223

command -v brew >/dev/null 2>&1 || { echo "Homebrew é necessário." >&2; exit 1; }
for pin in "wireguard-go $WIREGUARD_GO_VERSION" "wireguard-tools $WIREGUARD_TOOLS_VERSION"; do
  set -- $pin
  have=$(brew info --json=v2 "$1" | python3 -c 'import json,sys;print(json.load(sys.stdin)["formulae"][0]["versions"]["stable"])')
  [ "$have" = "$2" ] || { echo "O Homebrew oferece $1 $have, mas o app fixa $2. Atualize a versão fixada neste script de propósito." >&2; exit 1; }
done
command -v lipo >/dev/null 2>&1 || { echo "lipo (Xcode Command Line Tools) é necessário." >&2; exit 1; }

# Codinome do macOS -> tag de bottle (ex.: sequoia, sonoma, ventura).
CODENAME=${CODENAME:-}
if [ -z "$CODENAME" ]; then
  # brew config só traz o número (ex.: "26.7.1-x86_64"); o codinome vem da versão principal
  case "$(sw_vers -productVersion | cut -d. -f1)" in
    12) CODENAME=monterey ;; 13) CODENAME=ventura ;; 14) CODENAME=sonoma ;; 15) CODENAME=sequoia ;; 26) CODENAME=tahoe ;;
  esac
fi
[ -n "$CODENAME" ] || { echo "Não sei o codinome deste macOS para escolher o bottle. Rode com CODENAME=<bottle> (ex.: CODENAME=sonoma)." >&2; exit 1; }
echo "Bottles alvo: ${CODENAME} (x86_64) e arm64_${CODENAME}"

# Extrai bin/<name> de um bottle de uma formula para um arquivo de saída.
extract_bin() {  # formula tag name out
  local formula="$1" tag="$2" name="$3" out="$4" dir
  brew fetch --force --bottle-tag="$tag" "$formula" >/dev/null
  local tar; tar=$(brew --cache --bottle-tag="$tag" "$formula")
  dir="$WORK/${formula}-${tag}"; mkdir -p "$dir"
  tar -xzf "$tar" -C "$dir"
  local found; found=$(find "$dir" -type f -path "*/bin/${name}" | head -1)
  [ -n "$found" ] || { echo "Não achei bin/${name} no bottle ${formula}/${tag}." >&2; exit 1; }
  cp "$found" "$out"
}

make_universal() {  # formula binname
  local formula="$1" name="$2"
  extract_bin "$formula" "$CODENAME"        "$name" "$WORK/${name}.x64"
  extract_bin "$formula" "arm64_${CODENAME}" "$name" "$WORK/${name}.arm64"
  lipo -create "$WORK/${name}.x64" "$WORK/${name}.arm64" -output "$DEST/${name}"
  chmod +x "$DEST/${name}"
  echo "universal: ${name} -> $(lipo -archs "$DEST/${name}")"
}

make_universal wireguard-go  wireguard-go
make_universal wireguard-tools wg

# wg-quick é script bash (independe de arquitetura): pega de qualquer bottle já baixado.
WGQ=$(find "$WORK/wireguard-tools-${CODENAME}" -type f -path "*/bin/wg-quick" | head -1)
[ -n "$WGQ" ] || { echo "Não achei wg-quick." >&2; exit 1; }
cp "$WGQ" "$DEST/wg-quick"; chmod +x "$DEST/wg-quick"

(cd "$DEST" && shasum -a 256 wg wg-quick wireguard-go > SHA256SUMS)
echo "Binários universais em $DEST (SHA256SUMS atualizado)"
