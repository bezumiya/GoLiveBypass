import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

// A decisao da guarda vive no main.ts com estado de modulo (ativacaoCorrente /
// assinaturaUltimaAtivacao), entao o que se testa aqui e a logica de decisao,
// espelhada, mais o fato de ela existir e estar ligada no activateBypass.
// A guarda existe por causa da #145: duas ativacoes em 7s (boot + clique com
// status velho) injetaram duas vezes e a segunda derrubou o gateway recem-nascido.

function assinaturaAtivacao(proxy: string, modo: string): string {
  return JSON.stringify({ proxy: proxy.trim(), modo });
}

function devePularReativacao(args: {
  assinatura: string;
  assinaturaAnterior: string;
  status: string;
}): boolean {
  return (
    args.assinatura === args.assinaturaAnterior &&
    args.status === "ACTIVE"
  );
}

describe("guarda de ativacao duplicada", () => {
  const base = {
    assinaturaAnterior: assinaturaAtivacao("", "tor"),
    status: "ACTIVE",
  };

  it("pula quando ja ativo com a mesma configuracao", () => {
    expect(
      devePularReativacao({ ...base, assinatura: assinaturaAtivacao("", "tor") }),
    ).toBe(true);
  });

  it("normaliza espacos da proxy na assinatura (o campo da UI vem com espaco a mais)", () => {
    expect(assinaturaAtivacao("  ", "tor")).toBe(assinaturaAtivacao("", "tor"));
    expect(
      devePularReativacao({
        ...base,
        assinaturaAnterior: assinaturaAtivacao("socks5://x:1080", "tor"),
        assinatura: assinaturaAtivacao(" socks5://x:1080 ", "tor"),
      }),
    ).toBe(true);
  });

  it("nao pula quando a proxy mudou (re-injecao legitima)", () => {
    expect(
      devePularReativacao({ ...base, assinatura: assinaturaAtivacao("socks5://x:1080", "tor") }),
    ).toBe(false);
  });

  it("nao pula quando o modo mudou", () => {
    expect(
      devePularReativacao({ ...base, assinatura: assinaturaAtivacao("", "free") }),
    ).toBe(false);
  });

  it("nao pula com status INACTIVE (o activate precisa re-injetar)", () => {
    expect(
      devePularReativacao({ ...base, status: "INACTIVE", assinatura: assinaturaAtivacao("", "tor") }),
    ).toBe(false);
  });

  it("pula sem consultar o estado de injecao legado", () => {
    expect(devePularReativacao({ ...base, assinatura: assinaturaAtivacao("", "tor") })).toBe(true);
  });

  it("o main.ts realmente serializa ativacoes e compara a assinatura antes de injetar", () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), "electron/main.ts"), "utf8");
    expect(src).toContain("if (ativacaoCorrente !== null)");
    expect(src).toContain("assinaturaUltimaAtivacao = assinatura;");
    expect(src).toContain('getStatus() === "ACTIVE"');
  });

  it("a reativacao de boot atualiza janela e bandeja no fim (sucesso ou falha)", () => {
    // Relato do testador na beta 4 (#149): a janela carregava no meio da
    // reativacao e o botao ficava em "Ativar" com o bypass ja de pe.
    const src = fs.readFileSync(path.resolve(process.cwd(), "electron/main.ts"), "utf8");
    expect(src).toMatch(/autoInject: bypass reativado"[\s\S]{0,600}refreshWindowStatus\(\);/);
    expect(src).toMatch(/autoInject falhou:[\s\S]{0,600}refreshWindowStatus\(\);/);
  });

  it("o boot migra o estado legado para WireGuard", () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), "electron/main.ts"), "utf8");
    expect(src).toContain("sistema WireGuard ativo; configuracao legada removida");
  });

  it("remove dados de proxy e Tor da configuracao compartilhada", () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), "electron/main.ts"), "utf8");
    expect(src).toContain("delete novo.proxy;");
    expect(src).toContain("delete novo.torAddr;");
  });

  it("desativar WireSock serializa a recuperacao e so relanca o Discord apos validacao", () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), "electron/main.ts"), "utf8");
    const fnStart = src.indexOf("async function deactivateAll()");
    const fnBody = src.slice(fnStart, fnStart + 2200);
    expect(fnBody).toContain("const hadWireSock = IS_WINDOWS && isWireSockActive();");
    expect(fnBody).toContain('withWireSockLifecycle("desativacao"');
    expect(fnBody).toMatch(/await killDiscord\(\);[\s\S]{0,300}await recoverWireSockNetwork\(\);[\s\S]{0,500}startDiscordAndConfirm\(installs, "desativacao"\)/);
    expect(fnBody).toContain("if (!recovery.ok)");
  });

  it("nao relanca o Discord enquanto a restauracao do WireSock ou da rede falhou", () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), "electron/main.ts"), "utf8");
    const fnStart = src.indexOf('ipcMain.handle("restore-internet"');
    const fnBody = src.slice(fnStart, src.indexOf('ipcMain.handle("get-platform"', fnStart));
    expect(fnBody).toContain('withWireSockLifecycle("restaurar-internet"');
    expect(fnBody).toContain("const recovery = await recoverWireSockNetwork();");
    expect(fnBody).toContain("if (hadWireSock && recovery.ok)");
    expect(fnBody).toContain("const hadWireSock = isWireSockActive();");
  });

  it("inicia o túnel antes do cliente e observa a rota em segundo plano", () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), "electron/main.ts"), "utf8");
    expect(src).toContain('runScript(["--refresh-route"])');
    expect(src).not.toContain('runScript(["--deactivate"]);\n        await runScript(["--activate"]);');
    expect(src).toContain('withWireSockLifecycle("troca-rota-proton"');
    expect(src).toContain('await killDiscord();');

    const activation = src.slice(src.indexOf("async function executarAtivacao"), src.indexOf("async function deactivateAll"));
    expect(activation).not.toContain("requireFunctionalWindowsRoute");
    expect(activation).not.toContain("prepareDiscordScopeProbes");
    expect(activation.indexOf("await startWireSockService")).toBeLessThan(activation.indexOf('startDiscordAndConfirm(installs, "ativacao")'));
    expect(activation.indexOf('waitForWindowsRouteSettle(windowsGeneration, "ativacao")')).toBeGreaterThan(activation.indexOf("await startWireSockService"));
    expect(activation.indexOf('waitForWindowsRouteSettle(windowsGeneration, "ativacao")')).toBeLessThan(activation.indexOf('startDiscordAndConfirm(installs, "ativacao")'));
    expect(activation.indexOf('startDiscordAndConfirm(installs, "ativacao")')).toBeLessThan(activation.indexOf("startWindowsRouteWatchdog()"));

    const readinessStart = src.indexOf("async function waitForWindowsWgReady");
    const readiness = src.slice(readinessStart, src.indexOf("function linuxStatus", readinessStart));
    expect(readiness).toContain("hasWireSockAdapterTrafficIncrease");
    expect(readiness).toContain('"rota.confirmada.protun"');
    expect(readiness).not.toContain("verifyWindowsNetworkStable");
    expect(readiness).not.toContain("throw new Error(`WireGuard iniciou");
    expect(readiness).toContain('"disconnected" : "unverified"');

    const ui = fs.readFileSync(path.resolve(process.cwd(), "index.html"), "utf8");
    expect(ui).toContain("O Discord abre quando o túnel é iniciado");
  });

  it("usa uma fila unica para operacoes concorrentes do WireSock", () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), "electron/main.ts"), "utf8");
    expect(src).toContain("let wireSockLifecycleQueue: Promise<void> = Promise.resolve();");
    expect(src).toContain("wireSockLifecycleQueue = run.then(() => undefined, () => undefined);");
  });

  it("descarta provas atrasadas e nao herda ACTIVE depois de reinicio", () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), "electron/main.ts"), "utf8");
    expect(src).toContain("windowsRouteGeneration += 1;");
    expect(src).toContain("assertWindowsRouteGeneration(generation)");
    expect(src).toContain('if (IS_WINDOWS && sessaoAtiva())');
    expect(src).toContain('await activateBypass({});');
    const statusStart = src.indexOf("function getStatus():");
    const status = src.slice(statusStart, src.indexOf("async function linuxStatus", statusStart));
    expect(status).toContain('return "CONNECTING"');
    expect(status).toContain('return "RECOVERY_REQUIRED"');
    expect(status).toContain("windowsRouteStarted && isWireSockActive() && discordIsRunning()");
  });

  it("aguarda a limpeza WireSock terminar antes de concluir o quit", () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), "electron/main.ts"), "utf8");
    const beforeQuit = src.slice(src.indexOf('app.on("before-quit"'), src.indexOf('app.on("window-all-closed"'));
    expect(beforeQuit).toMatch(/const restore = IS_LINUX\s*\?\s*(?:withWireSockLifecycle\("encerrar-linux",\s*\(\) =>\s*)?linuxDeactivate\(\(\) => \{\}\)/);
    expect(beforeQuit).toContain(".finally(() => app.quit());");
    expect(beforeQuit).not.toMatch(/restore\.catch\(\(\) => \{\}\);[\s\S]*app\.quit\(\);/);
  });

  it("serializa a geracao Proton antes de persistir e aplicar a rota", () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), "electron/main.ts"), "utf8");
    const fnStart = src.indexOf('ipcMain.handle("optimize-proton-route"');
    const fnBody = src.slice(fnStart, src.indexOf('ipcMain.handle("report-bug"', fnStart));
    expect(fnBody).toMatch(/return withWireSockLifecycle\("troca-rota-proton", async \(\) => \{/);
    expect(fnBody.indexOf("return withWireSockLifecycle")).toBeLessThan(fnBody.indexOf("proton.generateOptimalProtonConfig"));
    expect(fnBody).not.toMatch(/withWireSockLifecycle\("troca-rota-proton"[\s\S]*withWireSockLifecycle\("troca-rota-proton"/);
  });

  it("mantém o IPC automático separado da seleção manual", () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), "electron/main.ts"), "utf8");
    const automaticStart = src.indexOf('ipcMain.handle("optimize-proton-route"');
    const automaticEnd = src.indexOf('ipcMain.handle("report-bug"', automaticStart);
    const automatic = src.slice(automaticStart, automaticEnd);
    const manualStart = src.indexOf('ipcMain.handle("select-proton-route"');
    const manual = src.slice(manualStart, src.indexOf('ipcMain.handle("report-bug"', manualStart));

    expect(manualStart).toBeGreaterThan(automaticStart);
    expect(automatic).not.toContain("generateManualProtonConfig");
    expect(automatic).not.toContain("-manual-probe");
    expect(manual).toContain("generateManualProtonConfig");
    expect(manual).toContain('withWireSockLifecycle("selecionar-rota-manual"');
    expect(manual).toContain("measurementId");
    expect(manual).toContain("ownerId");
  });

  it("faz backup antes da promoção manual e restaura em falha", () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), "electron/main.ts"), "utf8");
    const start = src.indexOf('ipcMain.handle("select-proton-route"');
    const body = src.slice(start, src.indexOf('ipcMain.handle("report-bug"', start));

    expect(body.indexOf("backupProtonConfig")).toBeLessThan(body.indexOf("promoteStagedProtonConfig"));
    expect(body).toContain("restoreProtonConfigBackup");
    expect(body).toContain("removeStagedProtonConfig");
    expect(body).toContain("manualRouteSelectionsInFlight");
  });

  it("mantem o diagnostico centrado no WireGuard", () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), "electron/main.ts"), "utf8");
    expect(src).toContain('updateSharedSettings({ routeMode: "wireguard" });');
    expect(src).toContain("getWireSockConnectionStatus");
  });

  it("no Windows ativa WireSock sem ler, esperar ou alterar app.asar", () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), "electron/main.ts"), "utf8");
    const activation = src.slice(src.indexOf("async function executarAtivacao"), src.indexOf("async function deactivateAll"));
    expect(activation).toContain("await startWireSockService(settingsDir(), undefined, windowsAllowedAppPaths(installs))");
    expect(src).not.toContain("apps.add(path.basename(probeExe));");
    expect(activation).not.toContain("app.asar");
    expect(activation).not.toContain("assertResourcesWritable");
    expect(activation).not.toContain("isOurInjection");
  });

  it("nao altera a rota enquanto o Discord anterior ainda esta vivo", () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), "electron/main.ts"), "utf8");
    const kill = src.slice(src.indexOf("async function killDiscord"), src.indexOf("function assertResourcesWritable"));
    expect(src).toContain('logger.error("discord", "encerramento.timeout"');
    expect(kill).toContain("discordDidNotStop()");
    const activation = src.slice(src.indexOf("async function executarAtivacao"), src.indexOf("async function deactivateAll"));
    expect(activation.indexOf("await killDiscord()")).toBeLessThan(
      activation.indexOf("await startWireSockService(settingsDir(), undefined, windowsAllowedAppPaths(installs))"),
    );
  });

  it("trata falha de tasklist como estado desconhecido, nunca como Discord encerrado", () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), "electron/main.ts"), "utf8");
    const probe = src.slice(src.indexOf("function discordProcessState"), src.indexOf("function discordDidNotStop"));
    expect(probe).toContain('return probeFailed ? "unknown" : "stopped"');
    expect(probe).toContain("waitForProcessStopped(() => discordProcessState()");
  });

  it("confirma que o Update.exe do Discord saiu antes de trocar a rota", () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), "electron/main.ts"), "utf8");
    const updaterProbe = src.slice(src.indexOf("function discordUpdaterProcessState"), src.indexOf("function killMacProcesses"));
    expect(updaterProbe).toContain("$_ .CommandLine".replace("$_ .", "$_."));
    expect(updaterProbe).toContain('return "unknown"');
    expect(updaterProbe).toContain("waitUntilDiscordUpdaterGone");

    const kill = src.slice(src.indexOf("async function killDiscord"), src.indexOf("function assertResourcesWritable"));
    expect(kill).toMatch(/killDiscordUpdater\(\);[\s\S]{0,500}waitUntilDiscordUpdaterGone/);
    expect(kill).toContain("discordUpdaterDidNotStop()");
  });

  it("nao declara recuperacao concluida se o Discord nao voltar depois da rede", () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), "electron/main.ts"), "utf8");
    const restart = src.slice(src.indexOf("async function startDiscordAndConfirm"), src.indexOf("function isOurInjection"));
    expect(restart).toContain("waitUntilDiscordRunning()");
    expect(restart).toContain('"reinicio.timeout"');

    const deactivation = src.slice(src.indexOf("async function deactivateAll"), src.indexOf("function getStatus"));
    expect(deactivation).toContain('startDiscordAndConfirm(installs, "desativacao")');
    expect(deactivation).toContain("A rede foi restaurada, mas o Discord não iniciou");

    const restore = src.slice(src.indexOf('ipcMain.handle("restore-internet"'), src.indexOf('ipcMain.handle("get-platform"'));
    expect(restore).toContain('startDiscordAndConfirm(getDiscordInstalls(), "restaurar-internet")');
    expect(restore).toContain("ok: false");
  });

  it("valida o tunel antes de iniciar o Discord e desfaz WireSock quando o spawn nao produz processo", () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), "electron/main.ts"), "utf8");
    const activation = src.slice(src.indexOf("async function executarAtivacao"), src.indexOf("async function deactivateAll"));
    expect(activation).toContain('startDiscordAndConfirm(installs, "ativacao")');
    const proofCall = 'await startWireSockService';
    expect(activation).toContain(proofCall);
    expect(activation.indexOf(proofCall)).toBeLessThan(
      activation.indexOf('startDiscordAndConfirm(installs, "ativacao")'),
    );
    expect(activation).toContain('withWireSockLifecycle("ativacao.rollback"');
    expect(activation).toContain("await recoverWireSockNetwork()");
    const start = src.slice(src.indexOf("function startDiscord"), src.indexOf("function isOurInjection"));
    expect(start).toContain('child.once("error"');
  });

  it("reverte WireSock parcialmente instalado quando a ativacao falha antes do Discord iniciar", () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), "electron/main.ts"), "utf8");
    const activation = src.slice(src.indexOf("async function executarAtivacao"), src.indexOf("async function deactivateAll"));
    expect(activation).toContain('withWireSockLifecycle("ativacao.rollback", () => recoverWireSockNetwork())');
    expect(activation).toContain('logger.error("wiresock", "ativacao.falhou_revertida"');
    expect(activation).toContain("clearSessionMarker();");
    expect(activation).toContain("pararWgStatsWatchdog();");
    const rollback = activation.slice(activation.indexOf("} catch (cause)"), activation.indexOf("if (!windowsDiscordStarted)"));
    expect(rollback.indexOf("await killDiscord()")).toBeLessThan(rollback.indexOf("recoverWireSockNetwork()"));
  });
});
