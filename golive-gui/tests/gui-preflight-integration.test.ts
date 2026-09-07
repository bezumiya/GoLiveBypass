import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { linuxPreflightRepairable } from "../electron/linux-preflight";

const sourcePath = path.resolve(process.cwd(), "electron/main.ts");
const source = fs.readFileSync(sourcePath, "utf8");
const file = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

function findFunction(name: string): ts.FunctionLikeDeclaration {
  let found: ts.FunctionLikeDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isFunctionLike(node) && node.name?.getText(file) === name) found = node;
    if (!found) ts.forEachChild(node, visit);
  };
  visit(file);
  if (!found?.body || !ts.isBlock(found.body)) throw new Error(`função não encontrada: ${name}`);
  return found;
}

function statementContaining(functionName: string, marker: string): string {
  const fn = findFunction(functionName);
  if (!fn.body || !ts.isBlock(fn.body)) throw new Error(`sem corpo: ${functionName}`);
  const statement = fn.body.statements.find((s) => s.getText(file).includes(marker));
  if (!statement) throw new Error(`statement não encontrado: ${functionName}/${marker}`);
  return statement.getText(file);
}

function statementsAfter(functionName: string, marker: string, nextMarker: string): string {
  const fn = findFunction(functionName);
  if (!fn.body || !ts.isBlock(fn.body)) throw new Error(`sem corpo: ${functionName}`);
  const statements = [...fn.body.statements];
  const start = statements.findIndex((s) => s.getText(file).includes(marker));
  const end = statements.findIndex((s, index) => index > start && s.getText(file).includes(nextMarker));
  if (start < 0 || end < 0) throw new Error(`intervalo não encontrado: ${marker}/${nextMarker}`);
  return statements.slice(start, end + 1).map((s) => s.getText(file)).join("\n");
}

function makeActivationPreflight() {
  const statement = statementsAfter("executarAtivacao", '"preflight-wiresock"', "await killDiscord();");
  return new Function(`return async function(ctx) {
    const { IS_WINDOWS, windowsWasActive, windowsGeneration, ensureWireSockInstalled,
      withWireSockLifecycle, assertWindowsRouteGeneration, isWireSockActive,
      refreshWindowStatus, event, setRouteState, killDiscord, stopWindowsRouteWatchdog } = ctx;
    const windowsRouteGeneration = ctx.currentGeneration ?? windowsGeneration;
    const quitting = false;
    let windowsRouteState = ctx.initialState ?? "inactive";
    try { ${statement} } catch (error) { error.routeState = windowsRouteState; throw error; }
    return { windowsRouteState };
  }`)();
}

function makeLinuxPreflight() {
  const fn = findFunction("linuxActivate");
  if (!fn.body || !ts.isBlock(fn.body)) throw new Error("linuxActivate sem corpo");
  const statements = [...fn.body.statements];
  const end = statements.findIndex((s) => s.getText(file).includes("if (!preflight.ok)"));
  if (end < 0) throw new Error("bloco de validação Linux não encontrado");
  const body = statements.slice(0, end + 1).map((s) => s.getText(file)).join("\n");
  return new Function(`return async function(ctx) {
    const { linuxPreflight, runScript, onChunk, linuxPreflightMessage, linuxPreflightRepairable, tailErroScript } = ctx;
    ${body}
    return preflight;
  }`)();
}

describe("integração de preflight extraída do main real", () => {
  it("rejeição da instalação não mata Discord nem converte estado antigo em active", async () => {
    const run = makeActivationPreflight();
    let killed = 0;
    let routeState: string | undefined;
    await expect(run({
      IS_WINDOWS: true, windowsWasActive: false, windowsGeneration: 7,
      ensureWireSockInstalled: async () => { throw new Error("installer failed"); },
      withWireSockLifecycle: async (_name: string, task: () => Promise<unknown>) => task(),
      assertWindowsRouteGeneration: () => {}, isWireSockActive: () => false,
      refreshWindowStatus: () => {}, event: undefined,
      setRouteState: (v: string) => { routeState = v; },
      killDiscord: () => { killed++; },
    })).rejects.toThrow("installer failed");
    expect(killed).toBe(0);
    expect(routeState).toBeUndefined();
  });

  it("instalação já compatível chega ao killDiscord exatamente uma vez", async () => {
    const run = makeActivationPreflight();
    let killed = 0;
    await expect(run({
      IS_WINDOWS: true, windowsWasActive: false, windowsGeneration: 1, currentGeneration: 1,
      ensureWireSockInstalled: async () => {},
      withWireSockLifecycle: async (_name: string, task: () => Promise<unknown>) => task(),
      assertWindowsRouteGeneration: () => {}, isWireSockActive: () => false,
      refreshWindowStatus: () => {}, event: undefined, setRouteState: () => {},
      killDiscord: async () => { killed++; }, stopWindowsRouteWatchdog: () => {},
    })).resolves.toEqual({ windowsRouteState: "inactive" });
    expect(killed).toBe(1);
  });

  it("cancelamento de geração durante instalação mantém o caminho sem kill", async () => {
    const run = makeActivationPreflight();
    let killed = 0;
    let generation = 1;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const operation = run({
      IS_WINDOWS: true, windowsWasActive: true, windowsGeneration: 1, currentGeneration: 2, initialState: "inactive",
      ensureWireSockInstalled: async () => { await pending; },
      withWireSockLifecycle: async (_name: string, task: () => Promise<unknown>) => task(),
      assertWindowsRouteGeneration: () => { generation++; throw new Error("operação cancelada"); },
      isWireSockActive: () => true, refreshWindowStatus: () => {}, event: undefined,
      killDiscord: () => { killed++; }, setRouteState: () => {},
    });
    await Promise.resolve();
    expect(killed).toBe(0);
    release();
    const failure = await operation.catch((error: Error & { routeState?: string }) => error);
    expect(failure.message).toContain("operação cancelada");
    expect(failure.routeState).toBe("inactive");
    expect(generation).toBe(2);
    expect(killed).toBe(0);
  });

  it("Linux repara dependências e só retorna depois de novo preflight válido", async () => {
    const run = makeLinuxPreflight();
    const seen: string[] = [];
    let calls = 0;
    const result = await run({
      linuxPreflight: async (force = false) => {
        calls++; seen.push(`preflight:${force}`);
        return calls === 1
          ? { ok: false, platform: "linux", dependencies: { missing: ["wireguard-tools", "iproute2"] }, installCommand: "", discord: { found: true, count: 1 }, elevation: { available: true, method: "sudo" }, netns: { available: true }, kernel: { wireguard: "unknown" }, errors: [] }
          : { ok: true, platform: "linux", dependencies: { missing: [] }, installCommand: "", discord: { found: true, count: 1 }, elevation: { available: true, method: "sudo" }, netns: { available: true }, kernel: { wireguard: "unknown" }, errors: [] };
      },
      runScript: async (args: string[]) => { seen.push(args[0]); return { code: 0, stdout: "", stderr: "" }; },
      onChunk: () => {}, linuxPreflightMessage: () => "preflight inválido",
      linuxPreflightRepairable,
    });
    expect(result.ok).toBe(true);
    expect(seen).toEqual(["preflight:false", "--ensure-dependencies", "preflight:true"]);
  });

  it("Linux não inicia quando o reparo falha ou o preflight fresco continua inválido", async () => {
    const run = makeLinuxPreflight();
    const invalid = {
      ok: false, platform: "linux", dependencies: { missing: ["wireguard-tools", "iproute2"] },
      installCommand: "sudo pacman -S --needed wireguard-tools iproute2", discord: { found: true, count: 1 },
      elevation: { available: true, method: "sudo" }, netns: { available: true },
      kernel: { wireguard: "unknown" }, errors: [],
    } as const;
    await expect(run({
      linuxPreflight: async () => invalid,
      runScript: async () => ({ code: 17, stdout: "", stderr: "pacman failed" }),
      onChunk: () => {}, linuxPreflightMessage: () => "preflight inválido", linuxPreflightRepairable,
      tailErroScript: (stderr: string) => stderr,
    })).rejects.toThrow("pacman failed");
    const seen: string[] = [];
    await expect(run({
      linuxPreflight: async (force = false) => { seen.push(String(force)); return invalid; },
      runScript: async (args: string[]) => { seen.push(args[0]); return { code: 0, stdout: "", stderr: "" }; },
      onChunk: () => {}, linuxPreflightMessage: () => "preflight inválido", linuxPreflightRepairable,
      tailErroScript: (stderr: string) => stderr,
    })).rejects.toThrow("preflight inválido");
    expect(seen).toEqual(["false", "--ensure-dependencies", "true"]);
  });
});
