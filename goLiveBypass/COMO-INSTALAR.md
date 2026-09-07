# GoLiveBypass — plugin do Vencord/Equicord

Este zip traz os arquivos fonte do plugin (`index.tsx`, `native.ts`, `stability.ts`,
`vpn-*.ts` e `manifest.json`) e, nos releases oficiais, o helper x64
`bin/win32-x64/proton-confgen.exe`. Ele não é um instalador: os arquivos entram dentro de um
**checkout (código-fonte) do Equicord ou do Vencord**, que compila o plugin.

Por enquanto a VPN do plugin funciona somente em Windows x64. Ela é autônoma: não depende da
GUI Electron, não compartilha o estado de rede do standalone e não altera o `app.asar` vanilla.
O standalone continua sendo um caminho separado e não é modificado por esta migração.

## Instalação resumida

1. Tenha o **Git**, **Node.js 22+** e **pnpm** instalados.
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
   o plugin para somente o WireSock que ele próprio iniciou e restaura a rede.

Para usar o modo Proton, informe o usuário e a senha na seção da VPN. O CAPTCHA, quando
solicitado, abre em uma janela isolada e a sessão fica em `%LOCALAPPDATA%\\GoLiveBypass\\plugin-vpn`.
Para um perfil próprio, escolha **Arquivo WireGuard personalizado** e informe o caminho do
`.conf`; o plugin copia o perfil para sua pasta privada, remove DNS do perfil e injeta
`AllowedApps` somente para o executável do Discord e o `Update.exe` da instalação atual.

## Tutorial completo

O README do projeto tem o passo a passo detalhado (com prints de erro
comuns) na seção **"Instalação: passo a passo completo"**:
https://github.com/bezumiya/GoLiveBypass#instala%C3%A7%C3%A3o-passo-a-passo-completo

## Já tenho o Vencord instalado pelo instalador oficial — e agora?

O plugin **convive** com o seu Vencord/Equicord atual, mas o caminho acima
compila tudo do zero: seus plugins atuais ficam salvos e você os reativa nas
configurações depois do build. Se não quiser compilar, a alternativa é
continuar usando o **standalone** (que substitui o mod — e aí você perde os
plugins dele).
