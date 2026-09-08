# Proton Helper Hash Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Garantir que os helpers `proton-confgen` embutidos na GUI e publicados para reparo tenham exatamente os mesmos bytes e hashes em Linux e Windows.

**Architecture:** O script `golive-gui/scripts/build-proton.mjs` será a única fonte de compilação dos dois helpers e desativará o carimbo VCS do Go para que arquivos gerados no checkout não alterem os bytes. O job `proton-runtime-assets` reutilizará essas saídas e validará cada hash contra o manifesto antes do upload.

**Tech Stack:** Go cross-compilation, Node.js, GitHub Actions YAML, SHA-256, Vitest e documentação Markdown.

**Spec:** `docs/releases/2026-09-08-proton-helper-hash-parity.md`

## Global Constraints

- A GUI deve continuar incluindo `proton-confgen` e `proton-confgen.exe` em `extraResources`.
- Linux e Windows devem ser compilados com `GOOS`, `GOARCH=amd64` e `CGO_ENABLED=0`.
- O build deve usar `-buildvcs=false`, `-trimpath`, `-ldflags=-s -w -buildid=` em todas as cópias do helper.
- O asset publicado só pode ser enviado depois de passar na comparação com `proton-confgen-manifest.json`.
- A correção não publica uma nova release automaticamente; a beta corrigida exige uma nova versão/tag.

### Task 1: Registrar o incidente e o contrato de paridade

**Files:**
- Create: `docs/releases/2026-09-08-proton-helper-hash-parity.md`
- Create: `docs/superpowers/plans/2026-09-08-proton-helper-hash-parity.md`

- [x] **Step 1: Documentar sintoma, causa, impacto e prevenção**

  Registrar que a beta `v2.0.5-beta-10` tinha containers íntegros, mas o manifesto esperava `d9bbe0cb...` e o asset Windows publicado tinha `1df3fbaa...`; a causa foi `vcs.modified=true` provocado pelo helper Linux criado no checkout antes da compilação Windows.

- [x] **Step 2: Revisar o documento contra a evidência**

  Confirmar que o documento distingue corrupção de arquivo, inconsistência de empacotamento e o comportamento esperado do updater.

### Task 2: Tornar a compilação do helper determinística

**Files:**
- Modify: `golive-gui/scripts/build-proton.mjs`
- Test: `golive-gui/tests/proton-packaging.test.ts`

- [x] **Step 1: Escrever a asserção preventiva**

  Exigir no teste que o script contenha `-buildvcs=false`, mantenha `-trimpath` e `-buildid=`, e que o manifesto continue sendo gerado.

- [x] **Step 2: Executar o teste antes da implementação**

  Run: `npm test -- tests/proton-packaging.test.ts` em `golive-gui/`.
  Expected: FAIL na asserção de `-buildvcs=false`.

- [x] **Step 3: Aplicar a flag determinística**

  Alterar `buildArgs` para `['build', '-buildvcs=false', '-trimpath', '-ldflags=-s -w -buildid=', '-o']`, mantendo os dois targets, o manifesto e as variáveis de ambiente existentes.

- [x] **Step 4: Executar o teste focado**

  Run: `npm test -- tests/proton-packaging.test.ts` em `golive-gui/`.
  Expected: PASS.

### Task 3: Fazer o workflow reutilizar e conferir o mesmo output

**Files:**
- Modify: `.github/workflows/build-gui.yml`
- Test: `golive-gui/tests/proton-packaging.test.ts`

- [x] **Step 1: Escrever as asserções do workflow**

  Exigir que o job configure Node, execute `node golive-gui/scripts/build-proton.mjs`, copie os dois outputs nomeados para `runtime/` e compare seus hashes com o manifesto antes do upload.

- [x] **Step 2: Executar o teste para registrar a falha**

  Run: `npm test -- tests/proton-packaging.test.ts` em `golive-gui/`.
  Expected: FAIL nas asserções do novo fluxo do job.

- [x] **Step 3: Substituir a compilação duplicada do job**

  No `proton-runtime-assets`, adicionar `actions/setup-node@v4`, executar o script compartilhado, copiar `build/proton-confgen` e `build/proton-confgen.exe` para os nomes versionados de `runtime/`, gerar os sidecars `.sha256`, conferir a versão e comparar os hashes via `jq` antes do upload.

- [x] **Step 4: Executar o teste focado**

  Run: `npm test -- tests/proton-packaging.test.ts` em `golive-gui/`.
  Expected: PASS.

### Task 4: Registrar a correção no changelog e validar o conjunto

**Files:**
- Modify: `CHANGELOG.md`

- [x] **Step 1: Adicionar a entrada em Unreleased**

  Referenciar o uso de `-buildvcs=false`, a reutilização do output e a comparação obrigatória manifesto/asset, com link para o incidente.

- [x] **Step 2: Validar o build e os testes**

  Run: `npm test -- tests/proton-packaging.test.ts`, `npm run compile`, `npm run check-bypass` e `git diff --check` em `golive-gui/`/raiz conforme o comando.
  Expected: todos concluídos sem falha; o manifesto gerado deve ter hashes não vazios para Linux e Windows.

- [x] **Step 3: Confirmar o escopo de release**

  Verificar que nenhuma tag ou release remota foi alterada e informar que a publicação da próxima beta permanece como etapa separada.
