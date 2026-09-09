# Seleção manual de rota Proton após falha de medição

## Contexto

A GUI já envia o progresso da seleção Proton em tempo real. Cada evento pode
conter fase, servidor, ping, download, upload e status, e o renderer já mantém
uma linha por servidor no diálogo de medição.

Quando a seleção automática termina sem sucesso, porém, a interface reduz
qualquer causa — falha de ping, preflight, download/upload, timeout ou geração
do perfil — a uma mensagem genérica. O usuário perde as rotas que já foram
medidas, mesmo que algumas ainda sejam utilizáveis manualmente.

O objetivo desta mudança é oferecer uma escolha manual somente como fallback.
O caminho automático atual atende a maioria dos usuários e não deve mudar sua
seleção, seus limites, seus filtros, seu critério de velocidade ou seu
failover.

## Objetivos

- Manter a seleção automática atual sem alteração de comportamento quando ela
  retorna sucesso.
- Preservar na tela os candidatos medidos quando a seleção automática falhar.
- Exibir ping em tempo real e velocidades quando elas estiverem disponíveis.
- Ordenar a lista manual por ping crescente por padrão.
- Marcar uma rota recomendada sem afirmar que ping isolado prova o túnel.
- Permitir que o usuário selecione uma rota com ping válido, mesmo sem
  velocidade medida.
- Revalidar o servidor escolhido, gerar o perfil de forma atômica e aplicar ou
  salvar a rota pelo ciclo existente.
- Manter a rota anterior se a seleção manual falhar.
- Impedir que dados antigos de uma medição sejam usados depois de uma nova
  medição ou de uma mudança de conta/filtros.

## Fora do escopo

- Alterar a seleção automática, o ranking automático, o número de candidatos,
  os timeouts ou o failover Proton.
- Abrir um navegador com todos os servidores da API sem medição local.
- Gerar antecipadamente um perfil para cada servidor medido.
- Alterar a semântica de `ACTIVE`, o filtro por aplicativo WireSock ou a
  política de probes diagnósticos da ativação.
- Migrar a lógica para o plugin Vencord/Equicord, standalone, proxy, Tor ou
  PAC.
- Permitir seleção durante uma medição automática ainda em andamento.
- Persistir uma lista de candidatos entre reinícios da GUI.

## Decisão de produto

O diálogo conserva o comportamento atual enquanto a medição está em execução.
Se o resultado automático for bem-sucedido, ele fecha como hoje e a rota
selecionada automaticamente continua sendo a única apresentada no feedback.

Se o resultado for `success: false`, o diálogo permanece aberto com os dados
coletados. A área de ações passa a oferecer a seleção manual. Cancelamento
voluntário continua sendo cancelamento e não abre automaticamente o modo
manual; o usuário pode iniciar uma nova medição.

Somente candidatos que tiveram ping válido ficam elegíveis. Uma linha que falhou
explicitamente no preflight do túnel permanece visível para diagnóstico, mas
fica desabilitada. Uma linha que tem ping válido e ainda não passou por
preflight pode ser selecionada; o backend fará uma validação rápida antes de
aceitar a rota.

## Experiência da GUI

Cada linha exibe:

- bandeira e nome exato da rota;
- ping em milissegundos;
- download e upload, quando medidos;
- estado: `Ping medido`, `Túnel verificado`, `Velocidade medida`, `Sem
  resposta` ou `Indisponível`;
- botão `Selecionar` quando a linha for elegível.

A lista conterá somente os candidatos que participaram da medição corrente. Ela
não será preenchida com servidores da API que não tenham sido sondados.

A ordenação inicial é do menor para o maior ping. Empates são resolvidos pelo
  nome normalizado do servidor para evitar que a lista pule durante a chegada
  de eventos.

A recomendação é apresentada somente no modo manual:

1. se houver candidatos com download e upload medidos, aplica aos dados
   disponíveis o mesmo critério de capacidade da seleção automática, somente
   para exibir a recomendação; isso não recalcula nem altera a escolha
   automática;
2. se não houver velocidade concluída, recomenda o menor ping válido e rotula a
   linha como `Menor ping disponível`, não como rota mais rápida;
3. uma rota explicitamente reprovada no preflight nunca recebe a recomendação.

Durante a aplicação manual, todos os botões ficam desabilitados e a interface
mostra `Aplicando rota US#...`. Em sucesso, o comportamento segue o estado
atual: se o bypass estiver inativo, a GUI informa que a rota foi selecionada e
será usada na próxima ativação; se estiver ativo, a troca reutiliza o ciclo de
fechar Discord, recuperar WireSock, iniciar o novo perfil e reabrir o Discord.

Em falha, a linha escolhida recebe o motivo sanitizado, os demais candidatos
continuam disponíveis e o perfil anterior permanece intacto.

## Arquitetura e fluxo

O fluxo será:

```text
medição automática atual
        ↓ eventos existentes
lista acumulada no diálogo
        ↓ falha automática
seleção manual de servidor exato
        ↓ validação de filtros + ping + preflight rápido
geração atômica do perfil
        ↓
salvar perfil ou aplicar troca WireSock existente
```

### Estado dos candidatos

O renderer manterá um mapa da medição corrente, indexado pelo nome exato do
servidor. Eventos `ping`, `preparing` e `testing` atualizam a mesma linha em
vez de substituí-la. O estado local terá, no mínimo:

- `server`;
- `pingMs`;
- `downloadMbps` e `uploadMbps` opcionais;
- status independente de ping, preflight e velocidade;
- `selectable`, `recommended` e `failureReason` derivados;
- `measurementId` para rejeitar eventos e cliques obsoletos.

O `requestId` já usado pelo IPC continuará correlacionando os eventos durante a
medição. Após uma falha, a GUI conservará apenas a fotografia sanitizada da
medição corrente até fechar o diálogo ou iniciar outra medição. Não serão
armazenados endpoint, chave privada, token, sessão Proton ou caminho de perfil
temporário no estado do renderer.

### Seleção manual no backend

Será criado um IPC separado, `select-proton-route`, para não adicionar uma
ramificação silenciosa ao IPC automático `optimize-proton-route`. O renderer
enviará somente o nome exato do servidor e o identificador da medição. Nunca
aceitará endpoint, chave, caminho de configuração ou métricas fornecidos pela
interface.

O processo principal deverá:

1. validar o tamanho e o formato do nome;
2. confirmar que a medição pertence à janela/conta/filtros atuais;
3. buscar novamente a lista Proton;
4. confirmar país, plano, exclusão de BR, status online e peer WireGuard com IP
   e chave válidos;
5. confirmar o ping do servidor escolhido;
6. executar o preflight rápido WireGuard + HTTPS já utilizado pela seleção,
   sem exigir download/upload;
7. gerar o perfil para o servidor exato usando arquivo temporário;
8. promover o arquivo somente após resultado válido;
9. aplicar a rota pelo ciclo já existente quando o bypass estiver ativo.

O endpoint `-server` já existe no helper Go, mas o caminho de servidor específico
deverá ser endurecido para aplicar os filtros atuais. Não basta verificar apenas
`StatusOnline`, pois isso poderia permitir que uma escolha manual escapasse de
`free-only`, país selecionado ou exclusão de BR.

O modo manual do helper terá uma operação de validação rápida separada do
`-speed-test`. Ela usará o túnel userspace e uma requisição HTTPS de zero bytes,
mas não fará download/upload. O resultado JSON retornará o servidor, ping,
estado do preflight e o perfil staged; não retornará segredo.

### Aplicação e serialização

A seleção manual usará a fila de ciclo WireSock já existente. Não poderá
executar em paralelo com ativação, desativação, restauração, otimização ou
failover. Uma nova medição invalida seleções pendentes da medição anterior.

Se a GUI estiver ativa, a troca seguirá a sequência já usada pelo produto:

1. parar Discord e updater;
2. recuperar a sessão WireSock anterior;
3. instalar o novo perfil por aplicativo;
4. aguardar a estabilização local;
5. iniciar e confirmar o Discord;
6. manter probes de saída como diagnóstico assíncrono e `log-only`.

Se qualquer etapa real de criação, processo, serviço ou recuperação falhar, o
novo perfil não será considerado aplicado. A recuperação não poderá apagar a
rota anterior antes de o novo perfil estar staged e validado.

## Contratos de dados

O contrato de progresso existente será preservado para o caminho automático.
Os campos atuais de `phase`, `server`, `pingMs`, `downloadMbps`,
`uploadMbps` e `status` serão suficientes para alimentar a lista. Se for
necessário diferenciar uma falha de preflight de uma falha de velocidade, o
evento ganhará apenas um código de fase/status compatível; nenhum consumidor
automático poderá mudar sua decisão por causa desse campo.

O novo retorno `select-proton-route` seguirá o formato de metadados Proton já
usado pela GUI, acrescentando somente `manual: true` e uma mensagem de erro
sanitizada quando necessário. A resposta não incluirá chave privada, token,
conteúdo do `.conf` nem saída integral do helper.

## Abordagens rejeitadas

### Perfis antecipados para todos os candidatos

Daria uma seleção quase instantânea, mas criaria muitas chaves, arquivos
temporários e operações de limpeza. Também aumentaria o risco de um perfil
stale ser aplicado depois que o servidor saísse da API.

### Nova tela independente de servidores

Duplicaria a consulta, o ping e os filtros do fluxo atual. O usuário poderia
escolher uma rota que nunca foi medida pela operação que acabou de falhar.

### Aceitar qualquer rota somente porque respondeu ao ping

Ping não confirma UDP WireGuard, peer, HTTPS pelo túnel ou validade do perfil.
Por isso a escolha manual usa ping para ordenar, mas exige revalidação e
preflight antes de promover a configuração.

## Testes

### TypeScript/GUI

- agregar eventos de fases diferentes na mesma linha;
- ordenar por ping crescente e resolver empates de forma estável;
- calcular recomendação por velocidade ou menor ping;
- manter a lista após `success: false` e não mantê-la após cancelamento/novo
  `requestId`;
- habilitar seleção somente para ping válido e não para falha explícita de
  preflight;
- rejeitar clique de uma medição obsoleta;
- garantir que o caminho automático continue enviando os mesmos argumentos
  quando nenhum servidor manual for informado;
- exibir erro específico sem apagar os demais candidatos.

### Helper Go

- seleção exata de servidor online;
- rejeição de servidor fora do país/plano/filtro atual;
- rejeição de peer sem IP ou chave WireGuard válida;
- ping de confirmação com falha;
- preflight rápido com sucesso e falha;
- geração atômica e ausência de velocidade quando o modo manual não a mede;
- formato JSON e redaction sem segredo;
- regressão do caminho automático sem `-server`.

### Integração GUI

- seleção com bypass inativo salva o perfil sem alegar que o Discord já está
  conectado;
- seleção com bypass ativo troca a rota dentro da fila e reabre o Discord;
- falha manual preserva o perfil anterior;
- ativação, desativação e seleção concorrentes não se sobrepõem;
- eventos de uma medição anterior não alteram a lista atual.

### Validação funcional

Os testes unitários não comprovam captura WFP nem saída real do Discord. Antes
de publicar, a VM Windows deverá testar uma medição automática falha, selecionar
uma rota por ping, confirmar a aplicação no `AllowedApps`, verificar IP/HTTPS do
Discord e restaurar a rede. O restante do computador deverá manter a rota direta.

Linux GUI poderá reutilizar o contrato compartilhado, mas a validação de
ativação deverá respeitar seu helper/namespace existente. Plugin, standalone e
legado não serão alterados por esta feature.

## Critérios de aceite

- Nenhuma alteração observável no caminho automático bem-sucedido.
- Depois de uma falha automática, o usuário vê os candidatos realmente medidos
  e pode escolher o menor ping válido.
- Velocidades parciais permanecem visíveis e não são inventadas para rotas sem
  medição.
- A rota recomendada é distinguida de uma rota apenas com menor ping.
- Servidor offline, fora dos filtros, sem peer WireGuard ou sem preflight não é
  aplicado.
- O perfil anterior permanece quando a seleção manual falha.
- A troca ativa respeita isolamento por aplicativo, serialização e restauração.
- Nenhum segredo aparece na GUI, no JSON ou nos logs.
- A validação Windows confirma a rota do Discord, e não apenas que o processo
  WireSock está em execução.
