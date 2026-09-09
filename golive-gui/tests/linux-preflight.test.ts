import { afterEach, describe, expect, it } from "vitest";
import { linuxPreflightRepairable, linuxPreflightMessage, parseLinuxPreflight } from "../electron/linux-preflight";
import fs from "fs";
import path from "path";
import os from "os";
import { execFileSync, spawnSync } from "child_process";

const tempRoots: string[] = [];
afterEach(() => { for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("preflight Linux", () => {
  it("mapeia dependencias ausentes do Arch para um comando pacman copiavel", () => {
    const result = parseLinuxPreflight(JSON.stringify({
      ok: false,
      platform: "linux",
      distro: "Arch Linux",
      archLike: true,
      dependencies: { missing: ["wireguard-tools", "iproute2", "curl"], required: ["wg", "ip", "curl"] },
      elevation: { available: true, method: "sudo" },
      netns: { available: true }, kernel: { wireguard: "unknown" },
      discord: { found: true, count: 1, firstPath: "/usr/share/discord/resources" },
      errors: ["wg (wireguard-tools)"],
      installCommand: "sudo pacman -S --needed wireguard-tools iproute2 curl",
    }));
    expect(result.ok).toBe(false);
    expect(result.archLike).toBe(true);
    expect(result.dependencies.missing).toEqual(["wireguard-tools", "iproute2", "curl"]);
    expect(linuxPreflightMessage(result)).toContain("wireguard-tools");
  });

  it("aceita WireGuard ativo sem transformar kernel desconhecido em falha", () => {
    const result = parseLinuxPreflight(JSON.stringify({
      ok: true, distro: "Arch Linux", archLike: true,
      dependencies: { missing: [], required: ["wg", "ip", "curl"] },
      elevation: { available: true, method: "sudo" }, netns: { available: true },
      kernel: { wireguard: "unknown" }, discord: { found: true, count: 2 }, errors: [], installCommand: "",
    }));
    expect(result.ok).toBe(true);
    expect(result.kernel.wireguard).toBe("unknown");
    expect(linuxPreflightRepairable(result)).toBe(false);
  });

  it("permite reparar pacotes conhecidos quando falta iproute2, mas não inventa capacidade pronta", () => {
    const base = parseLinuxPreflight(JSON.stringify({
      ok: false, platform: "linux", dependencies: { missing: ["iproute2"], required: ["wg", "ip", "curl"] },
      elevation: { available: true, method: "sudo" }, netns: { available: true },
      discord: { found: true, count: 1 }, kernel: { wireguard: "unknown" }, errors: [],
    }));
    expect(linuxPreflightRepairable(base)).toBe(true);
    for (const change of [
      { discord: { found: false, count: 0 } },
      { elevation: { available: false, method: "none" } },
      { dependencies: { missing: ["openssl"], required: ["wg", "ip", "curl"] } },
    ]) {
      expect(linuxPreflightRepairable(parseLinuxPreflight(JSON.stringify({ ...base, ...change })))).toBe(false);
    }
    expect(linuxPreflightRepairable(parseLinuxPreflight(JSON.stringify({ ...base, netns: { available: false } })))).toBe(true);
    expect(linuxPreflightRepairable(parseLinuxPreflight(JSON.stringify({ ...base, netns: { available: false }, dependencies: { missing: ["curl"], required: ["wg", "ip", "curl"] } })))).toBe(false);
  });

  it("rejeita JSON quebrado sem vazar um erro generico para a UI", () => {
    expect(() => parseLinuxPreflight("nao-json")).toThrow(/JSON inválido/);
  });

  it("o standalone oferece preflight e nao instala pacotes sozinho", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "../standalone/golivebypass-standalone.sh"), "utf8");
    expect(source).toContain("--preflight");
    expect(source).toContain("sudo pacman -S --needed");
    expect(source).not.toMatch(/^\s*(?:sudo\s+)?pacman\s+-S/m);
  });

  it("a ativacao Linux verifica o ambiente antes de limpar legado", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "electron/main.ts"), "utf8");
    const activation = source.slice(source.indexOf("async function linuxActivate"), source.indexOf("async function linuxDeactivate"));
    expect(activation.indexOf("linuxPreflight(")) .toBeGreaterThanOrEqual(0);
    expect(activation.indexOf("linuxPreflight(")) .toBeLessThan(activation.indexOf("--cleanup-legacy"));
    expect(activation).toContain('await linuxStatus() === "ACTIVE"');
    expect(source).toContain("let linuxStatusInFlight: Promise<string> | null = null");
  });

  it("autoriza a elevacao antes de fechar o Discord no fluxo de instalacao", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "../standalone/golivebypass-standalone.sh"), "utf8");
    const installStart = source.indexOf('FOUND="$(escolher_alvos patchear)"');
    const installEnd = source.indexOf("\nwhile IFS='|' read", installStart);
    expect(installStart).toBeGreaterThanOrEqual(0);
    expect(installEnd).toBeGreaterThan(installStart);

    const install = source.slice(installStart, installEnd);
    const authorizeIndex = install.indexOf("\nauthorize_install_elevation");
    const stopIndex = install.indexOf("\nstop_discord");
    expect(authorizeIndex).toBeGreaterThanOrEqual(0);
    expect(stopIndex).toBeGreaterThanOrEqual(0);
    expect(authorizeIndex).toBeLessThan(stopIndex);
    expect(install).toMatch(/authorize_install_elevation\s+\|\|\s+fail/);
  });

  it("não chama a barreira nos modos status, preflight e ensure-dependencies", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "../standalone/golivebypass-standalone.sh"), "utf8");
    const ensureStart = source.indexOf('[ "$MODE" = "ensure-dependencies" ] && {');
    const preflightStart = source.indexOf('[ "$MODE" = "preflight" ] && {');
    const foundStart = source.indexOf('FOUND="$(discord_dirs)"');
    const preflightEnd = source.indexOf('[ -n "$FOUND" ] || fail', preflightStart);
    const statusStart = source.indexOf('if [ "$MODE" = "status" ]');
    const statusEnd = source.indexOf('if [ "$MODE" = "uninstall" ] || [ "$MODE" = "restore" ]', statusStart);
    expect(ensureStart).toBeGreaterThanOrEqual(0);
    expect(foundStart).toBeGreaterThan(ensureStart);
    expect(preflightStart).toBeGreaterThan(foundStart);
    expect(preflightEnd).toBeGreaterThan(preflightStart);
    expect(statusStart).toBeGreaterThan(preflightEnd);
    expect(statusEnd).toBeGreaterThan(statusStart);

    const modeBlocks = [
      source.slice(ensureStart, foundStart),
      source.slice(preflightStart, preflightEnd),
      source.slice(statusStart, statusEnd),
    ];
    for (const block of modeBlocks) {
      expect(block).not.toMatch(/^\s*authorize_install_elevation\b/m);
    }
  });

  it("não fecha o Discord quando a autorização falha e mantém a ordem quando aceita", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "../standalone/golivebypass-standalone.sh"), "utf8");
    const authorizeMatch = source.match(/authorize_install_elevation\(\) \{[\s\S]*?\n\}\n\n# Variante somente-leitura/);
    const callMatch = source.match(/^authorize_install_elevation \|\| fail "[^\n]*"$/m);
    if (!authorizeMatch || !callMatch) {
      throw new Error("O standalone não contém a barreira de autorização esperada");
    }

    const runGuard = (outcome: "accepted" | "rejected") => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "golive-auth-order-"));
      tempRoots.push(root);
      const harness = path.join(root, "authorization.sh");
      fs.writeFileSync(harness, [
        "#!/bin/sh",
        "id() { if [ \"$1\" = \"-u\" ]; then printf '1000\\n'; return 0; fi; return 1; }",
        "elevation_event() { :; }",
        "elevate() { printf '%s\\n' authorize >> \"$ORDER\"; [ \"$AUTH_OUTCOME\" = accepted ]; }",
        "ELEVATION_PROVIDER=none",
        "ELEVATION_RESULT=not_attempted",
        authorizeMatch[0],
        "fail() { printf '%s\\n' \"$1\" >&2; exit 1; }",
        "stop_discord() { printf '%s\\n' stop >> \"$ORDER\"; }",
        callMatch[0],
        "stop_discord",
        "exit 0",
      ].join("\n"));
      fs.chmodSync(harness, 0o755);
      const order = path.join(root, "order");
      const run = spawnSync("/bin/sh", [harness], {
        env: { ...process.env, AUTH_OUTCOME: outcome, ORDER: order },
        encoding: "utf8",
      });
      const orderLog = fs.existsSync(order) ? fs.readFileSync(order, "utf8") : "";
      return { orderLog, run };
    };

    const rejected = runGuard("rejected");
    expect(rejected.run.status).toBe(1);
    expect(rejected.orderLog).toBe("authorize\n");
    expect(rejected.orderLog).not.toContain("stop");
    expect(rejected.run.stderr).toContain("Discord nao foi encerrado");

    const accepted = runGuard("accepted");
    expect(accepted.run.status).toBe(0);
    expect(accepted.orderLog).toBe("authorize\nstop\n");
  });

  it("limpa recursos legados depois da autorizacao e antes de fechar o Discord", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "../standalone/golivebypass-standalone.sh"), "utf8");
    const installStart = source.indexOf('FOUND="$(escolher_alvos patchear)"');
    const installEnd = source.indexOf("\nwhile IFS='|' read", installStart);
    expect(installStart).toBeGreaterThanOrEqual(0);
    expect(installEnd).toBeGreaterThan(installStart);
    const install = source.slice(installStart, installEnd);

    const authorizeIndex = install.indexOf("\nauthorize_install_elevation");
    const cleanupIndex = install.indexOf('\nif [ "$CLEANUP_LEGACY" -eq 1 ]; then');
    const stopIndex = install.indexOf("\nstop_discord");
    expect(authorizeIndex).toBeGreaterThanOrEqual(0);
    expect(cleanupIndex).toBeGreaterThan(authorizeIndex);
    expect(stopIndex).toBeGreaterThan(cleanupIndex);

    const authorizeFunction = source.match(/authorize_install_elevation\(\) \{[\s\S]*?\n\}\n\n# Variante somente-leitura/);
    const authorizeCall = install.match(/^authorize_install_elevation \|\| fail "[^\n]*"$/m);
    const cleanupBlock = install.match(/^if \[ "\$CLEANUP_LEGACY" -eq 1 \]; then\n    cleanup_legacy_tor\nfi$/m);
    if (!authorizeFunction || !authorizeCall || !cleanupBlock) {
      throw new Error("O fluxo de instalacao nao contem as barreiras de limpeza esperadas");
    }

    const runInstallOrder = (outcome: "accepted" | "rejected") => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "golive-cleanup-order-"));
      tempRoots.push(root);
      const harness = path.join(root, "install-order.sh");
      fs.writeFileSync(harness, [
        "#!/bin/sh",
        "id() { if [ \"$1\" = \"-u\" ]; then printf '1000\\n'; return 0; fi; return 1; }",
        "elevation_event() { :; }",
        "elevate() { printf '%s\\n' authorize >> \"$ORDER\"; [ \"$AUTH_OUTCOME\" = accepted ]; }",
        "cleanup_legacy_tor() { printf '%s\\n' cleanup >> \"$ORDER\"; }",
        "stop_discord() { printf '%s\\n' stop >> \"$ORDER\"; }",
        "fail() { printf '%s\\n' \"$1\" >&2; exit 1; }",
        "ELEVATION_PROVIDER=none",
        "ELEVATION_RESULT=not_attempted",
        "CLEANUP_LEGACY=1",
        authorizeFunction[0],
        authorizeCall[0],
        cleanupBlock[0],
        "stop_discord",
        "exit 0",
      ].join("\n"));
      fs.chmodSync(harness, 0o755);
      const order = path.join(root, "order");
      const run = spawnSync("/bin/sh", [harness], {
        env: { ...process.env, AUTH_OUTCOME: outcome, ORDER: order },
        encoding: "utf8",
      });
      const orderLog = fs.existsSync(order) ? fs.readFileSync(order, "utf8") : "";
      return { orderLog, run };
    };

    const rejected = runInstallOrder("rejected");
    expect(rejected.run.status).toBe(1);
    expect(rejected.orderLog).toBe("authorize\n");
    expect(rejected.orderLog).not.toContain("cleanup");
    expect(rejected.orderLog).not.toContain("stop");

    const accepted = runInstallOrder("accepted");
    expect(accepted.run.status).toBe(0);
    expect(accepted.orderLog).toBe("authorize\ncleanup\nstop\n");
  });

  it("mantem o rollback pendente ate o Discord iniciar e o limpa depois da confirmacao", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "../standalone/golivebypass-standalone.sh"), "utf8");
    expect(source).toMatch(/^ACTIVATION_ROLLBACK_PENDING=0$/m);
    expect(source).toMatch(/^ACTIVATION_ROLLBACK_REOPEN=0$/m);
    expect(source).toMatch(/^rollback_activation\(\) \{/m);

    const rollbackStart = source.indexOf("rollback_activation() {");
    const rollbackTrap = source.indexOf("\ntrap cleanup_sudo_pass", rollbackStart);
    const rollbackFunction = rollbackStart >= 0 && rollbackTrap > rollbackStart
      ? source.slice(rollbackStart, rollbackTrap).trim()
      : null;
    const startIndex = source.indexOf('start_discord "$(printf');
    const completionEnd = source.indexOf("\nprintf '\\n  %sDiscord aberto", startIndex);
    expect(rollbackFunction).not.toBeNull();
    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(completionEnd).toBeGreaterThan(startIndex);
    const completion = source.slice(startIndex, completionEnd);
    const waitIndex = completion.indexOf("wait_discord_started");
    const pendingResetIndex = completion.indexOf("ACTIVATION_ROLLBACK_PENDING=0");
    expect(waitIndex).toBeGreaterThanOrEqual(0);
    expect(pendingResetIndex).toBeGreaterThan(waitIndex);

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "golive-rollback-state-"));
    tempRoots.push(root);
    const harness = path.join(root, "rollback-state.sh");
    fs.writeFileSync(harness, [
      "#!/bin/sh",
      "netns_exists() { return 1; }",
      "discord_running() { return 1; }",
      "teardown_wireguard_netns() { printf '%s\\n' teardown >> \"$ORDER\"; return 0; }",
      "start_discord() { printf 'start:%s\\n' \"$1\" >> \"$ORDER\"; return 0; }",
      "wait_discord_started() { printf 'verified:%s\\n' \"$1\" >> \"$ORDER\"; return 0; }",
      "stop_discord() { printf '%s\\n' stop >> \"$ORDER\"; }",
      "warn() { printf 'warn:%s\\n' \"$1\" >> \"$ORDER\"; }",
      "fail() { printf '%s\\n' \"$1\" >&2; exit 1; }",
      "ACTIVATION_ROLLBACK_PENDING=1",
      "ACTIVATION_ROLLBACK_REOPEN=0",
      "ACTIVATION_NETNS_TOUCH_STARTED=0",
      rollbackFunction!,
      "rollback_activation",
      "printf 'rollback_pending=%s\\n' \"$ACTIVATION_ROLLBACK_PENDING\" >> \"$ORDER\"",
      "FOUND=target",
      "ACTIVATION_ROLLBACK_PENDING=1",
      completion,
      "printf 'completion_pending=%s\\n' \"$ACTIVATION_ROLLBACK_PENDING\" >> \"$ORDER\"",
      "exit 0",
    ].join("\n"));
    fs.chmodSync(harness, 0o755);

    const order = path.join(root, "order");
    const run = spawnSync("/bin/sh", [harness], {
      env: { ...process.env, ORDER: order },
      encoding: "utf8",
    });
    expect(run.status, run.stderr).toBe(0);
    expect(fs.readFileSync(order, "utf8")).toBe(
      "rollback_pending=0\nstart:target\nverified:target\ncompletion_pending=0\n",
    );
  });

  it("seleciona runuser ou setpriv sem sudo e preserva a entrada no namespace", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "../standalone/golivebypass-standalone.sh"), "utf8");
    const haveMatch = source.match(/^have\(\) \{[^\n]*\}$/m);
    const prepareStart = source.indexOf("prepare_run_user() {");
    const prepareBoundary = source.indexOf("\n}\n\n# Executa o comando dentro do namespace", prepareStart);
    const runUserStart = source.indexOf("run_user_netns_command() {");
    const runUserBoundary = source.indexOf("\n}\n\n# systemd-run", runUserStart);
    expect(haveMatch).not.toBeNull();
    expect(prepareStart).toBeGreaterThanOrEqual(0);
    expect(prepareBoundary).toBeGreaterThan(prepareStart);
    expect(runUserStart).toBeGreaterThanOrEqual(0);
    expect(runUserBoundary).toBeGreaterThan(runUserStart);

    const prepareFunction = source.slice(prepareStart, prepareBoundary + 2).trim();
    const runUserFunction = source.slice(runUserStart, runUserBoundary + 2).trim();

    const runExecutor = (executor?: "runuser" | "setpriv") => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "golive-user-executor-"));
      tempRoots.push(root);
      const bin = path.join(root, "bin");
      fs.mkdirSync(bin);
      if (executor) {
        const executable = path.join(bin, executor);
        fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n");
        fs.chmodSync(executable, 0o755);
      }

      const harness = path.join(root, "user-executor.sh");
      fs.writeFileSync(harness, [
        "#!/bin/sh",
        "id() {",
        "  if [ \"$1\" = \"-u\" ] && [ \"$2\" = \"testuser\" ]; then printf '1001\\n'; return 0; fi",
        "  if [ \"$1\" = \"-g\" ] && [ \"$2\" = \"testuser\" ]; then printf '1001\\n'; return 0; fi",
        "  return 1",
        "}",
        haveMatch![0],
        prepareFunction,
        runUserFunction,
        "elevate() { printf 'elevate:%s\\n' \"$*\" >> \"$TRACE\"; return 0; }",
        "NETNS_NAME=discord-vpn",
        "if prepare_run_user testuser; then",
        "  printf 'method=%s\\n' \"$RUN_USER_METHOD\" >> \"$TRACE\"",
        "  run_user_netns_command foreground env TEST=value /usr/bin/true",
        "  printf 'rc=%s\\n' \"$?\" >> \"$TRACE\"",
        "else",
        "  printf 'prepare_rc=%s\\n' \"$?\" >> \"$TRACE\"",
        "fi",
        "exit 0",
      ].join("\n"));
      fs.chmodSync(harness, 0o755);

      const trace = path.join(root, "trace");
      const run = spawnSync("/bin/sh", [harness], {
        env: { ...process.env, PATH: bin, TRACE: trace },
        encoding: "utf8",
      });
      const traceLog = fs.existsSync(trace) ? fs.readFileSync(trace, "utf8") : "";
      return { run, traceLog };
    };

    const runuser = runExecutor("runuser");
    expect(runuser.run.status, runuser.run.stderr).toBe(0);
    expect(runuser.traceLog).toContain("method=runuser\n");
    expect(runuser.traceLog).toContain(
      "elevate:ip netns exec discord-vpn runuser -u testuser -- env TEST=value /usr/bin/true",
    );
    expect(runuser.traceLog).toContain("rc=0\n");
    expect(runuser.traceLog).not.toContain("sudo");

    const setpriv = runExecutor("setpriv");
    expect(setpriv.run.status, setpriv.run.stderr).toBe(0);
    expect(setpriv.traceLog).toContain("method=setpriv\n");
    expect(setpriv.traceLog).toContain(
      "elevate:ip netns exec discord-vpn setpriv --reuid 1001 --regid 1001 --init-groups -- env TEST=value /usr/bin/true",
    );
    expect(setpriv.traceLog).toContain("rc=0\n");
    expect(setpriv.traceLog).not.toContain("sudo");

    const unavailable = runExecutor();
    expect(unavailable.run.status, unavailable.run.stderr).toBe(0);
    expect(unavailable.traceLog).toBe("prepare_rc=127\n");
    expect(unavailable.run.stderr).toContain("nenhum executor seguro");
  });

  it("instala apenas comandos ausentes com argv pacman fixo e verifica o resultado", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "golive-deps-"));
    tempRoots.push(root);
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    for (const command of ["cat", "chmod", "command", "dirname", "grep", "id", "mktemp", "printf", "pwd", "rm", "sed", "tr", "head", "basename", "true"]) {
      const target = path.join("/usr/bin", command);
      if (fs.existsSync(target)) fs.symlinkSync(target, path.join(bin, command));
    }
    fs.writeFileSync(path.join(bin, "sudo"), "#!/bin/sh\nif [ \"$1\" = \"-n\" ]; then shift; fi\nexec \"$@\"\n");
    fs.writeFileSync(path.join(bin, "pacman"), "#!/bin/sh\nif [ \"$1\" = \"-Qu\" ]; then exit 1; fi\nprintf '%s\\n' \"$*\" > \"$GOLIVE_TEST_PACMAN_LOG\"\nfor c in wg ip curl; do printf '#!/bin/sh\\nexit 0\\n' > \"$GOLIVE_TEST_BIN/$c\"; chmod +x \"$GOLIVE_TEST_BIN/$c\"; done\n");
    for (const file of ["sudo", "pacman"]) fs.chmodSync(path.join(bin, file), 0o755);
    const log = path.join(root, "pacman.args");
    const script = path.resolve(process.cwd(), "../standalone/golivebypass-standalone.sh");
    const run = spawnSync("/bin/bash", [script, "--ensure-dependencies"], {
      env: { ...process.env, GOLIVE_GUI: "1", PATH: bin, GOLIVE_TEST_BIN: bin, GOLIVE_TEST_PACMAN_LOG: log },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stderr).toContain("Dependencias Linux instaladas e verificadas");
    expect(fs.readFileSync(log, "utf8").trim()).toBe("-S --needed --noconfirm wireguard-tools iproute2 curl");
    expect(fs.readFileSync(log, "utf8")).not.toContain("-Sy");
  });

  it("é idempotente e não chama o gerenciador quando tudo já existe", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "golive-deps-ready-"));
    tempRoots.push(root);
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    for (const command of ["wg", "ip", "curl", "dirname", "id", "printf", "pwd", "sed", "tr", "head", "basename", "true"]) {
      const file = path.join(bin, command);
      fs.writeFileSync(file, command === "id" ? "#!/bin/sh\nprintf '1000\\n'\n" : command === "pwd" ? "#!/bin/sh\nprintf '%s\\n' \"$PWD\"\n" : "#!/bin/sh\nexit 0\n");
      fs.chmodSync(file, 0o755);
    }
    for (const command of ["dirname", "pwd"]) { fs.rmSync(path.join(bin, command)); fs.symlinkSync(`/usr/bin/${command}`, path.join(bin, command)); }
    const pacman = path.join(bin, "pacman");
    fs.writeFileSync(pacman, "#!/bin/sh\nexit 99\n"); fs.chmodSync(pacman, 0o755);
    const script = path.resolve(process.cwd(), "../standalone/golivebypass-standalone.sh");
    const run = spawnSync("/bin/bash", [script, "--ensure-dependencies"], { env: { ...process.env, GOLIVE_GUI: "1", PATH: bin }, encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stderr).toContain("Dependencias Linux ja estao instaladas");
  });

  it("gera o plano de pacotes correto para cada família suportada", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "../standalone/golivebypass-standalone.sh"), "utf8");
    const match = source.match(/linux_dependency_plan\(\) \{[\s\S]*?\n\}/);
    expect(match).not.toBeNull();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "golive-plan-"));
    tempRoots.push(root);
    const harness = path.join(root, "plan.sh");
    fs.writeFileSync(harness, `#!/bin/bash\n${match![0]}\nlinux_dependency_plan "$@"\n`);
    const plan = (distro: string, like: string) => execFileSync("/bin/bash", [harness, distro, like, "1", "1", "1"], { encoding: "utf8" }).trim();
    expect(plan("cachyos", "arch")).toBe("pacman|-S --needed --noconfirm wireguard-tools iproute2 curl");
    expect(plan("fedora", "fedora")).toBe("dnf|install -y wireguard-tools iproute curl");
    expect(plan("openSUSE", "suse")).toBe("zypper|--non-interactive install --no-recommends wireguard-tools iproute2 curl");
    expect(plan("ubuntu", "debian")).toBe("apt-get|install -y --no-install-recommends wireguard-tools iproute2 curl");
  });

  it("exibe um comando de reparo especifico sem upgrade global", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "../standalone/golivebypass-standalone.sh"), "utf8");
    const plan = source.match(/linux_dependency_plan\(\) \{[\s\S]*?\n\}/);
    const command = source.match(/linux_dependency_install_command\(\) \{[\s\S]*?\n\}/);
    expect(plan).not.toBeNull();
    expect(command).not.toBeNull();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "golive-install-command-"));
    tempRoots.push(root);
    const harness = path.join(root, "command.sh");
    fs.writeFileSync(harness, `#!/bin/sh\n${plan![0]}\n${command![0]}\nlinux_dependency_install_command "$@"\n`);
    const installCommand = (distro: string, like: string, missing: string) =>
      execFileSync("/bin/sh", [harness, distro, like, missing], { encoding: "utf8" }).trim();
    expect(installCommand("ubuntu", "debian", "wireguard-tools iproute2 curl"))
      .toBe("sudo apt-get update && sudo apt-get install -y --no-install-recommends wireguard-tools iproute2 curl");
    expect(installCommand("fedora", "fedora", "iproute2 curl"))
      .toBe("sudo dnf makecache --refresh && sudo dnf install -y --setopt=install_weak_deps=False iproute curl");
    expect(installCommand("cachyos", "arch", "wireguard-tools iproute2"))
      .toBe("sudo pacman -S --needed wireguard-tools iproute2");
    expect(installCommand("openSUSE", "suse", "curl"))
      .toBe("sudo zypper --non-interactive refresh && sudo zypper --non-interactive install --no-recommends curl");
    expect(installCommand("debian", "debian", "curl"))
      .toContain("apt-get install -y --no-install-recommends curl");
    expect(installCommand("alpine", "", "curl"))
      .toContain("gerenciador de pacotes");
    expect(installCommand("ubuntu", "debian", "openssl"))
      .toBe("");
    expect(installCommand("ubuntu", "debian", "wireguard-tools curl"))
      .not.toContain("upgrade");
  });

  it("atualiza somente os metadados exigidos por dnf e zypper", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "../standalone/golivebypass-standalone.sh"), "utf8");
    expect(source).toContain("elevate dnf makecache --refresh");
    expect(source).toContain("elevate zypper --non-interactive refresh");
    expect(source).not.toMatch(/elevate\s+dnf\s+upgrade/);
    expect(source).not.toMatch(/elevate\s+zypper\s+update/);
  });

  it("mantém o modo de reparo protegido contra a CLI standalone", () => {
    const script = path.resolve(process.cwd(), "../standalone/golivebypass-standalone.sh");
    expect(() => execFileSync("bash", [script, "--ensure-dependencies"], { env: { ...process.env, GOLIVE_GUI: "" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })).toThrow();
  });
});
