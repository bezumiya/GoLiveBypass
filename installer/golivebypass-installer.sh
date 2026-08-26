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
#
# Obrigado ao Vithor (https://github.com/Vith0r), que escreveu o primeiro instalador do
# GoLiveBypass e abriu o caminho para este aqui.

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
PLUGIN_FILES="goLiveBypass/index.tsx goLiveBypass/native.ts"
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
fail() {
    printf '\n  %s[X] %s%s\n\n' "$C_RED" "$1" "$C_OFF" >&2
    if [ "${REPORT_NO_AUTO:-0}" -eq 0 ]; then
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
    # pega a ultima mensagem de erro visivel (passthrough) + cauda de logs
    if [ -f "$INSTALL_DIR/golivebypass.log" ]; then
        desc="$(tail -n 40 "$INSTALL_DIR/golivebypass.log" 2>/dev/null || true)"
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

# tui_input <label> <value_inicial> → imprime o valor digitado (ou o inicial se Enter vazio).
tui_input() {
    local label="$1" value="${2:-}"
    printf '%s%s  %s%s: %s%s' "$TUI_BG" "$TUI_FG" "$label" "$TUI_ACCENT" "$value" >&2
    tui_show_cursor
    IFS= read -r value
    tui_hide_cursor
    printf '%s\n' "$value"
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

# O endereco da proxy pode carregar usuario e senha, e ele e mostrado na tela. A senha some.
hide_proxy_secret() {
    printf '%s\n' "$1" | sed -E 's#^([a-z0-9]+)://([^:@/]+)(:[^@/]*)?@#\1://\2:***@#'
    return 0
}

# ----------------------------------------------------------------------------- Tor embutido
# Mesmo bundle 13.5 e mesmos hashes da GUI (golive-gui/electron/main.ts), na porta dedicada
# 9060. A rotina e idempotente: se um Tor ja atende (nosso, da GUI, do sistema), reusa.

TOR_BUNDLE_VERSION="13.5"
TOR_PORT="9060"
TOR_BASE="${XDG_DATA_HOME:-$HOME/.local/share}/GoLiveBypass/Tor"
TOR_EXE="$TOR_BASE/tor/tor"
TOR_TORRC="$TOR_BASE/torrc"
TOR_TARBALL="tor-expert-bundle-linux-x86_64-$TOR_BUNDLE_VERSION.tar.gz"
TOR_URL="https://archive.torproject.org/tor-package-archive/torbrowser/$TOR_BUNDLE_VERSION/$TOR_TARBALL"
TOR_SHA256="147158f33c5f2c539d58d8fab69ca5af384778e7bbae951fbc7ac8ca58ac4e0d"
TOR_SERVICE="golivebypass-tor.service"

tor_base() { printf '%s\n' "$TOR_BASE"; }

tor_ready() {
    # Probe barato: quem aceita TCP na 9060 e um SOCKS de Tor (nosso, da GUI ou do sistema).
    if have bash && bash -c "exec 3<>/dev/tcp/127.0.0.1/$TOR_PORT" 2>/dev/null; then
        return 0
    fi
    return 1
}

tor_daemon_running() {
    tor_ready && return 0
    [ -x "$TOR_EXE" ] || return 1
    return 1
}

# Baixa o bundle e deixa o binario pronto, se ainda nao existir. Nao sobe nada.
ensure_tor_bundle() {
    [ -x "$TOR_EXE" ] && return 0

    step "Baixando o Tor (tor-expert-bundle $TOR_BUNDLE_VERSION, ~30 MB)"
    tmp="$(mktemp -d 2>/dev/null || printf '%s' "${TMPDIR:-/tmp}/glb-tor.$$")"
    trap 'rm -rf "$tmp"' EXIT

    if have curl; then
        curl -fsSL "$TOR_URL" -o "$tmp/$TOR_TARBALL" || {
            warn "Falha ao baixar o Tor. Verifique sua conexao."
            return 1
        }
    elif have wget; then
        wget -qO- "$TOR_URL" >"$tmp/$TOR_TARBALL" || {
            warn "Falha ao baixar o Tor. Verifique sua conexao."
            return 1
        }
    else
        warn "Preciso de curl ou wget para baixar o Tor."
        return 1
    fi

    step "Conferindo SHA-256"
    local obtido
    obtido="$(sha256sum "$tmp/$TOR_TARBALL" 2>/dev/null | cut -d' ' -f1)"
    if [ "$obtido" != "$TOR_SHA256" ]; then
        warn "O download do Tor veio corrompido (SHA-256 $obtido). Abortando."
        return 1
    fi

    step "Extraindo o Tor"
    mkdir -p "$TOR_BASE"
    tar -xzf "$tmp/$TOR_TARBALL" -C "$TOR_BASE" --exclude 'tor/pluggable_transports/*' --exclude 'debug/*' || {
        warn "Falha ao extrair o bundle do Tor."
        return 1
    }
    chmod +x "$TOR_EXE" 2>/dev/null || true
    return 0
}

# Garante o Tor de pe na 9060. Devolve 0 se estiver pronto (ja rodando ou acabou de subir).
ensure_tor() {
    tor_ready && { step "Tor ja atendendo em 127.0.0.1:$TOR_PORT"; return 0; }

    # Tor do sistema ja rodando na porta dele? Reusar evita baixar 30 MB.
    if have tor && tor_ready; then
        step "Tor do sistema em uso"
        return 0
    fi

    have tor && step "Tor do sistema encontrado; verifica se o daemon esta de pe (porta $TOR_PORT)"

    ensure_tor_bundle || return 1

    mkdir -p "$TOR_BASE/data-state"
    cat >"$TOR_TORRC" <<EOF
SocksPort $TOR_PORT
DataDirectory $TOR_BASE/data-state
$( [ -f "$TOR_BASE/tor/data/geoip" ] && printf 'GeoIPFile %s\n' "$TOR_BASE/tor/data/geoip" )
$( [ -f "$TOR_BASE/tor/data/geoip6" ] && printf 'GeoIPv6File %s\n' "$TOR_BASE/tor/data/geoip6" )
Log notice stdout
EOF

    # systemd user (padrao); com sudo sem systemd user, unit system com User=<SUDO_USER>;
    # ultimo recurso (sem systemd): nohup com aviso de que nao sobrevive ao boot.
    if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
        step "Registrando o Tor como servico do usuario (systemd user)"
        mkdir -p "$HOME/.config/systemd/user"
        cat >"$HOME/.config/systemd/user/$TOR_SERVICE" <<EOF
[Unit]
Description=GoLiveBypass Tor (SOCKS 127.0.0.1:$TOR_PORT)
After=network.target

[Service]
ExecStart=$TOR_EXE -f $TOR_TORRC
Restart=on-failure

[Install]
WantedBy=default.target
EOF
        systemctl --user daemon-reload
        systemctl --user enable --now "$TOR_SERVICE" 2>/dev/null || {
            warn "Nao consegui ativar o servico do usuario. Tentando nohup."
            nohup "$TOR_EXE" -f "$TOR_TORRC" >"$TOR_BASE/tor.log" 2>&1 &
        }
    elif command -v systemctl >/dev/null 2>&1; then
        # Estamos com sudo (a injecao do plugin pode pedir) e nao ha systemd user. A unit
        # system sobe com o User do dono real, senao o Tor guardaria o estado em /root.
        local real_user="${SUDO_USER:-$USER}"
        step "Registrando o Tor como servico do sistema (via sudo)"
        sudo tee "/etc/systemd/system/$TOR_SERVICE" >/dev/null <<EOF
[Unit]
Description=GoLiveBypass Tor (SOCKS 127.0.0.1:$TOR_PORT)
After=network.target

[Service]
User=$real_user
ExecStart=$TOR_EXE -f $TOR_TORRC
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF
        sudo systemctl daemon-reload
        sudo systemctl enable --now "$TOR_SERVICE" 2>/dev/null || {
            warn "Nao consegui ativar o servico do sistema. Tentando nohup."
            nohup "$TOR_EXE" -f "$TOR_TORRC" >"$TOR_BASE/tor.log" 2>&1 &
        }
    else
        step "systemd nao encontrado; rodando o Tor em background (nao sobrevive ao boot)"
        nohup "$TOR_EXE" -f "$TOR_TORRC" >"$TOR_BASE/tor.log" 2>&1 &
    fi

    step "Esperando o Tor subir"
    local i
    for i in $(seq 1 30); do
        tor_ready && break
        sleep 1
    done

    if tor_ready; then
        step "Tor atendendo em 127.0.0.1:$TOR_PORT"
        return 0
    fi

    warn "O Tor nao subiu em 30s. Veja o log em $TOR_BASE/tor.log"
    return 1
}

remove_tor() {
    # Desinstala o que este instalador criou. Nao apaga o binario (a GUI usa o mesmo).
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
        "$HOME/.local/share/vesktop" "$HOME/.local/share/equibop" "$HOME/.local/share/legcord"
    do
        [ -d "$raiz" ] || continue
        for sub in "$raiz/resources" "$raiz"; do
            if [ -e "$sub/app.asar" ] || [ -e "$sub/_app.asar" ]; then
                printf '%s\n' "$sub"
                break
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

    return 0
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

copy_plugin() {
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

inject_mod() {
    local root="$1"
    local alvo="" loc="" id="" n

    # So o ultimo elemento importa (achar o unico Discord): contar com wc e pegar a ultima
    # linha economiza o array, que nao existe no sh.
    n="$(discord_resources | wc -l)"
    if [ "$n" -eq 1 ]; then
        alvo="$(discord_resources | tail -1)"
        loc="$(install_location "$alvo")"
    fi

    if [ -n "$alvo" ] && id="$(flatpak_app_id "$alvo")"; then
        step "Discord instalado por flatpak ($id)"
    fi

    stop_discord

    # Fora do HOME a injecao precisa de raiz, e o instalador do mod nao pede sozinho: ele so
    # falha com permissao negada. Perguntar antes vale mais que falhar e mandar tentar de novo.
    if [ -n "$alvo" ] && [ ! -w "$alvo" ]; then
        printf '  %sO Discord esta em %s, fora do seu HOME.%s\n' "$C_DIM" "$alvo" "$C_OFF" >&2
        confirm "A injecao ai precisa de sudo. Posso rodar com sudo?" \
            || fail "Sem sudo nao da para injetar nesse Discord. Rode: cd $root && sudo pnpm inject"
        step "Injetando no Discord"
        run_inject_root "$root" "$loc" || true
    else
        step "Injetando no Discord (pode pedir sua senha do sudo)"
        run_inject "$root" "$loc" || true

        # O instalador do mod tambem cai aqui quando o Discord escolhido na lista dele estava
        # fora do HOME, e ai o sudo so aparece como opcao depois.
        if ! injected_from_checkout "$root" && confirm "Nao pegou. Tentar de novo com sudo?"; then
            run_inject_root "$root" "$loc" || true
        fi
    fi

    # O pnpm inject sai com 0 mesmo quando o instalador do mod falha, entao o codigo de saida
    # nao serve de prova. Conferir se a injecao realmente passou a apontar para este checkout.
    injected_from_checkout "$root" || fail "A injecao nao pegou. Se o Discord estiver em /usr/share, /opt ou num flatpak, rode: cd $root && sudo pnpm inject"

    # De novo por conta propria, e nao so confiando no instalador do mod: ele so libera o
    # sandbox quando descobre sozinho que aquilo e um flatpak, e o comando e idempotente.
    if id="$(injected_flatpak_id "$root")"; then
        grant_flatpak_access "$id" "$root/dist"
    fi
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
    local proxy="$2"
    local file
    file="$(mod_settings_file "$root")"
    mkdir -p "$(dirname "$file")"

    GLB_FILE="$file" GLB_PROXY="$proxy" node -e '
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
        plugin.proxy = process.env.GLB_PROXY || "";
        if (plugin.excludedCountries === undefined) plugin.excludedCountries = "BR";

        settings.plugins = settings.plugins || {};
        settings.plugins.GoLiveBypass = plugin;
        fs.writeFileSync(file, JSON.stringify(settings, null, 4));
    ' && step "Plugin ativado em $file" || warn "Nao mexi no $file. Ative o GoLiveBypass na mao em Configuracoes > Plugins."
}

show_status() {
    local root="${1:-}"
    local count mod plugin extra=""
    count="$(discord_resources | wc -l)"
    mod="$(installed_mod || true)"

    if discord_resources | grep -q '/com\.discordapp\.'; then extra=", flatpak"; fi

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

select_proxy() {
    if tui_is_interactive; then
        local tui_choice
        tui_choice="$(tui_menu "Como o bypass vai sair para fora do Brasil?" \
            "Proxy gratuita (escolhida e testada sozinha)" \
            "Tor automatico (baixa e sobe sozinho)" \
            "Proxy minha (socks5://host:porta)")"
        case "$tui_choice" in
            2)
                if ! ensure_tor; then
                    warn "Nao deu para preparar o Tor. Seguindo com proxy gratuita."
                    printf '\n'
                    return 0
                fi
                printf 'socks5://127.0.0.1:%s\n' "$TOR_PORT"
                ;;
            3)
                local manual
                manual="$(tui_input "Endereco da proxy")"
                case "$manual" in
                    socks5://*|https://*|http://*)
                        printf '%s' "$manual" | grep -Eq '^(socks5|https?)://(.+@)?[a-z0-9.-]{1,253}:[0-9]{1,5}(-[0-9]{1,5})?$' || fail "Formato invalido. Use socks5://host:porta, ou socks5://usuario:senha@host:porta." ;;
                    *) fail "Formato invalido. Use socks5://host:porta, ou socks5://usuario:senha@host:porta." ;;
                esac
                printf '%s\n' "$manual"
                ;;
            *) printf '\n' ;;
        esac
        return 0
    fi

    printf '\n  %sComo o bypass vai sair para fora do Brasil?%s\n\n' "$C_BOLD" "$C_OFF" >&2
    printf '    %s[1] Proxy gratuita, escolhida e testada sozinha%s\n' "$C_GREEN" "$C_OFF" >&2
    printf '  %s      Nao precisa instalar nada. O plugin testa varias e usa a que passar.%s\n' "$C_DIM" "$C_OFF" >&2
    printf '    %s[2] Tor automatico%s\n' "$C_CYAN" "$C_OFF" >&2
    printf '  %s      Baixa e instala o Tor sozinho (uma vez) e deixa ele sempre rodando.%s\n' "$C_DIM" "$C_OFF" >&2
    printf '    %s[3] Proxy minha%s\n' "$C_CYAN" "$C_OFF" >&2
    printf '  %s      Voce informa o endereco, no formato socks5://host:porta.%s\n\n' "$C_DIM" "$C_OFF" >&2

    local choice manual
    printf '%s' "  Escolha: " >&2
    read -r choice
    case "$choice" in
        2)
            if ! ensure_tor; then
                warn "Nao deu para preparar o Tor. Seguindo com proxy gratuita."
                printf '\n'
                return 0
            fi
            printf 'socks5://127.0.0.1:%s\n' "$TOR_PORT"
            ;;
        3)
            printf '  %sSe a sua proxy pedir login, use socks5://usuario:senha@host:porta%s\n' "$C_DIM" "$C_OFF" >&2
            printf '  %sSenha com @ ou : precisa vir codificada (@ vira %%40, : vira %%3A)%s\n' "$C_DIM" "$C_OFF" >&2
            printf '%s' "  Endereco da proxy: " >&2
            read -r manual
            # O trecho antes do @ e opcional e casado com ganancia, para a senha poder conter @ e
            # : codificados. Recusar aqui deixaria o suporte a login existindo so no plugin.
            # O mesmo casamento do =~ do bash, com case. O trecho antes do @ e opcional.
            case "$manual" in
                socks5://*|https://*|http://*)
                    printf '%s' "$manual" | grep -Eq '^(socks5|https?)://(.+@)?[a-z0-9.-]{1,253}:[0-9]{1,5}(-[0-9]{1,5})?$'                         || fail "Formato invalido. Use socks5://host:porta, ou socks5://usuario:senha@host:porta."
                    ;;
                *) fail "Formato invalido. Use socks5://host:porta, ou socks5://usuario:senha@host:porta." ;;
            esac
            printf '%s\n' "$manual"
            ;;
        *) printf '\n' ;;
    esac
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

do_install() {
    local root="${1:-}"
    root="$(select_target "$root")"

    local proxy permanent=0
    proxy="$(select_proxy)"
    select_persistence || permanent=1

    ensure_toolchain 0
    copy_plugin "$root"
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
    set_plugin_settings "$root" "$proxy"

    start_discord "$root"

    printf '\n'
    ok "Pronto. O plugin ja vem ativado, nao precisa mexer em nada."
    if [ -n "$proxy" ]; then
        # A senha nao aparece na tela: a pessoa costuma tirar print desta parte para mostrar que
        # deu certo.
        printf '  %sProxy: %s%s\n' "$C_DIM" "$(hide_proxy_secret "$proxy")" "$C_OFF"
    else
        printf '  %sProxy: gratuita, escolhida e testada sozinha a cada abertura%s\n' "$C_DIM" "$C_OFF"
    fi
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

    [ "$permanent" -eq 1 ] && wait_discord_exit "$root"
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
            "Instalar ou atualizar o GoLiveBypass" \
            "Remover so o plugin (o mod continua)" \
            "Restaurar tudo (remove o plugin e desfaz a injecao)" \
            "Sair")"
        case "$tui_choice" in
            1) do_install "$root" ;;
            2) do_uninstall ;;
            3) do_restore_everything ;;
            *) printf '  %sAte mais.%s\n' "$C_DIM" "$C_OFF" ;;
        esac
        return
    fi

    printf '  %sO que voce quer fazer?%s\n\n' "$C_BOLD" "$C_OFF"
    printf '    %s[1] Instalar ou atualizar o GoLiveBypass%s\n' "$C_GREEN" "$C_OFF"
    printf '    %s[2] Remover so o plugin (o mod continua)%s\n' "$C_YELLOW" "$C_OFF"
    printf '    %s[3] Restaurar tudo (remove o plugin e desfaz a injecao)%s\n' "$C_RED" "$C_OFF"
    printf '    [0] Sair\n\n'

    local choice
    printf '%s' "  Escolha: " >&2
    read -r choice
    case "$choice" in
        1) do_install "$root" ;;
        2) do_uninstall ;;
        3) do_restore_everything ;;
        *) printf '  %sAte mais.%s\n' "$C_DIM" "$C_OFF" ;;
    esac
}

banner
case "$MODE" in
    install) do_install "$(find_checkout || true)" ;;
    uninstall) do_uninstall ;;
    restore) do_restore_everything ;;
    *) main_menu ;;
esac
printf '\n'
