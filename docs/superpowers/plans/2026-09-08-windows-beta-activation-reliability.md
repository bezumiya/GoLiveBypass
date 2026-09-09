# Confiabilidade da ativação Windows nas betas — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Corrigir a regressão entre v2.0.5 e v2.0.6-beta-*, mantendo o WireSock por aplicativo como fluxo principal, preservando o runtime Proton e produzindo diagnóstico suficiente para explicar qualquer falha de ativação.

**Architecture:** A ativação Windows será transacional: preflight, perfil, execução por aplicativo, confirmação do processo pertencente à operação, abertura do Discord e diagnóstico assíncrono. O serviço global será uma compatibilidade excepcional, acionada somente por uma classificação explícita de “modo direto não suportado”; nunca será fallback genérico para DIRECT_EXITED, UAC, driver ou perfil. O logger conservará as linhas humanas atuais e adicionará eventos correlacionados com redaction e saída limitada de subprocessos.

**Tech Stack:** Electron 43, TypeScript, Vite, Vitest, PowerShell elevado, WireSock SDK 3.4.8.1, Go proton-confgen, GitHub Actions/electron-builder.

**Spec:** docs/superpowers/specs/2026-09-08-windows-beta-activation-reliability-design.md

## Global Constraints

- Manter WireSock por aplicativo (wiresock-client.exe run) como fluxo normal.
- O serviço wiresock-client-service/wiresock-pro-client-service é somente compatibilidade controlada.
- Um DIRECT_EXITED com código zero não autoriza fallback automático para serviço.
- Probes de IP, HTTP, geolocalização e handshake continuam diagnósticos; não bloqueiam uma ativação cujo processo foi aceito.
- O rollback não desinstala o driver WireSock; remove somente processo, serviço/filtro e network lock pertencentes à operação.
- Não registrar chave privada, token Proton, senha, sessão ou conteúdo integral do perfil.
- golive-gui/electron/bypass.ts é gerado; qualquer alteração do bypass legado deve ser feita em standalone/golivebypass.js e seguida de npm run sync-bypass.
- Betas continuam prereleases e não podem alterar latest da estável.
- Preservar todas as alterações não relacionadas já presentes no worktree; cada commit deve conter apenas os arquivos da tarefa correspondente.

---

### Task 1: Restaurar a base Proton e blindar o empacotamento

**Files:**
- Modify: .github/workflows/build-gui.yml:40-220
- Modify: golive-gui/scripts/build-proton.mjs:1-44
- Modify: golive-gui/package.json:50-61
- Test: golive-gui/tests/proton-packaging.test.ts
- Test: golive-gui/tests/runtime-installation-flow.test.ts

**Interfaces:**
- Consumes: golive-gui/electron/proton-runtime.ts, ensureProtonConfgen() e o manifesto gerado pelo build do helper.
- Produces: pacote com extra/proton-confgen/proton-confgen.exe, helper Linux, manifesto e assets de contingência autenticados.

- [ ] **Step 1: Escrever testes que detectem a regressão da beta 1**

Adicionar ao teste de empacotamento:

~~~ts
it("mantém o runtime autorreparável e o build determinístico", () => {
  const runtime = fs.readFileSync(path.join(root, "golive-gui/electron/proton-runtime.ts"), "utf8");
  const proton = fs.readFileSync(path.join(root, "golive-gui/electron/proton.ts"), "utf8");
  const script = fs.readFileSync(path.join(root, "golive-gui/scripts/build-proton.mjs"), "utf8");
  expect(runtime).toContain("ensureProtonConfgenOnce");
  expect(proton).toContain("ensureProtonConfgen");
  expect(script).toContain("proton-confgen-manifest.json");
  expect(script).toContain("-buildvcs=false");
  expect(script).toContain("-buildid=");
});

it("declara os recursos Proton que o runtime procura", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "golive-gui/package.json"), "utf8"));
  expect(packageJson.build.extraResources).toEqual(expect.arrayContaining([
    expect.objectContaining({ from: "../tools/proton-confgen/build", to: "extra/proton-confgen" }),
  ]));
});
~~~

Adicionar ao fluxo de instalação:

~~~ts
it("não considera o runtime pronto sem helper e manifesto compatíveis", async () => {
  const runtime = fs.readFileSync(path.join(root, "golive-gui/electron/proton-runtime.ts"), "utf8");
  expect(runtime).toContain("readProtonRuntimeManifest");
  expect(runtime).toContain("sha256File");
  expect(runtime).toContain("stageValidatedProtonConfgen");
});
~~~

- [ ] **Step 2: Executar os testes para confirmar a falha quando a proteção estiver ausente**

Run: npm test -- --run tests/proton-packaging.test.ts tests/runtime-installation-flow.test.ts em golive-gui/

Expected: o teste acusa imediatamente ausência do runtime, do manifesto ou das flags se a linha beta for baseada na árvore antiga.

- [ ] **Step 3: Restaurar a implementação mínima da base estável**

Garantir que proton-runtime.ts esteja presente e que checkProtonSession, getProtonPlan, loginProton, generateOptimalProtonConfig e generateProtonRoutePool obtenham o executável por await ensureProtonConfgen(installDir) antes de chamar runConfgen.

Garantir que build-proton.mjs compile os dois targets com:

~~~js
const buildArgs = ["build", "-buildvcs=false", "-trimpath", "-ldflags=-s -w -buildid=", "-o"];
~~~

O manifesto deve conter a versão da GUI, o asset de cada plataforma e seu SHA-256. No package.json, limitar o recurso extra ao helper e ao manifesto gerados, mantendo o destino extra/proton-confgen.

- [ ] **Step 4: Repor o job de assets e o gate de hash no workflow**

No job proton-runtime-assets, compilar o helper a partir da tag do workflow, conferir .version do manifesto contra a tag, gerar os assets cujo nome seja GoLiveBypass- concatenado com a versão e o sufixo proton-confgen de cada plataforma, e rejeitar hash divergente antes do upload.

O job beta-marcar deve depender de windows, linux, release-assets e proton-runtime-assets. O canal beta deve usar --config.publish.channel=beta --config.publish.releaseType=prerelease, com draft=false somente após todos os jobs.

- [ ] **Step 5: Executar os testes e o build sem publicação**

Run: npm test -- --run tests/proton-packaging.test.ts tests/runtime-installation-flow.test.ts em golive-gui/

Run: npm run compile em golive-gui/

Expected: PASS; tools/proton-confgen/build/proton-confgen, proton-confgen.exe e o manifesto existem e são não vazios.

- [ ] **Step 6: Commitar somente a proteção de empacotamento**

~~~bash
git add .github/workflows/build-gui.yml golive-gui/package.json golive-gui/scripts/build-proton.mjs golive-gui/tests/proton-packaging.test.ts golive-gui/tests/runtime-installation-flow.test.ts golive-gui/electron/proton-runtime.ts golive-gui/electron/proton.ts
git commit -m "fix(release): preservar runtime Proton nas betas"
~~~

### Task 2: Corrigir seleção de asset do updater

**Files:**
- Modify: golive-gui/electron/updater-channel.ts:1-95
- Modify: golive-gui/electron/updater.ts:110-170
- Test: golive-gui/tests/updater-channel.test.ts

**Interfaces:**
- Consumes: lista de assets da API de releases do GitHub.
- Produces: escolherAssetWindows(tag, assets) que retorna somente o portable exato ou null.

- [ ] **Step 1: Adicionar o teste de seleção exata**

Adicionar ao teste:

~~~ts
it("não escolhe proton-confgen como executável da GUI", () => {
  const assets = [
    { name: "GoLiveBypass-2.0.6-beta-4-proton-confgen-win-x64.exe", browser_download_url: "https://github.com/x/y/releases/download/v/GoLiveBypass-2.0.6-beta-4-proton-confgen-win-x64.exe" },
    { name: "GoLiveBypass-2.0.6-beta-4.exe", browser_download_url: "https://github.com/x/y/releases/download/v/GoLiveBypass-2.0.6-beta-4.exe" },
  ];
  expect(escolherAssetWindows("v2.0.6-beta-4", assets)?.name).toBe("GoLiveBypass-2.0.6-beta-4.exe");
});

it("recusa nome ou URL que só compartilha o prefixo", () => {
  const assets = [
    { name: "GoLiveBypass-2.0.6-beta-4-helper.exe", browser_download_url: "https://github.com/x/y/releases/download/v/GoLiveBypass-2.0.6-beta-4-helper.exe" },
  ];
  expect(escolherAssetWindows("v2.0.6-beta-4", assets)).toBeNull();
});
~~~

- [ ] **Step 2: Executar o teste para confirmar a falha**

Run: npm test -- --run tests/updater-channel.test.ts em golive-gui/

Expected: FAIL enquanto o updater aceitar qualquer .exe iniciado por GoLiveBypass-.

- [ ] **Step 3: Implementar a validação do nome e da URL**

Adicionar:

~~~ts
export interface AssetWindows {
  name: string;
  browser_download_url?: string;
  digest?: string;
}

export function escolherAssetWindows(tag: string, assets: AssetWindows[]): AssetWindows | null {
  const semV = tag.replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(semV)) return null;
  const esperado = "GoLiveBypass-" + semV + ".exe";
  return assets.find((asset) => {
    if (!asset || asset.name !== esperado) return false;
    if (asset.browser_download_url === undefined) return true;
    try {
      const url = new URL(asset.browser_download_url);
      const filename = decodeURIComponent(url.pathname.split("/").pop() ?? "");
      return url.protocol === "https:" && filename === esperado;
    } catch {
      return false;
    }
  }) ?? null;
}
~~~

Trocar o find por prefixo em updater.ts por escolherAssetWindows(String(item.tag_name), assets).

- [ ] **Step 4: Executar a suíte do updater**

Run: npm test -- --run tests/updater-channel.test.ts tests/updater-replace.test.ts tests/updater-settings.test.ts em golive-gui/

Expected: PASS; nenhum teste permite baixar asset auxiliar como portable.

- [ ] **Step 5: Commitar a seleção segura**

~~~bash
git add golive-gui/electron/updater-channel.ts golive-gui/electron/updater.ts golive-gui/tests/updater-channel.test.ts
git commit -m "fix(update): selecionar somente portable da release"
~~~

### Task 3: Introduzir eventos de log correlacionados e redacted

**Files:**
- Modify: golive-gui/electron/logger.ts:13-200
- Test: golive-gui/tests/logger.test.ts

**Interfaces:**
- Consumes: linhas atuais do logger e eventos de ativação.
- Produces: LogContext, createOperationId(), redactLogValue(), clipLogText() e logEvent().

- [ ] **Step 1: Escrever testes de correlação, redaction e limite**

Adicionar:

~~~ts
it("gera ids distintos e registra contexto operacional", () => {
  const operationId = createOperationId("activation");
  const attemptId = createOperationId("direct");
  logEvent("info", "wiresock", "process.start", {
    app_session_id: "session-test",
    operation_id: operationId,
    attempt_id: attemptId,
    phase: "process",
    pid: 123,
  });
  const recent = getRecent();
  expect(operationId).toMatch(/^activation-/);
  expect(attemptId).toMatch(/^direct-/);
  expect(recent).toContain("operation_id=" + operationId);
  expect(recent).toContain("phase=process");
});

it("remove segredos e limita saídas de helper", () => {
  const value = redactLogValue("password=s3cr3t token=abc PrivateKey=xyz");
  expect(value).toContain("[redacted]");
  expect(value).not.toContain("s3cr3t");
  expect(clipLogText("123456789", 5)).toBe("12345…");
});
~~~

- [ ] **Step 2: Executar o teste para confirmar a falha**

Run: npm test -- --run tests/logger.test.ts em golive-gui/

Expected: FAIL por ausência das funções novas.

- [ ] **Step 3: Implementar as primitivas sem quebrar o formato humano**

Adicionar:

~~~ts
export type LogContext = Record<string, string | number | boolean | null | undefined>;

export function createOperationId(prefix: string): string {
  return prefix + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

export function clipLogText(value: unknown, max = 2000): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? text.slice(0, max) + "…" : text;
}

export function redactLogValue(value: unknown): string {
  return clipLogText(value, 4000)
    .replace(/((?:password|senha|token|secret|privatekey|private_key|session)[=:]\s*)\S+/gi, "$1[redacted]");
}

export function logEvent(
  nivel: Nivel,
  cat: string,
  event: string,
  context: LogContext,
  data?: LogContext,
): void {
  const merged = Object.fromEntries(Object.entries({ ...context, ...data })
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => [key, redactLogValue(value)]));
  escrever(nivel, cat, event, merged);
}
~~~

Não alterar patchConsole() nem a rotação atual. Os eventos novos devem continuar grep-friendly e nunca lançar exceção se o arquivo de log não puder ser escrito.

- [ ] **Step 4: Executar a suíte do logger**

Run: npm test -- --run tests/logger.test.ts em golive-gui/

Expected: PASS; o teto do ring buffer e a rotação existentes continuam verdes.

- [ ] **Step 5: Commitar a observabilidade base**

~~~bash
git add golive-gui/electron/logger.ts golive-gui/tests/logger.test.ts
git commit -m "feat(logs): correlacionar eventos de ativacao Windows"
~~~

### Task 4: Tornar os scripts PowerShell observáveis e compatíveis com os dois serviços

**Files:**
- Modify: golive-gui/electron/wiresock-service.ts:1-150
- Test: golive-gui/tests/wiresock.test.ts
- Test: golive-gui/tests/wiresock-installation.test.ts

**Interfaces:**
- Consumes: caminho do EXE WireSock, caminho do perfil e caminho de resultado.
- Produces: scripts que devolvem marcadores estáveis, capturam stdout/stderr e distinguem modo direto não suportado de falha real.

- [ ] **Step 1: Escrever testes dos scripts gerados**

Adicionar:

~~~ts
it("o script de serviço reconhece ambos os nomes e retorna códigos SCM", () => {
  const script = wireSockServiceScript("C:\\Program Files\\WireSock\\wiresock-client.exe", "C:\\Users\\teste\\wireguard.conf", "C:\\Temp\\result.txt");
  expect(script).toContain("wiresock-client-service");
  expect(script).toContain("wiresock-pro-client-service");
  expect(script).toContain("Win32ExitCode");
  expect(script).toContain("ServiceSpecificExitCode");
  expect(script).toContain("SERVICE_RUNNING");
});

it("o script direto captura stdout/stderr e não confunde saída zero com processo vivo", () => {
  const script = wireSockDirectScript("C:\\Program Files\\WireSock\\wiresock-client.exe", "C:\\Users\\teste\\wireguard.conf", "C:\\Temp\\direct.txt");
  expect(script).toContain("RedirectStandardOutput");
  expect(script).toContain("RedirectStandardError");
  expect(script).toContain("DIRECT_EXITED");
  expect(script).toContain("DIRECT_RUNNING");
});
~~~

- [ ] **Step 2: Executar os testes para confirmar a falha**

Run: npm test -- --run tests/wiresock.test.ts tests/wiresock-installation.test.ts em golive-gui/

Expected: FAIL enquanto o script usar apenas wiresock-client-service e não transportar stdout/stderr do processo direto.

- [ ] **Step 3: Implementar descoberta de serviço e captura de saída**

No PowerShell, iterar:

~~~powershell
$serviceNames = @('wiresock-client-service', 'wiresock-pro-client-service')
$serviceInfo = $serviceNames |
  ForEach-Object { Get-CimInstance Win32_Service -Filter "Name='$_'" -ErrorAction SilentlyContinue } |
  Select-Object -First 1
~~~

Usar o nome encontrado em Stop-Service, Start-Service, Get-Service e Get-CimInstance. Se nenhum existir, instalar uma única vez e consultar novamente os dois nomes. Escrever no resultado o estado, Win32ExitCode, ServiceSpecificExitCode, PathName e o nome efetivo.

No modo direto, criar arquivos temporários separados para stdout e stderr, passar -RedirectStandardOutput e -RedirectStandardError a Start-Process, aguardar o limite definido, fazer Refresh() e escrever:

~~~text
DIRECT_RUNNING: pid=<pid>
~~~

somente se o processo ainda estiver vivo. Caso contrário, escrever:

~~~text
DIRECT_EXITED: codigo=<exit_code> stdout=<captured> stderr=<captured>
~~~

com cada campo limitado por clipLogText() no processo Electron antes de chegar ao log.

- [ ] **Step 4: Adicionar a classificação explícita de fallback**

Implementar em wiresock.ts:

~~~ts
export type WireSockDirectResult =
  | { kind: "running"; pid: number; detail: string }
  | { kind: "unsupported"; code: string; detail: string }
  | { kind: "failed"; code: string; detail: string };

export function mayUseServiceCompatibility(result: WireSockDirectResult): boolean {
  return result.kind === "unsupported";
}
~~~

Classificar como unsupported somente marcadores explícitos como UNKNOWN_COMMAND, RUN_NOT_SUPPORTED ou versão do SDK sem modo run. DIRECT_EXITED, código zero, UAC, perfil, driver e timeout devem permanecer failed.

- [ ] **Step 5: Executar os testes dos scripts**

Run: npm test -- --run tests/wiresock.test.ts tests/wiresock-installation.test.ts em golive-gui/

Expected: PASS; ambos os nomes de serviço, códigos e saída capturada aparecem nos scripts sem incluir segredo.

- [ ] **Step 6: Commitar o transporte PowerShell**

~~~bash
git add golive-gui/electron/wiresock-service.ts golive-gui/electron/wiresock.ts golive-gui/tests/wiresock.test.ts golive-gui/tests/wiresock-installation.test.ts
git commit -m "fix(windows): diagnosticar ativacao WireSock sem fallback cego"
~~~

### Task 5: Aplicar a máquina transacional de ativação e rollback

**Files:**
- Modify: golive-gui/electron/wiresock.ts:576-778
- Modify: golive-gui/electron/main.ts:1600-1672, 1794-1807, 2398-2461
- Test: golive-gui/tests/wiresock.test.ts
- Test: golive-gui/tests/main-activation-state.test.ts

**Interfaces:**
- Consumes: WireSockDirectResult, logEvent(), recoverWireSockNetwork() e as instalações Discord detectadas.
- Produces: ativação com estados preparing, direct-starting, service-compatibility, active, diagnostic-unverified, failed e recovery-required.

- [ ] **Step 1: Escrever os testes de decisão e rollback**

Adicionar:

~~~ts
it("não tenta serviço depois de DIRECT_EXITED", () => {
  expect(mayUseServiceCompatibility({ kind: "failed", code: "DIRECT_EXITED", detail: "codigo=0" })).toBe(false);
});

it("só aceita serviço para incompatibilidade explícita", () => {
  expect(mayUseServiceCompatibility({ kind: "unsupported", code: "RUN_NOT_SUPPORTED", detail: "sdk antigo" })).toBe(true);
  expect(mayUseServiceCompatibility({ kind: "failed", code: "WIRESOCK_PROFILE", detail: "perfil inválido" })).toBe(false);
});
~~~

No teste de estado, modelar uma tentativa com processo que encerra e verificar que o estado final é failed, o Discord não é aberto e o rollback é chamado uma vez; repetir o rollback deve continuar retornando o mesmo resultado sem lançar uma segunda limpeza destrutiva.

- [ ] **Step 2: Executar os testes para confirmar a falha**

Run: npm test -- --run tests/wiresock.test.ts tests/main-activation-state.test.ts em golive-gui/

Expected: FAIL até o fluxo de ativação deixar de usar service como fallback genérico e passar a expor os estados.

- [ ] **Step 3: Separar tentativa direta, compatibilidade e confirmação**

Em applyWireSockProfile():

1. criar operation_id e attempt_id e registrar preflight.start;
2. escrever o perfil final e registrar fingerprint SHA-256, tamanho e quantidade de AllowedApps, nunca o conteúdo;
3. executar o modo direto e registrar process.start, process.stdout, process.stderr, process.exit e duração;
4. se DIRECT_RUNNING vier com PID vivo, guardar esse PID como dono da operação;
5. se o resultado for failed, limpar a tentativa e propagar o código classificado;
6. se o resultado for unsupported, entrar em service-compatibility e executar o script de serviço compatível;
7. aceitar serviço somente com nome conhecido, RUNNING, caminho efetivo esperado e processo correspondente vivo;
8. registrar activation.accepted antes de devolver sucesso.

O serviço não deve ser instalado, reconfigurado ou iniciado para DIRECT_EXITED: codigo=0, falha de UAC, perfil, driver ou timeout.

- [ ] **Step 4: Corrigir estado no processo principal**

Trocar os testes genéricos isWireSockActive() usados para decidir sucesso por um estado da operação contendo o PID direto ou o nome/PID do serviço aceito. Manter waitForWindowsWgReady() assíncrono e log-only:

~~~ts
void waitForWindowsWgReady().then((readiness) => {
  logEvent("info", "wiresock", "readiness.complete", context, readiness);
}).catch((error) => {
  logEvent("warn", "wiresock", "readiness.error", context, { error: String(error) });
});
~~~

O Discord só deve ser iniciado depois de startWireSockService() retornar uma operação aceita. Uma falha não deve deixar windowsRouteState = "active".

- [ ] **Step 5: Tornar o rollback idempotente e limitado**

No caminho de erro, fechar o Discord se ele foi aberto, parar somente o PID/serviço registrado pela operação, resetar network lock, remover o perfil temporário e verificar a rede normal. Não remover o driver ndiswg/NDISRD. Se houver residual, registrar recovery-required e manter a orientação existente de Restaurar internet.

- [ ] **Step 6: Executar os testes da máquina**

Run: npm test -- --run tests/wiresock.test.ts tests/main-activation-state.test.ts em golive-gui/

Expected: PASS; falha direta não instala serviço, incompatibilidade explícita usa serviço, processo encerrado nunca vira ativo e rollback repetido é seguro.

- [ ] **Step 7: Commitar o ciclo transacional**

~~~bash
git add golive-gui/electron/wiresock.ts golive-gui/electron/main.ts golive-gui/tests/wiresock.test.ts golive-gui/tests/main-activation-state.test.ts
git commit -m "fix(windows): tornar ativacao WireSock transacional"
~~~

### Task 6: Instrumentar Proton, preflight e diagnóstico de campo

**Files:**
- Modify: golive-gui/electron/proton.ts:78-180, 351-700
- Modify: golive-gui/electron/wiresock-preflight.ts:1-180
- Modify: golive-gui/electron/main.ts:2398-2461
- Test: golive-gui/tests/proton.test.ts
- Test: golive-gui/tests/proton-runtime.test.ts
- Test: golive-gui/tests/wiresock-preflight.test.ts

**Interfaces:**
- Consumes: helper Proton, perfil WireGuard, preflight WireSock e fontes opcionais de handshake/ProTUN/CLI.
- Produces: eventos detalhados de descoberta, sessão, configuração e readiness sem bloquear ativação.

- [ ] **Step 1: Escrever testes dos eventos técnicos sem segredo**

Adicionar verificações de fonte:

~~~ts
it("registra o helper Proton sem expor sessão", async () => {
  const source = fs.readFileSync(path.resolve(process.cwd(), "electron/proton.ts"), "utf8");
  expect(source).toContain("ensureProtonConfgen");
  expect(source).toContain("logEvent");
  expect(source).not.toContain("logger.info('proton', 'sessão");
});
~~~

Adicionar ao preflight testes para versão, par EXE/DLL, arquitetura e os dois nomes de serviço. Adicionar ao readiness um caso em que CLI, wg.exe e ProTUN não existem e o resultado é unverified, não exceção.

- [ ] **Step 2: Executar os testes para localizar os pontos sem contexto**

Run: npm test -- --run tests/proton.test.ts tests/proton-runtime.test.ts tests/wiresock-preflight.test.ts em golive-gui/

Expected: os testes existentes passam; novos testes falham apenas nos pontos que ainda não registram contexto estruturado.

- [ ] **Step 3: Registrar cada fase Proton**

Usar o mesmo operation_id recebido pelo fluxo quando disponível e registrar:

- helper encontrado: basename, plataforma, arquitetura, tamanho e SHA-256;
- runConfgen(): argumentos com senha/token substituídos, duração, código, tamanho de stdout/stderr e presença de JSON;
- geração de perfil: país/filtro, fingerprint do staging, tamanho e promoção atômica;
- falhas classificadas: MISSING_EXECUTABLE, NETWORK_ERROR, TIMEOUT, SESSION_PERSISTENCE e CONFIGURATION_ERROR.

Não registrar sessionFile com conteúdo, senha, token CAPTCHA ou chave privada.

- [ ] **Step 4: Registrar o preflight WireSock e a readiness**

Registrar versão do EXE/DLL, origem do candidato, driver observado, estado dos serviços, adaptador ProTUN, fonte da readiness, idade do handshake e contadores RX/TX. Aplicar clipLogText() às mensagens externas.

Quando uma fonte estiver indisponível, registrar diagnostic.source_unavailable com source e motivo. O retorno final deve continuar:

~~~ts
{ verified: false, state: "unverified", source, detail }
~~~

quando o processo aceito estiver ativo, sem fechar o Discord.

- [ ] **Step 5: Executar os testes de diagnóstico**

Run: npm test -- --run tests/proton.test.ts tests/proton-runtime.test.ts tests/wiresock-preflight.test.ts em golive-gui/

Expected: PASS; logs têm contexto e probes ausentes não viram erro de ativação.

- [ ] **Step 6: Commitar a instrumentação**

~~~bash
git add golive-gui/electron/proton.ts golive-gui/electron/wiresock-preflight.ts golive-gui/electron/main.ts golive-gui/tests/proton.test.ts golive-gui/tests/proton-runtime.test.ts golive-gui/tests/wiresock-preflight.test.ts
git commit -m "feat(logs): detalhar preflight Proton e readiness WireSock"
~~~

### Task 7: Atualizar mensagens, changelog e documentação operacional

**Files:**
- Modify: CHANGELOG.md:1-40
- Modify: docs/superpowers/specs/2026-09-08-windows-beta-activation-reliability-design.md
- Create: docs/testing/2026-09-08-windows-beta-activation-validation.md

**Interfaces:**
- Consumes: códigos estáveis da máquina de ativação e nomes das fases do logger.
- Produces: documentação reproduzível para issues e release notes sem prometer geolocalização.

- [ ] **Step 1: Escrever os critérios de validação no relatório**

Criar o relatório com uma tabela contendo cenário, versão, comando/ação, resultado esperado, resultado observado e evidência:

~~~markdown
| Cenário | Esperado | Evidência |
| --- | --- | --- |
| v2.0.5 estável | ativa pelo caminho conhecido | log/versão |
| beta sem modo run | compatibilidade de serviço classificada | serviço e códigos |
| beta com DIRECT_EXITED: codigo=0 | falha limpa, sem iniciar serviço | attempt log |
| modo direto aceito | Discord abre com AllowedApps | PID e estado |
| helper ausente | runtime Proton repara por hash | manifesto e SHA-256 |
| updater beta | baixa somente portable exato | nome/URL/hash |
~~~

- [ ] **Step 2: Atualizar o changelog**

Adicionar uma entrada Unreleased explicando que:

- o modo por aplicativo permanece principal por causa do erro de serviço;
- o serviço alternativo só é usado para incompatibilidade explícita;
- helpers Proton são reparados/validados automaticamente;
- logs têm ids de operação e redaction;
- readiness sem handshake é diagnóstico, não garantia de país ou qualidade.

- [ ] **Step 3: Verificar documentação**

Run: git diff --check

Expected: o diff não contém whitespace inválido nem marcadores de rascunho.

- [ ] **Step 4: Commitar documentação**

~~~bash
git add CHANGELOG.md docs/superpowers/specs/2026-09-08-windows-beta-activation-reliability-design.md docs/testing/2026-09-08-windows-beta-activation-validation.md
git commit -m "docs: registrar diagnostico da ativacao Windows beta"
~~~

### Task 8: Gate final de compilação, artefatos e teste Windows

**Files:**
- Test: golive-gui/tests/ (suítes alteradas nas tarefas anteriores)
- Inspect: golive-gui/dist-app/
- Inspect: assets da release gerados pelo workflow

**Interfaces:**
- Consumes: commits das tarefas 1–7.
- Produces: evidência de que a beta é instalável, íntegra, atualizável e não reproduz o erro genérico sem diagnóstico.

- [ ] **Step 1: Executar a suíte completa da GUI**

Run: npm test em golive-gui/

Expected: todos os testes passam, inclusive updater, logger, Proton e WireSock.

- [ ] **Step 2: Compilar a GUI**

Run: npm run compile em golive-gui/

Expected: sync-bypass, helper Proton, TypeScript e Vite terminam com exit 0.

- [ ] **Step 3: Construir Windows e Linux sem publicar**

Run: npm run build:win em golive-gui/

Run: npm run build:linux em golive-gui/

Expected: ambos produzem os artefatos em dist-app/ sem tocar no GitHub.

- [ ] **Step 4: Inspecionar recursos do pacote**

Conferir nos artefatos:

~~~text
extra/proton-confgen/proton-confgen.exe
extra/proton-confgen/proton-confgen
extra/proton-confgen/proton-confgen-manifest.json
~~~

Calcular SHA-256 dos helpers e comparar com o manifesto. Conferir que o portable se chama exatamente GoLiveBypass- seguido da versão da release e .exe, e que nenhum helper é usado como asset principal.

- [ ] **Step 5: Executar testes Go quando o helper for alterado**

Run: go test ./... em tools/proton-confgen/

Expected: PASS.

- [ ] **Step 6: Executar a matriz Windows real quando a VM estiver disponível**

Validar, sem alterar a máquina inteira:

1. instalação oficial já existente com modo direto;
2. instalação com wiresock-client-service;
3. instalação com wiresock-pro-client-service;
4. ausência do serviço, permitindo somente a compatibilidade explícita;
5. DIRECT_EXITED: codigo=0;
6. UAC cancelado;
7. perfil inválido;
8. ativar, desativar, reiniciar e restaurar internet;
9. iniciar todos os Discord detectados dentro de AllowedApps;
10. verificar que a GUI não abre popup nativo novo e que o log contém operation_id, attempt_id, código, PID e cleanup.

Expected: o modo direto aceito abre o Discord; falhas limpam a rota; nenhum serviço residual ou processo encerrado é aceito como túnel da operação.

- [ ] **Step 7: Registrar evidências e decidir publicação**

Preencher docs/testing/2026-09-08-windows-beta-activation-validation.md com hashes, versão, logs sanitizados, cenário e resultado. Só depois do teste Windows, da inspeção dos assets e de todos os gates verdes a publicação beta poderá ser autorizada.

## Handoff de execução

O plano está salvo em docs/superpowers/plans/2026-09-08-windows-beta-activation-reliability.md. A especificação relacionada está em docs/superpowers/specs/2026-09-08-windows-beta-activation-reliability-design.md e foi versionada no commit 9260abf.
