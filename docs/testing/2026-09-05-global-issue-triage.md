# Rodada de investigação global — 2026-09-05

## Escopo e evidência

Snapshot: upstream `bezumiya/GoLiveBypass`, 21 issues abertas (#223–#244, exceto #226). Origin `pdl-clay/GoLiveBypass` tem zero issues. Upstream main e HEAD local: `95f751059520a75d18eba844ed29cada2464565c`. Todos os endpoints de comentários retornaram lista vazia. Nenhum anexo externo identificado nos corpos. Os logs têm trechos truncados na origem e histórico de várias arquiteturas; não é possível recuperar conteúdo ausente a partir do relato.

Arquivos brutos da coleta ficam em `/tmp/golive-triage/`; não são incorporados ao repositório. Alterações preexistentes em AGENTS.md, .agents/skills/astra-orchestrator e .codex foram preservadas.

## Triagem inicial

| Issue | Versão/ambiente | Classificação | Grupo | Evidência/limite |
|---|---|---|---|---|
| [#223](https://github.com/bezumiya/GoLiveBypass/issues/223) | 2.0.2-beta.3 / linux-x64 | SEM EVIDÊNCIA SUFICIENTE | E | Sem descrição; sessão beta mostra ativação/desativação e updater 404; histórico wg ausente. |
| [#224](https://github.com/bezumiya/GoLiveBypass/issues/224) | 2.0.2-beta.3 / win32-x64 | POTENCIALMENTE VÁLIDA | B | Beta ativo sem funcionamento relatado; nenhum handshake medido, sem prova funcional de mídia. |
| [#225](https://github.com/bezumiya/GoLiveBypass/issues/225) | 2.0.1 / win32-x64 | VÁLIDA — INVESTIGAR | A | 2.0.1 reverte serviço por ausência de handshake observável. |
| [#227](https://github.com/bezumiya/GoLiveBypass/issues/227) | 2.0.1 / win32-x64 | DUPLICADA / RELACIONADA | A | Mesmos horários e erro de ativação da #225; log cita envio da #225. |
| [#228](https://github.com/bezumiya/GoLiveBypass/issues/228) | 2.0.2 / linux-x64 | VÁLIDA — INVESTIGAR | E | fopen Permission denied e namespace File exists na ativação Linux. |
| [#229](https://github.com/bezumiya/GoLiveBypass/issues/229) | 2.0.2 / win32-x64 | VÁLIDA — INVESTIGAR | D | MISSING_EXECUTABLE proton-confgen.exe em 2.0.2. |
| [#230](https://github.com/bezumiya/GoLiveBypass/issues/230) | 2.0.0 / win32-x64 | VÁLIDA — INVESTIGAR | D | ReferenceError __dirname no login 2.0.0 confirmado no log. |
| [#231](https://github.com/bezumiya/GoLiveBypass/issues/231) | 2.0.2 / win32-x64 | NÃO REPRODUZÍVEL AINDA | B | Envio e recepção de live em loading; log 2.0.2 truncado antes da ativação, histórico Tor e updater EBUSY. |
| [#232](https://github.com/bezumiya/GoLiveBypass/issues/232) | 2.0.3-beta.1 / win32-x64 | SEM EVIDÊNCIA SUFICIENTE | B | Descrição não define defeito: não estou na localidade brasil; prova central CA não prova Discord. |
| [#233](https://github.com/bezumiya/GoLiveBypass/issues/233) | 2.0.2 / linux-x64 | VÁLIDA — INVESTIGAR | E | Linux 2.0.2 com pedidos recorrentes de senha; histórico contém sessões antigas. |
| [#234](https://github.com/bezumiya/GoLiveBypass/issues/234) | 2.0.3-beta.3 / win32-x64 | POTENCIALMENTE VÁLIDA | B | Bloqueio regional em beta.3; saída direta já US, requer distinguir rota efetiva e sessão Discord. |
| [#235](https://github.com/bezumiya/GoLiveBypass/issues/235) | 2.0.3 / win32-x64 | VÁLIDA — INVESTIGAR | A | Probes continuam BR e ativação 2.0.3 reverte; usa caminho WireSock VPN Client antigo. |
| [#236](https://github.com/bezumiya/GoLiveBypass/issues/236) | não informado / não informado | SEM EVIDÊNCIA SUFICIENTE | C | Path vazio no instalador; não há linha/stack/versão, logs antigos de proxy. |
| [#237](https://github.com/bezumiya/GoLiveBypass/issues/237) | 2.0.3 / win32-x64 | VÁLIDA — INVESTIGAR | A | Ativação 2.0.3 revertida por probe não comprovado. |
| [#238](https://github.com/bezumiya/GoLiveBypass/issues/238) | 2.0.3 / win32-x64 | VÁLIDA — INVESTIGAR | A | Watchdog 2.0.3 executa rollback após falhas de HTTP/probe; confirmar relação com fechamento reportado. |
| [#239](https://github.com/bezumiya/GoLiveBypass/issues/239) | 2.0.4 / win32-x64 | POTENCIALMENTE VÁLIDA | D | Erro JavaScript após CAPTCHA; sessão atual termina em início de autenticação, sem stack do erro. |
| [#240](https://github.com/bezumiya/GoLiveBypass/issues/240) | standalone / win32-AMD64 | VÁLIDA — INVESTIGAR | C | Saída textual do winget aparece concatenada ao executável invocado. |
| [#241](https://github.com/bezumiya/GoLiveBypass/issues/241) | 2.0.4 / win32-x64 | VÁLIDA — INVESTIGAR | B | Loading/sem áudio; sessão 2.0.4 mostra primeiro probe falhando e depois saída MX; login seleciona US durante túnel MX. |
| [#242](https://github.com/bezumiya/GoLiveBypass/issues/242) | não informado / não informado | INVÁLIDA / NÃO É BUG | F | Pedido de suporte a VPN Kaspersky; proposta de funcionalidade. |
| [#243](https://github.com/bezumiya/GoLiveBypass/issues/243) | 2.0.4 / win32-x64 | NÃO REPRODUZÍVEL AINDA | B | Vídeo enviado preto, áudio e recepção funcionam; probes HTTP bem-sucedidos não comprovam mídia. |
| [#244](https://github.com/bezumiya/GoLiveBypass/issues/244) | standalone / win32-AMD64 | VÁLIDA — INVESTIGAR | C | Change de serviço retorna 2; log anexo é legado, não demonstra contexto de elevação. |

## Mapa de investigação e ownership inicial

- A — gating/recuperação WireSock: #225 #227 #235 #237 #238. Exploração compartilhada com B; nenhuma edição simultânea em wiresock/main.
- B — rota efetiva e mídia Discord: #224 #232 #234 #231 #241 #243. Hipóteses de scope, perfil ativo, família IP e mídia devem ser confrontadas; não presumir mesma causa nem saturação de endpoint.
- C — instalação/serviço standalone Windows: #236 #240 #244. Funções PowerShell, stdout e elevação; independente dos fontes GUI.
- D — Proton/autenticação/empacotamento: #230 #229 #239. Três sintomas diferentes; investigar helper, resolução ESM e lifecycle CAPTCHA. Updater #223/#228/#231 é subinvestigação contextual.
- E — namespace/permissões/health Linux: #223 #228 #233. Fonte shell e linux-helper; não compartilhar edição do main com A/B.
- F — proposta Kaspersky #242: fora da rodada de correções de bugs.

Explorers A/B, C, D e E são somente leitura. Um único tester controla a VM Windows. A implementação foi delegada após consolidar evidências e reprodução, com ownership de arquivos por task descrito abaixo. Testes reais de RTC requerem sessão e interlocução autorizada, não são substituídos por HTTP ou mocks.

## Resultado da rodada

Triagem global concluída para as 21 issues, agrupadas em seis frentes. Três correções locais de causas demonstradas: detecção de namespace Linux, cleanup da janela CAPTCHA e retorno da instalação WireSock. Nenhuma issue recebeu RESOLVIDA E VALIDADA: os testes comprovam os defeitos delimitados, mas ainda faltam partes dos cenários originais. As limitações estão discriminadas individualmente abaixo.


## Consolidação das hipóteses

| Grupo | Hipótese principal e evidência favorável | Evidência contrária/limite | Confirmação e risco |
|---|---|---|---|
| A | Gates antigos de handshake/probe explicam os rollbacks explícitos #225/#227/#235/#237. Watchdog #238 mostra recovery/rollback após falhas. | #235 realmente observa BR; remover o gate não corrige necessariamente a rota. #238 não contém stack de crash GUI. | `60ba6d4` e `2a800aa` já mudaram essas políticas. Repetir cenários em Windows; não reintroduzir gates para melhorar diagnóstico. |
| B | Scope/perfil efetivo explicam parte dos relatos beta; `6ea3cc0` e `2a800aa` corrigiram escopo e comando do serviço. | #243 tem probes IPv4/IPv6 US e HTTPS OK, áudio e recepção de vídeo funcionam. Isso enfraquece falha geral do túnel; não comprova mídia. #241 muda preferências/perfil com sessão ativa e tem saída MX após seleção US. | Capturar fluxos RTC/UDP e vídeo de cada cenário. Sem interlocutor de teste autorizado, causas de mídia não confirmadas. Nenhum patch especulativo de MTU, retries ou endpoint. |
| C | #240 captura stdout de winget no retorno da função: VM confirmou array de três elementos, em vez de caminho único. | Winget real não foi instalado no teste; foi usado processo/controlador simulado sob PowerShell real. Standalone atual sai com `exit 1` antes dessas funções. | Corrigir somente a saída da função e testar sucesso/erro. Preservar desabilitação do entrypoint. #244: código 2 sugere acesso negado, sem prova de ACL/elevação específica. #236: sem linha ou stack. |
| D | #230 tem stack `__dirname` em ESM 2.0.0; corrigido por `a824018`. Cancelar CAPTCHA atual acessa WebContents destruído e deixa Promise pendente: Electron real FAIL 3/3. | #239 diz após CAPTCHA e não traz stack; cancelamento reproduzido não prova que seja o mesmo cenário. Pacote oficial 2.0.2 contém helper, refutando ausência geral no release como explicação da #229. | Cleanup usa Session capturada antes da destruição. Testar close/destroy/sucesso local em Electron real e Windows. Login completo Proton ainda exige desafio e sessão específicos. |
| E | #228: `ip netns list` pode retornar nome sem sufixo; regex exigia whitespace. Reprodução real: namespace criado, listagem nome puro, guarda falha, segunda criação retorna File exists. Afeta oito consumidores. | `fopen: Permission denied` é uma segunda falha da mesma issue e permanece sem causa. #223 mistura versões e não descreve defeito da sessão atual. | Comparar primeiro campo exato em helper comum; teste real de nome puro/nsid/prefixo e teardown. #233: `00aa8d4` já separou probes sem prompt; confirmar plataforma/cadência sem atribuir logs Tor à rede atual. |

### Auditoria do artefato #229 e updater

Foi baixado, sem executar, o [EXE oficial 2.0.2](https://github.com/bezumiya/GoLiveBypass/releases/download/v2.0.2/GoLiveBypass-2.0.2.exe). SHA-256 coincide com a API: `30fd17ad5416d3f95d4cd2817920dfdef914921c7cccdeb8382fd61443243a49`. O arquivo `app-64.7z` contém `resources/extra/proton-confgen/proton-confgen.exe` (15.620.608 bytes); `resources/app.asar/dist-electron/main.js` procura esse caminho e não contém `__dirname`. Isso não comprova integridade da cópia extraída na máquina do autor; quarentena, arquivo diferente ou resolução local permanecem hipóteses.

A metadata de v2.0.2 consultada contém apenas EXE e AppImage. O [release atual v2.0.4](https://github.com/bezumiya/GoLiveBypass/releases/tag/v2.0.4) contém `latest-linux.yml` e AppImage e está como stable, não draft/prerelease. Os 404 de metadata em #223/#228 e EBUSY updater em #231 são evidências secundárias independentes da rede. Não foi aplicado update remoto para testar.

### Laboratório e baseline

- Windows 11 Pro 10.0.26200, Discord 1.0.9256, GUI 2.0.4 e serviço WireSock Running observados por PowerShell na VM. Perfis existentes foram inventariados sem divulgar chaves.
- Transporte FAT próprio via GUI funcionou sem SSH. Discos preexistentes foram preservados; shares criados pelo tester têm cleanup próprio.
- Baseline Vitest: **25 arquivos / 205 testes PASS**.
- Baseline Linux com kernel WireGuard real: tráfego HTTP antes/depois de falha de readiness e handshake presente, sem teardown: **PASS** (`tests/test-linux-wireguard-diagnostic.sh`). Esse teste usa probe deliberadamente falho e não comprova Proton/Discord.
- #240 antes: função real extraída por AST sob PowerShell Windows, `outputCount=3`, `returnedSinglePath=false`.
- CAPTCHA antes: Electron 43.4.1, close programático em página local, **3/3 FAIL**, `Object has been destroyed`, Promise pendente. Não é teste de serviço CAPTCHA Proton.

### Ownership da implementação

- Worker Linux: `standalone/golivebypass-standalone.sh`, `tests/test-linux-netns-detection.sh`.
- Worker CAPTCHA: somente função de lifecycle em `golive-gui/electron/main.ts` e harness de regressão correspondente.
- Worker standalone Windows: `standalone/GoLiveBypass-Standalone.ps1` e teste PowerShell de saída de função.
- Raiz: relatório, changelog, integração e decisão final. Um tester é dono exclusivo da VM; reviews independentes usam Luna conforme a skill.


## Estado individual ao término da rodada

| Issue | Reprodução / evidência específica nesta rodada | Estado atual |
|---|---|---|
| #223 | Sessão beta sem descrição; erro `wg` ausente pertence ao histórico 2.0.0, não ao preflight beta. 404 updater separado. | NECESSITA MAIS EVIDÊNCIA |
| #224 | Relato beta sem prova de rota/mídia; código mudou depois. | NÃO REPRODUZIDA |
| #225 | Log histórico confirma rollback por readiness; HEAD já não bloqueia por isso. Cenário específico Windows ainda não repetido. | NÃO REPRODUZIDA |
| #227 | Mesmo erro/horários da #225; próprio log registra envio da #225. | DUPLICADA / MESMA CAUSA RAIZ (#225) |
| #228 | `File exists` reproduzido com iproute2 real. Correção de detecção validada por ciclos de namespace/teardown; `fopen` permanece independente e não reproduzido. | CORREÇÃO IMPLEMENTADA — AINDA NÃO VALIDADA integralmente |
| #229 | Helper presente no asset oficial e caminho correto no bundle 2.0.2; ambiente do autor não disponível. | NECESSITA MAIS EVIDÊNCIA |
| #230 | Stack 2.0.0 confirma erro ESM; correção já presente desde 2.0.1 e bundle 2.0.2 sem `__dirname`. Login exato do relato não repetido. | NÃO REPRODUZIDA no código atual |
| #231 | Sem cenário RTC compartilhado autorizado; dados não distinguem UDP/codec/túnel. EBUSY updater é separado. | NÃO REPRODUZIDA |
| #232 | Descrição ambígua e probe central CA não comprova escopo do Discord beta. | NECESSITA MAIS EVIDÊNCIA |
| #233 | Causa plausível de prompt automático já alterada em `00aa8d4`; cadência/UI do relato não repetida. | NÃO REPRODUZIDA |
| #234 | Bloqueio de Go Live relatado apesar de saída US; faltam evidências da sessão Discord. | NÃO REPRODUZIDA |
| #235 | Probe BR e rollback históricos confirmados; não comprovado se a rota atual repete a falha. | NÃO REPRODUZIDA no código atual |
| #236 | É instalador de plugin, não necessariamente standalone WireGuard. `c38d52f` introduziu guardas de Resources/paths e stack de report. Sem linha/stack do autor. | NECESSITA MAIS EVIDÊNCIA |
| #237 | Timeout de helper/gate histórico; atual log-only não demonstra conectividade no cenário do autor. | NÃO REPRODUZIDA no código atual |
| #238 | Recovery/rollback histórico pode explicar fechamento, sem stack de crash GUI. | NECESSITA MAIS EVIDÊNCIA |
| #239 | Defeito relacionado de cancelamento CAPTCHA reproduzido 3/3 no Electron real e corrigido; após patch, 12/12 cenários locais no Linux e 12/12 no Windows. Sucesso no CAPTCHA oficial do relato não reproduzido. | CORREÇÃO IMPLEMENTADA — AINDA NÃO VALIDADA para o relato |
| #240 | Captura de stdout da função reproduzida em Windows. Patch `Out-Host`; 10/10 ciclos com exit 0 e 50/50 verificações pós-patch passaram em PowerShell real. Instalação integral não exercitada; entrypoint atual desabilitado. | CORREÇÃO IMPLEMENTADA — AINDA NÃO VALIDADA |
| #241 | Probes MX posteriores funcionam; áudio/RTC reportado não foi reproduzido. | NÃO REPRODUZIDA |
| #242 | Sugestão de integração com Kaspersky, não defeito. Não rejeita o mérito da sugestão. | INVÁLIDA / NÃO É BUG |
| #243 | HTTP e famílias IP positivas nos logs não comprovam vídeo enviado. Sem participante de teste autorizado. | NÃO REPRODUZIDA |
| #244 | [Win32_Service.Change](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/change-method-in-class-win32-service) define retorno 2 como acesso insuficiente. ACL/elevação do autor desconhecidas; entrypoint standalone atual desabilitado. | BLOQUEADA para validação integral do standalone |

Nenhuma issue foi fechada, comentada ou marcada resolvida no GitHub. Nenhum release, push ou publicação foi realizado. O campo de estado acima pertence somente a este relatório local.


## Verificações finais disponíveis

| Verificação | Resultado | O que comprova |
|---|---|---|
| `npm test` em `golive-gui` | 205/205 PASS, 25 arquivos | Regressões automatizadas existentes; não comprova roteamento do Discord. |
| `npm run compile` em `golive-gui` | PASS | Sync bypass, helper Go, TypeScript e Vite. Não publica artefatos. |
| `bash tests/test-linux-netns-detection.sh` | 10/10 ciclos PASS na revisão final do raiz | Listagem nome puro/NSID, rejeição de prefixo, reutilização e teardown real, em namespaces mount/net privados. Outros ciclos intermediários não são agregados a essa contagem final. |
| `bash tests/test-linux-wireguard-diagnostic.sh` | PASS antes e após patch | Kernel WireGuard real com HTTP/handshake após diagnóstico falho; não é Discord/Proton. |
| Runner `captcha-electron-regression.mjs` no Electron Linux 43.4.1 | 12/12 PASS, exit 0 | 5 closes, 5 destroys, 2 sucessos com token local. Antes: 3/3 FAIL no cancelamento. Não acessa Proton. |
| Mesmo runner no Electron Windows 43.4.1 / VM | 12/12 PASS, exit 0 | 5 closes, 5 destroys, 2 tokens locais; todas as janelas destruídas e nenhum erro não capturado. Não comprova o desafio oficial Proton. |
| `tests/test-standalone-wiresock-output.ps1` / VM Windows | 10/10 ciclos, 50/50 assertions PASS, exit 0 | Função real extraída por AST; stdout e falhas de processo nativo controlado. Não instala WireSock nem executa o entrypoint desabilitado. |
| Sintaxe shell/Node e `git diff --check` | PASS | Integridade dos scripts e whitespace. |
| Review independente Luna — Linux | Sem finding material pendente | Detecção exata, ausência de SIGPIPE e isolamento explícito do teste. |
| Review independente Luna — CAPTCHA/PowerShell | Sem finding estático material pendente | Cleanup, saída de função e correção de falhas dos harnesses; resultados Windows registrados separadamente. |

Preparação do teste CAPTCHA (gera runner autocontido para Linux/Windows):

```sh
cd golive-gui
node scripts/captcha-electron-regression.mjs --prepare /tmp/captcha-regression.cjs
# Executar o runner com Electron real; no Windows definir CAPTCHA_LOG para um caminho local.
```

Runner validado no host e enviado à VM: SHA-256 `3a90fdc621ca3863bb2d3fc7de89e79238b8b6f85464b0ecbcb572b9c0015e25`.

### Riscos e cenários ainda pendentes

- Falhas de vídeo/áudio/RTC: faltam métricas e contraparte controlada autorizada; não há evidência de codec, MTU, UDP, saturação gratuita ou firewall como causa exclusiva.
- #228: cenário de `fopen` não explicado; teste de namespace não comprova todos os ciclos da GUI, sudo, Wayland ou Discord real.
- #239: cancelamento reproduzido/corrigido não equivale ao sucesso no desafio oficial relatado pelo usuário. Timeout completo e rede externa não foram exercitados pelo runner local.
- #244: ReturnValue 2 permite diagnosticar acesso insuficiente, mas não distingue UAC de ACL/política. Não se alterou o serviço real para forçar a falha; port standalone segue indisponível.
- #229: helper existe no pacote publicado, mas não há acesso à extração/quarentena na máquina afetada. O asset foi criado/atualizado em 2026-09-05 03:42 UTC, antes do relato das 04:28 UTC.
- Execução prolongada, perda de conectividade do ambiente do autor, combinação com VPN externa e cada relato histórico não foram comprovados apenas por testes automatizados.
- Não há script de lint no `package.json` atual. Compilação inclui TypeScript; não foi inventado um comando de lint.


### Falhas provocadas e limites das revisões

- Linux: namespace preexistente sem NSID, namespace de nome semelhante, repetição da remoção e falha deliberada de readiness com tráfego WireGuard real preservado.
- CAPTCHA: `close()` e `destroy()` durante operação pendente, além de token de sucesso local. O runner usa AST da função de produção e exige substituições únicas para nunca acessar Proton por falha silenciosa de preparação.
- Standalone: saída nativa no stdout, retorno 17 do simulador, executável ausente e executável já disponível. Não há instalação real do pacote nem mudança de ACL/serviço nesses testes.
- Os reviewers apontaram fragilidades nos testes (isolamento de mounts explícito, saída simulada criando indevidamente o executável e resolução dinâmica de `$candidate`). Os harnesses foram corrigidos e revisados novamente. Tentativas inconclusivas/falhas de harness ficam fora das contagens PASS.

### Evidência Windows e integridade dos testes

O runtime Electron Windows 43.4.1 foi conferido contra o SHASUMS256 oficial: SHA-256 `c2ef9a5f65472c34d14bd3e67b7d14e66b0c01f124aba45263d6a4232160e13a`. O log `captcha-result.log` registra `summary: PASS, cycles: 12`, e `captcha-run-result.txt` registra `exit=0`. A raiz inspecionou esses resultados.

O teste PowerShell usado na VM tem SHA-256 `bd8c74caf6b00ab66a87c257fe00b33fb52a6f0516f80d2c785b74b93f902f06`; a fonte standalone, `032fab3ee8da6672352d0d333727a40eca85973e1e4e48c2b1443646e8e1069c`. As tentativas intermediárias de coleta por `Start-Process` produziram códigos de saída vazios e falha do wrapper apesar das 50 assertions positivas; essas tentativas não são tratadas como sucesso integral do executor.

A coleta final usou `& powershell.exe` e capturou `$LASTEXITCODE` imediatamente: `standalone-10-direct.log` registra **10/10 ciclos exit 0**, **50/50 assertions PASS**, zero FAIL e `overallExit=0` (2026-09-05 23:46:44 -03:00). SHA-256 do log: `f1640496fd145b09f9fe3536f536579c9852bdc934a81ef9f380c5a84449e6ab`. A raiz conferiu contagens, saída final e hashes das fontes testadas.

O tester confirmou a ejeção, destacamento e destruição dos shares próprios e ausência de processos de teste residuais. Discos herdados, sessão Discord e serviço WireSock foram preservados. Não foram executados ciclos adicionais de ativação da GUI nem chamadas/streams com terceiros nesta rodada.
