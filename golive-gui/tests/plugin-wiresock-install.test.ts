import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyWireSockInstallState,
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