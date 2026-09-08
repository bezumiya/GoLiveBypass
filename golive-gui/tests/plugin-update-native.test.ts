import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const native = fs.readFileSync(
  path.resolve(process.cwd(), "..", "goLiveBypass", "native.ts"),
  "utf8",
);

function updateBlock(): string {
  const start = native.indexOf("async function performPluginUpdate");
  const end = native.indexOf('app.on("before-quit"');
  if (start < 0 || end < 0) throw new Error("bloco do updater nativo ausente");
  return native.slice(start, end);
}

describe("updater nativo do plugin", () => {
  it("consulta a coleção de releases e seleciona pelo canal", () => {
    expect(native).toContain("/repos/bezumiya/GoLiveBypass/releases?per_page=20");
    expect(native).not.toContain("/repos/pdl-clay/GoLiveBypass/releases/latest");
    expect(native).toContain("choosePluginRelease(candidates, PLUGIN_VERSION, channel)");
    expect(native).toContain("if (release.draft === true");
    expect(native).toContain("release.prerelease === true");
    expect(native).toContain('name === PLUGIN_ASSET');
    expect(native).toContain('name === PLUGIN_CHECKSUM_ASSET');
  });

  it("aplica limites e validações de transporte e artefato", () => {
    expect(native).toContain('parsed.protocol !== "https:"');
    expect(native).toContain("PLUGIN_MAX_REDIRECTS");
    expect(native).toContain("PLUGIN_UPDATE_TIMEOUT_MS");
    expect(native).toContain("PLUGIN_API_MAX_BYTES");
    expect(native).toContain("PLUGIN_ARCHIVE_MAX_BYTES");
    expect(native).toContain('createHash("sha256")');
    expect(native).toContain("SHA-256 do plugin não confere");
    expect(native).toContain("manifest do plugin não corresponde ao release");
    expect(native).toContain("validateArchiveEntries");
    expect(native).toContain("validateExtractedTree");
    expect(native).toContain('archive do plugin contém link simbólico');
    expect(native).toContain("try {\n                    void downloadBytes(response.headers.location");
  });

  it("persiste um marcador privado e informa que o reload ainda é necessário", () => {
    expect(native).toContain('const PENDING_UPDATE_FILE = "plugin-update-pending.json"');
    expect(native).toContain("validPendingUpdate");
    expect(native).toContain("writePendingUpdate");
    expect(native).toContain("backupName");
    expect(native).toContain("reloadRequired: true");
    expect(native).toContain("pending: true");
    expect(native).toContain("reconcileReachedPendingUpdate");
  });

  it("trata concorrência, ciclo automático e rollback de beta ao voltar para stable", () => {
    expect(native).toContain("pluginUpdateCheckFlight");
    expect(native).toContain("pluginUpdateFlight");
    expect(native).toContain("PLUGIN_UPDATE_INITIAL_DELAY_MS = 8_000");
    expect(native).toContain("PLUGIN_UPDATE_INTERVAL_MS = 60 * 60 * 1000");
    expect(native).toContain("discardPendingBetaForStable");
    expect(native).toContain("update beta pendente descartado ao selecionar stable");
    expect(native).toContain("rebuildUserplugin(projectRoot)");
    expect(native).toContain("falha ao restaurar o build anterior");
    expect(native).toContain("pluginUpdatePolicy.channel === policy.channel");
  });

  it("não reinicia o Discord no fluxo de update e preserva enable/shutdown da VPN", () => {
    const block = updateBlock();
    expect(block).not.toMatch(/app\.(quit|relaunch)\s*\(/);
    expect(native).toMatch(/export function enable\([^)]*IpcMainInvokeEvent[^)]*\)/);
    expect(native).toMatch(/export function shutdown\([^)]*IpcMainInvokeEvent[^)]*\)/);
    expect(native).toContain("export function configurePluginUpdates");
    expect(native).toContain("export function getPluginUpdateStatus");
    expect(native).toMatch(/export (?:async )?function checkPluginUpdate/);
    expect(native).toMatch(/export (?:async )?function updatePlugin/);
  });
});
