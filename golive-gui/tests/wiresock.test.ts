import { describe, expect, it } from "vitest";
import { elevatedPowerShellFileArgs, wireSockDirectScript, wireSockServiceScript } from "../electron/wiresock-service";
import fs from "fs";
import os from "os";
import path from "path";
import { classifyWireSockActivationFailure, classifyWireSockDirectResult, findWireSockInKnownRoots, formatAllowedApps, hasWireSockAdapterTrafficIncrease, mayUseServiceCompatibility, parseWireSockCliExternalAddress, parseWireSockCliStatus, verifyWindowsNetworkStable, wireSockDriverQueryShowsInstalled, wireSockInstallerExitKind, wireSockSearchRoots } from "../electron/wiresock";

describe("WireSock no Windows", () => {
  it("preserva caminhos Unicode nos arquivos usados pelo Windows PowerShell 5.1", () => {
    const executable = "C:\\Usuários\\João\\WireSock\\client.exe";
    const config = "C:\\Usuários\\João\\perfil.conf";
    const result = "C:\\Usuários\\João\\resultado.txt";
    for (const script of [wireSockServiceScript(executable, config, result), wireSockDirectScript(executable, config, result)]) {
      const bytes = Buffer.from(script, "utf8");
      expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      const decoded = new TextDecoder("utf-8").decode(bytes);
      expect(decoded).toContain(executable);
      expect(decoded).toContain(config);
      expect(decoded).toContain(result);
    }
  });

  it("preserva whitespace e palavras do diagnóstico capturado", () => {
    const script = wireSockDirectScript("C:\\ws.exe", "C:\\wg.conf", "C:\\result.txt");
    const pattern = script.match(/\[regex\]::Replace\(\$text, '([^']+)'/)?.[1];
    expect(pattern).toBe("\\s+");
    expect("unknown command\r\nservice\tunsupported".replace(new RegExp(pattern!, "g"), " ")).toBe("unknown command service unsupported");
  });

  it("classifica a falha do serviço sem recomendar reinstalação sem evidência", () => {
    expect(classifyWireSockActivationFailure("START_FAILED: Win32ExitCode=1060")).toMatchObject({ code: "WIRESOCK_SERVICE" });
    expect(classifyWireSockActivationFailure("START_FAILED: Win32ExitCode=1060").message).not.toMatch(/reinstale/i);
    const src = fs.readFileSync(path.resolve(process.cwd(), "electron/wiresock.ts"), "utf8");
    expect(src).not.toContain('classifyWireSockActivationFailure(directFailure + " " + serviceDetail)');
    expect(src).toContain('classifyWireSockActivationFailure(serviceDetail ||');
  });

  it("classifica cancelamento e reboot do instalador sem permitir retry silencioso", () => {
    expect(wireSockInstallerExitKind({ code: 1223 })).toBe("cancel");
    expect(wireSockInstallerExitKind({ code: 3010 })).toBe("reboot");
    expect(wireSockInstallerExitKind({ code: 1641 })).toBe("reboot");
    expect(wireSockInstallerExitKind({ code: 1 })).toBe("failure");
  });

  it("transforma falhas localizadas do Windows em orientações acionáveis", () => {
    expect(classifyWireSockActivationFailure({ stderr: "GOLIVE_WIRESOCK_ERROR: Access is denied" })).toMatchObject({
      kind: "permission",
      code: "WIRESOCK_PERMISSION",
    });
    expect(classifyWireSockActivationFailure({ stderr: "START_FAILED: driver ndiswg not ready" })).toMatchObject({
      kind: "driver",
      code: "WIRESOCK_DRIVER",
    });
    expect(classifyWireSockActivationFailure({ stderr: "STOP_TIMEOUT: estado=StopPending" })).toMatchObject({
      kind: "timeout",
      code: "WIRESOCK_TIMEOUT",
    });
    expect(classifyWireSockActivationFailure({ stderr: "DIRECT_EXITED: codigo=0" })).toMatchObject({
      kind: "process",
      code: "WIRESOCK_PROCESS",
    });
    expect(classifyWireSockActivationFailure({ stderr: "GOLIVE_WIRESOCK_DIRECT_ERROR: timeout" })).toMatchObject({
      kind: "process",
      code: "WIRESOCK_PROCESS",
    });
    expect(classifyWireSockActivationFailure({ stderr: "CONFIG_FAILED: AllowedApps inválido" })).toMatchObject({
      kind: "profile",
      code: "WIRESOCK_PROFILE",
    });
    expect(classifyWireSockActivationFailure({ stderr: "Command failed: activate-service.ps1" })).toMatchObject({
      kind: "unknown",
      code: "WIRESOCK_UNKNOWN",
    });
  });

  it("reconhece drivers WireSock atual e legado sem confundir servico comum", () => {
    expect(wireSockDriverQueryShowsInstalled("SERVICE_NAME: NDISRD\n        STATE: 4 RUNNING")).toBe(true);
    expect(wireSockDriverQueryShowsInstalled("SERVICE_NAME: ndiswg\nDISPLAY_NAME: WireSock VPN Client Filter Driver\nSTATE: 4 RUNNING")).toBe(true);
    expect(wireSockDriverQueryShowsInstalled("OpenService FAILED 1060: service does not exist")).toBe(false);
    expect(wireSockDriverQueryShowsInstalled("SERVICE_NAME: wiresock-client-service")).toBe(false);
  });

  it("gera AllowedApps por caminho absoluto sem duplicatas ambiguas", () => {
    expect(formatAllowedApps([
      "C:\\Apps\\Discord.exe",
      "c:\\apps\\discord.exe",
      "C:\\GoLiveBypass\\proton-confgen.exe",
    ])).toBe("C:\\Apps\\Discord.exe, C:\\GoLiveBypass\\proton-confgen.exe");
    expect(() => formatAllowedApps(["C:\\Apps, Inc\\Discord.exe"])).toThrow("AllowedApps");
  });

  it("torna a configuração do serviço idempotente e preserva detalhes do SCM no log", () => {
    const script = wireSockServiceScript("C:\\WireSock\\client.exe", "C:\\GoLive\\wg.conf", "C:\\Temp\\result.txt");
    expect(script).toContain("Wait-WireSockState $serviceName 'Stopped' 45");
    expect(script).toContain("for ($attempt = 1; $attempt -le 2; $attempt++)");
    expect(script).toContain("GOLIVE_WIRESOCK_ERROR");
    expect(script).toContain("ServiceSpecificExitCode");
    expect(script).toContain("Win32ExitCode");
    expect(script).toContain("SERVICE_RUNNING");
    expect(script).toContain("wiresock-pro-client-service");
    expect(script).toContain("$name = [string]$serviceInfo.Name");
    expect(script).toContain("pid=$($running.ProcessId)");
    expect(script).toContain("ServiceSpecificExitCode=$($info.ServiceSpecificExitCode) erro=$startMessage");
    expect(script).toContain("[IO.File]::WriteAllText");
  });

  it("gera fallback direto elevado sem depender do serviço global", () => {
    const script = wireSockDirectScript(
      "C:\\WireSock\\client.exe",
      "C:\\GoLive\\wg.conf",
      "C:\\Temp\\direct-result.txt",
    );
    expect(script).toContain("@('run', '-config'");
    expect(script).toContain("DIRECT_RUNNING: pid=");
    expect(script).toContain("wiresock-pro-client-service");
    expect(script).toContain("Stop-Process -Force");
    expect(script).toContain("-network-lock', 'disabled'");
    expect(script).toContain("-RedirectStandardOutput");
    expect(script).toContain("-RedirectStandardError");
    expect(script).toContain("Read-Captured");
    expect(script).toContain("DIRECT_EXITED: codigo=");
    expect(script).toContain("$processHandle = $child.Handle");
    expect(script.indexOf("$processHandle = $child.Handle")).toBeLessThan(script.indexOf("$child.Refresh()"));
    expect(script).toContain("$child.WaitForExit()");
  });

  it("aceita somente o processo próprio e reserva o serviço para incompatibilidade explícita", () => {
    const exited = classifyWireSockDirectResult("GOLIVE_WIRESOCK_DIRECT_ERROR: DIRECT_EXITED: codigo=0 stdout=unknown command run DIRECT_RUNNING: pid=1234");
    expect(exited).toMatchObject({ kind: "failed", code: "WIRESOCK_DIRECT_EXITED_0" });
    expect(mayUseServiceCompatibility(exited)).toBe(false);
    expect(classifyWireSockDirectResult("DIRECT_EXITED: codigo=7 stdout=DIRECT_RUNNING: pid=1234").kind).toBe("failed");
    expect(classifyWireSockDirectResult("DIRECT_RUNNING: pid=1234")).toMatchObject({ kind: "running", pid: 1234 });
    expect(classifyWireSockDirectResult("DIRECT_EXITED: codigo=0")).toMatchObject({
      kind: "failed",
      code: "WIRESOCK_DIRECT_EXITED_0",
    });
    const unsupported = classifyWireSockDirectResult("GOLIVE_WIRESOCK_DIRECT_ERROR: unknown command run");
    expect(unsupported).toMatchObject({ kind: "unsupported", code: "WIRESOCK_DIRECT_UNSUPPORTED" });
    expect(mayUseServiceCompatibility(unsupported)).toBe(true);
    expect(mayUseServiceCompatibility(classifyWireSockDirectResult("DIRECT_EXITED: codigo=1"))).toBe(false);
    for (const detail of ["unknown command service", "unknown option -network-lock", "not recognized", "run -config option unsupported"]) {
      expect(mayUseServiceCompatibility(classifyWireSockDirectResult(`DIRECT_EXITED: codigo=7 stdout=${detail}`))).toBe(false);
    }
  });

  it("prioriza o modo direto oficial e não usa fallback genérico do serviço", () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), "electron/wiresock.ts"), "utf8");
    expect(src).toContain("wireSockDirectScript(wsExe, targetConf, directResultPath)");
    expect(src).toContain("classifyWireSockDirectResult");
    expect(src).toContain("mayUseServiceCompatibility(directResult)");
    expect(src).toContain("activation.compatibility_fallback");
    expect(src).toContain("wireSockServiceScript(wsExe, targetConf, serviceResultPath)");
    expect(src.indexOf("wireSockDirectScript(wsExe, targetConf, directResultPath)")).toBeLessThan(
      src.indexOf("wireSockServiceScript(wsExe, targetConf, serviceResultPath)"),
    );
    expect(src).toContain('directResult.kind === "running"');
    expect(src).toContain("await esperarProcessoWireSock(directResult.pid, 12, 250)");
    expect(src).not.toContain("directDetail.startsWith(\"DIRECT_RUNNING\")");
    expect(src).toContain('activationMode = "service"');
  });

  it("eleva um arquivo temporário para não estourar o limite de argumentos do Windows", () => {
    const args = elevatedPowerShellFileArgs("C:\\Users\\teste\\AppData\\Local\\Temp\\golive-wiresock\\activate-service.ps1");
    expect(args).toHaveLength(4);
    expect(args[2]).toBe("-EncodedCommand");
    const decoded = Buffer.from(args[3], "base64").toString("utf16le");
    expect(decoded).toContain("-File $scriptPath");
    expect(decoded).toContain("-ExecutionPolicy Bypass -File $scriptPath");
    expect(decoded).toContain("'-ExecutionPolicy','Bypass','-File'");
    expect(decoded).toContain("Start-Process powershell.exe -Verb RunAs");
    expect(decoded).not.toContain("GOLIVE_WIRESOCK_ERROR");
  });

  it("modo direto espera resultado proprio sem aguardar o worker de logs terminar", () => {
    const args = elevatedPowerShellFileArgs("C:\\teste\\direct.ps1", "C:\\teste\\result.txt");
    const decoded = Buffer.from(args[args.length - 1], "base64").toString("utf16le");
    expect(decoded).toContain("Start-Process @launch");
    expect(decoded).toContain("Test-Path -LiteralPath 'C:\\teste\\result.txt'");
    expect(decoded).toContain("DIRECT_WORKER_TIMEOUT");
    expect(decoded).not.toContain("-Wait");
    expect(decoded).toContain("exit [int]$Matches[1]");
  });

  it("inclui o diretorio app do Discord para cobrir todos os subprocessos", () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), "electron/main.ts"), "utf8");
    const fn = src.slice(src.indexOf("function windowsAllowedAppPaths"), src.indexOf("function logRouteProbe"));
    expect(fn).toContain("path.dirname(path.resolve(install.exePath))");
    expect(fn).not.toContain("proton.findProtonConfgenExe()");
  });

  it("emite a extensao AllowedApps com o prefixo aceito pelo SDK 3.x", () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), "electron/wiresock.ts"), "utf8");
    expect(src).toContain("#@ws:AllowedApps = ${allowedApps}");
    expect(src).not.toContain("return `AllowedApps = ${allowedApps}`");
  });

  it("tem um caminho de troca que não copia candidato para o wireguard.conf canônico", () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), "electron/wiresock.ts"), "utf8");
    const start = src.indexOf("export async function switchWireSockService");
    const body = src.slice(start, src.indexOf("export interface WireSockCleanupResult", start));
    expect(body).toContain("applyWireSockProfile");
    expect(body).toContain("O perfil de failover WireSock está fora");
    expect(body).not.toContain("ensureWireGuardConf");
  });

  it("oculta os processos auxiliares e as elevacoes do WireGuard", () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), "electron/wiresock.ts"), "utf8");
    expect(src).toContain("windowsHide: true");
    expect(src).toContain("-WindowStyle Hidden");
  });

  it("usa instalador oficial fixado quando não há par compatível", () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), "electron/wiresock.ts"), "utf8");
    expect(src).toContain("wiresock.net/_api/download-release.php");
    expect(src).toContain("/quiet");
    expect(src).toContain("/norestart");
    expect(src).toContain("abfeebdc645de36b95fabbed00c7fdb0bf4d0c68c5518608450619c61876d33e");
  });

  it("valida o instalador antes de elevar e deixa o driver como diagnostico", () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), "electron/wiresock.ts"), "utf8");
    expect(src).toContain("const hash = await");
    expect(src).toContain("hash.toLowerCase() !== WIRESOCK_INSTALLER_HASHES[platform.hash]");
    expect(src).toContain("-Verb RunAs");
    expect(src).toContain("driver nao ficou visivel ao processo; seguindo para prova funcional");
    expect(src).not.toContain("driver de filtro de rede (ndiswg/NDISRD) não foi carregado");
  });

  it("nao deixa DNS global nem network lock residual no fluxo normal", () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), "electron/wiresock.ts"), "utf8");
    expect(src).toContain("DNS\\s*=");
    expect(src).toContain("reset-network-lock");
    expect(src).toContain("ipconfig.exe /flushdns");
    expect(wireSockServiceScript("C:\\WireSock\\client.exe", "C:\\GoLive\\wg.conf")).toContain("-network-lock disabled");
  });

  it("encerra a arvore do cliente e aguarda o servico sair antes de confirmar a limpeza", () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), "electron/wiresock.ts"), "utf8");
    expect(src).toContain("taskkill.exe /F /T /IM wiresock-client.exe");
    expect(src).toContain("for (let pass = 0; pass < 2; pass++)");
    expect(src).toContain("residuo encontrado; repetindo limpeza elevada");
    expect(src).toContain("await esperar(250)");
    expect(src).toContain("sc.exe stop ${name}");
    expect(src).toContain("stopWireSockServiceElevated");
    expect(src).toContain("-Verb RunAs");
    expect(src).toContain("-PassThru");
    expect(src).toContain("windowsHide: false");
    expect(src).toContain("killWireSockProcessElevated");
  });

  it("retorna os detalhes da limpeza e valida DNS/HTTPS antes de declarar recuperacao", () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), "electron/wiresock.ts"), "utf8");
    expect(src).toContain("attempts: number");
    expect(src).toContain("servicesResidual: string[]");
    expect(src).toContain("processResidual: boolean");
    expect(src).toContain("export async function recoverWireSockNetwork");
    expect(src).toContain("void verifyWindowsNetworkStable().then");
    expect(src).toContain("ok: cleanup.stopped");
  });

  it("repete a sondagem para não liberar o Discord com DNS intermitente", () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), "electron/wiresock.ts"), "utf8");
    expect(src).toContain("export async function verifyWindowsNetworkStable(");
    expect(src).toContain("await esperar(Math.max(0, intervalMs))");
    expect(src).toContain("consecutiveOk = last.ok ? consecutiveOk + 1 : 0");
    expect(src).toContain("const maxAttempts = Math.max(total, total * 3)");
    expect(src).toContain("if (consecutiveOk < total)");
    expect(src).toContain("ok: false");
    expect(src).toContain("void verifyWindowsNetworkStable().then");
  });

  it("falha fechado quando as amostras positivas não são consecutivas", async () => {
    const ok = (): { ok: boolean; dnsOk: boolean; httpsOk: boolean; updaterDnsOk: boolean; updaterHttpsOk: boolean } => ({
      ok: true, dnsOk: true, httpsOk: true, updaterDnsOk: true, updaterHttpsOk: true,
    });
    const bad = (): { ok: boolean; dnsOk: boolean; httpsOk: boolean; updaterDnsOk: boolean; updaterHttpsOk: boolean; error: string } => ({
      ok: false, dnsOk: false, httpsOk: false, updaterDnsOk: false, updaterHttpsOk: false, error: "DNS intermitente",
    });
    const samples = [ok(), bad(), ok(), bad(), ok()];
    const result = await verifyWindowsNetworkStable(2, async () => samples.shift() ?? bad(), 0);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("DNS intermitente");

    const stable = await verifyWindowsNetworkStable(2, async () => ok(), 0);
    expect(stable.ok).toBe(true);
  });

  it("valida o endpoint do updater antes de liberar o Discord", () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), "electron/wiresock.ts"), "utf8");
    expect(src).toContain('dns.lookup("updates.discord.com")');
    expect(src).toContain('testarHttps("https://updates.discord.com/")');
    expect(src).toContain("updaterDnsOk && updaterHttpsOk");
    expect(src).toContain("DNS nao resolveu updates.discord.com");
  });

  it("interpreta os estados da CLI oficial sem depender do wg.exe", () => {
    expect(parseWireSockCliStatus("Status: Connected")).toBe("connected");
    expect(parseWireSockCliStatus("Status: NotConnected")).toBe("disconnected");
    expect(parseWireSockCliStatus("Status: Connecting")).toBe("connecting");
    expect(parseWireSockCliStatus("WireSock Secure Connect")).toBe("unknown");
    const src = fs.readFileSync(path.resolve(process.cwd(), "electron/wiresock.ts"), "utf8");
    expect(src).toContain("wiresock-connect-cli.exe");
    expect(src).toContain('source: "service"');
  });

  it("extrai endereco externo como prova funcional da CLI WireSock", () => {
    expect(parseWireSockCliExternalAddress("Status: Connected\nExternal address: 203.0.113.7")).toBe("203.0.113.7");
    expect(parseWireSockCliExternalAddress("Status: Connected")).toBeUndefined();
    const src = fs.readFileSync(path.resolve(process.cwd(), "electron/wiresock.ts"), "utf8");
    expect(src).toContain("externalAddress");
  });

  it("aceita somente crescimento bidirecional do ProTUN como prova de fluxo pelo tunel", () => {
    const before = { adapter: "ProTUN", receivedBytes: 100, sentBytes: 200 };
    expect(hasWireSockAdapterTrafficIncrease(null, before)).toBe(false);
    expect(hasWireSockAdapterTrafficIncrease(before, { ...before, receivedBytes: 101, sentBytes: 201 })).toBe(true);
    expect(hasWireSockAdapterTrafficIncrease(before, { ...before, receivedBytes: 101 })).toBe(false);
    expect(hasWireSockAdapterTrafficIncrease(before, { ...before, sentBytes: 201 })).toBe(false);
  });

  it("mantem a prontidao WireSock como diagnostico, sem reprovar a ativacao", () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), "electron/main.ts"), "utf8");
    const readinessStart = src.indexOf("async function waitForWindowsWgReady");
    const readiness = src.slice(readinessStart, src.indexOf("function linuxStatus", readinessStart));
    expect(readiness).toContain('"disconnected" : "unverified"');
    expect(readiness).not.toContain("throw new Error(`WireGuard iniciou");
    expect(src).toContain("void waitForWindowsWgReady()");
  });

  it("procura o executavel no layout do WinGet e na variante sem sdk", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wiresock-winget-"));
    try {
      const packageDir = path.join(root, "Microsoft", "WinGet", "Packages", "NTKERNEL.WireSockVPNClientCLI_Test");
      const executable = path.join(packageDir, "x64", "wiresock-client.exe");
      fs.mkdirSync(path.dirname(executable), { recursive: true });
      fs.writeFileSync(executable, "test");
      const found = findWireSockInKnownRoots({ LOCALAPPDATA: root, ProgramFiles: "", ProgramW6432: "", "ProgramFiles(x86)": "" });
      expect(found).toBe(executable);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("limita as raizes de busca aos locais de instalacao esperados", () => {
    const roots = wireSockSearchRoots({ LOCALAPPDATA: "C:\\Users\\teste\\AppData\\Local", ProgramFiles: "C:\\Program Files", PATH: "C:\\Arbitrary\\attacker-bin" });
    expect(roots).toContain(path.join("C:\\Program Files", "WireSock Secure Connect"));
    expect(roots).toContain(path.join("C:\\Users\\teste\\AppData\\Local", "Microsoft", "WinGet", "Packages"));
    expect(roots).not.toContain("C:\\Arbitrary\\attacker-bin");
    expect(roots.some((root) => root.includes("Windows\\System32"))).toBe(false);
  });
});
