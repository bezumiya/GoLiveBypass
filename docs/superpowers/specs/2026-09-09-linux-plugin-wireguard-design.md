# Plugin Linux com WireGuard isolado — Especificação de design

**Data:** 2026-09-09  
**Status:** aprovado para especificação pelo usuário  
**Escopo:** plugin GoLiveBypass para Equicord/Vencord em Linux x86_64

## Objetivo

Tornar o transporte VPN do plugin funcional no Linux x86_64 usando o instalador já
publicado no README, `installer/golivebypass-installer.sh`, como o único ponto de
bootstrap. O Discord modificado deve nascer dentro de um namespace de rede com
WireGuard, enquanto o restante do computador mantém a rota normal. Ativar,
restaurar e repetir a operação deve ser seguro e comprovável com tráfego real.

O usuário fornece uma sessão Proton ou um arquivo WireGuard personalizado. O
instalador prepara dependências e o plugin prepara o túnel; nenhum segredo de
conta é inventado ou gravado pelo instalador.

## Limites da primeira versão

- Suporte: Linux x86_64, Discord desktop nativo executado com Equicord ou Vencord.
- O plugin continua autônomo: não compartilha namespace, lock, perfil ou processo
  com a GUI Electron nem com o standalone.
- Windows x64 continua usando WireSock e seu caminho atual.
- macOS, ARM64 e clientes Flatpak/Snap não serão declarados suportados pelo
  transporte Linux nesta etapa. O instalador detectará esses casos e informará a
  limitação antes da injeção ou ativação, sem aplicar uma rota parcial.
- O instalador não remove pacotes de sistema no `--uninstall`; eles podem ser
  usados por outros programas. A remoção desfaz a injeção, o plugin e o estado
  próprio do GoLiveBypass.
- Probes de IP, HTTP, gateway e handshake são diagnósticos. Eles registram o que
  foi observado, mas não bloqueiam uma ativação já funcional nem derrubam o
  Discord por uma divergência geográfica.

## Abordagens consideradas

### 1. Helper Linux privilegiado único — escolhida

O plugin terá um backend `vpn-linux.ts` e um helper shell interno, distribuído
junto com o plugin, responsável somente pelas operações que exigem privilégio:
criar/inspecionar/remover o namespace, configurar a interface WireGuard e
executar o Discord dentro dele. O backend chama o helper por `pkexec` ou `sudo`,
passando somente ações e caminhos validados, nunca chaves ou senhas na linha de comando.

Essa abordagem concentra quoting, rollback e elevação em um único limite. Também
permite testar o helper com `sh -n` e testes de comportamento sem misturar
permissão root com a lógica de estado do TypeScript.

### 2. Comandos privilegiados diretamente no TypeScript

O controlador chamaria `sudo`, `ip` e `wg` individualmente para cada etapa. É
menor no começo, mas espalha elevação, preservação de ambiente gráfico e limpeza
por vários caminhos; uma falha entre comandos teria mais chance de deixar
namespace ou processo órfão.

### 3. Daemon root permanente

O instalador criaria um serviço privilegiado permanente e o plugin conversaria
com ele. Isso facilitaria relaunch e recuperação após o processo do Discord
fechar, mas adicionaria serviço persistente, protocolo, atualização e superfície
de segurança desnecessários para um túnel que só existe enquanto o plugin está
ativo.

## Arquitetura

### Instalador oficial

`installer/golivebypass-installer.sh` deixará de sair imediatamente com o aviso
de portabilidade. No caminho `--install` e no menu de instalação, ele executará
um preflight Linux antes de clonar ou compilar o mod:

1. detectar `apt`, `dnf`, `pacman`, `zypper` ou `apk`;
2. instalar, com confirmação normal ou `--yes`, as ferramentas de build e runtime
   ausentes: Git, Node 22+, npm/pnpm, `iproute2`, `wireguard-tools`, `curl` e
   `unzip` quando necessário;
3. verificar `sudo` ou `pkexec`, o módulo WireGuard do kernel, `ip netns`, `wg`
   e `wg-quick`;
4. quando o Node distribuído for menor que 22, preparar uma versão 22+ em uma
   pasta do usuário sem rebaixar ou substituir silenciosamente o Node existente;
5. copiar todas as fontes do plugin Linux, o helper interno e o binário
   `proton-confgen` Linux x64, ou compilá-lo a partir da fonte versionada quando
   a instalação estiver usando uma cópia local;
6. compilar e injetar o mod, validando que o checkout realmente aponta para o
   plugin copiado antes de declarar sucesso.

O preflight será idempotente. Cada comando de pacote será exibido antes de ser
executado; `--yes` autoriza o fluxo automático já documentado pelo instalador,
mas a elevação do gerenciador de pacotes continuará sendo realizada pelo
provedor padrão do sistema. Se a distribuição não for reconhecida, se a
autorização não estiver disponível ou se o kernel não suportar WireGuard, o
instalador para antes de fechar/injetar o Discord e mostra o comando manual
correspondente.

O `--uninstall` e o `--restore` continuam sendo operações do instalador sobre o
checkout e a injeção. Eles também chamarão uma limpeza best-effort do estado
próprio do plugin, sem matar processos com nome genérico e sem remover
dependências compartilhadas.

### Backend Linux do plugin

Será criado `goLiveBypass/vpn-linux.ts`. A interface pública será paralela ao
backend Windows, mas com tipos próprios para não fazer o controlador assumir que
serviço Windows e namespace Linux têm o mesmo estado. Ela fornecerá:

- preflight e inspeção do namespace/interface pertencentes ao plugin;
- validação do perfil WireGuard usando o contrato comum de `vpn-types.ts`;
- start/stop idempotentes com confirmação do estado após cada etapa;
- leitura de handshake e RX/TX para diagnóstico;
- execução do Discord dentro do namespace preservando `HOME`, Wayland/X11,
  DBus, áudio, PipeWire e os argumentos originais do Electron;
- limpeza de namespace, arquivo de resolução e processo de lançamento somente
  quando o ownership do plugin for confirmado.

O namespace e a interface terão nomes estáveis e exclusivos do plugin. Antes de
reutilizá-los, o helper verificará marcadores de ownership, PID e configuração.
Um namespace ou interface já existente sem marcador compatível será tratado como
externo e não será removido.

O caminho de configuração usa uma cópia privada em
`$XDG_DATA_HOME/GoLiveBypass/plugin-vpn`, com modo 0600. As ações do helper serão
limitadas a `preflight`, `status`, `start`, `launch`, `stop` e `cleanup`, com o
diretório de dados validado contra a raiz esperada. Para `launch`, o backend
escreverá um descritor temporário 0600 contendo executável, argumentos e o
ambiente gráfico necessário; o helper validará que o executável pertence ao
processo/instalação atual, consumirá o descritor e o removerá. Nenhum segredo
será passado por argumento ou ambiente do processo root. A configuração é
aplicada sem DNS global e sem alterar a tabela de rotas do host. A rota padrão
fica dentro do namespace; a rota necessária para alcançar o endpoint WireGuard
permanece no caminho normal de saída do host conforme o modelo Linux já validado
no projeto.

### Controlador e ciclo de vida

`vpn-controller.ts` passará a selecionar o backend por plataforma:

- Windows x64: fluxo WireSock atual, sem mudança de ownership;
- Linux x86_64: fluxo namespace/WireGuard novo;
- demais plataformas: estado `blocked_external` com mensagem explícita.

O registro de ownership ganhará os dados necessários para identificar namespace,
interface, processo e geração. A fila de operações, o mutex, a proteção contra
respostas atrasadas e o watchdog continuarão compartilhados conceitualmente, mas
cada backend confirmará seu próprio estado. Um watchdog Linux só registrará
degradação; não removerá automaticamente o túnel por uma probe de rede falha.

Ao ativar com `relaunch=true`, o controlador:

1. valida ou gera o perfil;
2. adquire o lock do plugin;
3. cria e confirma o namespace e o túnel;
4. grava `restarting=true` no owner;
5. encerra o Discord atual e lança o mesmo executável dentro do namespace,
   preservando o ambiente gráfico;
6. aguarda o processo novo e confirma que ele pertence ao namespace antes de
   marcar a sessão como ativa.

Se qualquer etapa falhar, o rollback tenta parar o processo novo, desmontar
somente o namespace próprio e reabrir o Discord fora do namespace. Se a limpeza
não puder ser confirmada, o estado será `recovery_required` e o log indicará a
ação manual exata; o host não terá sua rota padrão modificada como fallback.

Ao restaurar, o controlador encerra somente o processo que foi lançado pelo
plugin, remove o namespace próprio, remove o owner e reabre o Discord normal.
Após o relaunch, a nova instância poderá adotar o owner se todos os marcadores
forem compatíveis. Uma sessão externa ou um lock vivo de outra instância será
preservado.

### Proton, configuração e pacote

`vpn-proton.ts` continuará gerando o perfil pela sessão Proton, mas localizará
`proton-confgen` em `bin/linux-x64/` antes dos caminhos de desenvolvimento. O
workflow de release produzirá os binários Windows x64 e Linux x64 no mesmo ZIP,
com manifest e lista de arquivos atualizados. O instalador local poderá usar uma
cópia de desenvolvimento; o instalador remoto usará o asset versionado e seu
SHA-256.

O modo personalizado aceitará o mesmo `.conf` WireGuard válido. O backend Linux
removerá apenas diretivas incompatíveis com o namespace gerenciado, como DNS
global, sem registrar a chave em logs ou argumentos.

## Fluxo de dados

```text
README -> installer/golivebypass-installer.sh
       -> preflight/pacotes -> checkout Equicord/Vencord
       -> copia plugin + helper + confgen Linux -> build/inject

Plugin native/controller -> vpn-linux.ts -> pkexec/sudo -> linux-helper.sh
                         -> namespace + wg -> Discord dentro do namespace
                         -> status/handshake/RX-TX -> log do plugin
```

O restante do computador nunca será colocado no namespace nem terá a rota
default substituída. O estado do plugin Linux ficará separado do estado da GUI e
do standalone.

## Erros e segurança

- Elevação cancelada ou indisponível: ativação abortada antes de fechar o
  Discord, com instrução para repetir pelo botão ou executar o comando exibido.
- Ferramenta ausente após o preflight: erro específico com pacote/comando
  faltante; não tentar um fallback de proxy.
- Namespace/interface externo: `blocked_external`, sem assumir ou remover.
- Falha parcial de start: rollback ordenado; `recovery_required` se a ausência
  do namespace/processo não puder ser confirmada.
- Discord não inicia dentro do namespace: remover o namespace próprio, reabrir
  fora dele somente depois da limpeza e registrar a causa.
- Handshake, HTTP ou IP inconclusivo: diagnóstico assíncrono e log-only quando
  o túnel já está confirmado.
- Caminhos, argumentos e nomes de ação serão validados; chaves, tokens, senha e
  URL de sessão não aparecerão em logs, arquivos de comando ou mensagens.

## Validação e critérios de aceite

### Testes automatizados

- testes puros de `vpn-types.ts` para plataforma, nomes, configuração e
  normalização;
- testes de `vpn-linux.ts` com comandos simulados para criação, inspeção,
  rollback, ownership e relaunch;
- teste shell `sh -n` e teste comportamental do `linux-helper.sh` com um `PATH`
  controlado;
- atualização do teste de pacote para exigir os arquivos Linux e ambos os
  helpers `proton-confgen`;
- `go test ./...` em `tools/proton-confgen/`;
- regressão do controlador e `npm test`/compilação do mod conforme os scripts do
  checkout usado.

### Teste real nesta máquina

O ciclo mínimo de aceite será executado no Discord oficial local com o plugin
compilado pelo Equicord:

1. registrar a rota default do host, processos Discord e estado de namespaces;
2. executar o instalador com `--source` local e confirmar a instalação automática
   das dependências já ausentes, sem tocar no Discord oficial até a etapa de
   injeção;
3. ativar o plugin e confirmar namespace, processo Discord dentro dele,
   handshake WireGuard e RX/TX positivos;
4. confirmar que um processo de teste fora do namespace mantém a rota/IP do
   host;
5. repetir ativação, restauração e relaunch por pelo menos três ciclos;
6. restaurar a rede, confirmar ausência do namespace/interface/owner e confirmar
   que o Discord volta a abrir fora do túnel;
7. executar novamente os testes automatizados e verificar `git diff --check`.

O aceite não declarará “IP estrangeiro” como garantia do produto; registrará
apenas a evidência de que o processo do Discord usou o namespace WireGuard e de
que o túnel teve handshake/tráfego.
