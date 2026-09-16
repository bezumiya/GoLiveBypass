import { describe, expect, it } from "vitest";

import { createPluginLogger, redactPluginData, trimJsonlTailByBytes } from "../../goLiveBypass/plugin-log";

function clock() {
    let current = new Date("2026-09-14T12:00:00.000Z");
    return {
        now: () => new Date(current),
        advance(ms: number) { current = new Date(current.getTime() + ms); },
    };
}

describe("núcleo de logs do plugin", () => {
    it("emite JSONL estruturado e redige dados aninhados e URLs credenciadas", () => {
        const lines: string[] = [];
        const logger = createPluginLogger({
            component: "plugin.native",
            pluginVersion: "2.0.6-beta-20",
            platform: "linux",
            arch: "x64",
            now: clock().now,
            onLine: line => lines.push(line),
        });

        logger.error("proton.login.failed", {
            operation_id: "login-1",
            attempt_id: "attempt-1",
            phase: "failed",
        }, {
            code: "INVALID_CREDENTIALS",
            password: "senha-falsa",
            nested: {
                token: "token-falso",
                endpoint: "10.0.0.1:51820",
                config: "PrivateKey = chave-falsa",
            },
            error: "request https://alice:secret@example.test/x conta@example.com Bearer bearer-falso em /home/alice/cache",
        });

        expect(lines).toHaveLength(1);
        const event = JSON.parse(lines[0]);
        expect(event).toMatchObject({
            schema_version: 1,
            level: "error",
            component: "plugin.native",
            event: "proton.login.failed",
            operation_id: "login-1",
            attempt_id: "attempt-1",
            phase: "failed",
            plugin_version: "2.0.6-beta-20",
            platform: "linux",
            arch: "x64",
        });
        const serialized = lines[0];
        for (const secret of ["senha-falsa", "token-falso", "10.0.0.1:51820", "chave-falsa", "alice:secret", "example.test/x", "conta@example.com", "bearer-falso", "/home/alice"]) {
            expect(serialized).not.toContain(secret);
        }
        expect(event.data.password).toBe("<redacted>");
        expect(event.data.nested.endpoint).toBe("<redacted>");
    });


    it("persiste o agregado e restaura contagem e intervalo temporal", () => {
        const time = clock();
        const lines: string[] = [];
        const logger = createPluginLogger({
            component: "plugin.controller",
            pluginVersion: "test",
            platform: "win32",
            arch: "x64",
            now: time.now,
            onLine: line => lines.push(line),
        });
        for (let i = 0; i < 5; i++) {
            logger.warn("wiresock.watchdog", { operation_id: "vpn-1" }, { state: "active" });
            time.advance(100);
        }
        expect(lines).toHaveLength(5);
        const persisted = JSON.parse(lines.at(-1)!);
        expect(persisted).toMatchObject({
            count: 5,
            first_ts: "2026-09-14T12:00:00.000Z",
            last_ts: "2026-09-14T12:00:00.400Z",
        });
        const restored = createPluginLogger({ component: "plugin.controller", pluginVersion: "test", platform: "win32", arch: "x64" });
        restored.restore(lines);
        expect(restored.records()).toHaveLength(1);
        expect(restored.records()[0]).toMatchObject({ count: 5, first_ts: persisted.first_ts, last_ts: persisted.last_ts });
        expect(restored.getLog()).toContain("count=5");
    });

    it("descarta chaves desconhecidas e nunca lança quando a escrita falha", () => {
        expect(redactPluginData({ unknown: "not-written", state: "active" })).toEqual({ state: "active" });
        const logger = createPluginLogger({
            component: "plugin.native",
            pluginVersion: "test",
            platform: "linux",
            arch: "x64",
            onLine: () => { throw new Error("disk full"); },
        });
        expect(() => logger.warn("logger.write.failed", undefined, { error: "disk full" })).not.toThrow();
        expect(logger.getLog()).toContain("logger.write.failed");
    });

    it("colapsa watchdog/progresso repetidos e respeita o limite do ring", () => {
        const time = clock();
        const logger = createPluginLogger({
            component: "plugin.controller",
            pluginVersion: "test",
            platform: "win32",
            arch: "x64",
            now: time.now,
            maxEvents: 3,
        });
        for (let i = 0; i < 5; i++) {
            logger.warn("wiresock.watchdog", { operation_id: "vpn-1" }, { state: "active" });
            time.advance(100);
        }
        expect(logger.records()).toHaveLength(1);
        expect(logger.records()[0].count).toBe(5);
        time.advance(60_001);
        logger.info("vpn.activation.completed", { operation_id: "vpn-1", phase: "completed" }, { state: "active" });
        logger.info("route.discovery.completed", { operation_id: "route-1", phase: "completed" }, { total: 1 });
        logger.error("error.operation_failed", { operation_id: "err-1", phase: "failed" }, { error_code: "HELPER_ERROR" });
        logger.info("plugin.process.ready", undefined, { state: "active" });
        expect(logger.records()).toHaveLength(3);
        expect(logger.getLog()).toContain("error.operation_failed");
    });

    it("recorta por bytes UTF-8 e descarta linha parcial", () => {
        const input = new TextEncoder().encode(`{"text":"${"á".repeat(160)}"}\n{"event":"sentinel","text":"fim"}\n`);
        const tail = trimJsonlTailByBytes(input, 128);
        expect(tail.byteLength).toBeLessThanOrEqual(128);
        const text = new TextDecoder().decode(tail);
        expect(text).not.toContain("\uFFFD");
        expect(text.split("\n").filter(Boolean).every(line => {
            try { JSON.parse(line); return true; } catch { return false; }
        })).toBe(true);
        expect(text).toContain('"event":"sentinel"');
    });

    it("restaura somente linhas JSONL do schema conhecido", () => {
        const logger = createPluginLogger({ component: "plugin.native", pluginVersion: "test", platform: "linux", arch: "x64" });
        logger.restore([
            "linha legada",
            JSON.stringify({ schema_version: 1, ts: "2026-09-14T12:00:00.000Z", level: "info", component: "plugin.native", event: "plugin.process.ready", data: { state: "active" } }),
            JSON.stringify({ schema_version: 99, ts: "2026-09-14T12:00:00.000Z", event: "ignored" }),
        ]);
        expect(logger.records()).toHaveLength(1);
        expect(logger.getLog()).toContain("plugin.process.ready");
    });
});
