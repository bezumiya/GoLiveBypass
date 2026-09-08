import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(path.resolve(process.cwd(), "../goLiveBypass/index.tsx"), "utf8");

function blockBetween(startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  return source.slice(start, end > start ? end : undefined);
}

describe("preferências e painel do updater do plugin", () => {
  it("expõe canal stable/beta e atualização automática ligada por padrão", () => {
    expect(source).toContain("updateChannel:");
    expect(source).toContain("type: OptionType.SELECT");
    expect(source).toContain('{ label: "Estável", value: "stable", default: true }');
    expect(source).toContain('{ label: "Beta", value: "beta" }');
    expect(source).toContain("autoUpdate:");
    expect(source).toContain("type: OptionType.BOOLEAN");
    expect(source).toContain("default: true");
  });

  it("configura o updater no start e ao observar mudanças das preferências", () => {
    const start = blockBetween("start() {", "    stop() {");
    const panel = blockBetween("function PluginUpdateSettings()", "const settings = definePluginSettings");

    expect(start).toContain("configurePluginUpdates");
    expect(start).toContain("settings.store.updateChannel");
    expect(start).toContain("settings.store.autoUpdate");
    expect(panel).toContain('settings.use(["updateChannel", "autoUpdate"])');
    expect(panel).toContain("configurePluginUpdates");
    expect(panel).toContain("getPluginUpdateStatus");
  });

  it("faz polling limitado, notifica uma vez por versão pendente e pede reload manual", () => {
    expect(source).toContain("PLUGIN_UPDATE_STATUS_POLL_INTERVAL_MS = 15_000");
    expect(source).toContain("setInterval");
    expect(source).toContain("clearInterval");
    expect(source).toContain("lastNotifiedPendingVersion");
    expect(source).toContain("pendingVersion");
    expect(source).toContain("pronto; recarregue o Discord");
    expect(source).toMatch(/recarregue o Discord/i);
    expect(source).not.toContain("app.relaunch");
    expect(source).not.toContain("app.quit");
  });

  it("preserva a ativação da VPN e o watchdog sem usar shutdown no update", () => {
    const start = blockBetween("start() {", "    stop() {");
    const update = blockBetween("    const update = async () =>", "    return (");

    expect(start).toContain("startStreamClaimWatch()");
    expect(start).toContain("Native?.enable()");
    expect(source).toContain("stopStreamClaimWatch()");
    expect(source).toContain("Native?.shutdown()");
    expect(update).not.toContain("shutdown");
  });
});
