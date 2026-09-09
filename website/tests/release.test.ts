import { describe, expect, it } from 'vitest'
import {
  downloads,
  fallbackReleaseCatalog,
  githubRawUrl,
  parseReleaseCatalog,
  release,
  releaseApiCatalogUrl,
  releaseApiDownloadUrl,
} from '../data/release'
import { terminalCommands } from '../data/install'

describe('release catalog', () => {
  it('mantém apenas um fallback de emergência da stable atual', () => {
    expect(release.version).toBe('2.0.4')
    expect(fallbackReleaseCatalog.channel).toBe('stable')
    expect(downloads.windowsGui).toContain('/releases/download/v2.0.4/')
  })

  it('monta os endpoints do catálogo e dos aliases', () => {
    expect(releaseApiCatalogUrl('https://api.example/bugs/')).toBe('https://api.example/bugs/v1/releases/latest')
    expect(releaseApiDownloadUrl('https://api.example/bugs', 'windows')).toBe(
      'https://api.example/bugs/v1/releases/latest/download/windows',
    )
    expect(githubRawUrl('installer/golivebypass-installer.sh')).toBe(
      'https://raw.githubusercontent.com/bezumiya/GoLiveBypass/main/installer/golivebypass-installer.sh',
    )
  })

  it('valida o payload estável e descarta URLs inseguras', () => {
    const parsed = parseReleaseCatalog({
      tag: 'v2.0.5',
      version: '2.0.5',
      name: 'GoLiveBypass 2.0.5',
      channel: 'stable',
      published_at: '2026-09-07T12:00:00Z',
      page_url: 'https://github.com/bezumiya/GoLiveBypass/releases/tag/v2.0.5',
      stale: false,
      assets: {
        windows: { name: 'GoLiveBypass-2.0.5.exe', url: 'https://github.com/a.exe' },
        linux: { name: 'GoLiveBypass-2.0.5.AppImage', url: 'http://github.com/a.AppImage' },
      },
    })
    expect(parsed?.version).toBe('2.0.5')
    expect(parsed?.assets.windows?.url).toBe('https://github.com/a.exe')
    expect(parsed?.assets.linux).toBeUndefined()
    expect(parseReleaseCatalog({ channel: 'beta', version: '2.0.5' })).toBeNull()
    expect(parseReleaseCatalog({ channel: 'stable', version: '2.0.5', tag: 'v2.0.5', name: 'x', published_at: '', page_url: 'http://evil' })).toBeNull()
  })

  it('preserva os comandos legados apenas como dados históricos', () => {
    expect(terminalCommands.windows.plugin.tui).toContain('GoLiveBypass-Installer.ps1')
    expect(terminalCommands.windows.standalone.tui).toContain('GoLiveBypass-Standalone.ps1')
    expect(terminalCommands.linux.standalone.tui).toContain('standalone/golivebypass.js')
  })
})
