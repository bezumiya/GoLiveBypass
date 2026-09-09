# Limpeza de deduplicação do updater no lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Garantir que deduplicação e supressão de erros do updater não atravessem a desativação do plugin.

**Architecture:** O renderer limpará as duas chaves de erro no `stop()`, depois da invalidação de geração. O estado persistido de adiamento e o contrato nativo permanecerão separados e inalterados.

**Tech Stack:** TypeScript/TSX do userplugin Vencord e testes-fonte Node.js.

**Spec:** `docs/superpowers/specs/2026-09-09-plugin-update-error-lifecycle-design.md`

## Global Constraints

- Não alterar IPC, Proton, WireGuard, rotas ou shutdown nativo.
- Não persistir chaves de erro nem remover verificações de integridade.
- Preservar alterações existentes do worktree; não fazer push, release ou deploy.

---

### Task 1: Limpeza no stop

**Files:**
- Modify: `tests/test-plugin-lifecycle.mjs`
- Modify: `goLiveBypass/index.tsx`

**Interfaces:**
- Consumes: chaves internas `lastNotifiedUpdateErrorKey` e
  `lastSuppressedUpdateErrorKey`.
- Produces: novo lifecycle sem supressão herdada de uma execução anterior.

- [x] **Step 1: Write the failing test**

No bloco de `stop()` exigir:

```js
assert.match(stopBlock, /lastNotifiedUpdateErrorKey = null/);
assert.match(stopBlock, /lastSuppressedUpdateErrorKey = null/);
```

- [x] **Step 2: Run the focused test to verify failure**

Run: `node --experimental-strip-types tests/test-plugin-lifecycle.mjs`

Expected: FAIL porque `stop()` ainda não limpa as duas chaves.

- [x] **Step 3: Implement the minimal reset**

Após `pluginLifecycleGeneration++` no `stop()`, atribuir `null` às duas chaves.
Não alterar `lastNotifiedPendingVersion`, as preferências persistidas ou as
chamadas nativas.

- [x] **Step 4: Run the focused test**

Run: `node --experimental-strip-types tests/test-plugin-lifecycle.mjs`

Expected: PASS com 4/4.

### Task 2: Integração e validação

**Files:**
- Modify: `docs/superpowers/reports/2026-09-07-plugin-update-validation.md`
- Modify: `docs/superpowers/plans/2026-09-09-plugin-update-error-lifecycle.md`

**Interfaces:**
- Consumes: reset implementado e suíte existente.
- Produces: evidência local, pacote Windows e registro de limitação.

- [x] **Step 1: Review boundaries**

Confirmar que o diff só limpa chaves de memória no renderer e não adiciona
privilégios, persistência, IPC, rota ou restart.

- [x] **Step 2: Run checks**

Executar todos os `tests/test-plugin-*.mjs`, `go test ./...` em
`tools/proton-confgen/`, `./tests/test-userplugin-e2e.sh` e `git diff --check`.

- [x] **Step 3: Validate Windows**

Gerar um ZIP final, instalar na VM `win11` com backup e executar
`pnpm.cmd testTsc` e `pnpm.cmd build`.

- [x] **Step 4: Clean and record**

Ejetar H:, confirmar `PathNotFound`, destacar/destruir somente o share da
rodada, preservar `sdc`, `sdd`, `sde` e registrar o hash/backup.
