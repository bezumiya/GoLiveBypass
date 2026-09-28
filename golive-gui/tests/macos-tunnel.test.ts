import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import net from "net";
import path from "path";
import {
  buildMacTunnelForceStopScript,
  buildMacTunnelLaunchScript,
  configureMacTunnel,
  ensureMacTunnelHelper,
  getMacTunnelStats,
  MacTunnelAuthorizationCancelled,
  MAC_TUNNEL_SOCKET,
  parseMacSentinelRoute,
  stopMacTunnel,
} from "../electron/macos-tunnel";
import { macHelperCandidates, protonConfgenCandidates } from "../electron/proton-runtime";

type FakeHelper = { server: net.Server; requests: Array<Record<string, unknown>>; configured: boolean };

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function tempSocket(): string {
  // sun_path no macOS aceita ~104 bytes: os.tmpdir() do runner pode ser longo.
  const dir = fs.mkdtempSync(path.join("/tmp", "gltun-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "t.sock");
}

function startFakeHelper(socketPath: string): Promise<FakeHelper> {
  const fake: FakeHelper = { server: net.createServer(), requests: [], configured: false };
  fake.server.on("connection", (socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
      fake.requests.push(request);
      if (request.cmd === "configure") fake.configured = !String(request.config).includes("INVALIDO");
      const ok = request.cmd !== "configure" || fake.configured;
      socket.end(`${JSON.stringify({
        ok,
        error: ok ? undefined : "PrivateKey inválida",
        pid: 4242,
        configured: fake.configured,
        interface: fake.configured ? "utun9" : "",
        routes: fake.configured ? 47 : 0,
        stats: fake.configured ? { handshakeAgoS: 3, rxBytes: 10, txBytes: 20, endpoint: "149.88.27.237:51820" } : undefined,
      })}\n`);
      if (request.cmd === "stop") fake.server.close();
    });
  });
  return new Promise((resolve) => fake.server.listen(socketPath, () => {
    cleanups.push(() => fake.server.close());
    resolve(fake);
  }));
}

describe("script de lançamento do helper macOS", () => {
  it("escapa caminhos com espaço, aspas e apóstrofo para shell e AppleScript", () => {
    const helper = `/Applications/Go "Live" d'Iuri.app/Contents/Resources/extra/proton-confgen/darwin-x64/golive-tunnel`;
    const script = buildMacTunnelLaunchScript(helper, 501);
    expect(script.startsWith('do shell script "')).toBe(true);
    expect(script).toContain("with administrator privileges");
    expect(script).toContain(`serve --owner-uid 501 --socket '${MAC_TUNNEL_SOCKET}'`);
    // Aspas duplas viram \\" no AppleScript; o apóstrofo fecha e reabre a string do shell.
    expect(script).toContain(`'/Applications/Go \\"Live\\" d'\\\\''Iuri.app/`);
    expect(script).toMatch(/2>&1 &" with prompt/);
    // O helper precisa ser um comando separado: `a && b &` jogaria a lista
    // toda numa subshell que segura o stdout e trava o do shell script.
    expect(script).toMatch(/\|\| exit 1; '/);
    expect(script).toContain("< /dev/null >>");
  });

  it("recusa caminho relativo e uid inválido", () => {
    expect(() => buildMacTunnelLaunchScript("golive-tunnel", 501)).toThrow(/absoluto/);
    expect(() => buildMacTunnelLaunchScript("/x/golive-tunnel", -1)).toThrow(/uid/);
  });

  it("o encerramento forçado só mata o helper pelo nome exato", () => {
    const script = buildMacTunnelForceStopScript();
    expect(script).toContain("pkill -TERM -x golive-tunnel");
    expect(script).not.toMatch(/pkill -f/);
    // Rotas de rejeição IPv6 vivem no loopback e sobrevivem ao helper.
    expect(script).toContain("route -q -n delete -inet6");
    expect(script).toContain("/var/run/golivebypass/reject-routes");
  });
});

describe("rota sentinela do Discord", () => {
  it("encontra o bloco de voz na utun e ignora a mesma rota em outra interface", () => {
    const table = [
      "Routing tables",
      "Internet:",
      "Destination        Gateway            Flags               Netif Expire",
      "default            192.168.0.1        UGScg                 en0",
      "66.22.192/18       utun7              USc                 utun7",
    ].join("\n");
    expect(parseMacSentinelRoute(table)).toBe("utun7");
    expect(parseMacSentinelRoute(table.replace(/utun7/g, "en0"))).toBeNull();
    expect(parseMacSentinelRoute("default 192.168.0.1 UGScg en0")).toBeNull();
  });
});

describe("helpers por arquitetura no macOS", () => {
  it("procura só em darwin-<arch> para nunca executar o ELF do Linux", () => {
    const context = { platform: "darwin", arch: "arm64", resourcesPath: "/App/Contents/Resources", cwd: "/repo/golive-gui" };
    const confgen = protonConfgenCandidates(context);
    expect(confgen[0]).toBe("/App/Contents/Resources/extra/proton-confgen/darwin-arm64/proton-confgen");
    expect(confgen.every((candidate) => candidate.includes(`${path.sep}darwin-arm64${path.sep}`))).toBe(true);
    expect(macHelperCandidates("golive-tunnel", { ...context, arch: "x64" })).toContain(
      "/repo/tools/proton-confgen/build/darwin-x64/golive-tunnel",
    );
  });

  it("mantém os caminhos de Windows e Linux intactos", () => {
    const linux = protonConfgenCandidates({ platform: "linux", arch: "x64", resourcesPath: "/opt/app/resources" });
    expect(linux[0]).toBe("/opt/app/resources/extra/proton-confgen/proton-confgen");
  });
});

describe("ciclo de vida do túnel macOS", () => {
  it("pede senha só quando o helper não está vivo e envia a configuração pelo socket", async () => {
    const socketPath = tempSocket();
    let prompts = 0;
    let fake: FakeHelper | null = null;
    const osascript = async (script: string) => {
      prompts += 1;
      expect(script).toContain("with administrator privileges");
      fake = await startFakeHelper(socketPath);
    };
    await ensureMacTunnelHelper({ helperPath: "/x/golive-tunnel", ownerUid: 501, socketPath, osascript });
    await ensureMacTunnelHelper({ helperPath: "/x/golive-tunnel", ownerUid: 501, socketPath, osascript });
    expect(prompts).toBe(1);

    const status = await configureMacTunnel("[Interface]\nPrivateKey = x", socketPath);
    expect(status).toMatchObject({ running: true, configured: true, interfaceName: "utun9", routes: 47 });
    const commands = fake!.requests.map((request) => request.cmd);
    expect(commands.at(-1)).toBe("configure");
    expect(commands.slice(0, -1).every((cmd) => cmd === "status")).toBe(true);
    expect(fake!.requests.at(-1)).toMatchObject({ config: "[Interface]\nPrivateKey = x" });

    const stats = await getMacTunnelStats(socketPath);
    expect(stats).toEqual({ ok: true, handshakeAgoS: 3, rxBytes: 10, txBytes: 20, endpoint: "149.88.27.237:51820" });
  });

  it("propaga o erro do helper quando a configuração é recusada", async () => {
    const socketPath = tempSocket();
    await startFakeHelper(socketPath);
    await expect(configureMacTunnel("INVALIDO", socketPath)).rejects.toThrow("PrivateKey inválida");
  });

  it("cancelamento do prompt não é confundido com falha de rede", async () => {
    const socketPath = tempSocket();
    const osascript = async () => { throw new MacTunnelAuthorizationCancelled(); };
    await expect(ensureMacTunnelHelper({ helperPath: "/x/golive-tunnel", ownerUid: 501, socketPath, osascript }))
      .rejects.toBeInstanceOf(MacTunnelAuthorizationCancelled);
  });

  it("parar sem helper e sem rota é sucesso; rota órfã sem force é resíduo", async () => {
    const socketPath = tempSocket();
    expect(await stopMacTunnel({ socketPath, routeInterface: () => null })).toEqual({ ok: true, residual: [] });
    const orphan = await stopMacTunnel({ socketPath, routeInterface: () => "utun4" });
    expect(orphan.ok).toBe(false);
    expect(orphan.residual).toEqual(["rotas do Discord em utun4"]);
  });

  it("envia stop e confirma que socket e rotas sumiram", async () => {
    const socketPath = tempSocket();
    const fake = await startFakeHelper(socketPath);
    let routesGone = false;
    fake.server.on("close", () => { routesGone = true; });
    const result = await stopMacTunnel({ socketPath, routeInterface: () => (routesGone ? null : "utun9") });
    expect(result).toEqual({ ok: true, residual: [] });
    expect(fake.requests.some((request) => request.cmd === "stop")).toBe(true);
  });

  it("helper travado sai pelo encerramento forçado com prompt de administrador", async () => {
    const socketPath = tempSocket();
    let routes: string | null = "utun4";
    let forced = 0;
    const result = await stopMacTunnel({
      socketPath,
      force: true,
      routeInterface: () => routes,
      osascript: async (script) => {
        forced += 1;
        expect(script).toContain("pkill -TERM -x golive-tunnel");
        routes = null;
      },
    });
    expect(forced).toBe(1);
    expect(result.ok).toBe(true);
  });
});

describe("integração macOS no main.ts", () => {
  const src = fs.readFileSync(path.resolve(process.cwd(), "electron/main.ts"), "utf8");

  it("pede a senha antes de fechar o Discord", () => {
    const activate = src.slice(src.indexOf("async function macActivateRoute"), src.indexOf("async function ativarTunelMac"));
    expect(activate.indexOf("ensureMacTunnelHelper")).toBeGreaterThan(-1);
    expect(activate.indexOf("ensureMacTunnelHelper")).toBeLessThan(activate.indexOf("await killDiscord()"));
    expect(activate.indexOf("await killDiscord()")).toBeLessThan(activate.indexOf("await applyMacProfile"));
  });

  it("não chama a fila serial de dentro de uma operação que já está nela", () => {
    const quit = src.slice(src.indexOf('app.on("before-quit"'), src.indexOf('app.on("window-all-closed"'));
    expect(quit).not.toContain('withWireSockLifecycle("encerrar-mac"');
    const optimize = src.slice(src.indexOf('return withWireSockLifecycle("troca-rota-proton"'), src.indexOf('ipcMain.handle("report-bug"'));
    expect(optimize).toContain("await macActivateRoute(");
    expect(optimize).not.toContain('withWireSockLifecycle("troca-rota-proton-mac"');
  });

  it("não restaura nem lê app.asar no fluxo macOS", () => {
    const mac = src.slice(src.indexOf("// ------------------------------------------------------------------ macOS: túnel por destino"), src.indexOf("// ------------------------------------------------------------------ fila serial"));
    expect(mac).not.toContain("app.asar");
    expect(mac).not.toContain("_app.asar");
  });
});
