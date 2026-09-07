#!/usr/bin/env bash
# Matriz de estabilidade Linux para a GUI AppImage e o shell WireGuard
# compartilhado. Cada caso roda em um container descartavel; nenhum namespace,
# rota ou pacote do host e alterado.
#
# Uso:
#   ./tests/test-linux-matrix.sh --quick       # preflight + compatibilidade
#   ./tests/test-linux-matrix.sh --full        # inclui reparo dos pacotes ausentes
#   RUNTIME=podman MATRIX_REPORT_DIR=... ./tests/test-linux-matrix.sh --full
#
# O caso Arch snapshot usa archive.archlinux.org e pode ser desabilitado quando o
# espelho historico estiver indisponivel. Para tornar essa ausencia uma falha de
# infraestrutura (em vez de um skip), use REQUIRE_ARCH_SNAPSHOT=1.

set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "$0")/.." && pwd)"
MODE="full"
REQUIRE_ARCH_SNAPSHOT="${REQUIRE_ARCH_SNAPSHOT:-0}"
ARCH_SNAPSHOT_DATE="${ARCH_SNAPSHOT_DATE:-2025/09/01}"
ARCH_SNAPSHOT_IMAGE="${ARCH_SNAPSHOT_IMAGE:-golive-arch-snapshot:20250901}"
APPIMAGE_PATH="${APPIMAGE_PATH:-}"
APPIMAGE_NAME=""
declare -a CONTAINER_APPIMAGE_ARGS=()
REPORT_DIR="${MATRIX_REPORT_DIR:-}"
PASS=0
FAIL=0
SKIP=0
REPORT_FILE=""
TMP_ROOT=""

usage() {
    cat >&2 <<'USAGE'
Uso: tests/test-linux-matrix.sh [--quick|--full] [--require-arch-snapshot]

  --quick                   nao instala pacotes nem tenta carregar GUI
  --full                    preflight + reparo somente das dependencias ausentes
  --require-arch-snapshot   falha se o repositorio Arch de 2025-09-01 nao puder ser criado

Variaveis:
  RUNTIME=podman|docker     runtime dos containers (podman e o padrao)
  MATRIX_INSTALL=0|1        atalho para quick/full
  MATRIX_REPORT_DIR=DIR     grava o relatorio sanitizado em DIR
  MATRIX_CASES=LIST         executa somente labels selecionados (ex.: debian-12,fedora-43)
  APPIMAGE_PATH=FILE        AppImage ja compilado para auditoria de bibliotecas
  ARCH_SNAPSHOT_IMAGE=NAME  imagem pronta para o caso Arch historico
USAGE
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --quick) MODE="quick" ;;
        --full) MODE="full" ;;
        --require-arch-snapshot) REQUIRE_ARCH_SNAPSHOT=1 ;;
        -h|--help) usage; exit 0 ;;
        *) printf 'Opcao desconhecida: %s\n' "$1" >&2; usage; exit 2 ;;
    esac
    shift
done
if [[ "${MATRIX_INSTALL:-}" == "0" ]]; then MODE="quick"; fi
if [[ "${MATRIX_INSTALL:-}" == "1" ]]; then MODE="full"; fi

if [[ -z "${RUNTIME:-}" ]]; then
    if command -v podman >/dev/null 2>&1; then
        RUNTIME=podman
    elif command -v docker >/dev/null 2>&1; then
        RUNTIME=docker
    else
        printf 'Preciso do podman ou do docker para a matriz Linux.\n' >&2
        exit 2
    fi
fi
command -v "$RUNTIME" >/dev/null 2>&1 || {
    printf 'Runtime nao encontrado: %s\n' "$RUNTIME" >&2
    exit 2
}
command -v node >/dev/null 2>&1 || {
    printf 'Node e necessario para validar o JSON do preflight.\n' >&2
    exit 2
}
if [[ -n "$APPIMAGE_PATH" ]]; then
    APPIMAGE_PATH="$(realpath "$APPIMAGE_PATH")"
    [[ -f "$APPIMAGE_PATH" ]] || {
        printf 'AppImage nao encontrado: %s\n' "$APPIMAGE_PATH" >&2
        exit 2
    }
    APPIMAGE_NAME="$(basename "$APPIMAGE_PATH")"
    CONTAINER_APPIMAGE_ARGS=(-v "$APPIMAGE_PATH:/tmp/golive-input.AppImage:ro")
fi

if [[ -n "$REPORT_DIR" ]]; then
    TMP_ROOT="$(mktemp -d -t golive-linux-matrix.XXXXXX)"
    mkdir -p "$REPORT_DIR"
    REPORT_FILE="$REPORT_DIR/linux-matrix-$(date -u +%Y%m%dT%H%M%SZ).log"
else
    TMP_ROOT="$(mktemp -d -t golive-linux-matrix.XXXXXX)"
    REPORT_FILE="$TMP_ROOT/report.log"
fi
touch "$REPORT_FILE"
cleanup() {
    if [[ -n "$TMP_ROOT" && -d "$TMP_ROOT" ]]; then
        rm -rf "$TMP_ROOT" 2>/dev/null || true
    fi
}
trap cleanup EXIT

sanitize() {
    # Os comandos executados nesta suite nao recebem sessoes Proton. Esta guarda
    # ainda remove acidentalmente qualquer valor com nome sensivel antes de gravar.
    sed -E 's/(^|[[:space:],;{])(token|password|passwd|private[-_]?key|session)[=:][^[:space:]]+/\1\2=[REDACTED]/Ig'
}
report() {
    local line
    line="[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"
    printf '%s\n' "$line" | sanitize | tee -a "$REPORT_FILE" >&2
}
pass() { PASS=$((PASS + 1)); printf '  [OK] %s\n' "$*" >&2; report "OK $*"; }
fail() { FAIL=$((FAIL + 1)); printf '  [FAIL] %s\n' "$*" >&2; report "FAIL $*"; }
skip() { SKIP=$((SKIP + 1)); printf '  [SKIP] %s\n' "$*" >&2; report "SKIP $*"; }

declare -a MATRIX=(
    "ubuntu|24.04|docker.io/library/ubuntu:24.04|bash|current"
    "ubuntu|22.04|docker.io/library/ubuntu:22.04|bash|previous"
    "debian|13|docker.io/library/debian:13-slim|bash|current"
    "debian|12|docker.io/library/debian:12-slim|bash|previous"
    "fedora|43|docker.io/library/fedora:43|bash|current"
    "fedora|42|docker.io/library/fedora:42|bash|previous"
    "arch|current|docker.io/archlinux:base|bash|current"
    "arch|snapshot-2025-09-01|${ARCH_SNAPSHOT_IMAGE}|bash|snapshot"
)

image_exists() {
    "$RUNTIME" image exists "$1" >/dev/null 2>&1
}

prepare_arch_snapshot() {
    local image="$ARCH_SNAPSHOT_IMAGE" file
    if image_exists "$image"; then
        return 0
    fi
    if [[ -n "${ARCH_SNAPSHOT_IMAGE_EXTERNAL:-}" ]]; then
        return 1
    fi
    file="$(mktemp -t golive-arch-snapshot.XXXXXX.Containerfile)"
    cat >"$file" <<'CONTAINERFILE'
FROM docker.io/archlinux:base
ARG SNAPSHOT_DATE=2025/09/01
RUN printf 'Server = https://archive.archlinux.org/repos/%s/$repo/os/$arch\n' "$SNAPSHOT_DATE" > /etc/pacman.d/mirrorlist
CONTAINERFILE
    report "ARCH snapshot build image=$image date=$ARCH_SNAPSHOT_DATE"
    if "$RUNTIME" build --pull=missing --build-arg "SNAPSHOT_DATE=$ARCH_SNAPSHOT_DATE" \
        -t "$image" -f "$file" "$ROOT" >>"$REPORT_FILE" 2>&1; then
        rm -f "$file"
        return 0
    fi
    rm -f "$file"
    return 1
}

make_fake_home() {
    local home="$1"
    mkdir -p "$home/.config/discord/app-9.9.9/resources"
    printf 'matrix fixture\n' >"$home/.config/discord/app-9.9.9/resources/app.asar"
    chmod -R a+rwX "$home"
}

container_run() {
    # $1 imagem, $2 home temporaria; o restante e o processo dentro do guest.
    local image="$1" home="$2"
    shift 2
    "$RUNTIME" run --rm --pull=missing --user 0 \
        -v "$ROOT:/repo:ro" \
        -v "$home:/home/golive-test" \
        "${CONTAINER_APPIMAGE_ARGS[@]}" \
        -e GOLIVE_GUI=1 \
        -e HOME=/home/golive-test \
        -e XDG_DATA_HOME=/home/golive-test/.local/share \
        "$image" "$@"
}

preflight_summary() {
    local expected="$1" json="$2"
    GOLIVE_PREFLIGHT_JSON="$json" node - "$expected" <<'NODE'
const expected = process.argv[2];
const data = JSON.parse(process.env.GOLIVE_PREFLIGHT_JSON || "");
const distro = String(data.distro || "");
const family = {
  ubuntu: /ubuntu/i,
  debian: /(debian|ubuntu|mint)/i,
  fedora: /(fedora|rhel|centos)/i,
  arch: /(arch|cachy|endeavour|manjaro)/i,
}[expected];
if (!family || !family.test(distro)) throw new Error(`distro inesperada: ${distro}`);
if (data.platform !== "linux") throw new Error("platform nao-linux");
if (!data.dependencies || !Array.isArray(data.dependencies.missing)) throw new Error("dependencies.missing ausente");
if (!Array.isArray(data.dependencies.required) || !["wg", "ip", "curl"].every((x) => data.dependencies.required.includes(x))) {
  throw new Error("required nao cobre wg/ip/curl");
}
const missing = data.dependencies.missing;
if (missing.length > 0 && typeof data.installCommand !== "string") throw new Error("installCommand ausente");
if (/(^|\s)(upgrade|dist-upgrade)(\s|$)|--network[= ]+host|pacman\s+-Sy(\s|$)/i.test(data.installCommand || "")) {
  throw new Error("comando sugere upgrade global, rede host ou pacman -Sy parcial");
}
process.stdout.write(JSON.stringify({ distro, missing, netns: Boolean(data.netns && data.netns.available), discord: Boolean(data.discord && data.discord.found) }));
NODE
}

compatibility_audit() {
    local image="$1" home="$2" shell="$3"
    container_run "$image" "$home" "$shell" -c '
set -eu
printf "LIBC="; (getconf GNU_LIBC_VERSION 2>/dev/null || ldd --version 2>/dev/null | head -1 || printf unknown) | head -1
printf "KERNEL=$(uname -r)\n"
for command in wg ip curl dbus-run-session weston; do
    if command -v "$command" >/dev/null 2>&1; then printf "COMMAND_%s=present\n" "$command"; else printf "COMMAND_%s=missing\n" "$command"; fi
done
if command -v ldconfig >/dev/null 2>&1; then
    ldconfig -p 2>/dev/null | grep -E "lib(stdc\+\+|glib-2.0|gtk-3|nss3|curl|ssl|drm)" | head -20 || true
fi
appimage=""
if [ -f /tmp/golive-input.AppImage ]; then appimage=/tmp/golive-input.AppImage; fi
if [ -z "$appimage" ] && [ -n "${APPIMAGE_NAME:-}" ] && [ -f "/repo/golive-gui/dist-app/$APPIMAGE_NAME" ]; then
    appimage="/repo/golive-gui/dist-app/$APPIMAGE_NAME"
fi
if [ -n "$appimage" ]; then
    rm -rf /tmp/golive-appimage-root /tmp/golive-matrix.AppImage squashfs-root
    cp "$appimage" /tmp/golive-matrix.AppImage
    chmod +x /tmp/golive-matrix.AppImage
    if /tmp/golive-matrix.AppImage --appimage-extract >/tmp/golive-appimage-extract.log 2>&1; then
        printf "APPIMAGE_EXTRACT=ok\n"
        electron="$(find squashfs-root /tmp/golive-appimage-root -type f \( -name electron -o -name GoLiveBypass \) -print -quit 2>/dev/null || true)"
        if [ -n "$electron" ] && command -v ldd >/dev/null 2>&1; then
            missing="$(ldd "$electron" 2>&1 | grep -c "not found" || true)"
            printf "APPIMAGE_LDD_MISSING=%s\n" "$missing"
        fi
    else
        printf "APPIMAGE_EXTRACT=failed\n"
        tail -20 /tmp/golive-appimage-extract.log || true
    fi
else
    printf "APPIMAGE=not-provided\n"
fi
'
}

broken_command_fixture() {
    local image="$1" home="$2" shell="$3" expected="$4" json
    json="$(container_run "$image" "$home" "$shell" -c '
set -eu
mkdir -p /tmp/golive-broken-bin
for command in wg ip curl; do
    printf "#!/bin/sh\nexit 1\n" >"/tmp/golive-broken-bin/$command"
    chmod +x "/tmp/golive-broken-bin/$command"
done
PATH=/tmp/golive-broken-bin:$PATH GOLIVE_GUI=1 /repo/standalone/golivebypass-standalone.sh --real-home /home/golive-test --preflight --json
' 2>"$TMP_ROOT/fixture-$expected.err")" || {
        fail "$expected triagem de binarios quebrados nao executou"
        return
    }
    if GOLIVE_PREFLIGHT_JSON="$json" node - <<'NODE'
const data = JSON.parse(process.env.GOLIVE_PREFLIGHT_JSON || "");
const missing = new Set(data.dependencies?.missing || []);
if (!(missing.has("wireguard-tools") && missing.has("iproute2") && missing.has("curl"))) process.exit(1);
NODE
    then
        pass "$expected triagem detecta wg/ip/curl presentes mas inutilizaveis"
    else
        fail "$expected triagem nao detectou binarios quebrados"
    fi
}

run_case() {
    local entry="$1" family version image shell age
    IFS='|' read -r family version image shell age <<<"$entry"
    local label="$family-$version" home preflight compat compat_rc post summary
    home="$(mktemp -d -t "golive-$family-$version.XXXXXX")"
    make_fake_home "$home"
    report "CASE start=$label image=$image mode=$MODE age=$age"
    if ! image_exists "$image"; then
        report "IMAGE pull=$image"
    fi

    if ! preflight="$(container_run "$image" "$home" "$shell" /repo/standalone/golivebypass-standalone.sh --real-home /home/golive-test --preflight --json 2>"$TMP_ROOT/$label-preflight.err")"; then
        fail "$label preflight nao executou: $(tail -5 "$TMP_ROOT/$label-preflight.err" 2>/dev/null | tr '\n' ' ')"
        rm -rf "$home" 2>/dev/null || true
        return
    fi
    if summary="$(preflight_summary "$family" "$preflight" 2>"$TMP_ROOT/$label-summary.err")"; then
        pass "$label preflight ($summary)"
        report "$label preflight-json $preflight"
    else
        fail "$label preflight invalido: $(cat "$TMP_ROOT/$label-summary.err")"
    fi

    if [[ "$MODE" == "full" ]]; then
        # Instala, repete a chamada (idempotencia) e so entao executa o
        # preflight no mesmo container. Uma chamada separada criaria outro
        # guest e daria um falso negativo apos uma instalacao bem-sucedida.
        if post="$(container_run "$image" "$home" "$shell" -c '
set -eu
log1=/tmp/golive-repair-first.log
log2=/tmp/golive-repair-second.log
/repo/standalone/golivebypass-standalone.sh --real-home /home/golive-test --ensure-dependencies >"$log1" 2>&1
/repo/standalone/golivebypass-standalone.sh --real-home /home/golive-test --ensure-dependencies >"$log2" 2>&1
cat "$log1" "$log2" >&2
/repo/standalone/golivebypass-standalone.sh --real-home /home/golive-test --preflight --json
' 2>"$TMP_ROOT/$label-repair.err")" \
            && GOLIVE_PREFLIGHT_JSON="$post" node - <<'NODE'
const data = JSON.parse(process.env.GOLIVE_PREFLIGHT_JSON || "");
if ((data.dependencies?.missing || []).length) process.exit(1);
for (const command of ["wg", "ip", "curl"]) if (!data.dependencies?.required?.includes(command)) process.exit(1);
NODE
        then
            if grep -q "Dependencias Linux ja estao instaladas" "$TMP_ROOT/$label-repair.err"; then
                pass "$label reparo + segunda chamada idempotente"
            else
                fail "$label instalou dependencias, mas a segunda chamada nao foi idempotente"
            fi
            report "$label repair-output $(tail -16 "$TMP_ROOT/$label-repair.err" | tr '\n' ' ')"
            pass "$label preflight pos-reparo sem dependencias ausentes"
            report "$label post-preflight $post"
        else
            fail "$label reparo/preflight falhou: $(tail -12 "$TMP_ROOT/$label-repair.err" 2>/dev/null | tr '\n' ' ')"
        fi
    else
        skip "$label reparo omitido (--quick)"
    fi

    compat_rc=0
    if [[ -n "$APPIMAGE_PATH" ]]; then
        compat="$(compatibility_audit "$image" "$home" "$shell" "$(basename "$APPIMAGE_PATH")" 2>"$TMP_ROOT/$label-compat.err")" || compat_rc=$?
    else
        compat="$(compatibility_audit "$image" "$home" "$shell" "" 2>"$TMP_ROOT/$label-compat.err")" || compat_rc=$?
    fi
    report "$label compatibility $(printf '%s' "$compat" | tr '\n' ' ')"
    if [[ "$compat" == *"APPIMAGE_EXTRACT=failed"* ]]; then
        fail "$label AppImage nao pode ser extraido"
    elif [[ -n "$APPIMAGE_PATH" ]]; then
        pass "$label auditoria de bibliotecas/AppImage"
    else
        skip "$label auditoria AppImage (APPIMAGE_PATH ausente)"
    fi
    broken_command_fixture "$image" "$home" "$shell" "$label"
    rm -rf "$home" 2>/dev/null || true
}

printf '\n== Matriz Linux GoLiveBypass (%s, runtime=%s) ==\n' "$MODE" "$RUNTIME" >&2
report "MATRIX start mode=$MODE runtime=$RUNTIME arch=x86_64 matrix=ubuntu24.04,ubuntu22.04,debian13,debian12,fedora43,fedora42,arch-current,arch-snapshot-2025-09-01"

if [[ "${MATRIX_BUILD_ARCH_SNAPSHOT:-1}" == "0" ]]; then
    skip "imagem Arch snapshot $ARCH_SNAPSHOT_DATE desabilitada por MATRIX_BUILD_ARCH_SNAPSHOT=0"
    MATRIX=("${MATRIX[@]:0:7}")
elif [[ "$REQUIRE_ARCH_SNAPSHOT" == "1" || "${MATRIX_BUILD_ARCH_SNAPSHOT:-1}" != "0" ]]; then
    if prepare_arch_snapshot; then
        pass "imagem Arch snapshot $ARCH_SNAPSHOT_DATE preparada"
    elif [[ "$REQUIRE_ARCH_SNAPSHOT" == "1" ]]; then
        fail "imagem Arch snapshot $ARCH_SNAPSHOT_DATE indisponivel"
    else
        skip "imagem Arch snapshot $ARCH_SNAPSHOT_DATE indisponivel (infraestrutura)"
        # O caso continua registrado como skip, sem fingir que a release historica
        # foi coberta. Remover da matriz evita um pull repetido a cada rodada.
        MATRIX=("${MATRIX[@]:0:7}")
    fi
fi

if [[ -n "${MATRIX_CASES:-}" ]]; then
    declare -a FILTERED_MATRIX=()
    IFS=',' read -r -a requested_cases <<<"$MATRIX_CASES"
    for entry in "${MATRIX[@]}"; do
        IFS='|' read -r case_family case_version _case_image _case_shell _case_age <<<"$entry"
        case_label="$case_family-$case_version"
        for requested in "${requested_cases[@]}"; do
            if [[ "$requested" == "$case_label" ]]; then
                FILTERED_MATRIX+=("$entry")
                break
            fi
        done
    done
    MATRIX=("${FILTERED_MATRIX[@]}")
    ((${#MATRIX[@]} > 0)) || {
        printf 'MATRIX_CASES nao corresponde a nenhum caso da matriz.\n' >&2
        exit 2
    }
fi

for entry in "${MATRIX[@]}"; do
    run_case "$entry"
done

printf '\n== Provas de namespace/rota no host descartavel ==\n' >&2
if [[ "${MATRIX_SKIP_HOST_PROBES:-0}" == "1" ]]; then
    skip "provas host desabilitadas por MATRIX_SKIP_HOST_PROBES=1"
elif [[ -x "$ROOT/tests/test-linux-netns-detection.sh" ]] && command -v unshare >/dev/null 2>&1; then
    if host_probe="$("$ROOT/tests/test-linux-netns-detection.sh" 2>&1)"; then
        pass "netns detection isolado"
        report "host-netns $host_probe"
    elif printf '%s' "$host_probe" | grep -Eqi 'operation not permitted|permission denied|unshare.*failed'; then
        skip "netns detection sem user namespace no host: $(printf '%s' "$host_probe" | tail -1)"
    else
        fail "netns detection falhou: $(printf '%s' "$host_probe" | tail -8 | tr '\n' ' ')"
    fi
else
    skip "prova netns nao disponivel neste host"
fi

printf '\n== Resultado: %d ok, %d falhas, %d skips ==\n' "$PASS" "$FAIL" "$SKIP" >&2
printf 'Relatorio sanitizado: %s\n' "$REPORT_FILE" >&2
report "MATRIX result pass=$PASS fail=$FAIL skip=$SKIP"
[[ "$FAIL" -eq 0 ]]
