# Triagem das issues de produção — 2026-09-10

Fila de `bezumiya/GoLiveBypass` (repo de produção, destino dos relatos da API).
Seis issues abertas na abertura da rodada (#258 a #263), todas relatos da GUI.
Nenhum artefato foi publicado, nenhuma credencial ou sessão Proton foi usada.

## Resultado por issue

| Issue | Versão / plataforma | Estado | Desfecho |
|---|---|---|---|
| [#263](https://github.com/bezumiya/GoLiveBypass/issues/263) | 2.0.5 / linux-x64 (Bazzite) | defeito confirmado | corrigido e fechado |
| [#260](https://github.com/bezumiya/GoLiveBypass/issues/260) | instalador do plugin / win32 | defeito confirmado | corrigido e fechado |
| [#258](https://github.com/bezumiya/GoLiveBypass/issues/258) | 2.0.5 / linux-x64 | defeito de diagnóstico confirmado; sintoma relatado é de rede | corrigido e fechado |
| [#259](https://github.com/bezumiya/GoLiveBypass/issues/259) | 2.0.5 / win32-x64 | sem defeito demonstrado | aberto; evidência pedida |
| [#261](https://github.com/bezumiya/GoLiveBypass/issues/261) | 2.0.5 / win32-x64 | causa do helper desconhecida | aberto; log da falha passou a ser registrado |
| [#262](https://github.com/bezumiya/GoLiveBypass/issues/262) | 2.0.5 / win32-x64 | sem defeito demonstrado | aberto; evidência pedida |

## #263 — alvo de relançamento no Linux

`ACTIVATION_ROLLBACK_TARGET` e a chamada de `start_discord` usavam a **primeira linha** de `$FOUND`. No Bazzite essa linha é a pasta de bootstrap `~/.config/discord/app-1.0.156/resources`, que não tem executável, enquanto o cliente real é o Flatpak `com.discordapp.Discord` — detectado na terceira linha, com o `flatpak_id` no 4º campo do formato interno. `start_discord` não achava binário nativo, ignorava o id e ficava sem comando; a espera esgotava em 20 s (mais o `stop_discord`), o namespace era removido e a GUI mostrava "Discord nao iniciou dentro do namespace WireGuard" — os ~43 s por ciclo do relato.

O mesmo `flatpak_id` ausente prejudica a detecção: no sandbox do bubblewrap `pgrep -x Discord` não enxerga o processo e o script precisa de `flatpak ps`.

A mensagem de erro também chegava truncada: `stripAnsiCodes` casava o `[` de um texto comum como início de sequência ANSI, transformando `[OK]` em `K]` e `[X]` em `]`. `tailErroScript` ainda usava as linhas informativas do teardown no lugar da causa.

Correção: `select_launch_target` (cliente em execução → primeiro alvo executável → primeira linha), leitura do `flatpak_id` a partir do próprio alvo em `start_discord`/`wait_discord_started`, `setup_wireguard_netns` uma única vez, `stripAnsiCodes` restrito a sequências reais e `tailErroScript` filtrando o teardown.

Verificação local: reprodução da escolha de alvo com stubs do cenário Bazzite (antes: comando vazio; depois: `flatpak run com.discordapp.Discord`); `golive-gui/tests/linux-script-error-message.test.ts` falha no código anterior e passa no atual. **Limite:** não há sessão Bazzite aqui; o caminho Flatpak foi exercitado com stub.

## #260 — helper do instalador do plugin

O instalador só procurava `$PluginSource\bin\win32-x64\proton-confgen.exe`. No asset `v2.0.6-beta-7` (zip de 11.503.425 bytes, sha256 `da449e0a…`) o helper está em `goLiveBypass/bin/win32-x64/proton-confgen.exe` (14.771.200 bytes), e um checkout o produz em `tools\proton-confgen\build\`. Sem reconhecer nenhum deles, restava o download pela API do GitHub — sujeito a rate limit — que ainda enviava `Accept` de API no download direto do asset.

Correção: resolução dos layouts reais (sem varrer `Downloads`), validação por `proton-confgen-manifest.json`/`.sha256` quando disponível, download preferindo o manifesto para nome e hash canônicos, e `-PluginSource` aceitando a pasta extraída do zip.

**Achado relacionado:** na `v2.0.6-beta-7` o helper dentro do zip (`ced12d2d…`) e o asset declarado no manifesto (`84c88bbb…`) são binários diferentes — o job `release-assets` compilava sem `-buildid=`, ao contrário do `build-proton.mjs` que gera o manifesto. As flags foram alinhadas; a paridade byte a byte só se confirma no próximo release publicado.

## #258 — diagnóstico enganoso na desativação

`pararWgStatsWatchdog()` e `stopLinuxHealthWatchdog()` eram chamados depois de `runScript(["--uninstall"])`, que encerra o Discord. O monitor então registrava `Discord não está dentro do namespace WireGuard` como falha durante a desativação. Corrigido: os watchdogs param antes do script.

O restante do relato é ambiente: a primeira tentativa foi cancelada no diálogo de senha (tratada corretamente, sem alterar o sistema), a segunda concluiu bem, e o "preso em Iniciando..." acompanha `net::ERR_TIMED_OUT` no updater **antes** de existir namespace, com a rota `US-FREE#41` a 225 ms de ping. Nada disso é defeito de produto.

## #259, #261 e #262 — abertas

- **#259:** o log prova que o processo do Discord foi iniciado e mantido vivo (`running.tasklist ok=sim` contínuo), mas o túnel ficou sem handshake (`prontidao.diagnostica verified=false`, `route.probe success=false`). O cliente abre e não conecta. Probes são log-only por invariante, então a ativação não é revertida. A hipótese da janela oculta (`windowsHide: true` marca `STARTUPINFO` com `SW_HIDE`) foi examinada e **não** confirmada: a aceitação da 2.0.4 registra o Discord abrindo logado com a flag presente, e o código não foi alterado. Foi pedido ao autor: janela visível ou não, handshake no diagnóstico e A/B sem o bypass.
- **#261:** o helper saiu com código 1 após 150 s e `resposta_json=true`, mas a GUI registrava apenas `codigo_saida`/`resposta_json` e descartava a mensagem. O log passou a incluir o motivo (limitado a 300 caracteres), o código estruturado e a validade da medição. A causa do código 1 depende de um relato novo.
- **#262:** às 21:00:15 o probe registra `success=true discord_ok=true` com saída em MX — o HTTPS do Discord responde de dentro do túnel. Câmera e compartilhamento de tela usam a mesma `RTCPeerConnection`; se o transporte não passasse pelo WireSock, a câmera também falharia. Tela preta com câmera funcionando aponta para captura gráfica do Windows (DXGI/GPU), não para a rota. Sem patch.

## Verificação da rodada

`npm test` 55 arquivos / 458 testes; `bash -n standalone/golivebypass-standalone.sh`; `tests/test-netmode-linux.sh` 16/16; `tests/test-linux-netns-detection.sh` e `tests/test-linux-diagnostic.sh` OK; `tests/test-distribution-parity.cjs` 32/32; `tests/test-userplugin-e2e.sh` 51/51; `git diff --check` limpo.

Limites: nenhuma das mudanças foi validada em Bazzite, Windows real ou VM nesta rodada; a paridade byte a byte do helper e a execução do instalador PowerShell dependem de um release/VM. Commit `5131d96`, não publicado.
