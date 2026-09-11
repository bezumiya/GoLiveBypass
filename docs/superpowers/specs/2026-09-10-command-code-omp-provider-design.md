# Provedor Command Code no OMP — Especificação de design

**Data:** 2026-09-10  
**Status:** design aprovado; especificação aguardando revisão do usuário  
**Escopo:** configuração local do Oh My Pi para descoberta e uso dos modelos atuais da Command Code

## Objetivo

Adicionar a Command Code como provedor selecionável no Oh My Pi (OMP), usando o login já existente em `~/.commandcode/auth.json` e descobrindo os modelos atuais pela API oficial. A configuração não deve substituir os papéis ou modelos padrão já configurados no OMP.

A API oficial documenta os endpoints OpenAI-compatible em:

- `https://api.commandcode.ai/provider/v1/chat/completions`
- `https://api.commandcode.ai/provider/v1/models`

A consulta autenticada realizada durante a descoberta retornou 69 modelos ativos. Os IDs devem ser preservados exatamente como fornecidos pela API, inclusive namespaces, barras e sufixos como `:free`.

## Limites

- Alterar somente a configuração local do OMP em `~/.omp/agent/models.yml`.
- Não alterar `~/.omp/agent/config.yml` nem os papéis `default`, `advisor`, `task`, `smol`, `slow`, `commit`, `plan` ou `tiny`.
- Não copiar o token Command Code para `models.yml`, para o repositório ou para logs.
- Não manter uma lista manual de modelos como fonte primária.
- Não criar wrapper, proxy ou daemon local; a API já é compatível com o transporte OpenAI Completions.
- A disponibilidade dos modelos depende da sessão/login local e da API Command Code.

## Abordagens consideradas

### 1. Descoberta dinâmica via API — escolhida

Registrar um provedor `command-code` com base URL `/provider/v1`, transporte `openai-completions` e descoberta `openai-models-list`. O OMP buscará o catálogo atual via `/models` quando `omp models refresh` for executado.

A chave será obtida por comando a partir do arquivo de autenticação existente, sem persistir seu conteúdo no YAML. Essa opção evita catálogo obsoleto e não duplica credenciais.

### 2. Lista estática de modelos

Gravar os 69 IDs atuais no YAML. Embora previsível, o catálogo ficaria obsoleto e exigiria manutenção manual sempre que a Command Code alterasse a oferta.

### 3. Wrapper local

Interpor um processo próprio entre OMP e Command Code. A opção não oferece benefício: a API já expõe os endpoints necessários e o wrapper aumentaria a superfície de falha e manutenção.

## Arquitetura

O arquivo `~/.omp/agent/models.yml` receberá este provedor:

```yaml
providers:
  command-code:
    baseUrl: https://api.commandcode.ai/provider/v1
    api: openai-completions
    apiKey: "!jq -er '.apiKey | select(type == \"string\" and length > 0)' /home/pdl/.commandcode/auth.json"
    authHeader: true
    discovery:
      type: openai-models-list
      injectV1: false
```

### Autenticação

- O comando `jq -er` falha se `.apiKey` não existir, não for string ou estiver vazio.
- O OMP usará a saída do comando para formar `Authorization: Bearer <chave>`.
- A credencial permanece em `~/.commandcode/auth.json`.
- `models.yml` será protegido com modo `600`.

### Descoberta e seleção

- `baseUrl` já termina em `/v1`; `injectV1: false` evita acrescentar outro segmento.
- `omp models refresh` consultará `GET https://api.commandcode.ai/provider/v1/models`.
- O catálogo será derivado da resposta corrente da API.
- O nome completo para seleção seguirá `command-code/<id-exato>`, por exemplo:
  `command-code/deepseek/deepseek-v4-flash`.
- Metadados de raciocínio, custo ou compatibilidade não serão inventados quando a API não os fornecer.

## Fluxo de dados

```text
~/.commandcode/auth.json
        -> jq -er apiKey
        -> OMP Authorization: Bearer ...
        -> GET /provider/v1/models
        -> catálogo command-code no OMP
        -> seleção command-code/<modelo>
        -> POST /provider/v1/chat/completions
```

O `config.yml` do OMP continua sendo a fonte dos papéis atuais. O novo provedor apenas amplia as opções disponíveis para seleção explícita.

## Falhas e segurança

- Arquivo de autenticação ausente, inválido ou sem chave: o comando de chave falha explicitamente; não enviar `null` nem string vazia.
- API indisponível ou resposta de modelos inválida: `omp models refresh` deve reportar erro; não alterar papéis existentes silenciosamente.
- Modelo removido pela Command Code: deixa de aparecer após a próxima atualização do catálogo.
- IDs com `/` ou `:` permanecem sem normalização destrutiva.
- O token não será incluído em saídas de validação, commits, documentação ou mensagens.
- Nenhuma operação assume ou altera a configuração de outros provedores.

## Validação e critérios de aceite

1. `models.yml` existe no diretório configurado pelo OMP e possui o provedor `command-code`.
2. O arquivo possui modo `600`.
3. `omp models refresh` conclui sem erro usando a sessão local.
4. OMP lista 69 modelos Command Code atuais, incluindo `deepseek/deepseek-v4-flash`.
5. Uma chamada mínima pelo próprio OMP usando `command-code/deepseek/deepseek-v4-flash` retorna uma resposta.
6. `~/.omp/agent/config.yml` permanece inalterado.
7. Nenhum token aparece no arquivo de configuração criado, no diff ou na saída de validação.

## Referências

- [Command Code — documentação](https://commandcode.ai/docs)
- [Command Code — provedor OpenAI](https://commandcode.ai/docs/provider)
- [Command Code — modelos](https://commandcode.ai/docs/reference/cli/models)

---

## Revisão 2026-09-11 — provedor embutido `commandcode`

A configuração acima (provedor `command-code` com `discovery: openai-models-list` e
`api: openai-completions` para todos os ids) foi substituída. O motivo veio de uma
sondagem direta: `POST /provider/v1/chat/completions` com `claude-fable-5` responde

```
400 unsupported_model: Model "claude-fable-5" must be called via
/provider/v1/messages (Anthropic Messages shape).
```

O OMP já traz o provedor `commandcode` embutido, que fixa o transporte por id
(Claude → `/provider/v1/messages`, demais → `/provider/v1/chat/completions`), aplica o
contrato do deployment em `providers/commandcode.kdl` (efforts, preços, limites) e usa
`skipCrossProviderReferenceFills`, evitando herdar metadados de outros hosts. O provedor
custom herdava ladders de terceiros (ex.: Claude com `minimal..high`, Kimi/MiMo/zai com
dial inexistente) e não servia os ids Claude.

### Estado atual

- `~/.omp/agent/config.yml`: papéis `default`, `smol`, `slow`, `tiny` e `vision` apontam
  para `commandcode/<id>`; os demais papéis não mudaram.
- `~/.omp/agent/models.yml`: apenas `providers.commandcode.apiKey` (via `jq` sobre
  `~/.commandcode/auth.json`) e `modelOverrides` verificados contra o registro do
  `command-code@1.53.0` instalado (`dist/cli.mjs`), que é a fonte do que o próprio CLI
  envia. Nada de lista manual de modelos: o catálogo continua vindo de `/provider/v1/models`.

Correções aplicadas (49 overrides):

| Campo | Ids | Correção |
|---|---|---|
| `thinking.efforts` | `deepseek/deepseek-v4.1-flash` | `-` → `low,high,max` |
| `thinking.efforts` | `MiniMaxAI/MiniMax-M3` | `-` → `low,medium,high` |
| `thinking.efforts` | `meta/muse-spark-1.1/1.2/1.2-contributor/1.3-contributor` | `+minimal` → `low,medium,high,xhigh` |
| `thinking.efforts` | `meta/muse-spark-1.3` | → `low,medium,high,xhigh,max` |
| `input` | 50 ids com visão no CLI | `text` → `text,image` |
| `contextWindow` | `gpt-5.4` 1M→400K, `Qwen/Qwen3.7-Flash` 32K→1M, `Qwen/Qwen3.7-Plus` 256K→1M, `xai/grok-4.6` 200K→500K | janela informada por `GET /provider/v1/models` |

### Verificação

- `omp models commandcode --json` comparado id a id com o registro do CLI: zero divergência
  de `efforts` e de modalidades declaradas (fora da classe DeepSeek, ver limitações).
- Corpo on-wire capturado por um stub local: `--thinking max` → `reasoning_effort: "max"`,
  `--thinking low` → `"low"`, `--thinking minimal` → `"low"` (clamp, pois `minimal` não
  existe no ladder).
- Chamadas reais pelo OMP: `commandcode/deepseek/deepseek-v4.1-flash --thinking max` e
  `commandcode/Qwen/Qwen3.8-Max-0902 --thinking high` retornam 200; `claude-sonnet-4-6`
  chega ao wire Anthropic e devolve `403 MODEL_NOT_IN_PLAN` (gate de plano, não erro de rota).
- Imagens aceitas pelo Provider API: `Qwen/Qwen3.8-Max`, `xai/grok-4.5` e
  `deepseek/deepseek-v4-flash-vision-exp` respondem 200 com `image_url`; `zai-org/GLM-5.3`,
  que o CLI declara text-only, responde 400 — a tabela de modalidades do CLI confere.

### Limitações conhecidas

- Ids da classe DeepSeek sem token `vision`/`ocr` (`deepseek-v4-flash`, `-flash-fast`,
  `-v4-pro`, `v4.1-flash`) têm imagem removida no cliente pelo `classes/deepseek.kdl`;
  `stripImageInput` não é ajustável por `models.yml`, então esses ids seguem sem visão mesmo
  o CLI declarando `text,image` para o `v4.1-flash`.
- `gpt-5.3-codex` permanece com 272K no OMP (regra deliberada do KDL); API e CLI informam 400K.
- Os ids Claude e `google/gemini-3.5-flash` exigem plano Pro ou superior nesta conta
  (`MODEL_NOT_IN_PLAN`); a correção de rota não contorna o gate.
