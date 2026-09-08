# GoLiveBypass — API de Bug Reports

API HTTP, em Go, que recebe relatos de bug dos apps do GoLiveBypass e abre
issues no GitHub. Ela também recebe o webhook de publicação de releases e mantém
um stream SSE leve para acordar o updater da GUI imediatamente; o cliente ainda
consulta o GitHub diretamente antes de baixar qualquer artefato.

- **Stack**: Go 1.25+ · [Echo v5](https://github.com/labstack/echo/v5)
- **Dependência externa**: nenhuma além do Echo (o cliente do GitHub é stdlib)

## Como funciona

```
app (GUI/standalone)                       API (este serviço)              GitHub
      │  POST /v1/reports                        │                              │
      │  Authorization: Bearer <API_TOKEN>       │                              │
      │  {title, description, log, meta} ───────►│  valida + monta markdown     │
      │                                          │  POST /repos/{repo}/issues ──►│
      │  201 {issue_number, issue_url} ◄─────────│◄── 201 {number, html_url}    │
      │                                          │                              │
      │  GET /v1/updates/stream (SSE) ◄─────────│                              │
      │                                          │◄── POST /v1/updates/github/webhook
      │                                          │    X-Hub-Signature-256          │
      │                              pulso release publicada ───────────────────│
```

## Setup

1. **Crie um PAT (fine-grained)** em *GitHub → Settings → Developer settings →
   Fine-grained personal access tokens*, com acesso somente ao repositório
   alvo (`Repository access → Only select repositories`) e permissão
   **Issues: write**.
2. **Crie as labels** usadas por padrão (`bug`, `gui`) no repositório alvo — sem
   elas o GitHub responde 422 e a issue não é criada. A lista vem de `ISSUE_LABELS`.
3. **Gere o token compartilhado** com os apps (`API_TOKEN`), por exemplo:
   `openssl rand -hex 32`. Este token será embutido na GUI/standalone quando
   eles ganharem o botão de reportar bug — se vazar, troque o valor e o
   segredo embutido nos apps.
4. **Gere o segredo do webhook** (`GITHUB_WEBHOOK_SECRET`), por exemplo:
   `openssl rand -hex 32`. Cadastre exatamente o mesmo valor no webhook do
   repositório GitHub. Ele nunca é enviado para a GUI.

### Webhook de release

No repositório `bezumiya/GoLiveBypass`, abra *Settings → Webhooks → Add webhook*
e configure:

- Payload URL: `https://api.skyplaceia.com/bugs/v1/updates/github/webhook`
- Content type: `application/json`
- Secret: o valor de `GITHUB_WEBHOOK_SECRET`
- Eventos: somente **Release**, com **Active** marcado

A API aceita apenas o evento `published`, não-draft, do repositório configurado.
Entrega repetida é ignorada pelo `X-GitHub-Delivery`; falhas de assinatura
respondem `401`.

O webhook é o caminho imediato. Como redundância, a API consulta as releases
publicadas a cada 30 segundos e distribui a maior tag SemVer válida pelo mesmo
broker SSE se o webhook estiver ausente ou atrasado. O broker rejeita eventos
iguais ou inferiores à última tag aceita, portanto um webhook atrasado não pode
rebaixar o replay para uma beta antiga.

## Rodando

```sh
cd api
go run ./cmd/api        # exige API_TOKEN, GITHUB_TOKEN e GITHUB_WEBHOOK_SECRET
```

Variáveis (todas em `.env.example`):

| Variável | Obrig. | Padrão | Descrição |
|---|---|---|---|
| `API_TOKEN` | sim | — | segredo compartilhado com os apps (Bearer) |
| `GITHUB_TOKEN` | sim | — | PAT com permissão Issues: write no repo alvo |
| `GITHUB_WEBHOOK_SECRET` | sim | — | segredo HMAC do webhook de Release |
| `GITHUB_REPO` | não | `bezumiya/GoLiveBypass` | `owner/repo` da issue e do webhook |
| `ISSUE_LABELS` | não | `bug,gui` | labels separadas por vírgula (precisam existir no repo) |
| `PORT` | não | `8080` | porta HTTP |
| `RATE_LIMIT` | não | `10` | requisições por minuto por IP |
| `MAX_LOG_BYTES` | não | `262144` | teto do campo `log` (256 KB) |
| `LOG_LEVEL` | não | `info` | `debug`, `info`, `warn`, `error` |
| `BASE_PATH` | não | vazio | prefixo quando atrás de proxy, ex.: `bugs` |

### Testar com curl

```sh
curl -s localhost:8080/healthz

# sem token → 401
curl -s -X POST localhost:8080/v1/reports -d '{"title":"x"}'

# validação → 400
curl -s -X POST localhost:8080/v1/reports -H 'Authorization: Bearer <API_TOKEN>' \
  -d '{"title":""}'

# com token fake → 502 (chega no GitHub e falha na auth) — confirma o fluxo
API_TOKEN=dev GITHUB_TOKEN=fake GITHUB_WEBHOOK_SECRET=dev-secret GITHUB_REPO=bezumiya/GoLiveBypass go run ./cmd/api
curl -s -X POST localhost:8080/v1/reports -H 'Authorization: Bearer dev' \
  -d '{"title":"Teste","log":"linha do log","meta":{"app":"cli","os":"linux"}}'

# stream de releases; fica aberto e envia heartbeat a cada 20s
curl -N localhost:8080/v1/updates/stream
```

### Docker

```sh
docker build -t golive-api api
docker run --rm -p 8080:8080 \
  -e API_TOKEN=... -e GITHUB_TOKEN=... \
  -e GITHUB_WEBHOOK_SECRET=... \
  -e GITHUB_REPO=bezumiya/GoLiveBypass \
  golive-api
```

## Endpoints

### `POST /v1/reports`

Body (JSON):

```json
{
  "title": "Go Live não sobe após atualização",
  "description": "passos de reprodução...",
  "log": "====\nabrindo | win32 x64 | electron 42...",
  "meta": { "app": "golive-gui", "version": "1.2.0", "os": "linux x64" }
}
```

- `title` — obrigatório, até 200 caracteres (espaços nas bordas são removidos).
- `description` — opcional, até 8 KB.
- `log` — opcional; truncado em `MAX_LOG_BYTES`; o conteúdo é neutralizado para
  não quebrar o bloco de código da issue.
- `meta` — opcional; pares `chave: valor` exibidos numa tabela na issue.

Resposta `201`:

```json
{ "issue_number": 123, "issue_url": "https://github.com/.../issues/123" }
```

### `GET /healthz`

`200 {"status":"ok"}` — sem autenticação, para healthcheck.

### `POST /v1/updates/github/webhook`

Rota pública para o GitHub, protegida por `X-Hub-Signature-256` com
`GITHUB_WEBHOOK_SECRET`. Recebe apenas o evento **Release** publicado do
`GITHUB_REPO` e responde `202` quando um pulso novo foi distribuído. Eventos
não relevantes e deliveries repetidas respondem `204`.

### `GET /v1/updates/stream`

Stream público `text/event-stream`, sem token embutido no cliente. Mantém até
100 conexões, com no máximo 2 por IP, envia heartbeat a cada 20 segundos e
reentrega o último release para uma conexão nova. O evento contém somente tag,
status de prerelease e data; URL e digest continuam sendo consultados pela GUI
diretamente no GitHub.

## Erros

| Status | Quando | Body |
|---|---|---|
| `400` | payload inválido (JSON, title, tamanhos) | `{"error": "..."}` |
| `401` | token ausente ou errado | `{"error": "..."}` |
| `413` | corpo acima de 512 KB | `{"error": "..."}` |
| `429` | rate limit por IP excedido (header `Retry-After`) | `{"error": "..."}` |
| `404` / `405` | rota/método inexistente | `{"error": "..."}` |
| `502` | o GitHub recusou (auth, label inexistente, etc.) | detalhe só no log do servidor |

## Operação

- **TLS termina no reverse proxy** (Caddy, nginx, Traefik) — a API não fala
  TLS sozinha. Atrás do proxy, o rate limit usa o IP real do cliente por
  `X-Forwarded-For` (o Echo só confia em XFF vindo de IP de loopback ou rede
  privada).
- **Rate limit em memória**: suficiente para uma instância; com várias
  instâncias atrás de um load balancer, cada uma tem a própria contagem e o
  Redis seria o próximo passo (fora de escopo por enquanto).
- **Pulso de update em memória**: se a API reiniciar, clientes reconectam e a
  GUI consulta o GitHub no boot e no fallback horário; nenhum update depende
  exclusivamente do webhook.
- Desligamento gracioso em `SIGINT`/`SIGTERM` (até 10 s para requisições em
  andamento). Streams SSE são encerrados nessa janela e reconectam sozinhos.

## Testes

```sh
cd api
go vet ./...
go test ./...
```

Cobertura: validação do payload e montagem do markdown (`internal/bugreport`),
cliente GitHub contra um fake HTTP (`internal/gh`), e os endpoints completos
com auth, rate limit, body limit e erros (`internal/server`).

## Integração (GUI)

A GUI Electron usa esta API: o botão **"Reportar bug"** coleta `gui.log` +
`golivebypass.log` + ring buffer, redige em camadas (L1 regex, L2 segredos
literais da proxy, L3 varredura final com bloqueio) e chama `POST /v1/reports`
com o `API_TOKEN` embutido ou configurado (`electron/bugreport.ts`). A resposta
traz a URL da issue para mostrar ao usuário. Logs são cortados para 256 KB,
corpo total limitado a 512 KB, rate limit 60/min por IP.

Para apontar a GUI para sua própria instância, coloque em
`settings.json` (ao lado do executável / `%LOCALAPPDATA%\GoLiveBypass\`):

```json
{
  "bugReportApiUrl": "https://sua-api.exemplo.com",
  "bugReportToken": "<mesmo valor de API_TOKEN>"
}
```

(ou as variáveis de ambiente `GOLIVE_BUG_API_URL` / `GOLIVE_BUG_API_TOKEN`).
Sem isso, a GUI cai no formulário `github.com/.../issues/new` com o diagnóstico
no clipboard.
