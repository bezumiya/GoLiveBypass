<script setup lang="ts">
const { catalog } = useRelease()

const active = ref(false)
const startupEnabled = ref(true)
const connectionTab = ref<'proton' | 'conf'>('proton')
const accountConnected = ref(false)
const routeOptimized = ref(false)
const confImported = ref(false)
const settingsOpen = ref(false)
const autoUpdateEnabled = ref(true)
const automaticRouteEnabled = ref(true)
const betaEnabled = ref(false)

const statusLabel = computed(() => (active.value ? 'Ativo' : 'Pronto'))
const statusMessage = computed(() => (active.value ? 'Túnel do Discord ativo.' : 'Discord pronto para conectar.'))
const routeLabel = computed(() => (routeOptimized.value ? 'Servidor otimizado' : 'Rota automática'))

function toggleDemo() {
  active.value = !active.value
}

function connectDemoAccount() {
  accountConnected.value = true
  routeOptimized.value = false
}

function optimizeDemoRoute() {
  routeOptimized.value = true
}

function importDemoConfig() {
  confImported.value = true
}
</script>

<template>
  <section class="gui-viewer" aria-label="Demonstração da GUI v2 do GoLiveBypass">
    <div class="gui-viewer__chrome">
      <div class="gui-viewer__dots" aria-hidden="true"><span></span><span></span><span></span></div>
      <span class="gui-viewer__chrome-caption">GoLiveBypass</span>
      <span class="gui-viewer__demo-badge">Demonstração no site</span>
      <a class="gui-viewer__icon-btn" href="https://github.com/bezumiya/GoLiveBypass/issues" target="_blank" rel="noopener noreferrer" aria-label="Reportar um bug">
        <BaseIcon name="bug" :size="16" />
      </a>
      <a class="gui-viewer__icon-btn" href="https://discord.gg/ZeNs47vE4R" target="_blank" rel="noopener noreferrer" aria-label="Abrir suporte no Discord">
        <BaseIcon name="discord" :size="16" />
      </a>
      <button class="gui-viewer__icon-btn" type="button" aria-label="Abrir configurações da demonstração" @click="settingsOpen = true">
        <BaseIcon name="settings" :size="16" />
      </button>
    </div>

    <div class="gui-viewer__surface">
      <header class="gui-viewer__header">
        <div class="gui-viewer__wordmark-group">
          <span class="gui-viewer__wordmark"><img src="/logo.svg" alt="" aria-hidden="true" draggable="false" /> GoLiveBypass</span>
          <span class="gui-viewer__meta">Go Live · Brasil · v{{ catalog.version }}</span>
        </div>
        <p class="gui-viewer__tagline">Devolve o Go Live e a câmera no Discord, no Brasil.</p>
      </header>

      <div class="gui-viewer__columns">
        <section class="gui-viewer__action-column" aria-label="Controle do bypass">
          <div class="gui-viewer__section-label">Ação principal</div>
          <p class="gui-viewer__section-description">Libere o Go Live no Discord usando a rota escolhida ao lado.</p>

          <div class="gui-viewer__status-card" role="status" aria-live="polite">
            <span class="gui-viewer__status-indicator" :class="{ 'gui-viewer__status-indicator--active': active }" aria-hidden="true"></span>
            <span>{{ statusMessage }}</span>
            <span class="gui-viewer__status-tag">{{ statusLabel }}</span>
          </div>

          <button class="gui-viewer__toggle-btn" :class="{ 'gui-viewer__toggle-btn--active': active }" type="button" :aria-pressed="active" @click="toggleDemo">
            <BaseIcon :name="active ? 'check' : 'play'" :size="17" />
            <span>{{ active ? 'Desativar túnel' : 'Ativar Go Live' }}</span>
          </button>

          <label class="gui-viewer__switch">
            <input v-model="startupEnabled" type="checkbox" />
            <span class="gui-viewer__switch-track" aria-hidden="true"><span class="gui-viewer__switch-thumb"></span></span>
            <span>Iniciar com o Windows</span>
          </label>
          <p class="gui-viewer__scope-note"><BaseIcon name="route" :size="14" /> Só o Discord usa o túnel.</p>
        </section>

        <section class="gui-viewer__connection-column" aria-labelledby="gui-viewer-connection-title">
          <div class="gui-viewer__connection-card">
            <div class="gui-viewer__connection-heading">
              <div>
                <div class="gui-viewer__section-label">Conexão segura</div>
                <h2 id="gui-viewer-connection-title">Escolha como rotear o Discord</h2>
              </div>
              <BaseIcon name="bolt" :size="18" />
            </div>

            <div class="gui-viewer__tabs" role="tablist" aria-label="Fonte da conexão">
              <button class="gui-viewer__tab" :class="{ 'gui-viewer__tab--active': connectionTab === 'proton' }" type="button" role="tab" :aria-selected="connectionTab === 'proton'" @click="connectionTab = 'proton'">
                <BaseIcon name="bolt" :size="13" /><span>Proton Otimizado</span>
              </button>
              <button class="gui-viewer__tab" :class="{ 'gui-viewer__tab--active': connectionTab === 'conf' }" type="button" role="tab" :aria-selected="connectionTab === 'conf'" @click="connectionTab = 'conf'">
                <BaseIcon name="code" :size="13" /><span>Arquivo .conf</span>
              </button>
            </div>

            <div v-if="connectionTab === 'proton'" class="gui-viewer__connection-panel" role="tabpanel">
              <template v-if="!accountConnected">
                <div class="gui-viewer__route-card">
                  <span class="gui-viewer__route-icon"><BaseIcon name="route" :size="17" /></span>
                  <div><strong>{{ routeLabel }}</strong><p>Encontra a melhor região entre as rotas disponíveis.</p></div>
                </div>
                <div class="gui-viewer__measurement"><span>Download</span><strong>medido ao conectar</strong><span>Upload</span><strong>medido ao conectar</strong></div>
                <button class="gui-viewer__primary-action" type="button" @click="connectDemoAccount"><BaseIcon name="signal" :size="16" /> Conectar conta Proton</button>
                <p class="gui-viewer__fine-print">A conta grátis já é suficiente. Esta prévia não coleta credenciais.</p>
              </template>
              <template v-else>
                <div class="gui-viewer__account-row"><span class="gui-viewer__account-avatar">P</span><div><strong>Conta conectada</strong><small>Plano: gratuito</small></div><span class="gui-viewer__online-dot"></span></div>
                <div class="gui-viewer__route-card gui-viewer__route-card--connected"><span class="gui-viewer__route-icon"><BaseIcon name="route" :size="17" /></span><div><strong>{{ routeLabel }}</strong><p>{{ routeOptimized ? 'Menor latência encontrada para esta sessão.' : 'Escolha uma rota para começar.' }}</p></div></div>
                <button class="gui-viewer__secondary-action" type="button" @click="optimizeDemoRoute"><BaseIcon name="bolt" :size="15" /> Otimizar rota</button>
                <div class="gui-viewer__server-line"><span>Rota selecionada</span><strong>{{ routeOptimized ? 'Servidor otimizado' : 'Automática' }}</strong><small>{{ routeOptimized ? '42 ms · carga baixa' : 'Aguardando medição' }}</small></div>
              </template>
            </div>

            <div v-else class="gui-viewer__connection-panel" role="tabpanel">
              <div class="gui-viewer__drop-zone" :class="{ 'gui-viewer__drop-zone--loaded': confImported }" role="button" tabindex="0" @click="importDemoConfig" @keydown.enter.prevent="importDemoConfig" @keydown.space.prevent="importDemoConfig">
                <BaseIcon :name="confImported ? 'check' : 'upload'" :size="22" />
                <strong>{{ confImported ? 'Arquivo .conf importado' : 'Solte seu arquivo .conf aqui' }}</strong>
                <span>{{ confImported ? 'Pronto para testar a configuração.' : 'ou clique para procurar' }}</span>
              </div>
              <div class="gui-viewer__conf-status"><span class="gui-viewer__status-indicator" :class="{ 'gui-viewer__status-indicator--active': confImported }"></span>{{ confImported ? 'Configuração pronta' : 'Nenhum arquivo importado' }}</div>
              <div class="gui-viewer__conf-actions"><button class="gui-viewer__secondary-action" type="button" :disabled="!confImported" @click="importDemoConfig">Importar</button><button class="gui-viewer__secondary-action" type="button" :disabled="!confImported">Testar</button></div>
            </div>
          </div>
        </section>
      </div>

      <footer class="gui-viewer__footer"><span><BaseIcon name="lock" :size="12" /> Ações nesta área são demonstrativas.</span><NuxtLink to="/downloads#gui">Baixar GUI v{{ catalog.version }} <BaseIcon name="arrow-right" :size="13" /></NuxtLink></footer>
    </div>

    <div v-if="settingsOpen" class="gui-viewer__settings-dialog" role="dialog" aria-modal="true" aria-labelledby="gui-viewer-settings-title">
      <button class="gui-viewer__settings-backdrop" type="button" aria-label="Fechar configurações" @click="settingsOpen = false"></button>
      <div class="gui-viewer__settings-panel" role="document">
        <div class="gui-viewer__settings-header"><div><span class="gui-viewer__section-label">Preferências</span><h2 id="gui-viewer-settings-title">Configurações</h2></div><button class="gui-viewer__icon-btn" type="button" aria-label="Fechar configurações" @click="settingsOpen = false"><BaseIcon name="x" :size="16" /></button></div>
        <label class="gui-viewer__settings-switch"><input v-model="autoUpdateEnabled" type="checkbox" /><span class="gui-viewer__switch-track" aria-hidden="true"><span class="gui-viewer__switch-thumb"></span></span><span>Avisar sobre atualizações</span></label>
        <label class="gui-viewer__settings-switch"><input v-model="automaticRouteEnabled" type="checkbox" /><span class="gui-viewer__switch-track" aria-hidden="true"><span class="gui-viewer__switch-thumb"></span></span><span>Troca automática de rota</span></label>
        <label class="gui-viewer__settings-switch"><input v-model="betaEnabled" type="checkbox" /><span class="gui-viewer__switch-track" aria-hidden="true"><span class="gui-viewer__switch-thumb"></span></span><span>Canal beta</span></label>
        <p class="gui-viewer__settings-hint">O site distribui somente releases stable. O canal beta é opt-in dentro da GUI.</p>
        <button class="gui-viewer__settings-close" type="button" @click="settingsOpen = false">Fechar</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.gui-viewer {
  --gui-canvas: #0f0f12;
  --gui-surface: #1a1a1f;
  --gui-surface-muted: #232329;
  --gui-ink: #e6e6ea;
  --gui-ink-strong: #f5f5f7;
  --gui-muted: #a6a6b0;
  --gui-faint: #6f6f7a;
  --gui-line: #26262d;
  --gui-line-strong: #34343c;
  --gui-ok-bg: #16301b;
  --gui-ok-ink: #7bc98c;
  --gui-go-bg: #bce0bf;
  --gui-go-ink: #0f3318;
  --gui-go-hover: #aed8b2;
  position: relative;
  isolation: isolate;
  width: 100%;
  container-type: inline-size;
  overflow: hidden;
  border: 1px solid var(--gui-line-strong);
  border-radius: 16px;
  background: var(--gui-canvas);
  color: var(--gui-ink);
  box-shadow: 0 18px 50px rgba(0, 0, 0, .25);
  color-scheme: dark;
}

:global(html[data-theme='light']) .gui-viewer { --gui-canvas: #f7f6f3; --gui-surface: #fff; --gui-surface-muted: #f1f0ee; --gui-ink: #2f3437; --gui-ink-strong: #111; --gui-muted: #6e6c68; --gui-faint: #a8a29e; --gui-line: #eaeaea; --gui-line-strong: #d9d9d7; --gui-ok-bg: #edf3ec; --gui-ok-ink: #346538; --gui-go-bg: #cfe8d0; --gui-go-ink: #1e5b28; --gui-go-hover: #c1e0c3; color-scheme: light; }
.gui-viewer, .gui-viewer * { box-sizing: border-box; }
.gui-viewer :where(button, a) { font-family: inherit; -webkit-tap-highlight-color: transparent; }
.gui-viewer button:focus-visible, .gui-viewer a:focus-visible, .gui-viewer [tabindex]:focus-visible { outline: 2px solid var(--gui-ink-strong); outline-offset: 3px; }
.gui-viewer__chrome { display: flex; height: 38px; align-items: center; gap: 7px; padding: 0 12px 0 16px; border-bottom: 1px solid var(--gui-line); background: var(--gui-surface-muted); }
.gui-viewer__dots { display: flex; gap: 6px; }.gui-viewer__dots span { width: 7px; height: 7px; border-radius: 50%; background: var(--gui-line-strong); }
.gui-viewer__chrome-caption, .gui-viewer__demo-badge { color: var(--gui-faint); font-family: var(--mono); font-size: 9px; letter-spacing: .08em; text-transform: uppercase; }.gui-viewer__demo-badge { margin-left: auto; color: var(--gui-ok-ink); font-size: 8px; }
.gui-viewer__icon-btn { display: grid; width: 30px; height: 30px; flex: 0 0 auto; place-items: center; border: 1px solid transparent; border-radius: 7px; background: transparent; color: var(--gui-muted); cursor: pointer; text-decoration: none; transition: .16s ease; }.gui-viewer__icon-btn:hover { border-color: var(--gui-line-strong); background: var(--gui-surface); color: var(--gui-ink); }
.gui-viewer__surface { display: flex; flex-direction: column; gap: 20px; padding: 24px; }.gui-viewer__header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }.gui-viewer__wordmark-group { display: flex; min-width: 0; flex-direction: column; gap: 7px; }.gui-viewer__wordmark { display: inline-flex; align-items: center; gap: 9px; color: var(--gui-ink-strong); font-size: 21px; font-weight: 700; letter-spacing: -.04em; }.gui-viewer__wordmark img { width: 23px; height: 23px; border-radius: 6px; }.gui-viewer__meta { color: var(--gui-faint); font-family: var(--mono); font-size: 9px; letter-spacing: .13em; text-transform: uppercase; }.gui-viewer__tagline { max-width: 26ch; color: var(--gui-muted); font-size: 11px; line-height: 1.5; text-align: right; }
.gui-viewer__columns { display: grid; grid-template-columns: minmax(190px, .76fr) minmax(280px, 1.24fr); gap: 16px; }.gui-viewer__action-column, .gui-viewer__connection-card { min-width: 0; }.gui-viewer__section-label { color: var(--gui-faint); font-family: var(--mono); font-size: 8px; font-weight: 700; letter-spacing: .13em; text-transform: uppercase; }.gui-viewer h2 { margin: 7px 0 0; color: var(--gui-ink-strong); font-size: 16px; letter-spacing: -.035em; line-height: 1.15; }.gui-viewer__section-description { margin-top: 8px; color: var(--gui-muted); font-size: 11px; line-height: 1.5; }.gui-viewer__status-card { display: flex; min-height: 46px; align-items: center; gap: 8px; margin-top: 16px; padding: 10px; border: 1px solid var(--gui-line); border-radius: 9px; background: var(--gui-surface); color: var(--gui-ink); font-size: 10px; }.gui-viewer__status-tag { margin-left: auto; padding: 3px 6px; border-radius: 99px; background: var(--gui-ok-bg); color: var(--gui-ok-ink); font-family: var(--mono); font-size: 8px; text-transform: uppercase; }.gui-viewer__status-indicator { width: 7px; height: 7px; flex: 0 0 auto; border-radius: 50%; background: var(--gui-faint); }.gui-viewer__status-indicator--active { background: var(--gui-ok-ink); box-shadow: 0 0 0 3px color-mix(in srgb, var(--gui-ok-ink) 15%, transparent); }
.gui-viewer__toggle-btn, .gui-viewer__primary-action { display: flex; min-height: 44px; width: 100%; align-items: center; justify-content: center; gap: 8px; margin-top: 10px; border: 0; border-radius: 8px; background: var(--gui-go-bg); color: var(--gui-go-ink); cursor: pointer; font-size: 11px; font-weight: 700; transition: .16s ease; }.gui-viewer__toggle-btn:hover, .gui-viewer__primary-action:hover { background: var(--gui-go-hover); }.gui-viewer__toggle-btn--active { background: var(--gui-ok-bg); color: var(--gui-ok-ink); }.gui-viewer__toggle-btn--active:hover { background: color-mix(in srgb, var(--gui-ok-bg) 82%, var(--gui-ok-ink)); }
.gui-viewer__switch, .gui-viewer__settings-switch { position: relative; display: flex; min-height: 38px; align-items: center; gap: 8px; color: var(--gui-muted); cursor: pointer; font-size: 10px; user-select: none; }.gui-viewer__switch input, .gui-viewer__settings-switch input { position: absolute; width: 1px; height: 1px; opacity: 0; }.gui-viewer__switch-track { position: relative; width: 29px; height: 17px; flex: 0 0 auto; border: 1px solid var(--gui-line-strong); border-radius: 99px; background: var(--gui-surface-muted); transition: .16s ease; }.gui-viewer__switch-thumb { position: absolute; top: 1px; left: 1px; width: 13px; height: 13px; border-radius: 50%; background: var(--gui-surface); transition: .16s ease; }.gui-viewer__switch input:checked + .gui-viewer__switch-track, .gui-viewer__settings-switch input:checked + .gui-viewer__switch-track { border-color: var(--gui-ink-strong); background: var(--gui-ink-strong); }.gui-viewer__switch input:checked + .gui-viewer__switch-track .gui-viewer__switch-thumb, .gui-viewer__settings-switch input:checked + .gui-viewer__switch-track .gui-viewer__switch-thumb { transform: translateX(12px); }.gui-viewer__switch input:checked + .gui-viewer__switch-track .gui-viewer__switch-thumb { background: var(--gui-canvas); }.gui-viewer__scope-note { display: flex; align-items: center; gap: 6px; margin-top: 8px; color: var(--gui-ok-ink); font-family: var(--mono); font-size: 9px; line-height: 1.4; }
.gui-viewer__connection-card { padding: 14px; border: 1px solid var(--gui-line); border-radius: 11px; background: var(--gui-surface); }.gui-viewer__connection-heading { display: flex; justify-content: space-between; gap: 12px; }.gui-viewer__connection-heading > .base-icon { color: var(--gui-ok-ink); }.gui-viewer__tabs { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; margin-top: 14px; padding: 3px; border: 1px solid var(--gui-line-strong); border-radius: 8px; background: var(--gui-surface-muted); }.gui-viewer__tab { display: flex; min-height: 38px; flex-direction: column; align-items: center; justify-content: center; gap: 2px; border: 0; border-radius: 6px; background: transparent; color: var(--gui-muted); cursor: pointer; font-size: 9px; }.gui-viewer__tab small { color: var(--gui-faint); font-family: var(--mono); font-size: 7px; text-transform: uppercase; }.gui-viewer__tab--active { background: var(--gui-ink-strong); color: var(--gui-canvas); }.gui-viewer__tab--active small { color: currentColor; opacity: .65; }.gui-viewer__connection-panel { padding-top: 13px; }.gui-viewer__route-card { display: flex; align-items: flex-start; gap: 9px; padding: 10px; border: 1px solid var(--gui-line-strong); border-radius: 8px; background: var(--gui-surface-muted); }.gui-viewer__route-icon { display: grid; width: 27px; height: 27px; flex: 0 0 auto; place-items: center; border-radius: 7px; background: var(--gui-ok-bg); color: var(--gui-ok-ink); }.gui-viewer__route-card strong, .gui-viewer__account-row strong { display: block; color: var(--gui-ink); font-size: 10px; }.gui-viewer__route-card p, .gui-viewer__account-row small { display: block; margin-top: 3px; color: var(--gui-muted); font-size: 9px; line-height: 1.35; }.gui-viewer__measurement { display: grid; grid-template-columns: 1fr auto; gap: 5px 8px; margin-top: 10px; color: var(--gui-faint); font-family: var(--mono); font-size: 8px; }.gui-viewer__measurement strong { color: var(--gui-muted); font-weight: 500; text-align: right; }.gui-viewer__fine-print { margin-top: 8px; color: var(--gui-faint); font-size: 8px; line-height: 1.45; text-align: center; }.gui-viewer__account-row { display: flex; align-items: center; gap: 8px; padding-bottom: 10px; border-bottom: 1px solid var(--gui-line); }.gui-viewer__account-avatar { display: grid; width: 25px; height: 25px; place-items: center; border-radius: 50%; background: #6d5dd3; color: #fff; font-size: 11px; font-weight: 700; }.gui-viewer__online-dot { width: 6px; height: 6px; margin-left: auto; border-radius: 50%; background: var(--gui-ok-ink); }.gui-viewer__route-card--connected { margin-top: 10px; }.gui-viewer__secondary-action { display: inline-flex; min-height: 32px; align-items: center; justify-content: center; gap: 6px; padding: 0 10px; border: 1px solid var(--gui-line-strong); border-radius: 7px; background: var(--gui-surface); color: var(--gui-ink); cursor: pointer; font-size: 9px; font-weight: 600; }.gui-viewer__secondary-action:hover:not(:disabled) { background: var(--gui-surface-muted); }.gui-viewer__secondary-action:disabled { cursor: not-allowed; opacity: .45; }.gui-viewer__server-line { display: grid; grid-template-columns: 1fr auto; gap: 3px 8px; margin-top: 10px; padding: 8px 0 0; border-top: 1px solid var(--gui-line); color: var(--gui-faint); font-family: var(--mono); font-size: 8px; }.gui-viewer__server-line strong { color: var(--gui-ok-ink); font-weight: 600; text-align: right; }.gui-viewer__server-line small { grid-column: 2; text-align: right; }.gui-viewer__drop-zone { display: flex; min-height: 104px; flex-direction: column; align-items: center; justify-content: center; gap: 6px; border: 1px dashed var(--gui-line-strong); border-radius: 8px; color: var(--gui-muted); cursor: pointer; text-align: center; }.gui-viewer__drop-zone:hover, .gui-viewer__drop-zone--loaded { border-color: var(--gui-ok-ink); color: var(--gui-ok-ink); }.gui-viewer__drop-zone strong { font-size: 10px; }.gui-viewer__drop-zone span { color: var(--gui-faint); font-size: 9px; }.gui-viewer__conf-status { display: flex; align-items: center; gap: 7px; margin-top: 10px; color: var(--gui-muted); font-family: var(--mono); font-size: 8px; }.gui-viewer__conf-actions { display: flex; gap: 7px; margin-top: 10px; }
.gui-viewer__footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-top: 2px; color: var(--gui-faint); font-size: 8px; }.gui-viewer__footer span, .gui-viewer__footer a { display: inline-flex; align-items: center; gap: 5px; }.gui-viewer__footer a { color: var(--gui-muted); text-decoration: none; }.gui-viewer__footer a:hover { color: var(--gui-ink); }
.gui-viewer__settings-dialog { position: absolute; z-index: 5; inset: 0; display: flex; align-items: center; justify-content: center; padding: 20px; }.gui-viewer__settings-backdrop { position: absolute; inset: 0; border: 0; background: rgba(0, 0, 0, .58); cursor: pointer; }.gui-viewer__settings-panel { position: relative; width: min(100%, 300px); padding: 17px; border: 1px solid var(--gui-line-strong); border-radius: 11px; background: var(--gui-surface); box-shadow: 0 16px 40px rgba(0, 0, 0, .35); }.gui-viewer__settings-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }.gui-viewer__settings-panel h2 { margin-top: 5px; }.gui-viewer__settings-switch { margin-top: 15px; }.gui-viewer__settings-hint { margin-top: 10px; color: var(--gui-faint); font-size: 9px; line-height: 1.45; }.gui-viewer__settings-close { width: 100%; min-height: 34px; margin-top: 15px; border: 1px solid var(--gui-line-strong); border-radius: 7px; background: var(--gui-surface-muted); color: var(--gui-ink); cursor: pointer; font-size: 10px; font-weight: 600; }
/* Match the portable app's centered header and equal control panels. */
.gui-viewer__surface { padding: 32px 24px 24px; gap: 26px; }
.gui-viewer__header { flex-direction: column; align-items: center; gap: 10px; text-align: center; }
.gui-viewer__wordmark-group { align-items: center; }
.gui-viewer__wordmark { font-size: 24px; }
.gui-viewer__tagline { max-width: 38ch; font-size: 13.5px; text-align: center; }
.gui-viewer__columns { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.gui-viewer__action-column { display: flex; flex-direction: column; justify-content: center; gap: 12px; padding: 18px; border: 1px solid var(--gui-line-strong); border-radius: 14px; background: var(--gui-surface); }
.gui-viewer__action-column .gui-viewer__section-label,
.gui-viewer__section-description { text-align: center; }
.gui-viewer__section-description { margin: 0; font-size: 11px; }
.gui-viewer__status-card { order: -1; margin: 0; background: var(--gui-surface-muted); }
.gui-viewer__toggle-btn { margin: 0; min-height: 46px; font-size: 13px; }
.gui-viewer__switch, .gui-viewer__scope-note { justify-content: center; margin: 0; }
.gui-viewer__connection-column { min-width: 0; }
.gui-viewer__connection-card { height: 100%; padding: 18px; border-radius: 14px; }
.gui-viewer__tabs { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.gui-viewer__tab { min-width: 0; flex-direction: row; gap: 5px; padding: 8px 4px; font-size: 11px; font-weight: 600; }
.gui-viewer__primary-action { font-size: 12px; }
.gui-viewer__route-card strong { font-size: 11px; }
.gui-viewer__route-card p { font-size: 10px; }
.gui-viewer__fine-print, .gui-viewer__footer { font-size: 10px; }
.gui-viewer__measurement { font-size: 9px; }
.gui-viewer__switch input:focus-visible + .gui-viewer__switch-track,
.gui-viewer__settings-switch input:focus-visible + .gui-viewer__switch-track { outline: 2px solid var(--gui-ink-strong); outline-offset: 3px; }
@container (max-width: 620px) {
  .gui-viewer__surface { padding: 24px 16px 18px; gap: 20px; }
  .gui-viewer__columns { grid-template-columns: minmax(0, 1fr); }
  .gui-viewer__footer { align-items: center; flex-direction: column; text-align: center; }
  .gui-viewer__demo-badge { display: none; }
  .gui-viewer__chrome-caption { margin-right: auto; }
}
</style>
