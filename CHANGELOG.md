# Changelog

Todas as mudanças notáveis deste projeto são documentadas aqui. O formato segue
[Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o versionamento
segue [Semantic Versioning](https://semver.org/lang/pt-BR/).

## [1.1.10] - Unreleased

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
