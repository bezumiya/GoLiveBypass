<script setup lang="ts">
export type IconName =
  | 'alert'
  | 'apple'
  | 'arrow-right'
  | 'book'
  | 'bug'
  | 'bolt'
  | 'check'
  | 'chevron-down'
  | 'code'
  | 'copy'
  | 'discord'
  | 'download'
  | 'external'
  | 'file'
  | 'github'
  | 'layers'
  | 'linux'
  | 'lock'
  | 'menu'
  | 'minus'
  | 'moon'
  | 'play'
  | 'plus'
  | 'route'
  | 'signal'
  | 'refresh'
  | 'sun'
  | 'terminal'
  | 'windows'
  | 'x'
  | 'settings'
  | 'upload'

withDefaults(
  defineProps<{
    name: IconName
    size?: number
  }>(),
  {
    size: 20,
  },
)
</script>

<template>
  <svg
    class="base-icon"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <template v-if="name === 'alert'">
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h16.9a2 2 0 0 0 1.7-3l-8.5-14.1a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </template>
    <template v-else-if="name === 'apple'">
      <path d="M15.5 12.4c0-2.2 1.8-3.3 1.9-3.4a4.2 4.2 0 0 0-3.3-1.8c-1.4-.1-2.8.8-3.5.8s-1.8-.8-3-.8a4.5 4.5 0 0 0-3.8 2.3c-1.6 2.8-.4 7 1.1 9.3.8 1.1 1.6 2.3 2.8 2.2 1.1 0 1.6-.7 3-.7s1.8.7 3 .7c1.2 0 2-.1 2.8-1.3.9-1.3 1.3-2.5 1.3-2.6-.1 0-2.3-.9-2.3-4.7Z" />
      <path d="M13.3 5.7c.6-.7 1-1.7.9-2.7-.9 0-2 .6-2.6 1.3-.6.6-1.1 1.6-1 2.6 1 .1 2-.5 2.7-1.2Z" />
    </template>
    <template v-else-if="name === 'arrow-right'">
      <path d="M4 12h15" />
      <path d="m13 6 6 6-6 6" />
    </template>
    <template v-else-if="name === 'book'">
      <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21.5v-16Z" />
      <path d="M4 5.5v16" />
      <path d="M8 7h8M8 11h7" />
    </template>
    <template v-else-if="name === 'bug'">
      <path d="M9 8.5h6a3 3 0 0 1 3 3v3.2a5 5 0 0 1-5 5.3h-2a5 5 0 0 1-5-5.3v-3.2a3 3 0 0 1 3-3Z" />
      <path d="M9 8.5 8 5.8M15 8.5l1-2.7M5 12H2.5M21.5 12H19M6 16l-2 1.5M18 16l2 1.5M10 5.5V3M14 5.5V3" />
    </template>
    <template v-else-if="name === 'bolt'">
      <path d="m13.5 2-8 11h6l-1 9 8-12h-6l1-8Z" />
    </template>
    <template v-else-if="name === 'check'">
      <path d="m4.5 12.5 5 5L19.5 7" />
    </template>
    <template v-else-if="name === 'chevron-down'">
      <path d="m6 9 6 6 6-6" />
    </template>
    <template v-else-if="name === 'code'">
      <path d="m8 8-4 4 4 4M16 8l4 4-4 4M14 4l-4 16" />
    </template>
    <template v-else-if="name === 'copy'">
      <rect x="8" y="8" width="11" height="12" rx="1.5" />
      <path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v10A1.5 1.5 0 0 0 5.5 17H8" />
    </template>
    <template v-else-if="name === 'discord'">
      <path fill="currentColor" stroke="none" d="M19.7 3.8A16 16 0 0 0 15.5 2.5c-.2.4-.5.9-.7 1.4a14.5 14.5 0 0 0-5.6 0c-.2-.5-.5-1-.7-1.4A15.7 15.7 0 0 0 4.3 3.8C1.6 7.8.9 11.8 1.3 15.7a16.3 16.3 0 0 0 5.2 2.7c.4-.5.8-1.2 1.1-1.8-.6-.2-1.2-.5-1.8-.9.1-.1.3-.2.4-.3 3.4 1.6 7.1 1.6 10.5 0l.4.3c-.6.4-1.2.7-1.8.9.3.6.7 1.3 1.1 1.8a16.2 16.2 0 0 0 5.2-2.7c.4-4.5-.7-8.4-2.9-11.9ZM8.2 13.3c-1 0-1.9-.9-1.9-2.1S7.1 9 8.2 9s1.9.9 1.9 2.2-.8 2.1-1.9 2.1Zm7.6 0c-1 0-1.9-.9-1.9-2.1S14.7 9 15.8 9s1.9.9 1.9 2.2-.8 2.1-1.9 2.1Z" />
    </template>
    <template v-else-if="name === 'download'">
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M4 20h16" />
    </template>
    <template v-else-if="name === 'external'">
      <path d="M14 4h6v6" />
      <path d="m20 4-9 9" />
      <path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" />
    </template>
    <template v-else-if="name === 'file'">
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v5h4M9 13h6M9 17h6" />
    </template>
    <template v-else-if="name === 'github'">
      <path fill="currentColor" stroke="none" d="M12 2.3a10 10 0 0 0-3.2 19.5c.5.1.7-.2.7-.5v-1.9c-2.8.6-3.4-1.2-3.4-1.2-.5-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 0 1.5 1 1.5 1 .9 1.5 2.3 1.1 2.9.8.1-.7.3-1.1.6-1.4-2.2-.2-4.5-1.1-4.5-4.9 0-1.1.4-1.9 1-2.6-.1-.2-.4-1.2.1-2.5 0 0 .8-.3 2.7 1a9.4 9.4 0 0 1 4.9 0c1.9-1.3 2.7-1 2.7-1 .5 1.3.2 2.3.1 2.5.6.7 1 1.5 1 2.6 0 3.8-2.3 4.7-4.5 4.9.4.3.7 1 .7 1.9v2.8c0 .3.2.6.7.5A10 10 0 0 0 12 2.3Z" />
    </template>
    <template v-else-if="name === 'layers'">
      <path d="m12 3 9 5-9 5-9-5 9-5Z" />
      <path d="m3 12 9 5 9-5M3 16l9 5 9-5" />
    </template>
    <template v-else-if="name === 'linux'">
      <path d="M12 3.5c-2.1 0-3.3 2-3.3 4.2 0 1.2-.4 2.4-1 3.5-.6 1.1-1.7 2.4-1.7 4 0 2 1.6 3.3 3.4 3.3.8 0 1.6-.3 2.6-.3s1.8.3 2.6.3c1.8 0 3.4-1.3 3.4-3.3 0-1.6-1.1-2.9-1.7-4-.6-1.1-1-2.3-1-3.5 0-2.2-1.2-4.2-3.3-4.2Z" />
      <path d="M8.8 14.1h.01M15.2 14.1h.01M9 17c1.7.8 4.3.8 6 0" />
    </template>
    <template v-else-if="name === 'lock'">
      <rect x="5" y="10" width="14" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" />
    </template>
    <template v-else-if="name === 'menu'">
      <path d="M4 7h16M4 12h16M4 17h16" />
    </template>
    <template v-else-if="name === 'minus'">
      <path d="M5 12h14" />
    </template>
    <template v-else-if="name === 'moon'">
      <path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5 8.8 8.8 0 1 0 20.5 14.2Z" />
    </template>
    <template v-else-if="name === 'plus'">
      <path d="M12 5v14M5 12h14" />
    </template>
    <template v-else-if="name === 'play'">
      <path fill="currentColor" stroke="none" d="M8 5.4v13.2a1 1 0 0 0 1.5.9l10.8-6.6a1 1 0 0 0 0-1.8L9.5 4.5A1 1 0 0 0 8 5.4Z" />
    </template>
    <template v-else-if="name === 'route'">
      <circle cx="6" cy="6" r="2.2" />
      <circle cx="18" cy="18" r="2.2" />
      <path d="M8 6h3a3 3 0 0 1 3 3v3a3 3 0 0 0 3 3h.8" />
    </template>
    <template v-else-if="name === 'refresh'">
      <path d="M20 11a8 8 0 0 0-14.7-3L4 10" />
      <path d="M4 5v5h5M4 13a8 8 0 0 0 14.7 3L20 14" />
      <path d="M20 19v-5h-5" />
    </template>
    <template v-else-if="name === 'signal'">
      <path d="M4 17a11.3 11.3 0 0 1 16 0M7 14a7 7 0 0 1 10 0M10 11a2.8 2.8 0 0 1 4 0M12 20h.01" />
    </template>
    <template v-else-if="name === 'sun'">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </template>
    <template v-else-if="name === 'settings'">
      <path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z" />
      <path d="m19.4 15 .1.1a1.7 1.7 0 0 1-2.4 2.4l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a1.7 1.7 0 0 1-3.4 0v-.2a1.7 1.7 0 0 0-2.9-1.2l-.1.1a1.7 1.7 0 0 1-2.4-2.4l.1-.1a1.7 1.7 0 0 0-1.2-2.9h-.2a1.7 1.7 0 0 1 0-3.4h.2a1.7 1.7 0 0 0 1.2-2.9l-.1-.1a1.7 1.7 0 0 1 2.4-2.4l.1.1a1.7 1.7 0 0 0 2.9-1.2V2a1.7 1.7 0 0 1 3.4 0v.2a1.7 1.7 0 0 0 2.9 1.2l.1-.1a1.7 1.7 0 0 1 2.4 2.4l-.1.1a1.7 1.7 0 0 0 1.2 2.9h.2a1.7 1.7 0 0 1 0 3.4h-.2a1.7 1.7 0 0 0-1.2 2.9Z" />
    </template>
    <template v-else-if="name === 'upload'">
      <path d="M12 16V4M7 9l5-5 5 5M5 20h14" />
    </template>
    <template v-else-if="name === 'terminal'">
      <path d="m5 7 5 5-5 5M13 17h6" />
    </template>
    <template v-else-if="name === 'windows'">
      <path d="m3 5.5 8-1.1v7.1H3V5.5ZM13 4.2l8-1.2v8.5h-8V4.2ZM3 13.5h8v7.1l-8-1.1v-6ZM13 13.5h8v8.5l-8-1.2v-7.3Z" />
    </template>
    <template v-else-if="name === 'x'">
      <path d="m6 6 12 12M18 6 6 18" />
    </template>
  </svg>
</template>
