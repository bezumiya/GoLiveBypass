# Instalação automática do runtime da GUI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preparar automaticamente os componentes Proton/WireGuard necessários no Windows e Linux, reparar instalações incompletas sem instalação manual e publicar a beta `2.0.5-beta-8`.

**Architecture:** `proton-runtime.ts` será a fronteira responsável por localizar, validar, cachear e reparar o `proton-confgen`; `proton.ts` garantirá esse runtime antes de qualquer operação Proton. O build produzirá um manifesto SHA-256 determinístico e o workflow publicará helpers auxiliares da mesma tag. A instalação do WireSock e dos pacotes Linux permanecerá nos caminhos existentes, com elevação somente durante uma ativação/login iniciado pelo usuário.

**Tech Stack:** Electron, TypeScript, Node.js `fs`/`https`/`crypto`, Go cross-compilation, shell POSIX, electron-builder, GitHub Actions, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-07-auto-install-runtime-design.md`

## Global Constraints

- A release beta deve usar `2.0.5-beta-8`, tag `v2.0.5-beta-8`, canal `beta`, `prerelease=true` e nunca `latest`.
- O helper baixado só pode ser executado após validação SHA-256 contra o manifesto empacotado da versão atual.
- O Windows usa UAC para WireSock; o Linux usa `pkexec`/`sudo` somente para os pacotes ausentes e não faz upgrade global.
- Não instalar o aplicativo ProtonVPN desktop, não alterar a rota global e não transformar probes em bloqueio de ativação.
- Preservar as alterações pendentes do workspace principal; toda implementação deste plano ocorre no worktree isolado `/tmp/golive-beta8-auto-install`.

### Task 1: Runtime Proton seguro e cache versionado

**Files:**
- Create: `golive-gui/electron/proton-runtime.ts`
- Modify: `golive-gui/electron/proton.ts:1-110,353-390,410-510,532-610,680-760`
- Create: `golive-gui/tests/proton-runtime.test.ts`
- Modify: `golive-gui/tests/proton.test.ts`

**Interfaces:**
- Consumes: contexto de recursos (`resourcesPath`, `appPath`, `execPath`, `cwd`, `moduleDir`), `installDir` e versão da GUI.
- Produces: `findProtonConfgenPath(context): string | undefined`, `readProtonRuntimeManifest(paths): ProtonRuntimeManifest | undefined`, `ensureProtonConfgen(options): Promise<string>` e `protonRuntimeAssetUrl(version, asset): string`.

- [ ] **Step 1: Escrever testes unitários falhando para resolução e cache**

  Em `proton-runtime.test.ts`, usar arquivos temporários para cobrir:

  ```ts
  it('prioriza extraResources e aceita layout ao lado do executável', () => {
    const context = { resourcesPath: '/app/resources', execPath: '/app/GoLiveBypass.exe', appPath: '/app/resources/app.asar', cwd: '/repo/golive-gui', moduleDir: '/repo/golive-gui/dist-electron', platform: 'win32' as const, arch: 'x64' as const };
    expect(protonConfgenCandidates(context)[0]).toContain('resources');
    expect(protonConfgenCandidates(context)).toContain('/app/resources/extra/proton-confgen/proton-confgen.exe');
  });

  it('copia o helper validado para runtime/<versão> sem deixar temporário', async () => {
    const result = await stageValidatedProtonConfgen({ sourcePath, installDir, version: '2.0.5-beta-8', expectedSha256 });
    expect(result).toContain('runtime');
    expect(fs.readFileSync(result)).toEqual(fs.readFileSync(sourcePath));
    expect(fs.readdirSync(path.dirname(result))).not.toContain(expect.stringContaining('.tmp'));
  });

  it('rejeita hash incorreto e versões/path inválidos', async () => {
    await expect(stageValidatedProtonConfgen({ sourcePath, installDir, version: '../x', expectedSha256 })).rejects.toThrow(/versão/i);
    await expect(stageValidatedProtonConfgen({ sourcePath, installDir, version: '2.0.5-beta-8', expectedSha256: '0'.repeat(64) })).rejects.toThrow(/SHA-256/i);
    expect(protonRuntimeAssetUrl('2.0.5-beta-8', 'proton-confgen-win-x64.exe')).toBe('https://github.com/bezumiya/GoLiveBypass/releases/download/v2.0.5-beta-8/proton-confgen-win-x64.exe');
  });
  ```

- [ ] **Step 2: Rodar os testes para confirmar a falha**

  Run: `npm test -- tests/proton-runtime.test.ts`

  Expected: FAIL porque o módulo e as funções ainda não existem.

- [ ] **Step 3: Implementar resolução, manifesto, hash, cache e download**

  Em `proton-runtime.ts`:

  1. Definir `ProtonRuntimeManifest` com `version` e entradas `win32-x64`/`linux-x64`, cada uma com `asset` e `sha256`.
  2. Procurar nesta ordem: `resourcesPath/extra/proton-confgen`, `resourcesPath/extra`, pasta `extra` ao lado de `execPath`, `appPath/../tools/proton-confgen/build`, `cwd/../tools/proton-confgen/build`, `moduleDir/../../tools/proton-confgen/build` e `cwd/tools/proton-confgen/build`.
  3. Validar a versão com `/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/` e o SHA-256 com `/^[a-f0-9]{64}$/i`.
  4. Se o helper local existir e o manifesto correspondente existir, conferir o hash; se não houver manifesto em desenvolvimento, aceitar apenas um arquivo existente e não vazio.
  5. Copiar para `installDir/runtime/<version>/<asset>` usando arquivo temporário no mesmo diretório, `renameSync` atômico e `chmod 0700` no Linux.
  6. Quando não houver helper local validado, baixar apenas por HTTPS de `github.com`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com` ou subdomínio `githubusercontent.com`, limitar redirects a 3 e tamanho a 100 MiB, conferir SHA-256 e instalar atomicamente.
  7. Deduplicar chamadas concorrentes por versão/plataforma e nunca executar um arquivo antes da validação.

- [ ] **Step 4: Integrar o runtime em todas as operações Proton**

  Em `proton.ts`, substituir o resolvedor local por um wrapper que monta o contexto Electron e manter `findProtonConfgenExe()` como API compatível. Antes de cada `runConfgen` sem `exePath`, chamar `ensureProtonConfgen(installDir, app.getVersion())` nas funções `checkProtonSession`, `getProtonPlan`, `loginProton`, `generateOptimalProtonConfig`, `generateProtonRoutePool` e `runIsolatedSpeedSelection`. Propagar falha como `MISSING_EXECUTABLE` com a mensagem “O componente Proton não pôde ser preparado automaticamente; verifique sua conexão e tente novamente.”

- [ ] **Step 5: Rodar testes do runtime e Proton**

  Run: `npm test -- tests/proton-runtime.test.ts tests/proton.test.ts tests/proton-speed-selection.test.ts`

  Expected: PASS, incluindo o teste existente que encontra e executa `proton-confgen` no desenvolvimento.

- [ ] **Step 6: Commitar a unidade de runtime**

  ```bash
  git add golive-gui/electron/proton-runtime.ts golive-gui/electron/proton.ts golive-gui/tests/proton-runtime.test.ts golive-gui/tests/proton.test.ts
  git commit -m "feat(gui): repair bundled Proton runtime automatically"
  ```

### Task 2: Build determinístico e assets de reparo

**Files:**
- Modify: `golive-gui/scripts/build-proton.mjs`
- Modify: `golive-gui/package.json:1-70`
- Modify: `.github/workflows/build-gui.yml:1-210`
- Create: `golive-gui/tests/proton-packaging.test.ts`

**Interfaces:**
- Consumes: `tools/proton-confgen/cmd/protonvpn-wg` e versão de `golive-gui/package.json`.
- Produces: `tools/proton-confgen/build/proton-confgen`, `proton-confgen.exe` e `proton-confgen-manifest.json`; assets de release `GoLiveBypass-<version>-proton-confgen-linux-x64` e `GoLiveBypass-<version>-proton-confgen-win-x64.exe`.

- [ ] **Step 1: Escrever teste de empacotamento falhando**

  Em `proton-packaging.test.ts`, ler `package.json`, `build-proton.mjs` e o workflow e exigir:

  ```ts
  expect(packageJson.build.extraResources).toEqual(expect.arrayContaining([
    expect.objectContaining({ from: '../tools/proton-confgen/build', to: 'extra/proton-confgen' }),
  ]));
  expect(script).toContain('proton-confgen-manifest.json');
  expect(workflow).toContain('proton-runtime-assets');
  expect(workflow).toContain('proton-confgen-win-x64.exe');
  expect(workflow).toContain('proton-confgen-linux-x64');
  ```

- [ ] **Step 2: Implementar build reprodutível e manifesto**

  Fazer `build-proton.mjs` usar `go build -trimpath -ldflags=-s -w -buildid=` para os binários nativo e Windows x64, verificar que ambos existem e têm tamanho maior que zero, calcular SHA-256 com `crypto.createHash('sha256')` e gravar o manifesto ao lado dos binários com os nomes exatos dos assets e a versão do `package.json`. O script deve sair com erro se Go falhar ou qualquer saída estiver ausente.

- [ ] **Step 3: Publicar assets auxiliares no workflow**

  Adicionar job `proton-runtime-assets` que faz checkout de `inputs.tag`, instala Go, compila os dois binários com as mesmas flags, renomeia os arquivos para a versão da tag, gera `.sha256` e usa `softprops/action-gh-release@v2` para anexá-los à mesma release. O job deve receber `needs: [windows, linux]` para evitar corrida de publicação. Alterar `beta-marcar.needs` para incluir `proton-runtime-assets`.

- [ ] **Step 4: Rodar testes de configuração**

  Run: `npm test -- tests/proton-packaging.test.ts`

  Expected: PASS com o manifesto e os nomes de asset presentes.

- [ ] **Step 5: Commitar o build/workflow**

  ```bash
  git add golive-gui/scripts/build-proton.mjs golive-gui/package.json .github/workflows/build-gui.yml golive-gui/tests/proton-packaging.test.ts
  git commit -m "build: publish Proton runtime repair assets"
  ```

### Task 3: Elevação e reparo automático Windows/Linux

**Files:**
- Modify: `golive-gui/electron/main.ts:4725-4750,2598-2615`
- Modify: `golive-gui/electron/linux-preflight.ts:20-31`
- Modify: `standalone/golivebypass-standalone.sh:1016-1215`
- Create: `golive-gui/tests/runtime-installation-flow.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: `ensureProtonConfgen`, `ensureWireSockInstalled`, `linuxPreflightRepairable` e `runScript --ensure-dependencies`.
- Produces: login/ativação que reparam o runtime antes de usar o túnel, com progresso nos eventos IPC existentes.

- [ ] **Step 1: Escrever testes de fluxo falhando**

  Verificar por análise do código que o handler `login-proton` garante o helper antes do primeiro login, que `linuxActivate` chama `--ensure-dependencies` antes de `--cleanup-legacy`, e que a ativação Windows mantém `ensureWireSockInstalled` antes do serviço:

  ```ts
  expect(loginHandler).toContain('ensureProtonConfgen');
  expect(linuxActivation.indexOf('--ensure-dependencies')).toBeLessThan(linuxActivation.indexOf('--cleanup-legacy'));
  expect(windowsActivation).toContain('ensureWireSockInstalled');
  ```

- [ ] **Step 2: Integrar mensagens de progresso e falhas acionáveis**

  No handler de login, enviar `proton-runtime-status` com `checking`, `repairing` e `ready` quando o helper for preparado; atualizar o preload/UI somente se já houver canal existente para logs, sem incluir senha ou caminho de sessão. No Linux, manter o preflight sem efeitos e usar `--ensure-dependencies` somente para os pacotes reconhecidos; após sucesso, executar novo preflight obrigatório. No Windows, manter UAC e hash fixo do instalador WireSock e transformar cancelamento em erro sem retry automático.

- [ ] **Step 3: Ajustar mensagens/documentação**

  Atualizar o texto `MISSING_EXECUTABLE` para indicar reparo automático. Adicionar `2.0.5-beta-8` ao `CHANGELOG.md`, documentando que Windows instala WireSock via UAC, Linux instala apenas os pacotes ausentes via elevação e o helper Proton é reparado pela release correspondente.

- [ ] **Step 4: Rodar testes de fluxo e shell**

  Run: `npm test -- tests/runtime-installation-flow.test.ts tests/linux-preflight.test.ts tests/gui-preflight-integration.test.ts tests/wiresock.test.ts`

  Expected: PASS.

  Run: `bash -n standalone/golivebypass-standalone.sh`

  Expected: saída vazia e código 0.

- [ ] **Step 5: Commitar o fluxo de instalação**

  ```bash
  git add golive-gui/electron/main.ts golive-gui/electron/linux-preflight.ts standalone/golivebypass-standalone.sh golive-gui/tests/runtime-installation-flow.test.ts CHANGELOG.md
  git commit -m "feat(gui): prepare dependencies before activation"
  ```

### Task 4: Versão, validação final e publicação da beta

**Files:**
- Modify: `golive-gui/package.json:4,31-35`
- Modify: `golive-gui/package-lock.json:3,9`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: todos os commits das tarefas anteriores e workflow `build-gui.yml`.
- Produces: tag `v2.0.5-beta-8`, release prerelease em `bezumiya/GoLiveBypass` e artefatos Windows/Linux.

- [ ] **Step 1: Definir versão consistente**

  Atualizar `package.json`, `package-lock.json`, changelog e nomes esperados para `2.0.5-beta-8`; confirmar `owner=bezumiya`, `repo=GoLiveBypass` e `updater` apontando para produção.

- [ ] **Step 2: Rodar a suíte e compilação local**

  ```bash
  npm ci
  npm test
  npm run check-bypass
  npm run compile
  (cd ../tools/proton-confgen && go test ./...)
  bash -n ../standalone/golivebypass-standalone.sh
  git diff --check HEAD~4..HEAD
  ```

  Expected: todos os testes passam, helper/manifesto são gerados, Vite/TypeScript compilam e não há erro de whitespace.

- [ ] **Step 3: Conferir diff e criar tag de beta**

  ```bash
  git status --short
  git log --oneline -5
  git tag v2.0.5-beta-8
  git push origin codex/auto-install-beta8
  git push origin v2.0.5-beta-8
  ```

- [ ] **Step 4: Disparar build remoto em draft**

  ```bash
  gh workflow run build-gui.yml --repo bezumiya/GoLiveBypass --ref main \
    -f tag=v2.0.5-beta-8 -f canal=beta -f rascunho=true
  RUN_ID="$(gh run list --repo bezumiya/GoLiveBypass --workflow build-gui.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
  gh run watch "$RUN_ID" --repo bezumiya/GoLiveBypass --interval 10 --exit-status
  ```

  Expected: jobs Windows, Linux e `proton-runtime-assets` passam; macOS/release-assets permanecem pulados no canal beta.

- [ ] **Step 5: Conferir e publicar release**

  ```bash
  gh release view v2.0.5-beta-8 --repo bezumiya/GoLiveBypass --json tagName,isDraft,isPrerelease,assets,url
  gh release edit v2.0.5-beta-8 --repo bezumiya/GoLiveBypass --draft=false --prerelease --latest=false --title 'GoLiveBypass v2.0.5-beta-8'
  gh api repos/bezumiya/GoLiveBypass/releases/latest --jq .tag_name
  ```

  Expected: release sem draft, `isPrerelease=true`, assets `.exe`, AppImage, `beta-linux.yml` e os dois helpers auxiliares; `/releases/latest` continua em `v2.0.4`.

- [ ] **Step 6: Validar reparo e entrega**

  Confirmar que os hashes dos assets auxiliares batem com os manifests gerados, que a API de produção está configurada para `bezumiya/GoLiveBypass` e que uma conexão `text/event-stream` recebe o evento `v2.0.5-beta-8`. Registrar que o teste real de UAC/restart exige executar a beta em Windows; não declarar isso como validado apenas pelo build.
