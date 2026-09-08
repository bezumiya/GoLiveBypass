# Changelog

Todas as mudanças notáveis deste projeto são documentadas aqui. O formato segue
[Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o versionamento
segue [Semantic Versioning](https://semver.org/lang/pt-BR/).

## [Unreleased]

## [2.0.5-beta-15] - 2026-09-08

### Teste adicional do update beta

- Nova prerelease para validar a entrega do SSE e a atualização pelo card da interface.

## [2.0.5-beta-14] - 2026-09-08

### Teste de entrega do update beta

- Publicação de validação do fluxo SSE e do card de atualização para instalações na beta-13.

## [2.0.5-beta-13] - 2026-09-08

### Proteção contra downgrade no SSE e no updater Windows

- O broker SSE agora rejeita releases antigas ou iguais, evitando que um
  webhook atrasado de beta-9 substitua o replay de beta-12.
- O polling escolhe a maior tag SemVer válida, sem depender da ordem ou apenas
  da data de publicação retornada pelo GitHub.
- O updater Windows valida o nome completo do portable e o nome do arquivo na
  URL; o helper Proton de aproximadamente 14,6 MB nunca é candidato ao update.
- O incidente foi confirmado nos artefatos: o portable publicado mede cerca de
  101 MB e o helper separado cerca de 14,6 MB; o digest SHA-256 continua sendo
  conferido antes da aplicação.

## [2.0.5-beta-12] - 2026-09-07

### Correção do asset Windows no updater

- O updater agora seleciona somente o portable `GoLiveBypass-<versão>.exe` da release.
- O `proton-confgen` não pode mais ser baixado como se fosse o executável principal.
- Adicionados testes para a ordem real dos assets e para a ausência do helper como candidato.

## [2.0.5-beta-11] - 2026-09-07

### Paridade dos helpers Proton no empacotamento

- A compilação dos helpers agora desativa o carimbo VCS do Go (`-buildvcs=false`) e o job de assets de reparo reutiliza exatamente as saídas que geram o manifesto.
- O pipeline compara a versão e o SHA-256 de cada helper com `proton-confgen-manifest.json` antes do upload; qualquer divergência interrompe a release.
- O incidente de paridade encontrado na `v2.0.5-beta-10` está documentado em [`docs/releases/2026-09-08-proton-helper-hash-parity.md`](docs/releases/2026-09-08-proton-helper-hash-parity.md).
- O helper do updater Windows só remove o executável antigo depois de iniciar a nova versão e confirmar que ela permanece aberta por cinco segundos; em falha, restaura a versão anterior.

## [2.0.5-beta-10] - 2026-09-07

### Fluxo de atualização na GUI

- Removidos os popups nativos de atualização do Windows e Linux; o card persistente da interface agora concentra o aviso e a ação de reinício.
- Falhas de preparação ou aplicação continuam preservando a versão atual e ficam registradas no log, sem interromper a sessão com uma janela do sistema.
- O `npm run dev` exibe uma prévia visual do card para validação antes da publicação.

### Ajuste visual

- O card de atualização fica centralizado horizontalmente no topo da janela.

## [2.0.5-beta-9] - 2026-09-07

### Card persistente de atualização

- O aviso de atualização passou a ser um card fixo no canto superior direito, exibido somente quando há uma versão pronta.
- O card oferece **Reiniciar e aplicar** e permanece visível até a aplicação ser iniciada com sucesso.

## [2.0.5-beta-8] - 2026-09-07

### Preparação automática da GUI

- A GUI agora procura o `proton-confgen` em todos os layouts de desenvolvimento e empacotados, valida o hash e repara a cópia ausente ou corrompida usando o asset da mesma release.
- O Windows continua instalando o WireSock automaticamente via UAC quando necessário; o Linux instala apenas `wireguard-tools`, `iproute2`/`iproute` e `curl` ausentes via `pkexec`/`sudo`, sem upgrade global.
- A versão não exige Go, WireSock ou o aplicativo ProtonVPN instalados manualmente pelo usuário.

### Ativação imediata do canal beta

- Ao ativar o canal beta nas configurações, a GUI consulta imediatamente a última beta compatível, baixa o instalador e abre o pedido para reiniciar e aplicar a atualização.
- A checagem aguarda uma consulta inicial em andamento para não perder a troca de canal; desativar o canal continua respeitando a preferência de atualizações automáticas.

## [2.0.5-beta.7] - 2026-09-07

### Atualização da GUI

- Corrige a troca do executável portable no Windows para relançar com o nome da nova versão, em vez de manter o nome anterior.
- Adiciona um toast interno na GUI quando uma atualização é baixada e fica pronta para reiniciar.
- Reativa o cliente SSE na beta publicada e mantém a consulta de releases como fallback.

## [2.0.6-beta.2] - 2026-09-07

### Correção do pipeline beta

- A publicação dos assets Windows/Linux ocorre primeiro em draft; a release só é marcada como prerelease depois que os dois jobs terminam.

### Failover automático de rotas Proton Free

- A GUI Windows/Linux mantém um pool local de até duas reservas ping-validadas além da rota ativa. A preparação ocorre depois da abertura do Discord e não cria túneis concorrentes.
- Após falha sustentada do peer WireGuard, a GUI troca a rota sem fechar o processo do Discord: Linux reaplica o peer com `wg setconf` e Windows reinicia somente o serviço WireSock. Cada candidata precisa confirmar handshake antes de ser promovida.
- O recurso fica ativo por padrão e pode ser desligado em Preferências. É exclusivo do Proton Free; há uma única renovação do pool por sessão. Se todas as candidatas falharem, o Discord permanece aberto e a GUI exibe um aviso discreto.
- Perfis Proton gerenciados passaram a usar `PersistentKeepalive = 10` para fornecer um sinal de liveness compatível com a janela de 10–15 segundos. Probes HTTP, IP e geolocalização continuam somente diagnósticos.

### Migração da VPN para o plugin

- O plugin Vencord/Equicord ganhou um controlador WireGuard/WireSock autônomo para Windows x64, com ProtonVPN e `.conf` personalizado, lock de ownership, reinício completo do Discord e restauração verificável da rede.
- O filtro `AllowedApps` fica restrito ao `Discord.exe`, ao `Update.exe` da instalação atual e, quando disponível, ao helper temporário de diagnóstico. Probes de IP, DNS, HTTPS e rota são log-only.
- Sessão Proton, perfil, lock e logs ficam no namespace privado `GoLiveBypass/plugin-vpn`. Uma única migração compatível importa apenas `wireguard.conf` e `proton-session.json` da GUI; settings e estado legado não são compartilhados.
- O `proton-confgen.exe` x64 passa a ser incluído no zip do plugin pelo workflow de release. O standalone, o `app.asar` e a cópia gerada `golive-gui/electron/bypass.ts` não foram alterados por esta migração.

### Inicialização do túnel WireGuard

- Windows e Linux aguardam dois segundos para o túnel se acomodar antes de abrir o Discord, evitando que o updater seja iniciado durante a conexão inicial. A espera é local e limitada; probes de IP, HTTP e handshake continuam apenas diagnósticos.

### Atualização automática do Windows

- O updater portable baixa o executável, confere o SHA-256 e agenda a troca em um helper externo. A substituição agora ocorre somente depois que o processo antigo encerra, evitando `EBUSY` ao renomear o próprio `.exe`; falhas mantêm a versão atual aberta e ficam registradas no log.

### Pulso de atualização

- A API Go recebe o webhook de `release.published` do GitHub, valida o HMAC e distribui um evento SSE para as GUIs conectadas. O cliente reconecta com backoff, faz duas tentativas após o pulso e mantém a consulta direta ao GitHub como fonte de verdade.
- A checagem de segurança passou para uma vez por hora. No Windows, o executável validado por SHA-256 fica pendente até o usuário escolher **Reiniciar para atualizar**; a preferência de updates pode desligar o SSE e as consultas automáticas sem interromper o app.

### Detecção do plano Proton

- A GUI consulta o endpoint autenticado de configurações da Proton (`/vpn/v2`) usando somente a sessão salva e classifica `VPN.MaxTier` como Free, Premium ou desconhecido. A consulta não tenta conectar a um servidor pago, não cria túnel e não interrompe uma rota ativa.
- O plano fica em cache por 15 minutos por conta, com coalescência de chamadas simultâneas e atualização manual. Free e respostas desconhecidas mantêm a seleção segura em tier 0; somente Premium confirmado permite tiers pagos. A sessão, o token, o IP e o endpoint não são exibidos.
- O indicador do painel informa Free, o título do plano Premium ou “não confirmado”. Falhas de sessão/rede não viram falso Free e não impedem o login; o helper oferece `-check-plan -json` sem pedir senha. Standalone e plugin legado não usam essa integração.

### Seleção inicial Proton por velocidade

- O primeiro login e a abertura sem medição compatível passam a medir download e upload em até seis finalistas saudáveis. A triagem mede o ping de todas as rotas da amostra regional, ordena as doze menores latências, valida o túnel e o endpoint HTTPS das doze e começa a medição pelos seis primeiros saudáveis; uma falha de transferência avança para a próxima rota já aprovada. O ranking final escolhe a maior média harmônica de download/upload, usando ping apenas como desempate. A busca continua sendo uma amostra regional, não uma varredura de todos os servidores.
- O painel Proton mostra skeleton, progresso por tentativa, servidores testados/restantes e Mbps medidos, com cancelamento e opções de tentar novamente ou continuar sem uma nova medição. Os resultados permanecem visíveis após reabrir o aplicativo.
- Quando a otimização automática é iniciada na abertura do programa, o diálogo de progresso também fica visível durante toda a triagem e medição; ao terminar, ele é fechado sem deslocar o foco do usuário.
- Em contas Premium no modo automático, rotas da América do Sul recebem preferência quando o ping medido fica até 12 ms acima de uma rota distante; uma diferença maior continua favorecendo o menor ping. A versão do critério foi incrementada para medir novamente perfis anteriores.
- O loop real com uma sessão Premium percorreu três ciclos sul-americanos e nove ciclos globais (370 rotas regionais pingadas por ciclo no escopo global): preflight de 12 rotas e seis medições válidas foram preservados, e o melhor resultado ficou em 94 ms de RTT aquecido com `SV#36` e 54,4 Mbps de download. Depois desse ganho, cinco ciclos consecutivos não reduziram o RTT; a rodada foi encerrada sem alterar a qualidade mínima.
- A lista de medição e o cartão da rota selecionada exibem os servidores no formato compacto `PAÍS#servidor` (por exemplo, `US#189`), mantendo o nome original internamente para seleção e cache.
- Cada rota visível ganhou uma bandeira SVG correspondente ao país, com fallback compacto para novos códigos que a Proton venha a disponibilizar.
- O diálogo de otimização acompanha a paleta da aplicação nos temas claro e escuro, usando superfícies, bordas e estados semânticos existentes no lugar do destaque roxo.
- Medições são reutilizadas quando conta, filtros, versão do critério e perfil salvo correspondem em fluxos que pedem reaproveitamento. A versão do critério foi incrementada para exigir o novo preflight completo de doze rotas; resultados anteriores são medidos novamente uma vez. Não há expiração diária. A abertura/login repetem a otimização quando o bypass está inativo; se ele já estiver ativo, a medição é adiada para não interromper uma chamada. A otimização manual mede novamente.
- Geração temporária e cancelamento aguardando o encerramento do helper preservam o perfil anterior em falhas. O login permanece válido se a medição falhar. A medição continua isolada por WireGuard/netstack, sem alterar a rota do host; diagnósticos de IP/HTTP do Discord continuam somente nos logs.
- Mantidos até 4 MiB de download e 1 MiB de upload por candidato, 12 segundos por candidato, verificação rápida de até 6 segundos por rota (handshake e HTTPS zero-byte, até quatro túneis em paralelo, com retentativa serial das falhas transitórias), 180 segundos para a triagem e os testes e limite externo de 210 segundos. A velocidade começa pelos seis menores pings aprovados e usa as demais rotas já aprovadas como reserva até completar seis medições válidas. O resultado descreve o caminho até o endpoint de medição naquele momento, sem garantir a qualidade de cada transmissão.
- Windows/Linux compartilham a seleção e a interface. O helper CLI oferece `-progress-json` em stderr e `-speed-test-trace` para acompanhar no terminal, sem mudar seu JSON final. Standalones e plugin legado não usam esse seletor Proton; não receberam uma tela nem mudanças de recuperação de rede.

### Correções investigadas na fila de issues

### Loop de estabilidade Linux

- **Bazzite/Flatpak:** a abertura do Discord oficial agora entra diretamente no namespace
  WireGuard com `setsid`, preservando o barramento da sessão Wayland e o portal do usuário;
  o launcher não passa mais por uma unidade `systemd` do sistema, que podia encerrar o
  `bwrap` antes de o cliente aparecer. A confirmação consulta `flatpak ps` e usa o PID do
  sandbox para o status, com espera de até 20 segundos para cold starts. Se a abertura falhar,
  o processo é fechado antes da remoção do namespace para não deixar um cliente órfão. A GUI
  também remove sequências ANSI corrompidas (como `�[36m`) das mensagens de erro. A triagem
  do detector foi validada em CachyOS com Flatpak simulado; a aceitação em uma sessão Bazzite
  real ainda depende do log do usuário, especialmente se o `bwrap` estiver sendo bloqueado por
  política de namespaces do sistema.
- Adicionada a matriz descartável `tests/test-linux-matrix.sh` para Ubuntu 24.04/22.04, Debian 13/12, Fedora 43/42 e Arch atual, com caso histórico fixado em 2025-09-01. O runner valida o preflight JSON, detecta binários presentes mas inutilizáveis, audita bibliotecas antigas/AppImage e executa a prova de namespace sem alterar a rede do host.
- O preflight agora sugere o comando correto por família: `apt-get update`/instalação mínima, `dnf makecache --refresh`, `zypper --non-interactive refresh` ou `pacman -S --needed`. A GUI continua instalando apenas dependências ausentes; não há upgrade global nem `pacman -Sy` parcial. DNF e Zypper atualizam somente os metadados antes da instalação.
- Adicionado `tests/test-linux-vm.sh` para VMs libvirt preparadas, com preflight/reparo por SSH, conferência da rota default do host e hook opt-in para uma sessão Premium sem registrar credenciais. Distrobox fica como reprodução auxiliar, não como prova de isolamento.
- O workflow `.github/workflows/linux-stability.yml` executa a matriz rápida e a auditoria do AppImage sem publicar artefatos. O procedimento, a execução contínua até sinal explícito e as limitações estão em [loop de estabilidade Linux](docs/testing/linux-stability-loop.md).
- A auditoria de bibliotecas do AppImage separa imagens mínimas de instalações desktop: bibliotecas ausentes ficam explícitas como `SKIP`, e `APPIMAGE_STRICT_LIBS=1` permite torná-las falhas em uma imagem com runtime gráfico instalado.
- O controlador `tests/run-linux-stability-loop.sh` mantém as rodadas Linux contínuas, alternando preflight, reparo e auditoria AppImage, comparando assinaturas de falha e encerrando somente por sinal explícito do operador.
- Evidência local desta rodada: os sete containers sem snapshot e a prova de namespace passaram no modo rápido; Debian 12 e Fedora 42 passaram instalação completa com segunda chamada idempotente. A imagem Arch atual foi marcada como infraestrutura bloqueada porque `archlinux:base` não traz bancos Pacman e a política impede upgrade parcial. O AppImage `2.0.5-beta.2` foi extraído em quatro bases e registrou bibliotecas ausentes nas imagens mínimas; isso não equivale a falha em uma instalação desktop completa. O snapshot Arch continua sem cobertura quando o espelho histórico não está disponível.

- CAPTCHA Proton (#239): duas perdas de resposta e uma corrida de fechamento antecipado foram reproduzidas no Electron real. O preload sandbox CommonJS, a captura persistente e o tratamento imediato de preload ausente/erro e `close` corrigem esses caminhos. Linux e Windows passaram as suítes sintéticas, incluindo Full-Repeat e captura/lifecycle 13/13; o relato original com desafio oficial não foi provado. A #230 (`__dirname`, caso histórico distinto do `_dirname` relatado pelo usuário na 2.0.4) permanece separada.
- Preflight de dependências Windows/Linux: a GUI distingue a SDK WireSock legada 1.4.7.1 da compatível 3.4.8.1, exige o par EXE/DLL e prepara `wg`/`ip`/`curl` Linux somente quando o preflight identifica um caso reparável. Linux teve validação de produto real em Debian rootless; Windows usa instalador oficial direto de hash fixado. Na VM, o runtime 1.4.7.1 interferiu no HTTPS fora do Discord em 3/3 ciclos com o formato atual; mudar somente a diretiva para o formato antigo preservou a rede nativa em 9/9 requisições. A GUI corrigida instalou a SDK 3.4.8.1 e passou três ciclos de ativação/desativação com isolamento por processo. A mudança para IP estrangeiro e os cenários de RTC/reboot ainda não foram comprovados. Detalhes: [relatório de preflight](docs/testing/2026-09-06-dependency-preflight.md).
- Elevação Linux no standalone: preserva sudo cacheado, usa pkexec quando a GUI não tem zenity/kdialog para apresentar um prompt sudo e não faz fallback após cancelamento, recusa ou senha incorreta. Probes readonly continuam sem prompt. A suíte completa executada após o ajuste teve 243 testes aprovados em 29 arquivos, incluindo 6 novos casos; o reviewer independente marcou PASS. Build Linux local com `--publish never` regenerado e SHA do shell empacotado conferido contra a fonte. O build Windows terminou com exit 0 sem publicação e SHA `f57f629f0d145a880e206692b0bc269ce85550d48714ee3169190e320e93caf3`; a VM confirmou a instalação automática e os ciclos de isolamento descritos no relatório.
- Linux: reconhece namespaces listados pelo `ip` tanto pelo nome puro quanto com NSID. A checagem anterior exigia um espaço após o nome, podendo tentar criar novamente `discord-vpn` e falhar com `File exists` (#228), além de omitir status e limpeza. GUI e standalone Linux compartilham a fonte corrigida. O outro sintoma da #228, `fopen: Permission denied`, ainda não tem causa confirmada.
- CAPTCHA Proton: o cancelamento usa uma referência à sessão capturada antes da destruição da janela. Evita `Object has been destroyed` no cleanup e operação de login pendente. O defeito foi reproduzido ao fechar a janela; a relação com o relato de erro após CAPTCHA da #239 ainda requer confirmação do cenário específico.
- Standalone Windows: a saída do `winget` vai ao console e não contamina o caminho retornado por `Ensure-WireSock` (#240). O entrypoint continua temporariamente desabilitado; esta correção da função não reativa nem publica o standalone.
- Os caminhos de proxy/PAC, plugin e standalone Windows não usam a detecção de namespace Linux nem a janela CAPTCHA da GUI. Nenhuma alteração de recuperação/rede foi portada mecanicamente ao legado.

Investigação, validação e limites por issue: [relatório da rodada](docs/testing/2026-09-05-global-issue-triage.md).

## [2.0.4] - 2026-09-05

### Perfil efetivo do WireSock

- A ativação atualiza e confere o comando do serviço, inclusive quando ele já foi instalado por outra ferramenta. Corrige a VM que continuava usando `wireproxy/discord-wiresock.conf` em vez da rota selecionada na GUI. Falhas reais de instalação/alteração/início do serviço são propagadas; não se aceita um serviço antigo como sucesso.

- A mesma correção de configuração efetiva foi portada ao standalone PowerShell, com `#@ws:AllowedApps` compatível com o SDK atual. O legado SOCKS/PAC não gerencia esse serviço.

- Autenticação e gerenciamento Proton permanecem na rede do host; somente os probes copiados para o diretório do Discord seguem seu túnel.

### Diagnóstico de rota sem bloqueio (Windows/Linux)

- Probes de IP, geolocalização, HTTP, handshake e tráfego deixam de impedir ativação/troca de rota ou derrubar o Discord. Os resultados, inclusive falhas repetidas, ficam somente nos logs; criação de túnel/serviço e abertura do processo continuam sendo verificadas.
- Windows inicia o Discord após subir WireSock e coleta os probes de escopo em segundo plano. Preparação/limpeza do helper de diagnóstico não bloqueia o cliente. O monitor não faz rollback por reprovação do probe. DNS/HTTPS de recuperação são informativos; resíduos reais de serviço/filtro ainda falham.
- Linux remove a espera obrigatória de readiness antes do lançamento/refresh; diagnóstico pontual vai a `logs/wireguard-diagnostics.log`, sem prompt de elevação. O monitor da GUI registra degradação sem reiniciar a sessão. O script Linux distribuído pela GUI compartilha esse comportamento; standalone Windows e plugin não tinham essa prova funcional.
- A interface não declara saída comprovada nem mostra alertas de probe. Ativo descreve túnel e processo iniciados, sem garantir o país ou a qualidade da saída.

### Rota Proton otimizada com medição real

- A busca regional considera todas as localidades elegíveis (país, região e cidade), com até dois candidatos de baixa carga por localidade. País escolhido e filtros de plano continuam respeitados; a GUI exclui saídas brasileiras, incompatíveis com o objetivo do bypass. Probes de latência têm concorrência limitada, deduplicação de IP e orçamento de 18 segundos; listas muito grandes ou redes lentas podem encerrar antes de medir todos.
- O botão **Otimizar rota** mede download, upload e latência HTTPS dentro de túneis WireGuard temporários de até seis finalistas, priorizando localidades distintas. Medições são sequenciais, evitando disputa de banda entre testes. Não é uma varredura de velocidade de todos os servidores nem garantia de máximo global.
- Ranking final: 70% velocidade medida (média harmônica de download/upload, para penalizar upload ruim) e 30% latência. A interface mostra Mbps medidos e informa duração/consumo antes do resultado. Até 4 MiB de download e 1 MiB de upload por candidato, aproximadamente 30 MiB de payload por busca, além do overhead de rede; orçamento de 12 segundos por candidato, até 75 segundos na etapa de velocidade e timeout externo de 150 segundos.
- O medidor usa WireGuard/netstack em memória: não cria interfaces ou rotas no host e nunca cai para HTTP direto quando o túnel falha. Na GUI, uma cópia temporária com outro nome fica fora das regras WireSock do helper normal; ela é removida ao terminar. VPNs externas que roteiem o sistema inteiro ainda podem influenciar a medição.
- A abertura do aplicativo reaproveita o perfil medido correspondente às preferências, em vez de sobrescrevê-lo pela heurística de carga. Otimização explícita mede novamente. Sem perfil medido, login/arranque continuam usando seleção rápida. Se todos os testes de velocidade falharem, a configuração anterior é preservada.
- Se o bypass estiver ativo, o Discord e o túnel anterior são encerrados antes da medição para evitar concorrência e interferência entre conexões. Em falha da medição, o Discord permanece fechado e a GUI orienta reativar o perfil anterior.
- A medição de velocidade escolhe a rota; o diagnóstico do escopo real do Discord ocorre depois da abertura e fica apenas nos logs.

### Fora do escopo

- Medições curtas usam os endpoints públicos do Cloudflare Speedtest e refletem aquele caminho/momento, não a velocidade garantida de cada destino do Discord. O benchmark transfere IPv4; o diagnóstico de rota observa as famílias disponíveis depois da ativação.
- GUI Windows/Linux compartilham o helper; sua CLI oferece `-speed-test`. Standalones sem seleção Proton e plugin SOCKS/PAC não usam esse seletor. Não foram alterados mecanismos de troca/reload do legado.

## [2.0.3] - 2026-09-05

### Hotfix de autenticação e rota segura

- CAPTCHA oficial da Proton integrado ao aplicativo, sem cópia manual de token.
- Login continua automaticamente após a verificação, com erros separados para
  cancelamento, expiração, CAPTCHA inválido e credenciais incorretas.
- Sessão Proton salva deixa de produzir falso erro de persistência no Windows.
- O WireSock comprova a mesma regra de diretório usada pelo Discord antes de
  liberar o cliente, evitando falso positivo de rota.
- Probes automáticos do Linux não abrem prompts de sudo/pkexec em segundo plano.

## [2.0.3-beta.3] - 2026-09-05

### Login Proton no Windows

- **CAPTCHA integrado:** quando o Proton exige verificação, o desafio oficial
  abre em uma janela isolada do GoLiveBypass. A resposta é capturada e validada
  automaticamente e o login continua sem pedir que o usuário copie token da
  URL ou use o console do navegador.
- **Erros corretos:** cancelamento, expiração e resposta rejeitada permanecem
  erros de CAPTCHA; não são mais apresentados como usuário ou senha incorretos.
- **Sem falso erro de persistência:** o sucesso do `proton-confgen`, que já só
  ocorre depois de salvar a sessão, passa a ser a fonte de verdade. A releitura
  do arquivo pelo Electron agora é uma confirmação diagnóstica assíncrona com
  tentativas limitadas, evitando o caso em que reiniciar o GoLive revelava que
  o login marcado como falho estava válido desde o início.
- **Troca de conta protegida:** confirmações atrasadas de um login anterior não
  sobrescrevem nem publicam estado para a conta autenticada depois.

### Correção Windows — issue #232

- **Prova do mesmo escopo do Discord:** a beta 1 comprovava somente que o
  `proton-confgen.exe` central entrava no túnel. Agora cada diretório `app-*`
  encontrado é incluído no `AllowedApps` e recebe um probe temporário. Esse
  probe só pode usar o WireSock pela mesma regra de diretório que cobrirá o
  `Discord.exe`, eliminando o falso positivo em que o helper aparecia no Canadá
  enquanto o Discord continuava com IP brasileiro.
- **Todas as instalações precisam passar:** Discord Stable, PTB, Canary e
  clientes paralelos detectados são comprovados individualmente antes de serem
  abertos. Um único diretório brasileiro, direto ou inconclusivo faz a ativação
  falhar fechada e restaurar a rede.
- **Sem arquivo residual:** os probes co-localizados são removidos antes de o
  Discord abrir, tanto em sucesso quanto em erro. Falha de limpeza também impede
  a abertura para não deixar um executável temporário abandonado na instalação.
- **Handshake continua auxiliar:** a decisão permanece baseada em HTTPS real,
  consenso entre fontes, comparação com o IP direto e acesso ao Discord, com
  tentativas tolerantes a inicialização lenta do túnel. Handshake recente por si
  só nunca aprova a rota.

### Fora do escopo

- A mudança continua específica da GUI Windows/WireSock. Linux já executa o
  próprio Discord dentro do namespace de rede, e o plugin não controla o filtro
  WFP. O standalone PowerShell ainda não distribui o sidecar necessário para a
  mesma prova co-localizada.

## [2.0.3-beta.1] - 2026-09-05

### Correção Windows — issue #226

- **Prova funcional antes do Discord:** a GUI mede a saída direta, inicia o
  WireSock e usa o `proton-confgen.exe` no mesmo `AllowedApps` para comprovar um
  IP público diferente, fora do Brasil, além de HTTPS até o Discord. O cliente
  só é aberto depois dessa prova; `wg.exe`, CLI e ProTUN ficam como telemetria
  auxiliar e sua ausência não causa falso negativo. Caminho absoluto e nome do
  executável são gravados juntos, usando a extensão `#@ws:AllowedApps` esperada
  pelo SDK 3.x, para compatibilidade entre versões do driver.
- **Falha fechada e status honesto:** serviço WireSock em execução sem prova de
  rota não é mais `ACTIVE`. IP direto/brasileiro ou resultado inconclusivo
  encerra a tentativa e restaura a rede antes de devolver controle.
- **Driver sem falso negativo:** a GUI reconhece tanto o filtro atual `ndiswg`
  quanto o legado `NDISRD`, mas a consulta ao SCM é apenas diagnóstico (ela pode
  ser ocultada a processos não elevados). Encontrar executável, driver ou serviço
  isoladamente nunca libera o Discord; só a prova funcional de rota o faz.
- **Troca sem janela direta:** trocar o servidor fecha Discord e updater, valida
  a nova saída e só então reabre o cliente.
- **IPv4 e IPv6 sem rota dividida:** o helper força as duas famílias de rede e
  recusa a ativação se qualquer fonte continuar vendo a saída direta. Perfis
  Proton novos passam a incluir `::/0` para não deixar o IPv6 fora do túnel.
- **Vigia e reinício seguros:** falhas repetidas do probe funcional retiram o
  estado `ACTIVE`, fecham o Discord e restauram a rede. Uma sessão WireSock que
  sobreviva a crash da GUI é revalidada do zero no próximo boot.

### Fora do escopo

- O probe funcional desta correção é específico da GUI Windows, pois reutiliza
  o sidecar `proton-confgen.exe` empacotado e o inclui no mesmo filtro WFP. O
  standalone PowerShell não distribui esse sidecar e o plugin Vencord/Equicord
  não controla WireSock; portar o comportamento exigirá um helper autenticado
  próprio em cada pacote, sem ampliar `AllowedApps` para todo `powershell.exe`.

## [2.0.2] - 2026-09-05

### Hotfix WireGuard Windows/Linux

- Consolidação das correções de estabilidade, ciclo de vida e recuperação do WireGuard.
- WireSock não bloqueia a ativação quando a telemetria opcional não está disponível.
- Falhas reais continuam acionando rollback e limpeza serializada.
- Linux confirma namespace, processo do Discord, handshake, tráfego e gateway antes de considerar o túnel saudável.
- Incluídas validações E2E e instaláveis oficiais para Windows e Linux.

## [2.0.2-beta.3] - 2026-09-04

### Teste E2E Linux e estabilidade

- Confirmada ativação no Discord real com namespace WireGuard, gateway acessível e tráfego RX/TX crescente.
- Status Linux agora distingue Discord fora do namespace de uma sessão realmente protegida.
- Inclui recuperação limitada para túnel degradado e correções de prontidão WireSock sem bloquear instalações sem telemetria opcional.

## [2.0.2-beta.2] - 2026-09-04

### Correção Windows

- **Prontidão WireSock não bloqueante:** a ativação e a troca de rota não falham
  mais apenas porque `wg.exe`, a CLI opcional, o handshake ou os contadores ProTUN
  não ficaram disponíveis a tempo. O WireSock ativo e o Discord iniciado concluem
  a operação; a confirmação de tráfego continua sendo registrada nos logs para
  diagnóstico. Falhas reais de inicialização e limpeza continuam acionando rollback.

- **Prontidão WireSock em duas fases:** instalações sem `wg.exe` nem CLI de status não entram
  mais no ciclo em que o Discord aguardava tráfego que apenas ele próprio pode gerar. O
  Discord inicia já protegido pelo filtro WireSock; em seguida o aplicativo confirma o túnel
  usando o tráfego real. Caso a confirmação falhe, encerra o cliente e restaura a rede.
- **Prazo de ativação respeitado:** a confirmação pelo ProTUN não executa sondagens HTTPS do
  host dentro do loop do WireSock. Duas amostras RX/TX crescentes, geradas após o Discord
  iniciar, confirmam a rota sem manter a GUI em carregamento por minutos.

### Correção Linux/Arch (issue #219)

- **Preflight acionável:** a GUI verifica `wireguard-tools` (`wg`), `iproute2` (`ip`), `curl`,
  autorização sudo/pkexec, namespaces de rede e a instalação do Discord antes de qualquer
  limpeza ou encerramento do cliente.
- **Sem loop de boot:** dependências ausentes agora deixam a ativação desabilitada e exibem o
  comando `sudo pacman -S --needed ...`; nenhum pacote é instalado automaticamente.
- **Instalações Arch descobertas:** bootstrap oficial, `discord_arch_electron`,
  `discord-electron-openasar`, PTB/Canary, clientes paralelos e Flatpak continuam sendo
  identificados sem tratar Equicord/Vencord como falha.
- **Operações serializadas:** ativação, desativação, restauração e troca de rota não podem
  iniciar duas instâncias WireGuard concorrentes; o status Linux usa single-flight, cache curto
  e limitação de telemetria para não reabrir o loop de varredura.

### Validação Linux

- Preflight verificado em contêiner Arch Linux com bootstrap simulado do Discord, tanto com
  dependências ausentes (erro acionável) quanto com `wireguard-tools`, `iproute2`, `curl` e
  autorização disponíveis (ambiente aprovado).

## [2.0.1] - 2026-09-04

### Correções de confiabilidade

- **Ciclo de vida WireSock serializado:** ativação, desativação, restauração de internet e troca
  de rota agora aguardam a operação anterior terminar antes de iniciar outra instância.
- **Limpeza recuperável:** processos e serviços residuais são encerrados em árvore, o Network
  Lock é resetado e a limpeza elevada pode ser repetida quando o Windows mantém um residual.
- **Validação WireSock sem ciclo:** após confirmar que o filtro WireSock subiu, o aplicativo abre
  o Discord já protegido e confirma o túnel pelo handshake/tráfego real do cliente. Isso funciona
  mesmo sem `wg.exe` ou a CLI opcional; falhas encerram o Discord e restauram a rede.
- **Restauração segura:** DNS só é limpo nos adaptadores WireSock/ProTUN; o DNS do host não é
  alterado permanentemente. O Discord só volta após limpeza e rede saudáveis.
- **Telemetria honesta:** ausência de `wg.exe` é reportada como telemetria indisponível quando o
  túnel está funcionando; falhas reais continuam sendo desconexão explícita ou teste funcional
  reprovado.
- **Encerramento correto:** o app aguarda a desativação antes de sair, evitando deixar WireSock
  ou o Network Lock presos no Windows.

### Correções do loop de recuperação

- **Watchdog sem sobreposição:** callbacks de uma geração anterior não podem agir depois de uma
  parada ou reinício.
- **Gateway sem reload duplicado:** a espera por uma saída reserva mantém seu próprio mutex e
  não permite dois reloads concorrentes.
- **RTC sem callback obsoleto:** respostas de uma sessão antiga são descartadas quando o Discord
  já iniciou outra navegação.
- **Paridade standalone/GUI:** o bundle do bypass é gerado a partir da fonte standalone e o
  build falha se as duas cópias divergirem.

### Proton, sessão e distribuição

- Persistência da conta Proton validada após login e gravação atômica da sessão.
- Fluxo de CAPTCHA permite concluir o login sem reiniciar a GUI e sem registrar credenciais.
- Diagnóstico registra serviço, PID residual, reset de lock, DNS, HTTPS e origem da confirmação
  do túnel sem expor endpoint privado.
- Build Windows portátil preparado para a versão 2.0.1.

### Validação

- 165 testes Vitest aprovados.
- 31 verificações de paridade aprovadas.
- Testes de gateway zumbi, recuperação RTC, corrida do viewer e re-seleção de saída aprovados.
- E2E em Windows 11: ativação aguardou a conexão real antes de abrir o Discord; desativação
  restaurou o cliente sem reiniciar o Windows.

### Agradecimentos

Obrigado aos beta testers e a todos os usuários que reportaram bugs, enviaram diagnósticos
sanitizados e repetiram cenários difíceis até conseguirmos reproduzi-los. Os relatos de queda
de rota, WireSock residual, loop de atualização e Discord preso em chamada foram essenciais para
esta estabilização.

## [2.0.0] - 2026-09-04

### Destaques

- **Mods no Windows:** a descoberta do Discord para WireSock usa somente `Discord.exe`; ela
  não lê, espera, cria ou altera `app.asar`/`resources`, preservando BetterDiscord e outros
  carregadores de mods.

- **WireGuard por aplicativo:** Windows usa WireSock/WFP para encaminhar somente o Discord (`Discord.exe`, `Discord` e `Update.exe`) pelo túnel. O restante do computador permanece na rede normal.
- **Namespace dedicado no Linux:** a GUI inicia o Discord dentro de `discord-vpn`, com a interface WireGuard isolada do restante do sistema.
- **Discord vanilla no Windows/Linux:** a GUI 2.0.0 não substitui nem injeta o `app.asar` do Discord. Ativar e desativar reinicia o cliente para aplicar ou remover o túnel com segurança.
- **ProtonVPN integrado:** login com sessão persistente, geração de configuração WireGuard, seleção automática por menor ping, suporte a 2FA e importação de configurações `.conf` próprias.
- **Persistência da conta Proton reforçada:** o GUI recupera o usuário da sessão salva no Windows/Linux, valida a gravação após o login e o sidecar grava sessões atomicamente, criando a pasta de dados quando necessário.
- **Privacidade na GUI:** endereço de e-mail Proton desfocado por padrão durante compartilhamento de tela e revelado apenas sob interação do usuário.
- **Diagnóstico de túnel:** logs e reports registram estado do handshake e volume de tráfego sem incluir o endpoint privado da VPN.
- **Login Proton com verificação humana:** quando o Proton exige CAPTCHA, a GUI abre o desafio oficial e permite reenviar o resultado sem reiniciar o aplicativo; tokens e senhas não são persistidos nem registrados.

### Compatibilidade e limites conhecidos

- **Plugin Equicord/Vencord e standalone CLI temporariamente fora de serviço:** a versão 2.0.0
  está disponível somente pela GUI. A portabilidade da solução WireGuard por aplicativo para
  essas duas variantes ainda está em andamento e elas voltarão após validação própria.
- O perfil WireGuard gratuito integrado é compartilhado; degradação sob carga pode afetar uploads e anexos. Uma configuração privada é recomendada para uso intenso.
- **macOS temporariamente indisponível:** a GUI não usa mais PAC/injeção e aguarda uma implementação de VPN por aplicativo equivalente.
- Depois de otimizar a rota ProtonVPN, é necessário sair e entrar novamente na chamada para que a nova rota seja usada pelo Discord.


## [1.1.12] - Unreleased

### Adicionado
- **Diagnóstico real do túnel WireGuard nos logs e nos reports (`electron/wgstats.ts`)**: pós
  migração para WireGuard, a causa mais provável de "Discord carregando infinito" deixou de
  ser o gateway zumbi do proxy legado e passou a ser o próprio túnel — o endpoint gratuito
  embutido é compartilhado e pode saturar, ou o handshake pode nunca ter completado. Não havia
  visibilidade nenhuma disso: um report de "travou" não dava pra diferenciar "túnel morto" de
  "túnel lento" de "outra coisa qualquer". Agora `wg show <iface> dump` é lido (handshake mais
  recente, bytes rx/tx) e:
  - Um vigia (45s de intervalo, sem opt-out — mesmo espírito do `torWatchdog`) loga
    `wg.stats`/`wg.handshake.velho` durante toda sessão ativa, incluindo a taxa de
    transferência entre amostras — dá pra ver no ring buffer se o túnel estava degradando
    minutos antes do usuário notar e reportar.
  - Handshake mais velho que 180s (o dobro do dobro do `PersistentKeepalive=25` que o bypass
    configura) com o bypass ativo vira aviso, não só info — sinal direto de túnel morto ou
    endpoint inalcançável.
  - Todo report de bug (os dois caminhos: `report-bug`/`bugreport.ts` e o
    `open-bug-report`/diagnóstico manual) inclui um snapshot fresco na hora do envio:
    `wg_handshake_ha_s`, `wg_rx_kb`, `wg_tx_kb`. O endpoint em si nunca é incluído (seria a
    saída escolhida da pessoa — mesma política de privacidade do resto do relatório).
  - **Linux**: como a GUI normalmente roda sem privilégio pra entrar no namespace de rede
    (`setns` exige `CAP_SYS_ADMIN`), a leitura não tenta o `ip netns exec` direto do processo
    desprivilegiado — o script standalone (que já roda elevado quando precisa) expõe os
    mesmos dados via `--status --json` (`wg_stats_json()`) e no `--status` legível, e a GUI
    consulta por ali. Sem privilégio nenhum disponível, o campo vem `"indisponivel"` de forma
    explícita em vez de simplesmente faltar.
  - **Windows**: lido via `wg.exe` (wireguard-tools) quando presente no PATH; sem ele, o
    report mostra `indisponivel` com o motivo em vez de omitir o campo.
  - **macOS (na série 1.1.12)**: fora do escopo — ainda usava o mecanismo legado de PAC/Tor, sem interface WireGuard
    nenhuma para vigiar.
  - Testado com `tests/wgstats.test.ts` (parsing do dump, handshake nunca, endpoint `(none)`,
    dump incompleto/vazio) e ao vivo nesta máquina via `--status --json` real.

- **Envelopamento de Discord via WireGuard Per-App VPN (Substituição do Proxy Legado)**:
  o mecanismo legado de injeção em `app.asar` e proxy PAC SOCKS5 para `*.discord.gg` foi
  desativado devido a incompatibilidades com sinalizações binárias ETF do Discord e bloqueios
  de IP cruzado em sessões de voz e WebRTC. Em seu lugar:
  - **Linux (`golivebypass-standalone.sh` e GUI)**: implementado isolamento via Network Namespaces
    do kernel Linux (`discord-vpn`). O Discord roda 100% envelopado dentro do túnel WireGuard,
    enquanto todo o restante da máquina continua operando diretamente na rede local/brasileira.
    O Discord permanece vanilla, sem adulteração de arquivos `.asar`.
  - **Windows (`GoLiveBypass-Standalone.ps1` e GUI)**: implementado isolamento via WireSock WFP
    (`wiresock-client-service`), tunelando estritamente os processos `Discord.exe` e `Update.exe`
    através de WireGuard, sem afetar navegadores ou conexões do sistema.
  - **Configurações WireGuard**: perfil padrão livre integrado (EUA/México) com suporte a importação
    de arquivos `.conf` customizados do usuário via flag `--wg-conf` / `-WgConf` ou no diretório local.
  - **Removidos os modos "Tor" e "Proxy gratuita" da GUI/Linux**: eram exclusivos do
    mecanismo legado de proxy/PAC (a saída precisava ser um túnel SOCKS5 apontado no
    `app.asar` injetado). Com Windows (WireSock) e Linux (netns) envelopando o Discord
    inteiro, a única saída de rede é a configuração `.conf` importada pelo usuário — não há
    mais seletor de modo na tela (`vpnConfigCard` substituiu o antigo seletor de `routeMode`).
    **macOS é a exceção**: sem um equivalente de Per-App VPN ainda implementado lá, ele
    continua dependendo do mecanismo antigo (PAC + injeção de `app.asar`, Tor incluso) como
    mecanismo real, não vestigial — não foi tocado nesta rodada.

- **Correção da trava de orçamento RTC no espectador (`standalone/golivebypass.js`)**:
  a função `renovarOrcamentoRtc` atualizava a chave `videoNativoOrcamentoChave` mesmo
  quando havia uma tentativa em voo (`videoNativoPendente !== null`), porém sem limpar
  as tentativas anteriores. Como as checagens subsequentes viam a chave já igual à
  armazenada, as tentativas gastas nunca eram reinicializadas, travando o espectador
  permanentemente em `teto_tentativas` e induzindo ao Erro 2012 na reabertura da Live.
  A atualização de chave agora é adiada até a resolução da tentativa pendente, a chave
  do espectador embute a identidade estrutural da conexão ativa (`stream.id`), e o
  encerramento de conexão (`conn.destroy`) reseta o estado ativo de demanda para
  garantir o avanço determinístico de epoch em nova intenção de assistir. Coberto em
  `tests/test-native-rtc-recovery.cjs`.

- **Fechamento prematuro de janelas PowerShell nos caminhos de status e sucesso (`standalone/GoLiveBypass-Standalone.ps1`)**:
  ao executar o script pelo Windows Explorer ("Executar com o PowerShell"), qualquer
  ação de status (`-Mode Status`), checagem/aplicação de update ou término bem-sucedido
  fechava instantaneamente a janela do console antes de o usuário ler as mensagens
  de confirmação. `Wait-AntesDeFechar` agora é invocado antes de cada `return` precoce
  e no encerramento normal do script. Coberto em `tests/test-error-handling.ps1`.

- **Corrida de ciclo de vida no plugin (`goLiveBypass/native.ts`)**: `shutdown()`
  não cancelava a promessa `enableOnce()` em voo caso o usuário desativasse o plugin
  durante a resolução de proxy ou subida de servidor, ressuscitando o roteador em
  segundo plano após o desligamento. Adicionada esgrima por sequência `enableSeq`,
  anulação do singleton `enabling` e reset da contagem de `retries` no `shutdown()`.
  Coberto em `tests/test-distribution-parity.cjs`.

- **Sincronização de porta Tor nas configurações de instalações injetadas no Windows/macOS (`main.ts`)**:
  `saveTorAddr` atualizava apenas o `settings.json` compartilhado, deixando o arquivo
  local dentro de `resources/app.asar/settings.json` com a porta antiga (9060) caso uma
  outra porta Tor fosse adotada pelo sistema. `saveTorAddr` agora chama
  `reescreverSettingsInjetado({ torAddr: addr })` imediatamente. Coberto em
  `golive-gui/tests/ativacao-guard.test.ts`.

- **Remoção de banner zumbi preso no DOM após recuperação (`standalone/golivebypass.js`)**:
  ao se recuperar de um congelamento de gateway com dispatches voltando a fluir, o código
  registrava a remoção mas não removia `#golivebypass-zumbi` do documento. Implementada
  a função `hideZumbiBanner()`, garantindo que o alerta seja retirado da interface
  após a recuperação. Coberto em `tests/test-gateway-zumbi-revive.cjs`.

- **Paridade de portas de varredura Tor (`standalone/golivebypass.js`)**: a lista
  `TOR_PORTS` no standalone omitia a porta `9060` (onde a GUI do GoLiveBypass sobe o Tor
  embutido), divergindo do plugin (`goLiveBypass/native.ts`). A porta `9060` foi
  adicionada à lista de busca padrão. Coberto em `tests/test-distribution-parity.cjs`.

- **Vazamento de timer de verificação de atualização no plugin (`goLiveBypass/index.tsx`)**:
  o timer de 8 segundos agendado em `start()` para checar novas versões não era salvo
  nem cancelado em `stop()`. O handle agora é retido em `updateCheckTimer` e cancelado
  explicitamente no desmonte do plugin. Coberto em `tests/test-distribution-parity.cjs`.

- **Resiliência do observador de RTC contra falhas transitórias do DOM (`standalone/golivebypass.js`)**:
  em `consultarRtcNativo(win)`, uma exceção durante descarregamento de página principal
  derrubava o `Promise.all` e abortava todo o probe de RTC nativo no mundo isolado.
  Adicionado tratamento com `.catch(() => null)` e guarda de `webContents.isDestroyed()`.
  Coberto em `tests/test-native-rtc-recovery.cjs`.

- **Precedência de versões SemVer beta para estável no instalador Linux (`installer/golivebypass-installer.sh`)**:
  a ordenação direta via `sort -V` considerava sufixos alfanuméricos (`1.1.12-beta.13`)
  superiores à versão estável (`1.1.12`), classificando a release estável final como
  downgrade. A função `compare_version` foi corrigida para separar o núcleo numérico dos
  sufixos de pré-release. Coberto em `tests/test-auto-update.sh`.

- **Precedência de versões SemVer beta para estável no instalador Windows (`installer/GoLiveBypass-Installer.ps1`)**:
  `Compare-Version` removia qualquer caractere após o hífen antes do cast para `[version]`,
  igualando versões beta à versão final estável e bloqueando o update. A função agora
  separa `$localCore` e `$localPre`, priorizando a release estável oficial. Coberto
  em `tests/test-auto-update.ps1`.

- **Eliminação de timeout de 6s em probes TLS fechados limpos (`readOverTls`)**:
  em `standalone/golivebypass.js` e `goLiveBypass/native.ts`, `readOverTls` não escutava
  o evento `close` do socket TLS, fazendo com que desconexões limpas do servidor sem
  erro TLS ficassem presas até o estouro total do timeout (`PROBE_TIMEOUT_MS`, 6s).
  Adicionado `tls.on("close", () => finish(body || null))` em ambas as distribuições.
  Coberto em `tests/test-distribution-parity.cjs`.

- **Guarda de falha de injeção no standalone Linux (`standalone/golivebypass-standalone.sh`)**:
  quando nenhum alvo era injetado com sucesso (`$injected -eq 0`), o script reabria o
  Discord vanilla antes de abortar com mensagem de erro. A verificação foi movida para
  antes de `start_discord`.

- **Extração de segredos da proxy pessoal (`redact.ts`, usado no report de
  bug) cortava a senha no primeiro `@` dela, em vez de tratá-la inteira**:
  a regex `extrairSegredosDaProxy()` usava uma classe que excluía `@` no
  trecho de credenciais (`[^/@]+@`), diferente do parser real da proxy em
  produção (`PROXY_RE`/`parseProxy()` em `standalone/golivebypass.js`), que
  usa `.+` guloso e por isso lida corretamente com uma senha contendo `@`
  não codificado (ex.: `socks5://user:p@ss@host:1080`). Com a regex antiga,
  o "segredo" extraído para a senha virava só o fragmento antes do primeiro
  `@` (`"p"` no exemplo) — descartado pelo filtro de tamanho mínimo (3
  chars) — e a senha real nunca entrava na lista L2 de redação literal do
  report de bug. Mitigado na prática porque `safeProxy()` já mascara a
  senha na origem dos logs (`bypass.log`/`gui.log` nunca a escrevem crua) e
  a URL inteira ainda entrava como segredo próprio (cobre o caso de a URL
  completa aparecer verbatim em algum lugar) — mas qualquer caminho que
  algum dia logasse a senha isolada (fora do formato de URL completa)
  vazaria para um report público no GitHub. Corrigido para espelhar
  `PROXY_RE`: credenciais capturadas de forma gulosa até o ÚLTIMO `@` antes
  do host (`(.+)@([^/@]+)$`), igual ao parser de produção.
  Teste: `golive-gui/tests/redact.test.ts`
  ("extrai a senha inteira mesmo com @ nao codificado dentro dela").
  Achado por revisão de código (sem reprodução ao vivo — o pipeline L1/L3
  do report de bug já bloqueava o cenário de vazamento direto no formato de
  log atual; a correção fecha a lacuna de defesa em profundidade, não uma
  exploração confirmada em produção).

- **`--uninstall` do script standalone Linux tinha o mesmo vazamento de Tor
  do bug do `deactivateAll()` (abaixo), por um caminho diferente**: achado
  puxando o fio deixado pela correção anterior — a GUI no Linux delega TODO
  o `deactivate`/uninstall para `standalone/golivebypass-standalone.sh
  --uninstall`, então aquele fix (que só mexeu em `main.ts`) não cobria
  Linux. No script, a chamada a `remove_tor` (para/desabilita o serviço
  systemd `golivebypass-tor.service`) só rodava dentro de `if [ "$failed"
  -eq 0 ]` — ou seja, só quando TODOS os Discords detectados (pode haver
  vários: estável, PTB, Vesktop...) foram revertidos com sucesso. Um único
  alvo falhando (elevação/polkit recusada, arquivo travado por um processo
  ainda vivo) deixava o serviço systemd do Tor rodando para sempre, sem
  nenhum alvo mais usando aquela saída — inconsistente com o bloco
  `restore` logo abaixo no mesmo arquivo, que já chama `remove_tor`
  incondicionalmente. `remove_tor` movida para fora do `if`, chamada
  sempre logo após o laço de reversão; o `if [ "$failed" -eq 0 ]` continua
  controlando só a reabertura do Discord/`exit 0` vs. `fail`. Coberto em
  `tests/test-distribution-parity.cjs`.
- **`deactivateAll()` deixava o Tor embutido órfão — vazamento de
  processo**: revisitando uma pergunta em aberto anotada durante a
  investigação do Bug 2 ("por que havia um Tor extra para matar
  deliberadamente"). `deactivateAll()` só chamava `torWatchdogParar()`
  (para o timer de vigia), nunca `stopTor()` (mata o processo `tor.exe`
  de verdade). O quit limpo (`before-quit`) já chamava `stopTor()`
  separadamente antes de `deactivateAll()`, por outro motivo documentado —
  mas o botão "Desativar Bypass" (`ipcMain.handle("deactivate", ...)`) e o
  toggle da bandeja do sistema chamam `deactivateAll()` direto, sem passar
  por `stopTor()` antes. Resultado: desativar o bypass pelo botão ou pela
  bandeja (sem fechar o app inteiro) deixava um `tor.exe` **órfão** rodando
  para sempre — ninguém mais usa aquela saída (o Discord acabou de ser
  desinjetado) e ninguém mais vigia se ela morre (o watchdog também parou
  junto). Tor continuava ligado depois da pessoa pedir explicitamente para
  desligar, consumindo recursos à toa. `stopTor()` agora roda no início de
  `deactivateAll()`, antes até do "nada a desfazer, sai" — o Tor pode estar
  de pé desde a abertura da GUI (o boot sobe o daemon cedo, independente de
  já ter ativado), mesmo quando não há injeção nenhuma para reverter, e o
  pedido de desligar vale de qualquer jeito. Chamada duplicada no caminho
  de quit limpo é inofensiva (`stopTor()` já é idempotente). Coberto em
  `golive-gui/tests/torwatchdog.test.ts`.
- **Plugin (renderer): `check()` de verificação de atualização não tratava
  rejeição, diferente da função irmã `update()`**: achado por uma revisão
  dedicada ao lado renderer do plugin (`goLiveBypass/index.tsx`).
  `Native.checkPluginUpdate()` em si nunca rejeita (o lado nativo já
  resolve sempre com `{ok:true|false,...}`), mas a chamada IPC por baixo
  pode rejeitar sozinha — plausível logo após um self-update do plugin, com
  o handler `ipcMain.handle` temporariamente desalinhado durante a
  recompilação. `update()`, a função irmã logo abaixo, já tratava isso
  corretamente com `catch`; `check()` não tinha, deixando uma promise
  rejeitada sem dono no console do renderer (inofensivo no renderer —
  diferente do processo principal, onde uma rejeição sem tratamento
  derruba o processo inteiro — mas inconsistente e sem feedback para a
  pessoa). `finally` já garantia que `busy` nunca ficasse preso, então
  severidade baixa. Adicionado `catch` espelhando o padrão de `update()`.
  Coberto em `tests/test-distribution-parity.cjs`.
- **GUI: diálogo de atualização usava `showMessageBoxSync`, que bloqueia o
  watchdog do Tor enquanto espera resposta**: achado ao investigar a lógica
  de auto-update (`golive-gui/electron/updater.ts`) durante a rodada de
  estabilidade. `dialog.showMessageBoxSync` bloqueia a thread JS do
  processo principal até a pessoa clicar um botão — inclusive o
  `setInterval` do watchdog do Tor (o mesmo mecanismo corrigido nesta
  rodada para o Bug 2), que fica sem checar o daemon durante todo o tempo
  que o aviso de atualização ficar aberto sem resposta (a pessoa pode ficar
  minutos, ou nunca voltar, sem clicar). Se o Tor morrer nessa janela, a
  recuperação automática fica pausada até o diálogo ser respondido. O resto
  do código já usava a versão assíncrona (`main.ts`, com `await`); só
  `updater.ts` (4 ocorrências, Linux e Windows) ficou para trás com a
  síncrona. Trocado para `await dialog.showMessageBox(...)` nos quatro
  pontos — mesmo comportamento visível, sem bloquear o processo principal.
  Coberto em `golive-gui/tests/updater-channel.test.ts`. Não reproduzido ao
  vivo (exigiria forçar uma atualização disponível e deixar o diálogo
  aberto enquanto se mata o Tor) — achado e corrigido por leitura de
  código, `tsc --noEmit` e `npm run compile` limpos.
- **Plugin Vencord/Equicord: `shutdown()` não zerava os mutexes de busca de
  saída (`choosing`/`hunting`)**: achado por uma revisão profunda dedicada
  ao plugin (`goLiveBypass/native.ts`). `choosing`/`hunting` guardam uma
  PROMESSA ("já tem uma busca em voo?"), não um booleano —
  `chooseExit()`/`sharedFreeExit()` só começam uma busca nova quando o
  campo está `null`. Um toggle rápido desligar→ligar no switch do plugin
  (ação normal da UI do Vencord, sem debounce) podia fazer a reativação
  reaproveitar CALADA uma busca de saída ainda em andamento de antes do
  desligamento — a sessão nova ficava dependendo do tempo de conclusão de
  uma busca que não reflete mais a configuração/intenção atual, em vez de
  começar do zero (ex.: Tor local, que resolveria em milissegundos).
  `shutdown()` agora zera os dois campos; a busca órfã ainda termina
  sozinha em segundo plano (suas próprias promessas já se resolvem sem
  quebrar nada), só não é mais reaproveitada por engano. Coberto em
  `tests/test-distribution-parity.cjs`. Não reproduzido ao vivo (fora do
  escopo desta tarefa, sem VM disponível) — achado e corrigido por leitura
  de código, verificado com checagem de sintaxe/transpile TypeScript.
- **Instalador (`installer/GoLiveBypass-Installer.ps1`) e standalone
  (`standalone/GoLiveBypass-Standalone.ps1`) não fecham mais a janela antes
  da pessoa ler o erro**: relato — no Windows 10 sem `winget`, o instalador
  falha e a janela "fecha sozinha", parecendo silencioso. Causa raiz: "Executar
  com o PowerShell" no menu de contexto do Explorer (ou duplo clique num
  `.ps1` associado a essa ação) faz o Windows abrir `powershell.exe -File
  script.ps1` **sem** `-NoExit` — a janela fecha sozinha ao sair do script,
  erro ou não. O `.bat` companheiro já tem `pause` para isso, mas quem baixa
  e roda só o `.ps1` (o link do README salva só esse arquivo) não passa por
  ele. Agora os dois `.ps1` detectam se o processo pai é o `explorer.exe`
  (`Test-JanelaTransitoria`) e, se for (e não estiver em modo `-Yes`,
  automação), pausam com "Pressione Enter para fechar esta janela" antes de
  sair — tanto no caminho de erro quanto no de sucesso. Sem afetar o uso
  normal via terminal (onde o pai não é o Explorer) nem a automação (`-Yes`
  pula a checagem antes mesmo de consultar o processo pai). Coberto em
  `tests/test-error-handling.ps1`.
- **`refreshExit()` (busca de saída em segundo plano, disparada na 2ª
  reconexão da rajada do gateway) podia sobrescrever `chosenExit` calado**:
  achado por uma revisão de código dedicada ao fluxo de reservas/troca de
  saída em modo gratuitas/auto. `refreshExit()` roda sem `await` no
  chamador e pode resolver DEPOIS de uma troca síncrona já ter acontecido
  no meio do caminho — a 3ª reconexão da mesma rajada dispara uma troca
  síncrona via `trocarPara()` (loga `saida.trocada`, limpa
  `missedBeats`/`rttLentoSeguidas` da saída nova, zera a janela de rajada).
  Quando a busca em segundo plano resolvia depois disso, ela chamava
  `settleExit()` sozinho — sem nenhum log estruturado dizendo o que foi
  substituído (só "saída nova encontrada: X", sem a saída anterior) e sem
  limpar os contadores de falha da saída nova, que podiam carregar
  contagem de uma ativação anterior dela. Não trava nem derruba nada
  ativamente (uma saída viva sempre acaba escolhida), mas corrompe
  silenciosamente o log — exatamente a fonte de evidência que este projeto
  depende para diagnosticar "carregamento infinito" depois do fato. Agora
  `refreshExit()` também loga no formato estruturado (`de=`/`para=`/`motivo=`)
  e limpa os contadores da saída nova quando de fato troca uma saída ativa
  por outra; confirmar a MESMA saída que já estava ativa continua sem gerar
  log de troca falso. Coberto em `tests/test-tor-oscillation-test.cjs`.
- **Classificação de socket RTC (issue #186) podia ser rebaixada de `'stream'`
  de volta para `'voice'` por uma mensagem chegando depois do IDENTIFY**:
  achado por uma revisão de código dedicada à lógica de pareamento RTC. O
  `IDENTIFY` (enviado pelo cliente) é a única prova forte — array de
  `streams` para `'stream'`, `server_id`+`channel_id` para `'voice'`. Mas o
  handler de `message` (mensagens do servidor, recebidas repetidas vezes
  durante a vida do socket) escrevia o mesmo campo sem nenhuma trava: um
  `op 5` chegando depois do IDENTIFY sobrescrevia `kind='stream'` de volta
  para `'voice'`, mesmo já provado. `socketMidiaDaStream()` exclui todo
  socket `'voice'` do close direcionado, então o socket certo da stream
  ficava permanentemente inelegível para a recuperação RTC, sem nunca ser
  reavaliado — o mesmo tipo de dano silencioso que a própria #186 já havia
  corrigido uma vez. Agora o handler de mensagem só classifica enquanto
  `kind` ainda está vazio (sem prova do IDENTIFY); uma vez que o IDENTIFY
  estabelece `'stream'` ou `'voice'`, nenhum sinal mais fraco e recorrente
  pode desfazer essa prova. Aplicado nos dois shims (frame e worker).
  Coberto em `tests/test-native-rtc-recovery.cjs` e
  `tests/test-worker-shim.cjs`.
- **`reloadPorRevive()` (escada de revive do gateway zumbi, nível 2) travava
  o mutex de reload só de leitura, nunca de escrita**: achado por uma
  revisão de código dedicada à lógica de recuperação RTC/gateway.
  `maybeReloadAfterDirect()` e `maybeReloadAfterColdHold()` escrevem
  `reloading = true` antes de chamar `win.webContents.reload()` e só
  liberam depois; `reloadPorRevive()` (nível 2 da escada de zumbi) conferia
  `if (reloading) return;` mas nunca setava a flag — as outras duas funções
  sempre viam `reloading === false` e podiam disparar um SEGUNDO
  `reload()` na mesma janela enquanto o reload do revive ainda estava
  navegando. Alcançável de verdade numa sessão com Tor caindo e gateway
  zumbi ao mesmo tempo (a mesma rede ruim motiva os dois gatilhos), não só
  em teoria. Agora `reloadPorRevive()` também trava `reloading = true`
  antes do reload, e `watchReloads()` libera o mutex assim que a navegação
  de verdade começa (`did-start-loading`) — o mesmo sinal que já limpa o
  resto do estado de revive/zumbi. Coberto em
  `tests/test-gateway-zumbi-revive.cjs`.
- **Aviso de arranque frio do Tor escala depois de 3 min parado, em vez de prometer "menos de
  um minuto" para sempre**: reproduzido ao vivo no laboratório (VM viewer, modo tor) — a GUI
  (dona do processo Tor e do watchdog que o ressuscita) havia saído em algum momento anterior
  sem deixar rastro de erro, mas o Discord já injetado continuou de pé, reabrindo sozinho e
  ficando preso em "Problemas de conexão?" com o banner "GoLiveBypass: aguardando o Tor... isso
  costuma levar menos de um minuto" imutável. `bypass.log` confirmou o runtime tentando e
  recusando a conexão do gateway a cada nova tentativa do próprio cliente
  (`modo tor: nenhuma saida entregou gateway.discord.gg, recusando esta conexao`) por mais de 5
  minutos seguidos; `gui.log` mostrava o Tor tendo bootstrapado com sucesso muito antes
  (`Bootstrapped 100% (done)`, `tunel confirmado ate o gateway`) e depois simplesmente parando
  de escrever — o processo da GUI não estava mais rodando (confirmado no Gerenciador de
  Tarefas: nenhum `tor.exe`, nenhum app GoLiveBypass). O runtime injetado nunca tem como subir
  Tor sozinho (só detecta), então sem aviso a pessoa fica lendo uma promessa falsa
  indefinidamente — exatamente o padrão de "carregamento infinito" que o projeto já combate em
  outras issues, só que originado da própria dependência externa em vez de rede. Agora, se o
  modo tor continuar sem saída passados `TOR_BOOT_STALL_MS` (3 min, checado a cada batimento de
  30 s que já tentava `detectTor()` de novo), o mesmo banner troca de texto e ícone
  (⏳ → ⚠️, borda âmbar) para explicar a causa provável e a ação real: reabrir o aplicativo
  GoLiveBypass, já que reiniciar só o Discord não liga o Tor. Escala uma única vez por arranque
  frio e reseta se uma saída real aparecer depois, permitindo escalar de novo num arranque frio
  seguinte. Sem retry indiscriminado nem enfraquecimento do fail-closed do modo tor (a conexão
  continua sendo recusada, nunca cai para IP direto). Coberto em
  `tests/test-cold-tor-boot-test.cjs`. Não se aplica ao plugin Vencord/Equicord: ele não sobe
  nem gerencia um processo Tor próprio (Tor é um proxy manual digitado pelo usuário, tratado
  como estrito) e já usa toasts com número de tentativa em vez de um banner silencioso de
  arranque frio — lacuna documentada aqui por não haver equivalente a portar.
- **Watchdog do Tor não rearmava sozinho ao reabrir a GUI sem o marcador de
  sessão** (mais grave que o item acima — é a causa de por que o Tor morto do
  cenário anterior nunca se recupera sozinho): reproduzido ao vivo — matei o
  `tor.exe` da VM com uma Live saudável em andamento e o watchdog (função pura
  já testada e correta em `torwatchdog.ts`) simplesmente nunca reagiu por 7+
  minutos. Causa raiz em `golive-gui/electron/main.ts`: o boot só chamava
  `torWatchdogIniciar()` quando `sessaoAtiva()` (um marcador efêmero em disco,
  `session.json`, escrito em `activateAll()` e apagado em `deactivateAll()`)
  era verdadeiro. Neste boot específico o marcador estava ausente mas a
  injeção estava genuinamente ativa (`getStatus() === "ACTIVE"`, confirmado
  por `Get-Process` mostrando os processos `GoLiveBypass`/`tor` de pé) — o
  watchdog nunca era armado, e uma morte real do Tor no meio da sessão ficava
  sem qualquer vigia pelo resto da vida do processo da GUI. Agora o boot arma
  o watchdog com `sessaoAtiva() || getStatus() === "ACTIVE"`, usando a mesma
  fonte de verdade (leitura de disco) que já decide se o botão da UI mostra
  "Ativo". Coberto em `golive-gui/tests/torwatchdog.test.ts`. Detalhes e
  passo a passo da reprodução em
  `docs/handoff-2026-09-02-tor-watchdog-gap.md`.
- **Guarda de ativação duplicada (issue #145) volta a valer logo após reabrir
  a GUI**: achado varrendo o código atrás do mesmo padrão do bug do watchdog
  acima. `assinaturaUltimaAtivacao` é um `let` de módulo que nasce vazio a
  cada boot, mesmo quando o bypass já está injetado de verdade
  (`getStatus() === "ACTIVE"`). Sem re-semear essa assinatura no boot, a
  primeira `activateBypass()` pós-reinício com a mesma proxy/modo nunca batia
  com `""`, e a guarda pensada para a #145 (duas ativações em segundos
  derrubando o gateway recém-nascido) ficava cega logo após qualquer
  reinício da GUI — uma reativação idêntica reinjetaria por cima de um
  bypass já correto, derrubando gateway/RTC à toa. Agora o boot reconstrói a
  assinatura a partir do proxy salvo em disco quando encontra a injeção já
  ativa. Coberto em `golive-gui/tests/ativacao-guard.test.ts`.
- **Revisão adversarial do fix do watchdog acima encontrou uma corrida nova
  que ele tornava alcançável**: armar o watchdog em mais situações é correto,
  mas abre uma janela em que o boot falha em subir o Tor (rede ruim), cai
  para a insistência de fundo (`tentarTorEmFundo`) — que roda `garantirTor()`
  FORA do singleton de promessa, porque começa depois dele já ter resolvido
  — e agora o watchdog, também armado, vê a porta fechada e chama
  `garantirTor()` por conta própria 5s depois. Duas chamadas de `spawnTor()`
  concorrentes checam a porta livre ao mesmo tempo e podem subir dois
  `tor.exe` (o "Address already in use" da issue #51, por um caminho novo).
  `torWatchdogRecuperar()` agora sai cedo quando `tentarTorEmFundo` já está
  tentando, antes de chamar `garantirTor()` — a insistência de fundo já
  cobre a recuperação; o watchdog só precisa esperar o próximo tick.
  Coberto em `golive-gui/tests/torwatchdog.test.ts`.
- **Primeira entrada de Live sem vídeo não espera mais 60 s** ([#181](https://github.com/bezumiya/GoLiveBypass/issues/181),
  [#183](https://github.com/bezumiya/GoLiveBypass/issues/183)): o viewer já
  tinha um caminho de 1 s apenas depois de uma Live saudável; um renderer
  recém-aberto ainda podia exibir Error 2012 por até 60 s antes da primeira
  tentativa. Agora, com demanda positiva, amostra inbound atual e socket de
  mídia pareado de forma não ambígua, um segundo sem quadro basta: o poll de 5 s
  fecha somente o RTC daquela stream em até ~6 s. Voz, gateway e renderer ficam
  intactos; falta de qualquer uma dessas provas continua sem ação. O plugin não
  tem observador RTC automático equivalente, lacuna já documentada e não
  aplicável à sua arquitetura.
- **Recuperação do viewer continua armada após `RTCControlSocket.reconnect`**
  ([#186](https://github.com/bezumiya/GoLiveBypass/issues/186)): o Discord pode
  reaproveitar a conexão nativa `discord_voice` de uma Live por minutos ou
  horas, mas recriar o WebSocket `*.discord.media`. O pareamento antigo por
  idade então ultrapassava 15 s e devolvia `socket=?`, desarmando para sempre o
  único close RTC seguro. O shim agora classifica cada socket pelo protocolo:
  `IDENTIFY` com vídeo/streams e mensagens de mídia confirmam `stream`; voz
  explícita é excluída. Entre streams confirmadas, escolhe somente a mais nova;
  a proximidade temporal permanece apenas como fallback fail-closed para mocks
  sem tráfego. A call principal continua fora de qualquer close. A GUI recebe a
  fonte sincronizada e os testes cobrem reconexão longa, eleição da stream mais
  nova e imunidade da voz; o plugin não possui esse observador nativo e a lacuna
  permanece explicitamente fora do escopo da sua arquitetura.
- **Classificação protocolar do RTC mais conservadora — `video:true` sozinho
  nunca é prova de Go Live** ([#186](https://github.com/bezumiya/GoLiveBypass/issues/186)):
  a marcação `stream` por `IDENTIFY` passou a exigir o array `streams` não
  vazio; um socket com `video:true` e apenas `server_id`/`channel_id` é
  classificado como `voice` e fica excluído de qualquer close direcionado (era
  o caminho pelo qual uma câmera ligada depois da stream poderia roubar o
  pareamento e derrubar a própria chamada). Sem servidor/canal e sem streams, a
  classificação fica desconhecida e o pareamento temporal estrito — fail-closed
  — assume. Medido no Discord atual, os dois sockets de mídia chegam com
  `streams` no `IDENTIFY`; a distinção por `kind` é defesa em profundidade, e a
  eleição mais-recente/idade continua sendo o pareamento real. Coberto em
  `tests/test-native-rtc-recovery.cjs` e `tests/test-worker-shim.cjs` (câmera
  vira `voice`, streams vira `stream`, sem prova fica sem `kind`, voz mais nova
  não rouba o close).
- **Contexto do voice shim comprovado no laboratório — o diagnóstico anterior
  lia o mundo errado, não o runtime** ([#186](https://github.com/bezumiya/GoLiveBypass/issues/186)):
  `executeJavaScriptInIsolatedWorld(999)` alcança sim o mesmo contexto isolado
  do preload (`Electron Isolated Context`); a telemetria do processo principal
  (`voice.probe` com `stream`/`socket`/`fonte`) bate exatamente com esse
  contexto. O que enganava era o `gateway-summary` do lab, que avaliava no
  mundo da página — onde a cópia do shim de voz convive com estado vazio
  (`connections: []`). O lab ganhou `linux voice-isolated-summary`, que lê o
  contexto isolado (o que o main consulta) e imprime os dois lados lado a lado.
  Nenhuma mudança de runtime foi necessária para "resolver" o contexto; a
  correção foi no diagnóstico. O plugin não é afetado (não usa o hook
  `discord_voice`).
- **`rtt`/`feedback_ha` no `voice.probe`: distingue "meu encoder está bem" de
  "meu pacote está chegando de verdade"**: bateria de fault injection (queda de
  rede real via `virsh domif-setlink`, firewall/iptables bloqueando só UDP de
  saída) mostrou que `fps_out`/`framesEncoded` continuam subindo normalmente no
  sender mesmo quando o pacote é descartado pelo firewall/NAT antes de sair da
  máquina — são contagem puramente local, o SO não sabe que o pacote não
  chegou. `getFilteredStats` passou de bitmask `6` (outbound+inbound) para `7`
  (+transport), expondo `rtt` e `receiverReports` do addon nativo, que só
  avançam com confirmação real de entrega vinda do outro lado. Um novo
  `feedback_ha` (idade desde a última mudança real de `rtt`/`receiverReports`,
  independente de `packetsSent`/`packetsReceived` — esses dois continuavam
  subindo sozinhos mesmo com a saída bloqueada e mascaravam o sinal numa
  primeira tentativa) fica congelado enquanto o encoder finge normalidade;
  provado ao vivo, subiu 0s → 25s → 60s com `frames` passando de 471 para 1364
  durante um bloqueio real de UDP, e voltou a 0s assim que a rede foi liberada.
  Não guarda `localAddress` nem o id do `receiverReport` — só `rtt` (número) e
  a idade em segundos. Testado nos dois papéis (sender/viewer) com stats
  brutas reais e cobertura nova em `tests/test-native-rtc-recovery.cjs`
  (rtt/idade aparecem, idade cresce parado, zera com feedback novo, nenhum dos
  dois identificadores vaza no resumo).
- **Observador direto do gateway pelo CDP `Network`** (beta 13, fix
  [#169](https://github.com/bezumiya/GoLiveBypass/issues/169)): a hipótese de que
  o websocket do gateway vivia em um dos Dedicated Workers visíveis foi
  refutada no laboratório — eles eram workers de blurhash/busca. O processo
  principal agora habilita `Network` junto de `Target.setAutoAttach`, antes do
  primeiro documento, e observa `webSocketCreated`, frames e fechamento do
  socket real do Chromium. Assim o probe nasce `origem=network` já no cold boot,
  sem wrapper de `Worker`, XHR síncrono, Blob substituto, BroadcastChannel ou
  ponte pelo renderer. Estado e ações são isolados por `webContents`, sessão CDP,
  target e geração; dois gateways abertos ou geração divergente falham fechado.
  O protocolo CDP desta versão do Chromium não oferece `Network.closeWebSocket`,
  portanto a origem `network` é deliberadamente somente observável; quando um
  shim de frame passa a enxergar uma reconexão, a origem acionável mais precisa
  vence.
- **Sniff ETF compatível com o Discord atual**: captura sanitizada ao vivo
  mostrou que os frames são `ETF MAP_EXT` (`#{<<"op">> => inteiro, ...}`), não a
  tupla presumida nas betas anteriores. Os parsers do frame, worker e CDP agora
  aceitam estritamente a chave inicial `op` e reconhecem `4`, `18`–`22` e `37`.
  Em especial, `18` registra criação da Live e `20` registra o pedido real do
  viewer para assistir. Formato, chave ou inteiro fora da whitelist devolvem
  `-1`; payload, URL autenticada e token nunca saem do processo.
- **Stress real do Tor sem punir a saída única**: após três reconexões em 180 s,
  `routeMode=tor` agora registra `gw.rajada_tor` apenas como diagnóstico. Não faz
  refresh proativo, não troca e não coloca `127.0.0.1:9060` em quarentena. O
  watchdog e `detectTor` continuam responsáveis pela morte real do daemon, e a
  política “só Tor, nunca direta” permanece intacta.
- **Paridade de estabilidade no plugin Vencord/Equicord** (beta 13): um Tor
  local escrito explicitamente no campo Proxy agora é uma escolha estrita. Se
  o daemon/circuito cair, o gateway falha fechado e o heartbeat tenta o mesmo
  Tor novamente; o plugin não usa o pote, proxy gratuita ou `DIRECT`. Proxy
  manual comum também deixou de trocar por um único probe ruidoso e só cede à
  reserva após dois batimentos perdidos. No renderer, uma UI que afirma Live
  por 30s sem nenhuma chave nativa em `StreamRTCConnectionStore` é registrada
  e avisada como possível erro 2001; store desconhecida falha fechado e não há
  reload/close automático. As decisões vivem em `stability.ts`, cobertas por
  matriz pura, teste de paridade das distribuições, ZIP E2E e compilação real
  no Equicord. Manifesto e instaladores Linux/Windows agora distribuem os quatro
  arquivos do plugin.
- **Provas ao vivo da beta 13**: cold restart isolado do sender, isolado do viewer
  e simultâneo passaram com Linux codificando a 60 fps e a VM apenas
  decodificando a 60 fps. A bateria normal passou 9 ciclos úteis. No fault
  injection, o `tor.exe` foi morto repetidamente durante a Live: zero saída
  direta, o gateway voltou depois do bootstrap, um único clique de assistir
  recriou o RTC e a ROI voltou viva. O teste também documentou o limite do
  cliente: indisponibilidade total do gateway encerra a visualização atual; o
  Discord recupera a chamada/tile, mas não reassiste a Live automaticamente.
- **Guarda de rota durante mídia**: uma ocorrência real no viewer Linux mostrou
  que a troca gratuita proativa por RTT, embora o gateway ainda estivesse vivo,
  precedeu o fechamento 4014 do RTC e uma renegociação DAVE sem frames de vídeo.
  RTT/rajada agora não trocam nem colocam a saída em quarentena durante os 20
  minutos de mídia recente; a troca por morte confirmada continua disponível.
  O plugin não possui esses caminhos proativos, portanto não há equivalente a
  portar. O replayer offline `tests/test-viewer-dave-race.cjs` reproduz o burst
  pre-DAVE/MLS com áudio/UDP vivo e confirmou 5.000/5.000 variações sem close
  repetido, queda da voz ou reload automático.
- **Reentrada do viewer após parar/voltar a assistir** ([#170](https://github.com/bezumiya/GoLiveBypass/issues/170),
  [#171](https://github.com/bezumiya/GoLiveBypass/issues/171)): os dois relatos
  apontaram o mesmo gatilho — a Live ficava saudável, o viewer parava de
  assistir e, ao voltar, o probe de uma saída gratuita podia perder um único
  batimento. `checkPool` agora aplica à saída ativa o mesmo limiar de dois
  batimentos consecutivos usado para retirar reservas: um miss isolado é
  mantido e só a morte confirmada pode fazer a troca emergencial. O porte foi
  feito também no plugin, em `stability.ts` + `native.ts`, com a arquitetura
  própria dele. O laboratório `tests/live-rtc-issue-170-e2e.mjs` executa
  literalmente `viewer close` → espera → `viewer watch`, comprova pixels móveis
  na VM e FPS do sender/viewer quando a implementação oferece essa telemetria,
  e falha se houver troca proativa, DIRECT, revive ou reload durante a reentrada.
  A lacuna independente de auto-recuperação de gateway/RTC do plugin continua
  documentada abaixo.
- **Recuperação direcional do RTC da transmissão** (próxima beta,
  [#164](https://github.com/bezumiya/GoLiveBypass/issues/164)): a reprodução ao
  vivo no Linux delimitou a falha que o probe da beta 10 não enxergava. O
  Discord desktop mantém a Live no addon nativo `discord_voice`, não em
  `window.RTCPeerConnection`. Durante o loading infinito, a captura do sender
  seguia em ~60 fps, mas `framesEncoded=0` e `targetMediaBitrate=0`. O stress de
  01/09 mostrou que esse target também pode ficar zerado com um viewer real
  esperando: ele é diagnóstico do Discord, não prova de ausência de receiver.
  - os ensaios descartaram duas curas inseguras. `destroy(stream)`/fechar toda a
    mídia derrubou também a voz e perdeu a fonte; `clearDesktopSource()` + replay
    transformou uma stream capturando em `stats=sem-video`. As duas rotas foram
    removidas, assim como a API interna de replay;
  - o preload envolve os factories de `discord_voice`, usa
    `getFilteredStats(6, callback)` (inbound + outbound) e classifica o papel da
    stream pelo uso real de `setDesktopSource*`: sender se configurou a fonte,
    viewer caso contrário. Ele guarda somente o marcador da chamada, nunca
    sourceId, callbacks, endpoints, tokens ou stats brutos;
  - no **sender**, sem demanda remota positiva o encoder zerado continua sendo
    ociosidade normal e nunca provoca ação. Com demanda positiva, captura viva
    e encoder parado por ≥20s confirmam o travamento mesmo que
    `targetMediaBitrate=0`. No **viewer**, demanda positiva + vídeo inbound
    ausente/parado por ≥60s é a assinatura que dispara a recuperação. O viewer
    conserva por até 120s a intenção positiva anterior quando a tela de erro
    zera `pixelCount`; a diferença de 40s deixa o sender agir e concluir sua
    observação antes da outra ponta;
  - cada websocket `*.discord.media` recebe um id local sanitizado. A conexão
    nativa da stream é pareada ao socket que nasceu no mesmo intervalo (≤15s),
    distinguindo-o do socket mais antigo da call; empate, dado incompleto ou
    pareamento distante falham fechado;
  - a única tentativa automática envia `close(4000)` **somente ao socket RTC
    pareado da stream**; o socket da voz principal, o gateway e a janela
    continuam intactos. O teste de fogo `blocked_start` provou que repetir
    `close(4000)` no socket substituto recria o websocket, mas conserva a mesma
    stream nativa congelada em `fps_out=0`; `close(4006)` cria outra stream,
    porém perde fonte/demanda e também não cura. A segunda tentativa foi
    removida. Se o vídeo não progride por 30s após o close seguro, o bypass
    mostra o aviso manual: recarregar o renderer é a única cura confirmada para
    esse estado fechado do Discord. Não há reload automático, destruição de
    voice/stream, close-all de mídia nem replay/clear da fonte;
  - sucesso exige progressão inbound/outbound recente e sustentada por 10s. Se a
    demanda cair durante a renegociação, a escada pausa e encerra sem escalar
    após 60s. Telemetria `voice.probe` agora inclui papel, socket pareado, vídeo
    inbound e target bitrate. O standalone é a fonte e a GUI recebe o mesmo
    código via `sync-bypass`; testes cobrem privacidade, filtro 6, classificação
    direcional, target zero com/sem demanda, pareamento ambíguo e preservação da
    call.
- **Injeção à prova de corrida: o shim vira preload de sessão** (beta 10,
  [#163](https://github.com/bezumiya/GoLiveBypass/issues/163)): a #163 pegou uma
  sessão inteira **cega** — o CDP não anexou, o fallback do `did-finish-load`
  reinjetou DEPOIS do gateway já ter conectado, e o gateway não reconectou mais
  (25+ min de túnel saudável): 17 minutos de probes `estado=nenhum`. Como nós
  controlamos o app.asar injetado, o shim agora é gravado em
  `golive-shim.js` e registrado como **preload de sessão**
  (`registerPreloadScript`, com fallback para `setPreloads`) — preload roda
  antes de qualquer script da página, em toda janela/frame, sem CDP e sem
  corrida. CDP e fallback ficam como reforço (tudo self-guardado: injeção dupla
  é inofensiva).
- **Instrumentação RTC + gatilho "áudio vivo, vídeo parado"**
  (beta 10): o nyxxy revelou o sintoma decisivo — **o áudio da transmissão
  toca, mas o vídeo nunca sai**. Áudio de Go Live vai por RTC/UDP (não pelo
  gateway): a conexão de voz ESTÁ de pé — o que trava é a ativação do vídeo.
  - O shim agora envolve o `RTCPeerConnection`: `__goliveRtcResumo()` agrega
    `getStats()` por PC — bytes inbound de **áudio vs vídeo**, se existe track
    de vídeo esperada e se o usuário é quem transmite.
  - Linha nova no vigia: `rtc.probe | pcs=.. audio_ha=.. video_ha=.. track=..
    enviando=..` — junto do `gw.probe`, o log conta sinalização + mídia.
  - **Gatilho** (`avaliarRtcVideo`, função pura): mídia aberta há ≥ 20s +
    **áudio vivo** (< 60s) + **track de vídeo esperada** (call só de voz nunca
    dispara) + **vídeo parado** (nunca chegou byte ou ≥ 120s) + **não é quem
    transmite** = video-travado.
  - A cura inicial da beta 10 fechava todos os ws `*.discord.media`. O ensaio da
    #164 mostrou que isso também alcança a call principal e não restaura a
    assinatura perdida; `__goliveMidiaFechar()` foi removida. A implementação
    final usa o close direcionado descrito acima e conserva a instrumentação
    `RTCPeerConnection` apenas como diagnóstico complementar.
- **Gatilho de stream travada: sniff do op 4 + fluxo de mídia** (beta 9,
  retorno da beta 8 nas issues [#159](https://github.com/bezumiya/GoLiveBypass/issues/159),
  [#160](https://github.com/bezumiya/GoLiveBypass/issues/160) e
  [#161](https://github.com/bezumiya/GoLiveBypass/issues/161)): a beta 8
  instrumentou o caso real e os logs contaram a história inteira — o shim
  anexou (o fallback da #154 disparou), o burst de atividade funcionou, e o
  `resp_bytes` revelou que **o gateway segue entregando MUITOS dados** (2,6 mil
  a 77 mil bytes por janela) mesmo com a stream travada no carregamento. O
  zumbi da nova geração não é o servidor calado: é o servidor que **empurra
  dados ambiente mas não PROCESSA pedidos novos** — o op 4 (VOICE_STATE_UPDATE,
  o "quero assistir") sai e o dispatch que abriria a conexão de voz
  (`*.discord.media`) nunca vem; a view gira eternamente e só o Ctrl+R cura.
  O gatilho novo é de precisão cirúrgica e independe de decodificar o payload:
  - **Sniff do op no frame binário (etf)**: `131` + tupla + inteiro na cabeça do
    termo — o op 4 é extraído em ~10 linhas defensivas (formato estranho devolve
    -1 e nunca vira falso op 4). No mundo JSON o op 4 já era lido.
  - **Assinatura**: op 4 enviado há 20-90s + **nenhum ws de mídia abriu desde o
    pedido** + sem mídia aberta agora = o fluxo de voz nunca começou → a escada
    dispara (close 4000 → o cliente renasce com RESUME e a stream abre sem
    Ctrl+R; persistindo, reload).
  - **Guarda de SAÍDA**: ws de mídia fechado há menos de 15s + op 4 = usuário
    SAINDO de voz/stream — nesses casos nenhuma mídia nova abre, então não
    dispara. E com mídia aberta (em call), a regra §6 segue bloqueando tudo.
  - `gw.probe` novo: `op4_ha`, `midia_open_ha`, `midia_close_ha` — o próximo
    relato prova sozinho se o sniff pegou o op no binário.
- **Shim v3: reviver do zumbi que funciona de verdade no Discord atual** (beta 8,
  retorno da beta 6 nas issues [#154](https://github.com/bezumiya/GoLiveBypass/issues/154),
  [#156](https://github.com/bezumiya/GoLiveBypass/issues/156) e
  [#158](https://github.com/bezumiya/GoLiveBypass/issues/158)): a beta 6 provou
  com logs que a cura automática do carregamento infinito era **no-op na
  produção** — `revives=0` para sempre. O cliente atual do Discord manda frames
  **binários** (etf): `JSON.parse` falhava em todo send (histograma vazio,
  `ops={}` com `cli_ha=1s`), o intent nunca era registrado, e o inflador zlib
  morria na primeira adversidade (`"sem decompress"` em toda a sessão da #156) —
  sem decode de cliente E de servidor, nenhuma assinatura de zumbi disparava. O
  shim v3 não depende mais de decodificar o payload:
  - **Atividade por burst** (agnóstico de encoding): 3+ envios em 30s = usuário
    pedindo algo — heartbeat vem a cada ~41s, então 2 heartbeats + presença solta
    nunca fecham o burst; funciona com JSON ou binário.
  - **Inflador que resincroniza** em vez de morrer: até 3 resyncs por geração
    (cobre dessincronia de fluxo contínuo E payload por stream), texto direto
    (`encoding=json`) é processado sem inflate, e lixo não acumula eterno.
  - **Detecção por volume**: servidor saudável responde ao pedido com centenas de
    bytes; o zumbi devolve só o baseline de heartbeat — sinal que independe de
    saber o encoding (`dispatch starve` continua valendo no mundo JSON).
- **Probe que nunca mais silencia** (beta 8, [#154](https://github.com/bezumiya/GoLiveBypass/issues/154)):
  a sessão inteira da #154 passou sem NENHUMA linha de probe — o shim do CDP não
  anexou numa das janelas e o resumo ausente era engolido. Agora: o vigia polla
  TODAS as janelas do cliente (escolhe a que tem gateway), loga
  `estado=sem-shim` quando ninguém responde, e o `did-finish-load` reinjeta o
  shim (self-guardado) quando o CDP não anexou.
- **Instalador standalone sobrevive a caminhos 8.3** (beta 8,
  [#155](https://github.com/bezumiya/GoLiveBypass/issues/155)):
  `Remove-Item -LiteralPath` explode com `PSArgumentException` ("Não existe um
  objeto no caminho especificado C:\Users\JOO~1...") em usuário com nome curto
  8.3 no perfil — o provider normaliza o caminho mesmo com `-LiteralPath`, e
  `-ErrorAction SilentlyContinue` não segura essa. As limpezas de arquivo/temp
  (download do Tor, zips de update) agora vão por `Remove-CaminhoSilencioso`
  (.NET direto, sem provider).
- **Canal beta: opt-in de testes na GUI + auto-update que distingue stable/beta**
  (beta 7): betas agora podem ser publicadas no GitHub como **prerelease** — e a
  garantia da regra §9 fica **estrutural**: `/releases/latest` nunca devolve
  prerelease, então o usuário do canal estável nem fica sabendo que a beta existe
  (o acidente da beta.3, que virou "latest" e disparou update em massa, ficou
  impossível de repetir). Quem quiser testar liga **"Participar dos testes (canal
  beta)"** nas configurações (settings `updateChannel`, default `stable`):
  - **Windows** (updater próprio): a checagem de 4h passa a varrer
    `/releases?per_page=20` e escolher a candidata de **maior versão** com exe
    anexado (estáveis + prereleases) via `updater-channel.ts` — semver de verdade
    com regra de prerelease, leitura VIVA do canal a cada checagem (toggle vale
    sem reiniciar), e o diálogo marca "(beta)". A comparação antiga por string
    (`latest !== current`) morreu junto: ela ofereceria **downgrade** de
    `1.1.12-beta.7` para `1.1.12` a quem ficasse no canal estável.
  - **Linux** (AppImage/electron-updater): canal beta nativo —
    `autoUpdater.allowPrerelease` lê o `beta.yml` que o electron-builder publica
    sozinho para versão com prerelease. Lido no boot (o electron-updater checa
    uma vez por sessão; o toggle vale no próximo reinício).
  - **macOS**: fora (updater desabilitado por falta de assinatura; o toggle nem
    aparece lá).
  - **Publicação:** tag (ex.: `v1.1.12-beta.7`) + `workflow_dispatch` do
    `build-gui.yml` com `canal=beta` — jobs de windows/linux publicam com
    `-c.publish.releaseType=prerelease` (linux gera o `beta.yml` sozinho), mac e
    assets do plugin/CLI pulam (um `goLiveBypass-vencord.zip` beta numa
    prerelease poderia ser pego pelo updater do plugin), e o job `beta-marcar`
    reforça `gh release edit --prerelease` e escreve a linha "**Canal: beta**" na
    nota. Desligar o toggle devolve ao estável na próxima release, sem downgrade
    (`1.1.12` stable > `1.1.12-beta.7` pelo semver). Testes:
    `tests/updater-channel.test.ts` (semver, escolha por canal, sem downgrade e
    wiring do updater/workflow).
- **Revive automático do gateway zumbi: detecção de dispatch starve + close 4000**
  ([#153](https://github.com/bezumiya/GoLiveBypass/issues/153), beta 6): o log da
  #153 trouxe o ground truth que faltava — durante o loading infinito o probe da
  beta 4 mostrou `estado=aberta srv_ha=1s cli_ha=0s subs=0`: ws aberta,
  heartbeats respondendo DOS DOIS lados e o usuário travado. O zumbi não é o
  servidor calado (isso o alarme "silente" já pega): é o servidor que **aceita
  heartbeat mas não entrega dispatch** — protocolo vivo, dados mortos. Com o shim
  descomprimindo o fluxo zlib do servidor no renderer (`DecompressionStream`, um
  stream contínuo por geração de ws), dispatch deixou de ser indistinguível de
  heartbeat e o caso virou detectável: **zumbi = o usuário pediu algo (qualquer op
  ≠ 1) e NÃO chegou dispatch nenhum desde o pedido**, com conexão quente dos dois
  lados e aquecimento de 2min para o READY assentar. O histograma de TODAS as ops
  do cliente vai no `gw.probe` (o `subs=0` eterno da #153 sugere que o cliente
  migrou do op 14 — contar tudo decide isso sem chute). A cura sem Ctrl+R existe:
  **fechar o ws com close(4000)** — o mesmo código que o próprio cliente usa ao
  receber op 7 (RECONNECT) — faz ele renascer sozinho com RESUME. A escada é
  automática e conservadora: nível 1 = close 4000; não curou, nível 2 = reload (a
  cura que sempre funciona); o ws não renasceu em 15s = reload direto (auto-cura);
  **nunca com mídia aberta ou recente <3min** (§6: reconexão mata o vídeo da live —
  nesse caso só banner + pill, decisão do usuário); teto de 2 tentativas por 30min
  com cooldown de 3min; estourou, volta a ser ambiental. A reconexão que o PRÓPRIO
  revive provoca é reconhecida (TTL de 60s): não vira "recorrência no meio da
  sessão", não alimenta a rajada e não quarentena a saída sadia. Sucesso só é
  creditado com a conexão sobrevivendo ao aquecimento com dispatch fluindo (o
  READY da conexão nova, que sempre chega, não engana o creditar). Toggle "Reviver
  gateway travado automaticamente" na GUI (settings `autoRevive`, default ligado;
  desligado = detecção e log continuam, a ação fica sendo do usuário). O `gw.probe`
  novo (`dispatch_ha`/`intent_ha`/`aberto_ha`/`geracao`/ops) entrega o veredito
  H1 (servidor envelhecido — close+RESUME cura) vs H2 (store engasgada — só o
  reload cura) no próximo relato. O **report de bug** acompanha: a tabela
  Sistema passou a dizer `autoRevive` na leitura do RUNTIME (mesma lógica do
  `routeModeDisco` — report sem nenhum `gw.revive` com a flag desligada é
  comportamento esperado, não bug) e o `estat.sessao` ganhou `revives=` com a
  contagem de ações da escada na sessão. Testes: `tests/gateway-probe.test.ts` (25
  cenários — shim com zlib REAL comprimido no teste, fechar, gerações, alarme em
  idades, escada) e `tests/test-gateway-zumbi-revive.cjs` (sandbox vm com o script
  real: escada completa, guardas de recorrência, auto-cura, mídia, flag).
- **Pill de recuperação permanente + probe do gateway no renderer** (beta 4,
  [#149](https://github.com/bezumiya/GoLiveBypass/issues/149)): o teste real do
  William na beta 3 provou que o **zumbi de aplicação é indistinguível na rede** —
  durante os vãos (416s e 713s) o túnel seguiu carregando heartbeats (o alarme da
  beta 3 não disparou) — e como a conexão é TLS ponta a ponta com payload
  comprimido, nenhum detector do lado da rede separa heartbeat de dado. Três
  mudanças: (1) um **pill "↻" permanente** dentro do Discord — discreto
  (opacidade 35%, hover 100%) — que recarrega a janela num clique:
  o usuário resolve no primeiro segundo de loading em vez de esperar os 7-25 min
  do reconnect; some sozinho em fullscreen e com websocket de mídia aberto (call/
  transmissão), e o atalho **Ctrl+Alt+R** fica de pé mesmo assim (intenções
  explícitas do usuário executam mesmo em chamada — a decisão é dele, nunca
  nossa). (2) Um **shim no renderer** injetado via CDP
  (`addScriptToEvaluateOnNewDocument`, antes do bundle — única forma sem corrida)
  que envolve o `WebSocket` do gateway e conta frames: cliente em JSON texto (o
  zlib do Discord é só servidor→cliente; op 1 heartbeat, op 14 subscribe =
  intenção de navegar), servidor comprimido em contagem/cadência — o vigia polla
  a cada 60s e loga `gw.probe`, então o próximo relato chega com ground truth em
  vez de dedução. (3) O alarme de rede foi **re-escopado** pelo probe: dispara só
  com o servidor inteiro calado (>3min sem NENHUM frame, nem ACK) — morte de
  rede real; o detector de bytes da beta 3 foi removido (mascarado pelos
  heartbeats, provou inútil para a variante real). Testes:
  `tests/gateway-probe.test.ts` executa o shim e o alarme REAIS extraídos do
  script (8 cenários, incluindo wire-up e remoção do antigo).
- **Alarme de "gateway zumbi"** ([#145](https://github.com/bezumiya/GoLiveBypass/issues/145),
  beta 3): a sessão de gateway pode ficar muda sem morrer de forma visível — o TCP não
  gera `tunel.caiu`, o Discord não reconecta (nada de `gw.visto`), e as telas ficam
  carregando para sempre enquanto isso (o relato: ~14,5 minutos sem nenhum connect novo,
  com o bypass achando que tudo estava bem, porque o batimento só prova o túnel do Tor,
  não a sessão do Discord). O sinal de vida de um gateway saudável são os heartbeats
  (bytes nos dois sentidos a cada ~40s): 5 minutos de silêncio total — nenhum byte no
  túnel e nenhum connect novo — agora dispara um banner manual dentro do Discord
  ("sessão sem resposta — Reiniciar agora"), que some sozinho se o sinal voltar.
  Manual de propósito: reload automático aqui seria o "esperto demais" que encerra
  chamada (mesma regra da janela de mídia recente). Testes: `tests/gateway-zumbi.test.ts`
  executa o bloco real do detector extraído do script (tempo falso, 7 cenários).
- **Guarda contra ativação duplicada** ([#145](https://github.com/bezumiya/GoLiveBypass/issues/145),
  beta 3): duas ativações em segundos (reativação de boot + clique com o status ainda
  velho) injetavam duas vezes — cada injeção fecha as conexões antigas e faz o gateway
  renascer; no relato da #145 a segunda derrubou a sessão recém-nascida da primeira,
  7 segundos depois. Agora a segunda chamada aguarda a primeira terminar, e
  re-ativação idêntica (mesma proxy, mesmo modo) sobre um bypass já injetado é
  ignorada. Mudou proxy ou modo? Re-injeta de verdade. Testes:
  `tests/ativacao-guard.test.ts`.
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

### Investigado (documentado, não corrigido)
- **Upload de imagem no chat trava e some com o bypass ativo**: reproduzido ao vivo em
  2026-09-03 (VM Windows/WireSock) — a barra de progresso do anexo trava e a mensagem some do
  canal, sem completar nem dar erro. Causa provável: o perfil WireGuard gratuito **embutido no
  app** (`Endpoint = 84.20.27.53:51820`, o mesmo `EMBEDDED_WG_CONF` de `wiresock.ts`/
  `golivebypass-standalone.sh`) é compartilhado entre todos os usuários que não importaram uma
  config própria, e satura sob carga real concorrente — um teste isolado de 5MB via `curl` pelo
  mesmo endpoint completou sem problema, descartando MTU/fragmentação como causa estrutural.
  Não é uma correção de código simples (a causa é capacidade de infraestrutura compartilhada de
  terceiros); detalhe completo, evidências e opções de mitigação (aviso de degradação na GUI,
  pool de perfis gratuitos, documentação) em `AGENTS.md` seção 10.1.

### Corrigido
- **Windows: GUI ativava de verdade mas a tela continuava mostrando "Ativar" (relato de beta
  tester)**: `getStatus()` só checava `isWireSockRunning()` (estado do **serviço** Windows,
  `sc query wiresock-client-service`). Mas `startWireSockService()` tem um fallback deliberado
  para quando o serviço não sobe (tipicamente falta de privilégio de administrador): ele
  spawna o `wiresock-client.exe` **direto, sem serviço** (`spawn(wsExe, ["run", ...])`), e a
  própria ativação já confere isso via `tunelConfirmado()`/`esperarTunel()` antes de declarar
  sucesso. `getStatus()` nunca soube desse segundo modo — com o túnel genuinamente de pé (sem
  serviço), ele reportava `INACTIVE` para sempre, e a UI ficava presa mostrando "Ativar" com o
  bypass realmente ativo por trás. Corrigido: nova `isWireSockActive()` (exportada de
  `wiresock.ts`) cobre os dois modos — serviço rodando OU processo `wiresock-client.exe` vivo
  (via `tasklist`) — e `getStatus()` passou a usá-la. Reproduzido e confirmado na VM Windows:
  parei o serviço, subi o `wiresock-client.exe` direto (mesmo estado do fallback), a beta 20
  reportava `INACTIVE` com o processo genuinamente vivo; a build corrigida reporta `ACTIVE` no
  mesmo estado exato, sem reiniciar nada.
- **GUI apagava Vencord/Equicord instalado no mesmo Discord (Linux, Windows)**: em
  `golivebypass-standalone.sh`, o loop de ativação calculava `injection_state()` (que já
  distinguia "nosso" de "outromod") e chegava a avisar/pedir confirmação quando achava outro
  mod, mas a remoção de fato (`remove_injection`, que faz `rm -rf app.asar && mv _app.asar
  app.asar`) rodava **incondicionalmente** sempre que `_app.asar` existisse — ignorando essa
  variável e a resposta do usuário. Como a GUI sempre chama o script com `--yes` (o `confirm()`
  do script vira no-op), todo clique em "Ativar" com Vencord/Equicord instalado restaurava o
  Discord vanilla por cima, apagando o mod sem aviso nenhum na tela. O mesmo padrão existia no
  `--uninstall`/`--restore` (desativar também apagava). Em `golive-gui/electron/main.ts`, o
  caminho Windows/macOS (`executarAtivacao`) tinha o problema ainda mais exposto: restaurava
  `_app.asar → app.asar` sempre que o backup existisse, sem checar se a injeção ali era nossa —
  as funções `detectOtherMod`/`isProtectedMod` existiam no arquivo mas nunca eram chamadas.
  Corrigido: nova função `asar_is_ours()` (ignora se o túnel netns já está de pé, ao contrário
  de `injection_state()`, para não confundir "WireGuard ativo" com "injeção nossa no asar") guarda
  as duas remoções do script; no Windows a restauração só roda quando `isOurInjection()` é
  verdadeiro (Vencord/Equicord/qualquer mod fica intocado — o WireSock envelopa o processo
  independente do que há no `app.asar`); no macOS (que ainda faz injeção real) as funções de
  detecção foram finalmente conectadas, com confirmação explícita do usuário antes de
  sobrescrever um mod protegido (`OUTRO_MOD:<mod>:<path>` tratado no renderer com um diálogo de
  confirmação). Testado nesta máquina com uma instalação real de Vencord
  (`~/.config/Vencord/dist/patcher.js`) simulando o app.asar patcheado: `injection_state`
  classifica corretamente como `outromod` e `asar_is_ours` recusa a remoção; a injeção legada
  do próprio GoLiveBypass continua sendo limpa normalmente (`nosso`/`asar_is_ours=sim`). O teste
  completo fim-a-fim (netns + WireGuard reais) não rodou por exigir elevação interativa não
  disponível nesta sessão.
- **Ativação podia falhar por causa de um Tor sem relação nenhuma com a rota real**: tanto
  `executarAtivacao` (Windows) quanto `linuxActivate` bootstrapavam um Tor embutido sempre que
  `readNetMode()` lia `"tor"` — o valor padrão para qualquer `settings.json` sem `routeMode`
  salvo, ou seja, toda instalação nova. Como não existe mais seletor de modo na tela, isso só
  acontecia por acidente, e uma falha no download/bootstrap do Tor abortava a ativação inteira
  mesmo com uma configuração WireGuard perfeitamente válida já conferida na função. Removido do
  Windows (WireSock não depende disso) e do Linux (o `netMode` passado ao script agora é sempre
  `"auto"`, o único valor que nunca aciona o `ensure_tor` do script); mantido no macOS, que
  ainda depende do Tor de verdade para o proxy manual/PAC.
- **Morte do Tor embutido deixa de esperar ~60 s para iniciar recuperação**:
  o watchdog da GUI tratava porta fechada (processo morto) igual a um circuito
  Tor temporariamente lento e só agia depois de duas verificações de 30 s. A
  porta agora é conferida a cada 5 s; fechada, ela é prova suficiente para um
  único bootstrap imediato do mesmo daemon. O bootstrap é serializado para que
  polls seguintes não criem processos concorrentes. Se a porta ainda atende,
  o probe de túnel mantém as duas amostras espaçadas por 30 s, preservando a
  rotação normal de circuito. Standalone e plugin não têm esse daemon embutido
  sob sua posse; seus caminhos estritos de detecção/falha fechada permanecem
  inalterados. Coberto por testes puros de porta morta, circuito lento e
  intervalo de probe.
- **Auto-update do standalone nunca notificaria quem está na beta, e podia
  instalar script de uma versão com payload de outra**: `Compare-StandaloneVersion`
  tratava o sufixo `-beta.N` como um componente numérico extra do
  `Split('.')` (`1.1.12-beta.13` virava `[1,1,12,13]` contra `[1,1,12,0]` da
  stable, "local mais nova" sempre venceu) — o mesmo bug existia em
  `standalone_compare_version` no `.sh` apesar do `sort -V`, verificado com
  testes diretos da função (`1.1.12-beta.13` contra `1.1.12` também dava
  "mais nova" lá). As duas agora separam base e sufixo antes de comparar: um
  sufixo de pre-release conta sempre como mais antigo que a mesma base sem
  sufixo. Corrigido também `Invoke-StandaloneUpdate`/`standalone_update`:
  buscavam o script sempre de `main` (HEAD mutável) mas o payload da tag da
  release (imutável), podendo instalar um par nunca lançado junto; os dois
  artefatos agora vêm da mesma tag.
- **Recuperação RTC obrigatória e regressão da beta 15**
  ([#183](https://github.com/bezumiya/GoLiveBypass/issues/183), beta 16): o log
  provou que o viewer saudável (geração 2) era substituído por gerações novas
  com `dec=0`/`fps_dec=0`, sem nenhum `gw.revive`. A beta 15 atualizava a
  memória de saúde antes de avaliar a nova geração e aceitava `0` ou um burst
  de bytes como vídeo saudável; por isso voltava ao início frio de 60 s a cada
  renegociação. Agora a leitura atual é pura, só frames/FPS realmente
  decodificados podem creditar saúde, e a memória anterior é usada para fechar
  somente o WebSocket RTC pareado da nova geração no próximo poll (~5 s). O
  gateway não é tocado durante mídia ativa. A recuperação automática deixou de
  ser uma escolha: checkbox, IPC e opt-out de runtime foram removidos, settings
  legados `autoRevive:false` são saneados para `true` e o report informa
  `obrigatorio`. Teto, cooldown, pareamento e as proteções de call/Live
  permanecem. O plugin Vencord/Equicord segue fora deste porte porque não possui
  este vigia RTC/gateway; a lacuna continua explícita.
  Uma auditoria posterior da reprodução real encontrou mais dois casos que os
  contadores nativos, sozinhos, escondiam: o Discord pode reutilizar a mesma
  conexão `discord_voice` enquanto troca o `srcObject` do `DirectVideo`, e os
  seus `getFilteredStats` antigos podem continuar mostrando FPS depois de a UI
  exibir o erro 2012. O shim agora soma uma geração visual local, sem expor
  identificadores da página, à geração nativa do viewer; uma troca visual sem
  frames entra no caminho rápido. A recuperação só é creditada quando a fonte
  visível recebeu um frame novo — anexar uma fonte parada em `currentTime=0`
  nunca vale como sucesso. Isso conserva a única tentativa de `close(4000)`
  direcionado e impede tanto a espera fria errada quanto o falso positivo que
  antes encerrava a escada sem recuperar a imagem.
  O teto também ganhou um fallback defensivo para implementações de
  `discord_voice` que não exponham `setDesktopSource*` ao hook: quando a fonte
  não é observável, usa a transição local de demanda remota como identidade da
  Live. Uma nova Live/reentrada avança esse epoch e ganha uma tentativa limpa;
  o `close(4000)` provocado pelo próprio bypass conserva a demanda e não pode
  reiniciar a escada. O replayer cobre ambos os ramos. A chamada Linux→Windows
  confirmou uma Live encerrada e iniciada de novo com imagem, encoder a 15 fps
  e nenhuma repetição automática de close, reload ou troca de rota. A página
  CDP comum não enxerga o mundo isolado do preload; por isso seus campos de
  fonte não são usados para diagnosticar a presença do callback real.
- **Seletores Tor/Gratuitas respeitam a escolha explícita**: a GUI preserva o
  texto da proxy ao trocar de modo para que ele possa ser reutilizado em
  “Personalizado”, mas o runtime ainda lhe dava precedência. Assim, uma GUI em
  Tor podia rotear por uma proxy manual antiga e aplicar a ela a tolerância de
  circuito do Tor. Agora somente `routeMode:auto` usa a saída/configuração de
  range manual; `tor` usa exclusivamente o Tor e `free` busca exclusivamente a
  lista. O log explica quando uma proxy salva foi ignorada. O plugin não tem
  esse seletor de três modos — nele a proxy explícita continua sendo, por
  desenho, a escolha do usuário — portanto não há porte aplicável.
- **Viewer que já recebia vídeo agora recupera a reentrada travada em até 5 s**
  ([#181](https://github.com/bezumiya/GoLiveBypass/issues/181)): uma nova conexão
  `discord_voice` de viewer sem frames, logo após outra que decodificava vídeo,
  não espera mais 60 s. O vigia fecha somente o WebSocket RTC pareado no próximo
  poll (limiar de 1 s, poll de 5 s), preservando gateway, chamada e janela. A
  primeira negociação da sessão continua com a guarda de 60 s, pois ainda pode
  ser conexão normal; sem socket pareado, demanda ativa e histórico saudável a
  ação falha fechada. O toggle de revive também passa a ser lido ao vivo do
  `settings.json`, para a GUI não mostrar "ligado" enquanto o runtime conserva
  um valor antigo. O plugin Vencord/Equicord não recebe porte: ele não possui o
  vigia nativo de `discord_voice`/recuperação RTC desta GUI.
- **Reconexão do gateway não dá mais Ctrl+R em viewer ativo**
  ([#178](https://github.com/bezumiya/GoLiveBypass/issues/178)): uma Live assistida
  por mais de 20 minutos continuava decodificando vídeo pelo `discord_voice`, mas
  o WebSocket `*.discord.media` tinha deixado de aparecer no shim. A marca de
  mídia expirava, a reconexão do Tor era lida como "sem chamada" e o reload
  preventivo derrubava o viewer. Stream nativa ativa agora renova a guarda de
  mídia mesmo sem esse WebSocket; antes do reload a GUI consulta novamente o
  estado nativo e, com stream/mídia ou telemetria indisponível, cancela a ação e
  mostra somente o aviso manual. A ausência comprovada de stream mantém o reload
  preventivo fora de chamadas. O plugin Vencord/Equicord não recebe porte: ele
  ainda não implementa esse auto-reload/revive de gateway, lacuna já documentada.
- **Instalador Linux morria em silêncio antes do menu** (sem issue): com o último
  install varrido sendo um Discord puro (o caso mais comum), o filtro
  `is_parallel_install "$r" && printf` de `parallel_installs()` fazia o `while`
  sair com status 1, o assignment `parallels="$(parallel_installs)"` falhava e o
  `set -e` encerrava o script inteiro sem mensagem nenhuma — o usuário via
  "Detectado: ... Fonte nao encontrado" e nada mais acontecia. O filtro agora é
  um `if`, que termina em status 0 quando a condição é falsa, e a detecção de
  clientes paralelos (Vesktop/Equibop/Legcord) continua idêntica. Regressão no
  `tests/test-posix.sh` (seção 9), rodando em sh/ash/bash/dash.
- **Banner de zumbi da beta 4 disparava em falso — e ficava preso** (achado no
  ciclo da #153): `avaliarSinalGw()` comparava a IDADE do último frame (`srvHa`,
  em ms desde o evento) como se fosse timestamp (`agora - srvHa`); o gate de
  3min nunca filtrava e qualquer ws aberta devolvia "silente" — o banner de
  sessão muda subia ~60s depois de abrir o Discord e o latch só saía se o ws
  fechasse. O teste antigo passava porque alimentava o resumo com TIMESTAMP —
  codificava o contrato errado. O contrato agora é de IDADES dos dois lados
  (shim e teste codificam o real).
- **Botão ficava em "Ativar" com o bypass já de pé após a reativação de boot**
  ([#149](https://github.com/bezumiya/GoLiveBypass/issues/149), beta 5 —
  confirmado pelo testador na beta 4): a janela costuma carregar NO MEIO da
  reativação automática do boot (o Tor demora segundos para subir) e nada a
  avisava quando ela terminava — o botão ficava em "Ativar", e o clique nesse
  estado era o gatilho exato da duplicação que a guarda da beta 4 neutralizou.
  A reativação de boot agora atualiza a janela e a bandeja ao terminar, no
  sucesso e na falha.
- **Instalador crashava com "Invalid handle. Parameter name: handle" ao perguntar no
  console** ([#146](https://github.com/bezumiya/GoLiveBypass/issues/146)): quando o
  instalador é lançado por um caminho que não abre console de verdade (atalho,
  automação, wrapper), o `Read-Host` do menu explode dentro do `FileStream` com um
  handle de stdin morto — crash cru, sem dizer nada. Todos os prompts (menus de
  escolha, proxy, persistência, update) agora passam por um `Read-Escolha` que
  converte o crash em uma mensagem com o que fazer ("rode de novo com duplo clique
  no .bat ou de uma janela normal do PowerShell"). É ambiente de uso, não bug — o
  aviso não abre issue automática (`Test-ShouldReport`).
- **Instalador: alvo de injeção sem caminho virava `DriveNotFoundException`
  críptico** ([#136](https://github.com/bezumiya/GoLiveBypass/issues/136), "Cannot
  find drive. A drive with the name '@{Flavour=Discord; Resources=C' does not
  exist"): um alvo cujo `Resources` não é string, usado como path, faz o PowerShell
  entender o trecho antes do `:` como nome de drive. Não reproduziu no código atual
  (verificado na VM Windows com pipeline completo e dois alvos falsos), então é
  ciclo velho ou estado de máquina — mas a classe morreu: `Get-PatchTargets` agora
  coerciona para string, descarta caminho vazio e valida todos os alvos antes de
  devolver (parando na causa, longe do sintoma). E o relato automático ganhou
  `ScriptStackTrace` quando o `InvocationInfo` não traz linha — a próxima ocorrência
  chega com a pilha exata em vez de vir sem localização nenhuma.
- **Auto-update do Windows portable não funcionava — nunca** ([#135](https://github.com/bezumiya/GoLiveBypass/issues/135),
  "Auto-update não funciona"): o popup aparecia, o download e a conferência de
  digest passavam, e a instalação morria sempre em "não consegui substituir o
  exe em uso" — dez retentativas de 1s e silêncio. A causa: a troca tentava
  **apagar** o executável em execução (`rmSync`), e o Windows nega delete de
  imagem mapeada em memória com EPERM para sempre, não é questão de esperar.
  A troca agora acontece em dois tempos. Primeiro, ainda dentro do processo e
  com rollback: o exe em uso sai do caminho com um **rename** (o Windows
  permite) para `GoLiveBypass.exe.old` e o baixado entra no lugar — se o novo
  não entrar, o antigo volta, porque é melhor seguir na versão atual que ficar
  com atalho quebrado. Segundo, o relançamento: um helper externo (`.bat`
  disparado por `wscript`, sem janela) espera o processo velho morrer de
  verdade — a sonda é o próprio delete do `.old`, que o Windows recusa enquanto
  a imagem roda — antes de abrir o exe novo, sem corrida contra o lock de
  instância única ("fecha mas não abre"); ao fim limpa a sobra `.old` e a si
  mesmo. O conteúdo do `.bat` é 100% ASCII com os caminhos chegando como
  argumento e o `.vbs` vai em UTF-16 com BOM: o cmd lê `.bat` no codepage OEM e
  o wscript lê `.vbs` como ANSI, então caminho embutido no conteúdo embaralharia
  para qualquer usuário com acento no nome (João, Conceição — público majoritário
  do projeto). Esgotadas as esperas, o helper lança mesmo assim, e a falha de
  instalação passou a mostrar um diálogo dizendo que a versão atual segue
  funcionando e onde baixar manualmente — em vez do silêncio do relato ("clico
  para atualizar, e nada acontece"). No caminho do AppImage, o `close` da janela
  agora respeita a marca de quit-por-update (era a causa latente do mesmo
  "fecha mas não abre" lá), e o Tor embutido fica de propósito rodando durante a
  troca: o processo novo o adota pela porta 9060 e o gateway nunca cai. Testes:
  `tests/updater-replace.test.ts` (troca, sobra de update anterior, rollback,
  limpeza no boot, conteúdo dos helpers sem disparar nada de verdade).

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

Fora do escopo desta rodada (documentado como trabalho futuro): o plugin ainda
não expõe um seletor `routeMode` equivalente ao da GUI. Campo vazio continua
significando automático (Tor detectado → gratuitas → direto), mas um Tor local
digitado explicitamente agora é estrito e nunca vaza para essas alternativas.
Também ficaram de fora o **alarme de "gateway zumbi"** do beta 3 (#145), o **pill de
recuperação + probe** do beta 4 (#149) e o **revive automático** do beta 6
(#153 — detecção de dispatch starve + close 4000 + escada até reload): no
plugin eles sairiam mais precisos (o renderer enxerga o socket do gateway, o
timestamp da última mensagem e o decompress sem CDP) — o pill e o close do ws
são quase diretos lá — mas o porte não entrou neste ciclo; o plugin segue sem
nenhum deles até o próximo. A recuperação nativa de vídeo da #164 também fica
fora do plugin nesta rodada: ela depende do preload de sessão no processo
principal, do world isolado 999, dos stats inbound/outbound de `discord_voice` e
do pareamento temporal com o websocket RTC específico da stream; o plugin tem
IPC/patches próprios e precisa de um porte manual que preserve as mesmas guardas
(sem demanda positiva nunca age; com demanda positiva o target zero é apenas
diagnóstico; a call principal nunca fecha; no máximo um close direcionado antes
do fallback manual), nunca de uma cópia literal do standalone.

O observador CDP `Network`, o parser ETF `MAP_EXT` e o controlador de ações por
target/geração da beta 13 também não foram copiados para o plugin: essa via não
injeta um app principal Electron próprio e já executa patches dentro do renderer,
portanto precisa observar o websocket por sua arquitetura nativa. A regra
`gw.rajada_tor` não tem equivalente direto — o plugin não implementa a janela
de rajadas do standalone, mas seu heartbeat Tor permanece informativo e o Tor
manual estrito agora também bloqueia reservas/DIRECT no tráfego vivo.

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
