/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * Regras puras de estabilidade do plugin. Este arquivo nao toca em stores nem
 * na rede: native.ts/index.tsx coletam somente os sinais que realmente
 * conhecem e estas funcoes decidem de forma fail-closed. Mantê-las puras
 * permite submeter o plugin ao mesmo tipo de matriz deterministica da GUI.
 */

export const STREAM_NATIVE_GRACE_MS = 30_000;

export interface StreamClaimState {
    claimSince: number;
    warned: boolean;
}

export interface StreamClaimSample {
    now: number;
    senderClaimed: boolean | null;
    nativeStreamCount: number | null;
}

export interface StreamClaimDecision {
    state: StreamClaimState;
    status: "idle" | "unknown" | "warming" | "healthy" | "failed" | "failed-known";
    warn: boolean;
}

export function initialStreamClaimState(): StreamClaimState {
    return { claimSince: 0, warned: false };
}

// O estado visual do Discord nao prova que a Live nasceu. So classificamos o
// erro 2001 quando a UI afirma que o usuario transmite, a store nativa de
// stream e conhecida e continua vazia por 30s. Store/metodo desconhecido nunca
// vira acao. Uma conexao nativa real limpa imediatamente o falso positivo.
export function evaluateStreamClaim(
    sample: StreamClaimSample,
    previous: StreamClaimState,
    graceMs = STREAM_NATIVE_GRACE_MS
): StreamClaimDecision {
    if (sample.senderClaimed === false) {
        return { state: initialStreamClaimState(), status: "idle", warn: false };
    }

    if (sample.senderClaimed === null || sample.nativeStreamCount === null) {
        return { state: previous, status: "unknown", warn: false };
    }

    if (sample.nativeStreamCount > 0) {
        return { state: initialStreamClaimState(), status: "healthy", warn: false };
    }

    const claimSince = previous.claimSince > 0 ? previous.claimSince : sample.now;
    if (sample.now - claimSince < graceMs) {
        return {
            state: { claimSince, warned: previous.warned },
            status: "warming",
            warn: false
        };
    }

    if (previous.warned) {
        return {
            state: { claimSince, warned: true },
            status: "failed-known",
            warn: false
        };
    }

    return {
        state: { claimSince, warned: true },
        status: "failed",
        warn: true
    };
}
