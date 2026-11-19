declare const golive: any;

const toggle      = document.getElementById('toggle') as HTMLButtonElement;
const stateLabel  = document.getElementById('state-label')!;
const ipLabel     = document.getElementById('ip-label')!;
const logEl       = document.getElementById('log')!;
const protonUser  = document.getElementById('proton-user') as HTMLInputElement;
const protonPass  = document.getElementById('proton-pass') as HTMLInputElement;
const fetchBtn    = document.getElementById('fetch-btn') as HTMLButtonElement;
const importBtn   = document.getElementById('import-btn') as HTMLButtonElement;
const protonStatus = document.getElementById('proton-status')!;
const captchaHint  = document.getElementById('captcha-hint')!;
const captchaLink  = document.getElementById('captcha-link') as HTMLAnchorElement;
const exitLabel   = document.getElementById('exit-label')!;
const exitFlag    = document.getElementById('exit-flag')!;
const exitCountry = document.getElementById('exit-country')!;
const accountRow  = document.getElementById('account-row')!;
const accountLabel = document.getElementById('account-label')!;
const logoutBtn   = document.getElementById('logout-btn') as HTMLButtonElement;
const permCard    = document.getElementById('perm-card')!;
const permOpen    = document.getElementById('perm-open') as HTMLButtonElement;
const permRetry   = document.getElementById('perm-retry') as HTMLButtonElement;
const permStatus  = document.getElementById('perm-status')!;
const vencordOptIn = document.getElementById('vencord-optin') as HTMLInputElement;
const pendingHint = document.getElementById('pending-hint')!;
const restartBtn  = document.getElementById('restart-btn') as HTMLButtonElement;
const offNowBtn   = document.getElementById('off-now-btn') as HTMLButtonElement;
const restoreBtn  = document.getElementById('restore-btn') as HTMLButtonElement;
const errorHint   = document.getElementById('error-hint')!;

function showRestore(msg: string) {
  errorHint.textContent = msg;
  errorHint.classList.remove('ok', 'info');
  errorHint.hidden = restoreBtn.hidden = false;
}
function hideRestore() { errorHint.hidden = restoreBtn.hidden = true; errorHint.classList.remove('ok', 'info'); }
const updateBanner  = document.getElementById('update-banner')!;
const updateMsg     = document.getElementById('update-msg')!;
const updateBtn     = document.getElementById('update-btn') as HTMLButtonElement;

let active = false;
let updateUrl = '';
let updateVersion = '';
let savedAccount: { username: string; expiresAt: string } | null = null;

const countryNames = new Intl.DisplayNames(['pt-BR'], { type: 'region' });

function flagEmoji(cc: string): string {
  return String.fromCodePoint(...[...cc.toUpperCase()].map(c => 0x1f1e6 + c.charCodeAt(0) - 65));
}

function hideExit() {
  exitLabel.hidden = true;
  exitFlag.textContent = '';
  exitCountry.textContent = '';
}

let exitSeq = 0;
async function showExit() {
  const seq = ++exitSeq;
  exitLabel.hidden = false;
  exitFlag.textContent = '';
  exitCountry.textContent = 'Verificando país…';
  const info = await golive.exitInfo().catch(() => null);
  if (seq !== exitSeq || !active) return;
  if (!info) { exitCountry.textContent = 'País indisponível'; return; }
  exitFlag.textContent = info.country ? flagEmoji(info.country) : '';
  exitCountry.textContent = info.country ? (countryNames.of(info.country) ?? info.country) : 'País desconhecido';
  ipLabel.textContent = `IP: ${info.ip}`;
  log(`Saída do Discord: ${info.country ?? '?'} (${info.ip})`);
}

function log(m: string, isErr = false) {
  const line = `[${new Date().toLocaleTimeString()}] ${m}\n`;
  logEl.textContent += line;
  if (isErr) console.error(m);
  logEl.scrollTop = logEl.scrollHeight;
}

type UiState = 'inactive' | 'active' | 'pending' | 'busy' | 'unknown';

function setState(s: UiState) {
  document.body.dataset.state = s;
  restartBtn.hidden = s !== 'active';
  if (s !== 'active' && s !== 'pending') {
    (document.getElementById('traffic') as HTMLElement).hidden = true;
  }
  offNowBtn.hidden = pendingHint.hidden = s !== 'pending';
  if (s === 'busy') hideRestore();
  if (s === 'pending') {
    stateLabel.textContent = 'Desliga ao fechar o Discord';
    toggle.setAttribute('aria-label', 'Manter ativo');
    hideExit();
    ipLabel.textContent = '';
  } else if (s === 'active') {
    stateLabel.textContent = 'Bypass ativo';
    toggle.setAttribute('aria-label', 'Desativar');
  } else if (s === 'inactive' || s === 'unknown') {
    stateLabel.textContent = s === 'unknown' ? 'Verificando…' : 'Inativo';
    toggle.setAttribute('aria-label', 'Ativar');
    ipLabel.textContent = '';
    hideExit();
  } else {
    hideExit();
    stateLabel.textContent = active ? 'Desativando…' : 'Ativando…';
  }
}

let hasConfig = false;

/** Aplica o estado vindo do main (evento tunnel:state, status ou resultado de uma ação). */
function applyTunnelState(st: string) {
  if (st === 'activating' || st === 'deactivating') {
    active = st === 'deactivating';
    toggle.disabled = true;
    setState('busy');
    return;
  }
  const wasActive = active;
  // Pendente conta como inativo para o botão: clicar reativa (cancela a espera)
  active = st === 'active';
  setState(st === 'active' || st === 'pending' || st === 'unknown' ? st : 'inactive');
  toggle.disabled = !(active || st === 'pending' || hasConfig);
  if (active && (!wasActive || exitLabel.hidden)) showExit();
}

async function refresh() {
  try {
    const s = await golive.status();
    hasConfig = s.hasConfig;
    if (s.busy) { toggle.disabled = true; setState('busy'); }
    else applyTunnelState(s.state);
    log(`[status] state=${s.state} hasConfig=${s.hasConfig}${s.busy ? ' (operação em andamento)' : ''}`);
  } catch (e) {
    log(`[status erro] ${e}`, true);
  }
}

golive.onTunnelState?.((p: { state: string; error?: string }) => {
  applyTunnelState(p.state);
  if (p.error) {
    log(`Erro: ${p.error}`, true);
    showRestore('Não deu para desligar o túnel. Use Restaurar internet.');
  }
});

// ── Toggle ────────────────────────────────────────────────────────────────────

toggle.addEventListener('click', async () => {
  const deactivating = active;
  log(deactivating ? 'Desativando bypass…' : 'Ativando bypass…');
  toggle.disabled = true;
  setState('busy');

  const r = deactivating ? await golive.deactivate() : await golive.activate();

  if (r?.error) {
    const msgs: Record<string, string> = {
      busy:              'Já existe uma ativação ou desativação em andamento.',
      user_cancelled:    'Senha cancelada pelo usuário.',
      handshake_timeout: 'Timeout de handshake — nenhum peer respondeu em 15s.',
      binary_missing:    'Binário wg-quick não encontrado.',
      wg_failed:         'Falha ao controlar o WireGuard.',
    };
    const msg = msgs[r.error] ?? r.error;
    log(`Erro: ${msg}${r.detail ? ` — ${r.detail}` : ''}`, true);
    await refresh();
    ipLabel.textContent = `Erro: ${msg}`;
    if (r.error !== 'busy' && r.error !== 'user_cancelled') showRestore('Se a internet ficou presa, use Restaurar internet.');
    return;
  }

  hideRestore();
  applyTunnelState(r?.state ?? (deactivating ? 'inactive' : 'active'));
});

async function runSecondary(btn: HTMLButtonElement, label: string, call: () => Promise<any>) {
  log(label);
  btn.disabled = toggle.disabled = true;
  setState('busy');
  try {
    const r = await call();
    if (r?.error) {
      log(`Erro: ${r.error}${r.detail ? ` — ${r.detail}` : ''}`, true);
      if (r.error !== 'busy' && r.error !== 'user_cancelled') showRestore('Se a internet ficou presa, use Restaurar internet.');
    } else if (btn === restoreBtn) {
      if (r?.online === false) {
        showRestore('O túnel foi limpo, mas o Discord ainda não responde. Confira o Wi-Fi e tente de novo.');
      } else {
        hideRestore();
        errorHint.textContent = 'Internet restaurada.';
        errorHint.classList.add('ok');
        errorHint.hidden = false;
      }
    }
  } finally {
    btn.disabled = false;
    await refresh();
  }
}

restartBtn.addEventListener('click', () => runSecondary(restartBtn, 'Reiniciando bypass…', () => golive.restart()));
offNowBtn.addEventListener('click', () => runSecondary(offNowBtn, 'Desativando agora…', () => golive.deactivate(true)));
restoreBtn.addEventListener('click', () => runSecondary(restoreBtn, 'Restaurando a internet…', () => golive.restoreNetwork()));

// ── Conexão Proton ────────────────────────────────────────────────────────────

const tabProton   = document.getElementById('tab-proton') as HTMLButtonElement;
const tabConf     = document.getElementById('tab-conf') as HTMLButtonElement;
const paneProton  = document.getElementById('pane-proton')!;
const paneConf    = document.getElementById('pane-conf')!;
const loginBox    = document.getElementById('login-box')!;
const routeBox    = document.getElementById('route-box')!;
const routeSelect = document.getElementById('route-select') as HTMLSelectElement;
const optimizeBtn = document.getElementById('optimize-btn') as HTMLButtonElement;
const planRow     = document.getElementById('plan-row')!;
const planLabel   = document.getElementById('plan-label')!;
const planRefresh = document.getElementById('plan-refresh') as HTMLButtonElement;
const confStatus  = document.getElementById('conf-status')!;

interface Route { server: string; country: string; city: string; pingMs?: number; downloadMbps?: number; uploadMbps?: number }
let routes: Route[] = [];
let currentRoute: Route | null = null;
let routePreference: 'auto' | 'manual' = 'auto';
let protonBusy = false;

function selectTab(which: 'proton' | 'conf') {
  tabProton.setAttribute('aria-selected', String(which === 'proton'));
  tabConf.setAttribute('aria-selected', String(which === 'conf'));
  paneProton.hidden = which !== 'proton';
  paneConf.hidden = which !== 'conf';
}
tabProton.addEventListener('click', () => selectTab('proton'));
tabConf.addEventListener('click', () => selectTab('conf'));

function setStatus(text: string, kind: 'info' | 'ok' | 'err' = 'info') {
  protonStatus.hidden = !text;
  protonStatus.textContent = text;
  protonStatus.className = `status-line${kind === 'info' ? '' : ` ${kind}`}`;
}

const AUTO = '__auto';
const LOAD = '__load';

function routeLabel(r: Route): string {
  const flag = r.country ? `${flagEmoji(r.country)} ` : '';
  return `${flag}${r.server}${r.city ? ` · ${r.city}` : ''}${r.pingMs ? ` · ${r.pingMs} ms` : ''}`;
}

function renderRoutes() {
  routeSelect.textContent = '';
  const add = (value: string, label: string) => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    routeSelect.appendChild(o);
    return o;
  };
  const autoLabel = routePreference === 'auto' && currentRoute
    ? `Automática · ${routeLabel(currentRoute)}`
    : 'Automática · menor ping';
  add(AUTO, autoLabel);
  const sorted = [...routes].sort((a, b) => (a.pingMs ?? 9999) - (b.pingMs ?? 9999));
  for (const r of sorted) add(r.server, routeLabel(r));
  if (!routes.length) add(LOAD, 'Carregar lista de rotas…');
  const manualCurrent = routePreference === 'manual' && currentRoute;
  if (manualCurrent && !routes.some(r => r.server === currentRoute!.server)) add(currentRoute!.server, routeLabel(currentRoute!));
  routeSelect.value = manualCurrent ? currentRoute!.server : AUTO;
}

function describeChosen(c: Route | undefined, prefix: string): string {
  if (!c) return `${prefix}.`;
  const speed = c.downloadMbps && c.uploadMbps ? ` (↓ ${c.downloadMbps.toFixed(1)} / ↑ ${c.uploadMbps.toFixed(1)} Mbps medidos${c.pingMs ? ` · ${c.pingMs} ms` : ''})` : c.pingMs ? ` (${c.pingMs} ms)` : '';
  return `${prefix} ${c.server}${speed}.`;
}

const errMsgs: Record<string, string> = {
  auth_failed:    'Usuário ou senha incorretos.',
  app_outdated:   'A Proton deixou de aceitar esta versão do GoLiveBypass. Atualize o GoLiveBypass para continuar.',
  no_servers:     'Nenhum servidor free disponível agora.',
  busy:           'Já existe uma busca em andamento.',
  binary_missing: 'proton-confgen não encontrado nos recursos.',
  binary_integrity: 'proton-confgen não confere com o manifesto do app; reinstale o GoLiveBypass.',
  timeout:        'O Proton demorou demais para responder. Tente de novo.',
  unknown:       'Erro desconhecido. Para ver o log, ligue o Modo desenvolvedor em Configurações.',
};

async function runProton(mode: 'auto' | 'manual' | 'speed' | 'catalog', opts: { password?: string; server?: string; btn?: HTMLButtonElement } = {}) {
  const user = savedAccount?.username ?? protonUser.value.trim();
  if (!user) { setStatus('Preencha usuário e senha.', 'err'); return; }
  if (protonBusy) return;
  protonBusy = true;
  captchaHint.hidden = true;
  fetchBtn.disabled = optimizeBtn.disabled = routeSelect.disabled = true;
  opts.btn?.classList.add('spinning');
  setStatus(mode === 'speed' ? 'Medindo as melhores rotas…' : 'Iniciando…');
  try {
    const r = await golive.fetchProton(user, opts.password, mode, opts.server);
    protonPass.value = '';
    if (Array.isArray(r.routes)) routes = r.routes;
    await refreshAccount();
    if (r.ok) {
      if (mode === 'catalog') { setStatus(''); renderRoutes(); return; }
      if (r.chosen) currentRoute = r.chosen;
      hasConfig = true;
      if (document.body.dataset.state !== 'busy') toggle.disabled = false;
      renderRoutes();
      const after = active ? ' Use Reiniciar bypass para trocar agora.' : ' Ative o bypass para usá-la.';
      setStatus(describeChosen(r.chosen, 'Rota') + after, 'ok');
      log(`Rota Proton: ${r.chosen?.server ?? '?'} (${mode}).`);
      return;
    }
    renderRoutes();
    if (r.error === 'captcha') {
      setStatus('CAPTCHA requerido — veja abaixo.', 'err');
      captchaHint.hidden = false;
      if (r.captchaUrl) {
        captchaLink.href = r.captchaUrl;
        captchaLink.onclick = (e) => { e.preventDefault(); window.open(r.captchaUrl, '_blank'); };
      }
      return;
    }
    setStatus(`Erro: ${errMsgs[r.error] ?? r.error}${r.detail ? ` (${r.detail})` : ''}`, 'err');
    log(`ProtonVPN erro: ${r.error}${r.detail ? ` — ${r.detail}` : ''}`, true);
  } finally {
    protonBusy = false;
    fetchBtn.disabled = optimizeBtn.disabled = routeSelect.disabled = false;
    opts.btn?.classList.remove('spinning');
  }
}

golive.onProtonProgress?.((msg: string) => {
  setStatus(msg);
  log(msg);
});

fetchBtn.addEventListener('click', () => {
  const user = protonUser.value.trim();
  const pass = protonPass.value;
  if (!user || (!pass && savedAccount?.username !== user)) { setStatus('Preencha usuário e senha.', 'err'); return; }
  void runProton('auto', { password: pass || undefined });
});

optimizeBtn.addEventListener('click', () => void runProton('speed', { btn: optimizeBtn }));

routeSelect.addEventListener('change', async () => {
  const v = routeSelect.value;
  if (v === LOAD) { void runProton('catalog'); return; }
  if (v === AUTO) {
    routePreference = 'auto';
    await golive.setSettings({ routePreference: 'auto' }).then(applySettings).catch(() => {});
    void runProton('auto');
    return;
  }
  routePreference = 'manual';
  void runProton('manual', { server: v });
});

golive.onRoute?.((r: Route | null) => { currentRoute = r; renderRoutes(); });

// ── Importar .conf ────────────────────────────────────────────────────────────

importBtn.addEventListener('click', async () => {
  const raw = await golive.pickConf();
  if (!raw) return;
  const r = await golive.importConfig(raw);
  if (!r.ok) { confStatus.textContent = 'Erro ao importar: ' + (r.errors?.join(' ') ?? ''); log('Erro ao importar: ' + r.errors?.join(' '), true); return; }
  r.warnings?.forEach((w: string) => log('Aviso: ' + w));
  hasConfig = true;
  currentRoute = null;
  if (document.body.dataset.state !== 'busy') toggle.disabled = false;
  confStatus.textContent = active ? 'Configuração importada. Use Reiniciar bypass para usá-la agora.' : 'Configuração importada. Você já pode ativar.';
  log('Config .conf importada com sucesso.');
});

// ── Conta Proton salva e plano ────────────────────────────────────────────────

async function refreshPlan(force = false) {
  if (!savedAccount) { planRow.hidden = true; return; }
  planRow.hidden = false;
  planLabel.textContent = 'Plano: verificando…';
  const { plan } = await golive.protonPlan(force).catch(() => ({ plan: null }));
  planLabel.textContent = plan
    ? `Plano: ${plan.planTitle ?? (plan.status === 'free' ? 'Proton VPN Free' : 'Proton VPN pago')}`
    : 'Plano: não deu para confirmar';
}
planRefresh.addEventListener('click', () => void refreshPlan(true));

async function refreshAccount() {
  const prev = savedAccount?.username;
  savedAccount = await golive.protonAccount().catch(() => null);
  loginBox.hidden = !!savedAccount;
  routeBox.hidden = !savedAccount;
  if (!savedAccount) {
    accountRow.hidden = true;
    planRow.hidden = true;
    return;
  }
  const until = new Date(savedAccount.expiresAt).toLocaleDateString('pt-BR');
  accountLabel.textContent = `${savedAccount.username} · sessão até ${until}`;
  accountLabel.title = savedAccount.username;
  accountRow.hidden = false;
  if (prev !== savedAccount.username) void refreshPlan();
}

logoutBtn.addEventListener('click', async () => {
  await golive.protonLogout();
  protonUser.value = '';
  protonPass.value = '';
  setStatus('Sessão removida. A configuração atual continua salva.');
  log('Sessão Proton removida.');
  await refreshAccount();
});

async function loadRoutes() {
  const r = await golive.protonRoutes().catch(() => null);
  if (!r) return;
  routes = r.routes ?? [];
  currentRoute = r.current;
  renderRoutes();
}

// ── Permissão de Gerenciamento de Apps (Vencord) ───────────────────────────────

golive.onVencordPermission?.((p: { granted: boolean }) => {
  permCard.hidden = p.granted || !vencordOptIn.checked;
  if (!p.granted) permStatus.textContent = '';
});

permOpen.addEventListener('click', async () => {
  await golive.vencordOpenSettings();
  permStatus.textContent = 'Ligue o GoLiveBypass e volte para esta janela.';
});

let retrying = false;
async function retryVencord(manual: boolean) {
  if (retrying || permCard.hidden) return;
  retrying = true;
  try {
    const { granted } = await golive.vencordPermission();
    if (!granted) {
      if (manual) permStatus.textContent = 'Ainda bloqueado. Confira se a chave do GoLiveBypass está ligada.';
      return;
    }
    permStatus.textContent = 'Permissão liberada! Injetando Vencord…';
    permRetry.disabled = permOpen.disabled = true;
    const { outcome } = await golive.vencordRetry();
    if (outcome === 'ok') {
      permCard.hidden = true;
      log('Vencord pronto.');
    } else {
      permStatus.textContent = outcome === 'needs_permission'
        ? 'O macOS ainda bloqueou. Feche e reabra o GoLiveBypass e tente de novo.'
        : 'Não deu certo. Para ver o log, ligue o Modo desenvolvedor em Configurações.';
    }
  } finally {
    permRetry.disabled = permOpen.disabled = false;
    retrying = false;
  }
}

permRetry.addEventListener('click', () => retryVencord(true));

golive.vencordGetOptIn?.().then((r: { enabled: boolean }) => { vencordOptIn.checked = !!r?.enabled; });

vencordOptIn.addEventListener('change', async () => {
  const enabled = vencordOptIn.checked;
  vencordOptIn.disabled = true;
  try {
    const r = await golive.vencordSetOptIn(enabled);
    if (!enabled) { permCard.hidden = true; return; }
    if (r?.outcome === 'ok') log('Vencord pronto.');
    else if (r?.outcome === 'no_discord') log('Discord não encontrado em Aplicativos.', true);
  } finally {
    vencordOptIn.disabled = false;
  }
});
// Ao voltar dos Ajustes, confere sozinho
window.addEventListener('focus', () => retryVencord(false));

// ── Atualizações ──────────────────────────────────────────────────────────────

function showUpdate(info: any) {
  if (!info?.available || updateBtn.disabled) return;
  updateMsg.textContent = `Nova versão disponível: v${info.latestVersion} (atual: v${info.currentVersion})`;
  updateBanner.hidden = false;
  updateUrl = info.downloadUrl ?? '';
  updateVersion = info.latestVersion ?? '';
}
golive.onUpdateAvailable?.(showUpdate);
golive.checkUpdate?.().then(showUpdate).catch(() => {});

golive.onUpdateProgress?.((msg: string) => {
  updateMsg.textContent = msg;
  log(`[update] ${msg}`);
});

updateBtn.addEventListener('click', async () => {
  if (!updateUrl) { log('URL de download não disponível.', true); return; }
  updateBtn.disabled = true;
  const r = await golive.downloadUpdate(updateVersion);
  if (!r?.ok) {
    updateMsg.textContent = `Falha ao baixar: ${r?.error ?? 'erro desconhecido'}`;
    log(`[update] erro: ${r?.error}`, true);
    updateBtn.disabled = false;
    if (r?.update) showUpdate(r.update);
    return;
  }
  updateMsg.textContent = 'Arraste o novo GoLiveBypass para Aplicativos e reabra o app.';
});

const checkUpdateBtn = document.getElementById('check-update') as HTMLButtonElement;
checkUpdateBtn.addEventListener('click', async () => {
  if (checkUpdateBtn.classList.contains('spinning')) {
    checkUpdateBtn.title = 'Já está procurando, aguarde…';
    return;
  }
  checkUpdateBtn.classList.add('spinning');
  try {
    const info = await golive.checkUpdate();
    checkUpdateBtn.title = info?.available
      ? `Nova versão: v${info.latestVersion}`
      : `Você está na última versão (v${info?.currentVersion ?? '?'})`;
    showUpdate(info);
  } catch (e) {
    checkUpdateBtn.title = 'Não deu para checar agora';
    log(`[update] erro ao checar: ${e}`, true);
  } finally {
    checkUpdateBtn.classList.remove('spinning');
  }
});

// ── Painéis ───────────────────────────────────────────────────────────────────

function openPanel(panel: HTMLElement) {
  panel.classList.remove('closing');
  panel.hidden = false;
  (panel.querySelector('[data-close].icon-btn') as HTMLElement | null)?.focus();
}

function closePanel(panel: HTMLElement) {
  if (panel.hidden || panel.classList.contains('closing')) return;
  panel.dispatchEvent(new Event('panelclose'));
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) { panel.hidden = true; return; }
  panel.classList.add('closing');
  setTimeout(() => { panel.hidden = true; panel.classList.remove('closing'); }, 160);
}

const panels = Array.from(document.querySelectorAll<HTMLElement>('.panel:not(.dialog)'));
for (const p of panels) {
  p.querySelectorAll('[data-close]').forEach((el: Element) => el.addEventListener('click', () => closePanel(p)));
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') panels.forEach(closePanel);
});
document.getElementById('open-help')!.addEventListener('click', () => openPanel(document.getElementById('help-panel')!));
document.getElementById('open-settings')!.addEventListener('click', () => openPanel(document.getElementById('settings-panel')!));

// ── Usar no celular ───────────────────────────────────────────────────────────

const phonePanel   = document.getElementById('phone-panel')!;
const phoneForm    = document.getElementById('phone-form')!;
const phoneInelig  = document.getElementById('phone-ineligible')!;
const phoneGenBtn  = document.getElementById('phone-generate') as HTMLButtonElement;
const phoneRegen   = document.getElementById('phone-regen-hint')!;
const phoneMeta    = document.getElementById('phone-meta')!;
const phoneStatus  = document.getElementById('phone-status')!;
const phoneQrBox   = document.getElementById('phone-qr-box')!;
const phoneQr      = document.getElementById('phone-qr') as HTMLImageElement;
const phoneFileBox = document.getElementById('phone-file-box')!;
const phoneSaveBtn = document.getElementById('phone-save') as HTMLButtonElement;
const phoneDelBtn  = document.getElementById('phone-delete') as HTMLButtonElement;
const phoneFileMsg = document.getElementById('phone-file-status')!;
const phoneDeliveryHint = document.getElementById('phone-delivery-hint')!;
const PHONE_TTL_MS = 300_000;
let phoneTtl: ReturnType<typeof setTimeout> | null = null;
let phoneSavedPaths: string[] = [];

const phoneErrMsgs: Record<string, string> = {
  not_eligible: 'Entre na sua conta Proton em Proton Otimizado para gerar a conf do celular.',
  busy:         'Espere a busca de rota atual terminar.',
  no_routes:    'Nenhum servidor respondeu ao ping agora. Tente de novo em instantes.',
  probe_failed: 'O servidor escolhido não passou no teste. Tente gerar de novo.',
  auth_failed:  'A sessão Proton expirou. Entre de novo em Proton Otimizado.',
  app_outdated: errMsgs.app_outdated,
  timeout:      errMsgs.timeout,
  invalid_conf: 'A conf gerada veio incompleta. Tente de novo.',
  unknown:      'Não deu para gerar a conf. Tente de novo.',
};

const phonePick = (name: string) => (document.querySelector(`input[name="${name}"]:checked`) as HTMLInputElement).value as any;

function phoneSetStatus(msg: string, kind: 'err' | 'info' = 'info') {
  phoneStatus.textContent = msg;
  phoneStatus.classList.toggle('err', kind === 'err');
  phoneStatus.hidden = !msg;
}

function renderPhoneMeta(m: any) {
  phoneMeta.hidden = phoneRegen.hidden = !m;
  if (!m) return;
  const until = m.expiresAt ? ` · vale até ${new Date(m.expiresAt * 1000).toLocaleDateString('pt-BR')}` : '';
  phoneMeta.textContent = `Última conf: ${m.server} (${m.city})${until}`;
}

function showPhoneSteps(delivery?: string) {
  for (const d of ['qr', 'file']) document.getElementById(`phone-steps-${d}`)!.hidden = d !== delivery;
}

/** Tira a conf da tela e da memória do main. */
function hidePhoneResult() {
  if (phoneTtl) clearTimeout(phoneTtl);
  phoneTtl = null;
  phoneQr.removeAttribute('src');
  phoneQrBox.hidden = phoneFileBox.hidden = true;
  showPhoneSteps();
  void golive.phoneClear();
}

async function openPhonePanel() {
  hidePhoneResult();
  phoneSetStatus('');
  phoneFileMsg.hidden = true;
  const st = await golive.phoneStatus();
  phoneInelig.hidden = st.eligible;
  phoneForm.hidden = !st.eligible;
  renderPhoneMeta(st.meta);
  openPanel(phonePanel);
}

document.querySelectorAll('input[name="phone-delivery"]').forEach(el => el.addEventListener('change', () => {
  phoneDeliveryHint.textContent = phonePick('phone-delivery') === 'file'
    ? 'Arquivo: mais seguro, porque a conf nunca aparece na tela, e menos prático.'
    : 'QR code: o jeito mais prático.';
}));

phoneGenBtn.addEventListener('click', async () => {
  const delivery = phonePick('phone-delivery');
  hidePhoneResult();
  phoneGenBtn.disabled = true;
  phoneSetStatus('Gerando a conf do celular… (até 2 min)');
  try {
    const r = await golive.phoneGenerate(delivery);
    if (!r?.ok) { phoneSetStatus(phoneErrMsgs[r?.error] ?? phoneErrMsgs.unknown, 'err'); return; }
    phoneSetStatus('');
    renderPhoneMeta(r.meta);
    if (delivery === 'qr') {
      phoneQr.src = r.qr;
      phoneQrBox.hidden = false;
    } else {
      phoneFileBox.hidden = false;
      phoneDelBtn.hidden = true;
    }
    showPhoneSteps(delivery);
    phoneTtl = setTimeout(() => {
      hidePhoneResult();
      phoneSetStatus('A conf saiu da tela depois de 5 minutos. Gere de novo se precisar.');
    }, PHONE_TTL_MS);
  } finally {
    phoneGenBtn.disabled = false;
  }
});

phoneSaveBtn.addEventListener('click', async () => {
  const r = await golive.phoneSave();
  if (r?.ok) {
    if (!phoneSavedPaths.includes(r.path)) phoneSavedPaths.push(r.path);
    phoneFileMsg.textContent = `Salvo em ${r.path}.`;
    phoneDelBtn.hidden = false;
  } else if (r?.error === 'cloud_folder') {
    phoneFileMsg.textContent = 'Essa pasta é sincronizada pelo iCloud: a chave iria para a nuvem. Escolha outra, como Downloads.';
  } else if (r?.error === 'no_conf') {
    phoneFileMsg.textContent = 'A conf saiu da memória. Gere de novo.';
  } else {
    return;
  }
  phoneFileMsg.hidden = false;
});

phoneDelBtn.addEventListener('click', async () => {
  await golive.phoneDeleteSaved();
  phoneSavedPaths = [];
  phoneDelBtn.hidden = true;
  phoneFileMsg.textContent = 'Arquivo apagado do Mac.';
  phoneFileMsg.hidden = false;
});

document.getElementById('phone-done')!.addEventListener('click', () => {
  hidePhoneResult();
  phoneSetStatus('Conf importada? Ligue o túnel no WireGuard antes de entrar em live.');
});

phonePanel.addEventListener('panelclose', () => {
  hidePhoneResult();
  void golive.phoneStatus().then((st: any) => {
    phoneSavedPaths = st?.savedPaths ?? [];
    if (!phoneSavedPaths.length) return;
    errorHint.textContent = phoneSavedPaths.length === 1
      ? `O arquivo ${phoneSavedPaths[0]} ainda está no Mac. Apague depois de importar.`
      : `Ainda há ${phoneSavedPaths.length} arquivos .conf do celular no Mac: ${phoneSavedPaths.join(', ')}. Apague depois de importar.`;
    errorHint.classList.remove('ok');
    errorHint.classList.add('info');
    errorHint.hidden = false;
  });
});

document.getElementById('open-phone')!.addEventListener('click', () => void openPhonePanel());

// ── Configurações ─────────────────────────────────────────────────────────────

const openAtLogin = document.getElementById('open-at-login') as HTMLInputElement;
const devMode     = document.getElementById('dev-mode') as HTMLInputElement;

const autoFailover = document.getElementById('auto-failover') as HTMLInputElement;
const routePrefInputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="route-pref"]'));

const themeInputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="theme"]'));

interface UiSettings {
  openAtLogin: boolean; devMode: boolean; theme: 'system' | 'light' | 'dark'; routePreference: 'auto' | 'manual';
  autoFailover: boolean; connectionMode: 'proton' | 'conf'; askRoutePreference: boolean;
}

function applySettings(s: UiSettings | null) {
  if (!s) return;
  openAtLogin.checked = s.openAtLogin;
  devMode.checked = s.devMode;
  themeInputs.forEach(i => { i.checked = i.value === s.theme; });
  logEl.hidden = !s.devMode;
  if (s.devMode) logEl.scrollTop = logEl.scrollHeight;
  routePreference = s.routePreference;
  routePrefInputs.forEach(i => { i.checked = i.value === s.routePreference; });
  autoFailover.checked = s.autoFailover;
  autoFailover.disabled = s.routePreference === 'manual';
}

async function saveSetting(input: HTMLInputElement, patch: Record<string, unknown>) {
  input.disabled = true;
  try { applySettings(await golive.setSettings(patch)); }
  catch (e) { log(`Falha ao salvar a configuração: ${e}`, true); }
  finally { input.disabled = false; }
}

openAtLogin.addEventListener('change', () => saveSetting(openAtLogin, { openAtLogin: openAtLogin.checked }));
devMode.addEventListener('change', () => saveSetting(devMode, { devMode: devMode.checked }));
themeInputs.forEach(i => i.addEventListener('change', () => { if (i.checked) void saveSetting(i, { theme: i.value }); }));
autoFailover.addEventListener('change', () => saveSetting(autoFailover, { autoFailover: autoFailover.checked }));
routePrefInputs.forEach(i => i.addEventListener('change', async () => {
  if (!i.checked) return;
  await saveSetting(i, { routePreference: i.value });
  renderRoutes();
}));

// ── Pergunta única de rota ────────────────────────────────────────────────────

const routePrompt = document.getElementById('route-prompt')!;

async function answerRoutePrompt(choice: 'auto' | 'manual' | null) {
  if (routePrompt.hidden) return;
  closePanel(routePrompt);
  try {
    applySettings(await golive.setSettings(choice ? { routePreference: choice } : { routePromptAnswered: true }));
  } catch (e) {
    log(`Falha ao salvar a resposta da pergunta de rota: ${e}`, true);
  }
  renderRoutes();
  if (choice === 'manual' && savedAccount) {
    if (!routes.length) void runProton('catalog');
    routeSelect.focus();
  }
}
document.getElementById('route-prompt-auto')!.addEventListener('click', () => void answerRoutePrompt('auto'));
document.getElementById('route-prompt-manual')!.addEventListener('click', () => void answerRoutePrompt('manual'));
routePrompt.querySelectorAll('[data-later]').forEach((el: Element) => el.addEventListener('click', () => void answerRoutePrompt(null)));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') void answerRoutePrompt(null); });

golive.getSettings?.().then((s: UiSettings) => {
  applySettings(s);
  selectTab(s.connectionMode);
  renderRoutes();
  if (s.askRoutePreference) openPanel(routePrompt);
}).catch(() => {});

golive.appInfo?.().then((i: { version: string }) => {
  document.getElementById('app-version')!.textContent = `Go Live · macOS · v${i.version}`;
}).catch(() => {});

// ── Notificação de segundo plano (ao fechar janela) ────────────────────────────

golive.onLog?.((m: string) => log(m));

// ── Init ──────────────────────────────────────────────────────────────────────

// ── Tráfego ───────────────────────────────────────────────────────────────────

const trafficEl = document.getElementById('traffic')!;
const tPing = document.getElementById('t-ping')!;

golive.onTraffic?.((t: { pingMs: number | null }) => {
  const st = document.body.dataset.state;
  if (st !== 'active' && st !== 'pending') return;
  trafficEl.hidden = false;
  tPing.textContent = t.pingMs ? `${t.pingMs} ms` : '–';
});

refresh();
refreshAccount().then(loadRoutes);
