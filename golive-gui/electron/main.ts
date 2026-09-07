import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Tray,
  shell,
  clipboard,
} from "electron";
import path, { dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { homedir, EOL } from "os";
import fs from "fs";
import { createHash, randomUUID } from "crypto";
import { execFileSync, execSync, spawn, spawnSync } from "child_process";
import { runScript } from "./linux-helper";
import {
  applyPendingUpdate,
  isQuittingForUpdate,
  isUpdateReady,
  setupUpdater,
  type UpdaterController,
} from "./updater";
import * as logger from "./logger";
import * as discordscan from "./discordscan";
import * as logsDir from "./logsDir";
import { submitBugReport } from "./bugreport";
import { ensureWireSockInstalled, getWireSockConnectionStatus, getWireSockConnectionStatusAsync, getWireSockAdapterTraffic, getWireSockAdapterTrafficAsync, hasWireSockAdapterTrafficIncrease, isWireSockActive, isWireSockActiveAsync, startWireSockService, switchWireSockService, recoverWireSockNetwork, type WireSockConnectionStatus } from "./wiresock";
import { classifyWgReadiness, getWgStats, getWgStatsAsync, iniciarWgStatsWatchdog, pararWgStatsWatchdog, type WgTunnelStats } from "./wgstats";
import { classifyFailoverHealth, FailoverHealthTracker, FAILOVER_ROUTE_TIMEOUT_MS, FAILOVER_SAMPLE_INTERVAL_MS, routeCandidateUsable, routePoolDirectory, readRoutePoolManifest, makeRoutePoolManifest, routePoolMatches, ROUTE_POOL_RESERVE_COUNT, ROUTE_POOL_TOTAL, safeRoutePoolPath, writeRoutePoolManifest, type ProtonRouteMetadata, type ProtonRoutePoolManifest } from "./route-failover";
import { validateWgConfContent } from "./wg-validator";
import * as proton from "./proton";
import { ProtonOptimizationCoordinator } from "./proton-optimization";
import { findWindowsDiscordInstall } from "./windows-discord-install";
import { waitForProcessRunning, waitForProcessStopped, type ProcessProbeState } from "./wait-condition";
import { TUNNEL_STARTUP_SETTLE_MS, waitForTunnelStartupSettle } from "./tunnel-startup";
import { linuxPreflightRepairable, parseLinuxPreflight, linuxPreflightMessage, type LinuxPreflight } from "./linux-preflight";
import { classifyLinuxHealth } from "./linux-health";
import { PROTON_CAPTCHA_IPC_CHANNEL, isAllowedProtonCaptchaNavigation, parseProtonCaptchaChallenge, validateProtonCaptchaResponse } from "./proton-captcha";
import { observeRouteDiagnostic } from "./route-diagnostics";
import { decideRouteProof, maskedIP, type RouteProbeResult } from "./route-proof";
import { prepareDiscordScopeProbes } from "./discord-scope-proof";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const isMac = process.platform === "darwin";
const IS_LINUX = process.platform === "linux";
const IS_WINDOWS = process.platform === "win32";
const MAIN_WINDOW_WIDTH = 720;

// Parar, resetar o lock e instalar outro perfil mexe no mesmo servico/driver
// global. Uma fila unica impede que clique, bandeja e troca Proton criem duas
// instancias ou que uma validacao aprove a rede enquanto outra ainda a desmonta.
let wireSockLifecycleQueue: Promise<void> = Promise.resolve();
const protonOptimizations = new ProtonOptimizationCoordinator();
const PROTON_PLAN_CACHE_TTL_MS = 15 * 60 * 1000;
type ProtonPlanCacheEntry = {
  username: string;
  generation: number;
  expiresAt: number;
  result?: proton.ProtonPlanResult;
  inFlight?: Promise<proton.ProtonPlanResult>;
};
let protonPlanCache: ProtonPlanCacheEntry | null = null;
let protonPlanGeneration = 0;

function normalizeProtonPlanUsername(username: string): string {
  return username.trim().toLocaleLowerCase("en-US");
}

function unknownProtonPlan(error = "Não foi possível confirmar o plano Proton."): proton.ProtonPlanResult {
  return { success: false, status: "unknown", error };
}

function invalidateProtonPlanCache() {
  protonPlanGeneration += 1;
  protonPlanCache = null;
}

function applyProtonPlanPreference(username: string, result: proton.ProtonPlanResult) {
  const settings = readSharedSettings() as any;
  if (normalizeProtonPlanUsername(String(settings.protonUsername || "")) !== username) return;
  const freeOnly = result.status !== "premium";
  if (settings.protonFreeOnly !== freeOnly) {
    updateSharedSettings({ protonFreeOnly: freeOnly });
  }
}

async function resolveProtonPlan(username: string, force = false): Promise<proton.ProtonPlanResult> {
  const normalized = normalizeProtonPlanUsername(username);
  if (!normalized) return unknownProtonPlan("Sessão Proton não encontrada.");

  const now = Date.now();
  const cached = protonPlanCache;
  if (cached && cached.username === normalized && cached.generation === protonPlanGeneration && cached.inFlight) {
    return cached.inFlight;
  }
  if (!force && cached && cached.username === normalized && cached.generation === protonPlanGeneration && cached.result && cached.expiresAt > now) {
    applyProtonPlanPreference(normalized, cached.result);
    return cached.result;
  }

  const generation = protonPlanGeneration;
  const entry: ProtonPlanCacheEntry = {
    username: normalized,
    generation,
    expiresAt: 0,
  };
  const request = proton.getProtonPlan(settingsDir(), username).catch(() => unknownProtonPlan());
  entry.inFlight = request;
  protonPlanCache = entry;
  const result = await request;

  // A login/logout/account switch can make this response stale while the API
  // request is in flight. Never publish its tier into the new account's state.
  if (generation !== protonPlanGeneration || protonPlanCache !== entry) {
    return unknownProtonPlan("A sessão Proton mudou durante a verificação.");
  }
  entry.result = result;
  entry.expiresAt = Date.now() + PROTON_PLAN_CACHE_TTL_MS;
  entry.inFlight = undefined;
  applyProtonPlanPreference(normalized, result);
  return result;
}
type WindowsRouteState = "inactive" | "preparing" | "active" | "failed" | "recovery_required";
let windowsRouteStarted = false;
let windowsRouteState: WindowsRouteState = "inactive";
let windowsRouteGeneration = 0;
let windowsRouteWatchdogTimer: ReturnType<typeof setInterval> | null = null;
let windowsRouteWatchdogInFlight = false;

// Failover automatico e separado dos watchdogs diagnosticos: ele observa apenas
// a saude do peer WireGuard e so troca depois de falha sustentada. O pool local
// nunca e usado para custom/Premium e nao compartilha estado com o plugin.
let protonFailoverTimer: ReturnType<typeof setInterval> | null = null;
let protonFailoverInFlight = false;
let protonFailoverInFlightGeneration = 0;
let protonFailoverGeneration = 0;
let protonFailoverTracker: FailoverHealthTracker | null = null;
let protonFailoverPreviousAdapterTraffic: ReturnType<typeof getWireSockAdapterTraffic> = null;
let protonFailoverDisabled = false;
let protonRoutePoolBuild: Promise<void> | null = null;
let protonRoutePoolAbort: AbortController | null = null;
function withWireSockLifecycle<T>(operation: string, task: () => Promise<T>): Promise<T> {
  const run = wireSockLifecycleQueue.then(async () => {
    logger.info("wiresock", "inicio de operacao serializada", { operation });
    try {
      return await task();
    } finally {
      logger.info("wiresock", "fim de operacao serializada", { operation });
    }
  });
  wireSockLifecycleQueue = run.then(() => undefined, () => undefined);
  return run;
}

function beginWindowsRouteOperation(state: WindowsRouteState = "preparing"): number {
  windowsRouteGeneration += 1;
  windowsRouteStarted = false;
  windowsRouteState = state;
  refreshWindowStatus();
  return windowsRouteGeneration;
}

function assertWindowsRouteGeneration(generation: number) {
  if (generation !== windowsRouteGeneration || quitting) {
    throw new Error("A validação da rota foi cancelada por uma operação mais recente.");
  }
}

// Cores da barra de titulo (Windows, titleBarOverlay) — casam com os tokens
// --canvas e --ink do renderer em cada tema.
const TITLEBAR = {
  light: { color: "#F7F6F3", symbolColor: "#2F3437" },
  dark: { color: "#0F0F12", symbolColor: "#E6E6EA" },
};
// Tema padrao: dark (o renderer tambem usa dark como fallback).
let theme: "light" | "dark" = "dark";

function applyTitlebarTheme() {
  if (!mainWindow || mainWindow.isDestroyed() || isMac) return;
  mainWindow.setTitleBarOverlay(TITLEBAR[theme]);
}

// No Linux com Wayland, o Chromium tenta inicializar Vulkan e o processo GPU cai com
// "'--ozone-platform=wayland' is not compatible with Vulkan" (wayland_surface_factory.cc).
// A janela abre, mas o renderer fica preso em "Verificando..." para sempre (o getStatus
// via IPC nunca responde). Desligar a aceleracao de hardware (SwiftShader no lugar) resolve
// — e este app e uma janela fixa de 720px, nao precisa de GPU. Vale para X11 tambem.
if (IS_LINUX) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
}

// O fs do Electron trata *.asar como pasta. original-fs e o disco de verdade, o mesmo
// que o instalador do Vencord usa para renomear o app.asar.
const diskFs: typeof fs = (() => {
  try {
    return createRequire(import.meta.url)("original-fs");
  } catch {
    return fs;
  }
})();

const FLAVOURS = ["Discord", "DiscordPTB", "DiscordCanary"];

// Clientes paralelos do Discord (mods standalone) com a MESMA estrutura Electron: pasta
// <LOCALAPPDATA>/<Nome>/app-<versao>/resources com app.asar. O bypass injeta igual — o
// que diferencia e o nome da pasta/do executavel. O "Vencord" citado pelos usuarios e o
// Vesktop (o desktop do Vencord); Vencord/Equicord em si sao builds que usam o plugin.
const PARALLEL_APPS = ["Vesktop", "Equibop", "Legcord"];
const ALL_APPS = [...FLAVOURS, ...PARALLEL_APPS];

const MAC_APPS = [
  { flavour: "Discord", appName: "Discord.app", processName: "Discord" },
  {
    flavour: "DiscordPTB",
    appName: "Discord PTB.app",
    processName: "Discord PTB",
  },
  {
    flavour: "DiscordCanary",
    appName: "Discord Canary.app",
    processName: "Discord Canary",
  },
  { flavour: "Vesktop", appName: "Vesktop.app", processName: "Vesktop" },
  { flavour: "Equibop", appName: "Equibop.app", processName: "Equibop" },
  { flavour: "Legcord", appName: "Legcord.app", processName: "Legcord" },
] as const;

const MAC_HELPER_PROCESSES = [
  "Discord Helper",
  "Discord Helper (GPU)",
  "Discord Helper (Renderer)",
  "Discord Helper (Plugin)",
  "Vesktop Helper",
  "Vesktop Helper (GPU)",
  "Vesktop Helper (Renderer)",
  "Vesktop Helper (Plugin)",
  "Equibop Helper",
  "Equibop Helper (GPU)",
  "Equibop Helper (Renderer)",
  "Equibop Helper (Plugin)",
  "Legcord Helper",
  "Legcord Helper (GPU)",
  "Legcord Helper (Renderer)",
  "Legcord Helper (Plugin)",
];

let mainWindow: BrowserWindow | null = null;
let logWindow: BrowserWindow | null = null;
let suppressLogClosedNotify = false;
let tray: Tray | null = null;
let updaterController: UpdaterController | null = null;

// Fechar a janela esconde na bandeja (Windows) / barra de menus (Mac); so o Sair do menu
// desliga o app (e reverte o bypass, como o fechar da janela fazia antes). Sem a trava, o X
// derrubaria o app e a pessoa nem notaria que a janela foi parar junto do relogio.
let quitting = false;
let cleaningUp = false;

// Os icones moram em assets/ e seguem no pacote pelo "files" do electron-builder. O icone do
// exe vem de build/icon.ico; no Mac o .icns e gerado a partir do mesmo desenho.
//
// Importante: no Linux (AppImage) os assets ficam DENTRO do app.asar, e o nativeImage
// createFromPath nao le de dentro do asar (API nativa, nao passa pelo patch do fs). Ler o
// arquivo com fs (que entende asar) e criar a imagem do buffer resolve a bandeja com icone
// vazio/invalido.
function assetPath(name: string) {
  return path.join(__dirname, "..", "assets", name);
}

function loadAsset(name: string) {
  const file = assetPath(name);
  try {
    return nativeImage.createFromBuffer(fs.readFileSync(file));
  } catch {
    return nativeImage.createFromPath(file);
  }
}

function startupLabel() {
  return isMac ? "Iniciar com o Mac" : "Iniciar com o Windows";
}

function enclosingApp(filePath: string) {
  let dir = path.resolve(filePath);
  while (dir !== path.dirname(dir)) {
    if (dir.endsWith(".app")) return dir;
    dir = path.dirname(dir);
  }
  return filePath;
}

function openAppManagementSettings() {
  void shell.openExternal(
    "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AppBundles",
  );
}

function writeError(targetPath: string) {
  if (isMac) {
    const appPath = enclosingApp(targetPath);
    return [
      `Não foi possível escrever dentro de Discord.app (${targetPath}).`,
      "",
      "O macOS bloqueia outros apps de alterar o Discord — é a mesma permissão que o Vencord pede.",
      "",
      "1. Ajustes do Sistema → Privacidade e Segurança → Administração de Apps",
      "2. Ative o GoLiveBypass (ou arraste o app para a lista)",
      "3. Volte aqui e tente de novo",
      "",
      "Se ainda falhar, no Terminal:",
      `sudo chown -R "$(whoami):staff" ${JSON.stringify(appPath)}`,
    ].join("\n");
  }
  return `Não foi possível escrever na pasta do Discord (${targetPath}).`;
}

function macPermissionDenied(targetPath: string): never {
  openAppManagementSettings();
  throw new Error(writeError(targetPath));
}

function lockedFileHint(targetPath: string) {
  if (isMac) {
    return `Arquivo bloqueado pelo sistema: ${targetPath}\n\nDICA: Feche o Discord completamente (Cmd+Q) e tente novamente.`;
  }
  return `Arquivo bloqueado pelo sistema: ${targetPath}\n\nDICA: Feche o Discord completamente pelo Gerenciador de Tarefas e tente novamente.`;
}

function isPermissionError(e: any) {
  return e && (e.code === "EACCES" || e.code === "EPERM");
}

/**
 * O app mora na bandeja / barra de menus. Windows usa HKCU\...\Run direto
 * (ver electron/startup.ts) porque o app e distribuido em portable e o
 * setLoginItemSettings do Electron delega ao instalador Squirrel/MSI, que
 * nao existe. No Mac usamos wasOpenedAtLogin porque o openAsHidden morreu
 * no macOS 13 :( Nos dois casos sobe so o icone, sem abrir janela no login.
 */
import { getStartup, setStartup, launchedHidden, syncStartupEntry } from "./startup";

function createWindow() {
  mainWindow = new BrowserWindow({
    width: MAIN_WINDOW_WIDTH,
    // A altura e ajustada pelo proprio conteudo: a pagina avisa via IPC 'resize-window'
    // quando o warning do bypass ativo aparece/some, e a janela cresce/encolhe para nao
    // cortar nada (antes o aviso ficava cortado com a altura fixa de 560).
    height: 560,
    resizable: false,
    icon: loadAsset('icon.png'),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: true,
      contextIsolation: false,
    },
    autoHideMenuBar: true,
    titleBarStyle: isMac ? "hiddenInset" : "hidden",
    ...(isMac
      ? {
          trafficLightPosition: { x: 8, y: 8 },
          useContentSize: true,
        }
      : {
          titleBarOverlay: TITLEBAR[theme],
        }),
  });

  // Sem isto, um link com target="_blank" abre numa janela do Electron sem barra de endereco:
  // a pessoa nao ve para onde esta indo, e nao tem como voltar. Vale para o botao do Discord,
  // que ja existia, e para os creditos.
  mainWindow.setTitle(`GoLiveBypass v${app.getVersion()}`);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("close", (event) => {
    if (quitting || isQuittingForUpdate()) return;
    // Fechar a janela esconde na bandeja / barra de menus e o app continua vivo em segundo
    // plano, nos tres SOs. Quem quer encerrar de verdade usa o "Sair" (que reverte o bypass).
    event.preventDefault();
    mainWindow?.hide();
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}

function loadLogsPage(win: BrowserWindow) {
  if (process.env.VITE_DEV_SERVER_URL) {
    const base = process.env.VITE_DEV_SERVER_URL.replace(/\/?$/, "/");
    win.loadURL(`${base}logs.html`);
  } else {
    win.loadFile(path.join(__dirname, "../dist/logs.html"));
  }
}

function closeLogWindow() {
  if (!logWindow || logWindow.isDestroyed()) {
    logWindow = null;
    return;
  }
  // Fecha pelo toggle: nao manda o evento que desligaria o switch de novo.
  suppressLogClosedNotify = true;
  const win = logWindow;
  logWindow = null;
  try {
    win.destroy();
  } catch {
    /* ignore */
  }
}

function openLogWindow() {
  if (logWindow && !logWindow.isDestroyed()) {
    logWindow.show();
    logWindow.focus();
    return;
  }

  // Ao lado da janela principal, sem alongar a UI principal.
  let x: number | undefined;
  let y: number | undefined;
  if (mainWindow && !mainWindow.isDestroyed()) {
    const [mx, my] = mainWindow.getPosition();
    const [mw] = mainWindow.getSize();
    x = mx + mw + 12;
    y = my;
  }

  logWindow = new BrowserWindow({
    width: 520,
    height: 560,
    x,
    y,
    minWidth: 420,
    minHeight: 360,
    resizable: true,
    icon: loadAsset("icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: true,
      contextIsolation: false,
    },
    autoHideMenuBar: true,
    titleBarStyle: isMac ? "hiddenInset" : "hidden",
    ...(isMac
      ? { trafficLightPosition: { x: 8, y: 8 }, useContentSize: true }
      : { titleBarOverlay: TITLEBAR[theme] }),
  });

  logWindow.setTitle("GoLiveBypass — Logs");
  logWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  logWindow.on("closed", () => {
    logWindow = null;
    stopLogWatch();
    if (!suppressLogClosedNotify && mainWindow && !mainWindow.isDestroyed() && !quitting) {
      mainWindow.webContents.send("dev-log-window-closed");
    }
    suppressLogClosedNotify = false;
  });

  loadLogsPage(logWindow);
}

// A janela precisa refletir o que a bandeja fez; sem isto, ativar/desativar pelo icone deixava
// a interface com o estado antigo (botao "Ativar" com o bypass ja ativo, por exemplo).
function refreshWindowStatus() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("refresh-status");
  }
  if (logWindow && !logWindow.isDestroyed()) {
    logWindow.webContents.send("refresh-status");
  }
}

function showWindow() {
  // Durante o encerramento (quit, auto-update reexecutando) nao faz sentido
  // mostrar janela: o mainWindow/tray podem ja estar destruidos, e acessar
  // objetos destruidos derruba o app com "Object has been destroyed".
  if (quitting || isQuittingForUpdate()) return;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    // A bandeja pode ter mudado o startup ou o status com a janela escondida; ao reaparecer, sincroniza.
    mainWindow.webContents.send("refresh-startup");
    mainWindow.webContents.send("refresh-auto-update");
    refreshWindowStatus();
  } else {
    createWindow();
  }
  refreshTray().catch(() => {});
}

function statusLabel(status: string) {
  if (status === "ACTIVE") return "ativo";
  if (status === "CONNECTING") return "comprovando rota";
  if (status === "RECOVERY_REQUIRED") return "recuperação necessária";
  if (status === "OTHER_MOD") return "outro mod detectado";
  if (status === "NOT_FOUND") return "Discord não encontrado";
  if (status === "UNSUPPORTED") return "não suportado nesta plataforma";
  return "inativo";
}

// O status no Linux vem do script (async); no Windows e sincrono. Guardamos o ultimo valor
// para o menu montar sem travar e para o botao Ativar/Desativar ficar sempre clicavel.
let cachedStatus: string | null = null;
let linuxPreflightInFlight: Promise<LinuxPreflight> | null = null;
let linuxPreflightCache: { value: LinuxPreflight; expiresAt: number } | null = null;
let linuxStatusInFlight: Promise<string> | null = null;
let linuxStatusCache: { value: string; expiresAt: number } | null = null;
let linuxStatusGeneration = 0;
let linuxStatusLastLog = "";
let linuxStatusLastLogAt = 0;
let linuxHealthTimer: ReturnType<typeof setInterval> | null = null;
let linuxHealthInFlight = false;
let linuxHealthFailures = 0;
function linuxStatusLogAllowed(signature: string): boolean {
  const now = Date.now();
  if (signature === linuxStatusLastLog && now - linuxStatusLastLogAt < 30_000) return false;
  linuxStatusLastLog = signature;
  linuxStatusLastLogAt = now;
  return true;
}

// O menu e remontado a cada mudanca: e o jeito simples de o rotulo de status e o item
// Ativar/Desativar refletirem o estado atual sem logica de diff.
async function refreshTray() {
  if (!tray) return;
  try {
    const status = IS_LINUX ? await linuxStatus() : getStatus();
    cachedStatus = status;
    const label = statusLabel(status);
    const updateMenuItems = isUpdateReady()
      ? [{
          label: "Reiniciar para atualizar",
          click: () => {
            void applyPendingUpdate().then((ok) => {
              if (!ok) {
                void dialog.showMessageBox({
                  type: "warning",
                  title: "Atualização pendente",
                  message: "Não foi possível reiniciar para aplicar a atualização.",
                  detail: "A versão atual continua funcionando. Tente novamente mais tarde.",
                  buttons: ["OK"],
                });
              } else {
                refreshTray().catch(() => {});
              }
            });
          },
        }]
      : [];
    tray.setToolTip(`GoLiveBypass v${app.getVersion()} — ${label}`);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: `GoLiveBypass v${app.getVersion()} — ${label}`, enabled: false },
        { type: "separator" },
        { label: "Abrir", click: showWindow },
        {
          label: status === "ACTIVE" ? "Desativar o bypass" : "Ativar o bypass",
          // Sempre clicavel: mesmo com Discord "nao encontrado" a pessoa pode tentar de novo.
          click: () => { toggleFromTray().catch(() => refreshTray()); },
        },
        {
          label: startupLabel(),
          type: "checkbox",
          checked: getStartup(),
          click: (item) => setStartup(item.checked),
        },
        {
          label: "Avisar sobre atualizações",
          type: "checkbox",
          checked: readAutoUpdate(),
          click: (item) => {
            saveAutoUpdate(item.checked);
            updaterController?.setEnabled(item.checked);
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send("refresh-auto-update");
            }
          },
        },
        ...updateMenuItems,
        { type: "separator" },
        // Sair pela bandeja / barra de menus reverte so o que e nosso.
        {
          label: status === "ACTIVE" ? "Sair (desfaz o bypass)" : "Sair",
          click: quitApp,
        },
      ]),
    );
  } catch {
    // uma bandeja sem menu nao vale derrubar o app
  }
}

async function toggleFromTray() {
  try {
    // Atualiza o menu com "trabalhando" para dar feedback imediato do clique.
    if (tray) {
      tray.setToolTip('GoLiveBypass — trabalhando...');
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: 'GoLiveBypass — trabalhando...', enabled: false },
      ]));
    }

    if (IS_LINUX) {
      const status = await linuxStatus();
      if (status === "ACTIVE") await withWireSockLifecycle("desativar-linux-bandeja", () => linuxDeactivate(() => {}));
      else await withWireSockLifecycle("ativar-linux-bandeja", async () => {
        return linuxActivate(() => {});
      });
    } else if (getStatus() === "ACTIVE") {
      await deactivateAll();
    } else {
      await activateBypass(null, "");
    }
  } catch (error) {
    console.error('toggle falhou:', error);
  } finally {
    await refreshTray().catch(() => {});
    refreshWindowStatus();
  }
}

async function quitApp() {
  // O restore (reverter o bypass) vive no before-quit, que cobre Sair da bandeja, Cmd+Q no
  // Mac e o quit do app; aqui so disparamos a saida. A reversao corre sem travar o quit.
  quitting = true;
  app.quit();
}

function trayIcon() {
  // loadAsset le do buffer (fs entende o app.asar); no Linux/AppImage o createFromPath
  // nao enxerga dentro do asar e a bandeja ficaria com icone vazio.
  const source = loadAsset("tray.png");
  if (!isMac) return source;

  // tray.png e 32x32. Sem scaleFactor o macOS desenha 32pt, o dobro dos outros icones da barra.
  const icon = nativeImage.createFromBuffer(source.toPNG(), { scaleFactor: 2 });
  icon.setTemplateImage(true);
  return icon;
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.on("click", showWindow);
  refreshTray().catch(() => {});
}

// No KDE Plasma (e outros com StatusNotifier), o Tray do Electron so aparece se o
// org.kde.StatusNotifierWatcher ja estiver no session bus na hora da criacao. No login via
// autostart o app sobe antes do Plasma terminar de subir, o watcher ainda nao existe, e o
// Electron cai para o GtkStatusIcon — que o Plasma 6 nao mostra na bandeja. Esperar o watcher
// (com timeout) resolve; sem watcher (ambientes sem SNI) cria mesmo assim, no fallback antigo.
function waitForStatusNotifier(timeoutMs = 10000): Promise<void> {
  if (!IS_LINUX) return Promise.resolve();
  return new Promise((resolve) => {
    const check = () => {
      try {
        execFileSync("dbus-send", [
          "--session",
          "--dest=org.freedesktop.DBus",
          "--type=method_call",
          "--print-reply",
          "/org/freedesktop/DBus",
          "org.freedesktop.DBus.NameHasOwner",
          "string:org.kde.StatusNotifierWatcher",
        ], { stdio: "ignore" });
        resolve();
        return;
      } catch {
        // watcher ainda nao subiu; tenta de novo ate o prazo
      }
      if (Date.now() - started > timeoutMs) {
        resolve();
        return;
      }
      setTimeout(check, 1000);
    };
    const started = Date.now();
    check();
  });
}

// Com o app morando na bandeja, rodar o exe de novo nao pode empilhar uma segunda copia:
// ela morre aqui e a janela da primeira aparece.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());

  app.whenReady().then(async () => {
    // Logger proprio: arquivo + ring buffer, captura console do main process.
    // O gui.log mora em <settingsDir>/logs/ — pasta estavel, sobrevive a updates.
    try {
      const logs = logsDir.garantirLogsDir(app.getPath("home"), process.platform);
      logger.initLogger(logs);
      logger.patchConsole();
      logger.info("app", "iniciado", { versao: app.getVersion(), plataforma: process.platform });
    } catch {}
    // Beta 16: esta nao e mais uma preferencia. Corrige na abertura tanto o
    // settings compartilhado (Linux) quanto o settings de injecoes existentes
    // (Windows/macOS), inclusive se uma beta anterior deixou autoRevive=false.
    updateSharedSettings({ routeMode: "wireguard" });
    logger.info("recuperacao", "sistema WireGuard ativo; configuracao legada removida", {});
    // Um crash pode deixar serviço, filtro WFP, Discord e marcador vivos. O
    // estado verificado é apenas de memória e nunca é herdado: refazemos a
    // ativação inteira (fecha, restaura, mede baseline, prova e reabre).
    if (IS_WINDOWS && sessaoAtiva()) {
      if (isWireSockActive()) {
        logger.warn("wiresock", "boot.residual.detectado", {});
        try {
          await activateBypass({});
          logger.info("wiresock", "boot.residual.revalidado", {});
        } catch (error) {
          logger.error("wiresock", "boot.residual.falhou", { erro: String((error as Error)?.message ?? error) });
        }
      } else {
        clearSessionMarker();
      }
    }
    // Se uma sessao anterior morreu sem o quit limpo (PC desligado, crash), a injecao
    // ficou orfa: reverte agora para o status nao mentir (bug: "Ativo" sem ter ativado).
    // O sistema atual usa somente WireGuard por processo. Não reverter nem interpretar
    // app.asar/_app.asar: esses arquivos podem pertencer ao Discord ou a outro mod.
    // Se a GUI reabriu com o bypass ja ativo (netns/
    // WireSock de uma sessao anterior sobrevivendo ao restart da janela), o vigia do tunel
    // precisa retomar aqui — sem isto, so uma ativacao nova (clique) o arma.
    if (!isMac) {
      try {
        const statusInicial = IS_LINUX ? await linuxStatus() : getStatus();
        if (statusInicial === "ACTIVE") {
          iniciarWgStatsWatchdog(wgStatsProvider);
          startLinuxHealthWatchdog();
        }
      } catch {}
    }

    // No login (start com --hidden / wasOpenedAtLogin) sobe so a bandeja; a janela aparece no clique.
    if (!launchedHidden()) createWindow();
    // Autostart: se a entrada de Run existe, garante que aponta para o exe ATUAL.
    // O valor congela o caminho de quando o toggle foi ativado; portable renomeado/
    // movido = boot falha em silencio com o checkbox marcado. Reescrever a cada
    // abertura cura (reg add idempotente). (issue: "nao abre mesmo ativando")
    syncStartupEntry();
    // Boot: se o usuario deixou o bypass ativo na sessao passada (flag gravada na
    // ativacao, zerada so no deactivate explicito) e a injecao nao esta no disco
    // (o quit limpo restaura), reativa sozinho — sem esperar o clique no botao
    // verde (relato do beta 1.1.11-beta.2). No Linux nao roda: a ativacao pode
    // pedir elevacao, e prompt no boot e pior que o clique; la a injecao persiste
    // no boot pelo intact-skip do revertOrphanedInjection.
    if (false && !IS_LINUX && readSharedSettings().autoInject === true) {
      const injetado = getDiscordInstalls().some((install) =>
        withNoAsar(() =>
          diskFs.existsSync(path.join(install.resources, "_app.asar")) &&
          isOurInjection(install.resources),
        ),
      );
      if (injetado) {
        // Bypass ja injetado neste boot (nao passou pelo activateBypass() desta execucao):
        // assinaturaUltimaAtivacao nasce "" a cada reinicio da GUI, entao sem isto a guarda
        // de ativacao duplicada (ver "guarda de ativacao duplicada" abaixo, issue #145) fica
        // cega logo apos QUALQUER reinicio da GUI — uma reativacao identica (mesma proxy/modo,
        // clique ou re-chamada automatica) nao seria reconhecida como no-op e re-injetaria por
        // cima de um bypass que ja estava certo, derrubando o gateway/RTC a toa. Reconstroi a
        // assinatura a partir do que esta salvo no disco (a mesma fonte que activateBypass()
        // usaria de qualquer forma) para a guarda valer desde o primeiro clique pos-boot.
        assinaturaUltimaAtivacao = assinaturaAtivacao(String(readSharedSettings().proxy ?? ""));
      } else {
        const proxySalvo = String(readSharedSettings().proxy ?? "");
        console.log("[boot] autoInject: bypass estava ativo e nao esta injetado, reativando");
        void garantirTor()
          .catch(() => ({ ok: false }))
          .then(() => activateBypass({}, proxySalvo, false))
          .then(() => {
            console.log("[boot] autoInject: bypass reativado");
            // A janela costuma carregar NO MEIO desta ativacao (o Tor demora
            // segundos): sem este refresh o botao ficava em "Ativar" com o
            // bypass ja de pe — e o clique nesse estado reinjetava por cima
            // (a origem da duplicacao da #149, confirmada pelo testador na
            // beta 4). Falha atualiza tambem: o botao tem que refletir o que
            // deu errado.
            refreshWindowStatus();
            refreshTray().catch(() => { });
          })
          .catch((error: unknown) => {
            console.error(
              "[boot] autoInject falhou:",
              error instanceof Error ? error.message : error,
            );
            refreshWindowStatus();
            refreshTray().catch(() => { });
          });
      }
    }
    // No KDE o watcher da bandeja (StatusNotifier) pode demorar a subir no login; esperar
    // evita o Tray cair para o GtkStatusIcon, que o Plasma 6 nao exibe.
    waitForStatusNotifier().then(createTray);
    app.on("activate", showWindow);
    // Checa por atualizacao na release do GitHub (Windows portable: baixa e substitui;
    // Mac/Linux: autoUpdater nativo). Roda sozinho e em silencio se nao houver nada.
    updaterController = setupUpdater(
      () => mainWindow,
      () => readAutoUpdate(),
      () => readUpdateChannel(),
      () => { void refreshTray(); },
    );
  });
}

// Cmd+Q no Mac nao passa por window-all-closed da mesma forma que o Sair da bandeja no Windows:
// o restore vive aqui para os dois caminhos.
app.on("before-quit", (event) => {
  // Durante o auto-update o quit nao pode ser adiado: o processo novo ja foi
  // executado e precisa do lock de instancia unica. Sem esta saida, o app
  // antigo fica vivo e o novo morre — o "fecha mas nao abre".
  //
  protonOptimizations.invalidate();
  invalidateProtonPlanCache();
  stopProtonFailoverMonitor();
  if (isQuittingForUpdate()) return;
  updaterController?.setEnabled(false);
  // A segunda instancia so acorda a primeira e morre: sem esta guarda ela restauraria o
  // Discord na saida, desfazendo o bypass que a instancia principal acabou de aplicar.
  if (!gotLock || cleaningUp) return;
  event.preventDefault();
  quitting = true;
  cleaningUp = true;
  // O quit e limpo: o marcador de sessao morre aqui, para o boot seguinte nao tentar
  // reverter nada (a reversao abaixo e a que vale).
  clearSessionMarker();
  closeLogWindow();
  stopLogWatch();
  // A limpeza precisa terminar antes do processo morrer. Antes, o app.quit() imediato
  // podia encerrar o Electron no meio do stop/reset/flush do WireSock e deixar WFP ou o
  // processo filho residual bloqueando a rede. A segunda entrada em before-quit passa pela
  // guarda cleaningUp e permite a saída somente depois deste promise concluir.
  const restore = IS_LINUX
    ? withWireSockLifecycle("encerrar-linux", () => linuxDeactivate(() => {}))
    : deactivateAll();
  restore
    .catch((error) => {
      logger.error("app", "limpeza no encerramento falhou", {
        erro: String((error as Error)?.message ?? error),
      });
    })
    .finally(() => app.quit());
});

// A bandeja e a "dona" do app: fechar a janela so esconde (em qualquer SO), e o processo
// continua vivo em segundo plano. Sem isto, no Linux o window-all-closed derrubaria o app
// inteiro ao fechar a janela. Quem quer encerrar de verdade usa o "Sair" (quitApp -> before-quit).
app.on("window-all-closed", () => {
  // manter vivo — a bandeja cuida do resto
});

function withNoAsar<T>(fn: () => T): T {
  const previous = process.noAsar;
  process.noAsar = true;
  try {
    return fn();
  } finally {
    process.noAsar = previous;
  }
}

interface DiscordInstall {
  flavour: string;
  resources: string;
  exePath: string;
  bundlePath?: string;
}

function getWinDiscordInstalls(): DiscordInstall[] {
  const localAppData = process.env.LOCALAPPDATA;
  discordscan.scanInicio("win32", localAppData);
  if (!localAppData) return [];

  const installs: DiscordInstall[] = [];
  for (const flavour of ALL_APPS) {
    const rootPath = path.join(localAppData, flavour);
    const existe = diskFs.existsSync(rootPath);
    discordscan.scanRaiz(rootPath, existe, flavour);
    if (!existe) continue;

    const candidate = findWindowsDiscordInstall(
      rootPath,
      flavour,
      diskFs.existsSync,
      (target) => diskFs.readdirSync(target) as string[],
    );
    if (!candidate) continue;

    discordscan.scanInstall(candidate.resources, flavour);
    installs.push({ flavour, ...candidate });
  }
  discordscan.scanResultado(installs.length);
  return installs;
}

function getMacDiscordInstalls(): DiscordInstall[] {
  const roots = ["/Applications", path.join(homedir(), "Applications")];
  const installs: DiscordInstall[] = [];
  const seen = new Set<string>();
  discordscan.scanInicio("darwin");

  for (const root of roots) {
    for (const { flavour, appName } of MAC_APPS) {
      if (seen.has(flavour)) continue;
      const bundlePath = path.join(root, appName);
      const resources = path.join(bundlePath, "Contents", "Resources");
      const asar = path.join(resources, "app.asar");
      const originalAsar = path.join(resources, "_app.asar");
      const existe = diskFs.existsSync(asar) || diskFs.existsSync(originalAsar);
      discordscan.scanRaiz(bundlePath, existe, flavour);
      if (existe) {
        installs.push({ flavour, resources, exePath: "", bundlePath });
        discordscan.scanInstall(resources, flavour);
        seen.add(flavour);
      }
    }
  }
  discordscan.scanResultado(installs.length);
  return installs;
}

function getDiscordInstalls(): DiscordInstall[] {
  // No Linux quem decide e o script standalone (--status/--yes); a varredura
  // win32/mac aqui so vale nos outros SOs — e logar o scan win no Linux so
  // confundiria o diagnostico ("localappdata=ausente" sem sentido).
  if (IS_LINUX) return [];
  return withNoAsar(() =>
    isMac ? getMacDiscordInstalls() : getWinDiscordInstalls(),
  );
}

function discordProcessState(): ProcessProbeState {
  if (isMac) {
    let probeFailed = false;
    for (const { processName } of MAC_APPS) {
      try {
        execFileSync("pgrep", ["-x", processName], { stdio: "ignore" });
        discordscan.runningPgrep(processName, true);
        return "running";
      } catch (e) {
        // pgrep usa exit 1 para "nenhum processo", que e uma resposta valida.
        const code = (e as NodeJS.ErrnoException)?.status;
        if (code === 1) discordscan.runningPgrep(processName, false);
        else {
          probeFailed = true;
          discordscan.runningPgrep(processName, false, (e as Error)?.message);
        }
      }
    }
    return probeFailed ? "unknown" : "stopped";
  }

  let probeFailed = false;
  for (const flavour of ALL_APPS) {
    try {
      const out = execSync(`tasklist /FI "IMAGENAME eq ${flavour}.exe" /NH`, {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "ignore"],
      });
      if (out.toLowerCase().includes(`${flavour}.exe`.toLowerCase())) {
        discordscan.runningTasklist(flavour, true);
        return "running";
      }
      discordscan.runningTasklist(flavour, false);
    } catch (e) {
      probeFailed = true;
      discordscan.runningTasklist(flavour, false, (e as Error)?.message);
    }
  }
  return probeFailed ? "unknown" : "stopped";
}

function discordIsRunning(): boolean {
  return discordProcessState() === "running";
}

async function waitUntilDiscordGone(tries = 40, delayMs = 250) {
  return waitForProcessStopped(() => discordProcessState(), { attempts: tries, delayMs });
}

async function waitUntilDiscordRunning(tries = 40, delayMs = 250) {
  return waitForProcessRunning(() => discordProcessState(), { attempts: tries, delayMs });
}

function discordDidNotStop(): never {
  logger.error("discord", "encerramento.timeout", { timeout_ms: 10_000 });
  throw new Error("Não foi possível encerrar completamente o Discord. Feche o cliente e tente novamente antes de alterar a rota.");
}

/**
 * O updater do Discord usa o nome genérico Update.exe e não aparece como
 * Discord*.exe. Se ele sobrevive ao encerramento, pode reabrir uma sessão velha
 * e ficar preso em “Checking for updates...”, disputando a sessão recém-criada.
 * Filtramos pelo command line para não matar atualizadores de outros produtos.
 */
function killDiscordUpdater() {
  if (!IS_WINDOWS) return;
  try {
    const script = "$procs = Get-CimInstance Win32_Process -Filter \"Name = 'Update.exe'\" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match 'Discord' }; $procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: "ignore", windowsHide: true, timeout: 5000 });
  } catch (err) {
    logger.warn("discord", "nao consegui encerrar o updater do Discord", { erro: String((err as Error)?.message ?? err) });
  }
}

// Update.exe e' compartilhado por apps Squirrel. Por isso a identificacao usa a
// command line, nunca somente o nome do executavel. Uma falha na consulta nao e'
// tratada como ausencia: alterar a rota com um updater desconhecido ainda vivo
// pode relancar o Discord fora da janela controlada.
function discordUpdaterProcessState(): ProcessProbeState {
  if (!IS_WINDOWS) return "stopped";
  try {
    const script = "$procs = @(Get-CimInstance Win32_Process -Filter \"Name = 'Update.exe'\" -ErrorAction Stop | Where-Object { $_.CommandLine -match 'Discord' }); if ($procs.Count -gt 0) { exit 0 }; exit 1";
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 5000,
    });
    return "running";
  } catch (err) {
    // O exit 1 e' a resposta esperada do script para nenhuma instancia Discord.
    if ((err as NodeJS.ErrnoException)?.status === 1) return "stopped";
    logger.warn("discord", "updater.estado_desconhecido", {
      erro: String((err as Error)?.message ?? err),
    });
    return "unknown";
  }
}

async function waitUntilDiscordUpdaterGone(tries = 10, delayMs = 250) {
  return waitForProcessStopped(() => discordUpdaterProcessState(), { attempts: tries, delayMs });
}

function discordUpdaterDidNotStop(): never {
  logger.error("discord", "updater.encerramento.timeout", { timeout_ms: 5_000 });
  throw new Error("Não foi possível encerrar o atualizador do Discord. Feche o cliente e tente novamente antes de alterar a rota.");
}

function killMacProcesses(names: readonly string[], signal?: "-9") {
  for (const name of names) {
    try {
      execFileSync("killall", signal ? [signal, name] : [name], {
        stdio: "ignore",
      });
    } catch {}
  }
}

async function killDiscord() {
  if (isMac) {
    const mains = MAC_APPS.map((macApp) => macApp.processName);
    killMacProcesses(mains);
    killMacProcesses(MAC_HELPER_PROCESSES);
    if (!(await waitUntilDiscordGone())) {
      killMacProcesses(mains, "-9");
      killMacProcesses(MAC_HELPER_PROCESSES, "-9");
      if (!(await waitUntilDiscordGone(20, 250))) discordDidNotStop();
    }
    return;
  }

  for (const flavour of ALL_APPS) {
    try {
      execSync(`taskkill /F /T /IM ${flavour}.exe`, { stdio: "ignore" });
    } catch {}
  }
  killDiscordUpdater();
  if (!(await waitUntilDiscordGone())) {
    // Um Update.exe pode recriar o processo principal depois do primeiro taskkill.
    // Mata-o mais uma vez e falha de forma segura se a sessao antiga persistir.
    killDiscordUpdater();
    if (!(await waitUntilDiscordGone(20, 250))) discordDidNotStop();
  }
  // O updater pode ter sido recriado no intervalo em que o processo principal
  // saiu; repete a verificação antes de qualquer nova instalação/rota.
  killDiscordUpdater();
  if (!(await waitUntilDiscordUpdaterGone())) {
    killDiscordUpdater();
    if (!(await waitUntilDiscordUpdaterGone(20, 250))) discordUpdaterDidNotStop();
  }
}

function assertResourcesWritable(install: DiscordInstall) {
  const probe = path.join(install.resources, ".golivebypass-write-test");
  try {
    withNoAsar(() => {
      diskFs.writeFileSync(probe, "");
      diskFs.unlinkSync(probe);
    });
  } catch {
    if (isMac) macPermissionDenied(install.bundlePath || install.resources);
    throw new Error(writeError(install.bundlePath || install.resources));
  }
}

function isAdHocSigned(bundlePath: string) {
  const result = spawnSync("codesign", ["-dv", "--verbose=2", bundlePath], {
    encoding: "utf8",
  });
  const info = `${result.stdout}\n${result.stderr}`;
  return /\badhoc\b/i.test(info) || /TeamIdentifier=not set/.test(info);
}

function assertDiscordSignature(bundlePath: string | undefined) {
  if (!isMac || !bundlePath) return;
  if (!isAdHocSigned(bundlePath)) return;
  throw new Error(
    [
      "O Discord.app está com a assinatura quebrada (assinatura ad-hoc).",
      "",
      "O macOS trata esse Discord como outro app: pede a senha do Keychain (Discord Safe Storage) e o cliente cai. Desativar o bypass não devolve a assinatura original da Discord Inc.",
      "",
      "Baixe o Discord de novo em https://discord.com/download e substitua o app em Aplicativos.",
      "Não apague ~/Library/Application Support/discord — sua conta continua lá.",
    ].join("\n"),
  );
}

/**
 *  Reassinar com codesign --deep --sign apaga as entitlements (JIT, library validation) e o Team ID: o Keychain pede senha e
 * o Chromium crasha.
 */
function clearBundleQuarantine(bundlePath: string | undefined) {
  if (!isMac || !bundlePath) return;
  try {
    execFileSync("xattr", ["-cr", bundlePath], { stdio: "ignore" });
  } catch {
    // sem atributos estendidos nao e erro
  }
}

// EBUSY persistente no rename/remove: o holder ou e um processo do Discord que
// sobreviveu ao taskkill (helper desanexado, updater) ou renasceu entre a
// checagem e a operacao. Esperar passivo nao solta handle de quem nunca vai
// soltar — as primeiras tentativas re-matam o Discord; as ultimas so aguardam
// o SO liberar (antivirus/indexador scanning o arquivo recem-fechado).
async function safeRename(oldPath: string, newPath: string) {
  let lastError;
  for (let i = 0; i < 15; i++) {
    try {
      withNoAsar(() => {
        diskFs.renameSync(oldPath, newPath);
      });
      return;
    } catch (e: any) {
      if (isPermissionError(e)) {
        if (isMac) macPermissionDenied(oldPath);
        throw new Error(writeError(oldPath));
      }
      lastError = e;
      if (i < 3) await killDiscord();
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(
    `${lockedFileHint(oldPath)}\nErro: ${lastError?.message || "Desconhecido"}`,
  );
}

async function safeRemove(targetPath: string) {
  let lastError;
  for (let i = 0; i < 15; i++) {
    try {
      withNoAsar(() => {
        if (diskFs.existsSync(targetPath)) {
          diskFs.rmSync(targetPath, { recursive: true, force: true });
        }
      });
      return;
    } catch (e: any) {
      if (isPermissionError(e)) {
        if (isMac) macPermissionDenied(targetPath);
        throw new Error(writeError(targetPath));
      }
      lastError = e;
      if (i < 3) await killDiscord();
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`Falha ao remover arquivo bloqueado: ${targetPath}`);
}

function startDiscord(install: DiscordInstall) {
  try {
    // exec() deixava o stdout do Discord preso num pipe nosso: quando a GUI morria (ou o
    // buffer do exec enchia), o pipe quebrava, e qualquer log de excecao do processo
    // principal do Discord virava EPIPE fatal ("A JavaScript error occurred in the main
    // process", relato real). O Discord precisa nascer sem pipe nenhum para nos: stdio
    // ignorado e sem referencia. Sem detached de proposito: no Windows ele faz o filho
    // sair na hora em alguns ambientes, e aqui ele nao falta.
    if (isMac && install.bundlePath) {
      spawn("open", [install.bundlePath], { stdio: "ignore" }).unref();
    } else if (install.exePath) {
      const child = spawn(install.exePath, [], { stdio: "ignore", windowsHide: true });
      // spawn pode falhar depois de retornar (exe removido pelo updater/antivirus).
      // Sem listener, o EventEmitter gera excecao nao tratada e derruba a GUI.
      child.once("error", (error) => {
        logger.error("discord", "inicio.falhou", {
          flavour: install.flavour,
          erro: String((error as Error)?.message ?? error),
        });
      });
      child.unref();
    }
  } catch {}
}

function windowsAllowedAppPaths(installs: DiscordInstall[]): string[] {
  const apps = new Set<string>();
  for (const install of installs) {
    if (!install.exePath) continue;
    apps.add(path.resolve(install.exePath));
    // WireSock interpreta caminho de diretorio como todos os executaveis
    // contidos nele. A prova co-localizada abaixo valida exatamente esta regra.
    apps.add(path.dirname(path.resolve(install.exePath)));
    apps.add(path.basename(install.exePath));
    apps.add(path.join(path.dirname(path.dirname(install.exePath)), "Update.exe"));
    apps.add("Update.exe");
  }
  // Controle da conta Proton usa a rede do host. Somente o probe copiado
  // para o diretorio do Discord acompanha a regra de tunel desse aplicativo.
  return [...apps];
}

function logRouteProbe(stage: "direct" | "tunnel", attempt: number, result: RouteProbeResult, target = "central") {
  logger.info("wiresock", "route.probe", {
    stage,
    attempt,
    target,
    success: result.success,
    discord_ok: result.discordOk,
    observations: result.observations.map((item) => ({
      source: item.source,
      ip: maskedIP(item.ip),
      country: item.country || "?",
      ms: item.latencyMs ?? "?",
    })),
    error: result.error || "",
  });
}

// Route observations are diagnostic only. Failure, geolocation disagreement,
// unavailable helpers and cleanup errors must never control Discord lifecycle.
async function diagnoseWindowsRoute(generation: number) {
  let scope: ReturnType<typeof prepareDiscordScopeProbes> | undefined;
  try {
    scope = prepareDiscordScopeProbes(getDiscordInstalls(), proton.findProtonConfgenExe());
    for (const probe of scope.probes) {
      if (generation !== windowsRouteGeneration || !windowsRouteStarted || quitting) return;
      await observeRouteDiagnostic(
        () => proton.runRouteProbeFrom(probe.probePath, 12_000),
        (result) => {
          logRouteProbe("tunnel", 0, result, probe.flavours.join("+"));
          logger.info("wiresock", "route.diagnostic", { ...decideRouteProof(null, result), mode: "log-only", target: probe.flavours.join("+") });
        },
        (error) => logger.warn("wiresock", "route.diagnostic.error", { mode: "log-only", erro: error }),
        () => generation === windowsRouteGeneration && windowsRouteStarted && !quitting,
      );
    }
  } catch (error) {
    logger.warn("wiresock", "route.diagnostic.setup", { mode: "log-only", erro: String((error as Error)?.message ?? error).slice(0, 300) });
  } finally {
    await scope?.cleanup().catch((error) => logger.warn("wiresock", "route.diagnostic.cleanup", { erro: String((error as Error)?.message ?? error).slice(0, 300) }));
  }
}

function stopWindowsRouteWatchdog() {
  if (windowsRouteWatchdogTimer) clearInterval(windowsRouteWatchdogTimer);
  windowsRouteWatchdogTimer = null;
  windowsRouteWatchdogInFlight = false;
}

function startWindowsRouteWatchdog() {
  if (!IS_WINDOWS) return;
  stopWindowsRouteWatchdog();
  const generation = windowsRouteGeneration;
  const observe = () => {
    if (windowsRouteWatchdogInFlight || !windowsRouteStarted || quitting || generation !== windowsRouteGeneration) return;
    windowsRouteWatchdogInFlight = true;
    void diagnoseWindowsRoute(generation).finally(() => {
      if (generation === windowsRouteGeneration) windowsRouteWatchdogInFlight = false;
    });
  };
  windowsRouteWatchdogTimer = setInterval(observe, 60_000);
  observe();
}

// Nas transicoes que restauram a rede, nao basta pedir o spawn: sem esse ack a
// UI dizia que a recuperacao terminou, mas o usuario ficava com o Discord
// fechado (por exemplo, se o updater removeu o exe entre scan e spawn).
async function startDiscordAndConfirm(installs: DiscordInstall[], operation: string): Promise<boolean> {
  for (const install of installs) startDiscord(install);
  if (!IS_WINDOWS || installs.length === 0) return true;
  const started = await waitUntilDiscordRunning();
  if (!started) {
    logger.error("discord", "reinicio.timeout", { operation, timeout_ms: 10_000 });
  }
  return started;
}

async function waitForWindowsRouteSettle(generation: number, operation: string): Promise<void> {
  logger.info("wiresock", "tunel criado; aguardando estabilizacao antes do Discord", {
    operation,
    delay_ms: TUNNEL_STARTUP_SETTLE_MS,
    mode: "startup-settle",
  });
  await waitForTunnelStartupSettle();
  assertWindowsRouteGeneration(generation);
}

// O _app.asar so existe quando alguem ja injetou: e o Discord original guardado de lado. Se ele
// existe e o app.asar nao e nosso, quem esta ali e outro mod.
function isOurInjection(resources: string) {
  return withNoAsar(() => {
    const indexJs = path.join(resources, "app.asar", "index.js");
    if (!diskFs.existsSync(indexJs)) return false;
    return diskFs.readFileSync(indexJs, "utf8").includes("golivebypass.js");
  });
}

// Detecta qual mod esta no app.asar (Vencord, Equicord, Vesktop, Equibop, Legcord).
// Vencord/Equicord injetam no Discord oficial patcheando o app.asar com um stub que faz
// require do patcher deles. Vesktop/Equibop/Legcord sao clientes paralelos com a mesma
// estrutura de <resources>/app.asar - nesse caso, quem nos informa o mod eh o flavour
// (pasta %LOCALAPPDATA%/<Nome>) e nao o conteudo do app.asar.
//
// Retorna null se nao detectou nenhum mod conhecido, ou a string com o nome canonico.
function detectOtherMod(resources: string, flavour?: string): string | null {
  // Primeiro tenta adivinhar pelo flavour (cliente paralelo). Esses tem o mod ja
  // embutido no executavel, nao no app.asar - o app.asar deles pode ser "deles mesmos"
  // ou de um mod que o user injetou em cima.
  if (flavour) {
    const f = flavour.toLowerCase();
    if (f === "vesktop") return "vesktop";
    if (f === "equibop") return "equibop";
    if (f === "legcord") return "legcord";
  }

  // Vencord/Equicord/Vesktop patcheado a mao: detecta lendo o stub do app.asar
  // (ate 64KB) e procurando o caminho do patcher. O stub faz `require("<caminho>")`
  // e o caminho contem o nome do mod.
  return withNoAsar(() => {
    const stub = path.join(resources, "app.asar");
    if (!diskFs.existsSync(stub)) return null;
    const stat = diskFs.statSync(stub);
    if (stat.isDirectory()) return null;  // nosso: pasta, nao asar
    if (stat.size > 65536) return null;   // stub de Vencord/Equicord tem < 1KB
    let content: string;
    try {
      content = diskFs.readFileSync(stub, "utf8");
    } catch {
      return null;
    }
    const m = content.match(/require\("([^"]+)"\)/);
    const target = m ? m[1].toLowerCase() : "";
    if (target.includes("vencord")) return "vencord";
    if (target.includes("equibop")) return "equibop";
    if (target.includes("equicord")) return "equicord";
    if (target.includes("vesktop")) return "vesktop";
    return null;
  });
}

// Vencord/Equicord convivem com a gente via plugin (goLiveBypass-vencord.zip).
// Quando detectado no app.asar, NAO sobrescrevemos sem confirmacao explicita - o
// user provavelmente tem outros plugins do Vencord/Equicord que vao deixar de funcionar.
// Vesktop/Equibop/Legcord sao clientes paralelos: sobrescrever o app.asar deles os
// transforma em "Discord com bypass" (perde a identidade, mas nao ha plugins do
// user perdidos). O retorno e mais informativo do que restritivo.
function isProtectedMod(name: string | null): boolean {
  return name === "vencord" || name === "equicord";
}

function writeInjection(asar: string, proxyAddress: string) {
  withNoAsar(() => {
    diskFs.mkdirSync(asar);
    diskFs.writeFileSync(
      path.join(asar, "package.json"),
      JSON.stringify({ name: "discord", main: "index.js", version: "1.0.0" }),
    );
    diskFs.writeFileSync(path.join(asar, "golivebypass.js"), bypassCode);
    // O modo de rede e a porta do Tor embutido vao junto: o bypass le routeMode e torAddr.
    // No modo tor o campo proxy fica vazio (a saida e o Tor, nao um proxy manual).
    diskFs.writeFileSync(
      path.join(asar, "settings.json"),
      JSON.stringify({
        enabled: true,
        proxy: proxyAddress,
        routeMode: readNetMode(),
        torAddr: `127.0.0.1:${torPortaEmUso}`,
        // Recuperacao e obrigatoria; mantemos a chave para atualizar tambem
        // instalacoes que ainda tenham um settings.json legado com false.
        autoRevive: true,
      }),
    );
    diskFs.writeFileSync(
      path.join(asar, "index.js"),
      `require('./golivebypass.js');`,
    );
  });
}

// Reescrita generica do settings.json dentro dos asars injetados (Windows/macOS): merge
// atomico por install, preservando o que ja estava la. No Linux e no-op — o runtime le o
// settings compartilhado, que o updateSharedSettings ja atualizou. Devolve quantos
// installs reescreveu (0 = bypass inativo, o valor entra na proxima ativacao).
function reescreverSettingsInjetado(patch: Record<string, unknown>): number {
  if (IS_LINUX) return 0;
  let reescritos = 0;
  for (const install of getDiscordInstalls()) {
    const asar = path.join(install.resources, "app.asar");
    const settingsPath = path.join(asar, "settings.json");
    const ok = withNoAsar(() => {
      try {
        if (!diskFs.existsSync(path.join(install.resources, "_app.asar"))) return false;
        if (!isOurInjection(install.resources)) return false;
        let atual: Record<string, unknown> = {};
        try {
          atual = JSON.parse(diskFs.readFileSync(settingsPath, "utf8"));
        } catch {}
        diskFs.writeFileSync(settingsPath, JSON.stringify({ ...atual, ...patch, autoRevive: true }));
        return true;
      } catch {
        return false;
      }
    });
    if (ok) reescritos++;
  }
  return reescritos;
}

// Troca de modo com o bypass ativo: o runtime le as settings UMA VEZ, no boot do
// Discord, e o settings.json dentro do asar so era reescrito na ATIVACAO. Quem
// trocava de modo no seletor ficava com o runtime no modo velho atraves de
// reinicios do Discord (issue #121: GUI em tor, runtime em free, 80 candidatas
// mortas, gateway direto). Reescrever so o settings.json deixa o disco verdadeiro
// para o proximo start.
function updateInjectedNetSettings(mode: string): number {
  return reescreverSettingsInjetado({ routeMode: mode, torAddr: `127.0.0.1:${torPortaEmUso}` });
}

// ------------------------------------------------------------------ fila serial: ativar/desativar
// nunca podem rodar ao mesmo tempo, venha o clique da janela ou da bandeja. Sao ENTRADAS
// INDEPENDENTES para os mesmos quatro caminhos (activateBypass/deactivateAll/linuxActivate/
// linuxDeactivate), e nenhuma sabia da outra: o toggle da bandeja e deliberadamente "sempre
// clicavel" (ver o comentario dele), inclusive com uma ativacao/desativacao ja em voo pela
// janela. Sem isto, ativar pela janela e desativar pela bandeja quase ao mesmo tempo faziam
// duas execucoes mexerem no MESMO app.asar/_app.asar ao mesmo tempo -- no Windows/Mac, dois
// killDiscord()+rename() concorrentes; no Linux, pior ainda, dois processos `sh
// golivebypass-standalone.sh` independentes com corrida de arquivo real (TOCTOU) sobre os
// mesmos diretorios. Resultado possivel: nem app.asar nem _app.asar no lugar certo, Discord
// quebrado sem recuperacao automatica -- corrupcao de estado, a prioridade mais alta do /goal.
let bypassOpFila: Promise<unknown> = Promise.resolve();
function serializarBypassOp<T>(fn: () => Promise<T>): Promise<T> {
  const propria = bypassOpFila.catch(() => {}).then(fn);
  bypassOpFila = propria.catch(() => {});
  return propria;
}

// ------------------------------------------------------------------ guarda de ativacao duplicada
// Duas ativacoes em segundos (reativacao de boot + clique com o status ainda velho, duplo
// clique no botao) injetam duas vezes: cada injecao fecha as conexoes antigas e faz o
// gateway renascer — na #145 isso abriu com duas injecoes em 7s e a segunda derrubou a
// sessao recem-nascida da primeira. Entao: a segunda chamada aguarda a primeira terminar;
// e re-ativacao identica (mesma proxy, mesmo modo) sobre um bypass ja injetado e no-op.
let ativacaoCorrente: Promise<void> | null = null;
let assinaturaUltimaAtivacao = "";

function assinaturaAtivacao(proxyAddress: string): string {
  return JSON.stringify({ proxy: proxyAddress.trim(), modo: readNetMode() });
}

async function activateBypass(event: any) {
  if (ativacaoCorrente !== null) {
    logger.info("ativacao", "ja ha uma ativacao em andamento; aguardando a mesma conclusao");
    return ativacaoCorrente;
  }
  ativacaoCorrente = serializarBypassOp(() =>
    executarAtivacao(event),
  ).finally(() => {
    ativacaoCorrente = null;
  });
  return ativacaoCorrente;
}

async function executarAtivacao(event: any) {
  if (isMac) throw new Error("O bypass por WireGuard ainda não está disponível no macOS.");
  const installs = getDiscordInstalls();
  if (installs.length === 0) {
    discordscan.ativacaoSemDiscord("nenhum install encontrado na varredura");
    throw new Error("Nenhum Discord encontrado.");
  }

  // Com WireSock, o estado ativo e somente tunel + Discord rodando. Reativar com a mesma
  // configuracao derrubaria conexoes a toa; nao consultamos nem alteramos o cliente.
  const assinatura = assinaturaAtivacao("");
  if (
    assinatura === assinaturaUltimaAtivacao &&
    getStatus() === "ACTIVE"
  ) {
    logger.info("ativacao", "bypass ja ativo com a mesma proxy/modo; re-injecao ignorada");
    return;
  }

  // Valida que o usuario selecionou uma configuracao WireGuard
  const s = readSharedSettings() as any;
  const vpnMode = (s.vpnMode as string) || "proton";
  const wgConf = path.join(settingsDir(), "wireguard.conf");

  if (vpnMode === "proton") {
    const username = (s.protonUsername as string) || "";
    if (!username) {
      throw new Error("Faça login com sua conta ProtonVPN (ou selecione 'Arquivo .conf Customizado') antes de ativar.");
    }
    if (!fs.existsSync(wgConf)) {
      await withWireSockLifecycle("perfil-proton-ativacao", ensureProtonActivationProfile);
    }
  } else {
    if (!fs.existsSync(wgConf)) {
      throw new Error("Nenhuma configuração WireGuard (.conf) foi selecionada. Por favor, importe uma configuração antes de ativar.");
    }
  }

  const windowsWasActive = IS_WINDOWS && getStatus() === "ACTIVE";
  const windowsGeneration = IS_WINDOWS ? beginWindowsRouteOperation() : 0;
  if (IS_WINDOWS) {
    try {
      await withWireSockLifecycle("preflight-wiresock", async () => {
        await ensureWireSockInstalled((message) => {
          event?.sender?.send?.("bypass-log", `${message}\n`);
        });
        assertWindowsRouteGeneration(windowsGeneration);
      });
    } catch (error) {
      if (windowsGeneration === windowsRouteGeneration) {
        windowsRouteState = windowsWasActive ? "active" : "inactive";
        refreshWindowStatus();
      }
      throw error;
    }
  }
  try {
    await killDiscord();
  } catch (error) {
    if (IS_WINDOWS) {
      windowsRouteState = isWireSockActive() ? "recovery_required" : "inactive";
      refreshWindowStatus();
    }
    throw error;
  }
  stopWindowsRouteWatchdog();
  windowsRouteStarted = false;

  let windowsDiscordStarted = false;
  if (IS_WINDOWS) {
    try {
      await withWireSockLifecycle("ativacao", async () => {
        // Uma sessao anterior pode ter sobrevivido ao fechamento da GUI. So
        // instala o perfil novo depois de comprovar que ela saiu por completo.
        if (isWireSockActive()) {
          const recovery = await recoverWireSockNetwork();
          if (!recovery.ok) throw new Error(`Não consegui limpar a sessão WireSock anterior (${recovery.residual.join(", ") || recovery.error || "rede não validada"}). Use "Restaurar internet".`);
        }
        assertWindowsRouteGeneration(windowsGeneration);
        await startWireSockService(settingsDir(), undefined, windowsAllowedAppPaths(installs));
        await waitForWindowsRouteSettle(windowsGeneration, "ativacao");
        if (!(await startDiscordAndConfirm(installs, "ativacao"))) {
          throw new Error("O Discord não iniciou após preparar o túnel.");
        }
        windowsDiscordStarted = true;
        windowsRouteStarted = true;
        windowsRouteState = "active";
        startWindowsRouteWatchdog();
        // Handshake, HTTP e geolocalizacao sao diagnosticos assincronos.
        void waitForWindowsWgReady().then((readiness) => {
          logger.info("wiresock", "prontidao.diagnostica", readiness);
        }).catch((error) => {
          logger.warn("wiresock", "prontidao.diagnostica.erro", { erro: String((error as Error)?.message ?? error) });
        });
      });
    } catch (cause) {
      windowsRouteStarted = false;
      windowsRouteState = "failed";
      stopWindowsRouteWatchdog();
      // startWireSockService pode parar o servico anterior antes de descobrir
      // que a nova configuracao/handshake falhou. Nunca deixe WFP nessa meia
      // transicao: o Discord ja foi fechado e a proxima tentativa deve partir
      // de uma rede normal comprovada.
      pararWgStatsWatchdog();
      clearSessionMarker();
      let closeError = "";
      try {
        // waitForWindowsWgReady agora ocorre depois do spawn para quebrar o
        // ciclo de observabilidade. Portanto o rollback tambem deve encerrar
        // esse cliente antes de remover o filtro WFP.
        await killDiscord();
      } catch (closeFailure) {
        closeError = String((closeFailure as Error)?.message ?? closeFailure);
      }
      if (closeError) {
        const detail = String((cause as Error)?.message ?? cause);
        logger.error("wiresock", "ativacao.falhou_cliente_aberto", { erro: detail, encerramento: closeError });
        throw new Error(`A ativação falhou (${detail}), mas não foi possível encerrar o Discord com segurança (${closeError}). Feche o Discord e use "Restaurar internet".`);
      }
      let recoveryError = "";
      try {
        const recovery = await withWireSockLifecycle("ativacao.rollback", () => recoverWireSockNetwork());
        if (!recovery.ok) recoveryError = recovery.residual.join(", ") || recovery.error || "rede não validada";
      } catch (rollbackError) {
        recoveryError = String((rollbackError as Error)?.message ?? rollbackError);
      }
      const detail = String((cause as Error)?.message ?? cause);
      logger.error("wiresock", "ativacao.falhou_revertida", { erro: detail, rollback: recoveryError || "ok" });
      windowsRouteState = recoveryError ? "recovery_required" : "inactive";
      refreshWindowStatus();
      throw new Error(
        recoveryError
          ? `A ativação falhou (${detail}) e não consegui restaurar a rede (${recoveryError}). Use "Restaurar internet".`
          : `A ativação falhou (${detail}). A rota WireSock foi removida; corrija a configuração e tente novamente.`,
      );
    }
  }

  if (!windowsDiscordStarted) {
    for (const install of installs) {
      startDiscord(install);
    }
  }

  // O spawn ter sido solicitado nao significa que o Electron do Discord sobreviveu ao
  // updater/antivirus. Sem este ack, a sessao ficava marcada como ativa mesmo sem cliente.
  if (IS_WINDOWS && !windowsDiscordStarted) {
    logger.error("discord", "inicio.timeout", { timeout_ms: 10_000 });
    await withWireSockLifecycle("ativacao.rollback", async () => {
      await killDiscord();
      const recovery = await recoverWireSockNetwork();
      if (!recovery.ok) {
        throw new Error(`Discord não iniciou e a rota WireSock não foi restaurada (${recovery.residual.join(", ") || recovery.error || "estado desconhecido"}). Use "Restaurar internet".`);
      }
    });
    throw new Error("O Discord não iniciou após preparar o túnel. A rota foi restaurada; verifique a instalação do Discord e tente novamente.");
  }

  // Registra a sessao: o bypass so se desfaz no quit limpo; se o PC desligar no meio, o
  // boot seguinte encontra este marcador e reverte a injecao orfa.
  writeSessionMarker(installs);
  // Flag de "estava ativo": o boot seguinte re-injeta sozinho se a injecao nao
  // estiver no disco (quit limpo restaura, e o usuario nao precisa apertar o
  // botao de novo — relato do beta 1.1.11-beta.2). Zerada so no deactivate
  // explicito do usuario.
  updateSharedSettings({ autoInject: false });
  // Ativacao concluiu de verdade: guarda a assinatura para a guarda de duplicada
  // (ver topo da funcao).
  assinaturaUltimaAtivacao = assinatura;
  // So Windows (WireSock) tem tunel WireGuard de verdade aqui — macOS ainda e o mecanismo
  // legado de PAC/Tor, sem interface wg nenhuma para vigiar.
  if (IS_WINDOWS) iniciarWgStatsWatchdog(wgStatsProvider);
  startProtonFailoverMonitor();
}

async function deactivateAll() {
  stopProtonFailoverMonitor();
  pararWgStatsWatchdog();
  stopWindowsRouteWatchdog();
  windowsRouteStarted = false;
  if (IS_WINDOWS) {
    windowsRouteGeneration += 1;
    windowsRouteState = "preparing";
  }
  // Na arquitetura WireSock o app.asar fica propositalmente vanilla. Guarda o estado antes
  // de parar o servico: getStatus() deixa de ver o bypass assim que ele desce.
  const hadWireSock = IS_WINDOWS && isWireSockActive();

  const installs = getDiscordInstalls();

  // O estado atual é exclusivamente o túnel. Nunca restaure ou remova app.asar/_app.asar
  // durante a desativação; isso eliminava mods do usuário e causava falsos positivos.
  if (IS_WINDOWS) {
    await withWireSockLifecycle("desativacao", async () => {
      // Rele a condicao ja dentro da fila: uma troca de rota pode ter entrado
      // pouco antes desta desativacao e nao pode sobreviver a ela.
      if (hadWireSock || isWireSockActive()) {
        await killDiscord();
        const recovery = await recoverWireSockNetwork();
        if (!recovery.ok) {
          windowsRouteState = "recovery_required";
          throw new Error(`Não consegui restaurar a rede: WireSock=${recovery.residual.join(", ") || "limpeza incompleta"}; rede=${recovery.error || "não validada"}. Use "Restaurar internet" e tente novamente.`);
        }
        const restarted = await startDiscordAndConfirm(installs, "desativacao");
        clearSessionMarker();
        if (!restarted) {
          throw new Error("A rede foi restaurada, mas o Discord não iniciou. Verifique a instalação do Discord e abra-o novamente.");
        }
      }
      clearSessionMarker();
      windowsRouteState = "inactive";
    });
    return;
  }
  if (isMac) return;

  // So desfaz o que e nosso. Isto roda ao sair do app, e antes desfazia qualquer injecao:
  // quem tinha Equicord ou Vencord abria este app, fechava, e o mod sumia sem nada avisar.
  const ours = installs.filter(
    (install) =>
      withNoAsar(() =>
        diskFs.existsSync(path.join(install.resources, "_app.asar")),
      ) && isOurInjection(install.resources),
  );

  // No Windows atual nao ha injecao para restaurar, mas o Discord precisa ser reiniciado fora
  // do filtro WFP. Antes este retorno precoce so parava o WireSock (ou nem isso) e deixava o
  // processo ja aberto conectado pela rota antiga.
  if (ours.length === 0) {
    if (hadWireSock) {
      await killDiscord();
      await recoverWireSockNetwork();
      for (const install of installs) startDiscord(install);
      clearSessionMarker();
    }
    return;
  }

  for (const install of ours) assertResourcesWritable(install);

  await killDiscord();

  if (IS_WINDOWS) await recoverWireSockNetwork();

  for (const install of ours) {
    const asar = path.join(install.resources, "app.asar");
    const originalAsar = path.join(install.resources, "_app.asar");

    await safeRemove(asar);
    await safeRename(originalAsar, asar);
    clearBundleQuarantine(install.bundlePath);
    startDiscord(install);
  }

  // Reverteu (de verdade): a sessao terminou, o marcador nao vale mais.
  clearSessionMarker();
}

function getStatus(): string {
  // isWireSockRunning() sozinho (so o servico do Windows) deixava o status "INACTIVE" para
  // sempre quando startWireSockService cai no fallback sem servico (usuario sem privilegio de
  // admin para instalar/iniciar o servico, mas o processo direto sobe e o tunel funciona): a
  // ativacao completava de verdade (Discord envelopado, WireSock rodando), mas a UI nunca via
  // isso e ficava presa mostrando "Ativar" -- exatamente o relato do beta tester.
  if (isMac) return "UNSUPPORTED";
  if (IS_WINDOWS) {
    const installs = getDiscordInstalls();
    if (installs.length === 0) return "NOT_FOUND";
    if (windowsRouteState === "preparing") return "CONNECTING";
    if (windowsRouteState === "recovery_required") return "RECOVERY_REQUIRED";
    return windowsRouteStarted && isWireSockActive() && discordIsRunning() ? "ACTIVE" : "INACTIVE";
  }
  const installs = getDiscordInstalls();
  if (installs.length === 0) return "NOT_FOUND";
  return withNoAsar(() => {
    for (const install of installs) {
      const asar = path.join(install.resources, "app.asar");
      const originalAsar = path.join(install.resources, "_app.asar");
      if (diskFs.existsSync(originalAsar)) {
        // Checa se é o nosso bypass legado
        const indexJs = path.join(asar, "index.js");
        if (diskFs.existsSync(indexJs)) {
          const content = diskFs.readFileSync(indexJs, "utf8");
          if (content.includes("golivebypass.js")) return "ACTIVE";
        }
      }
    }
    return "INACTIVE";
  });
}

// ---------------------------------------------------------------------------
// Linux: delega para o script standalone (POSIX). A GUI e uma casca: quem decide
// tudo (deteccao, flatpak, sudo, injecao) e o script, e a GUI mostra o progresso.
// ---------------------------------------------------------------------------

// Flavours (discord/vesktop/equibop/legcord) achados na ultima varredura Linux —
// exposto no report para mostrar na hora se um cliente paralelo foi visto.
let ultimosFlavoursLinux = "";
let ultimosGraficosLinux = "";

// Handshake/trafego do tunel WireGuard no Linux: le do `--status --json` do script (que ja
// roda elevado quando precisa), nao de um execSync direto na GUI, que normalmente nao tem
// privilegio para entrar no namespace de rede sozinha.
async function linuxWgStats(): Promise<WgTunnelStats> {
  const semDados: WgTunnelStats = { ok: false, handshakeAgoS: null, rxBytes: null, txBytes: null, endpoint: null };
  try {
    const { code, stdout } = await runScript(["--status", "--json"]);
    if (code !== 0) return { ...semDados, error: `script de status saiu com codigo ${code}` };
    const data = JSON.parse(stdout);
    const wg = data?.wg;
    if (!wg || wg.ok !== true) {
      return { ...semDados, error: typeof wg?.error === "string" ? wg.error : "sem campo wg no --status" };
    }
    return {
      ok: true,
      handshakeAgoS: typeof wg.handshakeAgoS === "number" ? wg.handshakeAgoS : null,
      rxBytes: typeof wg.rxBytes === "number" ? wg.rxBytes : null,
      txBytes: typeof wg.txBytes === "number" ? wg.txBytes : null,
      endpoint: null,
    };
  } catch (err) {
    return { ...semDados, error: String((err as Error)?.message ?? err) };
  }
}

async function checkLinuxTunnelHealth(): Promise<{ healthy: boolean; reason: string }> {
  const statusResult = await runScript(["--status", "--json"]);
  if (statusResult.code !== 0) return { healthy: false, reason: "script de status indisponível" };
  const data = JSON.parse(statusResult.stdout || "{}");
  const discords = Array.isArray(data.discords) ? data.discords : [];
  const discordInNamespace = discords.some((d: Record<string, unknown>) => d.running === "sim" && d.inNamespace === "sim");
  let probeReady = false;
  try {
    const probe = await runScript(["--probe", "--json", "--non-interactive"]);
    if (probe.stdout) probeReady = JSON.parse(probe.stdout).ready === true;
  } catch { /* classificador produz a razão acionável */ }
  const wg = data?.wg ?? {};
  return classifyLinuxHealth({
    netns: data?.netns === true,
    discordInNamespace,
    wg: {
      ok: wg.ok === true,
      handshakeAgoS: typeof wg.handshakeAgoS === "number" ? wg.handshakeAgoS : null,
      rxBytes: typeof wg.rxBytes === "number" ? wg.rxBytes : null,
      txBytes: typeof wg.txBytes === "number" ? wg.txBytes : null,
    },
    probeReady,
  });
}

function stopLinuxHealthWatchdog() {
  if (linuxHealthTimer !== null) clearInterval(linuxHealthTimer);
  linuxHealthTimer = null;
  linuxHealthInFlight = false;
  linuxHealthFailures = 0;
}

function startLinuxHealthWatchdog() {
  if (!IS_LINUX || linuxHealthTimer !== null) return;
  linuxHealthTimer = setInterval(() => {
    if (linuxHealthInFlight || quitting) return;
    linuxHealthInFlight = true;
    void checkLinuxTunnelHealth().then((result) => {
      if (result.healthy) {
        linuxHealthFailures = 0;
        return;
      }
      linuxHealthFailures += 1;
      logger.warn("linux", "tunel.diagnostico", { mode: "log-only", falhas: linuxHealthFailures, motivo: result.reason });
    }).catch((error) => logger.warn("linux", "health.erro", { erro: String((error as Error)?.message ?? error) }))
      .finally(() => { linuxHealthInFlight = false; });
  }, 15_000);
}

function wgStatsProvider(): Promise<WgTunnelStats> | WgTunnelStats {
  return IS_LINUX ? linuxWgStats() : getWgStats();
}

function protonRouteNumber(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function currentProtonRouteMetadata(settings: Record<string, unknown>): ProtonRouteMetadata | undefined {
  const raw = settings.protonLastServer as Record<string, unknown> | undefined;
  const server = typeof raw?.server === "string" ? raw.server.trim() : "";
  const endpoint = typeof raw?.endpoint === "string" ? raw.endpoint.trim() : "";
  if (!server || !endpoint) return undefined;
  return {
    success: true,
    server,
    country: typeof raw?.country === "string" ? raw.country : String(settings.protonCountry || ""),
    city: typeof raw?.city === "string" ? raw.city : "",
    tier: typeof raw?.tier === "string" ? raw.tier : "Free",
    load: protonRouteNumber(raw?.load),
    score: protonRouteNumber(raw?.score),
    pingMs: protonRouteNumber(raw?.pingMs),
    endpoint,
    confFile: path.join(settingsDir(), "wireguard.conf"),
    expiresAt: Number.isFinite(Number(raw?.expiresAt)) ? Number(raw?.expiresAt) : undefined,
    generatedAt: typeof raw?.updatedAt === "string" ? raw.updatedAt : undefined,
  };
}

function protonPoolFilter(settings: Record<string, unknown>, username: string) {
  return {
    username,
    country: typeof settings.protonCountry === "string" ? settings.protonCountry : "",
    freeOnly: true,
    autoPing: settings.protonAutoPing !== false,
  };
}

function validProtonPoolReserves(manifest: ProtonRoutePoolManifest): ProtonRouteMetadata[] {
  const poolDir = routePoolDirectory(settingsDir());
  const seen = new Set<string>();
  const valid: ProtonRouteMetadata[] = [];
  for (const candidate of manifest.reserves) {
    const safe = safeRoutePoolPath(poolDir, candidate.confFile);
    if (!safe || !fs.existsSync(safe) || !routeCandidateUsable(candidate) || seen.has(candidate.server)) continue;
    seen.add(candidate.server);
    valid.push({ ...candidate, confFile: safe });
  }
  return valid;
}

function cleanupProtonPoolOrphans(manifest: ProtonRoutePoolManifest): void {
  const poolDir = routePoolDirectory(settingsDir());
  const referenced = new Set<string>([
    ...(manifest.active?.confFile ? [path.resolve(manifest.active.confFile)] : []),
    ...manifest.reserves.map((route) => path.resolve(route.confFile)),
  ]);
  try {
    for (const entry of fs.readdirSync(poolDir, { withFileTypes: true })) {
      if (!entry.isFile() || !/^route-.*\.conf$/i.test(entry.name)) continue;
      const file = path.resolve(path.join(poolDir, entry.name));
      if (!referenced.has(file)) fs.rmSync(file, { force: true });
    }
  } catch (error) {
    logger.warn("proton", "limpeza.do.pool.falhou", { erro: String((error as Error)?.message ?? error) });
  }
}

function clearProtonRoutePool(): void {
  const poolDir = routePoolDirectory(settingsDir());
  try { fs.rmSync(poolDir, { recursive: true, force: true }); } catch (error) {
    logger.warn("proton", "limpeza.do.pool.falhou", { erro: String((error as Error)?.message ?? error) });
  }
}

function notifyProtonFailover(message: string): void {
  logger.warn("proton", "failover.aviso", { message, mode: "discreet" });
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send("proton-failover-notice", { message }); } catch {}
  }
}

function routePoolManifestForCurrent(
  settings: Record<string, unknown>,
  username: string,
): ProtonRoutePoolManifest {
  const filter = protonPoolFilter(settings, username);
  const current = currentProtonRouteMetadata(settings);
  const existing = readRoutePoolManifest(settingsDir());
  const manifest = routePoolMatches(existing, filter)
    ? existing as ProtonRoutePoolManifest
    : makeRoutePoolManifest(filter, current);
  if (current) manifest.active = current;
  const activeName = manifest.active?.server;
  manifest.reserves = validProtonPoolReserves(manifest)
    .filter((route) => route.server !== activeName && !manifest.quarantined.includes(route.server));
  return manifest;
}

function beginProtonRoutePoolSession(settings: Record<string, unknown>, username: string): void {
  const manifest = routePoolManifestForCurrent(settings, username);
  // A new activation gets one fresh pool renewal budget. Reserve files may be
  // reused when their identity and expiry still match the account/filter.
  manifest.renewalUsed = false;
  manifest.disabled = false;
  writeRoutePoolManifest(settingsDir(), manifest);
}

async function buildProtonRoutePoolNow(
  generation: number,
  count: number,
  markRenewal = false,
): Promise<boolean> {
  if (generation !== protonFailoverGeneration || quitting) return false;
  const settings = readSharedSettings();
  if (settings.vpnMode === "custom" || settings.protonAutoFailover === false) return false;
  const username = typeof settings.protonUsername === "string" ? settings.protonUsername.trim() : "";
  if (!username) return false;

  const poolDir = routePoolDirectory(settingsDir());
  fs.mkdirSync(poolDir, { recursive: true, mode: 0o700 });
  let manifest = routePoolManifestForCurrent(settings, username);
  if (markRenewal) {
    manifest.renewalUsed = true;
    writeRoutePoolManifest(settingsDir(), manifest);
  }

  const excluded = new Set<string>([
    ...(manifest.active?.server ? [manifest.active.server] : []),
    ...manifest.reserves.map((route) => route.server),
    ...manifest.quarantined,
  ]);
  const controller = protonRoutePoolAbort;
  let result: Awaited<ReturnType<typeof proton.generateProtonRoutePool>>;
  try {
    result = await proton.generateProtonRoutePool(settingsDir(), {
      username,
      countries: typeof settings.protonCountry === "string" ? settings.protonCountry || undefined : undefined,
      freeOnly: true,
      autoPing: settings.protonAutoPing !== false,
      size: Math.max(1, Math.min(3, Math.floor(count))),
      excludeServers: [...excluded],
      signal: controller?.signal,
    });
  } catch (error) {
    logger.warn("proton", "pool.background.failed", { erro: String((error as Error)?.message ?? error) });
    return false;
  }
  if (generation !== protonFailoverGeneration || quitting || !result.success || !result.stagingDir || !result.routes) {
    if (!result.success) logger.warn("proton", "pool.background.rejected", { erro: result.error || "resposta inválida" });
    if (result.stagingDir) {
      try { fs.rmSync(result.stagingDir, { recursive: true, force: true }); } catch {}
    }
    return false;
  }

  const promoted: ProtonRouteMetadata[] = [];
  try {
    for (const route of result.routes) {
      const source = safeRoutePoolPath(result.stagingDir, route.confFile);
      if (!source || !fs.existsSync(source) || !routeCandidateUsable(route) || excluded.has(route.server)) continue;
      const target = path.join(poolDir, `route-${Date.now()}-${randomUUID()}.conf`);
      try {
        fs.renameSync(source, target);
      } catch {
        fs.copyFileSync(source, target);
        fs.rmSync(source, { force: true });
      }
      try { fs.chmodSync(target, 0o600); } catch {}
      promoted.push({ ...route, confFile: target });
      excluded.add(route.server);
    }
  } finally {
    try { fs.rmSync(result.stagingDir, { recursive: true, force: true }); } catch {}
  }

  if (generation !== protonFailoverGeneration || promoted.length < count) {
    logger.warn("proton", "pool.background.incompleto", { solicitadas: count, preparadas: promoted.length });
    return false;
  }
  manifest.reserves = [...manifest.reserves, ...promoted].slice(-ROUTE_POOL_RESERVE_COUNT);
  manifest.createdAt = new Date().toISOString();
  manifest.disabled = false;
  writeRoutePoolManifest(settingsDir(), manifest);
  cleanupProtonPoolOrphans(manifest);
  logger.info("proton", "pool.background.ready", { reservas: manifest.reserves.length });
  return true;
}

function scheduleProtonRoutePoolBuild(generation: number, count: number): void {
  if (protonRoutePoolBuild || count <= 0 || generation !== protonFailoverGeneration) return;
  if (!protonRoutePoolAbort) protonRoutePoolAbort = new AbortController();
  const task = buildProtonRoutePoolNow(generation, count).catch((error) => {
    logger.warn("proton", "pool.background.error", { erro: String((error as Error)?.message ?? error) });
  });
  let tracked: Promise<void>;
  tracked = task.finally(() => {
    if (protonRoutePoolBuild === tracked) {
      protonRoutePoolBuild = null;
      protonRoutePoolAbort = null;
    }
  });
  protonRoutePoolBuild = tracked;
}

async function waitForLinuxFailoverHandshake(timeoutMs = FAILOVER_ROUTE_TIMEOUT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const stats = await linuxWgStats();
    if (stats.ok && stats.handshakeAgoS !== null && stats.handshakeAgoS <= 45) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

function promoteProtonCandidate(candidate: ProtonRouteMetadata): void {
  const canonical = path.join(settingsDir(), "wireguard.conf");
  const temp = `${canonical}.${randomUUID()}.tmp`;
  try {
    fs.copyFileSync(candidate.confFile, temp);
    try { fs.chmodSync(temp, 0o600); } catch {}
    fs.renameSync(temp, canonical);
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch {}
    throw error;
  }
}

async function applyProtonFailoverCandidate(
  candidate: ProtonRouteMetadata,
  generation: number,
): Promise<boolean> {
  const canonical = path.join(settingsDir(), "wireguard.conf");
  if (!fs.existsSync(canonical) || !fs.existsSync(candidate.confFile)) return false;
  if (generation !== protonFailoverGeneration || quitting) return false;

  const installs = IS_WINDOWS ? getDiscordInstalls() : [];
  const windowsGeneration = windowsRouteGeneration;
  if (IS_WINDOWS) {
    if (windowsRouteState !== "active" || !windowsRouteStarted || !isWireSockActive() || !discordIsRunning()) return false;
    stopWindowsRouteWatchdog();
  } else if (IS_LINUX) {
    stopLinuxHealthWatchdog();
  }
  pararWgStatsWatchdog();
  const switchProfile = async (profile: string): Promise<boolean> => {
    if (IS_WINDOWS) {
      assertWindowsRouteGeneration(windowsGeneration);
      await switchWireSockService(settingsDir(), profile, windowsAllowedAppPaths(installs));
      assertWindowsRouteGeneration(windowsGeneration);
      return (await waitForWindowsWgReady(FAILOVER_ROUTE_TIMEOUT_MS)).verified;
    }
    const refreshed = await runScript(["--refresh-route-from", profile, "--non-interactive"]);
    if (refreshed.code !== 0) return false;
    return waitForLinuxFailoverHandshake();
  };

  windowsRouteState = IS_WINDOWS ? "preparing" : windowsRouteState;
  refreshWindowStatus();
  let candidateReady = false;
  try {
    candidateReady = await switchProfile(candidate.confFile);
    if (!candidateReady) throw new Error("handshake não confirmado no tempo limite");
    if (generation !== protonFailoverGeneration || quitting) throw new Error("troca cancelada por uma operação mais recente");
    promoteProtonCandidate(candidate);
    windowsRouteState = IS_WINDOWS ? "active" : windowsRouteState;
    logger.info("proton", "failover.rota.aplicada", { server: candidate.server, endpoint: candidate.endpoint });
    return true;
  } catch (error) {
    logger.warn("proton", "failover.rota.rejeitada", { server: candidate.server, erro: String((error as Error)?.message ?? error) });
    try {
      const restored = await switchProfile(canonical);
      if (!restored) throw new Error("handshake da rota anterior não confirmado");
      windowsRouteState = IS_WINDOWS ? "active" : windowsRouteState;
      logger.info("proton", "failover.rollback.ok", { server: candidate.server });
    } catch (rollbackError) {
      if (IS_WINDOWS) windowsRouteState = "recovery_required";
      logger.error("proton", "failover.rollback.falhou", { erro: String((rollbackError as Error)?.message ?? rollbackError) });
    }
    return false;
  } finally {
    if (IS_WINDOWS && windowsRouteState === "preparing") windowsRouteState = "active";
    if (IS_WINDOWS && windowsRouteState === "active") startWindowsRouteWatchdog();
    if (IS_LINUX && !quitting) startLinuxHealthWatchdog();
    if (!quitting && generation === protonFailoverGeneration) iniciarWgStatsWatchdog(wgStatsProvider);
    refreshWindowStatus();
  }
}

async function attemptProtonFailover(generation: number): Promise<void> {
  if (generation !== protonFailoverGeneration || protonFailoverDisabled || quitting) return;
  if (protonRoutePoolBuild) await protonRoutePoolBuild.catch(() => {});
  if (generation !== protonFailoverGeneration || protonFailoverDisabled || quitting) return;

  const settings = readSharedSettings();
  const username = typeof settings.protonUsername === "string" ? settings.protonUsername.trim() : "";
  if (settings.vpnMode === "custom" || !username || settings.protonAutoFailover === false) return;
  const plan = await resolveProtonPlan(username);
  if (plan.status !== "free") return;

  let manifest = routePoolManifestForCurrent(settings, username);
  if (!manifest.active) manifest.active = currentProtonRouteMetadata(settings);
  let candidates = validProtonPoolReserves(manifest);

  // Pool exhaustion gets exactly one fresh generation. The persisted flag makes
  // a failed renewal terminal for this activation, avoiding an API/retry loop.
  if (candidates.length === 0 && !manifest.renewalUsed) {
    manifest.renewalUsed = true;
    writeRoutePoolManifest(settingsDir(), manifest);
    // A renovação ocorre dentro da fila de lifecycle, mas ainda precisa de um
    // AbortController próprio: uma desativação/login pode acontecer enquanto
    // o helper está consultando a API e não deve deixá-lo rodando por minutos.
    const renewalController = protonRoutePoolAbort ?? new AbortController();
    if (!protonRoutePoolAbort) protonRoutePoolAbort = renewalController;
    try {
      await buildProtonRoutePoolNow(generation, ROUTE_POOL_TOTAL, true);
    } finally {
      if (protonRoutePoolAbort === renewalController) protonRoutePoolAbort = null;
    }
    manifest = routePoolManifestForCurrent(readSharedSettings(), username);
    candidates = validProtonPoolReserves(manifest);
  }

  if (candidates.length === 0) {
    manifest.disabled = true;
    writeRoutePoolManifest(settingsDir(), manifest);
    protonFailoverDisabled = true;
    notifyProtonFailover("A rota Proton Free caiu e não foi encontrada uma reserva disponível. O Discord continua aberto; tente otimizar a rota quando puder.");
    return;
  }

  const failedNames = new Set<string>();
  for (const candidate of candidates) {
    if (generation !== protonFailoverGeneration || quitting) return;
    if (await applyProtonFailoverCandidate(candidate, generation)) {
      const oldName = manifest.active?.server;
      manifest.active = { ...candidate, confFile: path.join(settingsDir(), "wireguard.conf") };
      manifest.reserves = validProtonPoolReserves(manifest).filter((route) => route.server !== candidate.server && !failedNames.has(route.server));
      if (oldName && oldName !== candidate.server) manifest.quarantined = [...manifest.quarantined, oldName].slice(-32);
      manifest.disabled = false;
      writeRoutePoolManifest(settingsDir(), manifest);
      updateSharedSettings({
        protonLastServer: {
          ...candidate,
          confFile: path.join(settingsDir(), "wireguard.conf"),
          measurementUsername: username.toLocaleLowerCase("en-US"),
          updatedAt: new Date().toISOString(),
        },
      });
      protonFailoverTracker?.reset();
      scheduleProtonRoutePoolBuild(generation, Math.max(0, ROUTE_POOL_RESERVE_COUNT - manifest.reserves.length));
      return;
    }
    failedNames.add(candidate.server);
    manifest.reserves = manifest.reserves.filter((route) => route.server !== candidate.server);
    manifest.quarantined = [...manifest.quarantined, candidate.server].slice(-32);
    writeRoutePoolManifest(settingsDir(), manifest);
  }

  manifest.disabled = true;
  writeRoutePoolManifest(settingsDir(), manifest);
  protonFailoverDisabled = true;
  notifyProtonFailover("As reservas Proton Free não responderam. O Discord continua aberto e nenhuma nova tentativa automática será feita nesta sessão.");
  cleanupProtonPoolOrphans(manifest);
}

async function collectProtonFailoverSample(generation: number): Promise<void> {
  if (generation !== protonFailoverGeneration || !protonFailoverTracker || quitting || protonFailoverDisabled) return;
  const settings = readSharedSettings();
  if (settings.vpnMode === "custom" || settings.protonAutoFailover === false) return;

  let sample;
  if (IS_LINUX) {
    const status = await linuxStatus();
    const stats = await linuxWgStats();
    sample = {
      discordRunning: status === "ACTIVE",
      tunnelActive: status === "ACTIVE",
      stats,
      statsFailureEvidence: /namespace inativo|sem peer|interface .*inativ/i.test(stats.error || ""),
    };
  } else if (IS_WINDOWS) {
    const discordRunning = discordIsRunning();
    const [traffic, wireSock, stats, tunnelActive] = await Promise.all([
      getWireSockAdapterTrafficAsync(),
      getWireSockConnectionStatusAsync(),
      getWgStatsAsync(),
      isWireSockActiveAsync(),
    ]);
    const trafficIncreasing = hasWireSockAdapterTrafficIncrease(protonFailoverPreviousAdapterTraffic, traffic);
    protonFailoverPreviousAdapterTraffic = traffic;
    sample = {
      discordRunning,
      // Se uma leitura assíncrona do processo falhar, o estado WireSock ainda
      // pode estar apenas indeterminado. Só o estado explicitamente
      // desconectado deve transformar essa falha diagnóstica em uma amostra
      // negativa; assim não trocamos uma rota por causa de um timeout local.
      tunnelActive: windowsRouteState === "active" && windowsRouteStarted &&
        (tunnelActive || wireSock.state !== "disconnected"),
      stats,
      wireSock,
      trafficIncreasing,
    };
  } else {
    return;
  }

  const health = classifyFailoverHealth(sample);
  const observation = protonFailoverTracker.observe(health);
  if (health === "failed" || observation.trigger) {
    logger.warn("proton", "failover.health", {
      health,
      consecutive_failures: observation.consecutiveFailures,
      grace: observation.inGracePeriod,
    });
  }
  if (!observation.trigger || generation !== protonFailoverGeneration) return;
  await withWireSockLifecycle("failover-proton", () => attemptProtonFailover(generation));
}

function stopProtonFailoverMonitor(): void {
  protonFailoverGeneration += 1;
  if (protonFailoverTimer !== null) clearInterval(protonFailoverTimer);
  protonFailoverTimer = null;
  protonFailoverTracker = null;
  protonFailoverInFlight = false;
  protonFailoverInFlightGeneration = 0;
  protonFailoverPreviousAdapterTraffic = null;
  protonFailoverDisabled = false;
  if (protonRoutePoolAbort) protonRoutePoolAbort.abort();
  // Libera imediatamente a referência da sessão antiga para que uma nova
  // ativação ou mudança de filtro possa iniciar outra geração. O finally da
  // tarefa antiga só limpa o estado se ainda for a mesma Promise.
  protonRoutePoolBuild = null;
  protonRoutePoolAbort = null;
}

function startProtonFailoverMonitor(): void {
  if (!IS_WINDOWS && !IS_LINUX) return;
  stopProtonFailoverMonitor();
  const generation = protonFailoverGeneration;
  void (async () => {
    const settings = readSharedSettings();
    if (settings.vpnMode === "custom" || settings.protonAutoFailover === false) return;
    const username = typeof settings.protonUsername === "string" ? settings.protonUsername.trim() : "";
    if (!username) return;
    const plan = await resolveProtonPlan(username);
    if (generation !== protonFailoverGeneration || plan.status !== "free" || quitting) return;
    const active = IS_LINUX ? await linuxStatus() === "ACTIVE" : windowsRouteState === "active" && windowsRouteStarted && isWireSockActive() && discordIsRunning();
    if (!active || generation !== protonFailoverGeneration) return;
    protonFailoverTracker = new FailoverHealthTracker();
    protonFailoverTracker.reset();
    protonFailoverTimer = setInterval(() => {
      if (protonFailoverInFlight) return;
      protonFailoverInFlight = true;
      protonFailoverInFlightGeneration = generation;
      void collectProtonFailoverSample(generation)
        .catch((error) => logger.warn("proton", "failover.sample.error", { erro: String((error as Error)?.message ?? error) }))
        .finally(() => {
          if (generation === protonFailoverInFlightGeneration && generation === protonFailoverGeneration) protonFailoverInFlight = false;
        });
    }, FAILOVER_SAMPLE_INTERVAL_MS);
    // The first sample is useful for arming the grace window, not for an immediate swap.
    protonRoutePoolAbort = new AbortController();
    protonFailoverInFlight = true;
    protonFailoverInFlightGeneration = generation;
    void collectProtonFailoverSample(generation)
      .catch((error) => logger.warn("proton", "failover.sample.error", { erro: String((error as Error)?.message ?? error) }))
      .finally(() => {
        if (generation === protonFailoverInFlightGeneration && generation === protonFailoverGeneration) protonFailoverInFlight = false;
      });
    beginProtonRoutePoolSession(settings, username);
    scheduleProtonRoutePoolBuild(generation, ROUTE_POOL_RESERVE_COUNT);
  })().catch((error) => logger.warn("proton", "failover.setup.error", { erro: String((error as Error)?.message ?? error) }));
}

export interface WindowsRouteReadiness {
  verified: boolean;
  state: "connected" | "unverified" | "disconnected";
  source: WireSockConnectionStatus["source"] | "wg" | "functional" | "none";
  detail?: string;
}

// A CLI do WireSock confirma o estado administrativo, mas nao prova que pacotes
// chegaram ao peer. Esta rotina observa as fontes disponiveis para diagnostico;
// ela nunca bloqueia nem reprova uma ativacao que ja iniciou o WireSock.
async function waitForWindowsWgReady(timeoutMs = 20_000): Promise<WindowsRouteReadiness> {
  const deadline = Date.now() + timeoutMs;
  let last: WgTunnelStats | undefined;
  let lastWireSock: WireSockConnectionStatus = getWireSockConnectionStatus();
  let cliFlowSamples = 0;
  let adapterFlowSamples = 0;
  let previousAdapterTraffic: ReturnType<typeof getWireSockAdapterTraffic> = null;
  while (Date.now() < deadline) {
    lastWireSock = getWireSockConnectionStatus();
    if (lastWireSock.source === "cli" && lastWireSock.state === "disconnected") {
      return {
        verified: false,
        state: "disconnected",
        source: "cli",
        detail: "WireSock informou que a rota está desconectada",
      };
    }
    last = getWgStats();
    const readiness = classifyWgReadiness(last, true);
    if (readiness.ready) {
      return { verified: true, state: "connected", source: "wg", detail: "handshake recente e tráfego WireGuard bidirecional confirmados" };
    }
    // Instalações oficiais nem sempre incluem wg.exe. Dois estados Connected
    // consecutivos com endereço externo são a confirmação funcional da CLI;
    // quando wg.exe existe, a validação de handshake/RX/TX acima é preferida.
    if (lastWireSock.source === "cli" && lastWireSock.state === "connected" && lastWireSock.externalAddress) {
      cliFlowSamples++;
      if (cliFlowSamples >= 2) {
        return { verified: true, state: "connected", source: "cli", detail: `túnel conectado; endereço externo ${lastWireSock.externalAddress}` };
      }
    } else {
      cliFlowSamples = 0;
    }
    // Algumas instalações oficiais expõem apenas wiresock-client.exe + ProTUN.
    // Depois de abrir o Discord (que está em AllowedApps), duas amostras RX/TX
    // provam o fluxo real pelo túnel sem depender do tráfego da própria GUI.
    const traffic = getWireSockAdapterTraffic();
    const adapterTrafficIncreasing = hasWireSockAdapterTrafficIncrease(previousAdapterTraffic, traffic);
    previousAdapterTraffic = traffic;
    if (lastWireSock.source === "service" && lastWireSock.state === "unknown" && traffic && adapterTrafficIncreasing) {
      adapterFlowSamples++;
      if (adapterFlowSamples >= 2) {
        logger.info("wiresock", "rota.confirmada.protun", {
          received_bytes: traffic.receivedBytes,
          sent_bytes: traffic.sentBytes,
          samples: adapterFlowSamples,
        });
        return { verified: true, state: "connected", source: "service", detail: `ProTUN ativo com tráfego RX/TX (${traffic.receivedBytes}/${traffic.sentBytes})` };
      }
    } else {
      adapterFlowSamples = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const motivo = last?.handshakeAgoS === null
    ? "nenhum handshake WireGuard foi confirmado"
    : (last?.error || "o peer WireGuard não ficou pronto");
  return {
    verified: false,
    state: lastWireSock.state === "disconnected" ? "disconnected" : "unverified",
    source: lastWireSock.source === "none" ? "none" : lastWireSock.source,
    detail: motivo,
  };
}

function linuxStatus(): Promise<string> {
  const now = Date.now();
  if (linuxStatusInFlight) return linuxStatusInFlight;
  if (linuxStatusCache && linuxStatusCache.expiresAt > now) return Promise.resolve(linuxStatusCache.value);
  const generation = ++linuxStatusGeneration;
  const operation = runScript(["--status", "--json"])
    .then(({ code, stdout, stderr }) => {
      if (code !== 0) {
        if (linuxStatusLogAllowed(`exit:${code}`)) {
          discordscan.scriptStatus(code, false);
          discordscan.scriptTrace(`script falhou com code ${code}`);
        }
        return "NOT_FOUND";
      }
      try {
        const data = JSON.parse(stdout);
        if (data?.graphics && typeof data.graphics === "object") {
          const g = data.graphics as Record<string, unknown>;
          ultimosGraficosLinux = `backend=${String(g.backend ?? "?")} wayland=${String(g.waylandDisplay ?? "")} session=${String(g.sessionType ?? "")} portal=${String(g.portal ?? "?")}`;
        }
        const discords = Array.isArray(data.discords) ? data.discords : [];
        const netnsAtivo = data?.netns === true;
        const anyRunning = discords.some((d: { running?: string; inNamespace?: string }) => d.running === "sim" && (!netnsAtivo || d.inNamespace === "sim"));
        const status = discords.length === 0 ? "NOT_FOUND" : (netnsAtivo && anyRunning ? "ACTIVE" : "INACTIVE");
        // O status pode ser consultado por bandeja, janela e watchdog ao mesmo tempo.
        // Registra detalhes somente quando a assinatura muda ou a cada 30s, evitando
        // que a varredura do bootstrap volte a formar um loop de logs.
        const assinatura = JSON.stringify({ status, netns: netnsAtivo, discords: discords.map((d: Record<string, unknown>) => [d.path, d.state, d.running]) });
        if (linuxStatusLogAllowed(assinatura)) {
          const stderrLimpo = stripAnsiCodes(stderr ?? "");
          for (const linha of stderrLimpo.split("\n")) {
            const t = linha.replace(/^[[:space:]]*\[\!\]\s*/, "").trim();
            if (!t || /^(GoLiveBypass standalone|Go Live e camera de volta|CachyOS|Ubuntu|Arch|Fedora|Debian)/.test(t)) continue;
            discordscan.scriptTrace(t);
          }
          const flavours = new Set<string>();
          for (const d of discords) {
            if (typeof d?.path !== "string") continue;
            const extras: { flavour?: string; detected_by?: string; flatpak_id?: string } = {};
            if (typeof d.flavour === "string") { extras.flavour = d.flavour; flavours.add(d.flavour); }
            if (typeof d.detected_by === "string") extras.detected_by = d.detected_by;
            if (typeof d.flatpak_id === "string") extras.flatpak_id = d.flatpak_id;
            discordscan.scriptInstall(d.path, String(d.state ?? "?"), extras);
          }
          ultimosFlavoursLinux = [...flavours].join(",");
          discordscan.scriptStatus(code, true);
        }
        return status;
      } catch {
        if (linuxStatusLogAllowed("json-invalido")) discordscan.scriptJsonInvalido(stdout);
        return "NOT_FOUND";
      }
    })
    .catch((e) => {
      if (linuxStatusLogAllowed("exec-falhou")) {
        discordscan.scriptStatus(-1, false);
        discordscan.scriptTrace(`script nao executou: ${(e as Error)?.message ?? ""}`);
      }
      return "NOT_FOUND";
    })
    .then((value) => {
      if (generation === linuxStatusGeneration) linuxStatusCache = { value, expiresAt: Date.now() + 1000 };
      return value;
    })
    .finally(() => {
      if (linuxStatusInFlight === operation) linuxStatusInFlight = null;
    });
  linuxStatusInFlight = operation;
  return operation;
}

function linuxPreflight(force = false): Promise<LinuxPreflight> {
  const now = Date.now();
  if (!force && linuxPreflightInFlight) return linuxPreflightInFlight;
  if (!force && linuxPreflightCache && linuxPreflightCache.expiresAt > now) return Promise.resolve(linuxPreflightCache.value);
  const operation = runScript(["--preflight", "--json"])
    .then(({ code, stdout, stderr }) => {
      if (code !== 0) throw new Error(tailErroScript(stderr, 4) || "Falha ao verificar as dependências do Linux.");
      return parseLinuxPreflight(stdout);
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false, platform: "linux", distro: "Linux", archLike: false,
        dependencies: { missing: [], required: ["wg", "ip", "curl"] },
        elevation: { available: false, method: "none" }, netns: { available: false },
        kernel: { wireguard: "unknown" }, discord: { found: false, count: 0, firstPath: "" },
        errors: [message], installCommand: "",
      } satisfies LinuxPreflight;
    })
    .then((value) => {
      linuxPreflightCache = { value, expiresAt: Date.now() + 5000 };
      logger.info("linux", "preflight concluido", {
        ok: value.ok,
        missing: value.dependencies.missing.join(","),
        elevation: value.elevation.method,
        netns: value.netns.available,
        discordCount: value.discord.count,
      });
      return value;
    })
    .finally(() => { if (linuxPreflightInFlight === operation) linuxPreflightInFlight = null; });
  linuxPreflightInFlight = operation;
  return operation;
}

// As ultimas linhas do stderr do script viram a mensagem de erro na UI. O ruido imutavel de
// distro imutavel (Bluefin/Bazzite preenchem LD_PRELOAD da sessao: "ERROR: ld.so: object ...
// cannot be preloaded" em cada filho) ocupava o fim do stderr e escondia o erro de verdade
// (issue #108) -- filtrado aqui antes de qualquer tail.
// O standalone colore o stderr com ANSI. Em algumas sessões Wayland/Flatpak o
// byte ESC chega ao Electron como U+FFFD, deixando sequências literais como
// "�[36m" na mensagem. Removemos os dois formatos antes de mostrar o erro.
function stripAnsiCodes(value: string): string {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/(?:\x1b|\u009b)\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\uFFFD?\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function tailErroScript(stderr: string, linhas: number): string {
  const uteis = stripAnsiCodes(stderr)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^ERROR: ld\.so:/.test(l));
  return uteis.slice(-linhas).join("\n");
}

// Explicit activation remains available after a skipped/failed benchmark. Call only
// inside the lifecycle queue, so this fallback cannot overwrite an ongoing selection.
async function ensureProtonActivationProfile() {
  const s = readSharedSettings() as any;
  if ((s.vpnMode || "proton") !== "proton" || fs.existsSync(path.join(settingsDir(), "wireguard.conf"))) return;
  const username = typeof s.protonUsername === "string" ? s.protonUsername : "";
  if (!username) throw new Error("Faça login com sua conta ProtonVPN antes de ativar.");
  const plan = await resolveProtonPlan(username);
  const gen = await proton.generateOptimalProtonConfig(settingsDir(), {
    username,
    countries: s.protonCountry || undefined,
    // Unknown/failed plan checks stay Free-safe. Only an explicit Premium
    // response can expose paid tiers to the selector.
    freeOnly: plan.status !== "premium",
    autoPing: s.protonAutoPing !== false,
    speedTest: false,
  });
  if (!gen.success) throw new Error(gen.error || "Não foi possível preparar uma rota ProtonVPN.");
  updateSharedSettings({ protonLastServer: { ...gen, measurementUsername: username.trim().toLowerCase() } });
}

async function linuxActivate(onChunk: (c: string) => void) {
  let preflight = await linuxPreflight();
  if (!preflight.ok && linuxPreflightRepairable(preflight)) {
    const ensured = await runScript(["--ensure-dependencies"], onChunk);
    if (ensured.code !== 0) {
      throw new Error(tailErroScript(ensured.stderr, 4) || "Não foi possível preparar as dependências do Linux.");
    }
    preflight = await linuxPreflight(true);
  }
  if (!preflight.ok) {
    const comando = preflight.installCommand ? ` Execute: ${preflight.installCommand}` : "";
    throw new Error(`${linuxPreflightMessage(preflight)}${comando}`);
  }
  // Dois cliques da bandeja podem ter lido INACTIVE antes de entrarem na fila.
  // Reconfirma dentro da operação para que o segundo nunca suba uma segunda
  // instância sobre um namespace já ativo.
  if (await linuxStatus() === "ACTIVE") {
    logger.info("linux", "ativacao duplicada ignorada; tunel ja ativo");
    return;
  }
  await ensureProtonActivationProfile();
  updateSharedSettings({ routeMode: "wireguard" });
  const { code, stderr } = await runScript(["--yes", "--cleanup-legacy"], onChunk);
  if (code !== 0) {
    throw new Error(
      tailErroScript(stderr, 3) ||
        "Falha ao ativar",
    );
  }

  // Marca a sessao: se o PC desligar sem o quit limpo, o boot seguinte reverte a injecao
  // que ficou orfa. Os resources sao lidos do --status --json (a injecao no Linux e do
  // script, nao do getDiscordInstalls).
  try {
    const estado = await runScript(["--status", "--json"]);
    const data = JSON.parse(estado.stdout || "{}");
    const nossos = Array.isArray(data?.discords)
      ? data.discords
          .filter((d: { state?: string }) => d?.state === "nosso")
          .map((d: { path?: string }) => d?.path)
          .filter((p: unknown): p is string => typeof p === "string")
      : [];
    if (nossos.length > 0) {
      writeSessionMarker(
        nossos.map((resources) => ({
          flavour: "",
          resources,
          exePath: "",
          bundlePath: undefined,
        } as DiscordInstall)),
      );
    }
  } catch {
    // sem marcador o boot seguinte nao consegue reverter; a injecao orfa fica para a mao
  }
  // Flag de "estava ativo" (o quit limpo do Linux restaura a injecao; o boot
  // seguinte re-injeta pela flag). Zerada so no deactivate explicito.
  updateSharedSettings({ autoInject: false });
  iniciarWgStatsWatchdog(linuxWgStats);
  startLinuxHealthWatchdog();
  linuxStatusCache = null;
  startProtonFailoverMonitor();
}

async function linuxDeactivate(onChunk: (c: string) => void) {
  stopProtonFailoverMonitor();
  const { code, stderr } = await runScript(["--uninstall"], onChunk);
  if (code !== 0) {
    // Sem manter o marker: o disco continua "nosso"; o boot seguinte reverte a orfa assim
    // que o cliente estiver fechado. O erro vai inteiro para a UI (stderr cortado no fim da
    // linha), em vez dos ultimos 3 fragmentos que sumiam com altas linhas longas.
    throw new Error(
      tailErroScript(stderr, 6) ||
        "Falha ao desativar (a elevacao provavelmente falhou)",
    );
  }
  pararWgStatsWatchdog();
  stopLinuxHealthWatchdog();
  clearSessionMarker();
  linuxStatusCache = null;
}

// A bandeja precisa refletir o que os botoes da janela fizeram, entao os handlers de IPC
// tambem remontam o menu ao terminar.
ipcMain.handle("activate", async (event) => {
  if (IS_LINUX) {
    // No Linux, a GUI delega pro script standalone; o script.sh ja tem a heuristica
    // de deteccao de outromod e pede Confirm-Action quando acha Vencord/Equicord
    // (ver golivebypass-standalone.sh). O confirmOverride so faz sentido no fluxo
    // da GUI no Windows/macOS, onde o dialog.showMessageBox roda aqui.
    await withWireSockLifecycle("ativar-linux", () => linuxActivate((c) =>
      event.sender.send("bypass-log", c),
    ));
  } else {
    await activateBypass(event);
  }
  refreshTray().catch(() => {});
});
ipcMain.handle("deactivate", async (event) => {
  // Deactivate EXPLICITO (botao/bandeja): o usuario nao quer mais — zera a flag de
  // auto-injecao do boot. O quit limpo NAO passa aqui (la a injecao e removida mas o
  // usuario so fechou o app; o boot seguinte re-injeta pela flag).
  updateSharedSettings({ autoInject: false });
  if (IS_LINUX) {
    await withWireSockLifecycle("desativar-linux", () => linuxDeactivate((c) => event.sender.send("bypass-log", c)));
  } else {
    await deactivateAll();
  }
  refreshTray().catch(() => {});
});
ipcMain.handle("restore-internet", async () => {
  if (!IS_WINDOWS) return { ok: false, error: "Esta recuperação só está disponível no Windows." };
  return withWireSockLifecycle("restaurar-internet", async () => {
    windowsRouteGeneration += 1;
    windowsRouteStarted = false;
    windowsRouteState = "preparing";
    stopWindowsRouteWatchdog();
    // Releia dentro da fila: uma ativação concorrente pode ter subido o túnel
    // depois da leitura original, e restaurar não pode sair deixando essa sessão
    // viva por causa de um snapshot obsoleto.
    const hadWireSock = isWireSockActive();
    if (hadWireSock) {
      try {
        await killDiscord();
      } catch (error) {
        windowsRouteState = "recovery_required";
        throw error;
      }
    }
    const recovery = await recoverWireSockNetwork();
    windowsRouteState = recovery.ok ? "inactive" : "recovery_required";
    // Nao relancar o Discord enquanto o WFP ainda pode estar instalado ou a
    // resolucao/HTTPS nao foi comprovada saudavel.
    if (hadWireSock && recovery.ok) {
      const restarted = await startDiscordAndConfirm(getDiscordInstalls(), "restaurar-internet");
      if (!restarted) {
        return {
          ...recovery,
          ok: false,
          error: "A rede foi restaurada, mas o Discord não iniciou. Abra o Discord novamente.",
        };
      }
    }
    refreshTray().catch(() => {});
    return recovery;
  });
});
ipcMain.handle("get-platform", () => (IS_LINUX ? "linux" : isMac ? "mac" : "windows"));
ipcMain.handle("get-app-version", () => app.getVersion());
ipcMain.handle("get-status", async () => {
  if (IS_LINUX) return linuxStatus();
  return getStatus();
});
ipcMain.handle("get-linux-preflight", async () => {
  if (!IS_LINUX) return null;
  const preflight = await linuxPreflight();
  return { ...preflight, repairable: linuxPreflightRepairable(preflight) };
});
ipcMain.handle("get-startup", () => getStartup());
ipcMain.handle("set-startup", (_event, enabled: unknown) => {
  const result = setStartup(enabled === true);
  refreshTray().catch(() => {});
  return result;
});

// A pasta compartilhada do bypass — a mesma que o standalone/golivebypass.js e os instaladores
// usam. O XDG_DATA_HOME entra na conta porque o standalone e o plugin ja o respeitam: sem isso,
// quem move essa pasta acabaria com duas configuracoes em lugares diferentes.
function settingsDir() {
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || app.getPath("appData"), "GoLiveBypass");
  }
  const base = process.env.XDG_DATA_HOME || path.join(app.getPath("home"), ".local", "share");
  return path.join(base, "GoLiveBypass");
}

function readProxyFrom(file: string) {
  try {
    if (!fs.existsSync(file)) return "";
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return typeof data.proxy === "string" ? data.proxy : "";
  } catch {
    return "";
  }
}

// ======================================================== reversao de injecao orfa
// O bypass e persistente no disco (app.asar -> _app.asar + pasta-stub) e so volta ao
// normal no quit limpo da GUI. Se o PC desligar no meio (sem o before-quit rodar), a
// injecao fica orfa: o Discord abre injetado e a GUI mostra "Ativo" por engano. Este
// marcador registra o que a sessao injetou; no boot seguinte a GUI reverte o resto.
function markerFile() {
  return path.join(settingsDir(), "session.json");
}

function writeSessionMarker(installs: DiscordInstall[]) {
  try {
    fs.mkdirSync(settingsDir(), { recursive: true });
    fs.writeFileSync(
      markerFile(),
      JSON.stringify({
        pid: process.pid,
        startedAt: Date.now(),
        installs: installs.map((i) => i.resources),
      }),
    );
    // Espelha o log do bypass injetado para a pasta estavel (sobrevive a
    // updates do Discord e a desativacao).
    for (const install of installs) {
      const origem = path.join(install.resources, "app.asar", "golivebypass.log");
      logsDir.espelharLogBypass(origem, app.getPath("home"), process.platform);
    }
  } catch {
    // sem marcador, um desligamento no meio deixaria a injecao orfa; o boot seguinte limpa
  }
}

function clearSessionMarker() {
  try {
    fs.rmSync(markerFile(), { force: true });
  } catch {
    // inofensivo
  }
}

// Ha uma sessao de bypass ativa agora? (marcador escrito na ativacao, limpo no quit limpo).
// Se o app reabre com o marcador, o Discord esta injetado e o watchdog deve retomar a vigia.
function sessaoAtiva(): boolean {
  try {
    return fs.existsSync(markerFile());
  } catch {
    return false;
  }
}

// Reverte injecoes deixadas por uma sessao anterior que morreu sem o quit limpo (PC
// desligado, crash). So mexe onde a injecao e NOSSA, e nao inicia o Discord a toa: se ele
// ja estava aberto (o caso do status falso ativo), fecha, restaura e reabre.
async function revertOrphanedInjection() {
  let data: { installs?: unknown } | null = null;
  try {
    data = JSON.parse(fs.readFileSync(markerFile(), "utf8"));
  } catch {
    // Sem marker nao ha sessao registrada — no Linux ainda conferimos o status abaixo,
    // porque a ativacao pode ter vindo do script standalone (fora da GUI).
    data = null;
  }

  // No Linux a injecao vive no script (com permissoes flatpak/sudo); o --restore reverte
  // sem reabrir o Discord no login. MAS: se o patcher do INSTALL_DIR continua no lugar,
  // a injecao no disco nao e "orfã" — e o bypass persistente sobrevivendo ao boot.
  // Reverter fazia o Discord abrir injetado, a GUI restaura-lo vanilla e o usuario
  // apertar o botao de novo a cada boot sem quit limpo (relato beta 1.1.11-beta.2).
  if (IS_LINUX) {
    const patcherPresente = withNoAsar(() =>
      diskFs.existsSync(path.join(settingsDir(), "golivebypass.js")),
    );
    if (patcherPresente) {
      console.log("[restore] injecao do boot anterior intacta (patcher presente), mantendo");
      return; // mantem o marcador: a sessao continua valida
    }
    clearSessionMarker();
    if (data === null) {
      // A ativacao pode ter vindo do script standalone (fora da GUI), sem marker nenhum.
      // O status e a fonte da verdade: "nosso" parado no disco (nenhum cliente aberto) e
      // orfa e o boot limpa; com cliente aberto (ACTIVE) ou outro mod no lugar, nao mexe.
      const status = await linuxStatus().catch(() => "NOT_FOUND");
      if (status === "ACTIVE" || status === "OTHER_MOD" || status === "NOT_FOUND") return;
    }
    const { code, stderr } = await runScript(["--restore"]);
    if (code !== 0) {
      console.error("[restore] falha ao reverter injecao orfa:", stderr);
    }
    return;
  }

  if (!Array.isArray(data?.installs) || data.installs.length === 0) return;

  const resourcesList = data.installs.filter((r): r is string => typeof r === "string");
  if (resourcesList.length === 0) return;

  const atuais = getDiscordInstalls();
  const alvos: DiscordInstall[] = [];
  let intactas = 0;
  for (const resources of resourcesList) {
    const install =
      atuais.find((a) => a.resources === resources) ??
      ({ flavour: "", resources, exePath: "", bundlePath: undefined } as DiscordInstall);
    // So age onde a injecao ainda e a nossa (outro mod tomou o lugar = nao mexe).
    const temOriginal = withNoAsar(() => diskFs.existsSync(path.join(resources, "_app.asar")));
    if (!temOriginal || !isOurInjection(resources)) continue;
    // A injecao no Windows e autocontida (stub + patcher + settings dentro do asar):
    // se os arquivos internos estao la, ela nao e "orfã" — e o bypass persistente
    // sobrevivendo ao boot sem quit limpo. Reverter fazia o Discord abrir injetado,
    // a GUI restaura-lo vanilla e o usuario apertar o botao de novo a cada boot
    // (relato beta 1.1.11-beta.2). So reverte quando os arquivos quebrarem de verdade
    // (escrita parcial num crash, por exemplo).
    const intacta = withNoAsar(() => {
      try {
        const bypassJs = diskFs.statSync(path.join(resources, "app.asar", "golivebypass.js"));
        return bypassJs.isFile() && bypassJs.size > 1024 &&
          diskFs.existsSync(path.join(resources, "app.asar", "settings.json"));
      } catch {
        return false;
      }
    });
    if (intacta) {
      intactas++;
      console.log("[restore] injecao do boot anterior intacta, mantendo:", resources);
      continue;
    }
    alvos.push(install);
  }

  if (alvos.length === 0) {
    // Nada quebrado para reverter. Se havia injecao nossa intacta, o marcador
    // permanece: a sessao continua valida para um boot futuro que ache problemas.
    if (intactas === 0) clearSessionMarker();
    return;
  }

  const estavaRodando = discordIsRunning();
  if (estavaRodando) await killDiscord();

  for (const install of alvos) {
    const asar = path.join(install.resources, "app.asar");
    const originalAsar = path.join(install.resources, "_app.asar");
    try {
      await safeRemove(asar);
      await safeRename(originalAsar, asar);
      clearBundleQuarantine(install.bundlePath);
      console.log("[restore] injecao orfa revertida:", install.resources);
    } catch (error) {
      console.error("[restore] nao consegui reverter:", install.resources, error);
    }
  }

  clearSessionMarker();
  if (estavaRodando) {
    for (const install of alvos) startDiscord(install);
  }
}

// =============================================================================== Tor embutido
// O "modo Tor" da GUI pode funcionar sem o Tor instalado: baixa o daemon oficial do
// Tor Project, extrai para a pasta do GoLiveBypass e sobe como processo filho.
//
// O asset com o daemon SOZINHO (sem o navegador inteiro) e o "expert bundle" — hospedado no
// archive oficial (archive.torproject.org), versao "13.5", que foi a ultima serie a publicar
// esse pacote (~31MB, com geoip e as libs compartilhadas do tor). O dist.torproject.org
// atual (15.x/16.x) so publica o navegador inteiro (~137MB), pesado demais para isso.

const TOR_BUNDLE = "13.5";
const TOR_PORTA = 9060; // dedicada, para nao conflitar com um Tor do sistema (9050)

function torDir() {
  return path.join(settingsDir(), "tor");
}

function torExePath() {
  // Estrutura do expert bundle: <dir>/tor/tor (tor.exe no Windows) + libs ao lado.
  return process.platform === "win32"
    ? path.join(torDir(), "tor", "tor.exe")
    : path.join(torDir(), "tor", "tor");
}

// sha256 de cada pacote, do sha256sums-unsigned-build.txt publicado pelo Tor Project junto da
// serie 13.5. A versao esta fixada, entao estes arquivos nao mudam mais e o hash pode morar
// aqui. Sem esta conferencia o app baixava um .tar.gz, dava chmod +x e executava o que viesse:
// bastaria o archive sair do ar e um certificado indevido para virar execucao de codigo em
// quem usa o modo Tor. Ao trocar TOR_BUNDLE, troque os quatro hashes junto.
const TOR_SHA256: Record<string, string> = {
  "tor-expert-bundle-linux-x86_64-13.5.tar.gz":
    "147158f33c5f2c539d58d8fab69ca5af384778e7bbae951fbc7ac8ca58ac4e0d",
  "tor-expert-bundle-windows-x86_64-13.5.tar.gz":
    "5978ccc2a7fed783c329474888e87f5e6349aa132d9c43016418bff296c7becb",
  "tor-expert-bundle-macos-aarch64-13.5.tar.gz":
    "e18f749fbe6114c918735e950b28c1f476a5c9d8bf224f5ec26e6bffa1222d49",
  "tor-expert-bundle-macos-x86_64-13.5.tar.gz":
    "9e23c21a4e45dc45b599e723373530ef7cabef106367b43677a534fae099b10d",
};

// URL e hash saem juntos de proposito: separados, era facil trocar um e esquecer o outro.
function torAsset(): { url: string; sha256: string | undefined; nome: string } {
  const base = "https://archive.torproject.org/tor-package-archive/torbrowser";
  let nome: string;
  if (process.platform === "win32") {
    nome = `tor-expert-bundle-windows-x86_64-${TOR_BUNDLE}.tar.gz`;
  } else if (process.platform === "darwin") {
    const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
    nome = `tor-expert-bundle-macos-${arch}-${TOR_BUNDLE}.tar.gz`;
  } else {
    nome = `tor-expert-bundle-linux-x86_64-${TOR_BUNDLE}.tar.gz`;
  }
  return { url: `${base}/${TOR_BUNDLE}/${nome}`, sha256: TOR_SHA256[nome], nome };
}

// Estado do processo Tor embutido. A GUI sobe um Tor proprio quando o modo pede e nao ha
// Tor do sistema; ele morre junto com o app (will-quit).
let torProcess: ReturnType<typeof spawn> | null = null;

// Uma porta especifica esta atendendo? O torJaAtendendo varre a lista toda; este responde
// sobre uma porta so, que e o que o spawnTor precisa saber antes de subir um daemon.
function portaViva(porta: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const s = require("net").connect({ host: "127.0.0.1", port: porta });
    const fim = (v: boolean) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(timeoutMs, () => fim(false));
    s.on("connect", () => fim(true));
    s.on("error", () => fim(false));
  });
}

// O host que o bypass realmente vai rotear. Testar contra ele e nao contra um site qualquer:
// o que interessa e se o Tor abre ESTE caminho.
const TOR_ALVO_HOST = "gateway.discord.gg";
const TOR_ALVO_PORTA = 443;

// O portaViva so prova que alguma coisa escuta ali. Isso nao basta para liberar o modo Tor:
// um Tor a meio bootstrap aceita a conexao e recusa o CONNECT, e um servico qualquer na 9050
// nem fala SOCKS. Aqui a pergunta e a que importa -- este proxy consegue ABRIR um tunel ate o
// gateway do Discord? So com um sim o modo Tor entra em uso.
function torEntregando(porta: number, timeoutMs = 20_000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = require("net").connect({ host: "127.0.0.1", port: porta });
    let etapa: "saudacao" | "conexao" = "saudacao";
    let buf = Buffer.alloc(0);
    const inicio = Date.now();

    const fim = (v: boolean, motivo?: string) => {
      s.removeAllListeners();
      s.destroy();
      if (v) netevents.torTunelVerificado(Date.now() - inicio, porta);
      else netevents.tunelRecusado(porta, 0, 0, motivo);
      resolve(v);
    };

    s.setTimeout(timeoutMs, () => fim(false, `timeout (${timeoutMs}ms)`));
    s.on("error", (e) => fim(false, (e as Error & { code?: string })?.code ?? (e as Error)?.message));
    // Uma saida que aceita e fecha limpo no meio nao gera erro: FIN nao e erro. Sem isto o
    // retorno so viria quando o prazo estourasse.
    s.on("close", () => fim(false, "fechou antes do veredito"));

    s.on("connect", () => {
      // SOCKS5, uma unica forma de autenticacao: nenhuma.
      s.write(Buffer.from([0x05, 0x01, 0x00]));
    });

    s.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);

      if (etapa === "saudacao") {
        if (buf.length < 2) return;
        // 0x05 0x00 = SOCKS5 e sem autenticacao. Qualquer outra coisa nao e um Tor utilizavel.
        if (buf[0] !== 0x05 || buf[1] !== 0x00) {
          return fim(false, `saudacao invalida (0x${buf[1].toString(16)})`);
        }

        etapa = "conexao";
        buf = buf.subarray(2);

        const host = Buffer.from(TOR_ALVO_HOST, "utf8");
        const pedido = Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]),
          host,
          Buffer.from([(TOR_ALVO_PORTA >> 8) & 0xff, TOR_ALVO_PORTA & 0xff]),
        ]);
        s.write(pedido);
        return;
      }

      // Resposta do CONNECT: o segundo byte e o veredito, 0x00 = tunel aberto. Um Tor que
      // ainda nao tem circuito responde aqui com falha, que e exatamente o caso que queremos
      // pegar antes de dizer que o modo Tor esta pronto.
      if (buf.length < 2) return;
      fim(
        buf[0] === 0x05 && buf[1] === 0x00,
        buf[1] === 0x00 ? undefined : `CONNECT recusado (0x${buf[1].toString(16)})`,
      );
    });
  });
}

// Portas onde um Tor costuma atender, na ordem em que preferimos: a nossa primeiro, depois
// o servico do sistema (9050) e o Tor Browser (9150). Se qualquer uma responde, ja existe um
// Tor de pe nesta maquina e nao ha por que baixar nem subir outro.
const TOR_PORTAS = [TOR_PORTA, 9050, 9150, 9250, 9052];

// Porta do Tor que estamos realmente usando. Comeca na nossa e passa a ser a de um Tor ja
// existente quando encontramos um -- e esta que vai escrita no settings.json que o bypass le.
let torPortaEmUso = TOR_PORTA;
// Ja confirmamos um tunel de verdade por esta porta? O status da janela usa isto: sem a
// flag, so um connect TCP nao distingue Tor pronto de porta ocupada por outra coisa, e o
// teste de tunel e caro demais para rodar a cada atualizacao da tela.
let torVerificado = false;

// Em duas etapas de proposito: o portaViva e barato (400ms) e descarta as portas fechadas
// sem custo; so quem atende paga o teste do tunel, que e caro mas e o unico que prova que o
// Tor esta utilizavel. Varrer as cinco portas com o teste caro levaria mais de um minuto.
async function torJaAtendendo(): Promise<number | null> {
  for (const porta of TOR_PORTAS) {
    if (!(await portaViva(porta))) continue;
    if (await torEntregando(porta)) return porta;
    console.log(`[tor] a porta ${porta} atende mas nao abriu tunel; nao serve`);
  }
  return null;
}

// Um tor instalado no sistema (pacote da distro, brew, ou no PATH do Windows). Serve para
// subir sem baixar nada: o binario ja esta ai, so nao esta rodando.
function torDoSistema(): string | null {
  const cmd = process.platform === "win32" ? "where" : "which";
  try {
    const out = execFileSync(cmd, ["tor"], { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] });
    // EOL do modulo os: o where do Windows separa com CRLF e o which do Linux com LF.
    const linha = out.split(EOL).map((l) => l.trim()).find((l) => l !== "");
    return linha && fs.existsSync(linha) ? linha : null;
  } catch {
    return null;
  }
}

// Deixa um Tor utilizavel de pe, na ordem mais barata possivel:
//   1. ja ha um atendendo (nosso de uma sessao anterior, servico do sistema, Tor Browser)
//   2. o nosso ja esta extraido -> so sobe
//   3. ha um tor instalado no sistema -> sobe esse, sem baixar 22MB
//   4. so entao baixa o pacote oficial
// Devolve a porta em uso, para o settings.json apontar para o Tor certo.
// Uma passada: usa o que ja existe, ou tenta subir, ou baixa. Sem repeticao -- quem repete e
// o garantirTor.
async function tentarTor(): Promise<{ ok: boolean; porta?: number; error?: string }> {
  const atendendo = await torJaAtendendo();
  if (atendendo !== null) {
    torPortaEmUso = atendendo;
    torVerificado = true;
    console.log(`[tor] ja ha um Tor atendendo na porta ${atendendo} -- usando ele`);
    return { ok: true, porta: atendendo };
  }

  if (fs.existsSync(torExePath()) && (await spawnTor())) {
    torPortaEmUso = TOR_PORTA;
    torVerificado = true;
    return { ok: true, porta: TOR_PORTA };
  }

  const doSistema = torDoSistema();
  if (doSistema !== null) {
    console.log("[tor] usando o tor instalado no sistema:", doSistema);
    if (await spawnTor(doSistema)) {
      torPortaEmUso = TOR_PORTA;
      torVerificado = true;
      return { ok: true, porta: TOR_PORTA };
    }
  }

  const baixado = await ensureTor();
  if (!baixado.ok) return { ok: false, error: baixado.error };
  if (await spawnTor()) {
    torPortaEmUso = TOR_PORTA;
    torVerificado = true;
    return { ok: true, porta: TOR_PORTA };
  }
  return { ok: false, error: "o Tor nao completou o bootstrap" };
}

// Espera entre as tentativas, crescendo: um bootstrap que falhou por rede ruim costuma dar
// certo logo depois, e insistir de segundo em segundo so gastaria banda e CPU.
const TOR_ESPERAS_MS = [3_000, 8_000, 20_000];
let torTentandoEmFundo = false;

// Continua tentando depois que as tentativas imediatas falharam. Roda sozinho, sem segurar a
// janela: o status da tela consulta a cada 5s e passa a "pronto" quando isto der certo.
function tentarTorEmFundo() {
  if (torTentandoEmFundo) return;
  torTentandoEmFundo = true;

  const proxima = async (espera: number) => {
    await new Promise((r) => setTimeout(r, espera));

    // A pessoa pode ter trocado de modo enquanto esperavamos; ai nao ha mais o que insistir.
    if (readNetMode() !== "tor") {
      torTentandoEmFundo = false;
      return;
    }

    const r = await tentarTor();
    if (r.ok) {
      console.log(`[tor] subiu na tentativa em segundo plano (porta ${r.porta})`);
      torTentandoEmFundo = false;
      return;
    }

    console.warn("[tor] ainda nao subiu:", r.error, "-- tentando de novo");
    // O ultimo intervalo se repete: a insistencia nao acaba, so espaca. Um Tor que so vai
    // subir quando a internet voltar precisa que alguem continue tentando.
    void proxima(TOR_ESPERAS_MS[TOR_ESPERAS_MS.length - 1]);
  };

  void proxima(TOR_ESPERAS_MS[TOR_ESPERAS_MS.length - 1]);
}

// Deixa um Tor utilizavel de pe. Tenta algumas vezes seguidas antes de desistir da chamada, e
// mesmo desistindo deixa uma insistencia rodando em segundo plano -- falhar uma vez costuma
// ser rede ruim ou um bootstrap que demorou, nao uma maquina onde o Tor nunca vai funcionar.
// Singleton da promessa: chamadas concorrentes (whenReady + autoInject do boot,
// watchdog + botao) rodavam tentarTor em PARALELO — dois tor.exe nasciam, um
// perdia a porta e morria com "[err] Reading config failed" no log (relato da
// issue #129). Todos os chamadores agora esperam a mesma corrida.
let garantirTorEmCurso: Promise<{ ok: boolean; porta?: number; error?: string }> | null = null;
function garantirTor(): Promise<{ ok: boolean; porta?: number; error?: string }> {
  if (garantirTorEmCurso) return garantirTorEmCurso;
  garantirTorEmCurso = garantirTorUmaVez().finally(() => {
    garantirTorEmCurso = null;
  });
  return garantirTorEmCurso;
}

async function garantirTorUmaVez(): Promise<{ ok: boolean; porta?: number; error?: string }> {
  let ultimo: { ok: boolean; porta?: number; error?: string } = {
    ok: false,
    error: "nao consegui preparar o Tor",
  };

  for (let i = 0; i < TOR_ESPERAS_MS.length; i++) {
    ultimo = await tentarTor();
    if (ultimo.ok) return ultimo;

    const espera = TOR_ESPERAS_MS[i];
    console.warn(
      `[tor] tentativa ${i + 1} de ${TOR_ESPERAS_MS.length} falhou (${ultimo.error}); ` +
        `nova tentativa em ${Math.round(espera / 1000)}s`,
    );
    await new Promise((r) => setTimeout(r, espera));
  }

  const derradeira = await tentarTor();
  if (derradeira.ok) return derradeira;

  tentarTorEmFundo();
  return {
    ok: false,
    error: (derradeira.error ?? ultimo.error) + " (continuo tentando em segundo plano)",
  };
}


async function spawnTor(binario?: string): Promise<boolean> {
  // Um tor nosso pode ter sobrevivido a uma sessao anterior morta sem quit limpo: ele so morre
  // no stopTor. Subir um segundo sempre falha -- a porta esta ocupada e o DataDirectory tem
  // lock -- e o erro chegava na tela como "o Tor baixou mas nao subiu", com o tor.exe vivo no
  // gerenciador de tarefas. Se a porta ja atende, o daemon que existe serve.
  if ((await portaViva(TOR_PORTA)) && (await torEntregando(TOR_PORTA))) {
    console.log("[tor] ja havia um Tor entregando na porta", TOR_PORTA, "-- reaproveitado");
    return true;
  }

  return new Promise((resolve) => {
    // Sem argumento e o nosso, baixado; com argumento e um tor do sistema, que sobe com o
    // mesmo torrc e na mesma porta nossa.
    const exe = binario ?? torExePath();
    const dir = torDir();
    if (!fs.existsSync(exe)) return resolve(false);

    const dataDir = path.join(dir, "data-state");
    fs.mkdirSync(dataDir, { recursive: true });

    // Os geoip vieram do pacote; o tor quebra sem eles ao validar o pais da saida.
    const geoip = path.join(dir, "data", "geoip");
    const geoip6 = path.join(dir, "data", "geoip6");

    // O torrc e gerado aqui: config minima para um relay de saida SOCKS no loopback.
    const torrc = path.join(dir, "torrc");
    fs.writeFileSync(
      torrc,
      `SocksPort ${TOR_PORTA}\n` +
        `DataDirectory ${dataDir}\n` +
        // Os geoip so entram se vieram no nosso pacote: um tor instalado no sistema traz os
        // dele, e apontar para um caminho que nao existe faz o daemon recusar a config.
        (fs.existsSync(geoip) && fs.existsSync(geoip6)
          ? `GeoIPFile ${geoip}\nGeoIPv6File ${geoip6}\n`
          : "") +
        `Log notice stdout\n`,
    );

    // As libs (libevent/libssl/libcrypto) vieram empacotadas ao lado do binario; sem
    // apontar para elas o tor nao acha libevent. No macOS o DYLD e meio limitado pelo SIP,
    // mas vale tentar antes de exigir brew.
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (process.platform === "linux") {
      env.LD_LIBRARY_PATH = path.join(dir, "tor");
    } else if (process.platform === "darwin") {
      env.DYLD_LIBRARY_PATH = path.join(dir, "tor");
    }

    let bootstrapOk = false;
    const proc = spawn(exe, ["-f", torrc], {
      stdio: ["ignore", "pipe", "pipe"],
      env,
      windowsHide: true,
    });

    torProcess = proc;

    const onData = (buf: Buffer) => {
      const text = buf.toString();
      if (text.includes("Bootstrapped 100%") && !bootstrapOk) {
        bootstrapOk = true;
        // O "Bootstrapped 100%" e o que o Tor ACHA de si mesmo; nao e prova de que o SOCKS ja
        // aceita um CONNECT. Antes de dar o modo Tor como pronto, abrimos um tunel de verdade
        // ate o gateway -- e so ele libera. Sem isto o bypass era ligado apontando para uma
        // porta que ainda recusava conexao, e o Discord ficava sem conectar.
        void (async () => {
          for (let tentativa = 1; tentativa <= 3; tentativa++) {
            if (await torEntregando(TOR_PORTA)) {
              console.log("[tor] tunel confirmado ate o gateway; modo Tor liberado");
              return resolve(true);
            }
            console.log(`[tor] bootstrap pronto mas o tunel ainda nao abriu (${tentativa}/3)`);
          }
          console.error("[tor] o Tor subiu mas nao abriu tunel ate o gateway");
          resolve(false);
        })();
      }
      console.log("[tor]", text.trim().split("\n").slice(-1)[0]);
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    proc.on("error", (err) => {
      console.error("[tor] erro ao subir:", err.message);
      resolve(false);
    });
    proc.on("exit", (code) => {
      torProcess = null;
      if (!bootstrapOk) resolve(false);
    });

    // Se nao completar o bootstrap em 90s, desiste.
    setTimeout(() => {
      if (!bootstrapOk && torProcess === proc) resolve(false);
    }, 90_000);
  });
}

function stopTor() {
  if (torProcess) {
    try {
      torProcess.kill();
    } catch {
      // ja morreu
    }
    torProcess = null;
    // O que estava verificado era este daemon; sem ele a tela nao pode dizer "pronto".
    torVerificado = false;
  }
}

// =========================================================================== watchdog do Tor
// Vigia o daemon da porta 9060 durante a sessao (modo tor). Se ele morre/trava no meio,
// ressuscita na MESMA porta (sem trocar de saida) e avisa que um Ctrl+R pode ser preciso.
// Ver AGENTS.md: trocar de saida por RTT e sempre pior; so recuperar a morte real.

let torWatchdog: TorWatchdog | null = null;
let torWatchdogTimer: ReturnType<typeof setInterval> | null = null;
let torWatchdogRecuperando = false;

function criarTorWatchdog(): TorWatchdog {
  return createTorWatchdog({
    portaViva,
    torEntregando,
  });
}

function torWatchdogIniciar() {
  if (readNetMode() !== "tor") return;
  if (torWatchdog === null) torWatchdog = criarTorWatchdog();
  torWatchdog.setActive(true);
  if (torWatchdogTimer !== null) return;
  torWatchdogTimer = setInterval(() => {
    void torWatchdog!.check().then((acao) => {
      if (acao !== "restart" || torWatchdogRecuperando) return;
      console.warn("[tor] watchdog: daemon morreu/travou na porta em uso; ressuscitando");
      void torWatchdogRecuperar();
    });
  }, TOR_WATCHDOG_PORT_MS);
}

function torWatchdogParar() {
  if (torWatchdog !== null) torWatchdog.setActive(false);
  if (torWatchdogTimer !== null) {
    clearInterval(torWatchdogTimer);
    torWatchdogTimer = null;
  }
}

async function torWatchdogRecuperar() {
  // O poll da porta e curto para uma morte real. Bootstrap do Tor, porem, pode
  // levar dezenas de segundos; sem esta trava cada tick tentaria spawnar outro
  // daemon sobre o primeiro e transformaria uma recuperacao em corrida.
  if (torWatchdogRecuperando) return;
  // A insistencia de fundo (tentarTorEmFundo) e OUTRO chamador de garantirTor()/spawnTor()
  // fora do singleton de promessa (garantirTorEmCurso ja se resolveu quando ela comeca a
  // rodar sozinha). Se o watchdog passou a vigiar exatamente numa janela em que essa
  // insistencia ja esta tentando (ex.: a GUI reabriu com a injecao ja ativa no disco --
  // ver o fix do rearranque do watchdog -- mas o garantirTor() do boot falhou e caiu para
  // background), chamar garantirTor() aqui rodaria em paralelo com ela: dois spawnTor()
  // concorrentes checam a porta livre ao mesmo tempo e podem spawnar dois tor.exe (o
  // "Address already in use" da issue #51, so que por um caminho novo). A insistencia de
  // fundo ja esta cobrindo a recuperacao; o watchdog so precisa esperar o proximo tick.
  if (torTentandoEmFundo) {
    console.log("[tor] watchdog: insistencia de fundo ja tentando; aguardando o proximo tick em vez de correr junto");
    return;
  }
  torWatchdogRecuperando = true;
  try {
    // Mata o daemon zumbi ANTES de tentar subir de novo: spawnTor so funciona com a porta
    // livre, e o erro era "Address already in use" (issue #51) quando so ressuscitava por cima.
    stopTor();
    const r = await garantirTor();
    if (r.ok) {
      saveTorAddr(`127.0.0.1:${r.porta}`);
      console.log("[tor] watchdog: Tor de volta na porta", r.porta);
      avisarTorReiniciado();
    } else {
      console.warn("[tor] watchdog: nao consegui ressuscitar:", r.error);
    }
  } catch (error) {
    console.error("[tor] watchdog: falha ao recuperar:", error);
  } finally {
    torWatchdogRecuperando = false;
  }
}

// Toast na janela: a reconexao do gateway no meio de uma call costuma travar o video ate um
// Ctrl+R. Avisar isso e melhor do que fingir que nao aconteceu (armadilha conhecida).
function avisarTorReiniciado() {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("tor-watchdog-recuperado");
    }
  } catch {
    // janela fechada na bandeja: sem toast, sem problema
  }
}
// =========================================================================== /watchdog

// Baixa e extrai o Tor embutido, se preciso. Devolve true quando o binario existe.
async function ensureTor(): Promise<{ ok: boolean; error?: string }> {
  try {
    const exe = torExePath();
    if (fs.existsSync(exe)) return { ok: true };

    const dir = torDir();
    fs.mkdirSync(dir, { recursive: true });

    const { url, sha256, nome } = torAsset();
    const destino = path.join(dir, "tor-expert-bundle.tar.gz");

    // Sem hash conhecido nao ha o que conferir, e o que vem depois e um binario que este app
    // executa. Melhor falhar e dizer o porque do que rodar as cegas.
    if (sha256 === undefined) {
      return { ok: false, error: `sem sha256 conhecido para ${nome}` };
    }

    // Baixa com fetch (Node 18+/Electron tem fetch nativo). Erros de rede do
    // download sao a causa n.1 de "modo Tor nao sobe" — logs com errno/code.
    const res = await netevents.comLogRede("tor.download", () => fetch(url));
    if (!res.ok) {
      netevents.socksFalha(`download do Tor falhou (HTTP ${res.status})`);
      return { ok: false, error: `falha no download (HTTP ${res.status})` };
    }
    const buf = Buffer.from(await res.arrayBuffer());

    // Conferido ANTES de gravar e extrair: o que sai daqui recebe permissao de execucao e sobe
    // como processo filho, entao este e o unico ponto em que ainda da para recusar.
    const obtido = createHash("sha256").update(buf).digest("hex");
    if (obtido !== sha256) {
      return {
        ok: false,
        error: `o pacote do Tor nao confere (esperado ${sha256}, obtido ${obtido})`,
      };
    }

    fs.writeFileSync(destino, buf);

    // Deixa de fora o que o modo Tor nao usa, e leva o resto INTEIRO.
    //
    // Fora: os pluggable transports (lyrebird, snowflake, conjure), que nada aqui chama -- o
    // torrc gerado nao tem bridge nenhuma -- e que sao justamente os que o Windows Defender
    // poe em quarentena como HackTool/Tor. Com eles no meio, o tar terminava com codigo != 0
    // por nao conseguir grava-los e a limpeza ainda mascarava o motivo com um EPERM. Fora
    // tambem o debug/, que e uma copia com simbolos e so ocupa espaco.
    //
    // Dentro: tudo o que sobra de data/ e tor/. Listar os membros um a um (o que eu fiz antes)
    // funcionava no Windows, onde o tor.exe e autossuficiente, mas quebrava no Linux e no
    // macOS: ali o pacote traz libcrypto/libssl/libevent/libstdc++ ao lado do binario, e sem
    // elas o daemon nao sobe -- exatamente o "o Tor baixou mas nao subiu".
    const filtros = ["--exclude", "tor/pluggable_transports/*", "--exclude", "debug/*"];

    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        const p = spawn("tar", ["-xzf", destino, "-C", dir, ...filtros, "data", "tor"]);
        p.on("exit", resolve);
        p.on("error", reject);
      });

      // Vale o que chegou no disco, nao o codigo de saida: um antivirus que remova um arquivo
      // extra faz o tar reclamar sem que falte nada do que importa.
      if (!fs.existsSync(exe) || !fs.existsSync(path.join(dir, "data", "geoip"))) {
        throw new Error(
          code === 0
            ? "binario ou geoip nao encontrados apos extrair"
            : `a extracao falhou (tar saiu com ${code}) -- um antivirus pode ter bloqueado o tor`,
        );
      }
    } catch (error) {
      // A limpeza nao pode mascarar o erro de verdade: o EPERM dela era o que a pessoa via,
      // no lugar do motivo real.
      try {
        fs.rmSync(path.join(dir, "tor"), { recursive: true, force: true });
        fs.rmSync(path.join(dir, "data"), { recursive: true, force: true });
      } catch {
        // arquivo presos pelo antivirus; o proximo ensureTor tenta de novo
      }
      throw error;
    }

    fs.rmSync(destino, { force: true });

    // Garante permissao de execucao (o tar pode nao trazer).
    try {
      fs.chmodSync(exe, 0o755);
    } catch {
      // windows: chmod nao aplica
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// Leitura do settings.json compartilhado (o MESMO arquivo que o runtime injetado le no
// Linux). Objeto vazio quando nao existe ou e invalido -- mesmo contrato do runtime.
function readSharedSettings(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(path.join(settingsDir(), "settings.json"), "utf8"));
  } catch {
    return {};
  }
}

// Escrita por merge no settings.json compartilhado, atomica (tmp + rename). TODAS as
// preferencias da GUI que vivem nesse arquivo passam por aqui: um escritor parcial
// (o saveTorAddr antigo criava o arquivo so com torAddr) apagava a routeMode e o
// runtime injetado nascia "auto" enquanto a GUI mostrava Tor (issue #108).
function updateSharedSettings(patch: Record<string, unknown>): boolean {
  try {
    const dir = settingsDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "settings.json");
    // O runtime Linux le este arquivo e Windows/mac leem a copia injetada.
    // A preferencia legada false nunca pode voltar a desligar a recuperacao.
    const novo = { ...readSharedSettings(), ...patch, routeMode: "wireguard", autoRevive: true } as Record<string, unknown>;
    // PAC/SOCKS/Tor era estado exclusivo do mecanismo removido. A migracao
    // preserva a conta Proton, o .conf e as preferencias da aplicacao.
    delete novo.proxy;
    delete novo.torAddr;
    delete novo.torPort;
    // Tmp + rename: um crash no meio da escrita nao pode deixar um settings.json
    // pela metade, senao o modo se perderia de novo por outro caminho.
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(novo, null, 4));
    fs.renameSync(tmp, file);
    return true;
  } catch (error) {
    console.error("[settings] nao consegui gravar o settings.json compartilhado:", error);
    logger.error("settings", "falha ao persistir preferencias", {
      arquivo: path.join(settingsDir(), "settings.json"),
      erro: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

function recoverProtonUsername(): string {
  const saved = proton.getSavedSessionUsername(settingsDir());
  if (!saved) return "";
  const current = readSharedSettings().protonUsername;
  if (current !== saved) {
    invalidateProtonPlanCache();
    if (updateSharedSettings({ protonUsername: saved })) {
      logger.info("proton", "identidade recuperada da sessao persistida");
    } else {
      logger.warn("proton", "sessao encontrada, mas nao consegui reparar o usuario salvo");
    }
  }
  return saved;
}

// Guardado fora da pasta do Discord de proposito: o settings.json que o bypass le vive dentro do
// app.asar injetado (Windows/macOS) ou vem daqui (Linux), e esse some quando o bypass e
// desativado ou quando o Discord se atualiza. A copia daqui e a configuracao da pessoa, e
// sobrevive aos dois.
function saveProxy(proxy: string) {
  updateSharedSettings({ proxy });
}

// Porta do Tor que o script standalone (Linux) deve usar. So chamada depois de garantirTor()
// confirmar um tunel de verdade -- sem isto, torAddr no settings.json real fica preso na porta
// de uma sessao anterior e o gateway trava esperando uma saida que nao existe mais.
// No Windows/macOS, tambem reescreve o settings.json dentro dos asars injetados existentes
// para que o Discord ativo aponte para a porta real imediatamente sem precisar de reinjecao.
function saveTorAddr(addr: string) {
  updateSharedSettings({ torAddr: addr });
  reescreverSettingsInjetado({ torAddr: addr });
}

// Modo de rede escolhido (persistido no settings.json junto da proxy): "auto" | "tor" | "free".
// "auto" com proxy preenchida = personalizado (o bypass usa a proxy do campo). O PADRAO e
// "tor": o app baixa e usa o Tor sempre, para nunca cair no IP brasileiro.
function saveNetMode(mode: string) {
  updateSharedSettings({ routeMode: IS_WINDOWS ? "wireguard" : mode });
}

function readNetMode(): string {
  if (IS_WINDOWS) return "wireguard";
  try {
    const file = path.join(settingsDir(), "settings.json");
    // Padrao "tor". Saida gratuita e instavel por natureza -- morre no meio da sessao, tem RTT
    // alto e obriga o pool a ficar trocando -- enquanto o Tor entrega uma rota que fica de pe.
    // O custo aparece so na primeira vez (o pacote de 22MB e o bootstrap), e o modo agora so e
    // liberado depois de um tunel provado, entao o Discord nao nasce apontando para uma porta
    // que ainda nao serve.
    if (!fs.existsSync(file)) return "tor";
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    const m = typeof data.routeMode === "string" ? data.routeMode : "";
    if (m === "tor" || m === "free" || m === "auto") return m;
    return "tor";
  } catch {
    return "tor";
  }
}

export function saveAutoUpdate(enabled: boolean) {
  updateSharedSettings({ autoUpdate: enabled });
}

export function readAutoUpdate(): boolean {
  try {
    const file = path.join(settingsDir(), "settings.json");
    if (!fs.existsSync(file)) return true;
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return typeof data.autoUpdate === "boolean" ? data.autoUpdate : true;
  } catch {
    return true;
  }
}

// Canal de atualizacao: "stable" (padrao) ou "beta" (opt-in dos testadores —
// recebe as prereleases publicadas; o canal estavel nunca as ve). Consumido pelo
// updater: Windows le VIVO a cada checagem, Linux le no boot (electron-updater
// checa uma vez por sessao).
export function saveUpdateChannel(canal: string) {
  updateSharedSettings({ updateChannel: canal === "beta" ? "beta" : "stable" });
}

export function readUpdateChannel(): "stable" | "beta" {
  try {
    const file = path.join(settingsDir(), "settings.json");
    if (!fs.existsSync(file)) return "stable";
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return data.updateChannel === "beta" ? "beta" : "stable";
  } catch {
    return "stable";
  }
}

// Detecta Tor disponivel: o embutido (porta dedicada) ou um Tor do sistema (portas classicas).

// IPC de autoUpdate
ipcMain.handle("get-auto-update", () => readAutoUpdate());
ipcMain.handle("set-auto-update", (_event, enabled: unknown) => {
  const enabledValue = enabled !== false;
  saveAutoUpdate(enabledValue);
  updaterController?.setEnabled(enabledValue);
  refreshTray().catch(() => {});
});

// IPC do canal de atualizacao (stable | beta). Nao vai para o asar injetado: e
// preferencia do updater da GUI, o bypass injetado nao lê isso.
ipcMain.handle("get-update-channel", () => readUpdateChannel());
ipcMain.handle("set-update-channel", (_event, canal: unknown) => {
  saveUpdateChannel(typeof canal === "string" ? canal : "stable");
  updaterController?.setChannel(readUpdateChannel());
});

// ------------------------------------------------------------------ teste de proxy (Personalizado / VPS)
// A mesma pergunta do Tor: esta saida abre tunel ate o gateway? Sem isto a pessoa cola um
// endereco errado, ativa o bypass e o Discord fica carregando sem saber por que.

const PROXY_URL_RE =
  /^(socks5|socks4|http|https):\/\/(?:(.+)@)?([^:/?#\s@]+):(\d{1,5})(?:-(\d{1,5}))?$/i;

function parseProxyUrl(value: string): {
  scheme: string;
  user: string;
  pass: string;
  host: string;
  port: number;
} | null {
  const match = PROXY_URL_RE.exec(String(value).trim());
  if (!match) return null;
  const portStart = Number(match[4]);
  if (portStart < 1 || portStart > 65535) return null;

  // Range de portas multiplexado (ex.: 10000-10050): sorteia uma pra testar, igual ao
  // parseProxy do standalone -- o teste e so uma amostra da saida, nao precisa das 50 portas.
  let port = portStart;
  if (match[5] !== undefined) {
    const portEnd = Number(match[5]);
    if (portEnd >= portStart && portEnd <= 65535) {
      port = Math.floor(Math.random() * (portEnd - portStart + 1)) + portStart;
    }
  }

  const credentials = match[2] ?? "";
  const split = credentials.indexOf(":");
  const decode = (raw: string) => {
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  };

  return {
    scheme: match[1].toLowerCase(),
    user: credentials === "" ? "" : decode(split < 0 ? credentials : credentials.slice(0, split)),
    pass: credentials === "" || split < 0 ? "" : decode(credentials.slice(split + 1)),
    host: match[3],
    port,
  };
}

function openSocks5Tunnel(
  proxyHost: string,
  proxyPort: number,
  user: string,
  pass: string,
  destHost: string,
  destPort: number,
  timeoutMs = 12_000,
): Promise<import("net").Socket | null> {
  return new Promise((resolve) => {
    const net = require("net") as typeof import("net");
    const s = net.connect({ host: proxyHost, port: proxyPort });
    let etapa: "saudacao" | "auth" | "resposta" = "saudacao";
    let buf = Buffer.alloc(0);
    let settled = false;

    const fim = (sock: import("net").Socket | null) => {
      if (settled) return;
      settled = true;
      s.setTimeout(0);
      s.removeAllListeners();
      if (sock === null) s.destroy();
      resolve(sock);
    };

    const enviarConnect = () => {
      buf = Buffer.alloc(0);
      const alvo = Buffer.from(destHost, "utf8");
      s.write(
        Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, alvo.length]),
          alvo,
          Buffer.from([(destPort >> 8) & 0xff, destPort & 0xff]),
        ]),
      );
      etapa = "resposta";
    };

    s.setTimeout(timeoutMs, () => fim(null));
    s.on("error", () => fim(null));
    s.on("close", () => {
      if (!settled) fim(null);
    });

    s.on("connect", () => {
      if (user === "") s.write(Buffer.from([0x05, 0x01, 0x00]));
      else s.write(Buffer.from([0x05, 0x02, 0x00, 0x02]));
    });

    s.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);

      if (etapa === "saudacao") {
        if (buf.length < 2) return;
        if (buf[0] !== 0x05) return fim(null);
        const metodo = buf[1];
        buf = buf.subarray(2);

        if (metodo === 0x02) {
          const u = Buffer.from(user, "utf8");
          const p = Buffer.from(pass, "utf8");
          if (u.length > 255 || p.length > 255) return fim(null);
          etapa = "auth";
          s.write(
            Buffer.concat([
              Buffer.from([0x01, u.length]),
              u,
              Buffer.from([p.length]),
              p,
            ]),
          );
          return;
        }
        if (metodo !== 0x00) return fim(null);
        enviarConnect();
        return;
      }

      if (etapa === "auth") {
        if (buf.length < 2) return;
        if (buf[1] !== 0x00) return fim(null);
        buf = buf.subarray(2);
        enviarConnect();
        return;
      }

      if (etapa === "resposta") {
        // VER REP RSV ATYP + ADDR + PORT
        if (buf.length < 4) return;
        if (buf[0] !== 0x05 || buf[1] !== 0x00) return fim(null);
        const atyp = buf[3];
        let headerLen = 4;
        if (atyp === 0x01) headerLen = 10;
        else if (atyp === 0x03) {
          if (buf.length < 5) return;
          headerLen = 5 + buf[4] + 2;
        } else if (atyp === 0x04) headerLen = 22;
        else return fim(null);
        if (buf.length < headerLen) return;
        const leftover = buf.subarray(headerLen);
        if (leftover.length > 0) s.unshift(leftover);
        fim(s);
      }
    });
  });
}

function readHttpOverTls(
  socket: import("net").Socket,
  host: string,
  reqPath: string,
  timeoutMs = 10_000,
): Promise<string | null> {
  return new Promise((resolve) => {
    const tls = require("tls") as typeof import("tls");
    let body = "";
    let settled = false;
    const fim = (v: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        tlsSock.destroy();
      } catch {
        /* ignore */
      }
      resolve(v);
    };

    const timer = setTimeout(() => fim(null), timeoutMs);
    const tlsSock = tls.connect({ socket, servername: host, host }, () => {
      tlsSock.write(
        `GET ${reqPath} HTTP/1.1\r\nHost: ${host}\r\nAccept: */*\r\nConnection: close\r\n\r\n`,
      );
    });
    tlsSock.setEncoding("latin1");
    tlsSock.on("error", () => fim(null));
    tlsSock.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > 65536) fim(body);
    });
    tlsSock.on("end", () => fim(body || null));
  });
}

async function exitCountryViaSocks(
  proxyHost: string,
  proxyPort: number,
  user: string,
  pass: string,
): Promise<string | null> {
  // Mesma estrategia do bypass: Cloudflare /cdn-cgi/trace, fallback ipwho.is (Tor = loc=T1).
  const geoHost = "cloudflare.com";
  const sock = await openSocks5Tunnel(proxyHost, proxyPort, user, pass, geoHost, 443, 10_000);
  if (sock) {
    const response = await readHttpOverTls(sock, geoHost, "/cdn-cgi/trace");
    sock.destroy();
    const match = response ? /^loc=([A-Z]{2})/m.exec(response) : null;
    if (match && match[1] !== "T1") return match[1];
  }

  try {
    const fallbackHost = "ipwho.is";
    const fb = await openSocks5Tunnel(
      proxyHost,
      proxyPort,
      user,
      pass,
      fallbackHost,
      443,
      10_000,
    );
    if (fb) {
      const json = await readHttpOverTls(fb, fallbackHost, "/?fields=country_code");
      fb.destroy();
      const iso = json ? /"country_code"\s*:\s*"([A-Z]{2})"/.exec(json) : null;
      if (iso) return iso[1];
    }
  } catch {
    /* sem pais */
  }
  return null;
}

ipcMain.handle("test-proxy", async (_event, proxyRaw: unknown) => {
  // Canal mantido apenas para clientes antigos: nunca abre SOCKS nem inicia Tor.
  return { ok: false, error: "Proxy foi removida. Use uma configuração WireGuard." };
  /* c8 ignore start -- compatibilidade morta, removida do preload/UI */
  const raw = typeof proxyRaw === "string" ? proxyRaw.trim() : "";
  if (raw === "") {
    return { ok: false, error: "Cole o endereco da proxy (socks5://host:porta)." };
  }

  const parsed = parseProxyUrl(raw);
  if (!parsed) {
    return {
      ok: false,
      error: "Formato invalido. Use socks5://host:porta ou socks5://usuario:senha@host:porta.",
    };
  }

  if (parsed.scheme !== "socks5") {
    return {
      ok: false,
      error: `Por enquanto o teste so cobre SOCKS5 (voce usou ${parsed.scheme}).`,
    };
  }

  const t0 = Date.now();
  const tunnel = await openSocks5Tunnel(
    parsed.host,
    parsed.port,
    parsed.user,
    parsed.pass,
    TOR_ALVO_HOST,
    TOR_ALVO_PORTA,
  );
  const ms = Date.now() - t0;

  if (!tunnel) {
    return {
      ok: false,
      error: "Nao abriu tunel ate gateway.discord.gg. Confira IP, porta, firewall e se a saida nao e BR.",
      ms,
    };
  }
  tunnel.destroy();

  const country = await exitCountryViaSocks(
    parsed.host,
    parsed.port,
    parsed.user,
    parsed.pass,
  );

  if (country === "BR") {
    return {
      ok: false,
      error: `Tunel OK (${ms}ms), mas a saida e BR — o Discord continua bloqueando Go Live. Use VPS/Tor fora do Brasil.`,
      ms,
      country,
      host: parsed.host,
      port: parsed.port,
    };
  }

  return {
    ok: true,
    ms,
    country: country ?? undefined,
    host: parsed.host,
    port: parsed.port,
  };
  /* c8 ignore stop */
});

// ------------------------------------------------------------------ diagnostico / modo dev
const ISSUE_REPO = "pdl-clay/GoLiveBypass";
// A label "gui" precisa existir no repo (criar uma vez no GitHub). Sem ela o form ainda abre;
// a API de reports usa ISSUE_LABELS no servidor.
const ISSUE_LABELS = ["bug", "gui"];

function logFilePath() {
  return path.join(settingsDir(), "golivebypass.log");
}

function maskSecrets(text: string): string {
  return text
    .replace(
      /(socks5|socks4|https?|http):\/\/([^/\s@]+)@/gi,
      (_m, scheme: string, creds: string) => {
        const user = creds.split(":")[0] || "user";
        return `${scheme}://${user}:***@`;
      },
    )
    .replace(/(pass|password|senha)\s*[:=]\s*\S+/gi, "$1=***");
}

function readLogTail(maxBytes = 48_000): string {
  const file = logFilePath();
  try {
    if (!fs.existsSync(file)) return "(ainda nao ha golivebypass.log — ative o bypass uma vez)";
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - maxBytes);
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const text = buf.toString("utf8");
      return start > 0 ? `… (trecho final)\n${text}` : text;
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    return `(nao consegui ler o log: ${error instanceof Error ? error.message : String(error)})`;
  }
}

async function formatWgTunelDiagnostico(status: string): Promise<string> {
  if (isMac || status !== "ACTIVE") return "n/a";
  const s = await wgStatsProvider();
  if (!s.ok) return `indisponível (${s.error ?? "?"})`;
  const handshake = s.handshakeAgoS === null ? "nunca" : `há ${s.handshakeAgoS}s`;
  const trafego =
    s.rxBytes !== null && s.txBytes !== null
      ? `rx=${Math.round(s.rxBytes / 1024)}KB tx=${Math.round(s.txBytes / 1024)}KB`
      : "sem contadores";
  return `handshake ${handshake} · ${trafego}`;
}

function formatWireSockDiagnostico(): string {
  if (!IS_WINDOWS) return "n/a";
  const s = getWireSockConnectionStatus();
  return `${s.state} · fonte=${s.source}${s.detail ? ` · ${s.detail}` : ""}`;
}

async function buildDiagnostic(status: string, extraNote = ""): Promise<string> {
  const lines = [
    "### Diagnóstico GoLiveBypass (GUI)",
    "",
    "| | |",
    "|---|---|",
    `| app | golive-gui ${app.getVersion()} |`,
    `| os | ${process.platform} ${process.arch} |`,
    `| electron | ${process.versions.electron} |`,
    `| status | ${status} |`,
    `| routeMode | wireguard |`,
    `| wireSock | ${formatWireSockDiagnostico()} |`,
    // "Carregando infinito" pos-WireGuard costuma ser tunel morto/saturado, nao mais gateway
    // zumbi de proxy: handshake velho ou trafego zerado com bypass ativo aponta pra isso direto.
    `| tunelWg | ${await formatWgTunelDiagnostico(status)} |`,
    `| log | \`${logFilePath()}\` |`,
    "",
  ];
  if (extraNote.trim()) {
    lines.push("**Relato:**", "", extraNote.trim(), "");
  }
  lines.push("**Log (trecho):**", "", "```", maskSecrets(readLogTail()), "```", "");
  lines.push(
    "_Senhas mascaradas. Se o corpo da issue ficar curto demais, cole o diagnóstico completo do clipboard._",
  );
  return lines.join("\n");
}

let logWatchOffset = 0;
let logWatchActive = false;

function stopLogWatch() {
  logWatchActive = false;
  try {
    fs.unwatchFile(logFilePath());
  } catch {
    /* ignore */
  }
}

function pushLogChunk(chunk: string) {
  if (!chunk) return;
  if (logWindow && !logWindow.isDestroyed()) {
    logWindow.webContents.send("log-chunk", chunk);
  }
}

function startLogWatch() {
  stopLogWatch();
  const file = logFilePath();
  try {
    fs.mkdirSync(settingsDir(), { recursive: true });
  } catch {
    /* ignore */
  }

  logWatchActive = true;
  try {
    if (fs.existsSync(file)) {
      const size = fs.statSync(file).size;
      // Manda o final do arquivo de uma vez, depois so o que chegar.
      const start = Math.max(0, size - 24_000);
      logWatchOffset = start;
      const fd = fs.openSync(file, "r");
      try {
        const buf = Buffer.alloc(size - start);
        if (buf.length > 0) {
          fs.readSync(fd, buf, 0, buf.length, start);
          pushLogChunk(buf.toString("utf8"));
        }
      } finally {
        fs.closeSync(fd);
      }
      logWatchOffset = size;
    } else {
      logWatchOffset = 0;
      pushLogChunk("(aguardando golivebypass.log — aparece quando o Discord roda com o bypass)\n");
    }
  } catch (error) {
    pushLogChunk(
      `(erro ao abrir log: ${error instanceof Error ? error.message : String(error)})\n`,
    );
  }

  fs.watchFile(file, { interval: 700 }, (curr, prev) => {
    if (!logWatchActive) return;
    try {
      if (!fs.existsSync(file)) {
        logWatchOffset = 0;
        return;
      }
      if (curr.size < logWatchOffset) logWatchOffset = 0; // rotacao / truncate
      if (curr.size === logWatchOffset) return;
      if (curr.mtimeMs === prev.mtimeMs && curr.size === prev.size) return;

      const fd = fs.openSync(file, "r");
      try {
        const len = curr.size - logWatchOffset;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, logWatchOffset);
        logWatchOffset = curr.size;
        pushLogChunk(buf.toString("utf8"));
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      /* ignore race */
    }
  });
}

ipcMain.handle("start-log-watch", () => {
  startLogWatch();
  return { path: logFilePath() };
});

ipcMain.handle("stop-log-watch", () => {
  stopLogWatch();
  return true;
});

ipcMain.handle("get-diagnostic", async (_event, payload: unknown) => {
  const p = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const status = typeof p.status === "string" ? p.status : "UNKNOWN";
  const note = typeof p.note === "string" ? p.note : "";
  return {
    text: await buildDiagnostic(status, note),
    logPath: logFilePath(),
    apiConfigured: Boolean(readBugReportConfig()),
  };
});

function readBugReportConfig(): { baseUrl: string; token: string } | null {
  // Prioridade: settings.json da pasta compartilhada, depois env do processo.
  // Sem os dois, o botao cai no form do GitHub (sem segredo embutido no binario).
  let url = (process.env.GOLIVE_BUG_API_URL || "").trim().replace(/\/$/, "");
  let token = (process.env.GOLIVE_BUG_API_TOKEN || "").trim();
  try {
    const file = path.join(settingsDir(), "settings.json");
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      if (typeof data.bugReportApiUrl === "string" && data.bugReportApiUrl.trim()) {
        url = data.bugReportApiUrl.trim().replace(/\/$/, "");
      }
      if (typeof data.bugReportToken === "string" && data.bugReportToken.trim()) {
        token = data.bugReportToken.trim();
      }
    }
  } catch {
    /* ignore */
  }
  if (!url || !token) return null;
  return { baseUrl: url, token };
}

async function postBugReportToApi(
  cfg: { baseUrl: string; token: string },
  title: string,
  description: string,
  status: string,
): Promise<{ ok: true; issueUrl: string; issueNumber?: number } | { ok: false; error: string }> {
  const endpoint = `${cfg.baseUrl}/v1/reports`;
  const wgTunel = !isMac && status === "ACTIVE" ? await wgStatsProvider() : undefined;
  const body = {
    title,
    description,
    log: maskSecrets(readLogTail(200_000)),
    meta: {
      app: "golive-gui",
      version: app.getVersion(),
      os: `${process.platform} ${process.arch}`,
      electron: process.versions.electron ?? "",
      status,
      routeMode: readNetMode(),
      // Mesmo raciocinio do submitBugReport: handshake velho/trafego parado com bypass ativo
      // e o sinal mais direto de tunel morto ou saturado (ver electron/wgstats.ts).
      wg_handshake_ha_s: wgTunel?.ok ? String(wgTunel.handshakeAgoS ?? "nunca") : "indisponivel",
      wg_rx_kb: wgTunel?.ok && wgTunel.rxBytes !== null ? String(Math.round(wgTunel.rxBytes / 1024)) : "indisponivel",
      wg_tx_kb: wgTunel?.ok && wgTunel.txBytes !== null ? String(Math.round(wgTunel.txBytes / 1024)) : "indisponivel",
      wg_erro: !wgTunel?.ok ? (wgTunel?.error ?? "?") : "",
    },
  };

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let data: Record<string, unknown> = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      /* corpo nao-json */
    }

    if (!res.ok) {
      const err =
        typeof data.error === "string"
          ? data.error
          : `API respondeu ${res.status}`;
      return { ok: false, error: err };
    }

    const issueUrl =
      typeof data.issue_url === "string"
        ? data.issue_url
        : typeof data.html_url === "string"
          ? data.html_url
          : "";
    if (!issueUrl) return { ok: false, error: "API nao devolveu issue_url" };
    return {
      ok: true,
      issueUrl,
      issueNumber: typeof data.issue_number === "number" ? data.issue_number : undefined,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

ipcMain.handle("open-bug-report", async (_event, payload: unknown) => {
  const p = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const status = typeof p.status === "string" ? p.status : "UNKNOWN";
  const note =
    typeof p.note === "string" && p.note.trim()
      ? p.note.trim()
      : "(descreva o que aconteceu, o que esperava, e se câmera / Go Live / região da call)";
  const titleRaw =
    typeof p.title === "string" && p.title.trim()
      ? p.title.trim()
      : `[GUI] problema com bypass (${status})`;
  const title = titleRaw.slice(0, 180);

  const fullBody = await buildDiagnostic(status, note);
  clipboard.writeText(fullBody);

  // 1) API (log completo, labels no servidor) — se configurada.
  const apiCfg = readBugReportConfig();
  if (apiCfg) {
    const posted = await postBugReportToApi(apiCfg, title, note, status);
    if (posted.ok) {
      await shell.openExternal(posted.issueUrl);
      return {
        ok: true,
        via: "api" as const,
        url: posted.issueUrl,
        issueNumber: posted.issueNumber,
        copied: true,
        truncated: false,
      };
    }
    // Cai no form do GitHub, mas avisa o motivo no retorno.
    const maxBody = 5500;
    const bodyForUrl =
      fullBody.length > maxBody
        ? `${fullBody.slice(0, maxBody)}\n\n…(truncado — cole o diagnóstico do clipboard)\n\n_API falhou: ${posted.error}_`
        : `${fullBody}\n\n_API falhou: ${posted.error}_`;
    const params = new URLSearchParams({
      title,
      body: bodyForUrl,
      labels: ISSUE_LABELS.join(","),
    });
    const url = `https://github.com/${ISSUE_REPO}/issues/new?${params.toString()}`;
    await shell.openExternal(url);
    return {
      ok: true,
      via: "github" as const,
      url,
      copied: true,
      truncated: fullBody.length > maxBody,
      apiError: posted.error,
    };
  }

  // 2) Fallback: form do GitHub (sem token no app).
  const maxBody = 5500;
  const bodyForUrl =
    fullBody.length > maxBody
      ? `${fullBody.slice(0, maxBody)}\n\n…(truncado — cole o diagnóstico completo do clipboard)`
      : fullBody;

  const params = new URLSearchParams({
    title,
    body: bodyForUrl,
    labels: ISSUE_LABELS.join(","),
  });
  const url = `https://github.com/${ISSUE_REPO}/issues/new?${params.toString()}`;
  await shell.openExternal(url);

  return {
    ok: true,
    via: "github" as const,
    url,
    copied: true,
    truncated: fullBody.length > maxBody,
  };
});

ipcMain.handle("open-log-folder", async () => {
  const dir = settingsDir();
  fs.mkdirSync(dir, { recursive: true });
  await shell.openPath(dir);
  return dir;
});

ipcMain.handle("set-dev-log-window", (_event, open: unknown) => {
  // Janela de logs e ferramenta de desenvolvimento: so existe em npm run dev.
  if (open === true && app.isPackaged) return false;
  if (open === true) {
    openLogWindow();
    return true;
  }
  closeLogWindow();
  stopLogWatch();
  return false;
});

ipcMain.handle("get-proxy", () => {
  const salva = readProxyFrom(path.join(settingsDir(), "settings.json"));
  if (salva !== "") return salva;

  // Quem ativou antes desta versao so tem o settings.json dentro do app.asar injetado. Ler de
  // la evita que a proxy configurada suma na atualizacao do app.
  //
  // withNoAsar e obrigatorio: com o suporte a asar ligado, o Electron ABRE o app.asar para
  // resolver o caminho de dentro dele e guarda o descritor em cache pelo resto do processo.
  // Como isto roda na abertura da janela, o handle ficava preso e a ativacao seguinte
  // falhava com EBUSY ao renomear app.asar -> _app.asar. Com noAsar o caminho e tratado como
  // pasta comum: se a injecao existe, le o arquivo; se e um asar de verdade, so nao acha.
  for (const install of getDiscordInstalls()) {
    const doAsar = withNoAsar(() =>
      readProxyFrom(path.join(install.resources, "app.asar", "settings.json")),
    );
    if (doAsar !== "") return doAsar;
  }

  return "";
});

async function importWgConfFromPath(chosen: string) {
  const originalName = path.basename(chosen);

  try {
    const content = fs.readFileSync(chosen, "utf8");
    const validation = await validateWgConfContent(content);
    if (!validation.valid) {
      return {
        success: false,
        error: validation.error || "Arquivo de configuração WireGuard (.conf) inválido.",
      };
    }

    protonOptimizations.invalidate();
    return await withWireSockLifecycle("importar-perfil", async () => {
      const targetDir = settingsDir();
      fs.mkdirSync(targetDir, { recursive: true });
      const targetFile = path.join(targetDir, "wireguard.conf");
      fs.writeFileSync(targetFile, content, { mode: 0o600 });
      updateSharedSettings({ wgConfOriginalName: originalName, protonLastServer: undefined });
      return { success: true, fileName: originalName, path: targetFile, validation };
    });
  } catch (err) {
    return {
      success: false,
      error: `Erro ao ler o arquivo: ${(err as Error)?.message || String(err)}`,
    };
  }
}

ipcMain.handle("import-wg-conf", async () => {
  const win = BrowserWindow.getFocusedWindow();
  const res = await dialog.showOpenDialog(win || (undefined as any), {
    title: "Selecionar arquivo de configuração WireGuard (.conf)",
    filters: [{ name: "WireGuard Config (*.conf)", extensions: ["conf"] }],
    properties: ["openFile"],
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  return importWgConfFromPath(res.filePaths[0]);
});

ipcMain.handle("import-wg-conf-file", async (_event, filePath: unknown) => {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath) || path.extname(filePath).toLowerCase() !== ".conf") {
    return { success: false, error: "Solte um arquivo WireGuard com extensão .conf." };
  }
  return importWgConfFromPath(filePath);
});

ipcMain.handle("test-wg-conf", async () => {
  const targetFile = path.join(settingsDir(), "wireguard.conf");
  if (!fs.existsSync(targetFile)) {
    return {
      ok: false,
      error: "Nenhum arquivo de configuração WireGuard (.conf) encontrado.",
    };
  }

  try {
    const content = fs.readFileSync(targetFile, "utf8");
    const validation = await validateWgConfContent(content);
    if (!validation.valid) {
      return {
        ok: false,
        error: validation.error || "Arquivo .conf inválido.",
      };
    }

    const status = IS_LINUX ? await linuxStatus() : getStatus();
    let exitInfo: { ip?: string; country?: string } | undefined;
    let readiness: Record<string, unknown> | undefined;

    if (status === "ACTIVE" && IS_WINDOWS) {
      const ws = getWireSockConnectionStatus();
      readiness = {
        ready: ws.verified,
        state: ws.state,
        source: ws.source,
        error: ws.verified ? undefined : ws.detail,
      };
    }

    if (status === "ACTIVE" && IS_LINUX) {
      try {
        const probe = await runScript(["--probe", "--json"]);
        readiness = JSON.parse(probe.stdout || "{}");
        const out = execSync(
          "ip netns exec discord-vpn curl -m 3 -s https://cloudflare.com/cdn-cgi/trace",
          { encoding: "utf8" }
        );
        const ipMatch = out.match(/ip=([^\r\n]+)/);
        const locMatch = out.match(/loc=([^\r\n]+)/);
        if (ipMatch) {
          exitInfo = {
            ip: ipMatch[1],
            country: locMatch ? locMatch[1] : undefined,
          };
        }
      } catch {}
    }

    return {
      ok: true,
      endpoint: validation.endpoint,
      resolvedIp: validation.resolvedIp,
      address: validation.interfaceAddress,
      dns: validation.dns,
      exitInfo,
      readiness,
      active: status === "ACTIVE",
    };
  } catch (err) {
    return {
      ok: false,
      error: `Falha ao testar configuração: ${(err as Error)?.message || String(err)}`,
    };
  }
});

ipcMain.handle("get-wg-conf-name", async () => {
  const s = readSharedSettings() as any;
  const vpnMode = (s.vpnMode as string) || "proton";
  if (vpnMode === "proton") {
    if (s.protonLastServer?.server) {
      const ping = s.protonLastServer.pingMs > 0 ? ` (${s.protonLastServer.pingMs}ms)` : "";
      return `${s.protonLastServer.server}${ping}`;
    }
    return s.protonUsername ? `ProtonVPN (${s.protonUsername})` : "";
  }
  const targetFile = path.join(settingsDir(), "wireguard.conf");
  if (fs.existsSync(targetFile)) {
    if (typeof s.wgConfOriginalName === "string" && s.wgConfOriginalName) {
      return s.wgConfOriginalName;
    }
    return "wireguard.conf";
  }
  return "";
});

ipcMain.handle("get-vpn-mode", async () => {
  const s = readSharedSettings() as any;
  return (s.vpnMode as string) || "proton";
});

ipcMain.handle("set-vpn-mode", async (_event, mode: "proton" | "custom") => {
  if (mode !== "proton" && mode !== "custom") throw new Error("Modo VPN inválido.");
  protonOptimizations.invalidate();
  stopProtonFailoverMonitor();
  const result = await withWireSockLifecycle("modo-vpn", async () => {
    updateSharedSettings({ vpnMode: mode });
    return mode;
  });
  return result;
});

ipcMain.handle("get-proton-settings", async () => {
  const s = readSharedSettings() as any;
  const recoveredUsername = recoverProtonUsername() || (s.protonUsername as string) || "";
  return {
    vpnMode: (s.vpnMode as string) || "proton",
    username: recoveredUsername,
    country: (s.protonCountry as string) || "",
    freeOnly: s.protonFreeOnly !== false,
    autoPing: s.protonAutoPing !== false,
    autoFailover: s.protonAutoFailover !== false,
    lastServer: s.protonLastServer,
  };
});

ipcMain.handle("get-proton-plan", async (_event, options?: { force?: boolean }) => {
  const s = readSharedSettings() as any;
  const username = recoverProtonUsername() || (s.protonUsername as string) || "";
  if (!username) return unknownProtonPlan("Sessão Proton não encontrada.");
  return resolveProtonPlan(username, options?.force === true);
});

ipcMain.handle("set-proton-settings", async (_event, settings: any) => {
  protonOptimizations.invalidate();
  if (typeof settings?.username === "string") invalidateProtonPlanCache();
  const filterChanged = typeof settings?.username === "string" ||
    typeof settings?.country === "string" ||
    typeof settings?.freeOnly === "boolean" ||
    typeof settings?.autoPing === "boolean";
  if (filterChanged || settings?.autoFailover === false) stopProtonFailoverMonitor();
  if (typeof settings?.username === "string" || typeof settings?.country === "string" || typeof settings?.freeOnly === "boolean" || typeof settings?.autoPing === "boolean") {
    clearProtonRoutePool();
  }
  const result = await withWireSockLifecycle("preferencias-proton", async () => {
    const patch: Record<string, unknown> = {};
    if (typeof settings?.username === "string") patch.protonUsername = settings.username;
    if (typeof settings?.country === "string") patch.protonCountry = settings.country;
    if (typeof settings?.freeOnly === "boolean") patch.protonFreeOnly = settings.freeOnly;
    if (typeof settings?.autoPing === "boolean") patch.protonAutoPing = settings.autoPing;
    if (typeof settings?.autoFailover === "boolean") patch.protonAutoFailover = settings.autoFailover;
    return updateSharedSettings(patch);
  });
  if (!filterChanged && settings?.autoFailover === true) startProtonFailoverMonitor();
  return result;
});

ipcMain.handle("check-proton-session", async (_event, username?: string) => {
  const s = readSharedSettings() as any;
  const user = username || recoverProtonUsername() || (s.protonUsername as string) || "";
  if (!user) return { valid: false, error: "Usuário não especificado" };
  return await proton.checkProtonSession(settingsDir(), user);
});

type ProtonCaptchaSolveResult =
  | { ok: true; token: string }
  | { ok: false; code: "CAPTCHA_CANCELLED" | "CAPTCHA_INVALID"; message: string };

async function solveProtonCaptcha(rawUrl: string, parent: BrowserWindow | null): Promise<ProtonCaptchaSolveResult> {
  const challenge = parseProtonCaptchaChallenge(rawUrl);
  if (!challenge) {
    return { ok: false, code: "CAPTCHA_INVALID", message: "O Proton forneceu um endereço de CAPTCHA inválido." };
  }
  const captchaPreloadPath = path.join(__dirname, "proton-captcha-preload.cjs");
  if (!fs.existsSync(captchaPreloadPath)) {
    return { ok: false, code: "CAPTCHA_INVALID", message: "Não foi possível preparar a captura do CAPTCHA." };
  }

  return new Promise((resolve) => {
    let settled = false;
    let invalidMessages = 0;
    const captchaWindow = new BrowserWindow({
      width: 520,
      height: 700,
      minWidth: 420,
      minHeight: 560,
      parent: parent ?? undefined,
      modal: parent !== null,
      show: false,
      autoHideMenuBar: true,
      title: "Verificação de segurança Proton",
      backgroundColor: "#17171c",
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        devTools: false,
        safeDialogs: true,
        spellcheck: false,
        preload: captchaPreloadPath,
        partition: `proton-captcha-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      },
    });

    const preventDownload = (event: Electron.Event) => event.preventDefault();
    // O webContents.session deixa de ser acessível depois que a janela e destruída.
    // Guarde a referencia enquanto o webContents ainda esta vivo para que o caminho
    // de cancelamento/fechamento consiga remover o listener sem deixar a Promise pendente.
    const captchaSession = captchaWindow.webContents.session;
    captchaSession.on("will-download", preventDownload);
    captchaSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    captchaWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    captchaWindow.webContents.on("will-attach-webview", (event) => event.preventDefault());
    const guardNavigation = (event: Electron.Event, targetUrl: string) => {
      if (!isAllowedProtonCaptchaNavigation(targetUrl, challenge)) event.preventDefault();
    };
    captchaWindow.webContents.on("will-navigate", guardNavigation);
    captchaWindow.webContents.on("will-redirect", guardNavigation);

    const finish = (result: ProtonCaptchaSolveResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      ipcMain.removeListener(PROTON_CAPTCHA_IPC_CHANNEL, onCaptchaResponse);
      captchaSession.removeListener("will-download", preventDownload);
      resolve(result);
      if (!captchaWindow.isDestroyed()) captchaWindow.destroy();
    };

    const onCaptchaResponse = (event: Electron.IpcMainEvent, message: { type?: unknown; token?: unknown }) => {
      if (settled || event.sender !== captchaWindow.webContents) return;
      if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) return;
      if (!isAllowedProtonCaptchaNavigation(event.senderFrame.url, challenge)) return;
      if (message?.type !== "pm_captcha" && message?.type !== "proton_captcha") return;
      if (validateProtonCaptchaResponse(message?.token, challenge.challenge)) {
        finish({ ok: true, token: message.token });
        return;
      }
      invalidMessages += 1;
      if (invalidMessages >= 10) {
        finish({ ok: false, code: "CAPTCHA_INVALID", message: "O CAPTCHA retornou uma resposta inválida. Tente novamente." });
      }
    };
    ipcMain.on(PROTON_CAPTCHA_IPC_CHANNEL, onCaptchaResponse);

    const timeout = setTimeout(() => {
      finish({ ok: false, code: "CAPTCHA_INVALID", message: "A verificação expirou. Inicie o login novamente." });
    }, 120_000);

    captchaWindow.once("ready-to-show", () => {
      if (!settled) captchaWindow.show();
    });
    captchaWindow.webContents.on("did-fail-load", (_event, errorCode, _description, _url, isMainFrame) => {
      if (isMainFrame && errorCode !== -3) {
        finish({ ok: false, code: "CAPTCHA_INVALID", message: "Não foi possível carregar o CAPTCHA oficial da Proton." });
      }
    });
    captchaWindow.webContents.on("preload-error", (_event, preloadPath, _error) => {
      if (preloadPath === captchaPreloadPath) {
        finish({ ok: false, code: "CAPTCHA_INVALID", message: "Não foi possível preparar a captura do CAPTCHA." });
      }
    });
    captchaWindow.once("close", () => {
      if (!settled) finish({ ok: false, code: "CAPTCHA_CANCELLED", message: "Verificação cancelada. Nenhuma credencial foi alterada." });
    });
    captchaWindow.on("closed", () => {
      if (!settled) finish({ ok: false, code: "CAPTCHA_CANCELLED", message: "Verificação cancelada. Nenhuma credencial foi alterada." });
    });
    void captchaWindow.loadURL(challenge.url).catch(() => {
      finish({ ok: false, code: "CAPTCHA_INVALID", message: "Não foi possível abrir o CAPTCHA oficial da Proton." });
    });
  });
}

let protonLoginGeneration = 0;
ipcMain.handle("login-proton", async (event, payload: { username: string; password?: string; twoFactorCode?: string }) => {
  protonOptimizations.invalidate();
  invalidateProtonPlanCache();
  stopProtonFailoverMonitor();
  clearProtonRoutePool();
  await withWireSockLifecycle("aguardar-selecao-login", async () => {});
  const generation = ++protonLoginGeneration;
  let res = await proton.loginProton(settingsDir(), payload.username, payload.password, payload.twoFactorCode);
  for (let attempt = 1; !res.success && (res.code === "CAPTCHA_REQUIRED" || res.code === "CAPTCHA_INVALID") && attempt <= 3; attempt++) {
    if (!res.captchaUrl) break;
    if (generation !== protonLoginGeneration) {
      return { success: false, code: "CAPTCHA_CANCELLED", retryable: true, message: "Esta tentativa de login foi substituída por outra." };
    }
    event.sender.send("proton-captcha-status", attempt === 1 ? "opening" : "retrying");
    const parent = BrowserWindow.fromWebContents(event.sender);
    const solved = await solveProtonCaptcha(res.captchaUrl, parent);
    if (!solved.ok) {
      return { success: false, code: solved.code, retryable: true, message: solved.message };
    }
    event.sender.send("proton-captcha-status", "verifying");
    res = await proton.loginProton(settingsDir(), payload.username, payload.password, payload.twoFactorCode, solved.token);
  }
  if (generation !== protonLoginGeneration) {
    return { success: false, code: "CAPTCHA_CANCELLED", retryable: true, message: "Esta tentativa de login foi substituída por outra." };
  }
  if (res.success) {
    const authenticatedUsername = res.username || payload.username.trim();
    if (!updateSharedSettings({ protonUsername: authenticatedUsername })) {
      return { success: false, code: "SESSION_PERSISTENCE", retryable: false, message: "Login concluído, mas não foi possível salvar a conta neste computador.", error: "Verifique as permissões da pasta de dados e tente novamente." };
    }
    invalidateProtonPlanCache();
    // O sidecar só retorna sucesso depois de gravar SessionStore.Save. A
    // releitura imediata do Electron era redundante e, no Windows, podia ver o
    // arquivo tarde e transformar um login válido em erro. Confirme em segundo
    // plano apenas para diagnóstico; uma resposta atrasada nunca altera a conta.
    void proton.confirmSavedSessionIdentity(settingsDir(), authenticatedUsername).then((confirmation) => {
      if (generation !== protonLoginGeneration) return;
      if (confirmation.confirmed) {
        logger.info("proton", "sessao persistida confirmada", { tentativas: confirmation.attempts });
      } else {
        logger.warn("proton", "sessao persistida ainda nao visivel apos login", {
          tentativas: confirmation.attempts,
          identidade_encontrada: confirmation.savedUsername ? "diferente" : "ausente",
        });
      }
    }).catch((error) => {
      if (generation === protonLoginGeneration) {
        logger.warn("proton", "falha na confirmacao diagnostica da sessao", { erro: String((error as Error)?.message ?? error) });
      }
    });

  }
  return res;
});

ipcMain.handle("logout-proton", async () => {
  protonLoginGeneration++;
  protonOptimizations.invalidate();
  invalidateProtonPlanCache();
  stopProtonFailoverMonitor();
  return withWireSockLifecycle("logout-proton", async () => {
    const sessionFile = proton.getProtonSessionFile(settingsDir());
    try {
      if (fs.existsSync(sessionFile)) fs.unlinkSync(sessionFile);
    } catch {}
    updateSharedSettings({ protonLastServer: undefined });
    clearProtonRoutePool();
    return true;
  });
});

type ProtonOptimizationOptions = {
  country?: string;
  freeOnly?: boolean;
  autoPing?: boolean;
  speedTest?: boolean;
  reuseMeasured?: boolean;
  refreshOnStartup?: boolean;
  requestId?: string;
};

ipcMain.handle("cancel-proton-optimization", (event, requestId: string) =>
  protonOptimizations.cancel(requestId, event.sender.id));

ipcMain.handle("optimize-proton-route", async (event, options?: ProtonOptimizationOptions) => {
  if (isMac) return { success: false, error: "O bypass por WireGuard ainda não está disponível no macOS." };
  const requestId = typeof options?.requestId === "string" && options.requestId.length <= 128
    ? options.requestId : `proton-${Date.now()}`;
  const operation = protonOptimizations.start(requestId, event.sender.id);
  if (!operation) return { success: false, error: "Já existe uma seleção de rota em andamento." };
  const signal = operation.controller.signal;
  let lastProgress: proton.ProtonOptimizationProgress = { phase: "ping", total: 0, tested: 0, succeeded: 0 };
  const sendProgress = (progress: proton.ProtonOptimizationProgress) => {
    if (!protonOptimizations.isCurrent(operation) || event.sender.isDestroyed()) return;
    lastProgress = progress;
    try {
      event.sender.send("proton-optimization-progress", { ...progress, requestId });
    } catch {
      // A janela pode ser destruída entre isDestroyed() e send(); o helper
      // continua sendo cancelado pelo listener de destroyed abaixo.
    }
  };
  const senderDestroyed = () => protonOptimizations.cancel(requestId, event.sender.id);
  event.sender.once("destroyed", senderDestroyed);
  return withWireSockLifecycle("troca-rota-proton", async () => {
      if (signal.aborted || quitting) return { success: false, cancelled: true };
      const s = readSharedSettings() as any;
      const username = (s.protonUsername as string) || "";
      if (!username) {
        return { success: false, error: "Nenhuma conta ProtonVPN conectada." };
      }

      const country = options?.country !== undefined ? options.country : ((s.protonCountry as string) || "");
      const plan = await resolveProtonPlan(username);
      if (signal.aborted || quitting) return { success: false, cancelled: true };
      // Plan classification is authoritative for selection. Unknown remains
      // Free-safe; the IPC option is retained for compatibility with older
      // renderers but cannot accidentally unlock paid tiers.
      const freeOnly = plan.status !== "premium";
      const autoPing = options?.autoPing !== undefined ? options.autoPing : (s.protonAutoPing !== false);

      // A abertura/login deve confirmar a rota novamente quando o túnel está
      // inativo. O reaproveitamento continua disponível apenas para fluxos que
      // o solicitam explicitamente (por exemplo, "continuar sem medir").
      const previous = s.protonLastServer;
      const speedTest = options?.speedTest !== false;
      const refreshOnStartup = options?.refreshOnStartup === true;
      if (!refreshOnStartup && options?.reuseMeasured && proton.canReuseMeasuredProfile(settingsDir(), previous, { username, country, freeOnly, autoPing })) {
        return { ...previous, success: true };
      }
      // Continuing without a new test keeps only a profile matching the current
      // account and filters; otherwise the helper performs its normal quick
      // selection and writes a fresh profile.
      if (!speedTest && proton.canReuseMeasuredProfile(settingsDir(), previous, { username, country, freeOnly, autoPing })) {
        return { ...previous, success: true };
      }

      const status = IS_LINUX ? await linuxStatus() : getStatus();
      if (signal.aborted) return { success: false, cancelled: true };
      if ((options?.reuseMeasured || refreshOnStartup) && (status === "ACTIVE" || (IS_WINDOWS && isWireSockActive()))) {
        return { success: true, deferred: true };
      }
      sendProgress({ phase: "ping", total: 0, tested: 0, succeeded: 0 });
      // Do not benchmark beside the active Proton tunnel: limited accounts can
      // evict the existing connection, and current traffic biases measurements.
      if (speedTest) {
        try {
          if (IS_WINDOWS && (status === "ACTIVE" || isWireSockActive())) {
            beginWindowsRouteOperation();
            stopWindowsRouteWatchdog();
            pararWgStatsWatchdog();
            windowsRouteStarted = false;
            await killDiscord();
            const recovery = await recoverWireSockNetwork();
            if (!recovery.ok) {
              windowsRouteState = "recovery_required";
              throw new Error("a rota anterior não encerrou com segurança. Use Restaurar internet.");
            }
            windowsRouteState = "inactive";
            refreshWindowStatus();
          } else if (IS_LINUX && status === "ACTIVE") {
            await linuxDeactivate(() => {});
          }
        } catch (error) {
          return { success: false, error: `Não foi possível preparar a medição: ${String((error as Error)?.message ?? error)}` };
        }
      }

      if (signal.aborted) return { success: false, cancelled: true };
      let gen: Awaited<ReturnType<typeof proton.generateOptimalProtonConfig>>;
      try {
        gen = await proton.generateOptimalProtonConfig(settingsDir(), {
          username,
          countries: country || undefined,
          freeOnly,
          autoPing,
          speedTest,
          signal,
          onProgress: sendProgress,
        });
      } catch (error) {
        gen = { success: false, error: String((error as Error)?.message ?? error) };
      }

      if (signal.aborted) return { success: false, cancelled: true, error: status === "ACTIVE"
        ? "Teste cancelado. Ative o Bypass para retomar a configuração salva."
        : "Teste cancelado. A configuração anterior foi preservada." };
      if (!gen.success) {
        const paused = speedTest && status === "ACTIVE";
        return { ...gen, error: `${gen.error || "Falha ao medir servidores."}${paused ? " O Discord permanece fechado; ative o Bypass para retomar a configuração salva." : ""}` };
      }

      // The staged profile has been committed. Finish applying it before another lifecycle operation.
      operation.cancellable = false;
      const saved = {
        ...gen,
        measurementUsername: username.trim().toLowerCase(),
        ...(speedTest ? {
          measurementVersion: proton.MEASUREMENT_CRITERION_VERSION,
          measuredAt: new Date().toISOString(),
          measurementCountry: country,
          measurementFreeOnly: freeOnly,
          measurementAutoPing: autoPing,
        } : {}),
      };
      if (!updateSharedSettings({
        protonCountry: country,
        protonFreeOnly: freeOnly,
        protonAutoPing: autoPing,
        protonLastServer: saved,
      })) {
        return { success: false, error: "A rota foi preparada, mas não foi possível salvar suas preferências." };
      }

      if (status === "ACTIVE") {
        logger.info("proton", "bypass ativo, iniciando nova rota antes de reabrir o Discord", { server: gen.server });
        try {
          if (IS_WINDOWS) {
            const installs = getDiscordInstalls();
            const generation = beginWindowsRouteOperation();
            stopWindowsRouteWatchdog();
            await killDiscord();
            const recovery = await recoverWireSockNetwork();
            if (!recovery.ok) {
              throw new Error(`a rota anterior não encerrou com segurança (${recovery.residual.join(", ") || recovery.error || "rede não validada"}). Use "Restaurar internet".`);
            }
            assertWindowsRouteGeneration(generation);
            await startWireSockService(settingsDir(), undefined, windowsAllowedAppPaths(installs));
            await waitForWindowsRouteSettle(generation, "troca-rota-proton");
            if (!(await startDiscordAndConfirm(installs, "troca-rota-proton"))) {
              throw new Error("a nova rota foi comprovada, mas o Discord não iniciou");
            }
            windowsRouteStarted = true;
            windowsRouteState = "active";
            startWindowsRouteWatchdog();
            iniciarWgStatsWatchdog(wgStatsProvider);
            void waitForWindowsWgReady().then((result) => {
              logger.info("wiresock", "prontidao.diagnostica", result);
            }).catch((error) => {
              logger.warn("wiresock", "prontidao.diagnostica.erro", { erro: String((error as Error)?.message ?? error) });
            });
          } else if (IS_LINUX) {
            const preflight = await linuxPreflight();
            if (!preflight.ok && !linuxPreflightRepairable(preflight)) {
              throw new Error(`${linuxPreflightMessage(preflight)}${preflight.installCommand ? ` Execute: ${preflight.installCommand}` : ""}`);
            }
            if (speedTest) {
              await linuxActivate(() => {});
            } else {
              const refreshed = await runScript(["--refresh-route"]);
              if (refreshed.code !== 0) {
                throw new Error(tailErroScript(refreshed.stderr, 4) || "falha ao atualizar a rota WireGuard");
              }
            }
          }
        } catch (err) {
          if (IS_WINDOWS) {
            windowsRouteStarted = false;
            windowsRouteState = "failed";
            stopWindowsRouteWatchdog();
            try {
              await killDiscord();
              const recovery = await recoverWireSockNetwork();
              if (!recovery.ok) {
                windowsRouteState = "recovery_required";
                logger.error("wiresock", "troca-rota.rollback.incompleto", { residual: recovery.residual.join(", "), erro: recovery.error || "" });
              } else {
                windowsRouteState = "inactive";
              }
            } catch (rollbackError) {
              windowsRouteState = "recovery_required";
              logger.error("wiresock", "troca-rota.rollback.falhou", { erro: String((rollbackError as Error)?.message ?? rollbackError) });
            }
          }
          const error = String((err as Error)?.message ?? err);
          logger.error("proton", "nova rota nao ficou pronta", { server: gen.server, erro: error });
          return { ...gen, success: false, error: `A rota ${gen.server ?? "selecionada"} nao ficou pronta: ${error}` };
        }
      }
      return { ...saved };
    }).then((result) => {
    if (signal.aborted || ("cancelled" in result && result.cancelled)) {
      if (!event.sender.isDestroyed()) event.sender.send("proton-optimization-progress", { ...lastProgress, requestId, phase: "cancelled" });
    } else if (!("deferred" in result && result.deferred)) {
      sendProgress({ ...lastProgress, phase: result.success ? "completed" : "failed" });
    }
    refreshWindowStatus();
    refreshTray().catch(() => {});
    return result;
  }).catch((error) => {
    if (signal.aborted) return { success: false, cancelled: true, error: "Teste cancelado." };
    sendProgress({ ...lastProgress, phase: "failed" });
    return { success: false, error: String((error as Error)?.message ?? error) };
  }).finally(() => {
    event.sender.removeListener("destroyed", senderDestroyed);
    protonOptimizations.finish(operation);
  });
});

ipcMain.handle("report-bug", async (_event, payload: unknown) => {
  const p = (payload ?? {}) as { title?: string; description?: string; includeLogs?: boolean };
  let statusBypass = "INACTIVE";
  try {
    statusBypass = IS_LINUX ? await linuxStatus() : getStatus();
  } catch {}
  // Snapshot do tunel WireGuard no momento do report.
  const wgTunel = !isMac && statusBypass === "ACTIVE" ? await wgStatsProvider() : undefined;
  return submitBugReport(
    { title: String(p.title ?? ""), description: String(p.description ?? ""), includeLogs: !!p.includeLogs },
    { statusBypass, installsFlavours: ultimosFlavoursLinux, graphics: ultimosGraficosLinux, wgTunel },
  );
});

// A pagina reporta a ALTURA DO CONTEUDO. Com titleBarOverlay, setSize (janela externa)
// nao casa com essa medida: a janela crescia no Personalizado e nao encolhia ao voltar.
// setContentSize ajusta a area cliente — a mesma que o getBoundingClientRect mede.
ipcMain.on("resize-window", (_event, height: unknown) => {
  const h = Math.round(Number(height));
  if (!mainWindow || mainWindow.isDestroyed() || !Number.isFinite(h) || h <= 0) return;
  const [, contentH] = mainWindow.getContentSize();
  if (Math.abs(contentH - h) < 2) return;
  mainWindow.setContentSize(MAIN_WINDOW_WIDTH, h);
});

// O renderer avisa quando o tema muda para o overlay da barra de titulo
// (Windows) acompanhar; no Mac e Linux nao ha overlay a ajustar.
ipcMain.on('set-theme', (_event, value: unknown) => {
  if (value !== 'light' && value !== 'dark') return;
  theme = value;
  applyTitlebarTheme();
  if (logWindow && !logWindow.isDestroyed() && !isMac) {
    logWindow.setTitleBarOverlay(TITLEBAR[theme]);
  }
});
