// Atualizacao automatica via GitHub Releases.
//
// Windows: o target e portable, e o electron-updater nao suporta portable (so NSIS).
// Entao o update do Windows e proprio: o pulso SSE apenas acorda a consulta; a API do
// GitHub continua sendo a fonte de releases, assets e digests. O exe e baixado, conferido
// e fica pendente ate o usuario pedir o reinicio.
//
// Linux: o autoUpdater do electron-updater cuida do AppImage. O pulso tambem so acorda a
// consulta nativa; o download continua sujeito ao canal e a verificacao do updater.

import { app, dialog, BrowserWindow } from "electron";
import {
  createWriteStream,
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { createHash } from "crypto";
import { rm } from "fs/promises";
import { tmpdir } from "os";
import { basename, join, resolve, sep } from "path";
import { autoUpdater } from "electron-updater";
import { request } from "https";
import { cleanupOldExe, spawnWindowsUpdateHelper } from "./updater-replace";
import { compararVersoes, escolherRelease, type Canal, type ReleaseCandidata } from "./updater-channel";
import {
  createUpdatePulseClient,
  UPDATE_STREAM_URL,
  type UpdatePulseClient,
  type UpdatePulseEvent,
} from "./update-pulse";

// O fork pdl-clay e o canal de distribuicao desta linha de testes/releases.
// O updater e o publisher precisam apontar para o mesmo repositorio: consultar o
// upstream aqui faria o app detectar uma versao que nunca conseguiria baixar do
// fork (ou ignorar completamente a release beta criada para os testadores).
const REPO = "pdl-clay/GoLiveBypass";
const EXE_PREFIX = "GoLiveBypass-";
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // fallback de seguranca: uma vez por hora
const CHECK_MIN_INTERVAL_MS = 60_000;
const PUSH_RETRY_DELAYS_MS = [30_000, 120_000] as const;

type PendingWindowsUpdate = {
  current: string;
  downloaded: string;
  tag: string;
  version: string;
  digest: string;
  prerelease: boolean;
};

export type UpdaterController = {
  setEnabled(enabled: boolean): void;
  setChannel(canal: Canal): void;
  hasPendingUpdate(): boolean;
  applyPendingUpdate(): Promise<boolean>;
};

let lastCheckAt = 0;
let checking = false;
let linuxChecking = false;
let updateReady = false;
let pendingWindowsUpdate: PendingWindowsUpdate | null = null;
let quittingForUpdate = false;
let stateChangeListener: () => void = () => {};
let applyPendingUpdateImpl: () => Promise<boolean> = async () => false;
let updatePulse: UpdatePulseClient | null = null;
let lastPulseDeliveryId: string | null = null;
const pendingPulseRetries = new Set<ReturnType<typeof setTimeout>>();

function notifyStateChange(): void {
  try {
    stateChangeListener();
  } catch (error) {
    console.warn("[updater] falha ao atualizar o estado visual:", error);
  }
}

function setUpdateReady(ready: boolean): void {
  if (updateReady === ready) return;
  updateReady = ready;
  notifyStateChange();
}

export function isUpdateReady(): boolean {
  return updateReady;
}

export function applyPendingUpdate(): Promise<boolean> {
  return applyPendingUpdateImpl();
}

// ------------------------------------------------------------------ GitHub API

// Lista as releases recentes (20 dao e sobram: a escolha e por VERSAO, nao por
// ordem). A API publica nao devolve drafts; devolve prereleases — que o canal
// estavel filtra e o canal beta consome (regras no updater-channel.ts).
function githubReleases(): Promise<ReleaseCandidata[]> {
  return new Promise((resolve) => {
    console.log(`[updater] consultando releases do fork ${REPO}`);
    const req = request(
      {
        host: "api.github.com",
        path: `/repos/${REPO}/releases?per_page=20`,
        method: "GET",
        headers: { "User-Agent": "GoLiveBypass", Accept: "application/vnd.github+json" },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          console.warn(`[updater] consulta de releases falhou: HTTP ${res.statusCode ?? "desconhecido"}`);
          return resolve([]);
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          body += c;
          if (body.length > 2_000_000) req.destroy(new Error("resposta de releases grande demais"));
        });
        res.on("error", (error) => {
          console.warn("[updater] leitura das releases falhou:", error);
          resolve([]);
        });
        res.on("end", () => {
          try {
            const data = JSON.parse(body) as Array<Record<string, unknown>>;
            const releases: ReleaseCandidata[] = [];
            for (const item of data) {
              if (item.draft === true) continue;
              const assets = (item.assets || []) as Array<{
                name: string;
                browser_download_url?: string;
                digest?: string;
              }>;
              const asset = assets.find(
                (a) =>
                  typeof a?.name === "string" &&
                  a.name.startsWith(EXE_PREFIX) &&
                  a.name.endsWith(".exe"),
              );
              if (!asset || !asset.browser_download_url) continue;
              releases.push({
                tag: String(item.tag_name),
                url: asset.browser_download_url,
                digest: typeof asset.digest === "string" ? asset.digest : null,
                prerelease: item.prerelease === true,
              });
            }
            console.log(`[updater] releases com executavel encontradas: ${releases.length}`);
            resolve(releases);
          } catch {
            console.warn("[updater] resposta de releases invalida");
            resolve([]);
          }
        });
      },
    );
    req.on("error", (error) => {
      console.warn("[updater] consulta de releases falhou:", error);
      resolve([]);
    });
    req.setTimeout(15_000, () => req.destroy(new Error("timeout consultando releases")));
    req.end();
  });
}

// O browser_download_url do GitHub sempre responde 302 para release-assets.githubusercontent.com,
// e o request do Node nao segue redirecionamento sozinho. Sem isto o download do Windows falhava
// em toda tentativa: o app achava a versao nova e nunca conseguia baixar.
const MAX_REDIRECTS = 5;

function downloadFile(url: string, dest: string, hops = MAX_REDIRECTS): Promise<void> {
  return new Promise((resolveDownload, reject) => {
    // So https: um redirecionamento para http rebaixaria a conexao em silencio, e o que vem por
    // ela substitui o executavel em uso.
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return reject(new Error("URL de download invalida"));
    }
    if (parsedUrl.protocol !== "https:") {
      return reject(new Error("recusando destino que nao e https: " + url));
    }
    console.log(`[updater] iniciando download pelo host ${parsedUrl.hostname}`);

    const req = request(url, { headers: { "User-Agent": "GoLiveBypass" } }, (res) => {
      const { statusCode, headers } = res;
      res.on("error", reject);

      if (statusCode !== undefined && statusCode >= 300 && statusCode < 400 && headers.location) {
        res.resume();
        if (hops <= 0) return reject(new Error("redirecionamentos demais"));
        let redirecionada: string;
        try {
          redirecionada = new URL(headers.location, url).toString();
        } catch {
          return reject(new Error("redirecionamento de download invalido"));
        }
        console.log(`[updater] seguindo redirecionamento para ${new URL(redirecionada).hostname}`);
        return downloadFile(redirecionada, dest, hops - 1).then(resolveDownload, reject);
      }

      if (statusCode !== 200) {
        res.resume();
        return reject(new Error("download falhou: HTTP " + statusCode));
      }

      let bytes = 0;
      res.on("data", (chunk: Buffer) => { bytes += chunk.length; });
      const out = createWriteStream(dest);
      res.pipe(out);
      // Aguarda o fechamento do descritor, nao apenas o evento finish. Isso evita
      // ler o arquivo enquanto o ultimo flush ainda esta terminando no Windows.
      out.on("close", () => {
        console.log(`[updater] download concluido: ${bytes} bytes`);
        resolveDownload();
      });
      out.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(15_000, () => req.destroy(new Error("timeout baixando update")));
    req.end();
  });
}

// A API do GitHub devolve o digest do anexo na mesma resposta autenticada por TLS de onde sai a
// URL. Conferir aqui deixa o Windows no mesmo nivel de Linux e macOS, que ganham a checagem de
// graca pelo electron-updater.
function digestMatches(file: string, digest: string | null): boolean {
  if (digest === null) {
    console.warn("[updater] anexo sem digest na API; nao vou instalar sem conferir.");
    return false;
  }

  const [algo, esperado] = digest.split(":", 2);
  if (algo !== "sha256" || esperado === undefined || !/^[0-9a-f]{64}$/i.test(esperado)) return false;

  try {
    const obtido = createHash(algo).update(readFileSync(file)).digest("hex");
    if (obtido === esperado) return true;

    console.error(`[updater] ${algo} nao confere: esperado ${esperado}, obtido ${obtido}`);
    return false;
  } catch (error) {
    console.error("[updater] falhei ao conferir o digest:", error);
    return false;
  }
}

// ------------------------------------------------------------------ Windows portable

function portableExePath(): string | null {
  // O electron-builder portable define esta variavel com o caminho do exe em uso.
  const current = process.env.PORTABLE_EXECUTABLE_FILE;
  return current && current.trim() !== "" ? current : null;
}

function pendingWindowsFile(): string | null {
  try {
    return join(app.getPath("userData"), "pending-windows-update.json");
  } catch {
    return null;
  }
}

function isSafePendingDownload(file: string): boolean {
  const absolute = resolve(file);
  const tempRoot = resolve(tmpdir());
  return (
    absolute.startsWith(`${tempRoot}${sep}`) &&
    basename(absolute).startsWith("GoLiveBypass-update-") &&
    basename(absolute).endsWith(".exe")
  );
}

function clearPendingMarker(): void {
  const marker = pendingWindowsFile();
  if (!marker) return;
  try {
    unlinkSync(marker);
  } catch {
    // O arquivo pode nao existir ou o antivirus pode segura-lo; a proxima inicializacao tenta.
  }
}

function persistPendingWindowsUpdate(pending: PendingWindowsUpdate): boolean {
  const marker = pendingWindowsFile();
  if (!marker) return false;
  const temporary = `${marker}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, JSON.stringify(pending), "utf8");
    renameSync(temporary, marker);
    return true;
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // best effort
    }
    console.error("[updater] nao consegui guardar update pendente:", error);
    return false;
  }
}

function parsePendingWindowsUpdate(value: unknown): PendingWindowsUpdate | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (
    typeof item.current !== "string" ||
    typeof item.downloaded !== "string" ||
    typeof item.tag !== "string" ||
    typeof item.version !== "string" ||
    typeof item.digest !== "string" ||
    typeof item.prerelease !== "boolean"
  ) {
    return null;
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(item.version)) return null;
  if (!/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(item.tag)) return null;
  if (!/^sha256:[0-9a-f]{64}$/i.test(item.digest) || !isSafePendingDownload(item.downloaded)) return null;
  if (item.version !== item.tag.replace(/^v/, "") || item.prerelease !== item.tag.includes("-")) return null;
  return {
    current: item.current,
    downloaded: item.downloaded,
    tag: item.tag,
    version: item.version,
    digest: item.digest,
    prerelease: item.prerelease,
  };
}

function loadPendingWindowsUpdate(canal: Canal): void {
  const marker = pendingWindowsFile();
  const current = portableExePath();
  if (!marker || !current || !existsSync(marker)) return;

  let pending: PendingWindowsUpdate | null = null;
  try {
    pending = parsePendingWindowsUpdate(JSON.parse(readFileSync(marker, "utf8")));
  } catch {
    pending = null;
  }

  const valid =
    pending !== null &&
    pending.current === current &&
    existsSync(pending.downloaded) &&
    digestMatches(pending.downloaded, pending.digest) &&
    compararVersoes(pending.version, app.getVersion()) > 0 &&
    (canal === "beta" || !pending.prerelease);

  if (pending === null || !valid) {
    if (pending && isSafePendingDownload(pending.downloaded)) void rm(pending.downloaded, { force: true });
    clearPendingMarker();
    return;
  }

  pendingWindowsUpdate = pending;
  setUpdateReady(true);
  console.log(`[updater] update pendente recuperado: ${pending.version}`);
}

async function discardPendingWindowsUpdate(): Promise<void> {
  const pending = pendingWindowsUpdate;
  pendingWindowsUpdate = null;
  setUpdateReady(false);
  clearPendingMarker();
  if (pending && isSafePendingDownload(pending.downloaded)) {
    await rm(pending.downloaded, { force: true }).catch(() => {});
  }
}

async function downloadWindowsPortable(
  candidate: ReleaseCandidata,
  current: string,
): Promise<PendingWindowsUpdate | null> {
  if (!candidate.url || !candidate.digest) {
    console.error("[updater] candidata sem URL ou digest; nao vou preparar o update");
    return null;
  }

  // Um nome por processo evita reaproveitar um parcial deixado por outra copia
  // portable ou por uma tentativa interrompida.
  const downloaded = join(tmpdir(), `GoLiveBypass-update-${process.pid}.exe`);
  try {
    await downloadFile(candidate.url, downloaded);
  } catch (error) {
    await rm(downloaded, { force: true }).catch(() => {});
    console.error("[updater] download falhou:", error);
    return null;
  }

  // Conferido antes de encostar no exe em uso: o helper so recebe um arquivo que bate
  // com o digest publicado; um arquivo invalido e apagado e a versao atual continua.
  if (!digestMatches(downloaded, candidate.digest)) {
    console.error("[updater] digest do executavel baixado nao confere");
    await rm(downloaded, { force: true }).catch(() => {});
    return null;
  }

  const pending: PendingWindowsUpdate = {
    current,
    downloaded,
    tag: candidate.tag,
    version: candidate.tag.replace(/^v/, ""),
    digest: candidate.digest,
    prerelease: candidate.prerelease,
  };
  if (!persistPendingWindowsUpdate(pending)) {
    await rm(downloaded, { force: true }).catch(() => {});
    return null;
  }
  return pending;
}

// O main process consulta esta flag no before-quit: quando o auto-update esta
// aplicando, o quit nao pode ser segurado (senao o app antigo fica vivo e o
// novo morre no lock de instancia unica — o "fecha mas nao abre").
export function markQuittingForUpdate() {
  quittingForUpdate = true;
}
export function isQuittingForUpdate() {
  return quittingForUpdate;
}

function unmarkQuittingForUpdate(): void {
  quittingForUpdate = false;
}

async function installPendingWindowsUpdate(): Promise<boolean> {
  const pending = pendingWindowsUpdate;
  if (!pending) return false;

  // O arquivo fica pendente por tempo indeterminado. Reconfere caminho, existencia e
  // digest no instante da troca para que uma alteracao local depois do download nunca
  // seja entregue ao helper externo.
  const current = portableExePath();
  if (
    !current ||
    current !== pending.current ||
    !existsSync(pending.downloaded) ||
    !digestMatches(pending.downloaded, pending.digest)
  ) {
    await discardPendingWindowsUpdate();
    console.error("[updater] update pendente foi alterado ou ficou invalido");
    return false;
  }

  // O Windows nao permite renomear o exe que ainda esta em execucao. O helper faz a
  // troca somente depois que este processo sair; se ele nao puder ser agendado,
  // mantem o app aberto e permite uma nova tentativa.
  if (!spawnWindowsUpdateHelper(pending.current, pending.downloaded)) {
    console.error("[updater] nao consegui agendar a troca do exe portable.");
    return false;
  }

  markQuittingForUpdate();
  console.log("[updater] helper de relancamento agendado; encerrando processo atual");
  app.quit();
  return true;
}

async function installPendingLinuxUpdate(): Promise<boolean> {
  try {
    markQuittingForUpdate();
    autoUpdater.quitAndInstall();
    return true;
  } catch (error) {
    unmarkQuittingForUpdate();
    console.error("[updater] nao consegui reiniciar para aplicar o update:", error);
    return false;
  }
}

async function showUpdateFailure(getMainWindow: () => BrowserWindow | null, version: string): Promise<void> {
  const aviso = {
    type: "warning" as const,
    title: "Falha na atualização",
    message: `Não foi possível preparar o GoLiveBypass ${version}.`,
    detail:
      "A versão atual continua funcionando. Tente de novo mais tarde, ou baixe a versão nova manualmente em github.com/pdl-clay/GoLiveBypass/releases.",
    buttons: ["OK"],
  };
  const win = getMainWindow();
  if (win) await dialog.showMessageBox(win, aviso);
  else await dialog.showMessageBox(aviso);
}

async function askToInstallWindowsUpdate(
  getMainWindow: () => BrowserWindow | null,
  pending: PendingWindowsUpdate,
): Promise<void> {
  const win = getMainWindow();
  // Sem janela (app minimizado para a bandeja), o update fica pendente e aparece
  // na propria bandeja. Assim o pulso nunca derruba uma sessao em andamento.
  if (!win) return;

  const choice = (await dialog.showMessageBox(win, {
    type: "info",
    title: "Atualização disponível",
    message: `GoLiveBypass ${pending.version}${pending.prerelease ? " (beta)" : ""} foi baixado.`,
    detail: pending.prerelease
      ? "A versão de teste está pronta. Reiniciar agora para aplicar? O app reabre sozinho."
      : "A atualização está pronta. Reiniciar agora para aplicar? O app reabre sozinho.",
    buttons: ["Reiniciar agora", "Depois"],
    defaultId: 0,
    cancelId: 1,
  })).response;

  if (choice === 0) {
    const ok = await installPendingWindowsUpdate();
    if (!ok) await showUpdateFailure(getMainWindow, pending.version);
  }
}

// ------------------------------------------------------------------ pulso + consultas

function handleUpdatePulse(
  event: UpdatePulseEvent,
  getMainWindow: () => BrowserWindow | null,
  isAutoUpdateEnabled: () => boolean,
  canalAtual: () => Canal,
): void {
  if (event.deliveryId === lastPulseDeliveryId) return;
  lastPulseDeliveryId = event.deliveryId;
  if (!isAutoUpdateEnabled()) return;

  console.log(`[updater] pulso recebido: ${event.tag} (beta=${event.prerelease})`);
  const check = () => {
    if (process.platform === "win32") {
      void checkWindowsUpdate(getMainWindow, isAutoUpdateEnabled, canalAtual, {
        force: true,
        reason: "webhook",
      });
    } else {
      void checkLinuxUpdate(isAutoUpdateEnabled, canalAtual, "webhook");
    }
  };

  check();
  // O GitHub pode levar alguns segundos para propagar o asset depois do webhook.
  // As duas retentativas fecham essa janela sem transformar o fallback horario em
  // uma espera desnecessaria.
  for (const delay of PUSH_RETRY_DELAYS_MS) {
    const timer = setTimeout(() => {
      pendingPulseRetries.delete(timer);
      check();
    }, delay);
    pendingPulseRetries.add(timer);
  }
}

function stopUpdatePulse(): void {
  updatePulse?.stop();
  for (const timer of pendingPulseRetries) clearTimeout(timer);
  pendingPulseRetries.clear();
}

async function checkLinuxUpdate(
  isAutoUpdateEnabled: () => boolean,
  canalAtual: () => Canal,
  reason: string,
): Promise<void> {
  if (linuxChecking || updateReady || !isAutoUpdateEnabled()) return;
  linuxChecking = true;
  try {
    autoUpdater.allowPrerelease = canalAtual() === "beta";
    console.log(`[updater] verificando canal Linux (${reason})`);
    await autoUpdater.checkForUpdatesAndNotify();
  } catch (error) {
    console.warn("[updater] consulta Linux falhou:", error);
  } finally {
    linuxChecking = false;
  }
}

// ------------------------------------------------------------------ API publica

export function setupUpdater(
  getMainWindow: () => BrowserWindow | null,
  isAutoUpdateEnabled: () => boolean = () => true,
  canalAtual: () => Canal = () => "stable",
  onStateChange: () => void = () => {},
): UpdaterController | null {
  stateChangeListener = onStateChange;

  const isDev = !app.isPackaged;
  if (isDev) {
    console.log("[updater] desenvolvimento: checagem de atualizacoes desativada.");
    return null;
  }

  // Em desenvolvimento nao existe um AppImage/portable que possa receber update. Forcar
  // electron-updater a usar dev-app-update.yml faria o npm run dev consultar uma release
  // com a versao local e registrar um 404 ruidoso no terminal.

  // macOS fica de fora por enquanto. O MacUpdater exige app assinado com Developer ID, e o
  // certificado ainda nao existe (os secrets CSC_LINK/CSC_KEY_PASSWORD nao estao configurados).
  if (process.platform === "darwin") {
    console.log("[updater] macOS: auto-update desligado ate o app ser assinado.");
    return null;
  }

  const apply = process.platform === "win32" ? installPendingWindowsUpdate : installPendingLinuxUpdate;
  applyPendingUpdateImpl = apply;

  const controller: UpdaterController = {
    setEnabled(enabled) {
      if (enabled) {
        updatePulse?.start();
        if (process.platform === "win32") {
          void checkWindowsUpdate(getMainWindow, isAutoUpdateEnabled, canalAtual, {
            force: true,
            reason: "preferencia-ligada",
          });
        } else {
          void checkLinuxUpdate(isAutoUpdateEnabled, canalAtual, "preferencia-ligada");
        }
      } else {
        stopUpdatePulse();
      }
    },
    setChannel(canal) {
      if (process.platform === "win32" && pendingWindowsUpdate?.prerelease && canal === "stable") {
        void discardPendingWindowsUpdate();
      }
      if (!isAutoUpdateEnabled()) return;
      updatePulse?.start();
      if (process.platform === "win32") {
        void checkWindowsUpdate(getMainWindow, isAutoUpdateEnabled, canalAtual, {
          force: true,
          reason: "canal-alterado",
        });
      } else {
        void checkLinuxUpdate(isAutoUpdateEnabled, canalAtual, "canal-alterado");
      }
    },
    hasPendingUpdate: () => updateReady,
    applyPendingUpdate,
  };

  if (process.platform !== "win32") {
    // Linux: updater nativo do AppImage, com download diferencial.
    autoUpdater.autoDownload = true;
    // O usuario escolhe quando reiniciar. Sem esta trava, o electron-updater
    // instalaria silenciosamente no proximo quit depois de escolher "Depois".
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.logger = console;

    autoUpdater.on("update-downloaded", async (info) => {
      if (!isAutoUpdateEnabled() || updateReady) return;
      setUpdateReady(true);
      const win = getMainWindow();
      // showMessageBox assincrono: o sincrono bloquearia a thread JS do processo principal
      // ate a pessoa clicar — inclusive watchdogs e timers de rede.
      const choice = win
        ? (await dialog.showMessageBox(win, {
            type: "info",
            title: "Atualização disponível",
            message: `GoLiveBypass ${info.version} foi baixada.`,
            detail: "Reiniciar agora para aplicar a atualização? O app fecha e reabre sozinho.",
            buttons: ["Reiniciar agora", "Depois"],
            defaultId: 0,
            cancelId: 1,
          })).response
        : 1;

      if (choice === 0 && !isDev) {
        const ok = await installPendingLinuxUpdate();
        if (!ok) await showUpdateFailure(getMainWindow, info.version);
      }
    });

    updatePulse = createUpdatePulseClient({
      url: UPDATE_STREAM_URL,
      onRelease: (event) => handleUpdatePulse(event, getMainWindow, isAutoUpdateEnabled, canalAtual),
    });
    setInterval(
      () => void checkLinuxUpdate(isAutoUpdateEnabled, canalAtual, "fallback-horario"),
      CHECK_INTERVAL_MS,
    );
    if (isAutoUpdateEnabled()) {
      updatePulse.start();
      void checkLinuxUpdate(isAutoUpdateEnabled, canalAtual, "inicializacao");
    }
    return controller;
  }

  // Windows portable: checagem periodica em background.
  // Sobra de um update anterior: o ".old" de ontem nao roda mais, entao agora e a
  // hora de apagar (no momento da troca ele ainda estava em execucao).
  const atual = portableExePath();
  if (atual !== null) cleanupOldExe(atual);
  loadPendingWindowsUpdate(canalAtual());
  setInterval(
    () => void checkWindowsUpdate(getMainWindow, isAutoUpdateEnabled, canalAtual, {
      reason: "fallback-horario",
    }),
    CHECK_INTERVAL_MS,
  );
  updatePulse = createUpdatePulseClient({
    url: UPDATE_STREAM_URL,
    onRelease: (event) => handleUpdatePulse(event, getMainWindow, isAutoUpdateEnabled, canalAtual),
  });
  if (isAutoUpdateEnabled()) {
    updatePulse.start();
    void checkWindowsUpdate(getMainWindow, isAutoUpdateEnabled, canalAtual, { reason: "inicializacao" });
  }
  return controller;
}

type WindowsCheckOptions = {
  force?: boolean;
  reason?: string;
};

export async function checkWindowsUpdate(
  getMainWindow: () => BrowserWindow | null,
  isAutoUpdateEnabled: () => boolean = () => true,
  canalAtual: () => Canal = () => "stable",
  options: WindowsCheckOptions = {},
): Promise<void> {
  if (checking || updateReady) return;
  if (!isAutoUpdateEnabled()) return;
  if (!options.force && Date.now() - lastCheckAt < CHECK_MIN_INTERVAL_MS) return;
  checking = true;
  lastCheckAt = Date.now();

  try {
    const canal = canalAtual();
    console.log(`[updater] verificando versao ${app.getVersion()} no canal ${canal} (${options.reason ?? "manual"})`);
    const releases = await githubReleases();
    const escolhida = escolherRelease(releases, app.getVersion(), canal);
    if (escolhida === null) {
      console.log("[updater] nenhuma versao mais nova disponivel");
      return;
    }

    const latest = escolhida.tag.replace(/^v/, "");
    const ehBeta = escolhida.prerelease;
    console.log(`[updater] candidata ${latest} encontrada (beta=${ehBeta} digest=${escolhida.digest !== null})`);

    // O pulso torna possivel baixar logo, mas nao instala nada sem digest nem troca
    // de processo sem a confirmacao do usuario. A escolha fica retida na bandeja.
    const atual = portableExePath();
    if (!atual) {
      console.warn("[updater] PORTABLE_EXECUTABLE_FILE nao definido; pulando update.");
      return;
    }
    const pending = await downloadWindowsPortable(escolhida, atual);
    if (!pending) {
      await showUpdateFailure(getMainWindow, latest);
      return;
    }

    // Se o usuario trocou de beta para stable durante o download, nao deixa a
    // candidata beta escapar para a bandeja nem para o helper.
    if (canalAtual() === "stable" && pending.prerelease) {
      if (isSafePendingDownload(pending.downloaded)) await rm(pending.downloaded, { force: true }).catch(() => {});
      clearPendingMarker();
      return;
    }

    pendingWindowsUpdate = pending;
    setUpdateReady(true);
    await askToInstallWindowsUpdate(getMainWindow, pending);
  } finally {
    checking = false;
  }
}
