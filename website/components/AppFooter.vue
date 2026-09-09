<script setup lang="ts">
import { githubRepositoryUrl } from '~/data/release'

const { catalog } = useRelease()
</script>

<template>
  <footer class="site-footer">
    <div class="site-container footer-grid">
      <div class="footer-brand">
        <NuxtLink class="brand" to="/" aria-label="GoLiveBypass, início">
          <img class="brand-mark" src="/logo.svg" alt="" aria-hidden="true" />
          <span class="brand-name">GoLiveBypass</span>
        </NuxtLink>
        <p>Uma porta de entrada simples para devolver o Go Live e a câmera no Discord, no Brasil.</p>
      </div>

      <div class="footer-column">
        <span class="footer-label">Navegar</span>
        <NuxtLink to="/downloads">Downloads</NuxtLink>
        <NuxtLink to="/instalacao">Instalação</NuxtLink>
        <NuxtLink to="/como-funciona">Como funciona</NuxtLink>
        <NuxtLink to="/faq">FAQ</NuxtLink>
      </div>

      <div class="footer-column">
        <span class="footer-label">Projeto</span>
        <a :href="githubRepositoryUrl" target="_blank" rel="noopener noreferrer">
          <BaseIcon name="github" :size="15" />
          GitHub
        </a>
        <a href="https://discord.gg/7cWbtr82rG" target="_blank" rel="noopener noreferrer">
          <BaseIcon name="discord" :size="15" />
          Discord
        </a>
        <a :href="`${githubRepositoryUrl}/blob/main/LICENSE`" target="_blank" rel="noopener noreferrer">
          Licença GPL-3.0
        </a>
      </div>
    </div>

    <div class="site-container footer-bottom">
      <span>GoLiveBypass {{ catalog.version }} · canal {{ catalog.channel }}</span>
      <span>Open source. Feito para a comunidade.</span>
    </div>
  </footer>
</template>
