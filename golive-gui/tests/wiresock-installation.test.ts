import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { classifyWireSockActivationFailure, classifyWireSockDirectResult, classifyWireSockInstallState, formatAllowedApps, limparSinalDoSupervisor, mayUseServiceCompatibility, parseWireSockOrphanDefaultRoutes, parseWireSockUninstallEntries, readWireSockResult, sanitizeWireGuardConfig, wireSockExecError, wireSockInstallFailureHint, wireSockInstallModeError, wireSockInstallerArguments, wireSockInstallerExitKind, wireSockResidueNeedsRestore, type WireSockNetworkRestoreResult } from "../electron/wiresock";
import { elevatedPowerShellFileArgs, wireSockDirectScript, wireSockNetworkRestoreScript, wireSockServiceScript } from "../electron/wiresock-service";

const sourcePath = path.resolve(process.cwd(), "electron/wiresock.ts");
const source = fs.readFileSync(sourcePath, "utf8");
const file = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

/** Extrai o corpo real de uma função do módulo para exercitar o fluxo de verdade. */
function bodyOf(name: string): string {
  let found: ts.FunctionLikeDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isFunctionLike(node) && node.name?.getText(file) === name) found = node;
    if (!found) ts.forEachChild(node, visit);
  };
  visit(file);
  if (!found?.body || !ts.isBlock(found.body)) throw new Error(`${name} não encontrada`);
  return ts.transpileModule(found.body.getText(file).slice(1, -1), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
}

/**
 * Contexto do fluxo real de instalação: o corpo de `installOfficialWireSock`
 * roda com o WireSock inteiro trocado por dublês, então a ordem dos modos
 * (desinstalar -> instalar -> reparar) e a recuperação de rede são observadas
 * no código que roda em produção, não numa reimplementação do teste.
 */
function makeInstallOfficial() {
  return new Function(`return async function(ctx, onProgress) {
    const { path, fs, os, crypto, wireSockPlatform, downloadOfficialWireSock,
      WIRESOCK_INSTALLER_HASHES, wireSockInstallerExitKind, wireSockInstallFailureHint,
      detalheErro, markWireSockRebootPending, detectWireSockInstallState, wireSockInstallModeError,
      runWireSockInstaller, findCompatibleWireSockAsync, restoreWireSockNetwork,
      verifyWindowsNetworkStable, waitForCompatibleWireSock } = ctx;
    const esperar = async () => {};
    const WIRESOCK_INSTALLER_TIMEOUT_MS = 1;
    const WIRESOCK_UNINSTALL_TIMEOUT_MS = 1;
    const WIRESOCK_SETTLE_TIMEOUT_MS = 1;
    const WIRESOCK_INSTALL_REBOOT = "WIRESOCK_INSTALL_REBOOT";
    const WIRESOCK_INSTALL_CANCEL = "WIRESOCK_INSTALL_CANCEL";
    ${bodyOf("installOfficialWireSock")}
  }`)();
}

const restoreOk: WireSockNetworkRestoreResult = {
  ok: true, executed: true, networkLockReset: true, dnsFlushed: true, adapterRoutesCleared: true, residual: [],
};

interface InstallCtxOptions {
  state?: "compatible" | "stale" | "none";
  pairAfterInstall?: string | null;
  cancelOn?: "uninstall" | "install";
}

function installCtx(options: InstallCtxOptions = {}) {
  const modes: string[] = [];
  const restores: Array<{ reason: string; force?: boolean }> = [];
  let settleChecks = 0;
  // O corpo real confere o SHA-256 do download contra o release fixado: o
  // dublê precisa escrever exatamente o conteúdo cujo hash ele declara.
  const fixture = "instalador-oficial";
  const ctx = {
    path, fs, os, crypto,
    wireSockPlatform: () => ({ hash: "x64", query: "x64" }),
    WIRESOCK_INSTALLER_HASHES: { x64: crypto.createHash("sha256").update(fixture).digest("hex") },
    downloadOfficialWireSock: async (_platform: string, target: string) => fs.promises.writeFile(target, fixture),
    wireSockInstallerExitKind,
    wireSockInstallFailureHint,
    wireSockInstallModeError,
    detalheErro: (error: unknown) => String((error as Error)?.message ?? error),
    verifyWindowsNetworkStable: async () => ({ ok: true, dnsOk: true, httpsOk: true, updaterDnsOk: true, updaterHttpsOk: true }),
    markWireSockRebootPending: () => { throw new Error("REBOOT_PENDENTE"); },
    detectWireSockInstallState: async () => options.state ?? "none",
    runWireSockInstaller: async (_installer: string, mode: string) => {
      modes.push(mode);
      if (options.cancelOn === mode) throw Object.assign(new Error("cancelado"), { code: 1223 });
    },
    findCompatibleWireSockAsync: async () =>
      options.pairAfterInstall === undefined ? "C:\\WireSock\\wiresock-client.exe" : options.pairAfterInstall,
    waitForCompatibleWireSock: async function () {
      settleChecks += 1;
      return ctx.findCompatibleWireSockAsync();
    },
    restoreWireSockNetwork: async (reason: string, opts: { force?: boolean } = {}) => {
      restores.push({ reason, force: opts.force });
      return restoreOk;
    },
  };
  return { ctx, modes, restores, settleChecks: () => settleChecks };
}

function ensureOnceBody(): string {
  let found: ts.FunctionLikeDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isFunctionLike(node) && node.name?.getText(file) === "ensureWireSockInstalledOnce") found = node;
    if (!found) ts.forEachChild(node, visit);
  };
  visit(file);
  if (!found?.body || !ts.isBlock(found.body)) throw new Error("ensureWireSockInstalledOnce não encontrada");
  return found.body.getText(file).slice(1, -1);
}

function makeEnsure() {
  const body = ensureOnceBody();
  return new Function(`return async function(ctx, onProgress) {
    const { assertNoPendingWireSockReboot, findCompatibleWireSockAsync,
      isWireSockPacketFilterInstalled, isWireSockPacketFilterDriverInstalled, logger, installOfficialWireSock,
      WIRESOCK_OFFICIAL_DOWNLOAD } = ctx;
    ${body}
  }`)();
}

const base = () => ({
  WIRESOCK_OFFICIAL_DOWNLOAD: "https://wiresock.net/official-sdk",
  assertNoPendingWireSockReboot: () => {},
  findCompatibleWireSockAsync: async () => null,
  isWireSockPacketFilterDriverInstalled: () => true,
  logger: { warn: () => {}, info: () => {} },
  installOfficialWireSock: async () => "C:\\Program Files\\WireSock Secure Connect\\wiresock-client.exe",
});

describe("instalação WireSock extraída do fluxo real", () => {
  it.each([[3010, "reboot"], [1641, "reboot"], [1223, "cancel"], [1, "failure"]] as const)("classifica saída real do instalador %s", (code, expected) => {
    expect(wireSockInstallerExitKind({ code })).toBe(expected);
  });

  it("installOfficial real calcula hash antes de executar PowerShell", async () => {
    const run = makeInstallOfficial();
    const { ctx, modes } = installCtx();
    ctx.WIRESOCK_INSTALLER_HASHES = { x64: "hash-que-nao-confere" };
    await expect(run(ctx, () => {})).rejects.toThrow("Hash do instalador");
    expect(modes).toEqual([]);
  });

  it("ensureWireSock export preserva singleflight com Promise pendente", async () => {
    let release!: () => void; let calls = 0;
    const pending = new Promise<string>((resolve) => { release = () => resolve("new.exe"); });
    const fn = (() => {
      let found: ts.FunctionLikeDeclaration | undefined;
      const visit = (node: ts.Node) => { if (ts.isFunctionLike(node) && node.name?.getText(file) === "ensureWireSockInstalled") found = node; if (!found) ts.forEachChild(node, visit); };
      visit(file); return found;
    })();
    if (!fn?.body || !ts.isBlock(fn.body)) throw new Error("ensureWireSockInstalled não encontrada");
    const body = ts.transpileModule(fn.body.getText(file).slice(1, -1), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    const ensure = new Function(`let wireSockInstallInFlight = null; return function make(ctx) {
      const ensureWireSockInstalledOnce = () => { ctx.calls++; return ctx.pending; };
      return async function ensureWireSockInstalled(onProgress) { ${body} };
    }`)();
    const ctx = { pending, calls: 0 };
    const run = ensure(ctx); const first = run(); const second = run();
    expect(ctx.calls).toBe(1); release();
    await expect(first).resolves.toBe("new.exe");
  });

  it.each([
    ["legado ausente", null],
    ["nenhum candidato", null],
  ])("%s instala candidato oficial", async (_name, existing) => {
    const run = makeEnsure(); const ctx = base(); let installs = 0;
    ctx.findCompatibleWireSockAsync = async () => existing;
    ctx.installOfficialWireSock = async () => { installs++; return "new.exe"; };
    await expect(run(ctx, () => {})).resolves.toBe("new.exe");
    expect(installs).toBe(1);
  });

  it("candidato novo não reinstala", async () => {
    const run = makeEnsure(); const ctx = base(); let installs = 0;
    ctx.findCompatibleWireSockAsync = async () => "new.exe";
    ctx.installOfficialWireSock = async () => { installs++; return "bad.exe"; };
    await expect(run(ctx, () => {})).resolves.toBe("new.exe");
    expect(installs).toBe(0);
  });

  it("primeira consulta antiga instala e segunda consulta nova não reinstala", async () => {
    const run = makeEnsure(); const ctx = base(); let installs = 0; let lookup = 0;
    ctx.findCompatibleWireSockAsync = async () => (++lookup === 1 ? null : "new.exe");
    ctx.installOfficialWireSock = async () => { installs++; return "new.exe"; };
    await expect(run(ctx, () => {})).resolves.toBe("new.exe");
    await expect(run(ctx, () => {})).resolves.toBe("new.exe");
    expect(installs).toBe(1);
  });

  it.each(["hash mismatch", "UAC cancel", "installer failure"])("propaga falha de instalação: %s", async (reason) => {
    const run = makeEnsure(); const ctx = base();
    ctx.installOfficialWireSock = async () => { throw new Error(reason); };
    await expect(run(ctx, () => {})).rejects.toThrow(reason);
  });

  it("reboot pendente bloqueia antes de tocar no instalador", async () => {
    const run = makeEnsure(); const ctx = base(); let installs = 0;
    ctx.assertNoPendingWireSockReboot = () => { throw new Error("reboot pending"); };
    ctx.installOfficialWireSock = async () => { installs++; return "never.exe"; };
    await expect(run(ctx, () => {})).rejects.toThrow("reboot pending");
    expect(installs).toBe(0);
  });

  it("nova tentativa após reboot liberado volta a instalar", async () => {
    const run = makeEnsure(); const ctx = base(); let blocked = true; let installs = 0;
    ctx.assertNoPendingWireSockReboot = () => { if (blocked) throw new Error("reboot pending"); };
    ctx.installOfficialWireSock = async () => { installs++; return "new.exe"; };
    await expect(run(ctx, () => {})).rejects.toThrow("reboot pending");
    blocked = false;
    await expect(run(ctx, () => {})).resolves.toBe("new.exe");
    expect(installs).toBe(1);
  });

  it("driver invisível é diagnóstico e não bloqueia candidato compatível", async () => {
    const run = makeEnsure(); const ctx = base();
    ctx.findCompatibleWireSockAsync = async () => "new.exe";
    ctx.isWireSockPacketFilterDriverInstalled = () => false;
    await expect(run(ctx, () => {})).resolves.toBe("new.exe");
  });

  it("emite progresso verificável antes da descoberta", async () => {
    const run = makeEnsure(); const ctx = base(); const progress: string[] = [];
    await run(ctx, (message: string) => progress.push(message));
    expect(progress).toEqual(["Verificando instalação compatível do WireSock…"]);
  });
});

describe("ativação extraída do fluxo real", () => {
  function bodyOf(name: string): string {
    let found: ts.FunctionLikeDeclaration | undefined;
    const visit = (node: ts.Node) => { if (ts.isFunctionLike(node) && node.name?.getText(file) === name) found = node; if (!found) ts.forEachChild(node, visit); };
    visit(file);
    if (!found?.body || !ts.isBlock(found.body)) throw new Error(`${name} não encontrada`);
    return ts.transpileModule(found.body.getText(file).slice(1, -1), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  }

  const detalheErro = new Function(`return function detalheErro(err) {${bodyOf("detalheErro")}}`)();

  function makeApply() {
    return new Function(`return async function(ctx, installDir, rawConf, allowedAppPaths) {
      const { fs, path, os, crypto, logger, ensureWireSockInstalled, wireSockDirectScript, wireSockServiceScript,
        elevatedPowerShellFileArgs, readWireSockResult, classifyWireSockDirectResult, detalheErro,
        esperarProcessoWireSock, mayUseServiceCompatibility, classifyWireSockActivationFailure,
        stopWireSockService, WIRESOCK_SERVICE_NAMES, isServiceRunning, limparDnsDoAdaptadorWireSock,
        formatAllowedApps, sanitizeWireGuardConfig, execFileWithWindow, setTunnelSupervisor, limparSinalDoSupervisor } = ctx;
      ${bodyOf("applyWireSockProfile")}
    }`)();
  }

  // Contexto minimo da ativacao: o worker elevado falha com UAC cancelada, que e o caminho que os
  // testes exercitam. Cada chamada devolve um contexto novo para uma ativacao independente.
  function criarCtx(estado: { eventos: Array<{ event: string; payload: Record<string, unknown> }>; elevados: number }) {
    return {
      fs, path, crypto,
      os: { tmpdir: () => os.tmpdir() },
      logger: {
        info: () => {},
        warn: () => {},
        createOperationId: (prefixo: string) => `${prefixo}-teste`,
        logEvent: (_nivel: string, _categoria: string, event: string, _contexto: unknown, payload: Record<string, unknown>) => {
          estado.eventos.push({ event, payload: payload ?? {} });
        },
        clipLogText: (valor: unknown, max = 2000) => String(valor ?? "").trim().slice(0, max),
      },
      ensureWireSockInstalled: async () => "C:\\WireSock\\wiresock-client.exe",
      wireSockDirectScript, wireSockServiceScript, elevatedPowerShellFileArgs,
      readWireSockResult, classifyWireSockDirectResult, detalheErro, mayUseServiceCompatibility,
      classifyWireSockActivationFailure, formatAllowedApps, sanitizeWireGuardConfig,
      esperarProcessoWireSock: async () => false,
      stopWireSockService: async () => ({ stopped: true, attempts: 1, resetNetworkLock: true, dnsCleared: true, dnsFlushed: true, servicesResidual: [], processResidual: false, residual: [] }),
      WIRESOCK_SERVICE_NAMES: ["wiresock-client-service", "wiresock-pro-client-service"],
      isServiceRunning: () => false,
      limparDnsDoAdaptadorWireSock: async () => {},
      setTunnelSupervisor: () => {},
      limparSinalDoSupervisor,
      execFileWithWindow: async () => {
        estado.elevados++;
        throw wireSockExecError(
          Object.assign(new Error("Command failed: powershell.exe -NoProfile -NonInteractive -EncodedCommand JABFAHIAcgBvAHIA"), { code: 1 }),
          "powershell.exe",
          "",
          "Start-Process : A operação foi cancelada pelo usuário.",
        );
      },
    };
  }

  it("falha do wrapper elevado vira permissão com o stderr real, não perfil", async () => {
    const run = makeApply();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "golive-aplicacao-"));
    const installDir = path.join(root, "dados");
    const conf = path.join(root, "wireguard.conf");
    fs.writeFileSync(conf, "[Interface]\nPrivateKey = chave-teste\n[Peer]\nAllowedIPs = 0.0.0.0/0\n");
    const eventos: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const estado = { eventos, elevados: 0 };
    try {
      await expect(run(criarCtx(estado), installDir, conf, ["C:\\Apps\\Discord.exe"])).rejects.toThrow("WIRESOCK_PERMISSION");
      await expect(run(criarCtx(estado), installDir, conf, ["C:\\Apps\\Discord.exe"])).rejects.not.toThrow(/perfil WireGuard/i);
      expect(estado.elevados).toBe(2);
      const falha = eventos.find((evento) => evento.event === "activation.failed");
      expect(String(falha?.payload.detalhe)).toContain("cancelada pelo usuário");
      expect(String(falha?.payload.codigo)).toBe("WIRESOCK_PERMISSION");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("ativação começa sem sinal de parada velho, mesmo quando nenhum supervisor vai existir", async () => {
    const run = makeApply();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "golive-aplicacao-"));
    const installDir = path.join(root, "dados");
    const conf = path.join(root, "wireguard.conf");
    fs.writeFileSync(conf, "[Interface]\nPrivateKey = chave-teste\n[Peer]\nAllowedIPs = 0.0.0.0/0\n");
    const flag = path.join(installDir, "wiresock-stop.flag");
    // Sobra de um worker elevado que morreu no meio da parada: ninguem vigia o par.
    fs.mkdirSync(installDir, { recursive: true });
    fs.writeFileSync(flag, "stop");
    fs.writeFileSync(flag + ".result", JSON.stringify({ stopped: true, attempts: 1 }));
    const estado = { eventos: [], elevados: 0 };
    try {
      await expect(run(criarCtx(estado), installDir, conf, ["C:\\Apps\\Discord.exe"])).rejects.toThrow("WIRESOCK_PERMISSION");
      expect(estado.elevados).toBe(1);
      expect(fs.existsSync(flag)).toBe(false);
      expect(fs.existsSync(flag + ".result")).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// #281: o serviço precisa nascer e permanecer Manual — um registro Auto volta
// sozinho no reboot como serviço órfão, roteando o Discord sem sessão esperada.
describe("servico WireSock sempre em StartMode=Manual (#281)", () => {
  const pluginSource = fs.readFileSync(path.resolve(process.cwd(), "../goLiveBypass/vpn-windows.ts"), "utf8");

  it("script da GUI instala com start-type 3 e força StartMode Manual antes de iniciar", () => {
    const script = wireSockServiceScript(
      "C:\\Program Files\\WireSock Secure Connect\\wiresock-client.exe",
      String.raw`C:\Users\u\AppData\Local\GoLiveBypass\wiresock-discord.conf`,
    );
    expect(script).toContain("install -start-type 3");
    expect(script).toContain("StartMode='Manual'");
    expect(script.indexOf("StartMode='Manual'")).toBeLessThan(script.indexOf("Start-Service"));
  });

  it("script do plugin instala com start-type 3 e força StartMode Manual antes de iniciar", () => {
    const start = pluginSource.indexOf("function serviceScript(");
    const end = pluginSource.indexOf("function elevatedPowerShellArgs", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const script = pluginSource.slice(start, end);
    expect(script).toContain("install -start-type 3");
    expect(script).toContain("StartMode='Manual'");
    expect(script.indexOf("StartMode='Manual'")).toBeLessThan(script.indexOf("Start-Service"));
  });
});

// Instalação pela metade (setup caindo em "Modify Setup") deixava a máquina sem
// internet: o app agora remove antes de instalar e garante a restauração da rede.
describe("instalação quebrada do WireSock nunca deixa a máquina sem internet", () => {
  it.each([
    ["pasta do pacote sobrando", { installDir: true }],
    ["registro do Windows sobrando", { registered: true }],
    ["driver carregado sem cliente", { driverService: true }],
  ])("classifica %s como instalação pela metade", (_nome, residuo) => {
    expect(classifyWireSockInstallState({ compatiblePair: false, installDir: false, registered: false, driverService: false, ...residuo })).toBe("stale");
  });

  it("máquina sem nenhum vestígio é instalação nova", () => {
    expect(classifyWireSockInstallState({ compatiblePair: false, installDir: false, registered: false, driverService: false })).toBe("none");
  });

  it("par compatível vence qualquer resíduo", () => {
    expect(classifyWireSockInstallState({ compatiblePair: true, installDir: true, registered: true, driverService: true })).toBe("compatible");
  });

  it("instalação pela metade é removida antes de instalar", async () => {
    const run = makeInstallOfficial();
    const { ctx, modes, restores } = installCtx({ state: "stale" });
    const progress: string[] = [];
    await expect(run(ctx, (message: string) => progress.push(message))).resolves.toContain("wiresock-client.exe");
    expect(modes).toEqual(["uninstall", "install"]);
    expect(progress.some((message) => /Removendo a instalação anterior/i.test(message))).toBe(true);
    // Instalação bem-sucedida não paga UAC de restauração.
    expect(restores).toEqual([]);
  });

  it("instalação que não deixa par compatível cai no reparo", async () => {
    const run = makeInstallOfficial();
    const { ctx, modes } = installCtx({ state: "stale", pairAfterInstall: null });
    const progress: string[] = [];
    await expect(run(ctx, (message: string) => progress.push(message))).rejects.toThrow(/não deixou um par WireSock SDK compatível/);
    expect(modes).toEqual(["uninstall", "install", "repair"]);
    expect(progress.some((message) => /Reparando a instalação/i.test(message))).toBe(true);
  });

  it("falha total força a recuperação de rede e avisa que a rede voltou", async () => {
    const run = makeInstallOfficial();
    const { ctx, restores } = installCtx({ pairAfterInstall: null });
    await expect(run(ctx, () => {})).rejects.toThrow(/A rede do Windows foi restaurada/);
    expect(restores).toEqual([{ reason: "instalacao-falhou", force: true }]);
  });

  it("cancelamento do usuário não mexe na rede", async () => {
    const run = makeInstallOfficial();
    const { ctx, restores } = installCtx({ state: "stale", cancelOn: "install" });
    await expect(run(ctx, () => {})).rejects.toThrow(/cancelada pelo usuário/);
    expect(restores).toEqual([]);
  });

  it.each([
    ["rota default órfã no adaptador virtual", { adapterDefaultRoute: true, driverService: false, clientInstalled: true }],
    ["driver carregado sem cliente", { adapterDefaultRoute: false, driverService: true, clientInstalled: false }],
  ])("resíduo que segura a rede pede recuperação: %s", (_nome, residuo) => {
    expect(wireSockResidueNeedsRestore(residuo)).toBe(true);
  });

  it.each([
    ["instalado e desligado", { adapterDefaultRoute: false, driverService: true, clientInstalled: true }],
    ["nada de WireSock", { adapterDefaultRoute: false, driverService: false, clientInstalled: false }],
  ])("máquina saudável não abre UAC de restauração: %s", (_nome, residuo) => {
    expect(wireSockResidueNeedsRestore(residuo)).toBe(false);
  });

  it("rota default do ProTUN é órfã; a do Wi-Fi não é", () => {
    const protun = [
      "Publish  Type      Subnet Prefix      Next Hop        If Metric",
      "------  --------  -----------------  --------------  ---- ------",
      "     0.0.0.0/0                    10.2.0.1    ProTUN     5",
      "    0.0.0.0/0                  192.168.0.1      Wi-Fi    25",
    ].join("\n");
    expect(parseWireSockOrphanDefaultRoutes(protun)).toBe(true);
    expect(parseWireSockOrphanDefaultRoutes(protun.split("\n").filter((line) => !/ProTUN/.test(line)).join("\n"))).toBe(false);
  });

  it("registro do Windows é lido do JSON do PowerShell", () => {
    expect(parseWireSockUninstallEntries('[{"name":"WireSock Secure Connect"}]')).toEqual(["WireSock Secure Connect"]);
    expect(parseWireSockUninstallEntries('{"name":"WGLaunch"}')).toEqual(["WGLaunch"]);
    expect(parseWireSockUninstallEntries("[]")).toEqual([]);
    expect(parseWireSockUninstallEntries("")).toEqual([]);
    expect(parseWireSockUninstallEntries('[{"name":""}]')).toEqual([]);
  });

  it("script de recuperação usa o reset oficial do driver e recusa com túnel vivo", () => {
    const script = wireSockNetworkRestoreScript(["C:\\Program Files\\WireSock Secure Connect\\wiresock-client.exe"], "C:\\Temp\\result.json");
    expect(script).toContain("reset-network-lock");
    // O lock só é tocado sem nenhum wiresock-client em execução.
    expect(script.indexOf("$running = @(")).toBeLessThan(script.indexOf("reset-network-lock"));
    expect(script).toContain("WIRESOCK_RUNNING");
    expect(script).toContain("0.0.0.0/0");
    expect(script).toContain("ipconfig.exe /flushdns");
    expect(script).toContain("C:\\Temp\\result.json");
    expect(() => wireSockNetworkRestoreScript(["ok"], 'C:\\"quebrado.json')).toThrow(/Caminho WireSock inválido/);
  });

  it("modos do setup cobrem instalar, remover e reparar", () => {
    expect(wireSockInstallerArguments("install")).toEqual(["/quiet", "/norestart"]);
    expect(wireSockInstallerArguments("uninstall")).toEqual(["/uninstall", "/quiet", "/norestart"]);
    expect(wireSockInstallerArguments("repair")).toEqual(["/repair", "/quiet", "/norestart"]);
  });

  it("verifica o par depois que a instalação assenta, não no instante do setup", () => {
    const run = makeInstallOfficial();
    const { ctx } = installCtx();
    let checks = 0;
    // O msiexec continua depois do setup devolver (medido no Windows 11): o par
    // só aparece na terceira checagem. Verificar uma vez daria falso negativo.
    ctx.findCompatibleWireSockAsync = async () => {
      checks += 1;
      return checks >= 3 ? "C:\\WireSock\\wiresock-client.exe" : null;
    };
    ctx.waitForCompatibleWireSock = async () => {
      for (;;) {
        const found = await ctx.findCompatibleWireSockAsync();
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    };
    return expect(run(ctx, () => {})).resolves.toBe("C:\\WireSock\\wiresock-client.exe");
  });

  it("espera de assentamento tem prazo: par que não aparece vira falha, não travar", async () => {
    const runner = new Function(`return async function(ctx, timeoutMs) {
      const { findCompatibleWireSockAsync } = ctx;
      const esperar = async () => {};
      ${bodyOf("waitForCompatibleWireSock")}
    }`)();
    let checks = 0;
    const found = await runner({
      findCompatibleWireSockAsync: async () => { checks += 1; return null; },
    }, 0);
    expect(found).toBeNull();
    // Com prazo zero a checagem e unica: existe, e nao trava esperando.
    expect(checks).toBe(1);
  });

  it("dica final distingue rede restaurada de rede não confirmada", () => {
    expect(wireSockInstallFailureHint(restoreOk)).toMatch(/rede do Windows foi restaurada/);
    expect(wireSockInstallFailureHint({ ...restoreOk, executed: false })).toBe("");
    // A sonda é o que autoriza a afirmação de rede recuperada.
    expect(wireSockInstallFailureHint(restoreOk, { ok: true, dnsOk: true, httpsOk: true, updaterDnsOk: true, updaterHttpsOk: true })).toMatch(/A rede foi comprobada\./);
    expect(wireSockInstallFailureHint(restoreOk, {
      ok: false, dnsOk: true, httpsOk: false, updaterDnsOk: true, updaterHttpsOk: false, error: "HTTPS nao alcançou a internet",
    })).toMatch(/A rede ainda não responde \(HTTPS nao alcançou a internet\)\./);
    expect(wireSockInstallFailureHint({
      ok: false, executed: true, networkLockReset: false, dnsFlushed: false, adapterRoutesCleared: false, residual: ["NETWORK_LOCK_FAILED: codigo=1"],
    })).toMatch(/não foi possível confirmar a rede[\s\S]*NETWORK_LOCK_FAILED/);
  });
});

describe("recuperação de rede compartilhada", () => {
  function makeRecover() {
    // O corpo transpilado traz o diretivo "use strict", illegal em uma lista de
    // parâmetros com valor padrão; aqui ele é removido.
    const body = bodyOf("recoverWireSockNetwork").replace(/^\s*(['"])use strict\1;\s*/, "");
    return new Function(`return async function(ctx, callOptions) {
      const { stopWireSockService, verifyWindowsNetworkStable, restoreWireSockNetwork, logger } = ctx;
      const recoverWireSockNetwork = async function(options = {}) { ${body} };
      return recoverWireSockNetwork(callOptions);
    }`)();
  }

  function recoverCtx(stopped: boolean, restore: WireSockNetworkRestoreResult) {
    const calls: Array<{ reason: string; force?: boolean }> = [];
    return {
      calls,
      ctx: {
        stopWireSockService: async () => ({
          stopped, attempts: 1, resetNetworkLock: false, dnsCleared: true, dnsFlushed: true,
          servicesResidual: [], processResidual: false, residual: [],
        }),
        verifyWindowsNetworkStable: async () => ({ ok: true, dnsOk: true, httpsOk: true, updaterDnsOk: true, updaterHttpsOk: true }),
        restoreWireSockNetwork: async (reason: string, opts: { force?: boolean } = {}) => { calls.push({ reason, force: opts.force }); return restore; },
        logger: { info: () => {}, warn: () => {}, logEvent: () => {} },
      },
    };
  }

  it("restauração de rede confirmada mantém a recuperação como sucesso", async () => {
    const run = makeRecover();
    const { ctx, calls } = recoverCtx(true, restoreOk);
    const result = await run(ctx, {});
    expect(result.ok).toBe(true);
    expect(result.networkRestore.networkLockReset).toBe(true);
    expect(calls).toEqual([{ reason: "recuperacao", force: undefined }]);
  });

  it("rede não confirmada derruba o ok e explica o motivo", async () => {
    const run = makeRecover();
    const { ctx } = recoverCtx(true, {
      ok: false, executed: true, networkLockReset: false, dnsFlushed: true, adapterRoutesCleared: true, residual: ["WIRESOCK_CLIENT_MISSING"],
    });
    const result = await run(ctx, {});
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/WIRESOCK_CLIENT_MISSING/);
  });

  it("restauração ignorada por não haver resíduo não contamina o resultado", async () => {
    const run = makeRecover();
    const { ctx } = recoverCtx(true, { ...restoreOk, executed: false });
    const result = await run(ctx, {});
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("rede sem saída força a restauração do fornecedor", async () => {
    const run = makeRecover();
    const { ctx, calls } = recoverCtx(true, restoreOk);
    await run(ctx, { forceNetworkRestore: true });
    expect(calls).toEqual([{ reason: "recuperacao", force: true }]);
  });
});
