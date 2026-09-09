# Validação do updater stable/beta do plugin

Data: 2026-09-08
Versão do plugin: `2.0.0-beta.1`
Commit da implementação: `7cf3cf6`

## Resultado local

- `cd golive-gui && npm test`: 48 arquivos, 347 testes aprovados.
- `cd golive-gui && npm run check-bypass`: fonte gerada sincronizada.
- `node tests/test-distribution-parity.cjs`: 30 verificações aprovadas.
- `./tests/test-userplugin-e2e.sh`: 44 verificações aprovadas; ZIP, manifest, `update-channel.ts`, SHA-256, extração, backup e rollback conferidos.
- Transpilação sintática dos 8 arquivos TypeScript/TSX do plugin: aprovada.
- O artefato local produzido para a VM tinha 51.818 bytes e SHA-256 `efcc83c1bb114cd409a9187a8729f4ac3fca174e2289037bc26de1cf7d2be9f7`.

## Validação na VM Windows 11

- O ZIP foi copiado para `C:\Users\teste\Equicord\src\userplugins` e os arquivos existentes foram substituídos.
- `pnpm.cmd build`: concluído sem erro; o prompt voltou para `C:\Users\teste\Equicord`.
- `pnpm.cmd inject`: terminou com `Successfully patched ...` e `Success!`.
- O plugin apareceu em Equicord como o único userplugin habilitado.
- O painel mostrou `v2.0.0-beta.1`, botão `Verificar`, canal Estável e atualização automática ligada.
- O seletor exibiu `Estável` e `Beta`; ambos foram selecionados durante o teste.
- O Auto Update foi desligado e ligado novamente; o estado visual respondeu corretamente.
- Ao voltar para Estável, a consulta do updater exibiu erro controlado (`socket hang up`) sem derrubar a tela do Discord.
- Evidências: `/tmp/win11-plugin-update-settings-2.png`, `/tmp/win11-plugin-update-channel-options-2.png`, `/tmp/win11-plugin-update-beta-selected-2.png`, `/tmp/win11-plugin-update-auto-off-2.png`.

Depois da última reinjeção, a inicialização do próprio Discord ficou na tela `Checking for updates…`/`Você sabia que…`. Esse estado pertence ao updater do Discord e não ao updater do GoLiveBypass; por isso a captura final do painel não foi repetida após o hardening nativo. O build e o inject da última fonte ainda foram confirmados.

## Ciclo seguinte: assistente Proton/WireGuard no plugin

Objetivo do ciclo: levar o onboarding para dentro do Discord em duas etapas — sessão
Proton e preparação/otimização da rota — e ligar o feedback visual aos eventos reais do
controlador, sem ativar a VPN ou reiniciar o Discord automaticamente.

- Arquivos alterados: `goLiveBypass/index.tsx`, `goLiveBypass/native.ts`,
  `goLiveBypass/vpn-proton.ts`, `goLiveBypass/COMO-INSTALAR.md`, `CHANGELOG.md` e o
  teste-fonte `golive-gui/tests/plugin-update-ui.test.ts`.
- O painel do updater agora é um cartão dentro do Discord: mostra versão/canal e os
  estados instalada, verificando, disponível, baixando/preparando e pronta para reload
  manual. A ação continua sem foco forçado e sem `app.quit`/`app.relaunch`.
- O assistente valida sessão salva, diferencia sessão inválida de rede/timeout, preserva
  o fluxo de CAPTCHA/2FA existente, permite troca de conta e limpa campos sensíveis após
  login. A etapa de rota acompanha fase, total/testados/aprovados, servidor, ping e
  velocidades somente quando o backend realmente informa esses dados; cancelar não
  inicia túnel nem fecha o Discord.
- A tipagem foi corrigida após o primeiro type-check Windows: validação possivelmente
  nula, campos `null` do updater e a asserção do objeto nativo dinâmico.
- Artefato final enviado à VM: 55.801 bytes, SHA-256
  `477380ccc19a8d7a691a25799cf7eb24f0200461b8d6c909a41deed63de155c0`.
- VM Windows 11/Equicord: `pnpm.cmd testTsc` passou; `pnpm.cmd build` passou; `pnpm.cmd
  inject` concluiu com `Successfully patched` e `Success!`. A pasta instalada continha
  uma única cópia dos 10 arquivos do plugin.
- A abertura visual não foi concluída: o Discord instalado em
  `app-1.0.9256` ficou mais de 35 segundos na tela própria `Checking for updates…`,
  antes de qualquer tela do Equicord. O processo foi encerrado com `taskkill` somente
  para `Discord.exe`; não houve evidência visual suficiente para afirmar o modal em
  runtime. O mesmo bloqueio foi observado depois da rodada final do cartão; o share
  temporário final foi ejetado, destacado e removido.

Próxima ação: validar o cartão não intrusivo de atualização dentro do Discord com estados
disponível, baixando, preparado e reload manual; depois repetir a matriz estável/beta e
capturar a UI quando o updater do Discord da VM estiver funcional.

## Ciclo plugin-only: concorrência, cancelamento e runtime

Data: 2026-09-08. Esta rodada alterou somente o userplugin Discord e seus testes; nenhum
arquivo da GUI foi tocado.

- `goLiveBypass/index.tsx` agora invalida respostas assíncronas antigas ao trocar a conta
  ou fechar o modal, evita modais duplicados, cancela uma otimização em andamento ao
  fechar e mantém o erro de cancelamento recuperável. O cartão usa apenas variantes
  aceitas pelo `Card` do Vencord e não anuncia reinício automático.
- `goLiveBypass/native.ts` recusa uma segunda otimização antes de substituir o estado
  global da primeira. `goLiveBypass/vpn-controller.ts` reserva a operação antes da fila,
  respeita cancelamento imediato e restaura a rota anterior quando necessário.
- `manifest.json` permanece apontando para o repositório canônico
  `bezumiya/GoLiveBypass`; o teste E2E do userplugin valida esse contrato.
- Validação local: `./tests/test-userplugin-e2e.sh` passou com 44 verificações,
  `node --experimental-strip-types tests/test-plugin-stability.mjs` passou com 7,
  `sh -n tests/test-userplugin-e2e.sh` e `git diff --check` passaram.
- Artefato entregue à VM: `golive-plugin-concurrency-final9.zip`, 57.500 bytes,
  SHA-256 `ad879c7d36349cff9f04afbf2a2e761fa8276daa3e162d95ea6de020170166a8`.
- VM Windows 11, checkout `C:\Users\teste\Vencord`: `pnpm.cmd testTsc`,
  `pnpm.cmd build` e `pnpm.cmd inject` concluíram sem erro; a injeção terminou com
  `Successfully patched` e `Success!`. O runtime exibiu o modal do plugin dentro do
  Discord. Sem ProtonVPN instalado na VM, o avanço ficou corretamente em renovação de
  sessão e não iniciou rota falsa; isso limita a prova visual da segunda etapa, mas
  confirma o caminho seguro de recuperação.
- A instalação anterior foi preservada fora de `src\userplugins` em
  `C:\Users\teste\Vencord-vm-backups`; as três mídias temporárias foram ejetadas,
  desanexadas e removidas. O disco preexistente da VM permaneceu intacto.

## Ciclo plugin-only: helper Proton no asset e fluxo real de rota

- Causa confirmada do diagnóstico anterior: o pacote manual usado naquela tentativa
  não continha `bin/win32-x64/proton-confgen.exe`. O workflow oficial já o compilava,
  mas o teste E2E não detectava sua ausência. O teste agora compila o helper Windows x64
  em staging temporário e exige sua presença, extração e integridade; passou com 48
  verificações.
- Artefato completo instalado na VM: `golive-plugin-with-helper-final10.zip`,
  12.021.772 bytes, SHA-256
  `2d777a53685a0b35cc3cab0fd3b566156dd3d618583ae679d559c15573a615a7`.
- Na VM, o pacote completo passou novamente por `pnpm.cmd testTsc`, `pnpm.cmd build` e
  `pnpm.cmd inject`. A janela real do Discord reconheceu a sessão Proton persistida como
  válida e abriu a página 2 do onboarding (“Rota WireGuard”) sem solicitar a senha.
- Ao acionar “Otimizar rota”, o controlador detectou WireSock ativo por outro perfil,
  pela GUI ou por outro plugin e recusou a operação. Esse resultado é o comportamento de
  isolamento esperado: nenhum túnel externo foi assumido ou parado. Evidências sanitizadas:
  `/tmp/win11-plugin-helper-runtime-final10.png`,
  `/tmp/win11-plugin-helper-route-page-final10.png` e
  `/tmp/win11-plugin-helper-route-running-final10.png`.
- O Discord foi fechado, a mídia temporária foi ejetada/desanexada/removida e somente o
  share preexistente `sdc` permaneceu. A página 2 foi validada visualmente; a seleção de
  servidor e a aplicação de uma rota própria continuam não comprovadas nesta VM porque
  existe um WireSock externo ativo, uma limitação de laboratório e não uma falha que o
  plugin deva contornar.

## Limitação de release

Não houve download real de atualização: as releases existentes em `pdl-clay/GoLiveBypass` não continham os assets `goLiveBypass-vencord.zip` e `.sha256`. Publicar uma release ou enviar mensagem no canal Discord não estava autorizado para esta validação. O caminho real de download permanece coberto por seleção de canal, HTTPS, limite de tamanho, SHA-256, manifest, rejeição de links simbólicos, backup, rollback e reload manual.

O share FAT temporário usado na última rodada foi ejetado no Windows, destacado e removido. O disco preexistente da VM não foi alterado.

## Ciclo plugin-only: resolução do checkout pelo updater

Data: 2026-09-08. A correção ficou restrita a `goLiveBypass/native.ts` e aos testes do
userplugin. O updater falhava no runtime porque aceitava apenas `dist/desktop`, enquanto
o processo injetado da VM rodava fora desse diretório. `userpluginSource()` agora considera
raízes explicitamente informadas, `process.cwd()` e ancestrais do runtime, mas só aceita um
candidato que contenha `package.json` e o `manifest.json` do GoLiveBypass.

- `tests/test-plugin-update-channel.mjs`: 7/7 casos de SemVer, stable/beta, sem downgrade
  e candidatos sem artefatos.
- `./tests/test-userplugin-e2e.sh`: 48/48, incluindo helper Windows x64 no ZIP, SHA-256,
  extração e rollback; `node --experimental-strip-types tests/test-plugin-stability.mjs`:
  7/7; `cd tools/proton-confgen && go test ./...`: aprovado.
- Artefato completo instalado na VM: `golive-plugin-updater-path-final11.zip`, 12.022.128
  bytes, SHA-256 `3a76ef8f9a95e70ccb7950c933a6788f6ede1595f2453861e98b003bea5ee379`.
- VM Windows 11/Vencord: `pnpm.cmd testTsc`, `pnpm.cmd build` e `pnpm.cmd inject`
  concluíram sem erro. O runtime reconheceu a sessão Proton persistida e, no cartão do
  plugin, a consulta automática/manual deixou de exibir o erro de localização; mostrou
  `v2.0.5 pronta; recarregue o Discord`, sem reiniciar o Discord automaticamente. Evidências:
  `/tmp/win11-plugin-final11-updater-card.png` e
  `/tmp/win11-plugin-final11-updater-manual-check.png`.
- O share `sdd` foi ejetado, desanexado e removido; o share preexistente `sdc` permaneceu
  intacto. Não houve edição, build ou teste da GUI nesta rodada.

Limitação mantida: a VM tem WireSock externo ativo, então o teste de aplicação de rota
continua corretamente recusado por isolamento. A atualização preparada não foi aplicada
nem houve publicação de release; a política exige reload manual e a validação desta rodada
foi do caminho de descoberta e do estado do updater.

## Ciclo plugin-only: toast customizado e reinício explícito

Data: 2026-09-08.

- `goLiveBypass/index.tsx` exibe a atualização preparada em toast acessível no rodapé,
  deduplicado por versão, com `Depois` e `Recarregar Discord`. A atualização automática
  continua sem reiniciar o Discord por conta própria.
- `goLiveBypass/native.ts` e `goLiveBypass/vpn-controller.ts` conectam o segundo botão a
  um reinício explícito do processo: a rota própria é restaurada antes do relaunch; erro
  de limpeza impede o reinício; WireSock externo é preservado e não é assumido nem parado.
- Validações locais: `tests/test-plugin-update-notification.mjs` 4/4;
  `tests/test-plugin-update-channel.mjs` 7/7; `tests/test-plugin-stability.mjs` 7/7;
  `./tests/test-userplugin-e2e.sh` 48/48; `git diff --check` aprovado.
- Artefato final14: `/tmp/golive-plugin-final14.zip`, 5.996.846 bytes, SHA-256
  `baa07e5fc7219faec4bb203a7ceaf47d2ae2510eee0ed164ec1445ad95e3788`; o helper Proton
  Windows x64 está incluído. Na VM Windows 11, `pnpm.cmd testTsc`, `pnpm.cmd build` e
  `pnpm.cmd inject` concluíram sem erro. Evidências: `/tmp/win11-plugin-final14-tsc.png`,
  `/tmp/win11-plugin-final14-build.png` e `/tmp/win11-plugin-final14-inject.png`.
- A VM confirmou visualmente o toast, o adiamento e o retorno do Discord após o reinício
  explícito. O cartão também confirmou a detecção de WireSock externo sem apropriação:
  `/tmp/win11-plugin-toast-before-reload-click-15s.png`,
  `/tmp/win11-plugin-toast-dismissed-final12.png` e
  `/tmp/win11-plugin-final14-card2.png`.
- Os três shares temporários desta rodada foram ejetados, desanexados e removidos; o
  share persistente `sdc` permaneceu intacto. Nenhum arquivo do `golive-gui` foi editado,
  compilado ou testado nesta rodada.

Limitação mantida: a aplicação de uma rota própria e a instalação de um asset remoto real
não foram afirmadas como concluídas nesta rodada. A VM mantém WireSock externo ativo e não
havia asset de release autorizado para publicação; os fluxos locais de preparo, validação,
toast, rollback e reinício explícito permanecem cobertos.

## Ciclo plugin-only: DPAPI, transporte seguro e sessão temporária (final17)

Data: 2026-09-08. Esta rodada permaneceu restrita ao userplugin Discord e ao helper Proton
Windows x64; nenhum arquivo da GUI foi editado, compilado ou testado.

- `goLiveBypass/vpn-proton.ts` não envia senha, 2FA ou CAPTCHA na linha de comando. O helper
  recebe um envelope JSON privado por stdin, limitado a 32 KiB, e o teste de fonte confirma
  que os segredos não aparecem nos argumentos.
- O helper grava a sessão Proton com DPAPI no escopo do usuário Windows, migra o JSON legado
  no primeiro acesso e expõe ao plugin apenas o username por `-session-username`; o renderer
  não interpreta tokens no arquivo persistido.
- A verificação diferencia HTTP 401 de falha temporária: rede/5xx mantém o cache e agora
  retorna ao plugin uma mensagem de retry, em vez de “sessão expirada”. Testes Go cobrem a
  distinção e a preservação do arquivo.
- Validação local: `go test ./...`; `GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go test -run '^$' ./...`;
  build Windows x64 do helper; `tests/test-plugin-secret-transport.mjs` 9/9;
  `tests/test-plugin-update-notification.mjs` 4/4; `tests/test-plugin-update-channel.mjs`
  7/7; `tests/test-plugin-stability.mjs` 7/7; `./tests/test-userplugin-e2e.sh` 48/48;
  `git diff --check`.
- Artefato completo montado para a VM: `/tmp/golive-plugin-vm-final17.Otcooj/goLiveBypass-vencord.zip`,
  6.004.070 bytes, SHA-256
  `30e482ac38e444d205bd06711c8cad3ab1717004030d7246ac4df488a0bc34b2`. O helper Windows x64
  incluído mede 15.036.416 bytes.
- Na VM, o pacote foi instalado e o manifest confirmou `2.0.0-beta.1`. `pnpm.cmd testTsc`
  e `pnpm.cmd build` passaram. A reinjeção da última cópia não foi forçada porque o Discord
  estava usando o `app.asar` durante a call; a mesma base do plugin já havia passado por
  `pnpm.cmd inject` e runtime na rodada final16. O helper final17 foi executado diretamente
  com a sessão persistida e retornou JSON `success: true` para `-session-username`.
- No runtime visual já validado, o onboarding chegou à página de rota; ao iniciar a
  otimização, o plugin mostrou “WireSock já está ativo por outro perfil, pela GUI ou por
  outro plugin” e terminou com “otimização falhou”. A call e o compartilhamento de tela
  permaneceram ativos. Essa recusa é a proteção de isolamento esperada, não aplicação de
  uma rota própria.
- O share temporário final17 foi ejetado, destacado e removido após a coleta; o share
  persistente `sdc` não foi alterado. A reinjeção completa e a aplicação de rota
  própria continuam limitadas pelo processo Discord ativo e pelo WireSock externo.

## Ciclo plugin-only: classificação de retry em português (final18)

Data: 2026-09-08.

- O classificador de sessão do plugin agora reconhece também `temporariamente`, `rede` e
  `servidor` na resposta localizada do helper, mantendo `NETWORK_ERROR`/retry em vez de
  cair no estado genérico.
- `tests/test-plugin-secret-transport.mjs`: 10/10; `go test ./...`; teste de compilação
  Windows x64; `./tests/test-userplugin-e2e.sh`: 48/48; `git diff --check` aprovado.
- Artefato final18 instalado no checkout da VM:
  `/tmp/golive-plugin-vm-final18.eI1JV4/goLiveBypass-vencord.zip`, 6.004.080 bytes,
  SHA-256 `3aa21d421b4569600a818007f2f427188ee10461491effc6796a9abc6a6b5236`.
  `pnpm.cmd testTsc` e `pnpm.cmd build` passaram; a reinjeção não foi forçada porque o
  Discord continuava usando o `app.asar` durante a call.
- A mídia final18 foi ejetada, destacada e removida; `sdc` permaneceu intacto. Nenhuma
  alteração foi feita no `golive-gui`.

## Ciclo plugin-only: allowlist do updater para GitHub/CDN (final19)

Data: 2026-09-08. A rodada ficou restrita a `goLiveBypass/native.ts`, ao teste do
updater e à validação do userplugin na VM.

- O updater agora aceita somente `api.github.com`, `github.com` e os hosts oficiais de
  assets do GitHub (`release-assets.githubusercontent.com`,
  `objects.githubusercontent.com` e `github-releases.githubusercontent.com`). Os assets
  também precisam apontar para `/bezumiya/GoLiveBypass/releases/download/`; HTTPS sozinho
  não é mais suficiente.
- A API pública do repositório foi consultada e o redirect real do asset está em
  `release-assets.githubusercontent.com`, coberto pela allowlist. Nenhum ZIP remoto foi
  aplicado ou publicado nesta validação.
- Validação local: `tests/test-plugin-update-notification.mjs` 5/5;
  `tests/test-plugin-update-channel.mjs` 7/7; `tests/test-plugin-secret-transport.mjs`
  10/10; `tests/test-plugin-stability.mjs` 7/7; `./tests/test-userplugin-e2e.sh` 48/48;
  `git diff --check` aprovado.
- Artefato final19 montado e instalado na VM:
  `/tmp/golive-plugin-vm-final19.tVfIlY/goLiveBypass-vencord.zip`, 6.004.261 bytes,
  SHA-256 `bab2b8178d942b27daa2759b078b67864d14c5825520c05d9d8a5c6ef6f1de03`.
  O manifest permaneceu em `2.0.0-beta.1`; `pnpm.cmd testTsc` e `pnpm.cmd build`
  passaram na instalação do Vencord.
- `pnpm.cmd inject` foi tentado uma vez após o build, mas falhou no `app.asar` com
  `Access is denied`; a VM ainda mantém processos Vencord/Equicord/Legcord usando os
  arquivos. Nenhum processo foi encerrado para preservar a sessão e o compartilhamento
  existentes. Como alternativa isolada, um clone em
  `C:\Users\teste\Discord-plugin-test-final19` aceitou `pnpm.cmd inject` com sucesso.
- O clone abriu o Discord com o plugin carregado: a busca em Plugins encontrou
  `GoLiveBypass`, o modal exibiu o cartão de atualização e o seletor `Estável/Beta`.
  O teste alternou para `Beta` e voltou para `Estável`, mantendo `Auto Update` ligado;
  nenhuma rota WireGuard foi ativada nesse clone para não disputar o WireSock externo.
- O `Auto Update` também foi desligado e religado visualmente; após reabrir o modal,
  `Estável` e a chave ligada permaneceram persistidos. O cartão continuou distinguindo
  atualização preparada (`v2.0.5`) de reinicialização manual necessária.
- O share temporário final19 foi ejetado no Windows, destacado e removido após a coleta;
  o share persistente `sdc` não foi alterado. Nenhum arquivo da GUI foi editado,
  compilado ou testado.

## Ciclo plugin-only: validação final20 da segurança do updater

Data: 2026-09-08.

- A lógica de segurança do updater foi isolada em `goLiveBypass/update-security.ts` e
  conectada ao downloader nativo. Metadata e redirecionamentos exigem HTTPS e hosts
  oficiais do GitHub; assets precisam ainda pertencer ao caminho de release
  `bezumiya/GoLiveBypass`. O teste cobre host malicioso, HTTP, caminho de repositório
  incorreto, CDN oficial e redirect relativo.
- Validação local: `tests/test-plugin-update-notification.mjs` 5/5;
  `tests/test-plugin-update-channel.mjs` 7/7;
  `tests/test-plugin-secret-transport.mjs` 10/10;
  `tests/test-plugin-stability.mjs` 7/7; `./tests/test-userplugin-e2e.sh` 51/51;
  `go test ./...`; compilação de teste `GOOS=windows GOARCH=amd64 CGO_ENABLED=0`;
  `git diff --check` aprovado.
- Artefato final20: `/tmp/golive-plugin-vm-final20.0jN80c/goLiveBypass-vencord.zip`,
  6.004.633 bytes, SHA-256
  `7709f7fb6bc55bcb54a1127ad9138c3f4b866f06c838a6271ed35c5d21f6b695`.
  O ZIP contém `update-security.ts`, o manifest `2.0.0-beta.1` e o helper Proton
  Windows x64; a extração, os hashes e o rollback passaram no E2E.
- Na VM Windows 11, o pacote final20 foi instalado no checkout de teste do Vencord,
  com backup da versão anterior. `pnpm.cmd testTsc` e `pnpm.cmd build` passaram. A
  reinjeção no Discord em execução não foi forçada porque o `app.asar` continua usado
  pela sessão/call ativa; o runtime visual do pacote final19 já havia confirmado o
  seletor Estável/Beta, Auto Update e persistência. O final20 não foi afirmado como
  carregado no runtime.
- O share temporário final20 foi ejetado, destacado e removido; `sdc` e `sde` foram
  preservados. Nenhum arquivo da GUI foi editado, compilado ou testado.

Limitações mantidas: não houve publicação nem aplicação de ZIP remoto, CAPTCHA/2FA
real ou ativação de rota própria nesta rodada. A VM mantém WireSock externo e a
instalação original do Discord bloqueia `pnpm.cmd inject`; isso foi registrado sem
encerrar processos da call.

## Ciclo plugin-only: endurecimento de URL do updater (final21)

Data: 2026-09-08.

- O updater passou a rejeitar também credenciais, porta explícita e traversal
  codificado em URLs de atualização. A rejeição do traversal ocorre antes do parser
  normalizar `%2e`, `%2f` ou `%5c`; hosts continuam validados por igualdade exata com
  GitHub/CDNs oficiais e assets continuam limitados ao caminho de release do repositório.
- Após a correção guiada por um teste que falhou, a validação local passou novamente:
  updater 5/5, canal 7/7, transporte de segredos 10/10, estabilidade 7/7,
  E2E do userplugin 51/51, `go test ./...`, compilação de teste Windows x64 e
  `git diff --check`.
- Artefato final21: `/tmp/golive-plugin-vm-final21.mymDqk/goLiveBypass-vencord.zip`,
  6.004.703 bytes, SHA-256
  `e4ca47e4fe9b37b9978b1c8d690dff088d03e5c7318e5ee1258446156cfcc03f`.
- O final21 foi instalado no checkout de teste do Vencord na VM com backup do plugin
  anterior; `pnpm.cmd testTsc` e `pnpm.cmd build` passaram sem erro. A reinjeção do
  Discord em execução não foi feita para preservar a call e o compartilhamento ativos;
  o teste de runtime permanece o final19 documentado acima, enquanto a mudança final21
  está coberta pelo teste executável e pelo build Windows.
- O share temporário final21 foi ejetado, destacado e removido; os shares persistentes
  da VM permaneceram intactos. Nenhum arquivo da GUI foi editado, compilado ou testado.

## Ciclo plugin-only: compatibilidade do feed público e manifest oficial (final22)

Data: 2026-09-08.

- A inspeção do feed real encontrou `v2.0.6-beta-4` com ZIP e SHA-256 compatíveis,
  manifest `2.0.6-beta-4` e updater `bezumiya/GoLiveBypass`. O asset beta tem
  5.649.126 bytes e SHA-256
  `66656a22119260664b422ea2042a057f9e4b6788c887434adf9859da5333f274`.
- A inspeção do stable `v2.0.5` público revelou incompatibilidade confirmada: além de
  `manifest.updater.id = pdl-clay/GoLiveBypass`, o `native.ts` aponta para
  `https://api.github.com/repos/pdl-clay/GoLiveBypass/releases/latest`. O updater do
  plugin agora rejeita esse asset antes da instalação, evitando migração silenciosa
  para o fork de testes. Nenhum asset remoto foi aplicado.
- `goLiveBypass/update-security.ts` passou a validar nome, tipo, repositório e asset do
  manifest; o teste executável também cobre essa ligação em `readManifest()`. A suíte
  local passou: updater 5/5, canal 7/7, transporte 10/10, estabilidade 7/7, E2E 51/51,
  `go test ./...`, compilação Windows x64 e `git diff --check`.
- Artefato final22 instalado no checkout de teste Vencord da VM:
  `/tmp/golive-plugin-vm-final22.zq0dyW/goLiveBypass-vencord.zip`, 6.004.895 bytes,
  SHA-256 `267425682323bc8dbab54fc9a4e24ede64c53272d2bed5f682e5cad37e216f22`.
  `pnpm.cmd testTsc` e `pnpm.cmd build` passaram. A reinjeção do Discord em execução
  continua não sendo feita para preservar a call ativa; o runtime final19 permanece
  como a evidência visual anterior.
- O share temporário final22 foi ejetado, destacado e removido; os shares persistentes
  da VM foram preservados. Nenhum arquivo da GUI foi editado, compilado ou testado.

Próxima ação independente: concluir a decisão do onboarding para o modo customizado.
A correção do feed stable exige um asset de produção com metadata `bezumiya`; publicar
ou alterar releases não está autorizado por este objetivo.

## Ciclo plugin-only: política explícita nos botões Stable/Beta (final23)

Data: 2026-09-08.

- Os comandos manuais `Verificar` e `Atualizar` agora enviam diretamente ao processo
  nativo o canal e a preferência atuais (`selectedUpdatePolicy`). Isso elimina a corrida
  entre a troca do seletor e o `configurePluginUpdates()` assíncrono; o canal escolhido
  passa a ser respeitado mesmo se o clique ocorrer imediatamente.
- A regressão de integração confirma que os dois botões usam essa política, além dos
  testes já existentes de SemVer, opt-in beta, sem downgrade e artefatos compatíveis.
  Validação local final: updater 5/5, canal 7/7, transporte 10/10, estabilidade 7/7,
  E2E 51/51, `go test ./...`, compilação Windows x64 e `git diff --check`.
- Artefato final23 instalado no checkout de teste do Vencord na VM:
  `/tmp/golive-plugin-vm-final23.hC8Ka2/goLiveBypass-vencord.zip`, 6.004.916 bytes,
  SHA-256 `ed74e55d4083e4f38833e0c05a6131e7b5bbd2b61e196e043045caf28d4659e4`.
  `pnpm.cmd testTsc` e `pnpm.cmd build` passaram; não houve reinjeção no Discord em
  execução para preservar a call e o compartilhamento ativos.
- A inspeção do feed público atual continua registrando beta `v2.0.6-beta-4` como
  compatível e stable `v2.0.5` como asset legado do fork `pdl-clay`; o fail-closed do
  final22 impede instalação incorreta. Nenhum ZIP remoto foi aplicado ou publicado.
- O share temporário final23 foi ejetado, destacado e removido; os shares persistentes
  permaneceram intactos. Nenhum arquivo da GUI foi editado, compilado ou testado.

## Ciclo plugin-only: onboarding de WireGuard personalizado (final24)

Data: 2026-09-08.

- O onboarding agora mantém duas etapas nos dois modos. No modo Proton, a primeira
  continua validando a conta; no modo customizado, ela informa que não há login Proton
  e a segunda valida o `.conf` configurado antes de mostrar a conclusão. O painel da
  VPN também esconde credenciais Proton quando `vpnMode = custom`, mas conserva ativar,
  restaurar rede e testar `.conf`.
- O estado exibido para o modo customizado foi separado semanticamente de “otimização”:
  a UI informa “pronto para validar”, “configuração validada” ou “validação falhou”, sem
  inventar ping, download ou upload. A validação continua independente da ativação do
  túnel.
- Validação local: onboarding 3/3, updater 5/5, canal 7/7, transporte de segredos
  10/10, estabilidade 7/7, E2E do userplugin 51/51, `go test ./...`, compilação de
  teste Windows x64 e `git diff --check` aprovados.
- Artefato final24 montado com o helper Windows x64:
  `/tmp/golive-plugin-vm-final24.64UIkj/goLiveBypass-vencord.zip`, 6.005.658 bytes,
  SHA-256 `ca4df603dee5a2a438d05b3e48ec3f70fa5156fb9dc22d188c7f6b1b0ca0005b`.
- O pacote foi extraído no checkout de teste Vencord da VM; `pnpm.cmd testTsc` e
  `pnpm.cmd build` passaram. A mudança customizada foi validada por teste de fonte e
  compilação Windows; não houve reinjeção nem reinício do Discord em call, portanto a
  UI customizada deste final24 ainda não tem evidência visual runtime independente.
- O share temporário final24 foi ejetado, destacado e removido; `sdc` e `sde` foram
  preservados. Nenhum arquivo da GUI foi editado, compilado ou testado.

## Ciclo plugin-only: ajuste de texto e revalidação Windows (final25)

Data: 2026-09-08.

- Corrigida a mensagem da primeira etapa customizada para não sugerir que a validação
  acontece antes de abrir a segunda etapa; o comportamento continua sendo validar o
  `.conf` na etapa 2, antes da conclusão.
- Validação local repetida: onboarding 3/3, updater 5/5, canal 7/7, transporte de
  segredos 10/10, estabilidade 7/7 e E2E do userplugin 51/51. O helper também passou
  em `go test ./...` e na compilação de teste Windows x64.
- Artefato final25:
  `/tmp/golive-plugin-vm-final25.NXZu4R/goLiveBypass-vencord.zip`, 6.005.654 bytes,
  SHA-256 `2d4886f7c44ff0187b518e2c15beddb727a42b0d0ffd7d69104f869feb315551`.
- O final25 foi extraído no checkout de teste Vencord da VM Windows 11; `pnpm.cmd testTsc`
  e `pnpm.cmd build` passaram. A instância Discord em call não foi
  reinjetada nem reiniciada, então a mudança de texto não foi declarada como runtime.
- O share temporário final25 foi ejetado, destacado e removido; os shares persistentes
  foram preservados. Nenhum arquivo da GUI foi editado, compilado ou testado.

## Ciclo plugin-only: adiamento persistente do overlay (final26)

Data: 2026-09-08.

- O botão `Depois` do overlay agora grava a versão pendente e um adiamento de seis horas
  no armazenamento do plugin. O aviso fica suprimido apenas para aquela versão e janela;
  o card de atualização nas configurações continua visível e uma versão nova pode avisar.
- O teste de regressão do overlay passou de 5/5 para 6/6, cobrindo persistência por versão
  e expiração do adiamento. Onboarding 3/3, canal 7/7, segredos 10/10, estabilidade 7/7,
  E2E do userplugin 51/51, `go test ./...`, compilação de teste Windows x64 e
  `git diff --check` também passaram.
- Artefato final26:
  `/tmp/golive-plugin-vm-final26.4VafIE/goLiveBypass-vencord.zip`, 6.005.839 bytes,
  SHA-256 `d9eeb313ae92ffa8224d64487b336f8ec0b909fe46ed1101d5048fac117950f1`.
- O pacote foi extraído no checkout de teste Vencord da VM Windows 11; `pnpm.cmd testTsc`
  e `pnpm.cmd build` passaram com o prompt retornado. A instância em call não foi
  reinjetada nem reiniciada; a mudança está comprovada por teste de fonte e build do
  plugin, mas não por uma nova interação runtime para não interromper a sessão.
- O share temporário final26 foi ejetado, destacado e removido; `sdc` e `sde` foram
  preservados. A checagem do escopo encontrou alterações externas já existentes em
  `golive-gui/electron/logger.ts` e `golive-gui/tests/logger.test.ts`; elas não foram
  tocadas, compiladas ou testadas nesta rodada.

## Ciclo plugin-only: concorrência entre políticas Stable/Beta (final27)

Data: 2026-09-08.

- Os voos nativos do updater agora carregam uma chave de política (`canal` + habilitação).
  Uma verificação Stable não reutiliza mais o resultado de uma verificação Beta em curso;
  se uma instalação de outro canal já estiver em andamento, a segunda é recusada com
  erro explícito para evitar substituir o plugin duas vezes.
- Validação local: onboarding 3/3, updater 7/7, canal 7/7, transporte de segredos 10/10,
  estabilidade 7/7, E2E do userplugin 51/51, `go test ./...`, compilação de teste
  Windows x64 e `git diff --check` aprovados.
- Artefato final27:
  `/tmp/golive-plugin-vm-final27.5rwcXF/goLiveBypass-vencord.zip`, 6.006.081 bytes,
  SHA-256 `3ad787db4e695ccc45d64edb1011f8b51baaae1288e504d41bebfa26e4e5317b`.
- O final27 foi instalado no checkout de teste Vencord da VM; `pnpm.cmd testTsc` e
  `pnpm.cmd build` passaram. O prompt retornou sem erro e o share foi ejetado, destacado
  e removido. A instância em call não foi reinjetada nem reiniciada.
- Permanecem somente alterações externas preexistentes em `golive-gui`; nenhum arquivo
  da GUI foi tocado, compilado ou testado por este ciclo.

## Ciclo plugin-only: recuperação do estado de erro automático (final28)

Data: 2026-09-08.

- O updater agora limpa `pluginUpdateLastError` após uma checagem automática bem-sucedida
  e também após uma instalação automática bem-sucedida. Uma falha transitória não deixa o
  painel preso no estado “atualização falhou” depois que o canal se recupera.
- Validação local: onboarding 3/3, updater 8/8, canal 7/7, transporte de segredos 10/10,
  estabilidade 7/7, E2E do userplugin 51/51, `go test ./...`, compilação de teste
  Windows x64 e `git diff --check` aprovados.
- Artefato final28:
  `/tmp/golive-plugin-vm-final28.uYtxXq/goLiveBypass-vencord.zip`, 6.006.090 bytes,
  SHA-256 `9bc192291025dc2ecf0a9b92b086addcd731c1ecbbfe29d5a8daa10d5a653a62`.
- O pacote foi extraído no checkout Vencord da VM Windows 11; `pnpm.cmd testTsc` e
  `pnpm.cmd build` passaram com o prompt retornado. O share foi ejetado, destacado e
  removido; a call/instância Discord não foi reiniciada nem reinjetada.
- Há alterações externas preexistentes em `golive-gui`; elas foram apenas observadas e
  não foram tocadas, compiladas ou testadas nesta rodada.

## Ciclo plugin-only: lifecycle tolerante sem bridge (final29)

Data: 2026-09-08.

- `start`, `stop` e o registro de eventos agora verificam a existência das funções do
  bridge nativo antes de encadear `Promise`. Ambientes de teste ou carregamentos sem
  helper não quebram com `TypeError` ao iniciar, parar ou registrar o plugin.
- Validação local: lifecycle 1/1, onboarding 3/3, updater 8/8, canal 7/7, transporte
  de segredos 10/10, estabilidade 7/7, E2E do userplugin 51/51, `go test ./...`,
  compilação de teste Windows x64 e `git diff --check` aprovados.
- Artefato final29:
  `/tmp/golive-plugin-vm-final29.5lhY0U/goLiveBypass-vencord.zip`, 6.006.119 bytes,
  SHA-256 `5630363c085d0d142943609ccc7a881242c608e923551d263c0a4d4489c6f7b3`.
- O final29 foi extraído no checkout de teste Vencord da VM Windows 11; `pnpm.cmd
  testTsc` e `pnpm.cmd build` passaram com o prompt retornado. Não houve reinjeção
  nem reinício do Discord em call, preservando a sessão ativa.
- O share temporário final29 foi ejetado, destacado e removido; `sdc` e `sde` foram
  preservados. Nenhum arquivo da GUI foi editado, compilado ou testado por este ciclo;
  qualquer alteração existente nessa área permaneceu fora do escopo.

## Ciclo plugin-only: reaviso após adiamento e isolamento de status (final30)

Data: 2026-09-08.

- O botão `Depois` agora libera a deduplicação em memória; o aviso continua suprimido
  pela versão e pelo prazo persistidos e pode reaparecer depois da expiração enquanto o
  painel estiver fazendo polling.
- O updater nativo agora associa erros à revisão da política Stable/Beta. Conclusões
  atrasadas de uma política anterior não sobrescrevem o status do canal atualmente
  selecionado, inclusive após uma troca rápida de canal e retorno.
- Validação local: updater 8/8, onboarding 3/3, lifecycle 1/1, E2E do userplugin
  51/51 e `git diff --check` aprovados.
- Artefato final30:
  `/tmp/golive-plugin-vm-final30.EYU7hW/goLiveBypass-vencord.zip`, 6.006.386 bytes,
  SHA-256 `0fb50cd9ad12d43a76db38c1812bd2d2b4597bca6228c249926025d89005950c`.
- O pacote foi extraído no checkout de teste Vencord da VM Windows 11; `pnpm.cmd
  testTsc` e `pnpm.cmd build` passaram. A instância Discord em call não foi reinjetada
  nem reiniciada.
- O share temporário final30 foi ejetado, destacado e removido; `sdc` e `sde` foram
  preservados. Nenhum arquivo da GUI foi editado, compilado ou testado por este ciclo.

## Ciclo plugin-only: reutilização do cache Proton sem diferenciação de caixa (final31)

Data: 2026-09-08.

- O helper Proton agora compara o identificador salvo com `EqualFold` e ignora espaços
  externos ao carregar a sessão. A mesma conta continua reutilizando o cache quando a
  capitalização digitada na UI muda, sem apagar ou renovar credenciais por engano.
- Regressão adicionada para salvar `Account@Example.com` e carregar com
  `account@example.COM` cercado por espaços. Validação: `go test ./...`, compilação de
  teste Windows x64, updater 8/8, onboarding 3/3, lifecycle 1/1, E2E 51/51 e
  `git diff --check` aprovados.
- Artefato final31:
  `/tmp/golive-plugin-vm-final31.ZnNGTF/goLiveBypass-vencord.zip`, 6.006.809 bytes,
  SHA-256 `12d3a21798f4704af25f2361c7d2876821607f75ad81de5f70760bd1efebf2dd`.
- O pacote foi extraído no checkout de teste Vencord da VM Windows 11; `pnpm.cmd
  testTsc` e `pnpm.cmd build` passaram. A call/instância Discord não foi reinjetada
  nem reiniciada.
- O share temporário final31 foi ejetado, destacado e removido; `sdc` e `sde` foram
  preservados. Nenhum arquivo da GUI foi editado, compilado ou testado por este ciclo.

## Ciclo plugin-only: fechamento tolerante do onboarding (final32)

Data: 2026-09-08.

- O fechamento do modal agora só tenta cancelar a otimização quando o método nativo
  realmente existe. Isso evita que um bridge parcial transforme o botão de fechar em
  um `TypeError` e deixe a interface presa.
- Validação local: lifecycle 1/1, onboarding 3/3, updater 8/8, E2E do userplugin
  51/51, `go test ./...`, compilação de teste Windows x64 e `git diff --check` aprovados.
- Artefato final32:
  `/tmp/golive-plugin-vm-final32.pGpNNJ/goLiveBypass-vencord.zip`, 6.006.818 bytes,
  SHA-256 `fd9265d79f02af5f030422a461a993a6758f948382b731354119162a5889bd53`.
- O pacote foi extraído no checkout de teste Vencord da VM Windows 11; `pnpm.cmd
  testTsc` e `pnpm.cmd build` passaram. A instância em call não foi reinjetada nem
  reiniciada.
- O share temporário final32 foi ejetado, destacado e removido; `sdc` e `sde` foram
  preservados. Nenhum arquivo da GUI foi editado, compilado ou testado por este ciclo.

## Ciclo plugin-only: transmissão real e auditoria de handoff GUI→plugin (final33)

Data: 2026-09-08.

- O pacote final33 contém a correção mais recente do ciclo anterior:
  `/tmp/golive-plugin-vm-final33.TWpb2j/goLiveBypass-vencord.zip`, 6.006.824 bytes,
  SHA-256 `3389a38514d13704248dfa759fae70d2adca53e457164f02fe91e6a5407fd94e`.
- O pacote foi copiado e extraído no checkout Vencord da VM Windows 11. `pnpm.cmd
  testTsc` e `pnpm.cmd build` passaram com o prompt retornado; a transmissão permaneceu
  aberta durante a validação.
- Na call real `TESTE-TELA`, a VM exibiu a transmissão de PDL em `AO VIVO`, com tile
  de tela recebido e indicador de 1440p/60FPS em capturas consecutivas. A call continuou
  conectada, sem reload ou queda observada. Isso prova recepção de mídia no cliente de
  teste, não prova rota geográfica nem saída do transmissor.
- A auditoria do handoff encontrou processos da GUI e `wiresock-client.exe` externos
  ativos. O log sanitizado do plugin registrou `blocked_external` e a mensagem de
  preservação do WireSock externo. O plugin não matou a GUI nem assumiu o túnel, conforme
  o contrato de ownership; não é seguro nem permitido implementar `taskkill` automático.
- A migração atual importa somente arquivos compatíveis ausentes (`wireguard.conf` e
  `proton-session.json`) para `plugin-vpn`; ela não transfere ownership de um serviço
  ativo. Foi identificado como próxima melhoria o retry idempotente quando o primeiro
  boot ocorre antes de a GUI gravar esses arquivos; implementação aguardando aprovação
  do design seguro.
- Validação local: estabilidade 7/7, lifecycle 1/1, onboarding 3/3, updater 8/8,
  canal 7/7, transporte de segredos 10/10, E2E do userplugin 51/51 e `git diff --check`.
  O share final33 foi ejetado, destacado e removido; `sdc` e `sde` foram preservados.
  Nenhum arquivo da GUI foi editado, compilado ou testado.

## Ciclo plugin-only: retry seguro da migração compatível (final34)

Data: 2026-09-08.

- `goLiveBypass/vpn-controller.ts` não usa mais `migration-v1.json` como bloqueio
  definitivo. Arquivos compatíveis ausentes podem ser importados em uma inicialização
  posterior, sem sobrescrever dados já existentes do plugin.
- Cada importação agora copia para um temporário, valida o perfil WireGuard ou o JSON da
  sessão Proton, e só então faz `renameSync` atômico. Temporários de falha são removidos;
  o log registra apenas o nome do arquivo e o erro sanitizado.
- Regressão adicionada em `tests/test-plugin-migration.mjs`: retry com marcador, validação
  e atomicidade, e preservação do bloqueio de WireSock externo (3/3).
- Artefato final34:
  `/tmp/golive-plugin-vm-final34.coSlFu/goLiveBypass-vencord.zip`, 6.007.016 bytes,
  SHA-256 `bb3e0267d04f1bfc626c1ca25930f13029eb1a15e106232679b4622bc7f5890f`.
- O pacote foi extraído no checkout Vencord da VM Windows 11; `pnpm.cmd testTsc` e
  `pnpm.cmd build` passaram. O share final34 foi ejetado, destacado e removido;
  `sdc` e `sde` foram preservados.
- Na call real `TESTE-TELA`, a transmissão continuou visível durante a instalação e
  compilação, sem reinício do Discord, reload ou queda observada. A evidência continua
  limitada à recepção de mídia no cliente de teste; não prova rota geográfica.
- Limitação deliberada: o plugin continua recusando assumir ou matar um WireSock externo
  da GUI. A troca exige encerramento manual da GUI e nova ativação do plugin; automatizar
  `taskkill` violaria ownership, poderia interromper a call e não foi implementado.
- Validação final: migração 3/3, estabilidade 7/7, lifecycle 1/1, onboarding 3/3,
  updater 8/8, canal 7/7, transporte de segredos 10/10, E2E 51/51 e `git diff --check`.
  Nenhum arquivo da GUI foi editado, compilado ou testado.

## Ciclo plugin-only: restauração de rota sem relaunch implícito (final35)

Data: 2026-09-09.

- A restauração de uma rota que já estava ativa antes da otimização Proton agora usa
  `startInternal(false)`. Cancelamento, falha ou conclusão da otimização não solicitam
  mais um relaunch silencioso do Discord; o restart explícito do updater permanece
  separado e inalterado.
- Regressão adicionada em `tests/test-plugin-controller-recovery.mjs`: o contrato de
  restauração exige `relaunch=false` e rejeita `relaunch=true` (4/4).
- Validação local: todos os testes `tests/test-plugin-*.mjs`, `go test ./...` em
  `tools/proton-confgen/`, E2E do userplugin 51/51 e `git diff --check` aprovados.
- Artefato final35: `/tmp/golive-plugin-final35.zip`, 6.010.381 bytes, SHA-256
  `b628f69019780f509de7c4b1a5de543a53e3c22ddf00c407d72ab3139e81b53e`.
- O pacote foi copiado e extraído no checkout Vencord da VM Windows 11; `pnpm.cmd
  testTsc` e `pnpm.cmd build` passaram. A call `TESTE-TELA` permaneceu aberta; não
  houve injeção, reload ou reinício do Discord. O share temporário foi desmontado com
  PowerShell elevado, destacado e removido; os shares preexistentes sdc/sdd/sde foram
  preservados.
- Limitação: este ciclo valida compilação e empacotamento na VM, mas não executa a
  otimização Proton nem comprova a restauração de rota em runtime, porque a instância
  estava em uma call/transmissão ativa e o pacote não foi injetado.

## Ciclo plugin-only: invalidação de perfil na troca de conta Proton (final36)

Data: 2026-09-09.

- A troca de conta Proton agora é serializada com ativação/otimização e, quando a rota
  do próprio plugin está ativa, retorna erro recuperável sem alterar sessão nem rota.
- O perfil WireGuard gerado pelo Proton passa a ter marcador privado com schema e
  usuário normalizado. Ausência ou divergência do marcador força regeneração; login
  bem-sucedido em outra conta invalida o marcador. Importação de `.conf` e logout
  também o removem. Nenhum segredo é gravado no marcador.
- Regressão adicionada em `tests/test-plugin-account-switch.mjs`: serialização do
  login, bloqueio com rota própria ativa, correspondência/regeneração do perfil,
  invalidação por import/logout e preservação da guarda contra WireSock externo (6/6).
- Validação local: todos os testes `tests/test-plugin-*.mjs`, `go test ./...` em
  `tools/proton-confgen/`, E2E do userplugin 51/51 e `git diff --check` aprovados.
- Artefato final36: `/tmp/golive-plugin-final36.zip`, 6.010.946 bytes, SHA-256
  `030cb71cddbb6b4b3b20bf3f408a9c38dbe0f8978bb4654fc091bbcaaf5d8289`.
- O pacote foi copiado e extraído no checkout Vencord da VM Windows 11; `pnpm.cmd
  testTsc` (`tsc --noEmit`) e `pnpm.cmd build` concluíram com retorno ao prompt e
  sem erros visíveis. A call/transmissão `TESTE-TELA` permaneceu aberta; não houve
  injeção, reload ou reinício do Discord.
- O share temporário final36 foi desmontado com PowerShell elevado, destacado e
  removido; `sdc`, `sdd` e `sde` preexistentes foram preservados.
- Limitação: não houve login Proton real, troca de conta em runtime, ativação ou
  prova de rota nesta rodada, para não interromper a call/transmissão. A evidência
  cobre código, regressões, empacotamento e compilação Windows; não comprova o
  comportamento de rede em runtime.

## Ciclo plugin-only: invalidação por preferências de seleção Proton (final37)

Data: 2026-09-09.

- O marcador privado do perfil Proton agora registra, além de schema e conta,
  `country`, `freeOnly` e `autoPing`. A ativação só reutiliza o `wireguard.conf`
  quando todos os valores coincidem com a configuração normalizada atual; marcador
  ausente, antigo, corrompido ou divergente força nova seleção. `speedTest` não é
  persistido, pois é método de medição da otimização, não preferência da rota.
- A otimização grava os valores efetivamente usados no mesmo marcador. O fluxo de
  importação customizada, troca de conta, logout e a proteção contra WireSock
  externo permanecem inalterados.
- O teste primeiro falhou pela ausência do novo contrato e depois passou 6/6.
  Também passaram a recuperação 4/4, todos os testes `tests/test-plugin-*.mjs`,
  `go test ./...`, E2E do userplugin 51/51 e `git diff --check`.
- Artefato final37: `/tmp/golive-plugin-final37-corrected.zip`, 6.011.196 bytes,
  SHA-256 `2dd190e07f652d0cd95883d412fefdb2b2c241eab3180868850c20704dc0546e`.
- O pacote foi copiado e extraído no checkout Vencord da VM Windows 11; `pnpm.cmd
  testTsc` (`tsc --noEmit`) e `pnpm.cmd build` concluíram com retorno ao prompt e
  sem erros visíveis. O plugin anterior foi preservado em backup separado.
- O share temporário final37 foi ejetado com `mountvol H: /p`, confirmado ausente
  no Explorer, destacado e removido. Os shares preexistentes `sdc`, `sdd` e `sde`
  foram preservados.
- Limitação: não houve login/troca de conta, ativação Proton ou prova de rota em
  runtime, porque a call/transmissão `TESTE-TELA` permaneceu ativa. O ciclo prova
  o contrato de cache, regressões, empacotamento e compilação Windows, mas não o
  comportamento de rede efetivo.

## Ciclo plugin-only: guarda de ativação durante o onboarding (final38)

Data: 2026-09-09.

- O `start()` agora agenda o assistente quando `onboardingCompleted` ainda não é
  verdadeiro e não chama `Native.enable()` nessa primeira execução. Assim, uma
  ativação capaz de relançar o Discord não ocorre antes das duas etapas do
  onboarding; a ativação automática posterior permanece inalterada.
- Foi adicionada a especificação
  `docs/superpowers/specs/2026-09-09-plugin-onboarding-startup-gate-design.md`,
  o plano correspondente e a regressão `tests/test-plugin-onboarding.mjs` passou
  de 3/3 para 4/4. A asserção de lifecycle existente foi ajustada para o novo
  contrato.
- Validação local: todos os testes `tests/test-plugin-*.mjs`, helper
  `go test ./...` em `tools/proton-confgen/`, E2E do userplugin 51/51 e
  `git diff --check` aprovados.
- Artefato final38: `/tmp/golive-plugin-final38.zip`, 6.011.276 bytes, SHA-256
  `ac3ee4b0c5c1d5275361ccb70328d6b910e1b2365be66a5f47d216b45caf387f`.
- O pacote foi copiado e extraído no checkout Vencord da VM Windows 11, com o
  plugin anterior preservado em
  `C:\Users\teste\Vencord-vm-backups\final38-before-onboarding-gate`.
  `pnpm.cmd testTsc` chegou a `$ tsc --noEmit` sem erro visível e não deixou
  processo `node.exe` ativo quando conferido; a janela foi coberta antes de um
  código de saída independente ser capturado. O `pnpm.cmd build` terminou com
  retorno ao prompt e linhas `Done` em 8.197 ms, 8.227 ms, 9.239 ms e 9.141 ms.
- Não houve injeção, reload ou reinício do Discord: a call/transmissão
  `TESTE-TELA` permaneceu aberta. O share temporário final38 foi ejetado,
  destacado e removido; `sdc`, `sdd` e `sde` preexistentes foram preservados.
- Limitação: não houve login Proton real, ativação, troca de conta, prova de rota
  ou confirmação visual do onboarding em runtime. A evidência cobre a ordem do
  lifecycle, regressões, empacotamento e compilação Windows; não comprova rede
  efetiva nem o ciclo de UI em um Discord reiniciado.

## Ciclo plugin-only: contexto no overlay de atualização (final39)

Data: 2026-09-09.

- O toast de atualização pronta agora exibe versão atual, versão disponível e
  canal (`stable`/`beta`), usando o mesmo status que disparou a notificação. A
  mensagem continua informando que o pacote foi baixado, verificado e preparado;
  o Discord só é recarregado pelo botão explícito.
- Foram adicionados o design/plano
  `docs/superpowers/specs/2026-09-09-plugin-update-overlay-context-design.md` e
  `docs/superpowers/plans/2026-09-09-plugin-update-overlay-context.md`. A
  regressão de notificações passou de 8/8 para 9/9.
- Validação local: todos os testes `tests/test-plugin-*.mjs`, helper
  `go test ./...` em `tools/proton-confgen/`, E2E do userplugin 51/51 e
  `git diff --check` aprovados.
- Artefato final39: `/tmp/golive-plugin-final39.zip`, 6.011.428 bytes, SHA-256
  `483fc6f6b665c2e35beb11fe34afd23e676d6162bf82b27591478281670e10f2`.
- O pacote foi extraído no checkout Vencord da VM Windows 11, substituiu o
  plugin ativo e preservou o anterior em
  `C:\Users\teste\Vencord-vm-backups\final39-before-update-overlay`.
  `pnpm.cmd testTsc` retornou ao prompt após `$ tsc --noEmit` sem erros visíveis;
  `pnpm.cmd build` também retornou ao prompt com linhas `Done`.
- Não houve injeção, reload ou reinício do Discord: a call/transmissão
  `TESTE-TELA` permaneceu aberta. O share temporário final39 foi ejetado,
  destacado e removido; `sdc`, `sdd` e `sde` preexistentes foram preservados.
- Limitação: não houve atualização real via GitHub, clique visual no toast,
  login Proton, ativação ou prova de rota em runtime. A evidência cobre o
  contrato de dados/renderização, regressões, empacotamento e compilação Windows;
  não comprova o ciclo de UI após um reload real.

## Ciclo plugin-only: onboarding inicial exige as duas páginas (final40)

Data: 2026-09-09.

- A primeira página do onboarding não pode mais marcar `onboardingCompleted` nem
  oferece o atalho “Fazer depois”. A conclusão só ocorre na tela final, depois da
  passagem pela página de rota e da preparação/validação correspondente.
- No onboarding obrigatório da primeira execução, tentativas de fechar o modal antes
  da tela final são ignoradas. Um guia reaberto depois de concluído continua podendo
  ser fechado normalmente. O modo customizado segue sem solicitar credenciais Proton.
- A regressão `tests/test-plugin-onboarding.mjs` passou de 4/4 para 5/5; o teste
  reproduziu a possibilidade de bypass antes da implementação. Depois da correção,
  passaram todos os `tests/test-plugin-*.mjs`, `go test ./...` em
  `tools/proton-confgen/`, E2E do userplugin 51/51 e `git diff --check`.
- Artefato final40: `/tmp/golive-plugin-final40.zip`, 6.011.443 bytes,
  SHA-256 `fdfe7677598803fcc9a770558a20d3fb6dc5bd6ec80a80928a83440cf879abba`.
- O pacote foi extraído no checkout Vencord da VM Windows 11; o plugin anterior foi
  preservado em
  `C:\Users\teste\Vencord-vm-backups\final40-before-onboarding-sequential`.
  `pnpm.cmd testTsc` retornou ao prompt após `$ tsc --noEmit` sem erro visível;
  `pnpm.cmd build` concluiu com linhas `Done` e retornou ao prompt.
- Não houve injeção, reload ou reinício do Discord: a call/transmissão `TESTE-TELA`
  permaneceu ativa. O share temporário foi ejetado com `mountvol H: /p`, confirmado
  ausente no Explorer, destacado e removido; os shares preexistentes `sdc`, `sdd` e
  `sde` foram preservados.
- Limitação: não houve confirmação visual do onboarding após reinício nem login,
  ativação ou prova de rota em runtime; a evidência cobre o contrato sequencial,
  regressões, empacotamento e compilação Windows.

## Ciclo plugin-only: overlay para falha automática do updater (final41)

Data: 2026-09-09.

- Falhas reais retornadas em `PluginUpdateStatus.lastError` agora aparecem em um
  toast customizado no rodapé, com versão atual, canal e detalhe truncado. O
  botão `Depois` apenas dispensa o aviso; não há reload, ativação, encerramento
  nem alteração de rota como efeito colateral.
- O aviso é alimentado tanto pelo polling de inicialização quanto pelo card de
  configurações. A deduplicação usa canal, versão atual e erro normalizado; uma
  leitura sem erro limpa a chave para permitir nova notificação após recuperação.
  O erro continua visível no card existente e o caminho de atualização manual
  mantém seu feedback próprio.
- Foram adicionados o design/plano
  `docs/superpowers/specs/2026-09-09-plugin-update-failure-overlay-design.md` e
  `docs/superpowers/plans/2026-09-09-plugin-update-failure-overlay.md`. A
  regressão de notificações passou de 9/9 para 10/10; o teste primeiro falhou
  pela ausência do componente e helper e passou após a implementação.
- Validação local: todos os testes `tests/test-plugin-*.mjs`, `go test ./...` em
  `tools/proton-confgen/`, E2E do userplugin 51/51 e `git diff --check` aprovados.
- Artefato final41: `/tmp/golive-plugin-final41.zip`, 6.011.698 bytes,
  SHA-256 `e8fbaf864034038fa2e1bbb922c6255dd850f932f58a5eb6ae75c0b4994c9f64`.
- O pacote foi extraído no checkout Vencord da VM Windows 11; o plugin anterior
  foi preservado em
  `C:\Users\teste\Vencord-vm-backups\final41-before-update-failure-overlay`.
  `pnpm.cmd testTsc` retornou ao prompt após `$ tsc --noEmit` sem erros visíveis;
  `pnpm.cmd build` concluiu com linhas `Done` e retornou ao prompt.
- Com autorização explícita do usuário, o Discord foi encerrado para tentar
  validar o carregamento pós-restart. O cliente retornou à tela de login em
  Vesktop/Equibop, portanto não houve confirmação visual do plugin, do overlay
  de falha ou da chamada após a reinicialização; não foram alteradas credenciais
  nem perfis de conta.
- O share temporário final41 (`/tmp/golive-vm-share.RrIJMi.img`) foi ejetado com
  `mountvol H: /p`; `dir H:` confirmou que a unidade não existia, depois o disco
  foi destacado e destruído. Os shares preexistentes `sdc`, `sdd` e `sde` foram
  preservados.
- Limitação: não houve falha real do feed GitHub observada em runtime, login,
  ativação, prova de rota ou confirmação visual do onboarding. A evidência cobre
  o contrato de erro/deduplicação, regressões, empacotamento e compilação Windows;
  a última etapa de UI ficou bloqueada pelo estado de login da VM.

## Ciclo plugin-only: fechamento do onboarding sem bridge nativa (final42)

Data: 2026-09-09.

- Corrigido um dead-end no modal de configuração: `requiredOnOpen` agora é
  `Boolean(Native && settings.store.onboardingCompleted !== true)`. O assistente
  continua obrigatório na primeira execução suportada, mas o aviso de plataforma
  não suportada pode ser fechado quando a bridge nativa não existe. Nenhuma
  configuração é marcada como concluída nesse caminho.
- A regressão foi adicionada em `tests/test-plugin-onboarding.mjs`. O teste
  primeiro falhou com a expressão antiga e depois passou 6/6. A revisão confirmou
  que a mudança não move `Native.enable`, `Native.shutdown`, `restartDiscord`,
  persistência Proton ou operações WireGuard.
- Especificação e plano: `docs/superpowers/specs/2026-09-09-plugin-onboarding-native-gate-design.md`
  e `docs/superpowers/plans/2026-09-09-plugin-onboarding-native-gate.md`.
- Validação local: todos os testes `tests/test-plugin-*.mjs`, `go test ./...` em
  `tools/proton-confgen/`, E2E do userplugin 51/51 e `git diff --check` aprovados.
- Artefato final42: `/tmp/golive-plugin-final42.zip`, 6.011.704 bytes,
  SHA-256 `f3ebbd6b243c5177cbb8839998de0c6c30c09ed617a04e1783b0288f8b57e7cc`.
- O pacote foi instalado na VM Windows 11 com backup em
  `C:\Users\teste\Vencord-vm-backups\final42-before-native-gate`.
  `pnpm.cmd testTsc` retornou ao prompt após `$ tsc --noEmit`; `pnpm.cmd build`
  concluiu com linhas `Done` e retornou ao prompt.
- O comportamento sem bridge nativa não é reproduzível no checkout Windows x64
  integrado. A VM não estava autenticada no Discord após o ciclo anterior; não
  foram alteradas credenciais, nem houve alegação de validação visual desse caso.
- O share temporário `/tmp/golive-vm-share.3yVur5.img` foi ejetado com
  `mountvol H: /p`, confirmado ausente por `dir H:`, destacado e destruído. Os
  shares preexistentes `sdc`, `sdd` e `sde` foram preservados.

## Ciclo plugin-only: supressão one-shot de erro manual do updater (final43)

Data: 2026-09-09.

- Corrigida uma inconsistência do overlay de falha introduzido no final41: quando
  `check` ou `update` manual já mostrava seu feedback, a mesma falha nativa podia
  ser observada pelo polling e gerar um segundo overlay imediatamente. O renderer
  agora normaliza canal, versão e detalhe em uma chave comum, registra a falha
  manual e consome essa chave uma única vez na próxima observação automática.
- A supressão é somente one-shot: uma leitura posterior ainda pode notificar a
  falha persistente, e um status sem erro limpa as chaves de deduplicação. O card,
  os botões e as mensagens manuais existentes permanecem inalterados. Não houve
  alteração de IPC, sessão persistida, WireGuard, rota, reinício ou chamada nativa
  privilegiada; nenhuma chave de erro manual é persistida.
- Design e plano: `docs/superpowers/specs/2026-09-09-plugin-update-manual-error-suppression-design.md`
  e `docs/superpowers/plans/2026-09-09-plugin-update-manual-error-suppression.md`.
  O teste focado primeiro falhou pela ausência da guarda e passou depois com 11/11,
  incluindo os quatro ramos de falha manual e o consumo one-shot.
- Validação local: todos os testes `tests/test-plugin-*.mjs`, `go test ./...` em
  `tools/proton-confgen/`, E2E do userplugin 51/51 e `git diff --check` aprovados.
- Artefato final43: `/tmp/golive-plugin-final43.zip`, 6.011.958 bytes,
  SHA-256 `9547288e42c55cb9d88ca1390b214565a14e4ae3a58d25779ca42e327a53548c`.
- O pacote foi instalado na VM Windows 11 com backup em
  `C:\Users\teste\Vencord-vm-backups\final43-before-manual-update-suppression`.
  `pnpm.cmd testTsc` (`tsc --noEmit`) e `pnpm.cmd build` concluíram sem erro e
  retornaram ao prompt. O processo Discord não foi reiniciado nem houve alteração
  de credenciais; a validação visual do fluxo de updater continua limitada pelo
  estado não autenticado da VM.
- O share temporário `/tmp/golive-vm-share.Jdgx89.img` foi ejetado com
  `mountvol H: /p`; `dir H:` confirmou `PathNotFound`, depois o disco foi
  destacado e destruído. Os shares preexistentes `sdc`, `sdd` e `sde` foram
  preservados.

## Ciclo plugin-only: geração do lifecycle contra respostas tardias (final44)

Data: 2026-09-09.

- Identificada uma corrida real no renderer: uma resposta atrasada de
  `getPluginUpdateStatus()` ou `Native.enable()`, e o timer inicial do onboarding,
  podiam tocar a UI depois de `stop()` ou de um novo `start()`. Isso poderia
  exibir toast ou abrir modal em um plugin já desmontado.
- `goLiveBypass/index.tsx` agora mantém `pluginLifecycleGeneration`. Cada
  `start()` captura sua geração; onboarding, consulta inicial do updater,
  configuração e ativação nativa descartam respostas obsoletas antes de abrir
  modal, emitir toast ou registrar erro. `stop()` invalida a geração antes de
  limpar timers e solicitar o shutdown existente. Nenhuma promise IPC é forçada
  a cancelar, e não houve mudança em IPC, WireGuard, rota, persistência ou
  privilégios.
- Especificação e plano: `docs/superpowers/specs/2026-09-09-plugin-lifecycle-generation-design.md`
  e `docs/superpowers/plans/2026-09-09-plugin-lifecycle-generation.md`. O teste
  focado falhou antes da implementação e passou depois com 3/3.
- Validação local: todos os testes `tests/test-plugin-*.mjs`, `go test ./...` em
  `tools/proton-confgen/`, E2E do userplugin 51/51 e `git diff --check` aprovados.
- Artefato final44: `/tmp/golive-plugin-final44.zip`, 6.012.044 bytes,
  SHA-256 `fe879f52b99e5880dd0063ad38dd21fd8fe8f77ae072e38b77dbbdf2242f5ff9`.
- O pacote foi instalado na VM Windows 11 com backup em
  `C:\Users\teste\Vencord-vm-backups\final44-before-lifecycle-generation`.
  `pnpm.cmd testTsc` (`tsc --noEmit`) e `pnpm.cmd build` terminaram com retorno
  ao prompt e sem erros visíveis. Não houve reinício, injeção, alteração de
  credenciais ou prova visual do updater; a VM continua sem login autenticado.
- O share temporário `/tmp/golive-vm-share.SgK9ig.img` foi ejetado com
  `mountvol H: /p`; `dir H:` confirmou `PathNotFound`, depois foi destacado e
  destruído. Os shares preexistentes `sdc`, `sdd` e `sde` permaneceram intactos.

## Ciclo plugin-only: limpeza de deduplicação do updater no lifecycle (final45)

Data: 2026-09-09.

- A revisão do final44 encontrou uma fronteira de lifecycle faltante: as chaves
  em memória `lastNotifiedUpdateErrorKey` e `lastSuppressedUpdateErrorKey`
  podiam sobreviver a `stop()` e afetar a primeira observação automática após
  um novo `start()`. O renderer agora limpa as duas chaves imediatamente depois
  de invalidar `pluginLifecycleGeneration`; preferências persistidas, IPC,
  Proton, WireGuard, rotas e shutdown nativo não foram alterados.
- Especificação e plano: `docs/superpowers/specs/2026-09-09-plugin-update-error-lifecycle-design.md`
  e `docs/superpowers/plans/2026-09-09-plugin-update-error-lifecycle.md`.
  O teste focado falhou antes da implementação pela ausência dos resets e passou
  depois com `plugin lifecycle source tests: 4/4` (3 casos Node, com asserções
  adicionais no caso de lifecycle).
- Validação local: todos os `tests/test-plugin-*.mjs`, `go test ./...` em
  `tools/proton-confgen/`, E2E do userplugin 51/51 e `git diff --check` passaram.
- Artefato final45: `/tmp/golive-plugin-final45.zip`, 6.012.056 bytes,
  SHA-256 `cf4774bdbb772cf19689635ef9b9e2d0fbe2a08a027e79e0e82e221aedb8b377`.
- O pacote foi instalado na VM Windows 11 com backup em
  `C:\Users\teste\Vencord-vm-backups\final45-before-update-error-lifecycle`.
  Na VM, `pnpm.cmd testTsc` e `pnpm.cmd build` terminaram com `exit 0`.
  O share temporário foi ejetado via `mountvol E: /p`, destacado e destruído;
  após a limpeza, `vmctl disks` mostrou apenas o disco do sistema e o alvo
  `sdb` vazio.
- A validação visual também avançou: o erro observado ao abrir o clone antigo
  `Discord-plugin-test-final19` foi descartado; o Discord oficial abriu
  autenticado, carregou o GoLiveBypass habilitado no Vencord, e a tela de
  configurações do plugin ficou acessível. O cliente foi reiniciado com
  autorização do usuário; depois o plugin foi desativado e reativado na tela de
  plugins, retornando ao estado habilitado sem erro visível.
- Antes da instalação do final45, o onboarding real completou as duas páginas
  na call/transmissão `TESTE-TELA`: a sessão Proton persistida foi reconhecida,
  a otimização testou servidores e concluiu com `US-FREE#58`, medindo cerca de
  34,6 Mbps de download e 12,3 Mbps de upload. O prompt do Windows Firewall
  para `golive-speed-probe.exe` foi cancelado para preservar o isolamento; a
  otimização continuou e concluiu mesmo assim.
- Limitações: não foi concedida regra de Firewall, não foi feita ativação real
  do túnel WireGuard nem prova geográfica de saída nesta rodada. A evidência de
  runtime confirma carregamento, onboarding, seleção de rota e lifecycle visual;
  não substitui a validação de tráfego após ativação do túnel.

## Validação adicional: Discord oficial e recebimento de transmissão após final45

Data: 2026-09-09.

- A janela antiga do clone `Discord-plugin-test-final19` foi encerrada. O
  executável em teste passou a ser somente
  `C:\Users\teste\AppData\Local\Discord\app-1.0.9256\Discord.exe`; a coleta
  não encontrou queda do processo nem evento de aplicação relacionado ao
  Discord.
- Com o plugin habilitado e o WireSock próprio em execução, a primeira tentativa
  de assistir à Live reproduziu `Erro 2001`/`stream-failed-to-start`. A segunda
  tentativa, na mesma call, mostrou vídeo real da tela da VM em 1440p/60 FPS.
  A imagem permaneceu recebida por pelo menos 30 segundos, com a call ainda
  conectada. Evidências visuais: `/tmp/golive-vm-stream-success-clean.png` e
  `/tmp/golive-vm-stream-success-30s.png`.
- Os logs confirmam a transição nativa: `stream.observation` chegou a
  `native-connected` com `native=1`; os eventos transitórios
  `stream-view-low-fps`/`video-stream-receiver-ready-timeout` foram resolvidos
  durante a reconexão. Na coleta do estado saudável, o serviço
  `wiresock-client-service` estava `Running` e havia um `wiresock-client.exe`.
  Evidência sanitizada: `/tmp/discord-error-evidence-stream-success.txt`.
- O A/B com o plugin desligado confirmou que o oficial abre e mantém a call
  conectada, mas a transmissão remota deixou de ser anunciada após o reinício;
  por isso essa rodada não é uma comparação válida do vídeo. O A/B com
  `Restaurar rede` no estado anterior repetiu o erro 2012 em uma fonte antiga,
  portanto não atribui o erro ao túnel sem uma fonte fresca.
- Conclusão deste ciclo: abertura oficial, call e recebimento real foram
  validados com o final45; a primeira tentativa ainda pode falhar de forma
  transitória e se recuperar pelo retry normal do Discord. Não foi feita
  alteração de código neste ciclo, nem há prova de saída geográfica.

## Revalidação após reinício e relançamento do Discord oficial

Data: 2026-09-09.

- Depois do reinício da VM, o cliente oficial voltou a abrir autenticado. Para
  reproduzir a abertura de forma isolada, `Discord.exe` foi encerrado somente
  dentro da VM e o cliente foi relançado por
  `C:\Users\teste\AppData\Local\Discord\Update.exe --processStart Discord.exe`.
- Após o carregamento inicial, o Discord exibiu a interface normal, sem tela de
  erro. A reconexão ao canal de voz funcionou e a fonte de transmissão voltou a
  aparecer como ativa. Evidência visual: `/tmp/golive-vm-official-relaunch-dismissed.png`.
- A coleta de 04:49:58 encontrou processos do executável oficial
  `app-1.0.9256`, `wiresock-client-service=Running` e nenhum evento de erro ou
  crash da aplicação. O `Uncaught Error: Sentry successfully disabled` de
  04:47:30 pertence ao NoTrack desabilitando o Sentry de forma deliberada; não
  houve tela de falha correspondente. Evidência sanitizada:
  `/tmp/discord-error-evidence-after-official-relaunch.txt`.
- Resultado: o erro de abertura não foi reproduzido no cliente oficial após o
  reinício. O erro anterior permanece associado ao clone antigo e/ou a uma
  condição transitória de carregamento; ainda não há evidência suficiente para
  atribuí-lo ao WireGuard ou justificar uma alteração de código.

## Repetição do recebimento após o relançamento oficial

- Com o cliente oficial já reconectado ao canal, a transmissão foi aberta
  novamente. Em aproximadamente 6 s o vídeo real da VM apareceu e permaneceu
  visível por pelo menos 86 s, sem `stream-failed-to-start` ou erro 2001 na
  interface. Evidências visuais: `/tmp/golive-vm-post-relaunch-stream-6s.png` e
  `/tmp/golive-vm-post-relaunch-stream-26s.png`, além das capturas de
  estabilidade em `/tmp/golive-vm-stream-stability-56s.png` e
  `/tmp/golive-vm-stream-stability-86s.png`.
- A coleta de 04:53:43 registrou o `RTCControlSocket(stream)` conectado e
  `stream.observation | status=native-connected | visible=1 | native=1 | voice_state=RTC_CONNECTED`,
  com `wiresock-client-service=Running`. Evidência sanitizada:
  `/tmp/discord-error-evidence-post-relaunch-stream.txt`.
- Este ciclo reduz a hipótese de que a abertura do cliente oficial cause o
  problema: após o relançamento, a abertura, reconexão e recepção passaram em
  sequência. O erro 2001 observado antes continua classificado como transitório
  do primeiro início do receptor, sem justificativa atual para alterar o código.

## Revalidação local após os ciclos da VM

Data: 2026-09-09.

- Os 11 módulos `tests/test-plugin-*.mjs` passaram, totalizando 80 casos; a
  cobertura inclui conta Proton, concorrência, lifecycle, onboarding, transporte
  de segredos, recuperação e updater.
- `go test ./...` passou em `tools/proton-confgen`, incluindo autenticação,
  armazenamento, route probe, speedtest e WireGuard.
- `./tests/test-userplugin-e2e.sh` passou com 51 verificações: pacote, helper
  Windows x64, manifest, SHA-256, extração, hash dos arquivos e rollback.
- `git diff --check` passou. Nenhum código foi alterado nesta revalidação; os
  resultados apenas confirmam que a fonte atual continua íntegra após os testes
  reais na VM.

## Validação integrada do helper Proton atual

Data: 2026-09-09.

- A conferência do artefato revelou que o helper Windows x64 do final45 era
  diferente do helper produzido pela fonte atual. Foi montado um pacote novo
  com o código vigente: `/tmp/golive-plugin-current.zip`, 6.012.057 bytes,
  SHA-256 `d25f54dd66e3f03d89f707f97342bf749185e3328e08fc9c24831872409287d5`.
  O helper incluído tem SHA-256
  `bfcb9a5d35c92c7928c42f545e1770a20d7f6d6cf41ce100ef4b7fb921ddab0b`.
- O instalador temporário verificou os dois hashes dentro da VM, preservou o
  plugin anterior em `C:\Users\teste\Vencord-vm-backups` e instalou o pacote no
  checkout Vencord. `pnpm.cmd testTsc`, `pnpm.cmd build` e `pnpm.cmd inject`
  terminaram com `GO_LIVE_CURRENT_BUILD_READY`; a instalação oficial ficou
  patched novamente.
- Após o relançamento pelo `Update.exe`, o Discord oficial abriu autenticado,
  registrou `sessao aberta | VPN active | ativa true | ownership true` e recebeu
  vídeo real da transmissão. O vídeo apareceu em 8 s e permaneceu visível por
  pelo menos 38 s; o log registrou `native-connected`, `visible=1`, `native=1`
  e `voice_state=RTC_CONNECTED`. Evidências: `/tmp/golive-vm-current-helper-relaunch-12s.png`,
  `/tmp/golive-vm-current-helper-stream-8s.png`,
  `/tmp/golive-vm-current-helper-stream-38s.png` e
  `/tmp/discord-error-evidence-current-helper-stream.txt`.
- Resultado: o helper atual está integrado ao build Windows e passou o caminho
  de sessão persistida, abertura do Discord, chamada e recebimento de vídeo.
  Login novo, aplicação de rota própria e prova geográfica continuam não
  validados; o WireSock externo da VM segue protegido pela regra de ownership.

## Ciclo plugin-only: limpeza segura de probes e correção do autostart da VM

Data: 2026-09-09.

- A revisão independente encontrou uma corrida em que uma instância antiga
  poderia remover o probe da sucessora. A correção passou a amarrar a limpeza
  ao token `pid/generation/createdAt`, preservar ownership durante recovery
  antecipado, evitar varredura quando o owner ativo é desconhecido e fazer
  tentativas explícitas e limitadas de remoção, sem exclusão recursiva.
- Foram adicionados testes focados de reconhecimento, proteção, expiração e
  lifecycle: `tests/test-plugin-route-probe.mjs` passou 3/3 e
  `tests/test-plugin-route-probe-lifecycle.mjs` passou 5/5. Na revalidação,
  todos os 13 módulos `tests/test-plugin-*.mjs`, `go test ./...` em
  `tools/proton-confgen`, `tsc --noEmit` da GUI, o E2E do userplugin (51/51) e
  `git diff --check` passaram.
- O pacote Windows x64 vigente foi montado em
  `/tmp/golive-plugin-route-cleanup.zip`, com 6.014.087 bytes e SHA-256
  `f369452db415859758407ae76f103220cd4c35f0550dc8144d218fae83dca94f`.
  O helper incluído tem SHA-256
  `3b0e05ef82cbb070ec4dc1d0c33e2ebbfed1c258a960359f2a12d723243a053e`.
- A instalação temporária na VM verificou os hashes, e
  `pnpm.cmd testTsc`, `pnpm.cmd build` e `pnpm.cmd inject` terminaram com
  `GO_LIVE_CURRENT_BUILD_READY`.
- O primeiro cold boot foi descartado como evidência do oficial porque o
  ambiente de teste tinha `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\\Discord`
  apontando para um clone de teste. O clone foi encerrado dentro da VM; em
  seguida, o cliente oficial foi aberto isoladamente e todos os processos
  `Discord.exe` observados vieram de
  `C:\\Users\\teste\\AppData\\Local\\Discord\\app-1.0.9256\\Discord.exe`.
- A chave de inicialização foi corrigida para o `Update.exe` oficial e
  verificada. No segundo reboot, sem lançamento manual, o Discord oficial
  abriu normalmente: seis processos oficiais, WireSock `Running`, owner
  presente, um probe válido, probes de rota com `success=true` e
  `mode=log-only`. Depois de `Restaurar rede`, a coleta confirmou zero probes,
  owner ausente e serviço parado; os discos da VM terminaram limpos (`sda`
  do sistema e `sdb -`).

## Ciclo de endurecimento de ownership, inspeção e logout Proton

Data: 2026-09-09.

- O controller agora serializa a inicialização, usa mutex cooperativo com
  token e limite de tentativas para o ownership, grava o marcador de forma
  atômica e só remove probes depois de confirmar a própria posse. Instâncias
  com owner vivo, serviço externo ou inspeção inconclusiva não são assumidas;
  leituras desconhecidas de serviço/processo falham fechado.
- O probe de rota passou a validar arquivo regular, não-symlink e caminho
  gerenciado antes da execução. O logout Proton recusa operar enquanto o
  túnel ou um lock estiver ativo e, quando a rede está inativa, remove somente
  os artefatos gerados pelo modo Proton antes de apagar a sessão. Falha ao
  persistir refresh de sessão agora também é retornada ao chamador.
- O updater revalida canal, versão e revisão da política imediatamente antes
  da substituição do plugin. Foram adicionados testes para concorrência de
  ownership, inspeção Windows, execução/limpeza de probes, lifecycle de UI,
  logout e atualização.
- Na revalidação local, os 19 módulos `tests/test-plugin-*.mjs` passaram,
  `go test ./...` em `tools/proton-confgen` passou, `tsc --noEmit` passou e
  `./tests/test-userplugin-e2e.sh` terminou com 51 verificações aprovadas.
  `git diff --check` também passou.
- O pacote usado na VM foi
  `/tmp/golive-plugin-route-cleanup.zip`, SHA-256
  `892f3d681ca89460a4995cd06817aff00eeed27fa214185f139f2fc4454fbc82`, com
  helper Windows x64 SHA-256
  `0da58221a6246a14b923f7080541abab600cfa015ce94e86457bf0130a0ddcc0`.
  `pnpm.cmd testTsc`, `pnpm.cmd build` e `pnpm.cmd inject` terminaram sem
  erro dentro da VM.
- Depois do reinício e login já feitos na VM, o Discord oficial foi aberto
  pelo `Update.exe`, carregou a interface autenticada e o painel do plugin.
  O túnel próprio chegou a ficar ativo com owner e probe válido; ao clicar em
  `Sair` nesse estado, a conta não foi apagada, conforme a proteção esperada.
  Depois de `Restaurar rede`, a coleta confirmou serviço WireSock `Stopped`,
  ausência de `owner.lock` e de probe temporário, e `Test-Path E:\` igual a
  `False`. O disco temporário foi ejetado, desanexado e destruído; a VM ficou
  somente com `sda` do sistema e `sdb -`.

Este ciclo não reproduziu o erro de abertura do Discord oficial. A evidência
atual aponta para a configuração/autostart de teste que ainda apontava para um
clone antigo, já corrigida nas rodadas anteriores; não há uma falha nova do
cliente oficial justificando mudança adicional nesse caminho.

## Revalidação final do pacote corrigido e abertura oficial

Data: 2026-09-09.

- A primeira execução do pacote recém-instalado na VM revelou três erros reais
  de `testTsc` contra os tipos do Vencord atual: dois destructors de `useEffect`
  retornavam o booleano de `Set.delete`, e o cartão do updater usava variantes
  inexistentes (`primary`/`brand`). O código foi corrigido para cleanup sem
  retorno e variantes suportadas (`normal`/`info`/`warning`/`success`); o teste
  de auditoria da UI foi atualizado para o contrato real.
- Depois da correção, passaram novamente os 19 módulos de fonte do plugin, a
  suíte completa da GUI (52 arquivos, 405 testes), `tsc --noEmit`, o E2E do
  userplugin (51 verificações) e `git diff --check`.
- O pacote Windows x64 corrigido foi montado em
  `/tmp/golive-plugin-next.zip`, com 6.025.273 bytes e SHA-256
  `2b4354d43bda13ead66230d9f4d8fb93842086256a9e44e323421dd3d25b9cc4`.
  O conteúdo inclui o helper `proton-confgen.exe` e somente os arquivos do
  userplugin.
- Na VM, o pacote corrigido foi instalado preservando o anterior em backup.
  `pnpm.cmd testTsc`, `pnpm.cmd build` e `pnpm.cmd inject` terminaram com
  sucesso. O cliente oficial foi aberto pelo menu Iniciar, carregou a tela
  autenticada e permaneceu normal; o plugin apareceu habilitado na busca de
  Plugins e seu painel abriu sem erro.
- O autostart do plugin ativou o túnel conforme o estado persistido; a ação
  `Restaurar rede` confirmou a volta ao estado normal. O volume de transferência
  foi ejetado (`Test-Path E:\` = `False`), desanexado e destruído. A checagem
  final da VM mostrou somente `sda` do sistema e `sdb -`.
- O erro textual visto antes ao tentar iniciar com PowerShell foi causado pela
  entrada manual truncada no terminal de teste (`-processStart` separado do
  comando). Não foi reproduzido usando o lançador oficial nem após o novo
  `inject`.

## Revalidação da fonte corrente após as correções dos agentes

Data: 2026-09-09.

- A suíte local corrente passou: 19 módulos `tests/test-plugin-*.mjs`, 52
  arquivos da GUI com 405 testes, `tsc --noEmit`, `go test ./...` do helper
  Proton, `./tests/test-userplugin-e2e.sh` com 51 verificações e
  `git diff --check`. Uma asserção excessivamente dependente de quebra de
  linha no teste do updater foi ajustada para verificar a chamada segura por
  expressão; não houve alteração de comportamento para contornar falha.
- Foi montado o pacote corrente `/tmp/golive-plugin-current.zip`, com
  6.034.483 bytes e SHA-256
  `0315c660448d80ec444188c4064f88764545dd7b895c123470156dd3f9f25f3f`.
  O helper Windows x64 incluído tem SHA-256
  `56340c03adf171216dfc3ffbb5b26c4b6138a48985bbbf27c8c2c2110e53e182`.
- O pacote foi instalado na VM preservando o anterior em backup. O Vencord
  atual passou novamente por `pnpm.cmd testTsc`, `pnpm.cmd build` e
  `pnpm.cmd inject`. O cliente oficial abriu pelo menu Iniciar, permaneceu na
  interface autenticada, exibiu o GoLiveBypass habilitado e abriu o painel e o
  onboarding sem erro.
- O updater real consultou o canal estável e preparou a v2.0.5, exibindo no
  painel que ela está pronta e que o reload é manual. A versão não foi
  aplicada nesta rodada para manter a build corrente como alvo da validação;
  não houve reinício automático.
- No mesmo ciclo, a VPN foi restaurada pela ação do painel. `Test-Path E:\`
  retornou `False`, o compartilhamento FAT foi desmontado/destruído e a VM
  terminou somente com o disco de sistema e o slot secundário vazio.

## A/B real do erro de transmissão 2012

Data: 2026-09-09.

- Com a rede normal restaurada e o túnel do plugin inativo, a tentativa de
  abrir a transmissão ativa reproduziu a mensagem do Discord `Erro: 2012`
  após aproximadamente 45 s, em vez de entregar vídeo.
- No controle causal, o túnel WireGuard do plugin foi ativado e a mesma fonte
  passou a entregar vídeo real em aproximadamente 15 s; a imagem continuou
  presente na observação de 60 s. O teste mostra que, nesta VM, a transmissão
  depende da rota do plugin; não é prova independente de geolocalização.
- A rede não é ativada automaticamente em resposta ao erro: as probes seguem
  diagnósticas e o isolamento por aplicativo é preservado. A ação explícita
  `Restaurar rede` encerrou o túnel sem deixar owner/probe temporário ativo.

O resultado atual deixa de ser uma suspeita de “erro ao abrir o Discord”: a
abertura oficial foi repetida com a fonte corrente e não falhou. O 2012 é um
estado de transmissão observado quando a rota do plugin está inativa, com
recuperação comprovada quando a rota é ativada.

## Revalidação r2: pacote corrigido e abertura do Discord oficial

Data: 2026-09-09.

- A primeira tentativa na VM ainda usava o pacote r1 e revelou dois `TS18048`
  em `index.tsx`, nas chamadas assíncronas do updater. A fonte foi corrigida
  para capturar a referência nativa antes dos callbacks; a suíte local voltou a
  passar e o r2 foi montado com 6.036.837 bytes, SHA-256
  `02cf810a331c2a44dd0c92811a5f92a5c26ff502c3f9f0a54742d7adc0a400a1`.
- O r2 foi copiado para a VM por share FAT, extraído e instalado após mover o
  r1 para `C:\Users\teste\Vencord-vm-backups\before-hardening-r2-20260909`.
  `pnpm.cmd testTsc`, `pnpm.cmd build` e `pnpm.cmd inject` terminaram sem erro;
  a reinjeção exibiu `Success!` para o Discord oficial.
- O Discord oficial foi aberto pelo menu Iniciar depois da reinjeção e carregou
  a interface autenticada normalmente. Em Vencord, a busca de Plugins encontrou
  `GoLiveBypass` habilitado; a tela de configurações não apresentou erro de
  abertura nem falha de renderização.
- A chamada de voz foi encerrada com sucesso. O serviço
  `wiresock-client-service` ficou `Stopped`; não havia `owner.lock` nem probe
  temporário no diretório do plugin. O volume temporário foi ejetado, destacado
  e destruído; a VM permaneceu ligada somente com `sda` do sistema e `sdb -`.

Resultado: o erro de abertura do Discord oficial não foi reproduzido com o r2.
O bloqueio observado nesta rodada era a defasagem do pacote r1 em relação à
fonte corrigida, não uma falha persistente do cliente oficial. O r2 fica como o
artefato válido desta validação; não houve publicação, push ou release.

## Revalidação r3: helper Windows e estado final da VM

Data: 2026-09-09.

- Ao repetir a consulta da sessão Proton persistida com o r2, apareceu uma
  regressão real que não era coberta pelos testes Linux nem pelo cross-compile:
  o helper Windows encerrava com `0xC0000005` (`STATUS_ACCESS_VIOLATION`) dentro
  de `golang.org/x/sys/windows.LockFileEx`. A causa foi passar `nil` como
  `OVERLAPPED` para `LockFileEx`/`UnlockFileEx`.
- A correção passou a fornecer uma estrutura `windows.Overlapped` válida nas
  duas chamadas e ganhou um teste Windows específico de adquirir, liberar e
  readquirir o lock. O helper novo tem 15.083.008 bytes e SHA-256
  `42e6c81129ba081edd790a11e81710d6b1d7fc5f8da320685fc4861c6068505b`.
- O pacote r3 foi montado sem publicação, com 6.037.753 bytes e SHA-256
  `3f8cfe9036483c1be88f8e0081a70acae8b3ef9907e7157fc6910fd29a99a171`,
  instalado na VM após preservar o r2 em
  `C:\Users\teste\Vencord-vm-backups\before-hardening-r3-20260909`.
  `pnpm.cmd testTsc`, `pnpm.cmd build` e `pnpm.cmd inject` terminaram com
  sucesso (`Success!`) para o Discord oficial.
- O Discord oficial abriu autenticado e o `GoLiveBypass` apareceu habilitado.
  A abertura do guia de configuração não causou mais crash: a leitura da
  sessão terminou com a mensagem controlada de que ela precisa ser renovada.
  A rota própria não pôde ser preparada porque a sessão salva está expirada e
  esta rodada não recebeu senha, 2FA ou CAPTCHA novos.
- Durante a inspeção, o plugin tinha restaurado um estado VPN persistido; a
  ação explícita `Restaurar rede` encerrou o serviço. A checagem final mostrou
  `wiresock-client-service` como `Stopped`, `owner.lock` ausente e o probe
  temporário ausente. A conta da VM saiu da call; o participante remoto da
  chamada não foi alterado.
- O share FAT foi destacado e destruído. Depois da limpeza, `vmctl disks`
  mostrou somente `sda` do sistema e `sdb -`. O marcador antigo de update sem
  `sourceDigest` continua sendo exibido como falha controlada que exige nova
  preparação; ele não é usado como prova nem apagado silenciosamente.

Validações finais locais desta rodada: `npm test -- --reporter=dot` (52
arquivos, 408 testes), `npx tsc --noEmit`, `npm run compile`, `go test ./...`,
cross-compile/cross-test Windows x64, `tests/test-userplugin-e2e.sh` (51 ok,
0 falhas) e os 19 módulos `tests/test-plugin-*.mjs` passaram. `git diff
--check` também passou. Não houve publicação, push, release ou envio de
mensagem.

## O que ainda falta para a meta

O problema concreto de abertura do Discord oficial continua não reproduzido
após a correção do autostart, o novo `inject` e a abertura pelo lançador oficial.
O trabalho não está mais em um loop sem critério: a parte implementada e
testável tem evidência de conclusão para build, tipagem no Vencord atual,
injeção, inicialização oficial, ativação, restauração e limpeza.

Restam validações de escopo, não uma nova rodada genérica de melhoria:

- login Proton novo, incluindo 2FA/CAPTCHA ou troca real de conta;
- aplicação de rota própria do túnel em um cenário novo, separada da sessão
  persistida já testada; o A/B de 2012 comprovou dependência de rota, mas não
  substitui a validação de login e configuração novos;
- eventual prova externa de localização/saída, pois os países vistos pelos
  probes são apenas diagnóstico e não liberam nem bloqueiam a ativação;
- teste prolongado adicional de Go Live se a meta exigir duração maior que as
  janelas já registradas.

O aviso do marcador legado do updater é esperado pela regra de segurança atual:
sem o digest da árvore preparada, o estado não pode ser reconciliado como
confiável. Falta uma preparação válida/limpeza explícita desse estado para
validar também o caminho feliz do updater.

Não houve publicação, push, release ou envio de mensagem. A principal
limitação técnica restante é que a VM não fornece, por si só, prova
independente de geolocalização nem substitui um login Proton novo; também não
foi feito teste direto de arquivo Windows bloqueado durante a remoção.

## Checkpoint de continuidade

Após esta revalidação, a VM `win11` permanece ligada, com o Discord oficial
autenticado e o assistente do GoLiveBypass aberto na página de login Proton,
pronto para uma intervenção do titular da conta. A VPN está inativa, não há
share anexado e não há tarefa de subagente ou operação externa em andamento.
Próximo passo: concluir o login Proton dentro da VM e repetir preparação,
ativação, uso prolongado e restauração da rota.

## Revalidação r4: abertura oficial e compatibilidade do manifest stable

Data: 2026-09-09.

- A abertura anterior exibiu um erro real do updater, não um crash do Discord:
  o release stable público `v2.0.5` do repositório canônico ainda carrega
  metadata histórica `pdl-clay/GoLiveBypass`. Essa divergência era rejeitada
  pelo validador estrito, embora o asset viesse do release oficial.
- A correção mantém `isOfficialPluginManifest()` estrito e adiciona uma exceção
  fechada somente para o asset legado `GoLiveBypass` `v2.0.5`, com nome, versão,
  repositório antigo e nome do ZIP exatos. URLs e redirecionamentos continuam
  limitados ao repositório/CDNs oficiais; versões posteriores ou metadata
  diferentes continuam recusadas.
- Pacote usado nesta rodada: `/tmp/golive-plugin-hardening-compat.k7n5Od.zip`,
  6.041.117 bytes, SHA-256
  `42bcbabd8add9bd1d1b1ddf755dda43338f603b18dddca01012f1da8e4c67e8a`.
  Na VM, a cópia foi confirmada, `pnpm.cmd build` terminou sem erro e
  `pnpm.cmd inject` encerrou com `Success!` no Discord oficial.
- O cliente oficial foi relançado por `Update.exe`, abriu a interface normal e
  exibiu o onboarding do GoLiveBypass. Após mais de 18 segundos de observação,
  o erro `manifest do plugin não pertence ao updater oficial` não reapareceu.
  A única pendência visível é a sessão Proton expirada; nenhuma senha, 2FA ou
  CAPTCHA foi inserida ou registrada.
- Validação local após a correção: os 19 módulos `tests/test-plugin-*.mjs`,
  suíte da GUI (52 arquivos, 408 testes), `npm run compile`, `go test ./...`,
  compilação de teste Windows x64, `./tests/test-userplugin-e2e.sh` (51/51) e
  `git diff --check` passaram.

Resultado: o erro de abertura/manifest foi corrigido e validado no cliente
oficial; não há evidência atual de crash do Discord. O caminho de rede ainda
não pode ser concluído sem login Proton novo: ativação de rota própria, prova
geográfica e transmissão prolongada continuam pendentes. Não houve publicação,
push, release ou alteração externa.

Checkpoint: a VM permanece ligada com o Discord oficial aberto no onboarding,
pronta para o titular autenticar a conta Proton diretamente na tela.

## Retificação r4: limite da compatibilidade com releases públicas

A compatibilidade estreita do metadata legado não torna os assets públicos
antigos instaláveis. A inspeção dos ZIPs públicos confirmou que `v2.0.5`
stable não contém `update-channel.ts` nem `update-security.ts`, e
`v2.0.6-beta-6` não contém `update-security.ts`; portanto,
`validatePluginSourceTree` continua recusando esses artefatos antes da troca.
O teste na VM comprovou a abertura do Discord com o pacote local corrigido e
sem o aviso após a inicialização, mas não comprovou um update público feliz.
O caminho correto para isso continua sendo uma release canônica construída
com a árvore atual; nenhuma release foi publicada nesta rodada.

Após a correção do teste de ciclo de vida, que ainda esperava a forma antiga da
condição de descarte de status, a validação focada passou novamente: onboarding
9/9, ciclo de vida da UI 8/8, canal 7/7, notificação 15/15 e auditoria do
updater 16/16. A falha era do teste obsoleto, não do comportamento novo.

## Revalidação r5: cancelamento não destrutivo do login Proton e abertura após reinício

Data: 2026-09-09.

- A revisão de ciclo de vida identificou um risco concreto: cancelar uma renovação
  ou troca de conta podia reutilizar o caminho destrutivo de logout e apagar a
  sessão Proton canônica anterior. O login agora grava primeiro em um arquivo
  temporário privado e só faz a troca atômica após retorno válido da mesma conta.
- O controller e o native passaram a expor cancelamento imediato por `requestId`;
  o mesmo `AbortSignal` chega ao helper e à janela CAPTCHA. Shutdown, fechamento
  do processo, desmontagem do painel e fechamento do onboarding invalidam a
  tentativa sem apagar a sessão anterior. O painel e o onboarding exibem
  `Cancelar login` enquanto a operação está em andamento.
- Testes novos cobrem preservação byte a byte da sessão anterior durante o
  cancelamento, remoção dos temporários e propagação do request id. Os 19 módulos
  `tests/test-plugin-*.mjs`, 52 arquivos/408 testes Vitest, `tsc --noEmit`,
  `npm run compile`, `go test ./...`, cross-test Windows x64,
  `tests/test-userplugin-e2e.sh` (51/51) e `git diff --check` passaram.
- Pacote local instalado na VM: `/tmp/golive-plugin-vm-20260909132249.zip`,
  6.042.836 bytes, SHA-256
  `2e03c4492a4323e9df2b18e2aa1fc707d3bb2cf7cc843814ccfc9d63cc692856`.
  A cópia para a VM foi conferida pelo mesmo hash; o Vencord executou
  `pnpm.cmd build` e `pnpm.cmd inject` com `Success!`. O pacote anterior foi
  preservado em `C:\Users\teste\Vencord-vm-backups\plugin-before-login-cancel-20260909`.
- Depois do reinício, o Discord oficial abriu autenticado e o GoLiveBypass
  apareceu habilitado nas configurações. O painel e o onboarding abriram sem
  crash; a sessão Proton continuou sem senha, 2FA ou CAPTCHA fornecidos.
- A unidade FAT nova foi desmontada e destruída após a cópia. O share anterior
  da rodada continua anexado como checkpoint já existente; não foi usado para
  a instalação nova.

Limitação observada na mesma abertura: o updater continua exibindo uma falha
controlada ao consultar o ZIP público incompatível (`archive do plugin não
contém update-channel.ts`, e em uma consulta posterior timeout). Isso não é
erro de abertura do Discord e não deve ser resolvido relaxando as validações:
os assets públicos inspecionados continuam sem toda a árvore exigida, enquanto
o pacote local instalado contém os arquivos necessários. O caminho feliz do
updater público exige uma nova release canônica; não houve publicação, push,
release ou envio de mensagem.

Checkpoint atual: VM `win11` ligada, Discord oficial aberto, onboarding na tela
de login Proton, VPN inativa e sem credenciais digitadas. Restam login Proton
novo, preparação/ativação de rota, prova externa de saída e teste prolongado.

## Revalidação r6: journal transacional e lock entre processos do updater

Data: 2026-09-09.

- Uma revisão independente confirmou três riscos de alta prioridade no updater:
  morte entre o primeiro `rename` e o marcador, concorrência entre processos e
  rollback beta sem recuperação após queda. Também confirmou a possibilidade de
  falha de `rename` quando o TEMP do Windows fica em outro volume.
- O updater agora grava `phase: "preparing"` antes de mover a árvore instalada e
  só avança para `phase: "prepared"` depois do build e do digest da árvore. No
  boot, no status e antes de check/update, a rotina recupera o backup anterior
  quando a troca foi interrompida; o rollback beta usa também
  `phase: "rolling-back"` e nome temporário validado. A validação de manifest,
  SHA-256, árvore obrigatória e URLs oficiais permanece estrita.
- Foi adicionado `plugin-update.lock`, criado atomicamente com `open(..., "wx")`,
  com PID/token, recuperação de lock órfão e reentrada segura dentro do mesmo
  processo. Check, update, status e descarte de beta usam o mesmo lock. O
  staging agora fica em `.golivebypass-update-staging` dentro do checkout para
  manter a troca no mesmo volume do target.
- A auditoria focada passou 20/20; a suíte nativa do updater passou 11/11;
  os 19 módulos `tests/test-plugin-*.mjs`, a suíte GUI (52 arquivos, 412
  testes), paridade (30 casos), `npm run compile`, `tsc --noEmit`, compilação
  Windows x64, `tests/test-userplugin-e2e.sh` (51/51) e `git diff --check`
  passaram.
- O pacote local usado na nova rodada da VM foi
  `/tmp/golive-plugin-vm-20260909135248.zip`, 6.046.115 bytes, SHA-256
  `d7b499eecbff773644bd45b348e95fa991e4ec0913ff32457806fe8aae51483a`.
  A cópia na VM confirmou o mesmo hash; build e inject terminaram com
  `Success!`, e o Discord oficial abriu normalmente após o relaunch. O plugin
  apareceu habilitado nas configurações.
- O painel do plugin ainda mostra a falha controlada `update request timed out`
  ao consultar o release público. Isso é consequência do endpoint/asset público
  incompatível ou indisponível, não falha de abertura do Discord; as validações
  não foram relaxadas e nenhuma release, push ou mensagem foi enviada.
- Nenhuma senha, 2FA ou CAPTCHA foi digitada. O share novo foi desmontado e
  destruído; o share antigo de checkpoint continua anexado em `sdc` e não foi
  tocado.

Checkpoint atual: VM `win11` ligada, Discord oficial aberto, painel do
GoLiveBypass visível na tela de login Proton, sem credenciais fornecidas. A
meta de rede ainda depende do titular autenticar a conta e permitir a repetição
de preparação, ativação, restauração e teste prolongado.

## Revalidação r7: reinício controlado e regressão do cleanup de probes

Data: 2026-09-09.

- O Discord oficial foi fechado pelo caminho normal e relançado pelo
  `C:\Users\teste\AppData\Local\Discord\Update.exe --processStart Discord.exe`.
  Após a espera de inicialização, a interface normal abriu sem erro visível;
  não houve crash reproduzível nem ciclo de relaunch observado nessa rodada.
- Depois do boot, o Vencord carregou novamente e o card do GoLiveBypass apareceu
  habilitado. O painel abriu e estabilizou em `VPN inativa`; nenhum segredo,
  senha, 2FA ou CAPTCHA foi digitado.
- Os testes focados de route-probe, lifecycle, execução, recuperação, lifecycle
  do plugin e concorrência de ownership passaram: 25 casos no total. A suíte
  completa dos 19 módulos `tests/test-plugin-*.mjs` também passou; `git diff
  --check` permaneceu limpo.
- A revisão independente não encontrou defeito reproduzido na abertura, mas
  deixou duas lacunas reais: não há E2E Windows para um `.exe` de probe mantido
  aberto por outro processo, nem uma rodada com onboarding Proton concluído que
  exercite `boot → relaunch → adoção` sob falha de serviço. Essas lacunas não
  são cobertas por testes textuais e continuam pendentes.
- O timeout do updater público continua controlado e separado da inicialização
  do Discord. Não houve relaxamento da validação, release, push ou mensagem.

Checkpoint atual: VM `win11` ligada, Discord oficial e GoLiveBypass abertos no
login Proton, VPN inativa e share antigo de checkpoint ainda anexado em `sdc`.
Próximo avanço verificável: autenticação Proton pelo titular; em paralelo,
aplicar somente após aprovação o guard de uma tentativa para relaunch automático
e testar a recuperação de probe bloqueado na VM.

## Revalidação r8: guard de autostart e abertura do Discord oficial

Data: 2026-09-09.

- O controller agora reconhece um owner que marcou `restarting: true` mas voltou
  sem WireSock ativo. Nesse caso, limpa o probe, entra em
  `recovery_required` e suspende somente o autostart daquele boot. Uma chamada
  manual a `enable()` remove a supressão e mantém o retry explícito disponível;
  filtros de aplicativo, WireGuard e modos customizados não foram alterados.
- O boot nativo consulta esse estado antes de chamar `enable()` e registra a
  suspensão sem iniciar outro ciclo automático. Foram adicionadas as asserções
  de recuperação e onboarding para esse contrato.
- Durante a validação do asset na VM, `pnpm.cmd testTsc` inicialmente revelou
  duas incompatibilidades de tipagem já existentes no pacote distribuído: a
  resposta de erro do updater não declarava os campos opcionais do status e o
  leitor do lock retornava `unknown` como PID. Ambas foram corrigidas na fonte;
  depois disso `testTsc`, `pnpm.cmd build` e `pnpm.cmd inject` terminaram sem
  erro, com `Success!` no injetor oficial.
- O pacote usado foi `/tmp/golive-plugin-vm-20260909143418.zip`, 6.046.319
  bytes, SHA-256
  `78126ea1bde40120c672a7d089090be1fd8151c2aac8f76fa78a0650cfa37e12`.
  O asset E2E local passou 51/51 e confirmou helper Windows x64, manifest,
  hashes e rollback.
- Após o inject, o Discord foi relançado pelo `Update.exe --processStart
  Discord.exe`. A tela normal abriu depois do carregamento; o card do
  GoLiveBypass apareceu habilitado, e o painel abriu sem crash. A sessão VPN já
  persistida foi reconhecida como WireGuard ativa; nenhuma senha, 2FA ou CAPTCHA
  foi digitada.
- A única falha visível continua sendo `update request timed out` ao consultar
  o release público. Ela permanece separada da abertura do Discord e não levou
  a relaxamento das validações. Não houve release, push ou mensagem.
- A unidade FAT temporária `sdd` foi desmontada e destruída; o checkpoint antigo
  `sdc` continua anexado sem alteração.

As regressões finais passaram: os 19 módulos `tests/test-plugin-*.mjs`, Vitest
(52 arquivos, 412 testes), `npm run compile`, `tests/test-userplugin-e2e.sh`
(51/51) e `git diff --check`. Permanecem pendentes somente a E2E Windows com
`.exe` de probe realmente bloqueado por outro processo e a rodada controlada de
falha de serviço com `boot → relaunch → adoção`; a abertura normal do Discord
oficial e o caminho de recuperação de autostart já foram exercitados.

## Revalidação r9: instalador PowerShell beta e envio para main

Data: 2026-09-09.

- `installer/GoLiveBypass-Installer.ps1` deixou de abortar na entrada e agora
  mostra explicitamente o canal `[BETA]`. Ele distribui todas as fontes do
  plugin WireGuard e baixa o `proton-confgen.exe` Windows x64 da beta com
  validação SHA-256; `-PluginSource` continua preferindo um helper local.
- O PowerShell da VM Windows executou o script em `-Mode CheckUpdate` sem erro
  de parsing, mostrou o aviso beta e reconheceu o plugin instalado
  `v2.0.0-beta.1`. O teste de paridade local terminou com 32/32 casos.
- O conjunto consolidado foi commitado em `d8146b5` e integrado à base oficial
  em `22a4cbc`. O push foi confirmado em `bezumiya/GoLiveBypass` como
  `upstream/main`; não houve tag, release ou mensagem de Discord criada.
- `.codex/` e `tmp/` ficaram fora do commit por serem estado local/artefatos
  temporários. O checkpoint antigo da VM em `sdc` permaneceu intocado.

As lacunas de cobertura de probe bloqueado por outro processo e de falha de
serviço no ciclo `boot → relaunch → adoção` continuam explicitamente pendentes;
encerrar o loop nesta rodada não transforma essas hipóteses em evidência.
