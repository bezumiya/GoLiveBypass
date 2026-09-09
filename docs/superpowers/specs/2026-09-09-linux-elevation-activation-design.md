# Elevação Linux e ativação segura do Discord

## Contexto

A issue [#258](https://github.com/bezumiya/GoLiveBypass/issues/258) relata que o Discord fica
preso em “Iniciando...” ao ativar o bypass pela GUI Linux, em uma sessão Wayland com
Equicord. O relato registra `elevation=sudo` no preflight e, durante a ativação, a mensagem
“não foi possível obter a senha do sudo”.

## Causa confirmada

O caminho da GUI executa o standalone com `GOLIVE_GUI=1`, `--yes` e `--cleanup-legacy`.
No modo de instalação, o standalone chama `stop_discord` antes de `setup_wireguard_netns`.
A primeira operação elevada passa por `sudo_authenticate_once`: tenta `sudo -n true`,
seleciona `zenity` ou `kdialog` para coletar a senha e só considera a senha validada
depois de `sudo -S -k -v`.

O código atual não registra o provedor escolhido, se o diálogo foi iniciado, se retornou
texto ou se a validação foi aceita. O erro observado significa que `sudo_pass_get` recebeu
uma resposta vazia ou não encontrou um provedor; não prova que o usuário viu ou preencheu
um diálogo. Uma senha incorreta teria produzido a mensagem distinta “a senha do sudo foi
recusada”. Como o cliente já havia sido encerrado, qualquer um desses caminhos deixava o
Discord fora do namespace e sem uma nova inicialização.

## Objetivos

- Confirmar no log, sem registrar a senha, qual método de elevação foi tentado e em que
  estado terminou.
- Validar a autorização antes de fechar qualquer instalação do Discord.
- Distinguir autorização já disponível, prompt não encontrado, prompt cancelado/sem entrada,
  senha recusada, senha aceita e falha do `pkexec`.
- Preservar o isolamento por namespace WireGuard, a serialização existente e o comportamento
  não interativo dos probes de saúde.
- Não instalar gerenciadores de senha, não transportar a senha pela IPC do Electron e não
  alterar permissões permanentes do sistema.

## Projeto proposto

### Transação de elevação no standalone

O script manterá um estado efêmero da autorização e um provedor sanitizado. A rotina de
autenticação será chamada pelo fluxo de ativação depois do preflight e antes de
`stop_discord`.

Para `sudo`, a sequência será:

1. testar `sudo -n true` e registrar `provider=sudo result=cached` quando a autorização já
   estiver disponível;
2. registrar `prompt.requested` com `zenity` ou `kdialog`, executar o diálogo capturando
   apenas código de saída e presença/ausência de texto, e registrar `prompt.finished`;
3. validar a entrada exclusivamente com `sudo -S -k -v`, registrar `result=accepted` ou
   `result=rejected`, e manter a senha somente no arquivo temporário já protegido e apagado
   pelo `trap` existente;
4. quando não houver prompt de senha e houver `pkexec`, usar o prompt do polkit e registrar
   somente seu início e resultado. O estado selecionado será reutilizado pelas chamadas
   elevadas da mesma operação, sem pedir credenciais em probes automáticos.

Nenhum log conterá senha, comprimento da senha, conteúdo do stderr do prompt ou token de
sessão. Caminhos e comandos continuarão sujeitos à redação existente nos relatórios.

### Ordem da ativação

O fluxo será reorganizado para que uma falha na autenticação aconteça antes de qualquer
`stop_discord`, remoção de Singleton ou alteração do namespace. O erro exibido pela GUI
incluirá o resultado sanitizado da autenticação e uma instrução acionável, sem confundir
Equicord/Vencord com a causa.

As operações de saúde e status continuarão usando `elevate_readonly` com
`NONINTERACTIVE=1`; elas nunca abrirão `zenity`, `kdialog`, `pkexec` ou `sudo` interativo.

### Documentação e testes

O comportamento será documentado no `CHANGELOG.md` como correção Linux específica da GUI;
os caminhos Windows, plugin e standalone CLI não receberão garantias que não implementam.
Os testes do standalone cobrirão:

- `sudo -n` já autorizado, sem prompt;
- `zenity`/`kdialog` iniciado e senha aceita;
- diálogo cancelado ou resposta vazia;
- senha preenchida, mas recusada pelo `sudo`;
- ausência de prompt com fallback funcional para `pkexec`;
- `NONINTERACTIVE=1` sem qualquer prompt;
- falha de autenticação sem chamar `stop_discord`.

A validação será feita com `npm test -- tests/linux-elevation.test.ts`
e `npm test -- tests/linux-preflight.test.ts`, `bash -n standalone/golivebypass-standalone.sh`,
`npm run compile` e `npm run check-bypass`. Uma execução sintética não será apresentada como
prova de uma sessão Wayland real; essa limitação ficará registrada caso não haja ambiente
gráfico do usuário para reprodução.

## Alternativas consideradas

- **Diálogo nativo do Electron:** daria uma aparência consistente, mas exigiria transportar
  um segredo entre renderer, preload e processo shell, ampliando a superfície de exposição.
- **Provedor de sistema instrumentado (escolhido):** mantém a senha no prompt do sistema,
  comprova no log se a autenticação foi solicitada/aceita e exige apenas mudanças locais no
  fluxo já existente.
- **Instalar automaticamente um provedor de prompt:** poderia cobrir imagens mínimas, mas
  exige uma elevação anterior, é dependente da distribuição e não resolve o primeiro prompt.

## Fora do escopo

- Alterar a política `sudoers` do usuário.
- Instalar ou habilitar serviços permanentes de polkit/sudo.
- Fazer probes de IP, handshake ou telemetria decidirem se o Discord pode abrir.
- Mudar o comportamento do WireSock Windows, do plugin Vencord/Equicord ou do standalone CLI.
