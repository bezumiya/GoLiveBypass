# Restauração do bypass no autostart do Windows Implementation Plan

> **For agentic workers:** Execute this plan task-by-task with a review checkpoint after each task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persistir a intenção de manter o bypass ativo e, no boot oculto do Windows, otimizar a rota antes de ativar WireSock e iniciar o Discord, usando a última rota/seleção rápida como fallback.

**Architecture:** O processo principal do Electron será o orquestrador do boot oculto. Um helper sem dependências de Electron controlará a decisão e a ordem `otimização → ativação`, enquanto `main.ts` fornece a otimização Proton, a persistência e as operações WireGuard já existentes. O renderer manual não será usado para iniciar a restauração automática.

**Tech Stack:** Electron 43, TypeScript, Vitest, WireSock/WireGuard, Proton confgen e `settings.json` compartilhado.

**Spec:** `docs/superpowers/specs/2026-09-07-bypass-startup-restore-design.md`

## Global Constraints

- O autostart automático só reconcilia o bypass quando o processo foi iniciado com `--hidden` pelo login do Windows.
- `bypassEnabled` é `true` apenas após ativação concluída e `false` apenas após desativação explícita ou restauração de internet concluída.
- `before-quit` desmonta a sessão, mas não apaga `bypassEnabled`.
- Falha da medição mantém o `wireguard.conf` anterior; `activateBypass` deve tentar essa rota e, se ausente, sua seleção Proton rápida existente.
- WireSock continua limitado aos executáveis permitidos do Discord; não editar `app.asar`, o plugin ou o standalone legado.
- Probes de rota continuam diagnósticos e não podem bloquear a ativação.
- Toda operação de lifecycle permanece serializada; não criar uma fila paralela.

---

### Task 1: Extrair e testar a ordem de restauração do boot

**Files:**
- Create: `golive-gui/electron/startup-restore.ts`
- Create: `golive-gui/tests/startup-restore.test.ts`

**Interfaces:**
- Produces `restoreBypassOnStartup(options): Promise<StartupRestoreResult>`.
- `StartupRestoreOptions` recebe `enabled`, `isActive`, `optimize`, `activate`, `signal` opcional e callbacks de log opcionais.
- `StartupRestoreResult.status` é `skipped`, `already-active`, `activated`, `cancelled` ou `failed`; o resultado também informa se a otimização teve sucesso e se houve fallback.

- [ ] **Step 1: Write the failing tests**

```ts
it('não ativa nem otimiza quando a preferência está desligada', async () => {
  const calls: string[] = [];
  const result = await restoreBypassOnStartup({
    enabled: false,
    isActive: async () => { calls.push('active'); return false; },
    optimize: async () => { calls.push('optimize'); return { success: true }; },
    activate: async () => { calls.push('activate'); },
  });
  expect(result.status).toBe('skipped');
  expect(calls).toEqual([]);
});

it('executa otimização antes da ativação', async () => {
  const calls: string[] = [];
  const result = await restoreBypassOnStartup({
    enabled: true,
    isActive: async () => false,
    optimize: async () => { calls.push('optimize'); return { success: true }; },
    activate: async () => { calls.push('activate'); },
  });
  expect(result).toMatchObject({ status: 'activated', optimized: true, usedFallback: false });
  expect(calls).toEqual(['optimize', 'activate']);
});

it('ativa usando fallback quando a otimização falha', async () => {
  const calls: string[] = [];
  const result = await restoreBypassOnStartup({
    enabled: true,
    isActive: async () => false,
    optimize: async () => { calls.push('optimize'); return { success: false, error: 'sem rede' }; },
    activate: async () => { calls.push('activate'); },
  });
  expect(result).toMatchObject({ status: 'activated', optimized: false, usedFallback: true });
  expect(calls).toEqual(['optimize', 'activate']);
});

it('não repete a operação quando o túnel já está ativo', async () => {
  const optimize = vi.fn();
  const activate = vi.fn();
  const result = await restoreBypassOnStartup({
    enabled: true,
    isActive: async () => true,
    optimize,
    activate,
  });
  expect(result.status).toBe('already-active');
  expect(optimize).not.toHaveBeenCalled();
  expect(activate).not.toHaveBeenCalled();
});

it('cancela entre a otimização e a ativação', async () => {
  const controller = new AbortController();
  const activate = vi.fn();
  const result = await restoreBypassOnStartup({
    enabled: true,
    signal: controller.signal,
    isActive: async () => false,
    optimize: async () => { controller.abort(); return { success: true }; },
    activate,
  });
  expect(result.status).toBe('cancelled');
  expect(activate).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npm test -- tests/startup-restore.test.ts` from `golive-gui/`.

Expected: FAIL because `electron/startup-restore.ts` and `restoreBypassOnStartup` do not exist.

- [ ] **Step 3: Implement the pure helper**

Implement `restoreBypassOnStartup` with esta sequência:

```ts
export async function restoreBypassOnStartup(options: StartupRestoreOptions): Promise<StartupRestoreResult> {
  if (!options.enabled) return { status: 'skipped', optimized: false, usedFallback: false };
  if (options.signal?.aborted) return { status: 'cancelled', optimized: false, usedFallback: false };
  if (await options.isActive()) return { status: 'already-active', optimized: false, usedFallback: false };

  let optimized = false;
  let optimizationError: string | undefined;
  try {
    const result = await options.optimize(options.signal);
    optimized = result.success === true;
    optimizationError = result.error;
  } catch (error) {
    optimizationError = error instanceof Error ? error.message : String(error);
  }
  if (options.signal?.aborted) return { status: 'cancelled', optimized, usedFallback: !optimized, error: optimizationError };
  options.onOptimizationFailure?.(optimizationError);

  try {
    await options.activate();
    return { status: 'activated', optimized, usedFallback: !optimized, error: optimizationError };
  } catch (error) {
    return {
      status: options.signal?.aborted ? 'cancelled' : 'failed',
      optimized,
      usedFallback: !optimized,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
```

The helper must never throw for optimization or activation failure; the main process will log the returned result and keep the persisted intent for a later attempt.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `npm test -- tests/startup-restore.test.ts`.

Expected: all five tests pass.

- [ ] **Step 5: Commit the isolated helper**

```bash
git add golive-gui/electron/startup-restore.ts golive-gui/tests/startup-restore.test.ts
git commit -m "test: define startup bypass restore order"
```

### Task 2: Persistir a intenção do bypass e preparar a otimização headless

**Files:**
- Modify: `golive-gui/electron/main.ts:imports, activation, settings helpers, Proton optimization helpers`
- Create: `golive-gui/tests/startup-state.test.ts`

**Interfaces:**
- `readBypassEnabled(): boolean` reads only `settings.json.bypassEnabled === true`.
- `persistBypassEnabled(enabled: boolean): boolean` merges the preference and logs a persistence failure without changing the network state.
- `optimizeProtonRouteAtStartup(signal?: AbortSignal): Promise<{ success: boolean; skipped?: boolean; server?: string; error?: string }>` performs a speed-tested Proton selection without a renderer.

- [ ] **Step 1: Write tests for preference persistence contracts**

Add source-level assertions in `startup-state.test.ts`:

```ts
it('persiste true somente após ativação concluída', () => {
  const src = fs.readFileSync(path.resolve(process.cwd(), 'electron/main.ts'), 'utf8');
  const activation = src.slice(src.indexOf('async function executarAtivacao'), src.indexOf('async function deactivateAll'));
  expect(activation).toContain('persistBypassEnabled(true)');
  expect(activation.indexOf('persistBypassEnabled(true)')).toBeGreaterThan(activation.indexOf('startProtonFailoverMonitor()'));
});

it('não apaga a preferência no encerramento limpo', () => {
  const src = fs.readFileSync(path.resolve(process.cwd(), 'electron/main.ts'), 'utf8');
  const beforeQuit = src.slice(src.indexOf('app.on("before-quit"'), src.indexOf('app.on("window-all-closed"'));
  expect(beforeQuit).not.toContain('persistBypassEnabled(false)');
});

it('desativação explícita só persiste false depois da operação', () => {
  const src = fs.readFileSync(path.resolve(process.cwd(), 'electron/main.ts'), 'utf8');
  const handler = src.slice(src.indexOf('ipcMain.handle("deactivate"'), src.indexOf('ipcMain.handle("restore-internet"'));
  expect(handler.indexOf('await deactivateAll()')).toBeLessThan(handler.indexOf('persistBypassEnabled(false)'));
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npm test -- tests/startup-state.test.ts`.

Expected: FAIL because the new persistence helper and calls are absent.

- [ ] **Step 3: Add persistence and headless Proton selection**

In `main.ts`, import `restoreBypassOnStartup` and add the preference helpers near `readSharedSettings`/`updateSharedSettings`:

```ts
function readBypassEnabled(): boolean {
  return readSharedSettings().bypassEnabled === true;
}

function persistBypassEnabled(enabled: boolean): boolean {
  const ok = updateSharedSettings({ bypassEnabled: enabled });
  if (!ok) logger.warn('bypass', 'preferencia de ativação não foi persistida', { enabled });
  return ok;
}
```

Add `optimizeProtonRouteAtStartup` after `ensureProtonActivationProfile`. It must recover the saved Proton username, resolve the plan with Free-safe behavior, call `proton.generateOptimalProtonConfig(settingsDir(), { username, countries, freeOnly, autoPing, speedTest: true, signal, onProgress })` inside `withWireSockLifecycle('otimizacao-boot', ...)`, and persist `protonCountry`, `protonFreeOnly`, `protonAutoPing`, `protonLastServer`, `measurementVersion`, `measuredAt`, `measurementCountry`, `measurementFreeOnly` and `measurementAutoPing` only after a successful generation. Return an error instead of throwing so activation can use the existing `wireguard.conf` or `ensureProtonActivationProfile` as fallback. Return `{ success: true, skipped: true }` for custom `.conf` mode.

At the end of `executarAtivacao` and `linuxActivate`, call `persistBypassEnabled(true)` after the tunnel/Discord success path. In duplicate-active paths, also persist `true` because the explicit activation request found a working session.

- [ ] **Step 4: Run tests and compile**

Run: `npm test -- tests/startup-state.test.ts tests/ativacao-guard.test.ts tests/proton-optimization.test.ts`.

Expected: PASS. Then run `npm run compile`; expected: TypeScript, Vite and bypass synchronization complete without errors.

- [ ] **Step 5: Commit the state and optimizer changes**

```bash
git add golive-gui/electron/main.ts golive-gui/tests/startup-state.test.ts
git commit -m "feat: persist bypass activation intent"
```

### Task 3: Integrar o boot oculto e os desligamentos explícitos

**Files:**
- Modify: `golive-gui/electron/main.ts:startup initialization, tray toggle, before-quit, IPC deactivate/restore`
- Create: `golive-gui/tests/startup-restore-integration.test.ts`

**Interfaces:**
- `restoreBypassFromWindowsStartup(): Promise<void>` is the only entry point for the automatic boot reconciliation.
- `cancelStartupBypassRestore(): void` aborts a pending optimization when the user explicitly deactivates, restores internet, or quits.
- `startupRestoreInFlight` prevents the renderer’s manual optimizer from competing with the hidden boot operation.

- [ ] **Step 1: Write integration/source tests**

Add assertions for the boot gate and operation order:

```ts
it('só agenda restauração automática no Windows e com --hidden', () => {
  const src = fs.readFileSync(path.resolve(process.cwd(), 'electron/main.ts'), 'utf8');
  expect(src).toMatch(/IS_WINDOWS[\s\S]{0,180}launchedHidden\(\)[\s\S]{0,180}readBypassEnabled\(\)/);
  expect(src).toContain('void restoreBypassFromWindowsStartup()');
});

it('não deixa o otimizador do renderer concorrer com o boot oculto', () => {
  const src = fs.readFileSync(path.resolve(process.cwd(), 'electron/main.ts'), 'utf8');
  const handler = src.slice(src.indexOf('ipcMain.handle("optimize-proton-route"'), src.indexOf('ipcMain.handle("report-bug"'));
  expect(handler).toContain('startupRestoreInFlight');
  expect(handler).toContain('deferred: true');
});

it('preserva a preferência em falha e só a desliga após ação explícita concluída', () => {
  const src = fs.readFileSync(path.resolve(process.cwd(), 'electron/main.ts'), 'utf8');
  expect(src).toContain('mantém bypassEnabled=true');
  expect(src).toContain('persistBypassEnabled(false)');
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npm test -- tests/startup-restore-integration.test.ts`.

Expected: FAIL because the startup entry point, cancellation and handler guard are absent.

- [ ] **Step 3: Add the hidden Windows boot entry point**

Create the state variables near the other lifecycle state:

```ts
let startupRestoreInFlight = false;
let startupRestoreController: AbortController | null = null;
let startupRestorePromise: Promise<void> | null = null;
```

Implement `restoreBypassFromWindowsStartup` so it exits unless `IS_WINDOWS`, `launchedHidden()` and `readBypassEnabled()` are all true; creates an `AbortController`; calls `restoreBypassOnStartup` with an active check (`getStatus() === 'ACTIVE'` or active WireSock), `optimizeProtonRouteAtStartup`, and `activateBypass({})`; logs optimized/fallback/failed outcomes; refreshes tray/window; and clears the in-flight state in `finally`. Call it after `syncStartupEntry()` in `app.whenReady`, without awaiting the long measurement so the tray can appear.

Implement `cancelStartupBypassRestore` to abort the controller and use it from explicit deactivation, `restore-internet`, and `before-quit`. Do not persist false from cancellation or `before-quit`.

- [ ] **Step 4: Connect explicit state transitions and prevent optimizer races**

In the explicit `deactivate` IPC handler and tray deactivation branch, persist `false` only after `linuxDeactivate`/`deactivateAll` resolves. In `restore-internet`, persist `false` after `recoverWireSockNetwork()` reports `ok: true`, including the case where Discord fails to restart after the network has already been restored. Keep the preference true for an incomplete recovery.

At the beginning of `optimize-proton-route`, return `{ success: true, deferred: true }` while `startupRestoreInFlight` is true. This lets a window opened during boot wait for the authoritative main-process operation instead of starting a second selection.

- [ ] **Step 5: Run focused integration tests**

Run: `npm test -- tests/startup-restore.test.ts tests/startup-state.test.ts tests/startup-restore-integration.test.ts tests/ativacao-guard.test.ts`.

Expected: PASS with no regression in activation serialization or WireSock rollback tests.

- [ ] **Step 6: Commit the boot integration**

```bash
git add golive-gui/electron/main.ts golive-gui/tests/startup-restore-integration.test.ts
git commit -m "feat: restore bypass after Windows login"
```

### Task 4: Validação transversal e smoke tests de plataforma

**Files:**
- Modify: `CHANGELOG.md` with a concise unreleased entry describing persisted bypass intent, optimization-before-activation and saved-route fallback.
- No generated `golive-gui/electron/bypass.ts` edit is expected; run the repository sync/check command to confirm it remains generated and consistent.

- [ ] **Step 1: Run all GUI tests**

Run from `golive-gui/`: `npm test`.

Expected: all existing and new tests pass.

- [ ] **Step 2: Compile the GUI**

Run from `golive-gui/`: `npm run compile`.

Expected: `sync-bypass`, Proton helper build, TypeScript and Vite all finish successfully.

- [ ] **Step 3: Verify generated source and diff hygiene**

Run from `golive-gui/`: `npm run check-bypass`.

Run from the repository root: `git diff --check` and `git status --short`.

Expected: bypass check and whitespace validation pass; unrelated pre-existing worktree changes remain untouched.

- [ ] **Step 4: Linux smoke test**

Use the existing development launch path and inspect the stable log/settings directory. Confirm a disabled `bypassEnabled` does not start the Linux tunnel automatically, and that manual activation still starts WireGuard through the existing standalone helper. Do not introduce an elevation prompt at Linux login.

- [ ] **Step 5: Windows VM smoke test**

Run `npm run build:win` from `golive-gui/` (the script already uses `--publish never`), transfer the fresh portable executable to the Windows VM, enable “Iniciar com o Windows”, activate once, quit/reboot, and inspect Task Manager/logs. Confirm the hidden process starts, the optimization log precedes WireSock activation, the tunnel settle precedes Discord spawn, and the disabled-state cycle does not activate after the next reboot. Do not use Discord credentials or make a production release.

- [ ] **Step 6: Commit documentation and validation notes**

```bash
git add CHANGELOG.md
git commit -m "docs: registra restauração do bypass no autostart"
```
