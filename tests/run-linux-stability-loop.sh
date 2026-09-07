#!/usr/bin/env bash
# Loop contínuo de estabilidade Linux. A matriz interna é descartável; este
# controlador mantém somente relatórios sanitizados fora do repositório e não
# altera a rede do host.
#
# Parada normal: crie STABILITY_LOOP_STOP_FILE ou peça ao operador para encerrar
# a sessão. O padrão fica em /tmp e é removido no fim quando possível.
#
# Uso:
#   ./tests/run-linux-stability-loop.sh
#   STABILITY_LOOP_INTERVAL=20 STABILITY_LOOP_FULL_EVERY=3 ./tests/run-linux-stability-loop.sh

set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "$0")/.." && pwd)"
INTERVAL="${STABILITY_LOOP_INTERVAL:-30}"
FULL_EVERY="${STABILITY_LOOP_FULL_EVERY:-3}"
APPIMAGE_EVERY="${STABILITY_LOOP_APPIMAGE_EVERY:-4}"
STOP_FILE="${STABILITY_LOOP_STOP_FILE:-/tmp/golive-linux-stability.stop}"
REPORT_DIR="${STABILITY_LOOP_REPORT_DIR:-/tmp/golive-linux-stability-loop}"
RUNTIME="${RUNTIME:-podman}"
ARCH_SNAPSHOT="${MATRIX_BUILD_ARCH_SNAPSHOT:-0}"
KEEP_STOP_FILE="${STABILITY_LOOP_KEEP_STOP_FILE:-0}"
ONCE=0
CYCLE=0
LAST_SIGNATURE=""
LAST_SOURCE=""
LAST_APPIMAGE_SIGNATURE=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --once) ONCE=1 ;;
        -h|--help)
            sed -n '1,14p' "$0" >&2
            exit 0
            ;;
        *)
            printf 'Opcao desconhecida: %s\n' "$1" >&2
            exit 2
            ;;
    esac
    shift
done

[[ "$INTERVAL" =~ ^[0-9]+$ && "$FULL_EVERY" =~ ^[1-9][0-9]*$ && "$APPIMAGE_EVERY" =~ ^[1-9][0-9]*$ ]] || {
    printf 'Intervalos invalidos: use inteiros positivos.\n' >&2
    exit 2
}
command -v "$RUNTIME" >/dev/null 2>&1 || {
    printf 'Runtime nao encontrado: %s\n' "$RUNTIME" >&2
    exit 2
}
mkdir -p "$REPORT_DIR"
if [[ "$KEEP_STOP_FILE" != "1" ]]; then
    rm -f "$STOP_FILE" 2>/dev/null || true
fi

cleanup() {
    if [[ "$KEEP_STOP_FILE" != "1" ]]; then
        rm -f "$STOP_FILE" 2>/dev/null || true
    fi
}
trap cleanup EXIT INT TERM

source_digest() {
    sha256sum \
        "$ROOT/standalone/golivebypass-standalone.sh" \
        "$ROOT/golive-gui/electron/linux-preflight.ts" \
        "$ROOT/tests/test-linux-matrix.sh" \
        "$ROOT/tests/test-linux-vm.sh" 2>/dev/null | sha256sum | cut -d' ' -f1
}

wait_interval() {
    local remaining="$INTERVAL"
    while (( remaining > 0 )); do
        [[ -e "$STOP_FILE" ]] && return 1
        sleep 1
        remaining=$((remaining - 1))
    done
}

while [[ ! -e "$STOP_FILE" ]]; do
    CYCLE=$((CYCLE + 1))
    timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
    cycle_dir="$REPORT_DIR/cycle-$CYCLE-$timestamp"
    mkdir -p "$cycle_dir"
    output="$cycle_dir/matrix.log"
    mode="--quick"
    cases=""
    if (( CYCLE % FULL_EVERY == 0 )); then
        mode="--full"
        cases="debian-12,fedora-42,arch-current"
    fi

    appimage=""
    if (( CYCLE % APPIMAGE_EVERY == 0 )); then
        appimage="$(find "$ROOT/golive-gui/dist-app" -maxdepth 1 -type f -name '*.AppImage' -print 2>/dev/null | sort -V | tail -1 || true)"
    fi

    printf '\n== Stability cycle %d (%s, %s) ==\n' "$CYCLE" "$mode" "$timestamp" >&2
    command=("$ROOT/tests/test-linux-matrix.sh" "$mode")
    if [[ -n "$cases" ]]; then
        export MATRIX_CASES="$cases"
    else
        unset MATRIX_CASES || true
    fi
    export MATRIX_BUILD_ARCH_SNAPSHOT="$ARCH_SNAPSHOT"
    export MATRIX_REPORT_DIR="$cycle_dir"
    if [[ -n "$appimage" ]]; then
        export APPIMAGE_PATH="$appimage"
        printf 'AppImage auditado: %s\n' "$(basename "$appimage")" >&2
    else
        unset APPIMAGE_PATH || true
    fi

    rc=0
    "${command[@]}" >"$output" 2>&1 || rc=$?
    source="$(source_digest)"
    # Compare somente falhas concretas e evidências de bibliotecas ausentes.
    # O modo --full possui uma agenda de skips diferente do --quick; incluir
    # skips ou os totais do rodapé faria cada troca de modo parecer regressão.
    failure_signature="$( { grep -E '^[[:space:]]+\[FAIL\]' "$output" || true; } | sed -E 's/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.+-]+Z//g; s#'$cycle_dir'/##g' | sha256sum | cut -d' ' -f1)"
    appimage_evidence="$( { grep -Eo 'APPIMAGE_LDD_MISSING=[0-9]+' "$output" || true; } | sort -u | paste -sd, -)"
    if [[ -n "$appimage_evidence" ]]; then
        LAST_APPIMAGE_SIGNATURE="$appimage_evidence"
    fi
    signature="${failure_signature}|appimage:${LAST_APPIMAGE_SIGNATURE:-none}"

    state="baseline"
    if [[ -n "$LAST_SOURCE" && "$source" != "$LAST_SOURCE" ]]; then
        state="source-changed"
    elif [[ -n "$LAST_SIGNATURE" && "$signature" != "$LAST_SIGNATURE" ]]; then
        state="result-changed"
    elif [[ -n "$LAST_SIGNATURE" ]]; then
        state="stable"
    fi
    printf '{"cycle":%d,"timestamp":"%s","mode":"%s","rc":%d,"state":"%s","source":"%s","signature":"%s","report":"%s"}\n' \
        "$CYCLE" "$timestamp" "${mode#--}" "$rc" "$state" "$source" "$signature" "$cycle_dir" \
        >>"$REPORT_DIR/cycles.jsonl"
    printf 'CYCLE=%d MODE=%s RC=%d STATE=%s SIGNATURE=%s\n' "$CYCLE" "${mode#--}" "$rc" "$state" "$signature" >&2
    tail -18 "$output" >&2 || true

    LAST_SIGNATURE="$signature"
    LAST_SOURCE="$source"
    unset MATRIX_REPORT_DIR || true
    if (( ONCE == 1 )); then
        break
    fi
    [[ -e "$STOP_FILE" ]] && break
    wait_interval || break
done

printf 'Loop Linux encerrado apos %d ciclo(s). Relatorios: %s\n' "$CYCLE" "$REPORT_DIR" >&2
