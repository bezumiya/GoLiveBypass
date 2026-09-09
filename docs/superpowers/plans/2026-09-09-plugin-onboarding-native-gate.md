# Plugin Onboarding Native Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitir fechar o modal informativo do onboarding quando a bridge nativa não está disponível.

**Architecture:** O gate local de fechamento usará a mesma condição de suporte nativo que o startup já usa. A ausência de `Native` não marcará o onboarding como concluído e não chamará nenhuma operação privilegiada.

**Tech Stack:** TypeScript/TSX do userplugin Vencord, teste-fonte Node.js, helper Go Proton e build Windows/Vencord.

**Spec:** `docs/superpowers/specs/2026-09-09-plugin-onboarding-native-gate-design.md`

## Global Constraints

- Preservar a guarda de não ativar a VPN antes da conclusão das duas etapas quando `Native` existe.
- Não alterar credenciais, sessão Proton, rotas, WireSock ou updater.
- Não marcar `onboardingCompleted` quando a bridge nativa estiver ausente.
- Preservar o worktree e não fazer push, release ou deploy.

---

### Task 1: Corrigir o gate e proteger contra regressão

**Files:**
- Modify: `goLiveBypass/index.tsx:367`
- Modify: `tests/test-plugin-onboarding.mjs`

**Interfaces:**
- Consumes: `Native` e `settings.store.onboardingCompleted` dentro de `PluginOnboardingModal`.
- Produces: `requiredOnOpen: boolean`, verdadeiro somente quando a bridge existe e o onboarding ainda não terminou.

- [x] **Step 1: Define the failing regression**

Reforçar o teste-fonte para exigir `Boolean(Native && settings.store.onboardingCompleted !== true)` na definição de `requiredOnOpen`. Manter as asserções de que `closeModal` bloqueia somente o onboarding inicial suportado e de que `Native.enable()` fica depois do gate no `start()`.

- [x] **Step 2: Run test to verify the current behavior is exposed**

Run: `node --experimental-strip-types tests/test-plugin-onboarding.mjs`

Expected before the implementation: FAIL porque a expressão atual não inclui `Native`.

- [x] **Step 3: Implement the minimal gate**

Alterar somente a expressão para:

```tsx
const requiredOnOpen = Boolean(Native && settings.store.onboardingCompleted !== true);
```

Não adicionar escrita em settings, fallback de ativação ou exceções no backend.

- [x] **Step 4: Run the focused test**

Run: `node --experimental-strip-types tests/test-plugin-onboarding.mjs`

Expected: PASS com 5/5 testes.

### Task 2: Revisão integrada e verificação Windows

**Files:**
- Modify: `docs/superpowers/reports/2026-09-07-plugin-update-validation.md`
- Modify: `docs/superpowers/plans/2026-09-09-plugin-onboarding-native-gate.md`

**Interfaces:**
- Consumes: a expressão corrigida e a suíte existente.
- Produces: resultado local, artefato compilado e registro da limitação de runtime.

- [x] **Step 1: Review the safety boundary**

Confirmar por inspeção que a alteração não move `Native.enable`, `Native.shutdown`,
`restartDiscord`, `settings.store.onboardingCompleted = true` ou operações de VPN.

- [x] **Step 2: Run the complete local checks**

Run: `for test_file in tests/test-plugin-*.mjs; do node --experimental-strip-types "$test_file" || exit 1; done`, `(cd tools/proton-confgen && go test ./...)`, `./tests/test-userplugin-e2e.sh` e `git diff --check`.

Expected: toda a suíte passa, E2E mantém 51/51 e não há erro de whitespace.

- [x] **Step 3: Validate the integrated Windows build**

Empacotar o plugin atual, instalar em checkout versionado da VM `win11`, executar `pnpm.cmd testTsc` e `pnpm.cmd build`, preservando backup e sem depender de login Discord para este caso de compilação.

- [x] **Step 4: Clean transport and record the result**

Ejetar H: antes de destacar o share temporário, confirmar que a unidade desapareceu, preservar `sdc`, `sdd` e `sde`, atualizar o relatório e deixar o plano sem checkboxes pendentes.
