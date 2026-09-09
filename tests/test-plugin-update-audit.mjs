import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const nativeSource = readFileSync(new URL("../goLiveBypass/native.ts", import.meta.url), "utf8");
const channelSource = readFileSync(new URL("../goLiveBypass/update-channel.ts", import.meta.url), "utf8");
const securitySource = readFileSync(new URL("../goLiveBypass/update-security.ts", import.meta.url), "utf8");
const workflowSource = readFileSync(new URL("../.github/workflows/build-gui.yml", import.meta.url), "utf8");

test("a versão usada pelo updater acompanha o manifest reescrito no asset", () => {
    const nativeFallback = nativeSource.match(/const PLUGIN_VERSION = "([^"]+)"/)?.[1];
    assert.equal(nativeFallback, "2.0.0-beta.1");
    assert.match(workflowSource, /sed -i .*manifest\.json/);
    assert.doesNotMatch(workflowSource, /native\.ts/);
    assert.match(nativeSource, /function readInstalledPluginVersion\(/);
    assert.match(nativeSource, /function currentPluginVersion\(/);
    assert.match(nativeSource, /readInstalledPluginVersion\(userpluginSource\(\)\.target\)/);
    assert.match(nativeSource, /releaseInfo\(policy\.channel, currentVersion, signal\)/);
    assert.doesNotMatch(nativeSource, /return choosePluginRelease\(candidates, PLUGIN_VERSION, channel\)/);
});

test("o asset precisa conter arquivos-fonte e helper compatíveis", () => {
    const requiredFiles = [
        "index.tsx",
        "native.ts",
        "update-channel.ts",
        "update-security.ts",
        "stability.ts",
        "vpn-controller.ts",
        "vpn-proton.ts",
        "vpn-types.ts",
        "vpn-windows.ts",
        "manifest.json",
        "bin/win32-x64/proton-confgen.exe",
    ];
    assert.match(nativeSource, /const REQUIRED_PLUGIN_FILES = \[/);
    for (const file of requiredFiles) assert.match(nativeSource, new RegExp(JSON.stringify(file).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(nativeSource, /function validatePluginSourceTree\(/);
    assert.match(nativeSource, /validatePluginSourceTree\(source\)/);
    assert.match(nativeSource, /statSync\(candidate\)/);
});

test("a substituição revalida a origem local depois do download", () => {
    const updateBlock = nativeSource.slice(nativeSource.indexOf("async function performPluginUpdateLocked(policy"), nativeSource.indexOf("function runPluginUpdate(policy"));
    assert.match(updateBlock, /const sourceAtStart = userpluginSource\(\)/);
    assert.match(updateBlock, /const currentVersion = readInstalledPluginVersion\(sourceAtStart\.target\)/);
    assert.match(updateBlock, /const sourceAtCommit = \{ projectRoot, target \}/);
    assert.match(updateBlock, /readInstalledPluginVersion\(sourceAtCommit\.target\)/);
    assert.match(updateBlock, /versão local do plugin mudou durante o download/);
    assert.match(updateBlock, /assertCurrentPluginUpdatePolicy\(policy, revision\);[\s\S]*sourceAtCommit/);
});

test("o journal é gravado antes da troca e recupera um checkout interrompido", () => {
    const updateBlock = nativeSource.slice(nativeSource.indexOf("async function performPluginUpdateLocked(policy"), nativeSource.indexOf("function runPluginUpdate(policy"));
    const intent = updateBlock.indexOf('phase: "preparing"');
    const move = updateBlock.indexOf("renameSync(target, backup)");
    const prepared = updateBlock.indexOf('phase: "prepared"');
    assert.ok(intent >= 0 && move > intent, "a intenção precisa preceder o primeiro rename");
    assert.ok(prepared > move, "o estado preparado só pode vir depois da troca");
    assert.match(nativeSource, /type PendingPluginUpdatePhase = "preparing" \| "prepared" \| "rolling-back"/);
    assert.match(nativeSource, /function recoverInterruptedPluginUpdate\(/);
    assert.match(nativeSource, /if \(hasBackup\)[\s\S]*renameSync\(backup, target\)[\s\S]*rebuildUserplugin\(projectRoot\)/);
    assert.match(nativeSource, /update interrompido deixou a árvore nova sem backup/);
});

test("o updater usa lock persistente entre processos e recupera locks órfãos", () => {
    assert.match(nativeSource, /const UPDATE_LOCK_FILE = "plugin-update\.lock"/);
    assert.match(nativeSource, /function acquirePluginUpdateLock\(\)/);
    assert.match(nativeSource, /openSync\(path, "wx"/);
    assert.match(nativeSource, /process\.kill\(pid, 0\)/);
    assert.match(nativeSource, /já existe uma atualização do plugin em outro processo/);
    assert.match(nativeSource, /function releasePluginUpdateLock\(/);
    const wrapper = nativeSource.slice(nativeSource.indexOf("async function performPluginUpdate(policy"), nativeSource.indexOf("function runPluginUpdate(policy"));
    assert.match(wrapper, /acquirePluginUpdateLock\(\)[\s\S]*recoverInterruptedPluginUpdate\(\)[\s\S]*releasePluginUpdateLock/);
});

test("o rollback beta também deixa journal para sobreviver a uma queda", () => {
    const stableBlock = nativeSource.slice(nativeSource.indexOf("function discardPendingBetaForStable"), nativeSource.indexOf("function releaseInfo"));
    assert.match(nativeSource, /SAFE_DISPLACED_NAME/);
    assert.match(nativeSource, /function safeDisplacedPath\(/);
    assert.match(stableBlock, /const displacedName = `goLiveBypass-pending-\$\{Date\.now\(\)\}`/);
    assert.match(stableBlock, /writePendingUpdate\(\{ \.\.\.pending, phase: "rolling-back", displacedName \}\)/);
    assert.match(nativeSource, /if \(pending\.phase === "rolling-back"\)/);
    assert.match(nativeSource, /rollback interrompido recuperado para a versão estável/);
});

test("o staging do archive usa o mesmo volume do checkout", () => {
    assert.match(nativeSource, /const UPDATE_STAGING_DIR = "\.golivebypass-update-staging"/);
    assert.match(nativeSource, /function extractAndValidatePlugin\(zip: Buffer, release: PluginReleaseCandidate, projectRoot\?: string\)/);
    assert.match(nativeSource, /const parent = projectRoot \? join\(projectRoot, UPDATE_STAGING_DIR\) : tmpdir\(\)/);
    assert.match(nativeSource, /extractAndValidatePlugin\(zip, release, sourceAtStart\.projectRoot\)/);
});

test("a fonte instalada também precisa provar a identidade oficial", () => {
    const sourceBlock = nativeSource.slice(nativeSource.indexOf("function userpluginSource"), nativeSource.indexOf("function resolveWindowsPnpm"));
    const versionBlock = nativeSource.slice(nativeSource.indexOf("function readInstalledPluginVersion"), nativeSource.indexOf("function currentPluginVersion"));
    assert.match(sourceBlock, /isCompatiblePluginManifest\(manifest, PLUGIN_ASSET\)/);
    assert.match(versionBlock, /const manifest = readManifest\(target\)/);
    assert.doesNotMatch(sourceBlock, /manifest\.name === "GoLiveBypass"/);
});

test("um preparo no checkout não é confundido com reload do processo corrente", () => {
    const reconcileBlock = nativeSource.slice(nativeSource.indexOf("function reconcileReachedPendingUpdate"), nativeSource.indexOf("function discardPendingBetaForStable"));
    assert.match(nativeSource, /const UNKNOWN_PLUGIN_VERSION = "unknown"/);
    assert.match(nativeSource, /let pluginRuntimeVersion = UNKNOWN_PLUGIN_VERSION/);
    assert.match(nativeSource, /pluginRuntimeVersion = currentPluginVersion\(\)/);
    assert.match(reconcileBlock, /compareUpdateVersion\(pluginRuntimeVersion, pending\.version\) < 0\) return pending/);
    assert.match(nativeSource, /current: pluginRuntimeVersion/);
});

test("reconfiguração idêntica preserva o voo, mas mudança real aborta downloads antigos", () => {
    const configureBlock = nativeSource.slice(nativeSource.indexOf("export function configurePluginUpdates"), nativeSource.indexOf("export function getPluginUpdateStatus"));
    assert.match(configureBlock, /if \(changed\) \{[\s\S]*pluginUpdatePolicyRevision\+\+[\s\S]*pluginUpdateCheckFlight\?\.controller\.abort\(\)[\s\S]*pluginUpdateFlight\?\.controller\.abort\(\)/);
    assert.doesNotMatch(configureBlock.slice(0, configureBlock.indexOf("if (changed) {")), /pluginUpdatePolicyRevision\+\+/);
});

test("downloads e inspeção do arquivo têm cancelamento e prazo absoluto", () => {
    assert.match(nativeSource, /type PluginUpdateDownloadOptions = \{/);
    assert.match(nativeSource, /const deadlineAt = options\.deadlineAt \?\? Date\.now\(\) \+ PLUGIN_UPDATE_TIMEOUT_MS/);
    assert.match(nativeSource, /setTimeout\(\(\) => abortRequest\("update request timed out"\), remaining\)/);
    assert.match(nativeSource, /options\.signal\?\.addEventListener\("abort", onAbort/);
    assert.match(nativeSource, /deadlineAt \}/);
    assert.match(nativeSource, /timeout: PLUGIN_UPDATE_TIMEOUT_MS/);
    assert.match(nativeSource, /try \{\n\s+void downloadBytes\(response\.headers\.location/);
    assert.match(nativeSource, /catch \(error\) \{\n\s+rejectOnce\(error\);\n\s+\}/);
    assert.match(nativeSource, /controller\.abort\(\);\n        throw error;/);
});

test("rollback beta preserva o backup estável se a recompilação falhar", () => {
    const stableBlock = nativeSource.slice(nativeSource.indexOf("function discardPendingBetaForStable"), nativeSource.indexOf("function releaseInfo"));
    assert.match(stableBlock, /let stableMoved = false/);
    assert.match(stableBlock, /stableMoved = true/);
    assert.match(stableBlock, /if \(stableMoved && existsSync\(target\) && !existsSync\(backup\)\) renameSync\(target, backup\)/);
    const catchBlock = stableBlock.slice(stableBlock.indexOf("} catch (error) {"), stableBlock.indexOf("    try \{ rmSync\(displaced"));
    assert.doesNotMatch(catchBlock, /rmSync\(target, \{ recursive: true, force: true \}\)/);
});

test("falha de limpeza temporária não transforma preparo confirmado em erro", () => {
    const updateBlock = nativeSource.slice(nativeSource.indexOf("async function performPluginUpdateLocked(policy"), nativeSource.indexOf("function runPluginUpdate(policy"));
    assert.match(nativeSource, /function cleanupExtractedWork\(/);
    assert.match(updateBlock, /cleanupExtractedWork\(extracted\.work\)/);
    assert.match(nativeSource, /catch \(error\) \{\n        cleanupExtractedWork\(work\);\n        throw error;/);
    assert.match(nativeSource, /não consegui limpar os temporários do update/);
});

test("backup beta ausente preserva o marcador para recuperação posterior", () => {
    const stableBlock = nativeSource.slice(nativeSource.indexOf("function discardPendingBetaForStable"), nativeSource.indexOf("function releaseInfo"));
    const missingBackupBlock = stableBlock.slice(stableBlock.indexOf("if (!existsSync(backup))"), stableBlock.indexOf("const currentManifest"));
    assert.match(missingBackupBlock, /if \(!existsSync\(backup\)\) \{\s*throw new Error\("backup do beta pendente não foi encontrado"\);/);
    assert.doesNotMatch(missingBackupBlock, /clearPendingUpdate/);
});

test("marcador legado é preservado fora do slot ativo sem bloquear nova preparação", () => {
    const legacyStart = nativeSource.indexOf("if (typeof sourceDigest !== \"string\")");
    const legacyBlock = nativeSource.slice(legacyStart, nativeSource.indexOf("\n    try {", legacyStart));
    assert.match(nativeSource, /function quarantineLegacyPendingUpdate\(pending: PendingPluginUpdate\)/);
    assert.match(legacyBlock, /quarantineLegacyPendingUpdate\(pending\)/);
    assert.match(legacyBlock, /return \{ pending: null, trusted: null, error: null \}/);
    assert.doesNotMatch(legacyBlock, /clearPendingUpdate|rmSync/);
});

test("marcador novo prova a árvore preparada e legado exige nova preparação", () => {
    assert.match(nativeSource, /sourceDigest\?: string/);
    assert.match(nativeSource, /function hashPluginSourceTree\(/);
    assert.match(nativeSource, /sourceDigest: hashPluginSourceTree\(source\)/);
    assert.match(nativeSource, /const actualDigest = hashPluginSourceTree\(target\)/);
    assert.match(nativeSource, /actualDigest !== sourceDigest/);
    assert.match(nativeSource, /marcador de update pendente legado sem prova da árvore preparada/);
    assert.match(nativeSource, /a árvore preparada mudou durante a recompilação/);
});

test("canal pendente é exposto separadamente do canal selecionado", () => {
    assert.match(nativeSource, /pendingChannel\?: PluginUpdateChannel/);
    assert.match(nativeSource, /pendingChannel: pending\.channel/);
    assert.match(nativeSource, /pendingChannel: pending\?\.channel/);
    assert.match(nativeSource, /pendingChannel: policy\.channel/);
});

test("observações e finally antigos não sobrevivem à troca de política", () => {
    const configureBlock = nativeSource.slice(nativeSource.indexOf("export function configurePluginUpdates"), nativeSource.indexOf("export function getPluginUpdateStatus"));
    assert.match(configureBlock, /pluginUpdateLastCheckedAt = null/);
    assert.match(configureBlock, /pluginUpdateLastError = null/);
    assert.match(nativeSource, /if \(revision === pluginUpdatePolicyRevision && policyKey === updatePolicyKey\(pluginUpdatePolicy\)\)\s*pluginUpdateLastCheckedAt = Date\.now\(\)/);
    assert.match(nativeSource, /setPluginUpdateLastError\(policy: PluginUpdatePolicy, revision: number/);
    assert.match(nativeSource, /revision !== pluginUpdatePolicyRevision/);
});

test("fonte instalada inválida vira versão desconhecida, sem fallback beta", () => {
    const installedBlock = nativeSource.slice(nativeSource.indexOf("function readInstalledPluginVersion"), nativeSource.indexOf("function currentPluginVersion"));
    const currentBlock = nativeSource.slice(nativeSource.indexOf("function currentPluginVersion"), nativeSource.indexOf("function userpluginSource"));
    assert.match(installedBlock, /validatePluginSourceTree\(target\)/);
    assert.match(currentBlock, /catch \{ return UNKNOWN_PLUGIN_VERSION; \}/);
    assert.doesNotMatch(currentBlock, /return PLUGIN_VERSION/);
});

test("os módulos de canal e origem continuam ligados ao repositório oficial", () => {
    assert.match(channelSource, /export function choosePluginRelease/);
    assert.match(channelSource, /channel === "stable" && isPrerelease/);
    assert.match(channelSource, /compareParsedPluginVersions\(version, currentVersion\) <= 0/);
    assert.match(securitySource, /const OFFICIAL_UPDATE_REPOSITORY = "bezumiya\/GoLiveBypass"/);
    assert.match(securitySource, /metadata\.id === OFFICIAL_UPDATE_REPOSITORY/);
    assert.match(nativeSource, /releaseAssetUrl\(/);
    assert.match(nativeSource, /isCompatiblePluginManifest\(manifest, PLUGIN_ASSET\)/);
    assert.match(securitySource, /LEGACY_RELEASE_MANIFEST/);
});

console.log("plugin update audit source tests: 20/20");
