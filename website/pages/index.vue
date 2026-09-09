<script setup lang="ts">
import { githubRepositoryUrl } from '~/data/release'

const { catalog } = useRelease()

useSeoMeta({
  title: 'Go Live de volta ao Discord',
  description:
    'GoLiveBypass usa WireGuard por aplicativo: só o Discord entra no túnel, com a release estável mais recente sempre disponível.',
  ogTitle: 'GoLiveBypass — Go Live de volta ao Discord',
  ogDescription:
    'GUI v2 para devolver o Go Live e a câmera no Discord sem alterar a rede do restante do computador.',
  ogUrl: 'https://golivebypass.dev/',
})
</script>

<template>
  <div>
    <section class="hero site-container">
      <div class="hero__copy reveal reveal--first">
        <span class="eyebrow">GO LIVE · BRASIL</span>
        <h1>Go Live de volta ao Discord.</h1>
        <p class="hero__lead">
          A GUI v2 cria uma conexão WireGuard por aplicativo: o Discord usa o túnel e o restante do computador mantém sua rede normal. Baixe sempre a release estável mais recente.
        </p>
        <div class="hero__actions">
          <NuxtLink class="button button--primary" to="/downloads">
            <BaseIcon name="download" :size="17" />
            Escolher instalação
            <BaseIcon name="arrow-right" :size="16" />
          </NuxtLink>
          <a
            class="button button--secondary"
            :href="githubRepositoryUrl"
            target="_blank"
            rel="noopener noreferrer"
          >
            <BaseIcon name="github" :size="17" />
            Ver no GitHub
          </a>
        </div>
        <div class="hero__meta">
          <span>Windows</span>
          <span>macOS</span>
          <span>Linux</span>
          <span>WireGuard por aplicativo</span>
        </div>
      </div>

      <div class="hero__visual reveal reveal--second">
        <GuiViewer />
        <div class="hero__note">
          <span class="status-dot" aria-hidden="true"></span>
          <span>Release estável <strong>v{{ catalog.version }}</strong></span>
        </div>
      </div>
    </section>

    <div class="site-container product-strip reveal reveal--third" aria-label="Arquitetura disponível">
      <div>
        <span class="product-strip__value">02</span>
        <span class="product-strip__label">fontes de conexão</span>
      </div>
      <div>
        <span class="product-strip__value">03</span>
        <span class="product-strip__label">sistemas desktop</span>
      </div>
      <div>
        <span class="product-strip__value">01</span>
        <span class="product-strip__label">túnel só para o Discord</span>
      </div>
    </div>

    <section id="paths" class="section site-container">
      <div class="section-heading">
        <div>
          <span class="eyebrow">POR ONDE COMEÇAR</span>
          <h2>Use o caminho que já combina com seu Discord.</h2>
        </div>
        <p>A GUI v2 concentra a ativação e oferece duas formas de escolher a rota do Discord.</p>
      </div>

      <div class="path-grid">
        <PathCard
          icon="layers"
          eyebrow="INTERFACE DESKTOP"
          title="Quero a GUI v2"
          description="Ative, desative e acompanhe o túnel do Discord sem abrir o terminal."
          link-label="Ver downloads da GUI"
          to="/downloads#gui"
        />
        <PathCard
          icon="terminal"
          eyebrow="POUCOS COMANDOS"
          title="Quero Proton otimizado"
          description="Conecte uma conta Proton e deixe a GUI medir e escolher a melhor rota."
          link-label="Ver como funciona"
          to="/como-funciona#rota"
        />
        <PathCard
          icon="code"
          eyebrow="PARA QUEM JÁ USA MOD"
          title="Tenho um arquivo .conf"
          description="Importe um perfil WireGuard próprio pela segunda aba de conexão."
          link-label="Abrir instalação"
          to="/instalacao#gui"
        />
        <PathCard
          icon="route"
          eyebrow="DISCORD PURO"
          title="Uso um caminho legado"
          description="Plugin e standalone continuam documentados separadamente, sem confundir a arquitetura da GUI atual."
          link-label="Ver compatibilidade"
          to="/instalacao#legado"
        />
      </div>
    </section>

    <section class="section section--route">
      <div class="site-container route-section">
        <div class="section-heading section-heading--compact">
          <div>
            <span class="eyebrow">A IDEIA CENTRAL</span>
            <h2>Uma regra pequena para o que precisa mudar.</h2>
          </div>
          <NuxtLink class="text-link text-link--standalone" to="/como-funciona">
            Ver como funciona
            <BaseIcon name="arrow-right" :size="16" />
          </NuxtLink>
        </div>

        <div class="route-card">
          <div class="route-card__intro">
            <span class="icon-frame icon-frame--success"><BaseIcon name="route" :size="21" /></span>
            <div>
              <h3>WireGuard por aplicativo.</h3>
              <p>Só o processo do Discord usa o túnel; a rede do restante do computador permanece normal.</p>
            </div>
          </div>
          <div class="route-schematic" aria-label="Discord dentro do túnel WireGuard por aplicativo">
            <div class="route-node">
              <span class="route-node__icon"><BaseIcon name="code" :size="18" /></span>
              <strong>Discord</strong>
              <small>processo alvo</small>
            </div>
            <div class="route-path route-path--routed">
              <span class="route-path__line"></span>
              <span class="route-path__label">processo · no túnel</span>
            </div>
            <div class="route-node route-node--active">
              <span class="route-node__icon"><BaseIcon name="route" :size="18" /></span>
              <strong>WireGuard</strong>
              <small>WireSock / helper</small>
            </div>
            <div class="route-path route-path--direct">
              <span class="route-path__line"></span>
              <span class="route-path__label">restante · rede normal</span>
            </div>
            <div class="route-node">
              <span class="route-node__icon"><BaseIcon name="signal" :size="18" /></span>
              <strong>Computador</strong>
              <small>outros apps</small>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section class="section site-container">
      <div class="section-heading">
        <div>
          <span class="eyebrow">O FLUXO</span>
          <h2>Da escolha ao primeiro Go Live.</h2>
        </div>
        <p>A GUI separa a ativação do túnel, a escolha da rota e os diagnósticos necessários.</p>
      </div>
      <div class="steps-grid">
        <article class="step-item">
          <span class="step-index">01</span>
          <h3>Escolha a rota</h3>
          <p>Use Proton Otimizado ou importe um arquivo .conf na GUI v2.</p>
        </article>
        <article class="step-item">
          <span class="step-index">02</span>
          <h3>Instale a GUI</h3>
          <p>Baixe o asset estável indicado para Windows, macOS ou Linux.</p>
        </article>
        <article class="step-item">
          <span class="step-index">03</span>
          <h3>Ative</h3>
          <p>Abra o Discord, ative o túnel e use os diagnósticos como apoio, não como bloqueio.</p>
        </article>
      </div>
    </section>

    <section class="section section--faq-preview site-container">
      <div class="section-heading section-heading--compact">
        <div>
          <span class="eyebrow">ANTES DE INSTALAR</span>
          <h2>Respostas para as dúvidas mais comuns.</h2>
        </div>
        <NuxtLink class="text-link text-link--standalone" to="/faq">
          Abrir FAQ completa
          <BaseIcon name="arrow-right" :size="16" />
        </NuxtLink>
      </div>
      <div class="faq-preview-grid">
        <NuxtLink class="faq-preview-card" to="/faq#scope">
          <span class="faq-preview-card__number">01</span>
          <h3>O que entra no túnel?</h3>
          <p>Somente o Discord. Os outros aplicativos continuam usando a conexão normal do computador.</p>
          <BaseIcon name="arrow-right" :size="17" />
        </NuxtLink>
        <NuxtLink class="faq-preview-card" to="/faq#route">
          <span class="faq-preview-card__number">02</span>
          <h3>Proton ou arquivo .conf?</h3>
          <p>Proton escolhe a rota automaticamente; o arquivo .conf serve para um perfil WireGuard próprio.</p>
          <BaseIcon name="arrow-right" :size="17" />
        </NuxtLink>
        <NuxtLink class="faq-preview-card" to="/faq#diagnostics">
          <span class="faq-preview-card__number">03</span>
          <h3>Os diagnósticos bloqueiam a ativação?</h3>
          <p>Não. Probes de IP, HTTP e telemetria ajudam nos logs, mas não derrubam o Discord.</p>
          <BaseIcon name="arrow-right" :size="17" />
        </NuxtLink>
      </div>
    </section>

    <div class="site-container section section--last">
      <DiscordCta />
    </div>
  </div>
</template>
