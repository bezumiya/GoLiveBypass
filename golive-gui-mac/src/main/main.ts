import {
  app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage, powerMonitor, net, shell,
} from 'electron';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { makeRouter } from './ipc';
import { importConfig, readConfigState } from './config/store';
import { configPath, settingsPath, sessionDir, appDataDir } from './paths';
import { readDefaultRoute, publicIp, exitInfo } from './tunnel/collect';
import { deriveStateFromRoute } from './tunnel/status';
import { restartDiscord } from './discord/restart';
import { defaultDiscordCandidates, pickDiscordPath } from './discord/locate';
import { injectVencord, AppManagementDenied, canModifyApp } from './vencord/inject';
import { activate } from './tunnel/up';
import { deactivate } from './tunnel/down';
import { runActivation, runDeactivation } from './tunnel/activation';
import { cleanupStaleV6Rejects } from './privileged/helper';
import { ProtonFetcher } from './proton/fetch';
import { readSavedAccount, clearSavedAccount } from './proton/account';
import { checkForUpdate, downloadAndInstall, type UpdateInfo, type PendingUpdate } from './updater';
import type { AppSettings, TunnelState } from '../shared/types';

const home   = os.homedir();
const user   = os.userInfo().username;
const binDir = path.join(process.resourcesPath ?? path.join(__dirname, '../../resources'), 'bin');

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let tunnelActive = false;
// Túnel derrubado pela suspensão: volta sozinho ao acordar
let resumeTunnel = false;

// ─── Persistência de estado ──────────────────────────────────────────────────

function loadSettings(): AppSettings {
  try {
    const p = settingsPath(home);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {}
  return {};
}

function saveSettings(patch: Partial<AppSettings>): void {
  try {
    fs.mkdirSync(appDataDir(home), { recursive: true });
    const prev = loadSettings();
    fs.writeFileSync(settingsPath(home), JSON.stringify({ ...prev, ...patch }, null, 2));
  } catch {}
}

// ─── Config WireGuard ────────────────────────────────────────────────────────

function readStoredConf(): string | null {
  const p = configPath(home);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

function refreshConfigState() {
  return readConfigState({ read: readStoredConf });
}

async function activationOpts() {
  return { home, user, binDir };
}

function sendToWindow(channel: string, payload: unknown) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function storeConfig(rawText: string) {
  return importConfig(rawText, {
    configPath: () => configPath(home),
    mkdirp: (p: string) => fs.mkdirSync(p, { recursive: true, mode: 0o700 }),
    write: (p: string, data: string, mode: number) => { fs.writeFileSync(p, data, { mode }); fs.chmodSync(p, mode); },
  });
}

// ─── Operações do túnel ──────────────────────────────────────────────────────

type TunnelUiState = 'active' | 'inactive' | 'activating' | 'deactivating';
let tunnelOp: Promise<unknown> | null = null;

function pushState(state?: TunnelUiState) {
  sendToWindow('tunnel:state', { state: state ?? (tunnelActive ? 'active' : 'inactive') });
}

/** Uma ativação/desativação por vez; um pedido durante outra operação recebe 'busy'. */
async function exclusive<T>(fn: () => Promise<T>): Promise<T | { error: 'busy' }> {
  if (tunnelOp) return { error: 'busy' };
  const op = fn();
  tunnelOp = op;
  try { return await op; } finally { tunnelOp = null; }
}

/**
 * Derruba o túnel ao sair, desligar ou suspender. Não grava lastTunnelState:
 * a intenção do usuário continua "ativo" e o túnel volta ao reabrir/acordar.
 */
async function bringDownQuietly(): Promise<boolean> {
  if (!tunnelActive) return false;
  try {
    const r = await runDeactivation(await activationOpts());
    if (r.ok) { tunnelActive = false; updateTray(); pushState(); }
    return r.ok;
  } catch { return false; }
}

async function deactivateBeforeQuit(): Promise<void> {
  if (tunnelOp) await tunnelOp.catch(() => {});
  await bringDownQuietly();
}

/**
 * Encerramento único: derruba o túnel e sai com app.exit. Reentrar no
 * app.quit() depois de um before-quit cancelado deixava o processo vivo e sem
 * janela (o encerramento do Chromium já tinha começado).
 */
let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  isQuitting = true;
  try { await deactivateBeforeQuit(); } finally { app.exit(0); }
}

async function waitForNetwork(timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!net.isOnline() && Date.now() < until) await new Promise(r => setTimeout(r, 1000));
  // A interface pode estar "online" antes do DHCP/rota padrão assentarem
  await new Promise(r => setTimeout(r, 2000));
}

// ─── Tray ────────────────────────────────────────────────────────────────────

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    {
      label: tunnelActive ? 'Bypass: ATIVO' : 'Bypass: inativo',
      enabled: false,
    },
    { type: 'separator' },
    { label: 'Abrir janela', click: () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show(); } },
    { type: 'separator' },
    {
      label: 'Sair',
      click: () => { void shutdown(); },
    },
  ]);
}

function updateTray() {
  tray?.setContextMenu(buildTrayMenu());
  tray?.setToolTip(tunnelActive ? 'GoLiveBypass — ATIVO' : 'GoLiveBypass');
}

function createTray() {
  // Fora do asar: vem por extraResources (o @2x é carregado junto pelo nome)
  const trayDir = app.isPackaged ? path.join(process.resourcesPath, 'tray') : path.join(__dirname, '../../resources/tray');
  const icon = nativeImage.createFromPath(path.join(trayDir, 'iconTemplate.png'));
  if (icon.isEmpty()) {
    // O tray nasce antes da janela: o aviso espera o renderer carregar
    const msg = `Ícone da barra de menu não encontrado em ${trayDir}`;
    console.error(msg);
    app.once('browser-window-created', (_e, w) => w.webContents.once('did-finish-load', () => w.webContents.send('log', msg)));
  }
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.on('click', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show(); });
  updateTray();
}

// ─── Janela principal ────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 640,
    resizable: false,
    titleBarStyle: 'hiddenInset',
    vibrancy: 'under-window',
    visualEffectState: 'active',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  // Fechar esconde para tray, não encerra o app
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });
}

// ─── Vencord ─────────────────────────────────────────────────────────────────

const APP_MANAGEMENT_PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_AppBundles';

function discordAppPath(): string | null {
  return pickDiscordPath(defaultDiscordCandidates(home).map(p => ({ path: p, exists: fs.existsSync(p) })));
}

type InjectOutcome = 'ok' | 'needs_permission' | 'no_discord' | 'failed';

async function tryInjectVencord(): Promise<InjectOutcome> {
  const discordApp = discordAppPath();
  if (!discordApp) { sendToWindow('log', 'Discord não encontrado; Vencord não injetado.'); return 'no_discord'; }
  try {
    await injectVencord({
      home, discordApp, cacheDir: path.join(appDataDir(home), 'vencord'),
      log: m => sendToWindow('log', m),
    });
    sendToWindow('vencord:permission', { granted: true });
    return 'ok';
  } catch (e: any) {
    if (e instanceof AppManagementDenied) {
      sendToWindow('log', 'O macOS precisa liberar o GoLiveBypass em Gerenciamento de Apps para alterar o Discord.');
      sendToWindow('vencord:permission', { granted: false });
      return 'needs_permission';
    }
    sendToWindow('log', `Falha ao injetar Vencord: ${e?.message ?? e}`);
    return 'failed';
  }
}

// ─── IPC handlers ────────────────────────────────────────────────────────────

const protonFetcher = new ProtonFetcher();
let pendingUpdate: (PendingUpdate & { version: string }) | null = null;

/** Guarda a última checagem: some se a release sumir, troca se sair outra. */
function rememberUpdate(info: UpdateInfo): UpdateInfo {
  pendingUpdate = info.available && info.downloadUrl && info.sha256 && info.latestVersion
    ? { downloadUrl: info.downloadUrl, sha256: info.sha256, version: info.latestVersion }
    : null;
  return info;
}
let protonFetching = false;

const handlers = {
  async importConfig({ rawText }: { rawText: string }) {
    return storeConfig(rawText);
  },

  async activate() {
    return exclusive(async () => {
      pushState('activating');
      const r = await activate({
        opts: await activationOpts(),
        // Com o opt-in, injeta antes do restart para o Discord já subir com o Vencord
        restartDiscord: async () => {
          if (loadSettings().vencordOptIn) await tryInjectVencord();
          await restartDiscord();
        },
        publicIp,
      });
      if ('error' in r) sendToWindow('log', `Falha ao ativar: ${r.error}${r.detail ? ` — ${r.detail}` : ''}`);
      else {
        tunnelActive = true;
        resumeTunnel = false;
        saveSettings({ lastTunnelState: 'active' });
        updateTray();
      }
      pushState();
      return r;
    });
  },

  async deactivate() {
    return exclusive(async () => {
      pushState('deactivating');
      const r = await deactivate({ opts: await activationOpts(), restartDiscord });
      if ('error' in r) sendToWindow('log', `Falha ao desativar: ${r.error}${r.detail ? ` — ${r.detail}` : ''}`);
      else {
        tunnelActive = false;
        resumeTunnel = false;
        saveSettings({ lastTunnelState: 'inactive' });
        updateTray();
      }
      pushState();
      return r;
    });
  },

  async status() {
    const state = deriveStateFromRoute(await readDefaultRoute());
    if (!tunnelOp) tunnelActive = state === 'active';
    return { state, hasConfig: refreshConfigState().hasConfig, busy: !!tunnelOp };
  },

  async fetchProton({ username, password }: { username: string; password?: string }) {
    if (protonFetching) return { ok: false, error: 'busy' };
    protonFetching = true;
    return new Promise<object>((resolve) => {
      fs.mkdirSync(appDataDir(home), { recursive: true, mode: 0o700 });
      const confOut = path.join(appDataDir(home), `proton-raw-${process.pid}-${Date.now()}.conf`);

      protonFetcher.removeAllListeners();

      protonFetcher.on('progress', (msg: string) => {
        sendToWindow('proton:progress', msg);
      });

      protonFetcher.on('done', (result: { ok: boolean }) => {
        protonFetching = false;
        if (!result.ok) { fs.rmSync(confOut, { force: true }); return resolve(result); }
        try {
          // O conf do Proton vem full-tunnel; passa pela reescrita split tunnel
          const stored = storeConfig(fs.readFileSync(confOut, 'utf8'));
          resolve(stored.ok ? result : { ok: false, error: stored.errors.join(' ') });
        } catch (e: any) {
          resolve({ ok: false, error: String(e?.message ?? e) });
        } finally {
          fs.rmSync(confOut, { force: true });
        }
      });

      protonFetcher.fetch({
        username,
        password,
        binDir,
        sessDir: sessionDir(home),
        confOut,
      });
    });
  },

  async vencordPermission() {
    const discordApp = discordAppPath();
    return { granted: discordApp ? canModifyApp(discordApp) : false };
  },

  async vencordOpenSettings() {
    await shell.openExternal(APP_MANAGEMENT_PANE);
    return { ok: true };
  },

  async vencordRetry() {
    if (!loadSettings().vencordOptIn) return { outcome: 'disabled' };
    const outcome = await tryInjectVencord();
    if (outcome === 'ok' && tunnelActive) await restartDiscord();
    return { outcome };
  },

  async vencordGetOptIn() {
    return { enabled: loadSettings().vencordOptIn === true };
  },

  async vencordSetOptIn({ enabled }: { enabled: boolean }) {
    saveSettings({ vencordOptIn: enabled });
    if (!enabled) {
      sendToWindow('vencord:permission', { granted: true });
      sendToWindow('log', 'Vencord/FakeNitro desligado no GoLiveBypass: o app não mexe mais no Discord. Um Vencord já instalado continua lá.');
      return { enabled, outcome: 'disabled' };
    }
    const outcome = await tryInjectVencord();
    if (outcome === 'ok' && tunnelActive) await restartDiscord();
    return { enabled, outcome };
  },

  async exitInfo() {
    return exitInfo();
  },

  async protonAccount() {
    return readSavedAccount(sessionDir(home));
  },

  async protonLogout() {
    clearSavedAccount(sessionDir(home));
    return { ok: true };
  },

  async checkUpdate() {
    return rememberUpdate(await checkForUpdate());
  },

  // Baixa só a release que o próprio main encontrou, com o SHA-256 dela
  async downloadUpdate({ version }: { version?: string } = {}) {
    if (!pendingUpdate) return { ok: false, error: 'nenhuma atualização pendente' };
    // O aviso pode estar mostrando uma versão anterior à última checagem
    if (version && version !== pendingUpdate.version) {
      return {
        ok: false, error: `a versão disponível agora é a ${pendingUpdate.version}; confira o aviso e clique de novo`,
        update: { available: true, latestVersion: pendingUpdate.version, downloadUrl: pendingUpdate.downloadUrl, currentVersion: app.getVersion() },
      };
    }
    return downloadAndInstall(pendingUpdate, (msg) => {
      sendToWindow('update:progress', msg);
    });
  },
};

const router = makeRouter(handlers as any);

// ─── Inicialização ────────────────────────────────────────────────────────────

if (!app.requestSingleInstanceLock()) {
  app.exit(0);
}
app.on('second-instance', () => {
  if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); }
});

app.whenReady().then(async () => {
  // Confs gravados por versões anteriores podem estar full-tunnel ou sem keepalive: normaliza
  const stored = readStoredConf();
  if (stored && (/AllowedIPs\s*=.*(0\.0\.0\.0\/0|::\/0)/i.test(stored) || !/^PersistentKeepalive\s*=/im.test(stored))) {
    storeConfig(stored);
  }
  createTray();
  createWindow();

  ipcMain.handle('golive', (_e, channel: string, payload: unknown) => router(channel, payload));
  ipcMain.handle('golive:pick-conf', async () => {
    const r = await dialog.showOpenDialog({
      filters: [{ name: 'WireGuard', extensions: ['conf'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    return fs.readFileSync(r.filePaths[0], 'utf8');
  });

  // powerMonitor só pode ser usado depois de app.whenReady()
  powerMonitor.on('shutdown', async () => {
    await deactivateBeforeQuit();
  });

  powerMonitor.on('suspend', () => {
    if (!tunnelActive) return;
    void exclusive(async () => {
      if (await bringDownQuietly()) resumeTunnel = true;
    });
  });

  powerMonitor.on('resume', async () => {
    if (!resumeTunnel) return;
    resumeTunnel = false;
    sendToWindow('log', 'Mac acordou; reativando o bypass…');
    await waitForNetwork(30_000);
    await exclusive(async () => {
      pushState('activating');
      // Sem reiniciar o Discord: as conexões dele caíram na suspensão e
      // reconectam sozinhas, já pelas rotas do túnel
      const r = await runActivation(await activationOpts());
      if (r.ok) { tunnelActive = true; updateTray(); }
      else sendToWindow('log', `Falha ao reativar após suspensão: ${r.error}${r.detail ? ` — ${r.detail}` : ''}`);
      pushState();
    });
  });

  // Auto-reconnect: restaura último estado
  const { lastTunnelState } = loadSettings();
  const reconnect = lastTunnelState === 'active' && refreshConfigState().hasConfig;
  if (!reconnect) {
    // Dentro do exclusive: um Ativar no meio receberia 'busy' em vez de ter o túnel novo derrubado
    void exclusive(async () => {
      if (deriveStateFromRoute(await readDefaultRoute()) === 'active') return;
      if (await cleanupStaleV6Rejects(binDir)) sendToWindow('log', 'Rotas IPv6 de uma sessão anterior removidas.');
    }).catch(() => {});
  }
  if (reconnect) {
    setTimeout(async () => {
      sendToWindow('log', 'Auto-reconectando bypass…');
      try {
        await handlers.activate();
      } catch {}
    }, 1500);
  }

  // O renderer consulta ao carregar; aqui só repete, pois fechar a janela não encerra o app.
  setInterval(() => {
    checkForUpdate().then((info) => {
      if (rememberUpdate(info).available) sendToWindow('update:available', info);
    }).catch(() => {});
  }, 6 * 60 * 60_000);
});

// ─── Shutdown gracioso ────────────────────────────────────────────────────────

app.on('before-quit', (e) => {
  if (shuttingDown) return;
  e.preventDefault();
  void shutdown();
});

// kill/logout mandam SIGTERM: sem isto o Chromium fecha as janelas e o túnel fica no ar
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });

app.on('window-all-closed', () => {
  // No macOS, manter vivo no tray
});

app.on('activate', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
});
