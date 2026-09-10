import { protonMeasurementText } from './proton-measurement';
import { renderProtonCountryFlag } from './proton-flags';
import {
  isManualRouteSelectable,
  recommendManualRoute,
  reduceManualRouteEvent,
  sortManualRouteCandidates,
  type ManualRouteCandidate,
} from './proton-manual-selection';
import './style.css'

declare global {
  interface Window {
    api: {
      platform: string;
      activate: () => Promise<void>;
      deactivate: () => Promise<void>;
      restoreInternet: () => Promise<{ ok: boolean; error?: string; residual?: string[]; dnsOk?: boolean; httpsOk?: boolean }>;
      getStatus: () => Promise<string>;
      getLinuxPreflight: () => Promise<{
        ok: boolean;
        distro: string;
        archLike: boolean;
        dependencies: { missing: string[]; required: string[] };
        repairable?: boolean;
        elevation: { available: boolean; method: string };
        netns: { available: boolean };
        discord: { found: boolean; count: number; firstPath: string };
        errors: string[];
        installCommand: string;
      } | null>;
      getVersion: () => Promise<string>;
      getPlatform: () => Promise<string>;
      getStartup: () => Promise<boolean>;
      setStartup: (enabled: boolean) => Promise<{ success: boolean; error?: string }>;
      getAutoUpdate: () => Promise<boolean>;
      setAutoUpdate: (enabled: boolean) => Promise<void>;
      getUpdateChannel: () => Promise<string>;
      setUpdateChannel: (canal: string) => Promise<void>;
      startLogWatch: () => Promise<{ path: string }>;
      stopLogWatch: () => Promise<boolean>;
      getDiagnostic: (payload: { status: string; note?: string }) => Promise<{
        text: string;
        logPath: string;
        apiConfigured?: boolean;
      }>;
      openBugReport: (payload: {
        status: string;
        note?: string;
        title?: string;
      }) => Promise<{
        ok: boolean;
        via?: "api" | "github";
        url: string;
        issueNumber?: number;
        copied: boolean;
        truncated: boolean;
        apiError?: string;
      }>;
      openLogFolder: () => Promise<string>;
      setDevLogWindow: (open: boolean) => Promise<boolean>;
      onLogChunk: (callback: (chunk: string) => void) => void;
      onDevLogWindowClosed: (callback: () => void) => void;
      onRefreshStartup: (callback: () => void) => void;
      onRefreshAutoUpdate: (callback: () => void) => void;
      onRefreshStatus: (callback: () => void) => void;
      resizeWindow: (height: number) => void;
      importWgConf: () => Promise<{ success: boolean; fileName?: string; path?: string; error?: string } | null>;
      importWgConfFile: (filePath: string) => Promise<{ success: boolean; fileName?: string; path?: string; error?: string } | null>;
      getWgConfName: () => Promise<string>;
      testWgConf: () => Promise<{
        ok: boolean;
        endpoint?: string;
        resolvedIp?: string;
        address?: string;
        dns?: string;
        exitInfo?: { ip?: string; country?: string };
        readiness?: { ready?: boolean; state?: string; source?: string; error?: string; handshakeAgoS?: number };
        active?: boolean;
        error?: string;
      }>;
      setTheme: (theme: string) => void;
      reportBug: (payload: { title: string; description: string; includeLogs: boolean }) => Promise<{
        ok: boolean;
        issueUrl?: string;
        issueNumber?: number;
        error?: string;
        blocked?: boolean;
        retryAfter?: number;
      }>;
      getVpnMode: () => Promise<'proton' | 'custom'>;
      setVpnMode: (mode: 'proton' | 'custom') => Promise<string>;
      checkProtonSession: (username?: string) => Promise<{ valid: boolean; username?: string; expiresIn?: string; error?: string }>;
      loginProton: (payload: { username: string; password?: string; twoFactorCode?: string }) => Promise<{ success: boolean; code?: string; message?: string; error?: string; retryable?: boolean }>;
      onProtonCaptchaStatus: (callback: (status: string) => void) => void;
      logoutProton: () => Promise<boolean>;
      optimizeProtonRoute: (options?: { country?: string; freeOnly?: boolean; autoPing?: boolean; speedTest?: boolean; reuseMeasured?: boolean; refreshOnStartup?: boolean; requestId?: string }) => Promise<{
        success: boolean;
        server?: string;
        country?: string;
        city?: string;
        tier?: string;
        load?: number;
        score?: number;
        pingMs?: number;
        downloadMbps?: number;
        uploadMbps?: number;
        speedTested?: number;
        speedSucceeded?: number;
        endpoint?: string;
        confFile?: string;
        readiness?: { verified?: boolean; state?: string; source?: string; detail?: string };
        error?: string;
        cancelled?: boolean;
        deferred?: boolean;
        startup?: boolean;
      }>;
      selectProtonRoute: (options: { measurementId: string; server: string }) => Promise<{
        success: boolean;
        manual?: boolean;
        server?: string;
        pingMs?: number;
        error?: string;
      }>;
      onProtonOptimizationProgress: (callback: (event: ProtonOptimizationProgress) => void) => (() => void) | void;
      cancelProtonOptimization: (requestId: string) => Promise<boolean>;
      getProtonSettings: () => Promise<{
        vpnMode: 'proton' | 'custom';
        username: string;
        country: string;
        freeOnly: boolean;
        autoPing: boolean;
        autoFailover: boolean;
        lastServer?: any;
      }>;
      getProtonPlan: (options?: { force?: boolean }) => Promise<{
        success: boolean;
        status: 'free' | 'premium' | 'unknown';
        maxTier?: number;
        planName?: string;
        planTitle?: string;
        checkedAt?: string;
        error?: string;
      }>;
      setProtonSettings: (settings: any) => Promise<boolean>;
      onProtonFailoverNotice?: (callback: (notice: { message: string }) => void) => unknown;
    }
  }
}

interface ProtonOptimizationProgress {
  requestId: string;
  phase: 'ping' | 'preparing' | 'testing' | 'finalizing' | 'completed' | 'failed' | 'cancelled';
  total: number;
  tested: number;
  succeeded: number;
  server?: string;
  downloadMbps?: number;
  uploadMbps?: number;
  pingMs?: number;
  status?: 'testing' | 'success' | 'failed';
}

const platform = window.api.platform;
const isMac = platform === 'darwin';
const isLinux = platform === 'linux';

function applyPlatformCopy() {
  document.body.classList.toggle('darwin', isMac);

  const startupLabel = document.getElementById('startupLabel');
  if (startupLabel) {
    // Linux: autostart XDG; Windows/Mac: login item. O rotulo acompanha o SO.
    startupLabel.textContent = isMac ? 'Iniciar com o Mac' : isLinux ? 'Iniciar com o sistema' : 'Iniciar com o Windows';
  }

  const closeHint = document.getElementById('closeHint');
  if (closeHint) {
    closeHint.textContent = isMac
      ? 'Fechar a janela esconde o app na barra de menus, junto do relógio — para reverter tudo, saia pelo ícone de lá.'
      : 'Fechar a janela esconde o app na bandeja, junto do relógio — para reverter tudo, saia pelo ícone de lá.';
  }
}

// ---------------------------------------------------------------------------
// Tema claro/escuro — persistido em localStorage e avisado ao main process
// (o titleBarOverlay do Windows precisa saber a cor de fundo da janela).
// ---------------------------------------------------------------------------
const THEME_KEY = 'golivebypass-theme';

function applyTheme(theme: 'light' | 'dark') {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // localStorage pode falhar (perfil sem escrita); o tema ainda vale na sessao.
  }
  window.api.setTheme(theme);
}

function initTheme() {
  // Tema padrao: dark. So usa o claro se estiver salvo explicitamente.
  let theme: 'light' | 'dark' = 'dark';
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'dark' || saved === 'light') theme = saved;
  } catch {
    // cai no default escuro
  }
  applyTheme(theme);
}

const statusIndicator = document.getElementById('statusIndicator')!;
const statusText = document.getElementById('statusText')!;
const statusTag = document.getElementById('statusTag')!;
const statusCard = document.getElementById('statusCard')!;
const linuxPreflightCommand = document.getElementById('linuxPreflightCommand') as HTMLElement | null;
const toggleBtn = document.getElementById('toggleBtn') as HTMLButtonElement;
const btnText = document.getElementById('btnText')!;
const restoreInternetBtn = document.getElementById('restoreInternetBtn') as HTMLButtonElement | null;
let hasSelectedConf = false;
const appVersionEl = document.getElementById('appVersion');
const startupToggle = document.getElementById('startupToggle') as HTMLInputElement;
const autoUpdateToggle = document.getElementById('autoUpdateToggle') as HTMLInputElement | null;
const autoFailoverToggle = document.getElementById('autoFailoverToggle') as HTMLInputElement | null;
const updateChannelRow = document.getElementById('updateChannelRow') as HTMLElement | null;
const updateChannelToggle = document.getElementById('updateChannelToggle') as HTMLInputElement | null;
const settingsBtn = document.getElementById('settingsBtn') as HTMLButtonElement | null;
const settingsDialog = document.getElementById('settingsDialog') as HTMLElement | null;
const settingsBackdrop = document.getElementById('settingsBackdrop') as HTMLElement | null;
const settingsClose = document.getElementById('settingsClose') as HTMLButtonElement | null;
const vpnImportBtn = document.getElementById('vpnImportBtn') as HTMLButtonElement | null;
const vpnConfigStatus = document.getElementById('vpnConfigStatus') as HTMLElement | null;
const vpnDropZone = document.getElementById('vpnDropZone') as HTMLElement | null;
const vpnDropFeedback = document.getElementById('vpnDropFeedback') as HTMLElement | null;

let currentState = 'INACTIVE';
let linuxPreflight: Awaited<ReturnType<Window['api']['getLinuxPreflight']>> = null;

// ---------------------------------------------------------------------------
// Configurações: o botão de canto abre o dialog com tema + notificações de
// update. O tema continua aplicando na hora (e avisando o main pro
// titleBarOverlay); o toggle de update reusa o mesmo handler de sempre.
// ---------------------------------------------------------------------------
function syncThemeOptions() {
  const atual = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  document.querySelectorAll<HTMLButtonElement>('.theme-opt').forEach((opt) => {
    const ativo = opt.dataset.themeOpt === atual;
    opt.classList.toggle('theme-opt--active', ativo);
    opt.setAttribute('aria-checked', String(ativo));
  });
}

function openSettingsDialog() {
  if (!settingsDialog) return;
  syncThemeOptions();
  void refreshAutoFailover();
  settingsDialog.hidden = false;
  settingsClose?.focus();
}

function closeSettingsDialog() {
  if (!settingsDialog) return;
  settingsDialog.hidden = true;
}

settingsBtn?.addEventListener('click', openSettingsDialog);
settingsBackdrop?.addEventListener('click', closeSettingsDialog);
settingsClose?.addEventListener('click', closeSettingsDialog);

document.querySelectorAll<HTMLButtonElement>('.theme-opt').forEach((opt) => {
  opt.addEventListener('click', () => {
    applyTheme(opt.dataset.themeOpt === 'light' ? 'light' : 'dark');
    syncThemeOptions();
  });
});

// ---------------------------------------------------------------------------

// O warning do bypass ativo faz o conteudo crescer; a janela e fixa, entao reportamos a altura
// necessaria para o main process redimensionar e nada ficar cortado.
function fitWindowToContent() {
  // Espera o layout apos hidden/details: sem rAF a medicao ainda ve a altura antiga
  // (Personalizado expandia e a janela nunca encolhia ao voltar para Tor/Gratuitas).
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const container = document.querySelector('.container') as HTMLElement | null;
      if (!container) return;
      const height = Math.ceil(container.getBoundingClientRect().height + 1);
      window.api.resizeWindow(height);
    });
  });
}

async function updateStatus() {
  try {
    if (isLinux) linuxPreflight = await window.api.getLinuxPreflight();
    const status = await window.api.getStatus();
    currentState = status;
    
    statusIndicator.className = 'status-indicator';
    statusTag.className = 'status-tag';
    toggleBtn.classList.remove('loading', 'deactivate', 'overwrite');

    if (status === 'ACTIVE') {
      statusText.innerText = 'GoLiveBypass está Ativo';
      statusTag.textContent = 'Ativo';
      statusTag.classList.add('tag--ok');
      btnText.innerText = 'Desativar Bypass';
      toggleBtn.classList.add('deactivate');
      toggleBtn.disabled = false;
      statusCard.hidden = true;
      if (linuxPreflightCommand) linuxPreflightCommand.hidden = true;
    } else if (status === 'CONNECTING') {
      statusText.innerText = 'Iniciando a conexão do Discord…';
      statusTag.textContent = 'Iniciando';
      statusTag.classList.add('tag--warn');
      toggleBtn.disabled = true;
      btnText.innerText = 'Iniciando túnel…';
      statusCard.hidden = false;
    } else if (status === 'RECOVERY_REQUIRED') {
      statusText.innerText = 'A rota não pôde ser restaurada automaticamente';
      statusTag.textContent = 'Recuperação necessária';
      statusTag.classList.add('tag--danger');
      toggleBtn.disabled = true;
      btnText.innerText = 'Use Restaurar internet';
      statusCard.hidden = false;
    } else if (status === 'NOT_FOUND') {
      statusText.innerText = 'Discord não encontrado';
      statusTag.textContent = 'Ausente';
      statusTag.classList.add('tag--danger');
      toggleBtn.disabled = true;
      btnText.innerText = 'Não Disponível';
      statusCard.hidden = false;
      if (linuxPreflightCommand) linuxPreflightCommand.hidden = true;
    } else if (status === 'UNSUPPORTED') {
      statusText.innerText = isMac ? 'Bypass por WireGuard indisponível no macOS' : 'Plataforma não suportada';
      statusTag.textContent = 'Indisponível';
      statusTag.classList.add('tag--danger');
      toggleBtn.disabled = true;
      btnText.innerText = 'Não Disponível';
      statusCard.hidden = false;
      if (linuxPreflightCommand) linuxPreflightCommand.hidden = true;
    } else if (isLinux && linuxPreflight && !linuxPreflight.ok) {
      const missing = linuxPreflight.dependencies.missing;
      const canPrepare = linuxPreflight.repairable === true;
      statusText.innerText = canPrepare
        ? `Dependências do Linux ausentes: ${missing.join(', ')}. Serão preparadas ao ativar.`
        : (linuxPreflight.errors[0] || 'Ambiente Linux não está pronto');
      statusTag.textContent = canPrepare ? 'Preparação necessária' : 'Corrija antes de ativar';
      statusTag.classList.add(canPrepare ? 'tag--warn' : 'tag--danger');
      toggleBtn.disabled = !canPrepare || !hasSelectedConf;
      btnText.innerText = canPrepare ? (hasSelectedConf ? 'Preparar e ativar' : 'Selecione uma Configuração') : 'Não Disponível';
      statusCard.hidden = false;
      if (linuxPreflightCommand) {
        linuxPreflightCommand.textContent = linuxPreflight.installCommand
          ? `Comando: ${linuxPreflight.installCommand}`
          : 'Verifique sudo/pkexec, iproute2 e o suporte a namespaces.';
        linuxPreflightCommand.hidden = false;
      }
    } else {
      if (!hasSelectedConf) {
        toggleBtn.disabled = true;
        btnText.innerText = 'Selecione uma Configuração';
        statusText.innerText = currentVpnMode === 'proton'
          ? 'Conecte sua conta ProtonVPN abaixo para ativar'
          : 'Importe uma configuração WireGuard (.conf) abaixo para ativar';
        statusTag.textContent = 'Configuração necessária';
        statusTag.classList.add('tag--warn');
        statusCard.hidden = false;
        if (linuxPreflightCommand) linuxPreflightCommand.hidden = true;
      } else {
        toggleBtn.disabled = false;
        btnText.innerText = 'Ativar Bypass';
        statusText.innerText = 'Discord pronto para execução';
        statusTag.textContent = 'Pronto';
        statusTag.classList.add('tag--ok');
        statusCard.hidden = true;
        if (linuxPreflightCommand) linuxPreflightCommand.hidden = true;
      }
    }
  } catch (err) {
    console.error(err);
    statusText.innerText = 'Erro ao buscar status';
    statusTag.textContent = 'Erro';
    statusTag.classList.add('tag--danger');
    statusCard.hidden = false;
  }
  if (restoreInternetBtn) {
    restoreInternetBtn.hidden = window.api.platform !== 'win32' || currentState === 'ACTIVE';
  }
  if (protonOptimizationInFlight || protonManualSelectionInFlight) toggleBtn.disabled = true;
  // Depois de mudar o estado, ajusta a janela ao novo tamanho do conteudo.
  fitWindowToContent();
}

toggleBtn.addEventListener('click', async () => {
  if (protonOptimizationInFlight || protonManualSelectionInFlight) return;
  toggleBtn.disabled = true;
  toggleBtn.classList.add('loading');

  try {
    if (currentState === 'ACTIVE') {
      try {
        await window.api.deactivate();
      } catch (err) {
        updateStatus();
        throw err;
      }
    } else {
      if (!hasSelectedConf) {
        const msg = currentVpnMode === 'proton'
          ? 'Por favor, conecte sua conta ProtonVPN antes de ativar.'
          : 'Por favor, importe uma configuração WireGuard (.conf) antes de ativar.';
        alert(msg);
        toggleBtn.disabled = true;
        return;
      }
      try {
        await window.api.activate();
      } catch (err) {
        throw err;
      }
    }
  } catch (err) {
    alert('Erro: ' + err);
  }

  await updateStatus();
});

restoreInternetBtn?.addEventListener('click', async () => {
  if (protonOptimizationInFlight || protonManualSelectionInFlight) return;
  restoreInternetBtn.disabled = true;
  const original = restoreInternetBtn.textContent;
  restoreInternetBtn.textContent = 'Restaurando internet…';
  try {
    const result = await window.api.restoreInternet();
    if (!result.ok) {
      const detalhe = result.residual?.join(', ') || result.error || 'verifique o DNS e tente novamente';
      throw new Error(detalhe);
    }
    alert('Internet restaurada. Se o Discord estava aberto, saia e entre novamente na call.');
    await updateStatus();
  } catch (err) {
    alert('Não foi possível restaurar a internet: ' + (err instanceof Error ? err.message : String(err)));
  } finally {
    restoreInternetBtn.textContent = original || 'Restaurar internet';
    restoreInternetBtn.disabled = false;
  }
});

// Inicialização
applyPlatformCopy();
initTheme();
refreshVersion();
initVpnSection().then(() => updateStatus());
refreshStartup();
refreshAutoUpdate();
fitWindowToContent();

async function refreshVersion() {
  try {
    const ver = await window.api.getVersion();
    if (appVersionEl && ver) {
      appVersionEl.textContent = `v${ver}`;
    }
  } catch (err) {
    console.error(err);
  }
}

async function refreshStartup() {
  try {
    startupToggle.checked = await window.api.getStartup();
  } catch (err) {
    console.error(err);
  }
}

async function refreshAutoUpdate() {
  try {
    if (autoUpdateToggle) {
      autoUpdateToggle.checked = await window.api.getAutoUpdate();
    }
    // O canal beta so existe onde ha updater que o suporta (updater proprio no
    // Windows, allowPrerelease no Linux); no macOS nao existe updater nenhum.
    if (updateChannelRow) {
      updateChannelRow.hidden = window.api.platform === 'darwin';
    }
    if (updateChannelToggle) {
      updateChannelToggle.checked = (await window.api.getUpdateChannel()) === 'beta';
    }
  } catch (err) {
    console.error(err);
  }
}

async function refreshAutoFailover() {
  try {
    const settings = await window.api.getProtonSettings();
    if (autoFailoverToggle) autoFailoverToggle.checked = settings.autoFailover !== false;
  } catch (err) {
    console.error(err);
  }
}

// ---------------------------------------------------------------------------
// Configuração WireGuard & ProtonVPN (Per-App VPN)
// ---------------------------------------------------------------------------
const tabProton = document.getElementById('tabProton') as HTMLButtonElement | null;
const tabCustom = document.getElementById('tabCustom') as HTMLButtonElement | null;
const panelProton = document.getElementById('panelProton') as HTMLElement | null;
const panelCustom = document.getElementById('panelCustom') as HTMLElement | null;

const protonAuthForm = document.getElementById('protonAuthForm') as HTMLElement | null;
const protonConnectedView = document.getElementById('protonConnectedView') as HTMLElement | null;
const protonUsername = document.getElementById('protonUsername') as HTMLInputElement | null;
const protonPassword = document.getElementById('protonPassword') as HTMLInputElement | null;
const protonPasswordToggle = document.getElementById('protonPasswordToggle') as HTMLButtonElement | null;
const protonPasswordShowIcon = document.getElementById('protonPasswordShowIcon') as SVGElement | null;
const protonPasswordHideIcon = document.getElementById('protonPasswordHideIcon') as SVGElement | null;
const proton2FA = document.getElementById('proton2FA') as HTMLInputElement | null;
const proton2FADialog = document.getElementById('proton2FADialog') as HTMLElement | null;
const proton2FABackdrop = document.getElementById('proton2FABackdrop') as HTMLElement | null;
const proton2FACloseBtn = document.getElementById('proton2FACloseBtn') as HTMLButtonElement | null;
const proton2FACancelBtn = document.getElementById('proton2FACancelBtn') as HTMLButtonElement | null;
const proton2FAConfirmBtn = document.getElementById('proton2FAConfirmBtn') as HTMLButtonElement | null;
const protonLoginBtn = document.getElementById('protonLoginBtn') as HTMLButtonElement | null;
const protonLoginBtnText = document.getElementById('protonLoginBtnText') as HTMLElement | null;
const protonLoginSpinner = document.getElementById('protonLoginSpinner') as HTMLElement | null;
let protonLoginInFlight = false;

const protonUserDisplay = document.getElementById('protonUserDisplay') as HTMLElement | null;
const protonDot = document.getElementById('protonDot') as HTMLElement | null;
const protonPlanStatus = document.getElementById('protonPlanStatus') as HTMLElement | null;
const protonPlanRefreshBtn = document.getElementById('protonPlanRefreshBtn') as HTMLButtonElement | null;
const protonLogoutBtn = document.getElementById('protonLogoutBtn') as HTMLButtonElement | null;
const protonCountrySelect = document.getElementById('protonCountrySelect') as HTMLSelectElement | null;
const protonOptimizeBtn = document.getElementById('protonOptimizeBtn') as HTMLButtonElement | null;
const protonOptimizeBtnText = document.getElementById('protonOptimizeBtnText') as HTMLElement | null;

const protonServerBadge = document.getElementById('protonServerBadge') as HTMLElement | null;
const protonServerFlag = document.getElementById('protonServerFlag') as HTMLElement | null;
const protonServerName = document.getElementById('protonServerName') as HTMLElement | null;
const protonServerPing = document.getElementById('protonServerPing') as HTMLElement | null;
const protonServerLoad = document.getElementById('protonServerLoad') as HTMLElement | null;
const protonFeedback = document.getElementById('protonFeedback') as HTMLElement | null;
const protonMeasurementDialog = document.getElementById('protonMeasurementDialog') as HTMLDialogElement | null;
const protonMeasurement = document.getElementById('protonMeasurement') as HTMLElement | null;
const protonMeasurementTitle = document.getElementById('protonMeasurementTitle') as HTMLElement | null;
const protonMeasurementProgress = document.getElementById('protonMeasurementProgress') as HTMLElement | null;
const protonMeasurementCount = document.getElementById('protonMeasurementCount') as HTMLElement | null;
const protonMeasurementList = document.getElementById('protonMeasurementList') as HTMLElement | null;
const protonManualFallback = document.getElementById('protonManualFallback') as HTMLElement | null;
const protonManualFallbackHint = document.getElementById('protonManualFallbackHint') as HTMLElement | null;
const protonManualRecommendation = document.getElementById('protonManualRecommendation') as HTMLElement | null;
const protonManualRecommendationBtn = document.getElementById('protonManualRecommendationBtn') as HTMLButtonElement | null;
const protonMeasurementActions = document.getElementById('protonMeasurementActions') as HTMLElement | null;
const protonCancelMeasurementBtn = document.getElementById('protonCancelMeasurementBtn') as HTMLButtonElement | null;
const protonRetryMeasurementBtn = document.getElementById('protonRetryMeasurementBtn') as HTMLButtonElement | null;
const protonContinueMeasurementBtn = document.getElementById('protonContinueMeasurementBtn') as HTMLButtonElement | null;
const protonCloseMeasurementBtn = document.getElementById('protonCloseMeasurementBtn') as HTMLButtonElement | null;

let currentVpnMode: 'proton' | 'custom' = 'proton';
let isProtonAuthenticated = false;
let protonStateGeneration = 0;
let protonOptimizationInFlight = false;
let protonOptimizationRequestId = '';
let protonManualMeasurementId = '';
let protonManualSelectionInFlight = false;
let protonMeasurementTotal = 0;
let protonMeasurementTested = 0;
const protonMeasurementRows = new Map<string, HTMLElement>();
let protonManualCandidates = new Map<string, ManualRouteCandidate>();
let protonMeasurementDialogLastFocus: HTMLElement | null = null;

function formatMbps(value?: number): string {
  return Number.isFinite(value) && value! > 0 ? `${value!.toFixed(1)} Mbps` : '—';
}

function formatProtonServerName(value?: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';

  // A API pode devolver nomes regionais como US-NY#189. Para a leitura rápida
  // na tela, mantemos somente o código do país e o número do servidor.
  const match = raw.match(/^([A-Za-z]{2})(?:-[^#\s]+)?#(\d+)$/);
  return match ? `${match[1].toUpperCase()}#${match[2]}` : raw;
}

function protonServerCountry(value?: string): string {
  const normalized = formatProtonServerName(value);
  return normalized.match(/^([A-Z]{2})#/)?.[1] ?? '';
}

function updateProtonCountryFlag(element: HTMLElement | null, server?: string) {
  if (!element) return;
  element.innerHTML = server ? renderProtonCountryFlag(protonServerCountry(server)) : '';
}

function renderMeasurementList() {
  if (!protonMeasurementList) return;
  for (const row of protonMeasurementRows.values()) protonMeasurementList.appendChild(row);
}

function setManualFallbackVisible(visible: boolean) {
  if (protonManualFallback) protonManualFallback.hidden = !visible;
  if (!visible) {
    if (protonManualRecommendation) protonManualRecommendation.hidden = true;
    if (protonManualRecommendationBtn) {
      protonManualRecommendationBtn.disabled = false;
      protonManualRecommendationBtn.dataset.manualServer = '';
    }
  }
  fitWindowToContent();
}

function setManualSelectionBusy(busy: boolean) {
  protonManualSelectionInFlight = busy;
  protonManualFallback?.querySelectorAll<HTMLButtonElement>('[data-manual-server]').forEach((button) => {
    button.disabled = busy || button.classList.contains('is-unavailable');
  });
  if (protonManualRecommendationBtn) protonManualRecommendationBtn.disabled = busy;
  if (protonRetryMeasurementBtn) protonRetryMeasurementBtn.disabled = busy;
  if (protonContinueMeasurementBtn) protonContinueMeasurementBtn.disabled = busy;
  if (protonCloseMeasurementBtn) protonCloseMeasurementBtn.disabled = busy;
  if (protonOptimizeBtn) protonOptimizeBtn.disabled = busy || protonOptimizationInFlight;
  toggleBtn.disabled = busy || protonOptimizationInFlight;
  if (restoreInternetBtn) restoreInternetBtn.disabled = busy;
}

function manualRouteMetrics(candidate: ManualRouteCandidate): string {
  const ping = Number.isFinite(candidate.pingMs) && candidate.pingMs! > 0 && candidate.pingMs! < 999
    ? `${candidate.pingMs} ms` : '';
  const speed = Number.isFinite(candidate.downloadMbps) && candidate.downloadMbps! > 0 &&
    Number.isFinite(candidate.uploadMbps) && candidate.uploadMbps! > 0
    ? `↓ ${formatMbps(candidate.downloadMbps)} · ↑ ${formatMbps(candidate.uploadMbps)}` : '';
  if (ping && speed) return `${ping} · ${speed}`;
  if (ping) return `${ping} · será verificada novamente antes de aplicar`;
  return candidate.failureReason || 'Sem resposta ao ping';
}

function manualRouteStatus(candidate: ManualRouteCandidate, selectable: boolean): string {
  if (candidate.preflightStatus === 'failed') return 'Reprovada no preflight';
  if (!selectable) return 'Sem resposta';
  return candidate.speedStatus === 'success' ? 'Disponível · velocidade medida' : 'Disponível';
}

function makeManualRouteButton(candidate: ManualRouteCandidate, recommended: boolean): HTMLButtonElement {
  const selectable = isManualRouteSelectable(candidate);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `proton-manual-route${selectable ? '' : ' is-unavailable'}${recommended ? ' is-recommended' : ''}`;
  button.disabled = !selectable;
  button.dataset.manualServer = candidate.server;
  button.setAttribute('aria-label', `${formatProtonServerName(candidate.server)}: ${manualRouteMetrics(candidate)}`);

  const top = document.createElement('span');
  top.className = 'proton-manual-route__top';
  const flag = document.createElement('span');
  flag.className = 'proton-country-flag proton-measurement__server-flag';
  flag.setAttribute('aria-hidden', 'true');
  updateProtonCountryFlag(flag, candidate.server);
  const name = document.createElement('span');
  name.className = 'proton-manual-route__name';
  name.textContent = formatProtonServerName(candidate.server);
  top.append(flag, name);
  if (recommended) {
    const badge = document.createElement('span');
    badge.className = 'proton-manual-route__badge';
    badge.textContent = 'Recomendada';
    top.appendChild(badge);
  }

  const status = document.createElement('span');
  status.className = 'proton-manual-route__status';
  status.textContent = manualRouteStatus(candidate, selectable);
  const metrics = document.createElement('span');
  metrics.className = 'proton-manual-route__metrics';
  metrics.textContent = manualRouteMetrics(candidate);
  button.append(top, status, metrics);
  return button;
}

function renderManualRouteChoices() {
  if (!protonMeasurementList) return;
  const sorted = sortManualRouteCandidates(protonManualCandidates.values());
  const recommendedServer = recommendManualRoute(sorted);
  protonMeasurementList.replaceChildren();
  if (sorted.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'proton-manual-fallback__hint';
    empty.textContent = 'Nenhuma rota participou da medição atual. Tente novamente para obter novas candidatas.';
    protonMeasurementList.appendChild(empty);
  } else {
    for (const candidate of sorted) {
      protonMeasurementList.appendChild(makeManualRouteButton(candidate, candidate.server === recommendedServer));
    }
  }

  if (protonManualRecommendation && protonManualRecommendationBtn && recommendedServer) {
    const recommended = sorted.find((candidate) => candidate.server === recommendedServer);
    if (recommended) {
      protonManualRecommendation.hidden = false;
      protonManualRecommendationBtn.dataset.manualServer = recommended.server;
      protonManualRecommendationBtn.textContent = `${formatProtonServerName(recommended.server)} · ${manualRouteMetrics(recommended)}`;
      protonManualRecommendationBtn.setAttribute('aria-label', `Usar rota recomendada ${formatProtonServerName(recommended.server)}`);
    }
  }
  if (protonManualFallbackHint) {
    protonManualFallbackHint.textContent = recommendedServer
      ? 'A seleção automática falhou. Escolha uma rota medida; ela será verificada novamente antes de aplicar.'
      : 'Nenhuma rota respondeu com um ping utilizável. Tente novamente para obter novas candidatas.';
  }
  setManualFallbackVisible(true);
}

async function selectManualProtonRoute(server: string) {
  if (protonManualSelectionInFlight || !protonManualMeasurementId || !server) return;
  const candidate = protonManualCandidates.get(server);
  if (!candidate || !isManualRouteSelectable(candidate)) return;
  setManualSelectionBusy(true);
  if (protonManualFallbackHint) protonManualFallbackHint.textContent = `Validando ${formatProtonServerName(server)} e aplicando a rota…`;
  setProtonFeedback('Validando a rota escolhida e preparando o WireGuard…', 'busy');
  try {
    const result = await window.api.selectProtonRoute({ measurementId: protonManualMeasurementId, server });
    if (!result.success) {
      if (protonManualFallbackHint) protonManualFallbackHint.textContent = result.error || 'A rota foi reprovada. Escolha outra rota medida.';
      setProtonFeedback(result.error || 'Não foi possível aplicar a rota escolhida.', 'err');
      return;
    }
    const selectedServerName = formatProtonServerName(result.server || server);
    protonManualMeasurementId = '';
    protonManualCandidates = new Map();
    setManualFallbackVisible(false);
    await refreshProtonState();
    await atualizarStatusWgConf();
    await updateStatus();
    closeProtonMeasurementDialog();
    setProtonFeedback(
      currentState === 'ACTIVE'
        ? `Rota ${selectedServerName} aplicada!`
        : `Rota ${selectedServerName} selecionada! Ative o Bypass para usá-la.`,
      'ok',
    );
  } catch (error) {
    if (protonManualFallbackHint) protonManualFallbackHint.textContent = 'Não foi possível aplicar a rota. Escolha outra rota medida ou tente novamente.';
    setProtonFeedback((error as Error)?.message || String(error), 'err');
  } finally {
    setManualSelectionBusy(false);
    await updateStatus();
  }
}

function updateMeasurementProgress(event: ProtonOptimizationProgress) {
  if (!protonMeasurement || event.requestId !== protonOptimizationRequestId) return;
  if (event.phase === 'ping' || event.phase === 'preparing' || event.phase === 'testing') {
    protonManualCandidates = reduceManualRouteEvent(protonManualCandidates, event);
  }
  if (event.phase === 'failed' || event.phase === 'cancelled') {
    protonMeasurementList?.querySelectorAll('.proton-measurement__skeleton').forEach((node) => node.remove());
    protonMeasurementList?.querySelectorAll('.proton-measurement__metrics--pending').forEach((node) => {
      node.classList.remove('proton-measurement__metrics--pending');
      if (event.phase === 'cancelled') node.textContent = 'Medição interrompida';
    });
    if (protonCancelMeasurementBtn) protonCancelMeasurementBtn.hidden = true;
    if (protonCloseMeasurementBtn) protonCloseMeasurementBtn.hidden = false;
  }
  const total = Math.max(0, event.total || 0);
  const tested = Math.min(total, Math.max(0, event.tested || 0));
  if (total > 0) {
    protonMeasurementTotal = total;
    protonMeasurementTested = tested;
  }
  const progress = protonMeasurement.querySelector('.proton-progress') as HTMLElement | null;
  if (progress) {
    if (total > 0) {
      progress.setAttribute('aria-valuemax', String(total));
      progress.setAttribute('aria-valuenow', String(tested));
    } else {
      progress.removeAttribute('aria-valuemax');
      progress.removeAttribute('aria-valuenow');
    }
  }
  if (protonMeasurementProgress) protonMeasurementProgress.style.width = total ? `${(tested / total) * 100}%` : '0%';
  if (protonMeasurementCount) protonMeasurementCount.textContent = total
    ? `${tested} de ${total} ${event.phase === 'ping' ? 'rotas pingadas' : event.phase === 'preparing' ? 'túneis verificados' : 'servidores testados'} · faltam ${Math.max(0, total - tested)}`
    : event.phase === 'ping' ? 'Preparando a triagem de ping…' : 'Preparando servidores…';
  if (protonMeasurementTitle && event.phase === 'ping' && total > 0) {
    protonMeasurementTitle.textContent = 'Medindo o ping das rotas elegíveis';
  } else if (protonMeasurementTitle && event.phase === 'ping') {
    protonMeasurementTitle.textContent = 'Preparando a triagem de ping';
  } else if (protonMeasurementTitle && event.phase === 'preparing' && total > 0) {
    protonMeasurementTitle.textContent = 'Validando as rotas com menor ping';
  } else if (protonMeasurementTitle && event.phase === 'testing') {
    protonMeasurementTitle.textContent = 'Medindo a velocidade das rotas aprovadas';
  }
  if (event.server) {
    protonMeasurementList?.querySelectorAll('.proton-measurement__skeleton').forEach((node) => node.remove());
    let row = protonMeasurementRows.get(event.server);
    if (!row) {
      row = document.createElement('div');
      row.className = 'proton-measurement__server';
      row.innerHTML = '<span class="proton-measurement__server-main"><span class="proton-country-flag proton-measurement__server-flag" aria-hidden="true"></span><span class="proton-measurement__server-name"></span></span><span class="proton-measurement__status">Testando…</span><span class="proton-measurement__metrics proton-measurement__metrics--pending"><i aria-hidden="true"></i></span>';
      protonMeasurementRows.set(event.server, row);
      renderMeasurementList();
    }
    const name = row.querySelector('.proton-measurement__server-name');
    const flag = row.querySelector('.proton-measurement__server-flag') as HTMLElement | null;
    const status = row.querySelector('.proton-measurement__status');
    const metrics = row.querySelector('.proton-measurement__metrics');
    if (name) name.textContent = formatProtonServerName(event.server);
    updateProtonCountryFlag(flag, event.server);
    const isPing = event.phase === 'ping';
    const isPreflight = event.phase === 'preparing';
    const statusApplies = event.phase === 'testing' || isPreflight || isPing;
    if (event.status !== undefined && statusApplies) {
      if (isPing) {
        if (status) status.textContent = event.status === 'success' ? 'Ping medido' : 'Sem resposta';
        if (metrics) metrics.textContent = event.status === 'success' && event.pingMs
          ? `${event.pingMs} ms · candidata à triagem`
          : 'Sem resposta ao ping';
      } else if (isPreflight) {
        if (status) status.textContent = event.status === 'success' ? 'Túnel respondeu' : 'Descartada no teste rápido';
        if (metrics) metrics.textContent = event.status === 'success' ? 'Pronta para medir velocidade' : 'Falha no túnel ou HTTPS';
      } else {
        if (status) status.textContent = event.status === 'success' ? 'Medido' : event.status === 'failed' ? 'Não foi possível medir' : 'Testando…';
        if (metrics) metrics.innerHTML = event.status === 'success'
          ? `↓ ${formatMbps(event.downloadMbps)} · ↑ ${formatMbps(event.uploadMbps)} · ${event.pingMs ?? '—'} ms`
          : event.status === 'failed' ? 'Tente novamente para medir esta rota' : '<i aria-hidden="true"></i>';
      }
      metrics?.classList.toggle('proton-measurement__metrics--pending', event.status === 'testing');
      row.classList.toggle('is-success', event.status === 'success' && !isPreflight && !isPing);
      row.classList.toggle('is-failed', event.status === 'failed');
    }
  }
}

function setMeasurementVisible(visible: boolean) {
  if (protonMeasurement) protonMeasurement.hidden = !visible;
  if (visible) fitWindowToContent();
}

function openProtonMeasurementDialog() {
  if (!protonMeasurementDialog) {
    setMeasurementVisible(true);
    return;
  }

  if (!protonMeasurementDialog.open) {
    protonMeasurementDialogLastFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : protonOptimizeBtn;
    if (typeof protonMeasurementDialog.showModal === 'function') {
      protonMeasurementDialog.showModal();
    } else {
      protonMeasurementDialog.setAttribute('open', '');
    }
  }

  setMeasurementVisible(true);
  protonCancelMeasurementBtn?.focus();
  requestAnimationFrame(() => protonCancelMeasurementBtn?.focus());
}

function closeProtonMeasurementDialog(restoreFocus = true) {
  setMeasurementVisible(false);
  if (protonMeasurementDialog) {
    if (protonMeasurementDialog.open && typeof protonMeasurementDialog.close === 'function') {
      protonMeasurementDialog.close();
    } else {
      protonMeasurementDialog.removeAttribute('open');
    }
  }
  const focusTarget = protonMeasurementDialogLastFocus ?? protonOptimizeBtn;
  protonMeasurementDialogLastFocus = null;
  if (restoreFocus) {
    focusTarget?.focus();
    requestAnimationFrame(() => focusTarget?.focus());
  }
  fitWindowToContent();
}

protonMeasurementList?.addEventListener('click', (event) => {
  const target = (event.target as Element | null)?.closest<HTMLButtonElement>('[data-manual-server]');
  if (!target || target.disabled || !protonManualFallback || protonManualFallback.hidden) return;
  void selectManualProtonRoute(target.dataset.manualServer || '');
});
protonManualRecommendationBtn?.addEventListener('click', () => {
  void selectManualProtonRoute(protonManualRecommendationBtn.dataset.manualServer || '');
});

const removeProtonProgressListener = window.api.onProtonOptimizationProgress?.(updateMeasurementProgress);

protonPasswordToggle?.addEventListener('click', () => {
  if (!protonPassword) return;

  const visible = protonPassword.type === 'password';
  protonPassword.type = visible ? 'text' : 'password';
  protonPasswordToggle.setAttribute('aria-pressed', String(visible));
  protonPasswordToggle.setAttribute('aria-label', visible ? 'Ocultar senha' : 'Mostrar senha');
  protonPasswordToggle.title = visible ? 'Ocultar senha' : 'Mostrar senha';
  if (protonPasswordShowIcon) {
    protonPasswordShowIcon.toggleAttribute('hidden', visible);
  }
  if (protonPasswordHideIcon) {
    protonPasswordHideIcon.toggleAttribute('hidden', !visible);
  }
  protonPassword.focus();
});

function setProtonFeedback(msg: string, type?: 'ok' | 'err' | 'busy') {
  if (!protonFeedback) return;
  if (!msg) {
    protonFeedback.hidden = true;
    protonFeedback.textContent = '';
    protonFeedback.className = 'proton-feedback';
    fitWindowToContent();
    return;
  }
  protonFeedback.hidden = false;
  protonFeedback.className = 'proton-feedback' + (type ? ` proton-feedback--${type}` : '');
  protonFeedback.textContent = msg;
  fitWindowToContent();
}

let proton2FALastFocus: HTMLElement | null = null;

function closeProton2FADialog(restoreFocus = true) {
  if (!proton2FADialog) return;
  proton2FADialog.hidden = true;
  if (restoreFocus) (proton2FALastFocus ?? protonLoginBtn)?.focus();
  proton2FALastFocus = null;
  fitWindowToContent();
}

function openProton2FADialog() {
  if (!proton2FADialog) return;
  proton2FALastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : protonLoginBtn;
  proton2FADialog.hidden = false;
  requestAnimationFrame(() => proton2FA?.focus());
  fitWindowToContent();
}

proton2FABackdrop?.addEventListener('click', () => closeProton2FADialog());
proton2FACloseBtn?.addEventListener('click', () => closeProton2FADialog());
proton2FACancelBtn?.addEventListener('click', () => closeProton2FADialog());
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && proton2FADialog && !proton2FADialog.hidden) {
    event.preventDefault();
    closeProton2FADialog();
  }
});

function protonNeeds2FA(error?: string): boolean {
  return !!error && /2FA_REQUIRED|2FA|two.?factor/i.test(error);
}

function protonLoginMessage(res: { code?: string; message?: string; error?: string }): string {
  if (res.message) return res.message;
  switch (res.code) {
    case 'INVALID_CREDENTIALS': return 'Usuário ou senha incorretos. Confira os dados e tente novamente.';
    case 'TWO_FACTOR_REQUIRED': return 'Esta conta exige autenticação em duas etapas. Digite o código do aplicativo autenticador.';
    case 'TWO_FACTOR_INVALID': return 'O código 2FA está incorreto ou expirou. Gere um novo código e tente novamente.';
    case 'CAPTCHA_REQUIRED': return 'O Proton solicitou uma verificação de segurança, mas não forneceu um desafio válido.';
    case 'CAPTCHA_INVALID': return 'A verificação de segurança expirou ou foi recusada. Tente fazer login novamente.';
    case 'CAPTCHA_CANCELLED': return 'Verificação cancelada. Tente fazer login novamente quando estiver pronto.';
    case 'NETWORK_ERROR': return 'Não foi possível conectar aos servidores ProtonVPN. Verifique sua internet e tente novamente.';
    case 'TIMEOUT': return 'O ProtonVPN demorou demais para responder. Tente novamente em alguns instantes.';
    case 'MISSING_EXECUTABLE': return 'O componente de conexão ProtonVPN não foi encontrado. Reinstale o GoLiveBypass ou atualize para a versão mais recente.';
    case 'SESSION_PERSISTENCE': return 'Login concluído, mas a sessão não pôde ser salva neste computador. Verifique as permissões da pasta de dados.';
    default: return 'Não foi possível concluir o login ProtonVPN. Tente novamente ou envie um relatório de diagnóstico.';
  }
}

type ProtonPlanView = {
  success: boolean;
  status: 'free' | 'premium' | 'unknown';
  planTitle?: string;
};

function setProtonPlanLoading() {
  if (protonPlanStatus) {
    protonPlanStatus.className = 'proton-plan-status proton-plan-status--loading';
    protonPlanStatus.textContent = 'Plano: verificando…';
  }
  if (protonPlanRefreshBtn) {
    protonPlanRefreshBtn.disabled = true;
    protonPlanRefreshBtn.textContent = 'Verificando…';
  }
}

function renderProtonPlan(plan: ProtonPlanView) {
  if (!protonPlanStatus || !protonPlanRefreshBtn) return;
  const status = plan.success && (plan.status === 'free' || plan.status === 'premium')
    ? plan.status
    : 'unknown';
  protonPlanStatus.className = `proton-plan-status proton-plan-status--${status}`;
  if (status === 'free') {
    protonPlanStatus.textContent = 'Plano: Proton VPN Free';
  } else if (status === 'premium') {
    const title = typeof plan.planTitle === 'string' && plan.planTitle.trim() ? plan.planTitle.trim() : 'Premium';
    protonPlanStatus.textContent = `Plano: ${title}`;
  } else {
    protonPlanStatus.textContent = 'Plano: não confirmado';
  }
  protonPlanRefreshBtn.disabled = false;
  protonPlanRefreshBtn.textContent = status === 'unknown' ? 'Tentar novamente' : 'Atualizar plano';
  protonPlanRefreshBtn.setAttribute(
    'aria-label',
    status === 'unknown' ? 'Tentar confirmar o plano Proton' : 'Atualizar o plano Proton',
  );
}

async function switchVpnMode(mode: 'proton' | 'custom') {
  if (protonOptimizationInFlight || protonManualSelectionInFlight) return;
  currentVpnMode = mode;
  try {
    await window.api.setVpnMode(mode);
  } catch {}

  if (tabProton && tabCustom && panelProton && panelCustom) {
    const isProton = mode === 'proton';
    tabProton.classList.toggle('vpn-mode-tab--active', isProton);
    tabProton.setAttribute('aria-selected', String(isProton));
    tabCustom.classList.toggle('vpn-mode-tab--active', !isProton);
    tabCustom.setAttribute('aria-selected', String(!isProton));

    panelProton.hidden = !isProton;
    panelCustom.hidden = isProton;
  }

  if (mode === 'proton') await refreshProtonState();
  await atualizarStatusWgConf();
  await updateStatus();
  fitWindowToContent();
}

tabProton?.addEventListener('click', () => switchVpnMode('proton'));
tabCustom?.addEventListener('click', () => switchVpnMode('custom'));

async function refreshProtonState(forcePlan = false) {
  const generation = ++protonStateGeneration;
  try {
    const s = await window.api.getProtonSettings();
    if (generation !== protonStateGeneration) return;
    if (autoFailoverToggle) autoFailoverToggle.checked = s.autoFailover !== false;
    if (protonCountrySelect) {
      protonCountrySelect.value = s.country || '';
    }

    if (s.username) {
      if (protonUsername) protonUsername.value = s.username;
      const chk = await window.api.checkProtonSession(s.username);
      if (generation !== protonStateGeneration) return;
      if (chk.valid) {
        isProtonAuthenticated = true;
        if (protonAuthForm) protonAuthForm.hidden = true;
        if (protonConnectedView) protonConnectedView.hidden = false;
        if (protonUserDisplay) protonUserDisplay.textContent = `Conta: ${s.username}`;
        if (protonDot) protonDot.style.background = '#22c55e';
        setProtonPlanLoading();
        try {
          const plan = await window.api.getProtonPlan({ force: forcePlan });
          if (generation !== protonStateGeneration) return;
          renderProtonPlan(plan);
        } catch {
          if (generation !== protonStateGeneration) return;
          renderProtonPlan({ success: false, status: 'unknown' });
        }

        if (s.lastServer?.server && protonServerBadge && protonServerName && protonServerPing && protonServerLoad) {
          updateProtonCountryFlag(protonServerFlag, s.lastServer.server);
          protonServerName.textContent = formatProtonServerName(s.lastServer.server);
          const ping = s.lastServer.pingMs;
          if (ping > 0) {
            protonServerPing.textContent = `${ping} ms`;
            protonServerPing.classList.toggle('proton-ping-pill--high', ping > 180);
          } else {
            protonServerPing.textContent = 'Ping: rápido';
          }
          protonServerLoad.textContent = `${s.lastServer.load ?? 0}% carga`;
          const speedBadge = protonServerBadge.querySelector('.proton-speed-pill') as HTMLElement | null;
          if (speedBadge) {
            speedBadge.textContent = Number.isFinite(s.lastServer.downloadMbps) && s.lastServer.downloadMbps > 0
              ? `↓ ${s.lastServer.downloadMbps.toFixed(1)} Mbps` : 'Velocidade não medida';
            speedBadge.hidden = false;
          }
          protonServerBadge.hidden = false;
        } else if (protonServerBadge) {
          updateProtonCountryFlag(protonServerFlag);
          protonServerBadge.hidden = true;
        }
        return;
      }
    }

    isProtonAuthenticated = false;
    renderProtonPlan({ success: false, status: 'unknown' });
    if (protonAuthForm) protonAuthForm.hidden = false;
    if (protonConnectedView) protonConnectedView.hidden = true;
  } catch (err) {
    if (generation !== protonStateGeneration) return;
    console.error('Falha ao verificar sessão Proton:', err);
    isProtonAuthenticated = false;
    renderProtonPlan({ success: false, status: 'unknown' });
    if (protonAuthForm) protonAuthForm.hidden = false;
    if (protonConnectedView) protonConnectedView.hidden = true;
  }
}

protonPlanRefreshBtn?.addEventListener('click', async () => {
  if (protonOptimizationInFlight || protonManualSelectionInFlight || !isProtonAuthenticated) return;
  setProtonPlanLoading();
  await refreshProtonState(true);
});

async function submitProtonLogin() {
    if (protonLoginInFlight) return;
    const user = protonUsername?.value.trim() || '';
    const pass = protonPassword?.value || '';
    const twoFa = proton2FA?.value.trim() || undefined;

    if (!user) {
      setProtonFeedback('Informe o usuário Proton.', 'err');
      return;
    }
    if (!pass) {
      setProtonFeedback('Informe sua senha Proton.', 'err');
      return;
    }

    protonLoginInFlight = true;
    if (protonLoginBtn) protonLoginBtn.disabled = true;
    if (protonLoginSpinner) protonLoginSpinner.hidden = false;
    if (protonLoginBtnText) protonLoginBtnText.textContent = 'Conectando...';
    setProtonFeedback('Autenticando com ProtonVPN...', 'busy');

    try {
      const res = await window.api.loginProton({
        username: user,
        password: pass,
        twoFactorCode: twoFa,
      });

      if (res.success) {
        setProtonFeedback('Conectado com sucesso! Servidor rápido selecionado.', 'ok');
        if (protonPassword) protonPassword.value = '';
        if (proton2FA) proton2FA.value = '';
        closeProton2FADialog(false);
        await refreshProtonState();
        await atualizarStatusWgConf();
        await updateStatus();
        void optimizeProtonRoute(true);
      } else {
        if (res.code === 'TWO_FACTOR_REQUIRED' || res.code === 'TWO_FACTOR_INVALID' || protonNeeds2FA(res.error)) {
          setProtonFeedback(
            twoFa ? 'Código 2FA inválido ou expirado. Tente novamente.' : 'Esta conta exige um código 2FA.',
            'err'
          );
          openProton2FADialog();
        } else {
          setProtonFeedback(protonLoginMessage(res), 'err');
        }
      }
    } catch (err) {
      setProtonFeedback((err as Error)?.message || String(err), 'err');
    } finally {
      protonLoginInFlight = false;
      if (protonLoginBtn) protonLoginBtn.disabled = false;
      if (protonLoginSpinner) protonLoginSpinner.hidden = true;
      if (protonLoginBtnText) protonLoginBtnText.textContent = 'Conectar conta Proton';
    }
}

protonLoginBtn?.addEventListener('click', () => void submitProtonLogin());
window.api.onProtonCaptchaStatus((status) => {
  if (!protonLoginInFlight) return;
  if (status === 'opening') setProtonFeedback('Resolva a verificação oficial da Proton na janela que abriu.', 'busy');
  else if (status === 'retrying') setProtonFeedback('O desafio expirou. Resolva o novo CAPTCHA para continuar.', 'busy');
  else if (status === 'verifying') setProtonFeedback('CAPTCHA concluído. Confirmando o login com a Proton...', 'busy');
});
proton2FAConfirmBtn?.addEventListener('click', () => {
  const code = proton2FA?.value.trim() || '';
  if (!code) {
    setProtonFeedback('Digite o código 2FA para continuar.', 'err');
    proton2FA?.focus();
    return;
  }
  closeProton2FADialog(false);
  void submitProtonLogin();
});

if (protonLogoutBtn) {
  protonLogoutBtn.addEventListener('click', async () => {
    if (protonOptimizationInFlight || protonManualSelectionInFlight) return;
    protonStateGeneration += 1;
    await window.api.logoutProton();
    setProtonFeedback('');
    await refreshProtonState();
    await atualizarStatusWgConf();
    await updateStatus();
  });
}

if (protonCountrySelect) {
  protonCountrySelect.addEventListener('change', async () => {
    if (protonOptimizationInFlight || protonManualSelectionInFlight) return;
    const country = protonCountrySelect.value;
    await window.api.setProtonSettings({ country });
    protonOptimizeBtn?.click();
  });
}

async function optimizeProtonRoute(onStartup = false, speedTest = true) {
  if (protonOptimizationInFlight || protonManualSelectionInFlight || !isProtonAuthenticated) return;

  protonOptimizationInFlight = true;
  protonManualMeasurementId = '';
  protonManualCandidates = new Map();
  setManualFallbackVisible(false);
  protonMeasurementTotal = 0;
  protonMeasurementTested = 0;
  protonOptimizationRequestId = typeof crypto?.randomUUID === 'function' ? crypto.randomUUID() : `proton-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  protonMeasurementRows.clear();
  if (protonMeasurementTitle) protonMeasurementTitle.textContent = 'Encontrando uma rota para sua transmissão';
  if (protonMeasurementCount) protonMeasurementCount.textContent = 'Preparando servidores…';
  if (protonMeasurementList) {
    protonMeasurementList.innerHTML = '<div class="proton-measurement__skeleton"></div><div class="proton-measurement__skeleton"></div><div class="proton-measurement__skeleton"></div>';
  }
  if (protonMeasurementActions) protonMeasurementActions.hidden = true;
  if (protonCancelMeasurementBtn) protonCancelMeasurementBtn.hidden = false;
  if (protonCancelMeasurementBtn) protonCancelMeasurementBtn.disabled = false;
  if (protonCancelMeasurementBtn) protonCancelMeasurementBtn.textContent = 'Cancelar teste';
  if (protonCloseMeasurementBtn) protonCloseMeasurementBtn.hidden = true;
  // A otimização automática usa o mesmo diálogo da ação manual para que o
  // usuário veja a triagem de ping, o preflight e o teste de velocidade desde
  // o primeiro momento da abertura do programa.
  openProtonMeasurementDialog();
  if (tabProton) tabProton.disabled = true;
  if (tabCustom) tabCustom.disabled = true;
  if (protonCountrySelect) protonCountrySelect.disabled = true;
  if (protonLogoutBtn) protonLogoutBtn.disabled = true;
  toggleBtn.disabled = true;
  if (protonOptimizeBtn) protonOptimizeBtn.disabled = true;
  if (protonOptimizeBtnText) protonOptimizeBtnText.textContent = onStartup ? 'Otimizando...' : 'Medindo velocidade...';
  setProtonFeedback(
    onStartup ? 'Atualizando automaticamente a rota Proton...' : 'Medindo download e upload nos melhores candidatos. Pode levar até 2 minutos e usar cerca de 30 MB.',
    'busy',
  );

  try {
    const country = protonCountrySelect?.value || '';
    const res = await window.api.optimizeProtonRoute({ country, autoPing: true, speedTest, refreshOnStartup: onStartup, requestId: protonOptimizationRequestId });

    if (res.deferred) {
      closeProtonMeasurementDialog(!onStartup);
      setProtonFeedback(
        res.startup
          ? 'A rota está sendo otimizada automaticamente e será ativada antes do Discord.'
          : 'A medição será feita quando o bypass estiver desativado.',
        'busy',
      );
    } else if (res.success) {
      protonManualMeasurementId = '';
      protonManualCandidates = new Map();
      setManualFallbackVisible(false);
      const pingStr = protonMeasurementText(res);
      await refreshProtonState();
      await atualizarStatusWgConf();
      await updateStatus();
      closeProtonMeasurementDialog(!onStartup);
      // Otimizar so grava/prepara a configuracao WireGuard. Sem o bypass ativo, dizer
      // "conectado" sugere que o Discord ja esta passando pelo novo servidor.
      const rotaEmUso = currentState === 'ACTIVE';
      const testedSummary = protonMeasurementTotal > 0 && protonMeasurementTested < protonMeasurementTotal
        ? ` ${protonMeasurementTested} de ${protonMeasurementTotal} candidatos testados.` : '';
      const selectedServerName = formatProtonServerName(res.server);
      setProtonFeedback(
        rotaEmUso
          ? `Rota ${selectedServerName} aplicada!${pingStr}${testedSummary}`
          : `Rota ${selectedServerName} selecionada!${pingStr}${testedSummary} Ative o Bypass para usá-la.`,
        'ok',
      );
    } else {
      if (protonMeasurementTitle) protonMeasurementTitle.textContent = res.cancelled ? 'Medição cancelada' : 'Não foi possível concluir a medição';
      if (protonMeasurementCount) protonMeasurementCount.textContent = res.cancelled ? 'O teste foi interrompido.' : 'As rotas não puderam ser medidas.';
      if (protonMeasurementActions) protonMeasurementActions.hidden = false;
      if (protonCancelMeasurementBtn) protonCancelMeasurementBtn.hidden = true;
      if (protonCloseMeasurementBtn) protonCloseMeasurementBtn.hidden = false;
      if (res.cancelled) {
        protonManualMeasurementId = '';
        protonManualCandidates = new Map();
        setManualFallbackVisible(false);
      } else {
        protonManualMeasurementId = protonOptimizationRequestId;
        renderManualRouteChoices();
      }
      setProtonFeedback(res.error || 'Falha ao buscar servidor.', 'err');
      await updateStatus();
    }
  } catch (err) {
    protonMeasurementList?.querySelectorAll('.proton-measurement__skeleton').forEach((node) => node.remove());
    if (protonMeasurementTitle) protonMeasurementTitle.textContent = 'Não foi possível concluir a medição';
    if (protonMeasurementActions) protonMeasurementActions.hidden = false;
    if (protonCancelMeasurementBtn) protonCancelMeasurementBtn.hidden = true;
    if (protonCloseMeasurementBtn) protonCloseMeasurementBtn.hidden = false;
    protonManualMeasurementId = protonOptimizationRequestId;
    renderManualRouteChoices();
    if (protonMeasurementCount && !protonMeasurementCount.textContent?.includes('de')) protonMeasurementCount.textContent = 'Nenhum servidor foi testado.';
    setProtonFeedback((err as Error)?.message || String(err), 'err');
    await updateStatus();
  } finally {
    protonOptimizationInFlight = false;
    protonOptimizationRequestId = '';
    if (tabProton) tabProton.disabled = false;
    if (tabCustom) tabCustom.disabled = false;
    if (protonCountrySelect) protonCountrySelect.disabled = false;
    if (protonLogoutBtn) protonLogoutBtn.disabled = false;
    if (protonOptimizeBtn) protonOptimizeBtn.disabled = false;
    if (protonOptimizeBtnText) protonOptimizeBtnText.textContent = 'Otimizar rota';
    await updateStatus();
  }
}

protonOptimizeBtn?.addEventListener('click', () => void optimizeProtonRoute());
protonCancelMeasurementBtn?.addEventListener('click', async () => {
  if (!protonOptimizationRequestId) return;
  protonCancelMeasurementBtn.disabled = true;
  protonCancelMeasurementBtn.textContent = 'Cancelando…';
  try { await window.api.cancelProtonOptimization(protonOptimizationRequestId); } catch {}
});
protonRetryMeasurementBtn?.addEventListener('click', () => void optimizeProtonRoute(false, true));
protonContinueMeasurementBtn?.addEventListener('click', async () => {
  await optimizeProtonRoute(false, false);
});
protonCloseMeasurementBtn?.addEventListener('click', () => {
  if (!protonManualSelectionInFlight) closeProtonMeasurementDialog();
});
protonMeasurementDialog?.addEventListener('cancel', (event) => {
  event.preventDefault();
  if (!protonOptimizationInFlight && !protonManualSelectionInFlight) closeProtonMeasurementDialog();
});

window.addEventListener('beforeunload', () => {
  if (typeof removeProtonProgressListener === 'function') removeProtonProgressListener();
});

async function atualizarStatusWgConf() {
  if (currentVpnMode === 'proton') {
    hasSelectedConf = isProtonAuthenticated;
  } else {
    try {
      const nome = await window.api.getWgConfName();
      if (nome && nome.trim() && !nome.startsWith('ProtonVPN')) {
        hasSelectedConf = true;
        if (vpnConfigStatus) vpnConfigStatus.textContent = `Arquivo: ${nome}`;
      } else {
        hasSelectedConf = false;
        if (vpnConfigStatus) vpnConfigStatus.textContent = 'Nenhum arquivo (.conf) importado';
      }
    } catch {
      hasSelectedConf = false;
      if (vpnConfigStatus) vpnConfigStatus.textContent = 'Nenhum arquivo (.conf) importado';
    }
  }
}

async function initVpnSection() {
  try {
    const mode = await window.api.getVpnMode();
    currentVpnMode = mode || 'proton';
    if (tabProton && tabCustom && panelProton && panelCustom) {
      const isProton = currentVpnMode === 'proton';
      tabProton.classList.toggle('vpn-mode-tab--active', isProton);
      tabCustom.classList.toggle('vpn-mode-tab--active', !isProton);
      panelProton.hidden = !isProton;
      panelCustom.hidden = isProton;
    }
    await refreshProtonState();
    await atualizarStatusWgConf();
    if (currentVpnMode === 'proton' && isProtonAuthenticated) {
      void optimizeProtonRoute(true);
    }
  } catch (err) {
    console.error('Erro ao inicializar seção VPN:', err);
  }
}

if (vpnImportBtn) {
  vpnImportBtn.addEventListener('click', async () => {
    try {
      const res = await window.api.importWgConf();
      if (res && res.success) {
        await atualizarStatusWgConf();
        await updateStatus();
        setVpnDropFeedback(`Arquivo ${res.fileName ?? 'WireGuard'} importado.`, 'ok');
      } else if (res?.error) {
        setVpnDropFeedback(res.error, 'bad');
      }
    } catch (err) {
      console.error('Falha ao importar config WireGuard:', err);
    }
  });
}

function setVpnDropActive(active: boolean) {
  vpnDropZone?.classList.toggle('vpn-drop-zone--active', active);
}

function setVpnDropFeedback(message: string, type: 'ok' | 'bad') {
  if (!vpnDropFeedback) return;
  vpnDropFeedback.hidden = false;
  vpnDropFeedback.className = `vpn-drop-feedback vpn-drop-feedback--${type}`;
  vpnDropFeedback.textContent = message;
  fitWindowToContent();
}

async function importDroppedWgFile(file: File) {
  const filePath = (file as File & { path?: string }).path;
  if (!filePath) {
    setVpnDropFeedback('Não foi possível ler este arquivo. Use o botão Importar.', 'bad');
    return;
  }
  if (!file.name.toLowerCase().endsWith('.conf')) {
    setVpnDropFeedback('Solte um arquivo WireGuard com extensão .conf.', 'bad');
    return;
  }

  setVpnDropFeedback('Validando configuração WireGuard...', 'ok');
  try {
    const res = await window.api.importWgConfFile(filePath);
    if (res?.success) {
      setVpnDropFeedback(`Arquivo ${res.fileName ?? 'WireGuard'} importado.`, 'ok');
      await atualizarStatusWgConf();
      await updateStatus();
    } else {
      setVpnDropFeedback(res?.error ?? 'Não foi possível importar este arquivo.', 'bad');
    }
  } catch (err) {
    setVpnDropFeedback(err instanceof Error ? err.message : String(err), 'bad');
  }
}

if (vpnDropZone) {
  let dragDepth = 0;
  vpnDropZone.addEventListener('click', () => vpnImportBtn?.click());
  vpnDropZone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      vpnImportBtn?.click();
    }
  });
  vpnDropZone.addEventListener('dragenter', (event) => {
    event.preventDefault();
    dragDepth += 1;
    setVpnDropActive(true);
  });
  vpnDropZone.addEventListener('dragover', (event) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    setVpnDropActive(true);
  });
  vpnDropZone.addEventListener('dragleave', (event) => {
    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) setVpnDropActive(false);
  });
  vpnDropZone.addEventListener('drop', async (event) => {
    event.preventDefault();
    dragDepth = 0;
    setVpnDropActive(false);
    const file = event.dataTransfer?.files[0];
    if (file) await importDroppedWgFile(file);
  });

  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('drop', (event) => event.preventDefault());
}

const vpnTestBtn = document.getElementById('vpnTestBtn') as HTMLButtonElement | null;
const vpnTestFeedback = document.getElementById('vpnTestFeedback') as HTMLElement | null;

if (vpnTestBtn && vpnTestFeedback) {
  vpnTestBtn.addEventListener('click', async () => {
    vpnTestBtn.disabled = true;
    vpnTestFeedback.classList.remove('vpn-test-feedback--ok', 'vpn-test-feedback--bad');
    vpnTestFeedback.classList.add('vpn-test-feedback--busy');
    vpnTestFeedback.hidden = false;
    vpnTestFeedback.textContent = 'Testando configuração...';
    fitWindowToContent();

    try {
      const r = await window.api.testWgConf();
      vpnTestFeedback.classList.remove('vpn-test-feedback--busy');
      if (r.ok) {
        vpnTestFeedback.classList.add('vpn-test-feedback--ok');
        const partes = [`Endpoint ${r.endpoint ?? '?'}`];
        if (r.resolvedIp) partes.push(`resolve para ${r.resolvedIp}`);
        if (r.active && r.exitInfo?.ip) {
          const geo = r.exitInfo.country ? ` [${r.exitInfo.country}]` : '';
          partes.push(`saída ativa ${r.exitInfo.ip}${geo}`);
        } else if (!r.active) {
          partes.push('bypass inativo — não foi possível confirmar a saída real');
        }
        vpnTestFeedback.textContent = `OK — ${partes.join(' · ')}`;
      } else {
        vpnTestFeedback.classList.add('vpn-test-feedback--bad');
        vpnTestFeedback.textContent = r.error ?? 'Falha no teste';
      }
    } catch (err) {
      vpnTestFeedback.classList.remove('vpn-test-feedback--busy');
      vpnTestFeedback.classList.add('vpn-test-feedback--bad');
      vpnTestFeedback.textContent = err instanceof Error ? err.message : String(err);
    } finally {
      vpnTestBtn.disabled = false;
      fitWindowToContent();
    }
  });
}

const vpsGuide = document.querySelector('.vps-guide');
if (vpsGuide) {
  vpsGuide.addEventListener('toggle', () => fitWindowToContent());
}

startupToggle.addEventListener('change', async () => {
  const wanted = startupToggle.checked;
  const result = await window.api.setStartup(wanted);
  if (!result.success) {
    startupToggle.checked = !wanted;
    alert(result.error ?? 'Não foi possível alterar a inicialização automática.');
  }
});

autoUpdateToggle?.addEventListener('change', async () => {
  if (autoUpdateToggle) {
    await window.api.setAutoUpdate(autoUpdateToggle.checked);
  }
});

autoFailoverToggle?.addEventListener('change', async () => {
  if (!autoFailoverToggle) return;
  try {
    await window.api.setProtonSettings({ autoFailover: autoFailoverToggle.checked });
  } catch {
    autoFailoverToggle.checked = !autoFailoverToggle.checked;
  }
});

// Canal de atualizacao: opt-in dos testadores para receber prereleases (beta).
updateChannelToggle?.addEventListener('change', async () => {
  if (updateChannelToggle) {
    await window.api.setUpdateChannel(updateChannelToggle.checked ? 'beta' : 'stable');
  }
});

window.api.onRefreshAutoUpdate?.(refreshAutoUpdate);
window.api.onProtonFailoverNotice?.((notice) => {
  if (notice?.message) setProtonFeedback(notice.message, 'err');
});

// ---------------------------------------------------------------------------
// Modo desenvolvedor: so o toggle aqui. Logs e report ficam numa janela aparte.
// So existe no modo npm run dev: em producao o toggle some e a janela de logs
// nem abre (o main recusa o pedido quando empacotado).
// ---------------------------------------------------------------------------
const IS_DEV = import.meta.env.DEV;
const DEV_KEY = 'golivebypass-dev-mode';
const devModeToggle = document.getElementById('devModeToggle') as HTMLInputElement;
const devModeHint = document.getElementById('devModeHint') as HTMLElement;

if (!IS_DEV) {
  // Producao nao tem modo dev: a linha inteira (switch + texto) some.
  const devModeRow = document.getElementById('devModeRow');
  if (devModeRow) devModeRow.hidden = true;
  devModeToggle.hidden = true;
  devModeHint.hidden = true;
}

async function setDevMode(on: boolean) {
  try {
    localStorage.setItem(DEV_KEY, on ? '1' : '0');
  } catch {
    /* ignore */
  }
  try {
    await window.api.setDevLogWindow(on);
  } catch (err) {
    console.error(err);
  }
  devModeHint.hidden = !on;
  fitWindowToContent();
}

devModeToggle.addEventListener('change', () => {
  void setDevMode(devModeToggle.checked);
});

window.api.onDevLogWindowClosed?.(() => {
  devModeToggle.checked = false;
  devModeHint.hidden = true;
  try {
    localStorage.setItem(DEV_KEY, '0');
  } catch {
    /* ignore */
  }
  fitWindowToContent();
});

try {
  if (IS_DEV && localStorage.getItem(DEV_KEY) === '1') {
    devModeToggle.checked = true;
    void setDevMode(true);
  }
} catch {
  /* ignore */
}

// A bandeja tambem tem esses controles; sem os avisos, os dois ficariam dessincronizados.
window.api.onRefreshStartup(refreshStartup);
window.api.onRefreshStatus(updateStatus);

// ---------------------------------------------------------------------------
// Report de bug — dialog + IPC
// ---------------------------------------------------------------------------
const bugBtn = document.getElementById('bugBtn') as HTMLButtonElement | null;
const bugDialog = document.getElementById('bugDialog') as HTMLElement | null;
const bugBackdrop = document.getElementById('bugBackdrop') as HTMLElement | null;
const bugTitle = document.getElementById('bugTitle') as HTMLInputElement | null;
const bugDesc = document.getElementById('bugDesc') as HTMLTextAreaElement | null;
const bugIncludeLogs = document.getElementById('bugIncludeLogs') as HTMLInputElement | null;
const bugStatus = document.getElementById('bugStatus') as HTMLElement | null;
const bugCancel = document.getElementById('bugCancel') as HTMLButtonElement | null;
const bugSubmit = document.getElementById('bugSubmit') as HTMLButtonElement | null;
const bugForm = document.getElementById('bugForm') as HTMLElement | null;
const bugSkeleton = document.getElementById('bugSkeleton') as HTMLElement | null;
const bugSuccess = document.getElementById('bugSuccess') as HTMLElement | null;
const bugSuccessLink = document.getElementById('bugSuccessLink') as HTMLElement | null;
const bugDialogTitle = document.getElementById('bugDialogTitle') as HTMLElement | null;

function setBugStatus(msg: string, ok: boolean | null) {
  if (!bugStatus) return;
  bugStatus.textContent = msg;
  bugStatus.className = 'bug-status' + (ok === true ? ' bug-status--ok' : ok === false ? ' bug-status--err' : '');
}

function setBugLoading(loading: boolean) {
  if (!bugSubmit || !bugCancel || !bugTitle || !bugDesc || !bugIncludeLogs) return;
  bugSubmit.disabled = loading;
  bugCancel.disabled = loading;
  bugTitle.disabled = loading;
  bugDesc.disabled = loading;
  bugIncludeLogs.disabled = loading;
  bugSubmit.classList.toggle('bug-btn--loading', loading);
  const txt = bugSubmit.querySelector('.bug-btn__text') as HTMLElement | null;
  if (txt) txt.textContent = loading ? 'Enviando...' : 'Enviar';
  if (bugForm) bugForm.hidden = loading;
  if (bugSkeleton) bugSkeleton.hidden = !loading;
  const hint = document.querySelector('.bug-dialog__hint') as HTMLElement | null;
  if (hint) hint.hidden = loading;
}

function openBugDialog() {
  if (!bugDialog) return;
  // reset para estado de formulário
  pararContagemBloqueio();
  bugDialog.classList.remove('bug-dialog--success');
  if (bugForm) bugForm.hidden = false;
  if (bugSkeleton) bugSkeleton.hidden = true;
  if (bugSuccess) bugSuccess.hidden = true;
  if (bugSuccessLink) bugSuccessLink.innerHTML = '';
  if (bugDialogTitle) bugDialogTitle.textContent = 'Reportar bug';
  const hint = document.querySelector('.bug-dialog__hint') as HTMLElement | null;
  if (hint) hint.hidden = false;
  if (bugCancel) bugCancel.textContent = 'Cancelar';
  if (bugSubmit) {
    bugSubmit.hidden = false;
    const txt = bugSubmit.querySelector<HTMLElement>('.bug-btn__text');
    if (txt) txt.textContent = 'Enviar';
  }
  setBugStatus('', null);
  setBugLoading(false);
  bugDialog.hidden = false;
  bugTitle?.focus();
  fitWindowToContent();
}
function closeBugDialog() {
  if (!bugDialog) return;
  pararContagemBloqueio();
  bugDialog.hidden = true;
  setBugStatus('', null);
  setBugLoading(false);
  fitWindowToContent();
}

bugBtn?.addEventListener('click', openBugDialog);
bugBackdrop?.addEventListener('click', closeBugDialog);
bugCancel?.addEventListener('click', closeBugDialog);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && bugDialog && !bugDialog.hidden) closeBugDialog();
  if (e.key === 'Escape' && settingsDialog && !settingsDialog.hidden) closeSettingsDialog();
});

bugSubmit?.addEventListener('click', async () => {
  const title = (bugTitle?.value ?? '').trim();
  if (!title) {
    setBugStatus('Informe um resumo do problema.', false);
    bugTitle?.focus();
    return;
  }
  if (!bugSubmit || !bugCancel) return;
  setBugLoading(true);
  setBugStatus('', null);
  try {
    const r = await window.api.reportBug({
      title,
      description: bugDesc?.value ?? '',
      includeLogs: !!bugIncludeLogs?.checked,
    });
    if (r.ok) {
      // Estado de agradecimento: os inputs e as acoes somem, fica so a mensagem.
      setBugLoading(false);
      if (bugTitle) bugTitle.value = '';
      if (bugDesc) bugDesc.value = '';
      if (bugForm) bugForm.hidden = true;
      if (bugSkeleton) bugSkeleton.hidden = true;
      if (bugSuccess) bugSuccess.hidden = false;
      bugDialog?.classList.add('bug-dialog--success');
      const hint = document.querySelector('.bug-dialog__hint') as HTMLElement | null;
      if (hint) hint.hidden = true;
      if (bugDialogTitle) bugDialogTitle.textContent = 'Obrigado!';
      if (bugSuccessLink) {
        if (r.issueUrl) {
          const n = r.issueNumber ? ` #${r.issueNumber}` : '';
          bugSuccessLink.innerHTML = `<a href="${r.issueUrl}" target="_blank" rel="noopener">Ver issue${n} no GitHub →</a>`;
        } else {
          bugSuccessLink.textContent = '';
        }
      }
      setBugStatus('', null);
      if (bugCancel) bugCancel.textContent = 'Fechar';
      if (bugSubmit) bugSubmit.hidden = true;
      if (bugCancel) bugCancel.hidden = false;
      fitWindowToContent();
    } else if (r.blocked && r.retryAfter) {
      // Bloqueio por spam: mostra a mensagem com o tempo restante e desabilita
      // o envio com contagem regressiva ate o bloqueio expirar.
      setBugLoading(false);
      iniciarContagemBloqueio(r.retryAfter);
    } else {
      setBugStatus(r.error || 'Falha ao enviar.', false);
      setBugLoading(false);
    }
  } catch (err) {
    setBugStatus(String((err as Error)?.message ?? err), false);
    setBugLoading(false);
  }
});

// Contagem regressiva do bloqueio por spam: desabilita o botao Enviar e mostra
// o tempo restante na mensagem de status, reativando quando expirar.
let bloqueioTimer: number | null = null;
function pararContagemBloqueio() {
  if (bloqueioTimer) {
    window.clearInterval(bloqueioTimer);
    bloqueioTimer = null;
  }
  if (bugSubmit) bugSubmit.disabled = false;
}
function iniciarContagemBloqueio(segundos: number) {
  pararContagemBloqueio();
  let restante = Math.max(1, Math.floor(segundos));

  const tick = () => {
    if (bugStatus) {
      bugStatus.textContent =
        restante > 60
          ? `Você está bloqueado por enviar reports em excesso. Tente novamente em ${Math.ceil(restante / 60)}min.`
          : `Você está bloqueado por enviar reports em excesso. Tente novamente em ${restante}s.`;
    }
    if (bugSubmit) bugSubmit.disabled = true;
    if (restante <= 0) {
      pararContagemBloqueio();
      setBugStatus('', null);
      return;
    }
    restante--;
  };
  tick();
  bloqueioTimer = window.setInterval(tick, 1000);
}
