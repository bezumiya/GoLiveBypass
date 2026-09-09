<script setup lang="ts">
import { githubRepositoryUrl } from '~/data/release'

useSeoMeta({
  title: 'Como funciona',
  description: 'Entenda a arquitetura WireGuard por aplicativo do GoLiveBypass, com WireSock no Windows e helper no Linux.',
  ogTitle: 'Como funciona — GoLiveBypass',
  ogDescription: 'Uma explicação curta sobre o túnel por aplicativo, rotas e diagnósticos do GoLiveBypass.',
  ogUrl: 'https://golivebypass.dev/como-funciona',
})
</script>

<template>
  <div class="page-wrap site-container">
    <PageIntro
      eyebrow="POR DENTRO DO PROJETO"
      title="Um túnel para o aplicativo certo."
      description="A GUI v2 usa WireGuard por aplicativo: o Discord entra no túnel e o restante do computador continua na sua rede normal."
    />

    <section class="explanation-hero reveal reveal--first" aria-labelledby="explanation-title">
      <div class="explanation-hero__copy">
        <span class="eyebrow">ARQUITETURA ATUAL</span>
        <h2 id="explanation-title">WireGuard por aplicativo.</h2>
        <p>No Windows, a GUI usa WireSock para iniciar o transporte do Discord. No Linux, o helper aplica o isolamento suportado pela instalação. O app.asar permanece vanilla: a mudança acontece no caminho de rede do processo, não na lógica interna do Discord.</p>
        <a class="text-link" :href="`${githubRepositoryUrl}#arquitetura`" target="_blank" rel="noopener noreferrer">Ler a explicação completa no GitHub <BaseIcon name="external" :size="15" /></a>
      </div>
      <div class="explanation-hero__mark" aria-hidden="true"><div class="mark-ring mark-ring--outer"></div><div class="mark-ring mark-ring--inner"></div><span class="mark-center"><BaseIcon name="route" :size="26" /></span></div>
    </section>

    <section id="rota" class="section section--page-section" aria-labelledby="route-title">
      <div class="section-heading">
        <div><span class="eyebrow">ROTEAMENTO POR APLICATIVO</span><h2 id="route-title">Um processo dentro do túnel.</h2></div>
        <p>A regra de escopo é a parte mais importante: ativar o GoLiveBypass não transforma a rede inteira do computador.</p>
      </div>

      <div class="flow-diagram">
        <div class="flow-column flow-column--client">
          <span class="flow-column__label">No seu computador</span>
          <div class="flow-node"><span><BaseIcon name="code" :size="18" /></span><strong>Discord</strong><small>processo selecionado</small></div>
          <div class="flow-node flow-node--router"><span><BaseIcon name="route" :size="18" /></span><strong>WireSock / helper</strong><small>túnel local</small></div>
        </div>
        <div class="flow-column flow-column--paths">
          <div class="flow-connection flow-connection--gateway"><span class="flow-connection__line"></span><span class="flow-connection__label"><strong>Discord</strong><small>usa WireGuard</small></span></div>
          <div class="flow-connection flow-connection--media"><span class="flow-connection__line"></span><span class="flow-connection__label"><strong>Outros apps</strong><small>rede normal</small></span></div>
        </div>
        <div class="flow-column flow-column--discord">
          <span class="flow-column__label">Saídas do computador</span>
          <div class="flow-node flow-node--gateway"><span><BaseIcon name="signal" :size="18" /></span><strong>Rota WireGuard</strong><small>somente Discord</small></div>
          <div class="flow-node flow-node--media"><span><BaseIcon name="layers" :size="18" /></span><strong>Conexão normal</strong><small>outros processos</small></div>
        </div>
      </div>
    </section>

    <section class="section section--page-section" aria-labelledby="what-title">
      <div class="section-heading"><div><span class="eyebrow">SEM SURPRESAS</span><h2 id="what-title">O que muda e o que permanece.</h2></div></div>
      <div class="comparison-grid">
        <article class="comparison-card comparison-card--yes"><div class="comparison-card__title"><span class="icon-frame icon-frame--success"><BaseIcon name="check" :size="18" /></span><h3>Entra no túnel</h3></div><ul class="feature-list"><li>Processo do Discord selecionado pela GUI</li><li>Rotas da aba Proton ou do arquivo .conf</li><li>WireSock no Windows e helper no Linux</li></ul></article>
        <article class="comparison-card comparison-card--no"><div class="comparison-card__title"><span class="icon-frame icon-frame--muted"><BaseIcon name="signal" :size="18" /></span><h3>Fica na rede normal</h3></div><ul class="feature-list"><li>Outros aplicativos do computador</li><li>Serviços do sistema fora do escopo do Discord</li><li>Qualquer tráfego que a GUI não selecionou</li></ul></article>
      </div>
    </section>

    <section class="section section--page-section" aria-labelledby="limits-title">
      <div class="section-heading section-heading--compact"><div><span class="eyebrow">LIMITES CONHECIDOS</span><h2 id="limits-title">Estado ativo não é prova geográfica.</h2></div><NuxtLink class="text-link text-link--standalone" to="/faq#diagnostics">Ver diagnósticos <BaseIcon name="arrow-right" :size="16" /></NuxtLink></div>
      <div class="limits-grid">
        <article><BaseIcon name="alert" :size="19" /><h3>Saída depende da rota</h3><p>O status ativo confirma que túnel e processo foram iniciados. Ele não comprova sozinho a localização ou a qualidade da saída.</p></article>
        <article><BaseIcon name="refresh" :size="19" /><h3>Probes são diagnóstico</h3><p>IP, HTTP e telemetria ajudam nos logs. Eles não bloqueiam a ativação nem derrubam o Discord quando falham.</p></article>
        <article><BaseIcon name="lock" :size="19" /><h3>Escopo é intencional</h3><p>A GUI não altera o app.asar e não promete paridade entre GUI, plugin e standalone. Cada caminho tem seu próprio estado.</p></article>
      </div>
    </section>

    <div class="section section--last"><DiscordCta /></div>
  </div>
</template>
