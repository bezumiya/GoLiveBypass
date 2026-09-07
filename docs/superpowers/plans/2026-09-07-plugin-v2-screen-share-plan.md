# Plugin GoLiveBypass v2 — implementação e aceite de transmissão — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrar o userplugin para `2.0.0-beta.1`, instrumentar o erro real de transmissão e corrigir/validar o compartilhamento de tela na VM Windows com o transporte WireGuard por aplicativo.

**Architecture:** `native.ts` e `PluginVpnController` continuam sendo a autoridade do WireSock e do ciclo de vida; `index.tsx` só coleta sinais do Discord, força opcionalmente a região de stream e exibe diagnóstico. A primeira alteração funcional será observabilidade determinística; cada correção posterior será escolhida pela evidência coletada na VM, mantendo uma única variável por ciclo.

**Tech Stack:** TypeScript, React/Vencord userplugin, Electron IPC, WireGuard/WireSock, Vitest, pnpm/Equicord, libvirt Windows VM.

**Spec:** `docs/superpowers/specs/2026-09-07-plugin-v2-screen-share-design.md`

## Global Constraints

- A versão do plugin nesta rodada é exatamente `2.0.0-beta.1`; a GUI Electron continua em `2.0.6-beta.2`.
- A VPN do plugin funciona somente em Windows x64 nesta linha.
- O plugin controla somente o WireSock que iniciou e não assume nem encerra um WireSock externo, da GUI ou de outro plugin.
- `AllowedApps` permanece limitado ao executável do Discord, ao `Update.exe` correspondente e ao helper de diagnóstico estritamente necessário.
- O plugin não altera `app.asar`, não usa proxy/PAC/Tor e não compartilha estado com a GUI nem com o standalone.
- Probes de rota são diagnósticos; não bloqueiam a call, não encerram o Discord e não alteram a rota durante uma transmissão.
- Nenhuma mensagem ou anexo será enviado ao canal real; a call já aberta na VM é a superfície de validação.
- Screenshots e logs temporários ficam em `/tmp` e não entram no repositório.

## Mapa de arquivos

- `goLiveBypass/manifest.json`: identidade e versão do userplugin/updater.
- `goLiveBypass/index.tsx`: versão exibida, patch de região e observabilidade das stores de voz/stream.
- `goLiveBypass/native.ts`: versão do updater e registro em arquivo do processo principal.
- `goLiveBypass/stability.ts`: decisões puras de estado do stream.
- `golive-gui/tests/plugin-v2-version.test.ts`: contrato da versão major e da política beta.
- `golive-gui/tests/stream-diagnostics.test.ts`: testes dos snapshots e transições.
- `golive-gui/tests/plugin-vpn-source-guards.test.ts`: fronteira entre plugin e transporte legado.
- `golive-gui/tests/plugin-v2-regression.test.ts`: regressão escolhida pela evidência da VM.
- `docs/testing/2026-09-07-plugin-v2-vm.md`: evidência sanitizada da aceitação real.

---

### Task 1: Promover o plugin para a linha v2 beta

**Files:**
- Modify: `goLiveBypass/manifest.json`
- Modify: `goLiveBypass/index.tsx:PLUGIN_VERSION`
- Modify: `goLiveBypass/native.ts:PLUGIN_VERSION`
- Create: `golive-gui/tests/plugin-v2-version.test.ts`

**Interfaces:**
- Produces one version identity: `2.0.0-beta.1` in manifest, renderer and native updater.
- Keeps `releaseInfo()` stable-only: prereleases are never treated as `latest` stable releases.

- [ ] **Step 1: Write the failing version contract test**

~~~ts
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(process.cwd(), "../goLiveBypass");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

describe("linha major v2 do plugin", () => {
  it("declara a mesma versão beta no manifest, UI e updater", () => {
    const expected = "2.0.0-beta.1";
    expect(JSON.parse(read("manifest.json")).version).toBe(expected);
    expect(read("index.tsx")).toContain(`const PLUGIN_VERSION = "${expected}"`);
    expect(read("native.ts")).toContain(`const PLUGIN_VERSION = "${expected}"`);
  });

  it("mantém a política que ignora prereleases no endpoint estável", () => {
    const native = read("native.ts");
    expect(native).toContain("release.prerelease === true");
    expect(native).toContain("nenhum release estável disponível");
    expect(native).toContain("compareUpdateVersion(PLUGIN_VERSION, release.version)");
  });
});
~~~

- [ ] **Step 2: Run the focused test and verify the current v1 failure**

Run from `golive-gui/`: `npm test -- tests/plugin-v2-version.test.ts`. It must fail because the three identifiers still contain `1.1.12-beta.13`.

- [ ] **Step 3: Change only the three plugin version identifiers**

Set manifest and both source constants to `2.0.0-beta.1`. Do not change `golive-gui/package.json` or GUI release metadata.

- [ ] **Step 4: Run version and boundary tests**

Run `npm test -- tests/plugin-v2-version.test.ts tests/plugin-vpn-source-guards.test.ts tests/plugin-vpn-types.test.ts`. All tests must pass.

- [ ] **Step 5: Commit the isolated version migration**

~~~bash
git add goLiveBypass/manifest.json goLiveBypass/index.tsx goLiveBypass/native.ts golive-gui/tests/plugin-v2-version.test.ts
git commit -m "chore(plugin): iniciar linha v2 beta"
~~~

### Task 2: Tornar o diagnóstico de stream observável e determinístico

**Files:**
- Modify: `goLiveBypass/stability.ts`
- Modify: `goLiveBypass/index.tsx` no watcher e em `buildReport()`
- Create: `golive-gui/tests/stream-diagnostics.test.ts`

**Interfaces:**
- Produces `StreamObservation`, `StreamObservationStatus` and `evaluateStreamObservation()` from `stability.ts`.
- Logs contain only counts, booleans, state, hostname and selected region; never tokens, full URLs or message content.
- Existing `evaluateStreamClaim()` keeps the 30-second warning and performs no automatic network action.

- [ ] **Step 1: Write the failing pure-state tests**

~~~ts
import { describe, expect, it } from "vitest";
import { evaluateStreamObservation, type StreamObservation } from "../../goLiveBypass/stability";

const sample = (patch: Partial<StreamObservation> = {}): StreamObservation => ({
  now: 1_000, senderClaimed: true, visibleStreamCount: 1, nativeStreamCount: 0,
  voiceState: "connected", voiceHostname: "us-east123.discord.media",
  selectedRegion: "us-east", ...patch,
});

describe("observação da transmissão", () => {
  it("classifica UI afirmando stream sem conexão nativa", () =>
    expect(evaluateStreamObservation(sample()).status).toBe("claimed-without-native"));
  it("classifica conexão nativa como saudável", () =>
    expect(evaluateStreamObservation(sample({ nativeStreamCount: 1 })).status).toBe("native-connected"));
  it("não transforma store desconhecida em falha", () =>
    expect(evaluateStreamObservation(sample({ senderClaimed: null, nativeStreamCount: null })).status).toBe("unknown"));
  it("produz chave sem segredo", () => {
    const result = evaluateStreamObservation(sample());
    expect(result.key).not.toContain("token");
    expect(result.key).toContain("us-east123.discord.media");
  });
});
~~~

Use estas assinaturas:

~~~ts
export interface StreamObservation {
  now: number;
  senderClaimed: boolean | null;
  visibleStreamCount: number | null;
  nativeStreamCount: number | null;
  voiceState: string | null;
  voiceHostname: string | null;
  selectedRegion: string | null;
}
export type StreamObservationStatus = "unknown" | "claimed-without-native" | "native-connected" | "idle";
export function evaluateStreamObservation(sample: StreamObservation): { status: StreamObservationStatus; key: string };
~~~

- [ ] **Step 2: Run the focused test and verify it fails**

Run `npm test -- tests/stream-diagnostics.test.ts`. It must fail because the function and types do not exist.

- [ ] **Step 3: Implement the pure classifier**

Build `key` from the six diagnostic fields other than `now`, joined by `|`; use `null` for unknown values. Return `idle` when `senderClaimed === false`, `unknown` when sender or native count is unknown, `native-connected` when native count is positive, and `claimed-without-native` otherwise. Do not touch network state.

- [ ] **Step 4: Connect it to the existing watcher**

In `index.tsx`, add `lastStreamObservationKey: string | null`; read `getCurrentUserActiveStream`, `getAllActiveStreams`, `getAllActiveStreamKeys`, `RTCConnectionStore.getState()` and `RTCConnectionStore.getHostname()` through `readStore()`; use `collectionCount()`; log `stream.observation` only when the key changes; reset it in both watcher lifecycle functions. Keep the 30-second warning and put only status/counts in `buildReport()`.

- [ ] **Step 5: Run tests and commit**

Run `npm test -- tests/stream-diagnostics.test.ts tests/plugin-vpn-source-guards.test.ts tests/plugin-vpn-types.test.ts` and `git diff --check`. Then commit with `feat(plugin): registrar estado nativo da transmissao`.

### Task 3: Build identificável e baseline real na VM

**Files:**
- Modify: `goLiveBypass/COMO-INSTALAR.md` with the v2 beta test note.
- Create: `docs/testing/2026-09-07-plugin-v2-vm.md`.
- Test: complete GUI suite and plugin build in the Windows guest.

**Interfaces:**
- Consumes the v2 version and diagnostic records from Tasks 1–2.
- Produces a fresh guest build and a sanitized report with artifact hash, screenshots, log window and outcomes.

- [ ] **Step 1: Run host regression checks**

From `golive-gui/`, run `npm test` and `npm run check-bypass`. Expect all tests to pass and generated `electron/bypass.ts` to remain unchanged.

- [ ] **Step 2: Transfer the exact source through a temporary FAT share**

From the root run:

~~~bash
rm -f /tmp/golive-plugin-v2-source.zip /tmp/golive-plugin-v2-source.sha256
zip -qr /tmp/golive-plugin-v2-source.zip goLiveBypass
sha256sum /tmp/golive-plugin-v2-source.zip > /tmp/golive-plugin-v2-source.sha256
~~~

Use `/home/pdl/.codex/skills/windows-vm-control/scripts/vmctl.sh` with `share-create`, `share-put` and `share-attach`; do not detach until Windows ejects the disk. Replace only `src/userplugins/goLiveBypass` in the existing guest checkout.

- [ ] **Step 3: Build and inject inside Windows**

Run visibly in the guest checkout: `pnpm build` and `pnpm inject`. Restart the Discord mod and confirm settings show `v2.0.0-beta.1`; a stale label invalidates that cycle.

- [ ] **Step 4: Capture baseline without changing the call**

Capture `/tmp/win11-plugin-v2-baseline.png` and copy `%LOCALAPPDATA%\\GoLiveBypass\\plugin-vpn\\plugin-vpn.log` back through a fresh share after eject. Retain timestamps, levels, event names, counts, states, hostnames and route results; remove usernames, tokens, passwords, full URLs and channel IDs.

- [ ] **Step 5: Reproduce three automatic-region attempts**

For each attempt record start time, selected region, voice state, screenshots before/after and whether the tile reports `Erro: 2012`. Wait for visible transitions and do not send a channel message.

- [ ] **Step 6: Commit only the sanitized baseline report**

Write the report without raw screenshots/logs, run `git diff --check`, then commit `docs: registra baseline do plugin v2 na VM` with only the documentation files staged.

### Task 4: Corrigir a causa comprovada do erro 2012

**Files:**
- Modify exactly one responsible plugin file: `goLiveBypass/index.tsx`, `goLiveBypass/stability.ts`, `goLiveBypass/vpn-controller.ts` or `goLiveBypass/vpn-windows.ts`.
- Create or modify: `golive-gui/tests/plugin-v2-regression.test.ts`.
- Modify: `docs/testing/2026-09-07-plugin-v2-vm.md`.

**Interfaces:**
- Consumes the sanitized `stream.observation` sequence and route/process evidence from Task 3.
- Produces one bounded correction with a deterministic regression test before another VM run.

- [ ] **Step 1: Select exactly one evidence branch**

- `senderClaimed=true`, `nativeStreamCount=0`, `voiceState=connected`: correct only the stream signaling/region path in `index.tsx` and test the exact `pickStreamRegion()` or patch contract shown by the log.
- `nativeStreamCount>0` but the tile fails: compare `voiceHostname`, `selectedRegion`, `AllowedApps` and ownership; correct the smallest mismatch in `vpn-windows.ts` or `vpn-controller.ts` and test the profile contract.
- WireSock inactive, external or outside the plugin profile: stop the media experiment, correct lifecycle/ownership/filtering first, and test that external WireSock is preserved.

The report must identify the event and field proving the branch. Do not combine a region change with a transport/lifecycle change in one iteration.

- [ ] **Step 2: Write the regression test first**

Put the failing assertion in `golive-gui/tests/plugin-v2-regression.test.ts`, using the actual field/value from the report. A region defect asserts the exact `pickStreamRegion()` result; a transport defect asserts exact `AllowedApps` or ownership behavior.

- [ ] **Step 3: Implement the minimal correction**

Change one responsible component, preserve no-auto-switch and no-global-route invariants, keep diagnostics non-blocking, and do not add proxy, Tor, `app.asar` or GUI-state dependencies.

- [ ] **Step 4: Validate and rebuild**

Run `npm test -- tests/stream-diagnostics.test.ts tests/plugin-v2-regression.test.ts tests/plugin-vpn-source-guards.test.ts tests/plugin-vpn-types.test.ts`, then `npm test`. Rebuild inside the VM with `pnpm build` and `pnpm inject`; verify `v2.0.0-beta.1` before another call.

- [ ] **Step 5: Repeat the same three-attempt sequence**

Record whether the symptom disappeared, voice stayed connected and no service residue appeared. If it remains, retain both reports and repeat Task 4 with one changed variable.

- [ ] **Step 6: Commit the bounded correction**

Stage only the responsible source file, `golive-gui/tests/plugin-v2-regression.test.ts` and the evidence report; commit with `fix(plugin): corrigir causa comprovada da transmissao`.

### Task 5: Aceitação final e restauração da rede

**Files:**
- Modify: `docs/testing/2026-09-07-plugin-v2-vm.md`.
- Test: complete GUI suite, plugin build/injection and Windows VM lifecycle.

- [ ] **Step 1: Prove three consecutive successful screen shares**

On a fresh Discord restart with the plugin active, complete three calls to share the screen. Each must show a working stream tile, no `Erro: 2012`, and voice connected; capture a screenshot after each transition.

- [ ] **Step 2: Prove reload and explicit region paths**

Repeat after a full Discord reload and once with an explicit stream region. Confirm the region in the sanitized log and no automatic route swap during the call.

- [ ] **Step 3: Prove deactivation and ownership cleanup**

Disable the plugin, wait for visible network restoration, and verify plugin-owned WireSock service, owner lock and route probe are gone. Confirm external WireSock is neither stopped nor adopted.

- [ ] **Step 4: Run final automated validation**

~~~bash
npm test
npm run check-bypass
git diff --check
git status --short
~~~

Expected: all tests pass, generated bypass remains consistent, no whitespace errors, and only pre-existing unrelated worktree entries remain outside committed plugin work.

- [ ] **Step 5: Commit final evidence**

~~~bash
git add docs/testing/2026-09-07-plugin-v2-vm.md
git commit -m "docs: registra aceite funcional do plugin v2"
~~~

