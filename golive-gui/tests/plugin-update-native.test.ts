import fs from "node:fs";
import ts from "typescript";
import path from "node:path";
import { describe, expect, it } from "vitest";

const native = fs.readFileSync(
  path.resolve(process.cwd(), "..", "goLiveBypass", "native.ts"),
  "utf8",
);
const updateSecurity = fs.readFileSync(
  path.resolve(process.cwd(), "..", "goLiveBypass", "update-security.ts"),
  "utf8",
);

function updateBlock(): string {
  const start = native.indexOf("async function performPluginUpdate");
  const end = native.indexOf('app.on("before-quit"');
  if (start < 0 || end < 0) throw new Error("bloco do updater nativo ausente");
  return native.slice(start, end);
}

describe("updater nativo do plugin", () => {
  it("consulta a coleção de releases e seleciona pelo canal", () => {
    expect(native).toContain("/repos/bezumiya/GoLiveBypass/releases?per_page=20");
    expect(native).not.toContain("/repos/pdl-clay/GoLiveBypass/releases/latest");
    expect(native).toContain("choosePluginRelease(candidates, currentVersion, channel)");
    expect(native).toContain("if (release.draft === true");
    expect(native).toContain("release.prerelease === true");
    expect(native).toContain('name === PLUGIN_ASSET');
    expect(native).toContain('name === PLUGIN_CHECKSUM_ASSET');
  });

  it("aplica limites e validações de transporte e artefato", () => {
    expect(updateSecurity).toContain('parsed.protocol !== "https:"');
    expect(native).toContain("securePluginUpdateUrl");
    expect(native).toContain("PLUGIN_MAX_REDIRECTS");
    expect(native).toContain("PLUGIN_UPDATE_TIMEOUT_MS");
    expect(native).toContain("PLUGIN_API_MAX_BYTES");
    expect(native).toContain("PLUGIN_ARCHIVE_MAX_BYTES");
    expect(native).toContain('createHash("sha256")');
    expect(native).toContain("SHA-256 do plugin não confere");
    expect(native).toContain("manifest do plugin não corresponde ao release");
    expect(native).toContain("validateArchiveEntries");
    expect(native).toContain("validateExtractedTree");
    expect(native).toContain('archive do plugin contém link simbólico');
    expect(native).toMatch(/try \{\s+void downloadBytes\(response\.headers\.location/);
  });

  it("persiste um marcador privado e informa que o reload ainda é necessário", () => {
    expect(native).toContain('const PENDING_UPDATE_FILE = "plugin-update-pending.json"');
    expect(native).toContain("validPendingUpdate");
    expect(native).toContain("writePendingUpdate");
    expect(native).toContain("backupName");
    expect(native).toContain("reloadRequired: true");
    expect(native).toContain("pending: true");
    expect(native).toContain("reconcileReachedPendingUpdate");
    expect(native).toContain("sourceDigest");
    expect(native).toContain("pendingChannel");
  });

  it("grava journal antes da troca, adia o build para o boot e recupera um update interrompido", () => {
    const start = native.indexOf("async function performPluginUpdateLocked");
    const end = native.indexOf("function runPluginUpdate(policy", start);
    const block = native.slice(start, end);
    // A sessão só baixa, valida e registra: trocar a árvore ou compilar aqui travava
    // a thread principal do Discord por até USERPLUGIN_BUILD_TIMEOUT_MS.
    expect(block).toContain('phase: "staged"');
    expect(block).toContain("stagedPath: extracted.source");
    expect(block).not.toContain("renameSync(target, backup)");
    expect(block).not.toContain("rebuildUserplugin(");

    // A troca e o build acontecem no boot, com o journal já gravado antes do rename.
    const applyStart = native.indexOf("async function applyStagedPluginUpdate");
    const applyEnd = native.indexOf("async function recoverInterruptedPluginUpdate", applyStart);
    expect(applyStart).toBeGreaterThanOrEqual(0);
    const apply = native.slice(applyStart, applyEnd);
    expect(apply.indexOf('phase: "preparing"')).toBeGreaterThanOrEqual(0);
    expect(apply.indexOf("renameSync(target, backup)")).toBeGreaterThan(apply.indexOf('phase: "preparing"'));
    expect(apply.indexOf("await rebuildUserplugin(projectRoot)")).toBeGreaterThan(apply.indexOf("renameSync(target, backup)"));
    expect(apply.indexOf('phase: "prepared"')).toBeGreaterThan(apply.indexOf("await rebuildUserplugin(projectRoot)"));

    expect(native).toContain("async function recoverPendingUpdateInternal(options: { allowStaged?: boolean }): Promise<void>");
    expect(native).toContain('if (pending.phase === "staged")');
    expect(native).toContain("update interrompido deixou a árvore nova sem backup");
  });

  it("não bloqueia a thread principal do Discord com build ou extração", () => {
    // Nenhuma etapa do updater pode voltar para a variante síncrona: o build roda
    // dentro do processo principal do cliente e um `execFileSync` ali congela a
    // janela inteira (relato beta: "congela e fecha").
    expect(native).toContain("await execFileAsync(build.command, build.args, { cwd: projectRoot, env, timeoutMs: USERPLUGIN_BUILD_TIMEOUT_MS })");
    expect(native).toContain('await execFileAsync("unzip"');
    expect(native).toContain('await execFileAsync("tar"');
    expect(native).toContain("async function rebuildUserplugin(projectRoot: string): Promise<void>");
    expect(native).toContain("async function extractAndValidatePlugin");
    expect(native).not.toMatch(/execFileSync\(\s*build\.command/);
    const remainingSync = [...native.matchAll(/execFileSync\(\s*"([a-z.]+)"/g)].map(match => match[1]);
    expect(remainingSync).toEqual(["tasklist"]);
  });

  it("aplica o download adiado só na abertura do cliente", () => {
    // Enquanto a sessão roda, painel/configuração/checagem chamam a recuperação. Se
    // qualquer uma delas promovesse o staging, o plugin seria recompilado dentro do
    // cliente em uso (relato beta) e a promoção podia cruzar com a própria checagem.
    const calls = native.match(/recoverInterruptedPluginUpdate\((?:\{[^}]*\})?\)/g) ?? [];
    expect(calls.filter(call => call.includes("allowStaged: true")).length).toBe(1);
    expect(calls.length).toBe(5);
    const boot = native.slice(native.indexOf("app.whenReady().then(async () => {"), native.indexOf("pluginRuntimeVersion = currentPluginVersion();"));
    expect(boot).toContain("recoverInterruptedPluginUpdate({ allowStaged: true })");
    expect(native).toContain('if (pending.phase === "staged" && !options.allowStaged) return;');
  });

  it("serializa a recuperação para não atropelar a mesma árvore", () => {
    expect(native).toContain("let pluginUpdateRecoveryFlight: Promise<void> | null = null;");
    expect(native).toContain("if (pluginUpdateRecoveryFlight) return pluginUpdateRecoveryFlight;");
    // O rollback nunca apaga a árvore promovida sem o backup em mãos.
    const apply = native.slice(native.indexOf("async function applyStagedPluginUpdate"), native.indexOf("async function recoverInterruptedPluginUpdate"));
    expect(apply).toContain("if (existsSync(backup)) {\n                if (existsSync(target)) rmSync(target, { recursive: true, force: true });");
  });

  it("reconhece o download adiado como pendente e o descarta sem mexer na árvore", () => {
    const inspection = native.slice(native.indexOf("function inspectPendingUpdate"), native.indexOf("function trustedPendingResultState"));
    expect(inspection).toContain('if (pending.phase === "staged")');
    expect(inspection).toContain("stagedPluginSourcePath(projectRoot, pending)");
    const discard = native.slice(native.indexOf("async function discardPendingBetaForStable"), native.indexOf("function releaseInfo"));
    expect(discard).toContain('if (pending.phase === "staged")');
    expect(discard).toContain("cleanupStagedWork(projectRoot, staged)");
    expect(discard.indexOf("cleanupStagedWork(projectRoot, staged)")).toBeLessThan(discard.indexOf("const displacedName"));
  });

  it("serializa updates entre processos", () => {
    expect(native).toContain('const UPDATE_LOCK_FILE = "plugin-update.lock"');
    expect(native).toContain('openSync(path, "wx"');
    expect(native).toContain("process.kill(pid, 0)");
    expect(native).toContain("function releasePluginUpdateLock");
    expect(native).toMatch(/async function performPluginUpdate\([\s\S]*?acquirePluginUpdateLock\(\)[\s\S]*?releasePluginUpdateLock/);
  });

  it("extrai no mesmo volume do checkout", () => {
    expect(native).toContain('const UPDATE_STAGING_DIR = ".golivebypass-update-staging"');
    expect(native).toContain("extractAndValidatePlugin(zip, release, sourceAtStart.projectRoot)");
    expect(native).toContain("join(projectRoot, UPDATE_STAGING_DIR)");
  });

  it("jornaliza o rollback do beta", () => {
    expect(native).toContain('const displacedName = `goLiveBypass-pending-${Date.now()}`');
    expect(native).toContain('writePendingUpdate({ ...pending, phase: "rolling-back", displacedName })');
    expect(native).toContain('if (pending.phase === "rolling-back")');
    expect(native).toContain("function safeDisplacedPath");
  });

  it("trata concorrência, ciclo automático e rollback de beta ao voltar para stable", () => {
    expect(native).toContain("pluginUpdateCheckFlight");
    expect(native).toContain("pluginUpdateFlight");
    expect(native).toContain("PLUGIN_UPDATE_INITIAL_DELAY_MS = 8_000");
    expect(native).toContain("PLUGIN_UPDATE_INTERVAL_MS = 60 * 60 * 1000");
    expect(native).toContain("discardPendingBetaForStable");
    expect(native).toContain("update beta pendente descartado ao selecionar stable");
    expect(native).toContain("rebuildUserplugin(projectRoot)");
    expect(native).toContain("falha ao restaurar o build anterior");
    expect(native).toContain("pluginUpdatePolicy.channel === policy.channel");
  });

  it("não reinicia o Discord no fluxo de update e preserva enable/shutdown da VPN", () => {
    const block = updateBlock();
    expect(block).not.toMatch(/app\.(quit|relaunch)\s*\(/);
    expect(native).toMatch(/export function enable\([^)]*IpcMainInvokeEvent[^)]*\)/);
    expect(native).toMatch(/export function shutdown\([^)]*IpcMainInvokeEvent[^)]*\)/);
    expect(native).toContain("export async function configurePluginUpdates");
    expect(native).toContain("export async function getPluginUpdateStatus");
    expect(native).toMatch(/export (?:async )?function checkPluginUpdate/);
    expect(native).toMatch(/export (?:async )?function updatePlugin/);
  });

  it("preserva evidência quando o backup beta não está disponível", () => {
    const start = native.indexOf("function discardPendingBetaForStable");
    const end = native.indexOf("function releaseInfo", start);
    const block = native.slice(start, end);
    const missingBackup = block.slice(block.indexOf("if (!existsSync(backup))"), block.indexOf("const currentManifest"));
    expect(missingBackup).toContain("backup do beta pendente não foi encontrado");
    expect(missingBackup).not.toContain("clearPendingUpdate");
  });

  it("não usa fallback enganoso quando a fonte instalada é inválida", () => {
    expect(native).toContain('const UNKNOWN_PLUGIN_VERSION = "unknown"');
    expect(native).toContain("catch { return normalizePluginVersion(PLUGIN_VERSION) ?? UNKNOWN_PLUGIN_VERSION; }");
    expect(native).toContain("validatePluginSourceTree(target)");
  });
});

describe("diagnóstico da recuperação de update interrompido", () => {
  it("mantém a mensagem do erro no log do plugin", () => {
    const fonte = native.match(/export function describeUpdateRecoveryError\(error: unknown\): string \{[\s\S]*?\n\}/)?.[0];
    expect(fonte).toBeTruthy();
    const js = ts.transpileModule(fonte!.replace("export ", ""), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const descrever = new Function(`${js}\nreturn describeUpdateRecoveryError;`)() as (error: unknown) => string;
    expect(descrever(new Error("wireSockInstallFailure: 502"))).toBe("wireSockInstallFailure: 502");
    expect(descrever({ message: "sem permissão" })).toBe("sem permissão");
  });
});
