import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { isCompatiblePluginManifest, isOfficialPluginManifest, releaseAssetUrl, securePluginUpdateUrl } from "../goLiveBypass/update-security.ts";

const source = readFileSync(new URL("../goLiveBypass/index.tsx", import.meta.url), "utf8");
const nativeSource = readFileSync(new URL("../goLiveBypass/native.ts", import.meta.url), "utf8");
const controllerSource = readFileSync(new URL("../goLiveBypass/vpn-controller.ts", import.meta.url), "utf8");

test("update pendente usa toast customizado no rodape", () => {
  assert.match(source, /Toasts\.Type\.CUSTOM/);
  assert.match(source, /Toasts\.Position\.BOTTOM/);
  assert.match(source, /component:\s*<PluginUpdateToast/);
  assert.match(source, /duration:\s*15_000/);
  assert.match(source, /role="status"/);
});

test("overlay oferece adiamento e reload explicito", () => {
  assert.match(source, />Depois<\/Button>/);
  assert.match(source, />Recarregar Discord<\/Button>/);
  assert.match(source, /restartDiscord/);
  assert.doesNotMatch(source, /window\.location\.reload\(\)/);
  assert.match(source, /O Discord não será reiniciado sozinho/);
  assert.match(nativeSource, /export function restartDiscord/);
  assert.match(nativeSource, /controller\.restartDiscord\(\)/);
  assert.match(controllerSource, /app\.relaunch\(\)/);
  assert.match(controllerSource, /state !== "blocked_external"/);
  assert.match(controllerSource, /preservou o WireSock externo/);
});

test("overlay exibe versao atual, disponivel e canal", () => {
  const toast = source.slice(source.indexOf("function PluginUpdateToast"), source.indexOf("function notifyPendingPluginUpdate"));
  assert.match(toast, /Atual: v\{currentVersion\}/);
  assert.match(toast, /disponível: v\{availableVersion\}/);
  assert.match(toast, /Canal: \{channel\}/);
  assert.match(source, /notifyPendingPluginUpdate\(next\.current, next\.pendingVersion, next\.pendingChannel \|\| next\.channel\)/);
});

test("a notificacao continua deduplicada por versao", () => {
  assert.match(source, /version === lastNotifiedPendingVersion/);
  assert.match(source, /lastNotifiedPendingVersion = version/);
});

test("o adiamento do aviso persiste por versao e expira", () => {
  assert.match(source, /PLUGIN_UPDATE_DEFER_MS/);
  assert.match(source, /updateDeferredVersion/);
  assert.match(source, /updateDeferredUntil/);
  assert.match(source, /dismissPluginUpdateToast\(availableVersion\)/);
  assert.match(source, /lastNotifiedPendingVersion = null/);
  assert.match(source, /deferredVersion === version/);
  assert.match(source, /deferredUntil > Date\.now\(\)/);
});

test("o caminho de notificacao nao chama encerramento automatico", () => {
  const notifyBlock = source.slice(source.indexOf("function notifyPendingPluginUpdate"), source.indexOf("interface RegionSelectProps"));
  assert.doesNotMatch(notifyBlock, /app\.(quit|relaunch)|Native\.(shutdown|enable)/);
});

test("updater restringe metadata e artefatos ao GitHub oficial", () => {
  assert.match(nativeSource, /securePluginUpdateUrl/);
  assert.match(nativeSource, /releaseAssetUrl/);
  assert.match(nativeSource, /isCompatiblePluginManifest\(manifest, PLUGIN_ASSET\)/);
  assert.match(source, /checkPluginUpdate\(selectedUpdatePolicy\)/);
  assert.match(source, /updatePlugin\(selectedUpdatePolicy\)/);
  const asset = "https://github.com/bezumiya/GoLiveBypass/releases/download/v2.0.6-beta-3/goLiveBypass-vencord.zip";
  assert.equal(releaseAssetUrl(asset), asset);
  assert.equal(releaseAssetUrl("https://evil.example/releases/download/v2.0.6/goLiveBypass-vencord.zip"), null);
  assert.equal(releaseAssetUrl("https://github.com.evil/releases/download/v2.0.6/goLiveBypass-vencord.zip"), null);
  assert.equal(releaseAssetUrl("https://attacker.github.com/releases/download/v2.0.6/goLiveBypass-vencord.zip"), null);
  assert.equal(releaseAssetUrl("https://github.com/other/repo/releases/download/v2.0.6/goLiveBypass-vencord.zip"), null);
  assert.equal(releaseAssetUrl("https://github.com/bezumiya/GoLiveBypass/releases/download/v2.0.6/%2e%2e/evil.zip"), null);
  assert.throws(() => securePluginUpdateUrl("http://github.com/bezumiya/GoLiveBypass/releases/download/v2.0.6/a.zip"), /HTTPS/);
  assert.throws(() => securePluginUpdateUrl("https://evil.example/update.zip"), /host fora/);
  assert.throws(() => securePluginUpdateUrl("https://user:pass@github.com/update.zip"), /credenciais/);
  assert.throws(() => securePluginUpdateUrl("https://github.com:444/update.zip"), /porta/);
  const officialManifest = {
    name: "GoLiveBypass",
    updater: { type: "github", id: "bezumiya/GoLiveBypass", assetName: "goLiveBypass-vencord.zip" },
  };
  assert.equal(isOfficialPluginManifest(officialManifest, "goLiveBypass-vencord.zip"), true);
  assert.equal(isOfficialPluginManifest({ ...officialManifest, updater: { ...officialManifest.updater, id: "pdl-clay/GoLiveBypass" } }, "goLiveBypass-vencord.zip"), false);
  const inherited = Object.create({ name: "GoLiveBypass", version: "2.0.5", updater: { type: "github", id: "pdl-clay/GoLiveBypass", assetName: "goLiveBypass-vencord.zip" } });
  assert.equal(isCompatiblePluginManifest(inherited, "goLiveBypass-vencord.zip"), false);
  const legacyReleaseManifest = {
    ...officialManifest,
    version: "2.0.5",
    updater: { ...officialManifest.updater, id: "pdl-clay/GoLiveBypass" },
  };
  assert.equal(isCompatiblePluginManifest(legacyReleaseManifest, "goLiveBypass-vencord.zip"), true);
  assert.equal(isCompatiblePluginManifest({ ...legacyReleaseManifest, version: "2.0.6-beta-6" }, "goLiveBypass-vencord.zip"), false);
  assert.equal(isOfficialPluginManifest({ ...officialManifest, updater: { ...officialManifest.updater, assetName: "other.zip" } }, "goLiveBypass-vencord.zip"), false);
  assert.equal(
    securePluginUpdateUrl("https://release-assets.githubusercontent.com/release.zip"),
    "https://release-assets.githubusercontent.com/release.zip",
  );
  assert.equal(
    securePluginUpdateUrl("release.zip", "https://github.com/bezumiya/GoLiveBypass/releases/download/v2.0.6/"),
    "https://github.com/bezumiya/GoLiveBypass/releases/download/v2.0.6/release.zip",
  );
});

test("voos nativos não misturam canais e recusam instalações concorrentes", () => {
  assert.match(nativeSource, /type PluginUpdateFlight</);
  assert.match(nativeSource, /pluginUpdateCheckFlight\?\.policyKey === policyKey/);
  assert.match(nativeSource, /pluginUpdateFlight\.policyKey === policyKey/);
  assert.match(nativeSource, /já existe uma atualização do outro canal em andamento/);
});

test("checagem automática limpa erro antigo quando o canal se recupera", () => {
  const automaticBlock = nativeSource.slice(nativeSource.indexOf("async function automaticPluginUpdate"), nativeSource.indexOf("export function configurePluginUpdates"));
  assert.match(nativeSource, /let pluginUpdatePolicyRevision = 0/);
  assert.match(nativeSource, /function setPluginUpdateLastError\(/);
  assert.match(nativeSource, /revision !== pluginUpdatePolicyRevision/);
  assert.match(automaticBlock, /setPluginUpdateLastError\(policy, revision, null\)/);
  assert.match(automaticBlock, /setPluginUpdateLastError\(policy, revision, update\.ok \? null : update\.error\)/);
});

test("falha automática usa overlay contextual e deduplicado", () => {
  assert.match(source, /function PluginUpdateFailureToast/);
  const toast = source.slice(source.indexOf("function PluginUpdateFailureToast"), source.indexOf("function notifyPluginUpdateFailure"));
  assert.match(toast, /role="status"/);
  assert.match(toast, /aria-live="polite"/);
  assert.match(toast, /currentVersion/);
  assert.match(toast, /channel/);
  assert.match(toast, /error\.slice\(0, 240\)/);
  assert.match(toast, />Depois<\/Button>/);
  assert.match(source, /let lastNotifiedUpdateErrorKey: string \| null = null/);
  const notifyBlock = source.slice(source.indexOf("function notifyPluginUpdateFailure"), source.indexOf("interface RegionSelectProps"));
  assert.match(notifyBlock, /if \(context\.key === lastNotifiedUpdateErrorKey\) return/);
  assert.match(notifyBlock, /lastNotifiedUpdateErrorKey = context\.key/);
  assert.doesNotMatch(notifyBlock, /restartDiscord|Native\.(enable|shutdown)|app\.(quit|relaunch)|process\.kill/);
  assert.match(source, /notifyPluginUpdateFailure\(next\.current, next\.channel, next\.lastError\)/);
  assert.match(source, /notifyPluginUpdateFailure\(status\.current, status\.channel, status\.lastError\)/);
  assert.match(source, /lastNotifiedUpdateErrorKey = null/);
});

test("falha manual não duplica o overlay automático", () => {
  assert.match(source, /let lastSuppressedUpdateErrorKey: string \| null = null/);
  assert.match(source, /function pluginUpdateErrorContext/);
  assert.match(source, /function suppressPluginUpdateFailure/);
  const notifyBlock = source.slice(source.indexOf("function notifyPluginUpdateFailure"), source.indexOf("function notifyPendingPluginUpdate"));
  assert.match(notifyBlock, /if \(context\.key === lastSuppressedUpdateErrorKey\) \{[\s\S]*?lastSuppressedUpdateErrorKey = null;[\s\S]*?return;/);
  const checkBlock = source.slice(source.indexOf("const check = async"), source.indexOf("useEffect\(\(\) =>", source.indexOf("const check = async")));
  assert.match(checkBlock, /suppressPluginUpdateFailure\(result\.current, result\.channel \|\| selectedUpdatePolicy\.channel/);
  assert.match(checkBlock, /const currentVersion = status\?\.current \|\| PLUGIN_VERSION/);
  assert.match(checkBlock, /suppressPluginUpdateFailure\(currentVersion, status\?\.channel \|\| selectedUpdatePolicy\.channel/);
  const updateBlock = source.slice(source.indexOf("const update = async"), source.indexOf("const channelLabel", source.indexOf("const update = async")));
  assert.match(updateBlock, /failureContext = \{ current: result\.current, channel: result\.channel \|\| selectedUpdatePolicy\.channel/);
  assert.match(updateBlock, /suppressPluginUpdateFailure\(failureContext\.current, failureContext\.channel, failureContext\.detail/);
  assert.match(updateBlock, /const currentVersion = failureContext\?\.current \|\| status\?\.current \|\| PLUGIN_VERSION/);
  assert.match(updateBlock, /failureContext\?\.channel \|\| status\?\.channel \|\| selectedUpdatePolicy\.channel/);
});

test("commit do update revalida a política antes de tocar no plugin", () => {
  assert.match(nativeSource, /function assertCurrentPluginUpdatePolicy\(policy: PluginUpdatePolicy, revision: number\)/);
  assert.match(nativeSource, /assertCurrentPluginUpdatePolicy\(policy, revision\);\n\s+const \{ projectRoot, target \} = userpluginSource\(\)/);
  assert.match(nativeSource, /assertCurrentPluginUpdatePolicy\(policy, revision\);\n\s+renameSync\(extracted\.source, target\)/);
  assert.match(nativeSource, /revision: number;/);
  assert.match(nativeSource, /pluginUpdateFlight\.revision === revision/);
});

test("o status reporta a versão em execução enquanto o checkout aguarda reload", () => {
  assert.match(nativeSource, /const UNKNOWN_PLUGIN_VERSION = "unknown"/);
  assert.match(nativeSource, /let pluginRuntimeVersion = UNKNOWN_PLUGIN_VERSION/);
  assert.match(nativeSource, /const installedVersion = currentPluginVersion\(\);/);
  assert.match(nativeSource, /pending = reconcileReachedPendingUpdate\(installedVersion, pendingInspection\)/);
  const statusBlock = nativeSource.slice(nativeSource.indexOf("export function getPluginUpdateStatus"), nativeSource.indexOf("export async function checkPluginUpdate"));
  assert.match(statusBlock, /current: pluginRuntimeVersion/);
});

test("overlay fora da configuração continua observando falhas e updates", () => {
  const observer = source.slice(source.indexOf("function schedulePluginUpdateStatusObservation"), source.indexOf("interface RegionSelectProps"));
  assert.match(observer, /updateCheckTimer = setTimeout\(observe, 8_000\)/);
  assert.match(observer, /const statusRequest = readPluginUpdateStatus\(\)/);
  assert.match(observer, /statusRequest\.then\(status =>/);
  assert.match(observer, /\.finally\(scheduleNext\)/);
  assert.match(observer, /notifyPluginUpdateFailure\(status\.current, status\.channel, status\.lastError\)/);
  assert.match(observer, /pluginUpdateStatusMatchesRendererPolicy\(status\)/);
  assert.match(observer, /lastSuppressedUpdateErrorKey = null/);
  assert.match(source, /schedulePluginUpdateStatusObservation\(lifecycleGeneration\)/);
});

test("erro de consulta obsoleto não altera a supressão global", () => {
  const checkCatch = source.slice(source.indexOf("        } catch (error) {", source.indexOf("const check = async")), source.indexOf("        } finally {", source.indexOf("const check = async")));
  assert.match(checkCatch, /if \(isOperationMounted\(\)\) \{/);
  assert.match(checkCatch, /suppressPluginUpdateFailure/);
});

console.log("plugin update notification source tests: 15/15");
