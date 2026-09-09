---
name: golive-network
description: Diagnosticar e corrigir WireGuard, WireSock, Proton, prova de rota e isolamento por aplicativo no GoLiveBypass. Use para falhas de ativação, tráfego ou uploads com o túnel; não para UI sem efeito de rede ou proxy legado.
---

# Rede atual do GoLiveBypass

Trabalhe a partir da plataforma, distribuição, versão e perfil envolvidos. Descubra esses dados no código/logs disponíveis; pergunte apenas pelo que impedir o diagnóstico. Não exponha chaves WireGuard, senhas ou sessões Proton em saídas e relatos; reutilize a sanitização existente.

## Investigar e corrigir

Escolha a entrada pelo sintoma; não leia todos os subsistemas:

| Sintoma | Entrada em `golive-gui/electron/` | Testes em `golive-gui/tests/` |
| --- | --- | --- |
| Instalação/ativação Windows | `wiresock.ts`, `wiresock-service.ts`, `wiresock-preflight.ts` | `wiresock*.test.ts` |
| Ativação/restauração Linux | `linux-helper.ts`, `linux-preflight.ts`, `linux-health.ts` | `linux-*.test.ts` |
| Login/plano/seleção Proton | `proton.ts`, handlers Proton em `main.ts`; helper em `tools/proton-confgen/` | `proton*.test.ts` |
| Discord sem tráfego/upload | `discord-scope-proof.ts`, `route-proof.ts`, `wgstats.ts` | `discord-scope-proof.test.ts`, `route-proof.test.ts`, `wgstats.test.ts` |

Delimite o log por horário/versão e reproduza uma operação por vez. Registre estado inicial, ação e resultado esperado/observado. Após duas tentativas iguais sem informação nova, mude a hipótese ou o instrumento. Não altere vários timeouts/perfis simultaneamente. Código executado e logs prevalecem sobre changelog/histórico. Pedido só de diagnóstico não implica implementar a correção.

1. Localize o caminho chamado pela GUI ou standalone antes de editar. Consulte `golive-gui/electron/wiresock.ts`, `linux-helper.ts`, `proton.ts` e o standalone correspondente a partir da raiz do repositório. Confirme o comportamento mais recente no `CHANGELOG.md`.
   Nos scripts Windows PowerShell `-File`, preserve UTF-8 com BOM para caminhos Unicode. No modo direto, aguarde o resultado/PID, não o encerramento do worker que captura logs do túnel persistente; preserve o handle para códigos de saída. Fallback de serviço exige `run` explicitamente incompatível, não erro genérico de outra opção. Regressão e roteiro: `docs/testing/2026-09-09-windows-update-regression.md`.
2. Separe estado do serviço, telemetria e prova funcional. No Windows, leia `route-proof.ts` e `discord-scope-proof.ts`: um helper central funcionar não prova que o Discord usa a mesma regra WFP. Observe os diretórios detectados e IPv4/IPv6 apenas em diagnóstico assíncrono, com limpeza dos probes. Falhas, IP brasileiro/direto ou resultados inconclusivos ficam nos logs: não bloquear abertura nem derrubar Discord por esses sinais. Preserve falhas reais de criação do túnel/serviço.
3. No Linux, confira `discord-vpn`, `wg-discord`, DNS e execução do Discord no namespace com ambiente gráfico/áudio correto. Probes automáticos não devem abrir prompts de elevação em segundo plano. Não altere a rota padrão do host para simular isolamento.
4. Preserve serialização de ativação/desativação/troca, restauração e proteção contra respostas atrasadas de sessões anteriores. Handshake e RX/TX ajudam no diagnóstico, mas não substituem prova de rota. Não troque de saída durante chamada para melhorar RTT sem evidência de necessidade.
5. Para upload travado, compare perfis, famílias IP, rota efetiva do processo e acesso ao destino de upload, registrando o que cada teste prova. Consulte [o relato histórico](references/history.md) somente quando relevante; saturação do perfil gratuito permanece hipótese. Não introduza pool de perfis ou avisos de produto como consequência automática do relato.
6. Avalie o comportamento equivalente nas outras distribuições e registre no changelog o que foi portado e o que não se aplica. O plugin legado não controla WFP; o standalone PowerShell não deve herdar garantias do sidecar da GUI sem implementá-las.

## Validar e entregar

Execute testes pertinentes em `golive-gui/tests/` com `npm test -- tests/<arquivo>.test.ts` no diretório da GUI. Se alterar o helper Go, execute seus testes em `tools/proton-confgen/`. Para roteiro de comprovação real no Windows, consulte `docs/testing/2026-09-05-windows-functional-route-proof-vm.md` na raiz; use a skill `windows-vm-control` se disponível e se operar a VM fizer parte da tarefa.

Informe causa confirmada ou hipótese restante, plataformas cobertas e evidência da correção. Uma compilação ou mock passando não equivale a um Discord real roteado. Não envie mensagens/anexos a canais reais como teste sem autorização correspondente.
