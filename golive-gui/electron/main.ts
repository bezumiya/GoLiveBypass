import {
  app,
  BrowserWindow,
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
import { createHash } from "crypto";
import { execFileSync, execSync, spawn, spawnSync } from "child_process";
import { bypassCode } from "./bypass";
import { createTorWatchdog, type TorWatchdog } from "./torwatchdog";
import { runScript } from "./linux-helper";
import { setupUpdater, isQuittingForUpdate } from "./updater";
import * as logger from "./logger";
import * as discordscan from "./discordscan";
import * as netevents from "./netevents";
import * as logsDir from "./logsDir";
import { submitBugReport } from "./bugreport";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const isMac = process.platform === "darwin";
const IS_LINUX = process.platform === "linux";

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
// — e este app e uma janela fixa de 480px, nao precisa de GPU. Vale para X11 tambem.
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
 * O app mora na bandeja / barra de menus.  Windows o arg --hidden esconde a janela;
 * No Mac usamos wasOpenedAtLogin porque o openAsHidden morreu no macOS 13 :(
 * Nos dois casos sobe so o icone, sem jogar janela na cara do usuario a cada login.
 */
function getStartup() {
  if (IS_LINUX) {
    const file = path.join(app.getPath('home'), '.config', 'autostart', 'golivebypass.desktop');
    return fs.existsSync(file);
  }
  return app.getLoginItemSettings().openAtLogin;
}

function setStartup(enabled: boolean) {
  if (IS_LINUX) {
    const dir = path.join(app.getPath('home'), '.config', 'autostart');
    const file = path.join(dir, 'golivebypass.desktop');
    try {
      if (enabled) {
        fs.mkdirSync(dir, { recursive: true });
        // Exec com --hidden: abre so na bandeja/notificacao no login, sem jogar janela na tela.
        fs.writeFileSync(file, `[Desktop Entry]
Type=Application
Name=GoLiveBypass
Comment=Devolve o Go Live e a camera no Discord
Exec=${process.execPath} --hidden
X-GNOME-Autostart-enabled=true
`);
      } else if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    } catch (error) {
      console.error('Falha ao alterar autostart:', error);
    }
    return;
  }
  app.setLoginItemSettings({
    openAtLogin: enabled,
    args: ["--hidden"],
  });
}

function launchedHidden() {
  return (
    process.argv.includes("--hidden") ||
    app.getLoginItemSettings().wasOpenedAtLogin
  );
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 480,
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
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("close", (event) => {
    if (quitting) return;
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
  if (quitting) return;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    // A bandeja pode ter mudado o startup ou o status com a janela escondida; ao reaparecer, sincroniza.
    mainWindow.webContents.send("refresh-startup");
    refreshWindowStatus();
  } else {
    createWindow();
  }
  refreshTray().catch(() => {});
}

function statusLabel(status: string) {
  if (status === "ACTIVE") return "ativo";
  if (status === "OTHER_MOD") return "outro mod detectado";
  if (status === "NOT_FOUND") return "Discord não encontrado";
  return "inativo";
}

// O status no Linux vem do script (async); no Windows e sincrono. Guardamos o ultimo valor
// para o menu montar sem travar e para o botao Ativar/Desativar ficar sempre clicavel.
let cachedStatus: string | null = null;

// O menu e remontado a cada mudanca: e o jeito simples de o rotulo de status e o item
// Ativar/Desativar refletirem o estado atual sem logica de diff.
async function refreshTray() {
  if (!tray) return;
  try {
    const status = IS_LINUX ? await linuxStatus() : getStatus();
    cachedStatus = status;
    const label = statusLabel(status);
    tray.setToolTip(`GoLiveBypass — ${label}`);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: `GoLiveBypass — ${label}`, enabled: false },
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
      if (status === "ACTIVE") await linuxDeactivate(() => {});
      else await linuxActivate("", () => {});
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

  app.whenReady().then(() => {
    // Logger proprio: arquivo + ring buffer, captura console do main process.
    // O gui.log mora em <settingsDir>/logs/ — pasta estavel, sobrevive a updates.
    try {
      const logs = logsDir.garantirLogsDir(app.getPath("home"), process.platform);
      logger.initLogger(logs);
      logger.patchConsole();
      logger.info("app", "iniciado", { versao: app.getVersion(), plataforma: process.platform });
    } catch {}
    // Se uma sessao anterior morreu sem o quit limpo (PC desligado, crash), a injecao
    // ficou orfa: reverte agora para o status nao mentir (bug: "Ativo" sem ter ativado).
    revertOrphanedInjection().catch((error) =>
      console.error("[restore] falha na reversao de boot:", error),
    );
    // Se o modo salvo e Tor, comeca a subir o daemon JA na abertura. Sem isto ha um impasse:
    // o botao de ativar so libera com o Tor verificado, e o Tor so subia ao ativar ou ao
    // clicar no seletor -- mas quem abre o app com Tor ja selecionado nao clica em nada, e
    // ficava olhando "Aguardando o Tor..." com ninguem tentando. Vale para toda instalacao
    // nova, porque Tor e o padrao. Roda solto: o garantirTor ja insiste sozinho se falhar, e
    // a tela libera o botao quando ficar pronto.
    if (readNetMode() === "tor") {
      garantirTor()
        .then((r) => {
          if (!r.ok) console.warn("[tor] nao subiu na abertura:", r.error);
          // Se o Discord ja esta injetado (sessao viva do boot anterior), o watchdog retoma
          // a vigia — sem ele, um daemon que morreu na sessao antiga seguiria cego.
          if (sessaoAtiva()) torWatchdogIniciar();
        })
        .catch((error) => console.error("[tor] falha ao preparar na abertura:", error));
    } else {
      // Modo nao-tor: nada a vigiar.
      torWatchdogParar();
    }

    // No login (start com --hidden / wasOpenedAtLogin) sobe so a bandeja; a janela aparece no clique.
    if (!launchedHidden()) createWindow();
    // No KDE o watcher da bandeja (StatusNotifier) pode demorar a subir no login; esperar
    // evita o Tray cair para o GtkStatusIcon, que o Plasma 6 nao exibe.
    waitForStatusNotifier().then(createTray);
    app.on("activate", showWindow);
    // Checa por atualizacao na release do GitHub (Windows portable: baixa e substitui;
    // Mac/Linux: autoUpdater nativo). Roda sozinho e em silencio se nao houver nada.
    setupUpdater(() => mainWindow);
  });
}

// Cmd+Q no Mac nao passa por window-all-closed da mesma forma que o Sair da bandeja no Windows:
// o restore vive aqui para os dois caminhos.
app.on("before-quit", (event) => {
  // Durante o auto-update o quit nao pode ser adiado: o processo novo ja foi
  // executado e precisa do lock de instancia unica. Sem esta saida, o app
  // antigo fica vivo e o novo morre — o "fecha mas nao abre".
  if (isQuittingForUpdate()) return;
  // A segunda instancia so acorda a primeira e morre: sem esta guarda ela restauraria o
  // Discord na saida, desfazendo o bypass que a instancia principal acabou de aplicar.
  if (!gotLock || cleaningUp) return;
  event.preventDefault();
  quitting = true;
  cleaningUp = true;
  // O Tor embutido morre junto com o app (e o Discord restaurado nao fica dependente dele).
  stopTor();
  torWatchdogParar();
  // O quit e limpo: o marcador de sessao morre aqui, para o boot seguinte nao tentar
  // reverter nada (a reversao abaixo e a que vale).
  clearSessionMarker();
  closeLogWindow();
  stopLogWatch();
  // Reversao em background: o runScript roda detached/unref, entao o filho sobrevive ao
  // app.quit() e o Discord nao fica com a injecao pendurada. Sem esperar: o "Sair" sai na
  // hora mesmo se o script demorar (fechar o Discord, flatpak, sudo...).
  const restore = IS_LINUX ? linuxDeactivate(() => {}) : deactivateAll();
  restore.catch(() => {});
  app.quit();
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

function winAppHasDiscordResources(resourcesPath: string): boolean {
  const asar = path.join(resourcesPath, "app.asar");
  const originalAsar = path.join(resourcesPath, "_app.asar");
  return diskFs.existsSync(asar) || diskFs.existsSync(originalAsar);
}

// O Squirrel baixa updates numa pasta app-VERSAO nova antes de terminar; enquanto isso ela
// pode existir sem app.asar/_app.asar. Pegar so a "mais nova" cega falha com NOT_FOUND.
function findLatestValidWinAppDir(rootPath: string): string | null {
  let dirs: string[];
  try {
    dirs = diskFs.readdirSync(rootPath).filter((d) => d.startsWith("app-"));
  } catch {
    return null;
  }
  dirs.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const dir of dirs) {
    const resourcesPath = path.join(rootPath, dir, "resources");
    if (winAppHasDiscordResources(resourcesPath)) return dir;
  }
  return null;
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

    const latestApp = findLatestValidWinAppDir(rootPath);
    if (!latestApp) continue;

    const resourcesPath = path.join(rootPath, latestApp, "resources");
    const exePath = path.join(rootPath, latestApp, `${flavour}.exe`);
    const asar = path.join(resourcesPath, "app.asar");
    const originalAsar = path.join(resourcesPath, "_app.asar");
    if (diskFs.existsSync(asar) || diskFs.existsSync(originalAsar)) {
      discordscan.scanInstall(resourcesPath, flavour);
    }
    installs.push({ flavour, resources: resourcesPath, exePath });
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

function discordIsRunning(): boolean {
  if (isMac) {
    for (const { processName } of MAC_APPS) {
      try {
        execFileSync("pgrep", ["-x", processName], { stdio: "ignore" });
        discordscan.runningPgrep(processName, true);
        return true;
      } catch (e) {
        discordscan.runningPgrep(processName, false, (e as Error)?.message);
      }
    }
    return false;
  }

  for (const flavour of ALL_APPS) {
    try {
      const out = execSync(`tasklist /FI "IMAGENAME eq ${flavour}.exe" /NH`, {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "ignore"],
      });
      if (out.toLowerCase().includes(`${flavour}.exe`.toLowerCase())) {
        discordscan.runningTasklist(flavour, true);
        return true;
      }
      discordscan.runningTasklist(flavour, false);
    } catch (e) {
      discordscan.runningTasklist(flavour, false, (e as Error)?.message);
    }
  }
  return false;
}

async function waitUntilDiscordGone(tries = 40, delayMs = 250) {
  for (let i = 0; i < tries; i++) {
    if (!discordIsRunning()) return true;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return !discordIsRunning();
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
      await waitUntilDiscordGone(20, 250);
    }
    return;
  }

  for (const flavour of ALL_APPS) {
    try {
      execSync(`taskkill /F /T /IM ${flavour}.exe`, { stdio: "ignore" });
    } catch {}
  }
  await waitUntilDiscordGone();
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
      spawn(install.exePath, [], { stdio: "ignore" }).unref();
    }
  } catch {}
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
      }),
    );
    diskFs.writeFileSync(
      path.join(asar, "index.js"),
      `require('./golivebypass.js');`,
    );
  });
}

async function activateBypass(event: any, proxyAddress: string = "") {
  const installs = getDiscordInstalls();
  if (installs.length === 0) {
    discordscan.ativacaoSemDiscord("nenhum install encontrado na varredura");
    throw new Error("Nenhum Discord encontrado.");
  }
  netevents.gatewayConectando("gateway.discord.gg", "desconhecida");

  // Salvo antes de mexer no Discord: mesmo que a injecao falhe, o que a pessoa digitou nao se
  // perde, e o campo continua preenchido na proxima abertura.
  saveProxy(proxyAddress);

  // No modo Tor, garante o Tor embutido de pe ANTES de injetar: o bypass le a porta dele do
  // settings.json, e a sessao nasce ja roteada (sem o risco de o gateway nascer direto).
  const modo = readNetMode();
  if (modo === "tor") {
    // Aproveita um Tor que ja exista nesta maquina (o nosso de uma sessao anterior, o servico
    // do sistema, o Tor Browser) e so baixa quando nao ha nenhum. A porta encontrada e a que
    // vai escrita no settings.json logo abaixo.
    const tor = await garantirTor();
    if (!tor.ok) throw new Error(`Nao consegui preparar o Tor: ${tor.error ?? "erro desconhecido"}`);
    // A partir daqui a sessao e tor: o watchdog vigia o daemon e ressuscita se morrer no meio.
    torWatchdogIniciar();
  }

  for (const install of installs) {
    assertDiscordSignature(install.bundlePath);
    assertResourcesWritable(install);
  }

  await killDiscord();

  for (const install of installs) {
    const asar = path.join(install.resources, "app.asar");
    const originalAsar = path.join(install.resources, "_app.asar");

    const hasOriginal = withNoAsar(() => diskFs.existsSync(originalAsar));
    const hasAsar = withNoAsar(() => diskFs.existsSync(asar));

    if (!hasOriginal && hasAsar) {
      // Discord intocado: o app.asar atual e o original, entao ele vira _app.asar.
      await safeRename(asar, originalAsar);
      writeInjection(asar, proxyAddress);
    } else if (hasOriginal && !isOurInjection(install.resources)) {
      // Outro mod ocupa o lugar. O _app.asar ja e o Discord original, entao so o carregador do
      // outro mod e trocado pelo nosso. Sem isto o botao "Sobrescrever e Ativar" nao fazia nada:
      // a condicao antiga so injetava em Discord intocado, e aqui ela era falsa.
      await safeRemove(asar);
      writeInjection(asar, proxyAddress);
    } else if (hasOriginal) {
      // Ja e o nosso: so reescreve, para a proxy nova valer.
      await safeRemove(asar);
      writeInjection(asar, proxyAddress);
    }

    clearBundleQuarantine(install.bundlePath);
    startDiscord(install);
  }

  // Registra a sessao: o bypass so se desfaz no quit limpo; se o PC desligar no meio, o
  // boot seguinte encontra este marcador e reverte a injecao orfa.
  writeSessionMarker(installs);
}

async function deactivateAll() {
  const installs = getDiscordInstalls();

  // So desfaz o que e nosso. Isto roda ao sair do app, e antes desfazia qualquer injecao:
  // quem tinha Equicord ou Vencord abria este app, fechava, e o mod sumia sem nada avisar.
  const ours = installs.filter(
    (install) =>
      withNoAsar(() =>
        diskFs.existsSync(path.join(install.resources, "_app.asar")),
      ) && isOurInjection(install.resources),
  );

  // Decidido antes de matar o Discord: sem isto, quem tem outro mod teria o Discord fechado
  // para nada, porque nao haveria o que desfazer depois.
  if (ours.length === 0) return;

  for (const install of ours) assertResourcesWritable(install);

  await killDiscord();

  for (const install of ours) {
    const asar = path.join(install.resources, "app.asar");
    const originalAsar = path.join(install.resources, "_app.asar");

    await safeRemove(asar);
    await safeRename(originalAsar, asar);
    clearBundleQuarantine(install.bundlePath);
    startDiscord(install);
  }

  // Sessao terminou: o watchdog nao tem mais o que vigiar.
  torWatchdogParar();

  // Reverteu (de verdade): a sessao terminou, o marcador nao vale mais.
  clearSessionMarker();
}

function getStatus(): string {
  const installs = getDiscordInstalls();
  if (installs.length === 0) return "NOT_FOUND";
  return withNoAsar(() => {
    for (const install of installs) {
      const asar = path.join(install.resources, "app.asar");
      const originalAsar = path.join(install.resources, "_app.asar");
      if (diskFs.existsSync(originalAsar)) {
        // Checa se é o nosso bypass
        const indexJs = path.join(asar, "index.js");
        if (diskFs.existsSync(indexJs)) {
          const content = diskFs.readFileSync(indexJs, "utf8");
          if (content.includes("golivebypass.js")) return "ACTIVE";
        }
        return "OTHER_MOD";
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

function linuxStatus(): Promise<string> {
  return runScript(["--status", "--json"])
    .then(({ code, stdout, stderr }) => {
      // Loga o resultado do script (code) — o stderr de aviso vira trace legivel.
      if (code !== 0) {
        discordscan.scriptStatus(code, false);
        discordscan.scriptTrace(`script falhou com code ${code}`);
        return "NOT_FOUND";
      }
      try {
        const data = JSON.parse(stdout);
        // O script manda banner + avisos pro stderr; extrai so as linhas de
        // trace/aviso (as que tem conteudo) e loga cada uma como evento.
        // O banner (nome do app, subtitulo, distro) e ruido — filtra.
        const stderrLimpo = (stderr ?? "").replace(/\x1b\[[0-9;]*m/g, "");
        for (const linha of stderrLimpo.split("\n")) {
          const t = linha.replace(/^[[:space:]]*\[\!\]\s*/, "").trim();
          if (!t) continue;
          if (/^(GoLiveBypass standalone|Go Live e camera de volta|CachyOS|Ubuntu|Arch|Fedora|Debian)/.test(t)) continue;
          discordscan.scriptTrace(t);
        }
        discordscan.scriptStatus(code, true);
        const discords = data.discords ?? [];
        const flavours = new Set<string>();
        for (const d of discords) {
          if (typeof d?.path === "string") {
            const extras: { flavour?: string; detected_by?: string; flatpak_id?: string } = {};
            if (typeof d.flavour === "string") {
              extras.flavour = d.flavour;
              flavours.add(d.flavour);
            }
            if (typeof d.detected_by === "string") extras.detected_by = d.detected_by;
            if (typeof d.flatpak_id === "string") extras.flatpak_id = d.flatpak_id;
            discordscan.scriptInstall(d.path, String(d.state ?? "?"), extras);
          }
        }
        ultimosFlavoursLinux = [...flavours].join(",");
        if (discords.length === 0) return "NOT_FOUND";
        const anyOurs = discords.some(
          (d: { state: string }) => d.state === "nosso",
        );
        const anyOursRunning = discords.some(
          (d: { state: string; running?: string }) => d.state === "nosso" && d.running === "sim",
        );
        const anyMod = discords.some(
          (d: { state: string }) => d.state === "outromod",
        );
        // O bypass so esta "ativo" de verdade com o cliente aberto: injecao no disco com
        // nenhum processo vivo e orfa (o boot a reverte), nao um estado ativo.
        if (anyOursRunning) return "ACTIVE";
        if (anyOurs && !anyOursRunning) {
          discordscan.scriptTrace("injeção no disco mas nenhum cliente aberto — considerando inativo");
          return "INACTIVE";
        }
        if (anyMod) return "OTHER_MOD";
        return "INACTIVE";
      } catch {
        discordscan.scriptJsonInvalido(stdout);
        return "NOT_FOUND";
      }
    })
    .catch((e) => {
      discordscan.scriptStatus(-1, false);
      discordscan.scriptTrace(`script nao executou: ${(e as Error)?.message ?? ""}`);
      return "NOT_FOUND";
    });
}

async function linuxActivate(
  proxyAddress: string,
  onChunk: (c: string) => void,
) {
  // No Windows/macOS quem injeta e o processo principal, entao activateBypass reconfere o Tor
  // e grava a porta certa antes de mexer no Discord. No Linux quem injeta e o script standalone,
  // que so copia o torAddr que JA estava salvo -- sem isto, o botao podia estar "liberado" (o
  // Tor da Electron provado numa porta) e o script ainda injetar apontando para a porta antiga,
  // travando o gateway para sempre com a UI dizendo "Tor pronto". E sem reconferir aqui, nada
  // impede a ativacao de proceder com o Tor fora do ar: so o botao da tela travava, e um clique
  // fora da tela (ou uma corrida de estado) passava direto.
  if (readNetMode() === "tor") {
    const tor = await garantirTor();
    if (!tor.ok) throw new Error(`Nao consegui preparar o Tor: ${tor.error ?? "erro desconhecido"}`);
    saveTorAddr(`127.0.0.1:${tor.porta}`);
  }

  const args = ["--yes"];
  if (proxyAddress.trim() !== "") args.push("--proxy", proxyAddress.trim());
  const { code, stderr } = await runScript(args, onChunk);
  if (code !== 0) {
    throw new Error(
      stderr.split("\n").filter(Boolean).slice(-3).join("\n") ||
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
}

async function linuxDeactivate(onChunk: (c: string) => void) {
  const { code, stderr } = await runScript(["--uninstall"], onChunk);
  if (code !== 0) {
    // Sem manter o marker: o disco continua "nosso"; o boot seguinte reverte a orfa assim
    // que o cliente estiver fechado. O erro vai inteiro para a UI (stderr cortado no fim da
    // linha), em vez dos ultimos 3 fragmentos que sumiam com altas linhas longas.
    throw new Error(
      stderr.split("\n").map((l) => l.trim()).filter(Boolean).slice(-6).join("\n") ||
        "Falha ao desativar (a elevacao provavelmente falhou)",
    );
  }
  clearSessionMarker();
}

// A bandeja precisa refletir o que os botoes da janela fizeram, entao os handlers de IPC
// tambem remontam o menu ao terminar.
ipcMain.handle("activate", async (event, proxyAddress: string = "") => {
  if (IS_LINUX) {
    await linuxActivate(proxyAddress, (c) =>
      event.sender.send("bypass-log", c),
    );
  } else {
    await activateBypass(event, proxyAddress);
  }
  refreshTray().catch(() => {});
});
ipcMain.handle("deactivate", async (event) => {
  if (IS_LINUX) {
    await linuxDeactivate((c) => event.sender.send("bypass-log", c));
  } else {
    await deactivateAll();
  }
  refreshTray().catch(() => {});
});
ipcMain.handle("get-platform", () => (IS_LINUX ? "linux" : isMac ? "mac" : "windows"));
ipcMain.handle("get-status", async () => {
  if (IS_LINUX) return linuxStatus();
  return getStatus();
});
ipcMain.handle("get-startup", () => getStartup());
ipcMain.handle("set-startup", (_event, enabled: unknown) => {
  setStartup(enabled === true);
  refreshTray().catch(() => {});
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
  // sem reabrir o Discord no login.
  if (IS_LINUX) {
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
  for (const resources of resourcesList) {
    const install =
      atuais.find((a) => a.resources === resources) ??
      ({ flavour: "", resources, exePath: "", bundlePath: undefined } as DiscordInstall);
    // So age onde a injecao ainda e a nossa (outro mod tomou o lugar = nao mexe).
    const temOriginal = withNoAsar(() => diskFs.existsSync(path.join(resources, "_app.asar")));
    if (temOriginal && isOurInjection(resources)) alvos.push(install);
  }

  if (alvos.length === 0) {
    clearSessionMarker();
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
async function garantirTor(): Promise<{ ok: boolean; porta?: number; error?: string }> {
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
      if (acao !== "restart") return;
      console.warn("[tor] watchdog: daemon morreu/travou na porta em uso; ressuscitando");
      void torWatchdogRecuperar();
    });
  }, 30_000);
}

function torWatchdogParar() {
  if (torWatchdog !== null) torWatchdog.setActive(false);
  if (torWatchdogTimer !== null) {
    clearInterval(torWatchdogTimer);
    torWatchdogTimer = null;
  }
}

async function torWatchdogRecuperar() {
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

// Guardado fora da pasta do Discord de proposito: o settings.json que o bypass le vive dentro do
// app.asar injetado, e esse some quando o bypass e desativado ou quando o Discord se atualiza.
// A copia daqui e a configuracao da pessoa, e sobrevive aos dois.
function saveProxy(proxy: string) {
  try {
    const dir = settingsDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "settings.json");

    const atual = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
    fs.writeFileSync(file, JSON.stringify({ ...atual, proxy }, null, 4));
  } catch (error) {
    console.error("[settings] nao consegui salvar a proxy:", error);
  }
}

// Porta do Tor que o script standalone (Linux) deve usar. So chamada depois de garantirTor()
// confirmar um tunel de verdade -- sem isto, torAddr no settings.json real fica preso na porta
// de uma sessao anterior e o gateway trava esperando uma saida que nao existe mais.
function saveTorAddr(addr: string) {
  try {
    const dir = settingsDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "settings.json");
    const atual = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
    fs.writeFileSync(file, JSON.stringify({ ...atual, torAddr: addr }, null, 4));
  } catch (error) {
    console.error("[settings] nao consegui salvar o endereco do Tor:", error);
  }
}

// Modo de rede escolhido (persistido no settings.json junto da proxy): "auto" | "tor" | "free".
// "auto" com proxy preenchida = personalizado (o bypass usa a proxy do campo). O PADRAO e
// "tor": o app baixa e usa o Tor sempre, para nunca cair no IP brasileiro.
function saveNetMode(mode: string) {
  try {
    const dir = settingsDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "settings.json");
    const atual = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
    fs.writeFileSync(file, JSON.stringify({ ...atual, routeMode: mode }, null, 4));
  } catch (error) {
    console.error("[settings] nao consegui salvar o modo de rede:", error);
  }
}

function readNetMode(): string {
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

// Detecta Tor disponivel: o embutido (porta dedicada) ou um Tor do sistema (portas classicas).

// IPC do modo de rede + Tor embutido.
ipcMain.handle("get-net-mode", () => readNetMode());
ipcMain.handle("set-net-mode", (_event, mode: unknown) => {
  // A UI manda "auto" para o modo Personalizado (o campo de proxy define a saida).
  const m = typeof mode === "string" && ["auto", "tor", "free"].includes(mode) ? mode : "tor";
  saveNetMode(m);
  return m;
});
ipcMain.handle("get-tor-status", async () => {
  // "Presente" cobre os dois casos em que nao ha nada a baixar: o nosso ja extraido e um tor
  // instalado no sistema.
  //
  // "Ativo" se apoia na flag: o garantirTor so a liga depois de abrir um tunel de verdade,
  // entao aqui basta confirmar que a porta continua atendendo -- 400ms. Repetir o teste de
  // tunel a cada atualizacao da tela custaria segundos e travaria a janela.
  const ativo = torVerificado && (await portaViva(torPortaEmUso));
  return {
    presente: fs.existsSync(torExePath()) || torDoSistema() !== null,
    ativo,
    porta: torPortaEmUso,
  };
});
ipcMain.handle("install-tor", async () => {
  // Nao baixa nada quando ja ha um Tor de pe ou instalado: o garantirTor tenta, nessa ordem,
  // reaproveitar quem ja atende, subir o nosso ja extraido, subir o do sistema e, so entao,
  // baixar o pacote oficial.
  const r = await garantirTor();
  return r.ok ? { ok: true, porta: r.porta } : { ok: false, error: r.error };
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

function buildDiagnostic(status: string, extraNote = ""): string {
  const proxy = maskSecrets(
    readProxyFrom(path.join(settingsDir(), "settings.json")) || "(vazio)",
  );
  const lines = [
    "### Diagnóstico GoLiveBypass (GUI)",
    "",
    "| | |",
    "|---|---|",
    `| app | golive-gui ${app.getVersion()} |`,
    `| os | ${process.platform} ${process.arch} |`,
    `| electron | ${process.versions.electron} |`,
    `| status | ${status} |`,
    `| routeMode | ${readNetMode()} |`,
    `| proxy | ${proxy} |`,
    `| torPort | ${torPortaEmUso} (verificado=${torVerificado}) |`,
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

ipcMain.handle("get-diagnostic", (_event, payload: unknown) => {
  const p = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const status = typeof p.status === "string" ? p.status : "UNKNOWN";
  const note = typeof p.note === "string" ? p.note : "";
  return {
    text: buildDiagnostic(status, note),
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

  const fullBody = buildDiagnostic(status, note);
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

ipcMain.handle("report-bug", async (_event, payload: unknown) => {
  const p = (payload ?? {}) as { title?: string; description?: string; includeLogs?: boolean };
  const netMode = readNetMode();
  let statusBypass = "INACTIVE";
  try {
    statusBypass = IS_LINUX ? await linuxStatus() : getStatus();
  } catch {}
  let torAtivo = false;
  let torPorta: number | null = null;
  try {
    torAtivo = torVerificado && (await portaViva(torPortaEmUso));
    torPorta = torPortaEmUso;
  } catch {}
  return submitBugReport(
    { title: String(p.title ?? ""), description: String(p.description ?? ""), includeLogs: !!p.includeLogs },
    { netMode, statusBypass, torAtivo, torPorta, installsFlavours: ultimosFlavoursLinux },
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
  mainWindow.setContentSize(480, h);
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
