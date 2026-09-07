import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { TUNNEL_STARTUP_SETTLE_MS, waitForTunnelStartupSettle } from "../electron/tunnel-startup";

describe("acomodação inicial do túnel", () => {
  it("usa uma espera curta e determinística sem depender de probes", async () => {
    const delays: number[] = [];
    await waitForTunnelStartupSettle(async (milliseconds) => {
      delays.push(milliseconds);
    });
    expect(delays).toEqual([TUNNEL_STARTUP_SETTLE_MS]);
    expect(TUNNEL_STARTUP_SETTLE_MS).toBe(2_000);
  });

  it("espera no Windows antes de abrir o Discord", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "electron/main.ts"), "utf8");
    const activation = source.slice(source.indexOf("async function executarAtivacao"), source.indexOf("async function deactivateAll"));
    expect(activation).toMatch(/await startWireSockService\([\s\S]*?await waitForWindowsRouteSettle\([\s\S]*?startDiscordAndConfirm/);
  });

  it("espera no Linux depois de preparar o namespace e antes do launcher", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "../standalone/golivebypass-standalone.sh"), "utf8");
    const call = source.lastIndexOf("wait_for_tunnel_startup");
    const launch = source.indexOf('start_discord "$(printf');
    expect(source).toContain("TUNNEL_STARTUP_SETTLE_SECONDS=2");
    expect(call).toBeGreaterThan(source.indexOf("if [ \"$injected\" -eq 0 ]"));
    expect(call).toBeLessThan(launch);
  });
});
