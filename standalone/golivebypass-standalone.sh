#!/bin/sh
#
# GoLiveBypass standalone - instalador para Linux
#
# Instala direto no Discord, sem Equicord e sem Vencord. Nao precisa de Node, nem de pnpm,
# nem de git: o bypass e um arquivo .js que o proprio Discord carrega.
#
# Funciona tambem com o Discord instalado por flatpak, do sistema ou do usuario.
#
# Uso:
#   ./golivebypass-standalone.sh
#   ./golivebypass-standalone.sh --proxy socks5://127.0.0.1:9050
#   ./golivebypass-standalone.sh --uninstall
#   ./golivebypass-standalone.sh --status

# So construcoes POSIX: roda em dash, bash, zsh, ksh e busybox ash.
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





PATCHER_NAME="golivebypass.js"
# Quando o script roda via sudo (elevacao para mexer em /usr/lib), $HOME vira /root e o patcher
# iria para uma pasta que o Discord do usuario nao le. SUDO_USER devolve o usuario real.
_USER_HOME="${SUDO_USER:-${HOME}}"
if [ -n "${SUDO_USER:-}" ]; then _USER_HOME="$(getent passwd "$SUDO_USER" 2>/dev/null | cut -d: -f6 || printf '/home/%s' "$SUDO_USER")"; fi
INSTALL_DIR="${XDG_DATA_HOME:-$_USER_HOME/.local/share}/GoLiveBypass"
STUB_PACKAGE='{"name":"discord","main":"index.js","version":"1.0.0"}'
# Clientes do Discord por flatpak: os oficiais e os paralelos publicados no Flathub —
# Vesktop (dev.vencord.Vesktop), Legcord (app.legcord.Legcord) e Equibop
# (org.equicord.equibop).
FLATPAK_IDS="com.discordapp.Discord com.discordapp.DiscordPTB com.discordapp.DiscordCanary dev.vencord.Vesktop app.legcord.Legcord org.equicord.equibop"
HERE="$(cd "$(dirname "$0")" && pwd)"

# ---------------------------------------------------------------------------
# Tor embutido: mesma versao, mesmos hashes e mesma porta da GUI
# (golive-gui/electron/main.ts). A porta dedicada 9060 nao conflita com um Tor
# do sistema (9050) nem do Tor Browser (9150).
TOR_BUNDLE_VERSION="13.5"
TOR_PORT="9060"
TOR_BASE="$INSTALL_DIR/Tor"
TOR_EXE="$TOR_BASE/tor/tor"
TOR_TORRC="$TOR_BASE/torrc"
TOR_TARBALL="tor-expert-bundle-linux-x86_64-$TOR_BUNDLE_VERSION.tar.gz"
TOR_URL="https://archive.torproject.org/tor-package-archive/torbrowser/$TOR_BUNDLE_VERSION/$TOR_TARBALL"
TOR_SHA256="147158f33c5f2c539d58d8fab69ca5af384778e7bbae951fbc7ac8ca58ac4e0d"
TOR_SERVICE="golivebypass-tor.service"

MODE="install"
PROXY=""
EXCLUDED="BR"
TOR_MODE=0
ASSUME_YES=0
JSON=0

C_OFF=$(printf '\033[0m'); C_CYAN=$(printf '\033[36m'); C_GREEN=$(printf '\033[32m'); C_YELLOW=$(printf '\033[33m'); C_RED=$(printf '\033[31m'); C_DIM=$(printf '\033[2m')

# Tudo em stderr: estas funcoes sao chamadas de dentro de $(...), e escrever em stdout faria o
# texto colar no valor de retorno. Foi assim que a primeira versao do instalador de Linux
# devolveu "[*] procurando... /caminho" como se fosse um caminho.
step() { printf '  %s[*]%s %s\n' "$C_CYAN" "$C_OFF" "$1" >&2; }
ok()   { printf '  %s[OK]%s %s\n' "$C_GREEN" "$C_OFF" "$1" >&2; }
warn() { printf '  %s[!]%s %s\n' "$C_YELLOW" "$C_OFF" "$1" >&2; }
# should_report <mensagem>: 0 se a mensagem deve virar issue no GitHub, 1 se nao.
# Mesmo do instalador de plugin: erros de uso (dependencia, CLI typo, path
# errado, ferramenta externa quebrada) nao viram issue. Bug real continua.
should_report() {
    case "$1" in
        # --- cancelamento e instrucoes de uso ---
        "Cancelado.") return 1 ;;
        # Cancelamento via Ctrl+C: ver nota no installer.sh.
        *"cancelada pelo usu"*) return 1 ;;
        *"canceled by the user"*) return 1 ;;
        *"interrompido"*) return 1 ;;
        *"terminated"*) return 1 ;;
        "O Discord nao fechou"*) return 1 ;;
        # --- input / uso do usuario ---
        "Opcao desconhecida: "*) return 1 ;;
        "Formato invalido. Use socks5://"*) return 1 ;;
        "Endereco da proxy invalido"*) return 1 ;;
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
    printf '  %s[X]%s %s\n' "$C_RED" "$C_OFF" "$1" >&2
    # Report automatico: so quando esta de fato falhando (e nao em --yes de teste).
    if [ "${REPORT_NO_AUTO:-0}" -eq 0 ] && should_report "$1"; then
        report_error "Falha no instalador GoLiveBypass: $1" 2>&1 || true
    fi
    exit 1
}

# =========================================================================== Report de bugs
# Quando o instalador falha, monta um diagnostico (versao, OS, log sanitizado) e chama
# a mesma API de bugs da GUI. A issue abre automaticamente no bezumiya/GoLiveBypass.
# O envio NUNCA bloqueia o fluxo: falhou o report, avisa e segue.

BUG_API_URL="https://api.skyplaceia.com/bugs/v1/reports"
BUG_API_TOKEN="c3d0bff691ecc3ddc6f6ca10037b9ac967c62547e681d3749204e50800504511"

# Sanitiza texto: credenciais em URL, tokens Discord, query de gateway, e a proxy salva.
report_sanitize() {
    local texto="$1"
    # credenciais em URL: scheme://usuario:senha@host -> scheme://usuario:***@host
    texto="$(printf '%s' "$texto" | sed -E 's#([a-z][a-z0-9+.-]*://)([^/ @:]+):([^/@]+)@#\1\2:***@#g')"
    # tokens Discord (mfa.* / JWT)
    texto="$(printf '%s' "$texto" | sed -E 's/\b(mfa\.[A-Za-z0-9_-]{20,}|[A-Za-z0-9_-]{23,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{27,})\b/***/g')"
    # query de gateway: so o host interessa
    texto="$(printf '%s' "$texto" | sed -E 's#(https://gateway[^ ?]+)\?[^ ]*#\1?<params>#g')"
    # proxy personalizada salva (host/porta e URL inteira)
    if [ -f "$INSTALL_DIR/settings.json" ]; then
        local segredo
        segredo="$(sed -n 's/.*"proxy"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$INSTALL_DIR/settings.json" | head -1)"
        if [ -n "$segredo" ]; then
            texto="$(printf '%s' "$texto" | sed "s#$(printf '%s' "$segredo" | sed 's/[&/\]/\\&/g')#<proxy-pessoal>#g")"
        fi
    fi
    printf '%s' "$texto"
}

# Envia o report para a API. Devolve 0 em caso de sucesso (issue aberta).
report_send() {
    local titulo="$1" descricao="$2"
    local corpo
    corpo="$(report_sanitize "$descricao")"
    # JSON minimo: title, description, includeLogs
    local json
    json="$(printf '{"title":"%s","description":"%s","includeLogs":true}' \
        "$(printf '%s' "$titulo" | sed 's/"/\\"/g')" \
        "$(printf '%s' "$corpo" | sed 's/"/\\"/g')")"
    if have curl; then
        curl -fsS -X POST "$BUG_API_URL" \
            -H "Authorization: Bearer $BUG_API_TOKEN" \
            -H "Content-Type: application/json" \
            -d "$json" >/dev/null 2>&1 && return 0
    elif have wget; then
        echo "$json" | wget -qO- --post-data=- --header="Authorization: Bearer $BUG_API_TOKEN" --header="Content-Type: application/json" "$BUG_API_URL" >/dev/null 2>&1 && return 0
    fi
    return 1
}

# Chamada unica de report: mostra aviso e tenta enviar (sem bloquear).
report_error() {
    local titulo="$1"
    local desc="$(cat 2>/dev/null || true)"
    if [ -s /tmp/glb-report-context.txt ]; then
        desc="$(cat /tmp/glb-report-context.txt 2>/dev/null || true) $desc"
    fi
    # Aqui entra a cauda do log se existir
    if [ -f "$INSTALL_DIR/golivebypass.log" ]; then
        desc="$desc
$(tail -n 40 "$INSTALL_DIR/golivebypass.log" 2>/dev/null || true)"
    fi
    if [ -n "$desc" ]; then
        printf '  %s[!]%s Ocorreu um erro. Enviando relatorio automatico (issue no GitHub)...%s\n' "$C_YELLOW" "$C_OFF" "$C_OFF" >&2
        if report_send "$titulo" "$desc"; then
            printf '  %s[OK]%s Relatorio enviado. Obrigado — os devs vao ver a issue no GitHub.%s\n' "$C_GREEN" "$C_OFF" "$C_OFF" >&2
        else
            printf '  %s[!]%s Nao consegui enviar o relatorio automatico. Rode com --json e mande a saida.%s\n' "$C_YELLOW" "$C_OFF" "$C_OFF" >&2
        fi
    else
        printf '  %s[!]%s Nao consegui montar o relatorio (sem logs). Mande o erro acima.%s\n' "$C_YELLOW" "$C_OFF" "$C_OFF" >&2
    fi
}

# =========================================================================== /Report de bugs

# =========================================================================== TUI (standalone)
# Interface no estilo OpenCode (dark, caixas, setas/Enter), ANSI puro, POSIX.
# Quando nao ha TTY, ou -y/--yes esta ligado, o script cai para o fluxo por flags.
# As funcoes usam prefixo st_ para nao colidir com as do instalador de plugin.

st_tui_is_interactive() {
    [ "$ASSUME_YES" -eq 1 ] && return 1
    # stdin interativo e suficiente (evita quebrar em pty/emuladores).
    [ -t 0 ] && return 0
    return 1
}

ST_BG=$(printf '\033[48;5;235m')
ST_FG=$(printf '\033[38;5;252m')
ST_ACCENT=$(printf '\033[38;5;75m')
ST_OK=$(printf '\033[38;5;114m')
ST_DIM2=$(printf '\033[38;5;240m')
ST_BOLD=$(printf '\033[1m')
ST_RSET=$(printf '\033[0m')

st_tui_mouse_on()   { printf '\033[?1000h\033[?1006h' >&2; }
st_tui_mouse_off()  { printf '\033[?1000l\033[?1006l' >&2; }
st_tui_hide_cursor() { printf '\033[?25l' >&2; }
st_tui_show_cursor() { printf '\033[?25h' >&2; }

# Tamanho do terminal + posicionamento (centraliza o box).
st_tui_size() {
    local s
    if s="$(stty size 2>/dev/null)"; then
        set -- $s
        ST_ROWS=${1:-24}
        ST_COLS=${2:-80}
    else
        ST_ROWS=24
        ST_COLS=80
    fi
    if [ "$ST_COLS" -le 20 ]; then ST_COLS=80; fi
    return 0
}
st_tui_cursor() { printf '\033[%d;%dH' "$1" "$2" >&2; }

st_tui_raw_begin() {
    ST_STTY_SAVED="$(stty -g 2>/dev/null || true)"
    stty -icanon -echo 2>/dev/null || true
}
st_tui_raw_end() {
    if [ -n "${ST_STTY_SAVED:-}" ]; then
        stty "$ST_STTY_SAVED" 2>/dev/null || true
    else
        stty icanon echo 2>/dev/null || true
    fi
    ST_STTY_SAVED=""
}

st_tui_getkey() {
    local key rest
    key="$(dd bs=1 count=1 2>/dev/null | od -An -tx1 | tr -d ' \n')"
    case "$key" in
        1b)
            rest="$(dd bs=1 count=2 2>/dev/null | od -An -tx1 | tr -d ' \n')"
            case "$rest" in
                5b41) printf 'up\n' ;;
                5b42) printf 'down\n' ;;
                *)    printf 'esc\n' ;;
            esac ;;
        0a|0d) printf 'enter\n' ;;
        6a) printf 'down\n' ;;
        6b) printf 'up\n' ;;
        71) printf 'esc\n' ;;
        *) printf 'other\n' ;;
    esac
}

st_seq() {
    local start="$1" end="$2" i
    i="$start"
    while [ "$i" -le "$end" ]; do printf '%d ' "$i"; i=$((i+1)); done
}

# st_tui_menu <title> <items...> → imprime indice (1..N) ou 0 para cancelar.
# Centraliza o box no meio do terminal (horizontal e vertical).
st_tui_menu() {
    local title="$1"; shift
    local n sel key i txt
    n=$#
    sel=0
    st_tui_mouse_on
    st_tui_hide_cursor
    st_tui_raw_begin
    st_tui_size
    local w=62
    local total_rows top pad margin_col margin_row r
    total_rows=$((n + 5))
    margin_col=$(( ( ST_COLS - w ) / 2 ))
    [ "$margin_col" -lt 1 ] && margin_col=1
    margin_row=$(( ( ST_ROWS - total_rows ) / 2 ))
    [ "$margin_row" -lt 1 ] && margin_row=1
    while :; do
        printf '\033[1;0H\033[J' >&2
        top=""
        i=0; while [ "$i" -lt $((w-8)) ]; do top="${top}─"; i=$((i+1)); done
        r=$margin_row
        st_tui_cursor $r $margin_col
        printf '%s%s┌─ %s%s%s ─%s%s%s\n' "$ST_BG" "$ST_RSET" "$ST_ACCENT" "$title" "$ST_RSET" "$ST_DIM2" "$top" "$ST_RSET" >&2
        i=0
        for txt in "$@"; do
            r=$((r+1))
            st_tui_cursor $r $margin_col
            pad=""
            local j
            j=0; while [ "$j" -lt $((w-6-${#txt})) ]; do pad="${pad} "; j=$((j+1)); done
            if [ "$i" -eq "$sel" ]; then
                printf '%s│ %s●%s %s%s%s%s│%s\n' "$ST_BG" "$ST_ACCENT" "$ST_RSET" "$ST_BOLD" "$txt" "$ST_RSET" "$pad" "$ST_RSET" >&2
            else
                printf '%s│ %s○%s %s%s%s│%s\n' "$ST_BG" "$ST_DIM2" "$ST_RSET" "$txt" "$ST_RSET" "$pad" "$ST_RSET" >&2
            fi
            i=$((i+1))
        done
        r=$((r+1))
        st_tui_cursor $r $margin_col
        printf '%s└%s┘%s\n' "$ST_BG" "$(printf '─%.0s' $(st_seq 1 $((w-2))))" "$ST_RSET" >&2
        r=$((r+1))
        st_tui_cursor $r $margin_col
        printf '%s  %s[↑↓] navegar · [Enter] escolher · [Esc] cancelar%s' "$ST_BG" "$ST_DIM2" "$ST_RSET" >&2
        key="$(st_tui_getkey)"
        case "$key" in
            up)   [ "$sel" -gt 0 ] && sel=$((sel-1)) ;;
            down) [ "$sel" -lt $((n-1)) ] && sel=$((sel+1)) ;;
            enter) break ;;
            esc)  sel=-1; break ;;
        esac
    done
    st_tui_raw_end
    st_tui_mouse_off
    st_tui_show_cursor
    if [ "$sel" -ge 0 ] && [ "$sel" -lt "$n" ]; then printf '%d\n' $((sel+1)); else printf '0\n'; fi
}

# st_tui_confirm <question> → 0 sim, 1 nao
st_tui_confirm() {
    st_tui_is_interactive || return 1
    local answer
    printf '%s%s  %s [s/N] ' "$ST_BG" "$ST_FG" "$1" >&2
    st_tui_show_cursor
    read -r answer
    st_tui_hide_cursor
    case "$answer" in [sSyY]*) return 0 ;; *) return 1 ;; esac
}

# st_tui_input <label> <inicial>
st_tui_input() {
    local label="$1" value="${2:-}"
    printf '%s%s  %s%s: %s%s' "$ST_BG" "$ST_FG" "$label" "$ST_ACCENT" "$value" >&2
    st_tui_show_cursor
    IFS= read -r value
    st_tui_hide_cursor
    printf '%s\n' "$value"
}

# st_tui_progress/done: linha de status com spinner simples.
st_tui_progress() { printf '\033[2K\r%s%s[*]%s %s%s' "$ST_BG" "$ST_ACCENT" "$ST_RSET" "$1" "$ST_RSET" >&2; }
st_tui_done() { printf '\033[2K\r%s%s[OK]%s\n' "$ST_BG" "$ST_OK" "$ST_RSET" >&2; }

# =========================================================================== /TUI (standalone)

while [ $# -gt 0 ]; do
    case "$1" in
        --proxy) PROXY="${2:-}"; shift ;;
        --excluded-countries) EXCLUDED="${2:-BR}"; shift ;;
        --tor) TOR_MODE=1 ;;
        --uninstall) MODE="uninstall" ;;
        --restore) MODE="restore" ;;
        --status) MODE="status" ;;
        --json) JSON=1 ;;
        -y|--yes) ASSUME_YES=1 ;;
        -h|--help) sed -n '3,14p' "$SCRIPT_PATH" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) fail "Opcao desconhecida: $1" ;;
    esac
    shift
done

# Em automacao (--yes) o report automatico nao deve spammar a API: quase sempre essas
# rodadas sao de teste/CI. Usuario de verdade sem --yes reporta.
[ "$ASSUME_YES" -eq 1 ] && REPORT_NO_AUTO=1 || REPORT_NO_AUTO=0

have() { command -v "$1" >/dev/null 2>&1; }

# Senha digitada numa janela (zenity/kdialog) para o sudo -S. Cacheada em arquivo
# temporario para nao repetir a pergunta a cada operacao da injecao (mv, mkdir, cp).
SUDO_PASS_FILE=""
sudo_pass_get() {
    if [ -n "$SUDO_PASS_FILE" ] && [ -f "$SUDO_PASS_FILE" ]; then
        return 0
    fi
    local pass=""
    if have zenity; then
        pass="$(zenity --password --title='GoLiveBypass - senha do sudo' 2>/dev/null)"
    elif have kdialog; then
        pass="$(kdialog --password 'Senha do sudo (GoLiveBypass)' 2>/dev/null)"
    fi
    [ -n "$pass" ] || return 1
    SUDO_PASS_FILE="$(mktemp)"
    chmod 600 "$SUDO_PASS_FILE"
    printf '%s\n' "$pass" > "$SUDO_PASS_FILE"
    return 0
}

# Roda um comando como root. O sudo e o padrao, mas em desktops com polkit (Fedora KDE/GNOME,
# Ubuntu com sudo desativado) ele falha sem TTY ou sem senha configurada — e o pkexec mostra o
# dialogo grafico do sistema. Tentar os dois cobre os dois mundos; quem falhar, avisa.
# Sem TTY e sem agente polkit (niri/hyprland headless-ish), nem sudo interativo nem pkexec
# funcionam — ai a senha e pedida numa janela (zenity deve existir na GUI) e o sudo -S resolve.
elevate() {
    if [ "$(id -u)" -eq 0 ]; then
        "$@"
    elif have sudo && sudo -n true 2>/dev/null; then
        # NOPASSWD: sudo direto, sem dialogo.
        sudo "$@"
    elif have sudo && sudo_pass_get; then
        # Sem NOPASSWD e sem TTY (GUI/AppImage no niri), o pkexec falha sem agente polkit e o
        # sudo interativo sem TTY idem. A senha pedida em janela resolve os dois casos. Cacheada
        # em SUDO_PASS_FILE para nao repetir. Senha errada: invalida o cache e tenta de novo.
        sudo -S "$@" < "$SUDO_PASS_FILE" || { rm -f "$SUDO_PASS_FILE"; SUDO_PASS_FILE=""; return 1; }
    elif have pkexec; then
        # Dialogo grafico do polkit (GNOME/KDE com agente). Sem agente ele falha com 127.
        pkexec "$@"
    elif have sudo; then
        # Ultimo caso: sudo interativo (terminal). Sem TTY ele falha e o chamador avisa.
        sudo "$@"
    else
        return 127
    fi
}

# Ler campo a campo em vez de dar source: /etc/os-release e shell valido, e um arquivo torto
# executaria comando neste script, que logo depois chama sudo.
os_field() {
    [ -r /etc/os-release ] || return 0
    sed -n "s/^$1=//p" /etc/os-release | tr -d '"' | head -1
    return 0
}

# O trecho antes do @ e opcional e casado com ganancia, para a senha poder conter @ e :
# codificados. Sem validar aqui, um endereco com erro de digitacao viraria configuracao e o
# bypass cairia para a lista gratuita sem dizer por que.
if [ -n "$PROXY" ]; then
    if ! printf '%s' "$PROXY" | grep -Eq '^(socks5|socks4|https?)://(.+@)?[^:/@[:space:]]+:[0-9]{1,5}(-[0-9]{1,5})?$'; then
        printf '\n  %s[X]%s Endereco de proxy invalido.\n' "$C_RED" "$C_OFF" >&2
        printf '      %sUse socks5://host:porta, ou socks5://usuario:senha@host:porta.%s\n' "$C_DIM" "$C_OFF" >&2
        printf '      %sSenha com @ ou : precisa vir codificada (@ vira %%40, : vira %%3A).%s\n\n' "$C_DIM" "$C_OFF" >&2
        exit 1
    fi
fi

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

# Procura o app.asar de verdade em vez de confiar numa lista de caminhos.
#
# O ponto que quebra qualquer lista feita de memoria: desde a versao 1.0.136, de maio de 2026,
# o pacote de Linux do Discord (tar.gz, .deb, o oficial do Arch e o RPM) traz SO um bootstrap.
# O app de verdade, com o app.asar, e baixado na primeira execucao para dentro do HOME. Quem
# so olha /usr/share e /opt nao acha Discord nenhum numa instalacao atual.
discord_dirs() {
    local raiz sub base id flav detect count=0

    base="${XDG_CONFIG_HOME:-$HOME/.config}"
    detect="bootstrap"
    for sub in \
        "$base"/discord/app-*/resources \
        "$base"/discordptb/app-*/resources \
        "$base"/discordcanary/app-*/resources
    do
        [ -e "$sub/app.asar" ] || [ -e "$sub/_app.asar" ] || continue
        flav="discord"; case "$sub" in *ptb*) flav="discordptb" ;; *canary*) flav="discordcanary" ;; esac
        printf '%s|%s|%s\n' "$sub" "$flav" "$detect"
        count=$((count + 1))
    done
    warn "trace: bootstrap config varrido (achou $count)"

    # Pacotes que ainda embutem o app: discord_arch_electron do AUR (/usr/share/discord),
    # discord-electron-openasar (/usr/lib/discord), os AUR de PTB e Canary (/opt), e qualquer
    # tar.gz antigo que a pessoa tenha extraido na mao.
    detect="nativo"
    for raiz in \
        /usr/share/discord /usr/share/discord-ptb /usr/share/discord-canary \
        /usr/lib/discord /usr/lib/discord-ptb /usr/lib/discord-canary /usr/lib64/discord \
        /opt/discord /opt/Discord /opt/discord-ptb /opt/discord-canary \
        /usr/local/share/discord \
        "$HOME/.local/share/discord" "$HOME/.local/share/discordptb" "$HOME/.local/share/discordcanary" "$HOME/Discord" "$HOME/discord"
    do
        [ -d "$raiz" ] || continue
        for sub in "$raiz/resources" "$raiz"; do
            if [ -e "$sub/app.asar" ] || [ -e "$sub/_app.asar" ]; then
                flav="discord"; case "$raiz" in *ptb*) flav="discordptb" ;; *canary*) flav="discordcanary" ;; esac
                printf '%s|%s|%s\n' "$sub" "$flav" "$detect"
                count=$((count + 1))
                break
            fi
        done
    done

    # Clientes paralelos (mods standalone) com a mesma estrutura Electron: Vesktop (o desktop
    # do Vencord), Equibop (fork do Vesktop) e Legcord. Instalam em /opt, /usr/lib e
    # ~/.local/share conforme o empacotamento (AUR, .deb/.rpm ou portable). O bootstrap do
    # Discord nao se aplica aqui: o app vem inteiro com o resources/ embutido.
    detect="paralelo"
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
                flav="vesktop"; case "$raiz" in *equibop*|*Equibop*) flav="equibop" ;; *legcord*|*Legcord*) flav="legcord" ;; esac
                printf '%s|%s|%s\n' "$sub" "$flav" "$detect"
                count=$((count + 1))
                break
            fi
        done
    done

    # Flatpak. O deploy do ostree e do root, mas e um diretorio comum: a injecao troca o nome
    # do app.asar e cria uma pasta ao lado, sem reescrever arquivo nenhum, entao os objetos do
    # repositorio ficam intactos. O que muda em relacao ao resto e que um `flatpak update`
    # refaz o deploy inteiro e leva a injecao junto.
    detect="flatpak"
    for raiz in /var/lib/flatpak/app "${XDG_DATA_HOME:-$HOME/.local/share}/flatpak/app"; do
        [ -d "$raiz" ] || continue
        for id in $FLATPAK_IDS; do
            # O Discord oficial cai em files/<app>/resources; Vesktop, Equibop e Legcord
            # empacotam o Electron em files/bin/<app>/resources.
            for sub in "$raiz/$id"/current/active/files/*/resources \
                       "$raiz/$id"/current/active/files/bin/*/resources; do
                if [ -e "$sub/app.asar" ] || [ -e "$sub/_app.asar" ]; then
                    flav="discord"; case "$id" in *Vesktop*) flav="vesktop" ;; *Legcord*) flav="legcord" ;; *equibop*) flav="equibop" ;; *PTB*) flav="discordptb" ;; *Canary*) flav="discordcanary" ;; esac
                    printf '%s|%s|%s|%s\n' "$sub" "$flav" "$detect" "$id"
                    count=$((count + 1))
                fi
            done
        done
    done

    # O mesmo bootstrap de que fala o comentario la em cima, so que dentro do flatpak: o HOME
    # do Discord vira ~/.var/app/<id>, e o app baixado cai la. Este e do proprio usuario.
    detect="flatpak-bootstrap"
    for id in $FLATPAK_IDS; do
        for sub in "$HOME/.var/app/$id"/config/discord*/app-*/resources; do
            if [ -e "$sub/app.asar" ] || [ -e "$sub/_app.asar" ]; then
                flav="discord"; case "$id" in *Vesktop*) flav="vesktop" ;; *Legcord*) flav="legcord" ;; *equibop*) flav="equibop" ;; *PTB*) flav="discordptb" ;; *Canary*) flav="discordcanary" ;; esac
                printf '%s|%s|%s|%s\n' "$sub" "$flav" "$detect" "$id"
                count=$((count + 1))
            fi
        done
    done

    warn "trace: varridas 5 blocos de raizes, achei $count Discord(s)"
    return 0
}

# O id do flatpak a que um caminho pertence, ou nada se o caminho nao for de flatpak.
flatpak_app_id() {
    local parte
    for parte in $(printf '%s\n' "${1:-}" | tr '/' '\n'); do
        case "$parte" in com.discordapp.*|dev.vencord.*|app.legcord.*|org.equicord.*) printf '%s\n' "$parte"; return 0 ;; esac
    done
    return 1
}

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

# O flatpak so enxerga o proprio sandbox, e o bypass mora fora dele. Sem esta liberacao o
# index.js injetado faz require de um caminho que de dentro do sandbox nao existe, e o Discord
# abre em tela branca. Precisa ser leitura e escrita: o registro tambem e gravado aqui.
grant_flatpak_access() {
    local id="$1" dir="$2"
    have flatpak || return 0
    flatpak_has_access "$id" "$dir" && return 0

    # O override --user vale para app do sistema tambem (o override do usuario tem prioridade
    # sobre o do sistema) e nao precisa de root. So cai para o sistema quando o --user falha:
    # no Fedora KDE o sudo/pkexec costuma falhar sem TTY, e este caminho resolve sem dialogo.
    if flatpak override --user "$id" --filesystem="$dir" >/dev/null 2>&1; then
        flatpak_has_access "$id" "$dir" && return 0
    fi

    if ! flatpak_is_user_install "$id"; then
        step "Liberando $dir para o $id"
        elevate flatpak override "$id" --filesystem="$dir" >/dev/null 2>&1 && return 0
    fi

    warn "Nao consegui liberar $dir para o $id. Se o Discord abrir em branco, rode:"
    printf '      %sflatpak override %s--filesystem=%s %s%s\n' \
        "$C_DIM" "$(flatpak_is_user_install "$id" && printf -- '--user ')" "$dir" "$id" "$C_OFF" >&2
    return 1
}

revoke_flatpak_access() {
    local id="$1" dir="$2"
    have flatpak || return 0

    # Mesma logica do grant: o --user vale para app do sistema e nao precisa de root.
    flatpak override --user "$id" --nofilesystem="$dir" >/dev/null 2>&1 || true
    if ! flatpak_is_user_install "$id"; then
        elevate flatpak override "$id" --nofilesystem="$dir" >/dev/null 2>&1 || true
    fi
    return 0
}

# O pacote discord-electron-openasar ja substitui o app.asar pelo OpenAsar. Injetar por cima
# apagaria o OpenAsar da pessoa sem avisar.
aviso_openasar() {
    local dir="$1"
    case "$dir" in
        /usr/lib/discord*) warn "Esta instalacao parece ser a do openasar. Injetar aqui substitui o OpenAsar." ;;
    esac
    return 0
}

# O snap monta o app dentro de um squashfs, que e somente leitura de verdade: nem o root
# escreve la. Detectar isso vale mais que falhar no meio com "permissao negada". O flatpak nao
# entra nesta lista: o deploy dele e um diretorio comum, e a injecao funciona.
aviso_empacotado() {
    if have snap && snap list 2>/dev/null | grep -qi "^discord"; then
        warn "Voce tem o Discord por snap, e ali o sistema de arquivos e somente leitura."
        printf '      %sA injecao nao acontece dentro de um snap. Para usar o standalone,%s\n' "$C_DIM" "$C_OFF" >&2
        printf '      %sinstale o Discord por flatpak, pelo site oficial ou pela sua distro.%s\n' "$C_DIM" "$C_OFF" >&2
        warn "trace: snap detectado (injecao impossivel, squashfs read-only)"
    else
        warn "trace: snap nao detectado"
    fi

    # AppImage dos clientes paralelos: o scan nao injeta neles (e um binario unico, precisa
    # de extracao), mas o diagnostico deve avisar que o Vesktop/Equibop/Legcord existe e
    # nao foi considerado — senao a pessoa ve "Discord nao encontrado" com o app na tela.
    for raiz in "$HOME/Applications" "$HOME/AppImages" "$HOME/.local/bin" "$HOME/Downloads"; do
        [ -d "$raiz" ] || continue
        for appimage in "$raiz"/*.AppImage; do
            [ -e "$appimage" ] || continue
            case "$(basename "$appimage")" in
                Vesktop*|Equibop*|Legcord*)
                    warn "trace: achei AppImage de cliente paralelo em $appimage — injecao exige extracao (instale via pacote/flatpak)" ;;
            esac
        done
    done

    return 0
}

injection_state() {
    local resources="$1"
    [ -f "$resources/_app.asar" ] || { printf 'vanilla\n'; return 0; }

    if [ -f "$resources/app.asar/index.js" ] && grep -qF "$PATCHER_NAME" "$resources/app.asar/index.js" 2>/dev/null; then
        printf 'nosso\n'
    else
        printf 'outromod\n'
    fi
    return 0
}

# Escrever em /usr/share exige raiz; em ~/.local/share nao. Pedir sudo sempre seria grosseiro,
# e nunca pedir quebraria a instalacao mais comum.
as_root() {
    if [ -w "$1" ]; then
        shift
        "$@"
    else
        local dir="$1"; shift
        step "Preciso de privilegios para escrever em $dir"
        elevate "$@"
    fi
}

# O Discord de flatpak roda em outro namespace de PID: o pgrep costuma ve-lo, mas o pkill pode
# nao alcanca-lo. O `flatpak ps` e o `flatpak kill` respondem por essa parte.
discord_running() {
    # -x casa o nome exato do processo; no Linux o Discord pode ser "Discord", "discord",
    # "discord-canary", "discordptb"... e tambem o binario do Electron em qualquer desses nomes.
    pgrep -x Discord >/dev/null 2>&1 && return 0
    pgrep -x DiscordPTB >/dev/null 2>&1 && return 0
    pgrep -x discord >/dev/null 2>&1 && return 0
    pgrep -x discord-canary >/dev/null 2>&1 && return 0
    pgrep -x discordptb >/dev/null 2>&1 && return 0

    # Clientes paralelos nativos (Vesktop, Equibop, Legcord): o processo costuma ser o
    # binario generico do Electron (/usr/lib/electron*/electron), entao o NOME do processo
    # nao identifica nada. O cmdline de todos carrega o caminho do app.asar da pasta
    # instalada — o running_flav casa pelo nome do flav do install.
    if [ -n "${FOUND:-}" ]; then
        if [ -n "$(printf '%s\n' "$FOUND" | while IFS='|' read -r resources flav rest; do
            case "$flav" in vesktop|equibop|legcord) running_flav "$flav" && printf 'achou\n' ;; esac
        done)" ]; then
            return 0
        fi
    fi
    # Um `flatpak ps` so, e nao um por id: isto roda em laco de dois em dois segundos enquanto
    # o modo temporario espera o Discord fechar.
    if have flatpak; then
        local rodando
        rodando="$(flatpak ps --columns=application 2>/dev/null || true)"
        case "$rodando" in *com.discordapp.*|*dev.vencord.*|*app.legcord.*|*org.equicord.*) return 0 ;; esac
    fi
    return 1
}

# O cliente deste flav esta vivo? Oficiais ("discord*"): pelo NOME do processo. Paralelos
# (vesktop|equibop|legcord): o processo costuma ser o binario generico do Electron, entao o
# nome nao identifica nada — mas o cmdline de todos carrega o caminho do app.asar na pasta
# do cliente (ex.: /usr/lib/equibop/app.asar). O padrao casa "/flav/app.asar" (o main) e
# "/flav/arrpc" (o helper): nao casa o proprio script nem o shell que o invocou.
running_flav() {
    local flav="$1"
    case "$flav" in
        vesktop|equibop|legcord)
            pgrep -f "/$flav/app.asar" >/dev/null 2>&1 || pgrep -f "/$flav/arrpc" >/dev/null 2>&1
            ;;
        discord|discordptb|discordcanary)
            pgrep -x Discord >/dev/null 2>&1 || pgrep -x discord >/dev/null 2>&1 \
                || pgrep -x discordptb >/dev/null 2>&1 || pgrep -x discord-canary >/dev/null 2>&1
            ;;
        *) return 1 ;;
    esac
}

# Mata os clientes paralelos pelo caminho do app.asar: o nome do processo nao basta
# (o Electron generico nao tem o nome do cliente), mas o cmdline carrega a pasta instalada.
kill_parallel_by_path() {
    local sig="${1:-}"
    [ -n "${FOUND:-}" ] || return 0
    printf '%s\n' "$FOUND" | while IFS='|' read -r resources flav rest; do
        case "$flav" in
            vesktop|equibop|legcord)
                pkill $sig -f "/$flav/app.asar" 2>/dev/null || true
                pkill $sig -f "/$flav/arrpc" 2>/dev/null || true
                ;;
        esac
    done
    return 0
}

stop_discord() {
    discord_running || return 0
    step "Fechando o Discord"
    # Os nomes possiveis do processo do Discord em Linux: maiusculo (Windows), minusculo
    # (tar.gz/.deb/Flatpak) e os sufixos -canary/-ptb. pkill sem -x pegaria "discord" dentro
    # de outro comando (ex.: "discordctl"), entao vamos de nome exato, um por um.
    pkill -x Discord 2>/dev/null || true
    pkill -x DiscordPTB 2>/dev/null || true
    pkill -x discord 2>/dev/null || true
    pkill -x discord-canary 2>/dev/null || true
    pkill -x discordptb 2>/dev/null || true
    kill_parallel_by_path
    if have flatpak; then
        local id
        for id in $FLATPAK_IDS; do
            flatpak kill "$id" >/dev/null 2>&1 || true
        done
    fi

    local i
    for i in $(seq 1 40); do
        sleep 0.25
        discord_running || return 0
    done

    # SIGTERM nao resolveu em 10s (Discord as vezes segura o fechamento). SIGKILL e o ultimo
    # recurso: fechar a forca vale mais que travar a injecao com um processo teimoso.
    step "O Discord nao respondeu, forçando o fechamento"
    pkill -9 -x Discord 2>/dev/null || true
    pkill -9 -x DiscordPTB 2>/dev/null || true
    pkill -9 -x discord 2>/dev/null || true
    pkill -9 -x discord-canary 2>/dev/null || true
    pkill -9 -x discordptb 2>/dev/null || true
    kill_parallel_by_path -9
    for i in $(seq 1 20); do
        sleep 0.25
        discord_running || return 0
    done
    fail "O Discord nao fechou nem com SIGKILL. Feche na mao e rode de novo."
}

install_patcher() {
    [ -f "$HERE/$PATCHER_NAME" ] || fail "Nao achei $PATCHER_NAME ao lado deste script."

    mkdir -p "$INSTALL_DIR"
    cp "$HERE/$PATCHER_NAME" "$INSTALL_DIR/$PATCHER_NAME"
    ok "Bypass copiado para $INSTALL_DIR"

    # A configuracao fica fora da pasta do Discord: uma atualizacao apaga resources/ inteiro e
    # levaria a proxy do usuario junto.
    local proxy_value="$PROXY"
    if [ -z "$proxy_value" ] && [ -f "$INSTALL_DIR/settings.json" ]; then
        proxy_value="$(sed -n 's/.*"proxy"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$INSTALL_DIR/settings.json" | head -1)"
    fi

    # A barra invertida e a aspas quebrariam o JSON, e uma senha pode ter as duas. Sem escapar,
    # o arquivo sairia invalido e o bypass voltaria ao padrao em silencio.
    local proxy_json
    proxy_json="$(printf '%s' "$proxy_value" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"

    # O modo de rede (routeMode/torAddr) e escolhido no seletor da GUI e vive no mesmo
    # arquivo. Regravar sem essas chaves apagava a escolha A CADA ativacao: o runtime
    # voltava ao "auto" em silencio enquanto a GUI seguia mostrando Tor.
    local route_mode="" tor_addr=""
    if [ "$TOR_MODE" -eq 1 ]; then
        # --tor: aponta o bypass para o Tor que o proprio script instalou.
        route_mode="tor"
        tor_addr="127.0.0.1:$TOR_PORT"
    elif [ -f "$INSTALL_DIR/settings.json" ]; then
        route_mode="$(sed -n 's/.*"routeMode"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$INSTALL_DIR/settings.json" | head -1)"
        tor_addr="$(sed -n 's/.*"torAddr"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$INSTALL_DIR/settings.json" | head -1)"
    fi
    local net_keys=""
    if [ -n "$route_mode" ]; then
        net_keys="$net_keys,
    \"routeMode\": \"$route_mode\""
    fi
    if [ -n "$tor_addr" ]; then
        net_keys="$net_keys,
    \"torAddr\": \"$tor_addr\""
    fi

    cat > "$INSTALL_DIR/settings.json" <<JSON
{
    "enabled": true,
    "proxy": "$proxy_json",
    "excludedCountries": "$EXCLUDED"$net_keys
}
JSON

    # 600 porque o arquivo pode conter a senha da proxy da pessoa.
    chmod 600 "$INSTALL_DIR/settings.json" 2>/dev/null || true
    ok "Configuracao gravada em $INSTALL_DIR/settings.json"
}

# ---------------------------------------------------------------------------
# Tor embutido (installation)

tor_ready() {
    # Probe barato: quem aceita TCP na 9060 e um SOCKS de Tor (nosso, da GUI ou do sistema).
    if command -v bash >/dev/null 2>&1 && bash -c "exec 3<>/dev/tcp/127.0.0.1/$TOR_PORT" 2>/dev/null; then
        return 0
    fi
    return 1
}

# Baixa o bundle e deixa o binario pronto, se ainda nao existir. Nao sobe nada.
ensure_tor_bundle() {
    [ -x "$TOR_EXE" ] && return 0

    step "Baixando o Tor (tor-expert-bundle $TOR_BUNDLE_VERSION, ~30 MB)"
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    if have curl; then
        curl -fsSL "$TOR_URL" -o "$tmp/$TOR_TARBALL" || { warn "Falha ao baixar o Tor. Verifique sua conexao."; return 1; }
    elif have wget; then
        wget -qO- "$TOR_URL" > "$tmp/$TOR_TARBALL" || { warn "Falha ao baixar o Tor. Verifique sua conexao."; return 1; }
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

# Garante o Tor de pe na 9060. Devolve 0 se estiver pronto.
ensure_tor() {
    tor_ready && { step "Tor ja atendendo em 127.0.0.1:$TOR_PORT"; return 0; }

    have tor && step "Tor do sistema encontrado; verifica se o daemon esta de pe (porta $TOR_PORT)"

    ensure_tor_bundle || return 1

    mkdir -p "$TOR_BASE/data-state"
    cat > "$TOR_TORRC" <<EOF
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
        cat > "$HOME/.config/systemd/user/$TOR_SERVICE" <<EOF
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
            nohup "$TOR_EXE" -f "$TOR_TORRC" > "$TOR_BASE/tor.log" 2>&1 &
        }
    elif command -v systemctl >/dev/null 2>&1; then
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
            nohup "$TOR_EXE" -f "$TOR_TORRC" > "$TOR_BASE/tor.log" 2>&1 &
        }
    else
        step "systemd nao encontrado; rodando o Tor em background (nao sobrevive ao boot)"
        nohup "$TOR_EXE" -f "$TOR_TORRC" > "$TOR_BASE/tor.log" 2>&1 &
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
    # Desinstala o que este script criou. Nao apaga o binario (a GUI usa o mesmo).
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

# Devolve 1 em qualquer falha, sem matar o script (set -eu mataria o processo inteiro se
# fosse chamada sem guarda -- e com varios Discords paralelos numa mesma rodada, um so falhar
# em elevar (dialogo do polkit recusado, sem TTY, disco cheio) nao pode levar os outros junto.
# Cada passo desfaz o anterior antes de devolver, para a pasta sair como entrou.
install_injection() {
    local resources="$1"
    local patcher="$INSTALL_DIR/$PATCHER_NAME"

    if ! as_root "$resources" mv "$resources/app.asar" "$resources/_app.asar"; then
        warn "Nao consegui mover o app.asar em $resources."
        return 1
    fi

    if ! as_root "$resources" mkdir -p "$resources/app.asar"; then
        as_root "$resources" mv "$resources/_app.asar" "$resources/app.asar" || true
        warn "Nao consegui criar a pasta de injecao em $resources."
        return 1
    fi

    local tmp
    tmp="$(mktemp -d)"
    printf '%s' "$STUB_PACKAGE" > "$tmp/package.json"
    printf 'require(%s);\n' "\"$patcher\"" > "$tmp/index.js"
    if ! as_root "$resources" cp "$tmp/package.json" "$tmp/index.js" "$resources/app.asar/"; then
        rm -rf "$tmp"
        as_root "$resources" rm -rf "$resources/app.asar" || true
        as_root "$resources" mv "$resources/_app.asar" "$resources/app.asar" || true
        warn "Nao consegui copiar o carregador em $resources."
        return 1
    fi
    rm -rf "$tmp"
}

remove_injection() {
    local resources="$1"
    [ -f "$resources/_app.asar" ] || return 1

    as_root "$resources" rm -rf "$resources/app.asar"
    as_root "$resources" mv "$resources/_app.asar" "$resources/app.asar"
    return 0
}


# Reabre o Discord depois de injetar ou de desfazer. Quem tem o flatpak e um Discord nativo
# pela metade acabaria com o errado aberto: abre o mesmo que foi mexido. Recebe a linha crua
# do FOUND (path|flav|...) para abrir o binario certo do flav — injetou no Equibop, abre o
# equibop, nao "discord".
start_discord() {
    # `local a=X b=Y` em uma linha so quebra em ksh93/mksh: as atribuicoes depois da
    # primeira viram globais. Separar em linhas e' o que o POSIX manda, e o
    # `|` em ${var%%pattern} precisa de escape `\|` para ksh.
    local linha="${1:-}"
    local resources=""
    local flav=""
    local id
    local exe

    resources="${linha%%\|*}"
    [ -n "$resources" ] || return 1

    if id="$(flatpak_app_id "$resources")" && have flatpak; then
        nohup flatpak run "$id" >/dev/null 2>&1 &
        return 0
    fi

    flav="$(printf '%s' "$linha" | cut -d'|' -f2)"
    case "$flav" in
        equibop|vesktop|legcord)
            if have "$flav"; then
                nohup "$flav" >/dev/null 2>&1 &
                return 0
            fi
            ;;
    esac

    for exe in discord Discord discord-canary; do
        if have "$exe"; then
            nohup "$exe" >/dev/null 2>&1 &
            return 0
        fi
    done
}

printf '\n  %sGoLiveBypass standalone%s\n' "$C_CYAN" "$C_OFF" >&2
printf '  %sGo Live e camera de volta, direto no Discord%s\n' "$C_DIM" "$C_OFF" >&2

DISTRO="$(os_field PRETTY_NAME)"
[ -n "$DISTRO" ] || DISTRO="Linux"
printf '  %s%s%s\n\n' "$C_DIM" "$DISTRO" "$C_OFF" >&2

# ---------------------------------------------------------------------------
# Modo interativo (TUI): quando rodamos sem flags --status/--uninstall/--restore/--json
# com TTY de verdade, mostramos um menu estilo OpenCode. Com --yes ou sem TTY, o
# fluxo continua 100% por flags (comportamento atual).
if [ "$MODE" = "install" ] && st_tui_is_interactive; then
    st_choice="$(st_tui_menu "GoLiveBypass standalone" \
        "Instalar / atualizar o bypass" \
        "Ver status" \
        "Desinstalar" \
        "Sair")"
    case "$st_choice" in
        1) : ;;  # continua no fluxo de instalação abaixo
        2) MODE="status"; JSON=0 ;;
        3) MODE="uninstall" ;;
        *) printf '  %sAte mais.%s\n' "$C_DIM" "$C_OFF"; exit 0 ;;
    esac
    # Se veio de "Ver status" ou "Desinstalar", despacha abaixo (code continua).
fi

aviso_empacotado
FOUND="$(discord_dirs)"
[ -n "$FOUND" ] || fail "Nao achei nenhum Discord instalado."

if [ "$MODE" = "status" ]; then
    if [ "$JSON" -eq 1 ]; then
        # Saida maquina para a GUI: um JSON com o estado de cada Discord encontrado.
        # Formato de cada linha do FOUND: path|flavour|detected_by|flatpak_id(opcional)
        printf '{"discords":['
        first=1
        printf '%s\n' "$FOUND" | while IFS='|' read -r resources flav detect id; do
            [ "$first" -eq 1 ] || printf ','
            first=0
            running="nao"
            if running_flav "$flav"; then running="sim"; fi
            printf '{"path":"%s","state":"%s","flavour":"%s","detected_by":"%s","running":"%s"' "$resources" "$(injection_state "$resources")" "$flav" "$detect" "$running"
            if [ -n "$id" ]; then
                printf ',"flatpak_id":"%s"' "$id"
            fi
            printf '}'
        done
        printf ']}'
        printf '\n'
        exit 0
    fi
    printf '%s\n' "$FOUND" | while IFS='|' read -r resources flav detect id; do
        case "$(injection_state "$resources")" in
            vanilla)  printf '  %s (%s): sem nada instalado\n' "$resources" "$flav" >&2 ;;
            nosso)    printf '  %s (%s): com o GoLiveBypass standalone\n' "$resources" "$flav" >&2 ;;
            outromod) printf '  %s (%s): com Equicord/Vencord (ou outro mod)\n' "$resources" "$flav" >&2 ;;
        esac
    done
    [ -f "$INSTALL_DIR/golivebypass.log" ] && tail -12 "$INSTALL_DIR/golivebypass.log" >&2
    exit 0
fi

if [ "$MODE" = "uninstall" ]; then
    stop_discord
    failed=0
    # Arquivo em vez de pipe: o while dentro de um pipe roda em subshell, e o "failed"
    # nao voltaria para o pai. Com redirecionamento, o laco roda no shell principal.
    tmp="$(mktemp)"
    printf '%s\n' "$FOUND" > "$tmp"
    while IFS='|' read -r resources flav detect id; do
        if [ "$(injection_state "$resources")" != "nosso" ]; then
            warn "$resources nao tem o standalone, deixando como esta."
            continue
        fi
        if remove_injection "$resources" && [ "$(injection_state "$resources")" = "vanilla" ]; then
            ok "$resources voltou ao normal."
            if id="$(flatpak_app_id "$resources")"; then
                revoke_flatpak_access "$id" "$INSTALL_DIR"
            fi
        else
            warn "NAO consegui desinstalar de $resources — a elevacao falhou ou o arquivo esta bloqueado."
            failed=1
        fi
    done < "$tmp"
    rm -f "$tmp"

    # Nao reabrir o Discord nao-revertido: abriria com a injecao ainda no disco, e o botao
    # da GUI voltaria a "Ativo" por engano. Se nada falhou e ha um vanilla pra abrir, abre.
    if [ "$failed" -eq 0 ]; then
        remove_tor
        start_discord "$(printf '%s\n' "$FOUND" | head -1)"
        exit 0
    fi
    fail "Nao consegui desinstalar de todos — a elevacao pode ter falhado. Enviando relatorio."
fi

# Igual ao --uninstall, mas sem reabrir o Discord: usado pela GUI no boot para reverter
# uma injecao orfa de uma sessao anterior que morreu sem o quit limpo (PC desligado,
# crash). Reabrir aqui abriria o Discord de surpresa no login.
if [ "$MODE" = "restore" ]; then
    stop_discord
    printf '%s\n' "$FOUND" | while IFS='|' read -r resources flav detect id; do
        if [ "$(injection_state "$resources")" != "nosso" ]; then
            warn "$resources nao tem o standalone, deixando como esta."
            continue
        fi
        remove_injection "$resources" && ok "$resources voltou ao normal."
        if id="$(flatpak_app_id "$resources")"; then
            revoke_flatpak_access "$id" "$INSTALL_DIR"
        fi
    done
    remove_tor
    exit 0
fi

injected=0
# O while do pipe roda em subshell; o acumulador precisa ser um arquivo para o -eq valer.
lista="$(mktemp)"
tally="$(mktemp)"

# Se entramos pela TUI (instalar sem flags), pergunta a rede antes de injetar.
if [ "$MODE" = "install" ] && st_tui_is_interactive; then
    st_net="$(st_tui_menu "Como o bypass vai sair?" \
        "Tor automatico (recomendado, baixa e sobe sozinho)" \
        "Proxy gratuita (escolhida e testada sozinha)" \
        "Proxy minha (socks5://host:porta)")"
    case "$st_net" in
        2) PROXY="" ; TOR_MODE=0 ;;
        3) PROXY="$(st_tui_input "Endereco da proxy")" ; TOR_MODE=0 ;;
        *) TOR_MODE=1 ;;
    esac
fi

printf '%s\n' "$FOUND" > "$lista"
while IFS='|' read -r resources flav detect id; do
    state="$(injection_state "$resources")"
    printf '  %s (%s): %s\n' "$resources" "$flav" "$state" >&2

    if [ "$state" = "outromod" ]; then
        warn "Este Discord ja tem Equicord ou Vencord injetado."
        printf '      %sO standalone ocupa o mesmo lugar, entao instalar aqui desliga o outro mod.%s\n' "$C_DIM" "$C_OFF" >&2
        printf '      %sSe voce usa Equicord ou Vencord, prefira o plugin: ele convive com o resto.%s\n' "$C_DIM" "$C_OFF" >&2
        confirm "Substituir o mod em $resources pelo standalone?" || { warn "Deixei como estava."; continue; }
    fi

    # Vesktop, Equibop e Legcord de flatpak usam Electron 18 com zypak, que tenta ler o
    # app.asar como arquivo no bootstrap: a pasta de injecao faz o app nem abrir. O Discord
    # oficial de flatpak (Electron antigo) nao tem esse problema.
    if id="$(flatpak_app_id "$resources")" && case "$id" in dev.vencord.*|app.legcord.*|org.equicord.*) true ;; *) false ;; esac; then
        warn "Flatpak do $id: a injecao por pasta app.asar nao abre este cliente (Electron 18/zypak)."
        printf '      %sPrefira a versao nativa (pacote da distro, AUR, deb/rpm) deste cliente.%s\n' "$C_DIM" "$C_OFF" >&2
        confirm "Mesmo assim injetar em $id?" || { warn "Deixei como estava."; continue; }
    fi

    # Com --tor, prepara o daemon antes de injetar: o settings.json aponta para ele e o
    # gateway segura ate o Tor responder (o bypass nunca cai direto no modo tor).
    if [ "$TOR_MODE" -eq 1 ] && ! ensure_tor; then
        warn "O Tor nao subiu. Nao vou instalar o standalone no modo tor; tente de novo ou use --proxy."
        printf '0\n' >> "$tally"
        continue
    fi

    install_patcher

    # Antes do stop_discord de proposito: vale tanto para a injecao nova quanto para a que ja
    # estava la, que sai por baixo daqui pelo continue.
    if id="$(flatpak_app_id "$resources")"; then
        grant_flatpak_access "$id" "$INSTALL_DIR"
    fi

    stop_discord

    [ "$state" = "outromod" ] && remove_injection "$resources"
    if [ "$(injection_state "$resources")" = "nosso" ]; then
        ok "Ja estava injetado, so atualizei o bypass."
        printf '1\n' >> "$tally"
        continue
    fi

    if ! install_injection "$resources"; then
        warn "Pulei $resources -- os outros Discords encontrados continuam."
        continue
    fi
    printf '1\n' >> "$tally"
    ok "$resources pronto."
done < "$lista"
injected="$(grep -c . "$tally" || true)"
rm -f "$lista" "$tally"

# Modo portatil: reabre o Discord ja com o bypass ativo (mesmo comportamento do app do Windows).
# head -1 em vez de pipe para o while: nohup num subshell morreria junto com ele.
start_discord "$(printf '%s\n' "$FOUND" | head -1)"
if [ "$injected" -eq 0 ]; then
    # Nada foi injetado: nao reabrir (senao a GUI mostraria um "sucesso" mentiroso) e
    # falhar de verdade para o chamador enxergar.
    fail "NADA foi injetado — a elevacao falhou ou nenhum Discord foi tocado."
fi
printf '\n  %sDiscord aberto com o GoLiveBypass.%s\n' "$C_GREEN" "$C_OFF" >&2

# O updater do Discord baixa a versao nova numa pasta app-<versao> inteiramente nova, entao a
# injecao fica na pasta velha e simplesmente para de valer. Nao ha como impedir isso do lado de
# fora; avisar e o que da para fazer com honestidade.
case " $FOUND " in
    *"/app-"*)
        printf '  %sQuando o Discord se atualizar, ele cria uma pasta app-<versao> nova e a%s\n' "$C_DIM" "$C_OFF" >&2
        printf '  %sinjecao fica para tras. Rode este instalador de novo depois de atualizar.%s\n' "$C_DIM" "$C_OFF" >&2 ;;
esac

# O deploy do flatpak e refeito do zero a cada atualizacao, e a injecao mora dentro dele. Nao
# da para impedir isso de fora, e nem o proprio bypass consegue se remendar depois: dentro do
# sandbox a pasta do app e montada somente leitura. So resta avisar antes de acontecer.
case " $FOUND " in
    *"/flatpak/app/"*)
        printf '  %sEste Discord e flatpak: um "flatpak update" desfaz a injecao. Quando isso%s\n' "$C_DIM" "$C_OFF" >&2
        printf '  %sacontecer, rode este instalador de novo.%s\n' "$C_DIM" "$C_OFF" >&2 ;;
esac
printf '  %sRegistro em %s/golivebypass.log%s\n' "$C_DIM" "$INSTALL_DIR" "$C_OFF" >&2
printf '  %sPara desfazer: ./golivebypass-standalone.sh --uninstall%s\n\n' "$C_DIM" "$C_OFF" >&2
