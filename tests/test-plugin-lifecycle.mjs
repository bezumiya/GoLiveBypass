import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../goLiveBypass/index.tsx", import.meta.url), "utf8");
const nativeSource = readFileSync(new URL("../goLiveBypass/native.ts", import.meta.url), "utf8");

test("start e stop toleram bridge nativa ausente", () => {
    assert.match(source, /if \(!onboardingRequired && typeof Native\?\.enable === "function"\)/);
    assert.match(source, /if \(typeof Native\?\.shutdown === "function"\)/);
    assert.match(source, /if \(typeof Native\?\.logFromRenderer === "function"\)/);
    assert.match(source, /typeof Native\?\.cancelProtonOptimization !== "function"/);
    assert.match(source, /Promise\.resolve\(Native\.cancelProtonOptimization\(activeRequestId\)\)\.catch/);
    assert.doesNotMatch(source, /Native\?\.enable\(\)\.then/);
    assert.doesNotMatch(source, /Native\?\.shutdown\(\)\.catch/);
    assert.doesNotMatch(source, /Native\?\.logFromRenderer\(message\)\.catch/);
});

test("desativar o plugin não solicita relaunch automático", () => {
    const shutdown = nativeSource.slice(nativeSource.indexOf("export function shutdown"), nativeSource.indexOf("export function restoreNetwork"));
    const restart = nativeSource.slice(nativeSource.indexOf("export function restartDiscord"), nativeSource.indexOf("export function getVpnStatus"));
    assert.match(shutdown, /controller\.shutdown\(false\)/);
    assert.match(shutdown, /controller\.cancelProtonLogin\(\)/);
    assert.doesNotMatch(shutdown, /controller\.shutdown\(true\)/);
    assert.match(restart, /controller\.restartDiscord\(\)/);
});

test("cancelamento de login é exposto ao renderer e ao fechamento do processo", () => {
    assert.match(nativeSource, /export function cancelProtonLogin\(/);
    assert.match(nativeSource, /controller\.cancelProtonLogin\(typeof requestId === "string"/);
    const beforeQuit = nativeSource.slice(nativeSource.indexOf('app.on("before-quit"'), nativeSource.indexOf("app.on(\"before-quit\"") + 2_000);
    assert.match(beforeQuit, /controller\.cancelProtonLogin\(\)/);
    assert.match(source, /const loginRequestIdRef = React\.useRef<string \| null>\(null\)/);
    assert.match(source, /Native\.loginProton\(\{ username: username\.trim\(\), password, twoFactorCode, requestId: loginRequestId \}\)/);
    assert.match(source, /const cancelActiveLogin = \(\) =>/);
});

test("start e stop invalidam callbacks assíncronos de uma geração anterior", () => {
    const startBlock = source.slice(source.indexOf("    start()"), source.indexOf("    stop()"));
    const stopBlock = source.slice(source.indexOf("    stop()"));

    assert.match(source, /let pluginLifecycleGeneration = 0/);
    assert.match(startBlock, /const lifecycleGeneration = \+\+pluginLifecycleGeneration/);
    assert.match(startBlock, /const isLifecycleCurrent = \(\) => lifecycleGeneration === pluginLifecycleGeneration/);
    assert.match(startBlock, /if \(isLifecycleCurrent\(\) && settings\.store\.onboardingCompleted !== true\) openPluginOnboarding\(\)/);
    assert.match(source, /function schedulePluginUpdateStatusObservation\(lifecycleGeneration: number\)/);
    assert.match(source, /const statusRequest = readPluginUpdateStatus\(\);\n\s+if \(!statusRequest\) \{[\s\S]*?statusRequest\.then\(status => \{\n\s+if \(lifecycleGeneration !== pluginLifecycleGeneration\) return;/);
    assert.match(startBlock, /schedulePluginUpdateStatusObservation\(lifecycleGeneration\)/);
    assert.match(startBlock, /Native\.enable\(\)\.then\(result => \{\n\s+if \(!isLifecycleCurrent\(\)\) return;/);
    assert.match(source, /if \(lifecycleGeneration === pluginLifecycleGeneration\) logger\.error\("Falha ao consultar atualização pendente do plugin"/);
    assert.match(startBlock, /if \(isLifecycleCurrent\(\)\) logger\.error\("Failed to reach the desktop process"/);
    assert.match(stopBlock, /pluginLifecycleGeneration\+\+/);
    assert.match(stopBlock, /lastNotifiedUpdateErrorKey = null/);
    assert.match(stopBlock, /lastSuppressedUpdateErrorKey = null/);
});

console.log("plugin lifecycle source tests: 4/4");
