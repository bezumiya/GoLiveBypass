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
            /function assertPluginServiceSlot\(configPath: string\): void \{[\s\S]*?if \(!serviceRunning\(name\)\) return;/,
        );
        expect(windowsSource).toContain(
            "O serviço WireSock já está registrado com outro perfil",
        );
    });

    it("uses CIM when the Service Control Manager query is transiently unavailable", () => {
        expect(windowsSource).toContain("function serviceRunningFromCim(name: string): boolean | null");
        expect(windowsSource).toMatch(
            /function serviceRunning\(name: string\): boolean \{[\s\S]*?const cimState = serviceRunningFromCim\(name\);[\s\S]*?if \(cimState !== null\) return cimState;[\s\S]*?return \/STATE\\s\*:\\s\*\\d\+\\s\+RUNNING\/i\.test\(output\);/,
        );
    });

    it("keeps the active external service guard before service retargeting", () => {
        const inspection = windowsSource.indexOf("const current = inspectWireSock(configPath);");
        const activeGuard = windowsSource.indexOf(
            'if (current.active && !current.owned) throw new Error(current.reason || "WireSock externo já está ativo.");',
            inspection,
        );
        const slotGuard = windowsSource.indexOf("assertPluginServiceSlot(configPath);", inspection);

        expect(inspection).toBeGreaterThanOrEqual(0);
        expect(activeGuard).toBeGreaterThan(inspection);
        expect(slotGuard).toBeGreaterThan(activeGuard);
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
            /if \(!inspection\.active\) \{[\s\S]*?for \(let attempt = 0; attempt < 5 && !confirmation\.active; attempt\+\+\) \{[\s\S]*?setTimeout\(resolve, 1_000\)[\s\S]*?confirmation = windows\.inspectWireSock\(this\.serviceConfigPath\);[\s\S]*?if \(!confirmation\.active\)/,
        );
        expect(controllerSource).toContain("watchdog não confirmou o WireSock próprio");
        expect(controllerSource).toMatch(
            /if \(this\.state === "active" && inspection\.active && !inspection\.owned\)/,
        );
        expect(controllerSource).not.toMatch(
            /if \(!confirmation\.active\) \{[\s\S]*?this\.state = "recovery_required"[\s\S]*?this\.stopWatchdog\(\);/,
        );
    });
});
