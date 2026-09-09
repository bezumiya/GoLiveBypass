<script setup lang="ts">
const { catalog, downloadUrl, asset } = useRelease()

useSeoMeta({
  title: 'Instalação',
  description: 'Instale a GUI v2 do GoLiveBypass com WireGuard por aplicativo e escolha Proton Otimizado ou um arquivo .conf.',
  ogTitle: 'Instalação — GoLiveBypass',
  ogDescription: 'O caminho atual para instalar e configurar a GUI do GoLiveBypass.',
  ogUrl: 'https://golivebypass.dev/instalacao',
})
</script>

<template>
  <div class="page-wrap site-container">
    <PageIntro
      eyebrow="GUIA DE INSTALAÇÃO"
      title="Instale a GUI v2 sem escolher no escuro."
      description="Baixe a release estável mais recente, abra a GUI e escolha como o Discord deve usar o túnel WireGuard. Os caminhos legados ficam separados para não misturar arquiteturas."
    />

    <section class="decision-panel reveal reveal--first" aria-labelledby="decision-title">
      <div class="decision-panel__heading">
        <div><span class="eyebrow">DECISÃO RÁPIDA</span><h2 id="decision-title">Qual caminho descreve você?</h2></div>
        <BaseIcon name="route" :size="25" />
      </div>
      <div class="decision-grid">
        <NuxtLink class="decision-card" to="#gui"><span class="decision-card__index">01</span><strong>Quero uma janela para ativar</strong><span>Use a GUI v2 para Windows, macOS ou Linux.</span><BaseIcon name="arrow-right" :size="16" /></NuxtLink>
        <NuxtLink class="decision-card" to="#rota"><span class="decision-card__index">02</span><strong>Quero uma rota automática</strong><span>Conecte o Proton Otimizado e deixe a GUI medir a rota.</span><BaseIcon name="arrow-right" :size="16" /></NuxtLink>
        <NuxtLink class="decision-card" to="#rota"><span class="decision-card__index">03</span><strong>Tenho um arquivo .conf</strong><span>Importe um perfil WireGuard próprio na GUI.</span><BaseIcon name="arrow-right" :size="16" /></NuxtLink>
        <NuxtLink class="decision-card" to="#legado"><span class="decision-card__index">04</span><strong>Já uso um caminho legado</strong><span>Veja a compatibilidade do plugin e do standalone.</span><BaseIcon name="arrow-right" :size="16" /></NuxtLink>
      </div>
    </section>

    <section id="gui" class="section section--page-section reveal reveal--second" aria-labelledby="install-gui-title">
      <div class="section-heading">
        <div><span class="eyebrow">CAMINHO PRINCIPAL · GUI V2</span><h2 id="install-gui-title">Uma instalação por sistema.</h2></div>
        <p>O aplicativo vanilla mantém o app.asar original e concentra a lógica de rede no túnel por aplicativo.</p>
      </div>
      <div class="prose-grid">
        <div class="prose-block">
          <h3>Passo a passo</h3>
          <ol class="numbered-list">
            <li><span>01</span><p>Baixe o instalador correspondente na <NuxtLink to="/downloads#gui">página de downloads</NuxtLink>. A página sempre resolve a stable atual.</p></li>
            <li><span>02</span><p>Abra a GUI e aguarde a detecção do Discord. O status mostra quando o processo está pronto.</p></li>
            <li><span>03</span><p>Escolha Proton Otimizado ou Arquivo .conf e configure a rota.</p></li>
            <li><span>04</span><p>Clique em Ativar Go Live. Só o Discord usa o túnel; o restante do computador mantém a rede normal.</p></li>
          </ol>
        </div>
        <div id="gui-linux" class="prose-block prose-block--note">
          <span class="icon-frame icon-frame--success"><BaseIcon name="check" :size="19" /></span>
          <h3>Detalhes por sistema</h3>
          <p><strong>Windows:</strong> o WireSock fornece o túnel por aplicativo. O SmartScreen pode pedir confirmação na primeira execução.</p>
          <p><strong>macOS:</strong> use o DMG ou o ZIP da release e revise a autorização solicitada pelo sistema.</p>
          <p><strong>Linux:</strong> torne o AppImage executável. O helper Linux aplica o isolamento suportado pela instalação.</p>
          <a class="text-link" :href="catalog.pageUrl" target="_blank" rel="noopener noreferrer">Ver notas da release <BaseIcon name="external" :size="15" /></a>
        </div>
      </div>
    </section>

    <section id="rota" class="section section--page-section reveal reveal--third" aria-labelledby="route-install-title">
      <div class="section-heading">
        <div><span class="eyebrow">DENTRO DA GUI</span><h2 id="route-install-title">Escolha a fonte da conexão.</h2></div>
        <p>As duas abas aparecem na GUI v2 e têm finalidades diferentes.</p>
      </div>
      <div class="comparison-grid">
        <article class="comparison-card comparison-card--yes">
          <div class="comparison-card__title"><span class="icon-frame icon-frame--success"><BaseIcon name="bolt" :size="18" /></span><h3>Proton Otimizado</h3></div>
          <ul class="feature-list"><li>Conecta uma conta Proton, inclusive gratuita</li><li>Mede as rotas disponíveis</li><li>Permite otimizar o servidor durante a sessão</li></ul>
        </article>
        <article class="comparison-card comparison-card--no">
          <div class="comparison-card__title"><span class="icon-frame icon-frame--muted"><BaseIcon name="file" :size="18" /></span><h3>Arquivo .conf</h3></div>
          <ul class="feature-list"><li>Importa seu perfil WireGuard</li><li>Testa a configuração antes de ativar</li><li>Não exige conta Proton na GUI</li></ul>
        </article>
      </div>
      <div class="info-note info-note--dark"><span class="icon-frame icon-frame--muted"><BaseIcon name="lock" :size="18" /></span><div><strong>A prévia do site é apenas visual.</strong><p>Os controles da réplica no index demonstram a GUI e não ativam rede, não coletam credenciais e não enviam arquivos.</p></div></div>
    </section>

    <section id="legado" class="section section--page-section reveal reveal--third" aria-labelledby="legacy-title">
      <div class="section-heading">
        <div><span class="eyebrow">COMPATIBILIDADE</span><h2 id="legacy-title">Caminhos legados, sem confusão.</h2></div>
        <p>O plugin e o standalone têm ciclos e estados próprios. Eles não são a GUI v2 e não compartilham o estado do WireSock.</p>
      </div>
      <div class="plugin-layout">
        <div class="prose-block">
          <h3>Plugin Vencord / Equicord</h3>
          <p>O transporte WireGuard autônomo é voltado para Windows x64 e para quem já usa um mod compatível. Baixe o ZIP diretamente da release estável e siga o README do próprio plugin.</p>
          <a v-if="asset('plugin')" class="text-link" :href="downloadUrl('plugin')" target="_blank" rel="noopener noreferrer">Baixar {{ asset('plugin')?.name }} <BaseIcon name="download" :size="15" /></a>
        </div>
        <div class="warning-card">
          <BaseIcon name="alert" :size="20" />
          <div><strong>Standalone é histórico.</strong><p>Use somente se você já precisa desse caminho. Não o trate como equivalente à GUI v2 e não o execute junto com outro transporte ativo.</p><a class="text-link" :href="catalog.pageUrl" target="_blank" rel="noopener noreferrer">Ver release e checksums <BaseIcon name="external" :size="15" /></a></div>
        </div>
      </div>
    </section>

    <section class="section section--aftercare" aria-labelledby="aftercare-title">
      <div class="section-heading section-heading--compact"><div><span class="eyebrow">DEPOIS DA INSTALAÇÃO</span><h2 id="aftercare-title">O que esperar na primeira abertura.</h2></div><NuxtLink class="text-link text-link--standalone" to="/faq">Ir para a FAQ <BaseIcon name="arrow-right" :size="16" /></NuxtLink></div>
      <div class="aftercare-grid">
        <article><span class="icon-frame icon-frame--success"><BaseIcon name="signal" :size="18" /></span><h3>Confira o status</h3><p>Ativo indica que o túnel e o processo foram iniciados. Não é uma prova geográfica de saída.</p></article>
        <article><span class="icon-frame icon-frame--warning"><BaseIcon name="refresh" :size="18" /></span><h3>Leia os diagnósticos</h3><p>Probes de IP, HTTP e telemetria ajudam nos logs, mas não impedem a ativação.</p></article>
        <article><span class="icon-frame icon-frame--muted"><BaseIcon name="book" :size="18" /></span><h3>Atualize pelo site</h3><p>Os botões consultam a stable mais recente; você não precisa editar uma versão no site.</p></article>
      </div>
    </section>

    <div class="section section--last"><DiscordCta /></div>
  </div>
</template>
