import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

const source = fs.readFileSync(path.resolve(process.cwd(), "../standalone/golivebypass-standalone.sh"), "utf8");
const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await exited;
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function runHelpers(script: string) {
  const functions = ["normalize_pid", "parallel_app_root_for_resources", "parallel_process_belongs_to_resources", "parallel_pids_for_resources", "parallel_pid_for_resources", "kill_parallel_by_path", "discord_running", "running_flav", "discord_pid_flav", "select_launch_target"]
    .map(name => {
      const fn = source.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, "m"));
      if (!fn) throw new Error(`helper ausente: ${name}`);
      return fn[0];
    }).join("\n");
  return spawnSync("/bin/sh", ["-c", `${functions}\n${script}`], { encoding: "utf8" });
}

// Depende de /proc, pgrep, find GNU e /bin/sh do Linux.
describe.skipIf(process.platform !== "linux")("identidade do cliente Linux ao relançar", () => {
  it("escolhe o Flatpak em execução quando o bootstrap anterior só tem o mesmo flavour", () => {
    const result = runHelpers([
      'pgrep() { printf "424242\\n"; }',
      'flatpak_running_id() { [ "$1" = com.discordapp.Discord ]; }',
      'target_can_launch() { return 1; }',
      'select_launch_target "/nao-existe/bootstrap/resources|discord|bootstrap|',
      '/var/lib/flatpak/app/com.discordapp.Discord/current/active/files/discord/resources|discord|flatpak|com.discordapp.Discord"',
    ].join("\n"));
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("/var/lib/flatpak/app/com.discordapp.Discord/current/active/files/discord/resources|discord|flatpak|com.discordapp.Discord");
  });

  it("não confirma um Flatpak fechado pelo PID de outro Discord", () => {
    const result = runHelpers([
      'pgrep() { printf "424242\\n"; }',
      'flatpak_running_id() { return 1; }',
      'flatpak_pid_for_id() { return 1; }',
      'if running_flav discord com.discordapp.Discord /nao-existe/resources; then echo running; fi',
      'if discord_pid_flav discord com.discordapp.Discord /nao-existe/resources; then echo accepted; fi',
      'exit 0',
    ].join("\n"));
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("identifica somente o Discord nativo da instalação selecionada", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "golive-native-identity-"));
    roots.push(root);
    const resources = path.join(root, "resources");
    fs.mkdirSync(resources);
    const executable = path.join(root, "Discord");
    fs.copyFileSync("/bin/sleep", executable);
    const client = spawn(executable, ["30"]);
    children.push(client);
    await new Promise<void>(resolve => client.once("spawn", resolve));
    const result = runHelpers([
      'pgrep() { printf "424242\\n"; }',
      'discord_pid_flav discord "" "$1"',
    ].join("\n").replace('"$1"', `'${resources}'`));
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(String(client.pid));
  });

  // O caso spawna dois processos e roda `find`: sob a suíte completa em paralelo ele passa
  // dos 5 s padrão. O prazo maior não muda a asserção, só evita flake por carga da máquina.
  it.each(["gnu", "unsupported"])("restringe a instalação com app.asar direto e preserva executável irmão com find %s", async mode => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "golive-direct-asar-"));
    roots.push(root);
    const resources = path.join(root, "lib", "equibop");
    fs.mkdirSync(resources, { recursive: true });
    fs.writeFileSync(path.join(resources, "app.asar"), "");
    const executable = path.join(resources, "equibop");
    const sibling = path.join(root, "lib", "session-helper");
    fs.copyFileSync("/bin/sleep", executable);
    fs.copyFileSync("/bin/sleep", sibling);
    const unrelated = spawn(sibling, ["30"]);
    const client = spawn(executable, ["30"]);
    children.push(unrelated, client);
    await Promise.all([client, unrelated].map(child => new Promise<void>(resolve => child.once("spawn", resolve))));
    const setup = [
      "find() {",
      mode === "unsupported" ? '  for arg in "$@"; do [ "$arg" != -printf ] || return 1; done' : "",
      '  command find "$@"',
      "}",
    ].join("\n");
    const identity = runHelpers(`${setup}\nparallel_pids_for_resources '${resources}'`);
    expect(identity.stdout.trim().split("\n")).toEqual([String(client.pid)]);
    const siblingIdentity = runHelpers(`if parallel_process_belongs_to_resources '${resources}' '${unrelated.pid}'; then echo accepted; fi\nexit 0`);
    expect(siblingIdentity.status, siblingIdentity.stderr).toBe(0);
    expect(siblingIdentity.stdout).toBe("");
    const exited = new Promise<void>(resolve => client.once("exit", () => resolve()));
    const stopped = runHelpers(`${setup}\nFOUND='${resources}|equibop|paralelo|'\nkill_parallel_by_path -9`);
    expect(stopped.status, stopped.stderr).toBe(0);
    await exited;
    expect(client.signalCode).toBe("SIGKILL");
    expect(unrelated.exitCode).toBeNull();
    expect(unrelated.signalCode).toBeNull();
  }, 30_000);

  it.each(["gnu", "unsupported", "race"])("localiza executável nativo de nome arbitrário com find %s", async mode => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "golive-proc-snapshot-"));
    roots.push(root);
    const resources = path.join(root, "app", "resources");
    fs.mkdirSync(resources, { recursive: true });
    const executable = path.join(root, "app", "cliente-renomeado");
    fs.copyFileSync("/bin/sleep", executable);
    const client = spawn(executable, ["30"]);
    const unrelated = spawn("/bin/sleep", ["30"]);
    children.push(client, unrelated);
    await Promise.all([client, unrelated].map(child => new Promise<void>(resolve => child.once("spawn", resolve))));
    const trace = path.join(root, "readlink-trace");
    const result = runHelpers([
      `TRACE='${trace}'`,
      `MODE='${mode}'`,
      "readlink() {",
      '  case "$1" in /proc/*/exe) printf "%s\\n" "$1" >> "$TRACE" ;; esac',
      '  command readlink "$@"',
      "}",
      "find() {",
      '  if [ "$MODE" = unsupported ]; then',
      '    for arg in "$@"; do [ "$arg" != -printf ] || return 1; done',
      "  fi",
      '  command find "$@"',
      // /proc muda durante a captura: uma saída parcial válida não pode disparar
      // a varredura lenta de todos os processos outra vez.
      '  if [ "$MODE" = race ] && [ "$1" != /proc/self/exe ]; then return 1; fi',
      "}",
      `parallel_pid_for_resources '${resources}'`,
    ].join("\n"));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(String(client.pid));
    const lookups = fs.readFileSync(trace, "utf8").trim().split("\n");
    expect(lookups).toContain(`/proc/${client.pid}/exe`);
    if (mode === "unsupported") expect(lookups).toContain(`/proc/${unrelated.pid}/exe`);
    else expect(lookups).not.toContain(`/proc/${unrelated.pid}/exe`);
  });

  it.each(["electron", "electron34/runtime"])("mantém o Electron compartilhado %s com app.asar na linha de comando", async runtime => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "golive-electron-identity-"));
    roots.push(root);
    const resources = path.join(root, "app", "resources");
    fs.mkdirSync(resources, { recursive: true });
    // O interpretador ELF vive fora da instalação, como o Electron do sistema.
    const executable = path.join(root, "runtime", runtime);
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.copyFileSync("/bin/bash", executable);
    const client = spawn(executable, ["-c", "read -r _", path.join(resources, "app.asar")], { stdio: ["pipe", "ignore", "ignore"] });
    children.push(client);
    await new Promise<void>(resolve => client.once("spawn", resolve));
    const result = runHelpers(`parallel_pid_for_resources '${resources}'`);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(String(client.pid));
  });

  it("mantém o Electron compartilhado ativo após seu executável ser substituído", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "golive-deleted-electron-"));
    roots.push(root);
    const resources = path.join(root, "app", "resources");
    fs.mkdirSync(resources, { recursive: true });
    const executable = path.join(root, "runtime", "electron");
    fs.mkdirSync(path.dirname(executable));
    fs.copyFileSync("/bin/bash", executable);
    const client = spawn(executable, ["-c", "read -r _", path.join(resources, "app.asar")], { stdio: ["pipe", "ignore", "ignore"] });
    children.push(client);
    await new Promise<void>(resolve => client.once("spawn", resolve));
    fs.unlinkSync(executable);
    const result = runHelpers(`parallel_pid_for_resources '${resources}'`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(String(client.pid));
  });

  it.each([" ", "\n"])("rejeita menção incidental ao app.asar dentro de argumento separado por %j", async separator => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "golive-shell-identity-"));
    roots.push(root);
    const resources = path.join(root, "app", "resources");
    fs.mkdirSync(resources, { recursive: true });
    const executable = path.join(root, "runtime", "electron");
    fs.mkdirSync(path.dirname(executable));
    fs.copyFileSync("/bin/bash", executable);
    const unrelated = spawn(executable, ["-c", `read -r _ #${separator}${resources}/app.asar${separator}#`], { stdio: ["pipe", "ignore", "ignore"] });
    children.push(unrelated);
    await new Promise<void>(resolve => unrelated.once("spawn", resolve));
    const result = runHelpers(`if parallel_process_belongs_to_resources '${resources}' '${unrelated.pid}'; then echo accepted; fi\nexit 0`);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("identifica o Electron com argv reescrito pelo Chromium (NULs viraram espaços)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "golive-argv-rewrite-"));
    roots.push(root);
    const resources = path.join(root, "app", "resources");
    fs.mkdirSync(resources, { recursive: true });
    const executable = path.join(root, "runtime", "electron");
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.copyFileSync("/bin/bash", executable);
    // O Chromium troca os NULs do argv por espaços e deixa um NUL só no fim
    // (provado no NixOS real, Electron 42/43): argv0 carrega a linha colada.
    const rewritten = `electron --no-sandbox ${path.join(resources, "app.asar")}`;
    const client = spawn(executable, [], { argv0: rewritten, stdio: ["pipe", "ignore", "ignore"] });
    children.push(client);
    await new Promise<void>(resolve => client.once("spawn", resolve));
    const cmdline = fs.readFileSync(`/proc/${client.pid}/cmdline`, "utf8");
    expect(cmdline).toBe(`${rewritten}\0`);
    const result = runHelpers(`parallel_pid_for_resources '${resources}'`);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(String(client.pid));
  });

  it("detecta e encerra o Discord oficial com Electron compartilhado sem atingir outro processo", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "golive-official-shared-"));
    roots.push(root);
    const resources = path.join(root, "app", "resources");
    fs.mkdirSync(resources, { recursive: true });
    const executable = path.join(root, "runtime", "electron");
    fs.mkdirSync(path.dirname(executable));
    fs.copyFileSync("/bin/bash", executable);
    const client = spawn(executable, ["-c", "read -r _", path.join(resources, "app.asar")], { stdio: ["pipe", "ignore", "ignore"] });
    const unrelated = spawn(executable, ["-c", "read -r _", path.join(root, "other", "app.asar")], { stdio: ["pipe", "ignore", "ignore"] });
    children.push(client, unrelated);
    await Promise.all([client, unrelated].map(child => new Promise<void>(resolve => child.once("spawn", resolve))));
    const result = runHelpers([
      'pgrep() { return 1; }',
      'have() { return 1; }',
      `FOUND='${resources}|discord|nativo|'`,
      'discord_running && echo running',
      'kill_parallel_by_path -9',
    ].join("\n"));
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("running\n");
    if (client.exitCode === null && client.signalCode === null) await new Promise<void>(resolve => client.once("exit", () => resolve()));
    expect(client.signalCode).toBe("SIGKILL");
    expect(unrelated.exitCode).toBeNull();
    expect(unrelated.signalCode).toBeNull();
  });

  it("lança o Discord na unidade systemd com env absoluto e PATH do scan (NixOS)", () => {
    const launcher = ["run_user_systemd_command"]
      .map(name => {
        const fn = source.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, "m"));
        if (!fn) throw new Error(`helper ausente: ${name}`);
        return fn[0];
      }).join("\n");
    // A unidade parte de um PATH mínimo que no NixOS não contém o coreutils
    // do store: `env` relativo morre com "comando não encontrado" antes de o
    // Discord nascer, e alvos relativos (vesktop) e o `sh -c` não resolvem.
    const script = [
      launcher,
      'elevate() { printf "%s\\n" "$@"; }',
      'NETNS_NAME=discord-vpn',
      'RUN_USER_METHOD=sudo',
      'RUN_USER_NAME=testuser',
      'SUDO_BIN=/run/wrappers/bin/sudo',
      'ENV_BINARY=/run/current-system/sw/bin/env',
      'PATH=/run/current-system/sw/bin:/usr/bin:/bin',
      'run_user_systemd_command "discord-vpn-123" "PATH=$PATH" "HOME=/home/testuser" sh -c \'exec "$@"\' sh vesktop',
    ].join("\n");
    const result = spawnSync("/bin/sh", ["-c", script], { encoding: "utf8" });
    expect(result.status).toBe(0);
    const lines = result.stdout.trim().split("\n");
    expect(lines).toContain("/run/current-system/sw/bin/env");
    expect(lines).not.toContain("env");
    expect(lines).toContain("PATH=/run/current-system/sw/bin:/usr/bin:/bin");
    expect(lines[lines.indexOf("/run/current-system/sw/bin/env") + 1]).toBe("PATH=/run/current-system/sw/bin:/usr/bin:/bin");
  });
});
