import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { comparePluginVersions } from "../../goLiveBypass/update-channel";

const root = path.resolve(process.cwd(), "../goLiveBypass");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

describe("linha major v2 do plugin", () => {
  it("declara a mesma versão beta no manifest, UI e updater", () => {
    const expected = "2.0.0-beta.1";
    expect(JSON.parse(read("manifest.json")).version).toBe(expected);
    expect(read("index.tsx")).toContain(`const PLUGIN_VERSION = "${expected}"`);
    expect(read("native.ts")).toContain(`const PLUGIN_VERSION = "${expected}"`);
  });

  it("mantém a política que ignora prereleases no endpoint estável", () => {
    const native = read("native.ts");
    expect(native).toContain("release.prerelease === true");
    expect(native).toContain("nenhum release estável disponível");
    expect(native).toContain("compareUpdateVersion(PLUGIN_VERSION, release.version)");
  });

  it("mantém beta.1 e beta-1 equivalentes na ordenação do plugin", () => {
    expect(comparePluginVersions("2.0.0-beta.1", "2.0.0-beta-1")).toBe(0);
  });
});
