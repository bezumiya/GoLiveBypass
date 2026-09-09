# Plugin profile selection cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Regerar o perfil Proton quando as preferências de seleção mudarem, sem reutilizar uma rota stale.

**Architecture:** O `PluginVpnController` continuará sendo a autoridade do cache. O marcador privado existente receberá um contrato pequeno e não sensível; a ativação e a otimização usarão a mesma seleção normalizada. Perfis customizados continuarão invalidando o marcador.

**Tech Stack:** TypeScript, Node test runner, Electron/Vencord userplugin, WireGuard/WireSock e helper Proton em Go.

**Spec:** `docs/superpowers/specs/2026-09-09-plugin-profile-selection-cache-design.md`

## Global Constraints

- Não armazenar senha, token ou chave privada no marcador.
- Não assumir, parar ou matar WireSock externo.
- Não alterar GUI Electron, standalone legado ou `app.asar`.
- Não transformar probes diagnósticos em condições bloqueantes.
- Preservar as alterações locais existentes e não publicar release, deploy ou mensagem.
- A plataforma do transporte do plugin continua Windows x64.

---

### Task 1: Fixar o contrato de seleção no teste

**Files:**
- Modify: `tests/test-plugin-account-switch.mjs`
- Modify: `goLiveBypass/vpn-controller.ts`

**Interfaces:**
- O marcador continua em `wireguard-profile-account.json`.
- `protonProfileMatches(username, selection)` compara `country`, `freeOnly` e `autoPing` além de `schema` e `username`.
- `writeProtonProfileAccount(username, selection)` grava somente os campos não sensíveis do contrato.

- [x] **Step 1: Write the failing assertions**

Adicionar ao teste de ativação asserções para `profileSelection`, os campos
`country`, `freeOnly` e `autoPing`, e para passar a seleção efetiva ao método de
comparação e ao gerador.

- [x] **Step 2: Run the focused test and verify failure**

Executar `node --experimental-strip-types tests/test-plugin-account-switch.mjs`.
O teste deve falhar porque o marcador atual só contém conta/schema.

- [x] **Step 3: Implement the minimal selection-aware marker**

Normalizar a seleção a partir de `VpnSettings`, usar os mesmos valores na
ativação e gravar os valores efetivos após geração/otimização. Um marcador antigo
sem os campos deve ser considerado incompatível e provocar regeneração.

- [x] **Step 4: Run focused regressions**

Executar o teste de troca de conta e o teste de recuperação do controller; ambos
devem passar sem alterar a guarda de ownership externo.

- [x] **Step 5: Review the diff**

Conferir que o diff não introduz segredos, chamadas à GUI/standalone, `taskkill`
para processo externo ou alteração de `AllowedApps`.

### Task 2: Validação integrada e evidência

**Files:**
- Modify: `docs/superpowers/reports/2026-09-07-plugin-update-validation.md`
- Modify: `docs/superpowers/plans/2026-09-09-plugin-profile-selection-cache.md`

**Interfaces:**
- Consome o contrato implementado na Task 1.
- Registra resultados locais, E2E, helper Proton, build Windows e limitações de runtime.

- [x] **Step 1: Run the plugin suite**

Executar `for test_file in tests/test-plugin-*.mjs; do node --experimental-strip-types "$test_file"; done` e `git diff --check`.

- [x] **Step 2: Run the helper tests**

Executar `go test ./...` em `tools/proton-confgen/`.

- [x] **Step 3: Run userplugin E2E**

Executar `./tests/test-userplugin-e2e.sh` e registrar o resultado sem incluir
credenciais, sessões ou chaves.

- [x] **Step 4: Build/test the Windows checkout**

Transferir somente o artefato final por share FAT temporário, instalar uma cópia
identificável com backup, executar `pnpm.cmd testTsc` e `pnpm.cmd build`, ejetar
H: antes de destacar/destruir o share. Não reiniciar uma call ativa.

- [x] **Step 5: Record status and limitation**

Adicionar uma seção final37 com hash do artefato, shares preservados, verificações
e a distinção entre validação de código/build e ativação Proton real.

## Status

Concluído em 2026-09-09. O marcador agora inclui seleção de país, servidores
gratuitos e auto-ping; testes locais, helper, E2E e build/testTsc Windows foram
validados. A ativação Proton real permanece não exercitada enquanto a call
autorizada estiver ativa.
