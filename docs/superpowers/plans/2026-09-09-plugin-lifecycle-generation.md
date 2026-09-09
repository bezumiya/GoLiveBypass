# Guarda de geração no lifecycle do plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Impedir efeitos assíncronos tardios do renderer depois que o plugin for desativado ou reiniciado.

**Architecture:** `goLiveBypass/index.tsx` usará um contador de geração compartilhado pelo `start()` e `stop()`. Cada callback de onboarding, consulta inicial do updater e ativação nativa verificará a geração capturada antes de tocar a UI ou registrar erro. O contrato nativo e a rotina de shutdown permanecem inalterados.

**Tech Stack:** TypeScript/TSX do userplugin Vencord, testes-fonte Node.js, helper Go Proton e build Windows/Vencord.

**Spec:** `docs/superpowers/specs/2026-09-09-plugin-lifecycle-generation-design.md`

## Global Constraints

- Preservar o isolamento por aplicativo e não assumir nem parar WireSock externo.
- Não cancelar promises IPC já enviadas nem alterar o contrato nativo.
- Não introduzir persistência, privilégio, reload ou alteração de rota neste ciclo.
- Preservar alterações existentes do worktree; não fazer push, release ou deploy.

---

### Task 1: Regressão do lifecycle

**Files:**
- Modify: `tests/test-plugin-lifecycle.mjs`
- Read: `goLiveBypass/index.tsx`

**Interfaces:**
- Consumes: lifecycle `start()`/`stop()` e callbacks assíncronos atuais.
- Produces: assertions para geração capturada, invalidação e descarte de
  respostas stale.

- [x] **Step 1: Write the failing test**

Adicionar um caso que encontre o bloco de `start()` e exija:

```js
assert.match(source, /let pluginLifecycleGeneration = 0/);
assert.match(startBlock, /const lifecycleGeneration = \+\+pluginLifecycleGeneration/);
assert.match(startBlock, /const isLifecycleCurrent = \(\) => lifecycleGeneration === pluginLifecycleGeneration/);
assert.match(startBlock, /if \(!isLifecycleCurrent\(\)\) return;/);
assert.match(startBlock, /isLifecycleCurrent\(\) && settings\.store\.onboardingCompleted/);
assert.match(stopBlock, /pluginLifecycleGeneration\+\+/);
```

Também exigir uma guarda no `.then` da consulta inicial de status e no `.then`
da ativação, mantendo as verificações de `Native.enable` e `getStatus`.

- [x] **Step 2: Run the focused test to verify failure**

Run: `node --experimental-strip-types tests/test-plugin-lifecycle.mjs`

Expected: FAIL porque o contador de geração e as guardas ainda não existem.

- [x] **Step 3: Implement the minimal generation guard**

Em `goLiveBypass/index.tsx`:

1. Declarar `let pluginLifecycleGeneration = 0` junto dos timers globais.
2. No início de `start()`, capturar `const lifecycleGeneration = ++pluginLifecycleGeneration` e definir `isLifecycleCurrent`.
3. Consultar `isLifecycleCurrent()` antes de abrir o onboarding e antes de processar o resultado/erro de `getStatus()`.
4. Consultar `isLifecycleCurrent()` antes de exibir o erro retornado por `Native.enable()` ou registrar sua rejeição.
5. No início de `stop()`, incrementar `pluginLifecycleGeneration` antes de limpar timers e solicitar `Native.shutdown()`.

Não alterar a chamada nativa em si, o fluxo de ativação, o `shutdown()` ou os
componentes do updater.

- [x] **Step 4: Run the focused test**

Run: `node --experimental-strip-types tests/test-plugin-lifecycle.mjs`

Expected: PASS com 3/3 ou 4/4, conforme o número final de casos, incluindo a
regressão da geração.

### Task 2: Revisão integrada e VM

**Files:**
- Modify: `docs/superpowers/reports/2026-09-07-plugin-update-validation.md`
- Modify: `docs/superpowers/plans/2026-09-09-plugin-lifecycle-generation.md`

**Interfaces:**
- Consumes: guarda implementada e suíte de testes existente.
- Produces: artefato Windows, compilação integrada, limpeza de transporte e
  registro de limitações.

- [x] **Step 1: Review lifecycle and privilege boundaries**

Confirmar no diff que a única nova coordenação é a geração do renderer, que
`Native.shutdown()` continua sendo chamado no `stop()`, que não aparecem novas
chamadas a `Native.enable`, `Native.shutdown`, `restartDiscord`, `app.relaunch`,
`app.quit`, WireGuard ou rotas, e que nenhuma preferência nova é persistida.

- [x] **Step 2: Run complete local checks**

Run: `for test_file in tests/test-plugin-*.mjs; do node --experimental-strip-types "$test_file" || exit 1; done`, `(cd tools/proton-confgen && go test ./...)`, `./tests/test-userplugin-e2e.sh` e `git diff --check`.

Expected: todas as regressões e o pacote E2E permanecem aprovados.

- [x] **Step 3: Validate the integrated Windows build**

Gerar um ZIP versionado contendo o helper Windows x64, copiar para `win11` com
um backup do plugin atual, executar `pnpm.cmd testTsc` e `pnpm.cmd build`, e
registrar a identificação do artefato. Não exigir login, injeção ou reinício do
Discord para esta mudança de lifecycle.

- [x] **Step 4: Clean transport and update checkpoint**

No guest, executar `mountvol H: /p` e confirmar que `dir H:` falha por unidade
ausente. No host, destacar e destruir somente o share desta rodada, confirmar
que `sdc`, `sdd` e `sde` permanecem, registrar backup, resultados e a limitação
de runtime visual. Marcar todos os passos deste plano como concluídos.
