import {
  fallbackReleaseCatalog,
  parseReleaseCatalog,
  releaseApiCatalogUrl,
  releaseApiDownloadUrl,
  type ReleaseAlias,
  type ReleaseCatalog,
  type ReleaseStatus,
} from '~/data/release'

export function useRelease() {
  const runtimeConfig = useRuntimeConfig()
  const catalog = useState<ReleaseCatalog>('release-catalog', () => fallbackReleaseCatalog)
  const status = useState<ReleaseStatus>('release-status', () => 'fallback')
  const hasLoaded = useState('release-has-loaded', () => false)
  const isLoading = useState('release-is-loading', () => false)

  const apiBaseUrl = computed(() => {
    const configured = runtimeConfig.public.releaseApiBaseUrl
    return typeof configured === 'string' && configured.trim() ? configured.trim() : 'https://api.skyplaceia.com/bugs'
  })

  const load = async () => {
    if (isLoading.value || hasLoaded.value) return
    isLoading.value = true
    status.value = 'loading'
    try {
      const payload = await $fetch<unknown>(releaseApiCatalogUrl(apiBaseUrl.value))
      const nextCatalog = parseReleaseCatalog(payload)
      if (!nextCatalog) throw new Error('catálogo de release inválido')
      catalog.value = nextCatalog
      status.value = nextCatalog.stale ? 'stale' : 'ready'
    } catch {
      status.value = 'error'
    } finally {
      hasLoaded.value = true
      isLoading.value = false
    }
  }

  if (import.meta.client) {
    onMounted(load)
  }

  const downloadUrl = (alias: ReleaseAlias) => releaseApiDownloadUrl(apiBaseUrl.value, alias)
  const asset = (alias: ReleaseAlias) => catalog.value.assets[alias]

  return {
    catalog,
    status,
    apiBaseUrl,
    downloadUrl,
    asset,
    refresh: load,
  }
}
