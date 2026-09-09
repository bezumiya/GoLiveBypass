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
    consumeLinuxElevationEvents("uested provider=zenity result=requested input=unknown phase=dialog\n", state);

    consumeLinuxElevationEvents([
      "[elevation] prompt.finished provider=zenity result=not_attempted input=nonempty code=0 stderr=empty",
      "[elevation] prompt.unavailable provider=none result=unavailable input=not_applicable reason=provider_missing",
      "[elevation] prompt.failed provider=zenity result=failed input=not_applicable reason=temporary_file",
      "[elevation] sudo.cached provider=sudo result=cached phase=password",
      "[elevation] sudo.validation provider=sudo result=accepted code=1 phase=password",
      "[elevation] sudo.credential_store provider=zenity result=failed reason=temporary_file phase=password",
      "[elevation] pkexec.invoked provider=pkexec result=requested phase=polkit",
      "[elevation] pkexec.result provider=pkexec result=authorized code=2 phase=polkit",
      "[elevation] authorization.requested provider=none result=requested phase=pre_activation",
      "[elevation] authorization provider=root result=authorized phase=pre_activation",
      "[elevation] sudo.validation provider=sudo result=rejected code=126 phase=password",
      "[elevation] sudo.validation provider=sudo result=rejected code=127 phase=password",
      "[elevation] sudo.validation provider=sudo result=rejected code=other phase=password",
    ].join("\n") + "\n", state);

    expect(sink.calls).toHaveLength(14);
    expect(sink.calls.slice(0, 11).map((call) => call[2])).toEqual([
      "elevation.prompt.requested",
      "elevation.prompt.finished",
      "elevation.prompt.unavailable",
      "elevation.prompt.failed",
      "elevation.sudo.cached",
      "elevation.sudo.validation",
      "elevation.sudo.credential_store",
      "elevation.pkexec.invoked",
      "elevation.pkexec.result",
      "elevation.authorization.requested",
      "elevation.authorization",
    ]);
    expect(sink.calls.slice(11).map((call) => call[2])).toEqual([
      "elevation.sudo.validation",
      "elevation.sudo.validation",
      "elevation.sudo.validation",
    ]);
    expect(sink.calls[0]).toEqual([
      "info",
      "linux",
      "elevation.prompt.requested",
      { source: "standalone", provider: "zenity", result: "requested", input: "unknown", phase: "dialog" },
    ]);
    expect(sink.calls[1]).toEqual([
      "info",
      "linux",
      "elevation.prompt.finished",
      { source: "standalone", provider: "zenity", result: "not_attempted", input: "nonempty", code: "0", stderr: "empty" },
    ]);
    expect(sink.calls[2]).toEqual([
      "info",
      "linux",
      "elevation.prompt.unavailable",
      { source: "standalone", provider: "none", result: "unavailable", input: "not_applicable", reason: "provider_missing" },
    ]);
    expect(sink.calls[4]).toEqual([
      "info",
      "linux",
      "elevation.sudo.cached",
      { source: "standalone", provider: "sudo", result: "cached", phase: "password" },
    ]);
    expect(sink.calls[6]).toEqual([
      "info",
      "linux",
      "elevation.sudo.credential_store",
      { source: "standalone", provider: "zenity", result: "failed", reason: "temporary_file", phase: "password" },
    ]);
    expect(sink.calls[7]).toEqual([
      "info",
      "linux",
      "elevation.pkexec.invoked",
      { source: "standalone", provider: "pkexec", result: "requested", phase: "polkit" },
    ]);
    expect(sink.calls[8]).toEqual([
      "info",
      "linux",
      "elevation.pkexec.result",
      { source: "standalone", provider: "pkexec", result: "authorized", code: "2", phase: "polkit" },
    ]);
    expect(sink.calls.slice(11).map((call) => (call[3] as Record<string, unknown>).code)).toEqual([
      "126",
      "127",
      "other",
    ]);

    for (const call of sink.calls) {
      const context = call[3] as Record<string, unknown>;
      expect(Object.keys(context).every((key) => ["source", "provider", "result", "input", "code", "reason", "phase", "stderr"].includes(key))).toBe(true);
    }
  });

  it("descarta linhas malformadas e nunca persiste segredo, tamanho, codigo ou token", () => {
    const sink = makeSink();
    const { consumeLinuxElevationEvents } = loadElevationConsumer(sink.logger);
    const state = { pending: "" };

    consumeLinuxElevationEvents([
      "password=senha-super-secreta",
      "[elevation] prompt.requested provider=zenity result=requested input=unknown phase=dialog code=42",
      "[elevation] prompt.requested provider=zenity result=requested input=unknown phase=dialog token=abc123",
      "[elevation] prompt.failed provider=zenity result=failed input=not_applicable reason=provider_missing password=senha-super-secreta",
      "[elevation] prompt.requested provider=zenity result=requested input=unknown phase=dialog input=empty",
      "[elevation] prompt.requested provider=zenity result=requested  input=unknown phase=dialog",
      "[elevation] prompt.requested provider=nao-whitelistado result=requested input=unknown phase=dialog",
      "[elevation] prompt.finished provider=zenity result=not_attempted input=nonempty code=42 stderr=empty",
      "[elevation] prompt.finished provider=zenity result=not_attempted input=nonempty code=0 stderr=password=senha-super-secreta",
      "[elevation] sudo.validation provider=sudo result=rejected code=1 phase=password token=abc123",
      "[elevation] sudo.credential_store provider=zenity result=failed reason=temporary_file password=senha-super-secreta phase=password",
      "[elevation] pkexec.invoked provider=pkexec result=requested code=126 phase=polkit",
      "[elevation] prompt.finished provider=zenity result=not_attempted code=0 input=nonempty stderr=empty",
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
