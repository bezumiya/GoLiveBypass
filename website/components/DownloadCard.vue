<script setup lang="ts">
import type { IconName } from './BaseIcon.vue'

defineProps<{
  icon: IconName
  kicker: string
  title: string
  description: string
  meta: string
  primaryLabel: string
  primaryHref?: string
  secondaryLabel?: string
  secondaryHref?: string
  tone?: 'default' | 'success' | 'discord' | 'warning'
}>()
</script>

<template>
  <article class="download-card" :class="`download-card--${tone ?? 'default'}`">
    <div class="download-card__top">
      <span class="icon-frame"><BaseIcon :name="icon" :size="21" /></span>
      <span class="download-card__kicker">{{ kicker }}</span>
    </div>
    <h3>{{ title }}</h3>
    <p>{{ description }}</p>
    <div class="download-card__meta">{{ meta }}</div>
    <div class="download-card__actions">
      <a
        v-if="primaryHref"
        class="button button--small button--primary"
        :href="primaryHref"
        target="_blank"
        rel="noopener noreferrer"
      >
        <BaseIcon name="download" :size="16" />
        {{ primaryLabel }}
      </a>
      <span v-else class="button button--small button--secondary download-card__button-disabled" aria-disabled="true">
        {{ primaryLabel }}
      </span>
      <NuxtLink
        v-if="secondaryLabel && secondaryHref && secondaryHref.startsWith('/')"
        class="button button--small button--secondary"
        :to="secondaryHref"
      >
        {{ secondaryLabel }}
      </NuxtLink>
      <a
        v-else-if="secondaryLabel && secondaryHref"
        class="button button--small button--secondary"
        :href="secondaryHref"
        target="_blank"
        rel="noopener noreferrer"
      >
        {{ secondaryLabel }}
      </a>
    </div>
  </article>
</template>
