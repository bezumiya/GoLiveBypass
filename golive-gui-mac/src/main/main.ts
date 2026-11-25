import {
  app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage, nativeTheme, powerMonitor, net, shell,
} from 'electron';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { makeRouter } from './ipc';
import { importConfig, readConfigState } from './config/store';
import { configPath, settingsPath, sessionDir, appDataDir } from './paths';
import { readDefaultRoute, publicIp, exitInfo } from './tunnel/collect';
import { deriveStateFromRoute } from './tunnel/status';
import { restartDiscord, isDiscordRunning } from './discord/restart';
import { DeferredDeactivation } from './tunnel/deferred';
import { withDeadline } from './shutdown';
import { defaultDiscordCandidates, pickDiscordPath } from './discord/locate';
import { injectVencord, AppManagementDenied, canModifyApp } from './vencord/inject';
import { activate } from './tunnel/up';
import { deactivate } from './tunnel/down';
import { runActivation, runDeactivation } from './tunnel/activation';
import { cleanupStaleV6Rejects } from './privileged/helper';
import { ProtonFetcher, type ProtonFetchOpts, type ProtonFetchResult, type CatalogRoute, type FetchMode, type ProtonPlan } from './proton/fetch';
import { shouldAskRoutePreference } from './proton/route-prompt';
import { FailoverMonitor } from './tunnel/failover';
import { pingThroughTunnel } from './tunnel/traffic';
import { readSavedAccount, clearSavedAccount } from './proton/account';
import { checkForUpdate, downloadAndInstall, type UpdateInfo, type PendingUpdate } from './updater';
import type { AppSettings, UiSettings, ThemeChoice } from '../shared/types';
import { PhoneConfService } from './phone/service';
import { isCloudSyncedPath } from './phone/cloud';
import * as logger from './report/logger';
import { comRegistro, nivelDaMensagem } from './report/ops';
import { submitBugReport } from './report/bugreport';

const home   = os.homedir();
const user   = os.userInfo().username;
const binDir = path.join(process.resourcesPath ?? path.join(__dirname, '../../resources'), 'bin');

// Log persistente do relato de bug (gui.log, mesmo formato da GUI Windows/Linux)
const logDir = path.join(home, 'Library', 'Logs', 'GoLiveBypass');
logger.initLogger(logDir);
logger.patchConsole();
logger.info('app', 'inicio', { versao: app.getVersion(), macos: process.getSystemVersion?.() ?? os.release(), arch: process.arch });

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
  if (channel === 'log') {
    const msg = String(payload);
    logger.escrever(nivelDaMensagem(msg), 'app', msg);
  }
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

type TunnelUiState = 'active' | 'inactive' | 'pending' | 'activating' | 'deactivating';
let tunnelOp: Promise<unknown> | null = null;

function currentUiState(): TunnelUiState {
  if (!tunnelActive) return 'inactive';
  return deferredOff.pending ? 'pending' : 'active';
}

/** `error` revela o Restaurar internet quando a falha não veio de um clique. */
function pushState(state?: TunnelUiState, error?: string) {
  const s = state ?? currentUiState();
  sendToWindow('tunnel:state', error ? { state: s, error } : { state: s });
  syncMonitors(s);
}

// ─── Tráfego e troca automática de rota ──────────────────────────────────────

let trafficTimer: NodeJS.Timeout | null = null;
let failoverTimer: NodeJS.Timeout | null = null;

async function trafficTick() {
  sendToWindow('tunnel:traffic', { pingMs: await pingThroughTunnel() });
}

const failover = new FailoverMonitor({
  probe: async () => (await exitInfo(1)) !== null,
  onRouteDown: switchRoute,
});

function failoverEnabled(): boolean {
  const s = loadSettings();
  return s.autoFailover !== false && (s.connectionMode ?? 'proton') === 'proton'
    && s.protonRoutePreference !== 'manual' && !!readSavedAccount(sessionDir(home));
}

function syncMonitors(s: TunnelUiState) {
  const on = s === 'active' || s === 'pending';
  if (on && !trafficTimer) {
    trafficTimer = setInterval(() => { void trafficTick().catch(() => {}); }, 10_000);
    void trafficTick().catch(() => {});
  } else if (!on && s !== 'activating' && s !== 'deactivating' && trafficTimer) {
    clearInterval(trafficTimer);
    trafficTimer = null;
  }
  if (s === 'active' && !failoverTimer) {
    failover.reset();
    failoverTimer = setInterval(() => { if (failoverEnabled() && !tunnelOp) void failover.tick().catch(() => {}); }, 15_000);
  } else if (s !== 'active' && failoverTimer) {
    clearInterval(failoverTimer);
    failoverTimer = null;
  }
}

/** A rota Proton parou de responder: gera a próxima melhor e troca o túnel sem reiniciar o Discord. */
async function switchRoute(): Promise<void> {
  const account = readSavedAccount(sessionDir(home));
  if (!account) return;
  // Uma busca Proton por vez: a da janela e a do celular também gravam a sessão
  if (protonFetching || phone.generating) return;
  protonFetching = true;
  try { await switchRouteInner(account.username); } finally { protonFetching = false; }
}

async function switchRouteInner(username: string): Promise<void> {
  const current = loadSettings().protonServer?.server;
  sendToWindow('log', `A rota ${current ?? 'atual'} parou de responder; procurando outra…`);
  await exclusive(async () => {
    const r = await runFetch({ username, mode: 'auto', exclude: current ? [current] : [] });
    if (!r.ok) { sendToWindow('log', `Troca de rota falhou: ${r.error}${r.detail ? ` — ${r.detail}` : ''}`); return; }
    pushState('activating');
    const opts = await activationOpts();
    await runDeactivation(opts);
    const up = await runActivation(opts);
    tunnelActive = up.ok;
    if (up.ok) sendToWindow('log', `Rota trocada para ${r.chosen?.server ?? 'outra'}; o Discord reconecta sozinho.`);
    else {
      saveSettings({ lastTunnelState: 'inactive' });
      sendToWindow('log', `Falha ao subir a rota nova: ${up.error}${up.detail ? ` — ${up.detail}` : ''}`);
    }
    updateTray();
    pushState();
    sendToWindow('proton:route', loadSettings().protonServer ?? null);
  });
}

/** Desativar com o Discord aberto: o túnel cai quando ele fechar. */
const deferredOff = new DeferredDeactivation({
  isDiscordRunning,
  onDiscordClosed: async () => {
    const r = await exclusive(async () => {
      pushState('deactivating');
      const d = await runDeactivation(await activationOpts());
      let failure: string | undefined;
      if (d.ok) {
        tunnelActive = false;
        sendToWindow('log', 'Discord fechado: túnel desligado e rede restaurada.');
      } else {
        failure = `Falha ao desligar o túnel depois de o Discord fechar: ${d.error}${d.detail ? ` — ${d.detail}` : ''}`;
        sendToWindow('log', failure);
      }
      updateTray();
      pushState(undefined, failure);
    });
    // Outra operação no meio: tenta de novo na próxima volta
    if (r && typeof r === 'object' && 'error' in r && r.error === 'busy' && tunnelActive) deferredOff.start();
  },
});

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
  deferredOff.cancel();
  try {
    if (await withDeadline(deactivateBeforeQuit()) === 'timeout') console.error('Limpeza do Sair passou do prazo; encerrando mesmo assim.');
  } finally { app.exit(0); }
}

/** Qualquer resposta HTTP do Discord prova que os ranges dele voltaram a sair direto. */
const discordReachable = () =>
  net.fetch('https://discord.com/api/v9/gateway', { signal: AbortSignal.timeout(8000) }).then(() => true, () => false);

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
      label: !tunnelActive ? 'Bypass: inativo' : deferredOff.pending ? 'Bypass: desliga ao fechar o Discord' : 'Bypass: ATIVO',
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
    height: 680,
    minWidth: 380,
    minHeight: 520,
    // Aberto no login, o app sobe só na barra de menu
    show: !app.getLoginItemSettings().wasOpenedAtLogin,
    titleBarStyle: 'hiddenInset',
    vibrancy: 'under-window',
    visualEffectState: 'active',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  // Links externos (créditos, CAPTCHA) abrem no navegador, nunca numa janela do app
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

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

let pendingUpdate: (PendingUpdate & { version: string }) | null = null;

/** Guarda a última checagem: some se a release sumir, troca se sair outra. */
function rememberUpdate(info: UpdateInfo): UpdateInfo {
  pendingUpdate = info.available && info.downloadUrl && info.sha256 && info.latestVersion
    ? { downloadUrl: info.downloadUrl, sha256: info.sha256, version: info.latestVersion }
    : null;
  return info;
}
let protonFetching = false;
const routesPath = () => path.join(appDataDir(home), 'proton-routes.json');

function readRoutes(): CatalogRoute[] {
  try { return JSON.parse(fs.readFileSync(routesPath(), 'utf8')).routes ?? []; } catch { return []; }
}

/**
 * Roda o proton-confgen e, se gerou perfil, grava com a reescrita split tunnel.
 * Um ProtonFetcher por chamada: a troca automática pode rodar junto da tela.
 */
function runFetch(o: Omit<ProtonFetchOpts, 'binDir' | 'sessDir' | 'confOut'>, onProgress?: (m: string) => void): Promise<ProtonFetchResult> {
  fs.mkdirSync(appDataDir(home), { recursive: true, mode: 0o700 });
  const confOut = path.join(appDataDir(home), `proton-raw-${process.pid}-${Date.now()}.conf`);
  const f = new ProtonFetcher();
  if (onProgress) f.on('progress', onProgress);
  return new Promise<ProtonFetchResult>((resolve) => {
    f.once('done', (result: ProtonFetchResult) => {
      try {
        if (result.routes?.length) fs.writeFileSync(routesPath(), JSON.stringify({ routes: result.routes, at: new Date().toISOString() }));
        if (!result.ok || o.mode === 'catalog') return resolve(result);
        // O conf do Proton vem full-tunnel; passa pela reescrita split tunnel
        const stored = storeConfig(fs.readFileSync(confOut, 'utf8'));
        if (!stored.ok) return resolve({ ok: false, error: 'unknown', detail: stored.errors.join(' ') });
        saveSettings({ connectionMode: 'proton', ...(result.chosen ? { protonServer: result.chosen } : {}) });
        if (result.chosen) logger.info('proton', 'servidor ótimo selecionado', { server: result.chosen.server, ...(result.chosen.pingMs !== undefined ? { ping: result.chosen.pingMs } : {}) });
        resolve(result);
      } catch (e: any) {
        resolve({ ok: false, error: 'unknown', detail: String(e?.message ?? e) });
      } finally {
        fs.rmSync(confOut, { force: true });
      }
    });
    void f.fetch({ ...o, binDir, sessDir: sessionDir(home), confOut });
  });
}

/** Conf do celular: sessão Proton salva, sem tocar no golive.conf nem no túnel do Mac. */
const phone = new PhoneConfService({
  fetch: o => new Promise(resolve => {
    const f = new ProtonFetcher();
    f.once('done', resolve);
    void f.fetch({ ...o, username: readSavedAccount(sessionDir(home))?.username ?? '', binDir, sessDir: sessionDir(home) });
  }),
  tmpPath: () => {
    fs.mkdirSync(appDataDir(home), { recursive: true, mode: 0o700 });
    return path.join(appDataDir(home), `phone-raw-${process.pid}-${Date.now()}.conf`);
  },
  readFile: p => fs.readFileSync(p, 'utf8'),
  // writeFileSync só aplica o modo ao criar: o chmod cobre um arquivo que já existia
  writeFile: (p, data, mode) => { fs.writeFileSync(p, data, { mode }); fs.chmodSync(p, mode); },
  rm: p => fs.rmSync(p, { force: true }),
  exists: p => fs.existsSync(p),
  saveMeta: m => saveSettings({ phoneConf: m }),
  now: () => new Date(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: h => clearTimeout(h as NodeJS.Timeout),
  isBusy: () => protonFetching,
  isCloudSynced: p => isCloudSyncedPath(p, {
    home: os.homedir(),
    desktopDocumentsSynced: () => fs.existsSync(path.join(os.homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'Desktop')),
    realDir: d => { try { return fs.realpathSync(d); } catch { return d; } },
  }),
});

const phoneEligible = () => (loadSettings().connectionMode ?? 'proton') === 'proton' && !!readSavedAccount(sessionDir(home));

const planFetcher = new ProtonFetcher();
let planCache: { username: string; plan: ProtonPlan | null; at: number } | null = null;

const handlers = {
  async importConfig({ rawText }: { rawText: string }) {
    const r = storeConfig(rawText);
    if (r.ok) saveSettings({ connectionMode: 'conf' });
    return r;
  },

  async activate() {
    return exclusive(async () => {
      // Desativação adiada e túnel ainda no ar: basta cancelar a espera
      if (deferredOff.pending && tunnelActive) {
        deferredOff.cancel();
        saveSettings({ lastTunnelState: 'active' });
        updateTray();
        pushState();
        return { state: 'active', publicIp: null };
      }
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
      if ('error' in r) {
        logger.warn('tunnel', 'ativacao falhou', { erro: r.error, detalhe: r.detail });
        sendToWindow('log', `Falha ao ativar: ${r.error}${r.detail ? ` — ${r.detail}` : ''}`);
      } else {
        logger.info('tunnel', 'ativacao concluida', { servidor: loadSettings().protonServer?.server ?? 'conf importada' });
        tunnelActive = true;
        resumeTunnel = false;
        saveSettings({ lastTunnelState: 'active' });
        updateTray();
      }
      pushState();
      return r;
    });
  },

  async deactivate({ now }: { now?: boolean } = {}) {
    return exclusive(async () => {
      if (!now && tunnelActive && await isDiscordRunning()) {
        deferredOff.start();
        resumeTunnel = false;
        saveSettings({ lastTunnelState: 'inactive' });
        updateTray();
        pushState();
        sendToWindow('log', 'Desativação pendente: o túnel desliga quando você fechar o Discord.');
        return { state: 'pending' };
      }
      deferredOff.cancel();
      pushState('deactivating');
      // Agora com o Discord aberto: reinicia para ele largar as conexões do túnel
      const r = await deactivate({
        opts: await activationOpts(),
        restartDiscord: async () => { if (await isDiscordRunning()) await restartDiscord(); },
      });
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
    if (!tunnelActive) deferredOff.cancel();
    return {
      state: state === 'active' && deferredOff.pending ? 'pending' : state,
      hasConfig: refreshConfigState().hasConfig,
      busy: !!tunnelOp,
    };
  },

  /** Derruba e sobe o túnel numa operação só e reinicia o Discord. */
  async restart() {
    return exclusive(async () => {
      deferredOff.cancel();
      pushState('activating');
      const opts = await activationOpts();
      const down = await runDeactivation(opts);
      if (!down.ok) {
        sendToWindow('log', `Falha ao reiniciar (desligar): ${down.error}${down.detail ? ` — ${down.detail}` : ''}`);
        pushState();
        return { error: down.error ?? 'wg_failed', detail: down.detail };
      }
      tunnelActive = false;
      const r = await activate({
        opts,
        restartDiscord: async () => {
          if (loadSettings().vencordOptIn) await tryInjectVencord();
          await restartDiscord();
        },
        publicIp,
      });
      if ('error' in r) {
        saveSettings({ lastTunnelState: 'inactive' });
        sendToWindow('log', `Falha ao reiniciar (ligar): ${r.error}${r.detail ? ` — ${r.detail}` : ''}`);
      } else {
        tunnelActive = true;
        saveSettings({ lastTunnelState: 'active' });
      }
      updateTray();
      pushState();
      return r;
    });
  },

  /** Rede presa depois de uma falha: tira rotas e IPv6 do helper, mesmo sem túnel conhecido. */
  async restoreNetwork() {
    return exclusive(async () => {
      deferredOff.cancel();
      pushState('deactivating');
      const r = await runDeactivation(await activationOpts());
      let online = false;
      if (r.ok) {
        tunnelActive = false;
        resumeTunnel = false;
        saveSettings({ lastTunnelState: 'inactive' });
        online = await discordReachable();
        sendToWindow('log', online ? 'Rede restaurada: o Discord responde direto.' : 'Túnel limpo, mas o Discord ainda não responde.');
      } else {
        sendToWindow('log', `Falha ao restaurar a rede: ${r.error}${r.detail ? ` — ${r.detail}` : ''}`);
      }
      updateTray();
      pushState();
      return r.ok ? { ok: true, online } : { ok: false, error: r.error, detail: r.detail };
    });
  },

  async fetchProton({ username, password, mode, server }: { username: string; password?: string; mode?: FetchMode; server?: string }) {
    if (protonFetching || phone.generating) return { ok: false, error: 'busy' };
    protonFetching = true;
    try {
      const r = await runFetch({ username, password, mode, server }, m => sendToWindow('proton:progress', m));
      if (r.ok && mode === 'manual') saveSettings({ protonRoutePreference: 'manual', protonRoutePreferencePrompted: true });
      return { ...r, routes: r.routes ?? readRoutes() };
    } finally {
      protonFetching = false;
    }
  },

  async phoneStatus() {
    return { eligible: phoneEligible(), meta: loadSettings().phoneConf ?? null, savedPaths: phone.savedPaths().filter(p => fs.existsSync(p)) };
  },

  async phoneGenerate({ delivery }: { delivery?: 'qr' | 'file' }) {
    if (!delivery) return { ok: false, error: 'unknown' };
    if (!phoneEligible()) return { ok: false, error: 'not_eligible' };
    const r = await phone.generate(delivery);
    sendToWindow('log', r.ok
      ? `Conf do celular gerada: ${r.meta.server}`
      : `Falha ao gerar a conf do celular: ${r.error}`);
    return r;
  },

  async phoneSave() {
    const opts = { defaultPath: path.join(os.homedir(), 'Downloads', 'GoLiveBypass.conf'), filters: [{ name: 'WireGuard', extensions: ['conf'] }] };
    const pick = mainWindow ? await dialog.showSaveDialog(mainWindow, opts) : await dialog.showSaveDialog(opts);
    if (pick.canceled || !pick.filePath) return { ok: false, error: 'cancelled' };
    const r = phone.saveTo(pick.filePath);
    return r.ok ? { ok: true, path: pick.filePath } : r;
  },

  async phoneDeleteSaved() {
    return { ok: phone.deleteSaved() };
  },

  async phoneClear() {
    phone.clear();
    return { ok: true };
  },

  async protonRoutes() {
    const s = loadSettings();
    return { routes: readRoutes(), current: s.connectionMode === 'conf' ? null : s.protonServer ?? null };
  },

  async protonPlan({ force }: { force?: boolean } = {}) {
    const account = readSavedAccount(sessionDir(home));
    if (!account) return { plan: null };
    if (!force && planCache?.username === account.username && Date.now() - planCache.at < 30 * 60_000) return { plan: planCache.plan };
    const plan = await planFetcher.checkPlan(binDir, sessionDir(home), account.username);
    planCache = { username: account.username, plan, at: Date.now() };
    return { plan };
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
    planCache = null;
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

  async reportBug({ title, description, includeLogs }: { title: string; description: string; includeLogs: boolean }) {
    return submitBugReport({ title, description, includeLogs }, {
      home,
      logFile: path.join(logDir, 'gui.log'),
      protonUsername: readSavedAccount(sessionDir(home))?.username ?? null,
      meta: reportMeta(),
      fetch: ((input, init) => net.fetch(String(input), init)) as typeof fetch,
    });
  },

  async appInfo() {
    return { version: app.getVersion() };
  },

  async getSettings(): Promise<UiSettings> {
    const st = loadSettings();
    return {
      openAtLogin: app.getLoginItemSettings().openAtLogin,
      devMode: st.devMode === true,
      theme: st.theme ?? 'system',
      routePreference: st.protonRoutePreference === 'manual' ? 'manual' : 'auto',
      autoFailover: st.autoFailover !== false,
      connectionMode: st.connectionMode ?? 'proton',
      askRoutePreference: shouldAskRoutePreference(st),
    };
  },

  async setSettings(patch: Partial<Pick<UiSettings, 'openAtLogin' | 'devMode' | 'theme' | 'routePreference' | 'autoFailover'>> & { routePromptAnswered?: boolean }): Promise<UiSettings> {
    if (patch.openAtLogin !== undefined) app.setLoginItemSettings({ openAtLogin: patch.openAtLogin });
    if (patch.theme) nativeTheme.themeSource = patch.theme;
    saveSettings({
      ...(patch.devMode !== undefined ? { devMode: patch.devMode } : {}),
      ...(patch.theme ? { theme: patch.theme as ThemeChoice } : {}),
      ...(patch.autoFailover !== undefined ? { autoFailover: patch.autoFailover } : {}),
      ...(patch.routePreference ? { protonRoutePreference: patch.routePreference, protonRoutePreferencePrompted: true } : {}),
      ...(patch.routePromptAnswered ? { protonRoutePreferencePrompted: true } : {}),
    });
    return handlers.getSettings();
  },
};

const router = comRegistro(makeRouter(handlers as any));

// Metadados técnicos do relato: diagnóstico sem identificar a pessoa nem expor a saída escolhida.
function reportMeta(): Record<string, string> {
  const st = loadSettings();
  return {
    versao: app.getVersion(),
    plataforma: `${process.platform}-${process.arch}`,
    macos: process.getSystemVersion?.() ?? os.release(),
    electron: process.versions.electron ?? '?',
    node: process.versions.node ?? '?',
    locale: app.getLocale() || '?',
    fuso: Intl.DateTimeFormat().resolvedOptions().timeZone || '?',
    modoRoteamento: 'wireguard-split-ip',
    bypass: currentUiState(),
    conexao: st.connectionMode ?? 'conf',
    rota: st.protonRoutePreference === 'manual' ? 'manual' : 'auto',
    troca_automatica: st.autoFailover === false ? 'nao' : 'sim',
    vencord: st.vencordOptIn ? 'sim' : 'nao',
    uptime_s: String(Math.round(process.uptime())),
  };
}

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
  // Antes da janela: o vidro e o prefers-color-scheme do renderer seguem o themeSource
  nativeTheme.themeSource = loadSettings().theme ?? 'system';
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
    // Desativação pendente: o usuário já pediu para desligar, então não volta ao acordar
    const keep = !deferredOff.pending;
    deferredOff.cancel();
    void exclusive(async () => {
      if (await bringDownQuietly() && keep) resumeTunnel = true;
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
      try {
        if (deriveStateFromRoute(await readDefaultRoute()) === 'active') {
          if (lastTunnelState === 'active') return;
          // Túnel ativo com preferência inativa: o app morreu com a desativação pendente.
          tunnelActive = true;
          if (await isDiscordRunning()) {
            deferredOff.start();
            sendToWindow('log', 'Desativação pendente retomada: o túnel desliga quando você fechar o Discord.');
          } else {
            const d = await runDeactivation(await activationOpts());
            if (d.ok) {
              tunnelActive = false;
              sendToWindow('log', 'Túnel de uma sessão anterior desligado.');
            } else {
              const failure = `Falha ao desligar o túnel de uma sessão anterior: ${d.error}${d.detail ? ` — ${d.detail}` : ''}`;
              sendToWindow('log', failure);
              updateTray();
              pushState(undefined, failure);
              return;
            }
          }
          updateTray();
          return;
        }
        if (await cleanupStaleV6Rejects()) sendToWindow('log', 'Rotas IPv6 de uma sessão anterior removidas.');
      } finally {
        // O renderer que carregou no meio da limpeza recebeu busy=true e não tem
        // como sair: só um tunnel:state devolve o botão Ativar.
        pushState();
      }
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
