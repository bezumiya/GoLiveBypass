import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createHash } from "crypto";
import { Readable } from "stream";
import { EventEmitter } from "events";
import { isWindowsGuiExecutable, isWindowsPortableExecutable, validWindowsIdentity } from "../electron/updater-identity";

const state = vi.hoisted(() => ({ dir: "", body: Buffer.alloc(0), assets: [] as unknown[], downloads: 0,
  spawn: vi.fn(() => true), quit: vi.fn() }));
vi.mock("electron", () => ({ app: { isPackaged: true, getPath: () => state.dir,
  getVersion: () => "2.0.6-beta-5", quit: state.quit }, dialog: { showMessageBox: vi.fn(async () => ({ response: 1 })) } }));
vi.mock("electron-updater", () => ({ autoUpdater: {} }));
vi.mock("../electron/updater-replace", () => ({ cleanupOldExe: vi.fn(), spawnWindowsUpdateHelper: state.spawn }));
vi.mock("../electron/update-pulse", () => ({ UPDATE_STREAM_URL: "", createUpdatePulseClient: () => ({ start() {}, stop() {} }) }));
vi.mock("https", () => ({ request: (url: unknown, options: unknown, callback?: (res: unknown) => void) => {
  const cb = (typeof options === "function" ? options : callback) as (res: unknown) => void;
  const req = new EventEmitter() as EventEmitter & { end(): void; setTimeout(): void };
  req.setTimeout = () => {};
  req.end = () => queueMicrotask(() => {
    const api = typeof url !== "string";
    if (!api) state.downloads++;
    const res = Readable.from([api ? JSON.stringify([{ tag_name: "v2.0.6-beta-6", prerelease: true, assets: state.assets }]) : state.body]);
    Object.assign(res, { statusCode: 200, headers: {} });
    cb(res);
  });
  return req;
} }));

const tag = "v2.0.6-beta-6";
const name = "GoLiveBypass-2.0.6-beta-6.exe";
const url = `https://github.com/bezumiya/GoLiveBypass/releases/download/${tag}/${name}`;
function pe(subsystem = 2, size = 512): Buffer {
  const b = Buffer.alloc(size);
  b.writeUInt16LE(0x5a4d, 0); b.writeUInt32LE(64, 0x3c);
  b.writeUInt32LE(0x4550, 64); b.writeUInt16LE(0x14c, 68);
  b.writeUInt16LE(224, 84); b.writeUInt16LE(2, 86);
  b.writeUInt16LE(0x10b, 88); b.writeUInt16LE(subsystem, 156);
  b.writeUInt16LE(1, 70);
  b.writeUInt32LE(400, 88 + 60);
  b.writeUInt32LE(400, 312 + 16);
  Buffer.from("efbeadde4e756c6c736f6674496e7374", "hex").copy(b, 404);
  b.writeUInt32LE(1, 420); b.writeUInt32LE(size - 400, 424);
  return b;
}
function identity(body = state.body) {
  return { assetName: name, url, size: body.length, digest: `sha256:${createHash("sha256").update(body).digest("hex")}` };
}
function marker(extra = {}) {
  const downloaded = join(state.dir, "GoLiveBypass-update-test.exe");
  writeFileSync(downloaded, state.body);
  const pending = { current: process.env.PORTABLE_EXECUTABLE_FILE, downloaded, tag,
    version: tag.slice(1), prerelease: true, ...identity(), ...extra };
  writeFileSync(join(state.dir, "pending-windows-update.json"), JSON.stringify(pending));
  return pending;
}
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); state.spawn.mockClear(); state.quit.mockClear();
  state.dir = mkdtempSync(join(tmpdir(), "updater-identity-"));
  vi.stubEnv("PORTABLE_EXECUTABLE_FILE", join(state.dir, "current.exe"));
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  state.body = pe(); state.downloads = 0;
  state.assets = [{ name, browser_download_url: url, size: state.body.length, digest: identity().digest }];
});
afterEach(() => {
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs();
  Object.defineProperty(process, "platform", platform);
  rmSync(state.dir, { recursive: true, force: true });
});
it("vincula nome, repositorio, tag, URL, tamanho e digest antes do download", async () => {
  expect(validWindowsIdentity(tag, identity())).toBe(true);
  for (const extra of [{ assetName: "helper.exe" }, { size: 0 }, { size: 1.5 }, { digest: "sha256:abc" },
    { url: url.replace("bezumiya", "outro") }, { url: url.replace(tag, "v2.0.6") }, { url: `${url}?x=1` }]) {
    expect(validWindowsIdentity(tag, { ...identity(), ...extra })).toBe(false);
  }
  state.assets = [{ name, browser_download_url: url, digest: identity().digest }];
  const updater = await import("../electron/updater");
  await updater.checkWindowsUpdate(() => null, () => true, () => "beta", { force: true });
  expect(state.downloads).toBe(0);
});
it("baixa, persiste identidade e aplica GUI com digest e tamanho corretos", async () => {
  const updater = await import("../electron/updater");
  const controller = updater.setupUpdater(() => null, () => false, () => "beta")!;
  await updater.checkWindowsUpdate(() => null, () => true, () => "beta", { force: true });
  expect(controller.hasPendingUpdate()).toBe(true);
  const saved = JSON.parse(readFileSync(join(state.dir, "pending-windows-update.json"), "utf8"));
  expect(saved).toMatchObject(identity());
  expect(await controller.applyPendingUpdate()).toBe(true);
  expect(state.spawn).toHaveBeenCalledWith(process.env.PORTABLE_EXECUTABLE_FILE, saved.downloaded);
  rmSync(saved.downloaded, { force: true });
});
it.each(["console", "size", "digest"])("recusa download %s mesmo com nome exato", async (kind) => {
  if (kind === "console") state.body = pe(3, 14_000_000);
  state.assets = [{ name, browser_download_url: url, digest: identity().digest,
    size: state.body.length + (kind === "size" ? 1 : 0) }];
  if (kind === "digest") state.body[400] = 1;
  const updater = await import("../electron/updater");
  await updater.checkWindowsUpdate(() => null, () => true, () => "beta", { force: true });
  expect(updater.isUpdateReady()).toBe(false);
  expect(existsSync(join(state.dir, "pending-windows-update.json"))).toBe(false);
  expect(state.spawn).not.toHaveBeenCalled();
});
it.each(["legacy", "console", "size", "stable", "downgrade"])("recusa restauracao %s apos rollback", async (kind) => {
  if (kind === "console") state.body = pe(3, 14_000_000);
  marker(kind === "legacy" ? { assetName: undefined, url: undefined, size: undefined } :
    kind === "size" ? { size: 1 } : kind === "downgrade" ? { tag: "v2.0.6-beta-4", version: "2.0.6-beta-4" } : {});
  const updater = await import("../electron/updater");
  const controller = updater.setupUpdater(() => null, () => false, () => kind === "stable" ? "stable" : "beta")!;
  expect(controller.hasPendingUpdate()).toBe(false);
  expect(await controller.applyPendingUpdate()).toBe(false);
  expect(existsSync(join(state.dir, "pending-windows-update.json"))).toBe(false);
  expect(state.spawn).not.toHaveBeenCalled();
});
it("restaura GUI valida e reconfere bytes antes de aplicar", async () => {
  const pending = marker();
  const updater = await import("../electron/updater");
  const controller = updater.setupUpdater(() => null, () => false, () => "beta")!;
  expect(controller.hasPendingUpdate()).toBe(true);
  writeFileSync(pending.downloaded, pe(3));
  expect(await controller.applyPendingUpdate()).toBe(false);
  expect(state.spawn).not.toHaveBeenCalled();
  expect(state.quit).not.toHaveBeenCalled();
});
it("restaura e aplica o portable valido apos reiniciar", async () => {
  const pending = marker();
  const updater = await import("../electron/updater");
  const controller = updater.setupUpdater(() => null, () => false, () => "beta")!;
  expect(await controller.applyPendingUpdate()).toBe(true);
  expect(state.spawn).toHaveBeenCalledWith(pending.current, pending.downloaded);
});
it("troca para stable descarta beta restaurada antes de aplicar", async () => {
  marker();
  const updater = await import("../electron/updater");
  const controller = updater.setupUpdater(() => null, () => false, () => "beta")!;
  controller.setChannel("stable");
  expect(await controller.applyPendingUpdate()).toBe(false);
  expect(state.spawn).not.toHaveBeenCalled();
});
it("falha ao agendar helper preserva update e app para nova tentativa", async () => {
  marker();
  state.spawn.mockReturnValueOnce(false);
  const updater = await import("../electron/updater");
  const controller = updater.setupUpdater(() => null, () => false, () => "beta")!;
  expect(await controller.applyPendingUpdate()).toBe(false);
  expect(controller.hasPendingUpdate()).toBe(true);
  expect(state.quit).not.toHaveBeenCalled();
  expect(await controller.applyPendingUpdate()).toBe(true);
});
it("valida limites PE, console e DLL sem usar tamanho minimo", () => {
  expect(isWindowsGuiExecutable(pe())).toBe(true);
  expect(isWindowsGuiExecutable(pe(3))).toBe(false);
  const dll = pe(); dll.writeUInt16LE(0x2002, 86);
  expect(isWindowsGuiExecutable(dll)).toBe(false);
  const malformed = pe(); malformed.writeUInt32LE(0xffffffff, 0x3c);
  expect(isWindowsGuiExecutable(malformed)).toBe(false);
  expect(isWindowsGuiExecutable(Buffer.from("MZ"))).toBe(false);
});
it("exige NSIS no overlay, recusa assinatura em secao e arquivo truncado", () => {
  expect(isWindowsPortableExecutable(pe())).toBe(true);
  const noSignature = pe(); noSignature.fill(0, 404, 420);
  expect(isWindowsGuiExecutable(noSignature)).toBe(true);
  expect(isWindowsPortableExecutable(noSignature)).toBe(false);
  const inSection = pe(); inSection.writeUInt32LE(450, 312 + 16);
  expect(isWindowsPortableExecutable(inSection)).toBe(false);
  expect(isWindowsPortableExecutable(pe().subarray(0, 500))).toBe(false);
});
