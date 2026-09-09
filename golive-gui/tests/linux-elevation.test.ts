import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const source = fs.readFileSync(
  path.resolve(process.cwd(), "../standalone/golivebypass-standalone.sh"),
  "utf8",
);
const functions = source.slice(source.indexOf("have() {"), source.indexOf("# Ler campo a campo"));

type PromptMode =
  | "zenity-accepted"
  | "zenity-empty"
  | "zenity-cancel"
  | "kdialog-accepted";

type ElevationOptions = {
  cached?: boolean;
  prompt?: PromptMode;
  sudoValidation?: "accepted" | "rejected";
  pkexec?: boolean;
  noPrompt?: boolean;
  readonly?: boolean;
  readonlyElevate?: boolean;
  authReady?: boolean;
  cachedPass?: boolean;
};

type ElevationResult = {
  log: string;
  stdout: string;
  stderr: string;
  status: number | null;
};

function runElevation(options: ElevationOptions): ElevationResult {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "golive-elevation-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  for (const command of ["cat", "chmod", "mktemp", "rm"]) {
    fs.symlinkSync(`/usr/bin/${command}`, path.join(bin, command));
  }

  const write = (name: string, body: string) => {
    const file = path.join(bin, name);
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
    fs.chmodSync(file, 0o755);
  };

  write("id", 'if [ "$1" = "-u" ]; then echo 1000; else /usr/bin/id "$@"; fi');
  write("sudo", [
    'echo "sudo:$*" >> "$LOG"',
    'if [ "$1" = "-n" ] && [ "$2" = "true" ]; then',
    `  [ "${options.cached ? "1" : "0"}" = 1 ] && exit 0 || exit 1`,
    "fi",
    'if [ "$1" = "-S" ]; then',
    '  input="$(/usr/bin/cat)"',
    '  if [ -n "$input" ]; then echo "sudo_validate:nonempty" >> "$LOG"; fi',
    `  [ "${options.sudoValidation ?? "accepted"}" = accepted ] && exit 0 || exit 1`,
    "fi",
    "exit 0",
  ].join("\n"));

  if (options.pkexec) {
    write("pkexec", 'echo "pkexec:$*" >> "$LOG"; exit 0');
  }

  const promptProvider = options.prompt?.startsWith("kdialog") ? "kdialog" : "zenity";
  const promptMode = options.prompt?.replace(/^(zenity|kdialog)-/, "") ?? "";
  if (options.prompt && !options.noPrompt) {
    const prompt = [
      `echo "prompt:${promptProvider}" >> "$LOG"`,
      'case "$PROMPT_MODE" in',
      '  accepted) printf "%s\\n" "$PROMPT_SECRET"; exit 0 ;;',
      '  empty) exit 0 ;;',
      '  cancel) exit 1 ;;',
      '  *) exit 1 ;;',
      "esac",
    ].join("\n");
    write(promptProvider, prompt);
  }

  const call = options.readonly ? "elevate_readonly true" : "elevate true";
  const passFile = path.join(dir, "pass");
  const secret = "unit-test-sudo-secret";
  fs.writeFileSync(passFile, `${secret}\n`);
  const script = [
    functions,
    `SUDO_AUTH_READY=${options.authReady ? 1 : 0}`,
    `SUDO_USE_CACHED_PASS=${options.cachedPass ? 1 : 0}`,
    `SUDO_PASS_FILE=${options.cachedPass ? passFile : ""}`,
    `NONINTERACTIVE=${options.readonly || options.readonlyElevate ? 1 : 0}`,
    "GOLIVE_GUI=1",
    "printf '%s\\n' stdout-marker",
    `if ${options.readonlyElevate ? "elevate true" : call}; then rc=0; else rc=$?; fi`,
    'echo "rc:$rc" >> "$LOG"',
    'exit "$rc"',
  ].join("\n");

  const result = spawnSync("/bin/sh", ["-c", script], {
    env: {
      ...process.env,
      PATH: bin,
      LOG: path.join(dir, "log"),
      PROMPT_MODE: promptMode,
      PROMPT_SECRET: secret,
      TMPDIR: dir,
    },
    encoding: "utf8",
  });
  const logPath = path.join(dir, "log");
  const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
  const stdout = String(result.stdout ?? "");
  const stderr = String(result.stderr ?? "");
  const status = result.status;
  fs.rmSync(dir, { recursive: true, force: true });
  return { log, stdout, stderr, status };
}

describe("elevacao Linux no standalone", () => {
  it("usa sudo quando a autorizacao ja esta cacheada", () => {
    const result = runElevation({ cached: true, pkexec: true });
    expect(result.status).toBe(0);
    expect(result.log).toContain("sudo:");
    expect(result.log).not.toContain("pkexec:");
    expect(result.log).not.toContain("prompt:");
  });

  it("registra que o prompt zenity foi solicitado e aceito", () => {
    const result = runElevation({
      prompt: "zenity-accepted",
      sudoValidation: "accepted",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("stdout-marker");
    expect(result.log).toContain("prompt:zenity");
    expect(result.stderr).toContain("prompt.requested provider=zenity");
    expect(result.stderr).toMatch(
      /prompt\.finished provider=zenity result=not_attempted input=nonempty code=0/,
    );
    expect(result.stderr).not.toMatch(/prompt\.finished[^\n]*result=accepted/);
    expect(result.stderr).toMatch(/sudo\.validation provider=zenity result=accepted code=0/);
    expect(result.log).toContain("sudo_validate:nonempty");
    expect(`${result.log}\n${result.stdout}\n${result.stderr}`).not.toContain(
      "unit-test-sudo-secret",
    );
  });

  it("aceita o prompt kdialog e nunca registra a senha", () => {
    const result = runElevation({
      prompt: "kdialog-accepted",
      sudoValidation: "accepted",
    });
    expect(result.status).toBe(0);
    expect(result.log).toContain("prompt:kdialog");
    expect(result.stderr).toContain("prompt.requested provider=kdialog");
    expect(result.stderr).toMatch(
      /prompt\.finished provider=kdialog result=not_attempted input=nonempty code=0/,
    );
    expect(result.stderr).not.toMatch(/prompt\.finished[^\n]*result=accepted/);
    expect(result.stderr).toMatch(/sudo\.validation provider=kdialog result=accepted code=0/);
    expect(`${result.log}\n${result.stdout}\n${result.stderr}`).not.toContain(
      "unit-test-sudo-secret",
    );
  });

  it("distingue prompt vazio de prompt cancelado", () => {
    const empty = runElevation({ prompt: "zenity-empty" });
    expect(empty.status).not.toBe(0);
    expect(empty.log).toContain("prompt:zenity");
    expect(empty.stderr).toMatch(
      /prompt\.finished provider=zenity result=empty input=empty code=0/,
    );
    expect(empty.stderr).not.toMatch(/sudo\.validation .*result=accepted/);
    expect(empty.log).not.toContain("sudo_validate:nonempty");

    const cancelled = runElevation({ prompt: "zenity-cancel" });
    expect(cancelled.status).not.toBe(0);
    expect(cancelled.stderr).toMatch(
      /prompt\.finished provider=zenity result=cancelled input=empty code=1/,
    );
    expect(cancelled.stderr).not.toMatch(/sudo\.validation .*result=accepted/);
    expect(cancelled.log).not.toContain("sudo_validate:nonempty");
  });

  it("distingue prompt aceito de senha sudo recusada", () => {
    const result = runElevation({
      prompt: "zenity-accepted",
      sudoValidation: "rejected",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(
      /prompt\.finished provider=zenity result=not_attempted input=nonempty code=0/,
    );
    expect(result.stderr).not.toMatch(/prompt\.finished[^\n]*result=rejected/);
    expect(result.stderr).toMatch(/sudo\.validation provider=zenity result=rejected code=1/);
    expect(result.log).toContain("sudo_validate:nonempty");
    expect(`${result.log}\n${result.stdout}\n${result.stderr}`).not.toContain(
      "unit-test-sudo-secret",
    );
  });

  it("usa pkexec quando sudo nao tem prompt grafico", () => {
    const result = runElevation({ pkexec: true, noPrompt: true });
    expect(result.status).toBe(0);
    expect(result.log).toContain("pkexec:");
    expect(result.log).not.toContain("prompt:");
    expect(result.log).not.toContain("sudo_validate:nonempty");
    expect(result.stderr).toContain("provider=pkexec");
  });

  it("mantem probes readonly sem prompt", () => {
    const result = runElevation({ pkexec: true, readonly: true });
    expect(result.status).not.toBe(0);
    expect(result.log).not.toContain("pkexec:");
    expect(result.log).not.toContain("prompt:");
    expect(result.stderr).not.toMatch(/prompt\.|pkexec/);
  });

  it("nao usa pkexec nem prompt quando elevate e chamado em modo non-interactive", () => {
    const result = runElevation({ pkexec: true, readonlyElevate: true });
    expect(result.status).not.toBe(0);
    expect(result.log).not.toContain("pkexec:");
    expect(result.log).not.toContain("prompt:");
  });

  it("preserva senha sudo cacheada mesmo quando sudo-n falha depois", () => {
    const result = runElevation({ cached: false, pkexec: true, authReady: true, cachedPass: true });
    expect(result.status).toBe(0);
    expect(result.log).toContain("sudo:");
    expect(result.log).toContain("sudo_validate:nonempty");
    expect(result.log).not.toContain("pkexec:");
    expect(`${result.log}\n${result.stdout}\n${result.stderr}`).not.toContain(
      "unit-test-sudo-secret",
    );
  });
});
