export type ReleaseAlias =
  | 'windows'
  | 'linux'
  | 'mac-dmg'
  | 'mac-zip'
  | 'plugin'
  | 'plugin-sha'
  | 'standalone'
  | 'standalone-sha'

export type ReleaseAssetKey =
  | 'windowsGui'
  | 'macDmg'
  | 'macZip'
  | 'linuxGui'
  | 'plugin'
  | 'pluginSha'
  | 'standaloneJs'
  | 'standaloneSha'

export type ReleaseStatus = 'fallback' | 'loading' | 'ready' | 'stale' | 'error'

export interface ReleaseAsset {
  name: string
  url: string
}

export interface ReleaseCatalog {
  tag: string
  version: string
  name: string
  channel: 'stable'
  publishedAt: string
  pageUrl: string
  stale: boolean
  assets: Partial<Record<ReleaseAlias, ReleaseAsset>>
}

const owner = 'bezumiya'
const repo = 'GoLiveBypass'
const fallbackTag = 'v2.0.4'
const fallbackVersion = '2.0.4'
const repositoryUrl = `https://github.com/${owner}/${repo}`

export const release = {
  owner,
  repo,
  tag: fallbackTag,
  version: fallbackVersion,
  channel: 'stable',
  assets: {
    windowsGui: `GoLiveBypass-${fallbackVersion}.exe`,
    macDmg: 'GoLiveBypass.dmg',
    macZip: 'GoLiveBypass.zip',
    linuxGui: `GoLiveBypass-${fallbackVersion}.AppImage`,
    plugin: 'goLiveBypass-vencord.zip',
    pluginSha: 'goLiveBypass-vencord.zip.sha256',
    standaloneJs: `GoLiveBypass-${fallbackVersion}-bypass.js`,
    standaloneSha: `GoLiveBypass-${fallbackVersion}-bypass.js.sha256`,
  } satisfies Record<ReleaseAssetKey, string>,
} as const

export const githubRepositoryUrl = repositoryUrl
export const githubReleasePageUrl = `${repositoryUrl}/releases/tag/${release.tag}`

export function githubReleaseAssetUrl(asset: string, tag = release.tag) {
  return `${repositoryUrl}/releases/download/${tag}/${encodeURIComponent(asset)}`
}

export function githubRawUrl(path: string) {
  const encodedPath = path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')

  return `https://raw.githubusercontent.com/${owner}/${repo}/main/${encodedPath}`
}

export function releaseApiCatalogUrl(apiBaseUrl: string) {
  return `${apiBaseUrl.replace(/\/$/, '')}/v1/releases/latest`
}

export function releaseApiDownloadUrl(apiBaseUrl: string, alias: ReleaseAlias) {
  return `${apiBaseUrl.replace(/\/$/, '')}/v1/releases/latest/download/${encodeURIComponent(alias)}`
}

const fallbackAssets: Record<ReleaseAlias, ReleaseAsset> = {
  windows: { name: release.assets.windowsGui, url: githubReleaseAssetUrl(release.assets.windowsGui) },
  linux: { name: release.assets.linuxGui, url: githubReleaseAssetUrl(release.assets.linuxGui) },
  'mac-dmg': { name: release.assets.macDmg, url: githubReleaseAssetUrl(release.assets.macDmg) },
  'mac-zip': { name: release.assets.macZip, url: githubReleaseAssetUrl(release.assets.macZip) },
  plugin: { name: release.assets.plugin, url: githubReleaseAssetUrl(release.assets.plugin) },
  'plugin-sha': { name: release.assets.pluginSha, url: githubReleaseAssetUrl(release.assets.pluginSha) },
  standalone: { name: release.assets.standaloneJs, url: githubReleaseAssetUrl(release.assets.standaloneJs) },
  'standalone-sha': { name: release.assets.standaloneSha, url: githubReleaseAssetUrl(release.assets.standaloneSha) },
}

export const fallbackReleaseCatalog: ReleaseCatalog = {
  tag: release.tag,
  version: release.version,
  name: `GoLiveBypass ${release.version}`,
  channel: 'stable',
  publishedAt: '',
  pageUrl: githubReleasePageUrl,
  stale: false,
  assets: fallbackAssets,
}

export const downloads = {
  windowsGui: fallbackAssets.windows.url,
  macDmg: fallbackAssets['mac-dmg'].url,
  macZip: fallbackAssets['mac-zip'].url,
  linuxGui: fallbackAssets.linux.url,
  plugin: fallbackAssets.plugin.url,
  pluginSha: fallbackAssets['plugin-sha'].url,
  standaloneJs: fallbackAssets.standalone.url,
  standaloneSha: fallbackAssets['standalone-sha'].url,
  installerWindows: githubRawUrl('installer/GoLiveBypass-Installer.ps1'),
  installerPosix: githubRawUrl('installer/golivebypass-installer.sh'),
  standaloneWindows: githubRawUrl('standalone/GoLiveBypass-Standalone.ps1'),
  standaloneWindowsBat: githubRawUrl('standalone/GoLiveBypass-Standalone.bat'),
  standalonePosix: githubRawUrl('standalone/golivebypass-standalone.sh'),
}

const semver = /^\d+\.\d+\.\d+$/
const aliases: ReleaseAlias[] = ['windows', 'linux', 'mac-dmg', 'mac-zip', 'plugin', 'plugin-sha', 'standalone', 'standalone-sha']

export function parseReleaseCatalog(input: unknown): ReleaseCatalog | null {
  if (!input || typeof input !== 'object') return null
  const data = input as Record<string, unknown>
  if (data.channel !== 'stable' || typeof data.version !== 'string' || !semver.test(data.version)) return null
  if (typeof data.tag !== 'string' || !/^v?\d+\.\d+\.\d+$/.test(data.tag)) return null
  if (typeof data.page_url !== 'string' || !isHttpsUrl(data.page_url)) return null
  if (typeof data.name !== 'string' || typeof data.published_at !== 'string') return null

  const rawAssets = data.assets
  const parsedAssets: Partial<Record<ReleaseAlias, ReleaseAsset>> = {}
  if (rawAssets && typeof rawAssets === 'object') {
    for (const alias of aliases) {
      const rawAsset = (rawAssets as Record<string, unknown>)[alias]
      if (!rawAsset || typeof rawAsset !== 'object') continue
      const asset = rawAsset as Record<string, unknown>
      if (typeof asset.name === 'string' && typeof asset.url === 'string' && isHttpsUrl(asset.url)) {
        parsedAssets[alias] = { name: asset.name, url: asset.url }
      }
    }
  }

  return {
    tag: data.tag,
    version: data.version,
    name: data.name,
    channel: 'stable',
    publishedAt: data.published_at,
    pageUrl: data.page_url,
    stale: data.stale === true,
    assets: parsedAssets,
  }
}

function isHttpsUrl(value: string) {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}
