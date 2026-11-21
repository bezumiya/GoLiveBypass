import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const helperState = vi.hoisted(() => ({
    stdout: "",
    stderr: "",
    code: 0,
}));

vi.mock("child_process", () => ({
    execFileSync: vi.fn(),
    spawn: vi.fn(() => {
        const child = Object.assign(new EventEmitter(), {
            stdout: new EventEmitter(),
            stderr: new EventEmitter(),
            stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
            kill: vi.fn(),
        });
        queueMicrotask(() => {
            if (helperState.stdout) child.stdout.emit("data", Buffer.from(helperState.stdout));
            if (helperState.stderr) child.stderr.emit("data", Buffer.from(helperState.stderr));
            child.emit("close", helperState.code);
        });
        return child;
    }),
}));

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

import { criarResumoDeProgresso, runConfgen } from "../../goLiveBypass/vpn-proton";
import { createPluginLogger } from "../../goLiveBypass/plugin-log";

const temporaryRoots: string[] = [];

describe("logs do helper Proton", () => {
    it("registra fases, duração e bytes sem registrar stdin/stdout/stderr", async () => {
        // realpath: o helper recusa caminho com link simbólico, e no macOS /var é link para /private/var.
        const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "golive-helper-log-"));
        temporaryRoots.push(root);
        const executable = path.join(root, "proton-confgen");
        fs.writeFileSync(executable, "helper");
        fs.chmodSync(executable, 0o700);
        helperState.stdout = '{"success":true}\n';
        helperState.stderr = 'GOLIVE_PROGRESS {"phase":"testing","total":1,"tested":1,"succeeded":1}\nsecret-output\n';
        helperState.code = 0;
        const logs: Array<{ level: string; event: string; data?: Record<string, unknown> }> = [];

        const result = await runConfgen({
            exePath: executable,
            args: ["-stdin-secrets"],
            stdin: JSON.stringify({ password: "fake-password", token: "fake-token" }),
            log: (level, event, data) => logs.push({ level, event, data }),
        });

        expect(result.code).toBe(0);
        expect(logs.map(item => item.event)).toEqual(["helper.started", "helper.phase", "helper.completed"]);
        expect(logs.at(-1)?.data).toMatchObject({ stdout_bytes: expect.any(Number), stderr_bytes: expect.any(Number), exit_code: 0 });
        expect(JSON.stringify(logs)).not.toContain("fake-password");
        expect(JSON.stringify(logs)).not.toContain("fake-token");
        expect(JSON.stringify(logs)).not.toContain("secret-output");
    });

    it("uma busca com catalogo grande vira so as trocas de fase e um resumo no fim", async () => {
        const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "golive-helper-log-"));
        temporaryRoots.push(root);
        const executable = path.join(root, "proton-confgen");
        fs.writeFileSync(executable, "helper");
        fs.chmodSync(executable, 0o700);
        const progresso: string[] = [];
        for (let i = 0; i < 119; i++) progresso.push(`GOLIVE_PROGRESS {"phase":"catalog","total":119,"tested":0,"succeeded":0,"server":"NL-FREE#${i}"}`);
        for (let i = 0; i < 12; i++) {
            const succeeded = i === 7 ? 1 : i > 7 ? 1 : 0;
            progresso.push(`GOLIVE_PROGRESS {"phase":"testing","total":12,"tested":${i + 1},"succeeded":${succeeded},"server":"US-FREE#${i}"}`);
        }
        progresso.push('GOLIVE_PROGRESS {"phase":"completed","total":12,"tested":12,"succeeded":1}');
        helperState.stdout = '{"success":true,"server":"US-FREE#7","pingMs":38,"downloadMbps":44.2,"uploadMbps":12.1,"endpoint":"203.0.113.9:51820"}\n';
        helperState.stderr = `${progresso.join("\n")}\n`;
        helperState.code = 0;
        const logs: Array<{ level: string; event: string; data?: Record<string, unknown> }> = [];
        const telas: string[] = [];

        await runConfgen({
            exePath: executable,
            args: ["--optimize"],
            log: (level, event, data) => logs.push({ level, event, data }),
            onProgress: progress => telas.push(progress.phase),
        });

        // A tela recebe tudo; o log, so o essencial.
        expect(telas).toHaveLength(132);
        expect(logs.map(item => item.event)).toEqual(["helper.started", "helper.phase", "helper.phase", "helper.phase", "helper.completed"]);
        expect(logs.filter(item => item.event === "helper.phase").map(item => item.data?.phase)).toEqual(["catalog", "testing", "completed"]);
        const fim = logs.at(-1)?.data ?? {};
        expect(fim).toMatchObject({ progresso_fase: "completed", progresso_eventos: 132, total: 12, tested: 12, succeeded: 1 });
        expect(String(fim.servidores)).toContain("US-FREE#7:ok");
        expect(String(fim.servidores)).toContain("US-FREE#6:testando");
        expect(String(fim.servidores)).not.toContain("NL-FREE");
        // A escolha do helper fica no fim (antes so existia nas amostras de progresso); o endpoint nao.
        expect(fim).toMatchObject({ server: "US-FREE#7", ping_ms: 38, download_mbps: 44.2, upload_mbps: 12.1 });
        expect(JSON.stringify(logs)).not.toContain("203.0.113.9");
    });

    it("o resumo da busca passa pelo filtro do log do plugin sem perder campos", () => {
        const logger = createPluginLogger({ component: "plugin.native" });
        const resumo = criarResumoDeProgresso();
        resumo.registrar({ phase: "testing", total: 2, tested: 1, succeeded: 0, server: "MX-FREE#8", status: "failed" });
        resumo.registrar({ phase: "testing", total: 2, tested: 2, succeeded: 1, server: "CA-FREE#19", status: "success" });
        const record = logger.info("helper.completed", {}, { exit_code: 0, ...resumo.resumo() });
        expect(record?.data?.dropped_keys).toBeUndefined();
        expect(record?.data).toMatchObject({ progresso_fase: "testing", tested: 2, succeeded: 1, servidores: "MX-FREE#8:falhou,CA-FREE#19:ok" });
    });
});
