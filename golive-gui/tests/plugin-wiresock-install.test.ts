import { EventEmitter } from "node:events";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyWireSockInstallState,
  downloadInstaller,
  parseWireSockOrphanDefaultRoutes,
  parseWireSockUninstallEntries,
  parseWireSockUninstallLocations,
  wireSockForeignInstallLocations,
  wireSockForeignInstallMessage,
  wireSockInstallFailureHint,
  wireSockInstallerArguments,
  wireSockNetworkRestoreScript,
  wireSockResidueNeedsRestore,
  type WireSockNetworkRestoreResult,
} from "../../goLiveBypass/vpn-windows";

// Mesmo defeito da GUI: instalar por cima de um WireSock pela metade deixava a máquina sem
// internet, porque o setup caía em "Modify Setup" (manutenção) e o /quiet não instalava nada.
describe("instalação do WireSock no plugin nunca deixa a máquina sem internet", () => {
  it.each([
    ["pasta do pacote sobrando", { installDir: true }],
    ["registro do Windows sobrando", { registered: true }],
    ["driver carregado sem cliente", { driverService: true }],
  ])("classifica %s como instalação pela metade", (_nome, residuo) => {
    expect(classifyWireSockInstallState({ compatiblePair: false, installDir: false, registered: false, driverService: false, ...residuo })).toBe("stale");
  });

  it("máquina sem vestígio é instalação nova e par compatível vence resíduo", () => {
    expect(classifyWireSockInstallState({ compatiblePair: false, installDir: false, registered: false, driverService: false })).toBe("none");
    expect(classifyWireSockInstallState({ compatiblePair: true, installDir: true, registered: true, driverService: true })).toBe("compatible");
  });

  it.each([
    ["rota default órfã no adaptador virtual", { adapterDefaultRoute: true, driverService: false, clientInstalled: true }],
    ["driver carregado sem cliente", { adapterDefaultRoute: false, driverService: true, clientInstalled: false }],
  ])("resíduo que segura a rede pede recuperação: %s", (_nome, residuo) => {
    expect(wireSockResidueNeedsRestore(residuo)).toBe(true);
  });

  it("instalado e desligado não abre UAC de restauração", () => {
    expect(wireSockResidueNeedsRestore({ adapterDefaultRoute: false, driverService: true, clientInstalled: true })).toBe(false);
    expect(wireSockResidueNeedsRestore({ adapterDefaultRoute: false, driverService: false, clientInstalled: false })).toBe(false);
  });

  it("rota default do ProTUN é órfã; a do Wi-Fi não é", () => {
    const table = [
      "Publish  Type      Subnet Prefix      Next Hop        If Metric",
      "------  --------  -----------------  --------------  ---- ------",
      "     0.0.0.0/0                    10.2.0.1    ProTUN     5",
      "    0.0.0.0/0                  192.168.0.1      Wi-Fi    25",
    ].join("\n");
    expect(parseWireSockOrphanDefaultRoutes(table)).toBe(true);
    expect(parseWireSockOrphanDefaultRoutes(table.split("\n").filter(line => !/ProTUN/.test(line)).join("\n"))).toBe(false);
  });

  it("registro do Windows é lido do JSON do PowerShell", () => {
    expect(parseWireSockUninstallEntries('[{"name":"WireSock Secure Connect"}]')).toEqual(["WireSock Secure Connect"]);
    expect(parseWireSockUninstallEntries('{"name":"WGLaunch"}')).toEqual(["WGLaunch"]);
    expect(parseWireSockUninstallEntries("[]")).toEqual([]);
    expect(parseWireSockUninstallEntries("")).toEqual([]);
  });

  it("instalação registrada fora das raízes aceitas vira mensagem acionável (#402)", () => {
    const pfD = String.raw`D:\Program Files\WireSock Secure Connect`;
    const pfC = String.raw`C:\Program Files\WireSock Secure Connect`;
    const raw = JSON.stringify([
      { name: "WireSock Secure Connect", location: `${pfD}/`, icon: "" },
      { name: "WGLaunch", location: "", icon: `"${path.win32.join(pfC, "sdk", "wiresock-client.exe")}",0` },
      { name: "WireSock antigo", location: "", icon: "" },
    ]);
    const locations = parseWireSockUninstallLocations(raw);
    expect(locations).toEqual([pfD, path.win32.join(pfC, "sdk")]);
    expect(parseWireSockUninstallLocations("")).toEqual([]);
    const roots = [pfC, String.raw`C:\Users\u\AppData\Local\Microsoft\WinGet\Packages`];
    expect(wireSockForeignInstallLocations(locations, roots)).toEqual([pfD]);
    // Prefixo de nome nao e subpasta: "WireSock Secure Connect2" fica de fora.
    expect(wireSockForeignInstallLocations([`${pfC.toLowerCase()}2`], roots)).toHaveLength(1);
    const message = wireSockForeignInstallMessage(pfD);
    expect(message).toContain(pfD);
    expect(message).toContain('Desinstale o "WireSock Secure Connect"');
  });

  it("script de recuperação usa o reset oficial do driver e recusa com túnel vivo", () => {
    const script = wireSockNetworkRestoreScript(["C:\\Program Files\\WireSock Secure Connect\\wiresock-client.exe"], "C:\\Temp\\restore.json");
    expect(script).toContain("reset-network-lock");
    expect(script.indexOf("$running = @(")).toBeLessThan(script.indexOf("reset-network-lock"));
    expect(script).toContain("WIRESOCK_RUNNING");
    expect(script).toContain("0.0.0.0/0");
    expect(script).toContain("ipconfig.exe /flushdns");
    expect(script).toContain("C:\\Temp\\restore.json");
    expect(() => wireSockNetworkRestoreScript(["ok"], 'C:\\"quebrado.json')).toThrow(/Caminho WireSock inválido/);
  });

  it("modos do setup cobrem instalar, remover e reparar", () => {
    expect(wireSockInstallerArguments("install")).toEqual(["/quiet", "/norestart"]);
    expect(wireSockInstallerArguments("uninstall")).toEqual(["/uninstall", "/quiet", "/norestart"]);
    expect(wireSockInstallerArguments("repair")).toEqual(["/repair", "/quiet", "/norestart"]);
  });

  const restored: WireSockNetworkRestoreResult = {
    ok: true, executed: true, networkLockReset: true, dnsFlushed: true, adapterRoutesCleared: true, residual: [],
  };

  it("dica final distingue rede restaurada de rede não confirmada", () => {
    expect(wireSockInstallFailureHint(restored)).toMatch(/rede do Windows foi restaurada/);
    expect(wireSockInstallFailureHint({ ...restored, executed: false })).toBe("");
    expect(wireSockInstallFailureHint({
      ok: false, executed: true, networkLockReset: false, dnsFlushed: false, adapterRoutesCleared: false, residual: ["WIRESOCK_CLIENT_MISSING"],
    })).toMatch(/Restaurar rede/);
  });
});

describe("o caminho de instalação do plugin usa a política nova", () => {
  const source = require("node:fs").readFileSync(path.resolve(process.cwd(), "../goLiveBypass/vpn-windows.ts"), "utf8") as string;
  const installBody = source.slice(
    source.indexOf("async function ensureWireSockInstalledOnce"),
    source.indexOf("export function validateWireGuardProfile"),
  );

  it("desinstala a instalação pela metade antes de instalar", () => {
    expect(installBody).toContain('detectWireSockInstallState()');
    expect(installBody.indexOf('runElevatedInstaller(installer, "uninstall")')).toBeLessThan(installBody.indexOf('runElevatedInstaller(installer, "install")'));
    expect(installBody).toContain("WIRESOCK_ABSENT_EXIT_CODES");
  });

  it("repara quando o instalador termina sem par compatível", () => {
    expect(installBody).toContain('runElevatedInstaller(installer, "repair")');
    expect(installBody.indexOf('"repair"')).toBeLessThan(installBody.indexOf("não deixou uma instalação SDK compatível"));
  });

  it("nenhuma falha sai sem a recuperação de rede do fornecedor", () => {
    expect(installBody).toContain('restoreWireSockNetwork(log, { force: true })');
    expect(installBody).toContain("wireSockInstallFailureHint(restore)");
    // Cancelamento do usuário continua saindo limpo, sem tocar na rede.
    expect(installBody.indexOf('if (code === 1223) throw new Error("A instalação do WireSock foi cancelada pelo usuário.");'))
      .toBeLessThan(installBody.lastIndexOf("restoreWireSockNetwork(log, { force: true })"));
  });

  it("espera a instalação assentar: o msiexec sobrevive ao setup", () => {
    // Medido no Windows 11: o `/quiet` devolve antes da transação do Windows
    // Installer e o par só aparece depois. Verificar uma vez dava falso negativo.
    expect(installBody).toContain("waitForCompatibleWireSock(WIRESOCK_SETTLE_TIMEOUT_MS)");
    expect(installBody.indexOf("waitForCompatibleWireSock")).toBeLessThan(installBody.indexOf("não deixou uma instalação SDK compatível"));
    const source = require("node:fs").readFileSync(path.resolve(process.cwd(), "../goLiveBypass/vpn-windows.ts"), "utf8") as string;
    // Setup sem teto deixaria o painel preso em "preparando" para sempre.
    expect(source).toContain("WIRESOCK_INSTALLER_TIMEOUT_MS = 5 * 60_000");
    expect(source).toContain("taskkill.exe");
  });
});

// #429/#432: um 502 do site oficial derrubava a ativação. Mesmo retry da GUI: 429/502/503/504 e
// timeout, até três tentativas. O `https.get` responde por roteiro e a espera entre tentativas é injetada.
describe("download do instalador WireSock no plugin", () => {
  type Resposta =
    | { status: number; location?: string; body?: string }
    | { timeout: "antes-da-resposta" }
    | { timeout: "no-meio-do-corpo"; parcial: string };

  let dir = "";
  let target = "";
  const log = vi.fn();
  const sleep = vi.fn(async (_ms: number) => {});

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "golive-plugin-download-"));
    target = path.join(dir, "wiresock-sdk.exe");
    log.mockClear();
    sleep.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Cada `https.get` consome a próxima resposta. Como no Node, `destroy(erro)` emite o erro no pedido
  // e derruba a resposta que estiver em andamento.
  function roteiro(respostas: Resposta[]): string[] {
    const urls: string[] = [];
    vi.spyOn(https, "get").mockImplementation(((url: string, callback: (response: PassThrough) => void) => {
      urls.push(String(url));
      const resposta = respostas.shift();
      if (!resposta) throw new Error(`pedido inesperado: ${url}`);
      const request = new EventEmitter() as EventEmitter & { setTimeout(ms: number, onTimeout: () => void): void; destroy(error: Error): void };
      let entregue: PassThrough | null = null;
      let onTimeout = () => {};
      request.setTimeout = (_ms, callback) => { onTimeout = callback; };
      request.destroy = error => queueMicrotask(() => {
        request.emit("error", error);
        entregue?.destroy(new Error("aborted"));
      });
      const responder = (status: number, headers: Record<string, string> = {}) => {
        entregue = Object.assign(new PassThrough(), { statusCode: status, headers });
        callback(entregue);
        return entregue;
      };
      setImmediate(async () => {
        if (!("timeout" in resposta)) {
          responder(resposta.status, resposta.location ? { location: resposta.location } : {}).end(resposta.body ?? "");
          return;
        }
        if (resposta.timeout === "no-meio-do-corpo") {
          responder(200).write(resposta.parcial);
          await vi.waitFor(() => expect(fs.readFileSync(target, "utf8")).toBe(resposta.parcial));
        }
        onTimeout();
      });
      return request;
    }) as never);
    return urls;
  }

  it("502 seguido de 200 conclui na segunda tentativa", async () => {
    const urls = roteiro([{ status: 502 }, { status: 200, body: "instalador" }]);
    await downloadInstaller(target, log, sleep);
    expect(fs.readFileSync(target, "utf8")).toBe("instalador");
    expect(urls).toHaveLength(2);
    expect(sleep.mock.calls).toEqual([[1000]]);
    expect(log.mock.calls).toEqual([["warn", "wiresock.download.retry", { tentativa: 1, erro: expect.stringContaining("HTTP 502") }]]);
  });

  it("três 502 seguidos desistem com a mensagem que aponta o site oficial", async () => {
    const urls = roteiro([{ status: 502 }, { status: 502 }, { status: 502 }]);
    await expect(downloadInstaller(target, log, sleep)).rejects.toThrow(
      "Download WireSock retornou HTTP 502. O site oficial pode estar indisponível neste momento; tente ativar novamente em instantes.");
    expect(urls).toHaveLength(3);
    expect(sleep.mock.calls).toEqual([[1000], [2000]]);
    expect(log).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(target)).toBe(false);
  });

  it.each([
    ["HTTP 404", [{ status: 404 }], /^Download WireSock retornou HTTP 404\.$/],
    ["redirecionamento para fora do wiresock.net", [{ status: 302, location: "https://example.com/wiresock.exe" }], /host não autorizado/],
  ] as Array<[string, Resposta[], RegExp]>)("%s falha na hora, sem nova tentativa", async (_nome, respostas, erro) => {
    const urls = roteiro(respostas);
    await expect(downloadInstaller(target, log, sleep)).rejects.toThrow(erro);
    expect(urls).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("timeout antes da resposta ganha nova tentativa", async () => {
    const urls = roteiro([{ timeout: "antes-da-resposta" }, { status: 200, body: "instalador" }]);
    await downloadInstaller(target, log, sleep);
    expect(fs.readFileSync(target, "utf8")).toBe("instalador");
    expect(urls).toHaveLength(2);
    expect(log.mock.calls).toEqual([["warn", "wiresock.download.retry", { tentativa: 1, erro: "Timeout ao baixar o instalador WireSock." }]]);
  });

  it("timeout no meio do corpo descarta o arquivo parcial antes de tentar de novo", async () => {
    // Sem a remoção, o `wx` da segunda tentativa falharia com EEXIST.
    roteiro([{ timeout: "no-meio-do-corpo", parcial: "MZ-parcial" }, { status: 200, body: "instalador" }]);
    await downloadInstaller(target, log, sleep);
    expect(fs.readFileSync(target, "utf8")).toBe("instalador");
    expect(sleep.mock.calls).toEqual([[1000]]);
  });

  it("redirecionamento continua valendo e a nova tentativa recomeça pelo endpoint oficial", async () => {
    const cdn = "https://cdn.wiresock.net/wiresock-secure-connect-sdk.exe";
    const urls = roteiro([
      { status: 302, location: cdn }, { status: 503 },
      { status: 302, location: cdn }, { status: 200, body: "instalador" },
    ]);
    await downloadInstaller(target, log, sleep);
    expect(fs.readFileSync(target, "utf8")).toBe("instalador");
    const oficial = urls[0];
    expect(oficial).toMatch(/^https:\/\/wiresock\.net\/_api\/download-release\.php\?/);
    expect(urls).toEqual([oficial, cdn, oficial, cdn]);
    expect(sleep.mock.calls).toEqual([[1000]]);
  });
});
