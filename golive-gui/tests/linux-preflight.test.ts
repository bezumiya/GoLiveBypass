import { afterEach, describe, expect, it } from "vitest";
import { linuxPreflightRepairable, linuxPreflightMessage, parseLinuxPreflight } from "../electron/linux-preflight";
import fs from "fs";
import path from "path";
import os from "os";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "child_process";

// Os testes que rodam o script bash dependem de /bin/bash, /proc e binários do Linux.
const itLinux = it.skipIf(process.platform !== "linux");
const tempRoots: string[] = [];
afterEach(() => { for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function shellHelper(source: string, name: string): string {
  const match = source.match(new RegExp(`^${name}\\(\\) \\{[^\\n]*\\}$|^${name}\\(\\) \\{[\\s\\S]*?^\\}`, "m"));
  if (!match) throw new Error(`Helper ausente: ${name}`);
  return match[0];
}

describe("preflight Linux", () => {
  itLinux("reporta o alvo manual no JSON do preflight real", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "golive-manual-preflight-"));
    tempRoots.push(root);
    const app = path.join(root, "discord");
    fs.writeFileSync(app, "#!/bin/sh\n");
    fs.chmodSync(app, 0o755);
    const arquivo = path.join(root, "manual-target.conf");
    const script = path.resolve(process.cwd(), "../standalone/golivebypass-standalone.sh");

    const rodar = (): { manual: { present: boolean; valid: boolean }; count: number } => {
      const run = spawnSync("/bin/bash", [script, "--preflight", "--json"], {
        env: { ...process.env, GOLIVE_GUI: "1", MANUAL_TARGET_FILE: arquivo },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      expect(run.status, run.stderr).toBe(0);
      const json = JSON.parse(run.stdout.trim().split("\n").pop() as string);
      return { manual: json.discord.manual, count: json.discord.count };
    };

    // Sem arquivo: presente e valido sao falsos, e a varredura segue sendo a unica fonte.
    expect(rodar().manual).toEqual({ present: false, valid: false });

    fs.writeFileSync(arquivo, ["schema=1", "kind=exec", `key=${app}`, "label=Discord", "resources=", `arg=${app}`, ""].join("\n"));
    const comAlvo = rodar();
    expect(comAlvo.manual).toEqual({ present: true, valid: true });
    // O alvo manual entra em $FOUND: sem instalacao reconhecida ele ainda conta como um alvo.
    expect(comAlvo.count).toBeGreaterThanOrEqual(1);

    // Registro que existe e nao serve (schema desconhecido) nao vira alvo.
    fs.writeFileSync(arquivo, ["schema=2", "kind=exec", `key=${app}`, "label=Discord", "resources=", `arg=${app}`, ""].join("\n"));
    expect(rodar().manual).toEqual({ present: true, valid: false });

    // Alvo obsoleto: o caminho deixou de existir desde a escolha.
    fs.rmSync(app);
    fs.writeFileSync(arquivo, ["schema=1", "kind=exec", `key=${app}`, "label=Discord", "resources=", `arg=${app}`, ""].join("\n"));
    expect(rodar().manual).toEqual({ present: true, valid: false });
  });

  it("le o bloco do alvo manual e assume ausente quando o script nao manda o campo", () => {
    const comManual = parseLinuxPreflight(JSON.stringify({
      ok: true, platform: "linux", distro: "Arch Linux",
      dependencies: { missing: [], required: ["wg", "ip", "curl"] },
      elevation: { available: true, method: "sudo" }, netns: { available: true },
      kernel: { wireguard: "loaded" },
      discord: { found: true, count: 1, firstPath: "/home/u/Discord/resources", manual: { present: true, valid: true } },
      errors: [], installCommand: "",
    }));

    expect(comManual.discord.manual).toEqual({ present: true, valid: true });

    const alvoMorto = parseLinuxPreflight(JSON.stringify({ discord: { found: false, count: 0, manual: { present: true, valid: false } } }));
    expect(alvoMorto.discord.manual).toEqual({ present: true, valid: false });

    // Script antigo (sem o campo) e valores de tipo errado nao podem virar "alvo existente".
    expect(parseLinuxPreflight(JSON.stringify({ discord: { found: true, count: 1 } })).discord.manual).toEqual({ present: false, valid: false });
    expect(parseLinuxPreflight(JSON.stringify({ discord: { manual: { present: "sim", valid: 1 } } })).discord.manual).toEqual({ present: false, valid: false });
    expect(parseLinuxPreflight(JSON.stringify({ discord: { manual: null } })).discord.manual).toEqual({ present: false, valid: false });
  });

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

  it("mantém o estado do módulo informativo para permitir a carga na ativação", () => {
    const make = (state: string, ok = true) => parseLinuxPreflight(JSON.stringify({
      ok,
      distro: "CachyOS",
      dependencies: { missing: [], required: ["wg", "ip", "curl"] },
      elevation: { available: true, method: "sudo" },
      netns: { available: true },
      kernel: { wireguard: state },
      discord: { found: true, count: 1 },
      errors: state === "missing" ? ["modulo wireguard ausente"] : [],
    }));
    for (const state of ["loaded", "available", "missing", "unknown"]) {
      expect(make(state).kernel.wireguard).toBe(state);
    }
    expect(linuxPreflightMessage(make("missing"))).toBe("Ambiente Linux pronto para ativar.");
    expect(linuxPreflightMessage(make("missing", false))).toContain("não está disponível");
  });

  it("manda reiniciar quando o kernel em execução está sem os módulos em disco", () => {
    const result = parseLinuxPreflight(JSON.stringify({
      ok: false,
      distro: "CachyOS",
      dependencies: { missing: [], required: ["wg", "ip", "curl"] },
      elevation: { available: true, method: "sudo" },
      netns: { available: true },
      kernel: { wireguard: "missing", running: "7.2.6-1-cachyos", modulesInstalled: false, userspace: false },
      discord: { found: true, count: 1 },
      errors: ["modulo wireguard ausente"],
      installCommand: "",
    }));
    expect(result.kernel).toEqual({
      wireguard: "missing", running: "7.2.6-1-cachyos", modulesInstalled: false, userspace: false,
    });
    expect(result.ok).toBe(false);
    expect(linuxPreflightRepairable(result)).toBe(false);
    expect(linuxPreflightMessage(result)).toBe(
      "O kernel Linux em execução (7.2.6-1-cachyos) não possui os módulos instalados. Reinicie no kernel instalado, instale os módulos correspondentes ou instale o wireguard-go antes de ativar.",
    );
  });

  it("aceita o kernel sem módulo quando o WireGuard de usuário está disponível", () => {
    const result = parseLinuxPreflight(JSON.stringify({
      ok: true,
      distro: "CachyOS",
      dependencies: { missing: [], required: ["wg", "ip", "curl"] },
      elevation: { available: true, method: "sudo" },
      netns: { available: true },
      kernel: { wireguard: "missing", running: "7.2.6-1-cachyos", modulesInstalled: false, userspace: true },
      discord: { found: true, count: 1 },
      errors: ["modulo wireguard ausente"],
      installCommand: "",
    }));
    expect(result.ok).toBe(true);
    expect(result.kernel.userspace).toBe(true);
    expect(linuxPreflightRepairable(result)).toBe(false);
  });

  it("não lê o kernel sem os campos novos como 'sem módulos' nem como usuário", () => {
    const result = parseLinuxPreflight(JSON.stringify({
      ok: false, distro: "CachyOS",
      dependencies: { missing: [], required: ["wg", "ip", "curl"] },
      elevation: { available: true, method: "sudo" }, netns: { available: true },
      kernel: { wireguard: "missing" },
      discord: { found: true, count: 1 }, errors: ["modulo wireguard ausente"], installCommand: "",
    }));
    expect(result.kernel.running).toBe("");
    expect(result.kernel.modulesInstalled).toBe(true);
    expect(result.kernel.userspace).toBe(false);
    expect(linuxPreflightMessage(result)).toBe(
      "O módulo WireGuard não está disponível no kernel Linux em execução (atual). Instale ou ative o módulo WireGuard, ou instale o wireguard-go, antes de ativar.",
    );
  });

  itLinux.each([
    { loaded: false, userspace: false, wireguard: "missing", selectedUserspace: false, ok: false },
    { loaded: false, userspace: true, wireguard: "missing", selectedUserspace: true, ok: true },
    { loaded: true, userspace: true, wireguard: "loaded", selectedUserspace: false, ok: true },
  ])("calcula prontidão sem depender do kernel do host: $loaded/$userspace", ({ loaded, userspace, wireguard, selectedUserspace, ok }) => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "../standalone/golivebypass-standalone.sh"), "utf8");
    // Só os probes de capacidade são controlados; a agregação e o JSON são os do helper mantido.
    const run = spawnSync("/bin/sh", ["-c", [
      shellHelper(source, "json_escape"),
      "have() { return 0; }",
      "wg() { return 0; }",
      "ip() { return 0; }",
      "curl() { return 0; }",
      "os_field() { [ \"$1\" != ID ] || printf arch; }",
      "uname() { printf '%s\\n' 0.0.0-kernel-de-teste; }",
      "MODINFO_BINARY=/bin/false",
      `wireguard_module_loaded() { return ${loaded ? 0 : 1}; }`,
      `wireguard_userspace_available() { return ${userspace ? 0 : 1}; }`,
      "FOUND='/fixture/Discord/resources|discord|fixture|'",
      shellHelper(source, "linux_preflight_json"),
      "linux_preflight_json",
    ].join("\n")], { encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    const result = parseLinuxPreflight(run.stdout);
    expect(result.kernel).toEqual({
      wireguard, running: "0.0.0-kernel-de-teste", modulesInstalled: false, userspace: selectedUserspace,
    });
    expect(result.ok).toBe(ok);
  });

  itLinux("mantém o daemon vivo até o teardown e remove seu pidfile", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "../standalone/golivebypass-standalone.sh"), "utf8");
    const userspaceBlock = [
      "wireguard_go_pid_file", "wireguard_go_log_file", "resolve_wireguard_go",
      "start_wireguard_userspace", "wireguard_go_alive", "stop_wireguard_userspace",
    ].map(name => shellHelper(source, name)).join("\n");

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "golive-wireguard-userspace-"));
    tempRoots.push(root);
    const bin = path.join(root, "bin");
    const install = path.join(root, "dados");
    fs.mkdirSync(bin);
    fs.mkdirSync(install);
    // `ip` falso: a espera pela interface nao pode depender de namespace real no teste.
    // `link show` so responde depois que o daemon gravou o pidfile (como o device TUN
    // real, que nasce depois do exec); sem isso o script le o pidfile antes de ele existir.
    fs.writeFileSync(
      path.join(bin, "ip"),
      `#!/bin/sh\nif [ "$1" = link ] && [ "$2" = show ]; then [ -s "${install}/wireguard-go.pid" ]; exit $?; fi\nexit 0\n`,
    );
    const daemon = path.join(bin, "wireguard-go");
    fs.writeFileSync(daemon, "#!/bin/sh\nsleep 30\n");
    for (const file of ["ip", "wireguard-go"]) fs.chmodSync(path.join(bin, file), 0o755);

    const harness = path.join(root, "userspace.sh");
    fs.writeFileSync(harness, [
      "#!/bin/sh",
      "set -u",
      'WIREGUARD_GO_BINARY=""',
      'WIREGUARD_GO_SOURCE=""',
      `INSTALL_DIR="${install}"`,
      'NETNS_NAME="discord-vpn"',
`WG_IF="wg-discord"`,
      "step() { :; }",
      "warn() { :; }",
      // Só a fronteira de elevação/interface é isolada; o processo e seu ciclo de vida são reais.
      "elevate() { \"$@\"; }",
      userspaceBlock,
      // O override entra pelo resolvedor mantido, sem depender de binários do host.
      `WIREGUARD_GO_CLI="${daemon}"`,
      "resolve_wireguard_go || { printf 'SEM_BINARIO\\n'; exit 1; }",
      "if ! start_wireguard_userspace; then printf 'START_FAIL=1\\n'; exit 1; fi",
      "pid=\"$(cat \"$(wireguard_go_pid_file)\")\"",
      "printf 'PID=%s\\n' \"$pid\"",
      "wireguard_go_alive \"$pid\" && printf 'ALIVE_BEFORE=1\\n'",
      "printf 'LOG=%s\\n' \"$( [ -f \"$(wireguard_go_log_file)\" ] && printf presente || printf ausente )\"",
      "stop_wireguard_userspace",
      "[ -e \"$(wireguard_go_pid_file)\" ] || printf 'PIDFILE_REMOVIDO=1\\n'",
      "wireguard_go_alive \"$pid\" || printf 'ALIVE_DEPOIS=0\\n'",
    ].join("\n"));
    fs.chmodSync(harness, 0o755);

    const run = spawnSync("/bin/sh", [harness], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 20_000,
    });
    const saida = run.stdout + run.stderr;
    expect(run.status, saida).toBe(0);
    expect(saida).toContain("ALIVE_BEFORE=1");
    expect(saida).toContain("LOG=presente");
    expect(saida).toContain("PIDFILE_REMOVIDO=1");
    expect(saida).toContain("ALIVE_DEPOIS=0");
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


  itLinux("não fecha o Discord quando a autorização falha e mantém a ordem quando aceita", () => {
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

  itLinux("limpa recursos legados depois da autorizacao e antes de fechar o Discord", () => {
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

  itLinux("mantem o rollback pendente ate o Discord iniciar e o limpa depois da confirmacao", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "../standalone/golivebypass-standalone.sh"), "utf8");
    expect(source).toMatch(/^ACTIVATION_ROLLBACK_PENDING=0$/m);
    expect(source).toMatch(/^ACTIVATION_ROLLBACK_REOPEN=0$/m);
    expect(source).toMatch(/^rollback_activation\(\) \{/m);

    const rollbackStart = source.indexOf("rollback_activation() {");
    const rollbackTrap = source.indexOf("\ntrap cleanup_sudo_pass", rollbackStart);
    const rollbackFunction = rollbackStart >= 0 && rollbackTrap > rollbackStart
      ? source.slice(rollbackStart, rollbackTrap).trim()
      : null;
    const startIndex = source.indexOf('if ! start_discord "$(printf');
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

  itLinux("seleciona runuser ou setpriv sem sudo e preserva a entrada no namespace", () => {
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

  itLinux("instala apenas comandos ausentes com argv pacman fixo e verifica o resultado", () => {
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
    // Distro fixa (Arch): o resultado não pode depender do /etc/os-release do host.
    const osRelease = path.join(root, "os-release");
    fs.writeFileSync(osRelease, "ID=arch\n");
    const script = path.resolve(process.cwd(), "../standalone/golivebypass-standalone.sh");
    const run = spawnSync("/bin/bash", [script, "--ensure-dependencies"], {
      env: { ...process.env, GOLIVE_GUI: "1", PATH: bin, GOLIVE_TEST_BIN: bin, GOLIVE_TEST_PACMAN_LOG: log, OS_RELEASE_FILE: osRelease },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stderr).toContain("Dependencias Linux instaladas e verificadas");
    expect(fs.readFileSync(log, "utf8").trim()).toBe("-S --needed --noconfirm wireguard-tools iproute2 curl");
    expect(fs.readFileSync(log, "utf8")).not.toContain("-Sy");
  });

  itLinux("é idempotente e não chama o gerenciador quando tudo já existe", () => {
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

  itLinux("gera o plano de pacotes correto para cada família suportada", () => {
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

  itLinux("exibe um comando de reparo especifico sem upgrade global", () => {
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

  itLinux("reconhece e encerra todos os processos Vesktop ELF da raiz exata", async () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "../standalone/golivebypass-standalone.sh"), "utf8");
    const extract = (name: string) => {
      const match = source.match(new RegExp(`${name}\\(\\) \\{[\\s\\S]*?\\n\\}\\n`));
      if (!match) throw new Error(`Funcao ${name} nao encontrada`);
      return match[0].trim();
    };
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "golive-vesktop-elf-"));
    tempRoots.push(root);
    const appRoot = path.join(root, "vesktop");
    const resources = path.join(appRoot, "resources");
    fs.mkdirSync(resources, { recursive: true });
    const executable = path.join(appRoot, "vesktop");
    fs.copyFileSync("/bin/sleep", executable);
    const client = spawn(executable, ["30"]);
    const clientChild = spawn(executable, ["30"]);
    const unrelated = spawn("/bin/sleep", ["30"]);
    const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise<void>((resolve) => child.once("exit", () => resolve()));
    try {
      const harness = path.join(root, "stop.sh");
      fs.writeFileSync(harness, [
        "#!/bin/sh",
        extract("normalize_pid"),
        extract("parallel_app_root_for_resources"),
        extract("parallel_pids_for_resources"),
        extract("parallel_pid_for_resources"),
        extract("parallel_process_belongs_to_resources"),
        extract("kill_parallel_by_path"),
        "FOUND=\"$1|vesktop||\"",
        "parallel_pid_for_resources \"$1\"",
        "kill_parallel_by_path",
      ].join("\n"));
      const result = spawnSync("/bin/sh", [harness, resources], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      expect([String(client.pid), String(clientChild.pid)]).toContain(result.stdout.trim());
      await Promise.all([exited(client), exited(clientChild)]);
      expect(unrelated.exitCode).toBe(null);
    } finally {
      clientChild.kill("SIGKILL");
      unrelated.kill("SIGKILL");
      await Promise.all([exited(client), exited(clientChild), exited(unrelated)]);
    }
  });

  itLinux("escalona Flatpak apenas para PID positivo do application ID confirmado", async () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "../standalone/golivebypass-standalone.sh"), "utf8");
    const extract = (name: string) => {
      const match = source.match(new RegExp(`${name}\\(\\) \\{[\\s\\S]*?\\n\\}\\n`));
      if (!match) throw new Error(`Funcao ${name} nao encontrada`);
      return match[0].trim();
    };
    const target = spawn("/bin/sleep", ["30"]);
    const unrelated = spawn("/bin/sleep", ["30"]);
    const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const harness = path.join(os.tmpdir(), `golive-flatpak-kill-${process.pid}.sh`);
    const normalize = extract("normalize_pid");
    const flatpakPid = extract("flatpak_pid_for_id");
    const killFlatpak = extract("kill_flatpak_apps_forcefully");
    try {
      fs.writeFileSync(harness, [
        "#!/bin/sh",
        "have() { [ \"$1\" = flatpak ]; }",
        "flatpak_pid_for_id() { [ \"$1\" = org.example.Target ] && printf '%s\\n' \"$TARGET_PID\"; }",
        "FLATPAK_IDS=org.example.Target",
        "FLATPAK_TUNEL_IDS=",
        normalize,
        killFlatpak,
        "kill_flatpak_apps_forcefully",
      ].join("\n"));
      const result = spawnSync("/bin/sh", [harness], { encoding: "utf8", env: { ...process.env, TARGET_PID: String(target.pid) } });
      expect(result.status, result.stderr).toBe(0);
      await exited(target);
      expect(unrelated.exitCode).toBe(null);

      const invalidHarness = path.join(os.tmpdir(), `golive-flatpak-invalid-${process.pid}.sh`);
      fs.writeFileSync(invalidHarness, [
        "#!/bin/sh",
        "have() { [ \"$1\" = flatpak ]; }",
        "flatpak_pid_for_id() { [ \"$1\" = org.example.Target ] && printf '%s\\n' \"$TARGET_PID\"; }",
        "kill() { printf '%s\\n' \"$*\" >> \"$SIGNALS\"; }",
        "FLATPAK_IDS=org.example.Target",
        "FLATPAK_TUNEL_IDS=",
        normalize,
        killFlatpak,
        "kill_flatpak_apps_forcefully",
      ].join("\n"));
      for (const invalidPid of ["0", "000"]) {
        const signals = `${invalidHarness}.${invalidPid}`;
        const invalid = spawnSync("/bin/sh", [invalidHarness], {
          encoding: "utf8",
          env: { ...process.env, TARGET_PID: invalidPid, SIGNALS: signals },
        });
        expect(invalid.status, invalid.stderr).toBe(0);
        expect(fs.existsSync(signals)).toBe(false);
      }

      const parseHarness = path.join(os.tmpdir(), `golive-flatpak-parse-${process.pid}.sh`);
      fs.writeFileSync(parseHarness, [
        "#!/bin/sh",
        "have() { [ \"$1\" = flatpak ]; }",
        "flatpak() { printf '%s %s\\n' \"$FAKE_PID\" org.example.Target; }",
        normalize,
        flatpakPid,
        "flatpak_pid_for_id org.example.Target",
      ].join("\n"));
      const zero = spawnSync("/bin/sh", [parseHarness], { encoding: "utf8", env: { ...process.env, FAKE_PID: "0" } });
      expect(zero.status).toBe(1);
      expect(zero.stdout).toBe("");
      const leadingZeros = spawnSync("/bin/sh", [parseHarness], { encoding: "utf8", env: { ...process.env, FAKE_PID: "00042" } });
      expect(leadingZeros.status).toBe(0);
      expect(leadingZeros.stdout.trim()).toBe("42");
    } finally {
      for (const filename of [harness, `${harness}.0`, `${harness}.000`, path.join(os.tmpdir(), `golive-flatpak-invalid-${process.pid}.sh`), path.join(os.tmpdir(), `golive-flatpak-parse-${process.pid}.sh`)]) {
        fs.rmSync(filename, { force: true });
      }
      target.kill("SIGKILL");
      unrelated.kill("SIGKILL");
      await Promise.all([exited(target), exited(unrelated)]);
    }
  });

  itLinux("confirma o processo no namespace, usa readonly sem prompt e faz rollback se ele sumir", async () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "../standalone/golivebypass-standalone.sh"), "utf8");
    const extract = (name: string) => {
      const match = source.match(new RegExp(`${name}\\(\\) \\{[\\s\\S]*?\\n\\}\\n`));
      if (!match) throw new Error(`Funcao ${name} nao encontrada`);
      return match[0].trim();
    };
    const pidFunction = extract("discord_pid_flav");
    const namespaceFunction = extract("discord_pid_in_netns");
    const elevatedFunction = extract("discord_pid_in_netns_elevated");
    const netnsPidFunction = extract("discord_netns_pid_flav");
    const waitFunction = extract("wait_discord_started");
    const runWait = (scenario: "outside" | "inside" | "disappeared") => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "golive-wait-netns-"));
      tempRoots.push(root);
      const state = path.join(root, "state");
      const harness = path.join(root, "wait.sh");
      fs.writeFileSync(harness, [
        "#!/bin/sh",
        "[() { case \"$1\" in -e) return 0 ;; -n) case \"$2\" in \"\") return 1 ;; *) return 0 ;; esac ;; esac; case \"$2\" in -gt) case \"$1\" in 0) return 1 ;; *) return 0 ;; esac ;; =|-eq) case \"$1\" in \"$3\") return 0 ;; esac; return 1 ;; esac; return 1; }",
        "id() { [ \"$1\" = -u ] && { printf '1000\\n'; return 0; }; return 1; }",
        "have() { case \"$1\" in ip|sudo|stat|pgrep) return 0 ;; *) return 1 ;; esac; }",
        "elevate() { printf 'interactive\\n' >> \"$TRACE\"; \"$@\"; }",
        "elevate_readonly() { printf 'readonly\\n' >> \"$TRACE\"; \"$@\"; }",
        "parallel_pid_for_resources() {",
        "  calls=0; [ -f \"$STATE\" ] && calls=$(cat \"$STATE\")",
        "  calls=$((calls + 1)); printf '%s\\n' \"$calls\" > \"$STATE\"",
        "  if [ \"$SCENARIO\" = disappeared ] && [ \"$calls\" -gt 1 ]; then return 1; fi",
        "  [ \"$1\" = /resources ] && printf '4242\\n'",
        "}",
        "ip() {",
        "  if [ \"$1\" = netns ] && [ \"$2\" = identify ]; then",
        "    [ \"$SCENARIO\" = inside ] && { printf 'discord-vpn\\n'; return 0; }",
        "    [ \"$SCENARIO\" = outside ] && { printf 'host\\n'; return 0; }",
        "    return 1",
        "  fi",
        "  return 1",
        "}",
        "stat() {",
        "  case \"$4\" in /proc/*/ns/net) [ \"$SCENARIO\" = inside ] || [ \"$SCENARIO\" = inode ] && printf '5:4026533000\\n' || printf '5:4026532000\\n' ;;",
        "  /run/netns/discord-vpn) [ \"$SCENARIO\" = inside ] || [ \"$SCENARIO\" = inode ] && printf '5:4026533000\\n' || printf '5:4026532001\\n' ;; esac",
        "}",
        "sleep() { :; }",
        "NETNS_NAME=discord-vpn",
        "NONINTERACTIVE=0",
        pidFunction,
        namespaceFunction,
        elevatedFunction,
        netnsPidFunction,
        waitFunction,
        "wait_discord_started '/resources|discord||'",
      ].join("\n"));
      fs.chmodSync(harness, 0o755);
      return spawnSync("/bin/bash", [harness], {
        env: { ...process.env, SCENARIO: scenario, STATE: state, TRACE: path.join(root, "trace") },
        encoding: "utf8",
      });
    };

    expect(runWait("outside").status).toBe(1);
    const insideRun = runWait("inside");
    expect(insideRun.status).toBe(0);
    expect(runWait("disappeared").status).toBe(1);

    const readonlyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "golive-readonly-netns-"));
    tempRoots.push(readonlyRoot);
    const readonlyHarness = path.join(readonlyRoot, "readonly.sh");
    fs.writeFileSync(readonlyHarness, [
      "#!/bin/sh",
      "[() { case \"$1\" in -e) return 0 ;; -n) case \"$2\" in \"\") return 1 ;; *) return 0 ;; esac ;; esac; case \"$2\" in -gt) case \"$1\" in 0) return 1 ;; *) return 0 ;; esac ;; =|-eq) case \"$1\" in \"$3\") return 0 ;; esac; return 1 ;; esac; return 1; }",
      "id() { [ \"$1\" = -u ] && { printf '1000\\n'; return 0; }; return 1; }",
      "have() { case \"$1\" in ip|sudo|stat) return 0 ;; *) return 1 ;; esac; }",
      "elevate() { printf 'interactive\\n' >> \"$TRACE\"; return 99; }",
      "ip() { [ \"$SCENARIO\" = outside ] && printf 'host\\n'; return 1; }",
      "stat() {",
      "  [ \"$SCENARIO\" = inconclusive ] && return 1",
      "  case \"$4\" in /proc/*/ns/net) [ \"$SCENARIO\" = inside ] && printf '5:4026533000\\n' || printf '5:4026532000\\n' ;; /run/netns/discord-vpn) [ \"$SCENARIO\" = inside ] && printf '5:4026533000\\n' || printf '5:4026532001\\n' ;; esac",
      "}",
      "NETNS_NAME=discord-vpn",
      "NONINTERACTIVE=1",
      namespaceFunction,
      elevatedFunction,
      "discord_pid_in_netns_elevated 4242",
    ].join("\n"));
    fs.chmodSync(readonlyHarness, 0o755);
    const readonlyTrace = path.join(readonlyRoot, "trace");
    const readonlyRun = spawnSync("/bin/bash", [readonlyHarness], {
      env: { ...process.env, SCENARIO: "inside", TRACE: readonlyTrace },
      encoding: "utf8",
    });
    expect(readonlyRun.status, readonlyRun.stderr).toBe(0);
    expect(fs.existsSync(readonlyTrace)).toBe(false);

    const outsideRun = spawnSync("/bin/bash", [readonlyHarness], {
      env: { ...process.env, SCENARIO: "outside", TRACE: readonlyTrace },
      encoding: "utf8",
    });
    expect(outsideRun.status, outsideRun.stderr).toBe(1);
    expect(fs.existsSync(readonlyTrace)).toBe(false);

    const failureStart = source.indexOf('if ! wait_discord_started "$(printf');
    const failureEnd = source.indexOf("\nfi", failureStart) + 3;
    expect(failureStart).toBeGreaterThanOrEqual(0);
    expect(failureEnd).toBeGreaterThan(failureStart);
    const failureBlock = source.slice(failureStart, failureEnd);
    const falhaFunction = extract("falha_lancamento_mensagem");
    const rollbackRoot = fs.mkdtempSync(path.join(os.tmpdir(), "golive-wait-rollback-"));
    tempRoots.push(rollbackRoot);
    const rollbackHarness = path.join(rollbackRoot, "rollback.sh");
    fs.writeFileSync(rollbackHarness, [
      "#!/bin/sh",
      "wait_discord_started() { return 1; }",
      "stop_discord() { printf 'stop\\n' >> \"$TRACE\"; }",
      "teardown_wireguard_netns() { printf 'teardown\\n' >> \"$TRACE\"; }",
      "warn() { :; }",
      "fail() { printf '%s\\n' \"$1\" >&2; exit 1; }",
      "ACTIVATION_ROLLBACK_TARGET=\"${RTARGET:-target}\"",
      "FOUND=target",
      "INSTALL_DIR=/tmp/golive-test",
      falhaFunction,
      failureBlock,
    ].join("\n"));
    fs.chmodSync(rollbackHarness, 0o755);
    const rollbackTrace = path.join(rollbackRoot, "trace");
    const rollbackRun = spawnSync("/bin/sh", [rollbackHarness], {
      env: { ...process.env, TRACE: rollbackTrace },
      encoding: "utf8",
    });
    expect(rollbackRun.status).toBe(1);
    expect(fs.readFileSync(rollbackTrace, "utf8")).toBe("stop\nteardown\n");
    expect(rollbackRun.stderr).toContain("Discord nao iniciou dentro do namespace WireGuard");

    // #327: a falha precisa entregar saida acionavel — instancia fora do namespace,
    // ultima saida real do launcher e o caminho do log — numa linha so, porque e o
    // que a UI mostra depois do tail.
    const launcherLog = path.join(rollbackRoot, "discord-vpn.log");
    fs.writeFileSync(launcherLog, [
      "[2026-10-08T21:41:42-03:00] backend=wayland wayland=wayland-0",
      "[2026-10-08T21:41:42-03:00] launch=flatpak-direct app=com.discordapp.Discord",
      "error: bwrap: montagem de /proc negada pela politica do sistema",
      "",
    ].join("\n"));
    const flatpakTarget = "/var/lib/flatpak/app/com.discordapp.Discord/current/active/files/discord/resources|discord|flatpak|com.discordapp.Discord";
    const actionableRun = spawnSync("/bin/sh", [rollbackHarness], {
      env: {
        ...process.env,
        TRACE: rollbackTrace,
        RTARGET: flatpakTarget,
        WAIT_DISCORD_MOTIVO: "fora-do-namespace",
        START_DISCORD_LOG: launcherLog,
      },
      encoding: "utf8",
    });
    expect(actionableRun.status).toBe(1);
    expect(actionableRun.stderr).toContain("uma instancia do com.discordapp.Discord ficou fora do namespace");
    expect(actionableRun.stderr).toContain("flatpak kill com.discordapp.Discord");
    expect(actionableRun.stderr).toContain("error: bwrap: montagem de /proc negada pela politica do sistema");
    expect(actionableRun.stderr).toContain(launcherLog);
    expect(actionableRun.stderr).not.toContain("backend=wayland");
  });

  it("mantem no-op apenas para ACTIVE e libera reparo quando status fica INACTIVE", async () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "../standalone/golivebypass-standalone.sh"), "utf8");
    const main = fs.readFileSync(path.resolve(process.cwd(), "electron/main.ts"), "utf8");
    expect(main).toContain('runScript(["--status", "--json", "--non-interactive"])');
    const guardStart = main.indexOf('if (await linuxStatus() === "ACTIVE")');
    const guardEnd = main.indexOf("\n  await ensureProtonActivationProfile", guardStart);
    expect(guardStart).toBeGreaterThanOrEqual(0);
    expect(guardEnd).toBeGreaterThan(guardStart);
    const guard = main.slice(guardStart, guardEnd);
    let persistenceCalls = 0;
    const makeGuarded = (status: "ACTIVE" | "INACTIVE") => new Function(
      "linuxStatus",
      "logger",
      "persistBypassEnabled",
      `return async function() { ${guard}; return "continued"; }`,
    )(
      async () => status,
      { info: () => {} },
      () => { persistenceCalls += 1; },
    ) as () => Promise<"continued" | undefined>;
    expect(await makeGuarded("ACTIVE")()).toBeUndefined();
    expect(persistenceCalls).toBe(1);
    expect(await makeGuarded("INACTIVE")()).toBe("continued");
    expect(persistenceCalls).toBe(1);
    expect(source).toContain("discord_pid_in_netns_elevated");
  });
});
