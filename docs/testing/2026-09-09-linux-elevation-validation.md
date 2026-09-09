# Validação da elevação Linux — issue #258

## Causa confirmada

Na GUI Linux, o standalone encerrava o Discord antes de validar a elevação. Quando o
`zenity`/`kdialog` não retornava uma credencial utilizável, a execução terminava com
`Falha: nao foi possivel obter a senha do sudo`, deixando o cliente fechado. O log antigo
não permitia distinguir diálogo não aberto, cancelamento, entrada vazia, senha recusada e
senha aceita.

## Correção validada

- A autorização sudo/pkexec e o executor do usuário são verificados antes de
  `stop_discord` e de `cleanup_legacy_tor`.
- `prompt.finished` registra apenas estado sanitizado de entrada; `sudo.validation` é o
  único evento que confirma aceitação real da senha.
- `zenity` e `kdialog` têm fallback apenas para falha técnica. Cancelamento, entrada vazia
  e senha recusada não abrem outro pedido; `NONINTERACTIVE=1` nunca abre prompt nem usa
  `pkexec`.
- Eventos `[elevation]` são filtrados por whitelist no processo Electron e persistidos no
  `gui.log`; stderr bruto, senha, tamanho de segredo, token e códigos arbitrários não são
  persistidos.
- Falhas após o fechamento removem o namespace parcial quando possível e tentam reabrir o
  Discord fora do bypass somente depois de confirmar que não há namespace ativo.

## Comandos e resultados

| Verificação | Resultado |
|---|---|
| `bash -n standalone/golivebypass-standalone.sh` | passou |
| `/bin/sh -n standalone/golivebypass-standalone.sh` | passou |
| `npm test -- tests/linux-elevation.test.ts tests/linux-preflight.test.ts tests/linux-sudo.test.ts tests/linux-elevation-logger.test.ts tests/gui-preflight-integration.test.ts` | 5 arquivos, 41 testes passaram |
| `npm run compile` em `golive-gui/` | passou; sync-bypass em dia, helper Proton, TypeScript e Vite concluídos |
| `GOLIVE_GUI=1 bash standalone/golivebypass-standalone.sh --preflight --json` | `ok=true`; CachyOS, dependências presentes, sudo/netns disponíveis, WireGuard disponível, 8 instalações detectadas |
| `git diff --check` | passou |

`npm test` completo também foi executado: 377 de 380 testes passaram. Os 3 testes que
falharam pertencem ao updater/UI do plugin (`plugin-update-native.test.ts` e
`plugin-update-ui.test.ts`), arquivos que já estavam modificados no worktree antes desta
correção e que não foram tocados pelos commits Linux. As cinco suítes Linux acima passam
integralmente.

## Limitações

Os testes de prompt usam executores falsos para cobrir aceitação, cancelamento, falha do
provedor e recusa sem expor segredo. Não foi reproduzido visualmente um diálogo Wayland real
nem executado um Discord real dentro do namespace nesta validação; portanto, os testes não
substituem um teste manual da GUI na sessão afetada. Nenhuma VM ou release foi alterada por
esta correção.
