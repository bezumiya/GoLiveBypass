#!/bin/sh
#
# Testes dos helpers de selecao de alvo (escolher QUAL Discord patchear):
# parse_selecao (entrada textual "1,3" / "2-4" / "t"), rotulos e o caminho
# nao-interativo do seletor (-Yes / sem TTY = todos; 1 alvo = sem pergunta).
#
# Extrai as funcoes REAIS dos dois instaladores .sh e exercita contra casos
# conhecidos. O caminho interativo (TUI) precisa de terminal proprio e nao
# roda aqui (coberto pelos testes de VM em tests/tui-windows).
#
# Uso:
#   ./tests/test-selector.sh

set -eu

REPO="$(cd -- "$(dirname -- "$0")/.." && pwd)"
PASS=0
FAIL=0

ok() { PASS=$((PASS + 1)); printf '  [OK] %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  [FAIL] %s\n' "$1"; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ---- standalone.sh --------------------------------------------------------
ST="$TMP/standalone-fns.sh"
{
    sed -n '/^st_seq()/,/^}/p' "$REPO/standalone/golivebypass-standalone.sh"
    sed -n '/^rotulo_flavour()/,/^}/p' "$REPO/standalone/golivebypass-standalone.sh"
    sed -n '/^estado_label()/,/^}/p' "$REPO/standalone/golivebypass-standalone.sh"
    sed -n '/^parse_selecao()/,/^}/p' "$REPO/standalone/golivebypass-standalone.sh"
    sed -n '/^escolher_alvos()/,/^}/p' "$REPO/standalone/golivebypass-standalone.sh"
    # stubs de ambiente
    cat <<'EOF'
injection_state() { case "$1" in *nosso*) printf 'nosso' ;; *outro*) printf 'outromod' ;; *) printf 'vanilla' ;; esac; }
st_tui_is_interactive() { return 1; }
warn() { printf '  [!] %s\n' "$1" >&2; }
ASSUME_YES=1
EOF
} > "$ST"

printf '== standalone.sh ==\n'
sh -c "
    . '$ST'
    t() { # <desc> <esperado-por-linha> <saida>
        if [ \"\$2\" = \"\$3\" ]; then return 0; else return 1; fi
    }
    r=\$(parse_selecao '' 3);      [ \"\$r\" = '1 2 3' ] && echo 'OK vazio=todos' || echo \"FAIL vazio=todos: [\$r]\"
    r=\$(parse_selecao 't' 3);     [ \"\$r\" = '1 2 3' ] && echo 'OK t=todos' || echo \"FAIL t=todos\"
    r=\$(parse_selecao '1,3' 3);   [ \"\$r\" = '1 3' ] && echo 'OK 1,3' || echo \"FAIL 1,3: [\$r]\"
    r=\$(parse_selecao '2-3' 3);   [ \"\$r\" = '2 3' ] && echo 'OK 2-3' || echo \"FAIL 2-3: [\$r]\"
    r=\$(parse_selecao '1,3-4' 4); [ \"\$r\" = '1 3 4' ] && echo 'OK misto' || echo \"FAIL misto: [\$r]\"
    parse_selecao '5' 3 2>/dev/null && echo 'FAIL 5-fora' || echo 'OK 5-fora rejeitado'
    parse_selecao 'a' 3 2>/dev/null && echo 'FAIL letra' || echo 'OK letra rejeitada'
    parse_selecao '0' 3 2>/dev/null && echo 'FAIL zero' || echo 'OK zero rejeitado'
    [ \"\$(rotulo_flavour discordptb)\" = 'Discord PTB' ] && echo 'OK rotulo ptb' || echo 'FAIL rotulo ptb'
    [ \"\$(rotulo_flavour vesktop)\" = 'Vesktop' ] && echo 'OK rotulo vesktop' || echo 'FAIL rotulo vesktop'
    [ \"\$(rotulo_flavour clientex)\" = 'clientex' ] && echo 'OK rotulo desconhecido' || echo 'FAIL rotulo desconhecido'
" > "$TMP/out-st.txt" 2>&1 || true
while IFS= read -r linha; do
    case "$linha" in
        OK*)  ok "${linha#OK }" ;;
        FAIL*) bad "${linha#FAIL }" ;;
    esac
done < "$TMP/out-st.txt"

# escolher_alvos: 1 alvo = passthrough; -Yes = todos; sem TTY = todos
sh -c "
    . '$ST'
    FOUND='R1|discord|path|'
    r=\$(escolher_alvos patchear)
    [ \"\$r\" = 'R1|discord|path|' ] && echo 'OK 1-alvo passthrough' || echo 'FAIL 1-alvo: '\"\$r\"
    FOUND='R1|discord|path|
R2|discordptb|path|'
    r=\$(escolher_alvos patchear)
    n=\$(printf '%s\n' \"\$r\" | grep -c .)
    [ \"\$n\" = '2' ] && [ \"\$r\" = \"\$FOUND\" ] && echo 'OK -Yes todos' || echo 'FAIL -Yes todos: '\"\$r\"
" > "$TMP/out-st2.txt" 2>&1 || true
while IFS= read -r linha; do
    case "$linha" in
        OK*)  ok "${linha#OK }" ;;
        FAIL*) bad "${linha#FAIL }" ;;
    esac
done < "$TMP/out-st2.txt"

# ---- installer.sh ---------------------------------------------------------
IN="$TMP/installer-fns.sh"
{
    sed -n '/^seq_like()/,/^}/p' "$REPO/installer/golivebypass-installer.sh"
    sed -n '/^label_alvo()/,/^}/p' "$REPO/installer/golivebypass-installer.sh"
    sed -n '/^parse_selecao()/,/^}/p' "$REPO/installer/golivebypass-installer.sh"
    sed -n '/^escolher_alvos_inject()/,/^}/p' "$REPO/installer/golivebypass-installer.sh"
    cat <<'EOF'
tui_is_interactive() { return 1; }
warn() { printf '  [!] %s\n' "$1" >&2; }
ASSUME_YES=1
EOF
} > "$IN"

printf '== installer.sh ==\n'
sh -c "
    . '$IN'
    r=\$(parse_selecao '1,3' 4); [ \"\$r\" = '1 3' ] && echo 'OK 1,3' || echo \"FAIL 1,3: [\$r]\"
    case \"\$(label_alvo /var/lib/flatpak/app/com.discordapp.DiscordPTB/x/files/discord/resources)\" in
        'Discord PTB ('*) echo 'OK label ptb flatpak' ;;
        *) echo 'FAIL label ptb flatpak' ;;
    esac
    case \"\$(label_alvo /usr/lib/vesktop)\" in
        'Vesktop ('*) echo 'OK label vesktop' ;;
        *) echo 'FAIL label vesktop' ;;
    esac
    r=\$(escolher_alvos_inject '/usr/share/discord/resources' '')
    [ \"\$r\" = 'O|/usr/share/discord/resources' ] && echo 'OK 1-oficial sem pergunta' || echo \"FAIL 1-oficial: [\$r]\"
    r=\$(escolher_alvos_inject '/a/discord/resources
/b/discord/resources' '')
    n=\$(printf '%s\n' \"\$r\" | grep -c .)
    [ \"\$n\" = '2' ] && echo 'OK -Yes injeta todos os oficiais' || echo \"FAIL -Yes oficiais: [\$r]\"
    r=\$(escolher_alvos_inject '' '/x/vesktop')
    [ \"\$r\" = 'P|/x/vesktop' ] && echo 'OK so-paralelos' || echo \"FAIL so-paralelos: [\$r]\"
" > "$TMP/out-in.txt" 2>&1 || true
while IFS= read -r linha; do
    case "$linha" in
        OK*)  ok "${linha#OK }" ;;
        FAIL*) bad "${linha#FAIL }" ;;
    esac
done < "$TMP/out-in.txt"

printf '\n'
if [ "$FAIL" -eq 0 ]; then
    printf 'RESULTADO: %d OK, 0 FALHAS\n' "$PASS"
else
    printf 'RESULTADO: %d OK, %d FALHA(S)\n' "$PASS" "$FAIL"
fi
[ "$FAIL" -eq 0 ]
