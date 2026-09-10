# Recuperação manual Proton após otimização sem rotas — Plano de implementação

> Plano derivado da especificação aprovada em
> `docs/superpowers/specs/2026-09-10-proton-manual-recovery-design.md`.

## Objetivo

Quando a otimização terminar sem nenhuma candidata manual selecionável, medir
ping em uma nova operação leve e abastecer o dropdown principal. Remover do
diálogo de otimização a camada visual de fallback manual introduzida pelo
catálogo, preservando seu layout original.

## Restrições globais

- Não alterar ranking, limites ou decisão do speed-test automático.
- Não usar `route-pool`, não gerar certificado, chave, túnel ou perfil para a
  recuperação do dropdown.
- Medir somente as candidatas regionais usadas pelo triage do helper, com o
  prazo/concorrência já existentes.
- Preservar request id, owner, coordinator, cancelamento, expiração e rollback.
- Manter a seleção manual final revalidando ping, peer WireGuard, preflight e
  promoção atômica.
- Remover apenas a UI de fallback do diálogo; manter o dropdown customizado e
  seus pings válidos.
- Não tocar em plugin, standalone, proxy, PAC ou Tor.
- Não executar formatadores, linters ou suíte completa durante etapas
  intermediárias; validar os pacotes afetados ao final.

## Arquivos e contratos

### Helper Go

- `tools/proton-confgen/cmd/protonvpn-wg/main.go`
  - ampliar `routeCatalogEntry` com `pingMs,omitempty`;
  - reutilizar `ServerSelector.SpeedCandidatesWithProgress` quando
    `cfg.AutoPing` estiver ativo no modo catálogo;
  - anexar somente pings entre 1 e 998 ms às entradas correspondentes;
  - ignorar erro de ausência total de ping sem descartar o catálogo metadata;
  - manter o modo catálogo sem `-auto-ping` sem sondas.
- `tools/proton-confgen/cmd/protonvpn-wg/route_catalog_test.go`
  - testar enriquecimento de entradas com ping válido e omissão de ping
    inválido;
  - verificar que o JSON continua público e sem perfil/endpoint/segredo;
  - preservar filtros, exclusões e progresso existentes.

### Wrapper e IPC

- `golive-gui/electron/proton.ts`
  - adicionar opção interna `measurePing` a `generateProtonRouteCatalog`;
  - acrescentar `-auto-ping` somente quando essa opção estiver ativa;
  - validar `pingMs` opcional no parser do catálogo e propagá-lo ao renderer.
- `golive-gui/electron/main.ts`
  - aceitar `measurePing` em `discover-proton-routes`;
  - encaminhar a opção ao wrapper;
  - copiar `pingMs` válido para o resultado e para o estado da sessão manual;
  - manter o contrato de seleção final, revalidação e limpeza sem relaxamento;
  - preservar descoberta normal sem medição quando `measurePing` for falso.
- `golive-gui/tests/proton-speed-selection.test.ts`
  - testar argumentos `-auto-ping`, parsing e rejeição de ping inválido.
- `golive-gui/tests/proton-optimization.test.ts`
  - testar propagação de `measurePing`, sessão com ping e isolamento de
    operações concorrentes.

### Renderer e dropdown

- `golive-gui/src/main.ts`
  - adicionar intenção pendente de recuperação ping-only ao ciclo pós-otimização;
  - marcar a recuperação quando falha, cancelamento ou exceção deixa zero
    candidatas `isManualRouteSelectable`;
  - iniciar `discoverProtonRoutesInBackground(true)` somente após fechar o
    diálogo, mantendo o dropdown em loading;
  - não repetir a varredura quando já houver uma candidata selecionável;
  - aplicar `pingMs` recebido no catálogo e continuar filtrando sem ping;
  - remover `protonManualFallback`, recomendação, contador/retry de catálogo,
    `renderManualRouteChoices` e listeners DOM exclusivos do modal;
  - manter seleção manual pelo `ProtonRouteSelect`, estado ocupado e feedback
    geral sem depender de hint dentro do diálogo;
  - restaurar remoção de skeletons em falha/cancelamento e renderizar as
    candidatas medidas diretamente no dropdown;
  - limpar intenção pendente em nova otimização, logout, troca de conta e
    respostas obsoletas.
- `golive-gui/index.html`
  - remover a seção `protonManualFallback` do diálogo;
  - preservar título, progresso, lista de medição e ações originais;
  - manter apenas a estrutura do dropdown no cartão principal.
- `golive-gui/src/style.css`
  - remover regras exclusivas de `.proton-manual-fallback`,
    `.proton-manual-recommendation` e `.proton-manual-route`;
  - preservar estilos do modal, lista de medição e seletor customizado.
- `golive-gui/src/proton-route-select.ts`
  - ajustar somente o texto de estado vazio se necessário para distinguir
    catálogo carregando de ausência de rota com ping; não reintroduzir opções
    sem ping.
- `golive-gui/tests/proton-ui.test.ts`
  - afirmar que o diálogo não contém fallback manual, contador, recomendação ou
    retry de catálogo;
  - afirmar que o dropdown mantém filtro de ping válido, loading e rotas
    retornadas pela recuperação;
  - preservar contratos dos controles originais de otimização.

### Documentação

- `CHANGELOG.md`
  - registrar a recuperação ping-only após otimização sem rotas e a remoção do
    excesso visual do diálogo, sem prometer disponibilidade quando nenhum
    endpoint responder.

## Ordem de execução

### 1. Enriquecer o catálogo opcionalmente com ping

1. Consultar referências disponíveis antes de alterar exports/interfaces.
2. Extrair a construção da lista elegível se necessário para reaproveitar os
   mesmos filtros e exclusões.
3. Enriquecer o resultado apenas quando `-auto-ping` for solicitado.
4. Preservar pings válidos por nome e omitir 0/999/ausentes.
5. Adicionar teste unitário sintético sem API real, túnel ou certificado.

**Resultado:** o helper consegue fornecer alternativas pingadas sem gerar
perfil; o catálogo leve original permanece leve.

### 2. Encaminhar pings pelo wrapper e IPC

1. Passar `measurePing` do handler para `generateProtonRouteCatalog`.
2. Validar `pingMs` opcional e manter allowlist de metadados.
3. Inicializar a sessão manual com `pingStatus: success` somente para ping
   válido; demais entradas seguem `not-tested`.
4. Retornar ping no resultado público sem endpoint, chave, token ou arquivo.
5. Adicionar os casos dos testes Electron e executar apenas os arquivos Proton
   afetados.

**Resultado:** a camada de processo principal entrega pings frescos e mantém a
seleção final segura.

### 3. Corrigir o ciclo de recuperação do renderer

1. Adicionar a flag pendente e limpá-la ao iniciar uma nova otimização.
2. Após falha/cancelamento/exceção, contar candidatas selecionáveis; quando o
   total for zero, enfileirar descoberta com ping.
3. No `finally`, preservar a intenção enquanto o modal estiver aberto; no
   fechamento, consumir a intenção e iniciar a descoberta ping-only.
4. Mesclar o resultado no mapa existente e renderizar o dropdown somente com
   rotas pingadas.
5. Manter o caminho de sucesso sem varredura extra e ignorar respostas stale.

**Resultado:** fechar um erro sem nenhuma rota deixa o dropdown carregando e
passa a oferecer alternativas medidas assim que a varredura terminar.

### 4. Remover o fallback visual do modal

1. Retirar a seção manual e textos de catálogo do HTML.
2. Remover funções, estados, listeners e atualizações DOM que só serviam à
   lista manual do modal.
3. Restaurar limpeza de skeletons na falha/cancelamento.
4. Preservar a lista de progresso, as ações originais e o dropdown customizado.
5. Remover apenas o CSS órfão do fallback e atualizar contratos estáticos.

**Resultado:** a janela de otimização volta a ser enxuta; seleção manual fica
somente no dropdown.

### 5. Documentar e validar

1. Atualizar o changelog.
2. Rodar testes específicos:
   - `npm test -- tests/proton-speed-selection.test.ts`;
   - `npm test -- tests/proton-optimization.test.ts`;
   - `npm test -- tests/proton-ui.test.ts`;
   - `npm test -- tests/proton-manual-selection.test.ts`.
3. Rodar `go test ./...` em `tools/proton-confgen`.
4. Rodar `npm run compile` em `golive-gui`.
5. Fazer smoke test da GUI e do dropdown; registrar limites de teste sem túnel
   real/Discord.
6. Rodar `git diff --check`.

## Critérios de conclusão

- Falha/cancelamento/exceção sem rota selecionável agenda ping-only após fechar
  o modal.
- O dropdown mostra pings válidos retornados, sem linhas `—`.
- Otimização com alguma candidata selecionável não duplica a medição.
- O modal não contém fallback manual, recomendação, contador ou retry de
  catálogo.
- O speed-test normal, failover, seleção final e rollback permanecem intactos.
- Testes específicos, testes Go e compilação passam.
