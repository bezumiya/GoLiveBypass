#!/usr/bin/env node

import assert from "node:assert/strict";
import {
    STREAM_NATIVE_GRACE_MS,
    evaluateStreamClaim,
    initialStreamClaimState,
    normalizeStreamClaim
} from "../goLiveBypass/stability.ts";

let passed = 0;
function test(name, fn) {
    fn();
    passed++;
    process.stdout.write(`ok ${passed} - ${name}\n`);
}

test("UI sem Live permanece idle", () => {
    const result = evaluateStreamClaim(
        { now: 1_000, senderClaimed: false, nativeStreamCount: 0 },
        { claimSince: 10, warned: true }
    );
    assert.equal(result.status, "idle");
    assert.deepEqual(result.state, initialStreamClaimState());
});

test("valor false da store tambem significa Live inativa", () => {
    assert.equal(normalizeStreamClaim(false), false);
    assert.equal(normalizeStreamClaim(null), false);
    assert.equal(normalizeStreamClaim(undefined), null);
    assert.equal(normalizeStreamClaim({ id: "stream" }), true);
});

test("store ausente falha fechado", () => {
    const state = initialStreamClaimState();
    const result = evaluateStreamClaim(
        { now: 40_000, senderClaimed: true, nativeStreamCount: null }, state
    );
    assert.equal(result.status, "unknown");
    assert.equal(result.warn, false);
});

test("observacao desconhecida reinicia a janela temporal", () => {
    const warming = evaluateStreamClaim(
        { now: 1_000, senderClaimed: true, nativeStreamCount: 0 }, initialStreamClaimState()
    );
    const unknown = evaluateStreamClaim(
        { now: 60_000, senderClaimed: true, nativeStreamCount: null }, warming.state
    );
    assert.equal(unknown.status, "unknown");
    assert.equal(unknown.warn, false);
    assert.deepEqual(unknown.state, initialStreamClaimState());

    const restarted = evaluateStreamClaim(
        { now: 60_000 + STREAM_NATIVE_GRACE_MS - 1, senderClaimed: true, nativeStreamCount: 0 }, unknown.state
    );
    assert.equal(restarted.status, "warming");
    assert.equal(restarted.warn, false);
});

test("conexao nativa durante aquecimento prova saude", () => {
    let result = evaluateStreamClaim(
        { now: 1_000, senderClaimed: true, nativeStreamCount: 0 }, initialStreamClaimState()
    );
    result = evaluateStreamClaim(
        { now: 20_000, senderClaimed: true, nativeStreamCount: 1 }, result.state
    );
    assert.equal(result.status, "healthy");
    assert.deepEqual(result.state, initialStreamClaimState());
});

test("nao acusa erro 2001 antes de 30 segundos", () => {
    const first = evaluateStreamClaim(
        { now: 1_000, senderClaimed: true, nativeStreamCount: 0 }, initialStreamClaimState()
    );
    const result = evaluateStreamClaim(
        { now: 1_000 + STREAM_NATIVE_GRACE_MS - 1, senderClaimed: true, nativeStreamCount: 0 }, first.state
    );
    assert.equal(result.status, "warming");
    assert.equal(result.warn, false);
});

test("UI verde sem conexao nativa madura acusa uma vez", () => {
    const first = evaluateStreamClaim(
        { now: 1_000, senderClaimed: true, nativeStreamCount: 0 }, initialStreamClaimState()
    );
    const failed = evaluateStreamClaim(
        { now: 1_000 + STREAM_NATIVE_GRACE_MS, senderClaimed: true, nativeStreamCount: 0 }, first.state
    );
    assert.equal(failed.status, "failed");
    assert.equal(failed.warn, true);

    const repeated = evaluateStreamClaim(
        { now: 60_000, senderClaimed: true, nativeStreamCount: 0 }, failed.state
    );
    assert.equal(repeated.status, "failed-known");
    assert.equal(repeated.warn, false);
});

test("cura tardia limpa o bloqueio", () => {
    const result = evaluateStreamClaim(
        { now: 60_000, senderClaimed: true, nativeStreamCount: 2 },
        { claimSince: 1_000, warned: true }
    );
    assert.equal(result.status, "healthy");
    assert.deepEqual(result.state, initialStreamClaimState());
});

test("fuzz de 50000 amostras nunca avisa com dado desconhecido ou stream nativa", () => {
    let seed = 0x169b13;
    const random = () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 0x1_0000_0000;
    };

    let state = initialStreamClaimState();
    for (let i = 0; i < 50_000; i++) {
        const claimedOptions = [false, true, null];
        const countOptions = [0, 1, 2, null];
        const senderClaimed = claimedOptions[Math.floor(random() * claimedOptions.length)];
        const nativeStreamCount = countOptions[Math.floor(random() * countOptions.length)];
        const result = evaluateStreamClaim({
            now: 1_000 + i * 1_001,
            senderClaimed,
            nativeStreamCount
        }, state);

        if (senderClaimed !== true || nativeStreamCount === null || nativeStreamCount > 0)
            assert.equal(result.warn, false);
        state = result.state;
    }
});

process.stdout.write(`1..${passed}\n`);
