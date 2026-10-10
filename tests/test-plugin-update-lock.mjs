import assert from "node:assert/strict";
import * as fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";

const source = fs.readFileSync(new URL("../goLiveBypass/native.ts", import.meta.url), "utf8");
const start = source.indexOf("function acquirePluginUpdateLock()");
const end = source.indexOf("function quarantineLegacyPendingUpdate", start);
assert.ok(start >= 0 && end > start);
const functions = stripTypeScriptTypes(source.slice(start, end));

function fixture() {
    const root = fs.mkdtempSync(join(tmpdir(), "golive-update-lock-"));
    const path = join(root, "update.lock");
    const context = createContext({
        ...fs,
        pluginUpdateLock: null,
        VPN_DATA_DIR: root,
        updateLockPath: () => path,
        randomUUID: () => "test-owner",
        readUpdateLockOwner: () => {
            try { return JSON.parse(fs.readFileSync(path, "utf8")); }
            catch { return null; }
        },
        process: { pid: process.pid },
        isProcessAlive: () => true,
        log() {},
    });
    runInContext(functions, context);
    return { root, path, context };
}

test("release não fecha um descritor reutilizado por outro arquivo", () => {
    const { root, path, context } = fixture();
    let reused;
    try {
        const lock = context.acquirePluginUpdateLock();
        reused = fs.openSync(join(root, "unrelated.log"), "w+");
        context.releasePluginUpdateLock(lock);
        context.releasePluginUpdateLock(lock);
        fs.writeSync(reused, "still open");
        assert.equal(fs.fstatSync(reused).size, 10);
        assert.equal(fs.existsSync(path), false);
    } finally {
        if (reused !== undefined) { try { fs.closeSync(reused); } catch {} }
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("locks aninhados só removem o arquivo na última liberação", () => {
    const { root, path, context } = fixture();
    try {
        const lock = context.acquirePluginUpdateLock();
        assert.equal(context.acquirePluginUpdateLock(), lock);
        context.releasePluginUpdateLock(lock);
        assert.equal(fs.existsSync(path), true);
        context.releasePluginUpdateLock(lock);
        assert.equal(fs.existsSync(path), false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("release preserva o lock de outro owner", () => {
    const { root, path, context } = fixture();
    try {
        const lock = context.acquirePluginUpdateLock();
        fs.writeFileSync(path, JSON.stringify({ pid: process.pid, token: "another-owner" }));
        context.releasePluginUpdateLock(lock);
        assert.equal(JSON.parse(fs.readFileSync(path, "utf8")).token, "another-owner");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
