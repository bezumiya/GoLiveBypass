# Limpeza segura dos probes de rota do plugin

## Problema observado

O estado sanitizado da VM mostrou dezenas de arquivos `.golive-route-probe-*.exe`
acumulados em `AppData\\Local\\GoLiveBypass\\plugin-vpn`. A causa está no
ciclo de vida atual: o watchdog executa o probe de forma assíncrona, a remoção
tenta apagar apenas uma vez e ignora falhas, e uma falha de ativação pode
liberar `owner.lock` antes de remover a cópia recém-criada. No boot sem serviço
ativo, o owner antigo também é liberado sem uma varredura de resíduos.

O cliente Discord oficial não apresentou crash reproduzível nesta mesma rodada;
voz e recebimento de transmissão chegaram a `native-connected`. Portanto, esta
mudança trata uma regressão de estabilidade/manutenção independente do erro de
abertura relatado.

## Objetivo e invariantes

- Remover probes órfãos do diretório exclusivo do plugin em boot sem serviço,
  após parada e em falhas de ativação.
- Preservar o probe referenciado pelo owner ativo e qualquer probe cujo processo
  de diagnóstico ainda esteja em voo.
- Aceitar somente o nome exato
  `.golive-route-probe-<pid>-<timestamp>.exe` no diretório informado.
- Não seguir symlinks, não aceitar traversal e não apagar caminhos fora do
  diretório de dados do plugin.
- Usar retry limitado para bloqueios transitórios do Windows; falha de limpeza
  permanece diagnóstica e não bloqueia a ativação nem a restauração da rede.
- Tornar a liberação do owner condicional ao mesmo `pid`, `generation` e
  `createdAt`, evitando que uma operação tardia remova o lock de uma sessão
  nova.
- Manter diagnóstico de rota em modo log-only e não alterar o isolamento por
  aplicativo, o serviço WireSock ou o estado de chamadas/transmissões.

## Desenho

### Camada Windows

`goLiveBypass/vpn-windows.ts` terá um predicado de caminho gerenciado e uma
rotina de varredura. A rotina lista apenas entradas regulares cujo basename
corresponda ao padrão estrito, ignora os caminhos protegidos e ignora arquivos
recentes durante uma pequena janela de segurança. A remoção individual usa
`lstat` e três tentativas assíncronas limitadas, sem remoção recursiva; symlink,
entrada não regular, path inválido ou arquivo ainda bloqueado não é removido
nem seguido.

O resultado da varredura informa contagens de removidos, protegidos, recentes,
inválidos e ocupados para logging sanitizado. A API não contém credenciais,
configuração WireGuard ou dados de sessão.

### Controlador

`PluginVpnController` registrará o caminho assim que a cópia do probe for
criada. As promises de `runRouteProbe` serão acompanhadas em um conjunto; antes
da limpeza dos caminhos conhecidos, o controlador aguardará essas operações
terminarem ou atingirem o timeout próprio do probe. A limpeza ocorrerá:

1. no boot sem WireSock ativo, antes de liberar o owner antigo;
2. antes de criar uma nova cópia em uma ativação sem serviço;
3. após o serviço próprio ser parado;
4. no caminho de erro da ativação, antes de liberar o owner.

Quando o serviço está ativo, a varredura pode remover somente resíduos antigos
que não sejam o probe do owner atual. Qualquer falha da varredura é registrada
como diagnóstico e não muda o resultado da operação de rede.

### Concorrência e segurança

O controlador guarda o token (`pid`, `generation`, `createdAt`) da sessão que
registrou o probe. Antes de remover um caminho conhecido, a identidade do owner
atual precisa coincidir; antes de uma varredura, a presença de outro token faz a
rotina desistir. A remoção do lock compara identidade completa do registro;
respostas atrasadas não podem apagar o lock de uma nova geração. O `probePath`
lido do owner só pode ser usado para execução ou remoção se estiver dentro do
diretório de dados e obedecer ao padrão. O controlador não encerra processos
por PID e não interfere em WireSock externo.

## Validação

- Teste unitário Node do módulo Windows para geração, cópia, idempotência,
  padrão seguro, proteção de symlink/arquivo recente e varredura.
- Teste de fonte do controlador para garantir registro imediato, espera das
  promises e ordem limpeza→liberação do owner.
- Suíte atual do plugin, `go test ./...` do helper e E2E de empacotamento.
- VM Windows com o artefato atual: confirmar a nova versão do helper, repetir
  ativação/diagnóstico, fechar/reabrir o Discord e verificar que não há probes
  residuais fora do caminho protegido; registrar separadamente qualquer
  bloqueio de exclusão causado pelo Windows.

## Limitações

Linux não reproduz fielmente o compartilhamento de arquivo `.exe` em uso no
Windows. A confirmação final de retry sob lock exige a VM. A limpeza não é uma
prova de rota geográfica e não transforma os probes em condição de ativação.
