import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../components/GuiViewer.vue', import.meta.url), 'utf8')

describe('réplica da GUI v2', () => {
  it('expõe os controles e textos da arquitetura atual', () => {
    for (const phrase of ['Ação principal', 'Só o Discord usa o túnel', 'Proton Otimizado', 'Arquivo .conf', 'Otimizar rota', 'Troca automática de rota', 'Canal beta']) {
      expect(source).toContain(phrase)
    }
  })

  it('não reintroduz controles ou premissas do fluxo antigo', () => {
    for (const phrase of ['gateway · roteado', 'áudio e vídeo · direto', 'SOCKS5', 'proxy pública', 'window.api', 'type="password"', 'type="file"']) {
      expect(source).not.toContain(phrase)
    }
  })
})
