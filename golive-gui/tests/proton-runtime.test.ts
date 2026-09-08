import { afterEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  findProtonConfgenPath,
  protonConfgenCandidates,
  protonRuntimeAssetUrl,
  readProtonRuntimeManifest,
  stageValidatedProtonConfgen,
} from "../electron/proton-runtime";

const temporaryRoots: string[] = [];
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "golive-proton-runtime-"));
  temporaryRoots.push(root);
  return root;
}

describe("runtime Proton empacotado", () => {
  it("prioriza extraResources e aceita layout ao lado do executável", () => {
    const context = {
      resourcesPath: "/app/resources",
      execPath: "/app/GoLiveBypass.exe",
      appPath: "/app/resources/app.asar",
      cwd: "/repo/golive-gui",
      moduleDir: "/repo/golive-gui/dist-electron",
      platform: "win32" as const,
      arch: "x64" as const,
    };
    const candidates = protonConfgenCandidates(context);
    expect(candidates[0]).toContain("resources");
    expect(candidates).toContain("/app/resources/extra/proton-confgen/proton-confgen.exe");
    expect(candidates).toContain("/app/extra/proton-confgen/proton-confgen.exe");
  });

  it("encontra o helper no primeiro layout que realmente existe", () => {
    const root = temporaryRoot();
    const resourcesPath = path.join(root, "resources");
    const helperDir = path.join(resourcesPath, "extra", "proton-confgen");
    fs.mkdirSync(helperDir, { recursive: true });
    const helper = path.join(helperDir, "proton-confgen");
    fs.writeFileSync(helper, "helper-linux");
    expect(findProtonConfgenPath({ resourcesPath, platform: "linux", arch: "x64" })).toBe(helper);
  });

  it("copia o helper validado para runtime/<versão> sem deixar temporário", async () => {
    const root = temporaryRoot();
    const sourcePath = path.join(root, "proton-confgen");
    const content = "helper-linux-binary";
    fs.writeFileSync(sourcePath, content);
    const expectedSha256 = crypto.createHash("sha256").update(content).digest("hex");
    const result = await stageValidatedProtonConfgen({
      sourcePath,
      installDir: path.join(root, "data"),
      version: "2.0.6-beta-2",
      expectedSha256,
      assetName: "GoLiveBypass-2.0.6-beta-2-proton-confgen-linux-x64",
    });
    expect(result).toContain(path.join("runtime", "2.0.6-beta-2"));
    expect(fs.readFileSync(result, "utf8")).toBe(content);
    expect(fs.readdirSync(path.dirname(result)).some((item) => item.endsWith(".tmp"))).toBe(false);
  });

  it("rejeita hash incorreto e versões/path inválidos", async () => {
    const root = temporaryRoot();
    const sourcePath = path.join(root, "proton-confgen");
    fs.writeFileSync(sourcePath, "helper-linux-binary");
    await expect(stageValidatedProtonConfgen({
      sourcePath,
      installDir: path.join(root, "data"),
      version: "../x",
    })).rejects.toThrow(/versão/i);
    await expect(stageValidatedProtonConfgen({
      sourcePath,
      installDir: path.join(root, "data"),
      version: "2.0.6-beta-2",
      expectedSha256: "0".repeat(64),
    })).rejects.toThrow(/SHA-256/i);
    expect(protonRuntimeAssetUrl("2.0.6-beta-2", "GoLiveBypass-2.0.6-beta-2-proton-confgen-win-x64.exe"))
      .toBe("https://github.com/bezumiya/GoLiveBypass/releases/download/v2.0.6-beta-2/GoLiveBypass-2.0.6-beta-2-proton-confgen-win-x64.exe");
    expect(() => protonRuntimeAssetUrl("2.0.6-beta-2", "../proton-confgen.exe")).toThrow(/asset/i);
  });

  it("aceita somente manifesto com os dois runtimes e hashes válidos", () => {
    const root = temporaryRoot();
    const manifestPath = path.join(root, "proton-confgen-manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify({
      version: "2.0.6-beta-2",
      assets: {
        "win32-x64": { asset: "win.exe", sha256: "A".repeat(64) },
        "linux-x64": { asset: "linux", sha256: "B".repeat(64) },
      },
    }));
    expect(readProtonRuntimeManifest([manifestPath])).toMatchObject({ version: "2.0.6-beta-2" });
    fs.writeFileSync(manifestPath, JSON.stringify({ version: "2.0.6-beta-2", assets: { "win32-x64": { asset: "../x", sha256: "A".repeat(64) } } }));
    expect(readProtonRuntimeManifest([manifestPath])).toBeUndefined();
  });
});
