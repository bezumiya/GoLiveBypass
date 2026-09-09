export default defineNuxtConfig({
  devtools: { enabled: false },
  css: ['~/assets/css/main.css'],
  typescript: {
    strict: true,
    typeCheck: true,
  },
  app: {
    head: {
      htmlAttrs: {
        lang: 'pt-BR',
      },
      meta: [
        {
          name: 'theme-color',
          content: '#0F0F12',
        },
        {
          name: 'description',
          content:
            'GUI do GoLiveBypass com WireGuard por aplicativo: só o Discord usa o túnel, com downloads estáveis sempre atualizados.',
        },
      ],
      link: [
        {
          rel: 'icon',
          type: 'image/svg+xml',
          href: '/favicon.svg',
        },
      ],
      script: [
        {
          innerHTML: `try {
  var savedTheme = localStorage.getItem('golivebypass-theme');
  document.documentElement.dataset.theme = savedTheme === 'light' ? 'light' : 'dark';
} catch (error) {
  document.documentElement.dataset.theme = 'dark';
}`,
          tagPosition: 'head',
        },
      ],
    },
  },
  runtimeConfig: {
    public: {
      releaseApiBaseUrl: process.env.NUXT_PUBLIC_RELEASE_API_BASE_URL || 'https://api.skyplaceia.com/bugs',
    },
  },
})
