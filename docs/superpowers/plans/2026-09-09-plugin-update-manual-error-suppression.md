# Plugin Update Manual Error Suppression Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Evitar que o overlay automático duplique imediatamente o feedback de uma falha acionada manualmente.

**Architecture:** O renderer centralizará a normalização da chave de erro e consumirá uma supressão one-shot antes de exibir o toast automático. O contrato nativo e o estado persistido não serão alterados.

**Tech Stack:** TypeScript/TSX do userplugin Vencord, testes-fonte Node.js, helper Go Proton e build Windows/Vencord.

**Spec:** `docs/superpowers/specs/2026-09-09-plugin-update-manual-error-suppression-design.md`

## Global Constraints

- Manter o feedback atual do card e dos botões manuais.
- Não silenciar a mesma falha em observações automáticas posteriores.
- Não modificar o contrato IPC, sessão Proton, WireGuard, chamadas ou reinício automático.
- Preservar o worktree e não fazer push, release ou deploy.

---

### Task 1: Chave e supressão one-shot

**Files:**
- Modify: `tests/test-plugin-update-notification.mjs`
- Modify: `goLiveBypass/index.tsx`

**Interfaces:**
- Consumes: `PluginUpdateStatus.current`, `.channel`, `.lastError` e resultados manuais de `check/update`.
- Produces: `updateErrorKey`, `suppressPluginUpdateFailure` e consulta de status sem duplicata imediata.

- [x] **Step 1: Write the failing test**

Exigir uma chave comum de erro, uma variável de supressão, o consumo one-shot da
chave no helper de notificação e chamadas a partir dos ramos de falha de
`check`, `update` e `refreshStatus`. Manter a asserção de que a mensagem manual
continua sendo definida e exibida.

- [x] **Step 2: Run the focused test to verify failure**

Run: `node --experimental-strip-types tests/test-plugin-update-notification.mjs`

Expected: FAIL porque ainda não existe a chave/supressão nem os pontos manuais.

- [x] **Step 3: Implement the minimal renderer-only guard**

Criar uma função de chave que normalize canal, versão e erro truncado; registrar
a chave nos erros manuais; fazer `notifyPluginUpdateFailure` consumir e retornar
na primeira observação igual; limpar a chave quando o status não tiver erro.
Manter os toasts e labels manuais já existentes.

- [x] **Step 4: Run the focused test**

Run: `node --experimental-strip-types tests/test-plugin-update-notification.mjs`

Expected: PASS com 11 testes.

### Task 2: Revisão integrada, VM e registro

**Files:**
- Modify: `docs/superpowers/reports/2026-09-07-plugin-update-validation.md`
- Modify: `docs/superpowers/plans/2026-09-09-plugin-update-manual-error-suppression.md`

**Interfaces:**
- Consumes: helper de chave/supressão e suíte existente.
- Produces: evidência local, artefato Windows, build integrado e limitação registrada.

- [x] **Step 1: Review no-privilege and persistence boundaries**

Confirmar que o novo caminho não chama `restartDiscord`, `Native.enable`,
`Native.shutdown`, `app.relaunch`, `app.quit` ou operações de rota, e que nenhuma
chave de erro manual é persistida.

- [x] **Step 2: Run complete local checks**

Run: `for test_file in tests/test-plugin-*.mjs; do node --experimental-strip-types "$test_file" || exit 1; done`, `(cd tools/proton-confgen && go test ./...)`, `./tests/test-userplugin-e2e.sh` e `git diff --check`.

- [x] **Step 3: Validate the integrated Windows build**

Gerar um pacote versionado, instalar na VM `win11` com backup, executar
`pnpm.cmd testTsc` e `pnpm.cmd build`, sem exigir login ou reinício do Discord.

- [x] **Step 4: Clean transport and update checkpoint**

Ejetar H:, confirmar a unidade ausente, destacar/destruir somente o share desta
rodada, preservar `sdc`, `sdd`, `sde`, registrar hash/backup/limitações e marcar
o plano concluído.
