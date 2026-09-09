import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const pages = ['index.vue', 'instalacao.vue', 'como-funciona.vue', 'faq.vue'].map((file) => ({
  file,
  source: readFileSync(new URL(`../pages/${file}`, import.meta.url), 'utf8'),
}))

describe('copy da arquitetura do site', () => {
  it('explica WireGuard por aplicativo e seus limites', () => {
    const source = pages.map((page) => page.source).join('\n')
    for (const phrase of ['WireGuard por aplicativo', 'Só o Discord usa o túnel', 'WireSock', 'app.asar permanece vanilla']) {
      expect(source).toContain(phrase)
    }
  })

  it('não apresenta o legado como arquitetura principal', () => {
    const source = pages.map((page) => page.source).join('\n').toLowerCase()
    for (const phrase of ['gateway por uma saída alternativa', 'mídia continua direta', 'injeta direto no discord', 'proxy pública']) {
      expect(source).not.toContain(phrase)
    }
    expect(source).not.toMatch(/\bpac\b/)
  })
})
