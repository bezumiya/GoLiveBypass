import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PluginVpnController } from "../../goLiveBypass/vpn-controller";
import type * as VpnLinux from "../../goLiveBypass/vpn-linux";
import { forcePluginHost } from "./helpers/plugin-host";

// Só o backend Linux é simulado. Sem forçar a plataforma, no Windows o controlador
// seguia pelo WireSock real: reconfigurava o serviço da máquina com a conf de teste.
let restaurarHost: () => void = () => {};
beforeAll(() => { restaurarHost = forcePluginHost("linux"); });
afterAll(() => restaurarHost());

/**
 * Relato beta: "problemas em carregar uma conf própria" no plugin.
 *
 * A conf do usuário passa por três caminhos que a perdiam ou travavam a ativação:
 * 1. a ativação no modo custom reimportava a conf por `importCustomConfig`, que entra na
 *    mesma fila serial da ativação que a aguarda — deadlock permanente em "Preparando
 *    perfil e WireGuard", com a fila inteira envenenada (restaurar/provedor nunca rodam);
 * 2. a cópia privada ficava em `wireguard.conf`, o mesmo arquivo que a geração Proton
 *    escreve — depois de qualquer perfil Proton, o modo custom subia o túnel do servidor
 *    Proton apresentando-o como "arquivo .conf personalizado";
 * 3. o logout Proton apagava essa cópia quando o modo selecionado era Proton, embora o
 *    perfil em uso fosse a conf do usuário — a ativação seguinte morria em "Arquivo
 *    WireGuard não encontrado.".
 */

const CONF_DO_USUARIO = [
    "[Interface]",
    "PrivateKey = AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    "Address = 10.7.0.2/32",
    "[Peer]",
    "PublicKey = BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=",
    "AllowedIPs = 0.0.0.0/0",
    "Endpoint = 198.51.100.7:51820",
    "",
].join("\n");

const PERFIL_PROTON = [
    "[Interface]",
    "PrivateKey = CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=",
    "Address = 10.2.0.2/32",
    "[Peer]",
    "PublicKey = DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD=",
    "AllowedIPs = 0.0.0.0/0",
    "Endpoint = 203.0.113.9:51820",
    "",
].join("\n");

const registros = vi.hoisted(() => ({ iniciados: [] as string[] }));

vi.mock("../../goLiveBypass/vpn-linux", async importOriginal => {
    const actual = await importOriginal<typeof VpnLinux>();
    return {
        ...actual,
        inspectLinuxNetworkSync: () => ({
            active: false,
            owned: false,
            reliable: true,
            namespace: null,
            interfaceName: null,
            namespaceExists: false,
            interfaceExists: false,
            externalConflict: false,
            reason: null,
        }),
        linuxDependencyStatus: async () => ({
            ok: true,
            elevationOk: true,
            hasIp: true,
            hasWg: true,
            wireGuardModule: "loaded" as const,
            hasPkexec: true,
            hasFlatpakSpawn: false,
            hasSystemdRun: true,
            isFlatpak: false,
            inNamespace: false,
            issues: [],
            missing: [],
        }),
        startLinuxNetwork: async (_owner: unknown, rawConfig: string) => {
            registros.iniciados.push(rawConfig);
        },
        stopLinuxNetwork: async () => ({ stopped: true, namespaceRemoved: true, interfaceRemoved: true, dnsRemoved: true }),
        isProcessInNamespace: () => false,
    };
});

const raizes: string[] = [];

function diretorioTemporario(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "golive-conf-propria-"));
    raizes.push(dir);
    return dir;
}

afterEach(() => {
    registros.iniciados.length = 0;
    while (raizes.length > 0) fs.rmSync(raizes.pop()!, { recursive: true, force: true });
});

function controlador(dataDir: string, ajustes: Record<string, unknown> = {}): PluginVpnController {
    return new PluginVpnController({
        dataDir,
        guiDataDir: dataDir,
        readSettings: () => ({
            mode: "custom",
            customConfigPath: "",
            protonUsername: "",
            protonCountry: "",
            protonFreeOnly: true,
            protonAutoPing: true,
            ...ajustes,
        }),
        isEnabled: () => true,
        log: () => {},
        requestRelaunch: async () => true,
    });
}

/**
 * Sem prazo próprio: o travamento do deadlock aparece como a operação que nunca resolve,
 * e o prazo do próprio vitest é a prova (nada de espera fixa mascarando a condição).
 */
describe("conf WireGuard própria do plugin", () => {
    it("ativa no modo custom sem travar a fila de operações", async () => {
        const dataDir = diretorioTemporario();
        const origem = path.join(dataDir, "minha-vpn.conf");
        fs.writeFileSync(origem, CONF_DO_USUARIO);

        const controller = controlador(dataDir, { customConfigPath: origem });
        await controller.importCustomConfig(origem);

        const ativacao = await controller.enable();
        expect(ativacao.success).toBe(true);
        expect(registros.iniciados.at(-1)).toBe(CONF_DO_USUARIO);

        // A fila precisa continuar utilizável depois da ativação (antes ela ficava presa).
        const restauracao = await controller.restoreNetwork();
        expect(restauracao.success).toBe(true);
        await controller.shutdown(false);
    });

    it("guarda a conf em arquivo próprio e a usa mesmo depois de um perfil Proton", async () => {
        const dataDir = diretorioTemporario();
        const origem = path.join(dataDir, "minha-vpn.conf");
        fs.writeFileSync(origem, CONF_DO_USUARIO);

        const importado = await controlador(dataDir).importCustomConfig(origem);
        expect(importado.success).toBe(true);
        const copia = path.join(dataDir, "custom-wireguard.conf");
        expect(importado.path).toBe(copia);
        expect(fs.readFileSync(copia, "utf8")).toBe(CONF_DO_USUARIO);

        // A geração Proton escreve `wireguard.conf` no mesmo diretório (vpn-proton.ts).
        fs.writeFileSync(path.join(dataDir, "wireguard.conf"), PERFIL_PROTON);

        const controller = controlador(dataDir, { customConfigPath: importado.path });
        const ativacao = await controller.enable();
        expect(ativacao.success).toBe(true);
        expect(registros.iniciados.at(-1)).toBe(CONF_DO_USUARIO);
        await controller.shutdown(false);
    });

    it("não apaga a conf importada no logout Proton", async () => {
        const dataDir = diretorioTemporario();
        const origem = path.join(dataDir, "minha-vpn.conf");
        fs.writeFileSync(origem, CONF_DO_USUARIO);

        const importado = await controlador(dataDir).importCustomConfig(origem);
        expect(importado.success).toBe(true);

        // Modo Proton selecionado, mas o perfil em uso continua sendo a conf importada.
        const logout = await controlador(dataDir, { mode: "proton", protonUsername: "conta" }).logoutProton();
        expect(logout.success).toBe(true);
        expect(fs.existsSync(importado.path!)).toBe(true);
        expect(fs.readFileSync(importado.path!, "utf8")).toBe(CONF_DO_USUARIO);

        const ativacao = await controlador(dataDir, { customConfigPath: importado.path }).enable();
        expect(ativacao.success).toBe(true);
        expect(registros.iniciados.at(-1)).toBe(CONF_DO_USUARIO);
    });

    it("remove os artefatos Proton no logout quando o perfil em uso é do Proton", async () => {
        const dataDir = diretorioTemporario();
        fs.writeFileSync(path.join(dataDir, "wireguard.conf"), PERFIL_PROTON);
        fs.writeFileSync(path.join(dataDir, "wireguard-profile-account.json"), JSON.stringify({ schema: 1, username: "conta" }));
        fs.writeFileSync(path.join(dataDir, "wiresock-discord.conf"), PERFIL_PROTON);

        const logout = await controlador(dataDir, { mode: "proton", protonUsername: "conta" }).logoutProton();
        expect(logout.success).toBe(true);
        expect(fs.existsSync(path.join(dataDir, "wireguard.conf"))).toBe(false);
        expect(fs.existsSync(path.join(dataDir, "wiresock-discord.conf"))).toBe(false);
        expect(fs.existsSync(path.join(dataDir, "wireguard-profile-account.json"))).toBe(false);
    });

    it("não reimporta o perfil Proton como conf personalizada no layout antigo", async () => {
        const dataDir = diretorioTemporario();
        // Estado legado: a conf importada era guardada em `wireguard.conf`, e a geração Proton
        // escreveu por cima dela (marcador da conta presente).
        fs.writeFileSync(path.join(dataDir, "wireguard.conf"), PERFIL_PROTON);
        fs.writeFileSync(path.join(dataDir, "wireguard-profile-account.json"), JSON.stringify({ schema: 1, username: "conta" }));

        const controller = controlador(dataDir, { customConfigPath: path.join(dataDir, "wireguard.conf") });
        const ativacao = await controller.enable();

        expect(ativacao.success).toBe(false);
        expect(ativacao.error).toContain("Selecione o arquivo .conf novamente");
        expect(registros.iniciados).toHaveLength(0);
    });

    it("não valida o perfil ativo como se fosse a conf configurada", async () => {
        const dataDir = diretorioTemporario();
        fs.writeFileSync(path.join(dataDir, "wireguard.conf"), PERFIL_PROTON);

        const vazio = controlador(dataDir).testConfig("");
        expect(vazio.success).toBe(false);
        expect(vazio.error).toContain("personalizado");

        const origem = path.join(dataDir, "minha-vpn.conf");
        fs.writeFileSync(origem, CONF_DO_USUARIO);
        const importado = await controlador(dataDir).importCustomConfig(origem);
        expect(controlador(dataDir).testConfig(importado.path).success).toBe(true);

        // Sem argumento, o alvo é a conf configurada no settings (o que o botão "Testar .conf"
        // promete) — e um settings vazio não pode passar por válido só porque a cópia existe.
        expect(controlador(dataDir, { customConfigPath: importado.path }).testConfig().success).toBe(true);
        expect(controlador(dataDir, { customConfigPath: "" }).testConfig().success).toBe(false);
    });

    it("rejeita conf sem rota padrão dizendo o que falta", async () => {
        const dataDir = diretorioTemporario();
        const parcial = path.join(dataDir, "parcial.conf");
        fs.writeFileSync(parcial, CONF_DO_USUARIO.replace("AllowedIPs = 0.0.0.0/0", "AllowedIPs = 10.0.0.0/8"));

        const resultado = await controlador(dataDir).importCustomConfig(parcial);
        expect(resultado.success).toBe(false);
        expect(resultado.error).toContain("0.0.0.0/0");
    });

    it("aceita rota padrão escrita como as duas metades", async () => {
        const dataDir = diretorioTemporario();
        const metades = path.join(dataDir, "metades.conf");
        fs.writeFileSync(metades, CONF_DO_USUARIO.replace(
            "AllowedIPs = 0.0.0.0/0",
            "AllowedIPs = 0.0.0.0/1, 128.0.0.0/1",
        ));

        const resultado = await controlador(dataDir).importCustomConfig(metades);
        expect(resultado.success).toBe(true);
    });
});
