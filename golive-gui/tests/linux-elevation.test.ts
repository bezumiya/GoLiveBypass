import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const source = fs.readFileSync(
  path.resolve(process.cwd(), "../standalone/golivebypass-standalone.sh"),
  "utf8",
);
const functions = source.slice(source.indexOf("have() {"), source.indexOf("# Ler campo a campo"));

function runElevation(options: {
  cached?: boolean;
  pkexec?: boolean;
  zenity?: "cancel";
  readonly?: boolean;
  readonlyElevate?: boolean;
  authReady?: boolean;
  cachedPass?: boolean;
}) {
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
    "exit 0",
  ].join("\n"));
  if (options.pkexec) write("pkexec", 'echo "pkexec:$*" >> "$LOG"; exit 0');
  if (options.zenity) write("zenity", 'echo "zenity" >> "$LOG"; exit 1');

  const call = options.readonly ? 'elevate_readonly true' : 'elevate true';
  const passFile = path.join(dir, "pass");
  fs.writeFileSync(passFile, "test\n");
  const script = `${functions}\nSUDO_AUTH_READY=${options.authReady ? 1 : 0}\nSUDO_USE_CACHED_PASS=${options.cachedPass ? 1 : 0}\nSUDO_PASS_FILE=${options.cachedPass ? passFile : ""}\nNONINTERACTIVE=${options.readonly || options.readonlyElevate ? 1 : 0}\nGOLIVE_GUI=1\necho before >> "$LOG"\n${options.readonlyElevate ? "elevate true" : call}\necho rc:$? >> "$LOG"`;
  try {
    execFileSync("/bin/sh", ["-c", script], {
      env: { ...process.env, PATH: bin, LOG: path.join(dir, "log") },
      stdio: "ignore",
    });
  } catch {
    // A rejected sudo/pkexec is part of the behavior under test; inspect the log.
  }
  const log = fs.existsSync(path.join(dir, "log"))
    ? fs.readFileSync(path.join(dir, "log"), "utf8")
    : "";
  fs.rmSync(dir, { recursive: true, force: true });
  return log;
}

describe("elevacao Linux no standalone", () => {
  it("usa sudo quando a autorizacao ja esta cacheada", () => {
    const log = runElevation({ cached: true, pkexec: true });
    expect(log).toContain("sudo:");
    expect(log).not.toContain("pkexec:");
  });

  it("usa pkexec quando sudo nao tem prompt grafico", () => {
    const log = runElevation({ pkexec: true });
    expect(log).toContain("pkexec:");
    expect(log).not.toContain("sudo:-S");
  });

  it("nao faz fallback para pkexec quando o prompt zenity e cancelado", () => {
    const log = runElevation({ pkexec: true, zenity: "cancel" });
    expect(log).toContain("zenity");
    expect(log).not.toContain("pkexec:");
    expect(log).not.toContain("sudo:true");
  });

  it("mantem probes readonly sem prompt", () => {
    const log = runElevation({ pkexec: true, readonly: true });
    expect(log).not.toContain("pkexec:");
    expect(log).not.toContain("zenity");
  });

  it("nao usa pkexec quando elevate e chamado em modo non-interactive", () => {
    const log = runElevation({ pkexec: true, readonlyElevate: true });
    expect(log).not.toContain("pkexec:");
  });

  it("preserva senha sudo cacheada mesmo quando sudo-n falha depois", () => {
    const log = runElevation({ pkexec: true, authReady: true, cachedPass: true });
    expect(log).toContain("sudo:");
    expect(log).not.toContain("pkexec:");
  });
});
