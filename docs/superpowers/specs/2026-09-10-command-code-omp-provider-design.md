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
