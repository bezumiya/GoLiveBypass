# Recuperação manual Proton após otimização sem rotas

## Contexto

A GUI filtra corretamente o seletor persistente para mostrar somente rotas com
ping válido. Porém, quando o `proton-confgen` encerra a otimização sem produzir
nenhuma rota selecionável, a descoberta em segundo plano atual carrega apenas
metadados do catálogo. Como essas candidatas não têm ping, o filtro remove
todas e o dropdown mantém somente a rota anterior.

A otimização também passou a conter uma seção de fallback manual, contador,
recomendação e controles de catálogo dentro do diálogo de medição. Essa
informação não pertence ao fluxo de otimização: a seleção manual deve ocorrer
somente no dropdown principal.

## Objetivo

Depois de uma falha, cancelamento ou exceção da otimização sem nenhuma rota
manual selecionável, obter uma nova medição de ping sem gerar perfil e usar o
resultado para preencher o dropdown. Ao mesmo tempo, devolver o diálogo de
otimização ao layout original, mantendo nele somente progresso, lista da
medição e ações existentes.

## Decisões de produto

- O dropdown principal é a única superfície de seleção manual.
- O diálogo de otimização não exibe lista manual, contador de catálogo,
  recomendação, retry de catálogo ou orientação de seleção manual.
- O diálogo preserva a lista/progresso da otimização e os botões existentes:
  cancelar, tentar novamente, continuar sem medição e fechar conforme o estado.
- Se a otimização terminar sem nenhuma candidata manual selecionável, a GUI
  agenda uma descoberta com medição de ping para depois que o diálogo for
  fechado. A operação não bloqueia o modal nem injeta progresso adicional nele.
- Se já houver pelo menos uma candidata com ping válido e sem falha de
  preflight, a GUI não repete a varredura; essas candidatas abastecem o
  dropdown enquanto o catálogo comum continua podendo ser carregado.
- A medição de recuperação usa apenas as candidatas regionais já usadas pelo
  triage automático do helper, com concorrência e prazo limitados. Não mede
  indiscriminadamente todas as entradas do catálogo.
- A recuperação usa `-route-catalog -auto-ping`. O helper consulta a sessão e
  o catálogo, mede ping dos candidatos regionais e retorna `pingMs` somente
  para resultados válidos.
- A recuperação não pede certificado, não cria chave, não abre túnel e não
  escreve perfil. A seleção manual continua revalidando ping, peer WireGuard,
  preflight, staging, promoção e rollback no clique.
- Se nenhuma sonda responder, não é permitido inventar ping. O dropdown fica
  sem alternativas novas e mantém apenas uma rota anterior válida, se houver;
  a falha permanece diagnosticável e uma nova otimização pode ser tentada.

## Fora do escopo

- Alterar ranking, limites, filtros ou decisão do speed-test automático.
- Alterar o pool de failover ou gerar reservas para a recuperação manual.
- Medir em massa todo o catálogo Proton ou gerar perfis temporários.
- Mudar o isolamento WireGuard por aplicativo, ativação, restauração ou
  telemetria diagnóstica.
- Alterar plugin Vencord/Equicord, standalone, proxy, PAC ou Tor.
- Expor sessão, token, endpoint, chave ou conteúdo de perfil ao renderer.

## Arquitetura

### Helper Go

O modo existente `-route-catalog` ganha comportamento opcional quando recebe
`-auto-ping`:

1. filtra rotas online pelo plano, país, exclusões e demais preferências;
2. escolhe as candidatas regionais pelo mesmo algoritmo do triage automático;
3. mede seus endpoints com o probe de ping existente, sem certificado ou
   túnel;
4. anexa `pingMs` apenas quando o valor é finito, positivo e menor que `999`;
5. preserva entradas sem ping no JSON apenas como metadados, sem torná-las
   opções visíveis;
6. mantém `-route-catalog` sem `-auto-ping` leve e sem chamadas de rede de
   ping.

A saída pública permanece limitada a servidor, país, cidade, tier, carga, score
e o ping opcional. O modo não cria arquivo `.conf`. Falhas individuais de ping
não derrubam o catálogo inteiro; se nenhuma responder, o catálogo ainda pode
retornar metadados, que serão ocultados pelo renderer.

### Wrapper e IPC

`generateProtonRouteCatalog` aceita uma opção interna de medição e acrescenta
`-auto-ping` somente nessa chamada. O parser valida `pingMs` opcional e não
aceita valores inválidos como medição válida.

`discover-proton-routes` encaminha a opção `measurePing` e preserva o mesmo
canal, owner, request id, expiração, conta e filtros. O resultado inclui
`pingMs` quando disponível. A sessão manual registra a mesma informação para a
rota, mas a seleção ainda executa `generateManualProtonConfig` e não confia no
ping antigo como prova suficiente.

### Renderer e ciclo de vida

O renderer mantém os mapas de catálogo e de medições. A descoberta normal
continua podendo carregar metadados sem ping para o estado interno; o filtro
existente continua excluindo essas entradas do dropdown.

A função de otimização calcula, ao terminar em falha, cancelamento ou exceção,
se existe uma candidata manual selecionável. Se não existir, marca uma
recuperação de ping pendente. O `finally` preserva essa intenção até o diálogo
ser fechado. O fechamento dispara a descoberta com `measurePing: true`; a
operação fica coordenada pelo mesmo `ProtonOptimizationCoordinator` e o
dropdown fica em loading até a resposta.

O sucesso normal da otimização mantém suas candidatas medidas e não dispara
uma varredura extra. A descoberta catalogada sem ping continua atualizando o
estado interno, mas não cria opções com `—`. Quando a descoberta com ping
termina, o renderer mescla `pingMs` e renderiza apenas opções válidas.

### Interface de otimização

Remover do HTML a seção `protonManualFallback` e seus elementos auxiliares.
Remover os listeners e a renderização de botões manuais que dependiam dessa
seção, sem remover a seleção via `ProtonRouteSelect` no cartão principal.
Restaurar a remoção dos skeletons quando a medição falhar ou for cancelada.
Remover somente os estilos CSS exclusivos do fallback manual; preservar os
estilos do diálogo, progresso, lista de medição e dropdown.

## Estados e falhas

- **Otimização em andamento:** o diálogo mostra o layout original e a lista
  de progresso; nenhuma descoberta de recuperação concorrente começa.
- **Falha/cancelamento com ping medido:** o diálogo mostra suas ações originais;
  o dropdown recebe as candidatas medidas quando puder ser acessado.
- **Falha/cancelamento sem ping:** após fechar o diálogo, o dropdown entra em
  loading e a descoberta ping-only tenta obter alternativas.
- **Recuperação com ping:** rotas válidas aparecem no dropdown com ping; a
  seleção manual repete a validação completa antes de aplicar.
- **Recuperação sem resposta:** nenhuma linha sem ping aparece. A rota anterior
  válida pode continuar como seleção desabilitada, sem ser confundida com uma
  nova alternativa.
- **Resposta atrasada ou operação substituída:** request id, owner e geração
  continuam impedindo que catálogo antigo altere o dropdown atual.
- **Mudança de conta/filtro/logout:** sessão, catálogo e intenção de recuperação
  são invalidados pelas guardas existentes.

## Testes

### Helper Go

- catálogo sem `-auto-ping` mantém o contrato leve;
- catálogo com `-auto-ping` anexa apenas pings válidos às candidatas regionais;
- ping inválido não aparece como medição;
- falha de ping individual não descarta rotas válidas nem gera erro fatal;
- o modo não cria certificado, túnel, perfil ou segredo;
- filtros e exclusões continuam idênticos ao catálogo normal.

### Electron/IPC

- o wrapper acrescenta `-auto-ping` somente quando solicitado;
- `pingMs` opcional é validado e encaminhado sem segredos;
- a sessão manual recebe ping válido e mantém a revalidação no clique;
- descoberta normal não ganha ping extra;
- falha sem candidata selecionável agenda descoberta ping-only após o diálogo;
- falha com candidata selecionável não agenda uma segunda varredura;
- request id, cancelamento, owner e expiração permanecem protegidos.

### Renderer

- o dropdown mostra pings retornados pela recuperação;
- rotas sem ping continuam ocultas;
- o fechamento do diálogo dispara a recuperação pendente;
- o diálogo não contém fallback manual, contador de catálogo ou recomendação;
- falha/cancelamento remove skeletons e preserva as ações originais;
- uma recuperação sem resposta não cria opções com `—`;
- otimização bem-sucedida não executa uma varredura ping-only adicional.

## Critérios de aceite

- Se o confgen não testar nenhuma rota, fechar o diálogo inicia uma tentativa
  ping-only e o dropdown passa a mostrar as rotas que responderem.
- A seleção manual não fica limitada à rota anterior quando houver outra rota
  com ping válido.
- Nenhuma rota sem ping é renderizada como alternativa.
- O diálogo de otimização volta a ficar enxuto, sem a seção de seleção manual
  e sem os controles de catálogo.
- Nenhum certificado, túnel, perfil ou ping indiscriminado é criado para
  abastecer o dropdown.
- A seleção manual mantém ping novo, peer, preflight, staging, promoção e
  rollback.
- Otimização automática, failover e isolamento por aplicativo permanecem
  inalterados.
