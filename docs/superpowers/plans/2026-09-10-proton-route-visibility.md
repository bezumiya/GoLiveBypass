# Ocultação de rotas Proton sem ping — Plano de implementação

> Plano derivado da especificação aprovada em
> `docs/superpowers/specs/2026-09-10-proton-route-visibility-design.md`.

## Objetivo

Filtrar visualmente as rotas Proton sem ping válido no seletor persistente e na
lista manual de fallback. O catálogo e os mapas internos permanecem completos;
nenhum ping adicional será iniciado para preencher a UI.

## Restrições globais

- Preservar a otimização automática, o failover, o coordenador e o isolamento
  WireGuard por aplicativo.
- Não alterar helper Go, IPC, sessão manual, validação de seleção ou contratos
  de progresso.
- Não remover candidatas sem ping do estado interno; somente impedir sua
  renderização nas duas listas.
- Não ocultar uma rota que tem ping válido apenas porque o preflight falhou no
  fallback: ela mantém o estado indisponível já exibido, sem recomendação.
- Não alterar plugin, standalone, proxy, PAC ou Tor.
- Não executar formatadores, linters ou a suíte completa em etapas
  intermediárias; validar os caminhos afetados ao final.

## Arquivos e mudanças

### Predicado de ping

- `golive-gui/src/proton-manual-selection.ts`
  - exportar um predicado pequeno para ping válido, baseado na regra existente
    de número finito, positivo e menor que `999`;
  - considerar falha explícita de ping como não visível, mesmo que uma medição
    anterior tenha deixado `pingMs` no objeto;
  - reutilizar o predicado em `isManualRouteSelectable`, preservando a
    recomendação atual e suas fronteiras.
- `golive-gui/tests/proton-manual-selection.test.ts`
  - cobrir ping ausente, zero, `999`, valor positivo válido e falha explícita;
  - manter os casos existentes de candidato catalogado sem ping ser acionável,
    mas não selecionável/recomendável.

### Renderer

- `golive-gui/src/main.ts`
  - importar o predicado de ping válido;
  - em `renderProtonMeasuredRouteOptions`, manter somente candidatas acionáveis
    com ping válido;
  - não adicionar a rota selecionada como exceção quando seu ping salvo for
    ausente ou inválido; manter a exceção atual quando o ping salvo for válido;
  - em `renderManualRouteChoices`, filtrar apenas candidatas com ping válido,
    mantendo visíveis as que têm ping mas foram reprovadas no preflight;
  - calcular recomendação, ordenação, contador e criação dos botões a partir da
    mesma coleção visível;
  - substituir o estado vazio que hoje exibe catálogo disponível por uma
    mensagem de carregamento ou de ausência de rota medida, sem inserir linhas
    com `—`;
  - fazer o contador representar somente rotas visíveis e manter o progresso
    do catálogo no texto auxiliar;
  - manter o carregamento, retry, desabilitação durante descoberta e chamadas
    IPC atuais.
- `golive-gui/index.html`
  - atualizar o rótulo e a orientação do fallback para indicar que a lista
    contém somente rotas com ping medido, sem prometer ping sob demanda para
    itens ocultos;
- `golive-gui/tests/proton-ui.test.ts`
  - atualizar os contratos estáticos para exigir o filtro nas duas funções;
  - cobrir a ausência de renderização/contagem de rotas sem ping e os novos
    estados vazios, sem fixar detalhes de implementação não observáveis.

### Documentação

- `CHANGELOG.md`
  - adicionar em `[Unreleased]` a ocultação de rotas Proton sem ping nas duas
    listas, sem alegar medição em massa ou prova geográfica.

## Ordem de execução

### 1. Consolidar o predicado de ping

1. Consultar referências LSP antes de alterar o símbolo exportado.
2. Extrair a regra de ping válido para um predicado reutilizável.
3. Fazer `isManualRouteSelectable` delegar ao novo predicado.
4. Atualizar os testes de fronteira e falha explícita.

**Resultado:** o modelo distingue claramente ping válido de rota apenas
catalogada, sem mudar a ação sob demanda do backend.

### 2. Filtrar as superfícies do renderer

1. Aplicar a filtragem de ping válido ao seletor persistente após a filtragem de
   ação existente.
2. Aplicar a filtragem de ping válido antes de ordenar/renderizar a lista manual.
3. Preservar no fallback candidatos medidos com preflight reprovado, deixando o
   botão indisponível e retirando-os da recomendação.
4. Corrigir a exceção da rota salva e os textos/contadores de carregamento e
   lista vazia.
5. Atualizar os contratos de UI e executar o teste específico do renderer.

**Resultado:** nenhuma superfície mostra linha sem ping ou opção `—`, enquanto
as falhas de rota já medida continuam legíveis onde eram exibidas.

### 3. Documentar e validar

1. Atualizar o changelog.
2. Executar os testes específicos:
   - `npm test -- tests/proton-manual-selection.test.ts`;
   - `npm test -- tests/proton-ui.test.ts`;
   - se contratos compartilhados forem tocados, os testes Proton relacionados.
3. Executar `npm run compile` em `golive-gui`.
4. Fazer smoke test da superfície da GUI disponível e verificar que o catálogo
   não dispara ping adicional.
5. Executar `git diff --check`.

## Critérios de conclusão

- As duas listas renderizam somente rotas com ping válido.
- Nenhuma linha de rota sem ping ou métrica `—` é criada.
- O contador não conta candidatas ocultas como opções disponíveis.
- Nenhum ping em massa, mudança de IPC ou alteração de seleção automática é
  introduzido.
- Testes específicos e compilação passam; a validação real de túnel/Discord
  continua fora do alcance do smoke test local.
