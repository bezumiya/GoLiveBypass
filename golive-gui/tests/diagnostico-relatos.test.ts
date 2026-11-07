import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createPluginLogger, pendingNamespaceRelaunch, redactPluginData } from "../../goLiveBypass/plugin-log";
import { montarAmbiente, montarMeta, redigir as pluginRedigir } from "../../goLiveBypass/bug-report";
import { redigir as guiRedigir } from "../electron/redact";
import {
    describeWireSockInstallerExit as pluginDescribeExit,
    extractWireSockInstallerLogErrors as pluginExtractErrors,
    installerFolderDiagnosis as pluginFolderDiagnosis,
    selectWireSockCandidate,
    WIRESOCK_FALLBACK_VERSION,
    WIRESOCK_VERSION,
} from "../../goLiveBypass/vpn-windows";
import { linuxDistroLabel as pluginDistroLabel, linuxPackagingLabel } from "../../goLiveBypass/vpn-linux";
import {
    collectWireSockInstallerLogErrors,
    describeWireSockInstallerExit,
    extractWireSockInstallerLogErrors,
    installerFolderDiagnosis,
    windowsInstallerFolderPresent,
    wireSockInstallerFailureDetail,
} from "../electron/wiresock-install-diag";
import { FALLBACK_WIRESOCK_SDK, pickWireSock, type WireSockCandidate } from "../electron/wiresock-preflight";
import { guiEnvironmentSnapshot, linuxDistroLabel, timezoneOffsetLabel } from "../electron/env-snapshot";

// Trecho real (anonimizado) do log do setup 3.8.2.1 num Windows sem %SystemRoot%\Installer.
const SETUP_LOG = [
    "[2704:2B18][2026-11-06T15:49:38]i001: Burn x64 v6.0.2, Windows v10.0 x64 (Build 19044: Service Pack 0), path: B:\\Users\\Fulano\\Downloads\\wiresock-secure-connect-sdk-x64-3.8.2.1.exe",
    "[2704:2B18][2026-11-06T15:49:40]i301: Applying execute package: WireSockSdk, action: Install, path: B:\\ProgramData\\Package Cache\\{ABC}\\wiresock-sdk.msi",
    "[2704:2B18][2026-11-06T15:49:40]e000: Error 0x80070660: Failed to install MSI package.",
    "[2704:2B18][2026-11-06T15:49:40]e000: Error 0x80070660: Failed to execute MSI package.",
    "[2704:2B18][2026-11-06T15:49:41]i399: Apply complete, result: 0x80070660",
].join("\r\n");

describe("plugin: o log não descarta mais campos em silêncio", () => {
    it("mantém as contagens do IPv6 pulado e os campos do updater que sumiam (#404)", () => {
        expect(redactPluginData({ skipped_addresses: 1, skipped_dns: 1 })).toEqual({ skipped_addresses: 1, skipped_dns: 1 });
        expect(redactPluginData({ versão: "2.0.16", canal: "beta", namespace: "glb-k3m9q2" }))
            .toEqual({ versão: "2.0.16", canal: "beta", namespace: "glb-k3m9q2" });
    });

    it("número e booleano passam com qualquer chave não sensível; texto desconhecido deixa o nome da chave", () => {
        const data = redactPluginData({ tentativas: 3, ok: true, arquivo: "/home/alice/x.lock", token: "abc" });
        expect(data).toEqual({ tentativas: 3, ok: true, token: "<redacted>", dropped_keys: ["arquivo"] });
        expect(JSON.stringify(data)).not.toContain("alice");
    });

    it("campo opcional undefined some, sem virar <omitted> nem dropped_keys", () => {
        expect(redactPluginData({ code: 1632, significado: undefined })).toEqual({ code: 1632 });
    });

    it("a linha do relato traz mês/dia em UTC, a operação e a fase", () => {
        const logger = createPluginLogger({
            component: "plugin.native", pluginVersion: "t", platform: "linux", arch: "x64",
            now: () => new Date("2026-11-04T01:37:13.670Z"),
        });
        logger.info("linux.network.phase", { operation_id: "vpn-activation-ab-1", phase: "interface" });
        expect(logger.getLog()).toBe("11-04T01:37:13.670Z [info] [plugin.native] linux.network.phase | op=vpn-activation-ab-1 phase=interface");
    });
});

describe("plugin: retrato do ambiente no relato", () => {
    it("só entram os campos da lista branca, sem barra nem texto livre", () => {
        const ambiente = montarAmbiente({
            distro: "nixos 25.05", kernel: "6.18.58-xanmod1", ipv6_kernel: false, fuso: "-03:00",
            cliente: "../../home/alice/vesktop", hostname: "pc-da-alice", usuario: "alice",
        });
        expect(ambiente).toEqual({
            distro: "nixos 25.05", kernel: "6.18.58-xanmod1", ipv6_kernel: "nao", fuso: "-03:00",
            cliente: ".._.._home_alice_vesktop",
        });
        expect(ambiente).not.toHaveProperty("hostname");
        expect(ambiente).not.toHaveProperty("usuario");
    });

    it("o meta do plugin carrega o ambiente junto dos campos de sempre", () => {
        const meta = montarMeta({
            versao: "2.0.17", plataforma: "linux-x64", electron: "44", node: "24", estadoVpn: {}, modo: "proton",
            onboarding: true, ambiente: { distro: "arch", wg_modulo: "carregado" },
        });
        expect(meta).toMatchObject({ app: "golive-plugin", distro: "arch", wg_modulo: "carregado" });
    });

    it("distro vem só de ID e VERSION_ID; empacotamento separa flatpak, nix e nativo", () => {
        expect(pluginDistroLabel('NAME="NixOS"\nID=nixos\nVERSION_ID="25.05"\nPRETTY_NAME="NixOS 25.05 (Warbler)"')).toBe("nixos 25.05");
        expect(pluginDistroLabel(null)).toBe("desconhecida");
        expect(linuxPackagingLabel({ FLATPAK_ID: "dev.vencord.Vesktop" }, "/app/bin/vesktop")).toBe("flatpak");
        expect(linuxPackagingLabel({}, "/nix/store/abc-electron/libexec/electron/electron")).toBe("nix");
        expect(linuxPackagingLabel({}, "/usr/lib/vesktop/vesktop")).toBe("nativo");
    });
});

describe("instalação do WireSock: código de saída, log do setup e versão de reserva", () => {
    it.each([
        ["plugin", pluginDescribeExit],
        ["gui", describeWireSockInstallerExit],
    ])("%s: 1632 e o HRESULT 0x80070660 dão o mesmo significado", (_nome, describe) => {
        expect(describe(1632)).toEqual({ code: 1632, meaning: expect.stringContaining("pasta Installer") });
        expect(describe(0x80070660)).toEqual(describe(1632));
        expect(describe(-2147023264)).toEqual(describe(1632));
        expect(describe(undefined)).toEqual({ code: null, meaning: "" });
        expect(describe(4242).meaning).toBe("");
    });

    it.each([
        ["plugin", pluginExtractErrors],
        ["gui", extractWireSockInstallerLogErrors],
    ])("%s: extrai as linhas de erro do setup sem prefixo e sem caminho", (_nome, extract) => {
        const lines = extract(SETUP_LOG);
        expect(lines).toEqual([
            "e000: Error 0x80070660: Failed to install MSI package.",
            "e000: Error 0x80070660: Failed to execute MSI package.",
            "i399: Apply complete, result: 0x80070660",
        ]);
        expect(lines.join(" ")).not.toContain("Fulano");
    });

    it("lê só os logs do setup gravados durante a tentativa", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "golive-setup-logs-"));
        try {
            const antigo = path.join(dir, "WireSock_Secure_Connect_SDK_20261101000000.log");
            fs.writeFileSync(antigo, "e000: Error 0x80070643: velho");
            const velho = Date.now() / 1000 - 3600;
            fs.utimesSync(antigo, velho, velho);
            fs.writeFileSync(path.join(dir, "WireSock_Secure_Connect_SDK_20261106152500.log"), SETUP_LOG);
            fs.writeFileSync(path.join(dir, "outro.log"), "Error 0x1: nao e do setup");
            const lines = collectWireSockInstallerLogErrors(Date.now() - 60_000, dir);
            expect(lines).toContain("e000: Error 0x80070660: Failed to install MSI package.");
            expect(lines.join(" ")).not.toContain("velho");
            expect(lines.join(" ")).not.toContain("nao e do setup");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("o popup diz o código e a pasta do Windows Installer ausente; o 1 do wrapper fica de fora", () => {
        expect(wireSockInstallerFailureDetail(1632, false)).toBe(
            "O instalador saiu com o código 1632 (o Windows Installer não consegue gravar na pasta temporária ou na pasta Installer do Windows). " +
            "A pasta Installer do Windows (%SystemRoot%\\Installer) não existe; sem ela nenhum pacote MSI instala.",
        );
        expect(wireSockInstallerFailureDetail(1, true)).toBe("");
        expect(wireSockInstallerFailureDetail(undefined, null)).toBe("");
    });

    it("pasta Installer: false quando falta, null quando não há SystemRoot", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "golive-systemroot-"));
        try {
            expect(windowsInstallerFolderPresent({ SystemRoot: dir })).toBe(false);
            fs.mkdirSync(path.join(dir, "Installer"));
            expect(windowsInstallerFolderPresent({ SystemRoot: dir })).toBe(true);
            expect(windowsInstallerFolderPresent({})).toBeNull();
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("plugin: a 3.4.8.1 só serve como reserva, nunca como instalação compatível", () => {
        const antiga = { executable: "a", booster: "b", executableVersion: "3.4.8.1", boosterVersion: "3.4.8.1" };
        expect(selectWireSockCandidate([antiga])).toBeNull();
        expect(selectWireSockCandidate([antiga], WIRESOCK_FALLBACK_VERSION)).toBe(antiga);
        const nova = { ...antiga, executable: "n", executableVersion: WIRESOCK_VERSION, boosterVersion: WIRESOCK_VERSION };
        expect(selectWireSockCandidate([antiga, nova], WIRESOCK_FALLBACK_VERSION)).toBe(nova);
    });

    it("gui: a 3.4.8.1 só serve como reserva; par com versões diferentes nunca serve", () => {
        const v = (major: number, minor: number, patch: number, build: number) => ({ major, minor, patch, build });
        const antiga: WireSockCandidate = { executable: "a", booster: "b", executableVersion: v(3, 4, 8, 1), boosterVersion: v(3, 4, 8, 1) };
        const misturada: WireSockCandidate = { executable: "m", booster: "m", executableVersion: v(3, 8, 2, 1), boosterVersion: v(3, 4, 8, 1) };
        expect(pickWireSock([antiga, misturada])).toBeNull();
        expect(pickWireSock([antiga, misturada], FALLBACK_WIRESOCK_SDK)).toBe(antiga);
        expect(pickWireSock([{ ...antiga, executableVersion: v(3, 3, 0, 0), boosterVersion: v(3, 3, 0, 0) }], FALLBACK_WIRESOCK_SDK)).toBeNull();
    });
});

describe("pasta do Windows Installer ausente: explícito no log, sem mexer no sistema", () => {
    it.each([
        ["plugin", pluginFolderDiagnosis],
        ["gui", installerFolderDiagnosis],
    ])("%s: diz a causa e o reparo manual só quando a pasta falta", (_nome, diagnose) => {
        expect(diagnose(true)).toBeNull();
        expect(diagnose(null)).toBeNull();
        expect(diagnose(false)).toEqual({
            causa_provavel: expect.stringContaining("%SystemRoot%\\Installer ausente"),
            acao_manual: expect.stringContaining("como administrador, recriar %SystemRoot%\\Installer"),
        });
    });

    it("plugin: o filtro do log mantém a causa e o reparo", () => {
        const data = redactPluginData({ exit_code: 1632, ...pluginFolderDiagnosis(false) });
        expect(data).toMatchObject({ exit_code: 1632, causa_provavel: expect.any(String), acao_manual: expect.any(String) });
        expect(data).not.toHaveProperty("dropped_keys");
    });
});

describe("gui: retrato do ambiente", () => {
    it("fuso é só o deslocamento", () => {
        expect(timezoneOffsetLabel(new Date())).toMatch(/^[+-]\d{2}:\d{2}$/);
    });

    it("distro igual à do plugin e Windows traz build, pasta Installer e a escolha do WireSock", () => {
        expect(linuxDistroLabel('ID="ubuntu"\nVERSION_ID="24.04"')).toBe("ubuntu 24.04");
        const win = guiEnvironmentSnapshot({ wiresock: { version: "3.4.8.1", upgrade: "falhou_usando_anterior" } }, "win32");
        expect(win).toMatchObject({ so: "windows", wiresock_versao: "3.4.8.1", wiresock_upgrade: "falhou_usando_anterior" });
        expect(win.so_build).toBe(os.release());
        expect(["sim", "nao", "desconhecida"]).toContain(win.msi_pasta_installer);
        expect(guiEnvironmentSnapshot({}, "linux")).toMatchObject({ so: "linux", kernel: os.release() });
    });
});

describe("o relato não perde a causa do erro (simulação da #404)", () => {
    const POLKIT = "Error executing command as another user: Not authorized";

    it.each([
        ["plugin", (texto: string) => pluginRedigir(texto, [], "token")],
        ["gui", (texto: string) => guiRedigir(texto, [], "token")],
    ])("%s: a frase do pkexec sobrevive e rótulo de usuário de verdade continua escondido", (_nome, redigir) => {
        expect(redigir(POLKIT)).toBe(POLKIT);
        expect(redigir("usuario: fulano user=alice")).toBe("usuario:<usuario> user=<usuario>");
    });

    it("relaunch aceito sem abertura depois aponta o cliente que não subiu", () => {
        let now = new Date("2026-11-05T01:37:15.550Z");
        const logger = createPluginLogger({ component: "plugin.native", pluginVersion: "t", platform: "linux", arch: "x64", now: () => now });
        logger.info("plugin.process.started", {}, undefined, "abrindo plugin VPN | linux x64");
        logger.info("legacy.message", { operation_id: "vpn-activation-1" }, { namespace: "glb-k3m9q2" }, "comando de relaunch no namespace aceito com sucesso; encerrando processo atual");
        logger.info("operation.vpn-activation.completed", { operation_id: "vpn-activation-1" }, { duration_ms: 8242 });
        expect(pendingNamespaceRelaunch(logger.records())).toEqual({ at: "2026-11-05T01:37:15.550Z", namespace: "glb-k3m9q2", operation_id: "vpn-activation-1" });

        // O cliente relançado abriu o plugin: nada pendente.
        now = new Date("2026-11-05T01:37:18.000Z");
        logger.info("plugin.process.started", {}, undefined, "abrindo plugin VPN | linux x64");
        expect(pendingNamespaceRelaunch(logger.records())).toBeNull();
    });

    it("o código de saída e o passo vêm antes do stderr, que o log corta no fim", () => {
        const logger = createPluginLogger({ component: "plugin.native", pluginVersion: "t", platform: "linux", arch: "x64" });
        const erro = `Falha ao executar comando privilegiado [pkexec saiu com 127; nenhum passo chegou a rodar]: ${POLKIT} ${"x".repeat(400)}`;
        logger.error("operation.vpn-shutdown.failed", {}, { error: erro });
        expect(logger.getLog()).toContain("[pkexec saiu com 127; nenhum passo chegou a rodar]");
    });
});
