# Atualizações stable/beta no plugin — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Portar para o plugin Vencord/Equicord o updater stable/beta da GUI, com opt-in beta, atualização automática segura e reload manual.

**Architecture:** Um módulo puro selecionará releases por SemVer e canal. O serviço nativo consultará o GitHub, validará SHA-256, fará backup/rollback e recompilará o userplugin; um marcador privado impedirá downloads repetidos antes do reload. As preferências ficam no plugin e a UI apenas configura o serviço nativo e exibe seu estado.

**Tech Stack:** TypeScript, Vencord PluginNative, Node.js HTTPS/fs/crypto/child_process, GitHub Releases, Vitest, GitHub Actions e Windows x64 VM.

**Spec:** docs/superpowers/specs/2026-09-07-plugin-update-channels-design.md

## Global Constraints

- O plugin continua autônomo e não compartilha preferências com a GUI.
- A plataforma suportada continua Windows x64.
- A origem das releases permanece pdl-clay/GoLiveBypass.
- O asset é goLiveBypass-vencord.zip e o checksum é goLiveBypass-vencord.zip.sha256.
- Stable nunca recebe prerelease; beta é opt-in e aceita stable + prerelease.
- Não fazer downgrade, instalar manifest sem validação ou deixar troca parcial.
- Falha de update não desativa plugin, VPN ou chamada.
- Update automático baixa, valida e recompila, mas nunca reinicia o Discord silenciosamente.
- Beta permanece prerelease no GitHub e nunca vira latest.
- Preservar alterações existentes fora dos arquivos listados.

---

### Task 1: Módulo puro de canal e SemVer

**Files:**
- Create: goLiveBypass/update-channel.ts
- Test: golive-gui/tests/plugin-update-channel.test.ts
- Modify: golive-gui/tests/plugin-v2-version.test.ts

**Interfaces:**
- PluginUpdateChannel: "stable" | "beta".
- PluginReleaseCandidate: tag, version, zipUrl, shaUrl, prerelease.
- normalizePluginVersion(value: string): string | null.
- comparePluginVersions(a: string, b: string): number.
- choosePluginRelease(releases, current, channel): PluginReleaseCandidate | null.

- [ ] **Step 1: Write the failing tests**

Criar testes com estes casos:

~~~ts
it("ordena stable acima de beta do mesmo triplo", () => {
  expect(comparePluginVersions("2.0.0-beta.9", "2.0.0")).toBeLessThan(0);
});

it("trata beta.1 e beta-1 como a mesma prerelease", () => {
  expect(comparePluginVersions("v2.0.0-beta.1", "2.0.0-beta-1")).toBe(0);
  expect(comparePluginVersions("2.0.0-beta-10", "2.0.0-beta-9")).toBeGreaterThan(0);
});

it("filtra stable e escolhe a maior candidata no beta", () => {
  const releases = [
    { tag: "v2.0.1-beta-2", version: "2.0.1-beta-2", zipUrl: "zip-beta", shaUrl: "sha-beta", prerelease: true },
    { tag: "v2.0.0", version: "2.0.0", zipUrl: "zip-stable", shaUrl: "sha-stable", prerelease: false },
    { tag: "v2.0.1", version: "2.0.1", zipUrl: "zip-new", shaUrl: "sha-new", prerelease: false },
  ];
  expect(choosePluginRelease(releases, "2.0.0-beta.1", "stable")?.version).toBe("2.0.1");
  expect(choosePluginRelease(releases, "2.0.0-beta.1", "beta")?.version).toBe("2.0.1");
});

it("não oferece downgrade nem candidata sem asset ou checksum", () => {
  const releases = [
    { tag: "v2.0.0", version: "2.0.0", zipUrl: "", shaUrl: "sha", prerelease: false },
    { tag: "v1.9.9", version: "1.9.9", zipUrl: "zip", shaUrl: "sha", prerelease: false },
  ];
  expect(choosePluginRelease(releases, "2.0.0", "beta")).toBeNull();
});
~~~

Estender plugin-v2-version.test.ts para validar beta.1 e beta-1.

- [ ] **Step 2: Confirm the failure**

Run from golive-gui:

~~~bash
npm test -- --run tests/plugin-update-channel.test.ts tests/plugin-v2-version.test.ts
~~~

Expected: FAIL because the new module is absent.

- [ ] **Step 3: Implement the module**

Parse vMAJOR.MINOR.PATCH with prerelease, normalize beta.N and beta-N to the same identifiers, compare numeric identifiers numerically and stable above prerelease. Ignore candidates without zipUrl or shaUrl, filter prereleases on stable, choose the highest valid candidate and return null when it is not newer.

- [ ] **Step 4: Confirm the pass and commit**

Run `npm test -- --runInBand tests/plugin-update-channel.test.ts tests/plugin-v2-version.test.ts` and then:

~~~bash
git add goLiveBypass/update-channel.ts golive-gui/tests/plugin-update-channel.test.ts golive-gui/tests/plugin-v2-version.test.ts
git commit -m "feat(plugin): adicionar seleção de canal stable e beta"
~~~

---

### Task 2: Updater nativo, releases e marcador pendente

**Files:**
- Modify: goLiveBypass/native.ts
- Test: golive-gui/tests/plugin-update-native.test.ts

**Interfaces:**
- configurePluginUpdates(input: unknown): { enabled: boolean; channel: PluginUpdateChannel }.
- getPluginUpdateStatus(): current, channel, enabled, pending, pendingVersion, lastCheckedAt, lastError.
- checkPluginUpdate(input?: unknown): ok, current, channel, latest, available, pending.
- updatePlugin(input?: unknown): updated, current, latest, channel, pending.

- [ ] **Step 1: Write failing native tests**

Criar teste de fonte/harness verificando que native.ts usa a coleção de releases, não usa o endpoint latest, chama choosePluginRelease, valida createHash, manifest e goLiveBypass-vencord.zip.sha256, usa plugin-update-pending.json e não chama app.quit ou app.relaunch no bloco de update. O harness deve cobrir marcador válido, marcador já alcançado pela versão corrente e descarte de beta quando o canal muda para stable.

- [ ] **Step 2: Confirm the failure**

~~~bash
npm test -- --run tests/plugin-update-native.test.ts
~~~

Expected: FAIL because the native updater ainda consulta apenas stable/latest e não possui política ou marcador.

- [ ] **Step 3: Implement release discovery**

Trocar a URL por /repos/pdl-clay/GoLiveBypass/releases?per_page=20. Ignorar drafts, localizar exatamente os assets zip e zip.sha256 e mapear para PluginReleaseCandidate. Seguir apenas redirects HTTPS, limitar redirects/tamanho/timeout e passar o resultado a choosePluginRelease.

- [ ] **Step 4: Implement pending state and rollback**

Adicionar estado single-flight, timer de uma hora, atraso inicial de oito segundos e marcador em VPN_DATA_DIR. O marcador deve conter versão, canal, prerelease, digest e identificador seguro do backup, nunca caminho arbitrário vindo do renderer.

Após update, mover a fonte atual para .golivebypass-update-backups, instalar a nova fonte, recompilar e gravar o marcador. Em falha, restaurar e recompilar a fonte anterior. Ao trocar de beta para stable antes do reload, restaurar o backup beta pendente, recompilar a fonte anterior e limpar o marcador.

- [ ] **Step 5: Implement automatic and manual flows**

configurePluginUpdates deve normalizar enabled/channel, parar timers quando desligado, evitar duplicação e iniciar uma checagem imediata quando a política mudar. A checagem automática reutiliza o fluxo validado manual, não repete versão pendente e registra erros sem tocar na VPN ou no processo do Discord.

As funções antigas sem argumento devem continuar funcionando e usar stable como default. Um update preparado não pode ser descrito como versão já executando; deve retornar pending/reload required.

- [ ] **Step 6: Test and commit**

~~~bash
npm test -- --run tests/plugin-update-native.test.ts tests/plugin-update-channel.test.ts tests/plugin-v2-version.test.ts
npm run check-bypass
git diff --check
git add goLiveBypass/native.ts golive-gui/tests/plugin-update-native.test.ts
git commit -m "feat(plugin): portar updater stable e beta para o processo nativo"
~~~

---

### Task 3: Preferências e painel do plugin

**Files:**
- Modify: goLiveBypass/index.tsx
- Test: golive-gui/tests/plugin-update-ui.test.ts

**Interfaces:**
- settings.updateChannel: SELECT, default stable, values stable/beta.
- settings.autoUpdate: BOOLEAN, default true.
- UI consumes configurePluginUpdates and getPluginUpdateStatus.

- [ ] **Step 1: Write failing UI tests**

O teste deve exigir updateChannel, values stable/beta, autoUpdate, default true, configurePluginUpdates, getPluginUpdateStatus e texto indicando reload manual.

- [ ] **Step 2: Confirm the failure**

~~~bash
npm test -- --run tests/plugin-update-ui.test.ts
~~~

Expected: FAIL porque as preferências ainda não existem.

- [ ] **Step 3: Add settings and native wiring**

Adicionar as opções Estável — receber somente versões estáveis e Beta — participar dos testes. O autoUpdate ligado significa baixar/preparar em background; desligado interrompe consultas automáticas, mas não remove ações manuais.

No start(), configurar o updater nativo com settings.store.updateChannel e settings.store.autoUpdate. Em PluginUpdateSettings, usar settings.use para reconfigurar quando qualquer preferência mudar e consultar getPluginUpdateStatus em intervalo limitado. No stop(), limpar timers do renderer; não chamar shutdown como parte do update.

- [ ] **Step 4: Update panel behavior**

Mostrar versão corrente, canal, estado automático, último erro e reload pendente. Manter Verificar agora e Atualizar. Exibir uma única notificação por versão pendente. Se updatePlugin retornar pending, mostrar “pronto; recarregue o Discord”, nunca “atualizada” como se o processo já tivesse mudado.

- [ ] **Step 5: Test and commit**

~~~bash
npm test -- --run tests/plugin-update-ui.test.ts tests/plugin-update-native.test.ts tests/plugin-update-channel.test.ts tests/plugin-v2-version.test.ts
git add goLiveBypass/index.tsx golive-gui/tests/plugin-update-ui.test.ts
git commit -m "feat(plugin): adicionar seletor beta e auto update"
~~~

---

### Task 4: Asset beta no workflow de release

**Files:**
- Modify: .github/workflows/build-gui.yml
- Test: golive-gui/tests/plugin-update-workflow.test.ts

**Interfaces:**
- Stable and beta releases both contain goLiveBypass-vencord.zip and its checksum.
- Beta remains prerelease and is never briefly published as latest.

- [ ] **Step 1: Write failing workflow tests**

Testar que release-assets não possui condição de pular beta, que mantém vencord_basename, que beta usa draft antes da marcação, e que beta-marcar depende de windows, linux e release-assets.

- [ ] **Step 2: Confirm the failure**

~~~bash
npm test -- --run tests/plugin-update-workflow.test.ts
~~~

Expected: FAIL porque release-assets atualmente pula beta.

- [ ] **Step 3: Adjust the workflow**

Executar release-assets em stable e beta. Para beta, passar draft=true mesmo quando rascunho não foi solicitado; manter o nome fixo do zip/checksum. Fazer beta-marcar aguardar windows, linux e release-assets antes de executar gh release edit com prerelease e draft=false. Atualizar comentários que ainda descrevem a exclusão do plugin no beta.

- [ ] **Step 4: Test and commit**

~~~bash
npm test -- --run tests/plugin-update-workflow.test.ts
git diff --check
git add .github/workflows/build-gui.yml golive-gui/tests/plugin-update-workflow.test.ts
git commit -m "ci: publicar asset do plugin no canal beta"
~~~

---

### Task 5: Documentação e validação completa

**Files:**
- Modify: goLiveBypass/COMO-INSTALAR.md
- Modify: CHANGELOG.md
- Test: golive-gui/tests/plugin-update-docs.test.ts
- Evidence: /tmp/win11-plugin-update-*.png and /tmp/golive-plugin-update-*.log

- [ ] **Step 1: Add documentation tests**

Testar stable padrão, beta opt-in, auto update, SHA-256, reload manual e uma entrada Unreleased no changelog, mantendo separação da GUI/standalone.

- [ ] **Step 2: Update documentation**

Adicionar o fluxo das duas preferências, o asset/checksum fixos e o fato de que o reload é manual. Registrar a nova capacidade em Unreleased sem alterar o histórico independente da GUI ou do standalone.

- [ ] **Step 3: Run complete host validation**

~~~bash
cd golive-gui
npm test
npm run check-bypass
git diff --check
~~~

Expected: suíte completa aprovada, bypass em dia e diff limpo.

- [ ] **Step 4: Validate the VM**

Empacotar somente as fontes do plugin, transferir pela FAT share temporária, extrair no checkout Equicord, executar build e inject com pnpm.cmd, abrir o Discord e conferir stable padrão/auto ligado. Selecionar beta, verificar consulta imediata, download, SHA-256, manifest, backup, build e aviso de reload sem fechar Discord. Repetir a checagem para confirmar idempotência; voltar a stable para confirmar rollback/descarte da beta pendente enquanto chamada e WireSock continuam ativos.

- [ ] **Step 5: Collect evidence and finish**

Capturar seletor, auto update, pending reload, chamada e serviço WireSock. Copiar o log, ejetar a FAT share no Windows, desanexar e destruir a imagem temporária. Criar docs/superpowers/reports/2026-09-07-plugin-update-validation.md com testes, hash, evidências e limitações; revisar git diff/status e preservar arquivos não relacionados.

## Self-review

Todas as seções da especificação têm tarefa: UX/estado nas Tasks 2–3, SemVer nas Tasks 1–2, segurança/rollback nas Task 2, workflow nas Task 4, documentação e VM na Task 5. A compatibilidade beta.1/beta-1 é testada na Task 1. Não há placeholders nem dependências de um arquivo da GUI em runtime.
