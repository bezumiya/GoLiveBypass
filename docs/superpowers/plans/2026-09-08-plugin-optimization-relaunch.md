# Plugin optimization relaunch prevention Implementation Plan

> **For agentic workers:** Execute this plan task-by-task with a focused review after each task.

**Goal:** Preserve an already active plugin VPN after Proton route optimization without silently relaunching Discord.

**Architecture:** Keep the controller's existing serialized optimization and ownership flow. When optimization temporarily stops a route that was active before the operation, restore it through the non-relaunch activation path; explicit Discord restart remains exclusive to the update overlay action. The renderer contract and the external WireSock ownership guard remain unchanged.

**Tech Stack:** TypeScript source-based Node tests, Electron controller, Vencord userplugin, Go helper regression suite.

**Spec:** User objective in `/home/pdl/.codex/attachments/fad7752e-5974-4a96-9358-8d0f4235d5c1/pasted-text-1.txt`, especially the route-cancellation and explicit-restart requirements; current evidence in `docs/superpowers/reports/2026-09-07-plugin-update-validation.md`.

## Global Constraints

- Preserve WireSock ownership isolation; never stop or assume an external tunnel.
- Do not turn diagnostic probes into activation gates.
- Do not restart Discord during optimization, cancellation, or ordinary plugin lifecycle operations.
- Keep the explicit update action as the only updater-triggered Discord restart path.
- Preserve the existing dirty worktree and do not modify GUI, standalone, API, or release files.

---

### Task 1: Lock the optimization restart contract with a regression test

**Files:**
- Modify: `tests/test-plugin-controller-recovery.mjs`
- Consult: `goLiveBypass/vpn-controller.ts`

**Interfaces:**
- Consumes: the controller source block containing `restorePreviousRoute`.
- Produces: a source regression that fails if active-route restoration requests a relaunch.

- [x] **Step 1: Add the failing assertion**

  Extract the `optimizeProton` block and assert that `restorePreviousRoute` calls `startInternal(false)`, while the block does not call `startInternal(true)` for restoration.

- [x] **Step 2: Run the focused test**

  Run: `node --experimental-strip-types tests/test-plugin-controller-recovery.mjs`

  Expected: FAIL against the current source because `restorePreviousRoute` currently calls `startInternal(true)`.

---

### Task 2: Restore an active route without relaunching Discord

**Files:**
- Modify: `goLiveBypass/vpn-controller.ts:279-283`

**Interfaces:**
- Consumes: the existing `restorePreviousRoute` closure and serialized `startInternal(relaunch)` contract.
- Produces: a restored owned route with `relaunch=false`; failures still return the existing recovery error and ownership behavior.

- [x] **Step 1: Apply the minimal implementation**

  Change only the restoration call from `this.startInternal(true)` to `this.startInternal(false)`. Leave the initial `enable()` path and explicit `restartDiscord()` path unchanged.

- [x] **Step 2: Run the focused regression**

  Run: `node --experimental-strip-types tests/test-plugin-controller-recovery.mjs`

  Expected: PASS, including the existing boot recovery and external WireSock assertions.

---

### Task 3: Verify the plugin-only change and package contract

**Files:**
- Consult: all files matched by `tests/test-plugin-*.mjs` and `tools/proton-confgen/`

**Interfaces:**
- Consumes: the corrected controller and existing tests.
- Produces: evidence that the plugin regression suite, helper suite, packaging checks, and diff hygiene remain green.

- [x] **Step 1: Run all plugin source/runtime tests**

  Run:

  ```bash
  for test_file in tests/test-plugin-*.mjs; do
    node --experimental-strip-types "$test_file"
  done
  ```

  Expected: every plugin test exits successfully.

- [x] **Step 2: Run the Proton helper tests**

  Run: `cd tools/proton-confgen && go test ./...`

  Expected: all Go packages pass.

- [x] **Step 3: Validate the distribution assembly**

  Run: `./tests/test-userplugin-e2e.sh`

  Expected: the ZIP contains the corrected controller, manifest, helper Windows x64 asset, checksum, extraction tree, and rollback fixtures with zero failures.

- [x] **Step 4: Check whitespace and scope**

  Run: `git diff --check` and `git status --short`

  Expected: no whitespace errors; only the planned plugin test/controller files are newly changed by this cycle, while pre-existing worktree changes remain untouched.

---
