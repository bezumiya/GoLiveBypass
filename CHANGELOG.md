# Changelog

Todas as mudanças notáveis deste projeto são documentadas aqui. O formato segue
[Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o versionamento
segue [Semantic Versioning](https://semver.org/lang/pt-BR/).

## [1.1.12] - Unreleased

### Adicionado
- **Aviso visível + recarga automática no arranque frio em modo Tor** (beta 2,
  [#116](https://github.com/bezumiya/GoLiveBypass/issues/116)): a GUI é um
  processo Electron à parte do Discord e, no boot do Windows, precisa
  terminar o próprio arranque antes de sequer chamar o Tor — o Discord
  (nativo, mais rápido, e também com "Iniciar com Windows" ligado) costuma
  vencer essa corrida. O bypass já fazia a coisa seguramente (segura o
  gateway, nunca vaza direto pelo IP brasileiro), mas sem aviso a pessoa só
  via "carregando" parado, sem saber se travou. Agora: (1) um banner
  informativo aparece na janela do Discord avisando que o Tor está subindo
  (com retentativa até a janela do cliente existir — o Discord mostra uma
  splash sem URL antes do app de verdade); (2) assim que o Tor responde, a
  janela recarrega sozinha na hora (se o gateway ainda não tiver roteado por
  conta própria), em vez de esperar o backoff do próprio Discord tentar de
  novo. Testado ao vivo (Discord + Tor reais numa VM Windows): o arranque
  frio, a detecção do Tor pelo batimento e a recarga (ou o cancelamento dela
  quando o gateway já roteou sozinho) se comportaram como esperado.
- **Orçamento de espera do Tor no arranque frio aumentado de 45s para 90s**
  (`TOR_HOLD_BUDGET_MS`): com o aviso visível acima, esperar mais não
  confunde mais ninguém, e reduz quantos ciclos de recusa+retentativa o
  Discord precisa até o Tor (que pode legitimamente levar mais de 45s numa
  máquina fria) responder.
- **Botão "Reiniciar agora" no banner de reconexão durante uma
  chamada/transmissão**: o aviso amarelo que já existia (issue #129/#131)
  pedia Ctrl+R por texto; agora tem um botão que faz o mesmo
  (`location.reload()` na própria janela do Discord) com um clique.
- **Janela de "chamada recente" alargada de 5 para 20 minutos**
  (`MIDIA_RECENTE_MS`): essa marca só é atualizada quando um websocket de
  mídia NOVO abre (entrar numa call, ligar a câmera) — uma call já em
  andamento, sem reconectar por dentro, não a renova. Em calls/streams
  longas (comuns, de dezenas de minutos) o valor antigo de 5 min podia
  classificar uma chamada ainda ativa como "sem mídia" e a recarga
  automática (abaixo) reiniciaria a janela **no meio da chamada** — o oposto
  do que a guarda existe para evitar. Vinte minutos reduz bastante essa
  janela de risco (não elimina para calls mais longas: o projeto não
  inspeciona o payload do gateway para saber se a call segue de pé, só os
  hosts do handshake, por design).
- **Mitigação do "RTC connecting" eterno após instabilidade do Tor** (beta:
  [#129](https://github.com/bezumiya/GoLiveBypass/issues/129),
  [#131](https://github.com/bezumiya/GoLiveBypass/issues/131)): quando o
  gateway reconecta **sem chamada/transmissão recente** (ver janela acima),
  a janela do Discord é recarregada proativamente (após provar que a saída
  está entregando) — o motor de vídeo renasce limpo em vez de travar na
  próxima tentativa de Go Live. Com chamada em andamento continua só o
  banner manual (reload encerraria a call). Máximo de 1 reload a cada 3 min.
- **Singleton do `garantirTor`**: chamadas concorrentes (boot + janela)
  spawnavam dois `tor.exe` — um perdia a porta e morria com "Reading config
  failed".

### Corrigido
- **Falha silenciosa do auto-update no Windows Portable**
  ([#135](https://github.com/bezumiya/GoLiveBypass/issues/135)): no Windows, o executável
  portable gerado pelo `electron-builder` utiliza um wrapper NSIS que mantém um handle aberto
  exclusivo sobre o arquivo executável (`PORTABLE_EXECUTABLE_FILE`) durante toda a sua execução.
  Tentativas de substituir o executável de dentro do processo Electron ativo falhavam com
  `EBUSY / Permissão negada`, e o comportamento padrão de ocultar a janela para a bandeja do
  sistema impedia o encerramento do processo pai. A atualização agora utiliza um helper
  desacoplado e silencioso via `wscript.exe` que aguarda o encerramento incondicional
  (`app.exit(0)`), substitui o executável no disco e relança a versão atualizada automaticamente.
- **"Falha ao injetar" em cliente paralelo (Vesktop/Equibop/Legcord) sem dizer o motivo real**
  ([#123](https://github.com/bezumiya/GoLiveBypass/issues/123),
  [#130](https://github.com/bezumiya/GoLiveBypass/issues/130),
  [#132](https://github.com/bezumiya/GoLiveBypass/issues/132),
  [#133](https://github.com/bezumiya/GoLiveBypass/issues/133)): quatro relatos do mesmo
  padrão — "patch direto falhou (motivo no aviso acima)" — mas o "aviso" só ia para o
  console, nunca para o relato automático de bug (`--- logs ---` sempre vazio), obrigando
  diagnóstico manual toda vez. Causa raiz encontrada: Equicord e Vencord são forks
  **diferentes** — o build do Equicord só empacota `dist/equibop.asar` (o cliente dele), o
  do Vencord só `dist/vesktop.asar` (o dele); nenhum dos dois gera o `.asar` do outro. Quem
  tem o Vesktop instalado (comum: gente que usa só o Vesktop, sem Discord oficial) mas está
  com um checkout Equicord (a escolha mais comum) sempre batia nessa parede — e a mensagem
  antiga ("rode `pnpm build` e tente de novo") era **enganosa**: nenhum `pnpm build` nesse
  checkout jamais geraria `vesktop.asar`. Legcord é um projeto à parte (não é fork de
  nenhum dos dois) e tinha o mesmo problema. Agora o instalador (`.ps1` e `.sh`) detecta o
  mod do checkout (`Get-CheckoutMod`/`checkout_mod`, já existente) e, se o par mod×cliente
  não bate, explica exatamente isso — com o texto chegando de verdade no relato automático
  de bug (o `.ps1` agora devolve o motivo real em vez de "no aviso acima"). Teste de
  regressão novo: `tests/test-parallel-client-mismatch.sh` (dash/debian, 10 asserções) e
  validação funcional ao vivo do `.ps1` numa VM Windows (5 cenários: mismatch detectado,
  sucesso normal, build realmente faltando, cliente desconhecido, e a checagem de mod).

- **Aviso quando a proxy manual configurada está permanentemente quebrada**
  ([#134](https://github.com/bezumiya/GoLiveBypass/issues/134), "loading infinito
  mesmo dando control r"): com uma saída manual (`settings.proxy`) configurada
  mas recusando a conexão em toda tentativa (visto no relato: SOCKS5 recusando
  a autenticação, `etapa=auth`), o app já caía para Tor/gratuitas
  automaticamente — mas sem avisar a pessoa, que ficava dando Ctrl+R e
  reabrindo o Discord tentando "consertar" algo que só uma troca da própria
  proxy resolveria. **Ctrl+R não ajuda nesse caso**: ele só recarrega a
  página (renderer), não o processo principal onde o roteador roda — a
  saída manual quebrada continua sendo a preferida a cada abertura nova.
  Agora, depois de 2 falhas seguidas do probe em segundo plano, um banner
  avisa que a proxy configurada não respondeu, que o app está usando uma
  saída automática por baixo, e que reiniciar não resolve — é preciso
  checar o endereço/usuário/senha em Configurações. Contador por processo
  (uma resposta boa zera), banner uma vez só por sessão.

### Plugin Vencord/Equicord (`goLiveBypass/native.ts`)
O plugin é uma implementação separada do bypass (não gerada a partir de
`standalone/golivebypass.js`, arquitetura própria: patches de webpack +
roteador local + IPC com o renderer). Repetia o padrão da
[#37](https://github.com/bezumiya/GoLiveBypass/issues/37) — nenhuma das
mitigações de estabilidade das versões recentes tinha chegado até ele. Esta
rodada portou as duas mais críticas, adaptadas à arquitetura do plugin (não
uma cópia mecânica do standalone):
- **Rotação de circuito do Tor não derruba mais o gateway** (porte do
  [#122](https://github.com/bezumiya/GoLiveBypass/issues/122)): `isTorProxy()`
  identifica quando a saída ativa é um Tor local (auto-detectado ou digitado
  à mão no campo Proxy) e dá a ela prazo bem mais largo no trafego vivo
  (`TOR_RELAY_TIMEOUT_MS`, 30s) e no batimento (`TOR_HEARTBEAT_TIMEOUT_MS`,
  informativo — nunca troca nem descarta a saída). Antes, qualquer saída
  (Tor incluído) usava os prazos curtos pensados para proxy gratuita, e uma
  falha de probe durante a construção de um circuito novo (a cada ~10min)
  trocava de saída ou reconectava o gateway à toa.
- **Reload de sessão bloqueada não derruba mais uma call/transmissão em
  andamento**: `retryWithProxy` recarregava a janela do Discord **sem
  nenhuma verificação** sempre que o servidor continuava bloqueando o vídeo
  — reconectar o gateway no meio de uma call trava o motor de vídeo até um
  Ctrl+R manual (confirmado ao vivo no standalone, issue #129/#131, mesmo
  motor de vídeo dos dois lados). Agora um hook em
  `session.defaultSession.webRequest` observa quando um websocket de mídia
  (`*.discord.media`) abre — se houver um recente (call/transmissão em
  andamento, janela de 20min), o reload não acontece e a pessoa recebe um
  toast explicando em vez de ter a call encerrada por baixo do pé.
- **Detecção do Tor (auto ou manual) até 10x mais rápida**: achada testando
  ao vivo numa VM — o Tor configurado à mão (ou auto-detectado) usava a
  mesma função de teste da saída gratuita (`measure`, duas requisições HTTP
  completas em série: trace da Cloudflare + checagem do gateway), com prazo
  curto pensado para vencer a corrida do gateway (2,5s). Contra um Tor são
  mas não instantâneo isso reprovava a saída — visto ao vivo: Tor
  respondendo fora do plugin, `measure()` ainda assim estourando o prazo
  dentro dele, e a sessão caindo para uma saída gratuita aleatória com o Tor
  perfeitamente saudável do lado. `torReachable()` novo faz só o handshake
  TLS até o gateway (o único host que decide o bloqueio) com prazo bem mais
  largo; `torCountry()` novo faz a checagem de país à parte, com prazo curto
  e best-effort (não filtra se não responder a tempo — melhor destravar
  agora que ficar preso num geo-check inconclusivo). Confirmado ao vivo: o
  proxy Tor manual, que antes falhava e caía para uma saída gratuita da
  Coreia do Sul, passou a responder em ~1,1s.

Fora do escopo desta rodada (documentado como trabalho futuro): o plugin não
tem um modo "só Tor, nunca vaza direto" equivalente ao `routeMode` do
standalone/GUI — ele sempre tenta manual → pote → Tor → gratuitas → direto,
nessa ordem, com um teto de 12s. Sem relato específico de "carregamento
infinito ao abrir" para o plugin (o padrão da issue #116 é sobre a corrida
GUI×Discord no boot do Windows, que não existe da mesma forma aqui), não
implementei um modo equivalente nesta rodada — adicionar um exigiria nova
opção de settings e mudança maior na cadeia `pickExit`/`autoExit`.

**Pendência da regra de sincronização (seção 4 do AGENTS.md):** o aviso de
proxy manual quebrada da issue #134 (ver acima, nesta mesma versão) só foi
implementado no standalone/GUI até agora — o plugin tem o mesmo padrão de
falha silenciosa em `pickExit()` (loga em `history`/arquivo, nunca mostra
`showToast`) e merece o mesmo aviso, adaptado ao mecanismo de toast dele.
Não portado nesta rodada por escopo/tempo; fica para a próxima.

## [1.1.11] - 2026-08-29

Hotfix de estabilidade do ciclo 1.1.10: o bypass agora **sobrevive ao reboot**
de verdade (sem botão verde de novo), o Tor não derruba mais o gateway nas
rotações de circuito, e os instaladores de linha de comando voltam a
funcionar de ponta a ponta.

### Adicionado
- **Re-injeção automática no boot (`autoInject`)**: uma flag gravada nas
  configurações lembra que o bypass estava ativo. No boot, se a injeção não
  estiver no disco (o quit limpo a restaura), a GUI reativa sozinha — sem
  esperar o clique no botão verde. Zerada apenas quando o usuário desativa
  explicitamente. No modo tor, espera o daemon subir antes de injetar.
- **`diagnostico.ps1`**: coletor de boot/autostart para o Windows (somente
  leitura, proxy nunca impressa): Run key com detecção de caminho morto,
  tarefas agendadas, processos/portas, tails de log, eventos de erro, AV de
  terceiros e estado de injeção. Salva um `.txt` no Desktop para o suporte.
- **`COMO-INSTALAR.md` dentro do zip do plugin**: o `goLiveBypass-vencord.zip`
  sai com as instruções junto dos 3 arquivos fonte, e o card de conflito da
  GUI + os avisos dos CLIs apontam para o tutorial completo do README.

### Corrigido
- **O bypass apagava a si mesmo a cada reboot**: o `revertOrphanedInjection`
  revertia a injeção NOSSA e INTACTA sempre que o PC desligava sem quit
  limpo — no Windows ela é autocontida (stub + patcher + settings dentro do
  asar) e funcionava sozinha. Agora só reverte quando os arquivos internos
  quebrarem de verdade; no Linux ela persiste enquanto o patcher existir no
  `INSTALL_DIR`.
- **Trocar de modo no seletor não chegava ao runtime no Windows**
  ([#121](https://github.com/bezumiya/GoLiveBypass/issues/121)): o
  settings.json dentro do asar só era reescrito na ATIVAÇÃO — o bypass
  rodava no modo velho atravessando reinícios do Discord, e com a lista
  gratuita morta o fallback varria só as portas clássicas do Tor e perdia o
  daemon da GUI na 9060 (gateway direto, IP BR). Agora a troca reescreve a
  injeção na hora (com aviso de que vale no próximo start) e o fallback
  começa pelo `torAddr` gravado.
- **Rotação de circuito do Tor derrubava o gateway no modo tor**
  ([#122](https://github.com/bezumiya/GoLiveBypass/issues/122)): o batimento
  de 4s marcava a saída única como morta durante a construção do circuito
  novo (5-30s) e o relay abortava em 2.5s — janelas de minutos (no log do
  relato, 30 e 57 min) sem gateway. Batimento agora é informativo no modo
  tor e o relay usa 30s, atravessando a construção do circuito.
- **EBUSY ao ativar com o Discord recém-fechado**: o retry do
  rename/remove era passivo — handle de processo vivo não some com espera.
  As primeiras tentativas re-executam o kill do Discord; as demais aguardam
  o SO liberar (antivírus/indexador).
- **Autostart do Windows quebrado para usuários do portable**: a Run key era
  gravada com o exe EXTRAÍDO do `%TEMP%` (o portable se auto-extrai a cada
  execução) — limpou o temp, o boot falhava em silêncio com o checkbox
  marcado. Agora grava o exe original (`PORTABLE_EXECUTABLE_FILE`) e se
  auto-cura a cada abertura. O Tor do logon também não abre mais janela de
  terminal (wrapper VBS via wscript).
- **Seletor de Discords com checkboxes vazios e injeção com `Path` nulo** no
  instalador: `Get-PatchTargets` tratava strings como objetos (`.Flavour`
  dava `$null`) — e uma regressão minha stringificou os objetos do
  standalone, que já estavam certos. Ambos restaurados com o formato certo
  de cada `Get-DiscordResources`.
- **Instalação nova pela linha de comando falhava no injector**: o
  `--location` mandava `...\Discord\app-1.0.x` ao instalador do
  Vencord/Equicord, que espera a raiz (`...\Discord`) — o `.sh` do Linux já
  mandava certo. Relato de usuário com o print do
  `EquilotlCli` rejeitando o caminho.
- **Falha de injeção sem detalhe** ([#120](https://github.com/bezumiya/GoLiveBypass/issues/120)):
  o "Falha ao injetar em algum dos Discords escolhidos" agora carrega o
  alvo e o código de saída no relato automático.
- **Bug report mentia o modo no Windows**: `routeModeDisco` lia a
  preferência da GUI, não o que o runtime vai ler (o settings dentro do
  asar injetado) — divergência GUI×runtime agora é visível no relato.

## [1.1.10] - 2026-08-29

### Adicionado
- **Versão visível na UI**: número da versão agora aparece no header
  (`Go Live · Brasil · v1.1.9`), no título da janela (`GoLiveBypass
  v1.1.9`) e no tooltip + label do menu da bandeja do sistema.
  ([#93](https://github.com/bezumiya/GoLiveBypass/pull/93))
- **Toggle "Avisar sobre atualizações"**: switch na UI (mesmo padrão do
  "Iniciar com Windows") + checkbox no menu da bandeja. Quando
  desativado, o app não chama `checkForUpdatesAndNotify` nem exibe o
  diálogo de update-downloaded. Persistido em `settings.json` como
  `autoUpdate: boolean` (default `true`; settings corrompido → `true`
  pelo fallback seguro).
  ([#93](https://github.com/bezumiya/GoLiveBypass/pull/93))
- **Fallback para Tor em modo `gratuitas`**: quando a lista de
  `proxyList.txt` morre toda (`pickFreeExit` retorna null), o bypass
  agora tenta o Tor local como fallback antes de cair para saída
  direta. Antes, lista morta em modo `free` significava "load infinito"
  no Discord (gateway conectava direto pelo IP BR). Fecha
  [#85](https://github.com/bezumiya/GoLiveBypass/issues/85).
  ([#86](https://github.com/bezumiya/GoLiveBypass/pull/86))
- **Startup do Windows portable funcional**: o "Iniciar com Windows"
  agora grava em `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
  via `reg.exe`, com aspas para suportar caminhos com espaço (`C:\Program
  Files\`) e arg `--hidden` para subir só na bandeja. Antes o
  `app.setLoginItemSettings` do Electron retornava sucesso silencioso
  mas nada acontecia (delega ao instalador Squirrel/MSI, que não existe
  em portable). Linux `.desktop` e macOS `setLoginItemSettings`
  preservados. Fecha
  [#84](https://github.com/bezumiya/GoLiveBypass/issues/84).
  ([#86](https://github.com/bezumiya/GoLiveBypass/pull/86))
- **Escolha de qual Discord patchear na TUI e no CLI**: com mais de uma
  instalação (Discord oficial, PTB, Canary, Vesktop, Equibop, Legcord), os
  quatro instaladores agora perguntam quais recebem o patch — um, vários ou
  todos — em vez de patchear tudo sem avisar (standalone) ou delegar a
  escolha ao instalador do próprio mod, que só patcheia um e não conhece
  clientes paralelos (plugin). Multi-select estilo checkbox no menu (Espaço
  marca, `a` marca todos) e entrada textual (`1,3`, `2-4`, `t`) em terminal
  pequeno. Com uma instalação só, nada muda; `-Yes`/sem TTY continuam
  agindo em todos (a GUI não é afetada). A detecção de clientes paralelos
  agora existe também no Windows.

### Corrigido
- **Modo de roteamento da GUI era ignorado no Linux** (`routeMode` nunca
  chegava ao runtime): o `readNetMode()` da GUI tem default **virtual**
  `tor` — mostra Tor sem gravar nada — e o `linuxActivate` chamava o
  script standalone só com `--yes`/`--proxy`, nunca passando o modo. O
  `saveTorAddr()` criava o `settings.json` só com `torAddr` e o
  `install_patcher` regravava o arquivo preservando `routeMode` só se já
  existisse. Resultado: o runtime injetado nascia no default `auto` e, no
  `auto`, o probe do Tor contra `discord.com` é recusado pela Cloudflare
  (`tls alert handshake failure` com exit Tor), então `detectTor()`
  falhava com o Tor saudável na 9050 e o bypass caía no pool de
  **proxies gratuitas** — exatamente o log da
  [#108](https://github.com/bezumiya/GoLiveBypass/issues/108) ("22
  candidatas", saída `socks5://193.25.215.182`), com a GUI jurando que
  estava em Tor. Agora, com defesa em profundidade: a GUI materializa
  `routeMode`/`torAddr` no settings.json compartilhado **antes de toda
  ativação** (escrita atômica por merge, `updateSharedSettings`, que
  todas as preferências da GUI usam); o modo também viaja por argv
  (`--net-mode`/`--tor-addr`, novos, com `--tor` retrocompatível) e o
  script grava o que vier na flag por cima do arquivo — imune a escritor
  antigo/terceiro que regrave o settings.json sem a chave. A TUI do
  standalone também grava o modo explícito em toda escolha (a opção
  "gratuitas" não gravava `routeMode: free` e o CLI puro herdava
  `auto`). No runtime, o probe de um endereço Tor passou a provar o
  túnel com handshake TLS até o gateway (`gateway.discord.gg`) em
  qualquer modo — o que o `auto` prometia ("Tor local se houver") volta
  a valer mesmo com a Cloudflare na frente. Observabilidade pra drift
  futuro: a primeira linha do log do bypass agora diz o modo efetivo
  (`modo de roteamento: tor (settings.json)`), o `--status --json`
  reporta o `routeMode` do disco, e o bug report inclui
  `routeModeDisco` (o modo que o runtime vai ler, não só o do seletor).
  O fluxo Windows/macOS não muda (já materializava o modo dentro do
  app.asar injetado). Fecha
  [#108](https://github.com/bezumiya/GoLiveBypass/issues/108).
- **Preferência "Avisar sobre atualizações" zerava a cada ativação no
  Linux**: o `autoUpdate` da GUI vive no mesmo `settings.json`
  compartilhado, e o heredoc do `install_patcher` regravava o arquivo
  com um conjunto fixo de chaves, apagando a preferência. Agora a chave
  é preservada na regravação (e o merge da GUI nunca mais escreve
  subsets parciais).
- **`--uninstall`/`--restore` abortavam no meio com Tor do sistema**: o
  `remove_tor` rodava `systemctl --user disable --now
  golivebypass-tor.service` sem `|| true` — quando a unit não existe
  (o usuário usa o Tor da distro na 9050, não o embutido), o erro de
  "unit does not exist" tripava o `set -eu` e o script saía com código
  ≠ 0 antes do fim. A GUI recebia o erro e mostrava como mensagem as
  últimas linhas do stderr — que eram o ruído inofensivo de
  `LD_PRELOAD` (`ERROR: ld.so: ... cannot be preloaded`) típico de
  distros imutáveis (Bluefin/Bazzite), o famoso `Error occurred in
  handler for 'deactivate'`. Os `systemctl` agora toleram ausência da
  unit, e a GUI filtra o ruído `ld.so` do stderr antes de compor a
  mensagem de erro.
- **`Set-RunKey` apagava todas as entradas de inicialização do usuário**: no
  provider de registro do PowerShell (ao contrário do de arquivos),
  `New-Item -Path <chave> -Force` numa chave que **já existe** apaga a chave e
  recria vazia. Como o `Set-RunKey` do instalador e do standalone chamava isso
  em `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` antes de gravar o
  `GoLiveBypassTor`, toda execução limpava o startup da máquina (Spotify,
  Steam, Discord…) e deixava só a nossa entrada. Passava despercebido porque os
  poucos apps que reescrevem a própria entrada a cada abertura (como o Docker
  Desktop) reaparecem sozinhos, e porque a chave `StartupApproved` — que a tela
  "Inicializar" do Windows lê — não é tocada e continua listando tudo, então a
  lista da interface parece intacta. Agora a chave Run só é criada se realmente
  faltar.
- **Refresh do Tor em modo `tor` segurava o gateway por até 12s** quando o
  daemon oscilava: `refreshExit` chamava `detectTor()` com timeout de 6s
  para o probe + 6s para `exitCountryTorCached`. Em modo `tor` o bypass
  recusa saída direta (vazaria IP BR), então o Discord ficava preso em
  "load infinito" até o refresh terminar. Agora o refresh usa probe curto
  (3s) e o `currentExit` espera o refresh terminar em vez de recusar na
  hora. ([#87](https://github.com/bezumiya/GoLiveBypass/issues/87),
  [#89](https://github.com/bezumiya/GoLiveBypass/pull/89))
  - Nota: o fix já estava aplicado em `main` antes desta versão (cherry-pick
    manual, sem o commit formal do PR). Esta entrada apenas documenta a
    equivalência com o upstream.
- **Serviço do Tor embutido quebrava no boot do Linux** com `status=127`
  em distros com libevent recente (Arch, Fedora 40+): o bundle
  `tor-expert-bundle-13.5` foi compilado contra uma libevent 2.1 que ainda
  exporta `evutil_secure_rng_add_bytes` (removido em versões mais novas), e
  o `ld.so` resolvia para a libevent do sistema, fazendo o daemon abortar
  antes de subir. O `golivebypass-installer.sh` e o `golivebypass-standalone.sh`
  agora gravam `Environment=LD_LIBRARY_PATH=$TOR_LIBDIR` na unit do
  systemd (user e system) e exportam a variável nos fallbacks `nohup`, e a
  GUI Electron (que já fazia o mesmo em `main.ts`) continua o
  comportamento. O `tor` da porta 9060 agora sobe limpo no logon.
- **AppImage no Linux: `.desktop` de autostart apontava para o mountpoint
  temporário** (`/tmp/.mount_GoLiveXXX/golive-gui`) que some junto com o
  AppImage desmontado. O helper `realExecPath()` em `startup.ts` agora
  prioriza a env `APPIMAGE` (definida pelo runtime do AppImage) quando
  ela existe, garantindo que o `Exec=` do `.desktop` em
  `~/.config/autostart/golivebypass.desktop` aponte para o `.AppImage`
  real no disco.
- **Standalone Windows falhava ao substituir Vencord/Equicord** com
  `Cannot create a file when that file already exists`: nesses estados o
  `_app.asar` (backup do original feito pelo mod) já existe, e o fluxo só
  chamava `Remove-Injection` para o estado `OutroMod`. O `Rename-Item
  -Force` do `Install-Injection` não sobrescreve destino existente no
  Windows (`-Force` só afeta atributos escondidos). Agora o
  `Install-Injection` restaura o original antes de renomear, cobrindo
  também corrida com o updater entre a checagem de estado e a injeção.
  Fecha [#103](https://github.com/bezumiya/GoLiveBypass/issues/103).
- **Instalador/standalone quebravam com caminho nulo e viravam issue
  falsa no GitHub**: funções utilitárias (`Test-DiscordResourcesReady`,
  `Get-InjectedPath`, `Save-Text`, `Find-Checkout*`, `Install-Patcher`)
  passavam variáveis não inicializadas para `Join-Path`/`Split-Path`/
  `Test-Path`, estourando `Não é possível associar o argumento ao
  parâmetro 'Path' porque ele é nulo` — e o filtro de auto-report só
  reconhecia a mensagem sem acentos, então esse erro de ambiente abria
  issue como se fosse bug. Agora há checagens defensivas de `$null`/
  string vazia nas funções de resolução de caminho, fallback para
  `$USERPROFILE\AppData\Local` e `[IO.Path]::GetTempPath()`, o
  `Install-Patcher` do standalone baixa o `golivebypass.js` do GitHub
  quando rodado via `irm | iex` (sem `$PSScriptRoot`), e o
  `Test-ShouldReport` aceita as variantes acentuadas (PT-BR e EN).
  Fecha [#99](https://github.com/bezumiya/GoLiveBypass/issues/99).
  ([#107](https://github.com/bezumiya/GoLiveBypass/pull/107))
- **Cold start no modo `gratuitas` nascia direto (IP bloqueado)**: com listas
  públicas instáveis, as candidatas não ficavam prontas dentro do prazo de
  12s e a 1ª conexão do gateway saía direta — sessão bloqueada + 2 reloads
  (o "carregando infinitamente" da #98). Agora, estourado o prazo com o
  cache frio (sem saídas validadas em `state.json`), o bypass tenta o
  fallback do Tor local — o mesmo do #85 — antes do direct; sem Tor,
  comporta-se como antes. Cache quente, modo `tor` e saída manual
  inalterados. Mitiga
  [#98](https://github.com/bezumiya/GoLiveBypass/issues/98).
- **Relatórios de bug do instalador/standalone chegavam sem log nem
  metadata**: o payload usava `includeLogs`, campo que a API nem lê — issues
  como a #94 chegavam com log vazio e sem contexto. Agora o payload segue o
  formato da GUI (`log` + `meta`), com o tipo da exceção, o 1º frame do
  stack e a flag `caminho_8_3` (variáveis gravadas na forma 8.3 curta, tipo
  `C:\Users\CSAR~1`, que deixam de resolver quando a geração de nomes curtos
  está desligada no Windows — a causa provável da #94). O caminho base
  (`LOCALAPPDATA`/`TEMP`) agora é validado de verdade: se a variável existir
  mas não resolver, cai para o caminho canônico do Windows. Mitiga
  [#94](https://github.com/bezumiya/GoLiveBypass/issues/94).

## [1.1.9] - 2026-08-26

### Adicionado
- **TUI estilo OpenCode** nos 4 instaladores de terminal (PowerShell + bash):
  menus com caixas, setas, mouse SGR (Linux) e teclado (Windows). Sem
  dependência externa e sem binário extra. Cai automaticamente para os menus
  `[1]/[2]/[3]` quando o terminal não tem TTY ou `-Yes/--yes` foi passado.
  ([#50](https://github.com/bezumiya/GoLiveBypass/pull/50))
- **Auto-detecção de clientes paralelos** (Equibop, Vesktop, Legcord AUR) no
  instalador de plugin: agora varre `/usr/share`, `/usr/lib`, `/usr/lib64`,
  `/opt` e `~/.local/share`. Antes, só o Discord oficial era detectado.
  ([#50](https://github.com/bezumiya/GoLiveBypass/pull/50))
- **Instalação automática do Tor** nos 4 instaladores e no plugin: baixa o
  Expert Bundle 13.5, confere SHA-256, extrai e registra serviço persistente
  (systemd user/system no Linux, Run key no Windows) na porta 9060. Modo
  "Tor automático" nos menus. ([#48](https://github.com/bezumiya/GoLiveBypass/pull/48))
- **Auto-report de bugs** nos instaladores de terminal: ao falhar, monta
  diagnóstico sanitizado (versão, OS, cauda do log) e faz POST na API de
  bugs. Credenciais e tokens são redacted antes do envio. Erros de uso não
  reportam. ([#50](https://github.com/bezumiya/GoLiveBypass/pull/50))
- **Watchdog do Tor** na GUI: detecta quando o daemon da 9060 morre ou trava
  no meio da sessão e ressuscita o mesmo Tor (sem trocar de saída).
  Aciona após 2 falhas seguidas com heartbeat de 30s. ([#60](https://github.com/bezumiya/GoLiveBypass/pull/60))
- **Saída manual volta sozinha depois de cair**: o batimento tenta a saída
  manual a cada ~90s quando ela está fora (medido: até 48 min fora, voltou
  sozinha). Não tenta durante chamada ou Live em andamento. ([#64](https://github.com/bezumiya/GoLiveBypass/pull/64))
- **Botão "Testar" da GUI** aceita range `host:portaInicial-portaFinal` —
  testando uma porta sorteada do range, igual à ativação. ([#64](https://github.com/bezumiya/GoLiveBypass/pull/64))
- **Checagem de país do exit do Tor** no bypass: ~37 relays Tor são
  brasileiros (0.4% do total) e o servidor do Discord bloqueia Go Live com
  IP BR. Cache de país com TTL de 8 min (1 consulta por circuito, não por
  batimento). Recusa exits em BR e segura o gateway em vez de abrir direto
  pelo IP brasileiro. ([#76](https://github.com/bezumiya/GoLiveBypass/issues/76))
- **Job `release-assets` no CI** (Onda 2 do auto-update): publica 4 assets
  extras na release — `goLiveBypass-vencord.zip` (userplugin Vencord com
  `manifest.json` fixo para sempre baixar a versão mais recente),
  `goLiveBypass-vencord.zip.sha256`, `GoLiveBypass-<ver>-bypass.js` e o
  `.sha256` do bypass. Roda em paralelo com os builds da GUI.
  ([#77](https://github.com/bezumiya/GoLiveBypass/pull/77))

### Corrigido
- **TUI quebrava no cmd/conhost** clássico: a interface aparecia cheia de
  `[48;5;235m` com cursor pulando. Agora habilita VT no stdout via
  `SetConsoleMode(ENABLE_VIRTUAL_TERMINAL_PROCESSING)` ou cai para os menus
  textuais. ([#63](https://github.com/bezumiya/GoLiveBypass/pull/63))
- **3 bugs da TUI nos instaladores Windows** (caixa embaralhada, primeiro
  item pulado). 10/10 testes verdes no harness de `tests/tui-windows/`.
  ([#72](https://github.com/bezumiya/GoLiveBypass/pull/72))
- **`Invoke-CheckUpdate` quebrava** com erro `Write-Yellow`/`Write-Dim`/
  `Write-Green` (cmdlets inexistentes). Trocado por `Write-Host -ForegroundColor`.
  ([#75](https://github.com/bezumiya/GoLiveBypass/pull/75))
- **Serviço do Tor no Windows** rodava como `LocalService` e não conseguia
  escrever em `%LOCALAPPDATA%` — ficava parado. Trocado para Run key do
  usuário (mesmo contexto da GUI), com `Start-Process` para subir o daemon
  na hora. ([#48](https://github.com/bezumiya/GoLiveBypass/pull/48))
- **Banner "Ctrl+R" espúrio** após retorno silencioso para saída manual
  (`gatewayConnCount` ficava em 2+ e disparava o aviso sem motivo). Agora
  a troca zera o contador junto com `gatewayReconexoes`.
  ([#71](https://github.com/bezumiya/GoLiveBypass/pull/71))
- **`tryReturnToManual` violava o AGENTS.md** em modo Tor: trocava Tor →
  manual quando a manual voltava, mesmo o modo `tor` sendo exclusivo.
  Adicionada guarda `if (routeMode === "tor") return;` (mesma proteção de
  `trySwapByRtt` e `stockReserves`). ([#71](https://github.com/bezumiya/GoLiveBypass/pull/71))
- **`isManualAddress` inconsistente com `parseProxy`** para range inválido:
  aceitava `socks5://h:100-50` como porta única 100 mas rejeitava a ativa.
  `tryReturnToManual` ficava preso tentando trocar para uma porta que ele
  mesmo já tinha sorteado. Alinhada a convenção e rejeita `portEnd > 65535`.
  ([#71](https://github.com/bezumiya/GoLiveBypass/pull/71))
- **Auto-report abria issue para erros de uso** (5 issues #65-#69
  desnecessárias): "Cancelado.", "O Discord não fechou", "Ctrl+C cancelou",
  dependência faltando, CLI digitada errada, path errado e mensagens
  equivalentes. Adicionada deny-list em `Test-ShouldReport` (ps1) e
  `should_report` (sh) nos 4 scripts. Bugs reais (bypass, patcher,
  instalador) continuam reportando.
  ([#65](https://github.com/bezumiya/GoLiveBypass/issues/65),
  [#79](https://github.com/bezumiya/GoLiveBypass/pull/79))
- **TUI em `[ "$TUI_COLS" -le 20 ]` com `set -e`** abortava o shell: o
  teste falso retornava 1 e o `tui_menu` nunca era desenhado. Trocado por
  `if ...; then ...; fi; return 0`. ([#50](https://github.com/bezumiya/GoLiveBypass/pull/50))
- **Mouse SGR no `tui_is_interactive`** exigia `-t 1` (stdout) além de
  `-t 0` (stdin), quebrando em pty/emuladores onde o stdout não reporta
  tty. Reduzido para só `[ -t 0 ]`.

### Infraestrutura
- **CI**: novo job `release-assets` publica userplugin Vencord + bypass
  standalone + hashes SHA-256 (Onda 2 do auto-update).
  ([#77](https://github.com/bezumiya/GoLiveBypass/pull/77))
- **Testes**: +9 suites de teste novas
  (`tests/tui-windows/`, `tests/test-auto-update.{sh,ps1,edge.sh}`,
  `tests/test-ci-release.sh`, `tests/test-userplugin-e2e.sh`,
  `golive-gui/tests/torwatchdog.test.ts`,
  `golive-gui/tests/pr64-proxy-url.test.ts`,
  `standalone/tests-pr64/test-{is-manual-address,parse-proxy-range,try-return-to-manual}.js`).
  Harness automatizado para TUI Windows (10/10 verde).
- **Docs**: `docs/auto-update-plugin/00-sumario-executivo.md` e
  `02-plano-auto-update.md` documentam as duas ondas do auto-update.

### Estatísticas
- 15 commits, 5.926 inserções, 33 deleções em 28 arquivos.
- PRs: [#50](https://github.com/bezumiya/GoLiveBypass/pull/50),
  [#48](https://github.com/bezumiya/GoLiveBypass/pull/48),
  [#60](https://github.com/bezumiya/GoLiveBypass/pull/60),
  [#63](https://github.com/bezumiya/GoLiveBypass/pull/63),
  [#64](https://github.com/bezumiya/GoLiveBypass/pull/64),
  [#70](https://github.com/bezumiya/GoLiveBypass/pull/70),
  [#71](https://github.com/bezumiya/GoLiveBypass/pull/71),
  [#72](https://github.com/bezumiya/GoLiveBypass/pull/72),
  [#75](https://github.com/bezumiya/GoLiveBypass/pull/75),
  [#77](https://github.com/bezumiya/GoLiveBypass/pull/77),
  [#79](https://github.com/bezumiya/GoLiveBypass/pull/79),
  [#82](https://github.com/bezumiya/GoLiveBypass/pull/82).
- Issues: [#65](https://github.com/bezumiya/GoLiveBypass/issues/65),
  [#76](https://github.com/bezumiya/GoLiveBypass/issues/76).

## [1.1.8] - 2026-08-22

### Adicionado
- Reporte automático de bugs com logs detalhados e rate limit agressivo
  (PR [#42](https://github.com/bezumiya/GoLiveBypass/pull/42)).
- Modo dev com janela de logs, VPS testável e report de bug na GUI
  (PR [#42](https://github.com/bezumiya/GoLiveBypass/pull/42)).
- Sync-bypass: regenerar `bypass.ts` a partir do `golivebypass.js`
  (PR [#38](https://github.com/bezumiya/GoLiveBypass/pull/38)).

### Corrigido
- Proxy manual/privada não troca por RTT/reserva, só por morte real
  (PR [#38](https://github.com/bezumiya/GoLiveBypass/pull/38)).
- Detectar Discord mesmo com pasta `app-*` incompleta durante update.
- Elevação sem TTY, status honesto e modo dev só em `npm run dev`.
- API: fail-fast no boot — conferir labels do repo alvo antes de subir.

## [1.1.7] e anteriores

Veja o histórico de tags e commits para o que veio antes.
