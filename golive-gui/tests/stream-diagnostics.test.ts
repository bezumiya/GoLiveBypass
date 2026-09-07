import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { evaluateStreamObservation, type StreamObservation } from "../../goLiveBypass/stability";

const sample = (patch: Partial<StreamObservation> = {}): StreamObservation => ({
    now: 1_000,
    senderClaimed: true,
    visibleStreamCount: 1,
    nativeStreamCount: 0,
    voiceState: "connected",
    voiceHostname: "us-east123.discord.media",
    selectedRegion: "us-east",
    ...patch,
});

describe("observação da transmissão", () => {
    it("classifica UI afirmando stream sem conexão nativa", () => {
        expect(evaluateStreamObservation(sample()).status).toBe("claimed-without-native");
    });

    it("classifica conexão nativa como saudável", () => {
        expect(evaluateStreamObservation(sample({ nativeStreamCount: 1 })).status).toBe("native-connected");
    });

    it("prioriza conexão nativa de uma transmissão remota", () => {
        expect(evaluateStreamObservation(sample({ senderClaimed: false, nativeStreamCount: 1 })).status).toBe("native-connected");
    });

    it("não transforma store desconhecida em falha", () => {
        expect(evaluateStreamObservation(sample({ senderClaimed: null, nativeStreamCount: null })).status).toBe("unknown");
    });

    it("produz chave sem segredo", () => {
        const result = evaluateStreamObservation(sample());
        expect(result.key).not.toContain("token");
        expect(result.key).toContain("us-east123.discord.media");
    });

    it("não serializa objetos completos de stream no relatório", () => {
        const source = fs.readFileSync(path.resolve(process.cwd(), "../goLiveBypass/index.tsx"), "utf8");
        expect(source).not.toContain('JSON.stringify(ask(ApplicationStreamingStore, "getAllActiveStreams"))');
        expect(source).toContain("stream.observation");
    });
});
