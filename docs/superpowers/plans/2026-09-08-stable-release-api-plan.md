# Stable Release Catalog API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expor pela API Go a release estável atual do GitHub e aliases seguros que redirecionem para os assets corretos sem exigir atualização manual do site.

**Architecture:** O cliente Go existente consulta `GET /repos/{repo}/releases/latest` usando o token já configurado. Um cache em memória com TTL e mutex fornece o catálogo e mantém a última resposta válida como fallback; o webhook de release invalida esse cache quando uma release estável é publicada. O servidor expõe JSON público e redirects somente para aliases pré-definidos, sem revelar token ou aceitar URL arbitrária.

**Tech Stack:** Go 1.26.5, Echo v5, `net/http`, `encoding/json`, testes com `httptest`.

**Spec:** `docs/superpowers/specs/2026-09-08-website-latest-stable-gui-v2-design.md`

## Global Constraints

- “A consulta da API usará o endpoint do GitHub para a release mais recente. Por definição, a fonte escolhida é a release não-draft e não-prerelease.”
- “Os aliases de download são uma lista fechada.”
- “Token, headers do GitHub e detalhes internos do cache nunca saem da API.”
- “O endpoint público não reutilizará o token de reports nem ficará dentro do rate limit de criação de issues.”
- O webhook, reports, healthcheck e SSE existentes devem continuar com os mesmos caminhos e contratos.
- Nenhuma alteração nesta etapa publica a API, muda segredos ou altera o runtime da GUI.

## Mapa de arquivos

- Modificar `api/internal/gh/github.go`: tipos públicos mínimos de release e método autenticado para ler a release mais recente.
- Modificar `api/internal/gh/github_test.go`: teste HTTP do método novo, incluindo headers, caminho e falhas de resposta.
- Criar `api/internal/releases/catalog.go`: normalização da tag, seleção dos assets, cache, fallback e aliases.
- Criar `api/internal/releases/catalog_test.go`: testes unitários do catálogo sem rede real.
- Modificar `api/internal/config/config.go`: origens permitidas para CORS do site.
- Modificar `api/internal/config/config_test.go`: defaults, parsing e rejeição de origem vazia.
- Criar `api/internal/server/cors.go`: middleware GET/OPTIONS restrito às origens configuradas.
- Modificar `api/internal/server/server.go`: receber a fonte de release, criar o cache e registrar as rotas públicas.
- Modificar `api/internal/server/handlers.go`: handlers JSON/redirect e invalidação no webhook estável.
- Modificar `api/internal/server/server_test.go`: fonte fake, JSON, CORS, redirect, erro de alias e invalidação.
- Modificar `api/cmd/api/main.go`: injetar o cliente GitHub também como fonte do catálogo.
- Modificar `api/.env.example`, `api/README.md` e `api/deploy/README.md`: documentar origens e endpoints públicos.

### Task 1: Adicionar a leitura autenticada da release mais recente ao cliente GitHub

**Files:**
- Modify: `api/internal/gh/github.go`
- Test: `api/internal/gh/github_test.go`

**Interfaces:**
- Produces `gh.Release` com `TagName`, `Name`, `Draft`, `Prerelease`, `PublishedAt`, `HTMLURL` e `Assets []ReleaseAsset`.
- Produces `(*Client).LatestStableRelease(context.Context) (Release, error)`.
- O método chama `GET /repos/{Client.repo}/releases/latest` e envia os mesmos headers `Authorization`, `Accept`, `X-GitHub-Api-Version` e `User-Agent` já usados pelo cliente.

- [ ] **Step 1: Escrever o teste HTTP que deve falhar**

Adicionar em `api/internal/gh/github_test.go` um servidor fake que confira o token e o caminho e devolva:

```go
func TestLatestStableRelease(t *testing.T) {
    var gotPath string
    srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        gotPath = r.URL.Path
        if r.Header.Get("Authorization") != "Bearer token" {
            t.Fatalf("authorization = %q", r.Header.Get("Authorization"))
        }
        if r.Header.Get("Accept") != apiAccept {
            t.Fatalf("accept = %q", r.Header.Get("Accept"))
        }
        _, _ = io.WriteString(w, `{"tag_name":"v2.0.4","name":"GoLiveBypass 2.0.4","draft":false,"prerelease":false,"published_at":"2026-09-05T16:40:08Z","html_url":"https://github.com/owner/repo/releases/tag/v2.0.4","assets":[{"name":"GoLiveBypass-2.0.4.exe","browser_download_url":"https://objects.example/windows.exe"}]}`)
    }))
    t.Cleanup(srv.Close)

    client := New("token", "owner/repo")
    client.baseURL = srv.URL
    got, err := client.LatestStableRelease(context.Background())
    if err != nil {
        t.Fatal(err)
    }
    if got.TagName != "v2.0.4" || got.PublishedAt != "2026-09-05T16:40:08Z" || len(got.Assets) != 1 {
        t.Fatalf("release = %+v", got)
    }
    if gotPath != "/repos/owner/repo/releases/latest" {
        t.Fatalf("path = %q", gotPath)
    }
}
```

Adicionar também `TestLatestStableReleaseRejectsNonOK`, com resposta 403 e assertion de erro contendo `GitHub respondeu`.

- [ ] **Step 2: Rodar os testes para confirmar a falha**

Run: `go test ./internal/gh -run 'TestLatestStableRelease'`

Expected: FAIL porque `Release` e `LatestStableRelease` ainda não existem.

- [ ] **Step 3: Implementar os tipos e o método mínimo**

Adicionar os tipos JSON e o método no cliente existente. O método deve:

1. construir a URL com `c.baseURL + "/repos/" + c.repo + "/releases/latest"`;
2. usar `http.NewRequestWithContext`;
3. enviar os headers do cliente atual;
4. limitar o corpo lido a `1<<20` bytes;
5. aceitar somente status 200;
6. decodificar o JSON em `Release`;
7. retornar erro com status e corpo resumido para qualquer outro status.

Não filtrar a release silenciosamente no cliente: a validação de release estável e a seleção de assets pertencem ao pacote `internal/releases`.

- [ ] **Step 4: Rodar os testes para confirmar a passagem**

Run: `go test ./internal/gh -run 'TestLatestStableRelease'`

Expected: PASS.

- [ ] **Step 5: Commitar a unidade**

```bash
git add api/internal/gh/github.go api/internal/gh/github_test.go
git commit -m "feat(api): ler release mais recente do GitHub"
```

### Task 2: Criar catálogo estável, seleção de assets e cache

**Files:**
- Create: `api/internal/releases/catalog.go`
- Test: `api/internal/releases/catalog_test.go`

**Interfaces:**
- Consumes `gh.Release` e `gh.ReleaseAsset` de Task 1.
- Produces `releases.Source`, `releases.CatalogCache`, `releases.Catalog`, `releases.PublicAsset`.
- Produces aliases `windows`, `linux`, `mac-dmg`, `mac-zip`, `plugin`, `plugin-sha`, `standalone` e `standalone-sha`.
- Produces `NewCatalogCache(source Source, ttl time.Duration) *CatalogCache`, `Latest(context.Context) (Catalog, error)`, `Download(context.Context, string) (string, error)` e `Invalidate()`.

O JSON público terá esta forma:

```go
type Catalog struct {
    Tag         string                 `json:"tag"`
    Version     string                 `json:"version"`
    Name        string                 `json:"name"`
    Channel     string                 `json:"channel"`
    PublishedAt string                 `json:"published_at"`
    PageURL     string                 `json:"page_url"`
    Stale       bool                   `json:"stale,omitempty"`
    Assets      map[string]PublicAsset `json:"assets"`
}

type PublicAsset struct {
    Name string `json:"name"`
    URL  string `json:"url"`
}
```

- [ ] **Step 1: Escrever testes da normalização e dos assets**

Criar um `fakeSource` que conta chamadas e devolve uma `gh.Release`. Cobrir seis testes: `TestBuildCatalogAcceptsStableRelease` deve aceitar `v2.0.4` e conferir versão/aliases; `TestBuildCatalogRejectsPrerelease` deve rejeitar `Prerelease: true`; `TestBuildCatalogRejectsDraft` deve rejeitar `Draft: true`; `TestBuildCatalogRejectsPrereleaseTag` deve rejeitar `v2.0.5-beta.1`; `TestDownloadRejectsUnknownAlias` deve retornar `ErrUnknownAlias`; e `TestDownloadReportsMissingAsset` deve retornar `ErrAssetNotFound` quando o Windows não tiver `.exe`.

Usar os nomes reais do workflow: `GoLiveBypass-2.0.4.exe`, `GoLiveBypass-2.0.4.AppImage`, `GoLiveBypass.dmg`, `GoLiveBypass.zip`, `goLiveBypass-vencord.zip`, seu hash, `GoLiveBypass-2.0.4-bypass.js` e seu hash.

- [ ] **Step 2: Rodar os testes para confirmar a falha**

Run: `go test ./internal/releases`

Expected: FAIL porque o pacote e suas funções ainda não existem.

- [ ] **Step 3: Implementar a validação e seleção determinística**

Implementar `buildCatalog(gh.Release) (Catalog, error)` com estas regras:

- aceitar somente `Draft == false`, `Prerelease == false`;
- aceitar tags `v?MAJOR.MINOR.PATCH` com optional build metadata, mas rejeitar hífen de prerelease;
- remover somente o prefixo inicial `v` para preencher `Version`;
- preencher `Channel` com `stable`;
- localizar assets por nome exato usando a versão normalizada para `.exe`, `.AppImage` e `-bypass.js`;
- localizar os quatro nomes fixos para macOS/plugin/plugin hash;
- preservar `browser_download_url` como URL pública do asset;
- não fabricar entrada para asset ausente;
- aceitar apenas URLs HTTPS dos assets.

Os erros exportados serão `ErrInvalidStableRelease`, `ErrUnknownAlias` e `ErrAssetNotFound`.

- [ ] **Step 4: Escrever testes de TTL, fallback e invalidação**

Adicionar relógio injetável ou TTL curto no fake para cobrir cinco testes: `TestCatalogCacheUsesCachedValueWithinTTL` deve fazer duas leituras e uma chamada à fonte; `TestCatalogCacheRefreshesAfterTTL` deve avançar o relógio e receber nova tag; `TestCatalogCacheReturnsLastGoodCatalogOnRefreshError` deve marcar `Stale: true`; `TestCatalogCacheReturnsErrorWithoutPreviousValue` deve propagar a primeira falha; e `TestCatalogCacheInvalidateForcesRefresh` deve exigir uma nova chamada após `Invalidate()`.

- [ ] **Step 5: Implementar cache com refresh serializado**

Usar `sync.RWMutex` para o snapshot e um segundo `sync.Mutex` para serializar refreshes. O fluxo de `Latest` é:

1. ler snapshot e devolver cópia não-stale enquanto `expiresAt` estiver no futuro;
2. adquirir o mutex de refresh;
3. repetir a checagem do TTL após adquirir o mutex;
4. chamar a fonte fora do lock do snapshot;
5. armazenar catálogo novo e `expiresAt = now + ttl`;
6. em erro, devolver o snapshot anterior com `Stale: true` se existir;
7. sem snapshot anterior, retornar o erro original.

O TTL padrão será cinco minutos; `NewCatalogCache` aceitará TTL para os testes. `Download` chamará `Latest`, resolverá somente aliases declarados e devolverá a URL validada.

- [ ] **Step 6: Rodar os testes para confirmar a passagem**

Run: `go test ./internal/releases`

Expected: PASS.

- [ ] **Step 7: Commitar a unidade**

```bash
git add api/internal/releases/catalog.go api/internal/releases/catalog_test.go
git commit -m "feat(api): cachear catalogo estavel de assets"
```

### Task 3: Configurar CORS público e registrar os endpoints

**Files:**
- Modify: `api/internal/config/config.go`
- Modify: `api/internal/config/config_test.go`
- Create: `api/internal/server/cors.go`
- Modify: `api/internal/server/server.go`
- Modify: `api/internal/server/handlers.go`
- Modify: `api/cmd/api/main.go`

**Interfaces:**
- Consumes `releases.CatalogCache` de Task 2.
- `Config.WebsiteOrigins []string` vem de `WEBSITE_ORIGINS`, com default `https://golivebypass.dev,http://localhost:3000,http://127.0.0.1:3000`.
- `New(cfg, issues, logger, releaseSource releases.Source) *echo.Echo` recebe a fonte GitHub adicional.
- Rotas: `GET {BASE_PATH}/v1/releases/latest` e `GET {BASE_PATH}/v1/releases/latest/download/:asset`.

- [ ] **Step 1: Escrever testes de configuração e rotas**

Adicionar asserts em `config_test.go` para o default e CSV sem espaços. Em `server_test.go`, criar uma fonte fake, registrar `Origin: https://golivebypass.dev` e exigir `Access-Control-Allow-Origin` igual à origem.

- [ ] **Step 2: Rodar os testes para confirmar a falha**

Run: `go test ./internal/config ./internal/server -run 'Release|CORS|WebsiteOrigins'`

Expected: FAIL por falta de campo, fonte injetada e rotas públicas.

- [ ] **Step 3: Implementar origem permitida e middleware**

Adicionar `WebsiteOrigins` descartando itens vazios. O middleware deve:

- sempre definir `Vary: Origin` quando houver `Origin`;
- refletir `Access-Control-Allow-Origin` somente se a origem estiver na lista;
- responder OPTIONS com 204 e `Access-Control-Allow-Methods: GET, OPTIONS`;
- nunca usar `*`;
- não adicionar headers CORS a origens não autorizadas.

Registrar o middleware apenas no grupo `/v1/releases`.

- [ ] **Step 4: Implementar handlers públicos e injeção**

Adicionar `releaseCatalog *releases.CatalogCache` ao handler. No `server.New`, construir o cache com a fonte recebida e registrar:

```go
releaseV1 := e.Group(cfg.BasePath+"/v1/releases", releaseCORSMiddleware(cfg.WebsiteOrigins))
releaseV1.GET("/latest", h.latestRelease)
releaseV1.GET("/latest/download/:asset", h.downloadReleaseAsset)
```

`latestRelease` devolve 200 e o `Catalog`; sem catálogo nem fallback, devolve 502 com `{"error":"release estável indisponível"}`.

`downloadReleaseAsset` aceita somente `c.Param("asset")` e:

- devolve 404 `{"error":"asset não encontrado"}` para alias desconhecido ou asset ausente;
- devolve 502 para falha de origem sem fallback;
- responde `http.StatusFound` com `Location` igual à URL validada do GitHub em caso de sucesso.

No `main.go`, chamar `server.New(cfg, client, logger, client)`.

- [ ] **Step 5: Rodar testes focados**

Run: `go test ./internal/config ./internal/server`

Expected: PASS nos testes de configuração, JSON, CORS e redirect; reports/SSE continuam passando.

- [ ] **Step 6: Commitar a unidade**

```bash
git add api/internal/config api/internal/server api/cmd/api/main.go
git commit -m "feat(api): publicar catalogo e redirects de releases"
```

### Task 4: Invalidar o catálogo no webhook e cobrir regressões

**Files:**
- Modify: `api/internal/server/handlers.go`
- Modify: `api/internal/server/server_test.go`

**Interfaces:**
- Consumes `CatalogCache.Invalidate()` de Task 2.
- Preserves `updates.Broker` e o contrato SSE existente.

- [ ] **Step 1: Escrever teste de invalidação**

Preparar `fakeReleaseSource` que devolva `v2.0.4` na primeira leitura e `v2.0.5` na segunda. Fazer GET do catálogo, publicar webhook assinado com `prerelease:false), fazer novo GET e exigir a segunda tag. Enviar também webhook com `prerelease:true` e confirmar que a tag estável não é substituída.

- [ ] **Step 2: Rodar o teste para confirmar a falha**

Run: `go test ./internal/server -run 'Invalidates|Prerelease'`

Expected: FAIL porque o webhook ainda não invalida o catálogo.

- [ ] **Step 3: Invalidar somente eventos estáveis aceitos pelo parser**

Depois de `ParsePublishedRelease` e antes de retornar 202, chamar `h.releaseCatalog.Invalidate()` somente quando `event.Prerelease == false`. Manter `Broker.Publish` como está.

- [ ] **Step 4: Rodar a suíte completa da API**

Run: `go test ./...` em `api/`

Expected: PASS.

- [ ] **Step 5: Commitar a unidade**

```bash
git add api/internal/server/handlers.go api/internal/server/server_test.go
git commit -m "feat(api): invalidar catalogo apos release estavel"
```

### Task 5: Documentar o contrato e validar a API inteira

**Files:**
- Modify: `api/.env.example`
- Modify: `api/README.md`
- Modify: `api/deploy/README.md`

**Interfaces:**
- Documenta exatamente `WEBSITE_ORIGINS`, `/bugs/v1/releases/latest` e `/bugs/v1/releases/latest/download/{asset}`.

- [ ] **Step 1: Atualizar o exemplo de ambiente**

Adicionar:

```dotenv
WEBSITE_ORIGINS=https://golivebypass.dev,http://localhost:3000,http://127.0.0.1:3000
```

- [ ] **Step 2: Documentar JSON, aliases e política estável**

Explicar que `/releases/latest` do GitHub não retorna prereleases, que o serviço mantém cache de cinco minutos, que o webhook invalida o cache e que o redirect é fechado por alias. Incluir exemplos `curl` para `latest` e `download/windows`.

- [ ] **Step 3: Atualizar o runbook de deploy**

Adicionar verificação do endpoint com `curl -i`, incluindo request com `Origin: https://golivebypass.dev`, sem incluir tokens na documentação.

- [ ] **Step 4: Rodar validação final**

Run: `go test ./...` em `api/`  
Run: `git diff --check`

Expected: todos os testes passam e não há erro de whitespace.

- [ ] **Step 5: Commitar documentação**

```bash
git add api/.env.example api/README.md api/deploy/README.md
git commit -m "docs(api): documentar catalogo publico de releases"
```
