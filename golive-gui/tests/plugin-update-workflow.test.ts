import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const workflow = fs.readFileSync(
  path.resolve(process.cwd(), "..", ".github", "workflows", "build-gui.yml"),
  "utf8",
);

function jobBlock(name: string): string {
  const lines = workflow.split("\n");
  const start = lines.findIndex((line) => line === `  ${name}:`);
  if (start < 0) throw new Error(`job ausente: ${name}`);

  const nextJob = lines.findIndex(
    (line, index) => index > start && /^  [A-Za-z0-9_-]+:\s*$/.test(line),
  );
  return lines.slice(start, nextJob < 0 ? lines.length : nextJob).join("\n");
}

describe("workflow de release do plugin", () => {
  it("executa release-assets também no canal beta", () => {
    const assets = jobBlock("release-assets");

    expect(assets).not.toMatch(/if:\s*\$\{\{\s*inputs\.canal\s*!=\s*'beta'/);
    expect(assets).toContain("echo \"vencord_basename=goLiveBypass-vencord\"");
    expect(assets).toContain("${{ steps.version.outputs.vencord_basename }}.zip");
    expect(assets).toContain("${{ steps.version.outputs.vencord_basename }}.zip.sha256");
  });

  it("mantém assets beta em draft até a etapa de marcação", () => {
    const assets = jobBlock("release-assets");
    const upload = assets.slice(assets.indexOf("- name: Upload dos assets para a release"));

    expect(upload).toContain("draft: ${{ inputs.rascunho || inputs.canal == 'beta' }}");
    expect(upload).toContain("${{ steps.version.outputs.vencord_basename }}.zip");
    expect(upload).toContain("${{ steps.version.outputs.vencord_basename }}.zip.sha256");
  });

  it("faz beta-marcar aguardar todos os produtores de assets", () => {
    const marker = jobBlock("beta-marcar");

    expect(marker).toMatch(/needs: \[windows, linux, release-assets, proton-runtime-assets\]/);
    expect(marker).toContain("--prerelease");
    expect(marker).toContain("--draft=false");
  });
});
