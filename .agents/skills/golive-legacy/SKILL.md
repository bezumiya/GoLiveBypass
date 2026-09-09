---
name: golive-legacy
description: Manter proxy SOCKS/PAC, Tor, injeção app.asar, recuperação gateway/RTC e plugin Vencord/Equicord legado do GoLiveBypass. Use ao alterar esses caminhos; não aplicar suas premissas ao WireGuard atual.
---

# Bypass legado

Confirme que a distribuição afetada executa o legado. Os caminhos principais, relativos à raiz, são `standalone/golivebypass.js`, a cópia gerada `golive-gui/electron/bypass.ts` e o plugin independente em `goLiveBypass/native.ts`/`index.tsx`.

## Regras de alteração

- No PAC legado, somente `*.discord.gg` passa pelo proxy; mídia `*.discord.media` sai direta. Esse limite não vale para WireGuard.
- Edite a fonte standalone, execute `npm run sync-bypass` em `golive-gui/` e confira `npm run check-bypass`. Adapte manualmente o comportamento pertinente ao plugin; registre lacunas no `CHANGELOG.md`.
- Preserve saída manual sem reservas/trocas proativas por RTT, Tor estrito sem fallback para gratuitas/DIRECT, prazos tolerantes à construção de circuitos e heartbeat Tor informativo. Consulte código atual antes de alterar constantes.
- Não reconecte/recarregue o gateway com mídia ativa ou recente: a recuperação pode congelar vídeo. Preserve guardas, limites de tentativas e isolamento da recuperação RTC ao socket pareado. O `autoRevive` obrigatório não elimina essas guardas.
- Antes de injetar/desinjetar em uma instalação de teste autorizada, encerre todas as variantes do Discord e aguarde a saída. Preserve backup `_app.asar` e use o mecanismo existente `withNoAsar` no Windows.
- Confira qual `settings.json` o runtime efetivamente lê. No Linux, preserve merge atômico de configurações compartilhadas; não sobrescreva campos de outros escritores.

## Referência e validação

Localize símbolo/sintoma com `rg` e leia apenas funções chamadas e regressões correspondentes. Para lógica pura, não encerre Discord nem toque em instalações. Em teste real, registre versão, instalação-alvo e backup antes de agir; confirme restauração ao terminar. Encerre a validação quando o comportamento alterado estiver coberto e não restar falha relacionada.

Leia [o histórico técnico](references/history.md) apenas para o subsistema relevante: seções 3–5 para injeção, paridade e modos; seção 6 para Tor, gateway zumbi e RTC; seções 7–8 para Windows e 3proxy. Datas, issues e conclusões descrevem observações históricas, não garantias sobre o cliente Discord atual.

Selecione regressões existentes em `tests/` pelo comportamento alterado e examine seus efeitos antes de executar. Relate separadamente a validação standalone, a sincronização da GUI e a cobertura do plugin. Não declare paridade total quando uma arquitetura não suporta a mitigação.
