# Proteção do SSE e do updater Windows Implementation Plan

> **For agentic workers:** Execute este plano tarefa por tarefa, mantendo os ciclos de teste e os commits indicados.

**Goal:** Impedir downgrade de releases no pulso SSE e garantir que o updater Windows baixe somente o portable completo, nunca o helper Proton de ~14 MB.

**Architecture:** A API terá um comparador SemVer no pacote `updates`; o `Broker` aplicará uma barreira monotônica ao publicar e o `ReleasePoller` escolherá a maior tag válida. A GUI continuará consultando o GitHub diretamente, mas selecionará o asset por nome exato e verificará o digest antes de marcar o arquivo pendente.

**Tech Stack:** Go 1.25+, Echo v5, testes Go; Electron/TypeScript, Vitest, electron-builder portable.

**Spec:** `docs/superpowers/specs/2026-09-07-update-sse-and-windows-asset-guard-design.md`

## Global Constraints

- Releases beta continuam prerelease e nunca são tratadas como `latest` estável.
- O SSE é apenas um pulso; URL, asset e digest continuam sendo confirmados pelo GitHub no cliente.
- O portable Windows é exatamente `GoLiveBypass-<tag sem v>.exe`; helpers `*-proton-confgen-*.exe` não são candidatos.
- O download só vira atualização pendente depois de SHA-256 válido.
- Não alterar isolamento WireGuard, fluxo Linux ou o bypass gerado.

---

### Task 1: Comparador SemVer e barreira monotônica do broker

**Files:**
- Create: `api/internal/updates/version.go`
- Modify: `api/internal/updates/broker.go`
- Test: `api/internal/updates/version_test.go`
- Test: `api/internal/updates/updates_test.go`

**Interfaces:**
- Produces `CompareReleaseTags(a, b string) (int, bool)`, com retorno negativo quando `a < b`, zero quando iguais, positivo quando `a > b`, e `false` para tags inválidas.
- `Broker.Publish` continuará com assinatura `Publish(deliveryID string, event ReleaseEvent) bool`; retornará `false` para delivery duplicado, tag inválida, tag igual ou tag inferior à última aceita.

- [ ] **Step 1: Escrever os testes que falham**

Adicionar em `version_test.go`:

```go
func TestCompareReleaseTags(t *testing.T) {
    cases := []struct { a, b string; want int; valid bool }{
        {"v2.0.5-beta-10", "v2.0.5-beta-9", 1, true},
        {"v2.0.5", "v2.0.5-beta-12", 1, true},
        {"v2.0.6-beta-1", "v2.0.5", 1, true},
        {"release/latest", "v2.0.5", 0, false},
    }
    for _, tc := range cases {
        got, ok := CompareReleaseTags(tc.a, tc.b)
        if ok != tc.valid || (ok && (got < 0) != (tc.want < 0)) || (ok && (got > 0) != (tc.want > 0)) {
            t.Fatalf("CompareReleaseTags(%q, %q) = (%d, %v), want sign %d valid %v", tc.a, tc.b, got, ok, tc.want, tc.valid)
        }
    }
}
```

Adicionar em `updates_test.go`:

```go
func TestBrokerRejectsOlderRelease(t *testing.T) {
    broker := NewBroker()
    sub, _, err := broker.Subscribe("203.0.113.30")
    if err != nil { t.Fatal(err) }
    defer sub.Close()
    if !broker.Publish("beta-12", ReleaseEvent{Tag: "v2.0.5-beta-12", Prerelease: true}) { t.Fatal("beta-12 recusada") }
    if broker.Publish("beta-9", ReleaseEvent{Tag: "v2.0.5-beta-9", Prerelease: true}) { t.Fatal("beta-9 rebaixou o broker") }
    if got := <-sub.Events(); got.Tag != "v2.0.5-beta-12" { t.Fatalf("evento = %+v", got) }
    _, replay, err := broker.Subscribe("203.0.113.31")
    if err != nil || replay == nil || replay.Tag != "v2.0.5-beta-12" { t.Fatalf("replay = %+v, err = %v", replay, err) }
}
```

- [ ] **Step 2: Executar os testes novos**

Run: `go test ./internal/updates -run 'TestCompareReleaseTags|TestBrokerRejectsOlderRelease' -count=1`

Expected: FAIL porque o comparador ainda não existe e o broker ainda aceita o downgrade.

- [ ] **Step 3: Implementar o comparador e a barreira**

Em `version.go`, normalizar `v`, separar base `major.minor.patch` e prerelease, transformar `beta-N` em identificadores `beta.N`, comparar identificadores numéricos numericamente e tratar stable como superior à prerelease do mesmo triplo. Em `Broker.Publish`, depois de deduplicar o delivery, comparar `event.Tag` com `b.latest.Tag`; não atualizar `latest` nem as filas quando a tag não for estritamente maior.

- [ ] **Step 4: Executar os testes da API de updates**

Run: `go test ./internal/updates -count=1`

Expected: PASS, incluindo deduplicação webhook/polling, replay e limites existentes.

- [ ] **Step 5: Commitar a unidade**

Run: `git add api/internal/updates/version.go api/internal/updates/version_test.go api/internal/updates/broker.go api/internal/updates/updates_test.go && git commit -m "fix(api): impedir downgrade no pulso SSE"`

### Task 2: Poller escolher a maior release válida

**Files:**
- Modify: `api/internal/updates/poller.go`
- Test: `api/internal/updates/poller_test.go`

**Interfaces:**
- `ReleasePoller.PollOnce(context.Context) error` permanece igual.
- `newestRelease` continuará retornando `githubRelease`, mas escolherá a maior tag SemVer válida; o broker continuará sendo a barreira final contra eventos antigos.

- [ ] **Step 1: Adicionar teste de ordem de publicação enganosa**

Adicionar uma resposta fake com beta-9 publicada depois de beta-12 e verificar a tag escolhida:

```go
func TestReleasePollerChoosesHighestSemVerNotLatestDate(t *testing.T) {
    broker := NewBroker()
    sub, _, err := broker.Subscribe("203.0.113.40")
    if err != nil { t.Fatal(err) }
    defer sub.Close()
    responses := &fakeReleaseHTTP{bodies: [][]byte{
        []byte(`[{"tag_name":"v2.0.5-beta-9","published_at":"2026-09-08T03:00:00Z"},{"tag_name":"v2.0.5-beta-12","published_at":"2026-09-08T02:00:00Z"}]`),
    }}
    poller := NewReleasePoller("token", "owner/repo", broker, slog.New(slog.NewTextHandler(io.Discard, nil)))
    poller.client = responses
    got, err := poller.newestRelease(context.Background())
    if err != nil { t.Fatal(err) }
    if got.TagName != "v2.0.5-beta-12" { t.Fatalf("release escolhida = %+v", got) }
}
```

O teste do poller existente continua cobrindo baseline silenciosa e publicação posterior; este caso cobre diretamente que a maior tag vence mesmo quando a data de beta-9 é posterior.

- [ ] **Step 2: Executar o teste do poller**

Run: `go test ./internal/updates -run 'TestReleasePoller' -count=1`

Expected: FAIL enquanto a seleção comparar apenas `PublishedAt`.

- [ ] **Step 3: Alterar a seleção do poller**

Filtrar draft, data ausente e tag inválida como hoje; substituir a comparação de datas por `CompareReleaseTags(release.TagName, newest.TagName) > 0`. Usar a data somente como desempate determinístico quando as tags forem equivalentes.

- [ ] **Step 4: Rodar todos os testes Go**

Run: `go test ./...`

Expected: PASS em todos os pacotes da API.

- [ ] **Step 5: Commitar a unidade**

Run: `git add api/internal/updates/poller.go api/internal/updates/poller_test.go && git commit -m "fix(api): escolher maior release no polling"`

### Task 3: Reforçar e validar a seleção do asset Windows

**Files:**
- Verify/modify: `golive-gui/electron/updater-channel.ts`
- Modify: `golive-gui/electron/updater.ts` only if a guard is missing
- Test: `golive-gui/tests/updater-channel.test.ts`

**Interfaces:**
- `escolherAssetWindows(tag: string, assets: AssetWindows[]): AssetWindows | null` será a única seleção do EXE Windows.
- A seleção deverá aceitar somente `GoLiveBypass-${tag.replace(/^v/, '')}.exe` e rejeitar o helper mesmo se ele aparecer primeiro ou for o único `.exe`.

- [ ] **Step 1: Acrescentar regressão de tamanho/nome real**

Manter estes casos em `updater-channel.test.ts`:

```ts
it("ignora o helper de 14 MB mesmo quando ele aparece primeiro", () => {
  const assets = [
    { name: "GoLiveBypass-2.0.5-beta-12-proton-confgen-win-x64.exe" },
    { name: "GoLiveBypass-2.0.5-beta-12.exe" },
  ];
  expect(escolherAssetWindows("v2.0.5-beta-12", assets)?.name)
    .toBe("GoLiveBypass-2.0.5-beta-12.exe");
});

it("não aceita o helper como fallback", () => {
  expect(escolherAssetWindows("v2.0.5-beta-12", [
    { name: "GoLiveBypass-2.0.5-beta-12-proton-confgen-win-x64.exe" },
  ])).toBeNull();
});
```

Verificar também a chamada do updater usando `escolherAssetWindows(String(item.tag_name), assets)`.

- [ ] **Step 2: Executar os testes direcionados**

Run: `npm test -- tests/updater-channel.test.ts tests/updater-replace.test.ts`

Expected: PASS; se o seletor deixar passar o helper, o teste falha antes da implementação.

- [ ] **Step 3: Corrigir qualquer seleção residual por prefixo**

Remover qualquer `startsWith('GoLiveBypass-')` ou equivalente da montagem da candidata e manter a conferência de digest SHA-256 antes de `persistPendingWindowsUpdate`.

- [ ] **Step 4: Executar novamente os testes e a compilação**

Run: `npm test -- tests/updater-channel.test.ts tests/updater-replace.test.ts && npm run compile && npm run check-bypass`

Expected: PASS, com o código Electron e Vite compilados.

- [ ] **Step 5: Commitar a unidade**

Run: `git add golive-gui/electron/updater-channel.ts golive-gui/electron/updater.ts golive-gui/tests/updater-channel.test.ts && git commit -m "fix(update): bloquear helper Proton no asset Windows"`

### Task 4: Validação de produção e evidências

**Files:**
- Modify: `CHANGELOG.md` with a concise incident note and the permanent safeguards.
- Review: `api/README.md` and `api/deploy/README.md` for the actual polling/replay behavior.

**Interfaces:**
- Nenhuma API pública nova; o contrato SSE continua `event: release`, `id` e JSON com `tag`, `prerelease` e `published_at`.

- [ ] **Step 1: Rodar a suíte final**

Run: `go test ./...` in `api`; `npm test` in `golive-gui`; `npm run compile` and `npm run check-bypass` in `golive-gui`; `git diff --check`.

Expected: todos os testes passam e não há erro de whitespace.

- [ ] **Step 2: Conferir o SSE em produção**

Run: `timeout 6s curl -sS -N https://api.skyplaceia.com/bugs/v1/updates/stream`

Expected: HTTP 200 e replay de `v2.0.5-beta-12` ou release superior; nunca `v2.0.5-beta-9` como último evento.

- [ ] **Step 3: Conferir release e artefatos no GitHub**

Run: `gh release view v2.0.5-beta-12 --repo bezumiya/GoLiveBypass --json assets,isPrerelease,isDraft` e comparar o digest do asset `GoLiveBypass-2.0.5-beta-12.exe` com o arquivo baixado; registrar que o helper separado mede aproximadamente 14,6 MB e o portable aproximadamente 101 MB.

- [ ] **Step 4: Documentar a causa e as garantias**

Adicionar ao changelog que o problema era seleção por prefixo e que webhook/polling fora de ordem podia rebaixar o replay; registrar seleção exata, digest e barreira monotônica.

- [ ] **Step 5: Commitar documentação**

Run: `git add CHANGELOG.md api/README.md api/deploy/README.md && git commit -m "docs: registrar protecoes do updater e SSE"`
