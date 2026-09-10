import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

describe("elevacao sudo no Linux", () => {
  const source = fs.readFileSync(
    path.resolve(process.cwd(), "../standalone/golivebypass-standalone.sh"),
    "utf8",
  );

  it("reenvia a senha temporaria em politicas sem timestamp persistente", () => {
    expect(source).toContain("SUDO_USE_CACHED_PASS=0");
    expect(source).toContain("SUDO_USE_CACHED_PASS=1");
    expect(source).toContain("sudo -S -k -p '' \"$@\"");
  });

  it("mantem stdin apos a senha para comandos elevados como tee", () => {
    expect(source).toContain('(cat "$SUDO_PASS_FILE"; cat) | sudo -S -k -p \'\' "$@"');
    expect(source).toContain('if [ "${1:-}" = "tee" ]; then');
    expect(source).toContain('sudo -S -k -p \'\' "$@" < "$SUDO_PASS_FILE"');
    expect(source).toContain("trap cleanup_sudo_pass EXIT INT TERM");
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

  it("mantem Flatpak na sessao grafica e reconhece o sandbox no Bazzite", () => {
    expect(source).toContain("flatpak_running_id()");
    expect(source).toContain("flatpak_pid_for_id()");
    expect(source).toContain("launch=flatpak-direct app=%s");
    expect(source).toContain("elevate setsid -f ip netns exec");
    expect(source).toContain('running_flav "$flav" "$flatpak_id"');
    expect(source).toContain('discord_pid_flav "$flav" "$id"');
  });

  it("nunca pede senha nos probes automaticos do watchdog", () => {
    expect(source).toContain('--non-interactive) NONINTERACTIVE=1');
    expect(source).toContain('sudo -n "$@"');
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
});
