# Follow-up do CAPTCHA Proton — 2026-09-06

Este registro complementa a [triagem global de 2026-09-06](2026-09-06-global-issue-triage.md), que acompanha 22 issues abertas. O foco aqui é a #239 e o relato do usuário sobre perdas de resposta CAPTCHA. O usuário colou `ReferenceError: _dirname is not defined` (um underscore) e relatou a ocorrência na 2.0.4; `_dirname` não foi reproduzido na fonte ou bundles auditados. A #230 histórica registra `__dirname` (dois underscores), um caso distinto; o código atual declara `__dirname` corretamente e não permite atribuir automaticamente os dois relatos à correção de captura.

## Evidência e correção

O baseline reproduziu duas perdas no Electron real 43.4.1, registradas em `/tmp/captcha-race.log`:

| Caso | Causa observada | Resultado após a correção |
|---|---|---|
| A — mensagem antes de `did-finish-load` | O listener era instalado tarde por `executeJavaScript`; a resposta já emitida era perdida. | Corrigido pelo preload sandbox, que registra `window.message` antes dos scripts da página e encaminha por IPC dedicado. |
| B — inválida seguida imediatamente de válida | O script removia o listener na inválida; o main só o rearmava 50 ms depois. | Corrigido pela captura persistente: inválidas contam até 10 sem remover/rearmar o listener. |

Os controles de fluxo normal e cancelamento passaram 12/12 no baseline local. Após o patch, `/tmp/captcha-postfix-early.log` registra 20/20 casos no Electron real com preload IPC e HTTPS sintético: 10/10 de captura antecipada e 10/10 de resposta inválida seguida imediatamente de válida. Esse log não contém casos de cancelamento ou destruição. O runner posterior registra 13/13 (log `/tmp/golive-captcha-run-20260906.log`, SHA-256 `cad16f5cf6015e60a3e2b3315cb2ea47599283ff8728a38f7d847d27f01936e1`): cinco fechamentos, cinco destruições, uma captura antecipada, uma sequência inválida-válida e um sucesso puro, com listeners IPC contados por ciclo e todas as janelas destruídas. Esses testes são E2E sintéticos; nenhum usa o desafio oficial Proton.

Uma regressão adicional foi reproduzida em `/tmp/captcha-early-close.log`: 4/5 fechamentos antecipados terminavam como `CAPTCHA_INVALID` por uma navegação abortada vencer o evento `closed`. O handler `close` agora chama `finish(CAPTCHA_CANCELLED)` imediatamente, antes do abort; o fallback `closed` permanece para destruição direta. Após a correção, os cenários de 5 fechamentos e 5 destruições passaram 10/10 como `CAPTCHA_CANCELLED`.

O preload é CommonJS sandbox (`proton-captcha-preload.cjs`), sem Node/API genérica exposta à página. O main registra o handler antes de `loadURL`, restringe `sender` à janela CAPTCHA, exige o frame principal e valida o URL do frame com o allowlist existente. O `event.origin` não foi transformado em requisito novo, para preservar o contrato de `postMessage` por iframe. O token continua sujeito ao tipo aceito, prefixo do desafio e limite existente. O cleanup remove o handler IPC e listeners em sucesso, cancelamento, falha de navegação, `preload-error`, preload ausente, décima inválida e timeout de 120 s.

O arquivo ausente é detectado antes da criação da janela. Um preload corrompido emite `preload-error` e termina imediatamente com `CAPTCHA_INVALID`; esses caminhos não aguardam o timeout. A referência de sessão capturada antes de `destroy`, já existente no código, foi preservada.

O cenário Linux final, em `/tmp/golive-captcha-final-linux/summary.json`, passou 61/61 ações com providers sintéticos: cinco ciclos de cada uma das 12 ações (`success`, `double-click`, `retry`, `close`, `destroy`, `early-response`, `invalid-immediate-valid`, `invalid`, `loadfailure`, `missing-helper`, `missing-preload` e `corrupt-preload`), mais um timeout isolado. O bootstrap usado tem SHA-256 `e3aaaf814bda373c7c067cadf5e0ebdedd295c35d8c225eec01e18e44b9d9a35`. O timeout levou 120,002 s até expirar, com janela fechada e contador IPC em zero; isso confirma o prazo configurado e não representa uma falha de preload. Nenhuma dessas ações acessa o desafio oficial Proton.

## Auditoria do artefato 2.0.4

O manifest local em `/tmp/golive-release-check/release.json` é um snapshot anterior: identifica a tag `v2.0.4`, `isPrerelease: false` e `isDraft: true`, com assets em URLs `untagged-*`. A consulta read-only atual ao upstream `bezumiya/GoLiveBypass` identifica o release `v2.0.4` como `draft=false`, `prerelease=false`, publicado em `2026-09-05T16:57:19Z`, commit `95f751059520a75d18eba844ed29cada2464565c`. O checkout local aponta para `pdl-clay/GoLiveBypass`, portanto a procedência do release upstream e do checkout é diferente. Os hashes abaixo são dos artefatos auditados e não devem ser tratados como prova de que o binário usado pelo usuário tinha os mesmos bytes:

- snapshot local AppImage: `db046ce8cce21445e385203f29b752e7a9aab1dcd350149f0a36bb8e02968c7d`, 150207093 bytes.
- snapshot local EXE: `5be507ba05e57e4087581d28fe78a0244ff7db56f032f87f7980594a279e9201`, 111439270 bytes.
- build local Windows final: EXE `bc140966636813c9ff64f7561fb163a87d8a31e82c83b51470effbe3a8516db3`; `app.asar` `aa8f5c25136705bebfcfebd744a180bd0a7458de0bb20755c7564088579c38c7`; `main.js` `42fe01769fa7f0845d3d4f2b20498ade2cf2a9d17608bd6a95c0959e5cf2dc46`; preload CJS `9037d6d51f54096ad0ea2b87e3841ff6513b0f6111aec886807e08b26ecf3acb`.

O `verification-2026-09-06.txt` registra `npm test` com 25 arquivos/206 testes e `npm run build:win --publish never`. A extração do EXE upstream auditado (`/tmp/golive-official-ywqIZd/app/resources/app.asar`) não contém `proton-captcha-preload.cjs`, indicando um artefato anterior à correção; também não há `_dirname` (um underscore) em fonte ou bundles auditados. `__dirname` (dois) existe na fonte TypeScript em usos legítimos e é transformado pelo bundler nos bundles. O EXE upstream não foi executado na auditoria; os builds/runners sintéticos locais foram executados e nenhum artefato foi publicado.

Na VM Windows, a suíte completa registrou 61/61 PASS, com smoke 5/5 e o Full-Repeat 13/13; o runner CAPTCHA/lifecycle também registrou 13/13. Os resultados estão em `/tmp/e2e-suite-summary-full-r5.json`, `/tmp/e2e-results-metadata.json` e `/tmp/e2e-results-host-r5` (427 arquivos). O `main.js` (`42fe0176...`) e o preload (`9037d6d5...`) coincidem com os hashes do build local auditado. O timeout observado foi de aproximadamente 122 s com overhead de execução. Os shares E/F preexistentes foram preservados e os diretórios de teste foram limpos; o cleanup dos 79 diretórios guest ainda não foi confirmado. A GUI original permaneceu visível e nenhum segredo foi registrado. O `exitCode` ausente limita somente o wrapper do runner de captura; os 61 casos Windows completos terminaram com exit 0.

## Matriz pendente

| Verificação | Situação | Limite |
|---|---|---|
| Regressão unitária CAPTCHA | PASS, 6/6; suíte completa 25 arquivos/206 testes | Não exercita Proton oficial. |
| Compilação e pacote Windows | `npm run build:win` PASS com `--publish never` | Não prova execução do instalador/EXE na VM. |
| Captura/lifecycle Electron real com HTTPS sintético | PASS, 20/20 timing; 13/13 runner; 10/10 close/destroy como cancelamento | Exercita a camada de captura; não é login E2E nem desafio oficial Proton. |
| E2E Linux sintético final | 61/61 PASS; 12 ações × 5 ciclos + timeout | Providers sintéticos; não prova o desafio oficial Proton. |
| E2E completo do login com CAPTCHA oficial | PENDENTE | Depende de ambiente/credenciais e rede autorizados. |
| VM Windows / pacote 2.0.4 | Suíte completa 61/61, smoke 5/5, Full-Repeat 13/13 e captura/lifecycle 13/13 PASS | Runtime Electron 43.4.1 e HTTPS sintético; o relato original com desafio oficial não foi provado. |
| Review de fluxo/produto | PASS na auditoria independente Linux/Windows | Ainda não equivale à validação do desafio oficial. |

O fluxo local da #239 está validado com providers sintéticos. O relato original com o desafio oficial Proton não foi provado; `_dirname` em 2.0.4 também não foi reproduzido localmente. Nenhuma issue foi fechada ou marcada como resolvida.
