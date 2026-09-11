import assert from "node:assert/strict";
import { test } from "node:test";
import {
    copyFileSync,
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const isolatedModuleRoot = mkdtempSync(path.join(os.tmpdir(), "golive-route-probe-module-"));
const windowsSource = readFileSync(new URL("../goLiveBypass/vpn-windows.ts", import.meta.url), "utf8")
    .replace('from "./vpn-types"', 'from "./vpn-types.ts"')
    .replace('from "./vpn-snapshot"', 'from "./vpn-snapshot.ts"');
copyFileSync(new URL("../goLiveBypass/vpn-types.ts", import.meta.url), path.join(isolatedModuleRoot, "vpn-types.ts"));
copyFileSync(new URL("../goLiveBypass/vpn-snapshot.ts", import.meta.url), path.join(isolatedModuleRoot, "vpn-snapshot.ts"));
writeFileSync(path.join(isolatedModuleRoot, "vpn-windows.ts"), windowsSource, "utf8");
const {
    copyRouteProbe,
    cleanupRouteProbes,
    isManagedRouteProbePath,
    removeRouteProbe,
    routeProbeExecutablePath,
} = await import(pathToFileURL(path.join(isolatedModuleRoot, "vpn-windows.ts")).href);

process.once("exit", () => rmSync(isolatedModuleRoot, { recursive: true, force: true }));

function temporaryRoot() {
    return mkdtempSync(path.join(os.tmpdir(), "golive-route-probe-test-"));
}

test("reconhece somente probe regular no diretorio informado", () => {
    const root = temporaryRoot();
    const outsideRoot = temporaryRoot();
    const valid = path.join(root, ".golive-route-probe-11-1000.exe");
    const invalidName = path.join(root, ".golive-route-probe-11.exe");
    const outside = path.join(outsideRoot, ".golive-route-probe-12-1000.exe");
    try {
        assert.equal(isManagedRouteProbePath(root, valid), true);
        assert.equal(isManagedRouteProbePath(root, invalidName), false);
        assert.equal(isManagedRouteProbePath(root, outside), false);
        assert.equal(isManagedRouteProbePath(root, path.join(root, "..", path.basename(valid))), false);
    } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(outsideRoot, { recursive: true, force: true });
    }
});

test("copia sem sobrescrever e remove de forma idempotente", async () => {
    const root = temporaryRoot();
    const outsideRoot = temporaryRoot();
    const source = path.join(root, "proton-confgen.exe");
    const target = routeProbeExecutablePath(root);
    const outside = path.join(outsideRoot, ".golive-route-probe-13-1000.exe");
    try {
        writeFileSync(source, "probe-content");
        writeFileSync(outside, "outside-content");
        copyRouteProbe(source, target);
        assert.equal(readFileSync(target, "utf8"), "probe-content");
        assert.throws(() => copyRouteProbe(source, target));
        assert.equal(await removeRouteProbe(root, target), "removed");
        assert.equal(await removeRouteProbe(root, target), "missing");
        assert.equal(await removeRouteProbe(root, outside), "invalid");
        assert.equal(existsSync(outside), true);
    } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(outsideRoot, { recursive: true, force: true });
    }
});

test("varredura remove apenas residuos antigos e protege entrada ativa", async () => {
    const root = temporaryRoot();
    const outsideRoot = temporaryRoot();
    const oldProbe = path.join(root, ".golive-route-probe-21-1000.exe");
    const protectedProbe = path.join(root, ".golive-route-probe-22-1000.exe");
    const recentProbe = path.join(root, ".golive-route-probe-23-1000.exe");
    const linkProbe = path.join(root, ".golive-route-probe-24-1000.exe");
    const directoryProbe = path.join(root, ".golive-route-probe-25-1000.exe");
    const outside = path.join(outsideRoot, "sentinel.exe");
    const now = 2_000_000;
    try {
        writeFileSync(oldProbe, "old");
        writeFileSync(protectedProbe, "protected");
        writeFileSync(recentProbe, "recent");
        writeFileSync(outside, "outside");
        symlinkSync(outside, linkProbe);
        mkdirSync(directoryProbe);
        utimesSync(oldProbe, new Date(1_000_000), new Date(1_000_000));
        utimesSync(protectedProbe, new Date(1_000_000), new Date(1_000_000));
        utimesSync(recentProbe, new Date(now - 1_000), new Date(now - 1_000));

        const result = await cleanupRouteProbes(root, [protectedProbe], now, 60_000);
        assert.equal(result.scanned, 5);
        assert.equal(result.removed, 1);
        assert.equal(result.protected, 1);
        assert.equal(result.recent, 1);
        assert.equal(result.invalid, 2);
        assert.equal(result.busy, 0);
        assert.equal(existsSync(oldProbe), false);
        assert.equal(existsSync(protectedProbe), true);
        assert.equal(existsSync(recentProbe), true);
        assert.equal(lstatSync(linkProbe).isSymbolicLink(), true);
        assert.equal(lstatSync(directoryProbe).isDirectory(), true);
        assert.equal(existsSync(outside), true);
    } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(outsideRoot, { recursive: true, force: true });
    }
});
