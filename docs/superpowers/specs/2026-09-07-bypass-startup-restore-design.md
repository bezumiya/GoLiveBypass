# Restauração do bypass no autostart do Windows

## Status

Aprovado para implementação em 7 de setembro de 2026.

## Objetivo

Quando o GoLiveBypass for iniciado pelo autostart do Windows (`--hidden`), ele deve
lembrar a intenção do usuário sobre o bypass. Se o bypass estava ligado, o processo
deve selecionar/otimizar a rota antes de ativar o túnel e só então iniciar o Discord.
Se estava desligado, o boot não deve ativá-lo nem otimizar uma rota para ligá-lo.

## Escopo e limites

- O autostart existente continua sendo a entrada de login do usuário: HKCU Run no
  Windows portable e os mecanismos já existentes nas outras plataformas.
- A mudança usa o caminho WireGuard/WireSock da GUI. Não altera `app.asar`, o plugin
  Vencord/Equicord, o standalone legado ou o roteamento global do computador.
- O modo Proton recebe otimização automática no boot oculto. O modo `.conf`
  personalizado ativa diretamente porque não possui seleção Proton para executar.
- A abertura manual da janela mantém o fluxo atual do renderer; a nova reconciliação
  automática é limitada à entrada de autostart (`--hidden`) para não duplicar a medição
  visível nem surpreender uma abertura manual.

## Alternativas consideradas

1. Orquestrador no processo principal (escolhida): reutiliza a fila de lifecycle, roda
   sem janela e pode garantir a ordem otimização → túnel → Discord. É a opção mais
   confiável para o boot oculto.
2. Criar uma `BrowserWindow` oculta e dirigir o fluxo pelo renderer: reaproveita mais
   UI, mas introduz dependência de DOM, corrida com a inicialização da página e uma
   janela que não precisa existir no boot.
3. Instalar um wrapper/serviço externo para atrasar o Discord: poderia controlar a
   ordem fora do Electron, mas é específico do instalador, mais difícil de atualizar
   no portable e amplia a superfície de manutenção.

## Desenho aprovado

### Estado persistido

O `settings.json` compartilhado recebe `bypassEnabled`:

- `true` somente depois que a ativação do WireGuard/Discord terminou com sucesso;
- `false` depois de uma desativação explícita ou de uma restauração de internet
  solicitada pelo usuário;
- não é apagado durante `before-quit`, que apenas desmonta a sessão temporária;
- valores ausentes preservam o comportamento anterior: não fazem autoativação.

O marcador de sessão continua sendo um mecanismo de recuperação de processo/rede, não
a preferência do usuário. A chave legada `autoInject` não será usada para decidir o
boot WireGuard.

### Sequência do boot oculto

Depois de inicializar o logger, reparar as preferências WireGuard e sincronizar a
entrada de autostart:

1. verificar `launchedHidden()` e `bypassEnabled === true`;
2. no Proton, confirmar a conta/plano e executar uma medição completa com as mesmas
   restrições do otimizador normal, salvando o novo perfil apenas se ele for válido;
3. se a medição falhar, preservar e usar a última configuração Proton compatível;
4. se não houver perfil salvo, deixar `activateBypass` usar sua seleção rápida existente;
5. ativar pelo caminho WireGuard/WireSock já serializado;
6. aguardar a estabilização local do túnel, como nas ativações manuais, antes de iniciar
   e confirmar o Discord;
7. atualizar bandeja/janela e registrar sucesso ou falha no log.

A otimização não pode ser executada enquanto um túnel ativo estiver sendo usado. A fila
de lifecycle e a guarda de ativação continuam sendo a autoridade para evitar operações
concorrentes.

### Falhas

- Falha da medição não derruba uma rota já salva; o fallback é tentado antes da seleção
  rápida.
- Falha de ativação faz rollback pelo caminho WireSock existente, não inicia o Discord
  fora do túnel e mantém `bypassEnabled=true` para uma tentativa futura.
- Se nenhum perfil puder ser preparado, o app permanece inativo e registra o motivo;
  não haverá loop infinito nem bloqueio da rede do host.
- A ausência de credenciais Proton não será convertida em falso sucesso. O usuário
  poderá abrir a GUI, corrigir a conta/configuração e tentar novamente.

## Validação

- Testes unitários do estado persistido: ativação concluída, desativação explícita,
  quit limpo e restauração de internet.
- Testes de ordem: otimização concluída antes de `startWireSockService`, estabilização
  antes de `startDiscordAndConfirm`.
- Testes de fallback e de falha sem perfil.
- Regressão do autostart e `git diff --check`.
- `npm test` e `npm run compile` em `golive-gui/`.
- Smoke test no Linux disponível e teste de boot oculto na VM Windows, sem usar o
  Discord para validar a lógica do updater/boot.
