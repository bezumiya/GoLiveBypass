# Seleção manual de rota Proton após falha de medição Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Adicionar um fallback manual que preserve os candidatos medidos em tempo real e permita escolher uma rota por ping quando a seleção automática falhar, sem alterar o caminho automático bem-sucedido.

**Architecture:** O fluxo automático continuará chamando optimizeProtonRoute sem servidor específico e manterá seus filtros, limites e ranking. Um módulo puro agregará os eventos existentes no renderer; após uma falha, um IPC separado aceitará apenas o nome exato de um candidato, o helper Go fará revalidação de filtros/ping/preflight e o processo principal aplicará o perfil de forma transacional pelo ciclo WireSock já existente.

**Tech Stack:** Electron, TypeScript, Vitest, Go, WireGuard userspace, WireSock por aplicativo, HTML/CSS existente da GUI.

**Spec:** docs/superpowers/specs/2026-09-09-proton-manual-route-selection-design.md

## Global Constraints

- A seleção automática atual, incluindo argumentos, filtros, ranking, limites, timeouts e failover, não pode mudar quando nenhum servidor manual for informado.
- A lista manual conterá somente candidatos que participaram da medição corrente; servidores não sondados pela API não aparecerão como opções.
- Ping será usado para ordenar e velocidade será exibida somente quando medida; nenhum valor será inventado.
- A rota recomendada por menor ping será rotulada como Menor ping disponível, não como rota mais rápida.
- A escolha manual aceitará somente servidor online, elegível para conta/plano/país, com peer WireGuard válido, ping confirmado e preflight rápido aprovado.
- O renderer enviará somente nome exato do servidor e identificador da medição; endpoint, chave, token, sessão e conteúdo do perfil nunca atravessarão o IPC.
- O perfil será staged e promovido atomicamente; a rota anterior será restaurada quando a aplicação manual falhar.
- A ativação WireSock, o isolamento por aplicativo, a restauração, ACTIVE e os probes log-only não serão redefinidos por esta feature.
- Plugin Vencord/Equicord, standalone, proxy, PAC e Tor ficam fora do escopo.
- Cada tarefa termina com teste próprio e commit apenas dos arquivos de sua responsabilidade.

---

## Mapa de arquivos e responsabilidades

- golive-gui/src/proton-manual-selection.ts: estado puro dos candidatos, agregação dos eventos, ordenação e recomendação.
- golive-gui/tests/proton-manual-selection.test.ts: casos determinísticos do módulo puro.
- tools/proton-confgen/internal/config/types.go: opção interna ManualProbe.
- tools/proton-confgen/internal/config/flags.go: flag -manual-probe mantendo -server existente.
- tools/proton-confgen/internal/vpn/servers.go: seleção exata que reaplica todos os filtros antes do ping.
- tools/proton-confgen/cmd/protonvpn-wg/main.go: caminho manual com ping, preflight rápido, geração e JSON.
- tools/proton-confgen/internal/vpn/manual_selection_test.go: elegibilidade de servidor específico.
- tools/proton-confgen/internal/speedtest/manual_probe_test.go: contrato de preflight manual.
- golive-gui/electron/proton.ts: wrapper que gera perfil manual staged e chama -server/-manual-probe; o wrapper automático não muda.
- golive-gui/electron/preload.ts: exposição mínima do novo IPC.
- golive-gui/electron/main.ts: sessão efêmera da medição, handler manual, backup/promoção e aplicação serializada.
- golive-gui/tests/proton-speed-selection.test.ts: regressão do wrapper automático e argumentos manuais.
- golive-gui/tests/proton-optimization.test.ts: regressão do handler automático e aplicação manual.
- golive-gui/tests/ativacao-guard.test.ts: guarda de fila, separação dos IPCs e preservação do caminho automático.
- golive-gui/index.html: área de recomendação e ação manual no diálogo existente.
- golive-gui/src/main.ts: renderização, botões, retenção da lista após erro e chamada do novo IPC.
- golive-gui/src/style.css: layout dos indicadores e botões por candidato.
- golive-gui/tests/proton-ui.test.ts: contrato de markup e fluxo manual da GUI.
- CHANGELOG.md: entrada em [Unreleased] descrevendo o fallback manual sem prometer prova geográfica.

## Dependências entre tarefas

As tarefas 1 e 2 podem ser desenvolvidas em paralelo. A tarefa 3 depende do
contrato -manual-probe da tarefa 2. A tarefa 4 usa o módulo puro da tarefa 1 e
o IPC da tarefa 3. A tarefa 5 executa integração, documentação e validação
funcional.

### Task 1: Modelo puro dos candidatos manuais

**Files:**

- Create: golive-gui/src/proton-manual-selection.ts
- Test: golive-gui/tests/proton-manual-selection.test.ts

**Interfaces:**

- Consumes: eventos sanitizados com phase, server, pingMs, downloadMbps, uploadMbps e status.
- Produces: ManualRouteCandidate, reduceManualRouteEvent, sortManualRouteCandidates, isManualRouteSelectable e recommendManualRoute para o renderer.

- [ ] **Step 1: Escrever os testes de agregação e ordenação**

Criar testes Vitest para a mesma rota receber eventos de ping, preflight e
velocidade, preservando métricas anteriores quando o evento posterior não as
contém:

~~~ts
it('agrega ping, preflight e velocidade na mesma rota', () => {
  let state = new Map<string, ManualRouteCandidate>();
  state = reduceManualRouteEvent(state, {
    phase: 'ping', server: 'US#8', pingMs: 188, status: 'success',
  });
  state = reduceManualRouteEvent(state, {
    phase: 'preparing', server: 'US#8', status: 'success',
  });
  state = reduceManualRouteEvent(state, {
    phase: 'testing', server: 'US#8', pingMs: 188,
    downloadMbps: 42.5, uploadMbps: 8.2, status: 'success',
  });

  expect(state.get('US#8')).toMatchObject({
    server: 'US#8',
    pingMs: 188,
    pingStatus: 'success',
    preflightStatus: 'success',
    speedStatus: 'success',
    downloadMbps: 42.5,
    uploadMbps: 8.2,
  });
});

it('ordena ping válido crescente e deixa desconhecidos no fim', () => {
  const state = new Map([
    ['US#8', candidate('US#8', 188)],
    ['US#5', candidate('US#5', 197)],
    ['US#72', candidate('US#72', undefined, 'failed')],
  ]);

  expect(sortManualRouteCandidates(state.values()).map((route) => route.server))
    .toEqual(['US#8', 'US#5', 'US#72']);
});
~~~

Adicionar casos para ping ausente, ping 999, ping falho, preflight falho,
velocidade parcial e eventos sem server. Confirmar que preflight falho
desabilita a linha, enquanto ping válido sem preflight concluído continua
selecionável para a validação manual posterior.

- [ ] **Step 2: Executar os testes para confirmar a falha inicial**

Run: cd /home/pdl/Projetos/livedc/golive-gui && npm test -- tests/proton-manual-selection.test.ts

Expected: FAIL porque o módulo e as funções ainda não existem.

- [ ] **Step 3: Implementar o agregado mínimo e a recomendação**

Definir os contratos sem importar tipos do processo principal:

~~~ts
export type ManualCandidateStatus =
  | 'not-tested'
  | 'pending'
  | 'success'
  | 'failed';

export interface ManualRouteCandidate {
  server: string;
  pingMs?: number;
  downloadMbps?: number;
  uploadMbps?: number;
  pingStatus: ManualCandidateStatus;
  preflightStatus: ManualCandidateStatus;
  speedStatus: ManualCandidateStatus;
  failureReason?: string;
}

export interface ManualRouteProgressEvent {
  phase: 'ping' | 'preparing' | 'testing' | 'finalizing' | 'completed' | 'failed' | 'cancelled';
  server?: string;
  pingMs?: number;
  downloadMbps?: number;
  uploadMbps?: number;
  status?: 'testing' | 'success' | 'failed';
}

export function reduceManualRouteEvent(
  current: ReadonlyMap<string, ManualRouteCandidate>,
  event: ManualRouteProgressEvent,
): Map<string, ManualRouteCandidate>;

export function sortManualRouteCandidates(
  candidates: Iterable<ManualRouteCandidate>,
): ManualRouteCandidate[];

export function isManualRouteSelectable(
  candidate: ManualRouteCandidate,
): boolean;

export function recommendManualRoute(
  candidates: Iterable<ManualRouteCandidate>,
): string | undefined;
~~~

A redução deve usar o nome exato como chave, atualizar somente a fase do evento
e ignorar números não positivos. A ordenação deve colocar ping válido primeiro,
depois ping ausente, usando o nome como desempate estável.

Para a recomendação, candidatos com download/upload positivos usam
2 * download * upload / (download + upload); empate usa menor ping e depois
nome. Sem velocidade completa, usa-se o menor ping válido. Nenhuma rota com
preflight explicitamente reprovado pode ser recomendada.

- [ ] **Step 4: Rodar os testes e conferir isolamento do módulo**

Run: cd /home/pdl/Projetos/livedc/golive-gui && npm test -- tests/proton-manual-selection.test.ts

Expected: PASS, sem acesso a Electron, filesystem, rede ou estado global.

- [ ] **Step 5: Commitar a unidade pura**

~~~bash
git add golive-gui/src/proton-manual-selection.ts golive-gui/tests/proton-manual-selection.test.ts
git commit -m "feat(gui): agregar candidatos para seleção manual Proton"
~~~

### Task 2: Modo manual no helper Go

**Files:**

- Modify: tools/proton-confgen/internal/config/types.go
- Modify: tools/proton-confgen/internal/config/flags.go
- Modify: tools/proton-confgen/internal/vpn/servers.go
- Modify: tools/proton-confgen/cmd/protonvpn-wg/main.go
- Create: tools/proton-confgen/internal/vpn/manual_selection_test.go
- Create: tools/proton-confgen/internal/speedtest/manual_probe_test.go

**Interfaces:**

- Consumes: cfg.ServerName, filtros existentes e speedtest.ProbeCandidate.
- Produces: flag -manual-probe e ServerSelector.SelectManualWithPing, sem mudar o branch automático sem ServerName.

- [ ] **Step 1: Escrever testes para elegibilidade exata e preflight**

Criar fixtures com tier, país, estado online/offline e peer WireGuard válido.
Testar que o servidor específico é rejeitado quando estiver fora do plano,
fora do país selecionado, em BR, offline, sem IP ou sem chave válida:

~~~go
func TestSelectManualWithPingReappliesFilters(t *testing.T) {
    servers := []api.LogicalServer{
        fixtureServer("US#free", api.TierFree, constants.StatusOnline, true),
        fixtureServer("US#premium", api.TierPlus, constants.StatusOnline, true),
        fixtureServer("BR#free", api.TierFree, constants.StatusOnline, true),
        fixtureServer("US#bad-peer", api.TierFree, constants.StatusOnline, false),
    }

    selector := NewServerSelector(&config.Config{
        ServerName: "US#premium",
        FreeOnly: true,
        ExcludedCountries: []string{"BR"},
        AutoPing: true,
    })

    _, _, err := selector.SelectManualWithPing(servers)
    if err == nil {
        t.Fatal("expected filtered server to be rejected")
    }
}
~~~

Adicionar um teste de sucesso com seam de ping controlada, um teste para ping
999 e um teste de peer sem chave. No pacote speedtest, testar que o preflight
bem-sucedido retorna nil, o erro do túnel retorna erro e o contexto cancela o
probe dentro do limite.

- [ ] **Step 2: Executar os testes para observar a falha do contrato**

Run: cd /home/pdl/Projetos/livedc/tools/proton-confgen && go test ./internal/vpn ./internal/speedtest

Expected: FAIL por ausência de SelectManualWithPing, ManualProbe e dos testes
novos.

- [ ] **Step 3: Adicionar configuração e flag sem alterar o automático**

Adicionar ManualProbe bool em config.Config e registrar:

~~~go
flag.BoolVar(
    &cfg.ManualProbe,
    "manual-probe",
    false,
    "Validate and generate one explicitly selected server without speed test",
)
~~~

Validar que -manual-probe exige -server e não aceita -speed-test. Quando a flag
estiver ausente, o parser deve manter todas as combinações existentes.

- [ ] **Step 4: Implementar seleção exata com reaplicação dos filtros**

Adicionar em internal/vpn/servers.go:

~~~go
func (s *ServerSelector) SelectManualWithPing(
    servers []api.LogicalServer,
) (*api.LogicalServer, int, error) {
    if strings.TrimSpace(s.config.ServerName) == "" {
        return nil, 0, fmt.Errorf("manual server selection requires -server")
    }

    for i := range servers {
        candidate := &servers[i]
        if candidate.Name != s.config.ServerName || !isEligible(s.config, candidate) {
            continue
        }

        peer := GetBestWireGuardPhysicalServer(candidate)
        if peer == nil {
            return nil, 0, fmt.Errorf("server %q has no usable WireGuard peer", candidate.Name)
        }

        ping := ProbePing(peer.EntryIP, 1200*time.Millisecond)
        if ping <= 0 || ping >= 999 {
            return nil, ping, fmt.Errorf("server %q did not respond to ping", candidate.Name)
        }

        return candidate, ping, nil
    }

    return nil, 0, fmt.Errorf(
        "server %q is offline or outside current filters",
        s.config.ServerName,
    )
}
~~~

A implementação final deve guardar o peer em variável local e não chamar
GetBestWireGuardPhysicalServer duas vezes. O método deve ser usado somente no
branch manual; o caminho automático sem ServerName continua usando sua seleção
atual.

- [ ] **Step 5: Adicionar o branch manual antes do speed test**

Em generateConfig, manter o branch atual de cfg.SpeedTest intacto e inserir
somente o branch cfg.ManualProbe. Depois de obter chave/certificado, selecionar
o servidor exato, emitir evento ping, executar ProbeCandidate com contexto de
15 segundos, emitir evento preparing e só então gerar o perfil:

~~~go
if cfg.ManualProbe {
    server, pingMs, err = selector.SelectManualWithPing(servers)
    if err != nil {
        return err
    }

    if progress != nil {
        progress(speedtest.ProgressEvent{
            Phase: "ping", Total: 1, Tested: 1, Succeeded: 1,
            Server: server.Name, PingMs: pingMs, Status: "success",
        })
    }

    ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
    probeErr := speedtest.ProbeCandidate(ctx, cfg.ClientPrivateKey, *server)
    cancel()

    status := "success"
    succeeded := 1
    if probeErr != nil {
        status = "failed"
        succeeded = 0
    }
    if progress != nil {
        progress(speedtest.ProgressEvent{
            Phase: "preparing", Total: 1, Tested: 1, Succeeded: succeeded,
            Server: server.Name, Status: status,
        })
    }
    if probeErr != nil {
        return fmt.Errorf("manual route preflight failed: %w", probeErr)
    }
} else if cfg.SpeedTest {
    // preservar integralmente a seleção automática existente
} else {
    // preservar integralmente a seleção rápida existente
}
~~~

O helper deverá gerar o mesmo perfil WireGuard existente, sem interface de host.
O JSON manual conterá manual=true, server, pingMs, endpoint e confFile, sem
downloadMbps/uploadMbps falsos. A geração deverá manter a escrita no arquivo
staged informada pelo processo principal.

- [ ] **Step 6: Rodar os testes Go do helper**

Run: cd /home/pdl/Projetos/livedc/tools/proton-confgen && go test ./internal/vpn ./internal/speedtest ./cmd/protonvpn-wg

Expected: PASS, incluindo filtros do servidor específico, preflight manual e
regressões do speed test automático.

- [ ] **Step 7: Commitar o contrato do helper**

~~~bash
git add tools/proton-confgen/internal/config/types.go tools/proton-confgen/internal/config/flags.go tools/proton-confgen/internal/vpn/servers.go tools/proton-confgen/cmd/protonvpn-wg/main.go tools/proton-confgen/internal/vpn/manual_selection_test.go tools/proton-confgen/internal/speedtest/manual_probe_test.go
git commit -m "feat(proton): validar rota manual sem speed test"
~~~

### Task 3: Wrapper Proton e IPC transacional

**Files:**

- Modify: golive-gui/electron/proton.ts
- Modify: golive-gui/electron/preload.ts
- Modify: golive-gui/electron/main.ts
- Modify: golive-gui/tests/proton-speed-selection.test.ts
- Modify: golive-gui/tests/proton-optimization.test.ts
- Modify: golive-gui/tests/ativacao-guard.test.ts

**Interfaces:**

- Consumes: contrato -manual-probe do helper e fila withWireSockLifecycle.
- Produces: generateManualProtonConfig, promoteStagedProtonConfig, removeStagedProtonConfig e IPC select-proton-route.

- [ ] **Step 1: Escrever testes do wrapper manual**

Estender o mock de child_process.spawn já existente em
proton-speed-selection.test.ts. O teste deve exigir nome exato, -server e
-manual-probe, sem -speed-test, e confirmar que o perfil ativo não muda antes
da promoção:

~~~ts
it('gera somente a rota manual solicitada e deixa o perfil ativo intacto', async () => {
  const result = await generateManualProtonConfig(dir, {
    username: 'test',
    server: 'US#8',
    countries: 'US',
    freeOnly: true,
    autoPing: true,
  });

  expect(state.args).toEqual(expect.arrayContaining([
    '-server', 'US#8', '-manual-probe',
  ]));
  expect(state.args).not.toContain('-speed-test');
  expect(result).toMatchObject({
    success: true,
    server: 'US#8',
    pingMs: 188,
    staged: true,
  });
  expect(fs.readFileSync(path.join(dir, 'wireguard.conf'), 'utf8'))
    .toBe('existing profile');
});
~~~

Adicionar testes de JSON manual inválido, saída não zero, staged ausente,
limpeza após erro e redaction da conta. O teste automático existente deve
continuar exigindo exatamente o contrato sem servidor manual.

- [ ] **Step 2: Executar os testes do wrapper antes da implementação**

Run: cd /home/pdl/Projetos/livedc/golive-gui && npm test -- tests/proton-speed-selection.test.ts

Expected: FAIL porque generateManualProtonConfig ainda não existe.

- [ ] **Step 3: Implementar wrapper staged sem tocar no wrapper automático**

Adicionar os contratos:

~~~ts
export interface ManualProtonRouteOptions {
  username: string;
  server: string;
  countries?: string;
  freeOnly?: boolean;
  autoPing?: boolean;
  signal?: AbortSignal;
}

export interface ProtonConfigResult {
  success: boolean;
  server?: string;
  country?: string;
  city?: string;
  tier?: string;
  load?: number;
  score?: number;
  pingMs?: number;
  downloadMbps?: number;
  uploadMbps?: number;
  speedTested?: number;
  speedSucceeded?: number;
  endpoint?: string;
  confFile?: string;
  error?: string;
}

export async function generateManualProtonConfig(
  installDir: string,
  options: ManualProtonRouteOptions,
): Promise<ProtonConfigResult & { staged: boolean }>;

export function promoteStagedProtonConfig(
  stagedFile: string,
  canonicalFile: string,
): void;

export function removeStagedProtonConfig(stagedFile: string): void;
~~~

O wrapper deve criar arquivo .manual-proton-route.<uuid>.tmp dentro do diretório
de configuração, montar os argumentos base atuais, acrescentar -server com
valor validado e -manual-probe, chamar runConfgen com timeout de 60 segundos e
exigir json.success, json.manual, ping positivo e staged existente. Em erro,
remover staged e retornar causa sanitizada. A função
generateOptimalProtonConfig deve conservar sua assinatura, seus argumentos e
sua promoção automática atuais.

- [ ] **Step 4: Criar a sessão efêmera da medição no processo principal**

Adicionar tipos privados em electron/main.ts e registrar cada evento aceito por
sendProgress:

~~~ts
type ManualRouteProgressSnapshot = {
  server: string;
  pingMs?: number;
  downloadMbps?: number;
  uploadMbps?: number;
  pingStatus: 'not-tested' | 'pending' | 'success' | 'failed';
  preflightStatus: 'not-tested' | 'pending' | 'success' | 'failed';
  speedStatus: 'not-tested' | 'pending' | 'success' | 'failed';
};

type ManualMeasurementSnapshot = {
  measurementId: string;
  ownerId: number;
  username: string;
  country: string;
  freeOnly: boolean;
  autoPing: boolean;
  candidates: Map<string, ManualRouteProgressSnapshot>;
  expiresAt: number;
};

const manualMeasurementSessions = new Map<number, ManualMeasurementSnapshot>();
~~~

Criar uma sessão quando optimize-proton-route iniciar a medição, atualizar o
mapa no mesmo ponto em que lastProgress é atualizado e guardar a sessão somente
quando o resultado for falha. A expiração será de 10 minutos. Nova medição,
mudança de conta, mudança de país/plano ou fechamento da janela deverá invalidar
a sessão. O snapshot conterá apenas nome, ping, status de fase e métricas
públicas.

- [ ] **Step 5: Escrever testes do IPC e da transação**

Expandir o harness de proton-optimization.test.ts para cobrir sessão obsoleta,
owner diferente, servidor fora dos candidatos, ping falho, preflight falho,
concorrência e os dois estados de bypass:

~~~ts
it('rejeita seleção manual fora da sessão e não chama o helper', async () => {
  const result = await h.selectManual({
    measurementId: 'old',
    server: 'US#8',
  });

  expect(result.success).toBe(false);
  expect(result.error).toContain('medição');
  expect(h.calls.generateManual).toBeUndefined();
});

it('seleciona o servidor exato dentro da fila de ciclo', async () => {
  const result = await h.selectManual({
    measurementId: h.failedMeasurementId,
    server: 'US#8',
  });

  expect(h.calls.generateManualOptions).toMatchObject({ server: 'US#8' });
  expect(h.order).toEqual(['generate-manual', 'backup', 'promote', 'apply']);
  expect(result).toMatchObject({
    success: true,
    manual: true,
    server: 'US#8',
  });
});
~~~

Verificar também que bypass inativo salva sem iniciar Discord, bypass ativo executa
kill/recover/start na ordem atual, erro restaura o arquivo anterior, segunda
seleção é recusada e uma sessão de outra janela não é aceita.

- [ ] **Step 6: Expor somente o IPC manual no preload**

Adicionar ao preload e ao tipo global:

~~~ts
selectProtonRoute: (options: {
  measurementId: string;
  server: string;
}) => ipcRenderer.invoke('select-proton-route', options),
~~~

Não incluir endpoint, confFile, privateKey, token ou métricas no objeto enviado
pelo renderer.

- [ ] **Step 7: Implementar o handler manual e a promoção transacional**

Adicionar ipcMain.handle('select-proton-route', ...) sob
withWireSockLifecycle('selecionar-rota-manual', ...). A implementação deverá:

1. validar strings, tamanho do servidor e measurementId;
2. procurar a sessão pelo event.sender.id;
3. confirmar expiração, owner, measurementId, candidato e ping válido;
4. rejeitar candidato com preflight explicitamente falho;
5. reler settings, conta, país, plano, freeOnly e autoPing;
6. gerar o staged com generateManualProtonConfig;
7. copiar wireguard.conf para backup temporário;
8. promover staged atomicamente;
9. aplicar a rota ativa pelo helper comum;
10. remover backup/staged somente após sucesso;
11. restaurar backup e staged em qualquer falha.

Extrair a aplicação comum para:

~~~ts
async function applyProtonRouteResult(
  generated: ProtonConfigResult,
  context: {
    operation: string;
    username: string;
    country: string;
    freeOnly: boolean;
    autoPing: boolean;
    manual: boolean;
  },
): Promise<ProtonConfigResult & { manual?: boolean }>;
~~~

Mover para essa função somente o trecho comum de persistência e troca existente.
O caminho automático deverá continuar passando manual=false e preservar seus
campos measurementVersion, measuredAt, downloadMbps, uploadMbps, a ordem
kill/recover/start e a ordem de eventos. A rota manual não preencherá
measurementVersion, measuredAt ou métricas de velocidade ausentes.

Quando a troca ativa falhar, tentar restaurar o backup e deixar
windowsRouteState em recovery_required se a restauração do túnel não puder ser
comprovada. Não transformar probe geográfico ou handshake assíncrono em gate.

- [ ] **Step 8: Rodar os testes do processo principal e wrapper**

Run: cd /home/pdl/Projetos/livedc/golive-gui && npm test -- tests/proton-speed-selection.test.ts tests/proton-optimization.test.ts tests/ativacao-guard.test.ts

Expected: PASS, com regressão explícita de que o caminho automático sem servidor
manual mantém seus argumentos e sua ordem.

- [ ] **Step 9: Commitar a ponte Electron**

~~~bash
git add golive-gui/electron/proton.ts golive-gui/electron/preload.ts golive-gui/electron/main.ts golive-gui/tests/proton-speed-selection.test.ts golive-gui/tests/proton-optimization.test.ts golive-gui/tests/ativacao-guard.test.ts
git commit -m "feat(gui): expor seleção manual de rota Proton"
~~~

### Task 4: Interface de fallback manual

**Files:**

- Modify: golive-gui/index.html
- Modify: golive-gui/src/main.ts
- Modify: golive-gui/src/style.css
- Modify: golive-gui/tests/proton-ui.test.ts

**Interfaces:**

- Consumes: ManualRouteCandidate, sortManualRouteCandidates, recommendManualRoute, window.api.selectProtonRoute e eventos existentes.
- Produces: lista persistente após falha, selo de recomendação, botões Selecionar e estado de aplicação manual.

- [ ] **Step 1: Escrever contratos de markup e comportamento**

Adicionar em proton-ui.test.ts:

~~~ts
it('mantém ação manual no diálogo de medição', () => {
  const html = fs.readFileSync(path.resolve(process.cwd(), 'index.html'), 'utf8');

  expect(html).toContain('id="protonManualSelectionHint"');
  expect(html).toContain('Escolher uma rota manualmente');
  expect(html).toContain('aria-live="polite"');
});

it('mantém a chamada automática sem servidor específico', () => {
  const source = fs.readFileSync(path.resolve(process.cwd(), 'src/main.ts'), 'utf8');

  expect(source).toContain(
    'window.api.optimizeProtonRoute({ country, autoPing: true, speedTest, refreshOnStartup: onStartup',
  );
  expect(source).toContain('window.api.selectProtonRoute');
});
~~~

Adicionar teste de que o branch de falha não chama close antes de oferecer a lista
e de que o branch de sucesso conserva o feedback atual.

- [ ] **Step 2: Executar os testes UI antes da implementação**

Run: cd /home/pdl/Projetos/livedc/golive-gui && npm test -- tests/proton-ui.test.ts

Expected: FAIL nos novos contratos.

- [ ] **Step 3: Adicionar markup mínimo ao diálogo**

Entre protonMeasurementList e protonMeasurementActions, inserir:

~~~html
<div id="protonManualSelectionHint" class="proton-measurement__manual" hidden aria-live="polite">
  A medição automática não concluiu. Escolha uma rota medida pelo menor ping.
</div>
~~~

As linhas dinâmicas devem usar DOM API. O nome recebido do helper será aplicado
com textContent. Cada botão deve ter type=button, aria-label com o nome exibido e
disabled durante a aplicação.

- [ ] **Step 4: Integrar o agregado puro ao progresso**

Adicionar estado manualCandidates, manualSelectionVisible e
manualMeasurementId no renderer. A cada evento aceito pelo requestId, reduzir e
renderizar todas as linhas em ordem:

~~~ts
manualCandidates = reduceManualRouteEvent(manualCandidates, event);

renderMeasurementList(
  sortManualRouteCandidates(manualCandidates.values()),
  manualSelectionVisible,
  recommendManualRoute(manualCandidates.values()),
);
~~~

Durante a medição, os botões permanecem ocultos. O mesmo evento deve atualizar
ping, preflight ou velocidade da linha existente, sem aumentar artificialmente
o número de servidores ou alterar o total usado pela barra.

- [ ] **Step 5: Manter a lista quando a seleção automática falhar**

No branch !res.success:

- preservar as linhas já renderizadas;
- mudar o título para Medição automática não concluída;
- mostrar a dica manual se houver candidato elegível;
- inserir botões Selecionar nas linhas elegíveis;
- manter Tentar novamente, Continuar sem medição e Fechar;
- explicar quando nenhum candidato com ping válido existir.

O branch de sucesso continuará fechando o diálogo. O branch de cancelamento
continuará sem abrir automaticamente o modo manual.

- [ ] **Step 6: Implementar a ação manual com estado obsoleto protegido**

Guardar manualMeasurementId antes de limpar protonOptimizationRequestId no
finally. O clique deve verificar que a linha ainda está no mapa e chamar:

~~~ts
const result = await window.api.selectProtonRoute({
  measurementId: manualMeasurementId,
  server: candidate.server,
});
~~~

Antes da chamada, desabilitar todas as ações e mostrar Aplicando rota US#8.
Em sucesso, atualizar estado e feedback com Rota US#8 selecionada! quando o
bypass estiver inativo, ou Rota US#8 aplicada! quando estiver ativo. Em falha,
reabilitar as demais linhas, marcar somente a escolhida e mostrar erro
sanitizado.

- [ ] **Step 7: Estilizar recomendação, métricas e botões**

Adicionar classes para botão compacto na coluna direita, selo de recomendação,
texto monoespaçado das métricas e estados hover/focus/disabled. Respeitar a
largura e rolagem atuais do diálogo, foco visível e prefers-reduced-motion.
Não alterar a paleta global nem criar sombra/gradiente fora do padrão existente.

- [ ] **Step 8: Rodar os testes da GUI**

Run: cd /home/pdl/Projetos/livedc/golive-gui && npm test -- tests/proton-manual-selection.test.ts tests/proton-ui.test.ts

Expected: PASS, com lista ordenada, recomendação correta e fallback mantido após
erro.

- [ ] **Step 9: Commitar a interface**

~~~bash
git add golive-gui/index.html golive-gui/src/main.ts golive-gui/src/style.css golive-gui/tests/proton-ui.test.ts
git commit -m "feat(gui): permitir escolher rota Proton após falha"
~~~

### Task 5: Integração, regressões e documentação

**Files:**

- Modify: CHANGELOG.md
- Test: testes modificados nas tarefas 1 a 4

**Interfaces:**

- Consumes: commits das tarefas 1 a 4.
- Produces: validação do fluxo completo, changelog e registro de limitações reais.

- [ ] **Step 1: Verificar diff e escopo antes da suíte completa**

Run:

~~~bash
cd /home/pdl/Projetos/livedc
git diff --check HEAD~4..HEAD
git diff --name-only HEAD~4..HEAD
~~~

Expected: somente arquivos da feature e commits correspondentes; nenhum
arquivo de standalone/, goLiveBypass/, proxy, Tor ou app.asar alterado.

- [ ] **Step 2: Adicionar a entrada do changelog**

Em [Unreleased], registrar que a GUI mantém a seleção automática e passa a
exibir candidatos medidos para escolha manual após falha, usando ping para
ordenação e velocidade apenas quando disponível. Declarar que isso não é prova
de saída geográfica nem altera plugin/standalone.

- [ ] **Step 3: Executar todos os testes GUI relacionados**

Run:

~~~bash
cd /home/pdl/Projetos/livedc/golive-gui
npm test -- tests/proton-manual-selection.test.ts tests/proton-ui.test.ts tests/proton-speed-selection.test.ts tests/proton-optimization.test.ts tests/ativacao-guard.test.ts tests/proton-flags.test.ts tests/proton-privacy.test.ts
~~~

Expected: PASS; a suíte deve comprovar que a chamada automática sem servidor
manual continua igual e que nenhum segredo chega à UI.

- [ ] **Step 4: Executar todos os testes do helper**

Run: cd /home/pdl/Projetos/livedc/tools/proton-confgen && go test ./...

Expected: PASS, incluindo seleção automática, preflight, speed test, JSON e
modo manual.

- [ ] **Step 5: Compilar a GUI sem publicar**

Run: cd /home/pdl/Projetos/livedc/golive-gui && npm run compile

Expected: sincronização do bypass gerado, helper Go, TypeScript e Vite
concluídos sem editar golive-gui/electron/bypass.ts manualmente.

- [ ] **Step 6: Fazer revisão estática final do contrato**

Run:

~~~bash
cd /home/pdl/Projetos/livedc
git diff --check
git status --short
rg -n "select-proton-route|manual-probe|Escolher uma rota manualmente|Menor ping disponível" golive-gui tools/proton-confgen CHANGELOG.md
~~~

Confirmar que a lista manual não aparece antes da falha, que o novo IPC não
aceita endpoint/chave, que -server não foi acrescentado ao caminho automático
sem escolha manual e que o perfil anterior é restaurado em falha.

- [ ] **Step 7: Registrar a limitação funcional da plataforma**

Antes de publicar, executar o roteiro Windows da especificação: provocar falha
de velocidade, escolher uma rota por ping, confirmar AllowedApps, verificar o
Discord pela rota e restaurar a rede. Se a VM Windows não estiver disponível,
registrar explicitamente que compile/testes unitários não provam WFP nem tráfego
real do Discord; não declarar a feature como validada em campo.

- [ ] **Step 8: Commitar changelog e validação**

~~~bash
git add CHANGELOG.md
git commit -m "docs: registrar fallback manual de rota Proton"
~~~

## Resultado esperado

Usuários que passam pela seleção automática continuam vendo o mesmo fluxo. Nos
casos em que a medição falha, a GUI mantém os resultados já coletados, ordena as
rotas por ping, mostra velocidades parciais, destaca uma recomendação honesta e
permite escolher uma rota específica sem aceitar servidor fora dos filtros ou
promover um perfil que não passou pela validação manual.
