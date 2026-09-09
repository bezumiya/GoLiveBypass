<script setup lang="ts">
const { catalog } = useRelease()
</script>

<template>
  <div class="status-panel" aria-label="Prévia da interface do GoLiveBypass">
    <div class="window-chrome" aria-hidden="true">
      <span></span><span></span><span></span>
      <span class="window-chrome__caption">GoLiveBypass</span>
    </div>

    <div class="status-panel__body">
      <div class="status-panel__heading">
        <div class="status-panel__identity">
          <img src="/logo.svg" alt="" aria-hidden="true" />
          <div>
            <strong>GoLiveBypass</strong>
            <span>GO LIVE · BRASIL</span>
          </div>
        </div>
        <span class="status-panel__version">v{{ catalog.version }}</span>
      </div>

      <div class="status-line">
        <span class="status-dot" aria-hidden="true"></span>
        <span>Pronto para conectar</span>
        <span class="status-badge">STABLE</span>
      </div>

      <NuxtLink class="button button--primary status-panel__button" to="/downloads">
        <BaseIcon name="play" :size="17" />
        <span>Escolher download</span>
        <BaseIcon name="arrow-right" :size="16" />
      </NuxtLink>

      <div class="status-panel__details">
        <div>
          <span class="detail-label">Arquitetura</span>
          <strong>WireGuard por app</strong>
        </div>
        <div>
          <span class="detail-label">Escopo</span>
          <strong>Só o Discord</strong>
        </div>
      </div>
    </div>
  </div>
</template>
