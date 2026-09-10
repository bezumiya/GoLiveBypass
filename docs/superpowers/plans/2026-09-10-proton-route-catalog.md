# Catálogo completo e progressivo de rotas Proton — Plano de implementação

> Plano derivado da especificação aprovada em
> `docs/superpowers/specs/2026-09-10-proton-route-catalog-design.md`.

## Objetivo

Substituir a descoberta manual limitada a três reservas por um catálogo leve de
todas as rotas elegíveis. O catálogo será carregado progressivamente após
cancelamento/falha da otimização; ping, preflight e geração de perfil continuam
sob demanda no clique.

## Restrições globais

- Não alterar os limites nem o ranking do speed-test automático.
- Não alterar o pool de failover, que permanece com três reservas.
- Não gerar certificados, chaves, túneis ou perfis durante o catálogo.
- Preservar isolamento WireGuard, fila de ciclo, rollback e sessão efêmera.
- Enviar ao renderer somente metadados públicos; seleção envia nome exato e
  `measurementId`.
- Não tocar no plugin, standalone, proxy, PAC ou Tor.
- Não executar formatadores, linters ou a suíte completa durante etapas
  intermediárias; validar tudo ao final com os comandos específicos.

## Arquivos e contratos

### Helper Go

- `tools/proton-confgen/internal/config/types.go`
  - adicionar `RouteCatalog bool`.
- `tools/proton-confgen/internal/config/flags.go`
  - registrar `-route-catalog`;
  - permitir o modo sem país/servidor obrigatório;
  - manter validações de flags existentes;
  - manter `-route-pool-size` limitado a 1–3.
- `tools/proton-confgen/internal/speedtest/measure.go`
  - ampliar o evento público de progresso com fase `catalog` e metadados
    sanitizados necessários à GUI.
- `tools/proton-confgen/cmd/protonvpn-wg/main.go`
  - adicionar o branch `RouteCatalog` antes dos modos que geram perfil;
  - filtrar e ordenar todas as rotas elegíveis, removendo `ExcludedServers`;
  - emitir progresso por rota com contadores coerentes;
  - retornar `{success, routes}` sem endpoint, peer, chave ou arquivo.
- `tools/proton-confgen/cmd/protonvpn-wg/route_catalog_test.go`
  - testar filtragem, exclusão, ordenação, JSON e progresso sem autenticação
    real, usando dados de servidores sintéticos.
- `tools/proton-confgen/README.md`
  - documentar o modo interno de catálogo se o contrato CLI permanecer visível.

### Wrapper e processo principal

- `golive-gui/electron/proton.ts`
  - aceitar a fase `catalog` em `validProgress`;
  - manter allowlist/redaction para os novos metadados;
  - adicionar `generateProtonRouteCatalog`, separado de
    `generateProtonRoutePool`, sem diretório de perfis;
  - validar resultado final, filtros de strings e valores numéricos.
- `golive-gui/electron/main.ts`
  - trocar somente o IPC `discover-proton-routes` para o catálogo leve;
  - iniciar/encerrar sessão manual com todos os nomes catalogados;
  - manter a rota anterior excluída e não alterar `protonLastServer`;
  - encaminhar progresso com `requestId`;
  - aceitar no `select-proton-route` candidato com ping ausente, mantendo a
    validação nova de servidor, ping, preflight e promoção atômica;
  - preservar o coordenador e a limpeza de operações.
- `golive-gui/electron/preload.ts`
  - ajustar apenas tipos/contrato se necessário; manter canais existentes.
- `golive-gui/tests/proton-speed-selection.test.ts`
  - testar argumentos, parsing de catálogo, progresso e ausência de arquivos.
- `golive-gui/tests/proton-optimization.test.ts`
  - testar resposta completa de descoberta, sessão sem ping, requestId,
    concorrência e seleção sob demanda.

### Renderer e interface

- `golive-gui/src/proton-manual-selection.ts`
  - adicionar elegibilidade de ação para candidato sem ping;
  - manter `isManualRouteSelectable`/recomendação restritas a ping válido;
  - preservar ordenação e estados de falha.
- `golive-gui/tests/proton-manual-selection.test.ts`
  - cobrir candidato catalogado sem ping, falha de ping/preflight e
    recomendação sem métricas inventadas.
- `golive-gui/src/main.ts`
  - ampliar contrato de progresso com fase `catalog` e metadados;
  - separar mapas de medição e catálogo, mesclando por servidor sem apagar
    métricas medidas;
  - remover o corte `PROTON_ROUTE_POOL_SIZE` e o preview de três itens;
  - iniciar descoberta enquanto o fallback permanece aberto;
  - acumular e renderizar eventos em lotes por frame;
  - manter request/session generation e estados de erro/cancelamento;
  - renderizar rotas sem ping no fallback e no seletor persistente;
  - desabilitar seleção durante a descoberta e habilitá-la ao finalizar.
- `golive-gui/index.html`
  - atualizar título/hint da alternativa manual;
  - adicionar contador de catálogo e ação de recarregar catálogo se necessário.
- `golive-gui/src/style.css`
  - manter altura máxima/rolagem;
  - estilizar loading parcial, contador, rota sem ping e erro sem expandir a
    janela.
- `golive-gui/tests/proton-ui.test.ts`
  - substituir contratos da lista de três reservas por contratos do catálogo
    completo, loading, fase `catalog`, rota sem ping e fallback aberto.

### Documentação final

- `CHANGELOG.md`
  - adicionar entrada em `[Unreleased]` descrevendo catálogo completo,
    carregamento progressivo e validação sob demanda, sem prometer prova
    geográfica.

## Ordem de execução

### 1. Implementar catálogo puro no helper

1. Adicionar flag/configuração sem alterar os modos atuais.
2. Extrair uma função pura para filtrar/excluir/ordenar servidores.
3. Implementar JSON final e progresso `catalog`.
4. Escrever testes sintéticos para filtros, conta Free/Premium e payload.
5. Rodar apenas os testes do pacote Go afetado.

**Resultado:** o helper lista todas as rotas públicas elegíveis sem certificado,
perfil ou túnel.

### 2. Integrar wrapper e progresso

1. Ampliar os tipos/allowlist de `ProtonOptimizationProgress`.
2. Implementar `generateProtonRouteCatalog` com sessão, filtros e exclusão da
   rota atual.
3. Rejeitar JSON incompleto/segredo e limpar qualquer temporário.
4. Adicionar casos ao mock de `proton-speed-selection.test.ts`.
5. Rodar o teste específico do wrapper.

**Resultado:** Electron recebe catálogo e eventos sem alterar o pool existente.

### 3. Adaptar IPC e sessão manual

1. Fazer `discover-proton-routes` chamar o wrapper leve.
2. Preservar `requestId`, owner, expiração, conta, plano e filtros.
3. Criar candidatos `not-tested` a partir de todas as rotas.
4. Permitir que seleção de candidato sem ping prossiga para a revalidação do
   helper, sem relaxar filtros ou preflight.
5. Manter rollback e concorrência.
6. Atualizar e executar os testes isolados do handler.

**Resultado:** o backend conhece todos os nomes, mas só valida/aplica a rota
escolhida.

### 4. Adaptar modelo e renderer

1. Adicionar `isManualRouteActionable` para separar ação de recomendação.
2. Criar mapa de catálogo e união determinística com candidatas medidas.
3. Renderizar ping/velocidade medidos com precedência e `—` para desconhecidos.
4. Aceitar progresso `catalog`, atualizar contador e agendar renderização em
   lote.
5. Liberar a descoberta no fallback aberto sem esperar `close`.
6. Desabilitar ações durante loading; reabilitar em sucesso/erro/cancelamento.
7. Atualizar dropdown, fallback, skeleton, erro e ação de retry.
8. Invalidar mapa em logout, nova otimização, nova conta, filtro e request
   obsoleto.
9. Atualizar testes puros e contratos de UI.

**Resultado:** todas as rotas aparecem gradualmente no diálogo e no seletor,
sem interromper a medição já exibida.

### 5. Documentar e validar integração

1. Atualizar README/CHANGELOG apenas com comportamento implementado.
2. Rodar testes Vitest específicos:
   - `tests/proton-manual-selection.test.ts`;
   - `tests/proton-speed-selection.test.ts`;
   - `tests/proton-optimization.test.ts`;
   - `tests/proton-ui.test.ts`.
3. Rodar `go test ./...` em `tools/proton-confgen`.
4. Rodar `npm run compile` em `golive-gui`.
5. Inspecionar o diff final e executar `git diff --check`.
6. Fazer smoke test disponível da GUI; registrar que testes unitários/build não
   comprovam rota real do Discord ou captura WFP.

## Critérios de conclusão

- Nenhum corte fixo de três rotas no catálogo manual.
- Rotas catalogadas sem ping ficam visíveis e selecionáveis após loading.
- Cancelamento mantém o diálogo e dispara o catálogo em segundo plano.
- Seleção sob demanda mantém ping, peer, preflight, staging e rollback.
- Otimização automática/failover não mudam seus limites.
- Testes específicos, `go test ./...` e compilação passam.
- Changelog descreve a mudança sem alegar prova geográfica.
