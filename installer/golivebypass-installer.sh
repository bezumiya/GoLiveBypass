#!/bin/sh
#
# GoLiveBypass - instalador automatico (Linux)
#
# Encontra sozinho o Equicord ou o Vencord que voce tem, instala o plugin, compila e injeta.
# Se voce nao tiver nenhum dos dois, pergunta qual quer e instala junto.
#
# Funciona tambem com o Discord instalado por flatpak, do sistema ou do usuario.
#
# Uso:
#   ./golivebypass-installer.sh
#   ./golivebypass-installer.sh --source ~/Equicord
#   ./golivebypass-installer.sh --plugin-source ~/GoLiveBypass/goLiveBypass
#   ./golivebypass-installer.sh --mod vencord --yes
#   ./golivebypass-installer.sh --uninstall
#   ./golivebypass-installer.sh --check-update   # so consulta o GitHub, nao mexe
#   ./golivebypass-installer.sh --update          # aplica update se houver
#
# Obrigado ao Vithor (https://github.com/Vith0r), que escreveu o primeiro instalador do
# GoLiveBypass e abriu o caminho para este aqui.

# A instalacao volta a funcionar, mas a linha WireGuard do plugin ainda e beta: sai antes
# de baixar ou alterar qualquer cliente para ninguem achar que comprou um produto estavel.
# Sempre em stderr — o stdout e o contrato de --check-update/--update (quem integra le
# "plugin:"/"remote:"/"resultado:"), e um aviso no meio quebraria essa leitura.
# O standalone NAO entra aqui: ele tem bloqueio proprio em
# standalone/golivebypass-standalone.sh e este instalador nao encosta nele.
printf '\n[BETA] GoLiveBypass para Equicord/Vencord — canal beta WireGuard.\n' >&2
printf '        Este instalador entrega a versao beta atual do plugin; resultados podem mudar.\n' >&2
printf '        O sistema ainda nao e estavel e so chega la com gente testando: cada bug\n' >&2
printf '        reportado vira uma issue e encurta o caminho. Ao falhar, deixe o relatorio\n' >&2
printf '        automatico seguir, ou abra voce mesmo em\n' >&2
printf '        https://github.com/bezumiya/GoLiveBypass/issues\n' >&2
printf '        No Linux a parte menos testada e a ativacao do tunel, que pede autorizacao\n' >&2
printf '        no pkexec/polkit — a validacao atual parou nesse ponto.\n' >&2
printf '        O standalone continua indisponivel e nao e alterado por este instalador.\n\n' >&2

# So construcoes POSIX: roda em dash, bash, zsh, ksh e busybox ash.
# (sem pipefail de proposito: o status de pipeline e o do ultimo comando, como manda o POSIX)
set -eu
SCRIPT_PATH="${SCRIPT_PATH:-$0}"

# ---------------------------------------------------------------------------
# Portabilidade entre shells (POSIX + dash/ash/bash/zsh/ksh/mksh)
#
# zsh, por padrao, aborta com "no matches found" quando um glob nao casa
# (nomatch). O comportamento POSIX - e o de todos os outros shells - e deixar
# o glob literal, e os testes do script dependem disso (ex.: app-*/resources).
if [ -n "${ZSH_VERSION:-}" ]; then
    # so o zsh entende; nos outros shells isto e "command not found", engolido.
    setopt NULL_GLOB 2>/dev/null || true
fi

# ksh93 nao tem o builtin `local` (usa `typeset`); dash, bash, zsh, mksh e
# busybox ash tem. O probe roda `local` dentro de uma funcao: so e valido onde
# o builtin existe. Onde nao existe, definimos um wrapper via eval — o conteudo
# so e parseado nesse momento, entao o dash nunca ve a definicao.
_local_probe() { local _probe_var=1; }
if ! _local_probe 2>/dev/null; then
    eval 'local() { typeset "$@"; }'
fi
unset -f _local_probe 2>/dev/null || true





REPO_RAW="https://raw.githubusercontent.com/bezumiya/GoLiveBypass/main"
# Lista completa das fontes do plugin (native.ts: requiredFilesForPlatform). Faltando uma
# so, o pnpm build do checkout quebra: native.ts importa vpn-controller/vpn-proton/
# vpn-linux/update-*. Os binarios dos helpers nao vem por aqui — em Linux eles vao
# embutidos no vpn-proton.ts e o plugin os materializa sozinho quando nao acha bin/.
PLUGIN_FILES="goLiveBypass/index.tsx goLiveBypass/native.ts goLiveBypass/update-channel.ts goLiveBypass/update-security.ts goLiveBypass/stability.ts goLiveBypass/vpn-controller.ts goLiveBypass/vpn-proton.ts goLiveBypass/vpn-types.ts goLiveBypass/vpn-windows.ts goLiveBypass/vpn-linux.ts goLiveBypass/manifest.json"
PLUGIN_DIR_NAME="goLiveBypass"
EQUICORD_GIT="https://github.com/Equicord/Equicord"
VENCORD_GIT="https://github.com/Vendicated/Vencord"
FLATPAK_IDS="com.discordapp.Discord com.discordapp.DiscordPTB com.discordapp.DiscordCanary dev.vencord.Vesktop app.legcord.Legcord org.equicord.equibop"

MODE="menu"
MOD=""
SOURCE=""
# Instala o plugin de uma pasta local em vez de baixar do GitHub, para testar uma mudanca
# antes de publicar. Sem isto o instalador sempre traz o que esta no repositorio, e um teste
# feito assim mede a versao errada sem avisar.
PLUGIN_SOURCE=""
ASSUME_YES=0

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"

if [ -t 1 ]; then
    # printf em vez do $'...' do bash: so POSIX, funciona em qualquer shell.
    C_DIM=$(printf '\033[2m'); C_GREEN=$(printf '\033[32m'); C_YELLOW=$(printf '\033[33m'); C_RED=$(printf '\033[31m')
    C_CYAN=$(printf '\033[36m'); C_BOLD=$(printf '\033[1m'); C_OFF=$(printf '\033[0m')
else
    C_DIM=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_CYAN=""; C_BOLD=""; C_OFF=""
fi

# Sempre em stderr: estas funcoes sao chamadas de dentro de $(...) e qualquer coisa que
# fosse para stdout seria capturada como se fosse o valor de retorno.
step() { printf '  %s[*] %s%s\n' "$C_DIM" "$1" "$C_OFF" >&2; }
ok()   { printf '  %s[OK] %s%s\n' "$C_GREEN" "$1" "$C_OFF" >&2; }
warn() { printf '  %s[!] %s%s\n' "$C_YELLOW" "$1" "$C_OFF" >&2; }
# should_report <mensagem>: 0 se a mensagem deve virar issue no GitHub, 1 se nao.
# Tudo o que e "erro de uso" (dependencia faltando, CLI digitada errada, path
# errado, ferramenta externa quebrada) cai aqui — NAO e bug do projeto. O resto
# (bug real do instalador/bypass/patcher) continua abrindo issue como antes.
should_report() {
    case "$1" in
        # --- cancelamento e instrucoes de uso ---
        "Cancelado.") return 1 ;;
        # Cancelamento via Ctrl+C: bash imprime "^C" mas o erro que captura o
        # catch do sh vem do comando interrompido ("interrompido", "terminated"
        # ou "canceled" dependendo do shell).
        *"cancelada pelo usu"*) return 1 ;;
        *"canceled by the user"*) return 1 ;;
        *"interrompido"*) return 1 ;;
        *"terminated"*) return 1 ;;
        "O Discord nao fechou"*) return 1 ;;
        # Argumento vazio/ilegal passado pro instalador (input ruim do usuario, nao bug):
        # ver notas no installer.ps1.
        *"cadeia de caracteres vazia"*) return 1 ;;
        *"empty string"*) return 1 ;;
        *"Illegal characters in path"*) return 1 ;;
        *"associar"*"metro"*) return 1 ;;
        *"porque ele "*" nulo"*) return 1 ;;
        *"because it is null"*) return 1 ;;
        *"Nao e possivel associar"*) return 1 ;;
        *"Cannot bind argument"*) return 1 ;;
        # --- input / uso do usuario ---
        "Opcao desconhecida: "*) return 1 ;;
        "Nao consegui baixar "*) return 1 ;;
        # --- dependencia faltando (ambiente) ---
        "Instale "*) return 1 ;;
        "O npm nao conseguiu instalar o pnpm"*) return 1 ;;
        "Nao consegui deixar o pnpm funcionando"*) return 1 ;;
        # --- path / checkout errado ---
        "Nao encontrei o checkout do Equicord/Vencord"*) return 1 ;;
        "Nao achei "*) return 1 ;;
        *"ja existe e nao parece um checkout"*) return 1 ;;
        "Nao achei o patcher "*) return 1 ;;
        "Nao achei nenhum Discord instalado"*) return 1 ;;
        # --- ferramenta externa (ambiente) ---
        "git clone falhou") return 1 ;;
        "pnpm install falhou") return 1 ;;
        "pnpm build falhou") return 1 ;;
        "pnpm inject falhou") return 1 ;;
        # --- desinstalacao / elevacao parcial ---
        "Nao consegui desinstalar de todos"*) return 1 ;;
        "NADA foi injetado"*) return 1 ;;
        # default: e bug, reporta
        *) return 0 ;;
    esac
}

fail() {
    printf '\n  %s[X] %s%s\n\n' "$C_RED" "$1" "$C_OFF" >&2
    if [ "${REPORT_NO_AUTO:-0}" -eq 0 ] && should_report "$1"; then
        report_error "Falha no instalador GoLiveBypass: $1" 2>&1 || true
    fi
    exit 1
}

banner() {
    printf '\n  %sGoLiveBypass%s\n' "$C_CYAN$C_BOLD" "$C_OFF"
    printf '  %sGo Live e camera de volta no Discord%s\n' "$C_DIM" "$C_OFF"
    printf '  %shttps://github.com/bezumiya/GoLiveBypass%s\n\n' "$C_DIM" "$C_OFF"
}

confirm() {
    [ "$ASSUME_YES" -eq 1 ] && return 0
    local answer
    printf '  %s [s/N] ' "$1" >&2
    read -r answer || return 1
    case "$answer" in
        [sSyY]*) return 0 ;;
        *) return 1 ;;
    esac
}

# =========================================================================== Report de bugs
# Quando o instalador falha, monta um diagnostico (versao, OS, log sanitizado) e chama
# a mesma API de bugs da GUI. A issue abre automaticamente no bezumiya/GoLiveBypass.
# O envio NUNCA bloqueia o fluxo.

BUG_API_URL="https://api.skyplaceia.com/bugs/v1/reports"
BUG_API_TOKEN="c3d0bff691ecc3ddc6f6ca10037b9ac967c62547e681d3749204e50800504511"

report_sanitize() {
    local texto="$1"
    texto="$(printf '%s' "$texto" | sed -E 's#([a-z][a-z0-9+.-]*://)([^/ @:]+):([^/@]+)@#\1\2:***@#g')"
    texto="$(printf '%s' "$texto" | sed -E 's/\b(mfa\.[A-Za-z0-9_-]{20,}|[A-Za-z0-9_-]{23,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{27,})\b/***/g')"
    texto="$(printf '%s' "$texto" | sed -E 's#(https://gateway[^ ?]+)\?[^ ]*#\1?<params>#g')"
    printf '%s' "$texto"
}

report_send() {
    local titulo="$1" descricao="$2" corpo json

    # Dedupe: o mesmo erro NAO reabre issue (os reports duplos da 1.1.11 vieram
    # daqui — cada rodada do mesmo bug abria issue nova). Este script nao tem
    # INSTALL_DIR (era da versao antiga da GUI), entao o estado mora no XDG cache;
    # assinatura = titulo, com epoch, janela de 48h.
    local sig state ultimo data
    sig="$(printf '%s' "$titulo" | sha256sum 2>/dev/null | cut -c1-16)"
    state="${XDG_CACHE_HOME:-$HOME/.cache}/golivebypass-last-report"
    if [ -n "$sig" ] && [ -f "$state" ]; then
        ultimo=""; data=0
        read -r ultimo data < "$state" 2>/dev/null || true
        case "$data" in ''|*[!0-9]*) data=0 ;; esac
        if [ "$ultimo" = "$sig" ] && [ $(( $(date +%s) - data )) -lt 172800 ]; then
            printf '  %s[i]%s Esse erro ja foi reportado a menos de 48h — nao vou reabrir a issue.\n' "$C_DIM" "$C_OFF" >&2
            return 0
        fi
    fi
    if [ -n "$sig" ]; then
        mkdir -p "$(dirname "$state")" 2>/dev/null || true
        printf '%s %s\n' "$sig" "$(date +%s)" > "$state" 2>/dev/null || true
    fi

    corpo="$(report_sanitize "$descricao")"
    json="$(printf '{"title":"%s","description":"%s","includeLogs":true}' \
        "$(printf '%s' "$titulo" | sed 's/"/\\"/g')" \
        "$(printf '%s' "$corpo" | sed 's/"/\\"/g')")"
    if have curl; then
        curl -fsS -X POST "$BUG_API_URL" -H "Authorization: Bearer $BUG_API_TOKEN" -H "Content-Type: application/json" -d "$json" >/dev/null 2>&1 && return 0
    elif have wget; then
        echo "$json" | wget -qO- --post-data=- --header="Authorization: Bearer $BUG_API_TOKEN" --header="Content-Type: application/json" "$BUG_API_URL" >/dev/null 2>&1 && return 0
    fi
    return 1
}

report_error() {
    local titulo="$1" desc=""
    # INSTALL_DIR nao eh setado neste script (era de uma versao antiga da GUI). O log
    # do bypass fica em ${XDG_DATA_HOME:-$HOME/.local/share}/GoLiveBypass/golivebypass.log,
    # o mesmo que a GUI e o standalone usam. Fallback para o path do log se existir.
    local logdir="${XDG_DATA_HOME:-$HOME/.local/share}/GoLiveBypass"
    if [ -f "$logdir/golivebypass.log" ]; then
        desc="$(tail -n 40 "$logdir/golivebypass.log" 2>/dev/null || true)"
    fi
    if [ -n "$desc" ]; then
        printf '  %s[!]%s Ocorreu um erro. Enviando relatorio automatico (issue no GitHub)...%s\n' "$C_YELLOW" "$C_OFF" "$C_OFF" >&2
        if report_send "$titulo" "$desc"; then
            printf '  %s[OK]%s Relatorio enviado. Obrigado — os devs vao ver a issue no GitHub.%s\n' "$C_GREEN" "$C_OFF" "$C_OFF" >&2
        else
            printf '  %s[!]%s Nao consegui enviar o relatorio automatico. Mande esta saida.%s\n' "$C_YELLOW" "$C_OFF" "$C_OFF" >&2
        fi
    else
        printf '  %s[!]%s Nao consegui montar o relatorio (sem logs). Mande o erro acima.%s\n' "$C_YELLOW" "$C_OFF" "$C_OFF" >&2
    fi
}

# =========================================================================== /Report de bugs

# =========================================================================== TUI
# Interface no estilo OpenCode: dark, caixas, setas/Enter, mouse SGR onde o terminal
# suporta. Tudo ANSI puro, sem dependencia. Quando nao ha TTY (pipe/automacao/CI) ou
# --yes esta ligado, os scripts caem para os menus/flags de antes — nada muda nesses casos.
# POSIX 100%: em vez de read -n (bash-only), usa stty -icanon + dd para ler 1 tecla.

tui_is_interactive() {
    [ "$ASSUME_YES" -eq 1 ] && return 1
    # stdin interativo e suficiente: o terminal do usuario tem stdin+stdout ttys, e
    # exigir -t 1 quebra em pty/emuladores onde o stdout noutro momento nao reporta tty.
    [ -t 0 ] && return 0
    return 1
}

# Cores extras da TUI (fundo escuro, texto claro, acento). Reutiliza C_* ja definidos.
TUI_BG=$(printf '\033[48;5;235m')
TUI_FG=$(printf '\033[38;5;252m')
TUI_ACCENT=$(printf '\033[38;5;75m')   # azul-ciano (item ativo)
TUI_OK=$(printf '\033[38;5;114m')      # verde (recomendado)
TUI_DIM2=$(printf '\033[38;5;240m')
TUI_BOLD=$(printf '\033[1m')
TUI_RSET=$(printf '\033[0m')
TUI_MOUSE_ON='\033[?1000h\033[?1006h'
TUI_MOUSE_OFF='\033[?1000l\033[?1006l'

tui_mouse_on()   { printf '%b' "$TUI_MOUSE_ON" >&2; }
tui_mouse_off()  { printf '%b' "$TUI_MOUSE_OFF" >&2; }
tui_hide_cursor() { printf '\033[?25l' >&2; }
tui_show_cursor() { printf '\033[?25h' >&2; }

# Desenha uma caixa com titulo e linhas de conteudo. Cada elemento de `lines` ja vem
# com o texto pronto (sem as bordas).
tui_box() {
    local title="$1"; shift
    local w=62 line txt i
    local top bottom
    top=""; bottom=""
    i=0; while [ "$i" -lt $((w-8)) ]; do top="${top}─"; i=$((i+1)); done
    i=0; while [ "$i" -lt $((w-2)) ]; do bottom="${bottom}─"; i=$((i+1)); done
    printf '%s%s┌─ %s%s%s ─%s%s%s\n' "$TUI_BG" "$TUI_RSET" "$TUI_ACCENT" "$title" "$TUI_RSET" "$TUI_DIM2" "$top" "$TUI_RSET" >&2
    for txt in "$@"; do
        local pad
        pad=""
        i=0; while [ "$i" -lt $((w-4-${#txt})) ]; do pad="${pad} "; i=$((i+1)); done
        printf '%s%s│ %s%s%s %s│%s\n' "$TUI_BG" "$TUI_RSET" "$txt" "$TUI_RSET" "$pad" "$TUI_BG" "$TUI_RSET" >&2
    done
    printf '%s%s└%s┘%s\n' "$TUI_BG" "$TUI_RSET" "$bottom" "$TUI_RSET" >&2
}

# Tamanho do terminal (linhas/colunas), com fallback 80x24 quando nao da para ler.
tui_size() {
    local s
    if s="$(stty size 2>/dev/null)"; then
        set -- $s
        TUI_ROWS=${1:-24}
        TUI_COLS=${2:-80}
    else
        TUI_ROWS=24
        TUI_COLS=80
    fi
    if [ "$TUI_COLS" -le 20 ]; then TUI_COLS=80; fi
    return 0
}

# Posiciona o cursor em (row, col) — base 1, como o ANSI.
tui_cursor() { printf '\033[%d;%dH' "$1" "$2" >&2; }

# limpa a partir da linha N (para redesenhar o corpo sem o header).
tui_clear_below() { printf '\033[%d;0H\033[J' "$1" >&2; }

# Modo "raw" POSIX: le 1 byte sem eco, sem esperar Enter. Guarda o estado do terminal para
# restaurar. `dd` e `stty` existem em toda distro/busybox.
tui_raw_begin() {
    # salva o modo atual (só se stty funciona)
    TUI_STTY_SAVED="$(stty -g 2>/dev/null || true)"
    stty -icanon -echo 2>/dev/null || true
}
tui_raw_end() {
    if [ -n "${TUI_STTY_SAVED:-}" ]; then
        stty "$TUI_STTY_SAVED" 2>/dev/null || true
    else
        stty icanon echo 2>/dev/null || true
    fi
    TUI_STTY_SAVED=""
}

# Le uma tecla de navegacao em modo raw: retorna "up|down|enter|esc|j|k|other".
# Mouse SGR chega como sequencia de bytes; tratamos o hit simples (press) como
# "enter" quando clicou dentro da area do menu — aposicao e estimada pela linha.
tui_getkey() {
    local key rest
    key="$(dd bs=1 count=1 2>/dev/null | od -An -tx1 | tr -d ' \n')"
    case "$key" in
        1b) # ESC: ou so, ou seguido de [A/[B
            rest="$(dd bs=1 count=2 2>/dev/null | od -An -tx1 | tr -d ' \n')"
            case "$rest" in
                5b41) printf 'up\n' ;;      # ESC [ A
                5b42) printf 'down\n' ;;     # ESC [ B
                *)    printf 'esc\n' ;;      # ESC so
            esac ;;
        0a|0d) printf 'enter\n' ;;
        6a) printf 'down\n' ;;               # j
        6b) printf 'up\n' ;;                 # k
        71) printf 'esc\n' ;;                # q
        20) printf 'space\n' ;;              # espaco (marcar)
        61) printf 'a\n' ;;                  # a (marcar todos)
        *) printf 'other\n' ;;
    esac
}

# tui_menu <title> <items...> → imprime o indice escolhido (1..N) ou "0" para cancelar.
# Centraliza o box no meio do terminal (horizontal e vertical).
tui_menu() {
    local title="$1"; shift
    local n sel key i txt
    n=$#
    sel=0
    tui_mouse_on
    tui_hide_cursor
    tui_raw_begin
    tui_size
    local w=62
    local total_rows top pad margin_col margin_row
    # total de linhas desenhadas: topo + n itens + rodape + hints(2) + 1 folga
    total_rows=$((n + 5))
    margin_col=$(( ( TUI_COLS - w ) / 2 ))
    [ "$margin_col" -lt 1 ] && margin_col=1
    margin_row=$(( ( TUI_ROWS - total_rows ) / 2 ))
    [ "$margin_row" -lt 1 ] && margin_row=1
    while :; do
        tui_clear_below 1
        top=""
        i=0; while [ "$i" -lt $((w-8)) ]; do top="${top}─"; i=$((i+1)); done
        r=$margin_row
        tui_cursor $r $margin_col
        printf '%s%s┌─ %s%s%s ─%s%s%s\n' "$TUI_BG" "$TUI_RSET" "$TUI_ACCENT" "$title" "$TUI_RSET" "$TUI_DIM2" "$top" "$TUI_RSET" >&2
        i=0
        for txt in "$@"; do
            r=$((r+1))
            tui_cursor $r $margin_col
            pad=""
            local j
            j=0; while [ "$j" -lt $((w-6-${#txt})) ]; do pad="${pad} "; j=$((j+1)); done
            if [ "$i" -eq "$sel" ]; then
                printf '%s│ %s●%s %s%s%s%s│%s\n' "$TUI_BG" "$TUI_ACCENT" "$TUI_RSET" "$TUI_BOLD" "$txt" "$TUI_RSET" "$pad" "$TUI_RSET" >&2
            else
                printf '%s│ %s○%s %s%s%s│%s\n' "$TUI_BG" "$TUI_DIM2" "$TUI_RSET" "$txt" "$TUI_RSET" "$pad" "$TUI_RSET" >&2
            fi
            i=$((i+1))
        done
        r=$((r+1))
        tui_cursor $r $margin_col
        printf '%s└%s┘%s\n' "$TUI_BG" "$(printf '─%.0s' $(seq_like 1 $((w-2))))" "$TUI_RSET" >&2
        r=$((r+1))
        tui_cursor $r $margin_col
        printf '%s  %s[↑↓] navegar · [Enter] escolher · [Esc] cancelar%s' "$TUI_BG" "$TUI_DIM2" "$TUI_RSET" >&2
        key="$(tui_getkey)"
        case "$key" in
            up)   [ "$sel" -gt 0 ] && sel=$((sel-1)) ;;
            down) [ "$sel" -lt $((n-1)) ] && sel=$((sel+1)) ;;
            enter) break ;;
            esc)  sel=-1; break ;;
        esac
    done
    tui_raw_end
    tui_mouse_off
    tui_show_cursor
    if [ "$sel" -ge 0 ] && [ "$sel" -lt "$n" ]; then printf '%d\n' $((sel+1)); else printf '0\n'; fi
}

# tui_menu_multi <title> <items...> → imprime os indices marcados (1..N) separados
# por espaco, ou "0" para cancelar. Multi-selecao para escolher QUAL Discord
# patchear: Espaco marca/desmarca, 'a' marca/desmarca todos, Enter confirma
# (exige >= 1), Esc cancela.
tui_menu_multi() {
    local title="$1"; shift
    local n sel key i txt j pad marks marca_txt dim
    n=$#
    sel=0
    marks=""
    i=0; while [ "$i" -lt "$n" ]; do marks="${marks}0"; i=$((i+1)); done
    tui_mouse_on
    tui_hide_cursor
    tui_raw_begin
    tui_size
    local w=62
    local total_rows top margin_col margin_row r
    total_rows=$((n + 5))
    margin_col=$(( ( TUI_COLS - w ) / 2 ))
    [ "$margin_col" -lt 1 ] && margin_col=1
    margin_row=$(( ( TUI_ROWS - total_rows ) / 2 ))
    [ "$margin_row" -lt 1 ] && margin_row=1
    while :; do
        tui_clear_below 1
        top=""
        i=0; while [ "$i" -lt $((w-8)) ]; do top="${top}─"; i=$((i+1)); done
        r=$margin_row
        tui_cursor $r $margin_col
        printf '%s%s┌─ %s%s%s ─%s%s%s\n' "$TUI_BG" "$TUI_RSET" "$TUI_ACCENT" "$title" "$TUI_RSET" "$TUI_DIM2" "$top" "$TUI_RSET" >&2
        i=0
        for txt in "$@"; do
            r=$((r+1))
            tui_cursor $r $margin_col
            local marca antes novo
            marca="$(printf '%s' "$marks" | cut -c $((i+1)))"
            if [ "$marca" = "1" ]; then marca_txt="[x]"; dim="$TUI_FG"; else marca_txt="[ ]"; dim="$TUI_DIM2"; fi
            pad=""
            j=0; while [ "$j" -lt $((w-10-${#txt})) ]; do pad="${pad} "; j=$((j+1)); done
            if [ "$i" -eq "$sel" ]; then
                printf '%s│ %s%s%s %s%s%s%s%s│%s\n' "$TUI_BG" "$TUI_ACCENT" "$marca_txt" "$TUI_RSET" "$TUI_BOLD" "$txt" "$TUI_RSET" "$pad" "$TUI_RSET" >&2
            else
                printf '%s│ %s%s%s %s%s%s%s│%s\n' "$TUI_BG" "$TUI_DIM2" "$marca_txt" "$TUI_RSET" "$dim" "$txt" "$TUI_RSET" "$pad" "$TUI_RSET" >&2
            fi
            i=$((i+1))
        done
        r=$((r+1))
        tui_cursor $r $margin_col
        printf '%s└%s┘%s\n' "$TUI_BG" "$(printf '─%.0s' $(seq_like 1 $((w-2))))" "$TUI_RSET" >&2
        r=$((r+1))
        tui_cursor $r $margin_col
        printf '%s  %s[↑↓] navegar · [Espaço] marcar · [a] todos · [Enter] confirmar · [Esc] cancelar%s' "$TUI_BG" "$TUI_DIM2" "$TUI_RSET" >&2
        key="$(tui_getkey)"
        case "$key" in
            up)   [ "$sel" -gt 0 ] && sel=$((sel-1)) ;;
            down) [ "$sel" -lt $((n-1)) ] && sel=$((sel+1)) ;;
            space)
                marca="$(printf '%s' "$marks" | cut -c $((sel+1)))"
                if [ "$marca" = "1" ]; then novo="0"; else novo="1"; fi
                if [ "$sel" -gt 0 ]; then antes="$(printf '%s' "$marks" | cut -c 1-$sel)"; else antes=""; fi
                marks="$antes$novo$(printf '%s' "$marks" | cut -c $((sel+2))-"")"
                ;;
            a)
                local tudo=1 j2
                j2=0; while [ "$j2" -lt "$n" ]; do
                    [ "$(printf '%s' "$marks" | cut -c $((j2+1)))" = "1" ] || tudo=0
                    j2=$((j2+1))
                done
                marks=""
                j2=0; while [ "$j2" -lt "$n" ]; do
                    if [ "$tudo" -eq 1 ]; then marks="${marks}0"; else marks="${marks}1"; fi
                    j2=$((j2+1))
                done
                ;;
            enter)
                case "$marks" in *1*) break ;; esac
                ;;
            esc) sel=-1; break ;;
        esac
    done
    tui_raw_end
    tui_mouse_off
    tui_show_cursor
    if [ "$sel" -lt 0 ]; then printf '0\n'; return; fi
    local out="" j3
    j3=0; while [ "$j3" -lt "$n" ]; do
        if [ "$(printf '%s' "$marks" | cut -c $((j3+1)))" = "1" ]; then out="$out $((j3+1))"; fi
        j3=$((j3+1))
    done
    printf '%s\n' "$out"
}

# seq_like 1 N → 1 2 3 ... N (POSIX, sem `seq`).
seq_like() {
    local start="$1" end="$2" i
    i="$start"
    while [ "$i" -le "$end" ]; do printf '%d ' "$i"; i=$((i+1)); done
}

# tui_select <title> <opt1> <opt2> ... → igual a tui_menu (1-indexado).
tui_select() { tui_menu "$@"; }

# tui_confirm <question> → 0 se sim, 1 se nao. Aceita s/N (le uma linha).
tui_confirm() {
    tui_is_interactive || { confirm "$1"; return $?; }
    local answer
    printf '%s%s  %s [s/N] ' "$TUI_BG" "$TUI_FG" "$1" >&2
    tui_show_cursor
    read -r answer
    tui_hide_cursor
    case "$answer" in
        [sSyY]*) return 0 ;;
        *) return 1 ;;
    esac
}

# tui_progress <texto> → spinner simples na linha (atualiza no lugar).
tui_progress() {
    local msg="$1"
    printf '\033[2K\r%s%s[*]%s %s%s' "$TUI_BG" "$TUI_ACCENT" "$TUI_RSET" "$msg" "$TUI_RSET" >&2
}

# tui_done() → limpa a linha de progresso e imprime OK.
tui_done() {
    printf '\033[2K\r%s%s[OK]%s\n' "$TUI_BG" "$TUI_OK" "$TUI_RSET" >&2
}

# =========================================================================== /TUI

have() { command -v "$1" >/dev/null 2>&1; }

# Em automacao (--yes) o report automatico nao deve spammar a API (test/CI).
# Usuario de verdade sem --yes reporta.
[ "$ASSUME_YES" -eq 1 ] && REPORT_NO_AUTO=1 || REPORT_NO_AUTO=0

# O id do flatpak a que um caminho pertence, ou nada se o caminho nao for de flatpak. Serve
# para os dois lugares onde o Discord de flatpak aparece: o deploy em .../flatpak/app/<id>/ e
# o HOME do sandbox em ~/.var/app/<id>/.
flatpak_app_id() {
    local parte
    for parte in $(printf '%s\n' "${1:-}" | tr '/' '\n'); do
        case "$parte" in com.discordapp.*|dev.vencord.*|app.legcord.*|org.equicord.*) printf '%s\n' "$parte"; return 0 ;; esac
    done
    return 1
}

# Instalacao do usuario nao precisa de raiz para nada; a do sistema precisa para tudo. O
# `flatpak override` obedece essa mesma divisao, e passar --user na do sistema falha.
flatpak_is_user_install() {
    have flatpak && flatpak info --user "$1" >/dev/null 2>&1
}

# A liberacao ja existente aparece no --show-permissions, que nao precisa de raiz. Conferir
# antes evita pedir a senha do sudo toda vez que o instalador roda de novo.
flatpak_has_access() {
    local entrada lista IFS
    # Entrada por entrada, e comparando o texto inteiro: depois de um --nofilesystem a pasta
    # continua aparecendo na lista, so que como !pasta. Procurar o pedaco solto acharia essa
    # negacao e concluiria que o acesso existe, justamente quando ele nao existe mais.
    lista="$(flatpak info --show-permissions "$1" 2>/dev/null | sed -n 's/^filesystems=//p' | tr ';' '\n')"
    [ -n "$lista" ] || return 1
    IFS='
'
    for entrada in $lista; do
        case "$entrada" in
            "$2"|"$2:rw"|"$2:ro"|"$2:create") return 0 ;;
        esac
    done
    return 1
}

# O flatpak so enxerga o proprio sandbox. Sem liberar a pasta de build do mod, o Discord abre
# reclamando de modulo nao encontrado: o index.js injetado faz require de um caminho que de
# dentro do sandbox nao existe. O instalador do mod ja faz isso sozinho, mas nao no caminho em
# que a injecao ja estava pronta e nos so reiniciamos o Discord.
grant_flatpak_access() {
    local id="$1" dir="$2"
    have flatpak || return 0
    flatpak_has_access "$id" "$dir" && return 0

    if flatpak_is_user_install "$id"; then
        flatpak override --user "$id" --filesystem="$dir" >/dev/null 2>&1 && return 0
    else
        step "Liberando $dir para o $id (pode pedir sua senha do sudo)"
        sudo flatpak override "$id" --filesystem="$dir" >/dev/null 2>&1 && return 0
    fi

    warn "Nao consegui liberar $dir para o $id. Se o Discord abrir com erro de modulo, rode:"
    printf '  %s  flatpak override %s--filesystem=%s %s%s\n' \
        "$C_DIM" "$(flatpak_is_user_install "$id" && printf -- '--user ')" "$dir" "$id" "$C_OFF" >&2
    return 1
}

# ----------------------------------------------------------------------------- Tor legado
# O instalador nao oferece mais escolha de saida: a conta Proton e configurada dentro do
# plugin na primeira ativacao, e o plugin WireGuard nao le `proxy` do settings.json. O que
# sobra do Tor aqui e a limpeza do que as versoes anteriores deste instalador registraram
# na maquina de quem escolheu aquela opcao.

TOR_SERVICE="golivebypass-tor.service"

remove_tor() {
    # Desinstala o que versoes anteriores deste instalador criaram. Nao apaga o binario
    # (a GUI usa o mesmo).
    if command -v systemctl >/dev/null 2>&1; then
        systemctl --user disable --now "$TOR_SERVICE" 2>/dev/null
        rm -f "$HOME/.config/systemd/user/$TOR_SERVICE"
        systemctl --user daemon-reload 2>/dev/null
        if [ -f "/etc/systemd/system/$TOR_SERVICE" ]; then
            sudo systemctl disable --now "$TOR_SERVICE" 2>/dev/null
            sudo rm -f "/etc/systemd/system/$TOR_SERVICE"
            sudo systemctl daemon-reload 2>/dev/null
        fi
    fi
    rm -f "$HOME/.config/systemd/user/$TOR_SERVICE"
}

# O corepack cria o atalho do pnpm antes de saber que versao usar. Na primeira execucao ele
# busca essa versao no registro do npm e confere a assinatura com chaves embutidas nele; as
# chaves do corepack que vem no Node 22 estao velhas, entao o atalho existe e mesmo assim
# quebra com "Cannot find matching keyid". So testar se o comando existe nao prova nada.
# O </dev/null cobre o segundo modo de falha: um corepack virgem pergunta "Corepack is about
# to download..." e fica esperando resposta pelo stdin, pendurando o instalador para sempre.
# Com o stdin fechado ele aborta na hora e cai no npm install -g, como devia.
have_pnpm() { have pnpm && pnpm --version >/dev/null 2>&1 </dev/null; }

usage() {
    sed -n '3,18p' "$SCRIPT_PATH" | sed 's/^# \{0,1\}//'
    exit 0
}

while [ $# -gt 0 ]; do
    case "$1" in
        --install) MODE="install" ;;
        --uninstall) MODE="uninstall" ;;
        --restore) MODE="restore" ;;
        --check-update) MODE="check-update" ;;
        --update) MODE="update" ;;
        --mod) MOD="${2:-}"; shift ;;
        --source) SOURCE="${2:-}"; shift ;;
        --plugin-source) PLUGIN_SOURCE="${2:-}"; shift ;;
        --yes|-y) ASSUME_YES=1 ;;
        --help|-h) usage ;;
        *) fail "Opcao desconhecida: $1" ;;
    esac
    shift
done

# ----------------------------------------------------------------------------- descoberta

is_checkout() {
    [ -n "${1:-}" ] || return 1
    [ -f "$1/package.json" ] || return 1
    [ -f "$1/src/utils/types.ts" ]
}

# Procura o app.asar de verdade em vez de confiar numa lista de caminhos.
#
# Desde a versao 1.0.136, de maio de 2026, o pacote de Linux do Discord (tar.gz, .deb, o
# oficial do Arch e o RPM) traz SO um bootstrap: o app de verdade, com o app.asar, e baixado na
# primeira execucao para dentro do HOME. Quem so olha /usr/share e /opt nao acha Discord nenhum
# numa instalacao atual.
# Detecta se um path de install eh um cliente paralelo (Vesktop/Equibop/Legcord)
# e NAO o Discord puro. O Discord ja vem com o mod embutido no cliente, e o
# instalador de mod nao injeta neles (o EquilotlCli da "Invalid Discord install"
# porque o binario nao eh o Discord).
is_parallel_install() {
    case "$1" in
        */vesktop|*/Vesktop|*/equibop|*/Equibop|*/legcord|*/Legcord) return 0 ;;
        *) return 1 ;;
    esac
}

discord_resources() {
    local raiz sub base id

    base="${XDG_CONFIG_HOME:-$HOME/.config}"
    for sub in \
        "$base"/discord/app-*/resources \
        "$base"/discordptb/app-*/resources \
        "$base"/discordcanary/app-*/resources
    do
        if [ -e "$sub/app.asar" ] || [ -e "$sub/_app.asar" ]; then
            printf '%s\n' "$sub"
        fi
    done

    # Pacotes que ainda embutem o app: discord_arch_electron e os AUR de PTB e Canary.
    for raiz in \
        /usr/share/discord /usr/share/discord-ptb /usr/share/discord-canary \
        /usr/lib/discord /usr/lib/discord-ptb /usr/lib/discord-canary /usr/lib64/discord \
        /opt/discord /opt/Discord /opt/discord-ptb /opt/discord-canary \
        /usr/local/share/discord \
        "$HOME/.local/share/discord" "$HOME/Discord" "$HOME/discord" \
        "$HOME/.local/share/DiscordPTB" "$HOME/.local/share/DiscordCanary"
    do
        [ -d "$raiz" ] || continue
        for sub in "$raiz/resources" "$raiz"; do
            if [ -e "$sub/app.asar" ] || [ -e "$sub/_app.asar" ]; then
                printf '%s\n' "$sub"
                break
            fi
        done
    done

    # Clientes paralelos (Vesktop/Equibop/Legcord) instalados por AUR/pacote: costumam morar
    # em /usr/share, /usr/lib, /usr/lib64, /opt ou ~/.local/share. Espelhado do standalone.
    for raiz in \
        /usr/share/vesktop /usr/lib/vesktop /usr/lib64/vesktop /opt/vesktop /opt/Vesktop \
        /usr/share/equibop /usr/lib/equibop /usr/lib64/equibop /opt/equibop /opt/Equibop \
        /usr/share/legcord /usr/lib/legcord /usr/lib64/legcord /opt/legcord /opt/Legcord \
        /usr/local/share/vesktop /usr/local/share/equibop /usr/local/share/legcord \
        "$HOME/.local/share/vesktop" "$HOME/.local/share/equibop" "$HOME/.local/share/legcord" \
        "$HOME/vesktop" "$HOME/equibop" "$HOME/legcord" \
        /snap/vesktop/current /snap/equibop/current /snap/legcord/current \
        /opt/vesktop/vesktop /opt/equibop/equibop /opt/legcord/legcord
    do
        [ -d "$raiz" ] || continue
        for sub in "$raiz/resources" "$raiz"; do
            if [ -e "$sub/app.asar" ] || [ -e "$sub/_app.asar" ]; then
                printf '%s\n' "$sub"
                break
            fi
        done
    done

    # Discord "vanilla" (nao-paralelo) tambem pode estar em paths alternativos:
    # - Snap: /snap/discord/current/resources
    # - Home direto: ~/discord/resources, ~/Discord/resources
    # - AppImage montado em /opt
    for raiz in \
        /snap/discord/current /snap/discordptb/current /snap/discordcanary/current \
        "$HOME/discord" "$HOME/Discord" "$HOME/discordptb" "$HOME/DiscordPTB" \
        "$HOME/discordcanary" "$HOME/DiscordCanary" \
        /opt/discord/discord /opt/discordptb/discordptb /opt/discordcanary/discordcanary
    do
        [ -d "$raiz" ] || continue
        for sub in "$raiz/resources" "$raiz"; do
            if [ -e "$sub/app.asar" ] || [ -e "$sub/_app.asar" ]; then
                printf '%s\n' "$sub"
                break
            fi
        done
    done

    # AppImage la e descompacta manualmente (ou via appimaged). Procuramos o app.asar
    # em subpastas tipicas.
    for raiz in \
        "$HOME/Apps" "$HOME/Applications" "$HOME/AppImages" "$HOME/.local/bin" \
        /opt/apps /opt/Applications /opt/AppImages
    do
        [ -d "$raiz" ] || continue
        for sub in \
            "$raiz"/*/resources "$raiz"/*/discord-*/app-*/resources \
            "$raiz"/vesktop*/resources "$raiz"/equibop*/resources "$raiz"/legcord*/resources
        do
            if [ -e "$sub/app.asar" ] || [ -e "$sub/_app.asar" ]; then
                printf '%s\n' "$sub"
            fi
        done
    done

    # Flatpak. O app fica no deploy do ostree, que e do root, mas e um diretorio comum num
    # sistema de arquivos comum: a injecao troca o nome do app.asar e cria uma pasta ao lado,
    # sem reescrever nenhum arquivo, entao os objetos do repositorio ficam intactos. E o que o
    # instalador do Equicord e o do Vencord ja fazem ha tempos. O preco e que um
    # `flatpak update` refaz o deploy e leva a injecao junto.
    for raiz in /var/lib/flatpak/app "${XDG_DATA_HOME:-$HOME/.local/share}/flatpak/app"; do
        [ -d "$raiz" ] || continue
        for id in $FLATPAK_IDS; do
            for sub in "$raiz/$id"/current/active/files/*/resources; do
                if [ -e "$sub/app.asar" ] || [ -e "$sub/_app.asar" ]; then
                    printf '%s\n' "$sub"
                fi
            done
        done
    done

    # E o bootstrap de que fala o comentario aqui em cima, so que dentro do flatpak: o HOME do
    # Discord vira ~/.var/app/<id>, e o app baixado cai la. Este e do proprio usuario, sem sudo.
    for id in $FLATPAK_IDS; do
        for sub in "$HOME/.var/app/$id"/config/discord*/app-*/resources; do
            if [ -e "$sub/app.asar" ] || [ -e "$sub/_app.asar" ]; then
                printf '%s\n' "$sub"
            fi
        done
    done

    # Os loops acima listam tambem Equibop/Vesktop/Legcord (caminhos /usr/lib/equibop etc)
    # porque o usuario pode ter esses clientes paralelos. Mas o instalador de mod
    # (EquilotlCli) NAO injeta neles - o binario nao eh o Discord e o CLI da
    # "Invalid Discord install". Filtramos no final, e criamos discord_installs()
    # e parallel_installs() separados para o resto do script usar.
    return 0
}

# Versao filtrada do discord_resources: so Equibop/Vesktop/Legcord (clientes
# paralelos, NAO injetaveis pelo instalador de mod). Usado pelo show_status
# so para informacao.
parallel_installs() {
    # O corpo do while precisa terminar em status 0: os callers fazem
    # `parallels="$(parallel_installs)"` e, com `set -e`, um
    # `is_parallel_install && printf` curto-circuitado no ULTIMO recurso fazia o
    # while sair com 1, o assignment falhar e o shell inteiro morrer sem
    # mensagem nenhuma (menu nunca aparecia quando o ultimo install achado era
    # um Discord puro, o caso mais comum). Com `if`, sem branch executado o
    # status e 0 e a funcao sempre termina bem.
    discord_resources | while IFS= read -r resources; do
        if is_parallel_install "$resources"; then
            printf '%s\n' "$resources"
        fi
    done
}

# Versao filtrada do discord_resources: so Discord (sem Equibop/Vesktop/Legcord).
# Usado pela injecao (install_target) e pelo show_status que precisa do count
# correto de "Discord instalado".
discord_installs() {
    discord_resources | while IFS= read -r resources; do
        is_parallel_install "$resources" || printf '%s\n' "$resources"
    done
}

# O que passar em --location para o instalador do mod. Ele quer a pasta de cima, e no flatpak
# quer o diretorio do app inteiro: e de la que ele descobre que aquilo e um flatpak e libera o
# sandbox. Apontar direto para .../current/active/files/discord faz a liberacao nao acontecer,
# e o Discord abre com erro de modulo.
install_location() {
    local resources="$1"
    case "$resources" in
        */current/active/*) printf '%s\n' "${resources%%/current/active/*}" ;;
        */app-*/resources)  dirname "$(dirname "$resources")" ;;
        */resources)        dirname "$resources" ;;
        *)                  printf '%s\n' "$resources" ;;
    esac
}

# O resources cujo app.asar aponta para este checkout, seja ele qual for. Base das tres
# perguntas que o resto do script faz: se a injecao pegou, se ela caiu num flatpak, e em qual.
injected_resources() {
    local root="${1:-}" resources path
    [ -n "$root" ] || return 1
    while IFS= read -r resources; do
        path="$(injected_path "$resources" || true)"
        [ -n "$path" ] || continue
        case "$path" in "$root"/*) printf '%s\n' "$resources"; return 0 ;; esac
    done <<EOF
$(discord_resources)
EOF
    return 1
}

# O id do flatpak cuja injecao aponta para este checkout, se for o caso. Decide onde ficam as
# configuracoes do mod e como reabrir o Discord.
injected_flatpak_id() {
    local resources
    resources="$(injected_resources "${1:-}")" || return 1
    flatpak_app_id "$resources"
}

# O instalador do Equicord e o do Vencord trocam o app.asar por um stub cujo index.js so faz
# require da pasta de build. Numa instalacao a partir do fonte esse require aponta direto para
# <checkout>/dist/desktop, que e a forma mais confiavel de achar o checkout.
injected_path() {
    local resources="$1" file text match
    for file in "$resources/app/index.js" "$resources/app.asar"; do
        [ -f "$file" ] || continue
        [ "$(stat -c%s "$file" 2>/dev/null || echo 0)" -lt 65536 ] || continue
        text="$(tr -d '\0' < "$file" 2>/dev/null || true)"
        # O mesmo casamento do =~ do bash, com sed: so POSIX.
        match="$(printf '%s\n' "$text" | sed -n 's/.*require("\([^"]*\)").*/\1/p' | head -1)"
        if [ -n "$match" ]; then
            printf '%s\n' "$match"
            return 0
        fi
    done
    return 1
}

installed_mod() {
    local resources path
    while IFS= read -r resources; do
        path="$(injected_path "$resources" || true)"
        [ -n "$path" ] || continue
        case "$(printf '%s' "$path" | tr '[:upper:]' '[:lower:]')" in
            *equibop*) echo "Equibop"; return 0 ;;
            *equicord*) echo "Equicord"; return 0 ;;
            *vesktop*) echo "Vesktop"; return 0 ;;
            *vencord*) echo "Vencord"; return 0 ;;
            *legcord*) echo "Legcord"; return 0 ;;
        esac
    done <<EOF
$(discord_resources)
EOF
    return 1
}

checkout_from_injection() {
    local resources path root
    while IFS= read -r resources; do
        path="$(injected_path "$resources" || true)"
        [ -n "$path" ] || continue
        root="$(dirname "$(dirname "$path")")"   # <checkout>/dist/desktop -> <checkout>
        if is_checkout "$root"; then printf '%s\n' "$root"; return 0; fi
    done <<EOF
$(discord_resources)
EOF
    return 1
}

checkout_on_disk() {
    local root name candidate
    for root in "$HOME" "$HOME/Documents" "$HOME/Desktop" "$HOME/Downloads" \
                "$HOME/dev" "$HOME/git" "$HOME/repos" "$HOME/projects" "$HOME/src" \
                "$HOME/.local/share"
    do
        [ -d "$root" ] || continue
        for name in Equicord equicord Vencord vencord; do
            candidate="$root/$name"
            if is_checkout "$candidate"; then printf '%s\n' "$candidate"; return 0; fi
        done
    done

    step "Procurando um pouco mais fundo em $HOME"
    while IFS= read -r candidate; do
        if is_checkout "$candidate"; then printf '%s\n' "$candidate"; return 0; fi
    done <<EOF
$(find "$HOME" -maxdepth 4 -type d \( -iname Equicord -o -iname Vencord \) 2>/dev/null | head -n 20)
EOF

    return 1
}

find_checkout() {
    local root
    if [ -n "$SOURCE" ]; then
        is_checkout "$SOURCE" || fail "Nao encontrei um checkout do Equicord ou Vencord em $SOURCE"
        printf '%s\n' "$SOURCE"; return 0
    fi

    if root="$(checkout_from_injection)"; then
        ok "Achei pelo Discord: $root"
        printf '%s\n' "$root"; return 0
    fi

    if root="$(checkout_on_disk)"; then
        ok "Achei no disco: $root"
        printf '%s\n' "$root"; return 0
    fi

    return 1
}

injected_from_checkout() {
    injected_resources "$1" >/dev/null
}

# ----------------------------------------------------------------------------- instalacao

choose_mod() {
    if [ -n "$MOD" ]; then
        case "$(printf '%s' "$MOD" | tr '[:upper:]' '[:lower:]')" in
            equicord) echo "Equicord"; return 0 ;;
            vencord) echo "Vencord"; return 0 ;;
            *) fail "--mod aceita equicord ou vencord" ;;
        esac
    fi

    local installed
    installed="$(installed_mod || true)"

    if tui_is_interactive; then
        local tui_choice
        tui_choice="$(tui_menu "Qual mod instalar?" "Equicord (recomendado, inclui tudo do Vencord)" "Vencord (o original, mais enxuto)")"
        case "$tui_choice" in
            1) echo "Equicord" ;;
            2) echo "Vencord" ;;
            *) fail "Cancelado." ;;
        esac
        return 0
    fi

    printf '\n' >&2
    if [ -n "$installed" ]; then
        warn "Voce tem o $installed instalado, mas nao achei o codigo fonte dele." >&2
        printf '  %sPlugins de usuario so existem compilando do fonte, entao preciso baixar o repositorio.%s\n' "$C_DIM" "$C_OFF" >&2
    else
        warn "Nao encontrei Equicord nem Vencord no seu computador." >&2
        printf '  %sPosso baixar e instalar um dos dois junto com o plugin.%s\n' "$C_DIM" "$C_OFF" >&2
    fi

    printf '\n  %sQual voce quer instalar?%s\n\n' "$C_BOLD" "$C_OFF" >&2
    printf '    %s[1] Equicord%s    recomendado, inclui tudo do Vencord e mais plugins\n' "$C_GREEN" "$C_OFF" >&2
    printf '    %s[2] Vencord%s     o original, mais enxuto\n' "$C_CYAN" "$C_OFF" >&2
    printf '    [0] Cancelar\n\n' >&2

    local choice
    printf '%s' "  Escolha: " >&2
    read -r choice
    case "$choice" in
        1) echo "Equicord" ;;
        2) echo "Vencord" ;;
        *) fail "Cancelado." ;;
    esac
}

os_field() {
    [ -r /etc/os-release ] || return 0
    sed -n "s/^$1=//p" /etc/os-release | tr -d '"' | head -1
    return 0
}

# Detectado pelo binario, e nao pelo ID da distro: derivada de Arch e de Ubuntu aparece toda
# semana, e o pacman nao muda de nome por causa disso.
package_manager() {
    have pacman  && { printf 'pacman\n';  return 0; }
    have apt-get && { printf 'apt\n';     return 0; }
    have dnf     && { printf 'dnf\n';     return 0; }
    have zypper  && { printf 'zypper\n';  return 0; }
    have apk     && { printf 'apk\n';     return 0; }
    printf 'desconhecido\n'
    return 0
}

install_cmd() {
    case "$(package_manager)" in
        pacman) printf 'sudo pacman -S --needed %s\n' "$*" ;;
        apt)    printf 'sudo apt-get install -y %s\n' "$*" ;;
        dnf)    printf 'sudo dnf install -y %s\n' "$*" ;;
        zypper) printf 'sudo zypper install -y %s\n' "$*" ;;
        apk)    printf 'sudo apk add %s\n' "$*" ;;
        *)      printf '' ;;
    esac
    return 0
}

node_major() {
    local v=""
    have node && v="$(node -v 2>/dev/null | sed -n 's/^v\([0-9][0-9]*\).*/\1/p' | head -1)"
    printf '%s\n' "${v:-0}"
    return 0
}

# O Node do Debian estavel e do Ubuntu LTS costuma ser mais antigo que 22, e o build so quebra
# la na frente, com um erro que nao diz "seu Node e velho". Melhor barrar aqui e explicar.
node_velho_ajuda() {
    printf '\n  %sO Equicord precisa do Node 22 ou mais novo, e o seu e o %s.%s\n' "$C_YELLOW" "$(node_major)" "$C_OFF" >&2
    case "$(package_manager)" in
        pacman)
            printf '  %sNo Arch o pacote nodejs ja e atual. Rode: sudo pacman -Syu nodejs npm%s\n' "$C_DIM" "$C_OFF" >&2 ;;
        apt)
            printf '  %sO pacote do Debian/Ubuntu e antigo demais. Duas saidas:%s\n' "$C_DIM" "$C_OFF" >&2
            printf '  %s  1) nvm:  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash%s\n' "$C_DIM" "$C_OFF" >&2
            printf '  %s           depois: nvm install 22%s\n' "$C_DIM" "$C_OFF" >&2
            printf '  %s  2) NodeSource: https://github.com/nodesource/distributions%s\n' "$C_DIM" "$C_OFF" >&2 ;;
        dnf)
            printf '  %sNo Fedora: sudo dnf module reset nodejs && sudo dnf module enable nodejs:22%s\n' "$C_DIM" "$C_OFF" >&2 ;;
        *)
            printf '  %sInstale o Node 22 pelo nvm ou pelo fnm.%s\n' "$C_DIM" "$C_OFF" >&2 ;;
    esac
    return 0
}

ensure_toolchain() {
    local need_git="$1" faltando="" cmd

    [ "$need_git" -eq 1 ] && ! have git && faltando="${faltando:+$faltando }git"
    have node || faltando="${faltando:+$faltando }nodejs"
    have npm  || faltando="${faltando:+$faltando }npm"

    if [ -n "$faltando" ]; then
        warn "Faltando: $faltando"

        cmd="$(install_cmd "$faltando")"
        if [ -z "$cmd" ]; then
            printf '  %sNao reconheci o gerenciador de pacotes. Instale na mao: %s%s\n' "$C_DIM" "$faltando" "$C_OFF" >&2
            fail "Instale o que falta e rode de novo."
        fi

        printf '  %sSua distro: %s%s\n' "$C_DIM" "$(os_field PRETTY_NAME)" "$C_OFF" >&2
        printf '  %sComando: %s%s\n' "$C_DIM" "$cmd" "$C_OFF" >&2

        # Rodar por conta propria um comando com sudo seria abuso de confianca; perguntar antes
        # e o minimo, e quem preferir faz na mao com o comando ali em cima.
        if confirm "Posso rodar isso agora?"; then
            eval "$cmd" || fail "A instalacao das dependencias falhou. Rode na mao: $cmd"
            hash -r 2>/dev/null || true
        else
            fail "Instale o que falta e rode de novo."
        fi
    fi

    if [ "$(node_major)" -lt 22 ]; then
        node_velho_ajuda
        fail "Atualize o Node e rode de novo."
    fi

    # O corepack vem ligado no Node 22 e cria um atalho do pnpm que quebra na primeira
    # execucao: as chaves de assinatura embutidas estao velhas e o atalho morre com
    # "Cannot find matching keyid", ou fica esperando resposta no stdin. O </dev/null do
    # have_pnpm corta essa espera, mas o atalho continua no PATH atrapalhando a instalacao
    # e o uso do pnpm de verdade. Desligar tira esse atalho do caminho.
    #
    # So mexemos nisso quando o pnpm nao esta funcionando: se o corepack ja entrega um pnpm
    # que roda, desligar seria estragar a maquina de quem estava bem. E "disable pnpm", nao
    # "disable" seco, que tambem levaria o atalho do yarn junto -- nao e nosso para desligar.
    if ! have_pnpm && have corepack; then
        step "Desligando o atalho quebrado do pnpm no corepack"
        corepack disable pnpm >/dev/null 2>&1 || true
        hash -r 2>/dev/null || true
    fi

    # No Arch o pnpm e um pacote como qualquer outro, e sai mais limpo que um -g do npm em
    # /usr/lib, que fica fora do controle do pacman.
    if ! have_pnpm && [ "$(package_manager)" = "pacman" ]; then
        step "Instalando o pnpm pelo pacman"
        sudo pacman -S --needed --noconfirm pnpm >/dev/null 2>&1 || true
        hash -r 2>/dev/null || true
    fi

    if ! have_pnpm; then
        step "Instalando o pnpm pelo npm"
        npm install -g pnpm >/dev/null 2>&1 || sudo npm install -g pnpm >/dev/null 2>&1 || true
        hash -r 2>/dev/null || true
    fi

    # Fallback mais robusto: o instalador oficial baixa o binario standalone do pnpm
    # (que nem precisa do Node instalado) para a pasta do usuario, sem sudo e sem tocar
    # no npm. O default do instalador e ~/.pnpm no HOME; fixamos o PNPM_HOME para nao
    # depender do default de versao nenhuma, e o binario cai em $PNPM_HOME/bin.
    if ! have_pnpm && { have curl || have wget; }; then
        step "Baixando o pnpm do site oficial (pasta do usuario, sem sudo)"
        PNPM_HOME="${XDG_DATA_HOME:-$HOME/.local/share}/pnpm"
        export PNPM_HOME
        if have curl; then
            curl -fsSL https://get.pnpm.io/install.sh | sh - >/dev/null 2>&1 || true
        else
            wget -qO- https://get.pnpm.io/install.sh | sh - >/dev/null 2>&1 || true
        fi
        PATH="$PNPM_HOME/bin:$PATH"
        hash -r 2>/dev/null || true
    fi

    have_pnpm || fail 'Nao consegui deixar o pnpm funcionando. Rode: sudo npm install -g pnpm'
    ok "pnpm $(pnpm --version 2>/dev/null)"
}

install_mod() {
    local choice="$1" git_url target
    case "$choice" in
        Equicord) git_url="$EQUICORD_GIT" ;;
        Vencord)  git_url="$VENCORD_GIT" ;;
        *) fail "Mod desconhecido: $choice" ;;
    esac
    target="$HOME/$choice"

    printf '\n  %sVou fazer:%s\n' "$C_BOLD" "$C_OFF" >&2
    printf '  %s  1. Baixar o %s em %s%s\n' "$C_DIM" "$choice" "$target" "$C_OFF" >&2
    printf '  %s  2. Instalar as dependencias%s\n' "$C_DIM" "$C_OFF" >&2
    printf '  %s  3. Compilar junto com o GoLiveBypass%s\n' "$C_DIM" "$C_OFF" >&2
    printf '  %s  4. Injetar no Discord (o Discord vai fechar)%s\n\n' "$C_DIM" "$C_OFF" >&2
    confirm "Pode seguir?" || fail "Cancelado."

    ensure_toolchain 1

    if [ -d "$target" ]; then
        is_checkout "$target" || fail "$target ja existe e nao parece um checkout. Apague a pasta ou use --source."
        step "Ja existe um checkout em $target, reaproveitando" >&2
    else
        step "git clone $git_url" >&2
        git clone --depth 1 "$git_url" "$target" >&2 || fail "git clone falhou"
    fi

    printf '%s\n' "$target"
}

repo_file() {
    local relative="$1"
    local local_path="$SCRIPT_DIR/../$relative"
    if [ -f "$local_path" ]; then
        cat "$local_path"
        return 0
    fi

    if have curl; then
        curl -fsSL "$REPO_RAW/$relative" || fail "Nao consegui baixar $relative. Verifique sua conexao."
    elif have wget; then
        wget -qO- "$REPO_RAW/$relative" || fail "Nao consegui baixar $relative. Verifique sua conexao."
    else
        fail "Preciso do curl ou do wget para baixar o plugin."
    fi
}

# O processo do flatpak tem o mesmo nome de sempre e o pgrep costuma achar, mas ele roda em
# outro namespace de PID e um pkill pode nao alcancar. O `flatpak ps` responde pelo que o
# pgrep nao ve, e o `flatpak kill` fecha o que o pkill nao fecha.
discord_running() {
    pgrep -x -i 'Discord|DiscordCanary|DiscordPTB|discord|discord-canary|discordptb' >/dev/null 2>&1 && return 0

    # Um `flatpak ps` so, e nao um por id: isto roda em laco de dois em dois segundos enquanto
    # o modo temporario espera o Discord fechar.
    if have flatpak; then
        local rodando
        rodando="$(flatpak ps --columns=application 2>/dev/null || true)"
        case "$rodando" in *com.discordapp.*|*dev.vencord.*|*app.legcord.*|*org.equicord.*) return 0 ;; esac
    fi
    return 1
}

stop_discord() {
    discord_running || return 0

    step "Fechando o Discord"
    pkill -x -i 'Discord|DiscordCanary|DiscordPTB|discord|discord-canary|discordptb' >/dev/null 2>&1 || true
    if have flatpak; then
        local id
        for id in $FLATPAK_IDS; do
            flatpak kill "$id" >/dev/null 2>&1 || true
        done
    fi

    local i
    for i in $(seq 1 30); do
        sleep 0.3
        discord_running || return 0
    done

    # SIGTERM nao resolveu; SIGKILL e o ultimo recurso antes de desistir.
    step "O Discord nao respondeu, forçando o fechamento"
    pkill -9 -x -i 'Discord|DiscordCanary|DiscordPTB|discord|discord-canary|discordptb' >/dev/null 2>&1 || true
    for i in $(seq 1 20); do
        sleep 0.3
        discord_running || return 0
    done
    fail "O Discord nao fechou nem com SIGKILL. Feche na mao e rode de novo."
}

# Fontes uma a uma (checkout local ao lado do script ou raw.githubusercontent). E o caminho
# de reserva: o main pode estar atras da tag da linha beta — foi o caso da vpn-linux.ts, que
# so existia no zip — e ai a lista PLUGIN_FILES pede arquivo que o main ainda nao tem.
copy_plugin_from_repo() {
    local root="$1" target="$1/src/userplugins/$PLUGIN_DIR_NAME" file
    step "Instalando o plugin em $target"
    mkdir -p "$target"

    # versoes antigas usavam index.ts; deixar os dois quebra o build
    rm -f "$target/index.ts"

    # PLUGIN_FILES virou uma string com espacos na conversao POSIX (nao ha arrays no sh).
    # Sem aspas de proposito: divide nos espacos, uma palavra por arquivo. Com aspas, o
    # "${PLUGIN_FILES[@]}" restante colava os dois caminhos num so e o curl recusava a URL
    # malformada — o plugin nunca baixava (relato real: "URL rejected: Malformed input").
    for file in $PLUGIN_FILES; do
        if [ -n "$PLUGIN_SOURCE" ]; then
            [ -f "$PLUGIN_SOURCE/$(basename "$file")" ] || fail "Nao achei $(basename "$file") em $PLUGIN_SOURCE."
            cp "$PLUGIN_SOURCE/$(basename "$file")" "$target/$(basename "$file")"
        else
            repo_file "$file" > "$target/$(basename "$file")"
        fi
    done

    # `&&` sozinho como ultima linha deixaria a funcao com o codigo de saida do teste, e sob
    # `set -e` uma pasta vazia derrubaria o instalador inteiro.
    if [ -n "$PLUGIN_SOURCE" ]; then
        warn "Plugin copiado de $PLUGIN_SOURCE, e nao do GitHub."
    fi
    return 0
}

# De onde vem o plugin instalado. O zip da release e a fonte normal: e o mesmo artefato que
# o updater do proprio plugin instala, com SHA-256 publicado ao lado, e a tag entrega a
# linha beta inteira (o main pode nao ter todas as fontes dela). Tres casos caem nas fontes
# uma a uma: --plugin-source, um checkout do repositorio ao lado do script e, por ultimo, a
# release inalcancavel (rede ou rate limit do GitHub).
install_plugin_source() {
    local root="$1" url tag

    if [ -n "$PLUGIN_SOURCE" ]; then
        copy_plugin_from_repo "$root"
        return 0
    fi

    if [ -f "$SCRIPT_DIR/../$PLUGIN_DIR_NAME/index.tsx" ]; then
        step "Usando o checkout do repositorio que esta ao lado do instalador"
        copy_plugin_from_repo "$root"
        return 0
    fi

    if url=$(github_plugin_release 2>/dev/null) && [ -n "$url" ]; then
        tag=${url%/*}; tag=${tag##*/}; tag=${tag#v}
        step "Instalando o plugin da release v$tag"
        do_update_from_zip "$root" "$url" "$tag"
        return 0
    fi

    warn "Nao consegui consultar a release do plugin (rede ou rate limit do GitHub)."
    warn "Caindo no download arquivo a arquivo da branch main."
    copy_plugin_from_repo "$root"
}

build_mod() {
    local root="$1"
    if [ ! -d "$root/node_modules" ]; then
        step "Instalando dependencias (na primeira vez demora alguns minutos)"
        (cd "$root" && pnpm install) || fail "pnpm install falhou"
    fi

    step "Compilando"
    (cd "$root" && pnpm build) || fail "pnpm build falhou"
}

# Patch direto em UM cliente paralelo (Equibop/Vesktop/Legcord) com source local.
# O instalador de mod do Equicord (EquilotlCli) nao reconhece esses clientes
# (FindDiscords() soh olha LinuxDiscordNames) - pnpm inject mostra so "Custom
# Location" e falha. Esse caminho copia o dist/<cliente>.asar (gerado pelo
# build do Equicord) sobre o app.asar do cliente, com backup automatico.
# $2 = pasta do cliente (termina em /vesktop|/equibop|/legcord, com app.asar dentro).
# (Extrato do antigo inject_parallel: o seletor novo escolhe varios alvos.)
patch_parallel_one() {
    local root="$1" target="$2"
    local asar="" client_name="" app_path="" mod=""

    [ -n "$target" ] || return 1

    # Mapear path -> nome do cliente
    case "$target" in
        */equibop|*/Equibop) client_name="Equibop" ;;
        */vesktop|*/Vesktop) client_name="Vesktop" ;;
        */legcord|*/Legcord) client_name="Legcord" ;;
        *) printf "  [!] Cliente paralelo desconhecido: %s\n" "$target"; return 1 ;;
    esac

    # Equicord e Vencord sao forks DIFERENTES: o build do Equicord so empacota
    # equibop.asar (o cliente dele), o do Vencord so vesktop.asar (o dele) -- nenhum dos
    # dois gera o .asar do outro. Legcord e um projeto A PARTE (nao e fork de nenhum dos
    # dois): nenhum checkout Equicord/Vencord gera legcord.asar, entao "rode pnpm build e
    # tente de novo" era enganoso nesse caso -- nenhum build ia gerar aquele arquivo. Essa
    # e a causa raiz por tras das issues #123/#130/#132/#133 no lado Windows (sempre
    # Vesktop detectado com um checkout Equicord); aqui do lado Linux o bug era o mesmo,
    # so que sem relato ainda.
    app_path="$target/app.asar"
    mod="$(checkout_mod "$root")"
    case "$mod:$client_name" in
        Equicord:Equibop) asar="$root/dist/equibop.asar" ;;
        Vencord:Vesktop) asar="$root/dist/vesktop.asar" ;;
        *)
            printf "  [!] %s nao e gerado por um checkout %s (Equicord builda so o Equibop, Vencord so o Vesktop; Legcord e um app a parte -- nenhum dos dois builda ele). Use um checkout do mod certo para %s, ou injete o %s pelo instalador dele mesmo.\n" \
                "$client_name" "$mod" "$client_name" "$client_name"
            return 1
            ;;
    esac

    if [ ! -f "$asar" ]; then
        printf "  [!] Build nao gerou %s. Rode 'pnpm build' em %s e tente de novo.\n" "$asar" "$root"
        return 1
    fi

    # Backup do original (idempotente: pula se ja existe)
    if [ ! -f "$target/_app.asar" ]; then
        if [ -w "$target" ]; then
            cp "$app_path" "$target/_app.asar" || { printf "  [!] Nao consegui fazer backup\n"; return 1; }
        else
            step "Backup do app.asar original (precisa de sudo)"
            sudo cp "$app_path" "$target/_app.asar" || { printf "  [!] Sudo falhou no backup. Tente manualmente:\n  sudo cp %s %s/_app.asar\n" "$app_path" "$target"; return 1; }
            sudo chown "$(id -u):$(id -g)" "$target/_app.asar" 2>/dev/null || true
        fi
        ok "Backup criado em $target/_app.asar"
    else
        step "Backup ja existe em $target/_app.asar"
    fi

    # Copia o asar novo
    if [ -w "$target" ]; then
        cp "$asar" "$app_path" || { printf "  [!] Nao consegui copiar\n"; return 1; }
    else
        step "Copiando $client_name com patcher (precisa de sudo)"
        sudo cp "$asar" "$app_path" || { printf "  [!] Sudo falhou no copy. Tente manualmente:\n  sudo cp %s %s\n" "$asar" "$app_path"; return 1; }
        sudo chown "$(id -u):$(id -g)" "$app_path" 2>/dev/null || true
    fi
    ok "$client_name patchado: $app_path"
    return 0
}

# --location poupa a pergunta do instalador do mod quando so ha um Discord, e de quebra deixa
# a escolha do sudo certa: da para saber de antemao onde a injecao vai cair. Com mais de um,
# quem escolhe e o instalador do mod, que lista todos.
run_inject() {
    local root="$1" loc="${2:-}"

    # Nem todo pnpm come o -- antes de repassar o resto, e o instalador do mod que recebe um --
    # solto para de ler opcoes ali e ignora o --location. Nao da para impedir de fora; da para
    # cair no caminho de sempre, que e o instalador do mod perguntando qual Discord usar.
    if [ -n "$loc" ] && (cd "$root" && pnpm run inject -- --location "$loc"); then
        return 0
    fi

    (cd "$root" && pnpm inject)
}

# O sudo limpa o ambiente, e sem PATH nem o pnpm nem o node sobrevivem. E o instalador do mod
# que o pnpm baixa vai parar em dist/ como root: sem devolver o dono, o proximo build sem sudo
# quebra com permissao negada numa pasta que era do usuario.
run_inject_root() {
    local root="$1" loc="${2:-}" rc=0

    # Sem HOME de proposito: o instalador do mod ja descobre o HOME de verdade pelo SUDO_USER,
    # e mandar o do usuario so faria o pnpm encher ~/.cache de arquivo do root.
    if [ -n "$loc" ]; then
        sudo env PATH="$PATH" bash -c 'cd "$1" || exit 1; shift; exec "$@"' _ "$root" pnpm run inject -- --location "$loc" || rc=$?
    else
        sudo env PATH="$PATH" bash -c 'cd "$1" || exit 1; shift; exec "$@"' _ "$root" pnpm inject || rc=$?
    fi

    # Mesmo motivo do run_inject: se o --location nao chegou, tentar sem ele.
    if [ "$rc" -ne 0 ] && [ -n "$loc" ]; then
        rc=0
        sudo env PATH="$PATH" bash -c 'cd "$1" || exit 1; shift; exec "$@"' _ "$root" pnpm inject || rc=$?
    fi

    sudo chown -R "$(id -u):$(id -g)" "$root/dist" 2>/dev/null || true
    return "$rc"
}

# Rótulo curto de um alvo, para o seletor. O nome vem do caminho (o installer
# nao tem a deteccao de flavour que o standalone tem).
label_alvo() { # $1 = resources
    local nome
    case "$1" in
        *discordptb*|*DiscordPTB*)          nome="Discord PTB" ;;
        *discordcanary*|*DiscordCanary*)    nome="Discord Canary" ;;
        *com.discordapp.Discord*|*discord*|*Discord*) nome="Discord" ;;
        *equibop*|*Equibop*)                nome="Equibop" ;;
        *vesktop*|*Vesktop*)                nome="Vesktop" ;;
        *legcord*|*Legcord*)                nome="Legcord" ;;
        *)                                  nome="$(basename "$(dirname "$1")")" ;;
    esac
    printf '%s (%s)' "$nome" "$(dirname "$1")"
}

# parse_selecao <entrada> <total> → imprime os indices escolhidos, um por linha.
# "t"/"todos"/vazio = todos. Aceita "1,3", "2-4" e misturas ("1,3-4"). Invalido
# devolve codigo 1 e nada na saida.
parse_selecao() {
    local entrada="$1" total="$2" tok a b res=""
    case "$entrada" in
        ""|"t"|"T"|"todos"|"Todos"|"TODOS") printf '%s\n' "$(seq_like 1 "$total" | sed 's/ *$//')"; return 0 ;;
    esac
    for tok in $(printf '%s' "$entrada" | tr ',;' '  '); do
        case "$tok" in
            *-*)
                a="${tok%%-*}"; b="${tok#*-}"
                case "$a$b" in *[!0-9]*) return 1 ;; esac
                [ "$a" -ge 1 ] && [ "$b" -le "$total" ] && [ "$a" -le "$b" ] || return 1
                res="$res $(seq_like "$a" "$b")"
                ;;
            *)
                case "$tok" in ''|*[!0-9]*) return 1 ;; esac
                [ "$tok" -ge 1 ] && [ "$tok" -le "$total" ] || return 1
                res="$res $tok"
                ;;
        esac
    done
    res="${res# }"; res="${res% }"
    printf '%s\n' "$res"
}

# escolher_alvos_inject <oficiais> <paralelos> → imprime os alvos escolhidos no
# formato "O|<resources>" (oficial, recebe pnpm inject --location) ou "P|<res>"
# (paralelo, patch direto). Pergunta so quando ha mais de um alvo no total.
# -Yes ou entrada nao-interativa: todos os oficiais (e so ha paralelos quando
# nao existe oficial — comportamento de antes do seletor).
escolher_alvos_inject() {
    local oficiais="$1" paralelos="$2"
    local no np total resp i tipo res linha tentativa
    no=0; np=0
    [ -n "$oficiais" ] && no="$(printf '%s\n' "$oficiais" | grep -c . || true)"
    [ -n "$paralelos" ] && np="$(printf '%s\n' "$paralelos" | grep -c . || true)"
    total=$((no + np))

    if [ "$total" -le 1 ]; then
        [ -n "$oficiais" ] && printf 'O|%s\n' "$oficiais"
        [ -n "$paralelos" ] && printf 'P|%s\n' "$paralelos"
        return 0
    fi

    if [ "$ASSUME_YES" -eq 1 ] || [ ! -t 0 ]; then
        if [ -n "$oficiais" ]; then
            printf 'O|%s\n' "$oficiais"
        else
            printf 'P|%s\n' "$paralelos"
        fi
        return 0
    fi

    # Monta os rotulos na MESMA ordem da saida (oficiais primeiro, depois paralelos).
    set --
    while IFS= read -r linha; do
        [ -n "$linha" ] && set -- "$@" "O|$(label_alvo "$linha")"
    done <<EOF
$oficiais
EOF
    while IFS= read -r linha; do
        [ -n "$linha" ] && set -- "$@" "P|$(label_alvo "$linha")"
    done <<EOF
$paralelos
EOF

    if tui_is_interactive; then
        resp="$(tui_menu_multi "Quais Discords recebem o plugin?" "$@")"
        if [ "$resp" = "0" ]; then
            warn "Cancelado."
            exit 1
        fi
    else
        # Terminal sem espaco para a TUI: lista numerada e entrada textual.
        tentativa=0
        while [ "$tentativa" -lt 3 ]; do
            i=0
            for linha in "$@"; do
                i=$((i+1))
                printf '    [%d] %s\n' "$i" "${linha#*|}" >&2
            done
            printf '  Escolha (ex.: 1,3 · 2-4 · t = todos · Enter = todos): ' >&2
            read -r resp || resp=""
            if resp="$(parse_selecao "$resp" "$total")"; then break; fi
            warn "Escolha invalida."
            tentativa=$((tentativa+1))
        done
        [ "$tentativa" -lt 3 ] || resp="$(seq_like 1 "$total")"
    fi

    # Repercorre na mesma ordem e imprime so os escolhidos, com o prefixo de tipo.
    i=0
    for linha in "$@"; do
        i=$((i+1))
        case " $resp " in
            *" $i "*) printf '%s\n' "$linha" ;;
        esac
    done
}

inject_mod() {
    local root="$1"
    local oficiais paralelos escolhidos tipo alvo loc id falha injetou_oficial

    oficiais="$(discord_installs)"
    paralelos="$(parallel_installs)"

    # Caso comum: o user so tem Equibop/Vesktop/Legcord e nao tem Discord puro.
    # O instalador de mod nao funciona em clientes paralelos (eles ja vem com o
    # mod embutido): patch direto do dist/<cliente>.asar, agora multi-alvo.
    if [ -z "$oficiais" ]; then
        if [ -z "$paralelos" ]; then
            fail "Discord puro nao encontrado, e nenhum cliente paralelo disponivel para patch direto. Instale o Discord (ou use o instalador de plugin goLiveBypass-vencord.zip, que convive com mod)."
        fi
        printf '\n'
        printf '  %s[!]%s Nao encontrei o Discord puro, mas achei clientes paralelos:\n' "$C_YELLOW" "$C_OFF"
        while IFS= read -r p; do
            [ -z "$p" ] && continue
            printf '        - %s\n' "$p"
        done <<EOF
$paralelos
EOF
        if [ "$ASSUME_YES" -ne 1 ] && ! confirm "Injetar em algum dos clientes acima (patch direto, vai pedir sudo)"; then
            fail "Discord puro nao encontrado, e nenhum cliente paralelo disponivel para patch direto. Instale o Discord (ou use o instalador de plugin goLiveBypass-vencord.zip, que convive com mod)."
        fi
        escolhidos="$(escolher_alvos_inject "" "$paralelos")"
        falha=0
        while IFS='|' read -r tipo alvo; do
            [ -z "$alvo" ] && continue
            patch_parallel_one "$root" "$alvo" || falha=1
        done <<EOF
$escolhidos
EOF
        [ "$falha" -eq 0 ] || fail "Patch direto falhou."
        # Marca injecao como OK para o do_install seguir
        return 0
    fi

    # Selecao de alvos: 1 alvo = auto (como antes); varios = nosso seletor
    # (oficiais + paralelos), no lugar da lista do proprio instalador do mod,
    # que so patcheia um e nao conhece clientes paralelos.
    escolhidos="$(escolher_alvos_inject "$oficiais" "$paralelos")"

    stop_discord

    injetou_oficial=0
    falha=0
    while IFS='|' read -r tipo alvo; do
        [ -z "$alvo" ] && continue
        case "$tipo" in
            O)
                if id="$(flatpak_app_id "$alvo")"; then
                    step "Discord instalado por flatpak ($id)"
                fi
                # Fora do HOME a injecao precisa de raiz, e o instalador do mod nao pede
                # sozinho: ele so falha com permissao negada. Perguntar antes vale mais que
                # falhar e mandar tentar de novo.
                if [ ! -w "$alvo" ]; then
                    printf '  %sO Discord esta em %s, fora do seu HOME.%s\n' "$C_DIM" "$alvo" "$C_OFF" >&2
                    confirm "A injecao ai precisa de sudo. Posso rodar com sudo?" \
                        || { warn "Pulei $alvo -- sem sudo nao da para injetar."; continue; }
                    step "Injetando no Discord"
                    loc="$(install_location "$alvo")"
                    run_inject_root "$root" "$loc" || true
                else
                    step "Injetando no Discord (pode pedir sua senha do sudo)"
                    loc="$(install_location "$alvo")"
                    run_inject "$root" "$loc" || true

                    # O instalador do mod tambem cai aqui quando o Discord escolhido estava
                    # fora do HOME, e ai o sudo so aparece como opcao depois.
                    if ! injected_from_checkout "$root" && confirm "Nao pegou. Tentar de novo com sudo?"; then
                        run_inject_root "$root" "$loc" || true
                    fi
                fi
                injetou_oficial=1
                ;;
            P)
                patch_parallel_one "$root" "$alvo" || falha=1
                ;;
        esac
    done <<EOF
$escolhidos
EOF

    # O pnpm inject sai com 0 mesmo quando o instalador do mod falha, entao o codigo de saida
    # nao serve de prova. Conferir se a injecao realmente passou a apontar para este checkout.
    if [ "$injetou_oficial" -eq 1 ]; then
        injected_from_checkout "$root" || fail "A injecao nao pegou. Se o Discord estiver em /usr/share, /opt ou num flatpak, rode: cd $root && sudo pnpm inject"

        # De novo por conta propria, e nao so confiando no instalador do mod: ele so libera o
        # sandbox quando descobre sozinho que aquilo e um flatpak, e o comando e idempotente.
        if id="$(injected_flatpak_id "$root")"; then
            grant_flatpak_access "$id" "$root/dist"
        fi
    fi
    [ "$falha" -eq 0 ] || warn "Algum cliente paralelo nao foi patcheado -- os outros continuam."
}

checkout_mod() {
    # A identidade vem do package.json, nao do nome da pasta: quem baixou o ZIP tem o repo
    # numa pasta chamada Equicord-main, e ai o nome da pasta nao diz nada.
    local root="$1"
    local manifest="$root/package.json"

    if [ -f "$manifest" ]; then
        local name
        name="$(node -e 'try{process.stdout.write(String(require(process.argv[1]).name||""))}catch(e){}' "$manifest" 2>/dev/null || true)"
        case "$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')" in
            *equicord*) echo "Equicord"; return 0 ;;
            *vencord*) echo "Vencord"; return 0 ;;
        esac
    fi

    case "$(basename "$root" | tr '[:upper:]' '[:lower:]')" in
        *vencord*) echo "Vencord" ;;
        *) echo "Equicord" ;;
    esac
}

mod_settings_file() {
    # Mesma regra do proprio mod (src/main/utils/constants.ts):
    #   DATA_DIR = <MOD>_USER_DATA_DIR ?? ~/.config/<Mod>
    local root="$1"
    local mod id
    mod="$(checkout_mod "$root")"

    # Dentro do flatpak o HOME e outro: o ~/.config do mod cai em ~/.var/app/<id>/config. Um
    # settings.json escrito no ~/.config de fora nao seria lido por ninguem, e o plugin abriria
    # desligado depois de o instalador dizer que ativou.
    if id="$(injected_flatpak_id "$root")"; then
        printf '%s\n' "$HOME/.var/app/$id/config/$mod/settings/settings.json"
        return 0
    fi

    local override
    override="$(printf '%s' "$mod" | tr '[:lower:]' '[:upper:]')_USER_DATA_DIR"
    if [ -n "$(eval "printf '%s' "\${$override:-}"")" ]; then
        printf '%s\n' "$(eval "printf '%s' "\${$override}"")/settings/settings.json"
        return 0
    fi

    printf '%s\n' "$HOME/.config/$mod/settings/settings.json"
}

set_plugin_settings() {
    local root="$1"
    local file
    file="$(mod_settings_file "$root")"
    mkdir -p "$(dirname "$file")"

    GLB_FILE="$file" node -e '
        const fs = require("fs");
        const file = process.env.GLB_FILE;

        let settings = {};
        if (fs.existsSync(file)) {
            const raw = fs.readFileSync(file, "utf8");
            if (raw.trim() !== "") {
                try {
                    settings = JSON.parse(raw);
                } catch (error) {
                    // Nunca reescrever por cima de um arquivo ilegivel: isso apagaria todos os
                    // plugins da pessoa.
                    const backup = file + ".bak-" + Date.now();
                    fs.copyFileSync(file, backup);
                    console.error("ilegivel, copia em " + backup);
                    process.exit(2);
                }
            }
        }

        const plugin = settings.plugins && settings.plugins.GoLiveBypass ? settings.plugins.GoLiveBypass : {};
        plugin.enabled = true;
        if (plugin.excludedCountries === undefined) plugin.excludedCountries = "BR";

        settings.plugins = settings.plugins || {};
        settings.plugins.GoLiveBypass = plugin;
        fs.writeFileSync(file, JSON.stringify(settings, null, 4));
    ' && step "Plugin ativado em $file" || warn "Nao mexi no $file. Ative o GoLiveBypass na mao em Configuracoes > Plugins."
}

show_status() {
    local root="${1:-}"
    local count mod plugin extra=""
    # So conta Discord (sem Equibop/Vesktop/Legcord). Os paralelos sao listados
    # em separado abaixo se existirem.
    count="$(discord_installs | wc -l)"
    mod="$(installed_mod || true)"

    if discord_installs | grep -q '/com\.discordapp\.'; then extra=", flatpak"; fi

    printf '  %sDetectado:%s\n' "$C_BOLD" "$C_OFF"
    if [ "$count" -gt 0 ]; then
        printf '  %s  Discord   instalado (%s%s)%s\n' "$C_DIM" "$count" "$extra" "$C_OFF"
    else
        printf '  %s  Discord   nao encontrado%s\n' "$C_YELLOW" "$C_OFF"
    fi
    printf '  %s  Mod       %s%s\n' "$C_DIM" "${mod:-nenhum}" "$C_OFF"

    if [ -n "$root" ]; then
        printf '  %s  Fonte     %s%s\n' "$C_DIM" "$root" "$C_OFF"
        plugin="$root/src/userplugins/$PLUGIN_DIR_NAME"
        if [ -d "$plugin" ]; then
            printf '  %s  Plugin    ja instalado%s\n' "$C_GREEN" "$C_OFF"
        else
            printf '  %s  Plugin    nao instalado%s\n' "$C_DIM" "$C_OFF"
        fi
    else
        printf '  %s  Fonte     nao encontrado%s\n' "$C_DIM" "$C_OFF"
    fi

    # Clientes paralelos (Vesktop/Equibop/Legcord) so para informacao - o instalador
    # de plugin GoLiveBypass (zip de release) serve tambem para eles.
    local parallels
    parallels="$(parallel_installs)"
    if [ -n "$parallels" ]; then
        printf '\n'
        while IFS= read -r p; do
            [ -z "$p" ] && continue
            printf '  %sParalelo   %s%s\n' "$C_DIM" "$p" "$C_OFF"
        done <<EOF
$parallels
EOF
    fi
    printf '\n'
}

select_target() {
    local root="${1:-}"
    if [ -z "$root" ]; then
        install_mod "$(choose_mod)"
        return
    fi

    local name
    name="$(basename "$root")"

    if tui_is_interactive; then
        local tui_choice
        tui_choice="$(tui_menu "Onde instalar?" "Usar o $name que ja esta aqui" "Baixar e usar outro (Equicord ou Vencord)")"
        if [ "$tui_choice" = "2" ]; then
            install_mod "$(choose_mod)"
        else
            printf '%s\n' "$root"
        fi
        return
    fi

    printf '  %sOnde instalar?%s\n\n' "$C_BOLD" "$C_OFF" >&2
    printf '    %s[1] Usar o %s que ja esta aqui%s\n' "$C_GREEN" "$name" "$C_OFF" >&2
    printf '  %s      %s%s\n' "$C_DIM" "$root" "$C_OFF" >&2
    printf '    %s[2] Baixar e usar outro (Equicord ou Vencord)%s\n\n' "$C_CYAN" "$C_OFF" >&2

    local choice
    printf '%s' "  Escolha: " >&2
    read -r choice
    if [ "$choice" = "2" ]; then
        install_mod "$(choose_mod)"
    else
        printf '%s\n' "$root"
    fi
}

select_persistence() {
    if tui_is_interactive; then
        local tui_choice
        tui_choice="$(tui_menu "Como voce quer deixar o Discord?" \
            "Permanente (abre com o mod toda vez)" \
            "Temporario (desfaz quando voce fechar o Discord)")"
        [ "$tui_choice" = "2" ] && return 1
        return 0
    fi

    printf '\n  %sComo voce quer deixar o Discord?%s\n\n' "$C_BOLD" "$C_OFF" >&2
    printf '    %s[1] Permanente%s\n' "$C_GREEN" "$C_OFF" >&2
    printf '  %s      O Discord abre com o mod toda vez, ate voce remover.%s\n' "$C_DIM" "$C_OFF" >&2
    printf '    %s[2] Temporario%s\n' "$C_YELLOW" "$C_OFF" >&2
    printf '  %s      Vale so nesta sessao. Ao fechar o Discord a injecao e desfeita.%s\n\n' "$C_DIM" "$C_OFF" >&2

    local choice
    printf '%s' "  Escolha: " >&2
    read -r choice
    [ "$choice" = "2" ] && return 1
    return 0
}

start_discord() {
    local root="${1:-}" exe id

    # Quem tem o flatpak e um Discord nativo pela metade acabaria com o nativo aberto, sem o
    # mod, e concluiria que a instalacao falhou. Abrir o mesmo que foi injetado resolve.
    if id="$(injected_flatpak_id "$root")" && have flatpak; then
        nohup flatpak run "$id" >/dev/null 2>&1 &
        return 0
    fi

    for exe in discord Discord discord-canary; do
        if have "$exe"; then
            nohup "$exe" >/dev/null 2>&1 &
            return 0
        fi
    done
}

wait_discord_exit() {
    local root="$1"
    printf '\n'
    ok "Discord aberto com o GoLiveBypass."
    warn "Deixe este terminal aberto. Quando voce fechar o Discord, eu desfaco a injecao."

    sleep 5
    while discord_running; do sleep 2; done

    printf '\n'
    step "Discord fechado, desfazendo a injecao"
    if (cd "$root" && pnpm uninject); then
        ok "Discord restaurado."
    else
        warn "O pnpm uninject falhou. Rode 'pnpm uninject' na pasta do mod."
    fi
}


# -----------------------------------------------------------------------------
# Auto-update via GitHub Releases
#
# Compara a versao do plugin instalado (lida de goLiveBypass/manifest.json no
# checkout do Vencord/Equicord) com a tag da release mais recente do GitHub.
# A tag e' semver (v1.1.8), o manifest tem "version": "1.1.8" (sem o v).
#
# O instalador ja baixa o plugin do GitHub em repo_file(); aqui acrescentamos:
#   1. consulta de release (api.github.com) - para saber se ha versao nova
#   2. validacao de SHA-256 do zip - se baixarmos um zip (modo --update)
#   3. backup + rollback - restaura versao anterior se a nova quebrar
# -----------------------------------------------------------------------------

GITHUB_REPO="bezumiya/GoLiveBypass"
# API publica do GitHub: 60 req/h por IP, ok para uso interativo. User-Agent
# obrigatorio pela RFC 7231; sem ele o GitHub responde 403.
GITHUB_API="https://api.github.com/repos/$GITHUB_REPO"
GITHUB_UA="GoLiveBypass-Installer"

# Parseia a tag da release mais recente e devolve o numero de versao (sem "v")
# e o asset zip do userplugin. Falha silenciosa (RC=1, stdout vazio) quando:
#   - sem rede
#   - rate limit
#   - release sem o asset esperado
github_latest_release() {
    local json version tag zip_browser=""
    if have curl; then
        json=$(curl -fsSL -H "User-Agent: $GITHUB_UA" -H "Accept: application/vnd.github+json" "$GITHUB_API/releases/latest" 2>/dev/null) || return 1
    elif have wget; then
        json=$(wget -qO- --header="User-Agent: $GITHUB_UA" --header="Accept: application/vnd.github+json" "$GITHUB_API/releases/latest" 2>/dev/null) || return 1
    else
        return 1
    fi

    # tag_name vem como "v1.1.8"; o manifest usa "1.1.8"
    tag=$(printf '%s' "$json" | grep -oE '"tag_name"[[:space:]]*:[[:space:]]*"v?[0-9][^"]*"' | head -1 | sed 's/.*"v\?\([0-9][^"]*\)".*/\1/')
    [ -n "$tag" ] || return 1

    # Procura o asset do userplugin (zip). Se nao tiver nesta release, saida limpa
    # para o instalador dizer "release existe, mas sem o asset do userplugin".
    zip_browser=$(printf '%s' "$json" | grep -oE '"browser_download_url"[[:space:]]*:[[:space:]]*"[^"]*goLiveBypass-vencord[^"]*\.zip"' | head -1 | sed 's/.*"\(http[^"]*\)".*/\1/')

    # O printf para stdout: tag e url separados por \n, sem ruido.
    printf '%s\n%s\n' "$tag" "$zip_browser"
    return 0
}

# URL do zip do userplugin na release que serve a INSTALACAO: a mais recente publicada que
# tenha o asset, prerelease incluida. A consulta nao pode ser /releases/latest (que esconde
# prerelease, e a linha atual do plugin e beta) nem "primeiro tag_name da listagem" (um
# rascunho sem asset desalinharia tag e zip). A API devolve as releases da mais nova para a
# mais antiga e nao lista rascunhos para quem nao tem acesso de escrita, entao o primeiro
# asset do userplugin da lista e o da release mais nova que realmente tem o pacote — e a tag
# sai da propria URL dele.
github_plugin_release() {
    local json zip_browser
    if have curl; then
        json=$(curl -fsSL -H "User-Agent: $GITHUB_UA" -H "Accept: application/vnd.github+json" "$GITHUB_API/releases?per_page=30" 2>/dev/null) || return 1
    elif have wget; then
        json=$(wget -qO- --header="User-Agent: $GITHUB_UA" --header="Accept: application/vnd.github+json" "$GITHUB_API/releases?per_page=30" 2>/dev/null) || return 1
    else
        return 1
    fi

    zip_browser=$(printf '%s' "$json" | grep -oE '"browser_download_url"[[:space:]]*:[[:space:]]*"[^"]*goLiveBypass-vencord[^"]*\.zip"' | head -1 | sed 's/.*"\(http[^"]*\)".*/\1/')
    [ -n "$zip_browser" ] || return 1

    printf '%s\n' "$zip_browser"
    return 0
}

# Le a versao do manifest.json que esta dentro de $1 (pasta do plugin
# ja copiado para o checkout). Devolve string vazia se nao existir.
installed_plugin_version() {
    local target="$1/manifest.json"
    [ -f "$target" ] || return 0
    grep -oE '"version"[[:space:]]*:[[:space:]]*"[0-9][^"]*"' "$target" 2>/dev/null | head -1 | sed 's/.*"\([0-9][^"]*\)".*/\1/'
}

# Compara duas versoes semver. Saida:
#   -1 se installed < latest  (precisa atualizar)
#    0 se installed = latest
#   +1 se installed > latest  (downgrade - nao atualizar)
# Usa sort -V (GNU coreutils; presente em todas as distros testadas).
# Em caso de formato malformado, devolve -1 (assume desatualizado).
compare_version() {
    local installed="$1" latest="$2"
    # A API/manifest normalmente ja entregam sem o prefixo, mas arquivos
    # antigos e testes locais podem conservar o "v" da tag. Normalizar antes
    # da igualdade e do sort evita update fantasma e downgrade invertido.
    case "$installed" in [vV]*) installed=${installed#?} ;; esac
    case "$latest" in [vV]*) latest=${latest#?} ;; esac
    # Sem informacao do GitHub: considera "sem atualizacao" (0). Sem isso, a
    # falta de rede (que zera latest) mostraria "atualizacao disponivel".
    [ -n "$latest" ] || { echo "0"; return; }
    # Sem versao local conhecida: assume que vale a pena conferir o que tem.
    [ -n "$installed" ] || { echo "-1"; return; }
    [ "$installed" = "$latest" ] && { echo "0"; return; }

    local installed_core="${installed%%-*}" installed_pre="" latest_core="${latest%%-*}" latest_pre=""
    case "$installed" in *-*) installed_pre="${installed#*-}" ;; esac
    case "$latest" in *-*) latest_pre="${latest#*-}" ;; esac

    if [ "$installed_core" != "$latest_core" ]; then
        local lowest
        lowest=$(printf '%s
%s
' "$installed_core" "$latest_core" | sort -V | head -1)
        if [ "$lowest" = "$latest_core" ]; then
            echo "1"   # installed > latest
        else
            echo "-1"  # installed < latest
        fi
        return
    fi

    # Mesma versao base: um sufixo de pre-release (-beta.N) sempre conta como
    # mais antigo que a mesma base sem sufixo, nunca como um componente extra
    # (sort -V sozinho, sem separar o sufixo, tratava beta.N como mais novo).
    if [ -n "$installed_pre" ] && [ -z "$latest_pre" ]; then echo "-1"; return; fi
    if [ -z "$installed_pre" ] && [ -n "$latest_pre" ]; then echo "1"; return; fi
    if [ -n "$installed_pre" ] && [ -n "$latest_pre" ]; then
        local lowest_pre
        lowest_pre=$(printf '%s
%s
' "$installed_pre" "$latest_pre" | sort -V | head -1)
        if [ "$lowest_pre" = "$latest_pre" ]; then
            echo "1"
        else
            echo "-1"
        fi
        return
    fi
    echo "0"
}

# Faz backup do plugin atual antes de sobrescrever. Mantem so os 3 mais recentes
# para nao crescer sem limite.
backup_plugin() {
    local root="$1"
    local target="$root/src/userplugins/$PLUGIN_DIR_NAME"
    local backup_dir="$root/src/userplugins/.${PLUGIN_DIR_NAME}.bak"
    [ -d "$target" ] || return 0

    local stamp
    stamp=$(date +%Y%m%d%H%M%S 2>/dev/null || echo "000000000000")
    mkdir -p "$backup_dir"
    cp -R "$target" "$backup_dir/$stamp" 2>/dev/null || return 1

    # Mantem so os 3 mais recentes. POSIX nao tem "ls -t | head -3" garantido,
    # entao ordenamos por nome (que tem timestamp no formato YYYYMMDDHHMMSS).
    local count
    count=$(ls -1 "$backup_dir" 2>/dev/null | wc -l | tr -d ' ')
    if [ "$count" -gt 3 ]; then
        ls -1 "$backup_dir" 2>/dev/null | head -n $((count - 3)) | while read -r old; do
            rm -rf "$backup_dir/$old" 2>/dev/null || true
        done
    fi
    return 0
}

# --check-update: imprime o status e sai. NUNCA baixa nada. Usado por
# integracoes externas (GUI, cron) e pelo proprio instalador.
do_check_update() {
    local installed root latest_release latest_tag latest_zip cmp

    root="$(find_checkout 2>/dev/null || true)"
    if [ -z "$root" ]; then
        # Sem checkout descoberto: nao conseguimos saber o que esta instalado.
        printf 'plugin: %snao encontrado%s (rode uma vez para instalar)\n' "$C_YELLOW" "$C_OFF"
        return 0
    fi

    installed=$(installed_plugin_version "$root")
    if [ -z "$installed" ]; then
        # Plugin copiado sem manifest.json - instalacao muito antiga.
        printf 'plugin: %sinstalado (versao desconhecida)%s\n' "$C_YELLOW" "$C_OFF"
    else
        printf 'plugin: instalado (%sv%s%s)\n' "$C_DIM" "$installed" "$C_OFF"
    fi

    if ! latest_release=$(github_latest_release 2>/dev/null); then
        # Sem rede, rate limit, etc. Nao falhamos o comando: o usuario tem info local.
        printf 'remote: %snao consegui consultar (rede ou rate limit)%s\n' "$C_DIM" "$C_OFF"
        return 0
    fi

    latest_tag=$(printf '%s' "$latest_release" | head -1)
    latest_zip=$(printf '%s' "$latest_release" | tail -n +2 | head -1)

    if [ -z "$installed" ]; then
        # Nao sabemos o que esta instalado: dizemos que ha update e deixamos o
        # usuario decidir.
        printf 'remote: %sv%s%s disponivel\n' "$C_DIM" "$latest_tag" "$C_OFF"
        printf 'resultado: %sversao local desconhecida - rode --update para alinhar%s\n' "$C_YELLOW" "$C_OFF"
        return 0
    fi

    cmp=$(compare_version "$installed" "$latest_tag")
    case "$cmp" in
        0)  printf 'remote: %sv%s%s\n' "$C_DIM" "$latest_tag" "$C_OFF"
            printf 'resultado: %svoce esta na versao mais recente%s\n' "$C_GREEN" "$C_OFF" ;;
        1)  printf 'remote: %sv%s%s\n' "$C_DIM" "$latest_tag" "$C_OFF"
            printf 'resultado: %sversao local mais nova que a release (fork?)%s\n' "$C_DIM" "$C_OFF" ;;
        -1) printf 'remote: %sv%s%s disponivel\n' "$C_DIM" "$latest_tag" "$C_OFF"
            printf 'resultado: %shá versao nova - rode sem --check-update para atualizar%s\n' "$C_YELLOW" "$C_OFF" ;;
    esac
    return 0
}

# --update: faz o trabalho. Reusa do_update_from_zip (o mesmo caminho da instalacao a partir
# da release), mas primeiro roda o backup e a validacao de SHA-256 quando baixar de um zip.
do_update() {
    local installed root latest_release latest_tag latest_zip cmp

    root="$(find_checkout 2>/dev/null || true)"
    if [ -z "$root" ]; then
        fail "Nao achei o checkout do mod. Rode o instalador uma vez (sem --update) para descobrir."
    fi

    installed=$(installed_plugin_version "$root")
    if ! latest_release=$(github_latest_release 2>/dev/null); then
        fail "Nao consegui consultar a release mais recente (rede ou rate limit do GitHub)."
    fi
    latest_tag=$(printf '%s' "$latest_release" | head -1)
    latest_zip=$(printf '%s' "$latest_release" | tail -n +2 | head -1)

    if [ -n "$installed" ]; then
        cmp=$(compare_version "$installed" "$latest_tag")
        if [ "$cmp" = "0" ]; then
            ok "Voce ja esta na v$latest_tag (a mais recente)."
            return 0
        fi
        if [ "$cmp" = "1" ]; then
            warn "Versao local (v$installed) e mais nova que a release (v$latest_tag)."
            if [ "$ASSUME_YES" -eq 0 ] && tui_is_interactive; then
                local ans
                ans=$(tui_confirm "Atualizar mesmo assim? (downgrade)" "N")
                [ "$ans" = "Y" ] || { warn "Atualizacao cancelada."; return 0; }
            fi
        fi
    fi

    step "Fazendo backup do plugin atual"
    backup_plugin "$root" || warn "Backup nao foi possivel, mas sigo adiante."

    # Caminho 1: ha zip do userplugin. Baixa, valida SHA-256, extrai.
    if [ -n "$latest_zip" ]; then
        do_update_from_zip "$root" "$latest_zip" "$latest_tag"
    else
        # Caminho 2 (fallback): a release nao tem o asset do userplugin
        # (versao muito antiga, ou alguem publicou a tag na mao). Usa o REPO_RAW
        # como antes, que sempre funciona.
        warn "Release v$latest_tag nao tem o zip do userplugin. Caindo no download via REPO_RAW."
        copy_plugin_from_repo "$root"
    fi

    # Recompila e re-injeta para a nova versao pegar
    ensure_toolchain 0
    build_mod "$root"
    if ! injected_from_checkout "$root"; then
        inject_mod "$root"
    fi

    printf '\n'
    ok "Atualizado para v$latest_tag. Reinicie o Discord para carregar a nova versao."
}

# Baixa o zip do userplugin, valida SHA-256, extrai por cima do plugin atual.
do_update_from_zip() {
    local root="$1" zip_url="$2" expected_version="$3"
    local tmpdir zipfile sha_actual sha_expected

    step "Baixando $zip_url"
    tmpdir=$(mktemp -d 2>/dev/null) || fail "Nao consegui criar pasta temporaria."
    zipfile="$tmpdir/plugin.zip"

    if have curl; then
        curl -fsSL -o "$zipfile" "$zip_url" || fail "Download do zip falhou."
    elif have wget; then
        wget -qO "$zipfile" "$zip_url" || fail "Download do zip falhou."
    else
        fail "Preciso de curl ou wget para baixar."
    fi

    # Conferir SHA-256 contra o asset companion (.sha256). Se o .sha256 nao
    # existir (release muito antiga), falhamos fechado: executar codigo sem
    # conferir hash e o pior jeito de acabar.
    step "Validando SHA-256"
    sha_expected=$(download_text "${zip_url}.sha256" 2>/dev/null | awk '{print $1}' | head -1)
    if [ -z "$sha_expected" ]; then
        rm -rf "$tmpdir"
        fail "Release sem arquivo .sha256 (asset companion). Sem hash, sem update."
    fi
    sha_actual=$(sha256sum "$zipfile" 2>/dev/null | awk '{print $1}')
    if [ "$sha_actual" != "$sha_expected" ]; then
        rm -rf "$tmpdir"
        fail "SHA-256 nao confere: esperado $sha_expected, obtido $sha_actual."
    fi
    ok "SHA-256 confere"

    step "Extraindo o plugin em $root/src/userplugins/$PLUGIN_DIR_NAME"
    local target="$root/src/userplugins/$PLUGIN_DIR_NAME"
    rm -rf "$target"
    mkdir -p "$target"

    # unzip -o sobrescreve sem perguntar; -q silencia output
    if have unzip; then
        unzip -oq "$zipfile" -d "$tmpdir/extract" || { rm -rf "$tmpdir"; fail "Extracao falhou."; }
        # O zip contem uma pasta raiz chamada goLiveBypass/; movemos o conteudo
        local extracted
        extracted=$(find "$tmpdir/extract" -mindepth 1 -maxdepth 1 -type d | head -1)
        if [ -z "$extracted" ]; then
            rm -rf "$tmpdir"
            fail "Zip nao tem a pasta esperada (goLiveBypass/)."
        fi
        # Copia o conteudo, nao a pasta em si
        cp -R "$extracted"/. "$target"/ || { rm -rf "$tmpdir"; fail "Copia falhou."; }
    else
        # Sem unzip, fallback usando tar (que em geral tambem extrai zip)
        if tar -xf "$zipfile" -C "$tmpdir/extract" 2>/dev/null; then
            local extracted
            extracted=$(find "$tmpdir/extract" -mindepth 1 -maxdepth 1 -type d | head -1)
            [ -n "$extracted" ] || { rm -rf "$tmpdir"; fail "Zip malformado."; }
            cp -R "$extracted"/. "$target"/ || { rm -rf "$tmpdir"; fail "Copia falhou."; }
        else
            rm -rf "$tmpdir"
            fail "Preciso de unzip ou tar para extrair (nem um estao disponiveis)."
        fi
    fi

    rm -rf "$tmpdir"
    ok "Plugin extraido"
}

# Baixa texto via curl ou wget. Usado para o arquivo .sha256.
download_text() {
    if have curl; then
        curl -fsSL "$1" 2>/dev/null
    elif have wget; then
        wget -qO- "$1" 2>/dev/null
    fi
}

do_install() {
    local root="${1:-}"
    root="$(select_target "$root")"

    # select_persistence responde 0 para permanente e 1 para temporario. Guardamos na forma
    # positiva: a variavel invertida ("permanent=1 quando temporario") funciona por dupla
    # negacao, mas e exatamente a armadilha que deixou o temporario preso no instalador
    # PowerShell, onde a leitura do estado se perdeu e ninguem notou.
    local permanente=0
    if select_persistence; then permanente=1; fi

    ensure_toolchain 0
    install_plugin_source "$root"
    build_mod "$root"

    local flatpak_id=""
    if injected_from_checkout "$root"; then
        step "O Discord ja carrega deste checkout, so reiniciando"
        stop_discord
        # Por aqui o instalador do mod nao roda, e a liberacao do sandbox nao acontece
        # sozinha. Se ela tiver caido num `flatpak update`, o Discord abriria com erro.
        if flatpak_id="$(injected_flatpak_id "$root")"; then
            grant_flatpak_access "$flatpak_id" "$root/dist"
        fi
    else
        inject_mod "$root"
        flatpak_id="$(injected_flatpak_id "$root" || true)"
    fi

    # Com o Discord fechado: aberto, ele regrava o settings.json a partir da memoria e
    # apaga o que escrevemos aqui.
    set_plugin_settings "$root"

    start_discord "$root"

    printf '\n'
    ok "Pronto. O plugin ja vem ativado, nao precisa mexer em nada."
    printf '  %sNa primeira ativacao o plugin pede a conta Proton, dentro do Discord.%s\n' "$C_DIM" "$C_OFF"
    printf '  %sEntre numa call e use Go Live ou a camera.%s\n' "$C_DIM" "$C_OFF"

    # O deploy do flatpak e refeito do zero a cada atualizacao, e a injecao mora dentro dele.
    # Nao da para impedir isso de fora, entao o que resta e avisar antes de acontecer.
    if [ -n "$flatpak_id" ]; then
        case "$(injected_resources "$root")" in
            */flatpak/app/*)
                printf '\n'
                warn "Este Discord e flatpak: um 'flatpak update' desfaz a injecao."
                printf '  %sQuando isso acontecer, rode este instalador de novo.%s\n' "$C_DIM" "$C_OFF"
                ;;
        esac
    fi

    # Modo temporario: desfaz quando o Discord fechar, como o proprio menu promete.
    if [ "$permanente" -eq 0 ]; then
        wait_discord_exit "$root"
    fi
    return 0
}

do_uninstall() {
    local root target
    root="$(find_checkout)" || fail "Nao encontrei o checkout do Equicord/Vencord. Use --source."
    target="$root/src/userplugins/$PLUGIN_DIR_NAME"

    if [ -d "$target" ]; then
        step "Removendo $target"
        rm -rf "$target"
    else
        warn "O plugin nao estava instalado nesse checkout."
    fi

    build_mod "$root"
    stop_discord
    remove_tor
    start_discord "$root"

    printf '\n'
    ok "Plugin removido. Seu Equicord/Vencord continua funcionando."
}

do_restore_everything() {
    local root target
    if root="$(find_checkout)"; then
        target="$root/src/userplugins/$PLUGIN_DIR_NAME"
        [ -d "$target" ] && { step "Removendo $target"; rm -rf "$target"; }

        stop_discord
        step "Desfazendo a injecao"
        (cd "$root" && pnpm uninject) || warn "O pnpm uninject falhou."
    else
        warn "Nao achei o fonte do mod, entao so posso parar por aqui."
    fi

    remove_tor
    printf '\n'
    ok "Tudo restaurado. Seu Discord voltou ao normal."
}

main_menu() {
    local root
    root="$(find_checkout || true)"
    show_status "$root"

    if tui_is_interactive; then
        local tui_choice
        tui_choice="$(tui_menu "O que voce quer fazer?" \
            "Instalar o GoLiveBypass" \
            "Verificar atualizacoes do plugin" \
            "Atualizar o plugin" \
            "Remover so o plugin (o mod continua)" \
            "Restaurar tudo (remove o plugin e desfaz a injecao)" \
            "Sair")"
        case "$tui_choice" in
            1) do_install "$root" ;;
            2) do_check_update ;;
            3) do_update ;;
            4) do_uninstall ;;
            5) do_restore_everything ;;
            *) printf '  %sAte mais.%s\n' "$C_DIM" "$C_OFF" ;;
        esac
        return
    fi

    printf '  %sO que voce quer fazer?%s\n\n' "$C_BOLD" "$C_OFF"
    printf '    %s[1] Instalar o GoLiveBypass%s\n' "$C_GREEN" "$C_OFF"
    printf '    %s[2] Verificar atualizacoes do plugin%s\n' "$C_CYAN" "$C_OFF"
    printf '    %s[3] Atualizar o plugin%s\n' "$C_GREEN" "$C_OFF"
    printf '    %s[4] Remover so o plugin (o mod continua)%s\n' "$C_YELLOW" "$C_OFF"
    printf '    %s[5] Restaurar tudo (remove o plugin e desfaz a injecao)%s\n' "$C_RED" "$C_OFF"
    printf '    [0] Sair\n\n'

    local choice
    printf '%s' "  Escolha: " >&2
    read -r choice
    case "$choice" in
        1) do_install "$root" ;;
        2) do_check_update ;;
        3) do_update ;;
        4) do_uninstall ;;
        5) do_restore_everything ;;
        *) printf '  %sAte mais.%s\n' "$C_DIM" "$C_OFF" ;;
    esac
}

banner
case "$MODE" in
    install) do_install "$(find_checkout || true)" ;;
    uninstall) do_uninstall ;;
    restore) do_restore_everything ;;
    check-update) do_check_update ;;
    update) do_update ;;
    *) main_menu ;;
esac
printf '\n'
