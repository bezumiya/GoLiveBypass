# Plugin GoLiveBypass v2 — transporte WireGuard e transmissão de tela

Data: 2026-09-07  
Status: aprovado para implementação

## Objetivo

Marcar o plugin como uma nova linha major (`2.0.0-beta.1`) porque o transporte
foi redesenhado para WireGuard/WireSock por aplicativo, e conduzir uma rodada
de correção baseada em evidência para o erro `2012` observado ao compartilhar a
tela durante uma call real do Discord na VM Windows.

Enquanto a validação não terminar, a versão será beta. A GUI Electron mantém
sua própria versão (`2.0.6-beta.2`) e não será alterada por esta migração.

## Limites e invariantes

- A VPN do plugin funciona somente em Windows x64 nesta linha.
- O plugin controla somente o WireSock que iniciou e não assume nem encerra um
  WireSock externo, da GUI ou de outro plugin.
- O filtro `AllowedApps` permanece limitado ao executável do Discord, ao
  `Update.exe` correspondente e aos helpers de diagnóstico estritamente
  necessários.
- O plugin não altera `app.asar`, não usa proxy/PAC/Tor e não compartilha estado
  com a GUI nem com o standalone.
- Probes de rota são diagnósticos; não bloqueiam a call, não encerram o Discord
  e não alteram a rota durante uma transmissão.
- Falha de diagnóstico não pode ser confundida com falha de criação ou limpeza
  do túnel.
- Nenhuma mensagem ou anexo será enviado a canal real como parte do teste; a
  call já aberta na VM é a superfície de validação.

## Arquitetura v2

### Renderer

`index.tsx` permanece responsável pela tela de configurações, seleção opcional
de região de voz/stream e coleta de sinais que só existem nas stores do
Discord. Ele não configura sockets, proxy ou WireSock. A guarda de transmissão
somente registra o estado e mostra aviso quando a UI afirma que existe uma Live,
mas nenhuma conexão nativa aparece após a janela de tolerância.

### Native/controller

`native.ts` expõe a ponte IPC e instancia `PluginVpnController`. O controller é
a autoridade de ciclo de vida: serializa ativação/desativação, mantém
ownership, grava o perfil privado, inicia o WireSock, acompanha a saúde e
restaura a rede somente ao desativar ou encerrar.

### WireSock

`vpn-windows.ts` valida o perfil, remove DNS do perfil, injeta `AllowedApps`,
instala/seleciona a versão compatível do WireSock e confirma serviço + perfil
antes de informar sucesso. O diagnóstico funcional deve ser interpretado junto
com o processo do Discord; handshake do WireGuard isolado não prova o caminho
efetivo da mídia.

## Fluxo de diagnóstico e correção

O ciclo será incremental e observará uma variável por vez:

1. Confirmar versão do plugin, estado `active`, ownership do WireSock e os
   executáveis efetivamente permitidos.
2. Coletar log sanitizado do plugin e registrar estado inicial da call.
3. Reproduzir a transmissão com região automática.
4. Se falhar, repetir com uma região de stream explícita, sem trocar a VPN no
   meio da call.
5. Usar a evidência para corrigir o componente responsável — sinalização de
   stream, seleção de região ou transporte — e criar um teste determinístico
   antes de repetir a VM.
6. Após cada alteração, executar testes, compilar o userplugin, instalar uma
   cópia identificável na VM e capturar screenshot/log novo.

O erro `2012` será tratado como sintoma até que os logs mostrem se a falha está
na criação da sessão nativa de stream, na região sinalizada, na rota do
processo ou em algum estado residual do WireSock. Não será introduzido um
patch de RTC nem uma troca automática de saída sem essa evidência.

## Versionamento e updater

Os três identificadores visíveis do userplugin devem convergir para
`2.0.0-beta.1`: `manifest.json`, constante de UI em `index.tsx` e constante do
updater em `native.ts`. O teste de comparação deve continuar tratando o beta
como mais novo que a linha `1.x`, sem considerar um prerelease como release
estável. A GUI não deve ser reversionada para acompanhar o plugin.

## Validação

### Automatizada

- Testes de contratos do plugin, guardas de fonte, estabilidade e updater.
- Build do userplugin no checkout Equicord/Vencord da VM.
- Verificação de que não há proxy/PAC/Tor nem dependência da GUI no plugin.
- Verificação de diff e de que nenhum segredo aparece nos logs coletados.

### VM Windows

O aceite funcional exige três tentativas consecutivas de compartilhar a tela na
call, sem `Erro 2012`, mantendo voz conectada e WireSock próprio ativo. Também é
necessário confirmar que:

- o Discord usa o perfil do plugin e somente os executáveis permitidos;
- a transmissão permanece funcional após reinício/reload do Discord;
- desativar o plugin restaura a rede e remove serviço, ownership e resíduos;
- um WireSock externo não é assumido nem encerrado;
- falhas de probe não derrubam o Discord nem promovem falsamente um estado de
  sucesso.

Screenshots e logs temporários ficam em `/tmp` e não entram no repositório.

## Fora do escopo

- Publicar release ou enviar anúncio para canal Discord.
- Alterar GUI Electron, standalone legado ou plugin para macOS/Linux.
- Usar o ID de canal fornecido anteriormente, que não foi necessário para a
  reprodução visual e aparenta não ter formato de Snowflake válido.

