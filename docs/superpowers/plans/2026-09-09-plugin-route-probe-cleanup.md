# Limpeza segura dos probes de rota do plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminar o acúmulo de executáveis temporários de prova de rota do plugin sem alterar o roteamento, o isolamento por aplicativo ou o comportamento log-only dos diagnósticos.

**Architecture:** `vpn-windows.ts` será responsável por reconhecer, proteger e remover somente probes gerenciados no diretório de dados do plugin, com retry limitado e varredura de resíduos antigos. `vpn-controller.ts` registrará imediatamente cada cópia, acompanhará probes em voo, fará cleanup em boot/erro/parada e liberará ownership somente se o registro ainda for da mesma geração. Testes Node cobrirão o contrato de arquivos e as garantias de ordem/lifecycle; a VM Windows confirmará o comportamento integrado.

**Tech Stack:** TypeScript executado pelo Vencord/Electron, APIs `fs`/`path` do Node, Node test runner com `--experimental-strip-types`, shell E2E de empacotamento, Go helper existente e libvirt Windows VM.

**Spec:** `docs/superpowers/specs/2026-09-09-plugin-route-probe-cleanup-design.md`

## Global Constraints

- O probe aceito deve ter exatamente o basename `.golive-route-probe-<pid>-<timestamp>.exe` e estar diretamente no diretório de dados do plugin.
- Symlinks, diretórios, traversal e caminhos fora do diretório não podem ser removidos ou executados.
- O probe do owner ativo e qualquer operação de diagnóstico em voo devem ser preservados até deixarem de ser usados.
- Falha de cleanup é diagnóstica; não bloqueia ativação nem restauração da rede.
- Não encerrar processos por PID, não assumir WireSock externo e não alterar o isolamento WFP/AllowedApps.
- Não expor credenciais, tokens, cookies, chaves WireGuard, IPs públicos ou dados Proton.
- Não publicar release, fazer push, alterar feed público ou enviar mensagens de canal.

---

### Task 1: Definir e testar o contrato de cleanup de arquivos

**Files:**
- Modify: `goLiveBypass/vpn-windows.ts:610-634`
- Create: `tests/test-plugin-route-probe.mjs`

**Interfaces:**
- Produces `isManagedRouteProbePath(directory: string, candidate: string): boolean`.
- Produces `removeRouteProbe(directory: string, target: string): Promise<"removed" | "missing" | "invalid" | "busy">`.
- Produces `cleanupRouteProbes(directory: string, protectedPaths?: readonly string[], now?: number, graceMs?: number): Promise<RouteProbeCleanupResult>`.
- `RouteProbeCleanupResult` contém `scanned`, `removed`, `protected`, `recent`, `invalid` e `busy`.

- [x] **Step 1: Escrever os testes de contrato que devem falhar antes da implementação**

  Em `tests/test-plugin-route-probe.mjs`, crie uma raiz temporária e cubra:

  ```js
  const oldProbe = path.join(root, ".golive-route-probe-11-1000.exe");
  const protectedProbe = path.join(root, ".golive-route-probe-12-1000.exe");
  const recentProbe = path.join(root, ".golive-route-probe-13-1000.exe");
  const linkProbe = path.join(root, ".golive-route-probe-14-1000.exe");
  writeFileSync(oldProbe, "old");
  writeFileSync(protectedProbe, "protected");
  writeFileSync(recentProbe, "recent");
  writeFileSync(outside, "outside");
  symlinkSync(outside, linkProbe);
  const now = 2_000_000;
  utimesSync(oldProbe, new Date(1_000_000), new Date(1_000_000));
  utimesSync(protectedProbe, new Date(1_000_000), new Date(1_000_000));
  utimesSync(recentProbe, new Date(now - 1_000), new Date(now - 1_000));
  const result = await cleanupRouteProbes(root, [protectedProbe], now, 60_000);
  assert.equal(result.removed, 1);
  assert.equal(result.protected, 1);
  assert.equal(result.recent, 1);
  assert.equal(result.invalid, 1);
  assert.equal(existsSync(oldProbe), false);
  assert.equal(existsSync(protectedProbe), true);
  assert.equal(existsSync(recentProbe), true);
  assert.equal(existsSync(outside), true);
  ```

  Inclua também cópia sem sobrescrita, remoção idempotente, nome inválido e
  caminho fora da raiz. Use `node --experimental-strip-types` para executar o
  arquivo e confirme que ele falha por export ausente ou contrato ausente.

- [x] **Step 2: Implementar o reconhecimento seguro e a remoção limitada**

  Em `vpn-windows.ts`, adicione um regex privado para o basename exato e use
  `path.resolve`, `path.relative` e `path.dirname` para exigir a raiz imediata.
  Em `removeRouteProbe`, faça `lstatSync`, rejeite symlink/entrada não regular
  e use três tentativas assíncronas explícitas com 200 ms entre elas, sem
  remoção recursiva. Converta ausência, caminho inválido e bloqueio em estados
  explícitos.

- [x] **Step 3: Implementar a varredura com proteção de owner e janela de graça**

  Liste apenas a raiz fornecida, ignore nomes que não correspondam ao regex,
  proteja os caminhos normalizados em `protectedPaths`, ignore arquivos com
  `now - mtimeMs < graceMs` e acumule o resultado sem lançar por falha de
  `lstat`/remoção. Symlinks e diretórios contam como `invalid` e permanecem
  intactos.

- [x] **Step 4: Executar os testes de contrato**

  ```bash
  node --experimental-strip-types tests/test-plugin-route-probe.mjs
  ```

  Esperado: todos os casos do novo módulo passam e os arquivos fora do padrão
  ou fora da raiz permanecem.

### Task 2: Integrar o cleanup ao lifecycle do controlador

**Files:**
- Modify: `goLiveBypass/vpn-controller.ts:134-171, 422-520, 522-562, 586-620, 700-790`
- Create: `tests/test-plugin-route-probe-lifecycle.mjs`

**Interfaces:**
- `PluginVpnController` mantém um `Set<Promise<void>>` privado para probes em
  voo e expõe apenas os métodos existentes de ativação/parada.
- `removeProbe()` torna-se assíncrono e aguarda esse conjunto antes de apagar
  os caminhos conhecidos; o resultado da varredura só é registrado no log.
- O controlador mantém o token (`pid`, `generation`, `createdAt`) da sessão que
  registrou o probe; uma instância antiga não remove o probe de uma sucessora.

- [x] **Step 1: Escrever as asserções de ordem/lifecycle**

  No teste textual, recorte os blocos `startInternal`, `stopInternal`,
  `removeProbe`, `startDiagnostics`, `initialize` e `releaseOwnership` e exija:

  ```js
  assert.match(source, /this\.probePath = target/);
  assert.match(source, /await this\.waitForRouteProbes\(\)/);
  assert.match(source, /windows\.cleanupRouteProbes\(this\.dataDir/);
  assert.match(failureBlock, /await this\.removeProbe\(/);
  assert.ok(failureBlock.indexOf("await this.removeProbe(") < failureBlock.indexOf("this.releaseOwnership(owner)"));
  assert.match(source, /current\.pid !== owner\.pid/);
  assert.match(source, /current\.generation !== owner\.generation/);
  ```

  Exija ainda que o caminho vindo de `owner.lock` seja validado por
  `windows.isManagedRouteProbePath` antes de `runRouteProbe`/remoção.

- [x] **Step 2: Registrar cada probe no momento da cópia**

  Em `prepareRouteProbe`, atribua `this.probePath = target` imediatamente após
  `copyRouteProbe` retornar. Assim, um erro posterior em `writeOwner` ou no
  início do serviço ainda consegue encontrar a cópia criada.

- [x] **Step 3: Acompanhar e drenar diagnósticos assíncronos**

  Adicione `trackRouteProbe` e `waitForRouteProbes`. Envolva a promise de
  `windows.runRouteProbe` em `then/catch`, registre-a no `Set` e retire-a tanto
  em sucesso quanto em erro. Não mude o timeout, o parsing nem o modo
  `log-only` do diagnóstico.

- [x] **Step 4: Fazer cleanup em todos os caminhos seguros**

  Transforme `removeProbe` em `async`, capture `this.probePath` e o
  `owner.probePath` antes da remoção, aguarde as promises, remova caminhos
  conhecidos e execute a varredura. Chame-o antes de `releaseOwnership` em
  falha de ativação, parada normal e boot sem serviço. Antes de uma nova cópia,
  faça uma varredura de resíduos antigos; durante adoção ativa, proteja o probe
  do owner atual.

- [x] **Step 5: Fechar as corridas de owner e validar paths lidos**

  Faça `releaseOwnership` comparar `pid`, `generation` e `createdAt` do registro
  atual com o registro que está sendo liberado. Em `readOwner`, preserve o
  owner, mas converta `probePath` inválido em `undefined`, impedindo execução ou
  remoção fora do diretório.

- [x] **Step 6: Executar o teste de lifecycle**

  ```bash
  node --experimental-strip-types tests/test-plugin-route-probe-lifecycle.mjs
  ```

  Esperado: a ordem limpeza→liberação, registro imediato, espera de promise e
  proteção de ownership são detectados pelo teste.

### Task 3: Rodar a regressão local completa

**Files:**
- Read: `tests/test-plugin-*.mjs`
- Read: `tools/proton-confgen/`
- Read: `tests/test-userplugin-e2e.sh`

- [x] **Step 1: Rodar os testes focados**

  ```bash
  node --experimental-strip-types tests/test-plugin-route-probe.mjs
  node --experimental-strip-types tests/test-plugin-route-probe-lifecycle.mjs
  node --experimental-strip-types tests/test-plugin-controller-recovery.mjs
  node --experimental-strip-types tests/test-plugin-lifecycle.mjs
  ```

- [x] **Step 2: Rodar toda a suíte Node do plugin**

  ```bash
  for file in tests/test-plugin-*.mjs; do node --experimental-strip-types "$file"; done
  ```

  Registrar cada módulo e contagem; nenhum teste deve ser removido, relaxado ou
  passado com timeout ampliado.

- [x] **Step 3: Verificar helper, empacotamento e diff**

  ```bash
  (cd tools/proton-confgen && go test ./...)
  ./tests/test-userplugin-e2e.sh
  git diff --check
  ```

  O E2E deve montar o helper Windows x64 atual em diretório temporário e
  verificar manifest, hash, extração e rollback; não usar o helper antigo do
  artefato final45.

### Task 4: Validar o artefato integrado na VM Windows

**Files:**
- Read: `docs/superpowers/reports/2026-09-07-plugin-update-validation.md`
- Create outside repository: `/tmp/golive-plugin-route-cleanup.zip` e scripts
  temporários de instalação/coleta.

- [x] **Step 1: Confirmar baseline e transporte**

  Executar `vmctl.sh status`, `vmctl.sh disks` e screenshot. Construir o zip a
  partir do código atual e do helper Go atual, registrar SHA-256 e anexar um
  único compartilhamento FAT temporário como `sdc`.

- [x] **Step 2: Instalar e compilar somente o artefato atual**

  Copiar o plugin para a pasta de userplugins da VM com backup recuperável,
  executar `pnpm.cmd testTsc`, `pnpm.cmd build` e `pnpm.cmd inject`, confirmar a
  assinatura/manifest do plugin e relançar o Discord oficial pelo `Update.exe`.

- [x] **Step 3: Reproduzir abertura e lifecycle do diagnóstico**

  Confirmar por screenshot a interface normal do cliente oficial, registrar o
  boot do plugin, ativar a rota já configurada sem trocar conta/canal e deixar
  pelo menos um watchdog iniciar. Fechar a operação pelo caminho normal do
  plugin/Discord, não por `taskkill`, e iniciar novamente para exercitar o
  cleanup de boot.

- [x] **Step 4: Coletar e sanitizar o resultado**

  Recuperar `plugin-vpn.log`, `owner.lock`, metadata do diretório e processos
  por coletor sanitizado. Confirmar que o serviço/Discord continuam funcionais,
  que o probe protegido é o único permitido enquanto ativo e que probes antigos
  desaparecem após a parada/reativação. Não registrar conteúdo de perfil,
  sessão, token ou IP.

- [x] **Step 5: Deixar a VM limpa**

  Ejetar `E:` com `mountvol E: /p`, confirmar que a unidade desapareceu,
  executar `share-detach sdc`, recuperar os logs, destruir somente a imagem
  temporária criada nesta tarefa e confirmar `vmctl.sh disks` sem `sdc`.

### Task 5: Revisar e registrar o ciclo

**Files:**
- Modify: `docs/superpowers/reports/2026-09-07-plugin-update-validation.md`
- Read: `docs/superpowers/specs/2026-09-09-plugin-route-probe-cleanup-design.md`

- [x] **Step 1: Revisar a alteração contra invariantes**

  Conferir que nenhum caminho do plugin legado, GUI ou standalone recebeu
  premissas do WireGuard atual e que cleanup não virou condição de ativação.

- [x] **Step 2: Registrar fatos e limitações**

  Adicionar uma seção com commit/artefato/hash, testes locais, screenshots/logs
  sanitizados, contagem de probes antes/depois e resultado de abertura do
  Discord oficial. Marcar explicitamente login Proton novo, CAPTCHA/2FA, prova
  geográfica e updater remoto como não validados quando continuarem fora do
  ambiente.

- [x] **Step 3: Fazer revisão final do diff**

  ```bash
  git diff --check
  git status --short
  ```

  Confirmar que somente os arquivos desta mudança e o relatório foram tocados,
  preservando todas as alterações preexistentes do usuário e sem publicação.

## Status

Concluído em 2026-09-09. Os testes de contrato e lifecycle, a suíte local, o
empacotamento e a compilação/injeção Windows foram validados. A VM confirmou o
Discord oficial no segundo reboot, ativação com probe único e limpeza após
restauração; o primeiro cold boot com clone foi descartado como evidência e o
autostart foi corrigido. A falha pré-implementação dos testes não foi mantida
como artefato; o worktree também contém alterações preexistentes do usuário,
que foram preservadas e não são atribuídas a este plano.
