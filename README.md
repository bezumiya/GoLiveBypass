# GoLiveBypass — Bypass do Go Live no Discord (Brasil)

<p align="center">
  <a href="https://golivebypass.dev/"><img src="https://img.shields.io/badge/🌐_Site_oficial-golivebypass.dev-5865F2?style=for-the-badge" alt="Site oficial"></a>
  <a href="https://discord.gg/7cWbtr82rG"><img src="https://img.shields.io/badge/💬_Discord-Entrar_na_comunidade-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Entrar no Discord"></a>
</p>

Feito por um desenvolvedor brasileiro, o GoLiveBypass **devolve o Go Live e a câmera para usuários brasileiros** no Discord para computador. Na versão 2.0.0, a GUI cria um túnel WireGuard exclusivo para os processos do Discord, sem transformar a conexão inteira do computador em VPN.

No Windows, o WireSock aplica o túnel via WFP somente a `Discord.exe` e `Update.exe`. No Linux, o Discord é iniciado dentro de um namespace de rede dedicado. Navegadores, jogos e os demais aplicativos continuam usando a rede normal. Os detalhes técnicos ficam [mais abaixo](#como-funciona-na-versão-200).

> **English summary below / Resumo em inglês no final.**

## Escolha sua variante

Você não precisa usar todas as opções. Escolha uma delas:

| Variante | É para você se... | O que fazer |
|---|---|---|
| **[GUI](#-versão-200-interface-gráfica-com-wireguard-por-aplicativo)** | quer ativar e desativar com poucos cliques, sem terminal | baixe o aplicativo para Windows ou Linux |
| **[Standalone](#modo-standalone-só-o-discord-sem-equicord-e-sem-vencord)** | usa o Discord puro e não quer instalar Equicord/Vencord | temporariamente indisponível na 2.0.0 |
| **[Plugin](#instalação-do-plugin-recomendado-para-equicord-vencord-e-vesktop)** | já usa Equicord, Vencord ou Vesktop | instalador em beta, para Windows e Linux |

> **Regra rápida:** GUI para simplicidade, standalone para Discord sem mods, plugin para quem já usa um mod.

> **Status da versão 2.0.0:** a migração do plugin para a arquitetura WireGuard por aplicativo
> está em beta para Windows x64 e Linux x64, com o código separado da GUI e do standalone. Os
> instaladores automáticos do plugin voltaram a funcionar nessa linha beta — Windows e Linux —
> e entregam o pacote da release. O **standalone continua pausado** e só será retomado depois.

## 🌟 Versão 2.0.0: Interface Gráfica com WireGuard por aplicativo

Criamos um aplicativo completo que faz todo o trabalho de forma **100% automática**, sem precisar abrir terminais, usar scripts ou instalar modificações complexas como o Equicord.

<p align="center">
  <img src="golive-gui/src/assets/gui-v2.png" alt="Interface do GoLiveBypass 2.0.0 com ProtonVPN otimizado, status da rota e botão Ativar Bypass" width="520">
</p>

### O que mudou na 2.0.0

- O proxy SOCKS/PAC deixou de ser o caminho principal da GUI. Windows e Linux agora usam WireGuard por aplicativo.
- O Discord permanece original, sem substituição do `app.asar` pela GUI.
- A GUI reinicia o Discord ao ativar ou desativar para garantir que ele entre ou saia do túnel corretamente.
- A rota ProtonVPN pode ser otimizada por ping. Depois de otimizar, saia e entre novamente na chamada para a nova rota entrar em vigor.
- O e-mail da conta Proton aparece desfocado durante o compartilhamento de tela e só é revelado ao passar o mouse.

> **Importante:** o perfil WireGuard gratuito integrado é compartilhado e pode ter limite de capacidade. Para uploads e uso frequente, prefira importar uma configuração WireGuard privada.

### Como funciona na versão 2.0.0

| Plataforma | Como o Discord entra no túnel | O restante do computador |
|---|---|---|
| **Windows** | WireSock/WFP filtra `Discord.exe`, `Discord`, `Update.exe` e seus processos relacionados | Continua na conexão normal |
| **Linux** | Network namespace `discord-vpn` com interface WireGuard dedicada | Continua na conexão normal |
| **macOS** | Temporariamente indisponível até existir um túnel WireGuard por aplicativo | — |

O túnel cobre o processo do Discord inteiro — gateway, login, voz, vídeo e anexos — evitando a divergência de IP que motivou a migração. A mídia não é roteada por um proxy SOCKS separado.

### Como Baixar e Instalar
1. Vá na **[última release](https://github.com/bezumiya/GoLiveBypass/releases/latest)** aqui no GitHub.
2. Baixe o arquivo da sua plataforma, na lista no fim da página:
   - **Windows:** `GoLiveBypass-*.exe` (portátil, roda direto sem instalar)
   - **Linux:** `GoLiveBypass-*.AppImage`
3. Abra o arquivo que você acabou de baixar.

O programa **não é assinado**. O sistema avisa na primeira vez. Na 2.0.0, a GUI é a única variante estável; o instalador do plugin está disponível em beta e o standalone segue pausado.

**Windows (SmartScreen):** **Mais informações → Executar assim mesmo**.

#### macOS

O suporte macOS está temporariamente indisponível na 2.0.0. A GUI não usa mais injeção ou PAC;
o suporte será retomado quando houver um túnel WireGuard por aplicativo confiável.

### Como Usar
1. O aplicativo vai detectar o seu Discord automaticamente.
2. Clique em **"Ativar Bypass"**.
3. O Discord vai reiniciar automaticamente com o Go Live desbloqueado. Ao desativar, ele também reinicia para sair do túnel.
4. Pode fechar a janela sem medo: o app fica na bandeja. Use **Sair** no ícone para encerrar o túnel.
5. Se quiser que ele já abra com o PC, marque **"Iniciar com o sistema"**.

> **Dica Importante:** Se a sua transmissão ficar com a tela preta ou não carregar de primeira, recarregue o Discord com **Ctrl + R**.


## 🐧 Interface Gráfica para Linux (AppImage)

A mesma interface gráfica do Windows, **agora para Linux**, empacotada como **AppImage** (roda em qualquer distro: Debian, Ubuntu, Fedora, Arch e derivadas).

Assim como a versão Windows, ela é **portátil** e usa o namespace WireGuard diretamente. O standalone CLI continua separado e indisponível na 2.0.0.

### Como Baixar e Instalar
1. Vá na **[última release](https://github.com/bezumiya/GoLiveBypass/releases/latest)**.
2. Baixe o **`GoLiveBypass-*.AppImage`**.
3. Dê permissão de execução e abra:

```sh
chmod +x GoLiveBypass-*.AppImage
./GoLiveBypass-*.AppImage
```

> Se o seu sistema não tiver FUSE (alguns containers/WSL), use `--appimage-extract-and-run`:
> ```sh
> ./GoLiveBypass-*.AppImage --appimage-extract-and-run
> ```

### Como Usar
1. O aplicativo detecta o seu Discord automaticamente (nativo ou flatpak).
2. Clique em **"Ativar Bypass"** — o Discord fecha, o bypass entra e ele reabre.
3. Fechar a janela só a esconde na bandeja (o app continua vivo); para reverter o bypass de verdade, use o **Sair** no menu do ícone da bandeja.

> **Nota:** se o seu Discord é flatpak do sistema, a primeira ativação pode pedir sua senha (via `pkexec`) para liberar a pasta do bypass para o sandbox.

### Dependências no Arch Linux

Na primeira abertura a GUI executa um preflight somente leitura. Se faltar alguma dependência,
o botão de ativação fica bloqueado e o próprio aplicativo mostra o comando para corrigir. No
Arch/derivadas, o comando é:

```sh
sudo pacman -S --needed wireguard-tools iproute2 curl
```

Nenhum pacote é instalado automaticamente. A verificação também reconhece o Discord oficial
(`extra/discord`), `discord_arch_electron`, `discord-electron-openasar`, PTB/Canary, clientes
paralelos e Flatpak; Equicord/Vencord é preservado e não impede o túnel por namespace.

---

---

## Índice

**Quero instalar agora**
- [**GUI (Windows e Linux)**](#escolha-sua-variante) — 1 clique para ativar/desativar, sem terminal
- [**Standalone**](#modo-standalone-só-o-discord-sem-equicord-e-sem-vencord) — Discord puro, sem Equicord/Vencord
- [**Plugin**](#instalação-do-plugin-recomendado-para-equicord-vencord-e-vesktop) — para Equicord, Vencord e Vesktop
- [Interface Gráfica 2.0.0](#-versão-200-interface-gráfica-com-wireguard-por-aplicativo) — detalhes da GUI
- [Interface Gráfica (Linux, AppImage)](#-interface-gráfica-para-linux-appimage) — detalhes da GUI no Linux
- [**Um comando só**](#um-comando-só) — uma linha no PowerShell ou no terminal, sem baixar nada
- [Instalação automática do plugin](#instalação-do-plugin-recomendado-para-equicord-vencord-e-vesktop) — instalador completo, com menu
- [**Linux: Arch, Debian, Ubuntu, Fedora**](#linux-arch-debian-ubuntu-fedora) — onde o Discord fica em cada distro, e a pedra do Node no Debian

**Já instalei**
- [Uso](#uso) — o que fazer depois de instalar
- [Configuração](#configuração) — regiões da call/stream e VPN WireGuard isolada
- [Solução de problemas](#solução-de-problemas) — Discord travado, transmissão que não sobe, plugin sumido
- [O registro](#o-registro-o-que-o-plugin-anotou) — o arquivo que conta o que aconteceu, para relatar um problema

**Quero entender ou fazer à mão**
- [Por que este plugin existe](#por-que-este-plugin-existe)
- [Go Live no Brasil: por que funciona](#go-live-no-brasil-por-que-funciona)
- [Avisos importantes](#avisos-importantes) — o que o plugin faz com a sua conexão, e os riscos
- [Como funciona](#como-funciona) — as duas travas e como cada uma é desarmada
- [Instalação manual, passo a passo](#instalação-passo-a-passo-completo) — cada etapa à mão
- [Instalação no Vesktop](#instalação-no-vesktop) — passo a passo para quem usa o Vesktop no lugar do Discord normal
- [Dependências](#dependências-o-que-baixar-e-como-instalar) — só para o caminho manual

**Projeto**
- [Estrutura](#estrutura) · [Licença](#licença) · [Autor](#autor) · [Agradecimentos](#agradecimentos)

---

## Instalação do plugin (recomendado para Equicord, Vencord e Vesktop)

> A VPN do plugin está em beta para Windows x64 e Linux x64, e os instaladores automáticos
> entregam essa linha beta — no Windows e no Linux. O instalador avisa que o sistema ainda não
> é estável e que cada bug reportado vira uma issue. Para instalação manual e configuração, use
> [`goLiveBypass/COMO-INSTALAR.md`](goLiveBypass/COMO-INSTALAR.md).

<p align="center">
  <img src="assets/instalacao.gif" alt="O instalador acha o Equicord, instala o plugin, compila e o Go Live volta a funcionar" width="720">
</p>

O pacote do plugin contém o código do renderer, o controlador WireGuard/WireSock, a integração
Proton e o `proton-confgen.exe` x64 nos releases. Ele não usa a GUI Electron, não modifica o
`app.asar` e não lê o estado de rede do standalone.

### Um comando só

Os comandos abaixo baixam o instalador direto da branch `main` deste repositório
(garante que você sempre pega a versão mais recente, com TUI e auto-update) e abrem
a interface de instalação — a mesma TUI estilo OpenCode nos dois sistemas, navegável
por **setas** (ou `j`/`k`), **Enter** para escolher, **Esc** para sair, e mouse.

**Windows**, no PowerShell interativo (Windows Terminal, PowerShell 7 ou terminal
integrado do VS Code — todos suportam ANSI):

```powershell
irm https://raw.githubusercontent.com/bezumiya/GoLiveBypass/main/installer/GoLiveBypass-Installer.ps1 -OutFile $env:TEMP\glb.ps1; powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\glb.ps1"
```

**Linux**, em qualquer shell (bash, zsh, fish, sh, dash, ksh):

```sh
curl -fsSL https://raw.githubusercontent.com/bezumiya/GoLiveBypass/main/installer/golivebypass-installer.sh -o /tmp/glb.sh && chmod +x /tmp/glb.sh && /tmp/glb.sh
```

Os dois abrem a TUI completa. Se você já tem Equicord ou Vencord clonado em algum
lugar, ele detecta; se não tem, pergunta qual você quer e instala junto.

### Instalação direta (sem TUI)

Se preferir não abrir o menu interativo — em CI, em automação, ou quando o terminal
não tem suporte a VT/ANSI (cmd puro, conhost clássico, SSH sem TTY) — passe as opções
diretamente. O instalador faz tudo sem perguntar nada:

**Windows:**

```powershell
irm https://raw.githubusercontent.com/bezumiya/GoLiveBypass/main/installer/GoLiveBypass-Installer.ps1 -OutFile $env:TEMP\glb.ps1; powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\glb.ps1" -Mode Install -Mod Vencord -Yes
```

**Linux:**

```sh
curl -fsSL https://raw.githubusercontent.com/bezumiya/GoLiveBypass/main/installer/golivebypass-installer.sh -o /tmp/glb.sh && chmod +x /tmp/glb.sh && /tmp/glb.sh --install --mod vencord --yes
```

Para apontar para um checkout que você já tem clonado (em vez de baixar tudo):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\glb.ps1" -Source "C:\caminho\do\Vencord" -Mod Vencord -Yes
```

```sh
/tmp/glb.sh --source ~/Vencord --mod vencord --install --yes
```

> **Por que não `& ([scriptblock]::Create((irm ...)))`?** O instalador PowerShell tem
> caracteres Unicode na TUI (setas `↑↓`, box-drawing `┌─└┐`, acentos), e o
> `[scriptblock]::Create()` do PowerShell 5.1 falha em parsear scriptblock com Unicode
> no meio — quebra com "Unexpected attribute 'CmdletBinding'" antes mesmo de rodar.
> Daí o `-OutFile` + `powershell -ExecutionPolicy Bypass -File`: salva o script como
> arquivo (parsing de arquivo é tolerante a Unicode) e roda com a ExecutionPolicy
> liberada só para esse processo. Sem isso, a `ExecutionPolicy` padrão do Windows
> (`Restricted`) também bloqueia o `.ps1` com `UnauthorizedAccess`.
>
> **Por que não `curl ... | bash`?** Em `bash` lendo o script pela entrada padrão, o
> menu interativo tenta ler a sua resposta do stdin e acaba consumindo a próxima linha
> do próprio script — a pergunta nunca aparece. A forma `bash <(curl ...)` (`process
> substitution`) só funciona em bash/zsh e quebra no fish; além disso, com stdin sendo
> o pipe do curl, a TUI também cai pro menu textual. Daí o `curl -o /tmp/glb.sh && chmod
> +x && /tmp/glb.sh`: baixa como arquivo, torna executável, roda direto. Funciona em
> qualquer shell e preserva o tty para a TUI.

### Baixando o arquivo

**Windows:** baixe o [`GoLiveBypass-Installer.bat`](installer/GoLiveBypass-Installer.bat) e dê dois cliques. Ele libera a execução só para aquele processo (`Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass`), baixa o `.ps1` se ele não estiver do lado, e roda tudo.

**Linux:**

```bash
curl -fsSLO https://raw.githubusercontent.com/bezumiya/GoLiveBypass/main/installer/golivebypass-installer.sh
chmod +x golivebypass-installer.sh
./golivebypass-installer.sh
```

Ao abrir, ele mostra o que encontrou e um menu:

```
  Detectado:
    Discord   instalado (1)
    Mod       Equicord
    Fonte     /home/voce/Equicord
    Plugin    nao instalado

  O que voce quer fazer?

    [1] Instalar ou atualizar o GoLiveBypass
    [2] Remover so o plugin (o mod continua)
    [3] Restaurar tudo (remove o plugin e desfaz a injecao)
    [0] Sair
```

Escolhendo instalar, ele pergunta duas coisas: **onde** (usar o mod que já está aí ou baixar outro) e **por quanto tempo** (permanente, ou temporário — que desfaz a injeção quando você fechar o Discord). A saída para fora do Brasil não é mais escolhida aqui: a conta Proton é configurada dentro do plugin, na primeira ativação.

**Pelo PowerShell:**

```powershell
irm https://raw.githubusercontent.com/bezumiya/GoLiveBypass/main/installer/GoLiveBypass-Installer.ps1 -OutFile GoLiveBypass-Installer.ps1
powershell -ExecutionPolicy Bypass -File .\GoLiveBypass-Installer.ps1
```

Ele descobre onde está o seu checkout **lendo a própria injeção do Discord**: o instalador do Equicord e o do Vencord substituem o `app.asar` por um stub que faz `require` da pasta de build, e desse caminho dá para derivar a raiz do repositório. Se não achar por aí, procura nos lugares habituais.

| sua situação | o que acontece |
|---|---|
| Equicord ou Vencord já instalado a partir do fonte | Copia o plugin, compila e reinicia o Discord |
| Instalado, mas o Discord não carrega desse checkout | Compila e roda o `pnpm inject` para apontar o Discord para ele |
| Você não tem nenhum dos dois | Mostra uma tela para escolher **Equicord** ou **Vencord**, baixa, compila e injeta |
| Falta Git ou Node | No Windows, oferece instalar pelo winget. No Linux, mostra o comando da sua distro (o pacote do Node é `nodejs`, e costuma ser antigo demais: nesse caso use nvm, fnm ou o NodeSource). O pnpm sai do `corepack enable` nos dois |

A descoberta é automática e roda em milissegundos: primeiro lê a injeção do Discord, depois varre os lugares onde um checkout costuma estar (perfil, Documentos, Desktop, Downloads, `dev`, `repos`, `projects`, `source`, e a raiz de cada disco).

Outros modos:

```powershell
.\GoLiveBypass-Installer.ps1 -Source C:\caminho\do\Equicord  # aponta o checkout na mão
.\GoLiveBypass-Installer.ps1 -Mod Vencord                     # escolhe o mod sem a tela
.\GoLiveBypass-Installer.ps1 -Yes                             # sem perguntas, para automação
.\GoLiveBypass-Installer.ps1 -Mode Install                    # instala direto, sem menu
.\GoLiveBypass-Installer.ps1 -Mode Uninstall                  # remove o plugin e recompila
.\GoLiveBypass-Installer.ps1 -Mode Restore                    # remove o plugin e desfaz a injeção
```

```bash
./golivebypass-installer.sh --source ~/Equicord   # aponta o checkout na mão
./golivebypass-installer.sh --mod vencord         # escolhe o mod sem a tela
./golivebypass-installer.sh --yes                 # sem perguntas, para automação
./golivebypass-installer.sh --install             # instala direto, sem menu
./golivebypass-installer.sh --uninstall           # remove o plugin e recompila
./golivebypass-installer.sh --restore             # remove o plugin e desfaz a injeção
```

O instalador **baixa o pacote da release** (o mesmo `goLiveBypass-vencord.zip` que o updater do
plugin usa) e confere o **SHA-256** publicado antes de extrair — não copia arquivos soltos da
branch `main`, que pode estar atrás da tag. Ele nunca mexe no `app.asar`: quem injeta é o
instalador oficial do Equicord/Vencord.

O instalador já deixa o plugin **ativado e configurado**. Depois que ele terminar, feche o Discord pela bandeja e abra de novo: é isso.

## Modo standalone: só o Discord, sem Equicord e sem Vencord

> **Temporariamente indisponível na 2.0.0.** O standalone CLI está pausado durante a
> portabilidade da nova solução WireGuard. Esta seção fica como referência da versão anterior.

Não execute os comandos desta seção na 2.0.0: o CLI retorna aviso e código de erro até ser
portado e validado para WireGuard.

Se você não usa nenhum mod e não quer instalar um, existe o **modo standalone**. Ele instala o bypass direto no Discord.

**Não precisa de Node, nem de pnpm, nem de git.** Não há etapa de compilação: o bypass é um arquivo `.js` que o próprio Discord carrega ao abrir.

| | plugin | standalone |
|---|---|---|
| exige Equicord ou Vencord | sim | **não** |
| exige Node, pnpm e git | sim | **não** |
| convive com outros plugins | sim | não, ocupa o lugar do mod |
| tela de configuração | dentro do Discord | um `settings.json` |
| diagnóstico | `/golivebypass` e arquivo | arquivo |

**Escolha o standalone** se você só usa o Discord puro. **Escolha o plugin** se já usa Equicord ou Vencord — os dois ocupam o mesmo lugar dentro do Discord, e instalar o standalone por cima desliga o seu mod. O instalador detecta isso e pergunta antes de mexer.

### Como instalar

**Windows:** baixe a pasta `standalone` e dê dois cliques no `GoLiveBypass-Standalone.bat`.

**Linux:**

```bash
chmod +x golivebypass-standalone.sh
./golivebypass-standalone.sh
```

Para usar a sua própria proxy ou o Tor:

```powershell
.\GoLiveBypass-Standalone.ps1 -Proxy "socks5://127.0.0.1:9050"
```

Para ver o que ele detectou sem mexer em nada, `-Mode Status`. Para desfazer, `-Mode Uninstall` — ele devolve o `app.asar` original, byte a byte.

### Como ele funciona, e por que é mais simples

O plugin desarma duas travas: a do cliente, por patch, e a do servidor, pela proxy. O standalone precisa de **uma** só.

O motivo é que a trava do cliente vem de um experimento que o servidor atribui a partir do IP de onde o WebSocket de gateway sai. Com o gateway saindo por um IP não bloqueado, **o experimento não é atribuído** — os botões ficam livres sozinhos, sem patch nenhum. O patch do plugin é rede de segurança, não o mecanismo principal.

Sem a parte do cliente, sobra só o processo principal, e aí o desenho muda: em vez de mandar a sessão inteira pela proxy e soltar depois, o standalone instala uma regra por host (um PAC) que manda **apenas** `gateway.discord.gg` e `remote-auth-gateway.discord.gg` por um roteador SOCKS local. Uma regra assim não precisa ser solta nunca, e todo o resto do Discord sai direto o tempo todo.

O roteador escuta só em `127.0.0.1`, numa porta que o sistema escolhe, e **recusa qualquer destino que não esteja nessa lista** — sem isso ele seria um SOCKS aberto que qualquer programa da máquina poderia usar com a identidade do Discord.

Se nenhuma saída ficar pronta a tempo, a conexão sai direta em vez de ficar esperando: Discord sem bypass é ruim, Discord que não abre é muito pior.

### Depois de uma atualização do Discord

O Discord se atualiza numa pasta nova, sem a injeção, e o bypass sumiria em silêncio. Enquanto a versão atual ainda está rodando, o standalone detecta a pasta nova e já deixa ela pronta. Se mesmo assim parar de funcionar depois de uma atualização, rode o instalador de novo.

## Linux: Arch, Debian, Ubuntu, Fedora

Os instaladores detectam a sua distro sozinhos. Esta seção é para entender o que eles fazem, e para quem prefere fazer à mão.

### Qual dos dois usar

- **Só uso o Discord** → [modo standalone](#modo-standalone-só-o-discord-sem-equicord-e-sem-vencord). Não precisa de Node, nem de pnpm, nem de git. É um `.js` e pronto.
- **Uso ou quero usar Equicord/Vencord** → o instalador do plugin, acima.

### Onde o Discord fica em cada distro

Isto mudou em maio de 2026, na versão 1.0.136 do Discord, e a maior parte dos tutoriais na internet ainda está desatualizada.

**Hoje o pacote que você instala não contém o Discord.** O `.tar.gz` oficial, o `.deb`, o pacote oficial do Arch e o RPM do RPM Fusion trazem apenas um *bootstrapper* de uns 4 MB. Na primeira vez que você abre, ele baixa o app de verdade **para dentro da sua pasta pessoal**.

| como você instalou | onde o `app.asar` fica |
|---|---|
| `.tar.gz` oficial, `.deb`, `extra/discord` do Arch, RPM Fusion | `~/.config/discord/app-<versão>/resources/` |
| PTB | `~/.config/discordptb/app-<versão>/resources/` |
| Canary | `~/.config/discordcanary/app-<versão>/resources/` |
| `discord_arch_electron` (AUR) | `/usr/share/discord/resources/` |
| `discord-electron-openasar` (AUR) | `/usr/lib/discord/resources/` — **já tem OpenAsar** |
| `discord-ptb` / `discord-canary` (AUR) | `/opt/discord-ptb/resources/`, `/opt/discord-canary/resources/` |
| Flatpak do sistema | `/var/lib/flatpak/app/com.discordapp.Discord/current/active/files/discord/resources/` |
| Flatpak do usuário | `~/.local/share/flatpak/app/com.discordapp.Discord/current/active/files/discord/resources/` |
| Snap | dentro de um squashfs, somente leitura de verdade: **não dá para injetar** |

Três consequências práticas:

**Quase sempre não precisa de `sudo`.** Se o seu Discord veio pelo caminho normal, o `app.asar` está na sua pasta pessoal. Os instaladores só pedem root quando o alvo realmente pertence ao root — os pacotes do AUR que ainda embutem o app, e o Flatpak instalado para o sistema todo.

**Flatpak funciona, e um `flatpak update` desfaz.** O deploy do Flatpak parece intocável mas é um diretório comum: a injeção só renomeia o `app.asar` e cria uma pasta ao lado, sem reescrever arquivo nenhum, então os objetos do repositório ostree ficam intactos. O que muda é que cada atualização refaz o deploy inteiro e leva a injeção junto — rode o instalador de novo depois. Os instaladores também precisam liberar a pasta do bypass para o sandbox (`flatpak override --filesystem=`), senão o Discord abre reclamando de módulo não encontrado.

**A atualização do Discord desfaz a injeção.** Ele baixa a versão nova numa pasta `app-<versão>` inteiramente nova, e o que você injetou fica na pasta velha. Não dá para impedir isso de fora: rode o instalador de novo depois de atualizar. O instalador avisa quando esse é o seu caso.

Se você usa `discord-electron-openasar`, ele **já substitui** o `app.asar` pelo OpenAsar. Injetar por cima apaga o OpenAsar — o instalador avisa antes.

Por isso os instaladores procuram o `app.asar` de verdade em vez de confiar numa lista: `/usr/share/discord` existe nos dois mundos com significados opostos — no pacote oficial do Arch ele contém **só** o bootstrapper, e no `discord_arch_electron` contém o app inteiro.

### Arch e derivadas (Manjaro, EndeavourOS, Garuda)

O Arch entrega Node atual (26.x) e tem o `pnpm` empacotado, então é o caso mais simples:

```bash
sudo pacman -S --needed nodejs npm git pnpm
```

O instalador faz isso sozinho, com confirmação. Ele também prefere o `pnpm` do pacman em vez de um `npm install -g`, que jogaria arquivos em `/usr/lib` fora do controle do pacote.

Com o pacote **oficial** (`extra/discord`), o `app.asar` fica na sua pasta pessoal e nenhum `sudo` é necessário. Com o **`discord_arch_electron`** do AUR o app fica em `/usr/share/discord`, e aí sim precisa de root — e um `pacman -Syu` sobrescreve a injeção, então rode o instalador de novo depois de atualizar.

### Debian, Ubuntu, Mint, Pop!_OS

Aqui tem uma pedra: **o Node do repositório é velho demais**. O Equicord precisa da versão 22 ou mais nova, e o Debian estável e o Ubuntu LTS entregam versões bem anteriores. O `pnpm build` quebra lá na frente com um erro que não diz "seu Node é antigo" — por isso o instalador confere a versão **antes** de começar e explica o que fazer.

O jeito mais direto:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
# feche e abra o terminal
nvm install 22
```

Ou pelo [NodeSource](https://github.com/nodesource/distributions), se preferir pacote do sistema.

Git e npm vêm do repositório normalmente:

```bash
sudo apt-get install -y git npm
```

### Fedora e Nobara

```bash
sudo dnf install -y nodejs npm git
```

Se o Node vier abaixo de 22:

```bash
sudo dnf module reset nodejs && sudo dnf module enable nodejs:22
```

### openSUSE

```bash
sudo zypper install -y nodejs npm git
```

### Permissões

O Discord instalado em `/usr/share`, `/usr/lib` ou `/opt` pertence ao root, então a injeção precisa de `sudo`. Os instaladores pedem **só quando precisam** — se o seu Discord está em `~/.local/share` ou numa pasta sua, nada de sudo é usado.

Nenhum dos dois roda comando com sudo sem perguntar antes, e o comando exato aparece na tela para você conferir.

## Uso

1. Compile e instale o plugin conforme [`goLiveBypass/COMO-INSTALAR.md`](goLiveBypass/COMO-INSTALAR.md).
2. Ative **GoLiveBypass**. No Windows x64 o plugin prepara o perfil Proton ou personalizado, sobe o WireSock com filtro por aplicativo e reinicia o Discord automaticamente.
3. Entre em uma call e use câmera/Go Live. O túnel cobre o processo do Discord inteiro, incluindo gateway, login, voz, vídeo e anexos.
4. Ao desativar o plugin, ele para somente o WireSock que ele próprio controla, limpa o estado de rede e reinicia o Discord.

O plugin não roteia a máquina inteira: navegadores, jogos e os demais aplicativos continuam na rede normal. Se houver WireSock ativo ou um serviço registrado com outro perfil, a ativação é recusada para não interferir na GUI, no standalone ou em outro plugin.

## Configuração

Nas settings do plugin:

- **Voice region**: seletor com a lista real de regiões que o Discord expõe. Padrão: `Automatic`, que devolve a decisão ao Discord.

  > **Cuidado ao forçar `brazil` aqui.** Há indício de que o servidor de mídia brasileiro é justamente onde a transmissão é recusada: numa sessão em que a call caiu no Brasil o Go Live não subiu, e numa sessão em que caiu em Santiago funcionou. São duas observações, não uma prova, mas o padrão seguro é não forçar. Use este campo se quiser priorizar latência e estiver disposto a perder o Go Live.

  Vale saber que isto é uma **preferência**, não uma ordem: o Discord pode ignorar e escolher outra região, e foi o que aconteceu no teste.
- **VPN mode**: `ProtonVPN` gera um perfil WireGuard pela conta Proton; `Arquivo WireGuard personalizado` usa o `.conf` indicado em seguida.
- **Custom config path**: caminho absoluto do `.conf`. O plugin copia o arquivo para `%LOCALAPPDATA%\GoLiveBypass\plugin-vpn`, remove DNS global do perfil e adiciona `AllowedApps` somente para o Discord e o `Update.exe` da instalação atual.
- **Proton username**: usuário da conta ProtonVPN. A sessão fica na pasta privada do plugin; as configurações da GUI não são compartilhadas.
- **Proton countries**, **free only** e **auto-ping**: filtros da seleção automática do helper Proton. `BR` é sempre excluído da saída.

O painel também permite autenticar, resolver o CAPTCHA em uma janela oficial isolada, otimizar a rota, testar um `.conf` e restaurar a rede. Probes de IP, HTTP e rota são somente diagnósticos no log: não bloqueiam a ativação nem derrubam o Discord.

## Solução de problemas

- **WireSock externo detectado**: encerre a GUI, o standalone ou o outro plugin que controla o túnel. O plugin não faz `taskkill` amplo e não assume serviços externos.
- **Windows x64 necessário**: Linux, macOS, Windows 32-bit e Windows ARM64 permanecem fora desta primeira etapa da migração.
- **`recovery_required`**: a parada do serviço ou a restauração do lock/DNS não foi confirmada. Não tente iniciar outro perfil; abra o log e use **Restaurar rede** ou reinicie o Windows se o filtro continuar ativo.
- **CAPTCHA Proton**: o login abre uma janela com origem oficial Proton, sem downloads, permissões ou navegação externa. Fechar a janela cancela a tentativa sem alterar a sessão.
- **Quer ver o que aconteceu**: rode `/golivebypass` ou abra `%LOCALAPPDATA%\GoLiveBypass\plugin-vpn\plugin-vpn.log` (veja [O registro](#o-registro-o-que-o-plugin-anotou)). O arquivo inclui estado, ownership, início/parada do WireSock e probes log-only; não inclui senha nem token.
- **A região da call não mudou**: saia e entre de novo no canal. Canais de servidor com região fixada por um admin ignoram sua preferência, e numa call que já está rolando a região já foi decidida.
- **A VPN não ativou**: confirme que o helper `bin/win32-x64/proton-confgen.exe` veio no pacote do plugin. Em desenvolvimento, o helper precisa ser compilado pelo workflow de release ou disponibilizado em `GOLIVE_PLUGIN_PROTON_CONFGEN`.
- **`Cannot find matching keyid` ao instalar as dependências**: é o corepack, não o plugin. Ele cria o atalho do `pnpm` antes de saber que versão usar, e na primeira execução busca essa versão no registro do npm conferindo a assinatura com chaves embutidas nele — as que vêm no Node 22 estão vencidas. O instalador detecta isso e instala o pnpm pelo npm. Se estiver fazendo à mão, rode `npm install -g pnpm` e siga com `pnpm install`.
- **Erro de build `Could not resolve "./plugins/userplugins"`**: você copiou a pasta para dentro de `src/plugins/` por engano. O caminho certo é `src/userplugins/goLiveBypass` — a pasta `userplugins` fica em `src/`, **ao lado** de `plugins`, e pode ser necessário criá-la.
- **Plugin não aparece na lista**: confirme que a pasta está em `src/userplugins/goLiveBypass` (com `index.tsx`, `native.ts` e `stability.ts`) e que você rodou `pnpm build` + `pnpm inject` e reiniciou o Discord.

## O registro: o que o plugin anotou

O plugin e o standalone têm registros separados. O plugin WireGuard usa uma pasta privada e estável:

| sistema | caminho |
|---|---|
| Plugin, Windows x64 | `%LOCALAPPDATA%\GoLiveBypass\plugin-vpn\plugin-vpn.log` |
| Standalone, Windows | arquivo `golivebypass.log` do caminho legado |
| Standalone, Linux | arquivo `golivebypass.log` do caminho legado |

O diretório também guarda `wireguard.conf`, `wiresock-discord.conf`, `proton-session.json` e o lock de ownership. A migração da GUI, quando aplicável, copia somente o perfil WireGuard compatível e a sessão Proton uma vez; nenhum settings ou estado de rede é compartilhado depois disso. O standalone continua com seu caminho e comportamento legados.

O log do plugin é cortado quando passa de 256 KB e mantém uma cauda em memória. Ele registra transições de estado, processo/serviço controlado, resultado da limpeza e probes de rede/rota como diagnóstico — não é prova de IP geográfico nem bloqueia a ativação.

No plugin, `/golivebypass` copia o estado atual e o ring buffer do processo principal, pronto para colar num relato. No standalone o arquivo continua sendo o único caminho, porque não há interface para um comando.

O registro responde as perguntas que a tela não responde:

- **se a instância é dona do serviço WireSock** ou encontrou outro controlador
- **se o WireGuard iniciou, parou e restaurou o lock/DNS**
- **se os probes de rota e conectividade responderam** — sempre como diagnóstico
- **se o Discord abriu a sessão com o guard de vídeo atribuído**

Um registro típico de uma ativação que deu certo:

```
abrindo plugin VPN | win32 x64 | electron 43.x
WireSock SDK compatível encontrado | version=3.4.8.1
serviço WireSock ativo com filtro por aplicativo | allowedApps=...Discord.exe, ...Update.exe
diagnóstico assíncrono da rede | mode=log-only
probe de rota do Discord concluído | mode=log-only
sessão aberta | VPN active | ownership true
```

## Reportar um bug (GUI)

O app gráfico tem um botão **Reportar bug** no rodapé. Ele abre um diálogo onde você descreve o problema e envia um pacote de diagnóstico que vira uma issue no GitHub — sem precisar copiar logs na mão.

**O que é enviado:**
- **Resumo e descrição** que você digita (até 200 e 8 KB).
- **Logs da sessão** — cauda do `gui.log`, do `golivebypass.log` (do Discord injetado) e o ring buffer em memória — cortados para 256 KB, mantendo o fim (o mais recente importa mais).
- **Metadados técnicos** — versão do app, plataforma, modo de roteamento (Tor/gratuitas/personalizado), status do bypass, se o Tor embutido está ativo e em qual porta, uptime.

Depois do envio o app mostra o link da **issue criada** (ex.: `https://github.com/bezumiya/GoLiveBypass/issues/123`). Se preferir, abra direto em `https://github.com/bezumiya/GoLiveBypass/issues`.

**Privacidade — o que NUNCA sai da sua máquina:**
Sua proxy personalizada (`socks5://usuario:senha@host:porta`) é tratada como segredo. Antes de enviar, o app passa o pacote por três camadas:

- **L1 — padrões conhecidos:** credenciais embutidas em URL (`usuario:***@host`), cabeçalhos `authorization`, tokens do Discord (`mfa.*`) e query string do gateway.
- **L2 — segredos literais:** qualquer ocorrência exata de usuário, senha, `host:porta` e da URL inteira configurada em `settings.json` vira `<proxy-pessoal>` — mesmo fora de um padrão.
- **L3 — varredura final:** se algum segredo sobreviveu, **nada é enviado** e o app avisa “proxy apareceu nos logs”. O token da API (`api.skyplaceia.com`) também sai por L2 e trava em L3 se ficar.

Hosts do Discord (`gateway.discord.gg`) e do país de saída podem aparecer — são necessários para diagnosticar rota e latência. Senha e `host:porta` da sua proxy nunca.

**Operação:** o botão chama `POST https://api.skyplaceia.com/bugs/v1/reports` com `Authorization: Bearer <token>` embutido no app (escopo: só criar issue, com rate limit). Rate limit: **1 issue/min por IP** — o 2º envio no mesmo minuto recebe `429` e bloqueia o IP por **300s** (`Retry-After` + `GET /v1/block-status` informam o tempo restante; a GUI mostra a mensagem de bloqueio com contagem regressiva). O corpo é limitado a 512 KB; o campo `log` é cortado em 256 KB. Logs locais nunca excedem 2 MB por arquivo nem 128 KB em memória.

Sem GUI, compartilhe o arquivo de [O registro](#o-registro-o-que-o-plugin-anotou) manualmente numa issue.

---

---

**Daqui para baixo é a parte técnica** — como o bypass funciona por dentro, e como instalar tudo à mão. Se você só queria usar, já está pronto.

## Por que este plugin existe

Em agosto de 2026, a ANPD [ordenou que o Discord suspendesse as transmissões ao vivo (Go Live) no Brasil](https://www.gov.br/anpd/pt-br/assuntos/noticias/em-medida-preventiva-anpd-determina-que-discord-suspenda-transmissoes-ao-vivo-no-brasil), pouco depois de o país ter bloqueado o X (Twitter). Para quem depende dessas plataformas para se comunicar, organizar e denunciar, o recado foi claro: o acesso e a privacidade dos brasileiros na internet podem ser cortados por canetaço.

O GoLiveBypass nasce dessa luta. Ele é uma ferramenta de **privacidade e resistência à censura**: no plugin, a sessão do Discord pode ser iniciada dentro de um túnel WireGuard por aplicativo, sem transformar a conexão inteira do computador em VPN.

**O que ele entrega:** o patch do cliente e o túnel isolado trabalham juntos para devolver o **Go Live e a câmera** às contas brasileiras, mantendo os demais aplicativos fora do túnel. A primeira implementação do transporte do plugin é Windows x64.

## Go Live no Brasil: por que funciona

Testes práticos mostram que o bloqueio do Go Live funciona assim:

- O Discord verifica sua região **apenas no momento em que você entra num canal de voz** (`VOICE STATE UPDATE`), usando o **IP da conexão WebSocket do gateway** — e **nunca reavalia** durante a chamada.
- O WebSocket do gateway é aberto no boot do app. Se ele nasce pelo túnel WireGuard com uma saída fora do Brasil, o gate de região pode liberar telas e câmera para contas brasileiras.
- A mídia, o login, os anexos e o restante do processo do Discord seguem o filtro por aplicativo; os demais processos do computador continuam diretos.

Ou seja, o fluxo do GoLiveBypass — **o Discord nasce dentro do WireGuard, enquanto o restante do computador fica normal** — reproduz o bypass manual "ligar VPN, abrir o Discord, entrar na call, desligar a VPN", sem expor os demais aplicativos ao túnel.

**Ressalvas honestas:**

- Se o serviço WireSock morrer ou a restauração ficar inconclusiva, o plugin entra em `recovery_required` e registra o motivo. Ele não troca silenciosamente de saída, não bloqueia o Discord e não aplica um filtro amplo ao computador; use **Restaurar rede** e o log para concluir a recuperação.
- Isso depende de comportamento atual do Discord, que pode mudar a qualquer momento.
- Usar proxy/VPN para contornar a restrição pode violar os Termos de Serviço do Discord. Risco de punição à conta é baixo, mas existe — considere usar uma conta secundária.

## Avisos importantes

- **O transporte do plugin funciona nesta etapa somente no Discord desktop Windows x64** com Equicord ou Vencord injetado. Linux, macOS, Vesktop, Equibop, Snap e navegador continuam fora desta migração de transporte.
- Usar clientes modificados viola os Termos de Serviço do Discord. Use por sua conta e risco.
- O WireGuard do plugin carrega o processo inteiro do Discord por aplicativo. A GUI, navegadores, jogos e os demais programas ficam fora do filtro.
- `network-lock` fica desativado de propósito para preservar a rede normal do computador. Se a inicialização falhar, a operação é abortada; estado ativo significa que o processo/serviço próprio foi iniciado, não prova geográfica do IP de saída.
- A conta Proton e os perfis `.conf` são segredos do usuário. O plugin mantém esses arquivos em uma pasta privada e não os envia para a API do projeto.

## Como funciona

O plugin mantém duas responsabilidades separadas:

1. O patch do renderer mantém a interface de câmera/Go Live coerente com o experimento de vídeo do Discord e preserva as preferências de região da call/stream.
2. O processo principal controla uma sessão WireGuard/WireSock por aplicativo. O perfil usa a rota padrão, mas `AllowedApps` limita o túnel ao `Discord.exe`, ao `Update.exe` da instalação atual e, quando disponível, a um helper temporário de diagnóstico.

Ao ativar, o controlador valida ou gera o perfil, reserva o lock global, sanitiza DNS/AllowedApps, configura o serviço com `network-lock disabled`, confirma o ownership e reinicia o Discord. Ao desativar, ele para apenas serviços e PIDs cujo comando aponta para o perfil privado, reseta o network lock, limpa DNS somente dos adaptadores WireSock/ProTUN e confirma que não sobrou processo.

O estado `active` é deliberadamente operacional: significa que o serviço e o processo próprio foram confirmados. Os probes de DNS, HTTPS e rota são executados em segundo plano e ficam no log como evidência auxiliar; uma falha de probe não bloqueia a ativação, não troca a saída no meio da call e não encerra o Discord.

O modo Proton usa o `proton-confgen.exe` x64 empacotado no release para autenticar, consultar o plano e selecionar uma rota. O modo personalizado aceita somente um `.conf` WireGuard válido com rota padrão. A sessão Proton, o perfil e o lock vivem em `%LOCALAPPDATA%\GoLiveBypass\plugin-vpn`, sem compartilhar settings com a GUI ou com o standalone.

## Dependências: o que baixar e como instalar

> Se você usou o instalador automático acima, **pule esta seção e a próxima**. O instalador confere o que falta e oferece instalar sozinho. O que vem daqui em diante é o caminho manual, para quem prefere fazer cada passo à mão ou precisa entender o que está acontecendo.

Você precisa de **4 programas** antes de começar. Instale na ordem. Depois de instalar cada um, **feche e abra o terminal de novo** — o Windows só reconhece programas novos em terminais abertos depois da instalação.

### 1. Git — o programa que baixa código do GitHub

É ele que faz o `git clone` (baixar) deste repositório e do Equicord/Vencord.

**Windows (jeito mais fácil):**
1. Abra o **PowerShell** (tecla Windows → digite "PowerShell" → Enter)
2. Rode: `winget install Git.Git`
3. Ou, se preferir baixar manualmente: entre em [git-scm.com/download/win](https://git-scm.com/download/win), baixe o instalador de 64-bit e clique em **Next** em tudo (as opções padrão são as certas)

**Linux:** `sudo apt install git` (Debian/Ubuntu) ou o equivalente da sua distro.
**macOS:** `brew install git`.

**Confira se deu certo** (num terminal novo): `git --version` → deve mostrar algo como `git version 2.x.x`. Se disser "comando não encontrado", feche e abra o terminal.

### 2. Node.js 22 ou superior — o motor que compila o plugin

O Equicord/Vencord é feito em TypeScript, e quem transforma isso no programa final é o Node. **Versão menor que 22 quebra o build.**

**Windows/macOS:**
1. Entre em [nodejs.org](https://nodejs.org/) e baixe o botão verde **LTS** (qualquer LTS a partir do 22)
2. Instale clicando em **Next** em tudo — deixe marcada a opção de adicionar ao PATH (vem marcada)
3. Ou pelo terminal: `winget install OpenJS.NodeJS.LTS`

**Linux:** use o [NodeSource](https://github.com/nodesource/distributions) — o Node dos repositórios da distro costuma ser velho demais.

**Confira:** `node --version` → precisa mostrar `v22.x.x` ou maior.

### 3. pnpm — o instalador de peças do projeto

O projeto usa **pnpm** (e não o npm que vem com o Node) para baixar as bibliotecas do build. Você não baixa instalador nenhum: o Node já traz o **Corepack**, que ativa o pnpm com dois comandos.

Num terminal (depois de instalar o Node):

```bash
corepack enable
corepack prepare pnpm@latest --activate
```

Se der erro de permissão no Windows, abra o PowerShell **como administrador** e rode de novo. Se o Corepack não existir, a alternativa é: `npm install -g pnpm`.

**Confira:** `pnpm --version` → o projeto foi testado com pnpm 11.

### 4. Discord para computador — onde o plugin vai rodar

O plugin **só funciona no app de computador** (ele usa recursos do Electron que o navegador não tem):

- **Discord normal**: baixe em [discord.com/download](https://discord.com/download) (stable, PTB ou Canary servem). O Flatpak (`com.discordapp.Discord`) também serve, do sistema ou do usuário; ou
- **Vesktop/Equibop**: apps alternativos que já trazem o mod embutido. Os instaladores daqui não mexem neles; o patch do plugin pode ser carregado manualmente, mas o transporte VPN desta etapa não foi validado nesses hosts.
- **Não funciona** no Discord aberto no navegador nem no celular.

### Componentes da VPN do plugin

O transporte desta migração exige **Windows x64**. O pacote de release traz o
`proton-confgen.exe` x64; o plugin baixa o SDK oficial do WireSock somente quando
necessário, confere o SHA-256 fixado e pede elevação do Windows para instalar o serviço.
Não instale Tor, proxy SOCKS ou PAC para usar este caminho.

## Instalação: passo a passo completo

> Este é o caminho manual. O [instalador automático do plugin](#instalação-do-plugin-recomendado-para-equicord-vencord-e-vesktop) faz tudo isto sozinho; siga daqui só se preferir fazer na mão.

Escolha **Equicord** ou **Vencord** — os dois funcionam, o processo é idêntico. Os exemplos usam Equicord; para Vencord, troque o link do clone por `https://github.com/Vendicated/Vencord` e a pasta para `Vencord`.

### Passo 1 — Baixe o código do Equicord

Abra o terminal, vá para a pasta onde quer guardar o projeto e clone:

```bash
cd Documents
git clone https://github.com/Equicord/Equicord
cd Equicord
```

### Passo 2 — Instale as bibliotecas do build

```bash
pnpm install
```

Isso baixa tudo que o Equicord precisa para compilar (demora um pouco na primeira vez, é normal).

### Passo 3 — Baixe o plugin e coloque na pasta certa

Duas formas de baixar este repositório:

- **Pelo terminal** (estando fora da pasta Equicord): `git clone https://github.com/bezumiya/GoLiveBypass`
- **Pelo navegador**: abra [github.com/bezumiya/GoLiveBypass](https://github.com/bezumiya/GoLiveBypass), clique no botão verde **Code → Download ZIP** e extraia o arquivo

Depois copie a pasta **`goLiveBypass`** (a que contém `index.tsx`, `native.ts` e `stability.ts`) para dentro de:

```
Equicord/src/userplugins/goLiveBypass
```

**Atenção aos detalhes que mais quebram:**

- A pasta `userplugins` **não existe por padrão** — crie ela dentro de `src/`
- Ela fica em `src/userplugins`, **ao lado** de `src/plugins` — **nunca dentro** de `src/plugins` (isso gera o erro `Could not resolve "./plugins/userplugins"` no build)
- No final, os arquivos devem ficar juntos em `src/userplugins/goLiveBypass/`, incluindo `index.tsx`, `native.ts` e `stability.ts`

### Passo 4 — Compile

```bash
pnpm build
```

Isso gera a pasta `dist/` com o Equicord modificado já incluindo o plugin. Se aparecer algum erro vermelho, leia a seção **Solução de problemas** antes de tentar de novo.

### Passo 5 — Injete no Discord

**Feche o Discord completamente antes** (ícone na bandeja perto do relógio → botão direito → **Quit Discord**). Depois:

```bash
pnpm inject
```

O instalador abre uma janelinha perguntando **qual Discord** você usa (Stable, PTB ou Canary) — escolha o seu e confirme. É isso que "injetar" faz: ele aponta o seu Discord para o build que você compilou. Para desfazer depois, basta rodar `pnpm uninject` na mesma pasta.

### Passo 6 — Ative o plugin e use

1. Abra o Discord
2. Vá em **Configurações → Equicord (ou Vencord) → Plugins** e ative **GoLiveBypass**
3. Deixe **Voice region** em `Automatic`, que é o padrão (leia o aviso na seção [Configuração](#configuração) antes de mudar)
4. Ative o plugin; ele prepara o WireGuard/WireSock e reinicia o Discord automaticamente
5. Entre num canal de voz: **Go Live e câmera liberados** quando o servidor aceitar a saída do túnel. Quem escolhe o servidor de voz é o Discord, e pode não ser o brasileiro. Não force `brazil` em **Voice region** sem ler o aviso na seção Configuração

## Instalação no Vesktop

O **Vesktop** é um cliente alternativo que já traz o Vencord embutido, então o fluxo muda em dois pontos: **não use `pnpm inject`** (não há Discord para injetar) e, no fim, aponte o próprio Vesktop para o build que você compilou.

O processo abaixo é o mesmo do [passo a passo completo](#instalação-passo-a-passo-completo), com as diferenças marcadas:

### Passo 1 — Baixe o código do Vencord

No terminal, vá para a pasta onde quer guardar o projeto e clone:

```bash
cd Documents
git clone https://github.com/Vendicated/Vencord
cd Vencord
```

### Passo 2 — Instale as bibliotecas do build

```bash
pnpm install
```

### Passo 3 — Baixe o plugin e coloque na pasta certa

1. Clone este repositório: `git clone https://github.com/bezumiya/GoLiveBypass`
2. Copie a pasta **`goLiveBypass`** (a que contém `index.tsx`, `native.ts` e `stability.ts`) para dentro de:

```
Vencord/src/userplugins/goLiveBypass
```

**Atenção aos detalhes que mais quebram:**

- A pasta `userplugins` **não existe por padrão** — crie ela dentro de `src/`
- Ela fica em `src/userplugins`, **ao lado** de `src/plugins` — **nunca dentro** de `src/plugins`
- No final, os arquivos devem ficar juntos em `src/userplugins/goLiveBypass/`, incluindo `index.tsx`, `native.ts` e `stability.ts`

### Passo 4 — Compile

```bash
pnpm build
```

Isso gera a pasta `dist/` com o Vencord modificado já incluindo o plugin.

### Passo 5 — Aponte o Vesktop para o seu build

1. Abra o **Vesktop**
2. Vá em **Vesktop Settings** (Configurações do Vesktop)
3. Role até a seção **Vencord Location**
4. Clique em **Change** (Mudar) e selecione a pasta **`dist`** dentro do seu clone do Vencord (ex.: `Documents/Vencord/dist`)
5. Feche e reabra o Vesktop por completo

> **Se o Vesktop for Flatpak**, o caminho pode virar `/run/1000/...` — um caminho temporário do sandbox que quebra no próximo reinício. Para resolver, dê ao sandbox acesso à pasta do build:
>
> ```bash
> flatpak override dev.vencord.Vesktop --filesystem="$HOME/Documents/Vencord"
> ```

### Passo 6 — Ative o plugin e use

1. Abra o Vesktop
2. Vá em **Configurações → Vencord → Plugins** e ative **GoLiveBypass**
3. Deixe **Voice region** em `Automatic`, que é o padrão (leia o aviso na seção [Configuração](#configuração) antes de mudar)
4. Reinicie o Vesktop por completo (bandeja, Quit); a VPN do plugin ainda não foi validada E2E neste host alternativo
5. Entre num canal de voz: o patch do plugin pode liberar **Go Live e câmera**, mas o transporte WireGuard desta etapa é suportado oficialmente somente no Discord desktop Windows x64

## Estrutura

```
goLiveBypass/
├── index.tsx                      # renderer: patch do video guard, regiões, painel VPN e diagnóstico
├── native.ts                      # facade Electron: CAPTCHA isolado, updater e controller da VPN
├── vpn-controller.ts              # estado, ownership, migração pontual, watchdog e reinício
├── vpn-windows.ts                 # WireSock/WFP, AllowedApps, serviço e restauração de rede
├── vpn-proton.ts                  # sidecar Proton, sessão, seleção de rota e CAPTCHA
├── vpn-types.ts                   # contratos puros, validação e sanitização do perfil
├── stability.ts                   # guarda pura do falso estado de Live/erro 2001
└── bin/win32-x64/proton-confgen.exe # helper x64 incluído nos releases

installer/
├── GoLiveBypass-Installer.bat     # Windows: dois cliques, libera a execução e chama o .ps1
├── GoLiveBypass-Installer.ps1     # Windows: instalador automático
└── golivebypass-installer.sh      # Linux: mesmo instalador, mesmo menu

standalone/
├── golivebypass.js                # o bypass inteiro, sem build: proxy, roteador SOCKS,
│                                  #   regra por host, registro
├── GoLiveBypass-Standalone.bat    # Windows: dois cliques
├── GoLiveBypass-Standalone.ps1    # Windows: instala direto no Discord
└── golivebypass-standalone.sh     # Linux: o mesmo

golive-gui/                        # app Electron de um clique (Windows, macOS e Linux AppImage): injeta o
                                   #   standalone, mora na bandeja / barra de menus e reverte
                                   #   ao sair pelo ícone de lá. scripts/sync-bypass.mjs
                                   #   mantém a cópia embutida idêntica ao standalone

tests/
└── test-posix.sh                  # suíte de portabilidade: roda os instaladores em containers
                                   #   (podman/docker) com sh, dash, ash, bash, zsh, ksh e mksh

assets/
└── instalacao.gif                 # o vídeo do começo deste README
```

## Licença

GPL-3.0-or-later, mesma licença do Vencord/Equicord. Veja [LICENSE](LICENSE).

## Autor

**bezumiya**

- GitHub: [bezumiya/GoLiveBypass](https://github.com/bezumiya/GoLiveBypass)
- Twitter: [@obezumiya](https://twitter.com/obezumiya)
- Discord: `1366453661970071633`

## Agradecimentos

**Obrigado ao [mazxxy](https://github.com/mazxxy)** pela ideia que virou a espinha dorsal do projeto.

Ele foi o primeiro a notar que o `session.setProxy` vale para a sessão inteira e a propor,
na [PR #3](https://github.com/bezumiya/GoLiveBypass/pull/3), o desenho que usamos até hoje:
um SOCKS5 local com um PAC embutido mandando **só o gateway** pela proxy. O standalone nasceu
exatamente assim, e o plugin adotou o mesmo roteador depois. A PR ficou parada tempo demais
por culpa minha; ela foi mesclada pela autoria, porque as linhas já tinham sido reescritas,
mas a ideia é dele.

**Obrigado ao [Vithor](https://github.com/Vith0r)** pelo instalador.

Ele escreveu o primeiro instalador do GoLiveBypass por conta própria, e foi ele quem mostrou
que dava para automatizar tudo isso num script só. O instalador que está aqui hoje nasceu
desse trabalho.

**Obrigado ao [cleo-dev](https://github.com/cleo-dev)** pela interface gráfica.

Ele construiu o aplicativo inteiro, do zero, e com ele o projeto passou a alcançar quem nunca
vai abrir um terminal — que sempre foi a maior barreira aqui. Antes disso, usar o GoLiveBypass
exigia entender o que é um checkout, um gerenciador de pacotes e uma etapa de compilação.

**Obrigado ao [Eduardo Vasconcelos](https://github.com/EduardoVasconceloss)** pelo fork [StreamFix](https://github.com/EduardoVasconceloss/StreamFix).

Ele passou o plugin por uma pilha de revisões adversariais e encontrou erros de verdade: o
veredito da sessão lido cedo demais (a atribuição do experimento não vale no instante do
`CONNECTION_OPEN`), o teto de tentativas furado por reconexões em rajada, e a regra de proxy
do sistema atropelada por uma regra fixa. Ele também portou o roteador SOCKS local — que aqui
só existia no standalone — para dentro do plugin. As correções e melhorias dele foram
adotadas neste repositório, e o GoLiveBypass é melhor por causa delas.

**Obrigado ao [gabrigode](https://github.com/gabrigode)** pelo suporte a Flatpak no instalador de Linux.

O Discord de Flatpak parecia intocável e o instalador nem olhava para ele. O PR do Gabriel
achou o
deploy do Flatpak (tanto o do sistema quanto o do usuário), ensinou o instalador a liberar a
pasta do bypass para o sandbox com `flatpak override`, e documentou cada pegadinha — inclusive
que um `flatpak update` refaz o deploy inteiro e leva a injeção junto, então é preciso rodar
o instalador de novo depois de atualizar.

**Obrigado à [StellaThimoty](https://github.com/StellaThimoty) e ao [pdl-clay](https://github.com/pdl-clay)** pelo caminho do Vesktop.

Ela abriu a issue mostrando que dava para instalar o plugin no Vesktop apontando o "Vencord
Location" para um build manual — e testou até funcionar. Ele transformou o relato dela no
passo a passo completo que está no README, com direito à pegadinha do Flatpak.

**Obrigado ao [Victor Mello](https://github.com/victorsvart)** pelo fork [GUI-MacOS](https://github.com/victorsvart/GoLiveBypass-GUI-MacOS).

A interface gráfica existia apenas no Windows, então ele fez a portabilidade da GUI para o macOS.

**Obrigado ao [Claude](https://claude.com/claude-code)** pela mão no código. ❤️

Muita coisa daqui foi escrita e depurada em par com ele — principalmente os bugs que só
aparecem medindo, não lendo.

# English

**GoLiveBypass** is an **Equicord/Vencord** plugin, made by a Brazilian developer, that **restores Go Live and camera for Brazilian Discord users**. Its first migrated transport targets Windows x64: the main process brings up an isolated WireGuard/WireSock profile whose `AllowedApps` contains only the current Discord executable, its updater and an optional route-probe helper. Browsers, games and other processes remain on the normal network. The plugin does not use the legacy SOCKS/PAC/Tor transport.

It was written after Brazil's data protection authority (ANPD) [ordered Discord to suspend live streaming (Go Live) in Brazil](https://www.gov.br/anpd/pt-br/assuntos/noticias/em-medida-preventiva-anpd-determina-que-discord-suspenda-transmissoes-ao-vivo-no-brasil) in August 2026, shortly after the country blocked X (Twitter). The tunnel starts and stops with the plugin and the Discord process is restarted automatically so the whole session uses the selected profile. If service ownership or network restoration cannot be confirmed, the plugin reports a recovery state instead of taking over another WireSock instance. Bypassing the restriction may violate Discord's ToS.

- Desktop Discord with Equicord or Vencord injected; the migrated VPN is Windows x64 only. The renderer patch may load in other Electron hosts, but Vesktop and non-Windows VPN behavior are not validated by this migration.
- Dependencies: Git, Node.js 22+, pnpm 11 (via `corepack enable`), and a desktop Discord client. The release package includes `proton-confgen.exe`; WireSock is installed on demand with a pinned official hash.
- **Your calls stay on the region you pick.** The plugin keeps its `RTCRegionStore` preference override separate from the VPN controller and restores it on `stop()`.
- The plugin stores its WireGuard profile, Proton session and ownership lock in `%LOCALAPPDATA%\GoLiveBypass\plugin-vpn`; it does not read GUI settings or standalone state except for the one-time compatible-file migration described above.
- DNS/HTTPS/route probes are diagnostic-only. They are logged for troubleshooting and do not block activation, change the route during a call, or stop Discord.
- Install: copy the `goLiveBypass` folder into `src/userplugins/` of your Equicord or Vencord clone, then `pnpm install && pnpm build && pnpm inject`, fully restart Discord, and enable **GoLiveBypass** in plugin settings. The Windows PowerShell installer is available again for the current WireGuard beta; the Linux installer and standalone remain separate in this migration.
- Made by **bezumiya** — [GitHub](https://github.com/bezumiya/GoLiveBypass), [Twitter](https://twitter.com/obezumiya), Discord `1366453661970071633`.
- Thanks to **[mazxxy](https://github.com/mazxxy)** for the idea that became the project's backbone: a local SOCKS5 with an embedded PAC routing only the gateway through the proxy ([#3](https://github.com/bezumiya/GoLiveBypass/pull/3), merged for authorship — the lines were later rewritten, but the design is his).
- Thanks to **[mazxxy](https://github.com/mazxxy)** for the idea this project is built on: he was the first to notice that `session.setProxy` applies to the whole session, and proposed the design still in use — a local SOCKS5 with an embedded PAC routing **only the gateway** through the proxy. Thanks to **[Vithor](https://github.com/Vith0r)** for the installer: he wrote the first GoLiveBypass installer on his own and showed that the whole setup could be automated in a single script. Thanks to **[cleo-dev](https://github.com/cleo-dev)** for the graphical app, built from scratch. Thanks to **[Eduardo Vasconcelos](https://github.com/EduardoVasconceloss)** for the [StreamFix](https://github.com/EduardoVasconceloss/StreamFix) fork: his adversarial reviews found real bugs (verdict read too early, retry ceiling raced, system proxy policy trampled) and he ported the local SOCKS router into the plugin — fixes and improvements adopted here. Thanks to **[gabrigode](https://github.com/gabrigode)** for the Linux installer improvements: Flatpak support for system and user installs, including the sandbox filesystem override. Thanks to **[StellaThimoty](https://github.com/StellaThimoty)** for finding and testing the manual Vesktop path, and to **[pdl-clay](https://github.com/pdl-clay)** for turning it into the step-by-step guide in this README. Thanks to **[Victor Mello](https://github.com/victorsvart)** for the [GUI-MacOS](https://github.com/victorsvart/GoLiveBypass-GUI-MacOS) fork: He ported the GUI app to MacOS. Thanks to **[Claude](https://claude.com/claude-code)** for the hand on the code: much of this was written and debugged alongside it, mostly the bugs that only show up when you measure instead of read.
- License: GPL-3.0-or-later.
