import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { ProtonOptimizationCoordinator } from "../electron/proton-optimization";

const mainPath = path.resolve(process.cwd(), "electron/main.ts");
const mainSource = fs.readFileSync(mainPath, "utf8");
const mainFile = ts.createSourceFile(mainPath, mainSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

function handlerSource(): string {
  let body: ts.Block | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(mainFile) === "ipcMain.handle" &&
        node.arguments[0]?.getText(mainFile) === '"optimize-proton-route"') {
      const callback = node.arguments[1];
      if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) && callback.body && ts.isBlock(callback.body)) body = callback.body;
    }
    if (!body) ts.forEachChild(node, visit);
  };
  visit(mainFile);
  if (!body) throw new Error("handler optimize-proton-route não encontrado");
  return ts.transpileModule(`async function optimize(event, options) ${body.getText(mainFile)}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
}

type Harness = {
  run: (options?: Record<string, unknown>) => Promise<any>;
  settings: Record<string, any>;
  events: any[];
  calls: Record<string, number>;
  coordinator: ProtonOptimizationCoordinator;
  resolveGeneration?: () => void;
};

function makeHarness(overrides: Record<string, any> = {}): Harness {
  const settings: Record<string, any> = { protonUsername: "user@example.test" };
  const events: any[] = [];
  const calls: Record<string, number> = {};
  const sender = {
    id: 41,
    isDestroyed: () => false,
    send: (_channel: string, payload: any) => events.push(payload),
    once: () => {},
    removeListener: () => {},
  };
  const event = { sender };
  const coordinator = new ProtonOptimizationCoordinator();
  const ctx: any = new Proxy({
    isMac: false, IS_LINUX: false, IS_WINDOWS: false, quitting: false,
    settingsDir: () => "/tmp/test-settings",
    readSharedSettings: () => settings,
    updateSharedSettings: (patch: any) => { Object.assign(settings, patch); return true; },
    getStatus: () => "INACTIVE",
    linuxStatus: async () => "INACTIVE",
    isWireSockActive: () => false,
    withWireSockLifecycle: async (_name: string, task: () => Promise<any>) => task(),
    refreshWindowStatus: () => {}, refreshTray: async () => {},
    beginWindowsRouteOperation: () => 1, stopWindowsRouteWatchdog: () => {}, pararWgStatsWatchdog: () => {},
    windowsAllowedAppPaths: () => [], getDiscordInstalls: () => [], killDiscord: async () => { calls.killDiscord = (calls.killDiscord || 0) + 1; },
    recoverWireSockNetwork: async () => ({ ok: true, residual: [] }), startWireSockService: async () => { calls.startWireSock = (calls.startWireSock || 0) + 1; },
    startDiscordAndConfirm: async () => { calls.startDiscord = (calls.startDiscord || 0) + 1; return true; },
    waitForWindowsRouteSettle: async () => {},
    assertWindowsRouteGeneration: () => {}, windowsRouteStarted: false, windowsRouteState: "inactive",
    startWindowsRouteWatchdog: () => {}, iniciarWgStatsWatchdog: () => {}, waitForWindowsWgReady: async () => ({}),
    linuxDeactivate: async () => {}, linuxActivate: async () => {}, linuxPreflight: async () => ({ ok: true }),
    linuxPreflightRepairable: () => true, linuxPreflightMessage: () => "preflight", runScript: async () => ({ code: 0 }),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    resolveProtonPlan: async () => ({ success: true, status: "free", maxTier: 0 }),
    proton: {
      canReuseMeasuredProfile: () => false,
      matchesMeasuredProfile: () => false,
      MEASUREMENT_CRITERION_VERSION: "test-v2",
      generateOptimalProtonConfig: async (_dir: string, opts: any) => {
        calls.generate = (calls.generate || 0) + 1;
        if (opts.signal.aborted) return { success: false, error: "aborted" };
        return { success: true, server: "US#1", endpoint: "198.51.100.1:51820", downloadMbps: 100, uploadMbps: 20 };
      },
    },
    event,
    Date, Error, String, Number, Boolean, Object, Promise, Math, console, AbortController,
    protonOptimizations: coordinator,
  }, { has: () => true, get: (target, property) => property in target ? target[property as any] : undefined });
  Object.assign(ctx, overrides);
  const compiled = handlerSource();
  const factory = new Function("ctx", `with (ctx) { ${compiled}; return optimize; }`);
  const fn = factory(ctx);
  return { run: (options = {}) => fn(event, options), settings, events, calls, coordinator };
}

describe("handler real de otimização Proton", () => {
  it("reutiliza cache compatível sem medir", async () => {
    const cached = { success: true, server: "DE#1", endpoint: "198.51.100.2:51820", measurementUsername: "user@example.test" };
    const h = makeHarness({ proton: { canReuseMeasuredProfile: () => true, MEASUREMENT_CRITERION_VERSION: "test-v2", generateOptimalProtonConfig: vi.fn() } });
    h.settings.protonLastServer = cached;
    const result = await h.run({ reuseMeasured: true });
    expect(result).toMatchObject({ success: true, server: "DE#1" });
    expect(h.calls.generate).toBeUndefined();
  });

  it("refaz a medição automática na abertura mesmo com cache compatível", async () => {
    let generated = 0;
    const h = makeHarness({ proton: {
      canReuseMeasuredProfile: () => true,
      MEASUREMENT_CRITERION_VERSION: "test-v2",
      generateOptimalProtonConfig: async () => {
        generated += 1;
        return { success: true, server: "US#1", endpoint: "198.51.100.1:51820", downloadMbps: 100, uploadMbps: 20 };
      },
    } });
    h.settings.protonLastServer = { success: true, server: "DE#1", endpoint: "198.51.100.2:51820", measurementUsername: "user@example.test" };
    const result = await h.run({ refreshOnStartup: true });
    expect(result).toMatchObject({ success: true, server: "US#1" });
    expect(generated).toBe(1);
  });

  it("mede na seleção inicial e persiste a métrica de velocidade", async () => {
    const h = makeHarness();
    const result = await h.run({ speedTest: true });
    expect(result).toMatchObject({ success: true, downloadMbps: 100, uploadMbps: 20 });
    expect(h.calls.generate).toBe(1);
    expect(h.settings.protonLastServer).toMatchObject({ measurementVersion: "test-v2", measurementUsername: "user@example.test" });
    expect(h.events.at(-1)).toMatchObject({ phase: "completed", requestId: expect.any(String) });
  });

  it("adianta quando o túnel está ativo e há reutilização solicitada", async () => {
    const h = makeHarness({ getStatus: () => "ACTIVE", isWireSockActive: () => true });
    h.settings.protonLastServer = { server: "DE#1", endpoint: "198.51.100.2:51820" };
    const result = await h.run({ reuseMeasured: true });
    expect(result).toEqual({ success: true, deferred: true });
    expect(h.calls.generate).toBeUndefined();
    expect(h.calls.killDiscord).toBeUndefined();
  });

  it("adia a nova medição automática quando o túnel já está ativo", async () => {
    let generated = 0;
    const h = makeHarness({
      getStatus: () => "ACTIVE",
      isWireSockActive: () => true,
      proton: {
        canReuseMeasuredProfile: () => true,
        MEASUREMENT_CRITERION_VERSION: "test-v2",
        generateOptimalProtonConfig: async () => {
          generated += 1;
          return { success: true, server: "US#1" };
        },
      },
    });
    h.settings.protonLastServer = { server: "DE#1", endpoint: "198.51.100.2:51820" };
    const result = await h.run({ refreshOnStartup: true });
    expect(result).toEqual({ success: true, deferred: true });
    expect(generated).toBe(0);
    expect(h.calls.killDiscord).toBeUndefined();
  });

  it("troca rota Windows ativa em ordem: pausa, mede, inicia WireSock e reabre Discord", async () => {
    const order: string[] = [];
    const h = makeHarness({ IS_WINDOWS: true, getStatus: () => "ACTIVE", killDiscord: async () => order.push("kill"),
      recoverWireSockNetwork: async () => { order.push("recover"); return { ok: true, residual: [] }; },
      startWireSockService: async () => order.push("start-wg"),
      waitForWindowsRouteSettle: async () => order.push("settle"),
      startDiscordAndConfirm: async () => { order.push("start-discord"); return true; } });
    const result = await h.run({ speedTest: false });
    expect(result.success).toBe(true);
    expect(order).toEqual(["kill", "recover", "start-wg", "settle", "start-discord"]);
  });

  it("preserva preferências quando a geração falha", async () => {
    const h = makeHarness({ proton: { MEASUREMENT_CRITERION_VERSION: "test-v2", canReuseMeasuredProfile: () => false,
      generateOptimalProtonConfig: async () => ({ success: false, error: "sem candidatos" }) } });
    h.settings.protonCountry = "old";
    const result = await h.run({ speedTest: true, country: "new" });
    expect(result.success).toBe(false);
    expect(h.settings.protonCountry).toBe("old");
    expect(h.settings.protonLastServer).toBeUndefined();
  });

  it("cancelamento por requestId aborta a geração e não grava perfil", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const h = makeHarness({ proton: { MEASUREMENT_CRITERION_VERSION: "test-v2", canReuseMeasuredProfile: () => false,
      generateOptimalProtonConfig: async (_dir: string, opts: any) => {
        await pending;
        return opts.signal.aborted ? { success: false, error: "aborted" } : { success: true, server: "US#1" };
      } } });
    const run = h.run({ speedTest: true, requestId: "cancel-me" });
    await Promise.resolve();
    expect(h.coordinator.cancel("cancel-me", 41)).toBe(true);
    release();
    await expect(run).resolves.toMatchObject({ success: false, cancelled: true });
    expect(h.settings.protonLastServer).toBeUndefined();
  });

  it("coordenador rejeita concorrência e protege cancelamento por owner", () => {
    const c = new ProtonOptimizationCoordinator();
    const first = c.start("r1", 1)!;
    expect(c.start("r2", 2)).toBeUndefined();
    expect(c.cancel("r1", 2)).toBe(false);
    expect(c.cancel("r1", 1)).toBe(true);
    c.finish(first);
    const second = c.start("r2", 2)!;
    c.finish(first);
    expect(c.isCurrent(second)).toBe(true);
  });

  it("handler rejeita uma segunda seleção enquanto a primeira ainda mede", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const h = makeHarness({ proton: { MEASUREMENT_CRITERION_VERSION: "test-v2", canReuseMeasuredProfile: () => false,
      generateOptimalProtonConfig: async () => { await pending; return { success: true, server: "US#1" }; } } });
    const first = h.run({ speedTest: true, requestId: "first" });
    await Promise.resolve();
    await expect(h.run({ speedTest: true, requestId: "second" })).resolves.toEqual({ success: false, error: "Já existe uma seleção de rota em andamento." });
    release();
    await expect(first).resolves.toMatchObject({ success: true });
  });
});
