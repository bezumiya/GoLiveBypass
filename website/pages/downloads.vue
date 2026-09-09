<script setup lang="ts">
import type { Platform } from '~/components/PlatformTabs.vue'

const { catalog, status, downloadUrl, asset } = useRelease()

const releaseStateLabel = computed(() => {
  if (status.value === 'stale') return 'cache anterior'
  if (status.value === 'error') return 'fallback local'
  if (status.value === 'loading') return 'consultando API'
  return 'catálogo atualizado'
})

useSeoMeta({
  title: 'Downloads',
  description: 'Baixe a GUI WireGuard do GoLiveBypass pela release estável mais recente para Windows, macOS ou Linux.',
  ogTitle: 'Downloads — GoLiveBypass',
  ogDescription: 'Downloads estáveis sempre apontando para a release atual do GoLiveBypass.',
  ogUrl: 'https://golivebypass.dev/downloads',
})

const selectedPlatform = ref<Platform>('windows')

onMounted(() => {
  const userAgent = navigator.userAgent.toLowerCase()
  if (userAgent.includes('mac')) selectedPlatform.value = 'macos'
  if (userAgent.includes('linux')) selectedPlatform.value = 'linux'
})
</script>

<template>
  <div class="page-wrap site-container">
    <PageIntro
      eyebrow="BAIXAR O PROJETO"
      title="A release estável mais recente, sempre aqui."
      description="A página consulta o catálogo GoLiveBypass e mantém os botões apontando para a versão estável atual. O fallback local existe apenas para a primeira renderização ou uma indisponibilidade temporária."
    />

    <section id="gui" class="release-banner reveal reveal--first">
      <div class="release-banner__copy">
        <span class="release-banner__label"><span class="status-dot" aria-hidden="true"></span> Release estável · {{ releaseStateLabel }}</span>
        <h2>GoLiveBypass <code>v{{ catalog.version }}</code></h2>
        <p>Canal stable. Os downloads usam aliases da API e resolvem o asset atual no momento do clique.</p>
      </div>
      <a class="text-link" :href="catalog.pageUrl" target="_blank" rel="noopener noreferrer">
        Ver release no GitHub
        <BaseIcon name="external" :size="16" />
      </a>
    </section>

    <section class="section section--page-section reveal reveal--second" aria-labelledby="gui-title">
      <div class="section-heading section-heading--compact">
        <div>
          <span class="eyebrow">INTERFACE GRÁFICA · V2</span>
          <h2 id="gui-title">Baixe a GUI WireGuard</h2>
        </div>
        <p>Escolha o instalador do seu sistema. A GUI roteia somente o Discord e mantém o restante do computador na rede normal.</p>
      </div>

      <PlatformTabs v-model="selectedPlatform" />

      <div v-if="selectedPlatform === 'windows'" id="platform-panel-windows" class="platform-panel" role="tabpanel" aria-labelledby="platform-tab-windows">
        <DownloadCard
          icon="windows"
          kicker="WINDOWS"
          title="Aplicativo para Windows"
          description="A GUI usa WireSock para criar o túnel por aplicativo e oferece Proton Otimizado ou arquivo .conf."
          :meta="`${asset('windows')?.name ?? `GoLiveBypass-${catalog.version}.exe`} · canal ${catalog.channel}`"
          primary-label="Baixar para Windows"
          :primary-href="asset('windows') ? downloadUrl('windows') : undefined"
          secondary-label="Abrir release"
          :secondary-href="catalog.pageUrl"
          tone="success"
        />
        <div class="platform-note">
          <BaseIcon name="alert" :size="17" />
          <p>O Windows pode exibir um aviso do SmartScreen na primeira abertura. Confira a assinatura e o hash na página da release se precisar validar o arquivo.</p>
        </div>
      </div>

      <div v-else-if="selectedPlatform === 'macos'" id="platform-panel-macos" class="platform-panel" role="tabpanel" aria-labelledby="platform-tab-macos">
        <DownloadCard
          icon="apple"
          kicker="MACOS"
          title="Aplicativo para macOS"
          description="Baixe o pacote DMG da release estável. O ZIP alternativo fica disponível no segundo botão."
          :meta="`${asset('mac-dmg')?.name ?? 'GoLiveBypass.dmg'} · canal ${catalog.channel}`"
          primary-label="Baixar DMG"
          :primary-href="asset('mac-dmg') ? downloadUrl('mac-dmg') : undefined"
          secondary-label="Baixar ZIP"
          :secondary-href="asset('mac-zip') ? downloadUrl('mac-zip') : undefined"
          tone="success"
        />
        <div class="platform-note">
          <BaseIcon name="lock" :size="17" />
          <p>Se o pacote não estiver no catálogo da release atual, a própria página mostra o botão indisponível em vez de apontar para um arquivo antigo.</p>
        </div>
      </div>

      <div v-else id="platform-panel-linux" class="platform-panel" role="tabpanel" aria-labelledby="platform-tab-linux">
        <DownloadCard
          icon="linux"
          kicker="LINUX"
          title="AppImage para Linux"
          description="Um arquivo portátil para distribuições desktop compatíveis com Electron."
          :meta="`${asset('linux')?.name ?? `GoLiveBypass-${catalog.version}.AppImage`} · canal ${catalog.channel}`"
          primary-label="Baixar AppImage"
          :primary-href="asset('linux') ? downloadUrl('linux') : undefined"
          secondary-label="Ver instruções"
          secondary-href="/instalacao#gui-linux"
        />
        <div class="platform-note">
          <BaseIcon name="terminal" :size="17" />
          <p>Depois do download, dê permissão de execução com <code>chmod +x GoLiveBypass-*.AppImage</code>. O helper Linux cuida do isolamento aplicável ao processo.</p>
        </div>
      </div>
    </section>

    <section id="compatibilidade" class="section section--page-section reveal reveal--third" aria-labelledby="compatibility-title">
      <div class="section-heading">
        <div>
          <span class="eyebrow">CAMINHOS COMPLEMENTARES</span>
          <h2 id="compatibility-title">Plugin atual e legado separados.</h2>
        </div>
        <p>Esses arquivos não alteram o download principal da GUI. Use-os somente se você já conhece o caminho correspondente.</p>
      </div>

      <div class="download-grid">
        <DownloadCard
          icon="layers"
          kicker="WINDOWS X64 · MOD"
          title="Plugin Vencord / Equicord"
          description="Transporte WireGuard autônomo para quem já usa um mod compatível. Não compartilha estado com a GUI."
          :meta="`${asset('plugin')?.name ?? 'goLiveBypass-vencord.zip'} · canal ${catalog.channel}`"
          primary-label="Baixar plugin"
          :primary-href="asset('plugin') ? downloadUrl('plugin') : undefined"
          secondary-label="Abrir release"
          :secondary-href="catalog.pageUrl"
        />
        <DownloadCard
          icon="code"
          kicker="LEGADO"
          title="Standalone"
          description="Caminho histórico mantido para compatibilidade. Não confunda este arquivo com a arquitetura WireGuard por aplicativo da GUI v2."
          :meta="`${asset('standalone')?.name ?? `GoLiveBypass-${catalog.version}-bypass.js`} · canal ${catalog.channel}`"
          primary-label="Baixar standalone"
          :primary-href="asset('standalone') ? downloadUrl('standalone') : undefined"
          secondary-label="Ler instalação"
          secondary-href="/instalacao#legado"
        />
      </div>
    </section>

    <section class="info-note reveal reveal--third">
      <span class="icon-frame icon-frame--muted"><BaseIcon name="refresh" :size="18" /></span>
      <div>
        <strong>Sincronização automática</strong>
        <p>A API consulta apenas a última release estável do GitHub, rejeita prereleases e guarda a última resposta válida por cinco minutos. Uma publicação estável invalida o cache pelo webhook.</p>
      </div>
    </section>

    <div class="section section--last">
      <DiscordCta />
    </div>
  </div>
</template>
