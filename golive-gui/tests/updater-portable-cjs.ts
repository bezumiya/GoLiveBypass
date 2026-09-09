// Runner sem Electron/Vitest: compilar junto com updater-identity.ts para CommonJS.
// ELECTRON_RUN_AS_NODE=1 electron.exe updater-portable-cjs.js gui.exe helper.exe
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { isWindowsPortableExecutable, validWindowsIdentity, verifyWindowsAsset } from "../electron/updater-identity";
import { compararVersoes } from "../electron/updater-channel";

export function testPortableFiles(gui: string, helper: string): void {
  const good = readFileSync(gui);
  const bad = readFileSync(helper);
  assert.equal(isWindowsPortableExecutable(good), true, "GUI deve conter PE GUI + NSIS no overlay");
  assert.equal(isWindowsPortableExecutable(bad), false, "confgen nao pode ser portable");
  assert.equal(isWindowsPortableExecutable(good.subarray(0, 512)), false, "portable truncado");
  const tag = "v2.0.6-beta-5";
  const assetName = "GoLiveBypass-2.0.6-beta-5.exe";
  const identity = { assetName, size: good.length,
    url: `https://github.com/bezumiya/GoLiveBypass/releases/download/${tag}/${assetName}`,
    digest: `sha256:${createHash("sha256").update(good).digest("hex")}` };
  assert.equal(validWindowsIdentity(tag, identity), true);
  assert.equal(verifyWindowsAsset(gui, tag, identity), true);
  assert.equal(verifyWindowsAsset(gui, tag, { ...identity, size: good.length - 1 }), false);
  assert.equal(verifyWindowsAsset(helper, tag, { ...identity, size: bad.length,
    digest: `sha256:${createHash("sha256").update(bad).digest("hex")}` }), false);
  assert.equal(validWindowsIdentity(tag, { ...identity, assetName: "proton-confgen.exe" }), false);
  assert.equal(validWindowsIdentity(tag, { digest: identity.digest }), false, "pending legado");
  assert.ok(compararVersoes("2.0.6-beta-10", "2.0.6-beta-9") > 0);
  assert.equal(compararVersoes("2.0.6-beta-10", "2.0.6-beta.10"), 0);
  console.log(JSON.stringify({ passed: true, gui, guiBytes: good.length, helper, helperBytes: bad.length }));
}

if (require.main === module) {
  const [gui, helper] = process.argv.slice(2);
  assert.ok(gui && helper, "Uso: updater-portable-cjs.js GUI.exe proton-confgen.exe");
  testPortableFiles(gui, helper);
}
