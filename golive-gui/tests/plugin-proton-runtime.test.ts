import { afterAll, afterEach, beforeEach, describe, expect, it as vitestIt, vi } from "vitest";
import { pluginHostSupported } from "./helpers/plugin-host";

// vpn-proton.ts só localiza o helper em Windows x64 e Linux x64; fora deles estes testes pulam.
const it = vitestIt.skipIf(!pluginHostSupported);
import { EventEmitter } from "events";
import fs from "fs";
import os from "os";
import path from "path";

const state = vi.hoisted(() => ({
  code: 0,
  json: undefined as Record<string, unknown> | undefined,
  args: [] as string[],
  createOutput: true,
  spawnFailure: false,
  stderr: [] as string[],
  // Resposta por invocação: a sonda de diagnóstico roda um segundo helper depois
  // da otimização falhar, e cada chamada devolve um resultado diferente.
  calls: [] as string[][],
  jsonFor: undefined as ((args: string[]) => Record<string, unknown> | undefined) | undefined,
}));

vi.mock("child_process", () => ({
  execFileSync: vi.fn(() => ""),
  spawn: vi.fn((exe: string, args: string[]) => {
    state.args = args;
    state.calls.push(args);
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
      kill: vi.fn(() => {
        queueMicrotask(() => child.emit("close", state.code));
        return true;
      }),
    });
    queueMicrotask(() => {
      if (state.spawnFailure) {
        child.emit("error", Object.assign(new Error(`spawn ${exe} EACCES`), { code: "EACCES" }));
        child.emit("close", 1);
        return;
      }
      const outputAt = args.indexOf("-output");
      if (state.createOutput && outputAt >= 0 && args[outputAt + 1]) {
        fs.writeFileSync(args[outputAt + 1], PROFILE_CONTENT);
      }
      const json = state.jsonFor ? state.jsonFor(args) : state.json;
      if (json !== undefined) child.stdout.emit("data", Buffer.from(JSON.stringify(json)));
      for (const chunk of state.stderr) child.stderr.emit("data", Buffer.from(chunk));
      child.emit("close", state.code);
    });
    return child;
  }),
}));

import {
  automaticExcludedCountries,
  classifyProtonError,
  generateManualProtonConfig,
  generateOptimalProtonConfig,
  generateProtonRouteCatalog,
  loginProton,
  type ProtonOptimizationProgress,
} from "../../goLiveBypass/vpn-proton";

describe("países fora da escolha automática do plugin", () => {
  it("tira as rotas gratuitas do México só no Windows e sem pedido explícito", () => {
    expect(automaticExcludedCountries({ freeOnly: true }, "win32")).toBe("BR,MX");
    expect(automaticExcludedCountries({ country: "US,NL", freeOnly: true }, "win32")).toBe("BR,MX");
    expect(automaticExcludedCountries({ country: "mx", freeOnly: true }, "win32")).toBe("BR");
    expect(automaticExcludedCountries({ freeOnly: false }, "win32")).toBe("BR");
    expect(automaticExcludedCountries({ freeOnly: true }, "linux")).toBe("BR");
    expect(automaticExcludedCountries({ freeOnly: true, avoidFreeMexico: false }, "win32")).toBe("BR");
  });
});

const PROFILE_CONTENT = "# - Name: US#8\nEndpoint = 192.0.2.8:51820\n";
/** Texto claro da sessão: nunca pode aparecer em resultado, erro ou log. */
const SESSION_PLAINTEXT = '{"UID":"uid-de-teste","AccessToken":"token-de-teste"}';
const PREVIOUS_PROFILE = "perfil anterior preservado\n";

// O plugin injeta o armazenamento seguro do Electron neste global quando ele
// existe; aqui a substituição prova que a sessão cifrada é aberta por operação.
const globalScope = globalThis as {
  __GOLIVE_SAFE_STORAGE__?: {
    isEncryptionAvailable(): boolean;
    encryptString(value: string): Buffer;
    decryptString(value: Buffer): string;
  };
};

const temporaryRoots: string[] = [];
const previousHelperOverride = process.env.GOLIVE_PLUGIN_PROTON_CONFGEN;

function temporaryRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function dataDirWithSession(): string {
  const dir = temporaryRoot("golive-plugin-proton-");
  fs.writeFileSync(path.join(dir, "proton-session.json"), JSON.stringify({
    version: 1,
    format: "electron-safe-storage",
    ciphertext: Buffer.from(SESSION_PLAINTEXT, "utf8").toString("base64"),
  }));
  return dir;
}

function helperExecutable(): string {
  const helper = path.join(temporaryRoot("golive-plugin-helper-"), "proton-confgen");
  fs.writeFileSync(helper, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(helper, 0o755);
  return helper;
}

beforeEach(() => {
  state.code = 0;
  state.json = undefined;
  state.args = [];
  state.createOutput = true;
  state.spawnFailure = false;
  state.stderr = [];
  state.calls = [];
  state.jsonFor = undefined;
  process.env.GOLIVE_PLUGIN_PROTON_CONFGEN = helperExecutable();
  globalScope.__GOLIVE_SAFE_STORAGE__ = {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, "utf8"),
    decryptString: (value: Buffer) => value.toString("utf8"),
  };
});

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

afterAll(() => {
  if (previousHelperOverride === undefined) delete process.env.GOLIVE_PLUGIN_PROTON_CONFGEN;
  else process.env.GOLIVE_PLUGIN_PROTON_CONFGEN = previousHelperOverride;
  delete globalScope.__GOLIVE_SAFE_STORAGE__;
});

describe("catálogo de rotas do plugin", () => {
  it("consulta o catálogo com a sessão autenticada e não gera perfil", async () => {
    state.json = {
      success: true,
      routes: [
        { server: "US#1", country: "US", city: "New York", tier: "Free", load: 12, score: 3.5, pingMs: 44 },
        { server: "NL#2", country: "NL", city: "Amsterdam", tier: "Plus", load: 20, score: 1.25 },
      ],
    };
    const dir = dataDirWithSession();

    const result = await generateProtonRouteCatalog(dir, {
      username: "conta@proton.me",
      country: "US,NL",
      onProgress: () => {},
    });

    expect(state.args).toEqual(expect.arrayContaining([
      "-route-catalog", "-json", "-auto-ping", "-progress-json",
      "-exclude-countries", "BR", "-countries", "US,NL", "-free-only",
    ]));
    expect(state.args).not.toContain("-output");
    expect(state.args).not.toContain("-speed-test");
    expect(state.args[state.args.indexOf("-username") + 1]).toBe("conta");
    expect(result).toEqual({
      success: true,
      routes: [
        { server: "US#1", country: "US", city: "New York", tier: "Free", load: 12, score: 3.5, pingMs: 44 },
        { server: "NL#2", country: "NL", city: "Amsterdam", tier: "Plus", load: 20, score: 1.25 },
      ],
    });
    // Nem perfil nem resíduo de sessão em texto claro ficam no diretório.
    expect(fs.existsSync(path.join(dir, "wireguard.conf"))).toBe(false);
    expect(fs.readdirSync(dir).filter(name => name.startsWith(".protonvpn-session-"))).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("token-de-teste");
  });

  it("preenche metadados publicamente e descarta evento fora do contrato", async () => {
    state.json = { success: true, routes: [{ server: "US#1", country: "US", city: "New York", tier: "Free", load: 12, score: 3.5, pingMs: 44 }] };
    state.stderr = [
      'GOLIVE_PROGRESS {"phase":"catalog","total":1}\n',
      'GOLIVE_PROGRESS {"phase":"catalog","total":1,"tested":0,"succeeded":0,"server":"US#1","country":"US","city":"New York","tier":"Free","load":12,"score":3.5,"status":"success"}\n',
      'GOLIVE_PROGRESS {"phase":"catalog","total":1,"tested":1,"succeeded":1,"server":"US#1","country":"US","city":"New York","tier":"Free","load":12,"score":3.5,"pingMs":44,"status":"success"}\n',
      'GOLIVE_PROGRESS {"phase":"inventado","total":9,"server":"US#1"}\n',
      'GOLIVE_PROGRESS {"phase":"catalog","total":1,"server":"US#1","load":"muito","score":-1,"pingMs":-3}\n',
    ];
    const progress: ProtonOptimizationProgress[] = [];
    const dir = dataDirWithSession();

    const result = await generateProtonRouteCatalog(dir, { username: "conta", onProgress: event => progress.push(event) });

    expect(result.success).toBe(true);
    expect(progress).toHaveLength(4);
    expect(progress[0]).toEqual({ phase: "catalog", total: 1, tested: 0, succeeded: 0 });
    expect(progress[1]).toMatchObject({ server: "US#1", country: "US", city: "New York", tier: "Free", load: 12, score: 3.5, status: "success" });
    expect(progress[1]).not.toHaveProperty("pingMs");
    expect(progress[2]).toMatchObject({ server: "US#1", pingMs: 44 });
    // Métrica inválida é descartada campo a campo, sem inventar valor.
    expect(progress[3]).toEqual({ phase: "catalog", total: 1, tested: 0, succeeded: 0, server: "US#1" });
  });

  it("trata ping inválido como rota sem ping e rejeita metadados quebrados", async () => {
    const dir = dataDirWithSession();
    state.json = {
      success: true,
      routes: [{ server: "US#1", country: "US", city: "New York", tier: "Free", load: 12, score: 0, pingMs: 1500 }],
    };

    const measured = await generateProtonRouteCatalog(dir, { username: "conta" });
    expect(measured).toEqual({
      success: true,
      routes: [{ server: "US#1", country: "US", city: "New York", tier: "Free", load: 12, score: 0 }],
    });

    state.json = {
      success: true,
      routes: [
        { server: "US#1", country: "US", city: "New York", tier: "Free", load: 12, score: 1 },
        { server: "NL#2", country: "NL", city: "Amsterdam", tier: "Plus", load: 500, score: 1 },
      ],
    };
    const broken = await generateProtonRouteCatalog(dir, { username: "conta" });
    expect(broken.success).toBe(false);
    expect(broken.routes).toBeUndefined();
    expect(broken.error).toBeTruthy();
  });

  it("devolve erro sanitizado quando o helper falha", async () => {
    state.code = 1;
    state.json = undefined;
    state.stderr = ["authentication failed: Proton session verification returned an invalid HTTP status (200)\n"];
    const dir = dataDirWithSession();

    const result = await generateProtonRouteCatalog(dir, { username: "conta" });

    expect(result.success).toBe(false);
    expect(result.routes).toBeUndefined();
    expect(result.error).toContain("authentication failed");
  });

  it("recusa operar sem sessão utilizável", async () => {
    const dir = temporaryRoot("golive-plugin-no-session-");
    state.json = { success: true, routes: [] };

    const result = await generateProtonRouteCatalog(dir, { username: "conta" });

    expect(result.success).toBe(false);
    expect(result.routes).toBeUndefined();
    expect(state.args).toEqual([]);
  });
});

describe("otimização do plugin", () => {
  it("no Windows não exige HTTPS do Discord para medir uma rota", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      state.json = {
        success: true,
        server: "US#8",
        country: "US",
        city: "New York",
        tier: "Free",
        load: 12,
        score: 3.5,
        pingMs: 44,
        downloadMbps: 28,
        uploadMbps: 8,
        speedTested: 6,
        speedSucceeded: 6,
      };

      const result = await generateOptimalProtonConfig(dataDirWithSession(), {
        username: "conta",
        speedTest: true,
      });

      expect(result.success).toBe(true);
      expect(state.args).toEqual(expect.arrayContaining(["-speed-test", "-progress-json"]));
      expect(state.args).not.toContain("-require-discord");
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });

  it("quando a verificação rápida descarta todas, roda a sonda estendida e expõe a etapa", async () => {
    const dir = dataDirWithSession();
    const output = path.join(dir, "wireguard.conf");
    fs.writeFileSync(output, PREVIOUS_PROFILE);
    state.code = 1;
    state.jsonFor = args => args.includes("-manual-probe")
      ? { success: false, error: "manual route preflight failed: dial tcp4 192.0.2.8:443: i/o timeout" }
      : { success: false, error: "nenhum candidato respondeu pelo túnel na verificação rápida" };
    state.stderr = [
      'GOLIVE_PROGRESS {"phase":"preparing","total":12,"tested":1,"succeeded":0,"server":"US-FREE#56","status":"failed"}\n',
    ];

    const result = await generateOptimalProtonConfig(dir, { username: "conta", speedTest: true });

    expect(result.success).toBe(false);
    expect(result.error).toContain("nenhum candidato respondeu pelo túnel");
    // O erro agregado sozinho descartava as doze rotas sem dizer onde falhou.
    expect(result.error).toContain("sonda estendida (15 s) em US-FREE#56");
    expect(result.error).toContain("manual route preflight failed");
    expect(state.calls).toHaveLength(2);
    expect(state.calls[1]).toEqual(expect.arrayContaining(["-manual-probe", "-server", "US-FREE#56", "-ipv6"]));
    expect(state.calls[1]).not.toContain("-speed-test");
    // A sonda nunca promove perfil: o perfil anterior fica intacto e sem staging.
    expect(fs.readFileSync(output, "utf8")).toBe(PREVIOUS_PROFILE);
    expect(fs.readdirSync(dir).filter(name => name.startsWith(".wireguard.conf."))).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("token-de-teste");
  });

  it("sonda estendida aprovada aponta para a seleção manual em vez de culpar a rota", async () => {
    const dir = dataDirWithSession();
    state.code = 0;
    state.jsonFor = args => args.includes("-manual-probe")
      ? { success: true, manual: true, server: "US-FREE#56", pingMs: 128, preflight: "success" }
      : { success: false, error: "nenhum candidato respondeu pelo túnel na verificação rápida" };
    state.stderr = [
      'GOLIVE_PROGRESS {"phase":"preparing","total":12,"tested":12,"succeeded":0,"server":"US-FREE#56","status":"failed"}\n',
    ];

    const result = await generateOptimalProtonConfig(dir, { username: "conta", speedTest: true });

    expect(result.success).toBe(false);
    expect(result.error).toContain("nenhum candidato respondeu pelo túnel");
    // Com o túnel provado na sonda estendida, o descarte veio do limite de 6 s:
    // a saída do usuário é a lista manual, não a desistência.
    expect(result.error).toContain("a rota respondeu pelo túnel");
    expect(result.error).toContain("seleção manual");
    expect(state.calls).toHaveLength(2);
    expect(state.calls[1]).toEqual(expect.arrayContaining(["-manual-probe", "-server", "US-FREE#56"]));
    expect(fs.readdirSync(dir).filter(name => name.startsWith(".wireguard.conf."))).toEqual([]);
  });

  it("não dispara a sonda estendida quando a falha não é do preflight pelo túnel", async () => {
    const dir = dataDirWithSession();
    state.code = 1;
    state.json = { success: false, error: "authentication failed: Proton session verification returned an invalid HTTP status (200)" };

    const result = await generateOptimalProtonConfig(dir, { username: "conta", speedTest: true });

    expect(result.success).toBe(false);
    expect(state.calls).toHaveLength(1);
    expect(result.error).not.toContain("sonda estendida");
  });
});

describe("rota manual do plugin", () => {
  it("sonda o servidor exato e só então promove o perfil", async () => {
    state.json = {
      success: true,
      manual: true,
      server: "US#8",
      pingMs: 188,
      endpoint: "192.0.2.8:51820",
      preflight: "success",
      country: "US",
      city: "New York",
      tier: "Free",
      load: 10,
      score: 2,
    };
    const dir = dataDirWithSession();
    const output = path.join(dir, "wireguard.conf");
    fs.writeFileSync(output, PREVIOUS_PROFILE);

    const result = await generateManualProtonConfig(dir, {
      username: "conta@proton.me",
      server: " US#8 ",
      country: "US",
      onProgress: () => {},
    });

    expect(state.args).toEqual(expect.arrayContaining([
      "-server", "US#8", "-manual-probe", "-json", "-ipv6", "-exclude-countries", "BR",
      "-countries", "US", "-free-only", "-progress-json",
    ]));
    expect(state.args).not.toContain("-speed-test");
    // O perfil é escrito em staging e promovido atomicamente só ao final.
    expect(state.args[state.args.indexOf("-output") + 1]).toContain(".wireguard.conf.");
    expect(result).toMatchObject({
      success: true,
      manual: true,
      server: "US#8",
      country: "US",
      city: "New York",
      tier: "Free",
      load: 10,
      score: 2,
      pingMs: 188,
      endpoint: "192.0.2.8:51820",
      preflight: "success",
      confFile: output,
      staged: true,
    });
    expect(fs.readFileSync(output, "utf8")).toBe(PROFILE_CONTENT);
    expect(fs.readdirSync(dir).filter(name => name.startsWith(".wireguard.conf."))).toEqual([]);
    expect(fs.readdirSync(dir).filter(name => name.startsWith(".protonvpn-session-"))).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("token-de-teste");
  });

  it("preserva o perfil anterior quando a sonda não é aprovada", async () => {
    const dir = dataDirWithSession();
    const output = path.join(dir, "wireguard.conf");
    fs.writeFileSync(output, PREVIOUS_PROFILE);

    state.json = { success: true, manual: true, server: "US#8", pingMs: 188 };
    const noPreflight = await generateManualProtonConfig(dir, { username: "conta", server: "US#8" });
    expect(noPreflight.success).toBe(false);

    state.json = { success: true, manual: true, server: "NL#2", pingMs: 188 };
    const wrongServer = await generateManualProtonConfig(dir, { username: "conta", server: "US#8" });
    expect(wrongServer.success).toBe(false);

    state.json = { success: true, manual: false, server: "US#8", pingMs: 188 };
    const notManual = await generateManualProtonConfig(dir, { username: "conta", server: "US#8" });
    expect(notManual.success).toBe(false);

    state.json = { success: true, manual: true, server: "US#8", pingMs: 0 };
    const noPing = await generateManualProtonConfig(dir, { username: "conta", server: "US#8" });
    expect(noPing.success).toBe(false);

    state.createOutput = false;
    state.json = { success: true, manual: true, server: "US#8", pingMs: 188 };
    const noStaging = await generateManualProtonConfig(dir, { username: "conta", server: "US#8" });
    expect(noStaging.success).toBe(false);

    expect(fs.readFileSync(output, "utf8")).toBe(PREVIOUS_PROFILE);
    expect(fs.readdirSync(dir).filter(name => name.startsWith(".wireguard.conf."))).toEqual([]);
  });

  it("recusa seleção sem servidor nomeado", async () => {
    const dir = dataDirWithSession();

    const result = await generateManualProtonConfig(dir, { username: "conta", server: "   " });

    expect(result.success).toBe(false);
    expect(state.args).toEqual([]);
  });
});

describe("classificação dos erros de login do plugin", () => {
  it("não acusa senha incorreta pelo prefixo genérico do helper", () => {
    expect(classifyProtonError("authentication failed: protocol error").code).not.toBe("INVALID_CREDENTIALS");
    expect(classifyProtonError("authentication failed: protocol error").code).toBe("UNKNOWN");
    expect(classifyProtonError("authentication failed: incorrect username or password").code).toBe("INVALID_CREDENTIALS");
  });

  it("dá precedência absoluta ao código estruturado", () => {
    expect(classifyProtonError("INVALID_CREDENTIALS")).toMatchObject({ code: "INVALID_CREDENTIALS", retryable: false });
    expect(classifyProtonError("NETWORK_ERROR")).toMatchObject({ code: "NETWORK_ERROR", retryable: true });
    expect(classifyProtonError("HELPER_ERROR")).toMatchObject({ code: "HELPER_ERROR", retryable: true });
    expect(classifyProtonError("CAPTCHA_INVALID")).toMatchObject({ code: "CAPTCHA_INVALID" });
    expect(classifyProtonError("CAPTCHA_CANCELLED")).toMatchObject({ code: "CAPTCHA_CANCELLED" });
    expect(classifyProtonError("NETWORK_ERROR", "authentication failed: protocol error", "").code).toBe("NETWORK_ERROR");
  });

  it("classifica falha de execução do helper como HELPER_ERROR", () => {
    const spawn = classifyProtonError(new Error("spawn /opt/plugin/proton-confgen EACCES"));
    expect(spawn.code).toBe("HELPER_ERROR");
    expect(spawn.retryable).toBe(true);
    expect(spawn.message).not.toContain("senha");
    expect(classifyProtonError("unexpected token < in JSON at position 0").code).toBe("HELPER_ERROR");
  });

  it("preserva rede, timeout, armazenamento, 2FA e executável ausente", () => {
    expect(classifyProtonError(new Error("Tempo limite excedido (25s) ao executar proton-confgen.")).code).toBe("TIMEOUT");
    expect(classifyProtonError("spawn proton-confgen ENOENT").code).toBe("MISSING_EXECUTABLE");
    expect(classifyProtonError("O executável proton-confgen não foi encontrado no pacote do plugin.").code).toBe("MISSING_EXECUTABLE");
    expect(classifyProtonError("Cannot write session file: permission denied").code).toBe("SESSION_PERSISTENCE");
    expect(classifyProtonError("connection reset by peer").code).toBe("NETWORK_ERROR");
    expect(classifyProtonError("9100").code).toBe("TWO_FACTOR_REQUIRED");
  });
});

describe("login Proton através do helper", () => {
  it("mantém a rejeição estruturada de credencial", async () => {
    const dir = temporaryRoot("golive-plugin-login-cred-");
    state.code = 1;
    state.json = { success: false, error: "authentication failed: incorrect username or password", code: "INVALID_CREDENTIALS", retryable: false };

    const result = await loginProton(dir, "conta", "senha");

    expect(result).toMatchObject({ success: false, code: "INVALID_CREDENTIALS", retryable: false });
  });

  it("não acusa senha quando o helper só devolve o prefixo genérico", async () => {
    const dir = temporaryRoot("golive-plugin-login-generic-");
    state.code = 1;
    state.json = { success: false, error: "authentication failed: Proton session verification returned an invalid HTTP status (200)" };

    const result = await loginProton(dir, "conta", "senha");

    expect(result.success).toBe(false);
    expect(result.code).toBe("UNKNOWN");
    expect(result.message).not.toContain("senha");
  });

  it("trata resposta fora do contrato como falha do componente", async () => {
    const dir = temporaryRoot("golive-plugin-login-invalid-json-");
    state.code = 0;
    state.json = undefined;
    state.stderr = ["saída que não é JSON\n"];

    const result = await loginProton(dir, "conta", "senha");

    expect(result).toMatchObject({ success: false, code: "HELPER_ERROR", retryable: true });
    expect(result.message).toContain("componente ProtonVPN falhou");
  });

  it("trata spawn recusado como falha do componente", async () => {
    const dir = temporaryRoot("golive-plugin-login-spawn-");
    state.spawnFailure = true;

    const result = await loginProton(dir, "conta", "senha");

    expect(result).toMatchObject({ success: false, code: "HELPER_ERROR" });
  });

  it("mantém TIMEOUT e 2FA específicos durante o login", async () => {
    const dir = temporaryRoot("golive-plugin-login-specific-");
    state.code = 1;
    state.json = { success: false, error: "authentication failed: Proton took too long to respond", code: "TIMEOUT", retryable: true };

    const timedOut = await loginProton(dir, "conta", "senha");
    expect(timedOut).toMatchObject({ success: false, code: "TIMEOUT", retryable: true });

    state.json = { success: false, error: "authentication failed: two factor required", code: "TWO_FACTOR_REQUIRED", retryable: false };
    const twoFactor = await loginProton(dir, "conta", "senha");
    expect(twoFactor).toMatchObject({ success: false, code: "TWO_FACTOR_REQUIRED" });
  });
});
