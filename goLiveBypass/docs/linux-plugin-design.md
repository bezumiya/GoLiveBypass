# GoLiveBypass — design do transporte Linux

## Escopo

O plugin roda dentro do processo Electron do cliente Discord. Nesta migração ele ganha um backend Linux autônomo, sem importar estado, processos ou regras da GUI Electron e do standalone. O alvo primário de validação é o host CachyOS x64 em Wayland/niri, com Equibop 3.3.0 e Vesktop 1.6.7.

A garantia de isolamento é por processo: somente o cliente Discord relançado pelo plugin entra no network namespace próprio. O restante do sistema mantém a rota normal. `active` significa túnel e processo iniciados; handshake, IP público e probes são diagnósticos e não bloqueiam nem derrubam o cliente.

## Decisão de transporte

Usar um network namespace por instância, com relaunch controlado:

1. Validar dependências e possibilidade de elevação antes de encerrar o cliente atual.
2. Criar um namespace com nome e interface WireGuard exclusivos do plugin.
3. Criar/configurar a interface WireGuard no namespace inicial, onde o socket UDP consegue alcançar o endpoint pela rede normal, e só então mover a interface para o namespace dedicado.
4. Dentro do namespace, subir loopback, endereços do perfil, DNS privado do perfil e a rota padrão pela interface WireGuard.
5. Persistir um owner record com PID, geração, namespace, interface, perfil e estado de relaunch.
6. Relançar o mesmo cliente pelo helper C `netns-launcher`, que faz `setns`, monta o DNS privado e aplica apenas o ambiente/argumentos permitidos antes do `exec`.
7. Ao desativar ou encerrar, parar somente a instância com owner válido, remover namespace/interface/DNS temporário e relançar fora do namespace quando necessário.

Não usar rota padrão, proxy, PAC, Tor, alteração de `app.asar`, estado da GUI ou estado do standalone. Policy routing por UID/cgroup não foi escolhido porque não cobre de forma confiável todos os subprocessos de Electron/Flatpak e pode afetar outros processos do usuário.

## Cliente nativo e Flatpak

Para instalação nativa, o relaunch usa `pkexec` para executar o helper C `netns-launcher` com o namespace, UID/GID, ambiente gráfico permitido e argumentos atuais. O helper valida os argumentos, entra em `/run/netns/<namespace>`, cria um mount namespace privado para bind-mountar o `resolv.conf` do perfil quando existente, remove o próprio arquivo somente quando foi instalado como temporário e então faz `setuid`/`setgid`/`exec`.

Para Flatpak, o processo do plugin não consegue executar diretamente o binário que está dentro do sandbox. Ele exige `flatpak-spawn --host` com a permissão `org.freedesktop.Flatpak`, envia o helper para `/run/user/<uid>/` por stdin através de `pkexec install -m 700`, executa-o no host com `--self-delete` e só remove o temporário antecipadamente quando a preparação falha. O cliente é relançado com `flatpak run <app-id>` dentro do namespace.

O cliente precisa permitir a conversa com `org.freedesktop.Flatpak`; o instalador/documentação deve oferecer o override por aplicativo e o backend deve retornar erro acionável quando a permissão não existir. O app continua sem privilégios de rede: apenas a preparação host-side recebe elevação. Wayland, X11 fallback, D-Bus de sessão, PulseAudio/PipeWire e variáveis de idioma devem ser preservados no relaunch.

## Privilégio e segurança

Operações mutáveis (`netns add/del`, criação/movimentação da interface, `wg setconf`, endereços, rotas e DNS do namespace) são executadas com `pkexec`/mecanismo equivalente em chamadas sem shell. Nenhuma senha é colocada em argumento, ambiente, log ou arquivo do plugin.
Uma ativação explícita entra primeiro em `authorizing` e executa uma preflight foreground com `pkexec /usr/bin/true` (ou a ponte host do Flatpak); somente após a autorização o plugin cria owner, namespace e interface. O diálogo nativo do polkit recebe a senha; se não houver agente gráfico, um terminal nativo disponível executa o próprio `pkexec`. O plugin não cria campo próprio para senha administrativa.
Diagnósticos, boot automático e leitura de status não abrem prompt; cancelamento, timeout ou recusa deixam a rede e o Discord intactos e retornam falha acionável.

Todos os nomes e caminhos usados por comandos privilegiados são validados; o perfil efetivo fica na pasta privada do plugin. A limpeza é idempotente e limitada ao namespace/interface/DNS cujo owner pertence ao plugin. Owner externo ou estado inconclusivo causa bloqueio seguro, nunca parada de recurso alheio.

## Sessão Proton

O helper `proton-confgen` é selecionado por plataforma/arquitetura (`bin/linux-x64/proton-confgen` no Linux e o helper Windows existente no Windows). No Linux, a sessão canônica não fica em JSON plaintext: o payload é protegido pelo armazenamento seguro do Electron (Secret Service/libsecret); o helper recebe somente uma cópia temporária 0600, removida em `finally`. A pasta de dados é 0700 e arquivos privados são 0600. Falha do armazenamento seguro é erro explícito de persistência, sem fallback plaintext.

Login continua usando stdin estruturado, staging atômico e tentativas limitadas de CAPTCHA. 2FA, credenciais inválidas, rede, timeout, cancelamento e sessão expirada permanecem códigos distintos. Logout remove a sessão protegida e os artefatos Proton gerados, sem apagar perfil WireGuard personalizado.

## Estados e relaunch

O controller mantém uma fila serial e gerações para impedir respostas atrasadas. O owner marca `restarting` antes do spawn. O novo processo valida namespace/owner e adota somente o recurso correspondente; falha no relaunch não converte preparação em sucesso silencioso. O callback de relaunch é injetado pelo bridge nativo para manter o controller testável e separar Electron do backend Linux.

O fechamento normal tenta restaurar a rede antes de sair. Se a restauração não puder ser confirmada, o estado permanece `recovery_required` e a UI mostra ação acionável; o plugin não mata processos externos nem afirma rede restaurada sem prova.

## Updater

O asset continua assinado por SHA-256 e protegido por HTTPS/allowlist. A validação exige o helper correspondente a `process.platform`/`process.arch`, mantendo os dois helpers no pacote quando o release for universal. Canais estável/beta seguem SemVer: estável rejeita prerelease, beta é opt-in e nunca há downgrade automático. Update preparado exige reload manual; download parcial, árvore incompatível ou build falho restaura o backup e preserva sessão/configuração.

## Interface

O onboarding dentro do Discord tem três fases observáveis: sessão Proton, preparação real de rota e pronto. Progresso é alimentado por eventos do helper/controller, nunca por percentual inventado. Ações ficam desabilitadas durante operação, têm cancelamento quando suportado e usam `aria-live`; erros informam dependência, permissão, CAPTCHA, 2FA, credencial, rede ou restauração. Painel e overlay cancelam timers/listeners ao desmontar e ignoram resultados de gerações antigas.

## Verificação

A prova mínima combina build/teste do checkout do plugin com smoke real em Equibop 3.3.0 e Vesktop 1.6.7: instalação/carregamento, ativação e relaunch no namespace, desativação/restauração, reload, login/sessão/logout quando uma conta de teste estiver autorizada, voz/transmissão quando contas/canais permitirem e testes negativos sem credenciais. Toda lacuna de conta Proton, CAP_NET_ADMIN, CAPTCHA real ou mídia deve ser registrada como bloqueio/limitação, não simulada como sucesso.
