#!/bin/sh
#
# GoLiveBypass standalone - instalador para Linux
#
# Instala direto no Discord, sem Equicord e sem Vencord. Nao precisa de Node, nem de pnpm,
# nem de git: o bypass e um arquivo .js que o proprio Discord carrega.
#
# Funciona tambem com o Discord instalado por flatpak, do sistema, do usuario ou
# pelo Nix (nixpkgs, NixOS ou nix em qualquer distro).
#
# Uso:
#   ./golivebypass-standalone.sh
#   ./golivebypass-standalone.sh --uninstall
#   ./golivebypass-standalone.sh --status
#   ./golivebypass-standalone.sh --preflight --json
#   ./golivebypass-standalone.sh --ensure-dependencies  (GUI, instala so o necessario)
#   ./golivebypass-standalone.sh --probe
#   ./golivebypass-standalone.sh --refresh-route
#   ./golivebypass-standalone.sh --refresh-route-from <profile.conf>  (GUI)
#   ./golivebypass-standalone.sh --wireguard-go <caminho>  (WireGuard de usuario; GUI/testes)
#   ./golivebypass-standalone.sh --check-update
#   ./golivebypass-standalone.sh --update

# A variante standalone/CLI esta temporariamente fora do ar durante a portabilidade
# do novo sistema WireGuard por aplicativo. O aviso aparece antes de qualquer menu ou acao.
if [ "${GOLIVE_GUI:-}" != "1" ]; then
    printf '\n[AVISO] O standalone CLI esta temporariamente indisponivel.\n' >&2
    printf '       Estamos portando o novo sistema WireGuard para esta variante.\n' >&2
    printf '       Use a GUI 2.0.0 de teste enquanto isso; ela e a variante mantida no momento.\n\n' >&2
    exit 1
fi

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
STANDALONE_VERSION="1.1.12-beta.13"
WG_CONF_CLI=""
# WireGuard de usuario (wireguard-go): caminho explicito via --wireguard-go/GOLIVE_WIREGUARD_GO.
# Sem ele o script procura ao lado de si mesmo (AppImage), na arvore de desenvolvimento e no PATH.
WIREGUARD_GO_CLI="${WIREGUARD_GO_CLI:-}"
NETNS_NAME="discord-vpn"
WG_IF="wg-discord"
NONINTERACTIVE=0
# Janela curta para o namespace/interface e o primeiro caminho WireGuard se
# acomodarem antes de o Electron do Discord iniciar o updater.
TUNNEL_STARTUP_SETTLE_SECONDS=2

# iproute2 imprime tanto "nome" quanto "nome (id: N)" em `ip netns list`.
# Comparar o primeiro campo evita rejeitar o formato sem sufixo e tambem evita
# confundir um namespace com nome apenas semelhante (ex.: discord-vpn-old).
netns_exists() {
    _glb_ip="${IP_BINARY:-}"
    [ -n "$_glb_ip" ] || _glb_ip=ip
    "$_glb_ip" netns list 2>/dev/null | awk -v name="$NETNS_NAME" '$1 == name { found=1 } END { exit !found }'
}

# ---------------------------------------------------------------------------
# Home do usuario real
#
# A home vem do ambiente, e so dele: adivinhar /home/<usuario> quebra onde a home
# mora em outro lugar (Fedora Silverblue: /var/home), e dentro de contêiner o
# passwd pode divergir da home configurada na criacao (distrobox --home). Por isso
# o script nao roda sob root: lancado com sudo, re-executa como o usuario real
# levando a home por parametro (--real-home); fases elevadas via pkexec/sudo
# repassam o mesmo parametro em vez de consultar o passwd.
_REAL_HOME=""
_prev=""
for _arg in "$@"; do
    [ "$_prev" = "--real-home" ] && _REAL_HOME="$_arg"
    _prev="$_arg"
done
_USER_HOME="${_REAL_HOME:-${HOME}}"
if [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_USER:-}" ]; then
    # Sudo comum preserva o HOME do chamador: ja e a home certa. Com sudo -i/-s o
    # sudo trocou o HOME para /root antes de o script comecar, e o -H devolve a do
    # passwd (fonte do sistema, nunca um chute do script).
    if [ "$_USER_HOME" = "/root" ]; then
        exec sudo -H -u "$SUDO_USER" -- "$SCRIPT_PATH" "$@"
    fi
    exec sudo -u "$SUDO_USER" -- "$SCRIPT_PATH" --real-home "$_USER_HOME" "$@"
fi
# Root de verdade (login como root), sem home guardada: instalar em /root era o bug.
if [ "$(id -u)" -eq 0 ] && [ -z "$_REAL_HOME" ]; then
    printf '%s\n' "Rode como seu usuario, sem sudo: o instalador precisa da sua home." >&2
    printf '%s\n' "A elevacao, quando necessaria, e pedida pelo proprio script (pkexec/sudo)." >&2
    exit 1
fi
INSTALL_DIR="${XDG_DATA_HOME:-$_USER_HOME/.local/share}/GoLiveBypass"
STUB_PACKAGE='{"name":"discord","main":"index.js","version":"1.0.0"}'
# Clientes do Discord por flatpak: os oficiais e os paralelos publicados no Flathub —
# Vesktop (dev.vencord.Vesktop), Legcord (app.legcord.Legcord) e Equibop
# (org.equicord.equibop).
FLATPAK_IDS="com.discordapp.Discord com.discordapp.DiscordPTB com.discordapp.DiscordCanary dev.vencord.Vesktop app.legcord.Legcord org.equicord.equibop"
# Clientes de flatpak SEM Electron (nenhum app.asar para achar): o tunel envelopa o
# processo do mesmo jeito. Serein (cz.viceverse.serein) e nativo em Rust.
FLATPAK_TUNEL_IDS="cz.viceverse.serein"
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
# A libevent do bundle (libevent 2.1 com evutil_secure_rng_add_bytes) nao e
# encontrada em distros recentes (Arch, Fedora 40+), e o ldd resolve o simbolo
# na libevent do sistema, que aborta o tor com status 127. Apontar
# LD_LIBRARY_PATH para a pasta do bundle resolve. Mesmo padrao da GUI Electron
# em golive-gui/electron/main.ts.
TOR_LIBDIR="$TOR_BASE/tor"
TOR_TARBALL="tor-expert-bundle-linux-x86_64-$TOR_BUNDLE_VERSION.tar.gz"
TOR_URL="https://archive.torproject.org/tor-package-archive/torbrowser/$TOR_BUNDLE_VERSION/$TOR_TARBALL"
TOR_SHA256="147158f33c5f2c539d58d8fab69ca5af384778e7bbae951fbc7ac8ca58ac4e0d"
TOR_SERVICE="golivebypass-tor.service"

MODE="install"
PROXY=""
EXCLUDED="BR"
TOR_MODE=0
NET_MODE="wireguard"
TOR_ADDR_CLI=""
CLEANUP_LEGACY=0
ASSUME_YES=0
JSON=0

STANDALONE_REPO_API="https://api.github.com/repos/bezumiya/GoLiveBypass/releases/latest"

standalone_release() {
    local json tag_raw tag payload
    if have curl; then
        json=$(curl -fsSL -H 'User-Agent: GoLiveBypass-Standalone' -H 'Accept: application/vnd.github+json' "$STANDALONE_REPO_API") || return 1
    elif have wget; then
        json=$(wget -qO- --header='User-Agent: GoLiveBypass-Standalone' "$STANDALONE_REPO_API") || return 1
    else
        return 1
    fi
    tag_raw=$(printf '%s' "$json" | grep -oE '"tag_name"[[:space:]]*:[[:space:]]*"v?[0-9][^"]*"' | head -1 | sed 's/.*"\(v\?[0-9][^"]*\)".*/\1/')
    tag=${tag_raw#v}
    payload=$(printf '%s' "$json" | grep -oE '"browser_download_url"[[:space:]]*:[[:space:]]*"[^\"]*-[0-9][^\"]*-bypass\.js"' | head -1 | sed 's/.*"\(http[^\"]*\)".*/\1/')
    # A 3a linha (tag_raw, com o "v" que o git usa de verdade) e o que da pra
    # montar uma URL raw.githubusercontent presa nessa release; a 1a linha
    # (tag, sem "v") e so para exibir/comparar versao.
    [ -n "$tag" ] && printf '%s\n%s\n%s\n' "$tag" "$payload" "$tag_raw"
}

standalone_compare_version() {
    local local_version="$1" remote_version="$2"
    local_version=${local_version#v}; remote_version=${remote_version#v}
    [ -n "$remote_version" ] || { echo 0; return; }
    [ "$local_version" = "$remote_version" ] && { echo 0; return; }
    local local_core="${local_version%%-*}" local_pre="" remote_core="${remote_version%%-*}" remote_pre=""
    case "$local_version" in *-*) local_pre="${local_version#*-}" ;; esac
    case "$remote_version" in *-*) remote_pre="${remote_version#*-}" ;; esac
    if [ "$local_core" != "$remote_core" ]; then
        [ "$(printf '%s\n%s\n' "$local_core" "$remote_core" | sort -V | head -1)" = "$remote_core" ] && echo 1 || echo -1
        return
    fi
    # Mesma versao base: um sufixo de pre-release (-beta.N) sempre conta como
    # mais antigo que a mesma base sem sufixo, nunca como um componente extra
    # (sort -V sozinho, sem separar o sufixo, tratava beta.N como mais novo).
    if [ -n "$local_pre" ] && [ -z "$remote_pre" ]; then echo -1; return; fi
    if [ -z "$local_pre" ] && [ -n "$remote_pre" ]; then echo 1; return; fi
    if [ -n "$local_pre" ] && [ -n "$remote_pre" ]; then
        [ "$(printf '%s\n%s\n' "$local_pre" "$remote_pre" | sort -V | head -1)" = "$remote_pre" ] && echo 1 || echo -1
        return
    fi
    echo 0
}

standalone_check_update() {
    local release latest payload cmp
    release="$(standalone_release 2>/dev/null || true)"
    latest="$(printf '%s' "$release" | head -1)"
    [ -n "$latest" ] || { warn 'nao consegui consultar a release estavel'; return 0; }
    cmp="$(standalone_compare_version "$STANDALONE_VERSION" "$latest")"
    printf '  standalone: v%s\n' "$STANDALONE_VERSION"
    printf '  remoto:     v%s\n' "$latest"
    case "$cmp" in
        -1) printf '  resultado:  %sha uma atualizacao%s\n' "$C_YELLOW" "$C_OFF" ;;
        0) printf '  resultado:  %sja esta atualizado%s\n' "$C_GREEN" "$C_OFF" ;;
        1) printf '  resultado:  %sversao local e mais nova%s\n' "$C_DIM" "$C_OFF" ;;
    esac
}

standalone_update() {
    local release latest payload tag_ref target tmp backup
    release="$(standalone_release 2>/dev/null || true)"
    latest="$(printf '%s' "$release" | head -1)"
    payload="$(printf '%s' "$release" | sed -n '2p')"
    tag_ref="$(printf '%s' "$release" | sed -n '3p')"
    [ -n "$latest" ] || fail 'nao consegui consultar a release estavel'
    [ "$(standalone_compare_version "$STANDALONE_VERSION" "$latest")" = "-1" ] || { ok "standalone ja esta na v$STANDALONE_VERSION"; return 0; }
    [ -n "$payload" ] || fail 'release sem asset do standalone'
    [ -n "$tag_ref" ] || fail 'release sem tag para travar o script no mesmo par'
    tmp="$(mktemp)"; backup="${SCRIPT_PATH}.bak.$(date +%Y%m%d%H%M%S)"
    step "Baixando standalone v$latest"
    # Script e payload sempre vem da MESMA tag da release: buscar o script em
    # main misturaria uma versao do script com um payload de outra release.
    local script_url="https://raw.githubusercontent.com/bezumiya/GoLiveBypass/$tag_ref/standalone/golivebypass-standalone.sh"
    if have curl; then curl -fsSL "$script_url" -o "$tmp" || { rm -f "$tmp"; fail 'download do standalone falhou'; }
    else wget -qO "$tmp" "$script_url" || { rm -f "$tmp"; fail 'download do standalone falhou'; }
    fi
    chmod +x "$tmp"
    mv "$SCRIPT_PATH" "$backup" || { rm -f "$tmp"; fail 'nao consegui criar backup do standalone'; }
    mv "$tmp" "$SCRIPT_PATH" || { mv "$backup" "$SCRIPT_PATH"; fail 'nao consegui instalar o standalone novo'; }
    if [ -f "$INSTALL_DIR/$PATCHER_NAME" ]; then
        local payload_url="$payload"
        tmp="$(mktemp)"
        if have curl; then curl -fsSL "$payload_url" -o "$tmp" || { rm -f "$tmp"; warn 'payload instalado nao foi atualizado'; return 0; }
        else wget -qO "$tmp" "$payload_url" || { rm -f "$tmp"; warn 'payload instalado nao foi atualizado'; return 0; }
        fi
        chmod +x "$tmp"; mv "$INSTALL_DIR/$PATCHER_NAME" "$INSTALL_DIR/$PATCHER_NAME.bak.$(date +%Y%m%d%H%M%S)"; mv "$tmp" "$INSTALL_DIR/$PATCHER_NAME"
    fi
    ok "standalone atualizado para v$latest (backup: $backup)"
}

C_OFF=$(printf '\033[0m'); C_CYAN=$(printf '\033[36m'); C_GREEN=$(printf '\033[32m'); C_YELLOW=$(printf '\033[33m'); C_RED=$(printf '\033[31m'); C_DIM=$(printf '\033[2m'); C_BOLD=$(printf '\033[1m')

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

BUG_API_URL="https://bugs.golivebypass.dev/bugs/v1/reports"
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
    # Identidade local: e-mails e a pasta pessoal podem aparecer em erros de sistema/logs.
    texto="$(printf '%s' "$texto" | sed -E 's/[[:alnum:]._%+-]+@[[:alnum:].-]+\.[[:alpha:]]{2,}/<email>/g')"
    texto="$(printf '%s' "$texto" | sed -E 's#/(home|var/home|Users)/[^/[:space:]]+#/\1/<usuario>#g')"
    texto="$(printf '%s' "$texto" | sed -E 's/(nome|name|usuario|username|user)[[:space:]]*([:=])[[:space:]]*[^[:space:],;]+/\1\2<usuario>/g')"
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

    # Dedupe: o mesmo erro NAO reabre issue (os reports duplos da 1.1.11 vieram
    # daqui — cada rodada do mesmo bug abria issue nova). Assinatura = titulo,
    # guardada com epoch em INSTALL_DIR/.last-report; janela de 48h.
    local sig state ultimo data
    sig="$(printf '%s' "$titulo" | sha256sum 2>/dev/null | cut -c1-16)"
    state="$INSTALL_DIR/.last-report"
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
        mkdir -p "$INSTALL_DIR" 2>/dev/null || true
        printf '%s %s\n' "$sig" "$(date +%s)" > "$state" 2>/dev/null || true
    fi

    local corpo
    corpo="$(report_sanitize "$descricao")"
    # JSON minimo: title, description, includeLogs
    local json
    json="$(printf '{"title":"%s","description":"%s","includeLogs":true}' \
        "$(printf '%s' "$titulo" | sed 's/"/\\"/g')" \
        "$(printf '%s' "$corpo" | sed 's/"/\\"/g')")"
    if have curl; then
        curl -fsS --connect-timeout 5 --max-time 20 -X POST "$BUG_API_URL" \
            -H "Authorization: Bearer $BUG_API_TOKEN" \
            -H "Content-Type: application/json" \
            -d "$json" >/dev/null 2>&1 && return 0
    elif have wget; then
        echo "$json" | wget --timeout=20 -qO- --post-data=- --header="Authorization: Bearer $BUG_API_TOKEN" --header="Content-Type: application/json" "$BUG_API_URL" >/dev/null 2>&1 && return 0
    fi
    return 1
}

# Chamada unica de report: mostra aviso e tenta enviar (sem bloquear).
report_error() {
    local titulo="$1" desc="" desc_file="${2:-/tmp/glb-report-context.txt}"
    if [ -f "$desc_file" ]; then
        desc="$(cat "$desc_file" 2>/dev/null || true)"
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
        20) printf 'space\n' ;;
        61) printf 'a\n' ;;
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

# st_tui_multi <title> <items...> → imprime os indices marcados (1..N) separados
# por espaco, ou "0" para cancelar. Multi-selecao para escolher QUAL Discord
# patchear: Espaco marca/desmarca, 'a' marca/desmarca todos, Enter confirma
# (exige >= 1), Esc cancela.
st_tui_multi() {
    local title="$1"; shift
    local n sel key i txt j pad marks marca_txt dim
    n=$#
    sel=0
    marks=""
    i=0; while [ "$i" -lt "$n" ]; do marks="${marks}0"; i=$((i+1)); done
    st_tui_mouse_on
    st_tui_hide_cursor
    st_tui_raw_begin
    st_tui_size
    local w=62
    local total_rows top margin_col margin_row r
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
            local marca antes novo
            marca="$(printf '%s' "$marks" | cut -c $((i+1)))"
            if [ "$marca" = "1" ]; then marca_txt="[x]"; dim="$ST_FG"; else marca_txt="[ ]"; dim="$ST_DIM2"; fi
            pad=""
            j=0; while [ "$j" -lt $((w-10-${#txt})) ]; do pad="${pad} "; j=$((j+1)); done
            if [ "$i" -eq "$sel" ]; then
                printf '%s│ %s%s%s %s%s%s%s%s│%s\n' "$ST_BG" "$ST_ACCENT" "$marca_txt" "$ST_RSET" "$ST_BOLD" "$txt" "$ST_RSET" "$pad" "$ST_RSET" >&2
            else
                printf '%s│ %s%s%s %s%s%s%s│%s\n' "$ST_BG" "$ST_DIM2" "$marca_txt" "$ST_RSET" "$dim" "$txt" "$ST_RSET" "$pad" "$ST_RSET" >&2
            fi
            i=$((i+1))
        done
        r=$((r+1))
        st_tui_cursor $r $margin_col
        printf '%s└%s┘%s\n' "$ST_BG" "$(printf '─%.0s' $(st_seq 1 $((w-2))))" "$ST_RSET" >&2
        r=$((r+1))
        st_tui_cursor $r $margin_col
        printf '%s  %s[↑↓] navegar · [Espaço] marcar · [a] todos · [Enter] confirmar · [Esc] cancelar%s' "$ST_BG" "$ST_DIM2" "$ST_RSET" >&2
        key="$(st_tui_getkey)"
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
    st_tui_raw_end
    st_tui_mouse_off
    st_tui_show_cursor
    if [ "$sel" -lt 0 ]; then printf '0\n'; return; fi
    local out="" j3
    j3=0; while [ "$j3" -lt "$n" ]; do
        if [ "$(printf '%s' "$marks" | cut -c $((j3+1)))" = "1" ]; then out="$out $((j3+1))"; fi
        j3=$((j3+1))
    done
    printf '%s\n' "$out"
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
        --proxy) fail "Proxy nao e mais suportada; use uma configuracao WireGuard." ;;
        --wg-conf) WG_CONF_CLI="${2:-}"; shift ;;
        --wireguard-go) WIREGUARD_GO_CLI="${2:-}"; shift ;;
        --excluded-countries) EXCLUDED="${2:-BR}"; shift ;;
        --net-mode) shift ;;
        --tor-addr|--tor) fail "Tor foi removido; use uma configuracao WireGuard." ;;
        --cleanup-legacy) CLEANUP_LEGACY=1 ;;
        # Parametro interno: home guardada quando o script re-executa a si mesmo
        # como usuario (ou em fase elevada via pkexec/sudo), para nunca adivinhar.
        --real-home) _REAL_HOME="${2:-}"; shift ;;
        --uninstall) MODE="uninstall" ;;
        --restore) MODE="restore" ;;
        --status) MODE="status" ;;
        --preflight) MODE="preflight" ;;
        --ensure-dependencies) MODE="ensure-dependencies" ;;
        --probe) MODE="probe" ;;
        # Probes disparados por watchdog nunca podem abrir zenity/kdialog,
        # pkexec ou sudo interativo. Se nao houver autorizacao ja reutilizavel,
        # falham como telemetria indisponivel e deixam a sessao intacta.
        --non-interactive) NONINTERACTIVE=1 ;;
        --refresh-route) MODE="refresh" ;;
        --refresh-route-from) MODE="refresh"; WG_CONF_CLI="${2:-}"; shift ;;
        --check-update) MODE="check-update" ;;
        --update) MODE="update" ;;
        --json) JSON=1 ;;
        -y|--yes) ASSUME_YES=1 ;;
        -h|--help) sed -n '3,15p' "$SCRIPT_PATH" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) fail "Opcao desconhecida: $1" ;;
    esac
    shift
done

# Em automacao (--yes) o report automatico nao deve spammar a API: quase sempre essas
# rodadas sao de teste/CI. Usuario de verdade sem --yes reporta.
[ "$ASSUME_YES" -eq 1 ] && REPORT_NO_AUTO=1 || REPORT_NO_AUTO=0

# PATH do processo que chama este script (app iniciado pela interface grafica, AppImage,
# sessao de usuario) nao inclui /usr/sbin em varias distros, e `modprobe`, `modinfo` e `ip`
# moram la no Debian/Ubuntu. O `command -v` dava falso negativo com o pacote instalado: a
# ativacao parava em "o comando modprobe nao esta disponivel" depois do sudo autorizado
# (relato 19/09) e o diagnostico acusava iproute2 ausente. O PATH e a primeira tentativa
# (respeita instalacao do usuario); os diretorios do sistema entram como reserva.
resolve_binary() {
    _glb_resolved="$(command -v "$1" 2>/dev/null || true)"
    if [ -n "$_glb_resolved" ]; then
        printf '%s\n' "$_glb_resolved"
        return 0
    fi
    for _glb_dir in /usr/sbin /sbin /usr/bin /bin /usr/local/sbin /usr/local/bin; do
        if [ -x "$_glb_dir/$1" ]; then
            printf '%s\n' "$_glb_dir/$1"
            return 0
        fi
    done
    return 1
}

have() { command -v "$1" >/dev/null 2>&1; }

# O sudo exige um passo que os outros binarios nao exigem. No NixOS o pacote entra no
# environment.systemPackages (/run/current-system/sw/bin/sudo, alcancado tambem por
# /usr/bin/sudo) SEM o bit setuid, e quem eleva de verdade e o wrapper de
# /run/wrappers/bin/sudo (security.wrappers). Somente o init do shell poem
# /run/wrappers/bin na frente do PATH: uma GUI aberta por .desktop ou AppImage nao passa
# por esse init, resolve o sudo sem setuid e toda operacao elevada morre com
# "must be owned by uid 0 and have the setuid bit set" antes de ler a senha. O teste
# `-u` e o do bit setuid; enquanto o PATH oferecer um sudo que eleva, o resultado e o
# mesmo de antes.
sudo_bin_resolve() {
    local _glb_sudo="" _glb_dir="" _glb_ifs_saved=""
    _glb_sudo="$(command -v sudo 2>/dev/null || true)"
    if [ -n "$_glb_sudo" ] && [ -u "$_glb_sudo" ]; then
        printf '%s\n' "$_glb_sudo"
        return 0
    fi
    # PATH sem setuid: o resto do PATH antes ...
    _glb_ifs_saved="$IFS"
    IFS=":"
    for _glb_dir in ${PATH:-}; do
        IFS="$_glb_ifs_saved"
        [ -n "$_glb_dir" ] || continue
        [ -x "$_glb_dir/sudo" ] || continue
        [ -u "$_glb_dir/sudo" ] || continue
        printf '%s\n' "$_glb_dir/sudo"
        return 0
    done
    IFS="$_glb_ifs_saved"
    # ... e depois o wrapper do NixOS, que nao esta no PATH da GUI.
    for _glb_dir in /run/wrappers/bin; do
        [ -x "$_glb_dir/sudo" ] || continue
        [ -u "$_glb_dir/sudo" ] || continue
        printf '%s\n' "$_glb_dir/sudo"
        return 0
    done
    # Nada com setuid: devolve o que o PATH resolveu (ou o nome, se nao houver) para
    # o fluxo e a mensagem de falha tratarem o caso.
    if [ -n "$_glb_sudo" ]; then
        printf '%s\n' "$_glb_sudo"
    else
        printf '%s\n' sudo
    fi
    return 0
}

IP_BINARY="$(resolve_binary ip || true)"
MODPROBE_BINARY="$(resolve_binary modprobe || true)"
MODINFO_BINARY="$(resolve_binary modinfo || true)"
SUDO_BIN="$(sudo_bin_resolve)"
# O launcher do Discord (systemd-run/ip netns + troca de usuario) resolve o `env`
# com o PATH minimo da unidade, que no NixOS nao contem o coreutils do store
# (/run/current-system/sw/bin/env): sem o caminho absoluto, sudo/runuser/setpriv
# falham com "env: comando nao encontrado" antes de o Discord nascer. Nas outras
# distros resolve para /usr/bin/env e nada muda.
ENV_BINARY="$(resolve_binary env || true)"
[ -n "$ENV_BINARY" ] || ENV_BINARY="env"

# Senha digitada numa janela (zenity/kdialog) para o sudo -S. Cacheada em arquivo
# temporario para nao repetir a pergunta a cada operacao da injecao (mv, mkdir, cp).
SUDO_PASS_FILE=""
# 1 quando o arquivo veio da janela da GUI (GOLIVE_SUDO_PASS_FILE): ele e da GUI,
# que o apaga no dispose() da operacao. O script so remove o que ele mesmo criou.
SUDO_PASS_FILE_FROM_GUI=0
SUDO_ASKPASS_HELPER=""
SUDO_ASKPASS_EVENT_FILE=""
SUDO_ASKPASS_RESULT_FILE=""
SUDO_AUTH_READY=0
SUDO_USE_CACHED_PASS=0
SUDO_PROMPT_FALLBACK_PKEXEC=0
# Tentativas de senha incorreta antes de desistir. A politica padrao do sudo
# tambem insiste tres vezes; aqui o limite vale para a janela da GUI.
GOLIVE_SUDO_PASSWORD_ATTEMPTS="${GOLIVE_SUDO_PASSWORD_ATTEMPTS:-3}"
case "${GOLIVE_SUDO_PASSWORD_ATTEMPTS:-}" in ''|*[!0-9]*|0) GOLIVE_SUDO_PASSWORD_ATTEMPTS=3 ;; esac
SUDO_PROMPT_OUTCOME="not_attempted"
ELEVATION_PROVIDER="none"
ELEVATION_RESULT="not_attempted"
ELEVATION_INPUT_STATE="not_applicable"
ELEVATION_POLKIT_NO_AGENT=0
ACTIVATION_ROLLBACK_PENDING=0
ACTIVATION_ROLLBACK_REOPEN=0
ACTIVATION_ROLLBACK_TARGET=""
ACTIVATION_NETNS_TOUCH_STARTED=0
START_DISCORD_HOST_ONLY=0
# Log do launcher da ultima abertura; a mensagem de falha da ativacao o cita.
START_DISCORD_LOG=""
WIREGUARD_TMP_CONF=""
# Executor escolhido uma vez por ativacao. O nome nunca vai para logs; uid/gid
# numericos permitem usar setpriv sem interpolar identidade em um comando shell.
RUN_USER_NAME=""
RUN_USER_UID=""
RUN_USER_GID=""
RUN_USER_METHOD="none"

# Eventos de elevacao sao encaminhados pela GUI junto com o stderr do standalone.
# A whitelist evita que uma mensagem de comando, caminho ou qualquer valor externo
# entre no diagnostico por engano. Nunca registrar senha, tamanho da senha ou stderr
# do prompt: somente estados controlados e a presenca dele.
elevation_event() {
    local event="${1:-}" detail provider result input_state
    case "$event" in
        prompt.requested|prompt.finished|prompt.unavailable|prompt.failed|sudo.cached|sudo.validation|sudo.credential_store|pkexec.invoked|pkexec.result|authorization.requested|authorization) ;;
        *) return 0 ;;
    esac

    case "${ELEVATION_PROVIDER:-none}" in
        none|root|sudo|zenity|kdialog|askpass|pkexec|tty|gui) provider="$ELEVATION_PROVIDER" ;;
        *) provider="unknown" ;;
    esac
    case "${ELEVATION_RESULT:-not_attempted}" in
        not_attempted|requested|accepted|rejected|cancelled|unavailable|failed|cached|empty|authorized) result="$ELEVATION_RESULT" ;;
        *) result="unknown" ;
    esac

    printf '[elevation] %s provider=%s result=%s' "$event" "$provider" "$result" >&2
    case "$event" in
        prompt.requested|prompt.finished|prompt.unavailable|prompt.failed)
            case "${ELEVATION_INPUT_STATE:-not_applicable}" in
                unknown|empty|nonempty|not_applicable) input_state="$ELEVATION_INPUT_STATE" ;;
                *) input_state="unknown" ;;
            esac
            printf ' input=%s' "$input_state" >&2
            ;;
    esac
    shift || true
    for detail in "$@"; do
        case "$detail" in
            phase=dialog|phase=polkit|phase=password|phase=tty|phase=pre_activation|reason=provider_missing|reason=temporary_file|reason=incorrect_password|reason=not_in_sudoers|reason=tty_required|reason=account_blocked|reason=pam_error|reason=suid_missing|reason=other|code=0|code=1|code=2|code=126|code=127|code=other|stderr=present|stderr=empty)
                printf ' %s' "$detail" >&2
                ;;
        esac
    done
    printf '\n' >&2
}

# O codigo de um processo e reduzido a um conjunto fixo antes de chegar ao log.
# Assim, nem um valor externo nem uma mensagem de erro do provedor pode ser impresso.
elevation_code_detail() {
    case "${1:-}" in
        0|1|2|126|127) printf 'code=%s' "$1" ;;
        *) printf '%s' 'code=other' ;;
    esac
}

# Os quatro SUDO_ASKPASS_* podem estar desfeitos (unset) aqui: o caminho askpass
# os remove logo apos validar e chama esta limpeza na sequencia. Sem o `:-`, o
# `set -eu` do script transformaria a limpeza em saida silenciosa — o usuario
# perderia a mensagem de falha e os eventos de elevacao.
cleanup_sudo_pass() {
    cleanup_wireguard_temp
    rollback_activation
    # O arquivo da janela da GUI pertence a ela (dispose() no fim da operacao):
    # apaga-lo aqui faria o spawn seguinte da mesma operacao pedir a senha de novo.
    if [ "${SUDO_PASS_FILE_FROM_GUI:-0}" -ne 1 ] \
        && [ -n "${SUDO_PASS_FILE:-}" ] && [ -f "${SUDO_PASS_FILE:-}" ]; then
        rm -f "${SUDO_PASS_FILE:-}" 2>/dev/null || true
    fi
    for askpass_file in "${SUDO_ASKPASS_HELPER:-}" "${SUDO_ASKPASS_EVENT_FILE:-}" "${SUDO_ASKPASS_RESULT_FILE:-}"; do
        if [ -n "$askpass_file" ] && [ -f "$askpass_file" ]; then
            rm -f "$askpass_file" 2>/dev/null || true
        fi
    done
    SUDO_PASS_FILE=""
    SUDO_PASS_FILE_FROM_GUI=0
    SUDO_ASKPASS_HELPER=""
    SUDO_ASKPASS_EVENT_FILE=""
    SUDO_ASKPASS_RESULT_FILE=""
}

cleanup_wireguard_temp() {
    if [ -n "${WIREGUARD_TMP_CONF:-}" ] && [ -f "$WIREGUARD_TMP_CONF" ]; then
        rm -f "$WIREGUARD_TMP_CONF" 2>/dev/null || true
    fi
    WIREGUARD_TMP_CONF=""
}

# Falhas depois de stop_discord nao podem deixar o cliente fechado nem um namespace
# incompleto. A reabertura de emergencia so ocorre depois de remover o namespace
# parcialmente configurado; portanto o Discord nunca e iniciado dentro de uma rota
# cuja preparacao falhou. O estado pending e limpo antes das acoes para impedir loop
# no trap se alguma limpeza tambem falhar.
rollback_activation() {
    [ "${ACTIVATION_ROLLBACK_PENDING:-0}" -eq 1 ] || return 0
    ACTIVATION_ROLLBACK_PENDING=0

    if [ "${ACTIVATION_NETNS_TOUCH_STARTED:-0}" -eq 1 ] && netns_exists; then
        warn "Rollback: removendo o namespace WireGuard incompleto."
        teardown_wireguard_netns || true
    fi

    if [ "${ACTIVATION_ROLLBACK_REOPEN:-0}" -ne 1 ] || discord_running; then
        return 0
    fi
    if netns_exists; then
        warn "Rollback: o namespace WireGuard continua ativo; nao vou iniciar o Discord fora dele."
        return 0
    fi

    if [ -n "${ACTIVATION_ROLLBACK_TARGET:-}" ]; then
        warn "Rollback: bypass nao ativado; reabrindo o Discord sem o namespace WireGuard."
        START_DISCORD_HOST_ONLY=1
        if start_discord "$ACTIVATION_ROLLBACK_TARGET" && wait_discord_started "$ACTIVATION_ROLLBACK_TARGET"; then
            warn "Rollback: Discord reaberto sem bypass; a ativacao falhou e precisa ser repetida."
        else
            warn "Rollback: nao consegui reabrir o Discord automaticamente."
        fi
        START_DISCORD_HOST_ONLY=0
    fi
    return 0
}

# O trap e instalado cedo para que uma falha durante a coleta da senha ainda
# limpe o segredo temporario. `ACTIVATION_ROLLBACK_PENDING` continua em zero ate
# depois de todas as funcoes de rollback/lancamento estarem definidas.
trap cleanup_sudo_pass EXIT INT TERM
sudo_prompt_provider() {
    if have zenity; then
        printf '%s\n' 'zenity'
    fi
    if have kdialog; then
        printf '%s\n' 'kdialog'
    fi
    return 0
}

sudo_pass_get() {
    if [ -n "$SUDO_PASS_FILE" ] && [ -f "$SUDO_PASS_FILE" ]; then
        [ "${ELEVATION_PROVIDER:-none}" = "none" ] && ELEVATION_PROVIDER="sudo"
        ELEVATION_INPUT_STATE="nonempty"
        return 0
    fi

    local pass="" provider="" providers="" prompt_error="" prompt_exit=1
    local prompt_stderr_state="empty" provider_seen=0 provider_failure=0
    SUDO_PROMPT_FALLBACK_PKEXEC=0
    SUDO_PROMPT_OUTCOME="not_attempted"
    # Senha vinda da janela da propria GUI (GOLIVE_SUDO_PASS_FILE aponta um
    # arquivo 0600 com a senha + newline). Ultimo recurso quando o sistema nao
    # tem zenity/kdialog nem agente polkit alcancavel: a GUI decide quando
    # oferecer, nunca o script por conta propria. Vazio/ilegivel cai no fluxo
    # normal; o trap de saida apaga o arquivo como qualquer senha temporaria.
    if [ "${GOLIVE_GUI:-0}" = "1" ] && [ -n "${GOLIVE_SUDO_PASS_FILE:-}" ] \
        && [ -f "$GOLIVE_SUDO_PASS_FILE" ] && [ -r "$GOLIVE_SUDO_PASS_FILE" ] \
        && [ -s "$GOLIVE_SUDO_PASS_FILE" ]; then
        SUDO_PASS_FILE="$GOLIVE_SUDO_PASS_FILE"
        SUDO_PASS_FILE_FROM_GUI=1
        ELEVATION_PROVIDER="gui"
        ELEVATION_RESULT="not_attempted"
        ELEVATION_INPUT_STATE="nonempty"
        elevation_event "prompt.requested" "phase=dialog"
        elevation_event "prompt.finished" "$(elevation_code_detail 0)" "stderr=empty"
        SUDO_PROMPT_OUTCOME="credential_received"
        return 0
    fi
    # Numa operacao da GUI (GOLIVE_SUDO_UI=1) quem pergunta e a janela do app:
    # o modal dela devolve um arquivo reaproveitado por todos os spawns da
    # operacao, enquanto zenity/kdialog/pkexec abrem um dialogo por spawn — o
    # sudo do NixOS (timestamp por tty e, sem terminal, por processo pai) nao
    # tem como lembrar a escalacao entre processos da GUI, que nao tem tty.
    # Sem arquivo da janela, o script sinaliza o mesmo evento do sistema sem
    # provedores e quem responde e a GUI; nenhum dialogo externo e aberto.
    if [ "${GOLIVE_SUDO_UI:-0}" = "1" ]; then
        ELEVATION_PROVIDER="none"
        ELEVATION_RESULT="unavailable"
        ELEVATION_INPUT_STATE="not_applicable"
        SUDO_PROMPT_FALLBACK_PKEXEC=0
        SUDO_PROMPT_OUTCOME="provider_unavailable"
        elevation_event "prompt.unavailable" "reason=provider_missing"
        return 1
    fi
    providers="$(sudo_prompt_provider 2>/dev/null || true)"
    if [ -z "$providers" ]; then
        ELEVATION_PROVIDER="none"
        ELEVATION_RESULT="unavailable"
        ELEVATION_INPUT_STATE="not_applicable"
        SUDO_PROMPT_FALLBACK_PKEXEC=1
        SUDO_PROMPT_OUTCOME="provider_unavailable"
        elevation_event "prompt.unavailable" "reason=provider_missing"
        return 1
    fi

    # A ordem e fixa e cada nome veio apenas da whitelist acima. Uma falha de
    # execucao (codigo diferente de zero) libera o proximo provedor; stderr
    # benigno com codigo 0 e entrada nao vazia continua para a validacao do sudo.
    for provider in $providers; do
        provider_seen=1
        pass=""
        prompt_exit=1
        prompt_stderr_state="empty"
        ELEVATION_PROVIDER="$provider"
        ELEVATION_RESULT="not_attempted"
        ELEVATION_INPUT_STATE="unknown"
        elevation_event "prompt.requested" "phase=dialog"
        if ! prompt_error="$(mktemp 2>/dev/null)"; then
            ELEVATION_RESULT="failed"
            ELEVATION_INPUT_STATE="not_applicable"
            elevation_event "prompt.failed" "reason=temporary_file"
            SUDO_PROMPT_OUTCOME="internal_failure"
            pass=""
            return 1
        fi
        if [ "$provider" = "zenity" ]; then
            if pass="$( (unset LD_LIBRARY_PATH LD_PRELOAD; zenity --password --title='GoLiveBypass - senha do sudo') 2>"$prompt_error")"; then
                prompt_exit=0
            else
                prompt_exit=$?
            fi
        else
            if pass="$( (unset LD_LIBRARY_PATH LD_PRELOAD; kdialog --password 'Senha do sudo (GoLiveBypass)') 2>"$prompt_error")"; then
                prompt_exit=0
            else
                prompt_exit=$?
            fi
        fi

        [ -s "$prompt_error" ] && prompt_stderr_state="present"
        rm -f "$prompt_error"

        if [ "$prompt_exit" -ne 0 ]; then
            if [ "$prompt_exit" -ne 1 ]; then
                ELEVATION_RESULT="failed"
                ELEVATION_INPUT_STATE="not_applicable"
                elevation_event "prompt.finished" "$(elevation_code_detail "$prompt_exit")" "stderr=$prompt_stderr_state"
                provider_failure=1
                SUDO_PROMPT_OUTCOME="provider_failed"
                pass=""
                continue
            fi
            ELEVATION_RESULT="cancelled"
            ELEVATION_INPUT_STATE="empty"
            SUDO_PROMPT_OUTCOME="cancelled"
            elevation_event "prompt.finished" "$(elevation_code_detail "$prompt_exit")" "stderr=$prompt_stderr_state"
            pass=""
            return 1
        fi

        if [ -z "$pass" ]; then
            ELEVATION_RESULT="empty"
            ELEVATION_INPUT_STATE="empty"
            SUDO_PROMPT_OUTCOME="empty"
            elevation_event "prompt.finished" "$(elevation_code_detail "$prompt_exit")" "stderr=$prompt_stderr_state"
            pass=""
            return 1
        fi

        # Texto retornado pelo dialogo e apenas entrada recebida; ainda nao e
        # uma autorizacao. `accepted` fica reservado ao sudo -S -k -v.
        ELEVATION_RESULT="not_attempted"
        ELEVATION_INPUT_STATE="nonempty"
        elevation_event "prompt.finished" "$(elevation_code_detail "$prompt_exit")" "stderr=$prompt_stderr_state"
        if ! SUDO_PASS_FILE="$(mktemp 2>/dev/null)"; then
            ELEVATION_RESULT="failed"
            SUDO_PROMPT_OUTCOME="internal_failure"
            elevation_event "sudo.credential_store" "reason=temporary_file" "phase=password"
            pass=""
            return 1
        fi
        if ! chmod 600 "$SUDO_PASS_FILE" 2>/dev/null || ! printf '%s\n' "$pass" > "$SUDO_PASS_FILE"; then
            cleanup_sudo_pass
            ELEVATION_RESULT="failed"
            SUDO_PROMPT_OUTCOME="internal_failure"
            elevation_event "sudo.credential_store" "reason=temporary_file" "phase=password"
            pass=""
            return 1
        fi
        # O valor deixa de ser necessario depois da escrita no arquivo temporario.
        pass=""
        SUDO_PROMPT_OUTCOME="credential_received"
        return 0
    done

    if [ "$provider_seen" -eq 1 ] && [ "$provider_failure" -eq 1 ]; then
        ELEVATION_PROVIDER="none"
        ELEVATION_RESULT="failed"
        ELEVATION_INPUT_STATE="not_applicable"
        SUDO_PROMPT_FALLBACK_PKEXEC=1
        SUDO_PROMPT_OUTCOME="provider_failed"
        return 1
    fi

    ELEVATION_PROVIDER="none"
    ELEVATION_RESULT="unavailable"
    ELEVATION_INPUT_STATE="not_applicable"
    SUDO_PROMPT_FALLBACK_PKEXEC=1
    SUDO_PROMPT_OUTCOME="provider_unavailable"
    elevation_event "prompt.unavailable" "reason=provider_missing"
    return 1
}

# O askpass do sudo e executavel somente pelo usuario (0700: owner-only, pois
# o sudo precisa executar o helper). A senha continua no arquivo separado 0600.
sudo_authenticate_askpass() {
    local askpass_status askpass_stderr askpass_result askpass_reason line
    local askpass_event_file askpass_result_file
    ELEVATION_PROVIDER="askpass"
    ELEVATION_RESULT="requested"
    ELEVATION_INPUT_STATE="unknown"
    SUDO_PASS_FILE="$(mktemp 2>/dev/null)" || {
        ELEVATION_RESULT="failed"
        ELEVATION_INPUT_STATE="not_applicable"
        elevation_event "prompt.failed" "reason=temporary_file"
        return 1
    }
    if ! chmod 600 "$SUDO_PASS_FILE"; then
        cleanup_sudo_pass
        ELEVATION_RESULT="failed"
        ELEVATION_INPUT_STATE="not_applicable"
        elevation_event "prompt.failed" "reason=temporary_file"
        return 1
    fi
    SUDO_ASKPASS_HELPER="$(mktemp 2>/dev/null)" || {
        cleanup_sudo_pass
        ELEVATION_RESULT="failed"
        ELEVATION_INPUT_STATE="not_applicable"
        elevation_event "prompt.failed" "reason=temporary_file"
        return 1
    }
    SUDO_ASKPASS_EVENT_FILE="$(mktemp 2>/dev/null)" || {
        cleanup_sudo_pass
        ELEVATION_RESULT="failed"
        ELEVATION_INPUT_STATE="not_applicable"
        elevation_event "prompt.failed" "reason=temporary_file"
        return 1
    }
    SUDO_ASKPASS_RESULT_FILE="$(mktemp 2>/dev/null)" || {
        cleanup_sudo_pass
        ELEVATION_RESULT="failed"
        ELEVATION_INPUT_STATE="not_applicable"
        elevation_event "prompt.failed" "reason=temporary_file"
        return 1
    }
    if ! cat > "$SUDO_ASKPASS_HELPER" <<'ASKPASS_HELPER'
#!/bin/sh
event_file="${SUDO_ASKPASS_EVENT_FILE:-}"
result_file="${SUDO_ASKPASS_RESULT_FILE:-}"
pass_file="${SUDO_ASKPASS_PASS_FILE:-}"
stderr_file="${SUDO_ASKPASS_HELPER}.stderr"
provider=""
pass=""
prompt_exit=1
prompt_stderr="empty"

write_result() {
    [ -n "$result_file" ] && printf '%s\n' "$1" > "$result_file"
}
write_event() {
    [ -n "$event_file" ] && printf '%s\n' "$1" >> "$event_file"
}

if command -v zenity >/dev/null 2>&1; then
    provider="zenity"
elif command -v kdialog >/dev/null 2>&1; then
    provider="kdialog"
fi
if [ -s "$result_file" ]; then
    previous_result=""
    IFS= read -r previous_result < "$result_file" || true
    if [ "$previous_result" = "nonempty" ] && [ -s "$pass_file" ]; then
        stored_pass=""
        IFS= read -r stored_pass < "$pass_file" || true
        printf '%s\n' "$stored_pass"
        exit 0
    fi
    exit 1
fi
if [ -z "$provider" ]; then
    write_result "failed"
    write_event "[elevation] prompt.unavailable provider=askpass result=unavailable input=not_applicable reason=provider_missing"
    exit 2
fi

write_event "[elevation] prompt.requested provider=askpass result=requested input=unknown phase=dialog"
rm -f "$stderr_file"
if [ "$provider" = "zenity" ]; then
    if pass="$( (unset LD_LIBRARY_PATH LD_PRELOAD; zenity --password --title='GoLiveBypass - senha do sudo') 2>"$stderr_file")"; then
        prompt_exit=0
    else
        prompt_exit=$?
    fi
else
    if pass="$( (unset LD_LIBRARY_PATH LD_PRELOAD; kdialog --password 'Senha do sudo (GoLiveBypass)') 2>"$stderr_file")"; then
        prompt_exit=0
    else
        prompt_exit=$?
    fi
fi
[ -s "$stderr_file" ] && prompt_stderr="present"
rm -f "$stderr_file"

if [ "$prompt_exit" -ne 0 ]; then
    if [ "$prompt_exit" -eq 1 ]; then
        write_result "cancelled"
        write_event "[elevation] prompt.finished provider=askpass result=cancelled input=empty code=1 stderr=$prompt_stderr"
    else
        write_result "failed"
        write_event "[elevation] prompt.finished provider=askpass result=failed input=not_applicable code=2 stderr=$prompt_stderr"
    fi
    exit "$prompt_exit"
fi
if [ -z "$pass" ]; then
    write_result "empty"
    write_event "[elevation] prompt.finished provider=askpass result=empty input=empty code=0 stderr=$prompt_stderr"
    exit 1
fi
if [ -z "$pass_file" ] || ! chmod 600 "$pass_file" || ! printf '%s\n' "$pass" > "$pass_file"; then
    write_result "failed"
    write_event "[elevation] prompt.finished provider=askpass result=failed input=not_applicable code=2 stderr=$prompt_stderr"
    exit 2
fi
write_result "nonempty"
write_event "[elevation] prompt.finished provider=askpass result=not_attempted input=nonempty code=0 stderr=$prompt_stderr"
printf '%s\n' "$pass"
exit 0
ASKPASS_HELPER
    then
        cleanup_sudo_pass
        ELEVATION_RESULT="failed"
        ELEVATION_INPUT_STATE="not_applicable"
        elevation_event "prompt.failed" "reason=temporary_file"
        return 1
    fi
    if ! chmod 700 "$SUDO_ASKPASS_HELPER"; then
        cleanup_sudo_pass
        ELEVATION_RESULT="failed"
        ELEVATION_INPUT_STATE="not_applicable"
        elevation_event "prompt.failed" "reason=temporary_file"
        return 1
    fi

    SUDO_ASKPASS_PASS_FILE="$SUDO_PASS_FILE"
    askpass_event_file="$SUDO_ASKPASS_EVENT_FILE"
    askpass_result_file="$SUDO_ASKPASS_RESULT_FILE"
    export SUDO_ASKPASS_PASS_FILE SUDO_ASKPASS_EVENT_FILE SUDO_ASKPASS_RESULT_FILE SUDO_ASKPASS_HELPER
    askpass_stderr="$(mktemp 2>/dev/null)" || {
        unset SUDO_ASKPASS_PASS_FILE SUDO_ASKPASS_EVENT_FILE SUDO_ASKPASS_RESULT_FILE SUDO_ASKPASS_HELPER
        cleanup_sudo_pass
        ELEVATION_RESULT="failed"
        ELEVATION_INPUT_STATE="not_applicable"
        elevation_event "prompt.failed" "reason=temporary_file"
        return 1
    }
    # `|| askpass_status=$?` em vez de atribuicao direta: sob `set -eu`, uma
    # atribuicao com substituicao de comando que falha derrubaria o script.
    # `askpass_stderr` guarda o CAMINHO do arquivo temporario — nao o conteudo.
    askpass_status=0
    (
        unset LD_LIBRARY_PATH LD_PRELOAD
        # Sem `-k` pelo mesmo motivo do caminho `-S`: a validacao precisa deixar
        # o ticket vivo para o resto do spawn (e para o tty, quando existe).
        SUDO_ASKPASS="$SUDO_ASKPASS_HELPER" "$SUDO_BIN" -A -v >/dev/null 2>"$askpass_stderr"
    ) || askpass_status=$?
    # A primeira linha do stderr do sudo so serve para classificar a causa; ela
    # nunca volta para o log nem para a interface.
    askpass_reason="other"
    if [ -f "$askpass_stderr" ] && [ -s "$askpass_stderr" ]; then
        IFS= read -r askpass_reason < "$askpass_stderr" || true
        askpass_reason="$(sudo_classify_failure "$askpass_reason")"
    fi
    unset SUDO_ASKPASS_PASS_FILE SUDO_ASKPASS_EVENT_FILE SUDO_ASKPASS_RESULT_FILE SUDO_ASKPASS_HELPER
    rm -f "$askpass_stderr"
    askpass_stderr=""
    if [ -f "$askpass_event_file" ]; then
        while IFS= read -r line || [ -n "$line" ]; do
            printf '%s\n' "$line" >&2
        done < "$askpass_event_file"
    fi
    askpass_result="failed"
    if [ -f "$askpass_result_file" ]; then
        IFS= read -r askpass_result < "$askpass_result_file" || true
    fi
    case "$askpass_result" in
        cancelled|empty) ELEVATION_RESULT="$askpass_result"; ELEVATION_INPUT_STATE="empty" ;;
        nonempty)
            ELEVATION_INPUT_STATE="nonempty"
            if [ "$askpass_status" -eq 0 ] && [ -s "$SUDO_PASS_FILE" ]; then
                ELEVATION_RESULT="accepted"
                elevation_event "sudo.validation" "$(elevation_code_detail 0)" "phase=password"
                SUDO_AUTH_READY=1
                SUDO_USE_CACHED_PASS=1
                return 0
            fi
            ELEVATION_RESULT="rejected"
            ;;
        *) ELEVATION_RESULT="failed"; ELEVATION_INPUT_STATE="not_applicable" ;;
    esac
    cleanup_sudo_pass
    # O motivo identificado no askpass segue a mesma whitelist do caminho -S: sem
    # isso a falha de PAM apareceria como "senha recusada" e o usuario redigitaria
    # a senha correta sem sucesso (relato no NixOS). O askpass e o ultimo recurso
    # da cadeia (sem pkexec e sem janela do zenity/kdialog): classificar e informar
    # o motivo basta, repetir o prompt aqui so alongaria uma sessao ja degradada.
    # Dialogo cancelado, vazio ou com falha tecnica nao tem motivo de sudo para
    # classificar: a linha e a mensagem anteriores se mantêm.
    if [ "$askpass_result" = "nonempty" ]; then
        elevation_event "sudo.validation" "$(elevation_code_detail "$askpass_status")" "phase=password" "reason=$askpass_reason"
        case "$askpass_reason" in
            incorrect_password)
                printf '%s\n' "Falha: a senha do sudo foi recusada. A ativacao foi cancelada sem repetir o pedido." >&2
                ;;
            not_in_sudoers)
                printf '%s\n' "Falha: o usuario $(id -un) nao tem permissao de sudo nesta maquina. Adicione o usuario ao grupo wheel (ou ao sudoers) e tente de novo; a ativacao foi cancelada." >&2
                ;;
            tty_required)
                printf '%s\n' 'Falha: a politica de sudo desta maquina exige um terminal (Defaults requiretty), que a interface grafica nao tem. Remova o requiretty do sudoers ou execute a ativacao por um terminal; a ativacao foi cancelada.' >&2
                ;;
            account_blocked)
                printf '%s\n' 'Falha: o sudo recusou a autenticacao desta conta (senha expirada, conta bloqueada ou troca de senha obrigatoria). Resolva o acesso com sudo -v em um terminal e tente de novo; a ativacao foi cancelada.' >&2
                ;;
            pam_error)
                printf '%s\n' 'Falha: o sudo nao conseguiu autenticar esta conta pelo PAM do sistema (senha expirada, conta sem senha definida ou configuração de PAM ausente — comum em instalações NixOS/contêineres enxutas). Rode "sudo -v" em um terminal para ver o motivo exato e corrija-o antes de ativar.' >&2
                ;;
            suid_missing)
                printf '%s\n' "Falha: o sudo encontrado (${SUDO_BIN}) nao tem o bit setuid e nao consegue elevar. No NixOS o sudo que funciona e o wrapper /run/wrappers/bin/sudo: o binario do systemPackages (/run/current-system/sw/bin/sudo, tambem alcancado por /usr/bin/sudo) nao tem setuid e recusa antes de ler a senha. Deixe /run/wrappers/bin na frente do PATH ou reinstale o sudo; a ativacao foi cancelada." >&2
                ;;
            *)
                printf '%s\n' 'Falha: o sudo recusou a autorizacao por um motivo nao identificado. A ativacao foi cancelada sem repetir o pedido; rode "sudo -v" em um terminal para ver o motivo real exibido pelo sudo.' >&2
                ;;
        esac
        return 1
    fi
    elevation_event "sudo.validation" "$(elevation_code_detail "$askpass_status")" "phase=password"
    return 1
}

# A mensagem do sudo e lida somente para classificar a causa da recusa; ela nunca
# volta para o log nem para a interface. O retorno e sempre um motivo conhecido da
# whitelist abaixo. Os padroes reproduzem as saidas reais do sudo 1.9, conferidas
# em container (pt_BR e en, porque o texto segue o locale da maquina):
#   sem permissao .... "Sorry, user X may not run sudo on HOST." /
#                       "X is not in the sudoers file." /
#                       "Sinto muito, usuário X não pode executar sudo em HOST." /
#                       "X não está no arquivo sudoers."
#   falta de tty ..... "sorry, you must have a tty to run sudo" / "no tty present" /
#                       "sinto mesmo, você deve ter um tty" / "nenhum tty"
#   conta/senha ...... "Account or password is expired, reset your password" /
#                       "your account has expired" / "Conta ou senha expirou"
#   senha incorreta .. "Sorry, try again." / "N incorrect password attempt(s)" /
#                       "Authentication failure" / "Sinto mesmo, tente novamente." /
#                       "N tentativa de senha incorreta" / "falha de autenticação"
#   PAM .............. "PAM account management error", "a password is required",
#                       "no password was provided" (e equivalentes em pt) — e o
#                       que sobra quando /etc/pam.d/sudo nao consegue autenticar,
#                       como no NixOS enxuto; a senha digitada nunca chega a ser testada.
#   sem setuid ........ "sudo: /run/current-system/sw/bin/sudo must be owned by uid 0
#                       and have the setuid bit set" — NixOS: o binario do
#                       systemPackages nao tem o bit; o utilizavel e o wrapper de
#                       /run/wrappers/bin/sudo. A recusa vem antes de qualquer senha.
#   conta travada ..... "sudo: account validation failure, is your account locked?"
# A ordem importa: "PAM: Authentication failure" e senha incorreta, nao falha de
# configuracao do PAM. Os padroes evitam os caracteres acentuados das mensagens
# (cada idioma/localidade acentua de um jeito) e prendem o nucleo ASCII da frase.
sudo_classify_failure() {
    case "${1:-}" in
        *"setuid"*|*"owned by uid 0"*|*"not setuid"*)
            printf '%s\n' 'suid_missing' ;;
        *"may not run sudo"*|*"executar sudo"*|*"is not in the sudoers file"*|*"not in the sudoers file"*|*"no arquivo sudoers"*|*sudoers*)
            printf '%s\n' 'not_in_sudoers' ;;
        *"you must have a tty"*|*"deve ter um tty"*|*"no tty present"*|*"no tty"*|*"terminal is required"*)
            printf '%s\n' 'tty_required' ;;
        *expir*|*"redefina sua senha"*|*"reset your password"*|*"altera"*"senha"*|*"troca de senha"*|*locked*|*bloquead*)
            printf '%s\n' 'account_blocked' ;;
        *"try again"*|*"tente novamente"*|*incorrect*|*incorret*|*"Authentication failure"*|*"falha de autentica"*)
            printf '%s\n' 'incorrect_password' ;;
        *"PAM account"*|*"gerenciamento de conta PAM"*|*"a password is required"*|*"uma senha"*"necess"*|*"no password was provided"*|*"nenhuma senha foi fornecida"*|*"unable to read password"*|*"nao foi possivel ler a senha"*|*"cannot retrieve authentication info"*|*"recuperar as informacoes de autenticacao"*|*"recuperar as informa"*)
            printf '%s\n' 'pam_error' ;;
        *) printf '%s\n' 'other' ;;
    esac
}

# Valida a senha uma unica vez na janela grafica. Algumas politicas de sudo usam
# timestamp por TTY ou timeout zero: `sudo -v` aceita a senha, mas o proximo
# `sudo -n comando` ainda a exige. Nesses casos o elevate reenvia a mesma senha
# temporaria para cada comando, sem abrir uma nova janela.
sudo_authenticate_once() {
    local sudo_status sudo_reason sudo_stderr password_attempt
    [ "$(id -u)" -eq 0 ] && return 0
    [ "$SUDO_AUTH_READY" -eq 1 ] && return 0

    if have sudo && "$SUDO_BIN" -n true 2>/dev/null; then
        ELEVATION_PROVIDER="sudo"
        ELEVATION_RESULT="cached"
        elevation_event "sudo.cached" "phase=password"
        SUDO_AUTH_READY=1
        return 0
    fi

    # Watchdog/probe e explicitamente nao-interativo: jamais cair em zenity,
    # kdialog, pkexec ou sudo -v nesse caminho.
    if [ "${NONINTERACTIVE:-0}" -eq 1 ]; then
        ELEVATION_PROVIDER="sudo"
        ELEVATION_RESULT="unavailable"
        return 1
    fi

    if have sudo && [ "${GOLIVE_GUI:-0}" = "1" ]; then
        # Senha incorreta merece nova tentativa (erro de digitacao e a causa mais
        # comum); falta de permissao, conta bloqueada ou politica de tty nao mudam
        # com outra tentativa e param na primeira recusa.
        password_attempt=0
        while :; do
            if ! sudo_pass_get; then
                # Quando o provedor grafico falhou, elevate ainda pode tentar
                # pkexec. Nao anuncie cancelamento antes desse segundo caminho;
                # para cancelamento, senha vazia ou falha sem fallback, preserve a
                # mensagem sanitizada deste fluxo.
                if [ "${SUDO_PROMPT_FALLBACK_PKEXEC:-0}" -ne 1 ]; then
                    printf '%s\n' "Falha: nao foi possivel autorizar o sudo (resultado ${ELEVATION_RESULT}). A ativacao foi cancelada sem alterar o sistema." >&2
                fi
                return 1
            fi
            # A atribuicao com substituicao de comando falha junto com o sudo sob
            # `set -eu`: sem o `||`, o script morreria aqui (sem mensagem e sem
            # eventos) em chamadas de elevate fora de contexto de condicao, como
            # `elevate ip netns add`. O status e capturado, nao ignorado.
            # Validar sem `-k`: `sudo -k -v` ignora (e descarta) o ticket, e o
            # sudo 1.9 nao grava um novo depois disso — conferido na VM
            # nixos-26.05 (1.9.17p2): `-S -k -v` aceita a senha e o `sudo -n`
            # seguinte volta a exigir senha. Sem `-k` a validacao grava o
            # ticket (tty quando ha terminal; senao o processo pai) e a
            # escalacao passa a ser lembrada enquanto a politica do sudo
            # permitir. O arquivo continua sendo reenviado a cada comando.
            sudo_stderr=""
            sudo_status=0
            sudo_stderr="$("$SUDO_BIN" -S -v < "$SUDO_PASS_FILE" 2>&1 >/dev/null)" || sudo_status=$?
            if [ "$sudo_status" -eq 0 ]; then
                sudo_stderr=""
                ELEVATION_RESULT="accepted"
                elevation_event "sudo.validation" "$(elevation_code_detail 0)" "phase=password"
                SUDO_AUTH_READY=1
                SUDO_USE_CACHED_PASS=1
                return 0
            fi
            sudo_reason="$(sudo_classify_failure "$sudo_stderr")"
            sudo_stderr=""
            cleanup_sudo_pass
            case "$sudo_reason" in
                incorrect_password)
                    ELEVATION_RESULT="rejected"
                    elevation_event "sudo.validation" "$(elevation_code_detail "$sudo_status")" "phase=password" "reason=incorrect_password"
                    # Senha da GUI: repetir aqui so revalidaria o mesmo arquivo.
                    # Quem re-pergunta e a janela, com a mensagem de erro.
                    if [ "${ELEVATION_PROVIDER:-}" = "gui" ]; then
                        printf '%s\n' "Falha: senha do sudo incorreta. Informe a senha novamente na janela." >&2
                        return 1
                    fi
                    password_attempt=$((password_attempt + 1))
                    if [ "$password_attempt" -lt "$GOLIVE_SUDO_PASSWORD_ATTEMPTS" ]; then
                        printf '%s\n' "Falha: senha do sudo incorreta. Informe a senha novamente (tentativa ${password_attempt} de ${GOLIVE_SUDO_PASSWORD_ATTEMPTS})." >&2
                        continue
                    fi
                    printf '%s\n' "Falha: a senha do sudo foi recusada em ${GOLIVE_SUDO_PASSWORD_ATTEMPTS} tentativas. A ativacao foi cancelada sem repetir o pedido." >&2
                    return 1
                    ;;
                not_in_sudoers)
                    ELEVATION_RESULT="unavailable"
                    elevation_event "sudo.validation" "$(elevation_code_detail "$sudo_status")" "phase=password" "reason=not_in_sudoers"
                    printf '%s\n' "Falha: o usuario $(id -un) nao tem permissao de sudo nesta maquina. Adicione o usuario ao grupo wheel (ou ao sudoers) e tente de novo; a ativacao foi cancelada." >&2
                    return 1
                    ;;
                tty_required)
                    ELEVATION_RESULT="unavailable"
                    elevation_event "sudo.validation" "$(elevation_code_detail "$sudo_status")" "phase=password" "reason=tty_required"
                    printf '%s\n' 'Falha: a politica de sudo desta maquina exige um terminal (Defaults requiretty), que a interface grafica nao tem. Remova o requiretty do sudoers ou execute a ativacao por um terminal; a ativacao foi cancelada.' >&2
                    return 1
                    ;;
                account_blocked)
                    ELEVATION_RESULT="unavailable"
                    elevation_event "sudo.validation" "$(elevation_code_detail "$sudo_status")" "phase=password" "reason=account_blocked"
                    printf '%s\n' 'Falha: o sudo recusou a autenticacao desta conta (senha expirada, conta bloqueada ou troca de senha obrigatoria). Resolva o acesso com sudo -v em um terminal e tente de novo; a ativacao foi cancelada.' >&2
                    return 1
                    ;;
                pam_error)
                    # Caminho comum em NixOS enxuto: o PAM do sistema nao resolve a
                    # conta (modulo/servico incompleto) e o sudo recusa antes de
                    # comparar a senha. A mensagem precisa dizer que a senha nao
                    # estava em questao, senao o usuario a redigita infinitamente.
                    ELEVATION_RESULT="unavailable"
                    elevation_event "sudo.validation" "$(elevation_code_detail "$sudo_status")" "phase=password" "reason=pam_error"
                    printf '%s\n' 'Falha: o sudo nao conseguiu autenticar esta conta pelo PAM do sistema (senha expirada, conta sem senha definida ou configuração de PAM ausente — comum em instalações NixOS/contêineres enxutas). Rode "sudo -v" em um terminal para ver o motivo exato e corrija-o antes de ativar.' >&2
                    return 1
                    ;;
                suid_missing)
                    # NixOS: o sudo do PATH e o binario do systemPackages, sem o bit
                    # setuid; quem eleva e /run/wrappers/bin/sudo, fora do PATH da GUI.
                    ELEVATION_RESULT="unavailable"
                    elevation_event "sudo.validation" "$(elevation_code_detail "$sudo_status")" "phase=password" "reason=suid_missing"
                    printf '%s\n' "Falha: o sudo encontrado (${SUDO_BIN}) nao tem o bit setuid e nao consegue elevar. No NixOS o sudo que funciona e o wrapper /run/wrappers/bin/sudo: o binario do systemPackages (/run/current-system/sw/bin/sudo, tambem alcancado por /usr/bin/sudo) nao tem setuid e recusa antes de ler a senha. Deixe /run/wrappers/bin na frente do PATH ou reinstale o sudo; a ativacao foi cancelada." >&2
                    return 1
                    ;;
                *)
                    ELEVATION_RESULT="rejected"
                    elevation_event "sudo.validation" "$(elevation_code_detail "$sudo_status")" "phase=password" "reason=other"
                    printf '%s\n' 'Falha: o sudo recusou a autorizacao por um motivo nao identificado. A ativacao foi cancelada sem repetir o pedido; rode "sudo -v" em um terminal para ver o motivo real exibido pelo sudo.' >&2
                    return 1
                    ;;
            esac
        done
    fi

    if have sudo && [ -t 0 ]; then
        ELEVATION_PROVIDER="tty"
        ELEVATION_RESULT="requested"
        elevation_event "prompt.requested" "phase=tty"
        if "$SUDO_BIN" -v; then
            ELEVATION_RESULT="accepted"
            elevation_event "sudo.validation" "$(elevation_code_detail 0)" "phase=tty"
            SUDO_AUTH_READY=1
            return 0
        else
            sudo_status=$?
        fi
        ELEVATION_RESULT="rejected"
        elevation_event "sudo.validation" "$(elevation_code_detail "$sudo_status")" "phase=tty"
        printf '%s\n' 'Falha: nao foi possivel autenticar o sudo.' >&2
        return 1
    fi

    ELEVATION_PROVIDER="sudo"
    ELEVATION_RESULT="unavailable"
    printf '%s\n' 'Falha: este ambiente nao tem uma autorizacao sudo reutilizavel (sem TTY/agente grafico).' >&2
    return 1
}

# A GUI sem zenity/kdialog nao consegue coletar a senha do sudo. Nesse caso,
# quando o polkit esta disponivel, o pkexec inicia seu proprio fluxo de autorizacao.
# O teste fica separado da autenticacao para que cancelamento, recusa ou senha
# incorreta no prompt do sudo nunca disparem um segundo fluxo sem necessidade.
sudo_has_gui_prompt() {
    have zenity || have kdialog
}

# Quando a senha veio da janela grafica, ela e reenviada silenciosamente a cada
# chamada. Comandos comuns leem somente o arquivo de senha (o ticket do sudo,
# quando existir, e usado primeiro); isso impede que um `cat` espere para sempre
# pelo stdin herdado do processo Electron destacado. `tee` e a unica chamada que
# recebe dados pelo stdin: com ticket vivo ela passa direto (`-n`), porque a
# primeira linha com a senha iria junto para o arquivo de destino; sem ticket,
# o conteudo original e anexado depois da senha como antes.
sudo_with_cached_password() {
    if [ "${1:-}" = "tee" ]; then
        if "$SUDO_BIN" -n -p '' true 2>/dev/null; then
            "$SUDO_BIN" -n -p '' "$@"
        else
            (cat "$SUDO_PASS_FILE"; cat) | "$SUDO_BIN" -S -k -p '' "$@"
        fi
    else
        "$SUDO_BIN" -S -p '' "$@" < "$SUDO_PASS_FILE"
    fi
}

pkexec_interactive() {
    local pkexec_status pkexec_code
    ELEVATION_PROVIDER="pkexec"
    ELEVATION_RESULT="requested"
    ELEVATION_INPUT_STATE="not_applicable"
    # pkexec pode usar agente grafico, TTY ou politica preautorizada; o script
    # registra apenas que o comando foi delegado ao polkit, nunca que uma janela apareceu.
    elevation_event "pkexec.invoked" "phase=polkit"
    if pkexec "$@"; then
        ELEVATION_RESULT="authorized"
        elevation_event "pkexec.result" "$(elevation_code_detail 0)" "phase=polkit"
        return 0
    else
        pkexec_status=$?
    fi
    pkexec_code="$(elevation_code_detail "$pkexec_status")"
    [ "$pkexec_status" -eq 127 ] && ELEVATION_POLKIT_NO_AGENT=1
    ELEVATION_RESULT="failed"
    elevation_event "pkexec.result" "$pkexec_code" "phase=polkit"
    return "$pkexec_status"
}

elevate() {
    local pkexec_status
    if [ "$(id -u)" -eq 0 ]; then
        "$@"
    elif have sudo; then
        if ! sudo_authenticate_once; then
            # pkexec substitui um provedor grafico que nao conseguiu iniciar
            # (ou a ausencia dele). Cancelamento, senha vazia, senha recusada,
            # falha interna e NONINTERACTIVE nunca entram neste fallback.
            if [ "${SUDO_PROMPT_FALLBACK_PKEXEC:-0}" -eq 1 ] \
                && [ "${GOLIVE_GUI:-0}" = "1" ] && [ "${NONINTERACTIVE:-0}" -ne 1 ]; then
                if have pkexec; then
                    pkexec_interactive "$@"
                    pkexec_status=$?
                    if [ "$pkexec_status" -eq 127 ]; then
                        if sudo_authenticate_askpass; then
                            sudo_with_cached_password "$@"
                            return $?
                        fi
                    fi
                    return "$pkexec_status"
                fi
                ELEVATION_POLKIT_NO_AGENT=1
                if sudo_authenticate_askpass; then
                    sudo_with_cached_password "$@"
                    return $?
                fi
            fi
            return 1
        fi
        if [ "$SUDO_USE_CACHED_PASS" -eq 1 ]; then
            sudo_with_cached_password "$@"
            return $?
        fi
        "$SUDO_BIN" -n "$@"
    elif have pkexec && [ "${GOLIVE_GUI:-0}" = "1" ] && [ "${NONINTERACTIVE:-0}" -ne 1 ]; then
        pkexec_interactive "$@"
        return $?
    else
        printf '%s\n' 'Falha: sudo nao esta instalado neste sistema.' >&2
        return 127
    fi
}


# Valida a identidade e seleciona o menor mecanismo disponivel para trocar do
# root elevado para o usuario da sessao. O comando selecionado e sempre um dos
# tres literais abaixo; nenhum valor vindo do ambiente entra em log ou em shell.
# A funcao deve ser chamada antes de fechar o Discord, para que a ausencia de
# sudo/runuser/setpriv nao deixe a sessao sem cliente aberto.
prepare_run_user() {
    local user="${1:-}" uid="" gid=""

    RUN_USER_NAME=""
    RUN_USER_UID=""
    RUN_USER_GID=""
    RUN_USER_METHOD="none"

    case "$user" in
        ''|-*|*[!A-Za-z0-9_.-]*)
            printf '%s\n' 'Falha: usuario de execucao do Discord invalido.' >&2
            return 127
            ;;
    esac
    uid="$(id -u "$user" 2>/dev/null || true)"
    gid="$(id -g "$user" 2>/dev/null || true)"
    case "$uid" in ''|*[!0-9]*) printf '%s\n' 'Falha: nao consegui resolver o usuario de execucao do Discord.' >&2; return 127 ;; esac
    case "$gid" in ''|*[!0-9]*) printf '%s\n' 'Falha: nao consegui resolver o grupo de execucao do Discord.' >&2; return 127 ;; esac

    if have sudo; then
        RUN_USER_METHOD="sudo"
    elif have runuser; then
        RUN_USER_METHOD="runuser"
    elif have setpriv; then
        RUN_USER_METHOD="setpriv"
    else
        printf '%s\n' 'Falha: nenhum executor seguro (sudo, runuser ou setpriv) esta disponivel para iniciar o Discord.' >&2
        return 127
    fi

    RUN_USER_NAME="$user"
    RUN_USER_UID="$uid"
    RUN_USER_GID="$gid"
    return 0
}

# Executa o comando dentro do namespace, aplicando a troca de usuario somente
# depois que ip netns exec ja entrou no namespace. Assim o fallback nao move o
# iproute2 para o host nem amplia o escopo do WireGuard.
run_user_netns_command() {
    local launch_mode="${1:-}"
    [ "$#" -gt 0 ] || { printf '%s\n' 'Falha: executor do Discord recebeu um modo vazio.' >&2; return 127; }
    shift
    [ "$#" -gt 0 ] || { printf '%s\n' 'Falha: executor do Discord recebeu um comando vazio.' >&2; return 127; }
    case "$launch_mode" in
        detached|background|foreground) ;;
        *) printf '%s\n' 'Falha: modo de lancamento do Discord invalido.' >&2; return 127 ;;
    esac

    case "$RUN_USER_METHOD" in
        sudo)
            case "$launch_mode" in
                detached) elevate setsid -f ip netns exec "$NETNS_NAME" "$SUDO_BIN" -u "$RUN_USER_NAME" -- "$@" ;;
                background) elevate ip netns exec "$NETNS_NAME" "$SUDO_BIN" -u "$RUN_USER_NAME" -- "$@" & return 0 ;;
                foreground) elevate ip netns exec "$NETNS_NAME" "$SUDO_BIN" -u "$RUN_USER_NAME" -- "$@" ;;
            esac
            ;;
        runuser)
            case "$launch_mode" in
                detached) elevate setsid -f ip netns exec "$NETNS_NAME" runuser -u "$RUN_USER_NAME" -- "$@" ;;
                background) elevate ip netns exec "$NETNS_NAME" runuser -u "$RUN_USER_NAME" -- "$@" & return 0 ;;
                foreground) elevate ip netns exec "$NETNS_NAME" runuser -u "$RUN_USER_NAME" -- "$@" ;;
            esac
            ;;
        setpriv)
            case "$launch_mode" in
                detached) elevate setsid -f ip netns exec "$NETNS_NAME" setpriv --reuid "$RUN_USER_UID" --regid "$RUN_USER_GID" --init-groups -- "$@" ;;
                background) elevate ip netns exec "$NETNS_NAME" setpriv --reuid "$RUN_USER_UID" --regid "$RUN_USER_GID" --init-groups -- "$@" & return 0 ;;
                foreground) elevate ip netns exec "$NETNS_NAME" setpriv --reuid "$RUN_USER_UID" --regid "$RUN_USER_GID" --init-groups -- "$@" ;;
            esac
            ;;
        *)
            printf '%s\n' 'Falha: executor seguro do Discord nao foi preparado.' >&2
            return 127
            ;;
    esac
}

# systemd-run tambem inicia como root; a troca de usuario continua depois da
# entrada no namespace e usa exatamente o mesmo metodo validado acima.
run_user_systemd_command() {
    local unit="${1:-}"
    [ "$#" -gt 0 ] || { printf '%s\n' 'Falha: unidade systemd do Discord ausente.' >&2; return 127; }
    shift
    [ "$#" -gt 0 ] || { printf '%s\n' 'Falha: executor systemd do Discord recebeu um comando vazio.' >&2; return 127; }
    case "$unit" in
        discord-vpn-[0-9]*) ;;
        *) printf '%s\n' 'Falha: unidade systemd do Discord invalida.' >&2; return 127 ;;
    esac

    case "$RUN_USER_METHOD" in
        sudo)
            elevate systemd-run --collect --unit="$unit" ip netns exec "$NETNS_NAME" "$SUDO_BIN" -u "$RUN_USER_NAME" -- "$ENV_BINARY" "$@"
            # A unidade permanece em foreground; o chamador captura sua saida:
            # sh -c 'exec "$@"' sh $target_cmd >>"$discord_log" 2>&1
            ;;
        runuser)
            elevate systemd-run --collect --unit="$unit" ip netns exec "$NETNS_NAME" runuser -u "$RUN_USER_NAME" -- "$ENV_BINARY" "$@"
            ;;
        setpriv)
            elevate systemd-run --collect --unit="$unit" ip netns exec "$NETNS_NAME" setpriv --reuid "$RUN_USER_UID" --regid "$RUN_USER_GID" --init-groups -- "$ENV_BINARY" "$@"
            ;;
        *)
            printf '%s\n' 'Falha: executor seguro do Discord nao foi preparado.' >&2
            return 127
            ;;
    esac
}

# Usado somente no rollback host-only, depois de o namespace incompleto ter
# sido removido. Mesmo esse caminho nao pode cair silenciosamente no usuario
# corrente se o processo estiver elevado.
run_user_host_command() {
    local launch_mode="${1:-}"
    [ "$#" -gt 0 ] || { printf '%s\n' 'Falha: executor host do Discord recebeu um modo vazio.' >&2; return 127; }
    shift
    [ "$#" -gt 0 ] || { printf '%s\n' 'Falha: executor host do Discord recebeu um comando vazio.' >&2; return 127; }
    case "$launch_mode" in
        detached|background|foreground) ;;
        *) printf '%s\n' 'Falha: modo de lancamento host invalido.' >&2; return 127 ;;
    esac

    # O rollback normalmente ja esta rodando como o usuario real. Nesse caso
    # nao force um novo prompt sudo apenas para voltar a abrir o mesmo cliente;
    # a disponibilidade do executor ja foi validada por prepare_run_user().
    if [ "$(id -u)" -eq "$RUN_USER_UID" ]; then
        case "$launch_mode" in
            detached) setsid -f "$@" ;;
            background) "$@" & return 0 ;;
            foreground) "$@" ;;
        esac
        return $?
    fi

    case "$RUN_USER_METHOD" in
        sudo)
            case "$launch_mode" in
                detached) setsid -f "$SUDO_BIN" -u "$RUN_USER_NAME" -- "$@" ;;
                background) "$SUDO_BIN" -u "$RUN_USER_NAME" -- "$@" & return 0 ;;
                foreground) "$SUDO_BIN" -u "$RUN_USER_NAME" -- "$@" ;;
            esac
            ;;
        runuser)
            case "$launch_mode" in
                detached) setsid -f runuser -u "$RUN_USER_NAME" -- "$@" ;;
                background) runuser -u "$RUN_USER_NAME" -- "$@" & return 0 ;;
                foreground) runuser -u "$RUN_USER_NAME" -- "$@" ;;
            esac
            ;;
        setpriv)
            case "$launch_mode" in
                detached) setsid -f setpriv --reuid "$RUN_USER_UID" --regid "$RUN_USER_GID" --init-groups -- "$@" ;;
                background) setpriv --reuid "$RUN_USER_UID" --regid "$RUN_USER_GID" --init-groups -- "$@" & return 0 ;;
                foreground) setpriv --reuid "$RUN_USER_UID" --regid "$RUN_USER_GID" --init-groups -- "$@" ;;
            esac
            ;;
        *)
            printf '%s\n' 'Falha: executor seguro do Discord nao foi preparado.' >&2
            return 127
            ;;
    esac
}

# A autorizacao acontece antes de qualquer stop_discord. Assim, um prompt ausente,
# cancelado ou recusado nao deixa o cliente do usuario fechado sem um namespace ativo.
authorize_install_elevation() {
    if [ "$(id -u)" -eq 0 ]; then
        ELEVATION_PROVIDER="root"
        ELEVATION_RESULT="authorized"
        elevation_event "authorization" "phase=pre_activation"
        return 0
    fi

    ELEVATION_INPUT_STATE="not_applicable"
    ELEVATION_RESULT="requested"
    elevation_event "authorization.requested" "phase=pre_activation"
    if elevate true; then
        ELEVATION_RESULT="authorized"
        elevation_event "authorization" "phase=pre_activation"
        return 0
    fi

    # Preserva o diagnostico especifico produzido por sudo_pass_get/pkexec.
    case "${ELEVATION_RESULT:-not_attempted}" in
        accepted|cached) ELEVATION_RESULT="failed" ;;
        rejected|cancelled|unavailable|empty|failed) ;;
        *) ELEVATION_RESULT="failed" ;;
    esac
    if [ "${ELEVATION_POLKIT_NO_AGENT:-0}" -eq 1 ]; then
        printf '%s\n' 'Falha: nao foi possivel autorizar a ativacao Linux porque nao ha agente de autenticacao polkit. Instale e inicie um agente (por exemplo, polkit-gnome ou lxqt-policykit) ou rode o standalone em um terminal com sudo.' >&2
    fi
    elevation_event "authorization" "phase=pre_activation"
    return 1
}

# Variante somente-leitura para polling automatico. Diferente de elevate(),
# esta funcao jamais solicita credenciais quando --non-interactive foi usado.
# Acoes iniciadas pelo usuario continuam usando elevate() normalmente.
elevate_readonly() {
    if [ "$(id -u)" -eq 0 ]; then
        "$@"
    elif [ "$NONINTERACTIVE" -eq 1 ]; then
        have sudo || return 1
        "$SUDO_BIN" -n "$@"
    else
        elevate "$@"
    fi
}
# ======================= WireGuard de usuario (wireguard-go)
# O modulo do kernel nao e a unica forma de existir um device WireGuard. Um kernel recem
# atualizado fica sem a arvore de modulos (/lib/modules/<release> apagada pelo gerenciador)
# ate o reinicio: `modprobe` e `ip link add type wireguard` falham e nenhuma ativacao tem
# saida. O wireguard-go cria o MESMO device TUN com o mesmo protocolo no espaco do usuario,
# sem carregar nada no kernel; o que ele exige e /dev/net/tun com o driver `tun` presente
# (embutido ou ja carregado). O `wg` de wireguard-tools fala com ele pelo socket UAPI em
# /var/run/wireguard/<interface>.sock, entao setconf/show/telemetria seguem iguais.
WIREGUARD_GO_BINARY=""
WIREGUARD_GO_SOURCE=""

wireguard_go_pid_file() { printf '%s\n' "$INSTALL_DIR/wireguard-go.pid"; }
wireguard_go_log_file() { printf '%s\n' "$INSTALL_DIR/logs/wireguard-go.log"; }

# Ordem: caminho explicito (flag/env; usado pela GUI e pelos testes) -> empacotado ao lado do
# script (AppImage: resources/extra/wireguard-go) -> arvore de desenvolvimento -> PATH
# (pacote do sistema). Um caminho explicito vale mesmo quando nao e executavel (sem cair para
# os seguintes): assim um override recusado e observavel em vez de virar modo silencioso.
resolve_wireguard_go() {
    if [ -n "$WIREGUARD_GO_BINARY" ]; then
        return 0
    fi
    local script_dir candidate
    if [ -n "${WIREGUARD_GO_CLI:-}" ]; then
        [ -x "$WIREGUARD_GO_CLI" ] || return 1
        WIREGUARD_GO_BINARY="$WIREGUARD_GO_CLI"
        WIREGUARD_GO_SOURCE="explicito"
        return 0
    fi
    if [ -n "${GOLIVE_WIREGUARD_GO:-}" ]; then
        [ -x "$GOLIVE_WIREGUARD_GO" ] || return 1
        WIREGUARD_GO_BINARY="$GOLIVE_WIREGUARD_GO"
        WIREGUARD_GO_SOURCE="explicito"
        return 0
    fi
    script_dir="$(dirname "$SCRIPT_PATH")"
    for candidate in \
        "$script_dir/../wireguard-go/wireguard-go" \
        "$script_dir/../tools/wireguard-go/build/wireguard-go"; do
        [ -n "$candidate" ] || continue
        if [ -x "$candidate" ]; then
            WIREGUARD_GO_BINARY="$candidate"
            WIREGUARD_GO_SOURCE="pacote"
            return 0
        fi
    done
    candidate="$(resolve_binary wireguard-go || true)"
    if [ -n "$candidate" ]; then
        WIREGUARD_GO_BINARY="$candidate"
        WIREGUARD_GO_SOURCE="sistema"
        return 0
    fi
    return 1
}

# /sys/class/misc/tun existe quando o driver tun esta no kernel: sem ele nem o wireguard-go
# consegue criar a interface, entao o modo de usuario nao conta como disponivel.
wireguard_tun_available() {
    [ -e /dev/net/tun ] || return 1
    [ -e /sys/class/misc/tun ] || return 1
    return 0
}

wireguard_userspace_available() {
    resolve_wireguard_go || return 1
    wireguard_tun_available || return 1
    return 0
}

# 'kernel' com o modulo carregado, 'userspace' com wireguard-go + tun, 'none' sem device
# possivel. Nunca falha: quem chama decide a mensagem.
wireguard_device_mode() {
    if wireguard_module_loaded; then
        printf 'kernel'
    elif wireguard_userspace_available; then
        printf 'userspace'
    else
        printf 'none'
    fi
    return 0
}

# Barreira da ativacao, antes de fechar o Discord: o modulo do kernel e a primeira escolha
# (nao depende de um processo a mais); sem ele o WireGuard de usuario entra no lugar. Sem
# nenhum dos dois, a ativacao para com o motivo que o kernel deu.
ensure_wireguard_device() {
    local kernel_error=""
    if kernel_error="$(ensure_wireguard_module 2>&1)"; then
        WIREGUARD_DEVICE_MODE="kernel"
        return 0
    fi
    if wireguard_userspace_available; then
        WIREGUARD_DEVICE_MODE="userspace"
        # Sem repetir o texto da tentativa do kernel: ele fala em cancelar a ativacao, o que
        # deixou de ser verdade quando o device de usuario assume.
        warn "Modulo WireGuard do kernel indisponivel; ativando com o WireGuard de usuario ($WIREGUARD_GO_BINARY)."
        return 0
    fi
    printf '%s\n' "$kernel_error" >&2
    return 1
}

# O socket UDP do daemon precisa nascer no uplink original, como o device do kernel.
# Depois movemos somente o TUN para discord-vpn: o Discord usa o tunel, enquanto o
# wireguard-go continua alcançando o peer pela rede normal. -f impede daemonizacao
# para o pidfile identificar o processo vivo que stop_wireguard_userspace encerra.
start_wireguard_userspace() {
    local pid_file log_file
    pid_file="$(wireguard_go_pid_file)"
    log_file="$(wireguard_go_log_file)"
    mkdir -p "$INSTALL_DIR/logs" 2>/dev/null || true
    stop_wireguard_userspace
    elevate rm -f "$pid_file" 2>/dev/null || true

    step "Iniciando WireGuard de usuario '$WG_IF' com uplink original"
    elevate sh -c 'echo "$$" > "$1"; shift; exec "$@"' sh "$pid_file" "$WIREGUARD_GO_BINARY" -f "$WG_IF" >>"$log_file" 2>&1 &
    # Uma unica chamada elevada espera a interface nascer: o daemon cria o device TUN
    # depois do exec, e criar o namespace tambem leva tempo.
    if ! elevate sh -c 'i=0; while [ "$i" -lt 50 ]; do ip link show "$1" >/dev/null 2>&1 && exit 0; sleep 0.2; i=$((i+1)); done; exit 1' sh "$WG_IF"; then
        stop_wireguard_userspace
        return 1
    fi
    if ! elevate ip link set "$WG_IF" netns "$NETNS_NAME"; then
        stop_wireguard_userspace
        return 1
    fi
    return 0
}

# `/proc/<pid>` no lugar de `kill -0`: o daemon roda como root e o script como usuario, e o
# kill(0) de um processo de outro dono responde EPERM (que pareceria processo morto).
wireguard_go_alive() {
    [ -n "${1:-}" ] && [ -d "/proc/$1" ]
}

stop_wireguard_userspace() {
    local pid_file pid waited
    pid_file="$(wireguard_go_pid_file)"
    [ -e "$pid_file" ] || return 0
    pid="$(cat "$pid_file" 2>/dev/null || true)"
    elevate rm -f "$pid_file" 2>/dev/null || true
    case "$pid" in
        ''|*[!0-9]*) return 0 ;;
    esac
    wireguard_go_alive "$pid" || return 0

    step "Encerrando o WireGuard de usuario (pid $pid)"
    elevate kill "$pid" 2>/dev/null || true
    waited=0
    while [ "$waited" -lt 20 ]; do
        wireguard_go_alive "$pid" || return 0
        sleep 0.1
        waited=$((waited + 1))
    done
    elevate kill -9 "$pid" 2>/dev/null || true
    return 0
}

# O preflight nao carrega o modulo: ele apenas diferencia um modulo disponivel
# no kernel de um modulo ja carregado. A ativacao interativa faz a carga depois
# da autorizacao, mas antes de fechar o Discord ou criar o namespace.
wireguard_module_loaded() {
    [ -e /sys/module/wireguard ]
}

ensure_wireguard_module() {
    if wireguard_module_loaded; then
        return 0
    fi

    if [ -z "$MODPROBE_BINARY" ]; then
        printf '%s\n' 'Falha: o comando modprobe nao esta disponivel para carregar o modulo WireGuard (instale o pacote kmod).' >&2
        return 1
    fi

    # Nunca encaminhar stderr do modprobe: caminhos do kernel e mensagens do
    # provedor de elevacao nao pertencem ao diagnostico exibido ao usuario.
    if ! elevate "$MODPROBE_BINARY" wireguard >/dev/null 2>&1; then
        printf '%s\n' 'Falha: nao foi possivel carregar o modulo WireGuard; a ativacao foi cancelada antes de fechar o Discord.' >&2
        return 1
    fi

    if wireguard_module_loaded; then
        return 0
    fi

    if [ -n "$MODINFO_BINARY" ] && "$MODINFO_BINARY" wireguard >/dev/null 2>&1; then
        printf '%s\n' 'Falha: o modulo WireGuard existe, mas o kernel nao o ativou.' >&2
    else
        printf '%s\n' 'Falha: o modulo WireGuard nao esta disponivel neste kernel.' >&2
    fi
    return 1
}

# Ler campo a campo em vez de dar source: /etc/os-release e shell valido, e um arquivo torto
# executaria comando neste script, que logo depois chama sudo.
os_field() {
    # OS_RELEASE_FILE existe para os testes; em uso normal vale /etc/os-release.
    local file="${OS_RELEASE_FILE:-/etc/os-release}"
    [ -r "$file" ] || return 0
    sed -n "s/^$1=//p" "$file" | tr -d '"' | head -1
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
    [ ! -t 0 ] && return 1
    local answer
    printf '  %s [s/N] ' "$1" >&2
    read -r answer || return 1
    case "$answer" in
        [sSyY]*) return 0 ;;
        *) return 1 ;;
    esac
}

# Emite uma instalação uma única vez. Pacotes Linux podem expor o mesmo diretório por
# /usr/lib e /usr/lib64 (ou por symlinks); sem esta guarda o preflight contava duas vezes o
# mesmo cliente e a ativação podia tentar o mesmo processo em duplicidade.
discord_emit_dir() {
    local resources="$1" flav="$2" detect="$3" flatpak_id="${4:-}" require_asar="${5:-1}"
    local target target_key

    if [ -e "$resources/app.asar" ]; then
        target="$resources/app.asar"
    elif [ -e "$resources/_app.asar" ]; then
        target="$resources/_app.asar"
    elif [ "$require_asar" -eq 0 ] && [ -d "$resources" ]; then
        # Cliente nativo sem asar (ver FLATPAK_TUNEL_IDS): o proprio diretorio de
        # deploy e a chave de dedupe; ele nunca recebe injecao.
        target="$resources"
    else
        return 1
    fi

    # inode/device deduplica symlinks e hardlinks sem depender do texto do caminho. `stat`
    # existe nas distribuições Linux suportadas; se faltar, o caminho ainda é uma chave segura.
    target_key="$target"
    if command -v stat >/dev/null 2>&1; then
        target_key="$(stat -Lc '%d:%i' "$target" 2>/dev/null || printf '%s' "$target")"
    fi
    case "$DISCORD_SEEN_TARGETS" in
        *"|$target_key|"*) return 1 ;;
    esac
    DISCORD_SEEN_TARGETS="${DISCORD_SEEN_TARGETS}|${target_key}|"

    if [ -n "$flatpak_id" ]; then
        printf '%s|%s|%s|%s\n' "$resources" "$flav" "$detect" "$flatpak_id"
    else
        printf '%s|%s|%s\n' "$resources" "$flav" "$detect"
    fi
    return 0
}

# Raizes de pacote candidatas a partir de um link do perfil. A cadeia eh resolvida
# elo a elo com readlink: cada etapa - e nao so o destino final - pode ser a que
# revela o pacote. O Discord sem FHS aponta bin/<cliente> para opt/<cliente>/<cliente>
# e o modo FHS aponta bin/<cliente> para um wrapper solto em /nix/store; achatar
# tudo com readlink -f perderia esse <out> do meio, que eh quem guarda a saida
# share. Dois pais por etapa cobrem os dois desenhos. Quando o destino final eh
# script - wrapper do modo FHS ou makeWrapper dos modos - os caminhos absolutos do
# texto tambem alimentam os candidatos (o makeWrapper embute o resources/app.asar).
# ELF nao eh lido como texto: seria caro e as etapas ja resolvem esse caso.
nix_package_roots() {
    local alvo cur nxt parent avo base saida resolv primeira tok pai bisavo q s voltas
    alvo="${1:-}"
    [ -n "$alvo" ] && [ -e "$alvo" ] || return 0
    cur="$alvo"
    voltas=0
    while [ "$voltas" -lt 8 ]; do
        voltas=$((voltas + 1))
        parent="$(dirname "$cur")"
        # O proprio link dentro do perfil nao eh raiz de pacote: o perfil so
        # reexporta paths de outros pacotes por symlinks e o seu path muda a cada
        # instalacao. A primeira volta existe para entrar na cadeia.
        if [ "$voltas" -ge 2 ]; then
            printf '%s\n' "$cur"
            avo="$(dirname "$parent")"
            bisavo="$(dirname "$avo")"
            printf '%s\n' "$parent"
            printf '%s\n' "$avo"
            printf '%s\n' "$bisavo"
            # Saida secundaria: no modo FHS o pacote encadeia o app por um
            # symlink de share (ln -s <unwrapped>/share $out/share). O wrapper
            # atual do FHS roda bwrap com um container-init e nao menciona o app
            # no texto, entao essa ponte pelo share do output eh o que alcanca o
            # opt/<cliente> real. So symlink: um share mesclado de perfil eh
            # diretorio comum e nao leva a pacote nenhum.
            for base in "$parent" "$avo"; do
                saida="$base/share"
                [ -L "$saida" ] || continue
                resolv="$(readlink -f "$saida" 2>/dev/null || printf '%s' '')"
                if [ -n "$resolv" ] && [ "$resolv" != "$saida" ]; then
                    printf '%s\n' "$resolv"
                    printf '%s\n' "$(dirname "$resolv")"
                fi
            done
        fi
        nxt="$(readlink "$cur" 2>/dev/null)" || break
        [ -n "$nxt" ] || break
        case "$nxt" in
            /*) cur="$nxt" ;;
            *) cur="$parent/$nxt" ;;
        esac
    done
    primeira=""
    IFS= read -r primeira < "$cur" 2>/dev/null || true
    [ -n "$primeira" ] || return 0
    case "$primeira" in
        "#!"*)
            q='"'
            s="'"
            tr ' \t\r' '\n' < "$cur" 2>/dev/null | while IFS= read -r tok; do
                tok="${tok%;}"
                tok="${tok%$q}"
                tok="${tok%$s}"
                case "$tok" in
                    $q/*) tok="${tok#$q}" ;;
                    $s/*) tok="${tok#$s}" ;;
                esac
                case "$tok" in
                    /*)
                        printf '%s\n' "$tok"
                        pai="${tok%/*}"
                        printf '%s\n' "$pai"
                        bisavo="${pai%/*}"
                        printf '%s\n' "$bisavo"
                        printf '%s\n' "${bisavo%/*}"
                        ;;
                esac
            done || true
            ;;
    esac
    return 0
}

# Nix/NixOS. O Discord e os modos paralelos do nixpkgs nao copiam nada para
# /usr/share, /opt ou ~/.local/share: tudo mora no /nix/store e so aparece pelos
# perfis do Nix, que linkam os outputs do pacote. ~/.nix-profile (nix profile ou
# nix-env do usuario), /etc/profiles e /run/current-system/sw (system profile do
# NixOS), os perfis do home-manager e o default do nix single-user. O Discord
# oficial no modo FHS - o padrao do nixpkgs hoje - encadeia o app por um wrapper
# para outro store path; os modos ficam em opt/<cliente> (vesktop, equibop) e
# share/lib/legcord (legcord). O store eh somente-leitura e nao ha problema: a
# injecao por pasta acabou, e o WireGuard por aplicativo envolve o processo sem
# tocar no app.asar.
discord_nix_dirs() {
    local perfil cmd roots_file pkg_root layout sub flav
    roots_file="$(mktemp 2>/dev/null || printf '%s' "${TMPDIR:-/tmp}/golive-nix-roots.$$")"
    : > "$roots_file"
    for perfil in \
        "$HOME/.nix-profile" \
        /etc/profiles \
        /run/current-system/sw \
        "/etc/profiles/per-user/$(id -un 2>/dev/null || printf '%s' "${USER:-user}")" \
        "${XDG_STATE_HOME:-$HOME/.local/state}/nix/profiles/profile" \
        /nix/var/nix/profiles/default
    do
        [ -d "$perfil" ] || continue
        for cmd in Discord DiscordPTB DiscordCanary discord discordptb discord-canary vesktop equibop legcord; do
            [ -e "$perfil/bin/$cmd" ] || continue
            nix_package_roots "$perfil/bin/$cmd" >> "$roots_file" 2>/dev/null || true
        done
    done
    sort -u "$roots_file" -o "$roots_file" 2>/dev/null || true
    while IFS= read -r pkg_root; do
        [ -n "$pkg_root" ] || continue
        for layout in opt/Discord opt/DiscordPTB opt/DiscordCanary opt/Vesktop opt/Equibop share/lib/legcord; do
            sub="$pkg_root/$layout/resources"
            [ -e "$sub/app.asar" ] || [ -e "$sub/_app.asar" ] || continue
            flav="discord"
            case "$layout" in
                *DiscordPTB*) flav="discordptb" ;;
                *DiscordCanary*) flav="discordcanary" ;;
                *Vesktop*) flav="vesktop" ;;
                *Equibop*) flav="equibop" ;;
                *legcord*) flav="legcord" ;;
            esac
            if discord_emit_dir "$sub" "$flav" "nix"; then
                count=$(( ${count:-0} + 1 ))
            fi
        done
    done < "$roots_file"
    rm -f "$roots_file"
    return 0
}

# Procura o app.asar de verdade em vez de confiar numa lista de caminhos.
#
# O ponto que quebra qualquer lista feita de memoria: desde a versao 1.0.136, de maio de 2026,
# o pacote de Linux do Discord (tar.gz, .deb, o oficial do Arch e o RPM) traz SO um bootstrap.
# O app de verdade, com o app.asar, e baixado na primeira execucao para dentro do HOME. Quem
# so olha /usr/share e /opt nao acha Discord nenhum numa instalacao atual.
discord_dirs() {
    local raiz sub base id flav detect count=0
    DISCORD_SEEN_TARGETS=""

    base="${XDG_CONFIG_HOME:-$HOME/.config}"
    detect="bootstrap"
    for sub in \
        "$base"/discord/app-*/resources \
        "$base"/discordptb/app-*/resources \
        "$base"/discordcanary/app-*/resources
    do
        [ -e "$sub/app.asar" ] || [ -e "$sub/_app.asar" ] || continue
        flav="discord"; case "$sub" in *ptb*) flav="discordptb" ;; *canary*) flav="discordcanary" ;; esac
        if discord_emit_dir "$sub" "$flav" "$detect"; then
            count=$((count + 1))
        fi
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
                if discord_emit_dir "$sub" "$flav" "$detect"; then
                    count=$((count + 1))
                fi
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
        "$HOME/.local/share/vesktop" "$HOME/.local/share/equibop" "$HOME/.local/share/legcord" \
        "$HOME/vesktop" "$HOME/equibop" "$HOME/legcord" \
        /snap/vesktop/current /snap/equibop/current /snap/legcord/current \
        /opt/vesktop/vesktop /opt/equibop/equibop /opt/legcord/legcord
    do
        [ -d "$raiz" ] || continue
        for sub in "$raiz/resources" "$raiz"; do
            if [ -e "$sub/app.asar" ] || [ -e "$sub/_app.asar" ]; then
                flav="vesktop"; case "$raiz" in *equibop*|*Equibop*) flav="equibop" ;; *legcord*|*Legcord*) flav="legcord" ;; esac
                if discord_emit_dir "$sub" "$flav" "$detect"; then
                    count=$((count + 1))
                    break
                fi
            fi
        done
    done

    # Discord "vanilla" em paths nao-padroes (snap, home direto, AppImage em /opt).
    # O standalone so roda em Discord (nao cobre Vesktop/Equibop/Legcord como vanilla),
    # mas alguns pacotes legacy do Discord (aur/discord_arch_electron) instalam em
    # /opt/discord/discord. AppImages em /opt/discord/discord. Snap em /snap/discord/current.
    for raiz in \
        /snap/discord/current /snap/discordptb/current /snap/discordcanary/current \
        "$HOME/discord" "$HOME/Discord" "$HOME/discordptb" "$HOME/DiscordPTB" \
        "$HOME/discordcanary" "$HOME/DiscordCanary" \
        /opt/discord/discord /opt/discordptb/discordptb /opt/discordcanary/discordcanary
    do
        [ -d "$raiz" ] || continue
        for sub in "$raiz/resources" "$raiz"; do
            if [ -e "$sub/app.asar" ] || [ -e "$sub/_app.asar" ]; then
                flav="discord"; case "$raiz" in *PTB*|*ptb*) flav="discordptb" ;; *Canary*|*canary*) flav="discordcanary" ;; esac
                if discord_emit_dir "$sub" "$flav" "$detect"; then
                    count=$((count + 1))
                fi
                break
            fi
        done
    done

    # AppImages portateis em ~/Apps/, ~/Applications/, ~/AppImages/, /opt/apps/.
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
                case "$sub" in
                    *equibop*) flav="equibop" ;;
                    *legcord*) flav="legcord" ;;
                    *) flav="vesktop" ;;
                esac
                if discord_emit_dir "$sub" "$flav" "paralelo"; then
                    count=$((count + 1))
                fi
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
                    if discord_emit_dir "$sub" "$flav" "$detect" "$id"; then
                        count=$((count + 1))
                    fi
                fi
            done
        done
    done

    # Flatpak de cliente nativo sem Electron: nao ha o que achar de asar, a sessao e
    # provada por `flatpak ps`. Vale como Discord instalado para preflight/ativacao.
    detect="flatpak-nativo"
    for raiz in /var/lib/flatpak/app "${XDG_DATA_HOME:-$HOME/.local/share}/flatpak/app"; do
        [ -d "$raiz" ] || continue
        for id in $FLATPAK_TUNEL_IDS; do
            [ -d "$raiz/$id/current/active/files" ] || continue
            flav="${id##*.}"
            if discord_emit_dir "$raiz/$id/current/active/files" "$flav" "$detect" "$id" 0; then
                count=$((count + 1))
            fi
        done
    done

    # O mesmo bootstrap de que fala o comentario la em cima, so que dentro do flatpak: o HOME
    # do Discord vira ~/.var/app/<id>, e o app baixado cai la. Este e do proprio usuario.
    detect="flatpak-bootstrap"
    for id in $FLATPAK_IDS; do
        for sub in "$HOME/.var/app/$id"/config/discord*/app-*/resources; do
            if [ -e "$sub/app.asar" ] || [ -e "$sub/_app.asar" ]; then
                flav="discord"; case "$id" in *Vesktop*) flav="vesktop" ;; *Legcord*) flav="legcord" ;; *equibop*) flav="equibop" ;; *PTB*) flav="discordptb" ;; *Canary*) flav="discordcanary" ;; esac
                if discord_emit_dir "$sub" "$flav" "$detect" "$id"; then
                    count=$((count + 1))
                fi
            fi
        done
    done

    discord_nix_dirs

    warn "trace: varridas 7 blocos de raizes, achei $count Discord(s)"
    return 0
}

# Fallback de alvo manual: quando a varredura nao reconhece a instalacao do cliente, a GUI
# grava em manual-target.conf o programa que o usuario escolheu entre os que estao abertos.
# O arquivo e gravavel pelo usuario, entao TODO argumento de lancamento e revalidado aqui
# antes de virar linha de alvo: nada dele chega ao shell como comando.
MANUAL_TARGET_FILE="${MANUAL_TARGET_FILE:-${INSTALL_DIR}/manual-target.conf}"

# Le o registro para MANUAL_SCHEMA/KIND/KEY/LABEL/RESOURCES e para os argumentos numerados
# (MANUAL_ARGCOUNT/ARG1..ARG4). Nao valida — quem valida e manual_target_validate, para que o
# preflight possa distinguir "nao existe" de "existe e nao serve".
manual_target_read() {
    MANUAL_PRESENT=0
    MANUAL_SCHEMA=""; MANUAL_KIND=""; MANUAL_KEY=""; MANUAL_LABEL=""; MANUAL_RESOURCES=""
    MANUAL_ARGCOUNT=0; MANUAL_ARG1=""; MANUAL_ARG2=""; MANUAL_ARG3=""; MANUAL_ARG4=""
    [ -f "$MANUAL_TARGET_FILE" ] || return 0
    MANUAL_PRESENT=1
    local linha
    while IFS= read -r linha || [ -n "$linha" ]; do
        case "$linha" in
            schema=*) MANUAL_SCHEMA="${linha#schema=}" ;;
            kind=*) MANUAL_KIND="${linha#kind=}" ;;
            key=*) MANUAL_KEY="${linha#key=}" ;;
            label=*) MANUAL_LABEL="${linha#label=}" ;;
            resources=*) MANUAL_RESOURCES="${linha#resources=}" ;;
            arg=*)
                MANUAL_ARGCOUNT=$((MANUAL_ARGCOUNT + 1))
                case "$MANUAL_ARGCOUNT" in
                    1) MANUAL_ARG1="${linha#arg=}" ;;
                    2) MANUAL_ARG2="${linha#arg=}" ;;
                    3) MANUAL_ARG3="${linha#arg=}" ;;
                    4) MANUAL_ARG4="${linha#arg=}" ;;
                esac
                ;;
        esac
    done < "$MANUAL_TARGET_FILE"
    return 0
}

# Valida o registro lido. Cada kind tem uma forma de lancamento permitida e qualquer outra e
# recusada em silencio (o preflight reporta valid=false e a ativacao segue sem o alvo).
manual_target_validate() {
    [ "$MANUAL_SCHEMA" = "1" ] || return 1
    local tab campo
    tab="$(printf '\t')"
    for campo in "$MANUAL_KEY" "$MANUAL_LABEL" "$MANUAL_RESOURCES"; do
        case "$campo" in *"$tab"*) return 1 ;; esac
    done
    case "$MANUAL_RESOURCES" in ""|/*) ;; *) return 1 ;; esac
    case "$MANUAL_KIND" in
        flatpak)
            [ "$MANUAL_ARGCOUNT" = 3 ] || return 1
            [ "$MANUAL_ARG1" = "flatpak" ] || return 1
            [ "$MANUAL_ARG2" = "run" ] || return 1
            [ "$MANUAL_ARG3" = "$MANUAL_KEY" ] || return 1
            case "$MANUAL_KEY" in
                ""|*[!A-Za-z0-9_.-]*) return 1 ;;
            esac
            ;;
        snap)
            [ "$MANUAL_ARGCOUNT" = 3 ] || return 1
            [ "$MANUAL_ARG1" = "snap" ] || return 1
            [ "$MANUAL_ARG2" = "run" ] || return 1
            [ "$MANUAL_ARG3" = "$MANUAL_KEY" ] || return 1
            case "$MANUAL_KEY" in
                ""|*[!A-Za-z0-9-]*) return 1 ;;
            esac
            ;;
        appimage|exec)
            [ "$MANUAL_ARGCOUNT" = 1 ] || return 1
            [ "$MANUAL_ARG1" = "$MANUAL_KEY" ] || return 1
            case "$MANUAL_KEY" in /*) ;; *) return 1 ;; esac
            [ -f "$MANUAL_KEY" ] || return 1
            [ -x "$MANUAL_KEY" ] || return 1
            ;;
        *) return 1 ;;
    esac
    return 0
}

# Linha de alvo no formato que o resto do script ja consome:
# resources|flav|detect[|flatpak_id]. Sai vazia quando nao ha registro valido.
manual_target_line() {
    manual_target_read
    [ "$MANUAL_PRESENT" = 1 ] || return 0
    if ! manual_target_validate; then
        warn "O programa escolhido como alvo manual nao esta mais disponivel; escolha de novo na GUI."
        return 0
    fi
    # O alvo manual nao passa por discord_emit_dir: ela exige app.asar (ou um diretorio de
    # resources) e recusaria justamente o caso deste fallback. A dedupe continua valendo
    # quando existe um caminho para comparar.
    if [ -n "$MANUAL_RESOURCES" ]; then
        local chave
        chave="|$(stat -Lc '%d:%i' "$MANUAL_RESOURCES" 2>/dev/null || printf 'sem-alvo')|"
        case "${DISCORD_SEEN_TARGETS:-}" in *"$chave"*) return 0 ;; esac
    fi
    local app_id=""
    [ "$MANUAL_KIND" = "flatpak" ] && app_id="$MANUAL_KEY"
    printf '%s|manual|manual|%s\n' "$MANUAL_RESOURCES" "$app_id"
    return 0
}

# Fragmento do preflight: "present" e o arquivo existir, "valid" e ele poder ser lancado
# agora. A GUI nunca inventa validade — ela le esta resposta.
manual_target_manual_json() {
    manual_target_read
    local valid=false
    if [ "$MANUAL_PRESENT" = 1 ] && manual_target_validate; then valid=true; fi
    local present=false
    [ "$MANUAL_PRESENT" = 1 ] && present=true
    printf ',"manual":{"present":%s,"valid":%s}' "$present" "$valid"
}

# Preflight somente leitura para a GUI. Ele existe para que uma dependencia ausente
# (em especial wireguard-tools no Arch) vire uma mensagem acionavel, em vez de um
# loop de tentativas de ativacao. Nao instala pacotes nem pede senha.
linux_preflight_json() {
    local distro id_like missing="" errors="" install="" found_count=0 first_path="" netns_ok=false kernel="unknown" elevated=false
    local kernel_running="" kernel_modules_installed=true userspace=false
    distro="$(os_field ID)"
    id_like="$(os_field ID_LIKE)"

    # command -> pacote Arch correspondente. O nome do comando e mantido no diagnostico
    # porque e o que o usuario ve no erro; o pacote torna o comando de reparo copiavel.
    if ! { have wg && wg --version >/dev/null 2>&1; }; then missing="wireguard-tools"; errors="wg (wireguard-tools)"; fi
    if ! { have ip && ip -V >/dev/null 2>&1; }; then
        [ -n "$missing" ] && missing="$missing "; missing="${missing}iproute2"
        [ -n "$errors" ] && errors="$errors,"; errors="${errors}ip (iproute2)"
    fi
    if ! { have curl && curl --version >/dev/null 2>&1; }; then
        [ -n "$missing" ] && missing="$missing "; missing="${missing}curl"
        [ -n "$errors" ] && errors="$errors,"; errors="${errors}curl"
    fi

    if [ "$(id -u)" -eq 0 ] || have sudo || have pkexec; then elevated=true; else errors="${errors}${errors:+,}elevacao (sudo ou pkexec)"; fi
    if have ip && ip netns list >/dev/null 2>&1; then netns_ok=true; else errors="${errors}${errors:+,}ip netns"; fi
    if wireguard_module_loaded; then
        kernel="loaded"
    elif [ -n "$MODINFO_BINARY" ]; then
        if "$MODINFO_BINARY" wireguard >/dev/null 2>&1; then
            kernel="available"
        else
            kernel="missing"
            errors="${errors}${errors:+,}modulo wireguard ausente"
        fi
    fi

    # Um upgrade de kernel sem reinicio deixa o kernel em execucao sem a arvore de modulos
    # dela (o gerenciador apaga /lib/modules/<versao antiga> ao instalar a nova): modinfo e
    # modprobe nao acham nada e nenhuma tentativa de ativacao tem saida sem reiniciar.
    # O relato de 24/09 chegou aqui com "modulo ausente" generico, depois de autorizar o sudo.
    if have uname; then
        kernel_running="$(uname -r 2>/dev/null || true)"
    fi
    if [ -n "$kernel_running" ] && [ ! -d "/lib/modules/$kernel_running" ]; then
        kernel_modules_installed=false
    fi

    # Sem modulo do kernel o device pode vir do WireGuard de usuario (wireguard-go + tun):
    # e o caso do kernel recem-atualizado, onde `modprobe` nunca vai funcionar até reiniciar.
    if [ "$kernel" != "loaded" ] && [ "$kernel" != "available" ]; then
        if wireguard_userspace_available; then
            userspace=true
        fi
    fi

    if [ -n "$missing" ]; then
        install="$(linux_dependency_install_command "$distro" "$id_like" "$missing" || true)"
    fi

    # discord_dirs ja foi executado pelo chamador e permanece a fonte de verdade para
    # instalacoes oficiais do Arch, bootstrap, AUR, PTB/Canary e Flatpak.
    if [ -n "${FOUND:-}" ]; then
        found_count="$(printf '%s\n' "$FOUND" | grep -c . || true)"
        first_path="$(printf '%s\n' "$FOUND" | sed -n '1p' | cut -d'|' -f1)"
    fi
    if [ "$found_count" -eq 0 ]; then errors="${errors}${errors:+,}Discord nao encontrado"; fi

    local missing_json="" error_json=""
    if [ -n "$missing" ]; then
        local item first=1
        for item in $missing; do
            [ "$first" -eq 1 ] || missing_json="$missing_json,"
            missing_json="$missing_json\"$(json_escape "$item")\""
            first=0
        done
    fi
    if [ -n "$errors" ]; then
        error_json="\"$(json_escape "$errors")\""
    fi
    local ok=true
    [ -n "$missing" ] && ok=false
    # "missing" nao e o modulo apenas descarregado: modinfo nao encontrou modulo para o kernel
    # em execucao, entao o modprobe da ativacao falharia sempre. Reprovar aqui evita pedir a
    # senha do sudo e criar namespace parcial para uma ativacao que nao tem como concluir —
    # a menos que o WireGuard de usuario (wireguard-go) esteja disponivel, que e o caso em que
    # a ativacao funciona sem o modulo.
    [ "$kernel" = "missing" ] && [ "$userspace" != true ] && ok=false
    [ "$elevated" = true ] || ok=false
    [ "$netns_ok" = true ] || ok=false
    [ "$found_count" -gt 0 ] || ok=false
    printf '{"ok":%s,"platform":"linux","distro":"%s","archLike":%s,"dependencies":{"missing":[%s],"required":["wg","ip","curl"]},"elevation":{"available":%s,"method":"%s"},"netns":{"available":%s},"kernel":{"wireguard":"%s","running":"%s","modulesInstalled":%s,"userspace":%s},"discord":{"found":%s,"count":%s,"firstPath":"%s"%s},"errors":[%s],"installCommand":"%s"}\n' \
        "$ok" "$(json_escape "${distro:-Linux}")" \
        "$(case "$distro $id_like" in *arch*) printf true ;; *) printf false ;; esac)" \
        "$missing_json" "$elevated" "$(if [ "$(id -u)" -eq 0 ]; then printf root; elif have sudo; then printf sudo; elif have pkexec; then printf pkexec; else printf none; fi)" \
        "$netns_ok" "$kernel" "$(json_escape "$kernel_running")" "$( [ "$kernel_modules_installed" = true ] && printf true || printf false )" "$userspace" "$( [ "$found_count" -gt 0 ] && printf true || printf false )" "$found_count" "$(json_escape "$first_path")" "$(manual_target_manual_json)" "$error_json" "$(json_escape "$install")"
}

# Instala somente os comandos indispensaveis que faltam para o tunel WireGuard.
# Este caminho e deliberadamente separado do preflight: --preflight continua
# somente leitura e os watchdogs nunca podem chegar aqui.
linux_dependency_plan() {
    local distro="$1" id_like="$2" need_wg="$3" need_ip="$4" need_curl="$5" args="" ip_package="iproute2"
    case "$distro $id_like" in
        *arch*) args="pacman|-S --needed --noconfirm" ;;
        *fedora*|*rhel*|*centos*) args="dnf|install -y"; ip_package="iproute" ;;
        *opensuse*|*suse*) args="zypper|--non-interactive install --no-recommends" ;;
        *debian*|*ubuntu*|*linuxmint*) args="apt-get|install -y --no-install-recommends" ;;
        *) return 2 ;;
    esac
    [ "$need_wg" -eq 1 ] && args="$args wireguard-tools"
    [ "$need_ip" -eq 1 ] && args="$args $ip_package"
    [ "$need_curl" -eq 1 ] && args="$args curl"
    printf '%s\n' "$args"
}

# Monta a sugestao exibida no preflight. Este texto e informativo: a GUI chama
# --ensure-dependencies, que usa argv fixo e a mesma lista de pacotes. A mensagem
# deixa claro o refresh de metadados exigido por cada familia sem propor upgrade
# global ou um `pacman -Sy` parcial.
linux_dependency_install_command() {
    local distro="$1" id_like="$2" missing="$3" need_wg=0 need_ip=0 need_curl=0 item
    local packages="" ip_package="iproute2" manager
    case "$distro $id_like" in
        *fedora*|*rhel*|*centos*) ip_package="iproute" ;;
    esac
    for item in $missing; do
        case "$item" in
            wireguard-tools|wg) need_wg=1 ;;
            iproute2|ip|iproute) need_ip=1 ;;
            curl) need_curl=1 ;;
        esac
    done
    [ "$need_wg" -eq 1 ] && packages="$packages wireguard-tools"
    [ "$need_ip" -eq 1 ] && packages="$packages $ip_package"
    [ "$need_curl" -eq 1 ] && packages="$packages curl"
    packages="${packages# }"
    [ -n "$packages" ] || return 0
    case "$distro $id_like" in
        *arch*)
            manager="pacman"
            ;;
        *fedora*|*rhel*|*centos*)
            manager="dnf"
            ;;
        *opensuse*|*suse*)
            manager="zypper"
            ;;
        *debian*|*ubuntu*|*linuxmint*)
            manager="apt-get"
            ;;
        *)
            printf 'Instale %s com o gerenciador de pacotes da sua distribuicao.' "$packages"
            return 0
            ;;
    esac
    case "$manager" in
        pacman) printf 'sudo pacman -S --needed %s' "$packages" ;;
        dnf) printf 'sudo dnf makecache --refresh && sudo dnf install -y --setopt=install_weak_deps=False %s' "$packages" ;;
        zypper) printf 'sudo zypper --non-interactive refresh && sudo zypper --non-interactive install --no-recommends %s' "$packages" ;;
        apt-get) printf 'sudo apt-get update && sudo apt-get install -y --no-install-recommends %s' "$packages" ;;
    esac
}

linux_ensure_dependencies() {
    local distro id_like missing="" package_manager="" package_args="" item need_wg=0 need_ip=0 need_curl=0 updates pacman_rc=0 pacman_out pacman_err
    distro="$(os_field ID)"
    id_like="$(os_field ID_LIKE)"
    if ! { have wg && wg --version >/dev/null 2>&1; }; then need_wg=1; missing="$missing wireguard-tools"; fi
    if ! { have ip && ip -V >/dev/null 2>&1; }; then need_ip=1; missing="$missing iproute2"; fi
    if ! { have curl && curl --version >/dev/null 2>&1; }; then need_curl=1; missing="$missing curl"; fi
    missing="${missing# }"
    if [ -z "$missing" ]; then
        ok "Dependencias Linux ja estao instaladas."
        return 0
    fi

    if [ -e /run/ostree-booted ] || { have rpm-ostree && [ -d /sysroot/ostree ]; }; then
        fail "Sistema imutavel OSTree detectado; instale dependencias com rpm-ostree em uma operacao propria e reinicie, sem upgrade global automatico."
    fi

    local plan
    if ! plan="$(linux_dependency_plan "$distro" "$id_like" "$need_wg" "$need_ip" "$need_curl")"; then
        fail "Dependencias ausentes ($missing); a distribuicao nao tem um instalador suportado automaticamente."
    fi
    package_manager="${plan%%|*}"
    package_args="${plan#*|}"
    case "$package_manager" in
        pacman)
            have pacman || fail "Dependencias ausentes ($missing), mas pacman nao foi encontrado."
            pacman_out="$(mktemp)"; pacman_err="$(mktemp)"
            if pacman -Qu >"$pacman_out" 2>"$pacman_err"; then :; else pacman_rc=$?; fi
            updates="$(cat "$pacman_out")"
            local pacman_message
            pacman_message="$(cat "$pacman_err")"
            rm -f "$pacman_out" "$pacman_err"
            if [ "$pacman_rc" -ne 0 ] && { [ "$pacman_rc" -ne 1 ] || [ -n "$pacman_message" ] || [ -n "$updates" ]; }; then
                fail "Nao foi possivel consultar atualizacoes pendentes do pacman; a base Arch nao sera alterada automaticamente."
            fi
            [ -z "$updates" ] || fail "Ha atualizacoes Arch pendentes; conclua a manutencao da base antes de instalar dependencias automaticamente."
            ;;
        dnf)
            have dnf || fail "Dependencias ausentes ($missing), mas dnf nao foi encontrado."
            step "Atualizando o cache do dnf"
            elevate dnf makecache --refresh || fail "Falha ao atualizar o cache do dnf; verifique a rede e tente novamente."
            ;;
        zypper)
            have zypper || fail "Dependencias ausentes ($missing), mas zypper nao foi encontrado."
            step "Atualizando os repositorios do zypper"
            elevate zypper --non-interactive refresh || fail "Falha ao atualizar os repositorios do zypper; verifique a rede e tente novamente."
            ;;
        apt-get)
            have apt-get || fail "Dependencias ausentes ($missing), mas apt-get nao foi encontrado."
            step "Atualizando os indices do apt"
            elevate apt-get update || fail "Falha ao atualizar os indices do apt; verifique a rede e tente novamente."
            ;;
    esac

    step "Instalando: $missing"
    # Nao usa -Sy nem atualiza o sistema inteiro no Arch; dnf/zypper/apt recebem
    # apenas os pacotes ausentes. O lock, cancelamento e falha de rede sobem como
    # erro e impedem a ativacao seguinte.
    # shellcheck disable=SC2086
    elevate "$package_manager" $package_args || fail "Falha ao instalar dependencias Linux ($package_manager)."

    { have wg && wg --version >/dev/null 2>&1; } || fail "A instalacao terminou, mas o comando 'wg' continua ausente ou inutilizavel."
    { have ip && ip -V >/dev/null 2>&1; } || fail "A instalacao terminou, mas o comando 'ip' continua ausente ou inutilizavel."
    { have curl && curl --version >/dev/null 2>&1; } || fail "A instalacao terminou, mas o comando 'curl' continua ausente ou inutilizavel."
    ok "Dependencias Linux instaladas e verificadas."
}

# O id do flatpak a que um caminho pertence, ou nada se o caminho nao for de flatpak.
flatpak_app_id() {
    local parte
    for parte in $(printf '%s\n' "${1:-}" | tr '/' '\n'); do
        case "$parte" in com.discordapp.*|dev.vencord.*|app.legcord.*|org.equicord.*|cz.viceverse.*) printf '%s\n' "$parte"; return 0 ;; esac
    done
    return 1
}

# O processo principal de um Flatpak pode ficar escondido pelo namespace de PID do
# bubblewrap. `pgrep -x Discord` nem sempre o encontra, embora o launcher já tenha
# criado a sessão. O `flatpak ps` consulta o supervisor da sessão do usuário e é a
# fonte de verdade para o reconhecimento do cliente nesse caso.
flatpak_running_id() {
    local wanted="${1:-}"
    [ -n "$wanted" ] && have flatpak || return 1
    flatpak ps --columns=application 2>/dev/null \
        | awk -v wanted="$wanted" '$0 == wanted { found=1; exit } END { exit found ? 0 : 1 }'
}

# Normaliza sequencias decimais para que zero/zeros iniciais nunca sejam passados a kill.

normalize_pid() {
    local pid="${1:-}"
    case "$pid" in ''|*[!0-9]*) return 1 ;; esac
    while [ "${pid#0}" != "$pid" ]; do pid="${pid#0}"; done
    [ -n "$pid" ] || return 1
    printf '%s\n' "$pid"
}

# Retorna o PID do processo dentro do sandbox. O child-pid é preferido porque é o
# processo que herda o namespace de rede; o wrapper fica no host em alguns runtimes.

flatpak_pid_for_id() {
    local wanted="${1:-}" pid="" columns
    [ -n "$wanted" ] && have flatpak || return 1
    # `child-pid` existe nas versões atuais; o PID do wrapper é um fallback para
    # instalações Flatpak mais antigas que ainda não expõem essa coluna.
    for columns in child-pid pid; do
        pid="$(flatpak ps --columns="$columns,application" 2>/dev/null \
            | awk -v wanted="$wanted" '$2 == wanted { print $1; exit }')"
        pid="$(normalize_pid "$pid" 2>/dev/null)" || continue
        [ -n "$pid" ] || continue
        printf '%s\n' "$pid"
        return 0
    done
    return 1
}

# IDs da lista suportada que o `flatpak ps` mostra em execucao agora. O ID exato e a
# chave que o `flatpak kill` aceita e o unico sinal que alcanca o cliente dentro do
# sandbox do bubblewrap: pkill por nome no host nao encerra a sessao registrada e a
# ativacao ficava presa no "SIGKILL nao matou" sem dizer qual ID sobrou (#327).
flatpak_ids_em_execucao() {
    local id
    have flatpak || return 0
    for id in $FLATPAK_IDS $FLATPAK_TUNEL_IDS; do
        flatpak_running_id "$id" && printf '%s\n' "$id"
    done
    return 0
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
    if netns_exists; then
        printf 'nosso\n'
        return 0
    fi
    [ -f "$resources/_app.asar" ] || { printf 'vanilla\n'; return 0; }

    if [ -f "$resources/app.asar/index.js" ] && grep -qF "$PATCHER_NAME" "$resources/app.asar/index.js" 2>/dev/null; then
        printf 'nosso\n'
    else
        printf 'outromod\n'
    fi
    return 0
}

# So olha o conteudo do app.asar, ignorando se o netns ja esta de pe -- ao contrario de
# injection_state() (que responde "nosso" so por o tunel estar ativo), usada para QUALQUER
# decisao de apagar _app.asar. Sem isto, Vencord/Equicord instalado DEPOIS do tunel ja
# ativo seria confundido com nossa injecao legada e apagado na proxima ativacao/desativacao.
asar_is_ours() {
    local resources="$1"
    [ -f "$resources/_app.asar" ] || return 1
    [ -f "$resources/app.asar/index.js" ] && grep -qF "$PATCHER_NAME" "$resources/app.asar/index.js" 2>/dev/null
}

# Handshake e trafego do peer WireGuard dentro do namespace, para o --status --json. Motivo de
# existir: pos-migracao pra WireGuard, "Discord carregando infinito" e mais provavel de ser
# tunel morto ou saturado (endpoint gratuito compartilhado) do que o gateway zumbi do proxy
# legado -- e sem isto nao havia NENHUM jeito de diferenciar os dois num report. Handshake mais
# velho que ~180s (folga ampla sobre o PersistentKeepalive=10 dos perfis gerados pelo helper;
# perfis legados/customizados podem usar outro valor) com o namespace de pe e o sinal mais
# direto de tunel morto ou endpoint inalcancavel.
#
# So leitura (nunca falha fechado): sem privilegio ou sem namespace, devolve ok:false com o
# motivo em vez de travar o --status inteiro -- os passos que de fato mudam algo (elevate) tem
# a propria guarda em outro lugar.
wg_stats_json() {
    if ! netns_exists; then
        printf '{"ok":false,"error":"namespace inativo"}'
        return 0
    fi
    local dump
    if [ "$(id -u)" -eq 0 ]; then
        dump="$(ip netns exec "$NETNS_NAME" wg show "$WG_IF" dump 2>/dev/null)"
    # Durante a ativacao a senha pode ter sido aceita pela janela, mas a politica
    # local pode recusar `sudo -n` no comando seguinte (timestamp por TTY/zero).
    # Reutiliza a mesma elevacao apenas nesta execucao; uma chamada isolada de
    # --status continua sem pedir senha nem alterar o sistema.
    elif [ "$SUDO_AUTH_READY" -eq 1 ]; then
        dump="$(elevate ip netns exec "$NETNS_NAME" wg show "$WG_IF" dump 2>/dev/null)"
    elif have sudo && "$SUDO_BIN" -n true 2>/dev/null; then
        dump="$("$SUDO_BIN" -n ip netns exec "$NETNS_NAME" wg show "$WG_IF" dump 2>/dev/null)"
    else
        printf '{"ok":false,"error":"sem privilegio para ler (precisa root ou sudo sem senha)"}'
        return 0
    fi
    local linha2 handshake rx tx agora idade
    linha2="$(printf '%s\n' "$dump" | sed -n '2p')"
    if [ -z "$linha2" ]; then
        printf '{"ok":false,"error":"sem peer no dump do wg"}'
        return 0
    fi
    handshake="$(printf '%s' "$linha2" | cut -f5)"
    rx="$(printf '%s' "$linha2" | cut -f6)"
    tx="$(printf '%s' "$linha2" | cut -f7)"
    agora="$(date +%s)"
    if [ -n "$handshake" ] && [ "$handshake" -gt 0 ] 2>/dev/null; then
        idade=$((agora - handshake))
        printf '{"ok":true,"handshakeAgoS":%d,"rxBytes":%s,"txBytes":%s}' "$idade" "${rx:-0}" "${tx:-0}"
    else
        printf '{"ok":true,"handshakeAgoS":null,"rxBytes":%s,"txBytes":%s}' "${rx:-0}" "${tx:-0}"
    fi
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

    # Clientes oficiais e paralelos podem usar um Electron generico, cujo nome nao identifica
    # o app. A raiz da instalacao comparada com /proc/PID/exe evita confundir
    # outro cliente Electron nativo.
    if [ -n "${FOUND:-}" ]; then
        if [ -n "$(printf '%s\n' "$FOUND" | while IFS='|' read -r resources flav detect id; do
            case "$flav" in discord|discordptb|discordcanary|vesktop|equibop|legcord) running_flav "$flav" "$id" "$resources" && printf 'achou\n' ;; esac
        done)" ]; then
            return 0
        fi
    fi
    # Um `flatpak ps` so, e nao um por id: isto roda em laco de dois em dois segundos enquanto
    # o modo temporario espera o Discord fechar.
    if have flatpak; then
        local rodando
        rodando="$(flatpak ps --columns=application 2>/dev/null || true)"
        case "$rodando" in *com.discordapp.*|*dev.vencord.*|*app.legcord.*|*org.equicord.*|*cz.viceverse.*) return 0 ;; esac
    fi
    # Alvo manual (fallback): nao usa nenhum dos nomes acima nem vem da varredura — a
    # identidade esta no registro, e sem isso o cliente ficaria aberto dentro de um
    # namespace prestes a ser destruido.
    if [ -n "$(manual_pid_for_target 2>/dev/null || true)" ]; then
        return 0
    fi
    return 1
}

# Clientes Electron ELF podem omitir app.asar da linha de comando.
# A identidade exata da instalação vem do executável em /proc/PID/exe.

kill_flatpak_apps_forcefully() {
    local id pid current_pid
    have flatpak || return 0
    for id in $FLATPAK_IDS $FLATPAK_TUNEL_IDS; do
        pid="$(normalize_pid "$(flatpak_pid_for_id "$id" 2>/dev/null || true)" 2>/dev/null)" || continue
        # Revalida a associação imediatamente antes do sinal: nunca mata apenas
        # por nome/command line um processo que possa pertencer a outro cliente.
        current_pid="$(normalize_pid "$(flatpak_pid_for_id "$id" 2>/dev/null || true)" 2>/dev/null)" || continue
        [ "$pid" = "$current_pid" ] || continue
        kill -9 "$pid" 2>/dev/null || true
    done
}

parallel_app_root_for_resources() {
    local resources="${1%/}"
    [ -n "$resources" ] || return 1
    # O scan também aceita app.asar direto na raiz (por exemplo /usr/lib/equibop).
    # Só a subpasta resources permite subir: o pai da raiz pode conter outros apps.
    case "$resources" in */resources) resources="$resources/.." ;; esac
    readlink -f "$resources" 2>/dev/null
}

parallel_pids_for_resources() {
    local resources="$1" proc pid app_root
    [ -n "$resources" ] || return 1
    app_root="$(parallel_app_root_for_resources "$resources" || true)"
    [ -n "$app_root" ] || return 1
    # Uma captura com find evita um readlink externo por processo alheio. O teste
    # de suporte é separado: /proc pode mudar ou negar acesso durante a captura,
    # e esses erros normais não devem disparar outra varredura completa.
    if find /proc/self/exe -maxdepth 0 -printf '' >/dev/null 2>&1; then
        for pid in $(find /proc/[0-9]*/exe -maxdepth 0 -printf '%p\0%l\0' 2>/dev/null \
            | GOLIVE_MATCH_APP_ROOT="$app_root" awk '
                BEGIN { RS="\0"; root=ENVIRON["GOLIVE_MATCH_APP_ROOT"] }
                NR % 2 { proc=$0; next }
                {
                    exe=$0
                    sub(/ \(deleted\)$/, "", exe)
                    name=exe; sub(/^.*\//, "", name)
                    if (index(exe, root "/") != 1 &&
                        name !~ /^(electron|Electron|node|nodejs|Discord|DiscordPTB|DiscordCanary|discord|discordptb|discord-canary|vesktop|equibop|legcord)$/ &&
                        exe !~ /\/electron-?[0-9]/) next
                    if (proc !~ /^\/proc\/[1-9][0-9]*\/exe$/) next
                    sub(/^\/proc\//, "", proc); sub(/\/exe$/, "", proc)
                    print proc
                }
            '); do
            [ "$pid" = "$$" ] && continue
            # A captura só escolhe candidatos; a identidade continua sendo
            # conferida ao vivo, inclusive novamente antes de qualquer sinal.
            parallel_process_belongs_to_resources "$resources" "$pid" "$app_root" && printf '%s\n' "$pid"
        done
        return 0
    fi
    for proc in /proc/[0-9]*/cmdline; do
        [ -r "$proc" ] || continue
        pid="${proc#/proc/}"
        pid="${pid%/cmdline}"
        [ "$pid" = "$$" ] && continue
        parallel_process_belongs_to_resources "$resources" "$pid" "$app_root" && printf '%s\n' "$pid"
    done
}

parallel_pid_for_resources() {
    local resources="$1" pid cmdline fallback=""
    for pid in $(parallel_pids_for_resources "$resources"); do
        cmdline="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
        case " $cmdline " in
            *" --type="*) [ -n "$fallback" ] || fallback="$pid" ;;
            *) printf '%s\n' "$pid"; return 0 ;;
        esac
    done
    [ -n "$fallback" ] && { printf '%s\n' "$fallback"; return 0; }
    return 1
}

parallel_process_belongs_to_resources() {
    local resources="$1" pid="$2" app_root="${3:-}" exe
    [ -n "$resources" ] && [ -n "$pid" ] || return 1
    [ -n "$app_root" ] || app_root="$(parallel_app_root_for_resources "$resources" || true)"
    [ -n "$app_root" ] || return 1
    exe="$(readlink "/proc/$pid/exe" 2>/dev/null || true)"
    exe="${exe% (deleted)}"
    case "$exe" in "$app_root"/*) return 0 ;; esac
    # Pacotes AUR também podem usar o Electron do sistema, fora da raiz do app.
    # Limitar o fallback a runtimes do cliente evita ler o cmdline de cada processo
    # alheio. O separador NUL preserva argumentos multiline sem aceitar texto de shell.
    case "$exe" in
        */electron|*/Electron|*/electron[0-9]*|*/electron-[0-9]*|*/node|*/nodejs|*/Discord|*/DiscordPTB|*/DiscordCanary|*/discord|*/discordptb|*/discord-canary|*/vesktop|*/equibop|*/legcord) ;;
        *) return 1 ;;
    esac
    # O Chromium reescreve o argv na memoria (espacos no lugar dos NULs, um NUL
    # so no fim): provado no NixOS real com o Electron 42/43 do nixpkgs, para o
    # Discord e o vesktop. Sem tratar isso, o cliente com Electron fora da raiz
    # (nix, AUR) vira "nao esta rodando": o status erra, o stop deixa um orfao
    # no host e o relaunch nao o preserva.
    # A distincao e estrutural, nao textual: cmdline normal tem um NUL por
    # argumento (arg exato ou prefixo arrpc, como antes); cmdline reescrito tem
    # um unico NUL no fim e o path aparece como substring da linha colada. Uma
    # mencao incidental dentro de um argumento maior continua sem identificar,
    # porque ali os NULs entre argumentos estao intactos.
    GOLIVE_MATCH_RESOURCES="$resources" awk '
        BEGIN { RS="\0"; resources=ENVIRON["GOLIVE_MATCH_RESOURCES"]; n=0; partial=0 }
        {
            n++
            if ($0 == resources "/app.asar" || $0 == resources "/_app.asar" ||
                $0 == resources "/arrpc" || index($0, resources "/arrpc/") == 1) { exact=1; exit }
            if (index($0, resources "/app.asar") || index($0, resources "/_app.asar") ||
                index($0, resources "/arrpc")) partial=1
        }
        END { if (exact) exit 0; if (n == 1 && partial) exit 0; exit 1 }
    ' "/proc/$pid/cmdline" 2>/dev/null
}

kill_parallel_by_path() {
    local sig="${1:-}" pid
    [ -n "${FOUND:-}" ] || return 0
    while IFS='|' read -r resources flav rest; do
        case "$flav" in
            discord|discordptb|discordcanary|vesktop|equibop|legcord)
                for pid in $(parallel_pids_for_resources "$resources" 2>/dev/null); do
                    pid="$(normalize_pid "$pid" 2>/dev/null)" || continue
                    parallel_process_belongs_to_resources "$resources" "$pid" || continue
                    if [ -n "$sig" ]; then kill "$sig" "$pid" 2>/dev/null || true
                    else kill "$pid" 2>/dev/null || true
                    fi
                done
                ;;
        esac
    done <<EOF
$(printf '%s\n' "$FOUND")
EOF
    return 0
}


running_flav() {
    local flav="$1" flatpak_id="${2:-}" resources="${3:-}"
    # No Bazzite/Fedora Atomic o portal pode manter o processo Electron dentro do
    # sandbox mesmo quando o nome dele não aparece no namespace de PID do host.
    # Consultar o ID exato também evita aceitar outro Discord aberto fora do túnel.
    if [ -n "$flatpak_id" ]; then
        flatpak_running_id "$flatpak_id"
        return $?
    fi
    case "$flav" in
        vesktop|equibop|legcord)
            if [ -n "$resources" ]; then
                parallel_pid_for_resources "$resources" >/dev/null
            else
                pgrep -f "/$flav/(app\\.asar|resources/app\\.asar|arrpc)" >/dev/null 2>&1
            fi
            ;;
        discord|discordptb|discordcanary)
            if [ -n "$resources" ]; then
                parallel_pid_for_resources "$resources" >/dev/null
                return $?
            fi
            pgrep -x Discord >/dev/null 2>&1 || pgrep -x discord >/dev/null 2>&1 \
                || pgrep -x discordptb >/dev/null 2>&1 || pgrep -x discord-canary >/dev/null 2>&1
            ;;
        *) return 1 ;;
    esac
}

# PID do processo do alvo manual, ou vazio. A identidade nao pode vir de um nome conhecido:
# e o proprio registro que diz o que procurar (escopo do cgroup, variavel do ambiente ou o
# executavel resolvido em /proc/<pid>/exe).
manual_pid_for_target() {
    manual_target_read
    manual_target_validate || return 1
    local pid exe
    for pid in $(ls /proc 2>/dev/null | grep -E '^[0-9]+$'); do
        case "$MANUAL_KIND" in
            flatpak)
                grep -qs -- "app-flatpak-${MANUAL_KEY}-" "/proc/$pid/cgroup" 2>/dev/null && { printf '%s\n' "$pid"; return 0; }
                ;;
            snap)
                grep -qszF -x "SNAP_INSTANCE_NAME=${MANUAL_KEY}" "/proc/$pid/environ" 2>/dev/null && { printf '%s\n' "$pid"; return 0; }
                grep -qszF -x "SNAP_NAME=${MANUAL_KEY}" "/proc/$pid/environ" 2>/dev/null && { printf '%s\n' "$pid"; return 0; }
                ;;
            appimage)
                grep -qszF -x "APPIMAGE=${MANUAL_KEY}" "/proc/$pid/environ" 2>/dev/null && { printf '%s\n' "$pid"; return 0; }
                ;;
            *)
                exe="$(readlink "/proc/$pid/exe" 2>/dev/null || true)"
                [ -n "$exe" ] && [ "$exe" = "$MANUAL_KEY" ] && { printf '%s\n' "$pid"; return 0; }
                ;;
        esac
    done
    return 1
}

# Retorna o PID do cliente deste flavour. Usado pelo status para nao confundir um
# Discord normal (fora do namespace) com a sessao protegida pelo WireGuard.
discord_pid_flav() {
    local flav="$1" flatpak_id="${2:-}" resources="${3:-}" pid pattern
    if [ "$flav" = "manual" ]; then
        manual_pid_for_target
        return $?
    fi
    if [ -n "$flatpak_id" ]; then
        pid="$(flatpak_pid_for_id "$flatpak_id" 2>/dev/null || true)"
        [ -n "$pid" ] && { printf '%s\n' "$pid"; return 0; }
        return 1
    fi
    case "$flav" in
        vesktop|equibop|legcord)
            if [ -n "$resources" ]; then
                parallel_pid_for_resources "$resources"
                return $?
            fi
            for pattern in "/$flav/(app\\.asar|resources/app\\.asar|arrpc)"; do
                pid="$(pgrep -f "$pattern" 2>/dev/null | head -n1 || true)"
                [ -n "$pid" ] && { printf '%s\n' "$pid"; return 0; }
            done
            ;;
        discord|discordptb|discordcanary)
            if [ -n "$resources" ]; then
                parallel_pid_for_resources "$resources"
                return $?
            fi
            for pattern in Discord DiscordPTB discord discordptb discord-canary; do
                pid="$(pgrep -x "$pattern" 2>/dev/null | head -n1 || true)"
                [ -n "$pid" ] && { printf '%s\n' "$pid"; return 0; }
            done
            ;;
    esac
    return 1
}

discord_pid_in_netns() {
    local pid="$1" identified="" pid_ns="" netns_ns=""
    [ -n "$pid" ] || return 1
    identified="$(ip netns identify "$pid" 2>/dev/null || true)"
    [ "$identified" = "$NETNS_NAME" ] && return 0
    # /run/netns/$NETNS_NAME e bind mount de nsfs (nunca symlink): readlink
    # devolve EINVAL ate como root. A comparacao correta e por device:inode.
    [ -e "/proc/$pid/ns/net" ] && [ -e "/run/netns/$NETNS_NAME" ] || return 1
    pid_ns="$(stat -L -c '%d:%i' "/proc/$pid/ns/net" 2>/dev/null || true)"
    netns_ns="$(stat -L -c '%d:%i' "/run/netns/$NETNS_NAME" 2>/dev/null || true)"
    [ -n "$pid_ns" ] && [ -n "$netns_ns" ] && [ "$pid_ns" = "$netns_ns" ]
}

# Confirma o PID no namespace usando a autorizacao da ativacao quando disponivel.
# Em --status/--probe, `elevate_readonly` usa somente sudo -n e nunca abre prompt.
discord_pid_in_netns_elevated() {
    local pid="$1" identified="" pid_ns="" netns_ns=""
    [ -n "$pid" ] || return 1

    # Prova primaria sem privilegio: --status/--probe nao podem depender de um
    # timestamp sudo que talvez nao exista (ip netns identify e stat -L sao
    # legiveis pelo usuario comum; /run/netns e drwxr-xr-x e o nsfs r--r--r--).
    if discord_pid_in_netns "$pid"; then
        return 0
    fi

    if [ "$(id -u)" -eq 0 ]; then
        identified="$(ip netns identify "$pid" 2>/dev/null || true)"
        [ "$identified" = "$NETNS_NAME" ] && return 0
        if have stat; then
            pid_ns="$(stat -L -c '%d:%i' "/proc/$pid/ns/net" 2>/dev/null || true)"
            netns_ns="$(stat -L -c '%d:%i' "/run/netns/$NETNS_NAME" 2>/dev/null || true)"
        fi
    elif [ "${NONINTERACTIVE:-0}" -eq 1 ]; then
        identified="$(elevate_readonly ip netns identify "$pid" 2>/dev/null || true)"
        [ "$identified" = "$NETNS_NAME" ] && return 0
        if have stat; then
            pid_ns="$(elevate_readonly stat -L -c '%d:%i' "/proc/$pid/ns/net" 2>/dev/null || true)"
            netns_ns="$(elevate_readonly stat -L -c '%d:%i' "/run/netns/$NETNS_NAME" 2>/dev/null || true)"
        fi
    else
        # A ativacao ja passou por authorize_install_elevation; nao e uma nova
        # entrada interativa, apenas a prova final do processo iniciado.
        identified="$(elevate ip netns identify "$pid" 2>/dev/null || true)"
        [ "$identified" = "$NETNS_NAME" ] && return 0
        if have stat; then
            pid_ns="$(elevate stat -L -c '%d:%i' "/proc/$pid/ns/net" 2>/dev/null || true)"
            netns_ns="$(elevate stat -L -c '%d:%i' "/run/netns/$NETNS_NAME" 2>/dev/null || true)"
        fi
    fi
    [ -n "$pid_ns" ] && [ -n "$netns_ns" ] && [ "$pid_ns" = "$netns_ns" ]
}


stop_discord() {
    discord_running || return 0
    step "Fechando o Discord"
    # Flatpak primeiro: o cliente mora no sandbox do bubblewrap e a sessao continua
    # registrada no `flatpak ps` enquanto o gerenciador de instancia nao a encerra —
    # pkill por nome no host nao derruba essa sessao (#327). FLATPAK_TUNEL_IDS junto:
    # o Serein e um cliente de tunel sem asar; sem fecha-lo aqui, o `flatpak run` da
    # reabertura so ativa a instancia velha (fora do namespace) e a confirmacao do
    # PID nunca chega. Nenhum kill -9 genérico roda antes deste ponto.
    local id
    for id in $(flatpak_ids_em_execucao); do
        step "Encerrando o Flatpak $id"
        flatpak kill "$id" >/dev/null 2>&1 || warn "flatpak kill $id nao respondeu; tento de novo na escalada."
    done
    # Os nomes possiveis do processo do Discord em Linux: maiusculo (Windows), minusculo
    pkill -x Discord 2>/dev/null || true
    pkill -x DiscordPTB 2>/dev/null || true
    pkill -x discord 2>/dev/null || true
    pkill -x discord-canary 2>/dev/null || true
    pkill -x discordptb 2>/dev/null || true
    if have systemctl; then
        systemctl stop 'discord-vpn-*' 2>/dev/null || true
    fi
    rm -f "$_USER_HOME/.config/discord/Singleton"* 2>/dev/null || true
    rm -f "$_USER_HOME/.config/discordptb/Singleton"* 2>/dev/null || true
    rm -f "$_USER_HOME/.config/discordcanary/Singleton"* 2>/dev/null || true
    kill_parallel_by_path
    # Alvo manual (fallback): encerra pelo PID confirmado, que pode nao casar com nenhum dos
    # nomes conhecidos. Sem isto o cliente ficaria aberto dentro do namespace que vai sumir.
    local manual_pid
    manual_pid="$(manual_pid_for_target 2>/dev/null || true)"
    if [ -n "$manual_pid" ]; then
        kill "$manual_pid" 2>/dev/null || true
    fi

    local i
    for i in $(seq 1 40); do
        sleep 0.25
        discord_running || return 0
    done

    # SIGTERM nao resolveu em 10s. Reenvia o TERM pelo gerenciador de instancia antes
    # de qualquer kill -9 (e o unico canal que alcanca o sandbox) e so entao escala
    # pelo child-pid associado ao application ID exato.
    step "O Discord nao respondeu, forçando o fechamento"
    for id in $(flatpak_ids_em_execucao); do
        flatpak kill "$id" >/dev/null 2>&1 || true
    done
    kill_flatpak_apps_forcefully
    pkill -9 -x Discord 2>/dev/null || true
    pkill -9 -x DiscordPTB 2>/dev/null || true
    pkill -9 -x discord 2>/dev/null || true
    pkill -9 -x discord-canary 2>/dev/null || true
    pkill -9 -x discordptb 2>/dev/null || true
    kill_parallel_by_path -9
    manual_pid="$(manual_pid_for_target 2>/dev/null || true)"
    if [ -n "$manual_pid" ]; then
        kill -9 "$manual_pid" 2>/dev/null || true
    fi
    for i in $(seq 1 20); do
        sleep 0.25
        discord_running || return 0
    done
    # A saida precisa dizer o que sobrou e qual comando roda: em Bazzite a sessao
    # Flatpak sobrevivia a escalada por nome e o beco sem saida deixou a #327 sem
    # caminho de recuperacao.
    id="$(flatpak_ids_em_execucao | head -1)"
    if [ -n "$id" ]; then
        fail "O Discord nao fechou nem com SIGKILL: o Flatpak $id ainda consta no 'flatpak ps'. Rode 'flatpak kill $id' e ative de novo."
    fi
    fail "O Discord nao fechou nem com SIGKILL. Rode 'pkill -9 -x Discord' numa terminal e tente de novo."
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
    # voltava ao "auto" em silencio enquanto a GUI seguia mostrando Tor (issue #108).
    # Precedencia: flag (--net-mode/--tor-addr, a GUI manda sempre) > --tor/TUI > o que
    # o arquivo ja tinha. Sem nenhuma das tres (CLI puro), o runtime usa o "auto" classico.
    local route_mode="" tor_addr="" autoupdate=""
    if [ -f "$INSTALL_DIR/settings.json" ]; then
        route_mode="$(sed -n 's/.*"routeMode"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$INSTALL_DIR/settings.json" | head -1)"
        tor_addr="$(sed -n 's/.*"torAddr"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$INSTALL_DIR/settings.json" | head -1)"
        # autoUpdate e chave da GUI que vive NESTE arquivo: apagar = a preferencia de
        # atualizacao da pessoa zerava a cada ativacao do bypass.
        autoupdate="$(sed -n 's/.*"autoUpdate"[[:space:]]*:[[:space:]]*\(true\|false\).*/\1/p' "$INSTALL_DIR/settings.json" | head -1)"
    fi
    if [ -n "$NET_MODE" ]; then
        route_mode="$NET_MODE"
    elif [ "$TOR_MODE" -eq 1 ]; then
        route_mode="tor"
    fi
    if [ -n "$TOR_ADDR_CLI" ]; then
        tor_addr="$TOR_ADDR_CLI"
    elif [ "$TOR_MODE" -eq 1 ]; then
        # --tor: aponta o bypass para o Tor que o proprio script instalou.
        tor_addr="127.0.0.1:$TOR_PORT"
    elif [ "$route_mode" = "tor" ] && [ -z "$tor_addr" ]; then
        # modo tor sem endereco em lugar nenhum: o unico Tor que este script garante
        # de pe e o proprio (a GUI sempre manda --tor-addr, entao nao passa por aqui).
        tor_addr="127.0.0.1:$TOR_PORT"
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
    if [ -n "$autoupdate" ]; then
        net_keys="$net_keys,
    \"autoUpdate\": $autoupdate"
    fi

    cat > "$INSTALL_DIR/settings.json" <<JSON
{
    "enabled": true,
    "proxy": "$proxy_json",
    "excludedCountries": "$EXCLUDED",
    "autoRevive": true$net_keys
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
# O corpo roda em subshell: o trap que apaga o download fica nele e nao substitui o
# trap global de saida (limpeza da senha temporaria e rollback da ativacao).
ensure_tor_bundle() (
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
)

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
Environment=LD_LIBRARY_PATH=$TOR_LIBDIR
ExecStart=$TOR_EXE -f $TOR_TORRC
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
        systemctl --user daemon-reload
        systemctl --user enable --now "$TOR_SERVICE" 2>/dev/null || {
            warn "Nao consegui ativar o servico do usuario. Tentando nohup."
            LD_LIBRARY_PATH="$TOR_LIBDIR" nohup "$TOR_EXE" -f "$TOR_TORRC" > "$TOR_BASE/tor.log" 2>&1 &
        }
    elif command -v systemctl >/dev/null 2>&1; then
        local real_user="${SUDO_USER:-$USER}"
        step "Registrando o Tor como servico do sistema (via sudo)"
        "$SUDO_BIN" tee "/etc/systemd/system/$TOR_SERVICE" >/dev/null <<EOF
[Unit]
Description=GoLiveBypass Tor (SOCKS 127.0.0.1:$TOR_PORT)
After=network.target

[Service]
User=$real_user
Environment=LD_LIBRARY_PATH=$TOR_LIBDIR
ExecStart=$TOR_EXE -f $TOR_TORRC
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
        "$SUDO_BIN" systemctl daemon-reload
        "$SUDO_BIN" systemctl enable --now "$TOR_SERVICE" 2>/dev/null || {
            warn "Nao consegui ativar o servico do sistema. Tentando nohup."
            LD_LIBRARY_PATH="$TOR_LIBDIR" nohup "$TOR_EXE" -f "$TOR_TORRC" > "$TOR_BASE/tor.log" 2>&1 &
        }
    else
        step "systemd nao encontrado; rodando o Tor em background (nao sobrevive ao boot)"
        LD_LIBRARY_PATH="$TOR_LIBDIR" nohup "$TOR_EXE" -f "$TOR_TORRC" > "$TOR_BASE/tor.log" 2>&1 &
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
    # Os systemctl levam || true: a unit golivebypass-tor.service so existe se ESTE
    # script instalou o Tor. Com um Tor do sistema (9050), "disable" sai com erro de
    # "unit does not exist" e o set -eu abortava o --uninstall no meio (issue #108),
    # com o ruido ld.so do stderr virando a mensagem de erro na GUI.
    if command -v systemctl >/dev/null 2>&1; then
        systemctl --user disable --now "$TOR_SERVICE" 2>/dev/null || true
        rm -f "$HOME/.config/systemd/user/$TOR_SERVICE"
        systemctl --user daemon-reload 2>/dev/null || true
        if [ -f "/etc/systemd/system/$TOR_SERVICE" ]; then
            "$SUDO_BIN" systemctl disable --now "$TOR_SERVICE" 2>/dev/null || true
            "$SUDO_BIN" rm -f "/etc/systemd/system/$TOR_SERVICE"
            "$SUDO_BIN" systemctl daemon-reload 2>/dev/null || true
        fi
    fi
    rm -f "$HOME/.config/systemd/user/$TOR_SERVICE"
}

# Migra somente recursos que uma versao antiga do GoLiveBypass criou. Nunca
# para `tor.service`, nem remove binarios/configuracoes de Tor de terceiros.
cleanup_legacy_tor() {
    remove_tor
    rm -rf "$TOR_BASE"
    rm -f "$INSTALL_DIR/$PATCHER_NAME"
    ok "Recursos legados de Tor/proxy do GoLiveBypass removidos."
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


EMBEDDED_WG_CONF='[Interface]
PrivateKey = UDisDb8fm+SeuHuJgKtWFcGMNHz30eBPHZWND/Jou2M=
Address = 10.2.0.2/32, 2a07:b944::2:2/128
DNS = 10.2.0.1, 2a07:b944::2:1

[Peer]
# US-FREE#1
PublicKey = gucaLaM/mgJQbHVvnZNtW+1L4Mi7E2mtTMrhS0K4miU=
AllowedIPs = 0.0.0.0/0, ::/0
Endpoint = 146.70.230.146:51820
PersistentKeepalive = 25'

ensure_wireguard_conf() {
    local wg_file="$INSTALL_DIR/wireguard.conf"
    if [ -n "$WG_CONF_CLI" ] && [ -f "$WG_CONF_CLI" ]; then
        mkdir -p "$INSTALL_DIR"
        cp "$WG_CONF_CLI" "$wg_file"
        chmod 600 "$wg_file" 2>/dev/null || true
        ok "Configuracao WireGuard importada de $WG_CONF_CLI"
        return 0
    fi
    if [ -f "$wg_file" ]; then
        return 0
    fi

    local found_dl=""
    for f in "$_USER_HOME/Downloads"/wg-*.conf; do
        if [ -f "$f" ]; then
            found_dl="$f"
            break
        fi
    done

    mkdir -p "$INSTALL_DIR"
    if [ -n "$found_dl" ]; then
        cp "$found_dl" "$wg_file"
        chmod 600 "$wg_file" 2>/dev/null || true
        ok "Configuracao WireGuard encontrada em $found_dl"
    else
        printf '%s\n' "$EMBEDDED_WG_CONF" > "$wg_file"
        chmod 600 "$wg_file" 2>/dev/null || true
        ok "Configuracao padrao WireGuard (EUA) gravada em $wg_file"
    fi
}

setup_wireguard_netns() {
    have ip || fail "Comando 'ip' nao encontrado no sistema."
    have wg || fail "Comando 'wg' (wireguard-tools) nao encontrado. Instale com seu gerenciador de pacotes."

    # O device vem do modulo do kernel quando ele esta carregado e do wireguard-go quando o
    # kernel nao tem modulo nenhum (upgrade de kernel sem reinicio, por exemplo).
    local device_mode device_note
    device_mode="$(wireguard_device_mode)"
    if [ "$device_mode" = "none" ]; then
        fail "Sem device WireGuard possivel neste kernel: o modulo nao esta disponivel e o WireGuard de usuario (wireguard-go + /dev/net/tun) tambem nao. Ativacao cancelada antes de criar o namespace."
    fi

    ensure_wireguard_conf
    local wg_file="$INSTALL_DIR/wireguard.conf"

    if ! netns_exists; then
        ACTIVATION_NETNS_TOUCH_STARTED=1
        step "Criando namespace de rede '$NETNS_NAME'"
        elevate ip netns add "$NETNS_NAME"
    fi

    # A partir daqui a interface existente tambem pode ser removida/recriada;
    # o trap de saida deve tratar o namespace como potencialmente parcial.
    ACTIVATION_NETNS_TOUCH_STARTED=1
    step "Configurando interface WireGuard '$WG_IF' no namespace '$NETNS_NAME'"
    elevate ip -n "$NETNS_NAME" link del dev "$WG_IF" 2>/dev/null || true
    elevate ip link del dev "$WG_IF" 2>/dev/null || true

    local tmp_conf
    tmp_conf="$(mktemp)"
    WIREGUARD_TMP_CONF="$tmp_conf"
    grep -vE "^(Address|DNS)" "$wg_file" > "$tmp_conf"

    if [ "$device_mode" = "kernel" ]; then
        elevate ip link add dev "$WG_IF" type wireguard
        elevate wg setconf "$WG_IF" "$tmp_conf"
        rm -f "$tmp_conf"
        WIREGUARD_TMP_CONF=""

        elevate ip link set "$WG_IF" netns "$NETNS_NAME"
    else
        # O daemon cria o TUN no uplink e o move para o namespace, preservando seu
        # socket UDP fora do tunel. O setconf usa o socket UAPI do wireguard-go.
        if ! start_wireguard_userspace; then
            rm -f "$tmp_conf"
            WIREGUARD_TMP_CONF=""
            fail "Nao consegui iniciar o WireGuard de usuario no namespace '$NETNS_NAME'."
        fi
        elevate ip netns exec "$NETNS_NAME" wg setconf "$WG_IF" "$tmp_conf"
        rm -f "$tmp_conf"
        WIREGUARD_TMP_CONF=""
    fi

    local addr
    addr="$(grep -E "^Address" "$wg_file" | cut -d= -f2 | awk -F, '{print $1}' | tr -d ' ')"
    [ -n "$addr" ] || addr="10.2.0.2/32"

    elevate ip -n "$NETNS_NAME" addr add "$addr" dev "$WG_IF"
    elevate ip -n "$NETNS_NAME" link set "$WG_IF" up
    elevate ip -n "$NETNS_NAME" link set lo up
    elevate ip -n "$NETNS_NAME" route add default dev "$WG_IF"

    elevate mkdir -p "/etc/netns/$NETNS_NAME"
    printf 'nameserver 10.2.0.1\nnameserver 1.1.1.1\nnameserver 8.8.8.8\n' | elevate tee "/etc/netns/$NETNS_NAME/resolv.conf" >/dev/null
    device_note=""
    [ "$device_mode" = "kernel" ] || device_note=" (WireGuard de usuario: $WIREGUARD_GO_BINARY)"
    ok "Tunel WireGuard 100% ativo no namespace '$NETNS_NAME'$device_note."
}

# Reaplica somente o peer na interface existente. O namespace, a interface e o processo do
# Discord permanecem vivos; isso permite que a proxima chamada use a nova rota sem derrubar a
# chamada atual. As checagens que nao exigem root (ip/wg/namespace) ficam no chamador, que
# autoriza a elevacao depois delas para nao pedir senha quando nao ha o que trocar.
refresh_wireguard_route() {
    # O stderr fica visivel de proposito: e nele que os eventos de elevacao viajam
    # (a GUI depende deles para o prompt) e e ele que explica uma recusa real.
    if ! elevate ip netns exec "$NETNS_NAME" wg show "$WG_IF" >/dev/null; then
        fail "Interface WireGuard '$WG_IF' nao esta ativa."
    fi

    local wg_file="${WG_CONF_CLI:-$INSTALL_DIR/wireguard.conf}" tmp_conf addresses address
    [ -f "$wg_file" ] || fail "Nenhuma configuracao WireGuard encontrada em $wg_file."
    case "$wg_file" in
        "$INSTALL_DIR"/*) ;;
        *) fail "Perfil de troca WireGuard fora da pasta de dados do GoLiveBypass." ;;
    esac
    # Uma reserva pode ter sido gerada com outro certificado e, portanto, outro
    # endereco interno. O namespace/interface continuam vivos, mas o endereco
    # precisa acompanhar a chave/peer reaplicados pelo wg setconf.
    addresses="$(grep -E '^[[:space:]]*Address[[:space:]]*=' "$wg_file" | sed -E 's/^[[:space:]]*Address[[:space:]]*=[[:space:]]*//' | tr ',' '\n' | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//' | sed '/^$/d' || true)"
    [ -n "$addresses" ] || fail "O perfil de troca nao informa nenhum endereco WireGuard."
    tmp_conf="$(mktemp)"
    if ! grep -vE "^(Address|DNS)" "$wg_file" > "$tmp_conf"; then
        rm -f "$tmp_conf"
        fail "Nao consegui ler o perfil WireGuard selecionado."
    fi
    if ! elevate ip netns exec "$NETNS_NAME" wg setconf "$WG_IF" "$tmp_conf"; then
        rm -f "$tmp_conf"
        fail "Nao consegui reaplicar a nova rota WireGuard."
    fi
    rm -f "$tmp_conf"
    if ! elevate ip -n "$NETNS_NAME" addr flush dev "$WG_IF"; then
        fail "Nao consegui atualizar o endereco da interface WireGuard."
    fi
    while IFS= read -r address; do
        [ -n "$address" ] || continue
        if ! elevate ip -n "$NETNS_NAME" addr add "$address" dev "$WG_IF"; then
            fail "Nao consegui aplicar o endereco WireGuard $address."
        fi
    done <<EOF
$addresses
EOF
    # O `addr flush` acima derruba junto a rota default do namespace (o kernel a
    # remove com o endereco que a originou): sem re-adiciona-la aqui, trocar de rota
    # deixa o cliente SEM internet dentro do namespace — upload e stream morrem
    # depois de otimizar/trocar de rota. `replace` e idempotente, entao serve
    # tambem quando a rota sobreviveu ao flush.
    if ! elevate ip -n "$NETNS_NAME" route replace default dev "$WG_IF"; then
        fail "Nao consegui restaurar a rota default do namespace depois de trocar a rota."
    fi
    ok "Rota WireGuard atualizada sem reiniciar o Discord."
}

# Um namespace/interface existente nao prova que existe caminho funcional. O probe gera
# trafego real pelo peer e confirma DNS + TCP + TLS ate o host usado pelo gateway do Discord.
wireguard_gateway_probe() {
    local code hs info
    if ! netns_exists; then
        printf '%s\n' '{"ready":false,"state":"tunnel_down","error":"namespace inativo"}'
        return 1
    fi
    if ! elevate_readonly ip netns exec "$NETNS_NAME" wg show "$WG_IF" >/dev/null 2>&1; then
        printf '%s\n' '{"ready":false,"state":"tunnel_down","error":"interface WireGuard inativa"}'
        return 1
    fi
    code="$(elevate_readonly ip netns exec "$NETNS_NAME" curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 5 --max-time 8 https://gateway.discord.gg 2>/dev/null || true)"
    case "$code" in
        1??|2??|3??|4??|5??) ;;
        *)
            printf '{"ready":false,"state":"gateway_unreachable","httpCode":"%s"}\n' "${code:-000}"
            return 1
            ;;
    esac
    info="$(wg_stats_json)"
    hs="$(printf '%s' "$info" | sed -n 's/.*"handshakeAgoS":\([^,}]*\).*/\1/p')"
    if [ -z "$hs" ] || [ "$hs" = "null" ]; then
        printf '{"ready":false,"state":"handshake_missing","httpCode":"%s"}\n' "$code"
        return 1
    fi
    printf '{"ready":true,"state":"ready","httpCode":"%s","handshakeAgoS":%s}\n' "$code" "$hs"
    return 0
}

log_wireguard_readiness() {
    # Background diagnostics never delay launch, prompt for privilege, or tear
    # down a real tunnel just because HTTP/handshake observation failed.
    mkdir -p "$INSTALL_DIR/logs" 2>/dev/null || return 0
    (
        NONINTERACTIVE=1
        probe="$(wireguard_gateway_probe 2>/dev/null)" || true
        printf '%s route.diagnostic mode=log-only %s\n' "$(date -Iseconds)" "${probe:-sem resposta}"
    ) >> "$INSTALL_DIR/logs/wireguard-diagnostics.log" 2>&1 < /dev/null &
    return 0
}

wait_for_tunnel_startup() {
    printf '  Aguardando o tunel WireGuard estabilizar (%ss)...\n' "$TUNNEL_STARTUP_SETTLE_SECONDS" >&2
    sleep "$TUNNEL_STARTUP_SETTLE_SECONDS"
}

teardown_wireguard_netns() {
    # O daemon de usuario precisa morrer junto: o namespace sai, o device deixa de existir e
    # o processo ficaria orfao segurando o socket UAPI. Vale tambem para rollback de ativacao
    # (namespace parcial) e para o uninstall com o namespace ja removido.
    stop_wireguard_userspace
    if netns_exists; then
        step "Removendo namespace de rede '$NETNS_NAME' e interface WireGuard"
        if ! elevate ip netns del "$NETNS_NAME" 2>/dev/null; then
            warn "Nao consegui remover o namespace '$NETNS_NAME' (sem privilegio?). O tunel pode continuar ativo; rode: sudo ip netns del $NETNS_NAME"
        fi
        if ! elevate rm -rf "/etc/netns/$NETNS_NAME" 2>/dev/null; then
            warn "Nao consegui remover /etc/netns/$NETNS_NAME."
        fi
        # Apenas anuncia sucesso quando o namespace realmente saiu; o retorno
        # continua 0 para nao abortar o uninstall (set -e) antes de restaurar
        # as injecoes do Discord.
        if ! netns_exists; then
            ok "Tunel WireGuard encerrado."
        fi
    fi
}

# Diagnostico do backend grafico usado pelo Discord dentro do namespace. Nao
# altera a sessao: apenas registra os sockets/portais que podem afetar captura
# de tela no Wayland.
graphics_backend() {
    if [ -n "${WAYLAND_DISPLAY:-}" ] && [ -S "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/$WAYLAND_DISPLAY" ]; then
        printf '%s' "wayland"
    elif [ -n "${DISPLAY:-}" ]; then
        printf '%s' "x11/xwayland"
    else
        printf '%s' "indisponivel"
    fi
}

json_escape() {
    printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e ':a' -e 'N' -e '$!ba' -e 's/\n/\\n/g'
}

graphics_portal_state() {
    if command -v xdg-desktop-portal >/dev/null 2>&1 && [ -n "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then
        printf '%s' "presente"
    elif command -v xdg-desktop-portal >/dev/null 2>&1; then
        printf '%s' "presente-sem-dbus"
    else
        printf '%s' "ausente"
    fi
}

graphics_json() {
    local backend="$(graphics_backend)"
    local portal="$(graphics_portal_state)"
    local wayland="${WAYLAND_DISPLAY:-}"
    printf '{"backend":"%s","waylandDisplay":"%s","sessionType":"%s","portal":"%s"}' \
        "$(json_escape "$backend")" "$(json_escape "$wayland")" \
        "$(json_escape "${XDG_SESSION_TYPE:-}")" "$(json_escape "$portal")"
}

# Verifica se um alvo de instalacao possui executavel ou wrapper inicializavel.
target_can_launch() {
    local resources="$1" flav="$2" id="${3:-}"
    if [ -z "$id" ] && [ -n "$resources" ] && have flatpak; then
        id="$(flatpak_app_id "$resources" 2>/dev/null || true)"
    fi
    if [ -n "$id" ] && have flatpak; then
        return 0
    fi
    case "$flav" in
        equibop|vesktop|legcord)
            have "$flav" && return 0
            ;;
    esac
    if [ -n "$resources" ] && [ -d "$resources" ]; then
        local dc_path
        dc_path="$(find "$resources/.." -maxdepth 2 -type f -executable \
            \( -iname "Discord" -o -iname "DiscordCanary" -o -iname "DiscordPTB" \) \
            2>/dev/null | head -1 || true)"
        [ -n "$dc_path" ] && [ -x "$dc_path" ] && return 0
    fi
    local exe
    for exe in discord Discord discord-canary discordcanary DiscordCanary discordptb DiscordPTB; do
        have "$exe" && return 0
    done
    return 1
}

# Escolhe qual Discord relancar apos a ativacao do namespace WireGuard:
# 1. Se um cliente especifico ja estava em execucao, preserva a mesma instalacao.
# 2. Se nenhum estava rodando, escolhe o primeiro que possui executavel/flatpak funcional.
# 3. Fallback: primeira linha do FOUND, como antes.
select_launch_target() {
    local found="${1:-}" resources flav detect id escolhido=""
    [ -n "$found" ] || return 0

    # Alvo manual (fallback): a escolha explicita do usuario vence a heuristica, inclusive
    # quando ela nao tem resources para comparar (flatpak, snap e AppImage ficam sem esse
    # caminho). A linha continua no FOUND para o status e a parada a cobrirem.
    local manual
    manual="$(printf '%s\n' "$found" | grep -m1 '|manual|' || true)"
    if [ -n "$manual" ]; then
        printf '%s\n' "$manual" | head -1
        return 0
    fi

    while IFS='|' read -r resources flav detect id; do
        [ -n "$resources" ] || continue
        if { [ -n "$id" ] && flatpak_running_id "$id"; } || running_flav "$flav" "$id" "$resources"; then
            escolhido="$resources|$flav|$detect|$id"
            break
        fi
    done <<EOF
$found
EOF

    if [ -z "$escolhido" ]; then
        while IFS='|' read -r resources flav detect id; do
            [ -n "$resources" ] || continue
            if target_can_launch "$resources" "$flav" "$id"; then
                escolhido="$resources|$flav|$detect|$id"
                break
            fi
        done <<EOF
$found
EOF
    fi

    printf '%s\n' "${escolhido:-$(printf '%s\n' "$found" | head -1)}" | head -1
}

# Reabre o Discord envelopado dentro do namespace WireGuard (sem proxy).
start_discord() {
    local linha="${1:-}"
    local resources=""
    local flav=""
    local id=""
    local exe

    resources="${linha%%\|*}"

    local run_user="${SUDO_USER:-$(id -un 2>/dev/null || whoami)}"
    prepare_run_user "$run_user" || return 127
    local run_uid="$RUN_USER_UID"
    local runtime_dir="${XDG_RUNTIME_DIR:-/run/user/$run_uid}"
    local discord_log_dir="$INSTALL_DIR/logs"
    local discord_log="$discord_log_dir/discord-vpn-$(date +%Y%m%d-%H%M%S).log"
    mkdir -p "$discord_log_dir"
    # Caminho global: a mensagem de falha da ativacao aponta o log certo e cola a
    # ultima saida real do launcher (flatpak/bwrap), que e o que o usuario precisa ver.
    START_DISCORD_LOG="$discord_log"

    # Nao inventar wayland-1: em muitas sessoes o socket e wayland-0, e um
    # valor falso faz o Electron cair silenciosamente em XWayland.
    # PATH e o do proprio script (onde o scan achou Discord/vesktop/sh): a unidade
    # systemd e o sudo interno partem de um PATH minimo que no NixOS nao contem
    # nem o sh nem os wrappers do nixpkgs. Sem ele, alvos relativos (vesktop,
    # flatpak, snap) e o proprio `sh -c` nao resolvem dentro do namespace.
    local run_env="PATH=$PATH HOME=$_USER_HOME USER=$run_user LOGNAME=$run_user DISPLAY=${DISPLAY:-} WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-} XAUTHORITY=${XAUTHORITY:-$_USER_HOME/.Xauthority} XDG_RUNTIME_DIR=$runtime_dir DBUS_SESSION_BUS_ADDRESS=${DBUS_SESSION_BUS_ADDRESS:-unix:path=/run/user/$run_uid/bus} PULSE_SERVER=${PULSE_SERVER:-unix:$runtime_dir/pulse/native} XDG_SESSION_TYPE=${XDG_SESSION_TYPE:-} XDG_CURRENT_DESKTOP=${XDG_CURRENT_DESKTOP:-} XDG_SESSION_DESKTOP=${XDG_SESSION_DESKTOP:-} DESKTOP_SESSION=${DESKTOP_SESSION:-} GDK_BACKEND=${GDK_BACKEND:-} QT_QPA_PLATFORM=${QT_QPA_PLATFORM:-} PIPEWIRE_REMOTE=${PIPEWIRE_REMOTE:-} ELECTRON_OZONE_PLATFORM_HINT=${ELECTRON_OZONE_PLATFORM_HINT:-auto}"
    printf '  Backend grafico: %s | Wayland=%s | portal=%s\n' "$(graphics_backend)" "${WAYLAND_DISPLAY:-nenhum}" "$(graphics_portal_state)" >&2
    printf '[%s] backend=%s wayland=%s session=%s portal=%s\n' "$(date -Is)" "$(graphics_backend)" "${WAYLAND_DISPLAY:-}" "${XDG_SESSION_TYPE:-}" "$(graphics_portal_state)" >>"$discord_log"

    # Remove travas Singleton orfas que fazem o Chromium fechar imediatamente com before-quit
    rm -f "$_USER_HOME/.config/discord/Singleton"* 2>/dev/null || true
    rm -f "$_USER_HOME/.config/discordptb/Singleton"* 2>/dev/null || true
    rm -f "$_USER_HOME/.config/discordcanary/Singleton"* 2>/dev/null || true

    local target_cmd=""
    # Fallback de alvo manual: o comando veio validado da GUI e e refeito aqui como parametros
    # posicionais — um caminho com espaco nao pode virar duas palavras.
    if [ "$(printf '%s' "$linha" | cut -d'|' -f3)" = "manual" ]; then
        manual_target_read
        if ! manual_target_validate; then
            printf '[%s] launch=falhou motivo=alvo_manual_invalido\n' "$(date -Is)" >>"$discord_log"
            warn "O alvo manual nao esta mais disponivel. Escolha o programa de novo na GUI."
            return 1
        fi
        case "$MANUAL_KIND" in
            flatpak) set -- flatpak run "$MANUAL_KEY" ;;
            snap) set -- snap run "$MANUAL_KEY" ;;
            *) set -- "$MANUAL_KEY" ;;
        esac
        printf '[%s] launch=manual kind=%s key=%s\n' "$(date -Is)" "$MANUAL_KIND" "$MANUAL_KEY" >>"$discord_log"
        if [ "${START_DISCORD_HOST_ONLY:-0}" -eq 1 ]; then
            printf '[%s] launch=host-fallback\n' "$(date -Is)" >>"$discord_log"
            run_user_host_command detached "$ENV_BINARY" $run_env sh -c 'exec "$@"' sh "$@" >>"$discord_log" 2>&1 </dev/null
        elif have setsid; then
            run_user_netns_command detached "$ENV_BINARY" $run_env sh -c 'exec "$@"' sh "$@" >>"$discord_log" 2>&1 </dev/null
        else
            run_user_netns_command background "$ENV_BINARY" $run_env sh -c 'exec "$@"' sh "$@" >>"$discord_log" 2>&1 </dev/null
        fi
        printf '  Log do Discord: %s\n' "$discord_log" >&2
        return 0
    fi
    id="$(printf '%s' "$linha" | cut -d'|' -f4)"
    if [ -z "$id" ] && [ -n "$resources" ] && have flatpak; then
        id="$(flatpak_app_id "$resources" 2>/dev/null || true)"
    fi
    if [ -n "$id" ] && have flatpak; then
        target_cmd="flatpak run $id"
    elif [ -n "$linha" ]; then
        flav="$(printf '%s' "$linha" | cut -d'|' -f2)"
        case "$flav" in
            equibop|vesktop|legcord)
                if have "$flav"; then target_cmd="$flav"; fi
                ;;
        esac
    fi

    if [ -z "$target_cmd" ] && [ -n "$resources" ] && [ -d "$resources" ]; then
        local dc_path
        dc_path="$(find "$resources/.." -maxdepth 2 -type f -executable \
            \( -iname "Discord" -o -iname "DiscordCanary" -o -iname "DiscordPTB" \) \
            2>/dev/null | head -1 || true)"
        if [ -n "$dc_path" ] && [ -x "$dc_path" ]; then
            target_cmd="$dc_path"
        fi
    fi

    if [ -z "$target_cmd" ]; then
	    for exe in discord Discord discord-canary discordcanary DiscordCanary discordptb DiscordPTB; do
            if have "$exe"; then
                target_cmd="$exe"
                break
            fi
        done
    fi
    
    if [ -z "$target_cmd" ]; then
        printf '[%s] launch=falhou motivo=binario_nao_encontrado resources=%s\n' \
            "$(date -Is)" "$resources" >>"$discord_log"
	return 1
    fi

    if [ "${START_DISCORD_HOST_ONLY:-0}" -eq 1 ]; then
        # Rollback: depois de remover um namespace incompleto, reabra o cliente
        # diretamente na sessao do usuario. Isto deixa claro que o bypass falhou,
        # sem colocar um processo dentro de uma rota que nao foi validada.
        printf '[%s] launch=host-fallback\n' "$(date -Is)" >>"$discord_log"
        if have setsid; then
            run_user_host_command detached "$ENV_BINARY" $run_env sh -c 'exec "$@"' sh $target_cmd >>"$discord_log" 2>&1 </dev/null
        else
            run_user_host_command background "$ENV_BINARY" $run_env sh -c 'exec "$@"' sh $target_cmd >>"$discord_log" 2>&1 </dev/null
        fi
        printf '  Log do Discord: %s\n' "$discord_log" >&2
        return 0
    fi
    local lancamento_rc=0
    if [ -n "$id" ]; then
        # Flatpak depende do barramento e do portal da sessão gráfica do usuário.
        # Uma unidade transitória do systemd do sistema (o caminho anterior) inicia
        # o launcher como root e perde essa sessão no Bazzite, fazendo o bwrap sair
        # antes de o Discord aparecer. Entrar no namespace diretamente preserva o
        # ambiente Wayland/DBus e ainda mantém o tráfego isolado no WireGuard.
        printf '[%s] launch=flatpak-direct app=%s\n' "$(date -Is)" "$id" >>"$discord_log"
        if have setsid; then
            run_user_netns_command detached "$ENV_BINARY" $run_env sh -c 'exec "$@"' sh $target_cmd >>"$discord_log" 2>&1 </dev/null || lancamento_rc=$?
        else
            run_user_netns_command background "$ENV_BINARY" $run_env sh -c 'exec "$@"' sh $target_cmd >>"$discord_log" 2>&1 </dev/null || lancamento_rc=$?
        fi
    elif have systemd-run; then
        # O arquivo captura o stderr/stdout do cliente para diferenciar crash,
        # atualizacao e encerramento pelo portal. --collect evita unidades
        # antigas acumuladas sem habilitar restart automatico.
        # systemd-run so enfileira a unidade e retorna logo. Nao o coloque em
        # background: o trap de fim do script apaga a senha temporaria, e o
        # processo destacado tentava le-la tarde demais, deixando o Discord
        # fechado apesar de o tunel estar ativo.
        run_user_systemd_command "discord-vpn-$(date +%s)" \
            "PATH=$PATH" "HOME=$_USER_HOME" "USER=$run_user" "LOGNAME=$run_user" "DISPLAY=${DISPLAY:-}" \
            "WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-}" "XAUTHORITY=${XAUTHORITY:-$_USER_HOME/.Xauthority}" \
            "XDG_RUNTIME_DIR=$runtime_dir" "DBUS_SESSION_BUS_ADDRESS=${DBUS_SESSION_BUS_ADDRESS:-unix:path=/run/user/$run_uid/bus}" \
            "PULSE_SERVER=${PULSE_SERVER:-unix:$runtime_dir/pulse/native}" "XDG_SESSION_TYPE=${XDG_SESSION_TYPE:-}" \
            "XDG_CURRENT_DESKTOP=${XDG_CURRENT_DESKTOP:-}" "XDG_SESSION_DESKTOP=${XDG_SESSION_DESKTOP:-}" \
            "DESKTOP_SESSION=${DESKTOP_SESSION:-}" "GDK_BACKEND=${GDK_BACKEND:-}" \
            "QT_QPA_PLATFORM=${QT_QPA_PLATFORM:-}" "PIPEWIRE_REMOTE=${PIPEWIRE_REMOTE:-}" \
            "ELECTRON_OZONE_PLATFORM_HINT=${ELECTRON_OZONE_PLATFORM_HINT:-auto}" \
            sh -c 'exec "$@"' sh $target_cmd >>"$discord_log" 2>&1 || lancamento_rc=$?
    else
        run_user_netns_command background "$ENV_BINARY" $run_env sh -c 'exec "$@"' sh $target_cmd >>"$discord_log" 2>&1 </dev/null || lancamento_rc=$?
    fi
    if [ "$lancamento_rc" -ne 0 ]; then
        # Registrado sem data entre colchetes no extrato final: a mensagem de falha
        # da ativacao cola esta linha como a causa observada.
        printf 'launch=falhou rc=%s alvo=%s\n' "$lancamento_rc" "$target_cmd" >>"$discord_log"
    fi
    printf '  Log do Discord: %s\n' "$discord_log" >&2
    return "$lancamento_rc"
}

# O launcher confirma apenas que o processo foi solicitado; o Electron pode falhar
# logo depois (DISPLAY/Wayland, atualizacao, bwrap ou Flatpak sem override). Aguarde
# o PID correto e confirme sua rede no namespace antes de declarar a ativacao concluida.
wait_discord_started() {
    local linha="${1:-}" flav="" flatpak_id="" resources="" pid="" tentativas=40
    resources="$(printf '%s' "$linha" | cut -d'|' -f1)"
    flav="$(printf '%s' "$linha" | cut -d'|' -f2)"
    flatpak_id="$(printf '%s' "$linha" | cut -d'|' -f4)"
    # Motivo observado da espera: a mensagem de falha da ativacao usa isto para
    # distinguir "o launcher nao abriu nada" de "uma instancia ficou fora do
    # namespace" e dizer o proximo passo em vez de entregar um beco sem saida (#327).
    WAIT_DISCORD_MOTIVO="sem-processo"
    while [ "$tentativas" -gt 0 ]; do
        WAIT_DISCORD_MOTIVO="sem-processo"
        pid="$(discord_pid_flav "$flav" "$flatpak_id" "$resources" 2>/dev/null || true)"
        if [ -n "$pid" ]; then
            if discord_pid_in_netns_elevated "$pid"; then
                WAIT_DISCORD_MOTIVO="confirmado"
                return 0
            fi
            # O processo existe, mas fora do namespace: instancia antiga que ficou
            # fora do tunel (o `flatpak run` so reativaria ela, nunca criaria outra).
            WAIT_DISCORD_MOTIVO="fora-do-namespace"
        fi
        tentativas=$((tentativas - 1))
        [ "$tentativas" -gt 0 ] && sleep 0.5
    done
    return 1
}

# Mensagem acionavel da ativacao quando o cliente nao apareceu no namespace. A GUI
# mostra so as ultimas linhas do stderr, entao motivo, ultima saida do launcher, log
# e proximo passo precisam caber nesta linha unica: "nao iniciou" sem saida nao pode
# se repetir (#327/#330).
falha_lancamento_mensagem() {
    local linha="${1:-}" motivo="${WAIT_DISCORD_MOTIVO:-sem-processo}" id="" log="${START_DISCORD_LOG:-}" erro="" acao=""
    case "$linha" in
        *'|'*) id="$(printf '%s' "$linha" | cut -d'|' -f4)" ;;
    esac
    if [ -n "$log" ] && [ -f "$log" ]; then
        # As linhas proprias do script trazem data entre colchetes ou marcadores
        # launch=/backend=; o que sobra e a saida real do launcher (flatpak/bwrap/
        # Electron), que e a causa visivel. Sem saida nenhuma, o proprio marcador
        # de falha (rc/motivo) vira a causa.
        erro="$(tail -n 20 "$log" 2>/dev/null | sed -E 's/^\[[^]]*\] //' \
            | grep -Ev '^(backend=|launch=|$)' \
            | tail -1 | tr -d '\r' | cut -c1-200 || true)"
        if [ -z "$erro" ]; then
            erro="$(grep -E 'launch=falhou' "$log" 2>/dev/null | tail -1 | tr -d '\r' | cut -c1-200 || true)"
        fi
    fi
    case "$motivo" in
        fora-do-namespace)
            if [ -n "$id" ]; then
                acao="uma instancia do $id ficou fora do namespace; rode 'flatpak kill $id' e ative de novo"
            else
                acao="um processo antigo ficou fora do namespace; feche o Discord e ative de novo"
            fi
            ;;
        *)
            if [ -n "$id" ]; then
                acao="rode 'flatpak run $id' fora do bypass para ver o erro do sandbox, ou use o Discord nativo"
            else
                acao="abra o Discord fora do bypass para ver o erro, ou use outro Discord instalado"
            fi
            ;;
    esac
    printf 'Discord nao iniciou dentro do namespace WireGuard: %s; saida do launcher: %s; log: %s.' \
        "$acao" "${erro:-nenhuma}" "${log:-nao gerado}"
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
        "Instalar o bypass" \
        "Ver status" \
        "Verificar atualizacoes" \
        "Atualizar standalone" \
        "Desinstalar" \
        "Sair")"
    case "$st_choice" in
        1) : ;;  # continua no fluxo de instalação abaixo
        2) MODE="status"; JSON=0 ;;
        3) MODE="check-update" ;;
        4) MODE="update" ;;
        5) MODE="uninstall" ;;
        *) printf '  %sAte mais.%s\n' "$C_DIM" "$C_OFF"; exit 0 ;;
    esac
    # Se veio de "Ver status" ou "Desinstalar", despacha abaixo (code continua).
fi

# O menu TUI tambem pode selecionar status depois do parser de argumentos.
case "$MODE" in
    status|probe) NONINTERACTIVE=1 ;;
esac

case "$MODE" in
    check-update) standalone_check_update; exit 0 ;;
    update) standalone_update; exit 0 ;;
esac

aviso_empacotado

if [ "$MODE" = "probe" ]; then
    wireguard_gateway_probe
    exit $?
fi
# ---- selecao de alvos (escolher QUAL Discord patchear) --------------------
# rotulo_flavour <flav> → nome legivel para o seletor.
rotulo_flavour() {
    case "$1" in
        discord)       printf 'Discord' ;;
        discordptb)    printf 'Discord PTB' ;;
        discordcanary) printf 'Discord Canary' ;;
        vesktop)       printf 'Vesktop' ;;
        equibop)       printf 'Equibop' ;;
        legcord)       printf 'Legcord' ;;
        *)             printf '%s' "$1" ;;
    esac
}

# estado_label <resources> → estado da injecao em texto.
estado_label() {
    case "$(injection_state "$1")" in
        nosso)    printf 'com o GoLiveBypass standalone' ;;
        outromod) printf 'com Equicord/Vencord' ;;
        *)        printf 'sem nada instalado' ;;
    esac
}

# parse_selecao <entrada> <total> → imprime os indices escolhidos, um por linha.
# "t"/"todos"/vazio = todos. Aceita "1,3", "2-4" e misturas. Invalido = codigo 1.
parse_selecao() {
    local entrada="$1" total="$2" tok a b res=""
    case "$entrada" in
        ""|"t"|"T"|"todos"|"Todos"|"TODOS") printf '%s\n' "$(st_seq 1 "$total" | sed 's/ *$//')"; return 0 ;;
    esac
    for tok in $(printf '%s' "$entrada" | tr ',;' '  '); do
        case "$tok" in
            *-*)
                a="${tok%%-*}"; b="${tok#*-}"
                case "$a$b" in *[!0-9]*) return 1 ;; esac
                [ "$a" -ge 1 ] && [ "$b" -le "$total" ] && [ "$a" -le "$b" ] || return 1
                res="$res $(st_seq "$a" "$b")"
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

# escolher_alvos <acao> → filtra $FOUND pela escolha do usuario. 1 alvo: sem
# pergunta. -Yes ou entrada nao-interativa: todos (comportamento de antes do
# seletor). Com TTY e mais de um: multi-select (TUI) ou entrada textual.
escolher_alvos() {
    local acao="$1" total resp linha i tentativa
    total="$(printf '%s\n' "$FOUND" | grep -c . || true)"
    [ "$total" -le 1 ] && { printf '%s\n' "$FOUND"; return 0; }
    if [ "$ASSUME_YES" -eq 1 ] || [ ! -t 0 ]; then printf '%s\n' "$FOUND"; return 0; fi

    if st_tui_is_interactive; then
        set --
        while IFS='|' read -r linha; do
            [ -z "$linha" ] && continue
            case "$linha" in *'|'*) set -- "$@" "$(rotulo_flavour "$(printf '%s' "$linha" | cut -d'|' -f2)") - $(estado_label "$(printf '%s' "$linha" | cut -d'|' -f1)")" ;; esac
        done <<EOF
$FOUND
EOF
        resp="$(st_tui_multi "Quais Discords quer $acao?" "$@")"
        if [ "$resp" = "0" ]; then
            printf '  %sCancelado.%s\n' "$C_DIM" "$C_OFF" >&2
            exit 0
        fi
    else
        # Terminal sem espaco para a TUI: lista numerada e entrada textual.
        tentativa=0
        while [ "$tentativa" -lt 3 ]; do
            i=0
            while IFS='|' read -r linha; do
                [ -z "$linha" ] && continue
                i=$((i+1))
                printf '    [%d] %s - %s\n' "$i" "$(rotulo_flavour "$(printf '%s' "$linha" | cut -d'|' -f2)")" "$(estado_label "$(printf '%s' "$linha" | cut -d'|' -f1)")" >&2
            done <<EOF
$FOUND
EOF
            printf '  Escolha (ex.: 1,3 · 2-4 · t = todos · Enter = todos): ' >&2
            read -r resp || resp=""
            if resp="$(parse_selecao "$resp" "$total")"; then break; fi
            warn "Escolha invalida."
            tentativa=$((tentativa+1))
        done
        [ "$tentativa" -lt 3 ] || resp="$(st_seq 1 "$total")"
    fi

    # Filtra $FOUND pelos indices escolhidos (na mesma ordem da lista).
    i=0
    while IFS='|' read -r linha; do
        [ -z "$linha" ] && continue
        i=$((i+1))
        case " $resp " in
            *" $i "*) printf '%s\n' "$linha" ;;
        esac
    done <<EOF
$FOUND
EOF
}

[ "$MODE" = "ensure-dependencies" ] && {
    linux_ensure_dependencies
    exit 0
}
FOUND="$(discord_dirs; manual_target_line)"
[ "$MODE" = "preflight" ] && {
    if [ "$JSON" -eq 1 ]; then
        linux_preflight_json
    else
        linux_preflight_json | sed -e 's/^{//' -e 's/}$/\n}/' >&2
    fi
    exit 0
}
[ -n "$FOUND" ] || fail "Nao achei nenhum Discord instalado."

# Segunda barreira no proprio standalone: a GUI faz o mesmo preflight, mas as
# dependencias podem mudar entre as duas chamadas. Nunca limpe legado nem feche
# o Discord se o ambiente ja nao puder criar o namespace WireGuard.
if [ "$MODE" = "install" ]; then
    preflight_now="$(linux_preflight_json)"
    preflight_ok="$(printf '%s' "$preflight_now" | sed -n 's/.*"ok":\(true\|false\).*/\1/p')"
    if [ "$preflight_ok" != "true" ]; then
        preflight_hint="$(printf '%s' "$preflight_now" | sed -n 's/.*"installCommand":"\([^"]*\)".*/\1/p')"
        # O modulo ausente tem prioridade sobre o texto de dependencias: ele nao se resolve
        # instalando pacote nenhum.
        preflight_kernel="$(printf '%s' "$preflight_now" | sed -n 's/.*"wireguard":"\([^"]*\)".*/\1/p')"
        if [ "$preflight_kernel" = "missing" ]; then
            preflight_running="$(printf '%s' "$preflight_now" | sed -n 's/.*"running":"\([^"]*\)".*/\1/p')"
            preflight_modules="$(printf '%s' "$preflight_now" | sed -n 's/.*"modulesInstalled":\(true\|false\).*/\1/p')"
            if [ "$preflight_modules" = "false" ]; then
                fail "O kernel Linux em execucao (${preflight_running:-atual}) nao possui os modulos instalados. Reinicie no kernel instalado, instale os modulos correspondentes ou instale o wireguard-go (WireGuard de usuario) antes de ativar."
            fi
            fail "O modulo WireGuard nao esta disponivel no kernel Linux em execucao (${preflight_running:-atual}). Instale ou ative o modulo WireGuard, ou instale o wireguard-go (WireGuard de usuario), antes de ativar."
        fi
        fail "Preflight Linux reprovado. Instale as dependencias e tente novamente.${preflight_hint:+ Comando: $preflight_hint}"
    fi
fi


if [ "$MODE" = "refresh" ]; then
    # Primeiro o que nao exige root: sem namespace ativo nao existe troca de rota,
    # e pedir a senha so para descobrir isso era o comportamento antigo.
    have ip || fail "Comando 'ip' nao encontrado no sistema."
    have wg || fail "Comando 'wg' (wireguard-tools) nao encontrado."
    netns_exists || fail "Namespace WireGuard '$NETNS_NAME' nao esta ativo."
    # A troca reaplica peer, enderecos e rotas: autoriza uma vez, como a ativacao,
    # com os eventos visiveis para a GUI decidir o prompt.
    authorize_install_elevation || fail "Nao foi possivel autorizar a troca de rota (resultado ${ELEVATION_RESULT})."
    refresh_wireguard_route
    log_wireguard_readiness
    exit 0
fi

if [ "$MODE" = "status" ]; then
    if [ "$JSON" -eq 1 ]; then
        route_mode_disk="wireguard"
        tor_addr_disk=""
        netns_json=false
        if netns_exists; then netns_json=true; fi
        printf '{"routeMode":"wireguard","torAddr":"","netns":%s,"wg":%s,"graphics":%s,"discords":[' "$netns_json" "$(wg_stats_json)" "$(graphics_json)"
        first=1
        printf '%s\n' "$FOUND" | while IFS='|' read -r resources flav detect id; do
            [ "$first" -eq 1 ] || printf ','
            first=0
            running="nao"
            in_namespace="nao"
            discord_pid=""
            if discord_pid="$(discord_pid_flav "$flav" "$id" "$resources" 2>/dev/null)"; then
                running="sim"
                if discord_pid_in_netns_elevated "$discord_pid"; then in_namespace="sim"; fi
            fi
            printf '{"path":"%s","state":"%s","flavour":"%s","detected_by":"%s","running":"%s","inNamespace":"%s"' "$resources" "$(injection_state "$resources")" "$flav" "$detect" "$running" "$in_namespace"
            [ -n "$discord_pid" ] && printf ',"pid":"%s"' "$discord_pid"
            if [ -n "$id" ]; then
                printf ',"flatpak_id":"%s"' "$id"
            fi
            printf '}'
        done
        printf ']}\n'
        exit 0
    fi
    printf '\n  %b=== STATUS DO DISCORD E REDE ===%b\n' "$C_BOLD" "$C_OFF" >&2
    sys_ip="$(curl -s -m 3 https://api.ipify.org 2>/dev/null || echo "Desconhecido")"
    printf '  [Rede Normal do PC]\n' >&2
    printf '    IP Publico : %s (resto do PC navega por aqui)\n\n' "$sys_ip" >&2

    printf '  [Tunel WireGuard do Discord]\n' >&2
    if netns_exists; then
        printf '  [✓] Namespace "%s" ATIVO.\n' "$NETNS_NAME" >&2
        if [ "$(id -u)" -eq 0 ] || (have sudo && "$SUDO_BIN" -n true 2>/dev/null); then
            vpn_ip="$("$SUDO_BIN" ip netns exec "$NETNS_NAME" curl -s -m 4 https://api.ipify.org 2>/dev/null || echo "N/A")"
            vpn_loc="$("$SUDO_BIN" ip netns exec "$NETNS_NAME" curl -s -m 4 https://cloudflare.com/cdn-cgi/trace 2>/dev/null | grep -E '^loc=' | cut -d= -f2 || echo "N/A")"
            printf '    IP no Discord: %s\n' "$vpn_ip" >&2
            printf '    Pais         : %s\n' "$vpn_loc" >&2
        fi
        printf '  [✓] TODO o trafego do Discord (voz, video, gateway) esta envelopado no WireGuard!\n' >&2
        wg_info="$(wg_stats_json)"
        case "$wg_info" in
            '{"ok":true'*)
                wg_hs="$(printf '%s' "$wg_info" | sed -n 's/.*"handshakeAgoS":\([^,}]*\).*/\1/p')"
                wg_rx="$(printf '%s' "$wg_info" | sed -n 's/.*"rxBytes":\([0-9]*\).*/\1/p')"
                wg_tx="$(printf '%s' "$wg_info" | sed -n 's/.*"txBytes":\([0-9]*\).*/\1/p')"
                [ "$wg_hs" = "null" ] && wg_hs="nunca"
                printf '  Handshake: ha %ss | trafego: rx=%sKB tx=%sKB\n\n' "$wg_hs" "$((${wg_rx:-0} / 1024))" "$((${wg_tx:-0} / 1024))" >&2
                ;;
            *)
                printf '  Handshake/trafego indisponivel (rode como root ou com sudo sem senha para ver).\n\n' >&2
                ;;
        esac
    else
        printf '  [!] Namespace "%s" NAO esta ativo.\n\n' "$NETNS_NAME" >&2
    fi

    printf '  [Instalacoes do Discord]\n' >&2
    printf '%s\n' "$FOUND" | while IFS='|' read -r resources flav detect id; do
        case "$(injection_state "$resources")" in
            nosso)    printf '  %s (%s): envelopado via WireGuard (%s)\n' "$resources" "$flav" "$NETNS_NAME" >&2 ;;
            outromod) printf '  %s (%s): com Equicord/Vencord (ou outro mod)\n' "$resources" "$flav" >&2 ;;
            *)        printf '  %s (%s): vanilla (sem tunel)\n' "$resources" "$flav" >&2 ;;
        esac
    done
    exit 0
fi

if [ "$MODE" = "uninstall" ] || [ "$MODE" = "restore" ]; then
    stop_discord
    teardown_wireguard_netns
    remove_tor
    printf '%s\n' "$FOUND" | while IFS='|' read -r resources flav detect id; do
        # Mesma guarda do install: so desfaz _app.asar quando a injecao ali e NOSSA. Se for
        # backup do Vencord/Equicord, restaurar por cima apaga o mod do usuario ao desativar.
        if asar_is_ours "$resources"; then
            remove_injection "$resources" && ok "$resources voltou ao normal."
        fi
    done
    if [ "$MODE" = "uninstall" ]; then
        ok "GoLiveBypass desinstalado e Discord restaurado."
    fi
    exit 0
fi

injected=0
# O while do pipe roda em subshell; o acumulador precisa ser um arquivo para o -eq valer.
lista="$(mktemp)"
tally="$(mktemp)"

# Se entramos pela TUI (instalar sem flags), pergunta a rede antes de injetar.
# Quem ja veio com o modo explicito (--net-mode ou --tor) nao e perguntado: a escolha
# da flag vence. Toda opcao grava o modo no settings.json; deixar a chave de fora
# fazia o runtime voltar ao "auto" (issue #108).
if [ "$MODE" = "install" ] && [ -z "$NET_MODE" ] && st_tui_is_interactive; then
    st_net="$(st_tui_menu "Como o bypass vai sair?" \
        "Tor automatico (recomendado, baixa e sobe sozinho)" \
        "Proxy gratuita (escolhida e testada sozinha)" \
        "Proxy minha (socks5://host:porta)")"
    case "$st_net" in
        2) PROXY="" ; TOR_MODE=0 ; NET_MODE="free" ;;
        3) PROXY="$(st_tui_input "Endereco da proxy")" ; TOR_MODE=0 ; NET_MODE="auto" ;;
        *) TOR_MODE=1 ; NET_MODE="tor" ;;
    esac
fi

# Selecao de alvos: 1 alvo = sem pergunta (como antes); varios = escolher quais
# recebem o patch (um, varios ou todos).
FOUND="$(escolher_alvos patchear)"
printf '%s\n' "$FOUND" > "$lista"
# A autorizacao precisa estar concluida antes de fechar qualquer cliente. Isso
# tambem impede que uma falha no prompt deixe o usuario sem Discord aberto.
authorize_install_elevation || fail "Nao foi possivel autorizar a ativacao Linux (resultado ${ELEVATION_RESULT}). O Discord nao foi encerrado."
# Valide o executor do usuario antes de remover configuracoes legadas ou fechar
# o cliente. `pkexec` autoriza a operacao privilegiada, mas nao substitui a
# troca segura para o usuario que deve possuir a sessao grafica.
ACTIVATION_RUN_USER="${SUDO_USER:-$(id -un 2>/dev/null || whoami)}"
prepare_run_user "$ACTIVATION_RUN_USER" || fail "Nao foi possivel preparar a execucao segura do Discord. O Discord nao foi encerrado."
ensure_wireguard_device || fail "Nao foi possivel preparar o WireGuard (modulo do kernel ou wireguard-go). O Discord nao foi encerrado."
# A limpeza legada apaga recursos e configuracoes antigas; so pode acontecer
# depois de a autorizacao da ativacao ter sido concluida.
if [ "$CLEANUP_LEGACY" -eq 1 ]; then
    cleanup_legacy_tor
fi

# A partir do stop, qualquer falha fatal precisa remover o namespace parcial e
# tentar devolver o Discord ao usuario. O trap ja existe para limpar segredos,
# mas so e habilitado para rollback aqui, depois de autorizacao e limpeza legada.
ACTIVATION_ROLLBACK_TARGET="$(select_launch_target "$FOUND")"
if discord_running; then
    ACTIVATION_ROLLBACK_REOPEN=1
else
    ACTIVATION_ROLLBACK_REOPEN=0
fi
ACTIVATION_NETNS_TOUCH_STARTED=0
ACTIVATION_ROLLBACK_PENDING=1
# O processo antigo precisa sair antes de qualquer alteracao do namespace. Isso
# tambem impede que uma troca de rota deixe duas instancias compartilhando o host.
stop_discord
while IFS='|' read -r resources flav detect id; do
    state="$(injection_state "$resources")"
    printf '  %s (%s): %s\n' "$resources" "$flav" "$state" >&2
    case "$detect" in
        flatpak-nativo) printf '  %sCliente nativo de flatpak: apenas o tunel, sem injecao de app.asar.%s\n' "$C_DIM" "$C_OFF" >&2 ;;
    esac

    if [ "$state" = "outromod" ]; then
        # Desde a migracao para WireGuard Per-App VPN o bypass nao toca mais no app.asar de
        # ninguem: o tunel envelopa o processo do Discord inteiro, seja qual for o app.asar
        # dentro dele. Antigamente o standalone e o Vencord/Equicord disputavam o mesmo lugar
        # (a injecao por pasta) e um apagava o outro sem aviso real na GUI (--yes zera o
        # confirm) -- essa nota e so informativa agora, nada e sobrescrito.
        printf '  %sEquicord/Vencord detectado em %s -- convive normalmente: o WireGuard envelopa o processo sem tocar no app.asar dele.%s\n' "$C_DIM" "$resources" "$C_OFF" >&2
    fi

    # Vesktop, Equibop e Legcord de flatpak usam Electron 18 com zypak, que tenta ler o
    # app.asar como arquivo no bootstrap: a pasta de injecao faz o app nem abrir. O Discord
    # oficial de flatpak (Electron antigo) nao tem esse problema.
    if id="$(flatpak_app_id "$resources")" && case "$id" in dev.vencord.*|app.legcord.*|org.equicord.*) true ;; *) false ;; esac; then
        warn "Flatpak do $id: a injecao por pasta app.asar nao abre este cliente (Electron 18/zypak)."
        printf '      %sPrefira a versao nativa (pacote da distro, AUR, deb/rpm) deste cliente.%s\n' "$C_DIM" "$C_OFF" >&2
        confirm "Mesmo assim injetar em $id?" || { warn "Deixei como estava."; continue; }
    fi

    # Com modo tor do proprio script, prepara o daemon antes de injetar: o settings.json
    # aponta para ele e o gateway segura ate o Tor responder (o bypass nunca cai direto
    # no modo tor). Quem manda --tor-addr (a GUI) ja prove o Tor dela: nao instala.
    if { [ "$TOR_MODE" -eq 1 ] || { [ "$NET_MODE" = "tor" ] && [ -z "$TOR_ADDR_CLI" ]; } } && ! ensure_tor; then
        warn "O Tor nao subiu. Nao vou instalar o standalone no modo tor; tente de novo ou use --proxy."
        printf '0\n' >> "$tally"
        continue
    fi

    if [ "$ACTIVATION_NETNS_TOUCH_STARTED" -eq 0 ]; then
        setup_wireguard_netns
    fi

    # So desfazemos _app.asar quando a injecao la dentro e NOSSA (versao antiga, pre-WireGuard,
    # que patcheava o app.asar). Quando e outro mod (Vencord/Equicord), _app.asar e o backup
    # DELES -- restaurar por cima apagava o mod inteiro a toa, ja que o WireGuard nem precisa
    # do app.asar vanilla para envelopar o processo.
    if asar_is_ours "$resources"; then
        remove_injection "$resources"
        ok "Injecao legada de proxy removida de $resources (Discord restaurado para vanilla)."
    fi
    printf '1\n' >> "$tally"
    ok "$resources pronto para execucao no WireGuard."
done < "$lista"
injected="$(grep -c . "$tally" || true)"
rm -f "$lista" "$tally"

if [ "$injected" -eq 0 ]; then
    # Nada foi injetado: nao reabrir (senao a GUI mostraria um "sucesso" mentiroso) e
    # falhar de verdade para o chamador enxergar.
    fail "NADA foi injetado — a elevacao falhou ou nenhum Discord foi tocado."
fi

# HTTP/handshake probes are informational and must not gate Discord startup.
wait_for_tunnel_startup
log_wireguard_readiness

# Modo portatil: reabre o Discord ja com o bypass ativo (mesmo comportamento do app do Windows).
# head -1 em vez de pipe para o while: nohup num subshell morreria junto com ele.
# O launcher pode recusar o comando antes de existir qualquer processo (sem binario,
# flatpak sem ID); falhar aqui evita esgotar a espera de 20s e entrega a mesma causa.
if ! start_discord "$(printf '%s\n' "${ACTIVATION_ROLLBACK_TARGET:-$FOUND}" | head -1)"; then
    warn "O WireGuard ficou pronto, mas o launcher do Discord recusou o comando."
    stop_discord || true
    teardown_wireguard_netns
    fail "$(falha_lancamento_mensagem "$(printf '%s\n' "${ACTIVATION_ROLLBACK_TARGET:-$FOUND}" | head -1)")"
fi
if ! wait_discord_started "$(printf '%s\n' "${ACTIVATION_ROLLBACK_TARGET:-$FOUND}" | head -1)"; then
    warn "O WireGuard ficou pronto, mas o processo do Discord nao iniciou."
    # Se o launcher chegou a criar um sandbox, mas o reconhecimento expirou, feche-o
    # antes de remover o namespace. Assim não deixamos um Flatpak órfão usando uma
    # interface WireGuard sem o nome discord-vpn.
    stop_discord || true
    teardown_wireguard_netns
    fail "$(falha_lancamento_mensagem "$(printf '%s\n' "${ACTIVATION_ROLLBACK_TARGET:-$FOUND}" | head -1)")"
fi
# A sessao ja esta confirmada dentro do namespace; a partir daqui o trap deve
# apenas limpar segredos/temporarios e nunca reabrir o cliente fora do tunel.
ACTIVATION_ROLLBACK_PENDING=0
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
# O aviso so diz respeito a quem tem injecao dentro do deploy: um registro
# "flatpak-nativo" (sem asar) e sobrevive ao update sozinho.
if printf '%s\n' "$FOUND" | grep '/flatpak/app/' | grep -v '|flatpak-nativo|' | grep -q .; then
    printf '  %sEste Discord e flatpak: um "flatpak update" desfaz a injecao. Quando isso%s\n' "$C_DIM" "$C_OFF" >&2
    printf '  %sacontecer, rode este instalador de novo.%s\n' "$C_DIM" "$C_OFF" >&2
fi
printf '  %sRegistro em %s/golivebypass.log%s\n' "$C_DIM" "$INSTALL_DIR" "$C_OFF" >&2
printf '  %sPara desfazer: ./golivebypass-standalone.sh --uninstall%s\n\n' "$C_DIM" "$C_OFF" >&2
