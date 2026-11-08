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
#   ./golivebypass-installer.sh --channel stable
#   ./golivebypass-installer.sh --channel beta --update
#   ./golivebypass-installer.sh --source ~/Equicord
#   ./golivebypass-installer.sh --plugin-source ~/GoLiveBypass/goLiveBypass
#   ./golivebypass-installer.sh --mod vencord --yes
#   ./golivebypass-installer.sh --uninstall
#   ./golivebypass-installer.sh --check-update   # consulta a API e pode persistir o canal, sem baixar ZIP
#   ./golivebypass-installer.sh --client-status  # estado da injecao em cada cliente (nao altera nada)
#   ./golivebypass-installer.sh --restore-client # devolve o app.asar original (cliente que nao abre)
#   ./golivebypass-installer.sh --restore-client Equibop --force
#
# Obrigado ao Vithor (https://github.com/Vith0r), que escreveu o primeiro instalador do
# GoLiveBypass e abriu o caminho para este aqui.

# A instalacao usa stable por padrao; beta e sempre opt-in. Sempre em stderr — o
# stdout e o contrato de --check-update/--update.
printf '\nGoLiveBypass para Equicord/Vencord — escolha seu canal de atualizacoes.\n' >&2
printf '        Stable e a opcao recomendada: canal mais previsivel, somente releases estaveis.\n' >&2
printf '        Beta e opcional: canal de testes; voce ajuda a comunidade ao testar, encontrar\n' >&2
printf '        e corrigir erros antes da versao estavel. O sistema ainda nao e estavel; nenhum canal promete estabilidade.\n' >&2
printf '        Ao testar, encontrar e corrigir erros, relate em https://github.com/bezumiya/GoLiveBypass/issues.\n' >&2
printf '        O standalone continua separado e nao e alterado por este instalador.\n\n' >&2

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
PLUGIN_FILES="goLiveBypass/index.tsx goLiveBypass/native.ts goLiveBypass/plugin-build.ts goLiveBypass/plugin-log.ts goLiveBypass/bug-report.ts goLiveBypass/update-channel.ts goLiveBypass/update-security.ts goLiveBypass/stability.ts goLiveBypass/proton-manual-selection.ts goLiveBypass/vpn-controller.ts goLiveBypass/vpn-proton.ts goLiveBypass/vpn-types.ts goLiveBypass/vpn-snapshot.ts goLiveBypass/vpn-snapshot-worker.ts goLiveBypass/vpn-windows.ts goLiveBypass/vpn-linux.ts goLiveBypass/manifest.json"
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
CHANNEL="stable"
CHANNEL_EXPLICIT=0
# Alvo de --restore-client (nome do cliente ou vazio = todos os que tem patch/backup) e o
# escape para desfazer tambem um mod que esta funcionando (--force).
RESTORE_CLIENT_TARGET=""
FORCE_RESTORE=0
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
# =========================================================================== log local
# Observabilidade LOCAL do instalador (escopo B): eventos em installer.log (JSONL) no
# diretorio de dados existente. Nao ha POST, webhook ou telemetria — o usuario copia a
# saida acima ou abre o log manualmente. Falha de escrita NUNCA derruba a instalacao.
GLB_INSTALLER_LOG_DIR="${GLB_INSTALLER_LOG_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/GoLiveBypass}"
GLB_INSTALLER_LOG="$GLB_INSTALLER_LOG_DIR/installer.log"
GLB_INSTALLER_LOG_MAX=262144
GLB_COMPONENT="installer.linux"
GLB_OPERATION_ID="installer-$(date +%s 2>/dev/null || printf 0)-$$"
GLB_ARCH="$(uname -m 2>/dev/null || printf unknown)"
GLB_PHASE="detect"
GLB_REDACT_MAX=300

_glb_json_escape() {
    printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\000-\037\177'
}

# Timestamp UTC ISO-8601 com milissegundos (GNU/busybox `date +%N`; onde nao houver,
# cai para 000 sem quebrar o formato).
_glb_ts() {
    local base ms
    base="$(date -u +%Y-%m-%dT%H:%M:%S 2>/dev/null || printf '1970-01-01T00:00:00')"
    ms="$(date -u +%N 2>/dev/null | cut -c1-3)"
    case "$ms" in ''|*[!0-9]*) ms=000 ;; esac
    printf '%s.%sZ' "$base" "$ms"
}

_glb_redact() {
    # fail-closed: credencial (inclusive em URL e cabecalho), e-mail e caminho pessoal
    # nunca chegam ao log compartilhavel.
    local texto
    texto="$(printf '%s' "$1" | tr '\r\n\t' '   ')"
    # Cabecalho de autenticacao consome o resto; token Bearer/Basic isolado tambem.
    texto="$(printf '%s' "$texto" | sed -E 's#([Aa]uthorization[[:space:]]*:[[:space:]]*)([^[:space:]]+[[:space:]]+)?[^[:space:]]+#\1<redacted>#g')"
    texto="$(printf '%s' "$texto" | sed -E 's#([Bb]earer[[:space:]]+)[^[:space:]]+#\1<redacted>#g')"
    # URL com credenciais: usuário, senha, host e path são privados.
    texto="$(printf '%s' "$texto" | sed -E 's#(^|[^A-Za-z0-9])[A-Za-z][A-Za-z0-9+.-]*://[^/[:space:]@]+(:[^/[:space:]@]*)?@[^[:space:]]+#\1<redacted-url>#g')"
    # E-mail.
    texto="$(printf '%s' "$texto" | sed -E 's#[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}#<email>#g')"
    # chave=valor de credencial.
    texto="$(printf '%s' "$texto" | sed -E 's/(password|senha|token|secret|private[_]?key|public[_]?key|authorization|cookie|session|credential|twofactorcode|captchatoken)[[:space:]]*[:=][[:space:]]*[^[:space:]]+/\1=<redacted>/Ig')"
    # Caminhos: Windows, UNC e POSIX absoluto. As regras exigem fronteira/nao-barra
    # para nao destruir URL publica (https://...) nem o "s:/" do proprio scheme.
    texto="$(printf '%s' "$texto" | sed -E 's#(^|[^A-Za-z0-9])[A-Za-z]:[\\/][^[:space:]]*#\1<path>#g; s#\\\\[^[:space:]]*#<path>#g; s#(^|[[:space:]:=])/([^/[:space:]][^[:space:]]*)#\1<path>#g')"
    printf '%s' "$texto" | cut -c1-"$GLB_REDACT_MAX"
}

_glb_trim_log() {
    local tamanho
    [ -f "$GLB_INSTALLER_LOG" ] || return 0
    tamanho="$(wc -c < "$GLB_INSTALLER_LOG" 2>/dev/null || printf 0)"
    case "$tamanho" in ''|*[!0-9]*) return 0 ;; esac
    [ "$tamanho" -gt "$GLB_INSTALLER_LOG_MAX" ] || return 0
    tail -c $((GLB_INSTALLER_LOG_MAX / 2)) "$GLB_INSTALLER_LOG" 2>/dev/null \
        | sed '1d' > "$GLB_INSTALLER_LOG.tmp" 2>/dev/null \
        && mv "$GLB_INSTALLER_LOG.tmp" "$GLB_INSTALLER_LOG" 2>/dev/null \
        || rm -f "$GLB_INSTALLER_LOG.tmp" 2>/dev/null || true
    return 0
}

_glb_log_write() {
    local linha="$1"
    mkdir -p "$GLB_INSTALLER_LOG_DIR" 2>/dev/null || return 0
    _glb_trim_log
    printf '%s\n' "$linha" >> "$GLB_INSTALLER_LOG" 2>/dev/null || true
    _glb_trim_log
    return 0
}

# installer_log <nivel> <evento> <fase> [chave valor]...
# So chaves conhecidas entram em data; chave proibida vira <redacted> e chave desconhecida
# e descartada (fail-closed). Valores numericos/booleanos conhecidos saem tipados.
installer_log() {
    local nivel="$1" evento="$2" fase="$3"
    shift 3
    local data="" sep="" chave valor par
    while [ "$#" -ge 2 ]; do
        chave="$1"; valor="$2"; shift 2
        # Chave normalizada: a comparacao proibida/allowlist e case-insensitive e a chave
        # emitida e sempre a canonica minuscula.
        chave="$(printf '%s' "$chave" | tr '[:upper:]' '[:lower:]')"
        case "$chave" in
            *password*|*senha*|*token*|*captcha*|*secret*|*privatekey*|*private_key*|*publickey*|*authorization*|*cookie*|*session*|*credential*|*stdin*|*rawconfig*|config|endpoint)
                valor="<redacted>" ;;
            mode|channel|permanent|we_injected|target_count|candidate_count|discord_count|mod_kind|reason|reason_code|result|exit_code|duration_ms|path_present|path_kind|active|preserved|identity|count|pnpm_version|pnpm_esperado|node_version|node_modules|deps_sync)
                valor="$(_glb_redact "$valor")" ;;
            *) continue ;;
        esac
        case "$chave" in
            target_count|candidate_count|discord_count|exit_code|duration_ms|count)
                case "$valor" in ''|*[!0-9]*) par="\"$chave\":\"$(_glb_json_escape "$valor")\"" ;;
                    *) par="\"$chave\":$valor" ;; esac ;;
            path_present|permanent|we_injected|active|preserved|node_modules)
                case "$valor" in true|false) par="\"$chave\":$valor" ;;
                    *) par="\"$chave\":\"$(_glb_json_escape "$valor")\"" ;; esac ;;
            *) par="\"$chave\":\"$(_glb_json_escape "$valor")\"" ;;
        esac
        data="$data$sep$par"
        sep=","
    done
    _glb_log_write "{\"schema_version\":1,\"ts\":\"$(_glb_ts)\",\"level\":\"$nivel\",\"component\":\"$GLB_COMPONENT\",\"event\":\"$(_glb_json_escape "$evento")\",\"operation_id\":\"$GLB_OPERATION_ID\",\"phase\":\"$(_glb_json_escape "$fase")\",\"platform\":\"linux\",\"arch\":\"$(_glb_json_escape "$GLB_ARCH")\",\"data\":{$data}}"
    return 0
}

fail() {
    local msg="$1"
    printf '\n  %s[X] %s%s\n\n' "$C_RED" "$msg" "$C_OFF" >&2
    installer_log error installer.failed "$GLB_PHASE" reason "$msg"
    printf '  %sLog local: %s%s\n' "$C_DIM" "$GLB_INSTALLER_LOG" "$C_OFF" >&2
    printf '  %sCopie a saida acima ou abra o log para relatar.%s\n\n' "$C_DIM" "$C_OFF" >&2
    exit 1
}
# =========================================================================== /log local

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

# =========================================================================== /Report de bugs
# Nao ha envio remoto: qualquer relato e manual. O usuario copia a saida do terminal ou
# abre o installer.log no diretorio de dados. Nenhum token, POST, webhook ou payload.

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

# Corta um rotulo no limite da caixa da TUI, com ".." no fim do que ficou de fora. Sem isto um
# rotulo maior que a largura deixava o pad negativo, ele nao era aplicado e a borda direita da
# caixa saia no meio do texto.
tui_corta() { # $1 = texto, $2 = largura maxima
    local txt="$1" max="$2"
    if [ "$max" -gt 2 ] && [ "${#txt}" -gt "$max" ]; then
        printf '%s..' "$(printf '%s' "$txt" | cut -c 1-$((max-2)))"
    else
        printf '%s' "$txt"
    fi
    return 0
}

# Desenha uma caixa com titulo e linhas de conteudo. Cada elemento de `lines` ja vem
# com o texto pronto (sem as bordas).
tui_box() {
    local title="$1"; shift
    tui_size
    local w="$(tui_largura)" line txt i
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

# Largura da caixa da TUI. Acompanha o terminal porque o seletor de alvo precisa caber
# "cliente + onde ele mora + aviso", e as 62 colunas fixas cortavam justamente o aviso nas
# entradas de caminho longo. Piso de 62 para nao quebrar em terminal estreito, teto de 96 para
# nao esticar demais em monitor largo.
tui_largura() {
    local w=$(( ${TUI_COLS:-80} - 4 ))
    [ "$w" -lt 62 ] && w=62
    [ "$w" -gt 96 ] && w=96
    printf '%s\n' "$w"
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
    local w="$(tui_largura)"
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
# patchear: Espaco marca/desmarca, 'a' marca/desmarca todos. Enter confirma as
# marcas existentes ou, sem marcas, escolhe o item destacado. Esc cancela.
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
    local w="$(tui_largura)"
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
            # O rotulo e cortado no limite da caixa: sem isso um alvo com caminho longo
            # empurrava a borda direita e desenhava a caixa torta.
            txt="$(tui_corta "$txt" $((w-11)))"
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
                case "$marks" in
                    *1*) ;;
                    *)
                        if [ "$sel" -gt 0 ]; then antes="$(printf '%s' "$marks" | cut -c 1-$sel)"; else antes=""; fi
                        marks="${antes}1$(printf '%s' "$marks" | cut -c $((sel+2))-"")"
                        ;;
                esac
                break
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
        --channel)
            CHANNEL="${2:-}"
            case "$CHANNEL" in
                stable|beta) CHANNEL_EXPLICIT=1 ;;
                *) fail "Canal invalido: use --channel stable ou --channel beta." ;;
            esac
            shift
            ;;
        --mod) MOD="${2:-}"; shift ;;
        --source) SOURCE="${2:-}"; shift ;;
        --plugin-source) PLUGIN_SOURCE="${2:-}"; shift ;;
        --restore-client)
            MODE="restore-client"
            case "${2:-}" in
                ""|-*) ;;
                *) RESTORE_CLIENT_TARGET="${2:-}"; shift ;;
            esac
            ;;
        --client-status) MODE="client-status" ;;
        --force) FORCE_RESTORE=1 ;;
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
# Verdadeiro para Equibop/Vesktop/Legcord, que nao sao o Discord puro. O nome do cliente pode
# estar no MEIO do caminho: no flatpak o alvo e .../files/bin/vesktop/resources, e no
# ~/.local/share/vesktop ele e a propria raiz. Casar so o final do caminho deixava o Vesktop
# de fora, e ele era oferecido como Discord oficial -- cujo pnpm inject so sabe responder
# "Invalid Discord install". Por isso o casamento e por componente, com barra dos dois lados.
is_parallel_install() {
    case "/$1/" in
        */vesktop/*|*/Vesktop/*|*/equibop/*|*/Equibop/*|*/legcord/*|*/Legcord/*) return 0 ;;
        *) return 1 ;;
    esac
}

# Busca crua: varre os caminhos conhecidos e pode repetir o MESMO diretorio por caminhos
# diferentes (/usr/lib e /usr/lib64, quando lib64 e symlink). Os consumidores usam
# discord_resources() logo abaixo, que ja vem deduplicado.
discord_resources_raw() {
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
            # files/<app>/resources e o layout do Discord; Vesktop, Equibop e Legcord poem o
            # app em files/bin/<app>/resources. O glob do shell nao atravessa "/", entao o
            # segundo nivel precisa ser listado: sem ele NENHUM cliente paralelo de flatpak
            # era encontrado, e o seletor nao tinha o que o usuario tinha instalado.
            for sub in "$raiz/$id"/current/active/files/*/resources \
                       "$raiz/$id"/current/active/files/*/*/resources; do
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

# Lista de alvos sem repeticao. A ordem e a da busca crua e a primeira ocorrencia vence.
# O dedup fica entre a busca e os consumidores para que injected_resources(), installed_mod()
# e checkout_from_injection() tambem parem de olhar o mesmo diretorio duas vezes.
discord_resources() {
    discord_resources_raw | dedup_alvos
}

# Resolve symlinks para comparar caminhos que sao o MESMO diretorio. Onde /usr/lib64 e um
# symlink para lib (Arch, Fedora), /usr/lib/equibop e /usr/lib64/equibop eram listados como
# duas instalacoes diferentes -- o usuario via "Equibop" duas vezes e nao tinha como saber
# que eram a mesma. Sem readlink, cai no caminho cru (pior caso: volta a duplicar).
alvo_canonico() {
    if have readlink; then
        readlink -f "$1" 2>/dev/null || printf '%s\n' "$1"
    else
        printf '%s\n' "$1"
    fi
}

# Remove da lista os caminhos que apontam para o mesmo lugar, preservando a ordem e ficando
# com a PRIMEIRA ocorrencia (a mais "canonica" dos loops de busca).
dedup_alvos() {
    local vistos="" alvo real
    while IFS= read -r alvo; do
        [ -n "$alvo" ] || continue
        real="$(alvo_canonico "$alvo")"
        case "$vistos" in
            *"|$real|"*) continue ;;
        esac
        vistos="$vistos|$real|"
        printf '%s\n' "$alvo"
    done
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
injection_identities() {
    local resources path
    # `discord_resources` inclui Equibop/Vesktop/Legcord para o patch direto. Esses
    # clientes paralelos já carregam o mod dentro do próprio app e não podem ser tratados
    # como conflito do checkout escolhido para o Discord oficial.
    while IFS= read -r resources; do
        path="$(injected_path "$resources" || true)"
        [ -n "$path" ] || continue
        case "$(printf '%s' "$path" | tr '[:upper:]' '[:lower:]')" in
            *equibop*) printf 'Equibop\n' ;;
            *equicord*) printf 'Equicord\n' ;;
            *vesktop*) printf 'Vesktop\n' ;;
            *vencord*) printf 'Vencord\n' ;;
            *legcord*) printf 'Legcord\n' ;;
            *) printf 'desconhecido\n' ;;
        esac
    done <<EOF
$(discord_installs)
EOF
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
    local root installed
    if [ -n "$SOURCE" ]; then
        installer_log info installer.checkout_candidate detect candidate_kind source candidate_count 1
        if is_checkout "$SOURCE"; then
            installer_log info installer.selected detect candidate_kind source path_present true
            printf '%s\n' "$SOURCE"; return 0
        fi
        installer_log warn installer.checkout_rejected detect candidate_kind source reason_code SOURCE_NOT_A_CHECKOUT
        fail "Nao encontrei um checkout do Equicord ou Vencord em $SOURCE"
    fi

    installer_log info installer.checkout_candidate detect candidate_kind injection
    if root="$(checkout_from_injection)"; then
        installer_log info installer.selected detect candidate_kind injection path_present true
        ok "Achei pelo Discord: $root"
        printf '%s\n' "$root"; return 0
    fi

    installer_log info installer.checkout_candidate detect candidate_kind disk
    if root="$(checkout_on_disk)"; then
        installer_log info installer.selected detect candidate_kind disk path_present true
        ok "Achei no disco: $root"
        printf '%s\n' "$root"; return 0
    fi

    # Um Discord já patchado, mas sem checkout fonte, não pode cair no clone
    # padrão de Equicord/Vencord: isso substituiria silenciosamente o mod que
    # o usuário já usa. Preserve o app.asar e peça o checkout correto.
    installed="$(installed_mod || true)"
    if [ -n "$installed" ]; then
        # #293: mod detectado, checkout nao provado. A distincao fica por codigo
        # (a mensagem livre nao leva caminho pessoal ao log).
        installer_log warn installer.checkout_rejected detect reason_code MOD_INSTALLED_WITHOUT_CHECKOUT mod_kind "$installed"
        fail "Detectei $installed no Discord, mas nao encontrei o checkout fonte. Nenhum mod foi substituido; use --source apontando para o checkout $installed."
    fi

    installer_log warn installer.checkout_rejected detect reason_code CHECKOUT_NOT_FOUND
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
    installer_log info installer.selected preparing mode download mod_kind "$choice"

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
# O lock nativo pertence somente ao Discord oficial. Clientes em flatpak têm outro diretório de
# dados e não podem impedir a recuperação do lock desta instalação.
native_discord_running() {
    pgrep -x -i 'Discord|DiscordCanary|DiscordPTB|discord|discord-canary|discordptb' >/dev/null 2>&1
}

discord_running() {
    native_discord_running && return 0

    # Um `flatpak ps` so, e nao um por id: isto roda em laco de dois em dois segundos enquanto
    # o modo temporario espera o Discord fechar.
    if have flatpak; then
        local rodando
        rodando="$(flatpak ps --columns=application 2>/dev/null || true)"
        case "$rodando" in *com.discordapp.*|*dev.vencord.*|*app.legcord.*|*org.equicord.*) return 0 ;; esac
    fi
    return 1
}

# O Chromium deixa Singleton* como links no diretório de dados. Depois de um crash ou
# encerramento forçado eles podem apontar para alvos inexistentes e fazer a próxima abertura
# sair silenciosamente. Só limpamos esses locks quando nenhum Discord nativo está ativo; locks
# de um processo nativo vivo permanecem intactos.
clear_stale_discord_locks() {
    local dir="${XDG_CONFIG_HOME:-$HOME/.config}/discord" item
    native_discord_running && return 0
    [ -d "$dir" ] || return 0
    for item in SingletonCookie SingletonLock SingletonSocket; do
        [ -L "$dir/$item" ] || continue
        rm -f "$dir/$item" 2>/dev/null || true
    done
    return 0
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
validate_plugin_source_tree() {
    local target="$1" file leaf candidate
    [ -n "$target" ] || fail "Destino invalido para a fonte do plugin."
    for file in $PLUGIN_FILES; do
        leaf="$(basename "$file")"
        candidate="$target/$leaf"
        [ -f "$candidate" ] || fail "Arquivo obrigatorio do plugin ausente: $leaf."
        [ -s "$candidate" ] || fail "Arquivo obrigatorio do plugin vazio: $leaf."
    done
    return 0
}

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

    # Nunca compilar uma arvore parcial: um arquivo ausente ou vazio deve interromper a
    # instalacao explicitamente, em vez de reutilizar um modulo stale no destino.
    validate_plugin_source_tree "$target"

    # `&&` sozinho como ultima linha deixaria a funcao com o codigo de saida do teste, e sob
    # `set -e` uma pasta vazia derrubaria o instalador inteiro.
    if [ -n "$PLUGIN_SOURCE" ]; then
        warn "Plugin copiado de $PLUGIN_SOURCE, e nao do GitHub."
    fi
    return 0
}

# De onde vem o plugin instalado. A release validada pelo canal e a fonte normal.
install_plugin_source() {
    local root="$1" release version zip sha
    if [ -n "$PLUGIN_SOURCE" ]; then
        copy_plugin_from_repo "$root"
        return 0
    fi
    if [ -f "$SCRIPT_DIR/../$PLUGIN_DIR_NAME/index.tsx" ]; then
        step "Usando o checkout do repositorio que esta ao lado do instalador"
        copy_plugin_from_repo "$root"
        return 0
    fi
    release="$(github_plugin_release "$CHANNEL" 2>/dev/null || true)"
    version="$(printf '%s\n' "$release" | sed -n '1p')"
    zip="$(printf '%s\n' "$release" | sed -n '2p')"
    sha="$(printf '%s\n' "$release" | sed -n '3p')"
    if [ -z "$version" ] || [ -z "$zip" ] || [ -z "$sha" ]; then
        fail "Nao encontrei uma release $CHANNEL valida com zip e SHA-256; ela pode estar ausente, em metadata incoerente ou indisponivel por rede/rate limit. Use --plugin-source com uma fonte local explicita."
    fi
    step "Instalando o plugin da release $version (canal $CHANNEL)"
    do_update_from_zip "$root" "$zip" "$version" "$sha"
}

# O Equicord liga `verifyDepsBeforeRun: prompt`: com o node_modules fora de sincronia com o
# lockfile (checkout atualizado por git pull/updater do mod), o `pnpm build` pede confirmacao e,
# sem terminal (curl | sh), falha. Instalar so quando o node_modules faltava deixava o checkout
# preso. Sincroniza antes de todo build: --frozen-lockfile nao reescreve o pnpm-lock.yaml do
# checkout, o install comum fica de reserva e confirm-modules-purge=false evita o outro prompt.
sync_mod_deps() {
    local root="$1"
    if [ -d "$root/node_modules" ]; then
        step "Conferindo as dependencias do mod"
    else
        step "Instalando dependencias (na primeira vez demora alguns minutos)"
    fi
    (cd "$root" && pnpm install --frozen-lockfile --config.confirm-modules-purge=false) && return 0
    (cd "$root" && pnpm install --config.confirm-modules-purge=false)
}

# Versoes e estado do checkout no log de um build que falhou (mesmos campos do instalador Windows):
# pnpm em uso contra o que o projeto pede, node e se o node_modules existia. Sem caminho.
log_build_context() {
    local root="$1" deps="$2" exit_code="$3" esperado nm=false
    esperado="$(sed -n 's/.*"packageManager"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$root/package.json" 2>/dev/null | head -n 1)"
    [ -d "$root/node_modules" ] && nm=true
    installer_log error installer.build_context build \
        pnpm_version "$(pnpm --version 2>/dev/null | head -n 1)" pnpm_esperado "$esperado" \
        node_version "$(node --version 2>/dev/null | head -n 1)" node_modules "$nm" \
        deps_sync "$deps" exit_code "$exit_code"
}

build_mod() {
    local root="$1" rc=0 saida
    GLB_PHASE="build"
    installer_log info installer.build build mod_kind "$(checkout_mod "$root")"
    sync_mod_deps "$root" || { log_build_context "$root" falhou ""; fail "pnpm install falhou"; }

    step "Compilando"
    saida="$(cd "$root" && pnpm build 2>&1)" || rc=$?
    if [ -n "$saida" ]; then
        printf '%s\n' "$saida"
    fi
    if [ "$rc" -ne 0 ]; then
        log_build_context "$root" ok "$rc"
        if [ -z "$saida" ]; then
            # Sair calado e um sintoma em si (ex.: prompt que o pnpm nao conseguiu mostrar).
            fail "pnpm build falhou (exit=$rc): o pnpm saiu sem nenhuma mensagem; rode \"pnpm build\" na pasta do mod para ver o erro"
        fi
        fail "pnpm build falhou (exit=$rc): fim da saida do pnpm: $(printf '%s\n' "$saida" | grep -v '^[[:space:]]*$' | tail -n 8 | tr '\n' '|' | sed 's/|$//')"
    fi
}
remove_plugin_source() {
    local root="$1" target="$1/src/userplugins/$PLUGIN_DIR_NAME"
    [ -d "$target" ] || return 0
    step "Removendo apenas o plugin GoLiveBypass"
    rm -rf "$target"
    # O loader do mod permanece apontando para o checkout; recompilar remove
    # somente o userplugin e não desfaz Vencord/Equicord do app.asar.
    sync_mod_deps "$root" || warn "pnpm install falhou; tentando recompilar mesmo assim."
    (cd "$root" && pnpm build) || warn "Nao consegui recompilar o mod sem o GoLiveBypass."
}

# Patch direto em UM cliente paralelo (Equibop/Vesktop/Legcord) com source local.
# O instalador de mod do Equicord (EquilotlCli) nao reconhece esses clientes
# (FindDiscords() soh olha LinuxDiscordNames) - pnpm inject mostra so "Custom
# Location" e falha. Esse caminho copia o dist/<cliente>.asar (gerado pelo
# build do Equicord) sobre o app.asar do cliente, com backup automatico.
# $2 = pasta do cliente (termina em /vesktop|/equibop|/legcord, com app.asar dentro).
# (Extrato do antigo inject_parallel: o seletor novo escolhe varios alvos.)
# Nome do cliente a partir do caminho. Mesmo casamento por componente de is_parallel_install:
# no flatpak o alvo e .../files/bin/<cliente>/resources e no ~/.local/share/<cliente> ele e a
# propria raiz, entao olhar so o final do caminho nao bastava.
nome_cliente_paralelo() {
    case "/$1/" in
        */equibop/*|*/Equibop/*) printf 'Equibop\n'; return 0 ;;
        */vesktop/*|*/Vesktop/*) printf 'Vesktop\n'; return 0 ;;
        */legcord/*|*/Legcord/*) printf 'Legcord\n'; return 0 ;;
    esac
    return 1
}

# O .asar que o build do mod produz para este cliente paralelo. O build do Equicord so empacota
# equibop.asar (o cliente dele), o do Vencord so vesktop.asar (o dele) -- nenhum dos dois gera
# o .asar do outro. Devolve 1 quando nao ha build para este par.
asar_do_paralelo() { # $1 = cliente, $2 = mod
    case "$1:$2" in
        Equibop:Equicord) printf 'dist/equibop.asar\n'; return 0 ;;
        Vesktop:Vencord)  printf 'dist/vesktop.asar\n';  return 0 ;;
    esac
    return 1
}

# Motivo, em uma linha, de este mod nao atender o cliente; vazio quando atende. Usado no
# rotulo do seletor: oferecer um alvo que so pode falhar nao e escolha de verdade.
motivo_paralelo() { # $1 = cliente, $2 = mod
    asar_do_paralelo "$1" "$2" >/dev/null 2>&1 && return 0
    case "$1" in
        Legcord) printf 'Legcord nao usa build do mod' ;;
        Equibop) printf 'precisa de um checkout Equicord' ;;
        Vesktop) printf 'precisa de um checkout Vencord' ;;
    esac
    return 0
}

# O state.json do Vesktop deste alvo: no flatpak fica no HOME do sandbox.
vesktop_state_file() { # $1 = alvo (resources) do Vesktop
    local id
    if id="$(flatpak_app_id "$1")"; then
        printf '%s/.var/app/%s/config/vesktop/state.json\n' "$HOME" "$id"
    else
        printf '%s/vesktop/state.json\n' "${XDG_CONFIG_HOME:-$HOME/.config}"
    fi
}

# O plugin roda os comandos de rede no host com flatpak-spawn --host, que exige falar com o
# portal org.freedesktop.Flatpak. Sem isso a ativacao para em "sem permissao" no sandbox.
grant_flatpak_host_commands() {
    local id="$1"
    have flatpak || return 0
    flatpak info --show-permissions "$id" 2>/dev/null | grep -q 'org.freedesktop.Flatpak=talk' && return 0
    if flatpak_is_user_install "$id"; then
        flatpak override --user "$id" --talk-name=org.freedesktop.Flatpak >/dev/null 2>&1 && return 0
    else
        step "Liberando comandos no host para o $id (pode pedir sua senha do sudo)"
        sudo flatpak override "$id" --talk-name=org.freedesktop.Flatpak >/dev/null 2>&1 && return 0
    fi
    warn "Nao consegui liberar o flatpak-spawn para o $id. A VPN do plugin precisa disso; rode:"
    printf '  %s  flatpak override %s--talk-name=org.freedesktop.Flatpak %s%s\n' \
        "$C_DIM" "$(flatpak_is_user_install "$id" && printf -- '--user ')" "$id" "$C_OFF" >&2
    return 1
}

# O build do Vencord nao gera dist/vesktop.asar (so os vencordDesktop*.js), entao copiar um asar
# para o Vesktop nunca funcionou: o instalador parava em "Build nao gerou dist/vesktop.asar". O
# jeito que o proprio Vesktop suporta e o "Vencord Location": ele guarda a pasta em state.json
# (vencordDir) e carrega o Vencord dali na abertura. Nao mexe no pacote instalado nem pede sudo
# no Vesktop nativo; no flatpak libera a leitura da pasta e o flatpak-spawn.
configure_vesktop_vencord_dir() {
    local root="$1" target="$2" dist state id
    dist="$root/dist"
    if [ ! -f "$dist/vencordDesktopMain.js" ]; then
        printf "  [!] Build nao gerou %s/vencordDesktopMain.js. Rode 'pnpm build' em %s e tente de novo.\n" "$dist" "$root"
        return 1
    fi
    state="$(vesktop_state_file "$target")"
    mkdir -p "$(dirname "$state")" || return 1
    # Preserva as outras chaves do state.json; grava atomico para nao deixar JSON pela metade.
    node -e '
const fs = require("fs");
const [file, dir] = process.argv.slice(1);
let state = {};
try { state = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
if (!state || typeof state !== "object" || Array.isArray(state)) state = {};
state.vencordDir = dir;
fs.writeFileSync(file + ".golive-tmp", JSON.stringify(state, null, 4));
fs.renameSync(file + ".golive-tmp", file);
' "$state" "$dist" || { printf "  [!] Nao consegui gravar %s\n" "$state"; return 1; }
    if id="$(flatpak_app_id "$target")"; then
        grant_flatpak_access "$id" "$dist" || true
        grant_flatpak_host_commands "$id" || true
    fi
    # O Vencord carregado pelo Vesktop le as configuracoes de <dados do Vesktop>/settings, nao
    # do ~/.config/Vencord: sem isto o plugin abria desligado depois do "ja vem ativado".
    set_plugin_settings "$root" "$(dirname "$state")/settings/settings.json"
    installer_log info installer.vesktop_vencord_dir inject target_count 1
    ok "Vesktop usando o Vencord de $dist ($state)"
    return 0
}

patch_parallel_one() {
    local root="$1" target="$2"
    local asar="" client_name="" app_path="" mod="" rel=""

    [ -n "$target" ] || return 1

    client_name="$(nome_cliente_paralelo "$target")" || {
        printf "  [!] Cliente paralelo desconhecido: %s\n" "$target"
        return 1
    }
    if [ "$client_name" = Vesktop ] && [ "$(checkout_mod "$root")" = Vencord ]; then
        configure_vesktop_vencord_dir "$root" "$target"
        return
    fi

    # Equicord e Vencord sao forks DIFERENTES: o build do Equicord so empacota
    # equibop.asar (o cliente dele), o do Vencord so vesktop.asar (o dele) -- nenhum dos
    # dois gera o .asar do outro. Legcord e um projeto A PARTE (nao e fork de nenhum dos
    # dois): nenhum checkout Equicord/Vencord gera legcord.asar, entao "rode pnpm build e
    # tente de novo" era enganoso nesse caso -- nenhum build ia gerar aquele arquivo. Essa
    # e a causa raiz por tras das issues #123/#130/#132/#133 no lado Windows (sempre
    # Vesktop detectado com um checkout Equicord); aqui do lado Linux o bug era o mesmo,
    # so que sem relato ainda.
    mod="$(checkout_mod "$root")"
    if ! rel="$(asar_do_paralelo "$client_name" "$mod")"; then
        printf "  [!] %s nao e gerado por um checkout %s (Equicord builda so o Equibop, Vencord so o Vesktop; Legcord e um app a parte -- nenhum dos dois builda ele). Use um checkout do mod certo para %s, ou injete o %s pelo instalador dele mesmo.\n" \
            "$client_name" "$mod" "$client_name" "$client_name"
        return 1
    fi
    asar="$root/$rel"
    app_path="$target/app.asar"
    # Nunca sobrescrever um cliente paralelo que já foi patchado por Vencord,
    # Equicord ou outro loader. Este caminho não sabe compor dois app.asar;
    # recusar preserva tanto o patch quanto o backup `_app.asar`.
    local existing_injection
    existing_injection="$(injected_path "$target" || true)"
    if [ -n "$existing_injection" ]; then
        installer_log warn installer.preserved inject reason_code PARALLEL_ALREADY_PATCHED target_count 1
        printf "  [!] %s ja tem um patch em %s; preservei app.asar e _app.asar.\n" "$client_name" "$existing_injection"
        return 1
    fi

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

# ---------------------------------------------------------------- restauracao de cliente
#
# O patch em cliente paralelo troca app.asar pelo dist/<cliente>.asar do checkout e guarda o
# original em _app.asar (patch_parallel_one). Se o checkout, o build ou a versao do mod
# mudarem depois, o cliente fica sem abrir -- e nao havia caminho de volta: do_uninstall e
# do_restore_everything so removiam o userplugin e recompilavam, deixando o app.asar patchado
# no lugar. Estas funcoes devolvem o original.

# Rotulo do cliente a partir do resources. Paralelos tem nome proprio; o resto e "Discord".
nome_cliente() {
    local nome
    if nome="$(nome_cliente_paralelo "$1")"; then
        printf '%s\n' "$nome"
        return 0
    fi
    printf 'Discord\n'
}

# O app.asar atual carrega o userplugin? O build do mod feito com o GoLiveBypass dentro tem o
# nome do plugin; o stub do Vencord/Equicord (so um require) nao tem.
asar_tem_marca_golive() {
    [ -f "$1" ] || return 1
    have grep || return 1
    grep -aq "GoLiveBypass" "$1" 2>/dev/null
}

# Stub do mod apontando para um alvo que nao existe mais == cliente que nao sobe.
stub_do_mod_quebrado() {
    local resources="$1" alvo
    alvo="$(injected_path "$resources" || true)"
    [ -n "$alvo" ] || return 1
    [ -e "$alvo" ] && return 1
    [ -e "$alvo/index.js" ] && return 1
    [ -e "$alvo/package.json" ] && return 1
    return 0
}

# Estado do app.asar de um cliente. Rotulos estaveis (menu, log e suporte):
#   golive       patch do GoLiveBypass (copia do dist do checkout)
#   mod-quebrado stub do Vencord/Equicord com alvo ausente -> o cliente nao abre
#   mod          stub do Vencord/Equicord funcionando (nao e nosso; so com --force)
#   outro        tem _app.asar mas o app.asar atual nao e reconhecido (outro programa/versao)
#   vanilla      sem _app.asar: nunca foi injetado
#   ausente      sem app.asar nesse resources
client_asar_state() {
    local resources="$1" app="$1/app.asar" backup="$1/_app.asar"
    if [ ! -f "$app" ]; then
        if [ -f "$backup" ]; then printf 'outro\n'; else printf 'ausente\n'; fi
        return 0
    fi
    if asar_tem_marca_golive "$app"; then printf 'golive\n'; return 0; fi
    if injected_path "$resources" >/dev/null 2>&1; then
        if stub_do_mod_quebrado "$resources"; then printf 'mod-quebrado\n'; else printf 'mod\n'; fi
        return 0
    fi
    if [ -f "$backup" ]; then printf 'outro\n'; return 0; fi
    printf 'vanilla\n'
}

client_estado_legivel() {
    case "$1" in
        golive)       printf 'patch do GoLiveBypass (revertivel)' ;;
        mod-quebrado) printf 'injecao QUEBRADA: o alvo do require nao existe, o cliente nao abre' ;;
        mod)          printf 'mod Vencord/Equicord funcionando' ;;
        outro)        printf 'patch de outro programa (nao mexemos sem --force)' ;;
        vanilla)      printf 'original, sem injecao' ;;
        *)            printf 'sem app.asar nesse diretorio' ;;
    esac
}

# cp/mv com sudo quando o diretorio do cliente nao e gravavel (mesma regra do backup).
_cp_cliente() { # $1 = destino, $2 = origem
    if [ -w "$(dirname "$1")" ]; then
        cp -p "$2" "$1"
    else
        sudo cp -p "$2" "$1" || return 1
        sudo chown "$(id -u):$(id -g)" "$1" 2>/dev/null || true
    fi
}

_mv_cliente() { # $1 = origem, $2 = destino
    if [ -w "$(dirname "$2")" ]; then
        mv -f "$1" "$2"
    else
        sudo mv -f "$1" "$2"
    fi
}

# Devolve o app.asar original (o _app.asar) para o cliente.
# $1 = resources, $2 = rotulo, $3 = 1 para --force (desfaz mod funcionando/patch desconhecido).
restore_client_asar() {
    local resources="$1" label="${2:-cliente}" force="${3:-0}"
    local app="$1/app.asar" backup="$1/_app.asar" state
    state="$(client_asar_state "$resources")"
    case "$state" in
        golive) : ;;
        mod-quebrado)
            printf '  %s[!] %s: a injecao do mod aponta para um alvo que nao existe mais; devolvendo o original.%s\n' \
                "$C_YELLOW" "$label" "$C_OFF" >&2 ;;
        mod)
            if [ "$force" -ne 1 ]; then
                warn "$label: o mod Vencord/Equicord esta funcionando; restaurar tiraria o mod deste cliente. Use --force se e isso mesmo."
                installer_log warn installer.client_restore refused reason_code MOD_FUNCIONANDO target_count 1
                return 1
            fi ;;
        outro)
            if [ "$force" -ne 1 ]; then
                warn "$label: o app.asar atual nao e um patch reconhecido do GoLiveBypass. Use --force para devolver o backup mesmo assim."
                installer_log warn installer.client_restore refused reason_code PATCH_DESCONHECIDO target_count 1
                return 1
            fi ;;
        vanilla)
            warn "$label: o app.asar ja e o original; nada para restaurar."
            return 1 ;;
        *)
            warn "$label: nao encontrei app.asar em $resources."
            return 1 ;;
    esac
    if [ ! -f "$backup" ]; then
        warn "$label: nao ha backup _app.asar; sem ele nao da para devolver o original automaticamente."
        installer_log warn installer.client_restore refused reason_code BACKUP_AUSENTE target_count 1
        return 1
    fi

    installer_log info installer.client_restore start reason_code "$state" target_count 1
    # Preserva o patch atual: se o cliente voltar a precisar do mod, o arquivo fica ali.
    _cp_cliente "$app.golive-patched.bak" "$app" >/dev/null 2>&1 || true
    # Copia para um temporario no MESMO diretorio e so entao substitui: um erro no meio nao
    # deixa o cliente sem app.asar nenhum.
    if ! _cp_cliente "$app.restore.tmp" "$backup"; then
        warn "$label: nao consegui preparar a copia de restauracao (permissao?)."
        return 1
    fi
    if have cmp && ! cmp -s "$app.restore.tmp" "$backup"; then
        rm -f "$app.restore.tmp" 2>/dev/null || sudo rm -f "$app.restore.tmp" 2>/dev/null || true
        warn "$label: a copia de restauracao saiu diferente do backup; nao toquei no app.asar."
        return 1
    fi
    if ! _mv_cliente "$app.restore.tmp" "$app"; then
        warn "$label: nao consegui substituir o app.asar."
        return 1
    fi
    if have cmp && ! cmp -s "$app" "$backup"; then
        warn "$label: o app.asar restaurado nao confere com o backup; o _app.asar foi preservado."
        return 1
    fi
    # O backup cumpriu o papel; sai do caminho para o proximo install criar um limpo. Fica com
    # sufixo para o usuario conferir depois.
    _mv_cliente "$backup" "$resources/_app.asar.restaurado.bak" 2>/dev/null || true

    ok "$label: app.asar original restaurado (patch anterior em app.asar.golive-patched.bak)"
    installer_log info installer.client_restore done reason_code "$state" target_count 1
    return 0
}

# Tabela de estado por cliente. Usada por --client-status e pelo menu.
show_client_states() {
    local resources label state vistos=0
    while IFS= read -r resources; do
        [ -n "$resources" ] || continue
        label="$(nome_cliente "$resources")"
        state="$(client_asar_state "$resources")"
        printf '  %s  %-9s %s%s\n' "$C_DIM" "$label" "$(client_estado_legivel "$state")" "$C_OFF" >&2
        printf '  %s    %s%s\n' "$C_DIM" "$resources" "$C_OFF" >&2
        vistos=$((vistos + 1))
    done <<EOF
$(discord_resources)
EOF
    if [ "$vistos" -eq 0 ]; then
        printf '  %s  nenhum cliente encontrado%s\n' "$C_DIM" "$C_OFF" >&2
    fi
    return 0
}

# Restaura todos os clientes com patch/backup, ou so o que casar com $1 (Equibop, Vesktop,
# Legcord, Discord). Fecha o Discord antes e reabre depois: o app.asar restaurado so vale no
# proximo inicio, e deixar o cliente aberto rodando o patch antigo confunde o diagnostico.
do_restore_client() {
    local filtro="${1:-}" resources label state normalizado encontrados=0 rc=0
    filtro="$(printf '%s' "$filtro" | tr '[:upper:]' '[:lower:]')"
    stop_discord
    while IFS= read -r resources; do
        [ -n "$resources" ] || continue
        label="$(nome_cliente "$resources")"
        state="$(client_asar_state "$resources")"
        case "$state" in
            vanilla|ausente) continue ;;
        esac
        if [ -n "$filtro" ]; then
            normalizado="$(printf '%s' "$label" | tr '[:upper:]' '[:lower:]')"
            case "$normalizado" in
                "$filtro"*) ;;
                *) continue ;;
            esac
        fi
        encontrados=$((encontrados + 1))
        restore_client_asar "$resources" "$label" "$FORCE_RESTORE" || rc=1
    done <<EOF
$(discord_resources)
EOF
    if [ "$encontrados" -eq 0 ]; then
        warn "Nenhum cliente com injecao ou backup para restaurar."
        start_discord "$(find_checkout || true)" >/dev/null 2>&1 || true
        return 1
    fi
    start_discord "$(find_checkout || true)" >/dev/null 2>&1 || true
    return "$rc"
}

# Depois de remover o userplugin, um cliente paralelo continuaria rodando o build antigo (que
# ainda tem o GoLiveBypass dentro): recopia o asar recem-buildado, quando ele existir.
refresh_parallel_patches() {
    local root="$1" resources label mod rel asar
    [ -n "$root" ] || return 0
    while IFS= read -r resources; do
        [ -n "$resources" ] || continue
        is_parallel_install "$resources" || continue
        asar_tem_marca_golive "$resources/app.asar" || continue
        label="$(nome_cliente "$resources")"
        mod="$(checkout_mod "$root")"
        rel="$(asar_do_paralelo "$label" "$mod" 2>/dev/null || true)"
        if [ -z "$rel" ]; then
            warn "$label: patch antigo preservado (o checkout $mod nao gera build para ele)."
            continue
        fi
        asar="$root/$rel"
        if [ ! -f "$asar" ]; then
            warn "$label: rode 'pnpm build' em $root e reinstale para tirar o plugin do cliente."
            continue
        fi
        if _cp_cliente "$resources/app.asar" "$asar" >/dev/null 2>&1; then
            ok "$label: patch atualizado com o build sem o plugin."
        else
            warn "$label: nao consegui atualizar o patch; o cliente segue com o build antigo."
        fi
    done <<EOF
$(discord_resources)
EOF
    return 0
}

# --location poupa a pergunta do instalador do mod quando so ha um Discord, e de quebra deixa
# a escolha do sudo certa: da para saber de antemao onde a injecao vai cair. Com mais de um,
# quem escolhe e o instalador do mod, que lista todos.
run_inject() {
    local root="$1" loc="${2:-}"
    if [ -n "$loc" ]; then
        (cd "$root" && pnpm run inject --location "$loc")
        return $?
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
        sudo env PATH="$PATH" bash -c 'cd "$1" || exit 1; shift; exec "$@"' _ "$root" pnpm run inject --location "$loc" || rc=$?
    else
        sudo env PATH="$PATH" bash -c 'cd "$1" || exit 1; shift; exec "$@"' _ "$root" pnpm inject || rc=$?
    fi

    sudo chown -R "$(id -u):$(id -g)" "$root/dist" 2>/dev/null || true
    return "$rc"
}

# Rótulo curto de um alvo, para o seletor. O nome vem do caminho (o installer
# nao tem a deteccao de flavour que o standalone tem).
label_alvo() { # $1 = resources (ou o diretorio que contem app.asar)
    local nome onde
    # Os clientes paralelos vem antes do Discord: no flatpak o caminho carrega o id do app
    # (dev.vencord.Vesktop) e o nome da pasta, mas nenhum deles contem "discord".
    case "$1" in
        *discordptb*|*DiscordPTB*)          nome="Discord PTB" ;;
        *discordcanary*|*DiscordCanary*)    nome="Discord Canary" ;;
        *equibop*|*Equibop*)                nome="Equibop" ;;
        *vesktop*|*Vesktop*)                nome="Vesktop" ;;
        *legcord*|*Legcord*)                nome="Legcord" ;;
        *discord*|*Discord*)                nome="Discord" ;;
        *)                                  nome="$(basename "$(dirname "$1")")" ;;
    esac
    # Onde ele mora, em uma linha curta. O deploy do flatpak tem um caminho enorme
    # (app/<id>/<arch>/<branch>/active/files/bin/<app>) e o pai de um alvo que ja E a raiz da
    # instalacao (~/.local/share/vesktop) nao diz nada -- os dois apareciam como
    # "Equibop (/home/pdl/.local/share)" e nao dava para distinguir.
    case "$1" in
        */flatpak/app/*) onde="flatpak" ;;
        */resources)     onde="$(dirname "$1")" ;;
        *)               onde="$1" ;;
    esac
    printf '%s (%s)' "$nome" "$onde"
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

# Imprime, na ordem, o alvo de cada indice (1..N) escolhido. `alvos` e a lista completa no
# formato "TIPO|caminho", uma por linha. O alvo vem daqui, e nao dos rotulos da tela: era esse
# deslize que fazia o seletor devolver "Equibop (flatpak)" no lugar do caminho real, e a
# injecao falhava depois de o usuario escolher.
alvos_por_indice() { # $1 = lista de alvos, $2.. = indices
    local alvos="$1"; shift
    local i
    for i in "$@"; do
        printf '%s\n' "$alvos" | sed -n "${i}p"
    done
    return 0
}

# escolher_alvos_inject <oficiais> <paralelos> [mod] → imprime os alvos escolhidos no
# formato "O|<resources>" (oficial, recebe pnpm inject --location) ou "P|<res>"
# (paralelo, patch direto). Pergunta so quando ha mais de um alvo no total.
# -Yes ou entrada nao-interativa: todos os oficiais (e so ha paralelos quando
# nao existe oficial — comportamento de antes do seletor).
escolher_alvos_inject() {
    local oficiais="$1" paralelos="$2" mod="${3:-}"
    local no np total resp i tipo res linha tentativa motivo alvos largura limite
    no=0; np=0
    [ -n "$oficiais" ] && no="$(printf '%s\n' "$oficiais" | grep -c . || true)"
    [ -n "$paralelos" ] && np="$(printf '%s\n' "$paralelos" | grep -c . || true)"
    total=$((no + np))

    if [ "$total" -le 1 ]; then
        [ -n "$oficiais" ] && printf 'O|%s\n' "$oficiais"
        [ -n "$paralelos" ] && printf 'P|%s\n' "$paralelos"
        return 0
    fi

    # Sem ninguem para responder, mantem o comportamento de antes do seletor: todos os
    # oficiais. A condicao passa por tui_is_interactive em vez de repetir "[ ! -t 0 ]" porque
    # a duplicata deixava o ramo interativo inalcancavel por qualquer caminho que nao fosse um
    # terminal de verdade -- nem os testes conseguiam exercita-lo. As duas formas sao
    # equivalentes: tui_is_interactive() e falso exatamente quando -Yes ou quando o stdin nao
    # e terminal.
    # O prefixo vai em CADA linha: `printf 'P|%s\n' "$lista"` so marcava a primeira, e o
    # leitor (IFS='|' read tipo alvo) descartava as outras -- com dois clientes paralelos
    # (ex.: Vesktop nativo + flatpak) so o primeiro era configurado.
    if [ "$ASSUME_YES" -eq 1 ] || ! tui_is_interactive; then
        if [ -n "$oficiais" ]; then
            printf '%s\n' "$oficiais" | sed '/./!d; s/^/O|/'
        else
            printf '%s\n' "$paralelos" | sed '/./!d; s/^/P|/'
        fi
        return 0
    fi

    # Duas listas na MESMA ordem: `alvos` tem o caminho real que a injecao usa, e os
    # posicionais tem o rotulo que aparece na tela. Antes so existia a lista de rotulos e era
    # ELA que voltava como resultado -- quem escolhia recebia "Equibop (flatpak)" no lugar do
    # caminho, e a injecao morria depois com "Cliente paralelo desconhecido". O caminho nunca
    # chegava em patch_parallel_one()/install_location().
    alvos="$(
        while IFS= read -r linha; do
            [ -n "$linha" ] && printf 'O|%s\n' "$linha"
        done <<EOF
$oficiais
EOF
        while IFS= read -r linha; do
            [ -n "$linha" ] && printf 'P|%s\n' "$linha"
        done <<EOF
$paralelos
EOF
    )"

    # Um rotulo por alvo, na mesma ordem. O do paralelo diz se este checkout consegue
    # atende-lo: um alvo que so pode falhar nao e escolha de verdade, e antes disso o usuario
    # so descobria depois de escolher (e, pelo defeito acima, nem depois).
    #
    # tui_size aqui porque tui_menu_multi so descobre as colunas depois; sem isso o rotulo era
    # montado sem saber quanto espaco tinha.
    tui_size
    largura="$(tui_largura)"
    set --
    while IFS= read -r linha; do
        [ -n "$linha" ] && set -- "$@" "$(label_alvo "$linha")"
    done <<EOF
$oficiais
EOF
    while IFS= read -r linha; do
        [ -z "$linha" ] && continue
        res="$(label_alvo "$linha")"
        # Sem o mod em maos nao da para dizer se o alvo serve; melhor nao anotar do que anotar
        # errado.
        motivo=""
        if [ -n "$mod" ]; then
            motivo="$(motivo_paralelo "$(nome_cliente_paralelo "$linha")" "$mod")"
        fi
        if [ -n "$motivo" ]; then
            # Quem cede espaco e o caminho do cliente, nunca o aviso: e o aviso que muda a
            # escolha, e com o caminho inteiro ele era cortado justamente nos casos ambiguos
            # (o mesmo cliente em dois lugares), que sao os que mais precisam dele.
            limite=$((largura - 11 - ${#motivo} - 4))
            [ "$limite" -lt 12 ] && limite=12
            res="$(tui_corta "$res" "$limite") -- $motivo"
        fi
        set -- "$@" "$res"
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
                printf '    [%d] %s\n' "$i" "$linha" >&2
            done
            printf '  Escolha (ex.: 1,3 · 2-4 · t = todos · Enter = todos): ' >&2
            read -r resp || resp=""
            if resp="$(parse_selecao "$resp" "$total")"; then break; fi
            warn "Escolha invalida."
            tentativa=$((tentativa+1))
        done
        [ "$tentativa" -lt 3 ] || resp="$(seq_like 1 "$total")"
    fi

    # Repercorre na mesma ordem e imprime o ALVO (nao o rotulo) de cada escolhido.
    # shellcheck disable=SC2086
    alvos_por_indice "$alvos" $resp
}

# Alvos escolhidos para a injecao, no formato "TIPO|caminho". Faz a pergunta de selecao quando
# ha mais de um alvo; com um so, ou em --yes, nao pergunta.
selecionar_alvos_inject() {
    local root="$1"
    local oficiais paralelos mod

    oficiais="$(discord_installs)"
    paralelos="$(parallel_installs)"
    # Qual mod este checkout builda. Decide, no seletor, quais clientes paralelos da para
    # atender (Equicord so builda o Equibop, Vencord so o Vesktop).
    mod="$(checkout_mod "$root")"

    # Caso comum: o user so tem Equibop/Vesktop/Legcord e nao tem Discord puro.
    # O instalador de mod nao funciona em clientes paralelos (eles ja vem com o
    # mod embutido): patch direto do dist/<cliente>.asar, agora multi-alvo.
    # Tudo em stderr: o stdout desta funcao e a LISTA DE ALVOS que o chamador captura.
    if [ -z "$oficiais" ]; then
        if [ -z "$paralelos" ]; then
            fail "Discord puro nao encontrado, e nenhum cliente paralelo disponivel para patch direto. Instale o Discord (ou use o instalador de plugin goLiveBypass-vencord.zip, que convive com mod)."
        fi
        printf '\n' >&2
        printf '  %s[!]%s Nao encontrei o Discord puro, mas achei clientes paralelos:\n' "$C_YELLOW" "$C_OFF" >&2
        while IFS= read -r p; do
            [ -z "$p" ] && continue
            printf '        - %s\n' "$p" >&2
        done <<EOF
$paralelos
EOF
        if [ "$ASSUME_YES" -ne 1 ] && ! confirm "Injetar em algum dos clientes acima (patch direto, vai pedir sudo)"; then
            fail "Discord puro nao encontrado, e nenhum cliente paralelo disponivel para patch direto. Instale o Discord (ou use o instalador de plugin goLiveBypass-vencord.zip, que convive com mod)."
        fi
    fi

    # Selecao de alvos: 1 alvo = auto (como antes); varios = nosso seletor
    # (oficiais + paralelos), no lugar da lista do proprio instalador do mod,
    # que so patcheia um e nao conhece clientes paralelos.
    escolher_alvos_inject "$oficiais" "$paralelos" "$mod"
}

# Verdadeiro quando nada precisa ser injetado: todo alvo oficial escolhido ja aponta para este
# checkout e nenhum cliente paralelo foi escolhido. Espelha o $oficialPendente do instalador
# PowerShell. Sem isto, ter QUALQUER cliente ja apontando para o checkout -- era o caso de quem
# ja tinha o Equibop injetado -- fazia o instalador pular a injecao inteira e o seletor de alvos
# NUNCA aparecia, mesmo havendo Vesktop, Legcord e flatpaks intocados para escolher.
alvos_ja_injetados() { # $1 = root, $2 = escolhidos
    local root="$1" escolhidos="$2" tipo alvo path
    while IFS='|' read -r tipo alvo; do
        [ -z "$alvo" ] && continue
        case "$tipo" in
            # Cliente paralelo sempre precisa de patch: nao existe "ja estar" injetado.
            P) return 1 ;;
            O)
                path="$(injected_path "$alvo" || true)"
                case "$path" in
                    "$root"/*) ;;
                    *) return 1 ;;
                esac
                ;;
        esac
    done <<EOF
$escolhidos
EOF
    return 0
}

# Injeta nos alvos ja escolhidos por selecionar_alvos_inject.
injetar_alvos() { # $1 = root, $2 = escolhidos
    local root="$1" escolhidos="$2"
    local tipo alvo loc id falha injetou_oficial tem_oficial alvo_count

    GLB_PHASE="inject"
    alvo_count=0
    if [ -n "$escolhidos" ]; then
        alvo_count="$(printf '%s\n' "$escolhidos" | grep -c '|' || true)"
    fi
    installer_log info installer.inject inject target_count "$alvo_count"

    # Ha Discord puro entre os escolhidos? Sem nenhum, o unico caminho e o patch direto dos
    # paralelos, e ali uma falha e definitiva (nao ha injecao de mod para segurar o resultado).
    tem_oficial=0
    case "$escolhidos" in
        *"O|"*) tem_oficial=1 ;;
    esac

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

    # O pnpm inject pode sair com 0 mesmo quando o instalador do mod falha: cada alvo oficial
    # escolhido precisa apontar para este checkout; um cliente nao aprova outro.
    if [ "$injetou_oficial" -eq 1 ]; then
        alvos_ja_injetados "$root" "$escolhidos" || fail "A injecao nao foi confirmada em todos os Discords escolhidos."

        # De novo por conta propria, e nao so confiando no instalador do mod: ele so libera o
        # sandbox quando descobre sozinho que aquilo e um flatpak, e o comando e idempotente.
        if id="$(injected_flatpak_id "$root")"; then
            grant_flatpak_access "$id" "$root/dist"
        fi
    fi

    if [ "$falha" -ne 0 ]; then
        if [ "$tem_oficial" -eq 0 ]; then
            fail "Patch direto falhou."
        fi
        warn "Algum cliente paralelo nao foi patcheado -- os outros continuam."
    fi
}

# Injeccao completa (escolha + patch). Atalho para quem nao precisa decidir antes se ha o que
# fazer; o do_install faz os dois passos em separado justamente para poder pular a injecao
# quando os alvos escolhidos ja estao prontos.
inject_mod() {
    local root="$1" escolhidos
    escolhidos="$(selecionar_alvos_inject "$root")"
    injetar_alvos "$root" "$escolhidos"
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

get_persisted_channel() {
    local root="$1" file
    file="$(mod_settings_file "$root")"
    [ -f "$file" ] || return 1
    GLB_FILE="$file" node -e '
        const fs = require("fs");
        try {
            const s = JSON.parse(fs.readFileSync(process.env.GLB_FILE, "utf8"));
            const c = s?.plugins?.GoLiveBypass?.updateChannel;
            if (c === "stable" || c === "beta") process.stdout.write(c);
            else process.exit(1);
        } catch { process.exit(1); }
    ' 2>/dev/null
}

select_update_channel() {
    local root="$1" persisted choice
    if [ "$CHANNEL_EXPLICIT" -eq 1 ]; then
        printf '%s\n' "$CHANNEL"
        return 0
    fi
    persisted="$(get_persisted_channel "$root" || true)"
    if [ "$ASSUME_YES" -eq 1 ] || ! tui_is_interactive; then
        printf '%s\n' "${persisted:-stable}"
        return 0
    fi
    printf '\n  Canal de atualizacoes do plugin:\n' >&2
    printf '    [1] Stable (recomendado)\n' >&2
    printf '        Canal mais previsivel, somente releases estaveis.\n' >&2
    printf '    [2] Beta (opt-in)\n' >&2
    printf '        Canal de testes; voce ajuda a comunidade ao testar, encontrar e corrigir erros antes da versao estavel.\n' >&2
    printf '        Nenhum canal promete estabilidade.\n' >&2
    printf '  Escolha [1]: ' >&2
    IFS= read -r choice || choice=""
    case "$choice" in 2) CHANNEL="beta" ;; *) CHANNEL="stable" ;; esac
    printf '%s\n' "$CHANNEL"
}

# $2 opcional: outro settings.json (o do Vencord dentro do Vesktop, que nao usa o ~/.config do mod).
set_plugin_settings() {
    local root="$1"
    local file="${2:-}"
    [ -n "$file" ] || file="$(mod_settings_file "$root")"
    mkdir -p "$(dirname "$file")"

    GLB_FILE="$file" GLB_CHANNEL="$CHANNEL" node -e '
        const fs = require("fs");
        const file = process.env.GLB_FILE;
        const channel = process.env.GLB_CHANNEL;
        let settings = {};
        if (fs.existsSync(file)) {
            const raw = fs.readFileSync(file, "utf8");
            if (raw.trim() !== "") {
                try { settings = JSON.parse(raw); }
                catch (error) {
                    const backup = file + ".bak-" + Date.now();
                    fs.copyFileSync(file, backup);
                    console.error("ilegivel, copia em " + backup);
                    process.exit(2);
                }
            }
        }
        if (!settings || Array.isArray(settings) || typeof settings !== "object") settings = {};
        if (!settings.plugins || Array.isArray(settings.plugins) || typeof settings.plugins !== "object") settings.plugins = {};
        const existing = settings.plugins.GoLiveBypass;
        const plugin = existing && !Array.isArray(existing) && typeof existing === "object" ? existing : {};
        plugin.enabled = true;
        if (plugin.excludedCountries === undefined) plugin.excludedCountries = "BR";
        if (channel === "stable" || channel === "beta") plugin.updateChannel = channel;
        settings.plugins.GoLiveBypass = plugin;
        fs.writeFileSync(file, JSON.stringify(settings, null, 4) + "\n");
    ' && step "Plugin ativado em $file (canal $CHANNEL)" || warn "Nao mexi no $file. Ative o GoLiveBypass na mao em Configuracoes > Plugins."
}

persist_channel() {
    local root="$1" channel="$2" file
    case "$channel" in stable|beta) ;; *) return 1 ;; esac
    file="$(mod_settings_file "$root")"
    mkdir -p "$(dirname "$file")"
    GLB_FILE="$file" GLB_CHANNEL="$channel" node -e '
        const fs = require("fs");
        const file = process.env.GLB_FILE;
        const channel = process.env.GLB_CHANNEL;
        let settings = {};
        if (fs.existsSync(file)) {
            const raw = fs.readFileSync(file, "utf8");
            if (raw.trim()) {
                try { settings = JSON.parse(raw); }
                catch { process.exit(2); }
            }
        }
        if (!settings || Array.isArray(settings) || typeof settings !== "object") settings = {};
        if (!settings.plugins || Array.isArray(settings.plugins) || typeof settings.plugins !== "object") settings.plugins = {};
        const plugin = settings.plugins.GoLiveBypass && typeof settings.plugins.GoLiveBypass === "object" && !Array.isArray(settings.plugins.GoLiveBypass)
            ? settings.plugins.GoLiveBypass : {};
        plugin.updateChannel = channel;
        settings.plugins.GoLiveBypass = plugin;
        fs.writeFileSync(file, JSON.stringify(settings, null, 4) + "\n");
    ' || { warn "Nao consegui persistir o canal em $file; o arquivo permaneceu intacto."; return 1; }
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
        printf '  %s  Canal     %s%s\n' "$C_DIM" "$(get_persisted_channel "$root" || printf stable)" "$C_OFF"
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
    clear_stale_discord_locks

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
    warn "Deixe este terminal aberto. Quando voce fechar o Discord, removo apenas o plugin GoLiveBypass."

    sleep 5
    while discord_running; do sleep 2; done

    remove_plugin_source "$root"
    ok "GoLiveBypass removido; Vencord/Equicord preservado."
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

# Busca a coleção de releases e seleciona a maior SemVer válida do canal.
# A seleção exige release publicada, tag coerente, zip e SHA-256 publicados.
github_release_candidates() {
    local channel="${1:-$CHANNEL}" json_file
    json_file="$(mktemp 2>/dev/null)" || return 1
    if have curl; then
        curl -fsSL -H "User-Agent: $GITHUB_UA" -H "Accept: application/vnd.github+json" "$GITHUB_API/releases?per_page=30" >"$json_file" 2>/dev/null || { rm -f "$json_file"; return 1; }
    elif have wget; then
        wget -qO "$json_file" --header="User-Agent: $GITHUB_UA" --header="Accept: application/vnd.github+json" "$GITHUB_API/releases?per_page=30" 2>/dev/null || { rm -f "$json_file"; return 1; }
    else
        rm -f "$json_file"; return 1
    fi
    GLB_RELEASE_FILE="$json_file" node - "$channel" <<'NODE'
const fs = require("fs");
const channel = process.argv[2];
let releases;
try { releases = JSON.parse(fs.readFileSync(process.env.GLB_RELEASE_FILE, "utf8")); } catch { process.exit(1); }
if (!Array.isArray(releases)) process.exit(1);
const rx = /^[vV]?([0-9]+)\.([0-9]+)\.([0-9]+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
function parse(value) {
  const m = rx.exec(String(value ?? "")); if (!m) return null;
  if ([m[1],m[2],m[3]].some(v => v.length > 1 && v[0] === "0")) return null;
  let pre = m[4] ? m[4].split(".") : [];
  if (pre.length === 1) { const legacy = /^beta-([0-9]+)$/.exec(pre[0]); if (legacy) pre=["beta",legacy[1]]; }
  if (pre.some(v => /^\d+$/.test(v) && v.length > 1 && v[0] === "0")) return null;
  return { core: [BigInt(m[1]),BigInt(m[2]),BigInt(m[3])], pre, normalized: `${m[1]}.${m[2]}.${m[3]}${pre.length ? "-"+pre.join("-") : ""}` };
}
function cmp(a,b) {
  for (let i=0;i<3;i++) if (a.core[i] !== b.core[i]) return a.core[i] < b.core[i] ? -1 : 1;
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : (a.pre.length ? -1 : 1);
  for (let i=0;i<Math.max(a.pre.length,b.pre.length);i++) {
    if (i >= a.pre.length) return -1; if (i >= b.pre.length) return 1;
    const x=a.pre[i], y=b.pre[i], xn=/^\d+$/.test(x), yn=/^\d+$/.test(y);
    const c=xn&&yn ? (BigInt(x)<BigInt(y)?-1:BigInt(x)>BigInt(y)?1:0) : xn!==yn ? (xn?-1:1) : (x<y?-1:x>y?1:0);
    if (c) return c;
  }
  return 0;
}
let best = null;
for (const r of releases) {
  if (!r || r.draft !== false || typeof r.tag_name !== "string" || typeof r.prerelease !== "boolean") continue;
  const v=parse(r.tag_name); if (!v) continue;
  const pre=v.pre.length>0;
  if (r.prerelease !== pre) continue;
  if (channel === "stable" && pre) continue;
  const assets=Array.isArray(r.assets)?r.assets:[];
  const zip=assets.find(a=>a && a.name==="goLiveBypass-vencord.zip");
  const sha=assets.find(a=>a && a.name==="goLiveBypass-vencord.zip.sha256");
  if (!zip || !sha || typeof zip.browser_download_url !== "string" || typeof sha.browser_download_url !== "string" ||
      !/^https:\/\//.test(zip.browser_download_url) || !/^https:\/\//.test(sha.browser_download_url)) continue;
  const c={version:v.normalized,zip:zip.browser_download_url,sha:sha.browser_download_url,pre};
  if (!best || cmp(parse(c.version),parse(best.version))>0) best=c;
}
if (best) process.stdout.write(`${best.version}\n${best.zip}\n${best.sha}\n${best.pre ? "1" : "0"}\n`);
NODE
    local status=$?
    rm -f "$json_file"
    return "$status"
}

github_latest_release() { github_release_candidates "${1:-$CHANNEL}"; }
github_plugin_release() { github_release_candidates "${1:-$CHANNEL}"; }

installed_plugin_version() {
    local target="$1/manifest.json"
    if [ ! -f "$target" ]; then target="$1/src/userplugins/$PLUGIN_DIR_NAME/manifest.json"; fi
    [ -f "$target" ] || return 0
    grep -oE '"version"[[:space:]]*:[[:space:]]*"[0-9][^"]*"' "$target" 2>/dev/null | head -1 | sed 's/.*"\([0-9][^"]*\)".*/\1/'
}

compare_version() {
    local installed="$1" latest="$2" result
    [ -n "$latest" ] || { echo "0"; return; }
    [ -n "$installed" ] || { echo "-1"; return; }
    result=$(GLB_INSTALLED="$installed" GLB_LATEST="$latest" node -e '
const rx=/^[vV]?([0-9]+)\.([0-9]+)\.([0-9]+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
function p(s){const m=rx.exec(s||"");if(!m||[m[1],m[2],m[3]].some(v=>v.length>1&&v[0]==="0"))return null;let pre=m[4]?m[4].split("."):[];if(pre.length===1){const x=/^beta-([0-9]+)$/.exec(pre[0]);if(x)pre=["beta",x[1]];}if(pre.some(v=>/^\d+$/.test(v)&&v.length>1&&v[0]==="0"))return null;return{c:m.slice(1,4).map(BigInt),p:pre};}
function c(a,b){for(let i=0;i<3;i++)if(a.c[i]!==b.c[i])return a.c[i]<b.c[i]?-1:1;if(!a.p.length||!b.p.length)return a.p.length===b.p.length?0:(a.p.length?-1:1);for(let i=0;i<Math.max(a.p.length,b.p.length);i++){if(i>=a.p.length)return-1;if(i>=b.p.length)return 1;let x=a.p[i],y=b.p[i],xn=/^\d+$/.test(x),yn=/^\d+$/.test(y),z=xn&&yn?(BigInt(x)<BigInt(y)?-1:BigInt(x)>BigInt(y)?1:0):xn!==yn?(xn?-1:1):(x<y?-1:x>y?1:0);if(z)return z;}return 0;}
const a=p(process.env.GLB_INSTALLED),b=p(process.env.GLB_LATEST);process.stdout.write(!b?"0":!a?"-2":String(c(a,b)));
') || { echo "-2"; return; }
    echo "$result"
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
    local installed root latest_release latest_tag latest_zip latest_sha cmp
    root="$(find_checkout 2>/dev/null || true)"
    if [ -z "$root" ]; then
        printf 'plugin: %snao encontrado%s (rode uma vez para instalar)\n' "$C_YELLOW" "$C_OFF"
        return 0
    fi
    CHANNEL="$(select_update_channel "$root")"
    installed=$(installed_plugin_version "$root")
    if [ -z "$installed" ]; then
        printf 'plugin: %sinstalado (versao desconhecida)%s\n' "$C_YELLOW" "$C_OFF"
    else
        printf 'plugin: instalado (v%s)\n' "$installed"
    fi
    if ! latest_release=$(github_latest_release "$CHANNEL" 2>/dev/null); then
        printf 'remote: %snao consegui consultar (rede, timeout, JSON invalido ou metadata incoerente)%s\n' "$C_DIM" "$C_OFF"
        return 0
    fi
    latest_tag=$(printf '%s\n' "$latest_release" | sed -n '1p')
    latest_zip=$(printf '%s\n' "$latest_release" | sed -n '2p')
    latest_sha=$(printf '%s\n' "$latest_release" | sed -n '3p')
    [ -n "$latest_tag" ] || { printf 'remote: nenhuma release %s valida com zip e SHA-256 (ausente, metadata incoerente, rede ou rate limit)\n' "$CHANNEL"; return 0; }
    persist_channel "$root" "$CHANNEL" || true
    printf 'canal: %s\n' "$CHANNEL"
    printf 'remote: %s\n' "$latest_tag"
    if [ -z "$installed" ]; then
        printf 'resultado: %sversao local desconhecida - rode --update para alinhar%s\n' "$C_YELLOW" "$C_OFF"
        return 0
    fi
    cmp=$(compare_version "$installed" "$latest_tag")
    case "$cmp" in
        0) printf 'resultado: %svoce esta na versao mais recente%s\n' "$C_GREEN" "$C_OFF" ;;
        1) printf 'resultado: %sversao local mais nova que a release (nenhum downgrade)%s\n' "$C_DIM" "$C_OFF" ;;
        -1) printf 'resultado: %sha versao nova - rode --update para atualizar%s\n' "$C_YELLOW" "$C_OFF" ;;
        *) printf 'resultado: %sversao local invalida; nenhum update seguro%s\n' "$C_YELLOW" "$C_OFF" ;;
    esac
    return 0
}

do_update() {
    local installed root latest_release latest_tag latest_zip latest_sha cmp
    root="$(find_checkout 2>/dev/null || true)"
    [ -n "$root" ] || fail "Nao achei o checkout do mod. Rode o instalador uma vez (sem --update) para descobrir."
    CHANNEL="$(select_update_channel "$root")"
    installed=$(installed_plugin_version "$root")
    if [ -f "$root/src/userplugins/$PLUGIN_DIR_NAME/manifest.json" ] && [ -z "$installed" ]; then
        fail "A versao instalada do plugin e invalida; nenhum update seguro foi aplicado."
    fi
    if ! latest_release=$(github_latest_release "$CHANNEL" 2>/dev/null); then
        fail "Nao consegui consultar releases do canal $CHANNEL (rede, timeout, JSON invalido ou metadata incoerente)."
    fi
    latest_tag=$(printf '%s\n' "$latest_release" | sed -n '1p')
    latest_zip=$(printf '%s\n' "$latest_release" | sed -n '2p')
    latest_sha=$(printf '%s\n' "$latest_release" | sed -n '3p')
    [ -n "$latest_tag" ] || fail "Nao encontrei release $CHANNEL valida com zip e SHA-256 (ausente, metadata incoerente, rede ou rate limit)."
    if [ -n "$installed" ]; then
        cmp=$(compare_version "$installed" "$latest_tag")
        [ "$cmp" != "-2" ] || fail "A versao instalada do plugin e invalida; nenhum downgrade ou update foi feito."
        if [ "$cmp" = "0" ]; then
            persist_channel "$root" "$CHANNEL" || true
            ok "Voce ja esta na versao $latest_tag (canal $CHANNEL)."
            return 0
        fi
        if [ "$cmp" = "1" ]; then
            persist_channel "$root" "$CHANNEL" || true
            warn "Versao local (v$installed) e mais nova; nenhum downgrade foi feito."
            return 0
        fi
    fi
    step "Fazendo backup do plugin atual"
    backup_plugin "$root" || warn "Backup nao foi possivel, mas sigo adiante."
    do_update_from_zip "$root" "$latest_zip" "$latest_tag" "$latest_sha"
    ensure_toolchain 0
    build_mod "$root"
    if ! injected_from_checkout "$root"; then inject_mod "$root"; fi
    persist_channel "$root" "$CHANNEL" || true
    printf '\n'
    ok "Atualizado para $latest_tag (canal $CHANNEL). Reinicie o Discord para carregar a nova versao."
}

# Baixa o zip do userplugin, valida SHA-256 publicado e extrai por cima.
do_update_from_zip() {
    local root="$1" zip_url="$2" expected_version="$3" sha_url="${4:-}"
    local tmpdir zipfile sha_actual sha_expected
    step "Baixando $zip_url"
    tmpdir=$(mktemp -d 2>/dev/null) || fail "Nao consegui criar pasta temporaria."
    zipfile="$tmpdir/plugin.zip"
    if have curl; then
        curl -fsSL -o "$zipfile" "$zip_url" || { rm -rf "$tmpdir"; fail "Download do zip falhou."; }
    elif have wget; then
        wget -qO "$zipfile" "$zip_url" || { rm -rf "$tmpdir"; fail "Download do zip falhou."; }
    else
        rm -rf "$tmpdir"; fail "Preciso de curl ou wget para baixar."
    fi
    [ -n "$sha_url" ] || sha_url="${zip_url}.sha256"
    sha_expected=$(download_text "$sha_url" 2>/dev/null | awk '{print $1}' | head -1 | tr '[:upper:]' '[:lower:]')
    if ! printf '%s\n' "$sha_expected" | grep -Eq '^[0-9a-fA-F]{64}$'; then
        rm -rf "$tmpdir"
        fail "Release sem SHA-256 valido. Sem hash, sem update."
    fi
    sha_actual=$(sha256sum "$zipfile" 2>/dev/null | awk '{print $1}')
    if [ "$sha_actual" != "$sha_expected" ]; then
        rm -rf "$tmpdir"; fail "SHA-256 nao confere: esperado $sha_expected, obtido $sha_actual."
    fi
    ok "SHA-256 confere"
    mkdir -p "$tmpdir/extract"

    step "Extraindo o plugin em $root/src/userplugins/$PLUGIN_DIR_NAME"
    local extracted actual_version
    if have unzip; then
        unzip -oq "$zipfile" -d "$tmpdir/extract" || { rm -rf "$tmpdir"; fail "Extracao falhou."; }
    elif tar -xf "$zipfile" -C "$tmpdir/extract" 2>/dev/null; then
        :
    else
        rm -rf "$tmpdir"; fail "Preciso de unzip ou tar para extrair (nem um estao disponiveis)."
    fi
    extracted=$(find "$tmpdir/extract" -mindepth 1 -maxdepth 1 -type d | head -1)
    if [ -z "$extracted" ] || [ "$(basename "$extracted")" != "$PLUGIN_DIR_NAME" ]; then
        rm -rf "$tmpdir"; fail "Zip nao tem a pasta esperada (goLiveBypass/)."
    fi
    actual_version="$(installed_plugin_version "$extracted")"
    if [ -z "$actual_version" ] || [ "$(compare_version "$actual_version" "$expected_version")" != "0" ]; then
        rm -rf "$tmpdir"; fail "Manifest do plugin nao corresponde a release $expected_version."
    fi
    validate_plugin_source_tree "$extracted" || { rm -rf "$tmpdir"; fail "Zip do plugin incompleto."; }
    local target="$root/src/userplugins/$PLUGIN_DIR_NAME"
    rm -rf "$target"
    mkdir -p "$target"
    cp -R "$extracted"/. "$target"/ || { rm -rf "$tmpdir"; fail "Copia falhou."; }
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
    local root="${1:-}" installed_kind
    installer_log info installer.detect.started detect mode install
    root="$(select_target "$root")"
    CHANNEL="$(select_update_channel "$root")"
    local checkout_identity identity
    checkout_identity="$(checkout_mod "$root")"
    installer_log info installer.discord_detected detect discord_count "$(discord_installs | wc -l | tr -d ' ')"
    installed_kind="$(installed_mod || true)"
    if [ -n "$installed_kind" ]; then
        installer_log info installer.mod_detected detect mod_kind "$installed_kind"
    fi
    installer_log info installer.selected preparing mod_kind "$checkout_identity" path_present true channel "$CHANNEL"
    while IFS= read -r identity; do
        [ -z "$identity" ] && continue
        if [ "$identity" != "$checkout_identity" ]; then
            fail "O Discord ja carrega $identity, mas este checkout e $checkout_identity. Preservei o mod existente; use --source do checkout correto."
        fi
    done <<EOF
$(injection_identities)
EOF

    # A escolha de alvos vem PRIMEIRO, assim que o checkout esta definido, e antes de mexer
    # em qualquer coisa do ambiente ou do checkout. Com varios clientes e TUI, a pergunta
    # aparece antes de ensure_toolchain/install_plugin_source/build_mod e antes de qualquer
    # injecao: Esc cancela na hora, sem instalar dependencias, sem compilar o plugin e sem
    # tocar no Discord. Um unico alvo ou --yes continuam sem perguntar (escolher_alvos_inject
    # decide). A lista e reaproveitada la embaixo, entao o seletor nunca roda duas vezes.
    #
    # Isto tambem e o que garante o seletor em quem ja tem um cliente injetado: a decisao de
    # pular so olha os alvos ESCOLHIDOS aqui (alvos_ja_injetados), e nao mais "o checkout ja
    # esta injetado em algum lugar?" -- pergunta que, sozinha, escondia o menu de quem tinha
    # o Equibop injetado mesmo com Vesktop, Legcord e flatpaks intocados.
    local escolhidos
    escolhidos="$(selecionar_alvos_inject "$root")"

    # select_persistence responde 0 para permanente e 1 para temporario. Guardamos na forma
    # positiva: a variavel invertida ("permanent=1 quando temporario") funciona por dupla
    # negacao, mas e exatamente a armadilha que deixou o temporario preso no instalador
    # PowerShell, onde a leitura do estado se perdeu e ninguem notou.
    local permanente=0
    if select_persistence; then permanente=1; fi

    ensure_toolchain 0
    install_plugin_source "$root"
    build_mod "$root"

    # So pula a injecao quando TODOS os alvos escolhidos ja estao prontos; espelha o
    # $oficialPendente/Select-InjectionTargets do instalador PowerShell.
    local flatpak_id=""
    if alvos_ja_injetados "$root" "$escolhidos"; then
        step "O Discord ja carrega deste checkout, so reiniciando"
        stop_discord
        # Por aqui o instalador do mod nao roda, e a liberacao do sandbox nao acontece
        # sozinha. Se ela tiver caido num `flatpak update`, o Discord abriria com erro.
        if flatpak_id="$(injected_flatpak_id "$root")"; then
            grant_flatpak_access "$flatpak_id" "$root/dist"
        fi
    else
        injetar_alvos "$root" "$escolhidos"
        flatpak_id="$(injected_flatpak_id "$root" || true)"
    fi

    # Com o Discord fechado: aberto, ele regrava o settings.json a partir da memoria e
    # apaga o que escrevemos aqui.
    set_plugin_settings "$root"

    start_discord "$root"

    GLB_PHASE="completed"
    if [ "$permanente" -eq 1 ]; then
        installer_log info installer.completed completed permanent true channel "$CHANNEL"
    else
        installer_log info installer.completed completed permanent false channel "$CHANNEL"
    fi

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
    # Cliente paralelo patchado continuaria rodando o build antigo, que ainda tem o plugin
    # dentro: atualiza o patch com o build recem-saido (sem o plugin).
    refresh_parallel_patches "$root"
    remove_tor
    start_discord "$root"

    printf '\n'
    ok "Plugin removido. Seu Equicord/Vencord continua funcionando."
}

do_restore_everything() {
    local root
    if root="$(find_checkout)"; then
        remove_plugin_source "$root"
        stop_discord
    else
        warn "Nao achei o fonte do mod, entao so posso parar por aqui."
    fi

    remove_tor
    printf '\n'
    ok "GoLiveBypass removido; Vencord/Equicord e o Discord foram preservados."
}
change_channel_menu() {
    local root="${1:-}" current choice selected
    if [ -z "$root" ]; then
        warn "Para persistir o canal, primeiro prepare um checkout do Equicord/Vencord; a instalacao inicial perguntara o canal depois de preparar o mod."
        return 0
    fi

    current="$(get_persisted_channel "$root" || true)"
    current="${current:-stable}"
    if [ "$CHANNEL_EXPLICIT" -eq 1 ]; then
        printf '  Canal fixado por --channel: %s. Nada foi alterado pelo submenu.\n' "$CHANNEL" >&2
        return 0
    fi
    if [ "$ASSUME_YES" -eq 1 ]; then
        persist_channel "$root" "$current" || return 0
        ok "Canal mantido em $current."
        return 0
    fi

    if tui_is_interactive; then
        choice="$(tui_menu "Canal de atualizacoes (atual: $current)" \
            "Stable (recomendado) — canal mais previsivel, somente releases estaveis" \
            "Beta (opt-in) — canal de testes; ajuda a encontrar e corrigir erros" \
            "Cancelar")"
        case "$choice" in
            1) selected="stable" ;;
            2) selected="beta" ;;
            *) return 0 ;;
        esac
    else
        printf '\n  %sCanal de atualizacoes (atual: %s)%s\n\n' "$C_BOLD" "$current" "$C_OFF" >&2
        printf '    %s[1] Stable (recomendado)%s\n' "$C_GREEN" "$C_OFF" >&2
        printf '  %s      Canal mais previsivel, somente releases estaveis.%s\n' "$C_DIM" "$C_OFF" >&2
        printf '    %s[2] Beta (opt-in)%s\n' "$C_YELLOW" "$C_OFF" >&2
        printf '  %s      Canal de testes; voce ajuda a comunidade a testar, encontrar e corrigir erros antes da versao estavel.%s\n' "$C_DIM" "$C_OFF" >&2
        printf '    %s[0] Cancelar%s\n\n' "$C_DIM" "$C_OFF" >&2
        printf '%s' "  Escolha: " >&2
        IFS= read -r choice || return 0
        case "$choice" in
            1) selected="stable" ;;
            2) selected="beta" ;;
            *) return 0 ;;
        esac
    fi

    persist_channel "$root" "$selected" || return 0
    if [ "$(get_persisted_channel "$root" || true)" = "$selected" ]; then
        ok "Canal salvo: $selected. Voltando ao menu."
    else
        warn "Nao consegui confirmar o canal salvo; nada mais foi executado."
    fi
}

main_menu() {
    local root
    while :; do
        root="$(find_checkout || true)"
        show_status "$root"

        if tui_is_interactive; then
            local tui_choice
            tui_choice="$(tui_menu "O que voce quer fazer?" \
                "Instalar o GoLiveBypass" \
                "Verificar atualizacoes do plugin" \
                "Atualizar o plugin" \
                "Mudar canal de atualizacoes" \
                "Remover so o plugin (o mod continua)" \
                "Restaurar tudo (remove o plugin; preserva o mod)" \
                "Ver estado dos clientes (injecao/backup)" \
                "Restaurar cliente que nao abre (devolve o app.asar)" \
                "Sair")"
            case "$tui_choice" in
                1) do_install "$root"; return ;;
                2) do_check_update; return ;;
                3) do_update; return ;;
                4) change_channel_menu "$root"; continue ;;
                5) do_uninstall; return ;;
                6) do_restore_everything; return ;;
                7) show_client_states; continue ;;
                8) do_restore_client "$RESTORE_CLIENT_TARGET"; continue ;;
                *) printf '  %sAte mais.%s\n' "$C_DIM" "$C_OFF" >&2; return ;;
            esac
        fi

        printf '  %sO que voce quer fazer?%s\n\n' "$C_BOLD" "$C_OFF" >&2
        printf '    %s[1] Instalar o GoLiveBypass%s\n' "$C_GREEN" "$C_OFF" >&2
        printf '    %s[2] Verificar atualizacoes do plugin%s\n' "$C_CYAN" "$C_OFF" >&2
        printf '    %s[3] Atualizar o plugin%s\n' "$C_GREEN" "$C_OFF" >&2
        printf '    %s[4] Mudar canal de atualizacoes%s\n' "$C_CYAN" "$C_OFF" >&2
        printf '    %s[5] Remover so o plugin (o mod continua)%s\n' "$C_YELLOW" "$C_OFF" >&2
        printf '    %s[6] Restaurar tudo (remove o plugin; preserva o mod)%s\n' "$C_RED" "$C_OFF" >&2
        printf '    %s[7] Ver estado dos clientes (injecao/backup)%s\n' "$C_CYAN" "$C_OFF" >&2
        printf '    %s[8] Restaurar cliente que nao abre (devolve o app.asar)%s\n' "$C_YELLOW" "$C_OFF" >&2
        printf '%s' "  Escolha: " >&2
        local choice
        IFS= read -r choice || return 0
        case "$choice" in
            1) do_install "$root"; return ;;
            2) do_check_update; return ;;
            3) do_update; return ;;
            4) change_channel_menu "$root"; continue ;;
            5) do_uninstall; return ;;
            6) do_restore_everything; return ;;
            7) show_client_states; continue ;;
            8) do_restore_client "$RESTORE_CLIENT_TARGET"; continue ;;
            *) printf '  %sAte mais.%s\n' "$C_DIM" "$C_OFF" >&2; return ;;
        esac
    done
}


banner
case "$MODE" in
    install) do_install "$(find_checkout || true)" ;;
    uninstall) do_uninstall ;;
    restore) do_restore_everything ;;
    restore-client) do_restore_client "$RESTORE_CLIENT_TARGET" ;;
    client-status) show_client_states ;;
    check-update) do_check_update ;;
    update) do_update ;;
    *) main_menu ;;
esac
printf '\n'
