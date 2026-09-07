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

export interface StreamObservation {
    now: number;
    senderClaimed: boolean | null;
    visibleStreamCount: number | null;
    nativeStreamCount: number | null;
    voiceState: string | null;
    voiceHostname: string | null;
    selectedRegion: string | null;
}

export type StreamObservationStatus = "unknown" | "claimed-without-native" | "native-connected" | "idle";

export interface StreamObservationDecision {
    status: StreamObservationStatus;
    key: string;
}

/**
 * Classifica apenas sinais já coletados pelo renderer. A chave não inclui o
 * timestamp, pois o watcher deve registrar mudanças de estado, não cada tick.
 */
export function evaluateStreamObservation(sample: StreamObservation): StreamObservationDecision {
    const key = [
        sample.senderClaimed,
        sample.visibleStreamCount,
        sample.nativeStreamCount,
        sample.voiceState,
        sample.voiceHostname,
        sample.selectedRegion,
    ].map(value => String(value ?? "null")).join("|");

    if (sample.senderClaimed === false) return { status: "idle", key };
    if (sample.senderClaimed === null || sample.nativeStreamCount === null) return { status: "unknown", key };
    if (sample.nativeStreamCount > 0) return { status: "native-connected", key };
    return { status: "claimed-without-native", key };
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
