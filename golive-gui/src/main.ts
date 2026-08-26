import './style.css'

declare global {
  interface Window {
    api: {
      platform: string;
      activate: (proxy?: string) => Promise<void>;
      deactivate: () => Promise<void>;
      getStatus: () => Promise<string>;
      getProxy: () => Promise<string>;
      getPlatform: () => Promise<string>;
      getStartup: () => Promise<boolean>;
      setStartup: (enabled: boolean) => Promise<void>;
      getNetMode: () => Promise<string>;
      setNetMode: (mode: string) => Promise<string>;
      getTorStatus: () => Promise<{ presente: boolean; ativo: boolean; porta: number }>;
      installTor: () => Promise<{ ok: boolean; porta?: number; error?: string }>;
      testProxy: (proxy: string) => Promise<{
        ok: boolean;
        ms?: number;
        host?: string;
        port?: number;
        country?: string;
        error?: string;
      }>;
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
      onRefreshStatus: (callback: () => void) => void;
      onTorWatchdogRecuperado: (callback: () => void) => void;
      resizeWindow: (height: number) => void;
      setTheme: (theme: string) => void;
      reportBug: (payload: { title: string; description: string; includeLogs: boolean }) => Promise<{
        ok: boolean;
        issueUrl?: string;
        issueNumber?: number;
        error?: string;
        blocked?: boolean;
        retryAfter?: number;
      }>;
    }
  }
}

const platform = window.api.platform;
const isMac = platform === 'darwin';
const isLinux = platform === 'linux';
const reloadShortcut = isMac ? 'Cmd + R' : 'Ctrl + R';

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

  const reloadKeys = document.getElementById('reloadKeys');
  if (reloadKeys) reloadKeys.textContent = reloadShortcut;
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
const toggleBtn = document.getElementById('toggleBtn') as HTMLButtonElement;
const btnText = document.getElementById('btnText')!;
const warningToast = document.getElementById('warningToast') as HTMLElement | null;
const toastClose = document.getElementById('toastClose') as HTMLButtonElement | null;
const proxyInput = document.getElementById('proxyInput') as HTMLInputElement;
const startupToggle = document.getElementById('startupToggle') as HTMLInputElement;
const themeBtn = document.getElementById('themeBtn') as HTMLButtonElement;

let currentState = 'INACTIVE';

// ---------------------------------------------------------------------------
// Toast de aviso — canto superior direito. Persistente: so fecha quando o
// usuario clica no "x" (sem auto-close). Reaparece ao ativar o bypass.
// ---------------------------------------------------------------------------
function setWarningOpen(open: boolean) {
  if (!warningToast) return;
  warningToast.hidden = !open;
}

toastClose?.addEventListener('click', () => setWarningOpen(false));

// Em dev mostra o toast automaticamente para validar layout sem precisar ativar
// @ts-ignore - import.meta.env vem do Vite
if ((import.meta as any).env?.DEV) {
  window.setTimeout(() => setWarningOpen(true), 700);
}

// ---------------------------------------------------------------------------
// Tema: botao alterna; inicia com o valor salvo.
// ---------------------------------------------------------------------------
themeBtn.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
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
    const status = await window.api.getStatus();
    currentState = status;
    
    statusIndicator.className = 'status-indicator';
    statusTag.className = 'status-tag';
    toggleBtn.disabled = false;
    toggleBtn.classList.remove('loading', 'deactivate', 'overwrite');

    if (status === 'ACTIVE') {
      statusText.innerText = 'GoLiveBypass está Ativo';
      statusTag.textContent = 'Ativo';
      statusTag.classList.add('tag--ok');
      btnText.innerText = 'Desativar Bypass';
      toggleBtn.classList.add('deactivate');
      statusCard.hidden = true;
    } else if (status === 'OTHER_MOD') {
      statusText.innerText = 'Outro mod detectado';
      statusTag.textContent = 'Conflito';
      statusTag.classList.add('tag--warn');
      btnText.innerText = 'Sobrescrever e Ativar';
      toggleBtn.classList.add('overwrite');
      statusCard.hidden = false;
    } else if (status === 'NOT_FOUND') {
      statusText.innerText = 'Discord não encontrado';
      statusTag.textContent = 'Ausente';
      statusTag.classList.add('tag--danger');
      toggleBtn.disabled = true;
      btnText.innerText = 'Não Disponível';
      statusCard.hidden = false;
    } else {
      statusText.innerText = 'Discord limpo. Pronto para injetar.';
      statusTag.textContent = 'Pronto';
      statusTag.classList.add('tag--ok');
      btnText.innerText = 'Ativar Bypass';
      statusCard.hidden = true;
    }
  } catch (err) {
    console.error(err);
    statusText.innerText = 'Erro ao buscar status';
    statusTag.textContent = 'Erro';
    statusTag.classList.add('tag--danger');
    statusCard.hidden = false;
  }
  // O updateStatus acabou de reabilitar o botao; se o modo e Tor e o daemon nao esta de pe,
  // a trava tem que valer por cima -- senao dava para injetar e ficar sem conectar.
  aplicarTravaDoTor();
  // Depois de mudar o estado, ajusta a janela ao novo tamanho do conteudo.
  fitWindowToContent();
}

toggleBtn.addEventListener('click', async () => {
  toggleBtn.disabled = true;
  toggleBtn.classList.add('loading');

  try {
    if (currentState === 'ACTIVE') {
      try {
        await window.api.deactivate();
      } catch (err) {
        // O script pode falhar (elevacao/sudo) DEPOIS de fechar o Discord. Em vez de
        // simplesmente alertar, deixa o botao travado e o status dirá "Desativar Bypass"
        // enquanto o disco continuar "nosso" — a pessoa sabe que a desinstalacao nao
        // aconteceu e pode fechar o cliente pra tentar de novo (o boot limpa a orfã).
        updateStatus();
        throw err;
      }
    } else {
      const proxy = proxyInput.value.trim();
      await window.api.activate(proxy);

      // Popup de aviso
      setWarningOpen(true);
    }
  } catch (err) {
    alert('Erro: ' + err);
  }

  await updateStatus();
  // O Tor sobe durante a ativacao, entao o texto lido na abertura da janela ja nasceu velho:
  // ficava em "aguardando ativacao" com o Tor de pe e o bypass funcionando.
  refreshTorStatus();
});

// Inicialização
applyPlatformCopy();
initTheme();
updateStatus();
refreshStartup();
refreshProxy();
refreshNetMode();
refreshTorStatus();
// O Tor pode subir depois (durante a ativacao) ou cair no meio; sem reconferir, o texto
// congela no que era verdade quando a janela abriu. A checagem custa um connect no loopback.
setInterval(refreshTorStatus, 5000);
fitWindowToContent();

async function refreshStartup() {
  try {
    startupToggle.checked = await window.api.getStartup();
  } catch (err) {
    console.error(err);
  }
}

// Preenche o campo de proxy com o valor salvo no settings.json (se houver),
// para a configuracao ficar visivel apos reiniciar o app.
async function refreshProxy() {
  try {
    proxyInput.value = await window.api.getProxy();
  } catch (err) {
    console.error(err);
  }
}

// ---------------------------------------------------------------------------
// Rede de saida: tres modos segmentados (Tor / Gratuitas / Personalizado).
// O padrao e TOR (o app instala e usa o Tor sempre). O campo de proxy so aparece
// no modo Personalizado.
// ---------------------------------------------------------------------------
const segBtns = Array.from(document.querySelectorAll<HTMLButtonElement>('.seg-btn'));
const torStatusEl = document.getElementById('torStatus') as HTMLElement;
const manualProxyGroup = document.getElementById('manualProxyGroup') as HTMLElement;

// O modo escolhido e se o Tor ja foi verificado: juntos decidem se o botao de ativar pode ser
// liberado. Injetar em modo Tor sem o daemon de pe deixa o Discord sem conectar -- o bypass
// segura o gateway em vez de vazar pelo IP brasileiro, entao o Discord fica sem rede nenhuma.
let modoAtual = 'tor';
let torPronto = false;

// Libera ou trava o botao conforme o Tor. Fora do modo Tor nao ha o que travar; o resto do
// estado (Discord ausente, etc.) continua mandando no updateStatus.
function aplicarTravaDoTor() {
  if (currentState === 'NOT_FOUND') return;
  if (modoAtual !== 'tor' || currentState === 'ACTIVE') return;

  if (torPronto) {
    toggleBtn.disabled = false;
    btnText.innerText = currentState === 'OTHER_MOD' ? 'Sobrescrever e Ativar' : 'Ativar Bypass';
    return;
  }

  toggleBtn.disabled = true;
  btnText.innerText = 'Aguardando o Tor...';
}

function selectMode(mode: string) {
  modoAtual = mode;
  for (const btn of segBtns) {
    const checked = btn.dataset.mode === mode;
    btn.setAttribute('aria-checked', String(checked));
    btn.classList.toggle('seg-btn--active', checked);
  }
  manualProxyGroup.hidden = mode !== 'manual';
  // O status do Tor so faz sentido no modo Tor; nos outros ele so confunde.
  torStatusEl.hidden = mode !== 'tor';
  // Fecha o guia VPS ao sair do Personalizado: se ficar aberto, a proxima visita ja nasce alta.
  if (mode !== 'manual') {
    const guide = manualProxyGroup.querySelector('details.vps-guide');
    if (guide) (guide as HTMLDetailsElement).open = false;
  }
  fitWindowToContent();
}

async function refreshNetMode() {
  try {
    const saved = await window.api.getNetMode();
    const proxy = await window.api.getProxy();
    // Mapeia o estado salvo para a UI de 3 opcoes:
    // - "free" -> Gratuitas (escolha explicita)
    // - "auto" com proxy preenchida -> Personalizado
    // - o resto ("tor", "auto" sem proxy, vazio) -> Tor, que e o padrao
    if (saved === 'free') selectMode('free');
    else if (saved === 'auto' && proxy) selectMode('manual');
    else selectMode('tor');
  } catch (err) {
    console.error(err);
  }
}

async function refreshTorStatus() {
  try {
    const st = await window.api.getTorStatus();
    torPronto = st.ativo;
    if (st.ativo) {
      torStatusEl.textContent = `Tor pronto (porta ${st.porta})`;
      torStatusEl.classList.add('tor-status--ok');
    } else if (st.presente) {
      torStatusEl.textContent = 'Tor baixado, preparando... o botao libera quando ele subir.';
      torStatusEl.classList.remove('tor-status--ok');
    } else {
      torStatusEl.textContent = 'Tor sera baixado automaticamente ao ativar.';
      torStatusEl.classList.remove('tor-status--ok');
    }
  } catch (err) {
    console.error(err);
  }
  // O botao depende disto: em modo Tor ele so libera com o daemon verificado.
  aplicarTravaDoTor();
}

for (const btn of segBtns) {
  btn.addEventListener('click', () => {
    const mode = btn.dataset.mode!;
    selectMode(mode);

    if (mode === 'tor') {
      // Prepara o Tor (baixa/sobe) — o padrao. Nao espera: o status atualiza.
      window.api.setNetMode('tor').catch(() => {});
      // Trava o botao na hora: ate o Tor estar de pe, injetar so deixaria o Discord sem
      // conectar. O refreshTorStatus (a cada 5s) libera quando ele subir.
      torPronto = false;
      aplicarTravaDoTor();
      window.api.installTor().then((r) => {
        torPronto = !!r.ok;
        torStatusEl.textContent = r.ok
          ? `Tor pronto (porta ${r.porta ?? 9060})`
          : `${r.error ?? 'nao consegui preparar o Tor'}`;
        torStatusEl.classList.toggle('tor-status--ok', !!r.ok);
        aplicarTravaDoTor();
      }).catch(() => {});
      fitWindowToContent();
    } else if (mode === 'free') {
      window.api.setNetMode('free').catch(() => {});
      // Fora do modo Tor nao ha o que esperar: devolve o botao.
      aplicarTravaDoTor();
      updateStatus();
    } else {
      // Personalizado: volta ao auto com a proxy do campo.
      window.api.setNetMode('auto').catch(() => {});
      aplicarTravaDoTor();
      updateStatus();
      fitWindowToContent();
    }
  });
}

const proxyTestBtn = document.getElementById('proxyTestBtn') as HTMLButtonElement;
const proxyTestStatus = document.getElementById('proxyTestStatus') as HTMLElement;

proxyTestBtn.addEventListener('click', async () => {
  const proxy = proxyInput.value.trim();
  proxyTestBtn.disabled = true;
  proxyTestStatus.classList.remove('proxy-test-status--ok', 'proxy-test-status--bad');
  proxyTestStatus.textContent = 'Testando túnel até o gateway...';
  fitWindowToContent();

  try {
    const r = await window.api.testProxy(proxy);
    if (r.ok) {
      proxyTestStatus.classList.add('proxy-test-status--ok');
      const geo = r.country ? ` · saída ${r.country}` : '';
      proxyTestStatus.textContent = `OK — túnel em ${r.ms ?? '?'}ms (${r.host}:${r.port})${geo}`;
    } else {
      proxyTestStatus.classList.add('proxy-test-status--bad');
      const geo = r.country ? ` [${r.country}]` : '';
      proxyTestStatus.textContent = `${r.error ?? 'Falha no teste'}${geo}`;
    }
  } catch (err) {
    proxyTestStatus.classList.add('proxy-test-status--bad');
    proxyTestStatus.textContent = err instanceof Error ? err.message : String(err);
  } finally {
    proxyTestBtn.disabled = false;
    fitWindowToContent();
  }
});

const vpsGuide = document.querySelector('.vps-guide');
if (vpsGuide) {
  vpsGuide.addEventListener('toggle', () => fitWindowToContent());
}

startupToggle.addEventListener('change', async () => {
  await window.api.setStartup(startupToggle.checked);
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

// O watchdog do Tor ressuscitou o daemon no meio da sessao: reabre o aviso do Ctrl+R
// (a reconexao do gateway pode travar o video ate um reload — armadilha conhecida).
window.api.onTorWatchdogRecuperado(() => setWarningOpen(true));

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
