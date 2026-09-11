import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ execFile: vi.fn(), execFileSync: vi.fn() }));

import { inspectWireSock } from "../../goLiveBypass/vpn-windows";

const windowsSource = fs.readFileSync(
    path.resolve(__dirname, "../../goLiveBypass/vpn-windows.ts"),
    "utf8",
);
const controllerSource = fs.readFileSync(
    path.resolve(__dirname, "../../goLiveBypass/vpn-controller.ts"),
    "utf8",
);

const PLUGIN_CONFIG = String.raw`C:\Users\teste\AppData\Local\GoLiveBypass\plugin-vpn\wiresock-discord.conf`;
const SERVICE_COMMAND = `"C:\\Program Files\\WireSock Secure Connect\\wiresock-client.exe" -config "${PLUGIN_CONFIG}" -allowed-apps "discord.exe"`;

// A leitura inteira do WireSock vem de uma única resposta do PowerShell; os testes de
// comportamento alimentam essa resposta e observam o veredito público. O CIM devolve o
// serviço ausente como uma linha própria ("Missing"), como faz o script de inspeção.
function snapshot(processes: Array<{ pid: number; commandLine: string | null }>, clientProcessId: number | null = null): string {
    return JSON.stringify({
        services: [
            { name: "wiresock-client-service", state: clientProcessId === null ? "Missing" : "Running", command: clientProcessId === null ? null : SERVICE_COMMAND, processId: clientProcessId ?? 0 },
            { name: "wiresock-pro-client-service", state: "Missing", command: null, processId: 0 },
        ],
        processes,
    });
}

describe("atribuição do WireSock pelo PID do serviço próprio", () => {
    const originalPlatform = process.platform;
    const windows = (value: string) => vi.mocked(execFileSync).mockReturnValue(value as never);

    beforeEach(() => {
        Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    });

    afterEach(() => {
        Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
        vi.mocked(execFileSync).mockReset();
    });

    it("reconhece como próprio o processo sem linha de comando cujo PID é do serviço do plugin", () => {
        windows(snapshot([{ pid: 4242, commandLine: null }], 4242));
        expect(inspectWireSock(PLUGIN_CONFIG)).toMatchObject({
            active: true,
            owned: true,
            reliable: true,
            services: ["wiresock-client-service"],
            processIds: [4242],
        });
    });

    it("não adivinha a origem de um processo sem linha de comando que não pertence ao serviço do plugin", () => {
        windows(snapshot([{ pid: 4242, commandLine: null }, { pid: 9999, commandLine: null }], 4242));
        expect(inspectWireSock(PLUGIN_CONFIG)).toMatchObject({
            active: false,
            owned: false,
            reliable: false,
            processIds: [4242, 9999],
        });
    });

    it("sem a leitura do CIM, reporta os serviços do sc.exe sem afirmar que o túnel caiu", () => {
        vi.mocked(execFileSync).mockImplementation(((file: string, args?: readonly string[]) => {
            if (file === "powershell.exe") throw new Error("CIM indisponível");
            return args?.[1] === "wiresock-client-service" ? "STATE : 4 RUNNING" : "STATE : 1 STOPPED";
        }) as never);
        expect(inspectWireSock(PLUGIN_CONFIG)).toMatchObject({
            active: false,
            owned: false,
            reliable: false,
            services: ["wiresock-client-service"],
            processIds: [],
            reason: "Não foi possível confirmar o estado do WireSock; estado desconhecido.",
        });
    });
});

describe("plugin v2 WireSock ownership regression", () => {
    it("does not treat a stopped legacy service registration as an active external tunnel", () => {
        expect(windowsSource).toMatch(
            /function assertPluginServiceSlot\(configPath: string\): void \{[\s\S]*?const running = serviceRunning\(name\);[\s\S]*?if \(running === null\) throw[\s\S]*?if \(!running\) return;/,
        );
        expect(windowsSource).toContain(
            "O serviço WireSock já está registrado com outro perfil",
        );
    });

    it("keeps the active external service guard before service retargeting", () => {
        const inspection = windowsSource.indexOf("const current = inspectWireSock(configPath);");
        const activeGuard = windowsSource.indexOf(
            'if (!current.reliable) throw new Error(current.reason || UNKNOWN_WIRESOCK_STATE);',
            inspection,
        );
        const externalGuard = windowsSource.indexOf(
            'if (current.active && !current.owned) throw new Error(current.reason || "WireSock externo já está ativo.");',
            inspection,
        );
        const slotGuard = windowsSource.indexOf("assertPluginServiceSlot(configPath);", inspection);

        expect(inspection).toBeGreaterThanOrEqual(0);
        expect(activeGuard).toBeGreaterThan(inspection);
        expect(externalGuard).toBeGreaterThan(activeGuard);
        expect(slotGuard).toBeGreaterThan(externalGuard);
    });

    it("confirma uma leitura inativa sem transformar o watchdog em bloqueio", () => {
        expect(controllerSource).toMatch(
            /if \(!inspection\.reliable\) \{[\s\S]*?if \(!inspection\.active\) \{[\s\S]*?for \(let attempt = 0; attempt < 5 && confirmation\.reliable && !confirmation\.active; attempt\+\+\) \{[\s\S]*?setTimeout\(resolve, 1_000\)[\s\S]*?confirmation = windows\.inspectWireSock\(this\.serviceConfigPath\);[\s\S]*?if \(!confirmation\.reliable\)[\s\S]*?if \(!confirmation\.active\)/,
        );
        expect(controllerSource).toContain("watchdog não confirmou o WireSock próprio");
        expect(controllerSource).toMatch(
            /if \(inspection\.reliable && inspection\.active && !inspection\.owned\) \{[\s\S]*?this\.blockExternal\(reason\)/,
        );
        expect(controllerSource).toMatch(
            /if \(!confirmation\.active\) \{[\s\S]*?this\.state = "inactive";[\s\S]*?this\.discordPid = null;[\s\S]*?this\.stopWatchdog\(\);/,
        );
        expect(controllerSource).not.toMatch(
            /if \(!confirmation\.active\) \{[\s\S]*?this\.state = "recovery_required"[\s\S]*?this\.stopWatchdog\(\);/,
        );
    });

    it("mantém inspeção não confiável fora do bloqueio externo", () => {
        expect(windowsSource).toMatch(
            /if \(!reliable\) \{[\s\S]*?active: false,[\s\S]*?owned: false,[\s\S]*?reliable: false,[\s\S]*?estado desconhecido/,
        );
        expect(controllerSource).toContain("if (isUnknownWireSockInspection(inspection))");
        expect(controllerSource).toContain('this.state = "recovery_required";');
    });
});
