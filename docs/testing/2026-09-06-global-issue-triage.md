# Rodada de investigação global — 2026-09-06

## Escopo e evidência

Snapshot: upstream `bezumiya/GoLiveBypass`, 22 issues abertas (#223–#245, exceto #226). Origin `pdl-clay/GoLiveBypass`: zero issues abertas. Os endpoints de comentários retornaram listas vazias para todas as 22 issues; nenhum anexo identificável foi incorporado a este relatório. O snapshot e o manifest estão em `/tmp/golive-triage-20260906/` e não são dados de produto.

Este documento é uma atualização local da [triagem de 2026-09-05](2026-09-05-global-issue-triage.md). Resultados desta rodada ficam separados das evidências anteriores. Não houve publicação, push, comentário ou alteração no GitHub. Não são registrados tokens, chaves, contas ou IPs pessoais.

O foco de execução desta rodada é a GUI atual, nas frentes A, B, D e E (17 issues). Tor, plugin e standalone CLI ficam fora do escopo de execução atual; a triagem global permanece aqui como contexto. O shell Linux compartilhado só é exercitado quando integrado ao fluxo da GUI.

## Triagem global

| Issue | Versão/ambiente | Classificação atual | Grupo | Evidência e limite |
|---|---|---|---|---|
| [#223](https://github.com/bezumiya/GoLiveBypass/issues/223) | 2.0.2-beta.3 / Linux x64 | NECESSITA MAIS EVIDÊNCIA | E | Descrição insuficiente; ativação/desativação e updater 404 no histórico. |
| [#224](https://github.com/bezumiya/GoLiveBypass/issues/224) | 2.0.2-beta.3 / Windows x64 | POTENCIALMENTE VÁLIDA | B | Beta ativo sem funcionamento relatado; não há handshake ou prova de mídia. |
| [#225](https://github.com/bezumiya/GoLiveBypass/issues/225) | 2.0.1 / Windows x64 | VÁLIDA — INVESTIGAR | A | Rollback por ausência de handshake observável. |
| [#227](https://github.com/bezumiya/GoLiveBypass/issues/227) | 2.0.1 / Windows x64 | DUPLICADA / RELACIONADA | A | Mesmos horários e erro da #225; o próprio relato referencia a #225. |
| [#228](https://github.com/bezumiya/GoLiveBypass/issues/228) | 2.0.2 / Linux x64 | VÁLIDA — INVESTIGAR | E | `File exists` de namespace reproduzido; `fopen: Permission denied` continua sem causa confirmada. |
| [#229](https://github.com/bezumiya/GoLiveBypass/issues/229) | 2.0.2 / Windows x64 | VÁLIDA — INVESTIGAR | D | `proton-confgen.exe` ausente no ambiente relatado; helper existe no asset oficial auditado. |
| [#230](https://github.com/bezumiya/GoLiveBypass/issues/230) | 2.0.0 / Windows x64 | VÁLIDA — INVESTIGAR | D | `ReferenceError: __dirname` no login; correção existe no código atual, cenário original não repetido. |
| [#231](https://github.com/bezumiya/GoLiveBypass/issues/231) | 2.0.2 / Windows x64 | NÃO REPRODUZÍVEL AINDA | B | Live em loading e updater EBUSY no histórico; log RTC truncado. |
| [#232](https://github.com/bezumiya/GoLiveBypass/issues/232) | 2.0.3-beta.1 / Windows x64 | NECESSITA MAIS EVIDÊNCIA | B | Descrição ambígua; prova central de país não comprova a sessão Discord. |
| [#233](https://github.com/bezumiya/GoLiveBypass/issues/233) | 2.0.2 / Linux x64 | VÁLIDA — INVESTIGAR | E | Pedidos recorrentes de senha; prompts manuais e health automático ainda não foram associados. |
| [#234](https://github.com/bezumiya/GoLiveBypass/issues/234) | 2.0.3-beta.3 / Windows x64 | POTENCIALMENTE VÁLIDA | B | Bloqueio regional apesar de saída direta US; falta prova da rota efetiva da sessão. |
| [#235](https://github.com/bezumiya/GoLiveBypass/issues/235) | 2.0.3 / Windows x64 | VÁLIDA — INVESTIGAR | A | Probes BR e rollback histórico; caminho WireSock antigo. |
| [#236](https://github.com/bezumiya/GoLiveBypass/issues/236) | não informado | FORA DO ESCOPO DE EXECUÇÃO ATUAL | C | Path vazio no instalador; item standalone/CLI, sem versão, linha ou stack suficiente. |
| [#237](https://github.com/bezumiya/GoLiveBypass/issues/237) | 2.0.3 / Windows x64 | VÁLIDA — INVESTIGAR | A | Ativação revertida por probe não comprovado no cenário atual. |
| [#238](https://github.com/bezumiya/GoLiveBypass/issues/238) | 2.0.3 / Windows x64 | NECESSITA MAIS EVIDÊNCIA | A | Watchdog e rollback podem explicar fechamento; não há stack de crash. |
| [#239](https://github.com/bezumiya/GoLiveBypass/issues/239) | 2.0.4 / Windows x64 | POTENCIALMENTE VÁLIDA | D | Erro JavaScript após CAPTCHA; cancelamento local reproduzido, sucesso no desafio oficial não. |
| [#240](https://github.com/bezumiya/GoLiveBypass/issues/240) | standalone / Windows AMD64 | FORA DO ESCOPO DE EXECUÇÃO ATUAL | C | Saída do winget aparece concatenada ao executável retornado; item standalone/CLI. |
| [#241](https://github.com/bezumiya/GoLiveBypass/issues/241) | 2.0.4 / Windows x64 | VÁLIDA — INVESTIGAR | B | Loading/sem áudio; probes posteriores e seleção de perfil não comprovam mídia RTC. |
| [#242](https://github.com/bezumiya/GoLiveBypass/issues/242) | não informado | FORA DO ESCOPO — PROPOSTA | F | Pedido de integração com VPN Kaspersky, proposta de funcionalidade. |
| [#243](https://github.com/bezumiya/GoLiveBypass/issues/243) | 2.0.4 / Windows x64 | NÃO REPRODUZÍVEL AINDA | B | Vídeo enviado preto, áudio e recepção funcionam; HTTP positivo não prova vídeo. |
| [#244](https://github.com/bezumiya/GoLiveBypass/issues/244) | standalone / Windows AMD64 | FORA DO ESCOPO DE EXECUÇÃO ATUAL | C | `Service.Change` retorna 2; item standalone/CLI e contexto de elevação/ACL não está disponível. |
| [#245](https://github.com/bezumiya/GoLiveBypass/issues/245) | 1.1.11 / Tor legado | FORA DO ESCOPO DE EXECUÇÃO ATUAL; NÃO REPRODUZIDA | G | Transporte Tor teve verificação isolada, mas o loading/CtrlR original não foi testado; causa não confirmada. Não agrupar com WireGuard. |

## Grupos, hipóteses e ownership

| Grupo | Issues e hipótese de trabalho | Evidência contra/limite | Ownership e dependências |
|---|---|---|---|
| A — gates/recuperação WireSock | #225, #227, #235, #237, #238: gates antigos explicam rollbacks explícitos. | Remover gate não prova rota; #238 não tem stack de crash. | Raiz/tester Windows; exige cenário de ativação repetido na VM. |
| B — rota efetiva e mídia Discord | #224, #231, #232, #234, #241, #243: escopo, perfil, família IP ou sessão podem divergir. | HTTP, país e handshake não comprovam UDP, codec ou vídeo. Contraparte/canal específico RTC ainda falta. | Raiz/tester Windows; não aplicar patches especulativos de MTU/endpoint. |
| C — instalação/serviço standalone | #236, #240, #244: path vazio, stdout contaminado ou retorno de serviço. | Fora da execução atual; correções anteriores ficam preservadas. | Sem trabalho novo nesta rodada. |
| D — Proton/autenticação/empacotamento | #229, #230, #239: helper, ESM e lifecycle CAPTCHA são sintomas distintos. | Asset oficial contém helper; erro pós-CAPTCHA não identifica etapa. `getBalance` Anti-Captcha autenticou, mas não houve solver/desafio real. Conta Proton de teste foi fornecida, sem divulgar credenciais. | Frente Proton/CAPTCHA; login isolado concluído, CAPTCHA não exercitado. |
| E — namespace/permissões/health Linux | #223, #228, #233: detector antigo falha com nome bare; prompts são subquestão. | `fopen` não reproduzido na fonte atual; não atribuir automaticamente #233 ao detector. | Frente Linux na GUI atual; shell compartilhado só é exercitado por esse fluxo. |
| F — proposta | #242 é solicitação de suporte Kaspersky. | Não há defeito reproduzível a corrigir. | Fora da correção de bugs; decisão de produto separada. |
| G — legado Tor | #245: triagem histórica do caminho Tor 1.1.11. | Fora da execução atual; transporte isolado não testou o loading/CtrlR do relato. | Sem trabalho novo nesta rodada; arquitetura não é WireGuard. |

## Resultados verificáveis desta rodada

O relatório de validação Linux em `/tmp/golive-linux-validation-20260906.md` foi incorporado apenas como resultado resumido: `test-linux-netns-detection.sh` (10 ciclos), `test-linux-diagnostic.sh`, `test-linux-wireguard-diagnostic.sh`, `test-netmode-linux.sh` (16/16) e os testes Vitest Linux (10/10) passaram. O namespace com nome bare foi reproduzido no iproute2 real; a causa confirmada é o falso negativo do detector antigo. `fopen: Permission denied` não foi reproduzido.

Uma rechecagem read-only em 2026-09-06 confirmou 22 issues abertas no upstream e zero no origin, com os mesmos números e timestamps do snapshot (`#245` atualizado em `2026-09-06T02:33:45Z` como o mais recente). Não houve delta; a coleta completa não foi repetida.

A revisão independente Luna dos três patches não encontrou finding material pendente. As verificações estáticas de Bash, Node e `git diff --check` passaram. Essas revisões e testes não comprovam ambientes externos, Proton, Discord ou RTC.

O runner local de CAPTCHA continua sendo teste de lifecycle Electron com token local; não é E2E de CAPTCHA. O `getBalance` Anti-Captcha autenticou validamente, sem criar solver nem executar desafio. Na validação Windows, `npm test` passou com 53/53 testes em 4 arquivos, `npm run compile`, `electron-builder --win --x64 --dir --publish never`, `go test ./...` do helper e `git diff --check` passaram. O artefato e metadados ficam em `/tmp/golive-vm-validation-20260906/` (incluindo `artifact-win-unpacked`, `artifact-metadata.json`, hashes e logs). O `app.asar` do build atual foi confirmado no guest com SHA-256 `42b63b83e3eb45af8c0d73b7f1a94384242dfc84d006c89186d1c2a466dc9e47`. A GUI atual abre na VM; o CDP ficou inconclusivo e não é falha de produto confirmada. O simulador de diagnóstico é explicitamente diagnóstico e não comprova rede. Foram confirmadas cinco transições visuais inativo→ativo do portable (`portable-focus1.png` e os pares dos ciclos 1–5); isso não é PASS de cinco ciclos de rede. O collector Windows foi invocado e exibiu o banner, mas nenhum JSON foi confirmado; o resultado é **INCONCLUSIVO**. O preenchimento de login pela UI/IPC/helper passou em uma tentativa e a GUI exibiu conta conectada e conexão bem-sucedida com servidor selecionado; a revisão independente confirmou a validade desse fluxo sem mocks. O CAPTCHA não apareceu e o Anti-Captcha registrou zero tarefas: o fluxo CAPTCHA/solver não foi exercitado. O bypass não foi avaliado porque o Discord não estava disponível no `LOCALAPPDATA` isolado; isso não comprova rede ou rota ativa. Os metadados do perfil temporário foram coletados e o perfil foi removido: `proton-session.json` (1271 bytes, SHA-256 `6DC3E8305ABFF7E2B7E051163B26C9A7C78DF8B110043E1ACA4D74E10EB57A40`), `settings.json` (515 bytes, SHA-256 `A2615EDDB67C2AC17DD175E8124E8FE166F2F522B67DE3FC1BAB088CF913B800`) e `wireguard.conf` (673 bytes, SHA-256 `3D5C9762F4C79D37E2C359B6D8EBC8415CD9754B2F29D033B674735C2A9D9FB1`). A confirmação visual está em `/tmp/profile-meta-hash.png` e `/tmp/guest-cleanup.png`. O cleanup de perfil, GUI de teste e shares próprios foi concluído; perfis e arquivos preexistentes foram preservados. Os horários dos arquivos foram registrados sem conversão de fuso. Não há baseline do perfil original para afirmar integridade byte a byte. A contraparte/canal específico para RTC ainda falta.

### Evidência adicional do portable atual

O portable `/tmp/golive-current-portable-20260906/GoLiveBypass-2.0.4.exe` tem SHA-256 `30656a2c93756cb94d61d3c0428ff9a95a25bcb17f67745cd691e603c23e31a2`; ele foi produzido com `--publish never` após build bem-sucedido. Cinco transições visuais inativo→ativo foram confirmadas a partir do volume portátil, preservando a conta existente e exibindo o controle de ativação (pares `portable-cycle1` a `portable-cycle5`, além de `portable-focus1.png`). Isso comprova lançamento e ativação visual do portable; não comprova cinco ciclos de rede, estado do serviço, login/CAPTCHA, rota, RTC ou resolução de issue.

Na comparação registrada em `/tmp/golive-appasar-comparison-20260906.txt`, o único arquivo diferente entre os pacotes é `main.js`, correspondente exatamente ao patch de lifecycle da sessão CAPTCHA; UI e preload permaneceram iguais. A extração manual anterior continua inconclusiva e não deve ser confundida com o portable funcional. Não há evidência de bug de GPU nesta rodada.

## Estado individual e próximos passos

| Issue | Estado local nesta rodada | Próximo dado necessário |
|---|---|---|
| #223 | NECESSITA MAIS EVIDÊNCIA | versão/log completo e contexto updater/Linux. |
| #224 | NÃO REPRODUZIDA | rota e sessão Discord observáveis. |
| #225 | NÃO REPRODUZIDA no código atual | ativação WireSock na VM. |
| #227 | DUPLICADA / MESMA CAUSA RAIZ provável (#225) | confirmar cenário comum. |
| #228 | CORREÇÃO DO DETECTOR IMPLEMENTADA; validação integral pendente | reproduzir `fopen`/GUI e teardown completo. |
| #229 | NECESSITA MAIS EVIDÊNCIA | ambiente de instalação/quarentena do autor. |
| #230 | CORREÇÃO PRESENTE; login original não repetido | sessão de login 2.0.0/atual comparável. |
| #231 | NÃO REPRODUZIDA | contraparte RTC e dados completos de loading. |
| #232 | NECESSITA MAIS EVIDÊNCIA | comportamento Discord e região efetiva. |
| #233 | NÃO REPRODUZIDA | distinguir prompt manual de health automático. |
| #234 | NÃO REPRODUZIDA | sessão Discord com bloqueio regional. |
| #235 | NÃO REPRODUZIDA no código atual | cenário WireSock antigo e rota. |
| #236 | FORA DO ESCOPO DE EXECUÇÃO ATUAL | versão, linha e stack do instalador podem ser coletados em rodada standalone futura. |
| #237 | NÃO REPRODUZIDA no código atual | ativação com logs de processo. |
| #238 | NECESSITA MAIS EVIDÊNCIA | stack e evento de fechamento. |
| #239 | CORREÇÃO DE CANCELAMENTO IMPLEMENTADA; relato oficial pendente | desafio Proton real autorizado. |
| #240 | FORA DO ESCOPO DE EXECUÇÃO ATUAL | correção de stdout preservada; instalação integral pertence a rodada standalone futura. |
| #241 | NÃO REPRODUZIDA | fluxo de áudio/RTC comparável. |
| #242 | FORA DO ESCOPO — PROPOSTA | decisão de produto. |
| #243 | NÃO REPRODUZIDA | contraparte e métricas de vídeo autorizadas. |
| #244 | FORA DO ESCOPO DE EXECUÇÃO ATUAL | contexto UAC/ACL e standalone funcional ficam para rodada própria. |
| #245 | FORA DO ESCOPO DE EXECUÇÃO ATUAL; NÃO REPRODUZIDA | transporte Tor isolado não reproduziu o loading/CtrlR do relato; causa não confirmada. |

## Limitações e cuidados

## Atualização da rodada WireSock

O cenário adicional reportado pela usuária foi reproduzido na VM depois do snapshot global: o par EXE/DLL 1.4.7.1, com o perfil atual da GUI, interrompeu HTTPS fora do Discord em 3/3 ciclos; a cópia do mesmo perfil usando somente `AllowedApps` preservou a rede nativa em 9/9 requisições. A GUI corrigida instalou a SDK 3.4.8.1, selecionou o par moderno e passou três ciclos de ativação/desativação com o probe fora do escopo nativo e o probe no diretório do Discord roteado. Isso acrescenta evidência ao grupo de compatibilidade WireSock, mas não fecha nenhuma issue: o IP estrangeiro específico, RTC e todos os cenários das issues continuam sem comprovação individual.

Nenhuma issue foi marcada resolvida. Testes locais não substituem prova de roteamento, mídia Discord, Proton ou Tor. A arquitetura WireGuard atual permanece separada do caminho legado Tor/proxy. Credenciais e tokens usados na validação não são divulgados nem incorporados ao relatório. Um incidente de harness expôs um fragmento de credencial no console local; a execução foi interrompida, e console, capturas, shares e perfil afetados foram removidos, sem submissão. Isso é limitação do harness, não evidência de falha do produto. A GUI original foi reaberta no ambiente Windows normal, com a conta original mascarada e o estado visual esperado; a evidência está em `/tmp/final-original-state.png`. Guest, staging e shares temporários foram limpos, e arquivos preexistentes foram preservados. Não foi coletado hash baseline para afirmar integridade byte a byte. Fault injection da GUI Windows/probe/serviço não foi executada, e não há cenário ou contraparte RTC; portanto não se alegam cinco ciclos de rede nem validação RTC.
