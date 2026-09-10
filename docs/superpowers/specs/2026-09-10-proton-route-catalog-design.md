# Catálogo completo e progressivo de rotas Proton

## Contexto

A GUI já possui uma seleção manual de rota como fallback da otimização Proton.
A descoberta usada pelo seletor persistente chama o modo `route-pool` com
`size: 3`, que mede ping e prepara três perfis temporários. O fallback aberto
quando o usuário cancela a otimização também depende das candidatas que já
participaram da medição automática. A descoberta em segundo plano só começa
depois que o diálogo é fechado.

Esse comportamento deixa a conta com apenas três alternativas visíveis e não
permite consultar todas as rotas elegíveis da conta sem executar trabalho de
speed-test ou gerar perfis para rotas que talvez nunca sejam escolhidas.

## Objetivo

Depois do cancelamento da otimização, exibir progressivamente todas as rotas
elegíveis do catálogo Proton atual, respeitando a conta e as preferências da
GUI, sem alterar a decisão automática nem criar um perfil para cada rota.

A mesma fonte deve alimentar a lista manual do diálogo e o seletor persistente
`Escolha sua rota`.

## Decisões de produto

- A descoberta do catálogo começa assim que a otimização cancelada ou falha
  termina; ela não espera o diálogo ser fechado.
- A lista preserva imediatamente as candidatas que já foram medidas.
- Rotas do catálogo chegam em lotes/eventos e são adicionadas sem remover as
  anteriores.
- A filtragem usa a sessão Proton autenticada, o plano confirmado, o país
  selecionado, a exclusão de Brasil e o status online da rota.
- A rota atualmente selecionada fica fora das alternativas de catálogo.
- Uma rota sem ping medido mostra `—` e `Ping sob demanda`.
- Depois que a descoberta termina, uma rota sem ping pode ser acionada por
  `Validar e usar`; o backend mede o ping, valida o peer WireGuard e executa o
  preflight antes de gerar ou aplicar o perfil.
- Enquanto a descoberta ocupa o coordenador de operações, as ações de seleção
  ficam desabilitadas. O usuário pode selecionar qualquer rota catalogada assim
  que a descoberta terminar.
- Candidatas já medidas conservam ping, velocidade, status e recomendação.
- A recomendação só pode apontar para uma rota com ping válido; nenhuma métrica
  é inventada para uma rota ainda não sondada.
- A lista tem altura limitada e rolagem; o número de itens não redimensiona a
  janela indefinidamente.

## Fora do escopo

- Alterar os limites, o ranking, os filtros ou a decisão do speed-test
  automático.
- Alterar o pool de failover automático, que continua limitado ao contrato
  atual de reservas.
- Fazer ping em todas as rotas apenas para preencher a lista.
- Gerar antecipadamente perfis WireGuard para todas as rotas.
- Expor endpoint, chave pública/privada, token, sessão ou conteúdo de perfil ao
  renderer.
- Alterar plugin Vencord/Equicord, standalone, proxy, PAC ou Tor.
- Persistir o catálogo entre reinícios ou contas.

## Arquitetura

### Catálogo no helper Go

Adicionar um modo leve de catálogo ao `proton-confgen`. Esse modo reutiliza a
sessão autenticada e `GetServers`, reaplica os filtros de seleção e retorna
somente metadados públicos da rota:

- nome exato do servidor;
- país de saída;
- cidade;
- tier;
- carga e score, quando disponíveis.

O modo não chama `GetCertificate`, não cria chave WireGuard, não abre túnel,
não executa ping e não escreve perfil. Com `-progress-json`, emite um evento
sanitizado para cada rota elegível, ou para pequenos lotes, com o total e o
contador de itens catalogados. Os eventos usam uma fase própria de catálogo,
sem reaproveitar semanticamente as fases `ping`, `preparing` ou `testing`.

A resposta JSON final confirma a operação e contém os mesmos metadados. Uma
falha de autenticação, sessão, catálogo ou filtro retorna erro sem criar estado
parcial aplicável.

### Wrapper Electron

Adicionar ao wrapper Proton uma operação de catálogo separada do
`generateProtonRoutePool`. Ela:

1. garante o helper autenticado;
2. passa usuário, sessão, filtros atuais e rota excluída;
3. encaminha eventos de progresso sanitizados;
4. valida o formato dos metadados recebidos;
5. retorna a lista pública para o processo principal/renderer;
6. limpa qualquer diretório temporário que o modo criar, embora o caminho
   normal não gere perfis.

O `generateProtonRoutePool` permanece inalterado para o failover e continua
com seu limite de três reservas.

### Processo principal

O IPC existente `discover-proton-routes` passa a usar o modo de catálogo, sem
mudar o nome público do canal. O coordenador `ProtonOptimizationCoordinator`
continua serializando descoberta, otimização e seleção manual.

A sessão efêmera de medição manual passa a aceitar candidatos com estado de
ping `not-tested`. Cada evento catalogado atualiza a sessão do owner com o nome
exato e seus metadados sanitizados. A sessão mantém o identificador de medição,
owner, conta, filtros e expiração atuais.

A seleção `select-proton-route` aceita um candidato catalogado mesmo sem ping
armazenado, mas mantém todas as validações existentes:

1. owner, identificador e expiração da sessão;
2. identidade da conta e preferências atuais;
3. plano e filtros atuais;
4. servidor exato, online e com peer WireGuard utilizável;
5. ping novo com resultado válido;
6. preflight WireGuard/HTTPS;
7. geração staged e promoção atômica;
8. aplicação pela fila de ciclo existente.

Uma rota rejeitada não altera o perfil anterior e devolve somente erro
sanitizado. O renderer continua enviando apenas `measurementId` e `server`.

### Renderer

O estado da descoberta separa:

- catálogo progressivo recebido;
- candidatas medidas pela otimização;
- identificador e operação atuais;
- estado de carregamento, conclusão e erro.

Os mapas são mesclados pela chave do nome exato do servidor. Dados de medição
já existentes têm precedência sobre campos ausentes do catálogo. Eventos com
`requestId` antigo são ignorados.

A lista manual renderiza cada rota catalogada. Para uma rota sem ping:

- `pingMs` permanece indefinido;
- a métrica mostra `—`;
- o estado informa que o ping será validado sob demanda;
- o botão aciona o IPC somente após a descoberta concluir.

Para uma rota medida, a ordenação continua sendo ping crescente, seguida pelo
nome normalizado para empates. Rotas sem ping ficam depois das medidas e são
ordenadas pelo nome normalizado. A recomendação usa somente as candidatas
selecionáveis com ping válido.

O seletor persistente usa a mesma coleção, mostra skeleton e contador durante
a descoberta, permite rolagem e preserva a rota atualmente selecionada mesmo
quando ela não faz parte das alternativas catalogadas.

### Início e término da descoberta

Após o retorno cancelado/falho de `optimizeProtonRoute`, o renderer mantém o
diálogo aberto, mostra o fallback e dispara a descoberta sem a guarda que hoje
espera o fechamento do diálogo. O callback de progresso atualiza a lista manual
em lotes para evitar re-render por item quando o catálogo for grande.

Se o usuário fechar o diálogo, a operação pode terminar em segundo plano e
atualizar o seletor persistente. Logout, mudança de conta e nova otimização
invalidam request, sessão e catálogo anteriores.

## Estados e falhas

- **Carregando:** skeleton, contador de itens e controles de seleção
  desabilitados.
- **Parcial:** rotas recebidas continuam visíveis e as medidas anteriores não
  são apagadas.
- **Concluído:** todas as rotas catalogadas ficam disponíveis para validação
  sob demanda.
- **Catálogo vazio:** mantém medidas existentes; informa que nenhuma rota
  adicional atende aos filtros atuais.
- **Erro de catálogo:** mantém medidas existentes e informa erro sanitizado com
  ação de tentar novamente.
- **Falha da seleção:** mantém as demais rotas, marca a falha da rota escolhida
  e preserva o perfil anterior.
- **Sessão expirada ou filtros alterados:** rejeita a seleção e exige nova
  descoberta, sem aplicar configuração stale.
- **Cancelamento de operação antiga:** eventos atrasados não alteram a lista
  atual nem reabilitam controles indevidamente.

## Contratos de dados

A fase de progresso de catálogo terá, no mínimo:

```ts
interface ProtonRouteCatalogProgress {
  phase: 'catalog';
  total: number;
  tested: number;
  succeeded: number;
  server?: string;
  country?: string;
  city?: string;
  tier?: string;
  load?: number;
  score?: number;
  status?: 'testing' | 'success' | 'failed';
}
```

O contrato interno pode compartilhar o envelope de progresso existente, mas a
fase `catalog` deve ser explícita e validada. O resultado final contém
`success`, `measurementId` e `routes` com metadados públicos. Não contém
endpoint, chave, token, conteúdo `.conf` ou saída bruta do helper.

## Testes

### Helper Go

- catálogo retorna todas as rotas que passam pelos filtros;
- plano gratuito não recebe rota premium e plano premium não é reduzido a
  gratuito por campo ausente;
- país selecionado e exclusão de Brasil são respeitados;
- rotas offline não aparecem como elegíveis;
- modo catálogo não pede certificado, não cria perfil e não abre túnel;
- eventos progressivos têm fase `catalog`, contadores coerentes e nenhum
  segredo;
- catálogo vazio e erro da API preservam contratos de erro;
- modo automático e `route-pool` mantêm seus limites e argumentos atuais.

### Electron/IPC

- progresso chega ao owner com `requestId` correto;
- sessão acumula candidatos sem ping;
- descoberta não altera `protonLastServer` nem o perfil ativo;
- seleção de candidato sem ping força a validação nova;
- conta, plano ou filtros alterados invalidam a sessão;
- operações concorrentes continuam rejeitadas/serializadas;
- diretórios temporários são limpos em sucesso, erro e cancelamento.

### Renderer

- eventos de catálogo são agregados sem apagar ping ou velocidade medidos;
- todas as rotas recebidas aparecem, não apenas três;
- skeleton e contador são exibidos durante o carregamento;
- rotas sem ping mostram `—` e não recebem recomendação;
- ações ficam bloqueadas durante a descoberta e habilitam após conclusão;
- fallback inicia a descoberta enquanto o diálogo permanece aberto;
- erro ou cancelamento preserva candidatas já medidas;
- request antigo não altera catálogo novo;
- o IPC contém somente nome exato e identificador de medição.

## Critérios de aceite

- Ao cancelar a otimização, a lista manual inicia carregamento sem esperar o
  fechamento do diálogo.
- Todas as rotas elegíveis do catálogo Proton aparecem progressivamente,
  respeitando plano, país, exclusão de Brasil e estado online.
- A interface deixa de limitar a descoberta manual a três itens.
- Rotas ainda não pingadas exibem `—` e podem ser validadas individualmente
  após o catálogo terminar.
- A escolha manual só aplica uma rota após ping, peer WireGuard e preflight
  válidos.
- A otimização automática, o failover e o isolamento por aplicativo mantêm o
  comportamento atual.
- Nenhum perfil é gerado em massa e nenhum segredo chega à GUI, JSON ou logs.
- Falhas de catálogo ou seleção não substituem a configuração anterior.
