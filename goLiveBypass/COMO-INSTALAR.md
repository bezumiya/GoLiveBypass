# GoLiveBypass — plugin do Vencord/Equicord

Este zip traz os arquivos fonte do plugin (`index.tsx`, `native.ts`, `stability.ts`,
`vpn-*.ts` e `manifest.json`) e o helper x64 do Windows
(`bin/win32-x64/proton-confgen.exe`), que não tem equivalente embutido. No Linux o pacote
não carrega binário nenhum: o `vpn-proton.ts` já leva os dois helpers comprimidos e o
runtime os materializa quando não há `bin/linux-x64/` (veja **Linha v2 beta**). Ele não é um
instalador: os arquivos entram dentro de um **checkout (código-fonte) do Equicord ou do
Vencord**, que compila o plugin.

A VPN do plugin funciona em Windows x64 e Linux x64. Ela é autônoma: não depende da GUI
Electron, não compartilha o estado de rede do standalone e não altera o `app.asar` vanilla.
O standalone continua sendo um caminho separado — e segue pausado nesta linha — e não é
modificado por esta migração.

## Linha v2 beta

A versão atual do plugin é **2.0.0-beta.1**. Nesta linha, a VPN WireGuard/WireSock é
iniciada e controlada pelo próprio plugin, com estado privado em
`%LOCALAPPDATA%\\GoLiveBypass\\plugin-vpn` no Windows ou
`$XDG_DATA_HOME/GoLiveBypass/plugin-vpn` no Linux (por padrão `~/.local/share/GoLiveBypass/plugin-vpn`).
O watchdog e as probes de rede são diagnósticos: eles registram evidências sem derrubar o
Discord por uma leitura transitória.
Em clientes Linux empacotados, o bundle pode não copiar arquivos arbitrários de
`src/userplugins`. Por isso, o `vpn-proton.ts` contém os helpers Linux comprimidos e os
materializa, após conferir SHA-256, dentro da pasta privada do plugin com modo 0700. Um
checkout fonte continua preferindo os arquivos de `bin/`; nenhuma variável de ambiente é
necessária para o build empacotado.

O beta ainda não é um release estável. O updater ignora prereleases quando consulta o
canal estável; para testar esta linha, instale o código-fonte do plugin e recompile o
checkout do Equicord/Vencord. A versão `2.0.0-beta.1` também pode aparecer como
`2.0.0-beta-1` nas releases; os dois formatos representam a mesma sequência beta.

## Atualizações do plugin

O plugin tem um updater próprio, separado do updater da GUI e do standalone. Ele consulta
as releases do repositório do projeto e instala somente o asset
`goLiveBypass-vencord.zip`, acompanhado de `goLiveBypass-vencord.zip.sha256`.

- **Estável** é o canal padrão: recebe somente releases estáveis e nunca instala uma
  prerelease. Quem estiver usando uma beta pode voltar para uma versão estável quando
  houver uma versão estável mais nova, sem downgrade.
- **Beta** é opcional: nas configurações do GoLiveBypass, selecione o canal **Beta** para
  participar dos testes e receber releases estáveis e prereleases. A beta continua marcada
  como prerelease no GitHub e não substitui a release estável do canal padrão.
- **Atualização automática** vem ligada por padrão. Quando ligada, o plugin verifica em
  segundo plano e prepara a atualização; quando desligada, as verificações automáticas são
  interrompidas, mas **Verificar agora** e **Atualizar** continuam disponíveis no painel.
- Antes de substituir os arquivos, o updater confere HTTPS, o manifesto do plugin, o
  tamanho do arquivo e o **SHA-256** publicado. Se a validação ou a recompilação falhar,
  o backup anterior é restaurado e a VPN, a chamada e o Discord permanecem intactos.
- A atualização nunca reinicia o Discord silenciosamente. Depois de uma atualização
  preparada, o painel informa que é necessário fazer um **reload/recarregar manualmente o
  Discord** para executar a nova versão; faça isso fora de uma chamada quando for possível.

As preferências do plugin ficam no próprio checkout do Vencord/Equicord e não são
compartilhadas com a GUI Electron ou com o standalone. Atualizar o plugin não atualiza a
GUI, não altera o `app.asar` e não assume nem controla um WireSock iniciado por outro
componente.

## Assistente dentro do Discord

Na primeira ativação do plugin, o assistente abre dentro do Discord e conduz duas etapas
sequenciais: validar a sessão da conta Proton e preparar/otimizar a rota WireGuard. Uma
sessão salva pode seguir sem redigitar a senha; sessão inválida, erro de rede, timeout,
CAPTCHA e 2FA aparecem como estados distintos, sem colocar senha ou token no diagnóstico.
Trocar o usuário inicia uma nova sessão e o botão para sair remove a sessão privada.

Na etapa da rota, o progresso exibido vem dos eventos reais do controlador: fase atual,
servidores testados/aprovados, servidor escolhido e latência/velocidades quando medidas.
Cancelar interrompe a otimização sem ativar ou reiniciar o Discord. A conclusão apenas
salva a preparação; a ativação do túnel continua sendo uma ação separada no painel. O
assistente pode ser adiado e reaberto pelo botão **Abrir guia de configuração** ou pela
ação do Toolbox do Vencord/Equicord.

## Instalação resumida

1. Tenha o **Git**, **Node.js 22+** e **pnpm** instalados. No Linux, instale também
   `iproute2`, `wireguard-tools` e `polkit`; o cliente precisa de uma sessão `systemd --user`
   quando o relaunch sair da namespace.
2. Baixe o código do Equicord (ou Vencord):
   `git clone https://github.com/Equicord/Equicord` (ou Vencord/Vencord)
3. Copie **esta pasta** (`goLiveBypass`) para dentro de `src/userplugins/`
   do checkout. Se a pasta `userplugins` não existir dentro de `src/`,
   **crie ela** — ela fica **ao lado** de `src/plugins`, nunca dentro.
   No final o caminho deve ser exatamente:
   `src/userplugins/goLiveBypass/index.tsx`
4. No checkout: `pnpm install`, depois `pnpm build` e `pnpm inject`
   (escolha o seu Discord quando perguntar).
5. Reinicie o Discord por completo e ative **GoLiveBypass** nas
   configurações de plugins. Ao ativar, a VPN WireGuard sobe automaticamente; ao desativar,
   o plugin para somente o WireSock/namespace que ele próprio iniciou e restaura a rede.

No Linux, ao clicar em **Ativar agora**, o plugin verifica as dependências sem alterar a
rede e abre o diálogo nativo do polkit para autorização administrativa. Informe a senha
do sistema nessa janela — nunca a senha da conta Proton. Se não houver agente gráfico
polkit no desktop, o próprio `pkexec` será aberto em um terminal nativo disponível para
fazer a mesma solicitação. Cancelar ou fechar o diálogo não cria namespace/interface nem
encerra o Discord. O plugin não amplia o túnel para os demais aplicativos.

O instalador do plugin existe nos dois sistemas e entrega a linha beta:

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/bezumiya/GoLiveBypass/main/installer/GoLiveBypass-Installer.ps1 -OutFile $env:TEMP\glb-beta.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\glb-beta.ps1" -Mode Install -Mod Vencord -Yes
```

```sh
# Linux
curl -fsSL https://raw.githubusercontent.com/bezumiya/GoLiveBypass/main/installer/golivebypass-installer.sh -o /tmp/glb-beta.sh && chmod +x /tmp/glb-beta.sh && /tmp/glb-beta.sh --install --mod vencord --yes
```

Os dois abrem com o aviso de beta e baixam o pacote da release (`goLiveBypass-vencord.zip`)
conferindo o **SHA-256** publicado antes de extrair; não copiam arquivos soltos da `main`, que
pode estar atrás da tag. O Windows baixa também o helper Proton x64 da beta mais recente, com
validação de SHA-256 contra o manifesto publicado. O standalone não é alterado por esse
caminho — ele segue pausado.

Para usar o modo Proton, informe o usuário e a senha na seção da VPN. O CAPTCHA, quando
solicitado, abre em uma janela isolada; a sessão fica na pasta privada indicada acima e
é protegida pelo armazenamento seguro do Electron. Em máquinas sem esse armazenamento
(sem Secret Service/libsecret no Linux), a sessão não é gravada: ela vale só enquanto o
Discord estiver aberto e o painel avisa disso antes do login. Senhas e códigos não entram em logs.
Para um perfil próprio, escolha **Arquivo WireGuard personalizado** e informe o caminho do
`.conf`; o plugin copia o perfil para sua pasta privada, remove DNS do perfil e isola somente
o executável do Discord e o `Update.exe` da instalação atual (ou o cliente dentro da namespace Linux).

## Tutorial completo

O README do projeto tem o passo a passo detalhado (com prints de erro
comuns) na seção **"Instalação: passo a passo completo"**:
https://github.com/bezumiya/GoLiveBypass#instala%C3%A7%C3%A3o-passo-a-passo-completo

## Já tenho o Vencord instalado pelo instalador oficial — e agora?

O plugin **convive** com o seu Vencord/Equicord atual, mas o caminho acima
compila tudo do zero: seus plugins atuais ficam salvos e você os reativa nas
configurações depois do build. Substituir o mod pelo standalone — que era a
alternativa sem compilação — não vale hoje: o **standalone está pausado** nesta
linha e só volta depois da portabilidade para o WireGuard.
