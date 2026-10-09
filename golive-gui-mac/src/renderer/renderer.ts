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

function setState(s: 'inactive' | 'active' | 'busy' | 'unknown') {
  document.body.dataset.state = s;
  if (s === 'active') {
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
  active = st === 'active';
  setState(active ? 'active' : st === 'unknown' ? 'unknown' : 'inactive');
  toggle.disabled = !(active || hasConfig);
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

golive.onTunnelState?.((p: { state: string }) => applyTunnelState(p.state));

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
    return;
  }

  applyTunnelState(r?.state ?? (deactivating ? 'inactive' : 'active'));
});

// ── ProtonVPN fetch ───────────────────────────────────────────────────────────

golive.onProtonProgress?.((msg: string) => {
  protonStatus.textContent = msg;
  log(msg);
});

fetchBtn.addEventListener('click', async () => {
  const user = protonUser.value.trim();
  const pass = protonPass.value;
  const usesSession = !!savedAccount && savedAccount.username === user;
  if (!user || (!pass && !usesSession)) { protonStatus.textContent = 'Preencha usuário e senha.'; return; }

  captchaHint.hidden = true;
  fetchBtn.disabled = true;
  protonStatus.textContent = 'Iniciando…';

  const r = await golive.fetchProton(user, pass || undefined);

  fetchBtn.disabled = false;
  protonPass.value = '';
  await refreshAccount();

  if (r.ok) {
    const c = r.chosen;
    const where = c ? `${c.country ? flagEmoji(c.country) + ' ' : ''}${c.city} (${c.server})${c.pingMs ? ` · ${c.pingMs} ms` : ''}` : '';
    protonStatus.textContent = where
      ? `Servidor: ${where}.${active ? ' Desative e ative de novo para usar.' : ' Você já pode ativar.'}`
      : 'Servidor configurado! Você já pode ativar.';
    hasConfig = true;
    if (document.body.dataset.state !== 'busy') toggle.disabled = false;
    log('Config ProtonVPN importada com sucesso.');
    return;
  }

  if (r.error === 'captcha') {
    protonStatus.textContent = 'CAPTCHA requerido — veja abaixo.';
    captchaHint.hidden = false;
    if (r.captchaUrl) {
      captchaLink.href = r.captchaUrl;
      captchaLink.onclick = (e) => { e.preventDefault(); window.open(r.captchaUrl, '_blank'); };
    }
    return;
  }

  const errMsgs: Record<string, string> = {
    auth_failed:    'Usuário ou senha incorretos.',
    no_servers:     'Nenhum servidor free disponível agora.',
    busy:           'Já existe uma busca em andamento.',
    binary_missing: 'proton-confgen não encontrado nos recursos.',
    binary_integrity: 'proton-confgen não confere com o manifesto do app; reinstale o GoLiveBypass.',
    timeout:        'O Proton demorou demais para responder. Tente de novo.',
    unknown:       'Erro desconhecido — veja o log.',
  };
  protonStatus.textContent = `Erro: ${errMsgs[r.error] ?? r.error}`;
  log(`ProtonVPN erro: ${r.error}`, true);
});

// ── Importar .conf ────────────────────────────────────────────────────────────

importBtn.addEventListener('click', async () => {
  const raw = await golive.pickConf();
  if (!raw) return;
  const r = await golive.importConfig(raw);
  if (!r.ok) { log('Erro ao importar: ' + r.errors?.join(' '), true); return; }
  r.warnings?.forEach((w: string) => log('Aviso: ' + w));
  hasConfig = true;
  if (document.body.dataset.state !== 'busy') toggle.disabled = false;
  protonStatus.textContent = 'Configuração importada.';
  log('Config .conf importada com sucesso.');
});

// ── Conta Proton salva ────────────────────────────────────────────────────────

async function refreshAccount() {
  savedAccount = await golive.protonAccount().catch(() => null);
  if (!savedAccount) {
    accountRow.hidden = true;
    protonPass.placeholder = 'Senha';
    return;
  }
  const until = new Date(savedAccount.expiresAt).toLocaleDateString('pt-BR');
  accountLabel.textContent = `Conta salva: ${savedAccount.username} · sessão até ${until}`;
  accountLabel.title = savedAccount.username;
  accountRow.hidden = false;
  if (!protonUser.value) protonUser.value = savedAccount.username;
  protonPass.placeholder = 'Senha (não precisa)';
}

logoutBtn.addEventListener('click', async () => {
  await golive.protonLogout();
  protonUser.value = '';
  protonPass.value = '';
  protonStatus.textContent = 'Sessão removida. A configuração atual continua salva.';
  log('Sessão Proton removida.');
  await refreshAccount();
});

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
        : 'Não deu certo — veja o log abaixo.';
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

// ── Notificação de segundo plano (ao fechar janela) ────────────────────────────

golive.onLog?.((m: string) => log(m));

// ── Init ──────────────────────────────────────────────────────────────────────

refresh();
refreshAccount();
