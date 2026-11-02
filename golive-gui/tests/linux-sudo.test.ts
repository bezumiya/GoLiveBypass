import { describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn, spawnSync } from "node:child_process";

// Estes testes executam o script com sh e curl falsos (shebang, chmod, process groups).
const itLinux = it.skipIf(process.platform !== "linux");
const scriptPath = path.resolve(process.cwd(), "../standalone/golivebypass-standalone.sh");

function runWithOpenStdin(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  // O --status só emite JSON quando há algum alvo; um alvo manual válido evita depender de
  // um Discord instalado no host (no CI o script falha com "Nao achei nenhum Discord").
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "golive-status-stdin-"));
  const app = path.join(dir, "discord");
  fs.writeFileSync(app, "#!/bin/sh\n");
  fs.chmodSync(app, 0o755);
  const manual = path.join(dir, "manual-target.conf");
  fs.writeFileSync(manual, ["schema=1", "kind=exec", `key=${app}`, "label=Discord", "resources=", `arg=${app}`, ""].join("\n"));
  return new Promise((resolve, reject) => {
    const child = spawn("sh", [scriptPath, ...args], {
      env: { ...process.env, GOLIVE_GUI: "1", REPORT_NO_AUTO: "1", MANUAL_TARGET_FILE: manual },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`script bloqueou com stdin aberto: ${args.join(" ")}`));
    }, 60_000);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", (error) => { clearTimeout(timeout); fs.rmSync(dir, { recursive: true, force: true }); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timeout);
      fs.rmSync(dir, { recursive: true, force: true });
      resolve({ code, stdout, stderr });
    });
  });
}

describe("elevacao sudo no Linux", () => {
  const source = fs.readFileSync(
    path.resolve(process.cwd(), "../standalone/golivebypass-standalone.sh"),
    "utf8",
  );
  itLinux("monta o relatorio pelo contexto e log sem ler stdin aberto", { timeout: 10_000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "golive-report-stdin-"));
    const context = path.join(root, "context.txt");
    const capture = path.join(root, "payload.txt");
    const log = path.join(root, "golivebypass.log");
    const curl = path.join(root, "curl");
    fs.writeFileSync(context, "CONTEXTO-ARQUIVO\n");
    fs.writeFileSync(log, "CAUDA-LOG\n");
    fs.writeFileSync(curl, [
      "#!/bin/sh",
      "last=''",
      "for arg do last=\"$arg\"; done",
      "printf '%s' \"$last\" > \"$REPORT_CAPTURE\"",
      "exit 0",
    ].join("\n"));
    fs.chmodSync(curl, 0o755);

    const extract = (name: string, before: string) => {
      const start = source.indexOf(`${name}() {`);
      const end = source.indexOf(before, start);
      if (start < 0 || end < 0) throw new Error(`funcao ${name} ausente`);
      return source.slice(start, end);
    };
    const reportFunctions = [
      extract("report_sanitize", "# Envia o report"),
      extract("report_send", "# Chamada unica de report"),
      extract("report_error", "# =========================================================================== /Report de bugs"),
    ].join("\n");
    const script = [
      "set -eu",
      `INSTALL_DIR=${JSON.stringify(root)}`,
      "BUG_API_URL=https://example.invalid/report",
      "BUG_API_TOKEN=test-token",
      "C_GREEN='' C_YELLOW='' C_DIM='' C_OFF=''",
      "have() { [ \"$1\" = curl ]; }",
      reportFunctions,
      `report_error titulo ${JSON.stringify(context)}`,
    ].join("\n");

    let result: { code: number | null; stdout: string; stderr: string };
    try {
      result = await new Promise((resolve, reject) => {
        const child = spawn("sh", ["-c", script], {
          detached: true,
          env: { ...process.env, PATH: `${root}:${process.env.PATH ?? ""}`, REPORT_CAPTURE: capture },
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let settled = false;
        let timer: NodeJS.Timeout | undefined;
        const finish = (value: { code: number | null; stdout: string; stderr: string }) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          resolve(value);
        };
        timer = setTimeout(() => {
          if (child.pid) {
            try { process.kill(-child.pid, "SIGKILL"); } catch { /* ja terminou */ }
          }
          finish({ code: null, stdout, stderr });
        }, 2_000);
        child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
        child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
        child.once("error", reject);
        child.once("close", (code) => finish({ code, stdout, stderr }));
        child.stdin.write("SENTINELA-STDIN\n");
      });
      expect(result.code).toBe(0);
      const payload = fs.readFileSync(capture, "utf8");
      expect(payload).toContain("CONTEXTO-ARQUIVO");
      expect(payload).toContain("CAUDA-LOG");
      expect(payload).not.toContain("SENTINELA-STDIN");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reenvia a senha temporaria em politicas sem timestamp persistente", () => {
    expect(source).toContain("SUDO_USE_CACHED_PASS=0");
    expect(source).toContain("SUDO_USE_CACHED_PASS=1");
  });

  it("mantem askpass alternativo sanitizado e remove o helper no cleanup", () => {
    expect(source).toContain("sudo_authenticate_askpass()");
    expect(source).toContain("printf '%s\\n' \"$pass\"");
    expect(source).toContain("chmod 600 \"$pass_file\"");
    expect(source).toContain("unset LD_LIBRARY_PATH LD_PRELOAD");
    expect(source).toContain('for askpass_file in "${SUDO_ASKPASS_HELPER:-}"');
    expect(source).toContain("SUDO_PROMPT_FALLBACK_PKEXEC");
  });

  it("usa a autorizacao da ativacao para ler o handshake", () => {
    expect(source).toContain('elif [ "$SUDO_AUTH_READY" -eq 1 ]; then');
    expect(source).toContain('dump="$(elevate ip netns exec "$NETNS_NAME" wg show "$WG_IF" dump 2>/dev/null)"');
  });

  it("inicia a unidade do Discord antes de apagar a senha temporaria", () => {
    const systemdBlock = source.slice(source.indexOf('elevate systemd-run --collect'), source.indexOf('    else', source.indexOf('elevate systemd-run --collect')));
    expect(systemdBlock).toContain('sh -c \'exec "$@"\' sh $target_cmd >>"$discord_log" 2>&1');
    expect(systemdBlock).not.toContain('>>"$discord_log" 2>&1 &');
  });

  it("mantem Flatpak na sessao grafica e confirma o sandbox no Bazzite", () => {
    expect(source).toContain("flatpak_running_id()");
    expect(source).toContain("flatpak_pid_for_id()");
    expect(source).toContain("launch=flatpak-direct app=%s");
    expect(source).toContain("elevate setsid -f ip netns exec");
    expect(source).toContain('discord_pid_in_netns_elevated "$pid"');
    expect(source).toContain('discord_pid_flav "$flav" "$id"');
    const wait = source.slice(source.indexOf("wait_discord_started()"), source.indexOf("printf '\\n  %sGoLiveBypass", source.indexOf("wait_discord_started()")));
    expect(wait).not.toContain('running_flav "$flav" "$flatpak_id"');
  });

  it("troca de rota devolve a rota default do namespace", () => {
    const start = source.indexOf("refresh_wireguard_route() {");
    const refresh = source.slice(start, source.indexOf("\n}\n", start));
    // Sem re-por a default depois do addr flush, o cliente fica sem internet
    // dentro do namespace (upload/stream morrem ao trocar de rota).
    expect(refresh).toContain('route replace default dev "$WG_IF"');
    expect(refresh.indexOf("addr flush")).toBeLessThan(refresh.indexOf('route replace default dev "$WG_IF"'));
  });

  it("nunca pede senha nos probes automaticos do watchdog", () => {
    expect(source).toContain('--non-interactive) NONINTERACTIVE=1');
    expect(source).toContain('elevate_readonly ip netns exec "$NETNS_NAME" curl');

    const main = fs.readFileSync(path.resolve(process.cwd(), "electron/main.ts"), "utf8");
    const health = main.slice(main.indexOf("async function checkLinuxTunnelHealth"), main.indexOf("function stopLinuxHealthWatchdog"));
    expect(health).toContain('runScript(["--probe", "--json", "--non-interactive"])');
  });

  it("nao anuncia tunel encerrado quando a elevacao falha no teardown", () => {
    const teardown = source.slice(
      source.indexOf("teardown_wireguard_netns() {"),
      source.indexOf("graphics_backend()"),
    );
    // Falha de elevacao nao pode ser mascarada: o operador precisa do aviso
    // com o comando manual porque o tunel pode continuar ativo.
    expect(teardown).toContain('warn "Nao consegui remover o namespace');
    // Sucesso so e anunciado quando o namespace realmente saiu.
    expect(teardown).toContain("if ! netns_exists; then");
    expect(teardown).toContain('ok "Tunel WireGuard encerrado."');
  });
  itLinux("finaliza status e probe mesmo com stdin aberto", { timeout: 120_000 }, async () => {
    // Integração deliberada com o relógio real: reproduz o pipe/socket vivo do
    // Electron, e o timeout curto detecta regressão de bloqueio em cat/read.
    for (const args of [
      ["--status", "--json", "--non-interactive"],
      ["--probe", "--json", "--non-interactive"],
    ]) {
      const result = await runWithOpenStdin(args);
      expect([0, 1]).toContain(result.code);
      const jsonLine = result.stdout.split(/\r?\n/).find((line) => line.trim().startsWith("{"));
      expect(jsonLine).toBeDefined();
      expect(() => JSON.parse(jsonLine as string)).not.toThrow();
    }
  });
  itLinux("limita report_send quando curl nao responde", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "golive-report-timeout-"));
    const curl = path.join(root, "curl");
    const marker = path.join(root, "marker");
    fs.writeFileSync(curl, [
      "#!/bin/sh",
      "has_timeout=0",
      "for arg do [ \"$arg\" = --max-time ] && has_timeout=1; done",
      "[ \"$has_timeout\" -eq 1 ] && { sleep 1; printf done > \"$REPORT_MARKER\"; exit 28; }",
      "sleep 30",
    ].join("\n"));
    fs.chmodSync(curl, 0o755);
    const start = source.indexOf("report_send() {");
    const end = source.indexOf("\n}\n\n# Chamada unica de report", start) + 3;
    const reportSend = source.slice(start, end);
    const script = [
      "set -eu",
      `INSTALL_DIR=${root}`,
      "BUG_API_URL=https://example.invalid/report",
      "BUG_API_TOKEN=test-token",
      "report_sanitize() { printf '%s' \"$1\"; }",
      "have() { [ \"$1\" = curl ]; }",
      reportSend,
      "report_send titulo descricao || true",
      "printf done",
    ].join("\n");
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn("sh", ["-c", script], {
        cwd: root,
        detached: true,
        env: { ...process.env, PATH: `${root}:${process.env.PATH}`, REPORT_MARKER: marker },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (value: { code: number | null; stdout: string; stderr: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        if (child.pid) {
          try { process.kill(-child.pid, "SIGKILL"); } catch { /* já terminou */ }
        }
        finish({ code: null, stdout, stderr });
      }, 2_000);
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child.once("error", reject);
      child.once("close", (code) => finish({ code, stdout, stderr }));
    });
    expect(result.code).toBe(0);
    expect(fs.existsSync(marker)).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  // Roda o confirm() real com `sh`; no Windows não existe shell POSIX para o teste.
  itLinux("recusa confirm sem TTY sem bloquear e preserva ASSUME_YES", () => {
    const start = source.indexOf("\nconfirm() {") + 1;
    const end = source.indexOf("\n}\n", start) + 3;
    const confirm = source.slice(start, end);
    const no = spawnSync("sh", ["-c", `ASSUME_YES=0\n${confirm}\nif confirm teste; then echo yes; else echo no; fi`], {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    expect(no.status).toBe(0);
    expect(no.stdout.trim()).toBe("no");
    const yes = spawnSync("sh", ["-c", `ASSUME_YES=1\n${confirm}\nif confirm teste; then echo yes; else echo no; fi`], {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    expect(yes.status).toBe(0);
    expect(yes.stdout.trim()).toBe("yes");
  });
});
