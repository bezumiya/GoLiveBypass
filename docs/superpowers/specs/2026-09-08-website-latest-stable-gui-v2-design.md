# Especificação de design — release estável dinâmica e GUI v2 no site

**Data:** 2026-09-08  
**Escopo:** API Go de releases e frontend Nuxt em `website/`  
**Fora do escopo:** publicação/deploy do site ou da API, alteração do runtime da GUI Electron, migração do standalone legado ou alteração do plugin WireGuard.

## Objetivo

Manter o site distribuindo automaticamente a release estável mais recente do
GitHub, sem editar tag, versão ou nomes de assets no frontend a cada release.
O número exibido, os metadados da release e os botões de download devem apontar
para a mesma release estável.

O index também deve apresentar uma réplica visual e interativa da GUI v2 atual,
com os controles reconhecíveis da aplicação real, mas sem simular que o site
consegue ativar um túnel ou alterar o Discord do visitante.

## Decisões

### Fonte central de release

A API Go existente será a fonte intermediária entre o site e o GitHub. Ela já
possui `GITHUB_REPO`, `GITHUB_TOKEN` e o webhook de publicação de releases.

Serão adicionados endpoints públicos sob o `BASE_PATH` configurado:

- `GET /v1/releases/latest` devolve um contrato público, pequeno e sem
  credenciais, com tag, versão, título, data, URL da release e assets
  selecionados.
- `GET /v1/releases/latest/download/{asset}` resolve um alias permitido e
  responde com redirecionamento para o `browser_download_url` do asset atual.

Os aliases de download são uma lista fechada, por exemplo `windows`, `linux`,
`mac-dmg`, `mac-zip`, `plugin` e `standalone`. O servidor nunca aceitará uma
URL arbitrária de redirect enviada pelo cliente.

A consulta da API usará o endpoint do GitHub para a release mais recente. Por
definição, a fonte escolhida é a release não-draft e não-prerelease. O servidor
validará essa condição antes de publicar a resposta, além de validar o formato
de `tag_name` e a existência do asset solicitado.

### Cache e atualização

O catálogo ficará em cache em memória por um TTL curto, com mutex e uma única
consulta simultânea quando o cache expirar. Uma resposta válida anterior será
mantida como fallback temporário se uma consulta posterior falhar.

O handler existente de webhook invalidará o cache somente para evento de
release publicada estável. Uma nova visita ao site fará a API buscar a nova
release; a perda do processo ou do SSE não impede a recuperação porque o
GitHub continua sendo a fonte de verdade.

O contrato retornará apenas dados necessários para a distribuição: versão,
tag, canal `stable`, publicação, URL da release e URLs de download dos assets
encontrados. Token, headers do GitHub e detalhes internos do cache nunca saem
da API.

### Integração do site

O frontend substituirá `website/data/release.ts` como fonte fixa por um
composable compartilhado, com fallback local de emergência. O composable:

1. inicia com o fallback para a página continuar renderizando;
2. consulta a API Go no cliente após a montagem;
3. atualiza versão, canal, data e links quando recebe uma resposta válida;
4. expõe estado de carregamento/erro sem bloquear os botões;
5. mantém o link da página da release como fallback de navegação.

Os downloads principais usarão os aliases da API, não nomes de arquivo
versionados. O endpoint da API resolverá o nome real do asset no GitHub. Os
scripts de instalação continuarão apontando para suas fontes oficiais; a
documentação deixará explícito quando o caminho é GUI v2, plugin WireGuard
autônomo ou variante legada.

A API terá CORS restrito ao domínio do site e ao ambiente local de
desenvolvimento necessário. O endpoint público não reutilizará o token de
reports nem ficará dentro do rate limit de criação de issues.

## Conteúdo e arquitetura comunicada

O site deixará de descrever a GUI atual como injeção, proxy/PAC, Tor ou
roteamento apenas do gateway. O conteúdo da GUI v2 será descrito como:

- WireGuard por aplicativo;
- no Windows, WireSock como transporte/helper da GUI;
- no Linux, helper WireGuard isolado para o processo do Discord;
- o restante do computador continua usando a rede normal;
- estado ativo significa que o túnel e o processo foram iniciados, não uma
  prova geográfica de saída;
- probes de IP, HTTP e telemetria são diagnósticos e não bloqueiam a ativação;
- `app.asar` permanece vanilla.

As páginas explicarão a diferença entre a GUI atual e os caminhos legados sem
prometer paridade entre GUI, plugin e standalone. Qualquer texto sobre
plugin/standalone permanecerá condicionado ao estado real desses caminhos.

## Réplica da GUI v2 no index

`website/components/GuiViewer.vue` será refeito com namespace próprio para não
importar o CSS global da Electron. A geometria e os textos serão derivados de
`golive-gui/index.html`, mantendo a identidade da GUI:

- wordmark, versão dinâmica e tagline;
- ações de reportar bug, suporte e configurações;
- coluna da ação principal com status, botão de ativar/desativar, startup e a
  nota “Só o Discord usa o túnel”;
- cartão “Conexão segura” com abas “Proton Otimizado” e “Arquivo .conf”;
- estado demonstrativo de login Proton, plano, rota selecionada, ping/carga e
  “Otimizar rota”;
- drop zone demonstrativa para arquivo WireGuard `.conf`, com ações Importar e
  Testar;
- diálogo de configurações com tema, aviso de updates, troca automática de
  rota e canal beta;
- estados de foco, teclado, responsividade e respeito a `prefers-reduced-motion`.

O viewer não coletará credenciais, não abrirá o fluxo Proton real, não aceitará
arquivo local e não chamará a API de ativação. A ação de download será um link
real para a página de downloads; ações de configuração alteram somente o
estado local da demonstração.

## Tratamento de falhas

- GitHub indisponível: a API serve a última resposta válida em cache, se houver;
  o site mantém o fallback local e oferece a página da release.
- API sem resposta no carregamento: o site mostra a versão fallback sem
  bloquear a navegação e marca que a atualização automática não foi confirmada.
- Asset ausente na release: o alias retorna erro explícito e o frontend oferece
  a página da release, sem construir uma URL de arquivo inexistente.
- release recebida pelo webhook como prerelease ou draft: não invalida nem
  substitui o catálogo estável.
- CORS ou contrato inválido: o composable ignora a resposta e conserva o
  fallback; o erro não aparece como falha de ativação porque a página não ativa
  o túnel.

## Validação

API:

- testes unitários para decodificação, filtro de release estável, seleção de
  assets, cache, invalidação por webhook, alias desconhecido e fallback;
- `go test ./...` em `api/`.

Site:

- testes do composable/formatadores para resposta válida, erro e fallback;
- testes que confirmem que versão, metadata e downloads usam o mesmo catálogo;
- `npm test`, `npm run typecheck` e `npm run generate` em `website/`;
- inspeção visual do index e das páginas de downloads em desktop e mobile;
- `git diff --check`.

Não será considerado comprovado pelo site qualquer roteamento real, ativação do
Discord ou desempenho de túnel. Esses comportamentos continuam pertencendo às
validações da GUI e da skill de rede.

