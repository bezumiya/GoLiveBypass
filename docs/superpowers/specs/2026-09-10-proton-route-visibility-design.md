# Ocultação de rotas Proton sem ping

## Contexto

O catálogo Proton e as medições manuais são mesclados em uma coleção usada por
duas superfícies da GUI:

- o seletor persistente `Escolha sua rota`;
- a lista manual exibida quando a otimização é cancelada ou falha.

A coleção também contém rotas ainda não sondadas ou que não responderam. Essas
rotas aparecem com a métrica `—` ou com a indicação de validação sob demanda.
Isso aumenta o ruído visual e deixa a lista menos útil para escolher uma rota
que já tenha latência conhecida.

O catálogo completo e a seleção sob demanda foram definidos na especificação
`2026-09-10-proton-route-catalog-design.md`. Esta decisão altera somente a
visibilidade dessas candidatas na GUI e substitui as decisões anteriores de
renderizar rotas sem ping.

## Objetivo

Mostrar nas duas listas somente rotas que tenham ping válido já medido, sem
executar uma nova rodada de pings apenas para preencher a interface e sem
alterar a seleção automática, o failover ou as validações do backend.

## Decisões de produto

- O filtro vale para o seletor persistente e para a lista manual de fallback.
- Uma rota é visível quando possui ping finito, positivo e menor que `999 ms`,
  respeitando também o estado de falha já existente da candidata.
- Rotas sem ping válido não geram linha, botão, opção com `—` ou recomendação.
- A ordenação entre as rotas visíveis continua sendo a ordenação existente,
  por ping crescente e nome normalizado para empates.
- A recomendação continua usando somente candidatas selecionáveis; o filtro
  visual não transforma uma rota indisponível em selecionável.
- O contador da lista representa somente rotas exibíveis, com texto como
  `N rotas com ping`. Durante a descoberta, o progresso do catálogo pode
  continuar sendo informado no texto auxiliar, mas o total catalogado não é
  apresentado como quantidade de opções disponíveis.
- Se não houver rota com ping válido, a lista informa explicitamente que ainda
  não há rota medida e mantém a ação existente de nova medição/tentativa.
- Uma rota salva só pode permanecer como opção excepcional no seletor se o
  próprio estado salvo tiver ping válido. Uma rota salva sem ping não é
  reintroduzida para preservar uma linha que a regra de visibilidade rejeita.
- A coleção interna continua recebendo e mesclando o catálogo completo. O
  estado sem ping não é apagado; ele apenas deixa de ser renderizado até que
  uma medição válida seja obtida por outro fluxo existente.

## Fora do escopo

- Fazer ping em todas as rotas catalogadas antes de renderizar.
- Alterar o catálogo Go, o IPC, os contratos de sessão ou as validações de
  `select-proton-route`.
- Alterar a otimização automática, o pool de failover, o ranking ou os filtros
  de conta, plano, país e estado online.
- Alterar a medição de velocidade, a renovação de sessão ou a aplicação do
  perfil WireGuard.
- Alterar plugin Vencord/Equicord, standalone, proxy, PAC ou Tor.
- Expor segredos, endpoints ou conteúdo de perfil ao renderer.

## Arquitetura

### Estado e predicado de visibilidade

A mesclagem entre `protonRouteCatalogCandidates` e
`protonManualCandidates` permanece inalterada. O renderer deriva uma coleção
visível a cada renderização usando o predicado de ping válido já usado pelo
modelo de seleção. A filtragem ocorre antes da ordenação, recomendação e
criação dos elementos DOM.

As duas superfícies usam a mesma regra de dados, mas preservam suas regras de
estado atuais:

- o seletor persistente mantém sua filtragem de candidatas acionáveis e passa
  a excluir também as que não têm ping válido;
- a lista manual passa a excluir somente as candidatas sem ping válido, para
  que uma rota que tenha ping mas esteja reprovada no preflight continue
  visível com seu estado indisponível atual, em vez de ser confundida com uma
  rota não medida.

A distinção mantém o diagnóstico existente: `—` significa ausência de ping e
some da UI; uma mensagem de falha acompanhada de ping continua identificando
uma rota medida que não pode ser aplicada naquele momento.

### Seletor persistente

`renderProtonMeasuredRouteOptions` mantém o formato atual de
`ProtonRouteOption`, incluindo país, ping, recomendação e estado desabilitado.
A coleção enviada ao componente contém apenas candidatas acionáveis com ping
válido. A exceção da rota atualmente selecionada continua existindo somente
quando `protonSelectedRoute.pingMs` também é válido; caso contrário, o valor do
seletor fica vazio até que uma rota medida seja selecionada.

Nenhuma opção de catálogo `not-tested` é criada para provocar ping sob demanda.
O seletor não faz novas chamadas de rede por causa do filtro.

### Fallback manual

`renderManualRouteChoices` ordena e renderiza somente candidatas com ping
válido. A ação e o estado de indisponibilidade de uma candidata medida seguem
as regras atuais. A recomendação é calculada sobre a coleção visível e ainda
pode ficar vazia quando todas as rotas medidas foram reprovadas no preflight ou
não possuem velocidade suficiente para recomendação.

Quando a descoberta estiver em andamento e ainda não existir rota medida, a
lista mostra uma mensagem de carregamento sem inserir linhas sem ping. Quando a
descoberta terminar sem uma rota com ping válido, mostra uma mensagem de lista
vazia orientada a executar nova medição. O botão de tentar novamente mantém o
fluxo atual.

### Descoberta e medição

A descoberta do catálogo continua leve e progressiva. Eventos podem atualizar
as candidatas internas e disparar nova renderização, mas apenas entradas com
ping válido atravessam o filtro. Medições automáticas, medições manuais,
validação de peer, preflight e seleção de rota não ganham chamadas ou estados
novos por causa desta mudança.

## Estados e falhas

- **Carregando sem rota medida:** nenhum servidor sem ping é mostrado; o
  fallback informa que está carregando e que rotas com ping aparecerão quando
  disponíveis.
- **Carregando com rotas medidas:** somente as rotas com ping válido aparecem;
  a contagem de opções mede apenas essas rotas.
- **Concluído com rotas medidas:** a lista contém somente rotas com ping
  válido, na ordenação atual.
- **Concluído sem rota medida:** a lista fica vazia e orienta uma nova medição;
  o catálogo interno não é tratado como opções disponíveis.
- **Rota medida reprovada:** continua visível no fallback com o estado
  indisponível existente, mas não recebe recomendação nem pode ser aplicada.
- **Erro ou cancelamento:** candidatas medidas preservadas continuam visíveis;
  candidatas sem ping continuam ocultas.
- **Rota selecionada salva sem ping:** não é adicionada como exceção no
  seletor; isso não altera o túnel ou o perfil atualmente ativo.

## Testes

### Modelo/renderer

- candidatas sem ping não aparecem no seletor persistente;
- candidatas sem ping não aparecem na lista manual;
- uma candidata com ping válido continua aparecendo nas duas superfícies;
- uma candidata com ping válido e preflight reprovado permanece identificada
  como indisponível no fallback, sem recomendação;
- a rota salva sem ping não é reintroduzida no seletor;
- a recomendação nunca aponta para uma rota sem ping;
- carregamento e estado vazio não criam linhas com `—`;
- o contador considera apenas rotas exibíveis;
- catálogo interno, medição automática e fluxo de seleção não ganham chamadas
  extras de ping.

## Critérios de aceite

- As duas listas Proton exibem somente rotas com ping válido.
- Nenhuma linha com `—` é renderizada nessas listas.
- A interface não executa ping em massa para satisfazer o filtro.
- Rotas medidas indisponíveis mantêm seu estado explícito onde já era exibido,
  sem virar recomendação ou opção aplicável.
- O estado vazio continua oferecendo orientação para nova medição/tentativa.
- Otimização automática, failover, isolamento por aplicativo e aplicação do
  WireGuard permanecem inalterados.
