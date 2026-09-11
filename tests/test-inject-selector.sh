#!/bin/sh
#
# Regressao do SELETOR DE ALVO do instalador Linux.
#
# Relato: "tenho Equibop, Vesktop e Legcord e o instalador nao me da opcao de escolher em qual
# quero instalar o plugin". Atras disso havia tres defeitos somados:
#
#   1. o glob do flatpak era files/*/resources, e Vesktop/Equibop/Legcord poem o app em
#      files/bin/<cliente>/resources -- NENHUM cliente paralelo de flatpak era encontrado;
#   2. is_parallel_install casava so o FIM do caminho, entao ~/.local/share/vesktop/resources
#      (que termina em /resources) passava por Discord oficial e ia para o pnpm inject, que so
#      sabe dizer "Invalid Discord install";
#   3. escolher_alvos_inject devolvia os ROTULOS da tela em vez dos caminhos. Mesmo escolhendo
#      certo, a injecao recebia "Equibop (flatpak)" no lugar do alvo.
#
# Este teste dirige a TUI de verdade (tui_menu_multi + escolher_alvos_inject) trocando so o
# leitor de tecla: sem PTY, sem terminal, sem tempo de espera.
#
# Uso:
#   ./tests/test-inject-selector.sh

set -eu

REPO="$(cd -- "$(dirname -- "$0")/.." && pwd)"
PASS=0
FAIL=0

ok() { PASS=$((PASS + 1)); printf '  [OK] %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  [FAIL] %s\n' "$1"; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

HARNESS="$TMP/fns.sh"
{
    awk '/^banner$/{exit} {print}' "$REPO/installer/golivebypass-installer.sh"
    cat <<'EOF'

# --- o seletor roda como se houvesse terminal; so a tecla vem do roteiro ---
warn() { printf '  [!] %s\n' "$1" >&2; }
ASSUME_YES=0
tui_is_interactive() { return 0; }
# O roteiro fica num ARQUIVO, nao numa variavel: tui_menu_multi chama tui_getkey dentro de
# "$(...)", e uma substituicao de comando roda em subshell -- atribuicao feita la dentro nao
# volta para o shell de fora, e a leitura ficaria repetindo a primeira tecla para sempre.
tui_getkey() {
    local k
    k="$(head -n 1 "$GLB_TECLAS" 2>/dev/null || true)"
    [ -n "$k" ] || k="esc"    # roteiro esgotado: cancela, para nao girar para sempre
    tail -n +2 "$GLB_TECLAS" > "$GLB_TECLAS.resto" 2>/dev/null || : > "$GLB_TECLAS.resto"
    mv "$GLB_TECLAS.resto" "$GLB_TECLAS"
    printf '%s\n' "$k"
}
EOF
} > "$HARNESS"

# --------------------------------------------------------------------- alvos falsos
# Diretorio e app.asar de verdade: o seletor so monta rotulos, mas manter a arvore real deixa
# o teste honesto se um dia a montagem passar a olhar o disco.
BASE="$TMP/alvos"
mkdir -p "$BASE/oficial/resources" "$BASE/Equibop" "$BASE/Legcord/resources" "$BASE/Vesktop/resources"
mkdir -p "$BASE/flatpak/app/org.equicord.equibop/x86_64/stable/active/files/bin/equibop/resources"
: > "$BASE/oficial/resources/app.asar"
: > "$BASE/Equibop/app.asar"
: > "$BASE/Legcord/resources/app.asar"
: > "$BASE/Vesktop/resources/app.asar"
: > "$BASE/flatpak/app/org.equicord.equibop/x86_64/stable/active/files/bin/equibop/resources/app.asar"

OFICIAIS="$BASE/oficial/resources"
PARALELOS="$BASE/Equibop
$BASE/Legcord/resources
$BASE/Vesktop/resources
$BASE/flatpak/app/org.equicord.equibop/x86_64/stable/active/files/bin/equibop/resources"

# Roda o seletor com um roteiro de teclas (uma por espaco) e devolve o que ele imprimiu. Roda
# em subshell porque o cancelamento termina com exit 1 dentro da funcao.
selecionar() { # $1 = teclas, $2 = mod (default Equicord)
    printf '%s\n' "$1" | tr ' ' '\n' > "$TMP/teclas.txt"
    GLB_TECLAS="$TMP/teclas.txt" GLB_MOD="${2:-Equicord}" sh -c "
        . '$HARNESS'
        escolher_alvos_inject \"\$(printf '%s\n' '$OFICIAIS')\" \"\$(printf '%s\n' '$PARALELOS')\" \"\$GLB_MOD\"
    " 2>"$TMP/err.txt"
}

printf '\n== 1. O alvo que volta e o CAMINHO, nao o rotulo da tela ==\n'

# item 1 = oficial, 2 = Equibop, 3 = Legcord, 4 = Vesktop, 5 = Equibop flatpak
saida="$(selecionar 'space enter')"
[ "$saida" = "O|$OFICIAIS" ] && ok "oficial escolhido devolve o caminho" \
                            || bad "oficial devolveu: [$saida]"

saida="$(selecionar 'down space enter')"
[ "$saida" = "P|$BASE/Equibop" ] && ok "paralelo escolhido devolve o caminho" \
                                || bad "paralelo devolveu: [$saida]"

saida="$(selecionar 'down down down down space enter')"
esperado="P|$BASE/flatpak/app/org.equicord.equibop/x86_64/stable/active/files/bin/equibop/resources"
[ "$saida" = "$esperado" ] && ok "cliente de flatpak devolve o caminho do deploy" \
                          || bad "flatpak devolveu: [$saida]"

case "$saida" in
    *"Equibop ("*) bad "o resultado ainda carrega rotulo de tela" ;;
    *)             ok "nenhum rotulo de tela no resultado" ;;
esac

printf '\n== 2. Multi-selecao, na ordem dos alvos ==\n'

saida="$(selecionar 'space down down down down space enter')"
esperado="O|$OFICIAIS
P|$BASE/flatpak/app/org.equicord.equibop/x86_64/stable/active/files/bin/equibop/resources"
[ "$saida" = "$esperado" ] && ok "dois alvos saem na ordem (oficial primeiro)" \
                          || bad "multi devolveu: [$saida]"

saida="$(selecionar 'a enter')"
n="$(printf '%s\n' "$saida" | grep -c .)"
[ "$n" = "5" ] && ok "'a' marca todos e devolve os 5" || bad "'a' devolveu $n alvos: [$saida]"

printf '\n== 3. Confirmar sem marcar nao injeta nada ==\n'

if selecionar 'enter esc' >/dev/null 2>&1; then
    bad "Enter sem marcar confirmou uma escolha vazia"
else
    case "$(cat "$TMP/err.txt")" in
        *Cancelado*) ok "Enter sem marcar nao confirma; Esc cancela" ;;
        *)           bad "cancelou sem avisar: [$(cat "$TMP/err.txt" | tr -d '\033' | tail -3)]" ;;
    esac
fi

printf '\n== 4. O rotulo avisa quando o mod nao atende o cliente ==\n'

# O aviso precisa aparecer no MENU desenhado, nao so na funcao: e o menu que o usuario le.
selecionar 'esc' >/dev/null 2>&1 || true
menu="$(sed 's/\x1b\[[0-9;?]*[a-zA-Z]//g' "$TMP/err.txt")"
case "$menu" in
    *"Legcord nao usa build do mod"*) ok "o menu marca o Legcord como nao atendido" ;;
    *) bad "o menu nao avisa sobre o Legcord" ;;
esac
case "$menu" in
    *"precisa de um checkout Vencord"*) ok "o menu diz que o Vesktop precisa de outro checkout" ;;
    *) bad "o menu nao avisa sobre o Vesktop" ;;
esac
if printf '%s\n' "$menu" | grep -a 'Equibop' | grep -aq 'precisa de um checkout'; then
    bad "Equibop foi marcado a toa (ele e atendido pelo Equicord)"
else
    ok "Equibop nao recebe aviso"
fi
# E o aviso nao pode empurrar a borda da caixa: todas as linhas de item tem a mesma largura.
larguras="$(sed 's/\x1b\[[0-9;?]*[a-zA-Z]//g' "$TMP/err.txt" | grep -a '^│.*│$' | awk '{ print length }' | sort -u | tr '\n' ' ')"
n_larg="$(printf '%s\n' $larguras | grep -c .)"
[ "$n_larg" = "1" ] && ok "todas as linhas do menu tem a mesma largura ($larguras)" \
                   || bad "menu desalinhado, larguras: $larguras"

printf '\n== 3. Bloqueador: escolha vem ANTES de decidir se injeta ==\n'

# Defeito relatado: com QUALQUER cliente ja apontando para o checkout (o caso de quem tinha o
# Equibop injetado a partir de ~/Equicord), o do_install pulava a injecao inteira e o seletor
# de alvos nunca aparecia -- sem opcao de escolher Vesktop, Legcord ou um flatpak intocado.
do_install_fonte="$(awk '/^do_install\(\) \{/,/^\}$/' "$REPO/installer/golivebypass-installer.sh")"

case "$do_install_fonte" in
    *escolher_alvos_inject*|*selecionar_alvos_inject*)
        ok "do_install chama o seletor de alvos" ;;
    *) bad "do_install nao chama o seletor: nao ha como escolher o cliente" ;;
esac

case "$do_install_fonte" in
    *alvos_ja_injetados*)
        ok "do_install decide pelo conjunto escolhido, nao por um cliente qualquer" ;;
    *) bad "do_install pula a injecao por um unico cliente ja injetado" ;;
esac

# A decisao tem que vir DEPOIS da escolha: se vier antes, o seletor fica inalcancavel de novo.
linha_sel="$(printf '%s\n' "$do_install_fonte" | grep -n 'selecionar_alvos_inject\|escolher_alvos_inject' | head -1 | cut -d: -f1)"
linha_dec="$(printf '%s\n' "$do_install_fonte" | grep -n 'alvos_ja_injetados' | head -1 | cut -d: -f1)"
if [ -n "$linha_sel" ] && [ -n "$linha_dec" ] && [ "$linha_sel" -lt "$linha_dec" ]; then
    ok "a escolha vem antes da decisao (por isso o menu sempre aparece)"
else
    bad "a decisao vem antes da escolha: o seletor pode nao aparecer"
fi

# Sem o gate por conjunto, o instalador voltaria a pular tudo: o caso exato do relato.
ja_injetado="$(sh -c "
    . '$HARNESS'
    injected_path() { printf '%s\n' '/checkout/Equicord/dist/desktop'; }
    if alvos_ja_injetados /checkout/Equicord 'P|/algum/equibop'; then echo sim; else echo nao; fi
")"
[ "$ja_injetado" = "nao" ] && ok "cliente paralelo escolhido forca a injecao (patch direto)" \
                            || bad "paralelo foi dado como pronto"

paralelo_ja="$(sh -c "
    . '$HARNESS'
    injected_path() { printf '%s\n' '/outro/checkout/dist/desktop'; }
    if alvos_ja_injetados /checkout/Equicord 'O|/algum/discord/resources'; then echo sim; else echo nao; fi
")"
[ "$paralelo_ja" = "nao" ] && ok "oficial apontando para outro checkout forca a injecao" \
                           || bad "oficial de outro checkout foi dado como pronto"

pronto="$(sh -c "
    . '$HARNESS'
    injected_path() { printf '%s\n' '/checkout/Equicord/dist/desktop'; }
    if alvos_ja_injetados /checkout/Equicord 'O|/algum/discord/resources'; then echo sim; else echo nao; fi
")"
[ "$pronto" = "sim" ] && ok "oficial ja apontando para este checkout nao reinjeta" \
                      || bad "oficial pronto foi dado como pendente"

printf '\n'
if [ "$FAIL" -eq 0 ]; then
    printf 'RESULTADO: %d OK, 0 FALHAS\n' "$PASS"
else
    printf 'RESULTADO: %d OK, %d FALHA(S)\n' "$PASS" "$FAIL"
fi
[ "$FAIL" -eq 0 ]
