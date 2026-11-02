#!/usr/bin/env bash
# ensure_tor_bundle precisa de um trap para apagar o download temporario, mas o script
# ja tem um trap EXIT global (cleanup_sudo_pass: senha temporaria e rollback da
# ativacao). Um `trap ... EXIT` direto no corpo da funcao substituia o global e, depois
# do primeiro download do Tor, a saida do script deixava de limpar a senha.
#
# Este teste exercita ensure_tor_bundle do script real, sem rede e sem root.
set -euo pipefail
root=$(cd -- "$(dirname -- "$0")/.." && pwd)
script="$root/standalone/golivebypass-standalone.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

python3 - "$script" "$work/functions.sh" <<'PY'
from pathlib import Path
import sys
text = Path(sys.argv[1]).read_text()
a = text.index('ensure_tor_bundle() ')
b = text.index('\n# Garante o Tor de pe', a)
Path(sys.argv[2]).write_text(text[a:b])
PY

step() { :; }
warn() { :; }
have() { [ "$1" = curl ]; }
source "$work/functions.sh"

export TMPDIR="$work/tmp"
mkdir -p "$TMPDIR"
TOR_BASE="$work/tor-base"
TOR_EXE="$TOR_BASE/tor/tor"
TOR_TARBALL="tor.tar.gz"
TOR_URL="https://example.invalid/tor.tar.gz"
TOR_BUNDLE_VERSION="test"

# Tarball falso servido pelo curl de mentira.
mkdir -p "$work/src/tor"
printf '#!/bin/sh\n' > "$work/src/tor/tor"
tar -czf "$work/bundle.tar.gz" -C "$work/src" tor
TOR_SHA256=$(sha256sum "$work/bundle.tar.gz" | cut -d' ' -f1)

curl_falha=0
curl() {
    [ "$curl_falha" -eq 0 ] || return 22
    local out=""
    while [ $# -gt 0 ]; do
        [ "$1" = -o ] && { out="$2"; shift; }
        shift
    done
    cp "$work/bundle.tar.gz" "$out"
}

# Faz o papel do cleanup_sudo_pass e tambem limpa o diretorio do teste.
trap_global() { rm -rf "$work"; }
confere() {
    [[ "$(trap -p EXIT)" == "trap -- 'trap_global' EXIT" ]] || { echo "trap EXIT trocado: $(trap -p EXIT)" >&2; exit 1; }
    [ -z "$(ls -A "$TMPDIR")" ] || { echo "download temporario ficou para tras" >&2; exit 1; }
}
trap trap_global EXIT

# 1) Download que falha: devolve erro, preserva o trap global e apaga o temporario.
curl_falha=1
if ensure_tor_bundle; then echo "falha de download deveria devolver erro" >&2; exit 1; fi
confere

# 2) Hash errado tambem devolve erro sem vazar o trap.
curl_falha=0
TOR_SHA256_OK=$TOR_SHA256
TOR_SHA256=0000
if ensure_tor_bundle; then echo "hash errado deveria devolver erro" >&2; exit 1; fi
confere

# 3) Download bom extrai o binario e mantem o trap global.
TOR_SHA256=$TOR_SHA256_OK
ensure_tor_bundle
[ -x "$TOR_EXE" ]
confere

# 4) Com o binario presente nao baixa de novo.
curl_falha=1
ensure_tor_bundle
confere

echo "ok: ensure_tor_bundle preserva o trap EXIT global"
