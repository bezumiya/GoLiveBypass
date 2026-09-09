import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const windowsSource = fs.readFileSync(
    path.resolve(__dirname, "../../goLiveBypass/vpn-windows.ts"),
    "utf8",
);
const controllerSource = fs.readFileSync(
    path.resolve(__dirname, "../../goLiveBypass/vpn-controller.ts"),
    "utf8",
);

describe("plugin v2 WireSock ownership regression", () => {
    it("does not treat a stopped legacy service registration as an active external tunnel", () => {
        expect(windowsSource).toMatch(
            /function assertPluginServiceSlot\(configPath: string\): void \{[\s\S]*?const running = serviceRunning\(name\);[\s\S]*?if \(running === null\) throw[\s\S]*?if \(!running\) return;/,
        );
        expect(windowsSource).toContain(
            "O serviço WireSock já está registrado com outro perfil",
        );
    });

    it("uses CIM when the Service Control Manager query is transiently unavailable", () => {
        expect(windowsSource).toContain("function serviceRunningFromCim(name: string): boolean | null");
        expect(windowsSource).toMatch(
            /function serviceRunning\(name: string\): boolean \| null \{[\s\S]*?const cimState = serviceRunningFromCim\(name\);[\s\S]*?if \(cimState !== null\) return cimState;[\s\S]*?if \(\/STATE\\s\*:\\s\*\\d\+\\s\+RUNNING\/i\.test\(output\)\) return true;/,
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

    it("attributes a blank-command-line process to its owned WireSock service by PID", () => {
        expect(windowsSource).toContain("function serviceProcessId(name: string): number | null");
        expect(windowsSource).toContain("const ownServiceProcessIds = new Set");
        expect(windowsSource).toMatch(
            /containsConfig\(process\.commandLine, configPath\) \|\| ownServiceProcessIds\.has\(process\.pid\)/,
        );
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
