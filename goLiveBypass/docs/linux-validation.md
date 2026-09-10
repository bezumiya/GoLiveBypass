# Validação Linux do plugin GoLiveBypass

## Escopo e resultado

Validação executada em **2026-09-10**, sem publicar, fazer push ou alterar arquivos fora de `goLiveBypass/**`.
O alvo principal foi o plugin carregado em dois clientes Linux:

- Equibop **3.3.0** (`org.equicord.equibop`);
- Vesktop **1.6.7** (`dev.vencord.Vesktop`).

Resultado geral: **PARCIAL**. O plugin compila, carrega e expõe o caminho Linux nativo, o onboarding e os erros estruturados. A sessão do Discord oficial foi clonada somente para perfis temporários e abriu logado nos dois clientes modificados, inclusive após fechar e reabrir. Com uma credencial Proton de teste fornecida para esta validação, o login, a checagem da sessão e a preparação da rota real também passaram. A ativação do namespace/túnel permaneceu bloqueada pelo prompt de autenticação do `pkexec`.

## Ambiente observado

- CachyOS Linux x86_64, kernel `7.2.2-1-cachyos`;
- sessão gráfica Wayland/niri (`DISPLAY=:1`, `WAYLAND_DISPLAY=wayland-1`);
- `wg` WireGuard `1.0.20260223`;
- `ip`/iproute2 `7.2.0`;
- `/usr/bin/pkexec`, `/usr/bin/systemd-run`, `/usr/bin/flatpak-spawn` disponíveis no host/sandbox conforme o cliente;
- `unshare -Ur` e `unshare -Urn` aceitos, mas o shell de teste não possuía `CAP_NET_ADMIN`;
- `systemd-run --user --wait --pipe /usr/bin/true` aceito;
- `sudo -n true` exigiu senha, portanto não foi usado como atalho.

O plugin usa os diretórios autônomos por cliente em `GoLiveBypass/plugin-vpn`; não migra o estado da GUI nem do standalone. Os caminhos observados nos Flatpaks foram separados por ID de aplicativo, por exemplo:

- Equibop: `~/.var/app/org.equicord.equibop/data/GoLiveBypass/plugin-vpn`;
- Vesktop: `~/.var/app/dev.vencord.Vesktop/data/GoLiveBypass/plugin-vpn`.

Nenhum segredo, senha, token, chave privada ou conteúdo de sessão foi registrado.

## Procedimento reproduzível

### Build e análise estática

Os comandos abaixo foram executados nos checkouts temporários `/tmp/golive-vencord` e `/tmp/golive-equicord`, com uma cópia do diretório do plugin. Eles não são checkouts de trabalho do repositório principal.

```text
pnpm exec eslint src/userplugins/goLiveBypass       PASS (Vencord)
pnpm testTsc                                        PASS (Vencord)
pnpm build                                          PASS (Vencord)
pnpm exec eslint src/userplugins/goLiveBypass       PASS (Equicord)
pnpm testTsc                                        PASS (Equicord)
pnpm build                                          PASS (Equicord)
```

Os checkouts temporários do Equibop 3.3.0 e Vesktop 1.6.7 também passaram seus testes de tipos e builds respectivos.

O helper Go de geração de configuração passou:

```text
cd tools/proton-confgen && go test ./...              PASS
```

O launcher C Linux foi compilado com:

```text
cc -O2 -pipe -Wall -Wextra -Werror \
  -o /tmp/golive-netns-launcher goLiveBypass/tools/netns-launcher.c
install -m 0755 /tmp/golive-netns-launcher \
  goLiveBypass/bin/linux-x64/netns-launcher
```

`file` identificou `netns-launcher` e `proton-confgen` como ELF x86-64. Executar `netns-launcher` sem argumentos foi rejeitado com código 126 e mensagem de argumentos inválidos.

### Fallback no cliente empacotado

O build do Vencord/Equicord transforma o bridge nativo em `main.js` dentro do asar e não copia automaticamente os arquivos binários de `src/userplugins`. O caminho anterior retornava `MISSING_EXECUTABLE` nesse cenário. O plugin agora embute os helpers Linux comprimidos em `vpn-proton.ts`, verifica SHA-256 e os materializa somente na pasta privada `GoLiveBypass/plugin-vpn`, com modo 0700.

No bundle Vencord final, iniciado sem `GOLIVE_PLUGIN_PROTON_CONFGEN` e fora de um checkout fonte, o login de diagnóstico foi cancelado pelo fluxo nativo e retornou `CANCELLED`; o helper foi materializado como um ELF x86-64 de 14.745.863 bytes. O launcher Linux usa o mesmo fallback. Após o cancelamento, o arquivo `.tmp.lock` também foi removido pela limpeza de temporários.

Nenhum segredo, senha, token ou chave privada foi incluído nesse smoke; a credencial real foi usada somente na rodada interativa temporária descrita abaixo.

### Smoke unitário descartável

Um script temporário em `/tmp/golive-plugin-smoke.ts` exercitou e foi removido após a execução. O resultado foi:

```json
{
  "ok": true,
  "dependencies": { "ip": true, "wg": true, "pkexec": true },
  "networkInspection": { "reliable": true, "active": false, "externalConflict": false },
  "safeStoragePath": "/tmp/golive-session/proton-session.json"
}
```

Esse smoke cobriu validação/rejeição de configuração WireGuard, parsing de endereço/DNS, remoção dos campos não aceitos pelo `wg setconf`, allowlist de aplicativos, nomes de namespace/interface, rejeição de marcador falso de namespace, mapeamento de binários Flatpak para o host, dependências, inspeção de rede, CAPTCHA, classificação de erros Proton, canais/versões sem downgrade, allowlist de URLs e redação de segredos.

### Clientes reais, sessão clonada e CDP

Como a GUI GoLive é o controlador e não um cliente Discord, a sessão usada veio do perfil local do Discord oficial (`/home/pdl/.config/discord`). O processo oficial estava fechado; foram copiados apenas bancos de sessão Electron para `/tmp/golive-official-login-data` e duas cópias temporárias para os clientes. O perfil original não foi alterado e nenhum valor foi lido para o registro.

O perfil oficial clonado abriu em `https://discord.com/channels/@me` com o título `Amigos`. Equibop 3.3.0 e Vesktop 1.6.7 foram iniciados com cópias da mesma sessão, chegaram a `https://discord.com/channels/@me` já autenticados e permaneceram autenticados depois de fechar e reabrir os dois processos.

Nos bundles construídos do Vencord/Equicord, a inspeção do runtime confirmou em **ambos**:

```text
window.Vencord.Plugins.plugins.GoLiveBypass       presente e iniciado
window.VencordNative.pluginHelpers.GoLiveBypass   presente
native.getVpnStatus                               função disponível
native.getPluginUpdateStatus().current            2.0.0-beta-1
native.loginProton({username:"", password:""})    CONFIGURATION_ERROR
native.testWireGuardConfig()                      erro sem configuração encontrada
```

Uma tentativa interativa com a credencial Proton de teste fornecida pelo usuário concluiu:

```text
loginProton                         success=true
checkProtonSession                  valid=true
optimizeProtonRoute                 phase=completed, tested=7, succeeded=6
servidor selecionado                US-FREE#143
```

A sessão criptografada foi salva no diretório XDG temporário do cliente, sem senha em argumentos ou logs. O onboarding real avançou pelas páginas de conta, rota e pronto; a conclusão fechou o modal sem ativar o túnel. O Equibop apresentou depois um timeout transitório do IPC `navigator.languages` e encerrou com `SIGTRAP`, sintoma separado do login Proton e do fallback do helper.

A sequência de ciclo de vida foi exercitada nos dois clientes logados: `stopPlugin` terminou sem erro com o plugin parado e status Linux inativo; `startPlugin` terminou sem erro com o plugin iniciado e o mesmo status inativo. Os dois runtimes expuseram os caminhos XDG do plugin em `/home/pdl/.local/share/GoLiveBypass/plugin-vpn`, independentes da GUI e do standalone.


O status Linux observado nos dois runtimes foi inativo e coerente:

```text
platform=linux, architecture=x64, active=false, owned=false,
namespace=null, interfaceName=null, requiresRelaunch=false,
dependencies=[], state=inactive
```

O onboarding foi aberto pela ação real da toolbox em ambos os clientes logados. DOM e screenshot confirmaram o modal **“Configurar o GoLiveBypass”**, os três passos **“Conta Proton / Rota real / Pronto”**, os campos de usuário, senha e 2FA, texto de armazenamento protegido e botão desabilitado enquanto os campos estão vazios. Não há promessa de IP geográfico.

O updater exibiu a versão embutida `2.0.0-beta-1` nos bundles construídos e relatou explicitamente a ausência de checkout compilável para aplicar um release no cliente empacotado; não fingiu instalação nem reinício.

Nos Flatpaks instalados, foi aplicado somente durante o laboratório:

```text
flatpak override --user --filesystem=/tmp \
  --talk-name=org.freedesktop.Flatpak org.equicord.equibop
flatpak override --user --filesystem=/tmp \
  --talk-name=org.freedesktop.Flatpak dev.vencord.Vesktop
```

Essa permissão é necessária para que `flatpak-spawn --host` possa preparar o relaunch. Ela deve ser removida ao terminar a validação; o procedimento de limpeza está no fim deste arquivo.

### Preflight de privilégio

Uma tentativa real de ativação pelo Vesktop alcançou o backend Linux e abriu o agente polkit:

```text
AUTHENTICATING FOR org.freedesktop.policykit.exec
Authentication is needed to run `/usr/bin/true' as the super user
Authenticating as: Luan Rhiston (pdl)
Password:
```

A tentativa foi interrompida sem senha. Não foi criada namespace/interface e não houve alteração da rota default do host. Isso comprova o bloqueio ambiental, não sucesso artificial da ativação.
O fluxo de ativação foi separado em uma etapa explícita `authorizing`: a autorização
foreground via polkit ocorre antes de criar owner, namespace ou interface. O painel informa
que a senha deve ser digitada na janela nativa do sistema (ou no terminal nativo de
fallback), nunca em um campo do plugin.
Cancelamento, timeout ou recusa retornam ao estado inativo sem encerrar o Discord.
O smoke descartável do backend cobriu os quatro resultados de autorização sem segredo:
`AUTHORIZED`, `CANCELLED`, `FAILED` e `TIMEOUT`, incluindo o fallback de terminal.
Na execução real deste ambiente, o daemon polkit estava ativo, mas não havia agente gráfico
nem TTY no processo; o fallback Alacritty foi acionado e expirou após 60 segundos sem
senha fornecida. Nenhum recurso de rede foi criado.


## Matriz E2E A–H

`PASS` significa que o comportamento foi exercitado e observado. `BLOQUEADO` significa pré-requisito externo ausente ou prompt privilegiado não autorizado. `PARCIAL` significa que apenas a parte alcançável foi validada.

| Grupo | Cenários | Resultado e evidência |
|---|---|---|
| **A. Instalação e carregamento** | Instalação/carregamento; reabertura; reload; desativação/reativação | **PASS parcial**: builds Vencord/Equicord passaram; Equibop e Vesktop abriram autenticados; plugin, native bridge, status e toolbox ficaram disponíveis; fechar e reabrir preservou a sessão Discord e o carregamento. **BLOQUEADO**: reativação com túnel real, porque `pkexec` exigiu senha. |
| **B. Proton e persistência** | Login real; credenciais erradas; sessão persistida/renovação; logout; troca de conta; cancelamento; falha de rede; CAPTCHA; 2FA; fechar/abrir; remoção da sessão | **PASS parcial**: entrada vazia retornou `CONFIGURATION_ERROR`; a credencial Proton de teste concluiu o login, a sessão foi validada e a preparação criptografada foi gravada; o cancelamento nativo retornou `CANCELLED` sem deixar `.tmp.lock`; parser/classificador, armazenamento `safeStorage`, arquivos temporários 0600, remoção e concorrência foram cobertos pelo smoke/build. **NÃO COBERTO**: renovação, troca de conta, 2FA e CAPTCHA interativo contra a API. |
| **C. Preparação de rota** | Preparação normal; falha de aplicação; ausência de opção de cancelamento; respostas atrasadas; perda/reconexão; cliques repetidos | **PASS parcial**: a preparação real terminou com 7 servidores testados, 6 aprovados e `US-FREE#143` selecionado; contratos de cancelamento, voo único, timeout, recuperação e diagnóstico foram compilados e exercitados no smoke. **BLOQUEADO**: aplicação de namespace/WireGuard real sem autenticação polkit/CAP_NET_ADMIN. |
| **D. Isolamento e restauração** | Restauração ao encerrar recurso; limpeza de processos/rotas/configuração; modos Proton independentes; sobrevivência sem alterar tráfego global | **PASS parcial**: backend limita `ip`/`wg` ao namespace do proprietário, grava DNS em `/etc/netns`, não assume recurso protegido e trata resíduos como diagnóstico/recuperação. **BLOQUEADO**: ciclo real de rota, Discord dentro da namespace e restauração pós-encerramento por falta de privilégio autorizado. |
| **E. Atualizações** | Stable; beta com opt-in; entrada/saída beta; sem downgrade; artefato Linux correto; download checksum; instalação/rebuild; interrupção/corrupção; nova versão; preservação de conta/configuração | **PASS parcial**: seleção de asset/arquitetura, canais, comparação sem downgrade, checksum SHA-256, journal/backup/rollback, lock, cancelamento e reload explícito estão no código; smoke cobriu versões, canais e URLs; bundles construídos reconheceram `2.0.0-beta-1`. **BLOQUEADO no Flatpak instalado**: o pacote não contém checkout Vencord/Equicord nem ferramenta de rebuild; por segurança o updater não modifica o bundle imutável e reporta estado/erro em vez de fingir aplicação. |
| **F. Discord em uso** | Navegação; voz; transmissão; recepção da transmissão em outro cliente | **PASS**: a sessão clonada navegou até `Amigos` nos dois clientes e permaneceu autenticada após reabertura. **BLOQUEADO**: não foi iniciado canal de voz/transmissão nem recepção em outro cliente, porque a rota real não foi ativada e isso exigiria um destino de teste autorizado sem afetar a conta. |
| **G. Resiliência de cliente** | Carregamento preso/erro 2012; sessão longa; memória; processos/listeners/timers | **PARCIAL**: o timeout `navigator.languages` do Equibop foi observado e separado do plugin; os guards de voo, desmontagem e watchdog são cobertos por build/smoke; a sessão clonada foi reaberta com plugin ativo. **BLOQUEADO**: sessão longa, memória e erro 2012 reproduzido em conta autenticada. |
| **H. Regressão e reinicialização** | Matriz integrada; persistência após reiniciar VM; recuperação após interrupção; fechamento/reabertura completa | **PASS parcial**: builds integrados Vencord/Equicord e execução autenticada de ambos os clientes passaram; helper inválido foi rejeitado; fechar/reabrir preservou login, plugin e status. **BLOQUEADO**: reboot de VM não disponível, aplicação privilegiada não concluída e atualização real do pacote não autorizada/disponível. |

## Limitações que permanecem explícitas

1. Não foi afirmado handshake, IP de saída, geolocalização, voz ou transmissão sem a rota efetivamente ativada.
2. Probes de IP/HTTP/telemetria permanecem diagnósticos; não bloqueiam ativação nem derrubam o Discord.
3. A autenticação polkit foi alcançada. Sem agente gráfico, o fallback de terminal foi acionado, mas expirou sem senha fornecida; não há evidência de criação de namespace ou interface neste ciclo.
4. A sessão Discord do usuário foi usada somente em cópias temporárias autorizadas e permaneceu intacta no perfil original. A credencial Proton foi usada somente na rodada interativa temporária; não foi registrada nem mantida no repositório. A ativação real continuou bloqueada pelo polkit.
5. O updater exige checkout compilável para substituir fonte e reconstruir. Em Flatpak empacotado, o estado é exposto sem escrever fora do diretório permitido e a aplicação exige reload manual; a ausência do checkout é erro operacional, não fallback inseguro.
## Limpeza do laboratório

Limpeza executada após a validação:

```text
flatpak override --user --reset org.equicord.equibop
flatpak override --user --reset dev.vencord.Vesktop
```

Os processos, abas CDP e perfis temporários específicos do teste Proton foram encerrados/removidos, junto com as cópias temporárias da sessão Discord (`/tmp/golive-*-login-data`) e o smoke descartável. O perfil original `/home/pdl/.config/discord`, os dados permanentes dos clientes e o diretório de dados da GUI não foram alterados nem apagados.

