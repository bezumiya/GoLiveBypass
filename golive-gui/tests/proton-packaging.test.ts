import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.cwd(), "..");

describe("empacotamento do runtime Proton", () => {
  it("mantém o helper e o manifesto nos recursos extras", () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, "golive-gui/package.json"), "utf8"));
    expect(packageJson.build.extraResources).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: "../tools/proton-confgen/build", to: "extra/proton-confgen" }),
    ]));
    const script = fs.readFileSync(path.join(root, "golive-gui/scripts/build-proton.mjs"), "utf8");
    expect(script).toContain("proton-confgen-manifest.json");
    expect(script).toContain("-buildvcs=false");
    expect(script).toContain("-trimpath");
    expect(script).toContain("-buildid=");
  });

  it("publica assets auxiliares da mesma versão no workflow", () => {
    const workflow = fs.readFileSync(path.join(root, ".github/workflows/build-gui.yml"), "utf8");
    expect(workflow).toContain("proton-runtime-assets:");
    expect(workflow).toContain("proton-confgen-win-x64.exe");
    expect(workflow).toContain("proton-confgen-linux-x64");
    expect(workflow).toContain("node golive-gui/scripts/build-proton.mjs");
    expect(workflow).toContain(".assets[$key].sha256");
    expect(workflow).toContain("Comparar hashes do manifesto com os assets");
    expect(workflow).toContain("cp tools/proton-confgen/build/proton-confgen");
    expect(workflow).toContain("-buildvcs=false");
    expect(workflow).toContain("needs: [windows, linux, proton-runtime-assets]");
  });
});
