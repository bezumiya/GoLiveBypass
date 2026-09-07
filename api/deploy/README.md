# Runbook de deploy — api.skyplaceia.com

Hospedagem da API de bug reports em container Docker isolado no servidor principal, atrás do OpenLiteSpeed (CyberPanel) que termina o TLS.

```
Internet ──443──> OpenLiteSpeed (TLS pelo CyberPanel)
                      │ rewrite [P] prefixo /bugs -> extprocessor
                      ▼
              127.0.0.1:8091 (container hardened)
                      ├──> api.github.com (cria as issues)
GitHub ──webhook───────┘
GUI ─────SSE /bugs/v1/updates/stream────> API
```

A porta 8091 fica publicada apenas em `127.0.0.1` — nenhum acesso direto externo.

**Importante**: `api.skyplaceia.com` já hospeda outros serviços (Supabase em `/`, pagamentos em `/v2`). Esta API usa o **prefixo exclusivo `/bugs`** — nada existente é alterado.

- Health: `https://api.skyplaceia.com/bugs/healthz`
- Reports: `https://api.skyplaceia.com/bugs/v1/reports`
- Webhook: `https://api.skyplaceia.com/bugs/v1/updates/github/webhook`
- Update stream: `https://api.skyplaceia.com/bugs/v1/updates/stream`

> Nota de integração dos apps clientes (GUI/standalone): a URL base passa a ser
> `https://api.skyplaceia.com/bugs` (config `BASE_PATH=bugs` no servidor) e os
> caminhos internos da API continuam `/healthz` e `/v1/reports`.

**Mecanismo de proxy**: o `context /bugs { type proxy }` do OLS repassa o path
completo (`/bugs/...`) — por isso o container recebe o prefixo e a API usa
`BASE_PATH=bugs`.

## Pré-requisitos

1. **DNS**: registro A `api.skyplaceia.com` -> IP do servidor principal.
2. **CyberPanel**: criar website `api.skyplaceia.com` e emitir SSL Let's Encrypt pelo painel.
3. **Docker** + plugin compose instalados no host.
4. Segredos:
   - `API_TOKEN`: `openssl rand -hex 32` (compartilhado com os apps clientes).
   - `GITHUB_TOKEN`: PAT fine-grained no repo `bezumiya/GoLiveBypass`, permissão **Issues: Read and write**, sem acesso a código.
   - `GITHUB_WEBHOOK_SECRET`: `openssl rand -hex 32`; o mesmo valor será cadastrado no webhook de Release.

## Passos

### 1. Preparar o `.env`

```sh
cd /caminho/para/repo/api
cp .env.example .env
chmod 600 .env
# editar .env: API_TOKEN, GITHUB_TOKEN, GITHUB_WEBHOOK_SECRET
```

### 2. Aplicar o snippet no servidor web

O vhost já existe e tem outros serviços — **adicione** (não substitua), usando o conteúdo de `deploy/openlitespeed-vhost.conf`:

1. Bloco `extProcessor golivebugapi` em `/usr/local/lsws/conf/httpd_config.conf` (nível de servidor — obrigatório: `[REWRITE] [P]` de vhost não resolve nome de host neste OLS, e os demais proxies do painel também vivem nesse nível)
2. Bloco `context /bugs { type proxy ... }` no vhost `/usr/local/lsws/conf/vhosts/api.skyplaceia.com/vhost.conf`

> Não use rewrite com flag `[P]`: neste OpenLiteSpeed falha com "Can not determine proxy host name".

Depois valide e reinicie:

```sh
/usr/local/lsws/bin/lshttpd -t && systemctl restart lsws
```

### 3. Build + subir o container

```sh
cd /caminho/para/repo/api
./deploy/deploy.sh
```

O script valida pré-requisitos, faz build, sobe o compose e espera `GET /healthz` responder em `127.0.0.1:8091`.

### 4. Cadastrar o webhook no GitHub

No repositório `bezumiya/GoLiveBypass`, em *Settings → Webhooks → Add webhook*:

- Payload URL: `https://api.skyplaceia.com/bugs/v1/updates/github/webhook`
- Content type: `application/json`
- Secret: o mesmo `GITHUB_WEBHOOK_SECRET` do `.env`
- Evento: somente **Release**; **Active** marcado

O endpoint valida a assinatura, o repositório, `action=published` e `draft=false`.
Não é necessário embutir `API_TOKEN` na conexão SSE dos clientes.

## Verificação end-to-end

```sh
# saude via HTTPS
curl -fsS https://api.skyplaceia.com/bugs/healthz
# esperado: {"status":"ok"}

# report valido -> cria issue de teste no GitHub
curl -fsS -X POST https://api.skyplaceia.com/bugs/v1/reports \
  -H "Authorization: Bearer $API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"title":"validacao deploy","description":"teste pos-deploy"}'
# esperado: 201 {"issue_number":N,"issue_url":"..."}

# stream SSE; deixe este comando aberto e publique uma release de teste para conferir o pulso
curl -i -N https://api.skyplaceia.com/bugs/v1/updates/stream

# sem token -> 401 | payload invalido -> 400 | rajada >10/min -> 429 + Retry-After

# regressao dos servicos existentes no mesmo dominio:
curl -fsS https://api.skyplaceia.com/v2/...        # pagamentos deve seguir respondendo
```

Confirme também que a renovação de cert do CyberPanel segue funcionando (`/.well-known/acme-challenge/` tem context próprio, fora do rewrite) e que os demais sites do painel não foram afetados.

## Operação

| Tarefa | Comando |
|---|---|
| Logs | `docker compose logs -f` (em `api/`) |
| Status | `docker compose ps` |
| Atualizar versão | `git pull && ./deploy/deploy.sh` |
| Reiniciar | `docker compose restart` |

### Rotação de segredos

Edite `api/.env` com os novos valores e recrie o container (as variáveis são lidas só na inicialização):

```sh
docker compose up -d --force-recreate
```

Se trocar `API_TOKEN`, coordene com a atualização nos apps clientes (GUI/standalone), senão os reports passam a receber 401.

### Rollback

```sh
cd api && docker compose down
```

Remove apenas a API; o vhost volta a servir a página padrão. Nenhum outro site do painel é afetado.

## Limitações conhecidas

- Rate limit é **em memória**: reinício do container zera os contadores.
- Sem CORS é intencional — consumo pelos apps desktop (Electron/standalone), não por browsers.
- Healthcheck interno não existe na imagem (final é `FROM scratch`, sem shell); a checagem fica no `deploy.sh` e em monitor externo apontando para `https://api.skyplaceia.com/bugs/healthz`.
- O broker de SSE é em memória. Uma reinicialização derruba os streams, mas as GUIs
  reconectam com backoff e continuam com consulta direta ao GitHub no boot e a cada hora.
