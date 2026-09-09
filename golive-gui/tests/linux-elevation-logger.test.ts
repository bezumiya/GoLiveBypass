import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const mainSource = fs.readFileSync(path.resolve(process.cwd(), "electron/main.ts"), "utf8");

function loadElevationConsumer(logger: { logEvent: (...args: unknown[]) => void }) {
  const start = mainSource.indexOf("type LinuxElevationEventName");
  const end = mainSource.indexOf("async function linuxActivate", start);
  if (start < 0 || end < 0) throw new Error("bloco do parser de elevacao nao encontrado");
  const block = mainSource.slice(start, end);
  const javascript = ts.transpileModule(block, {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None },
  }).outputText;
  return new Function("logger", `${javascript}; return { consumeLinuxElevationEvents };`)(logger) as {
    consumeLinuxElevationEvents: (chunk: string, state: { pending: string }) => void;
  };
}

function makeSink() {
  const calls: unknown[][] = [];
  return {
    calls,
    logger: { logEvent: (...args: unknown[]) => calls.push(args) },
  };
}

describe("persistencia dos eventos de elevacao Linux", () => {
  it("persiste cada evento permitido, inclusive quando a linha chega fragmentada", () => {
    const sink = makeSink();
    const { consumeLinuxElevationEvents } = loadElevationConsumer(sink.logger);
    const state = { pending: "" };

    consumeLinuxElevationEvents("[elevation] prompt.req", state);
    expect(sink.calls).toHaveLength(0);
    consumeLinuxElevationEvents("uested provider=zenity result=requested phase=dialog\n", state);

    consumeLinuxElevationEvents([
      "[elevation] prompt.finished provider=zenity result=accepted input=nonempty stderr=empty",
      "[elevation] sudo.cached provider=sudo result=cached phase=password",
      "[elevation] sudo.validation provider=sudo result=rejected phase=password",
      "[elevation] pkexec.result provider=pkexec result=failed phase=polkit",
      "[elevation] authorization.requested provider=none result=requested phase=pre_activation",
      "[elevation] authorization provider=root result=accepted phase=pre_activation",
    ].join("\n") + "\n", state);

    expect(sink.calls).toHaveLength(7);
    expect(sink.calls.map((call) => call[2])).toEqual([
      "elevation.prompt.requested",
      "elevation.prompt.finished",
      "elevation.sudo.cached",
      "elevation.sudo.validation",
      "elevation.pkexec.result",
      "elevation.authorization.requested",
      "elevation.authorization",
    ]);
    expect(sink.calls[1]).toEqual([
      "info",
      "linux",
      "elevation.prompt.finished",
      { source: "standalone", provider: "zenity", result: "accepted", input: "nonempty", stderr: "empty" },
    ]);

    for (const call of sink.calls) {
      const context = call[3] as Record<string, unknown>;
      expect(Object.keys(context).every((key) => ["source", "provider", "result", "phase", "input", "stderr"].includes(key))).toBe(true);
    }
  });

  it("descarta linhas malformadas e nunca persiste segredo, tamanho, codigo ou token", () => {
    const sink = makeSink();
    const { consumeLinuxElevationEvents } = loadElevationConsumer(sink.logger);
    const state = { pending: "" };

    consumeLinuxElevationEvents([
      "password=senha-super-secreta",
      "[elevation] prompt.requested provider=zenity result=requested phase=dialog code=42",
      "[elevation] prompt.requested provider=zenity result=requested phase=dialog token=abc123",
      "[elevation] prompt.requested provider=zenity result=requested phase=dialog password=senha-super-secreta",
      "[elevation] prompt.requested provider=zenity result=requested phase=dialog phase=tty",
      "[elevation] prompt.requested provider=zenity result=requested  phase=dialog",
      "[elevation] prompt.requested provider=nao-whitelistado result=requested phase=dialog",
      "[elevation] prompt.finished provider=zenity result=accepted input=nonempty stderr=password=senha-super-secreta",
      "[elevation] prompt.requested provider=zenity result=requested phase=dialog detalhe-arbitrario",
    ].join("\n") + "\n", state);

    expect(sink.calls).toHaveLength(0);
    expect(JSON.stringify(sink.calls)).not.toContain("senha-super-secreta");
    expect(JSON.stringify(sink.calls)).not.toContain("abc123");
  });

  it("liga o consumidor ao callback da ativacao sem mudar o canal publico", () => {
    const activationStart = mainSource.indexOf("async function linuxActivate");
    const activationEnd = mainSource.indexOf("async function linuxDeactivate", activationStart);
    const activation = mainSource.slice(activationStart, activationEnd);

    expect(activation).toContain("const elevationParserState: LinuxElevationParserState = { pending: \"\" };");
    expect(activation).toContain("consumeLinuxElevationEvents(chunk, elevationParserState);");
    expect(activation).toContain("onChunk(chunk);");
    expect(activation).toContain('runScript(["--yes", "--cleanup-legacy"], forwardLinuxChunk)');
    expect(mainSource).toContain('logger.logEvent("info", "linux", LINUX_ELEVATION_LOG_EVENTS[record.event], data);');
  });
});
