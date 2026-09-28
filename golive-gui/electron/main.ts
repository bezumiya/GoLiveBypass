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
import { homedir } from "os";
import fs from "fs";
import { randomUUID } from "crypto";
import { execFileSync, execSync, spawn } from "child_process";
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
import { restoreBypassOnStartup, type StartupOptimizationResult } from "./startup-restore";
import { findWindowsDiscordInstall } from "./windows-discord-install";
import { collectWindowsDiscoveryPowerShell, collectWindowsDiscoverySnapshot, createWindowsDiscoveryCache, rootsForEnvironment, toPublicWindowsDiscoveryInstall, type WindowsDiscoveryEnvironment, type WindowsDiscoverySnapshotCollectors } from "./windows-discord-discovery";
import { waitForProcessRunning, waitForProcessStopped, type ProcessProbeState } from "./wait-condition";
import { TUNNEL_STARTUP_SETTLE_MS, waitForTunnelStartupSettle } from "./tunnel-startup";
import { linuxPreflightRepairable, parseLinuxPreflight, linuxPreflightMessage, type LinuxPreflight } from "./linux-preflight";
import { classifyLinuxHealth } from "./linux-health";
import { PROTON_CAPTCHA_IPC_CHANNEL, isAllowedProtonCaptchaNavigation, parseProtonCaptchaChallenge, validateProtonCaptchaResponse } from "./proton-captcha";
import { observeRouteDiagnostic } from "./route-diagnostics";
import { decideRouteProof, maskedIP, type RouteProbeResult } from "./route-proof";
import { prepareDiscordScopeProbes } from "./discord-scope-proof";
import { configureMacTunnel, ensureMacTunnelHelper, findMacHelper, getMacTunnelStats, getMacTunnelStatus, MAC_TUNNEL_HELPER, MacTunnelAuthorizationCancelled, macTunnelRouteInterfaceSync, pauseMacTunnel, stopMacTunnel, waitForMacTunnelHandshake, type StopMacTunnelResult } from "./macos-tunnel";

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
let startupRestoreInFlight = false;
let startupRestoreController: AbortController | null = null;
let startupRestorePromise: Promise<void> | null = null;
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

type ManualRouteCandidateState = {
  server: string;
  pingMs?: number;
  downloadMbps?: number;
  uploadMbps?: number;
  pingStatus: "not-tested" | "pending" | "success" | "failed";
  preflightStatus: "not-tested" | "pending" | "success" | "failed";
  speedStatus: "not-tested" | "pending" | "success" | "failed";
  failureReason?: string;
};

type ManualMeasurementSession = {
  measurementId: string;
  ownerId: number;
  username: string;
  country: string;
  freeOnly: boolean;
  autoPing: boolean;
  candidates: Map<string, ManualRouteCandidateState>;
  expiresAt: number;
};

// A medição automática continua sendo a autoridade. Este cache sanitizado fica
// disponível por alguns minutos após uma medição com speed-test, permitindo que
// o renderer ofereça as candidatas medidas para uma escolha manual posterior.
const MANUAL_MEASUREMENT_TTL_MS = 10 * 60_000;
const manualMeasurementSessions = new Map<number, ManualMeasurementSession>();
const manualRouteSelectionsInFlight = new Set<string>();

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
// <LOCALAPPDATA>/<Nome>/app-<versao>/resources ou diretamente em
// <LOCALAPPDATA>/<Nome>/resources. O bypass injeta igual — o que diferencia e o nome da
// pasta/do executavel. O "Vencord" citado pelos usuarios e o Vesktop (o desktop do Vencord);
// Vencord/Equicord em si sao builds que usam o plugin.
const PARALLEL_APPS = ["Vesktop", "Equibop", "Legcord"];
const ALL_APPS = [...FLAVOURS, ...PARALLEL_APPS];
const windowsDiscoveryCollectors: WindowsDiscoverySnapshotCollectors = {
  collectPowerShell: () => collectWindowsDiscoveryPowerShell(),
  listDirectory: (target) => diskFs.readdirSync(target) as string[],
  exists: (target) => diskFs.existsSync(target),
  isFile: (target) => {
    try { return diskFs.statSync(target).isFile(); } catch { return false; }
  },
  realpath: (target) => diskFs.realpathSync(target),
  readShortcut: (target) => {
    const shortcut = shell.readShortcutLink(target);
    return { target: shortcut.target, args: shortcut.args ?? "" };
  },
  findInstall: (root, flavour, exists, readdir) => findWindowsDiscordInstall(root, flavour, exists, readdir),
  isDirectory: (target) => {
    try { return diskFs.lstatSync(target).isDirectory(); } catch { return false; }
  },
  isSymbolicLink: (target) => {
    try { return diskFs.lstatSync(target).isSymbolicLink(); } catch { return false; }
  },
};

function readWindowsDiscoveryEnvironment(): WindowsDiscoveryEnvironment {
  return {
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    APPDATA: process.env.APPDATA,
    USERPROFILE: process.env.USERPROFILE,
    PUBLIC: process.env.PUBLIC,
    ProgramData: process.env.ProgramData,
    ProgramFiles: process.env.ProgramFiles,
    "ProgramFiles(x86)": process.env["ProgramFiles(x86)"],
    ProgramW6432: process.env.ProgramW6432,
  };
}
const windowsDiscoveryCache = createWindowsDiscoveryCache({
  platform: () => process.platform,
  nowMs: () => Date.now(),
  readEnv: readWindowsDiscoveryEnvironment,
  rootsForEnv: rootsForEnvironment,
  collectFresh: (env, roots) => collectWindowsDiscoverySnapshot(env, windowsDiscoveryCollectors, Date.now(), roots),
});

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

// No Linux o status vem do script (async); no Windows e sincrono.
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
let linuxHealthStatusNotificado = "";
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
      if (status === "ACTIVE") {
        cancelStartupBypassRestore();
        await withWireSockLifecycle("desativar-linux-bandeja", () => linuxDeactivate(() => {}));
        persistBypassEnabled(false);
      }
      else await withWireSockLifecycle("ativar-linux-bandeja", async () => {
        return linuxActivate(() => {});
      });
    } else if (getStatus() === "ACTIVE") {
      cancelStartupBypassRestore();
      await deactivateAll();
      persistBypassEnabled(false);
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
    try {
      const statusInicial = IS_LINUX ? await linuxStatus() : getStatus();
      if (statusInicial === "ACTIVE") {
        if (isMac) macRouteState = "active";
        iniciarWgStatsWatchdog(wgStatsProvider);
        startLinuxHealthWatchdog();
      }
    } catch {}

    // No login (start com --hidden / wasOpenedAtLogin) sobe so a bandeja; a janela aparece no clique.
    if (!launchedHidden()) createWindow();
    // Autostart: se a entrada de Run existe, garante que aponta para o exe ATUAL.
    // O valor congela o caminho de quando o toggle foi ativado; portable renomeado/
    // movido = boot falha em silencio com o checkbox marcado. Reescrever a cada
    // abertura cura (reg add idempotente). (issue: "nao abre mesmo ativando")
    syncStartupEntry();
    // No boot oculto do Windows, restaura somente a intenção persistida do
    // usuário. A otimização Proton acontece antes da ativação WireSock; o
    // Discord não é iniciado até a ativação terminar.
    void restoreBypassFromWindowsStartup();
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
  cancelStartupBypassRestore();
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
  const restore = IS_LINUX
    ? withWireSockLifecycle("encerrar-linux", () => linuxDeactivate(() => {}))
    : IS_WINDOWS
      ? withWireSockLifecycle("encerrar-windows", () => deactivateAll())
      // O ramo macOS de deactivateAll já entra na fila sozinho.
      : isMac ? deactivateAll() : Promise.resolve();
  restore
    .catch((error) => {
      logger.error("app", "limpeza no encerramento falhou", {
        erro: String((error as Error)?.message ?? error),
      });
    })
    .finally(() => app.quit());
});
// A bandeja é a dona do app: fechar a janela apenas esconde e o processo continua
// vivo em segundo plano. Encerramento explícito passa pelo menu Sair/before-quit.
app.on("window-all-closed", () => {});

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
type WindowsDiscoveryReadOptions = {
  forceRefresh?: boolean;
  allowStale?: boolean;
};
function logWindowsDiscoveryHealth(sourceFailure: string | undefined): void {
  if (!sourceFailure) return;
  const boundedCodes = new Set(["PROCESS_LIMIT", "UNINSTALL_LIMIT"]);
  const details = sourceFailure.split(",").slice(0, 2);
  for (const detail of details) {
    const match = /^(process|registry):([A-Za-z0-9_]+)$/.exec(detail.trim());
    if (!match) continue;
    const origem = match[1] as "process" | "registry";
    const code = match[2];
    const isBounded = boundedCodes.has(code);
    const status = code === "partial" || isBounded ? "partial" : "error";
    discordscan.scanFonte(origem, status, {
      truncated: isBounded,
      errorCode: /^[A-Z][A-Z0-9_]*$/.test(code) ? code : undefined,
    });
  }
}

function logWindowsDiscoveryRoots(env: WindowsDiscoveryEnvironment): void {
  for (const root of rootsForEnvironment(env)) {
    for (const flavour of ALL_APPS) {
      const rootPath = path.win32.join(root, flavour);
      discordscan.scanRaiz(rootPath, diskFs.existsSync(rootPath), flavour);
    }
  }
}


function getWinDiscordInstalls(options: WindowsDiscoveryReadOptions = {}): DiscordInstall[] {
  const env = readWindowsDiscoveryEnvironment();
  discordscan.scanInicio("win32", env.LOCALAPPDATA);
  logWindowsDiscoveryRoots(env);
  const snapshot = withNoAsar(() => windowsDiscoveryCache.read(options));
  logWindowsDiscoveryHealth(snapshot.sourceFailure);
  for (const candidate of snapshot.installs) {
    discordscan.scanCandidato(candidate.flavour, candidate.detectedBy);
  }
  const installs = snapshot.installs.map(toPublicWindowsDiscoveryInstall).map((install) => ({
    flavour: install.flavour,
    resources: install.resources,
    exePath: install.exePath,
  }));
  for (const install of installs) discordscan.scanInstall(install.resources, install.flavour);
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

function getDiscordInstalls(options: WindowsDiscoveryReadOptions = {}): DiscordInstall[] {
  // No Linux quem decide e o script standalone (--status/--yes); a varredura
  // win32/mac aqui so vale nos outros SOs — e logar o scan win no Linux so
  // confundiria o diagnostico ("localappdata=ausente" sem sentido).
  if (IS_LINUX) return [];
  return withNoAsar(() =>
    isMac ? getMacDiscordInstalls() : getWinDiscordInstalls(options),
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
    scope = prepareDiscordScopeProbes(getDiscordInstalls({ allowStale: true }), proton.findProtonConfgenExe());
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
  if ((!IS_WINDOWS && !isMac) || installs.length === 0) return true;
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

// ------------------------------------------------------------------ macOS: túnel por destino
// Sem primitiva por processo no macOS, o helper golive-tunnel roteia pela utun
// somente os destinos do Discord (ver electron/macos-tunnel.ts). O estado abaixo
// só cobre as transições; "ativo" continua sendo túnel + Discord rodando.
type MacRouteState = "inactive" | "preparing" | "active" | "recovery_required";
let macRouteState: MacRouteState = "inactive";

function macTunnelHelperPath(): string {
  let appPath = "";
  try { appPath = app.getAppPath(); } catch {}
  const found = findMacHelper(MAC_TUNNEL_HELPER, {
    resourcesPath: process.resourcesPath,
    appPath,
    execPath: process.execPath,
    cwd: process.cwd(),
    moduleDir: __dirname,
    arch: process.arch,
  });
  if (!found) throw new Error("O componente golive-tunnel não foi encontrado nesta instalação. Baixe o GoLiveBypass novamente.");
  return found;
}

function macTunnelActive(): boolean {
  return macTunnelRouteInterfaceSync() !== null;
}

async function applyMacProfile(operation: string, profile = protonCanonicalConfig()): Promise<void> {
  const status = await configureMacTunnel(fs.readFileSync(profile, "utf8"));
  logger.info("macos", "tunel.configurado", { operation, iface: status.interfaceName ?? "?", rotas: status.routes, pid: status.pid ?? 0 });
}

async function macRestoreNetwork(operation: string, force = false): Promise<StopMacTunnelResult> {
  const result = await stopMacTunnel({ force });
  const log = result.ok ? logger.info : logger.error;
  log("macos", "tunel.encerrado", { operation, ok: result.ok, residual: result.residual.join(", "), erro: result.error || "" });
  return result;
}

/**
 * O prompt de administrador vem antes de fechar o Discord: cancelar a senha
 * não pode deixar o usuário sem o cliente. Depois, o fluxo espelha o Windows:
 * fecha o Discord, aplica o perfil e reabre para o gateway nascer no túnel.
 */
async function macActivateRoute(installs: DiscordInstall[], operation: string): Promise<void> {
  await ensureMacTunnelHelper({ helperPath: macTunnelHelperPath() });
  await killDiscord();
  await applyMacProfile(operation);
  // Handshake é diagnóstico: o Discord abre mesmo sem ele, como no Windows.
  void waitForMacTunnelHandshake(15_000).then((ok) => {
    logger.info("macos", "tunel.handshake", { operation, ok, mode: "diagnostic-only" });
  });
  if (!(await startDiscordAndConfirm(installs, operation))) {
    throw new Error("O Discord não iniciou após preparar o túnel.");
  }
}

async function ativarTunelMac(installs: DiscordInstall[]): Promise<void> {
  const wasActive = macTunnelActive();
  macRouteState = "preparing";
  refreshWindowStatus();
  try {
    await withWireSockLifecycle("ativacao-mac", () => macActivateRoute(installs, "ativacao"));
    macRouteState = "active";
  } catch (cause) {
    if (cause instanceof MacTunnelAuthorizationCancelled) {
      macRouteState = wasActive ? "active" : "inactive";
      refreshWindowStatus();
      throw new Error("Ativação cancelada: o macOS precisa da senha de administrador para criar o túnel do Discord.");
    }
    const detail = String((cause as Error)?.message ?? cause);
    let closeError = "";
    try {
      await killDiscord();
    } catch (closeFailure) {
      closeError = String((closeFailure as Error)?.message ?? closeFailure);
    }
    const result = await withWireSockLifecycle("ativacao-mac.rollback", () => macRestoreNetwork("ativacao.rollback"))
      .catch((error): StopMacTunnelResult => ({ ok: false, residual: [], error: String((error as Error)?.message ?? error) }));
    macRouteState = result.ok ? "inactive" : "recovery_required";
    if (result.ok && !closeError) await startDiscordAndConfirm(installs, "ativacao.rollback");
    refreshWindowStatus();
    logger.error("macos", "ativacao.falhou", { erro: detail, rollback: result.ok ? "ok" : result.residual.join(", ") || result.error || "?" });
    throw new Error(
      result.ok
        ? `A ativação falhou (${detail}). O túnel foi removido e o Discord voltou à rede normal.`
        : `A ativação falhou (${detail}) e não consegui remover o túnel (${result.residual.join(", ") || result.error || "estado desconhecido"}). Use "Restaurar internet".`,
    );
  }
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
  const installs = getDiscordInstalls({ forceRefresh: true });
  if (installs.length === 0) {
    discordscan.ativacaoSemDiscord("nenhum install encontrado na varredura");
    throw new Error("Nenhum Discord encontrado.");
  }

  // Com WireSock, o estado ativo e somente tunel + Discord rodando. Reativar com a mesma
  // configuracao derrubaria conexoes a toa; nao consultamos nem alteramos o cliente.
  const assinatura = assinaturaAtivacao("");
  if (
    assinatura === assinaturaUltimaAtivacao &&
    getStatus({ forceRefresh: true }) === "ACTIVE"
  ) {
    logger.info("ativacao", "bypass ja ativo com a mesma proxy/modo; re-injecao ignorada");
    persistBypassEnabled(true);
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

  if (isMac) {
    await ativarTunelMac(installs);
    writeSessionMarker(installs);
    updateSharedSettings({ autoInject: false });
    assinaturaUltimaAtivacao = assinatura;
    iniciarWgStatsWatchdog(wgStatsProvider);
    startProtonFailoverMonitor();
    persistBypassEnabled(true);
    return;
  }

  const windowsWasActive = IS_WINDOWS && getStatus({ forceRefresh: true }) === "ACTIVE";
  const windowsGeneration = IS_WINDOWS ? beginWindowsRouteOperation() : 0;
  if (IS_WINDOWS) {
    try {
      await withWireSockLifecycle("preflight-wiresock", async () => {
        await ensureWireSockInstalled();
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
  // A chave autoInject pertence ao fluxo legado e nao decide mais o boot
  // WireGuard. A intencao atual e persistida em bypassEnabled logo abaixo.
  updateSharedSettings({ autoInject: false });
  // Ativacao concluiu de verdade: guarda a assinatura para a guarda de duplicada
  // (ver topo da funcao).
  assinaturaUltimaAtivacao = assinatura;
  // So Windows (WireSock) tem tunel WireGuard de verdade aqui — macOS ainda e o mecanismo
  // legado de PAC/Tor, sem interface wg nenhuma para vigiar.
  if (IS_WINDOWS) iniciarWgStatsWatchdog(wgStatsProvider);
  startProtonFailoverMonitor();
  persistBypassEnabled(true);
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

  const installs = getDiscordInstalls({ forceRefresh: true });

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
  if (isMac) {
    await withWireSockLifecycle("desativacao-mac", async () => {
      if (macTunnelActive() || (await getMacTunnelStatus()).running) {
        macRouteState = "preparing";
        await killDiscord();
        const result = await macRestoreNetwork("desativacao");
        if (!result.ok) {
          macRouteState = "recovery_required";
          throw new Error(`Não consegui encerrar o túnel do Discord (${result.residual.join(", ") || result.error || "estado desconhecido"}). Use "Restaurar internet".`);
        }
        macRouteState = "inactive";
        const restarted = await startDiscordAndConfirm(installs, "desativacao");
        clearSessionMarker();
        if (!restarted) {
          throw new Error("A rede foi restaurada, mas o Discord não iniciou. Abra o Discord novamente.");
        }
      }
      clearSessionMarker();
      macRouteState = "inactive";
    });
  }
}

function getStatus(options: WindowsDiscoveryReadOptions = { allowStale: true }): string {
  // isWireSockRunning() sozinho (so o servico do Windows) deixava o status "INACTIVE" para
  // sempre quando startWireSockService cai no fallback sem servico (usuario sem privilegio de
  // admin para instalar/iniciar o servico, mas o processo direto sobe e o tunel funciona): a
  // ativacao completava de verdade (Discord envelopado, WireSock rodando), mas a UI nunca via
  // isso e ficava presa mostrando "Ativar" -- exatamente o relato do beta tester.
  if (isMac) {
    const installs = getDiscordInstalls(options);
    if (installs.length === 0) return "NOT_FOUND";
    if (macRouteState === "preparing") return "CONNECTING";
    if (macRouteState === "recovery_required") return "RECOVERY_REQUIRED";
    return macTunnelActive() && discordIsRunning() ? "ACTIVE" : "INACTIVE";
  }
  if (IS_WINDOWS) {
    const installs = getDiscordInstalls(options);
    if (installs.length === 0) return "NOT_FOUND";
    if (windowsRouteState === "preparing") return "CONNECTING";
    if (windowsRouteState === "recovery_required") return "RECOVERY_REQUIRED";
    return windowsRouteStarted && isWireSockActive() && discordIsRunning() ? "ACTIVE" : "INACTIVE";
  }
  // getStatus e Windows-only: no Linux quem responde e linuxStatus().
  return "INACTIVE";
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
    const { code, stdout } = await runScript(["--status", "--json", "--non-interactive"]);
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
  const statusResult = await runScript(["--status", "--json", "--non-interactive"]);
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
  linuxHealthStatusNotificado = "";
}

function startLinuxHealthWatchdog() {
  if (!IS_LINUX || linuxHealthTimer !== null) return;
  linuxHealthTimer = setInterval(() => {
    if (linuxHealthInFlight || quitting) return;
    linuxHealthInFlight = true;
    void checkLinuxTunnelHealth().then((result) => {
      if (result.healthy) {
        linuxHealthFailures = 0;
      } else {
        linuxHealthFailures += 1;
        logger.warn("linux", "tunel.diagnostico", { mode: "log-only", falhas: linuxHealthFailures, motivo: result.reason });
      }
      // A janela le o MESMO estado que este watchdog observa. Sem esta
      // comparacao, fechar o Discord ou perder o namespace deixava o botao
      // preso no estado antigo ate reabrir a janela. So a mudanca vira evento.
      return linuxStatus().then((status) => {
        if (status === linuxHealthStatusNotificado) return;
        linuxHealthStatusNotificado = status;
        refreshWindowStatus();
      });
    }).catch((error) => logger.warn("linux", "health.erro", { erro: String((error as Error)?.message ?? error) }))
      .finally(() => { linuxHealthInFlight = false; });
  }, 15_000);
}

function wgStatsProvider(): Promise<WgTunnelStats> | WgTunnelStats {
  if (isMac) return getMacTunnelStats();
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

type ProtonConfigBackup = {
  canonical: string;
  backupFile?: string;
  existed: boolean;
};
type ProtonConfigBackupLike = ProtonConfigBackup | string | undefined;

function protonCanonicalConfig(): string {
  return path.join(settingsDir(), "wireguard.conf");
}

function backupProtonConfig(): ProtonConfigBackup {
  const canonical = protonCanonicalConfig();
  if (!fs.existsSync(canonical)) return { canonical, existed: false };
  const backupFile = `${canonical}.${randomUUID()}.backup`;
  try {
    fs.copyFileSync(canonical, backupFile);
    try { fs.chmodSync(backupFile, 0o600); } catch {}
    return { canonical, backupFile, existed: true };
  } catch (error) {
    try { fs.rmSync(backupFile, { force: true }); } catch {}
    throw error;
  }
}

function restoreProtonConfigBackup(backup: ProtonConfigBackupLike): void {
  if (!backup) return;
  if (typeof backup === "string") {
    if (!fs.existsSync(backup)) return;
    const canonical = protonCanonicalConfig();
    const temp = `${canonical}.${randomUUID()}.restore.tmp`;
    try {
      fs.copyFileSync(backup, temp);
      try { fs.chmodSync(temp, 0o600); } catch {}
      fs.renameSync(temp, canonical);
    } finally {
      try { fs.rmSync(temp, { force: true }); } catch {}
    }
    return;
  }
  if (!backup.existed || !backup.backupFile) {
    try { fs.rmSync(backup.canonical, { force: true }); } catch {}
    return;
  }
  if (!fs.existsSync(backup.backupFile)) return;
  const temp = `${backup.canonical}.${randomUUID()}.restore.tmp`;
  try {
    fs.copyFileSync(backup.backupFile, temp);
    try { fs.chmodSync(temp, 0o600); } catch {}
    fs.renameSync(temp, backup.canonical);
  } finally {
    try { fs.rmSync(temp, { force: true }); } catch {}
  }
}

function removeProtonConfigBackup(backup: ProtonConfigBackupLike): void {
  const backupFile = typeof backup === "string" ? backup : backup?.backupFile;
  if (!backupFile) return;
  try { fs.rmSync(backupFile, { force: true }); } catch {}
}

type ProtonRouteApplyContext = {
  status: string;
  username: string;
  country: string;
  freeOnly: boolean;
  autoPing: boolean;
  configBackup?: ProtonConfigBackupLike;
  previousSettings?: Record<string, unknown>;
};

async function applyProtonRouteResult(
  generated: proton.ProtonManualRouteResult,
  context: ProtonRouteApplyContext,
): Promise<proton.ProtonManualRouteResult> {
  const canonical = protonCanonicalConfig();
  const previousSettings = context.previousSettings ?? readSharedSettings();
  const saved: proton.ProtonManualRouteResult = {
    ...generated,
    success: true,
    manual: true,
    confFile: canonical,
    staged: false,
  };
  if (!updateSharedSettings({
    protonCountry: context.country,
    protonFreeOnly: context.freeOnly,
    protonAutoPing: context.autoPing,
    protonRoutePreference: "manual",
    protonLastServer: {
      ...saved,
      measurementUsername: context.username.trim().toLocaleLowerCase("en-US"),
      updatedAt: new Date().toISOString(),
    },
  })) {
    return { ...saved, success: false, error: "A rota foi preparada, mas não foi possível salvar suas preferências." };
  }
  if (context.status !== "ACTIVE") return saved;

  let installsForWindows: DiscordInstall[] = [];
  try {
    if (IS_WINDOWS) {
      installsForWindows = getDiscordInstalls({ forceRefresh: true });
      const generation = beginWindowsRouteOperation();
      stopWindowsRouteWatchdog();
      pararWgStatsWatchdog();
      await killDiscord();
      const recovery = await recoverWireSockNetwork();
      if (!recovery.ok) throw new Error(`a rota anterior não encerrou com segurança (${recovery.residual.join(", ") || recovery.error || "rede não validada"})`);
      assertWindowsRouteGeneration(generation);
      await startWireSockService(settingsDir(), undefined, windowsAllowedAppPaths(installsForWindows));
      await waitForWindowsRouteSettle(generation, "selecionar-rota-manual");
      if (!(await startDiscordAndConfirm(installsForWindows, "selecionar-rota-manual"))) {
        throw new Error("a nova rota foi comprovada, mas o Discord não iniciou");
      }
      windowsRouteStarted = true;
      windowsRouteState = "active";
      startWindowsRouteWatchdog();
      iniciarWgStatsWatchdog(wgStatsProvider);
    } else if (IS_LINUX) {
      await linuxDeactivate(() => {});
      const preflight = await linuxPreflight();
      if (!preflight.ok && !linuxPreflightRepairable(preflight)) {
        throw new Error(`${linuxPreflightMessage(preflight)}${preflight.installCommand ? ` Execute: ${preflight.installCommand}` : ""}`);
      }
      await linuxActivate(() => {});
    } else if (isMac) {
      await macActivateRoute(getDiscordInstalls({ forceRefresh: true }), "selecionar-rota-manual");
      macRouteState = "active";
    }
    return saved;
  } catch (error) {
    const message = String((error as Error)?.message ?? error);
    logger.error("proton", "rota manual nao ficou pronta", { server: generated.server, erro: message });
    try {
      restoreProtonConfigBackup(context.configBackup);
      updateSharedSettings({
        protonCountry: previousSettings.protonCountry,
        protonFreeOnly: previousSettings.protonFreeOnly,
        protonAutoPing: previousSettings.protonAutoPing,
        protonRoutePreference: previousSettings.protonRoutePreference,
        protonLastServer: previousSettings.protonLastServer,
      });
      if (IS_WINDOWS) {
        windowsRouteStarted = false;
        windowsRouteState = "failed";
        stopWindowsRouteWatchdog();
        await killDiscord();
        const recovery = await recoverWireSockNetwork();
        if (!recovery.ok) {
          windowsRouteState = "recovery_required";
          throw new Error(recovery.error || "a rede não pôde ser restaurada");
        }
        await startWireSockService(settingsDir(), undefined, windowsAllowedAppPaths(installsForWindows));
        await waitForWindowsRouteSettle(windowsRouteGeneration, "selecionar-rota-manual.rollback");
        if (!(await startDiscordAndConfirm(installsForWindows, "selecionar-rota-manual.rollback"))) {
          throw new Error("o Discord não voltou após restaurar a rota anterior");
        }
        windowsRouteStarted = true;
        windowsRouteState = "active";
        startWindowsRouteWatchdog();
        iniciarWgStatsWatchdog(wgStatsProvider);
      } else if (IS_LINUX) {
        await linuxDeactivate(() => {});
        await linuxActivate(() => {});
      } else if (isMac) {
        await macActivateRoute(getDiscordInstalls({ forceRefresh: true }), "selecionar-rota-manual.rollback");
        macRouteState = "active";
      }
    } catch (rollbackError) {
      if (IS_WINDOWS) windowsRouteState = "recovery_required";
      logger.error("proton", "rota manual.rollback.falhou", { erro: String((rollbackError as Error)?.message ?? rollbackError) });
    }
    return { ...generated, success: false, manual: true, error: `A rota ${generated.server ?? "selecionada"} não ficou pronta: ${message}` };
  }
}

async function applyProtonFailoverCandidate(
  candidate: ProtonRouteMetadata,
  generation: number,
): Promise<boolean> {
  const canonical = path.join(settingsDir(), "wireguard.conf");
  if (!fs.existsSync(canonical) || !fs.existsSync(candidate.confFile)) return false;
  if (generation !== protonFailoverGeneration || quitting) return false;

  const installs = IS_WINDOWS ? getDiscordInstalls({ forceRefresh: true }) : [];
  const windowsGeneration = windowsRouteGeneration;
  if (IS_WINDOWS) {
    if (windowsRouteState !== "active" || !windowsRouteStarted || !isWireSockActive() || !discordIsRunning()) return false;
    stopWindowsRouteWatchdog();
  } else if (IS_LINUX) {
    stopLinuxHealthWatchdog();
  } else if (isMac) {
    if (!macTunnelActive() || !discordIsRunning()) return false;
  }
  pararWgStatsWatchdog();
  const switchProfile = async (profile: string): Promise<boolean> => {
    if (isMac) {
      // O helper troca o peer na mesma utun; as rotas do Discord não piscam.
      await applyMacProfile("failover", profile);
      return waitForMacTunnelHandshake(FAILOVER_ROUTE_TIMEOUT_MS);
    }
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
  // Captura local: stopProtonFailoverMonitor() pode zerar o tracker enquanto
  // esta amostra espera linuxStatus/linuxWgStats; o teste de geração abaixo
  // garante que o gatilho de uma amostra velha nunca dispare failover.
  const tracker = protonFailoverTracker;
  if (generation !== protonFailoverGeneration || !tracker || quitting || protonFailoverDisabled) return;
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
  } else if (isMac) {
    const tunnelActive = macTunnelActive();
    const stats = await getMacTunnelStats();
    sample = {
      discordRunning: discordIsRunning(),
      tunnelActive,
      stats,
      statsFailureEvidence: !tunnelActive || /sem peer|ECONNREFUSED|ENOENT/i.test(stats.error || ""),
    };
  } else {
    return;
  }

  const health = classifyFailoverHealth(sample);
  const observation = tracker.observe(health);
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
  if (!IS_WINDOWS && !IS_LINUX && !isMac) return;
  stopProtonFailoverMonitor();
  const generation = protonFailoverGeneration;
  void (async () => {
    const settings = readSharedSettings();
    if (settings.vpnMode === "custom" || settings.protonAutoFailover === false) return;
    const username = typeof settings.protonUsername === "string" ? settings.protonUsername.trim() : "";
    if (!username) return;
    const plan = await resolveProtonPlan(username);
    if (generation !== protonFailoverGeneration || plan.status !== "free" || quitting) return;
    const active = IS_LINUX
      ? await linuxStatus() === "ACTIVE"
      : isMac
        ? macTunnelActive() && discordIsRunning()
        : windowsRouteState === "active" && windowsRouteStarted && isWireSockActive() && discordIsRunning();
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
  const operationId = logger.createOperationId("windows-readiness");
  const finish = (result: WindowsRouteReadiness): WindowsRouteReadiness => {
    logger.logEvent("info", "wiresock", "readiness.complete", {
      operation_id: operationId,
      phase: "readiness",
      source: result.source,
      state: result.state,
    }, {
      verified: result.verified,
      detail: result.detail || null,
    });
    return result;
  };
  logger.logEvent("info", "wiresock", "readiness.start", {
    operation_id: operationId,
    phase: "readiness",
  }, { timeout_ms: timeoutMs });
  const deadline = Date.now() + timeoutMs;
  let last: WgTunnelStats | undefined;
  let lastWireSock: WireSockConnectionStatus = getWireSockConnectionStatus();
  let cliFlowSamples = 0;
  let adapterFlowSamples = 0;
  let previousAdapterTraffic: ReturnType<typeof getWireSockAdapterTraffic> = null;
  while (Date.now() < deadline) {
    lastWireSock = getWireSockConnectionStatus();
    if (lastWireSock.source === "cli" && lastWireSock.state === "disconnected") {
      return finish({
        verified: false,
        state: "disconnected",
        source: "cli",
        detail: "WireSock informou que a rota está desconectada",
      });
    }
    last = getWgStats();
    const readiness = classifyWgReadiness(last, true);
    if (readiness.ready) {
      return finish({ verified: true, state: "connected", source: "wg", detail: "handshake recente e tráfego WireGuard bidirecional confirmados" });
    }
    // Instalações oficiais nem sempre incluem wg.exe. Dois estados Connected
    // consecutivos com endereço externo são a confirmação funcional da CLI;
    // quando wg.exe existe, a validação de handshake/RX/TX acima é preferida.
    if (lastWireSock.source === "cli" && lastWireSock.state === "connected" && lastWireSock.externalAddress) {
      cliFlowSamples++;
      if (cliFlowSamples >= 2) {
        return finish({ verified: true, state: "connected", source: "cli", detail: `túnel conectado; endereço externo ${lastWireSock.externalAddress}` });
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
        return finish({ verified: true, state: "connected", source: "service", detail: `ProTUN ativo com tráfego RX/TX (${traffic.receivedBytes}/${traffic.sentBytes})` });
      }
    } else {
      adapterFlowSamples = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const motivo = last?.handshakeAgoS === null
    ? "nenhum handshake WireGuard foi confirmado"
    : (last?.error || "o peer WireGuard não ficou pronto");
  return finish({
    verified: false,
    state: lastWireSock.state === "disconnected" ? "disconnected" : "unverified",
    source: lastWireSock.source === "none" ? "none" : lastWireSock.source,
    detail: motivo,
  });
}

function linuxStatus(): Promise<string> {
  const now = Date.now();
  if (linuxStatusInFlight) return linuxStatusInFlight;
  if (linuxStatusCache && linuxStatusCache.expiresAt > now) return Promise.resolve(linuxStatusCache.value);
  const generation = ++linuxStatusGeneration;
  const operation = runScript(["--status", "--json", "--non-interactive"])
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
        const discords = Array.isArray(data?.discords) ? data.discords : [];
        if (data?.graphics && typeof data.graphics === "object") {
          const g = data.graphics as Record<string, unknown>;
          ultimosGraficosLinux = `backend=${String(g.backend ?? "?")} wayland=${String(g.waylandDisplay ?? "")} session=${String(g.sessionType ?? "")} portal=${String(g.portal ?? "?")}`;
        }
        const netnsAtivo = data?.netns === true;
        const anyRunning = discords.some((d: { running?: string; inNamespace?: string }) => d.running === "sim" && (!netnsAtivo || d.inNamespace === "sim"));
        const status = discords.length === 0 ? "NOT_FOUND" : (netnsAtivo && anyRunning ? "ACTIVE" : "INACTIVE");
        // O status INACTIVE tambem precisa liberar qualquer nova ativacao:
        // somente ACTIVE confirmado e um no-op.
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
    .replace(/(?:\x1b|\u009b|\uFFFD)\[[0-?]*[ -/]*[@-~]/g, "");
}

function tailErroScript(stderr: string, linhas: number): string {
  const uteis = stripAnsiCodes(stderr)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^ERROR: ld\.so:/.test(l))
    // Passos informativos do teardown ocupavam as ultimas linhas e viravam a
    // mensagem de erro da UI, escondendo o "[X] ..." que explica a falha.
    .filter((l) => !/^\[\*\]\s*Removendo namespace de rede/i.test(l))
    .filter((l) => !/^\[OK\]\s*Tunel WireGuard encerrado/i.test(l));
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
  updateSharedSettings({
    protonRoutePreference: "auto",
    protonLastServer: { ...gen, measurementUsername: username.trim().toLowerCase() },
  });
}

// No autostart do Windows nao existe renderer para conduzir a selecao Proton. A
// medicao roda aqui, antes de activateBypass(), e grava o perfil somente depois
// de o confgen entregar uma configuracao valida. Se falhar, o arquivo anterior
// continua no lugar e a ativacao abaixo faz o fallback normal.
async function optimizeProtonRouteAtStartup(
  signal?: AbortSignal,
): Promise<StartupOptimizationResult & { server?: string; skipped?: boolean }> {
  const settings = readSharedSettings() as any;
  if ((settings.vpnMode || "proton") !== "proton") {
    logger.info("proton", "otimizacao de boot ignorada para configuracao customizada", {});
    return { success: true, skipped: true };
  }

  const username = (await recoverProtonUsername()) || (settings.protonUsername as string) || "";
  if (!username) {
    return { success: false, error: "Nenhuma conta ProtonVPN conectada." };
  }
  if (signal?.aborted || quitting) {
    return { success: false, error: "Otimização de boot cancelada." };
  }
  const manualPreference = settings.protonRoutePreference === "manual"
    || (settings.protonRoutePreference !== "auto" && settings.protonLastServer?.manual === true);
  if (
    manualPreference &&
    settings.protonLastServer?.server &&
    fs.existsSync(path.join(settingsDir(), "wireguard.conf"))
  ) {
    logger.info("proton", "otimizacao de boot ignorada; rota manual salva será preservada", {
      server: settings.protonLastServer.server,
    });
    return { success: true, server: settings.protonLastServer.server, skipped: true };
  }

  const country = (settings.protonCountry as string) || "";
  const plan = await resolveProtonPlan(username);
  const freeOnly = plan.status !== "premium";
  const autoPing = settings.protonAutoPing !== false;
  let generated: Awaited<ReturnType<typeof proton.generateOptimalProtonConfig>>;
  try {
    generated = await withWireSockLifecycle("otimizacao-boot", () =>
      proton.generateOptimalProtonConfig(settingsDir(), {
        username,
        countries: country || undefined,
        freeOnly,
        autoPing,
        speedTest: true,
        signal,
        onProgress: (progress) => {
          logger.info("proton", "otimizacao.boot.progresso", {
            phase: progress.phase,
            total: progress.total,
            tested: progress.tested,
            succeeded: progress.succeeded,
            server: progress.server || "",
          });
        },
      }),
    );
  } catch (error) {
    return {
      success: false,
      error: String((error as Error)?.message ?? error),
    };
  }

  if (signal?.aborted || quitting) {
    return { success: false, error: "Otimização de boot cancelada." };
  }
  if (!generated.success) {
    return { success: false, error: generated.error || "Falha ao otimizar a rota ProtonVPN." };
  }

  const saved = {
    ...generated,
    measurementUsername: username.trim().toLowerCase(),
    measurementVersion: proton.MEASUREMENT_CRITERION_VERSION,
    measuredAt: new Date().toISOString(),
    measurementCountry: country,
    measurementFreeOnly: freeOnly,
    measurementAutoPing: autoPing,
  };
  if (!updateSharedSettings({
    protonCountry: country,
    protonFreeOnly: freeOnly,
    protonAutoPing: autoPing,
    protonRoutePreference: "auto",
    protonLastServer: saved,
  })) {
    return { success: false, error: "A rota foi preparada, mas não foi possível salvar suas preferências." };
  }
  return { success: true, server: generated.server };
}

type LinuxElevationEventName =
  | "prompt.requested"
  | "prompt.finished"
  | "prompt.unavailable"
  | "prompt.failed"
  | "sudo.cached"
  | "sudo.validation"
  | "sudo.credential_store"
  | "pkexec.invoked"
  | "pkexec.result"
  | "authorization.requested"
  | "authorization";
type LinuxElevationProvider = "none" | "root" | "sudo" | "zenity" | "kdialog" | "askpass" | "pkexec" | "tty" | "unknown";
type LinuxElevationResult = "not_attempted" | "requested" | "accepted" | "rejected" | "cancelled" | "unavailable" | "failed" | "cached" | "empty" | "authorized" | "unknown";
type LinuxElevationDetails = {
  input?: "nonempty" | "empty" | "unknown" | "not_applicable";
  code?: "0" | "1" | "2" | "126" | "127" | "other";
  reason?: "provider_missing" | "temporary_file";
  phase?: "dialog" | "polkit" | "password" | "tty" | "pre_activation";
  stderr?: "present" | "empty";
};
type LinuxElevationRecord = {
  event: LinuxElevationEventName;
  provider: LinuxElevationProvider;
  result: LinuxElevationResult;
  details: LinuxElevationDetails;
};
type LinuxElevationParserState = { pending: string };

const LINUX_ELEVATION_PREFIX = "[elevation]";
const LINUX_ELEVATION_MAX_LINE_LENGTH = 256;
const LINUX_ELEVATION_LOG_EVENTS: Record<LinuxElevationEventName, string> = {
  "prompt.requested": "elevation.prompt.requested",
  "prompt.finished": "elevation.prompt.finished",
  "prompt.unavailable": "elevation.prompt.unavailable",
  "prompt.failed": "elevation.prompt.failed",
  "sudo.cached": "elevation.sudo.cached",
  "sudo.validation": "elevation.sudo.validation",
  "sudo.credential_store": "elevation.sudo.credential_store",
  "pkexec.invoked": "elevation.pkexec.invoked",
  "pkexec.result": "elevation.pkexec.result",
  "authorization.requested": "elevation.authorization.requested",
  authorization: "elevation.authorization",
};
const LINUX_ELEVATION_PROVIDERS = new Set<LinuxElevationProvider>([
  "none", "root", "sudo", "zenity", "kdialog", "askpass", "pkexec", "tty", "unknown",
]);
const LINUX_ELEVATION_RESULTS = new Set<LinuxElevationResult>([
  "not_attempted", "requested", "accepted", "rejected", "cancelled", "unavailable", "failed", "cached", "empty", "authorized", "unknown",
]);
const LINUX_ELEVATION_DETAIL_RULES: Record<LinuxElevationEventName, readonly (keyof LinuxElevationDetails)[]> = {
  "prompt.requested": ["input", "phase"],
  "prompt.finished": ["input", "code", "stderr"],
  "prompt.unavailable": ["input", "reason"],
  "prompt.failed": ["input", "reason"],
  "sudo.cached": ["phase"],
  "sudo.validation": ["code", "phase"],
  "sudo.credential_store": ["reason", "phase"],
  "pkexec.invoked": ["phase"],
  "pkexec.result": ["code", "phase"],
  "authorization.requested": ["phase"],
  authorization: ["phase"],
};
const LINUX_ELEVATION_DETAIL_VALUES: {
  [K in keyof LinuxElevationDetails]-?: readonly NonNullable<LinuxElevationDetails[K]>[];
} = {
  input: ["nonempty", "empty", "unknown", "not_applicable"],
  code: ["0", "1", "2", "126", "127", "other"],
  reason: ["provider_missing", "temporary_file"],
  phase: ["dialog", "polkit", "password", "tty", "pre_activation"],
  stderr: ["present", "empty"],
};

function parseLinuxElevationLine(line: string): LinuxElevationRecord | null {
  // O parser recebe dados de stderr, mas nunca confia no canal nem no conteúdo:
  // somente uma linha completa, curta e com a gramática fixa abaixo pode gerar log.
  if (line.length === 0 || line.length > LINUX_ELEVATION_MAX_LINE_LENGTH || !line.startsWith(`${LINUX_ELEVATION_PREFIX} `)) {
    return null;
  }
  const fields = line.split(" ");
  if (fields.length < 5 || fields[0] !== LINUX_ELEVATION_PREFIX) return null;

  const event = fields[1] as LinuxElevationEventName;
  if (!Object.prototype.hasOwnProperty.call(LINUX_ELEVATION_LOG_EVENTS, event)) return null;
  if (!fields[2].startsWith("provider=") || !fields[3].startsWith("result=")) return null;
  const provider = fields[2].slice("provider=".length) as LinuxElevationProvider;
  const result = fields[3].slice("result=".length) as LinuxElevationResult;
  if (!LINUX_ELEVATION_PROVIDERS.has(provider) || !LINUX_ELEVATION_RESULTS.has(result)) return null;

  const details: LinuxElevationDetails = {};
  const detailKeys: (keyof LinuxElevationDetails)[] = [];
  for (const field of fields.slice(4)) {
    const separator = field.indexOf("=");
    if (separator <= 0 || separator !== field.lastIndexOf("=")) return null;
    const key = field.slice(0, separator) as keyof LinuxElevationDetails;
    const value = field.slice(separator + 1);
    if (!Object.prototype.hasOwnProperty.call(LINUX_ELEVATION_DETAIL_VALUES, key) || details[key] !== undefined) return null;
    const allowed = LINUX_ELEVATION_DETAIL_VALUES[key] as readonly string[];
    if (!allowed.includes(value)) return null;
    details[key] = value as never;
    detailKeys.push(key);
  }

  const expected = LINUX_ELEVATION_DETAIL_RULES[event];
  if (detailKeys.length !== expected.length || expected.some((key, index) => details[key] === undefined || detailKeys[index] !== key)) return null;
  return { event, provider, result, details };
}

function persistLinuxElevationEvent(record: LinuxElevationRecord): void {
  const data: logger.LogContext = {
    source: "standalone",
    provider: record.provider,
    result: record.result,
  };
  if (record.details.phase !== undefined) data.phase = record.details.phase;
  if (record.details.input !== undefined) data.input = record.details.input;
  if (record.details.code !== undefined) data.code = record.details.code;
  if (record.details.reason !== undefined) data.reason = record.details.reason;
  if (record.details.stderr !== undefined) data.stderr = record.details.stderr;
  try {
    logger.logEvent("info", "linux", LINUX_ELEVATION_LOG_EVENTS[record.event], data);
  } catch {
    // Diagnostico nunca pode transformar uma falha de logging em falha de ativacao.
  }
}

function consumeLinuxElevationEvents(chunk: string, state: LinuxElevationParserState): void {
  if (typeof chunk !== "string") return;
  const input = state.pending + chunk;
  state.pending = "";
  const lines = input.split("\n");
  const tail = lines.pop() ?? "";
  for (const rawLine of lines) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const record = parseLinuxElevationLine(line);
    if (record) persistLinuxElevationEvent(record);
  }

  // Nunca acumula stderr arbitrario: só retém um prefixo que ainda pode virar uma
  // linha de elevacao valida, e sempre dentro de um limite pequeno.
  const isElevationPrefix = LINUX_ELEVATION_PREFIX.startsWith(tail) || tail.startsWith(`${LINUX_ELEVATION_PREFIX} `);
  if (tail.length > 0 && tail.length <= LINUX_ELEVATION_MAX_LINE_LENGTH && isElevationPrefix) {
    state.pending = tail;
  }
}

async function linuxActivate(onChunk: (c: string) => void) {
  const elevationParserState: LinuxElevationParserState = { pending: "" };
  const forwardLinuxChunk = (chunk: string) => {
    consumeLinuxElevationEvents(chunk, elevationParserState);
    onChunk(chunk);
  };
  let preflight = await linuxPreflight();
  if (!preflight.ok && linuxPreflightRepairable(preflight)) {
    const ensured = await runScript(["--ensure-dependencies"], forwardLinuxChunk);
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
  // Reconfirma dentro da operacao; somente o ACTIVE confirmado vira no-op.
  if (await linuxStatus() === "ACTIVE") {
    logger.info("linux", "ativacao duplicada ignorada; tunel ja ativo");
    persistBypassEnabled(true);
    return;
  }
  await ensureProtonActivationProfile();
  updateSharedSettings({ routeMode: "wireguard" });
  const { code, stderr } = await runScript(["--yes", "--cleanup-legacy"], forwardLinuxChunk);
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
    const estado = await runScript(["--status", "--json", "--non-interactive"]);
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
  // autoInject e legado; bypassEnabled e a preferencia atual da GUI e so e
  // gravada depois que o namespace WireGuard terminou de subir.
  updateSharedSettings({ autoInject: false });
  iniciarWgStatsWatchdog(linuxWgStats);
  startLinuxHealthWatchdog();
  linuxStatusCache = null;
  persistBypassEnabled(true);
}

async function linuxDeactivate(onChunk: (c: string) => void) {
  stopProtonFailoverMonitor();
  pararWgStatsWatchdog();
  stopLinuxHealthWatchdog();
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
    await withWireSockLifecycle("ativar-linux", () => linuxActivate(() => {}));
  } else {
    await activateBypass(event);
  }
  refreshTray().catch(() => {});
});
ipcMain.handle("deactivate", async (event) => {
  // Deactivate EXPLICITO (botao/bandeja): o usuario nao quer mais — zera a flag de
  // auto-injecao do boot. O quit limpo NAO passa aqui: ele desmonta a sessao, mas
  // preserva a intencao para o proximo login do Windows.
  cancelStartupBypassRestore();
  updateSharedSettings({ autoInject: false });
  if (IS_LINUX) {
    await withWireSockLifecycle("desativar-linux", () => linuxDeactivate(() => {}));
  } else {
    await deactivateAll();
  }
  persistBypassEnabled(false);
  refreshTray().catch(() => {});
});
ipcMain.handle("restore-internet", async () => {
  if (isMac) {
    cancelStartupBypassRestore();
    return withWireSockLifecycle("restaurar-internet-mac", async () => {
      stopProtonFailoverMonitor();
      pararWgStatsWatchdog();
      const hadTunnel = macTunnelActive() || (await getMacTunnelStatus()).running;
      const installs = hadTunnel ? getDiscordInstalls({ forceRefresh: true }) : [];
      macRouteState = "preparing";
      if (hadTunnel) {
        try {
          await killDiscord();
        } catch (error) {
          macRouteState = "recovery_required";
          throw error;
        }
      }
      // force: um helper travado só sai com outro prompt de administrador.
      const result = await macRestoreNetwork("restaurar-internet", true);
      macRouteState = result.ok ? "inactive" : "recovery_required";
      if (result.ok) {
        clearSessionMarker();
        persistBypassEnabled(false);
      }
      if (hadTunnel && result.ok && !(await startDiscordAndConfirm(installs, "restaurar-internet"))) {
        return { ok: false, residual: [], error: "A rede foi restaurada, mas o Discord não iniciou. Abra o Discord novamente." };
      }
      refreshTray().catch(() => {});
      return { ok: result.ok, residual: result.residual, error: result.error };
    });
  }
  if (!IS_WINDOWS) return { ok: false, error: "Esta recuperação só está disponível no Windows e no macOS." };
  cancelStartupBypassRestore();
  return withWireSockLifecycle("restaurar-internet", async () => {
    windowsRouteGeneration += 1;
    windowsRouteStarted = false;
    windowsRouteState = "preparing";
    stopWindowsRouteWatchdog();
    // Releia dentro da fila: uma ativação concorrente pode ter subido o túnel
    // depois da leitura original, e restaurar não pode sair deixando essa sessão
    // viva por causa de um snapshot obsoleto.
    const hadWireSock = isWireSockActive();
    const installs = hadWireSock
      ? getDiscordInstalls({ forceRefresh: true })
      : [];
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
    if (recovery.ok) persistBypassEnabled(false);
    // Nao relancar o Discord enquanto o WFP ainda pode estar instalado ou a
    // resolucao/HTTPS nao foi comprovada saudavel.
    if (hadWireSock && recovery.ok) {
      const restarted = await startDiscordAndConfirm(installs, "restaurar-internet");
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
// (que gravasse o arquivo com uma chave so) apagava a routeMode e o runtime nascia
// "auto" enquanto a GUI mostrava outra coisa (issue #108).
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

function readBypassEnabled(): boolean {
  return readSharedSettings().bypassEnabled === true;
}

function persistBypassEnabled(enabled: boolean): boolean {
  const ok = updateSharedSettings({ bypassEnabled: enabled });
  if (!ok) {
    logger.warn("bypass", "preferencia de ativação não foi persistida", { enabled });
  }
  return ok;
}

function cancelStartupBypassRestore(): void {
  if (!startupRestoreController) return;
  logger.info("bypass", "restauração automática de boot cancelada por ação do usuário", {});
  startupRestoreController.abort();
}

function restoreBypassFromWindowsStartup(): Promise<void> {
  if (!IS_WINDOWS || !launchedHidden() || !readBypassEnabled()) return Promise.resolve();
  if (startupRestorePromise) return startupRestorePromise;

  const controller = new AbortController();
  startupRestoreController = controller;
  startupRestoreInFlight = true;

  const operation = restoreBypassOnStartup({
    enabled: true,
    signal: controller.signal,
    isActive: () => getStatus() === "ACTIVE" || isWireSockActive(),
    optimize: (signal) => optimizeProtonRouteAtStartup(signal),
    activate: () => activateBypass({}),
    onOptimizationFailure: (error) => {
      logger.warn("proton", "otimizacao de boot falhou; tentando rota salva ou selecao rapida", {
        erro: error || "motivo não informado",
      });
    },
  }).then((result) => {
    if (result.status === "activated") {
      logger.info("bypass", "restauração automática concluída", {
        otimizada: result.optimized,
        fallback: result.usedFallback,
        erroOtimizacao: result.optimized ? "" : result.error || "",
      });
    } else if (result.status === "already-active") {
      logger.info("bypass", "restauração automática ignorada; túnel já ativo", {});
    } else if (result.status === "cancelled") {
      logger.info("bypass", "restauração automática cancelada", { erro: result.error || "" });
    } else if (result.status === "failed") {
      // A preferência permanece verdadeira: a próxima abertura terá outra
      // oportunidade de usar a rota salva ou de otimizar novamente.
      logger.error("bypass", "restauração automática falhou; preferência preservada", {
        erro: result.error || "motivo não informado",
        bypassEnabled: true,
      });
    }
  }).catch((error) => {
    logger.error("bypass", "erro inesperado na restauração automática", {
      erro: String((error as Error)?.message ?? error),
      bypassEnabled: true,
    });
  });

  const tracked = operation.finally(() => {
    if (startupRestorePromise === tracked) {
      startupRestorePromise = null;
      startupRestoreController = null;
      startupRestoreInFlight = false;
    }
    refreshWindowStatus();
    refreshTray().catch(() => {});
  });
  startupRestorePromise = tracked;
  return tracked;
}

async function recoverProtonUsername(): Promise<string> {
  const saved = await proton.getSavedSessionUsername(settingsDir());
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

// O unico modo de rede existente e o tunel WireGuard por aplicativo: o Windows
// nunca leu outra coisa e no Linux o updateSharedSettings reescreve o settings
// compartilhado para "wireguard" no boot e em toda gravacao (migracao do
// settings.json legado, que podia ter "tor"/"free"/"auto").
function readNetMode(): string {
  if (IS_WINDOWS) return "wireguard";
  try {
    const file = path.join(settingsDir(), "settings.json");
    if (!fs.existsSync(file)) return "wireguard";
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return typeof data.routeMode === "string" && data.routeMode ? data.routeMode : "wireguard";
  } catch {
    return "wireguard";
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

// ------------------------------------------------------------------ diagnostico / modo dev
const ISSUE_REPO = "bezumiya/GoLiveBypass";
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
  if (status !== "ACTIVE") return "n/a";
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
  const wgTunel = status === "ACTIVE" ? await wgStatsProvider() : undefined;
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
      updateSharedSettings({ wgConfOriginalName: originalName, protonLastServer: undefined, protonRoutePreference: undefined });
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
        const probe = await runScript(["--probe", "--json", "--non-interactive"]);
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
  const recoveredUsername = (await recoverProtonUsername()) || (s.protonUsername as string) || "";
  return {
    vpnMode: (s.vpnMode as string) || "proton",
    username: recoveredUsername,
    country: (s.protonCountry as string) || "",
    freeOnly: s.protonFreeOnly !== false,
    autoPing: s.protonAutoPing !== false,
    autoFailover: s.protonAutoFailover !== false,
    routePreference: s.protonRoutePreference === "manual"
      ? "manual"
      : s.protonRoutePreference === "auto" ? "auto" : s.protonLastServer?.manual === true ? "manual" : "auto",
    lastServer: s.protonLastServer,
  };
});

ipcMain.handle("get-proton-plan", async (_event, options?: { force?: boolean }) => {
  const s = readSharedSettings() as any;
  const username = (await recoverProtonUsername()) || (s.protonUsername as string) || "";
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
    if (settings?.routePreference === "auto" || settings?.routePreference === "manual") {
      patch.protonRoutePreference = settings.routePreference;
    }
    return updateSharedSettings(patch);
  });
  if (!filterChanged && settings?.autoFailover === true) startProtonFailoverMonitor();
  return result;
});

ipcMain.handle("check-proton-session", async (_event, username?: string) => {
  const s = readSharedSettings() as any;
  const user = username || (await recoverProtonUsername()) || (s.protonUsername as string) || "";
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

ipcMain.handle("logout-proton", async (event) => {
  protonLoginGeneration++;
  protonOptimizations.invalidate();
  invalidateProtonPlanCache();
  stopProtonFailoverMonitor();
  manualMeasurementSessions.delete(event.sender.id);
  return withWireSockLifecycle("logout-proton", async () => {
    const sessionFile = proton.getProtonSessionFile(settingsDir());
    try {
      if (fs.existsSync(sessionFile)) fs.unlinkSync(sessionFile);
    } catch {}
    updateSharedSettings({ protonLastServer: undefined, protonRoutePreference: undefined });
    clearProtonRoutePool();
    return true;
  });
});

type ProtonRouteDiscoveryOptions = {
  requestId?: string;
  measurePing?: boolean;
};

ipcMain.handle("cancel-proton-route-discovery", (event, requestId: string) =>
  protonOptimizations.cancel(requestId, event.sender.id));

ipcMain.handle("discover-proton-routes", async (event, options?: ProtonRouteDiscoveryOptions) => {
  if (startupRestoreInFlight) {
    return { success: false, error: "A rota de boot ainda está sendo restaurada." };
  }
  const requestId = typeof options?.requestId === "string" && options.requestId.length <= 128
    ? options.requestId : `proton-discovery-${Date.now()}`;
  const measurePing = options?.measurePing === true;
  const operation = protonOptimizations.start(requestId, event.sender.id);
  if (!operation) return { success: false, error: "Já existe uma seleção de rota em andamento." };

  const signal = operation.controller.signal;
  const senderDestroyed = () => {
    protonOptimizations.cancel(requestId, event.sender.id);
    manualMeasurementSessions.delete(event.sender.id);
  };
  const sendDiscoveryProgress = (progress: proton.ProtonOptimizationProgress) => {
    if (!protonOptimizations.isCurrent(operation) || event.sender.isDestroyed()) return;
    try {
      event.sender.send("proton-route-discovery-progress", { ...progress, requestId });
    } catch {
      // A janela pode ser destruída entre isDestroyed() e send(); a operação
      // continua sendo cancelada pelo listener de destroyed abaixo.
    }
  };
  event.sender.once("destroyed", senderDestroyed);

  try {
    return await withWireSockLifecycle("descoberta-rotas-proton", async () => {
      if (signal.aborted || quitting) return { success: false, cancelled: true };
      const settings = readSharedSettings() as any;
      const username = typeof settings.protonUsername === "string" ? settings.protonUsername.trim() : "";
      if (!username) return { success: false, error: "Nenhuma conta ProtonVPN conectada." };

      const plan = await resolveProtonPlan(username);
      if (signal.aborted || quitting) return { success: false, cancelled: true };
      const freeOnly = plan.status !== "premium";
      const country = typeof settings.protonCountry === "string" ? settings.protonCountry : "";
      const previousServer = typeof settings.protonLastServer?.server === "string"
        ? settings.protonLastServer.server : "";
      try {
        const catalog = await proton.generateProtonRouteCatalog(settingsDir(), {
          username,
          countries: country || undefined,
          freeOnly,
          excludeServers: previousServer ? [previousServer] : [],
          measurePing,
          signal,
          onProgress: sendDiscoveryProgress,
        });
        if (signal.aborted || quitting) return { success: false, cancelled: true };
        const routes = (catalog.routes ?? []).filter((route) =>
          route &&
          typeof route.server === "string" &&
          route.server.trim() !== "" &&
          route.server !== previousServer &&
          typeof route.country === "string" &&
          typeof route.city === "string" &&
          typeof route.tier === "string" &&
          Number.isFinite(route.load) &&
          route.load >= 0 &&
          route.load <= 100 &&
          Number.isFinite(route.score) &&
          route.score >= 0 &&
          (route.pingMs === undefined ||
            (Number.isFinite(route.pingMs) && route.pingMs > 0 && route.pingMs < 999)),
        );
        if (!catalog.success || routes.length === 0) {
          return { success: false, error: catalog.error || "Nenhuma outra rota ProtonVPN está disponível." };
        }

        const candidates = new Map<string, ManualRouteCandidateState>();
        for (const route of routes) {
          const hasPing = route.pingMs !== undefined && Number.isFinite(route.pingMs)
            && route.pingMs > 0 && route.pingMs < 999;
          candidates.set(route.server, {
            server: route.server,
            ...(hasPing ? { pingMs: route.pingMs, pingStatus: "success" as const } : { pingStatus: "not-tested" as const }),
            preflightStatus: "not-tested",
            speedStatus: "not-tested",
          });
        }
        manualMeasurementSessions.set(event.sender.id, {
          measurementId: requestId,
          ownerId: event.sender.id,
          username,
          country,
          freeOnly,
          autoPing: settings.protonAutoPing !== false,
          candidates,
          expiresAt: Date.now() + MANUAL_MEASUREMENT_TTL_MS,
        });
        return {
          success: true,
          measurementId: requestId,
          routes: routes.map((route) => ({
            server: route.server,
            country: route.country,
            city: route.city,
            tier: route.tier,
            load: route.load,
            score: route.score,
            ...(route.pingMs === undefined ? {} : { pingMs: route.pingMs }),
          })),
        };
      } catch (error) {
        if (signal.aborted || quitting) return { success: false, cancelled: true };
        return { success: false, error: String((error as Error)?.message ?? error) };
      }
    });
  } finally {
    event.sender.removeListener("destroyed", senderDestroyed);
    protonOptimizations.finish(operation);
  }
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
  if (startupRestoreInFlight) {
    // O boot oculto é a autoridade enquanto mede e ativa a rota. Uma janela
    // aberta nesse intervalo deve aguardar o resultado, não iniciar outra
    // seleção concorrente no mesmo perfil WireGuard.
    return { success: true, deferred: true, startup: true };
  }
  const requestId = typeof options?.requestId === "string" && options.requestId.length <= 128
    ? options.requestId : `proton-${Date.now()}`;
  const operation = protonOptimizations.start(requestId, event.sender.id);
  if (!operation) return { success: false, error: "Já existe uma seleção de rota em andamento." };
  const measurementSessions = typeof manualMeasurementSessions !== "undefined" ? manualMeasurementSessions : undefined;
  measurementSessions?.delete(event.sender.id);
  const signal = operation.controller.signal;
  let lastProgress: proton.ProtonOptimizationProgress = { phase: "ping", total: 0, tested: 0, succeeded: 0 };
  const sendProgress = (progress: proton.ProtonOptimizationProgress) => {
    if (!protonOptimizations.isCurrent(operation) || event.sender.isDestroyed()) return;
    lastProgress = progress;
    const sessions = typeof manualMeasurementSessions !== "undefined" ? manualMeasurementSessions : undefined;
    proton.recordManualMeasurementProgress?.(sessions?.get(event.sender.id), requestId, progress);
    try {
      event.sender.send("proton-optimization-progress", { ...progress, requestId });
    } catch {
      // A janela pode ser destruída entre isDestroyed() e send(); o helper
      // continua sendo cancelado pelo listener de destroyed abaixo.
    }
  };
  const senderDestroyed = () => {
    protonOptimizations.cancel(requestId, event.sender.id);
    measurementSessions?.delete(event.sender.id);
  };
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
      if (speedTest) {
        const sessions = typeof manualMeasurementSessions !== "undefined" ? manualMeasurementSessions : undefined;
        if (sessions) {
          sessions.set(event.sender.id, {
            measurementId: requestId,
            ownerId: event.sender.id,
            username,
            country,
            freeOnly,
            autoPing,
            candidates: new sessions.constructor(),
            expiresAt: Date.now() + MANUAL_MEASUREMENT_TTL_MS,
          });
          event.sender.once("destroyed", () => sessions.delete(event.sender.id));
        }
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
          } else if (isMac && status === "ACTIVE") {
            // Pausa (sem peer) em vez de encerrar: a utun fica, o Discord não
            // vaza pela rede normal e a retomada não pede a senha de novo.
            stopProtonFailoverMonitor();
            pararWgStatsWatchdog();
            await killDiscord();
            await pauseMacTunnel();
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
        protonRoutePreference: "auto",
        protonLastServer: saved,
      })) {
        return { success: false, error: "A rota foi preparada, mas não foi possível salvar suas preferências." };
      }

      if (status === "ACTIVE") {
        logger.info("proton", "bypass ativo, iniciando nova rota antes de reabrir o Discord", { server: gen.server });
        try {
          if (IS_WINDOWS) {
            const installs = getDiscordInstalls({ forceRefresh: true });
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
          } else if (isMac) {
            // Já dentro da fila "troca-rota-proton": chamar a fila de novo travaria.
            await macActivateRoute(getDiscordInstalls({ forceRefresh: true }), "troca-rota-proton");
            macRouteState = "active";
            iniciarWgStatsWatchdog(wgStatsProvider);
            startProtonFailoverMonitor();
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
    const sessions = typeof manualMeasurementSessions !== "undefined" ? manualMeasurementSessions : undefined;
    if (sessions && ("deferred" in result && result.deferred)) {
      const current = sessions.get(event.sender.id);
      if (current?.measurementId === requestId) sessions.delete(event.sender.id);
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
  const wgTunel = statusBypass === "ACTIVE" ? await wgStatsProvider() : undefined;
  return submitBugReport(
    { title: String(p.title ?? ""), description: String(p.description ?? ""), includeLogs: !!p.includeLogs },
    { statusBypass, installsFlavours: ultimosFlavoursLinux, graphics: ultimosGraficosLinux, wgTunel },
  );
});

type ProtonManualSelectionOptions = {
  measurementId?: unknown;
  server?: unknown;
};

ipcMain.handle("select-proton-route", async (event, options?: ProtonManualSelectionOptions) => {
  const ownerId = event.sender.id;
  const measurementId = typeof options?.measurementId === "string" ? options.measurementId.trim() : "";
  const server = typeof options?.server === "string" ? options.server.trim() : "";
  if (measurementId.length > 128 || server.length > 200) {
    return { success: false, error: "A identificação da medição ou da rota é inválida." };
  }
  const session = manualMeasurementSessions.get(ownerId);
  if (!session || session.ownerId !== ownerId || !measurementId || session.measurementId !== measurementId || session.expiresAt <= Date.now()) {
    return { success: false, error: "A sessão de medição expirou. Execute a medição novamente." };
  }
  const candidate = session.candidates.get(server);
  if (!candidate || !server || candidate.pingStatus === "failed") {
    return { success: false, error: "A rota selecionada não está disponível para seleção." };
  }
  if (candidate.preflightStatus === "failed") {
    return { success: false, error: "A rota selecionada foi reprovada no preflight rápido." };
  }

  const selectionKey = `${ownerId}:${measurementId}`;
  if (manualRouteSelectionsInFlight.has(selectionKey)) {
    return { success: false, error: "Já existe uma seleção manual em andamento." };
  }
  manualRouteSelectionsInFlight.add(selectionKey);
  let configBackup: ProtonConfigBackupLike;
  let stagedFile: string | undefined;
  try {
    return await withWireSockLifecycle("selecionar-rota-manual", async () => {
      if (quitting) return { success: false, error: "A seleção foi cancelada porque o aplicativo está encerrando." };
      const settings = readSharedSettings() as any;
      const username = typeof settings.protonUsername === "string" ? settings.protonUsername.trim() : "";
      if (!username || !proton.protonIdentityMatches(session.username, username)) {
        return { success: false, error: "A conta Proton mudou. Execute a medição novamente." };
      }
      const plan = await resolveProtonPlan(username);
      const country = typeof settings.protonCountry === "string" ? settings.protonCountry : "";
      const freeOnly = plan.status !== "premium";
      const autoPing = settings.protonAutoPing !== false;
      if (country !== session.country || freeOnly !== session.freeOnly || autoPing !== session.autoPing) {
        return { success: false, error: "As preferências Proton mudaram. Execute a medição novamente." };
      }
      const status = IS_LINUX ? await linuxStatus() : getStatus();
      let generated: proton.ProtonManualRouteResult;
      try {
        generated = await proton.generateManualProtonConfig(settingsDir(), {
          username,
          server,
          countries: country || undefined,
          freeOnly,
          autoPing,
        });
      } catch (error) {
        return { success: false, manual: true, error: String((error as Error)?.message ?? error) };
      }
      if (!generated.success) return { ...generated, manual: true };
      stagedFile = generated.confFile;
      if (!stagedFile) return { ...generated, success: false, manual: true, error: "A rota não gerou um perfil temporário válido." };
      if (generated.server !== server || !Number.isFinite(Number(generated.pingMs)) || Number(generated.pingMs) <= 0 || Number(generated.pingMs) >= 999) {
        proton.removeStagedProtonConfig(stagedFile);
        return { ...generated, success: false, manual: true, error: "A validação retornou uma rota diferente da selecionada." };
      }

      try {
        configBackup = backupProtonConfig();
        proton.promoteStagedProtonConfig(stagedFile);
        const applied = await applyProtonRouteResult(generated, {
          status,
          username,
          country,
          freeOnly,
          autoPing,
          configBackup,
          previousSettings: settings,
        });
        if (!applied || !applied.success) {
          restoreProtonConfigBackup(configBackup);
          removeProtonConfigBackup(configBackup);
          proton.removeStagedProtonConfig(stagedFile);
          return { ...(applied || generated), success: false, manual: true };
        }
        removeProtonConfigBackup(configBackup);
        proton.removeStagedProtonConfig(stagedFile);
        return { ...applied, success: true, manual: true };
      } catch (error) {
        restoreProtonConfigBackup(configBackup);
        removeProtonConfigBackup(configBackup);
        proton.removeStagedProtonConfig(stagedFile);
        return {
          ...generated,
          success: false,
          manual: true,
          error: String((error as Error)?.message ?? error),
        };
      }
    });
  } finally {
    manualRouteSelectionsInFlight.delete(selectionKey);
  }
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
