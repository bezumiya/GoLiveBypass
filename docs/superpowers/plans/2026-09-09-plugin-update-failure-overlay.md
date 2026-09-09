# Plugin Update Failure Overlay Implementation Plan

> **For agentic workers:** Execute this plan task-by-task, mantendo os checkboxes atualizados e revisando a integração antes da validação na VM.

**Goal:** Exibir falhas reais da checagem automática do updater como overlay deduplicado dentro do Discord.

**Architecture:** Reutilizar o status existente do processo principal. O renderer terá um componente de toast separado para erros e uma chave local de deduplicação; `refreshStatus` e o polling de inicialização alimentarão o mesmo helper. Nenhuma nova operação privilegiada será adicionada.

**Tech Stack:** TypeScript/TSX do userplugin Vencord, `Toasts.CUSTOM`, testes-fonte Node.js, Go helper Proton e build Windows/Vencord.

**Spec:** `docs/superpowers/specs/2026-09-09-plugin-update-failure-overlay-design.md`

## Global Constraints

- Usar somente `lastError` retornado pelo updater; não inventar progresso ou sucesso.
- Não reiniciar, encerrar, ativar VPN ou alterar rotas em resposta ao erro.
- Não duplicar notificações para o mesmo canal, versão e erro.
- Truncar a mensagem exibida e manter o overlay sem roubo de foco.
- Preservar mudanças existentes e não editar GUI/standalone.

---

### Task 1: Contrato do overlay e deduplicação

**Files:**
- Modify: `tests/test-plugin-update-notification.mjs`
- Modify: `goLiveBypass/index.tsx`

**Interfaces:**
- Consumes: `PluginUpdateStatus.current`, `.channel` e `.lastError`.
- Produces: `notifyPluginUpdateFailure(current: unknown, channel: unknown, error: unknown): void` e o componente `PluginUpdateFailureToast`.

- [x] **Step 1: Write the failing test**

Adicionar uma asserção que exija componente customizado de falha, versão/canal/erro,
deduplicação por chave e chamadas a partir de `refreshStatus` e do polling de
inicialização. Exigir também que o bloco de notificação não invoque reinício ou
ativação.

- [x] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types tests/test-plugin-update-notification.mjs`

Expected: FAIL porque o componente e o helper de falha ainda não existem.

- [x] **Step 3: Write minimal implementation**

Em `goLiveBypass/index.tsx`, adicionar:

```tsx
let lastNotifiedUpdateErrorKey: string | null = null;

function notifyPluginUpdateFailure(current: unknown, channel: unknown, error: unknown): void {
    if (typeof error !== "string" || !error.trim()) return;
    const key = `${normalizedUpdateChannel(channel)}:${typeof current === "string" && current ? current : PLUGIN_VERSION}:${error}`;
    if (key === lastNotifiedUpdateErrorKey) return;
    lastNotifiedUpdateErrorKey = key;
    showToast("Atualização do GoLiveBypass", Toasts.Type.CUSTOM, {
        position: Toasts.Position.BOTTOM,
        duration: 15_000,
        component: <PluginUpdateFailureToast ... />,
    });
}
```

O componente deve renderizar `role="status"`, `aria-live="polite"`, versão atual,
canal e `error.slice(0, 240)`, com botão `Depois` que apenas chama `Toasts.pop()`.
Quando um status sem erro for aceito, limpar `lastNotifiedUpdateErrorKey`.

- [x] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types tests/test-plugin-update-notification.mjs`

Expected: PASS com 10 testes.

### Task 2: Integrar os pontos de observação

**Files:**
- Modify: `goLiveBypass/index.tsx`
- Test: `tests/test-plugin-update-notification.mjs`

**Interfaces:**
- Consumes: `notifyPluginUpdateFailure` da Task 1.
- Produces: feedback automático para falha observada no card e no startup polling.

- [x] **Step 1: Integrate status paths**

No ramo `next.lastError` de `refreshStatus`, chamar o helper antes de atualizar o
estado do card. No ramo sem erro, limpar a chave. No polling de `start()`, chamar o
helper quando `status.lastError` existir; quando não existir, limpar a chave.

- [x] **Step 2: Review safety contract**

Confirmar por busca que o novo helper não contém `restartDiscord`, `Native.enable`,
`Native.shutdown`, `app.relaunch`, `app.quit` ou `process.kill`.

- [x] **Step 3: Run focused and full tests**

Run: `node --experimental-strip-types tests/test-plugin-update-notification.mjs`,
`for test_file in tests/test-plugin-*.mjs; do node --experimental-strip-types "$test_file"; done`,
`(cd tools/proton-confgen && go test ./...)`, `./tests/test-userplugin-e2e.sh` e
`git diff --check`.

Expected: todos passam, E2E reporta 51/51 e não há whitespace inválido.

### Task 3: Empacotar, validar na VM e registrar

**Files:**
- Modify: `docs/superpowers/reports/2026-09-07-plugin-update-validation.md`
- Modify: `docs/superpowers/plans/2026-09-09-plugin-update-failure-overlay.md`

**Interfaces:**
- Consumes: pacote produzido pelo E2E e o estado atual da VM `win11`.
- Produces: artefato hashado, backup, evidência de `testTsc`/`build` e limitação real.

- [x] **Step 1: Build the Windows package**

Gerar um zip com `goLiveBypass/` e `proton-confgen.exe` Windows x64 em
`/tmp/golive-plugin-final41.zip`, registrar tamanho e SHA-256.

- [x] **Step 2: Install with rollback path**

Transferir via share FAT temporário, extrair para uma pasta versionada, mover o
plugin anterior para backup e instalar o novo. Confirmar que a VM está no checkout
integrado atual antes de compilar.

- [x] **Step 3: Run Windows verification**

Executar `pnpm.cmd testTsc` e `pnpm.cmd build`, observar o retorno ao prompt e erros
visíveis. Não injetar/recarregar/reiniciar se a call/transmissão estiver ativa.

- [x] **Step 4: Clean transport safely**

Ejetar H: dentro do Windows, confirmar que a unidade sumiu no Explorer, destacar e
destruir somente o share temporário desta tarefa; preservar `sdc`, `sdd` e `sde`.

- [x] **Step 5: Update checkpoint**

Registrar implementação, testes, hash, backup, evidências e limitações no relatório;
marcar este plano como concluído somente após `git diff --check` final.
