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
