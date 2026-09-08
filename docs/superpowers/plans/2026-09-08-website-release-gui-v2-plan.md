# Website Release and GUI v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fazer o site consumir o catálogo de release estável da API Go, manter downloads sempre apontando para a release atual e apresentar no index uma réplica demonstrativa da GUI v2 alinhada à arquitetura WireGuard por aplicativo.

**Architecture:** `website/data/release.ts` terá somente contrato, aliases e fallback de emergência. `useRelease()` manterá um estado Nuxt compartilhado, começará pelo fallback e atualizará o catálogo via API Go no cliente; os links de download continuarão usando aliases da API para permanecerem atuais depois de uma nova publicação. O `GuiViewer` será um componente Vue isolado, visualmente derivado de `golive-gui/index.html` e sem chamadas de ativação.

**Tech Stack:** Nuxt 3, Vue 3 Composition API, TypeScript, Vitest, CSS scoped/global existente.

**Spec:** `docs/superpowers/specs/2026-09-08-website-latest-stable-gui-v2-design.md`

## Global Constraints

- “Os downloads principais usarão os aliases da API, não nomes de arquivo versionados.”
- “O composable inicia com o fallback para a página continuar renderizando.”
- “O viewer não coletará credenciais, não abrirá o fluxo Proton real, não aceitará arquivo local e não chamará a API de ativação.”
- A página só oferecerá a release estável; prerelease/beta não aparecerá no catálogo principal.
- Descrições não podem afirmar proxy/PAC, injeção, gateway seletivo ou mídia direta como arquitetura da GUI v2.
- A réplica deve dizer claramente que ações no site são demonstrativas.
- Preservar tema claro/escuro, foco visível, responsividade e preferência de movimento reduzido.
- Não alterar `golive-gui/`, `standalone/` ou `goLiveBypass/` nesta etapa.

## Mapa de arquivos

- Modify `website/data/release.ts`: tipos, endpoint da API, fallback 2.0.4 e helpers de alias/raw URL.
- Create `website/composables/useRelease.ts`: fetch client-side, validação e estado compartilhado.
- Modify `website/nuxt.config.ts`: runtime config público para sobrescrever a base da API em desenvolvimento/deploy.
- Modify `website/tests/release.test.ts`: contrato, parser, fallback e aliases.
- Modify `website/components/GuiViewer.vue`: réplica completa da GUI v2 e estados demonstrativos.
- Modify `website/components/BaseIcon.vue`: ícones necessários para ações que não existem no sistema atual.
- Modify `website/components/AppFooter.vue`, `website/components/StatusPanel.vue`: versão dinâmica e linguagem atual.
- Modify `website/pages/index.vue`: hero, badge, arquitetura visual e FAQ preview atualizados.
- Modify `website/pages/downloads.vue`: catálogo/metadata dinâmicos, GUI para três plataformas e caminhos condicionados.
- Modify `website/pages/como-funciona.vue`: explicação WireGuard por aplicativo e limites honestos.
- Modify `website/pages/instalacao.vue`: passos da GUI v2 e aviso separado para legado.
- Modify `website/pages/faq.vue`: perguntas sem premissas de proxy/PAC/injeção.
- Modify `website/assets/css/main.css`: apenas estilos das seções do index que mudarem de semântica.
- Modify `website/README.md`: remover instrução de edição manual e documentar endpoint/configuração.

### Task 1: Definir o contrato de release e os helpers de links

**Files:**
- Modify: `website/data/release.ts`
- Modify: `website/nuxt.config.ts`
- Test: `website/tests/release.test.ts`

**Interfaces:**
- Produces `ReleaseAssetKey = 'windowsGui' | 'macDmg' | 'macZip' | 'linuxGui' | 'plugin' | 'pluginSha' | 'standaloneJs' | 'standaloneSha'`.
- Produces `ReleaseCatalog`, `ReleaseAsset` e `ReleaseLoadStatus`.
- Produces `defaultReleaseCatalog` com a release estável conhecida 2.0.4 somente como fallback.
- Produces `releaseApiBaseUrl(runtimeConfig?)`, `releaseCatalogUrl(runtimeConfig?)`, `releaseDownloadAliasUrl(key, runtimeConfig?)`, `githubRawUrl(path)` e `parseReleaseCatalog(input)`.

O contrato frontend será:

```ts
export type ReleaseAssetKey =
  | 'windowsGui'
  | 'macDmg'
  | 'macZip'
  | 'linuxGui'
  | 'plugin'
  | 'pluginSha'
  | 'standaloneJs'
  | 'standaloneSha'

export type ReleaseAsset = { name: string; url: string }

export type ReleaseCatalog = {
  tag: string
  version: string
  name: string
  channel: 'stable'
  publishedAt: string
  pageUrl: string
  stale?: boolean
  assets: Partial<Record<ReleaseAssetKey, ReleaseAsset>>
}

export type ReleaseLoadStatus = 'fallback' | 'loading' | 'ready' | 'stale' | 'error'
```

- [ ] **Step 1: Substituir o teste de URL versionada por testes do contrato**

Atualizar `website/tests/release.test.ts` para validar:

```ts
it('aceita somente o contrato estável da API', () => {
  const catalog = parseReleaseCatalog({
    tag: 'v2.0.4',
    version: '2.0.4',
    name: 'GoLiveBypass 2.0.4',
    channel: 'stable',
    published_at: '2026-09-05T16:40:08Z',
    page_url: 'https://github.com/bezumiya/GoLiveBypass/releases/tag/v2.0.4',
    assets: {
      windows: { name: 'GoLiveBypass-2.0.4.exe', url: 'https://objects.example/windows.exe' },
    },
  })
  expect(catalog.version).toBe('2.0.4')
  expect(catalog.assets.windowsGui?.name).toBe('GoLiveBypass-2.0.4.exe')
})

it('rejeita resposta beta', () => {
  expect(() => parseReleaseCatalog({ channel: 'beta', version: '2.0.5-beta.1' })).toThrow()
})

it('monta aliases sem depender da tag atual', () => {
  expect(releaseDownloadAliasUrl('windowsGui')).toContain('/v1/releases/latest/download/windows')
  expect(releaseDownloadAliasUrl('linuxGui')).toContain('/v1/releases/latest/download/linux')
})
```

Adicionar testes para `published_at` → `publishedAt`, `page_url` → `pageUrl`, asset ausente e rejeição de URL que não começa com `https://`.

- [ ] **Step 2: Rodar o teste para confirmar a falha**

Run: `npm test -- tests/release.test.ts` em `website/`

Expected: FAIL porque o parser e os aliases novos ainda não existem.

- [ ] **Step 3: Implementar o contrato e o fallback**

Manter `owner` e `repo` como constantes do projeto. O fallback deve conter os assets reais conhecidos de 2.0.4 e a página da release, mas os links de botão devem ser gerados pelos aliases da API. `parseReleaseCatalog` deve validar:

- tag no formato `v?MAJOR.MINOR.PATCH` sem hífen;
- `channel === 'stable'`;
- `version` sem prerelease;
- URL da página e dos assets em HTTPS;
- nomes de assets não vazios;
- assets convertidos do contrato API (`windows` → `windowsGui`, `mac-dmg` → `macDmg`, `mac-zip` → `macZip`, `linux` → `linuxGui`, `plugin`, `plugin-sha`, `standalone`, `standalone-sha`).

Adicionar em `nuxt.config.ts`:

```ts
runtimeConfig: {
  public: {
    releaseApiBaseUrl: process.env.NUXT_PUBLIC_RELEASE_API_BASE_URL || 'https://api.skyplaceia.com/bugs',
  },
},
```

- [ ] **Step 4: Rodar os testes para confirmar a passagem**

Run: `npm test -- tests/release.test.ts`

Expected: PASS.

- [ ] **Step 5: Commitar a unidade**

```bash
git add website/data/release.ts website/nuxt.config.ts website/tests/release.test.ts
git commit -m "feat(site): definir catalogo dinamico de releases"
```

### Task 2: Criar `useRelease` com fallback e atualização no cliente

**Files:**
- Create: `website/composables/useRelease.ts`
- Modify: `website/tests/release.test.ts`

**Interfaces:**
- Consumes `ReleaseCatalog`, `defaultReleaseCatalog`, `parseReleaseCatalog` e `releaseCatalogUrl` de Task 1.
- Produces `useRelease(): { release: Readonly<Ref<ReleaseCatalog>>; status: Readonly<Ref<ReleaseLoadStatus>>; refresh: () => Promise<void> }`.

- [ ] **Step 1: Escrever testes para estado e parser de resposta**

Como o projeto não usa Vue Test Utils, testar as funções puras exportadas do composable (`normalizeApiRelease`, `releaseStatusFromCatalog`) e manter o fluxo de `useState` coberto pelo `npm run typecheck`/ `generate`. Os testes devem exigir:

```ts
it('marca resposta stale sem perder a versão', () => {
  const catalog = normalizeApiRelease({ ...validApiRelease, stale: true })
  expect(catalog.stale).toBe(true)
  expect(releaseStatusFromCatalog(catalog)).toBe('stale')
})

it('rejeita resposta com canal beta', () => {
  expect(() => normalizeApiRelease({ ...validApiRelease, channel: 'beta' })).toThrow()
})
```

- [ ] **Step 2: Rodar o teste para confirmar a falha**

Run: `npm test -- tests/release.test.ts`

Expected: FAIL porque o composable e seus helpers não existem.

- [ ] **Step 3: Implementar o composable compartilhado**

Usar `useState` com chaves `release-catalog`, `release-status` e `release-catalog-checked`. O estado inicial é `fallback`; `refresh` deve:

1. retornar cedo se já houver request concluída ou em andamento;
2. marcar `loading`;
3. chamar `$fetch<unknown>(releaseCatalogUrl(useRuntimeConfig()))` somente no cliente;
4. validar via `normalizeApiRelease`/ `parseReleaseCatalog`;
5. armazenar `ready` ou `stale`;
6. em erro, manter catálogo anterior, marcar `error` e não lançar para o template;
7. marcar `checked` no `finally`.

Registrar `onMounted(() => refresh())`. O composable não deve chamar o endpoint durante geração SSR; o HTML inicial renderiza o fallback e o cliente o atualiza.

- [ ] **Step 4: Rodar testes e typecheck**

Run: `npm test -- tests/release.test.ts`  
Run: `npm run typecheck`

Expected: PASS sem erros TypeScript.

- [ ] **Step 5: Commitar a unidade**

```bash
git add website/composables/useRelease.ts website/tests/release.test.ts
git commit -m "feat(site): atualizar release no carregamento"
```

### Task 3: Conectar versão e downloads ao catálogo em todas as páginas

**Files:**
- Modify: `website/pages/index.vue`
- Modify: `website/pages/downloads.vue`
- Modify: `website/pages/instalacao.vue`
- Modify: `website/pages/como-funciona.vue`
- Modify: `website/pages/faq.vue`
- Modify: `website/components/AppFooter.vue`
- Modify: `website/components/StatusPanel.vue`
- Modify: `website/components/DownloadCard.vue`

**Interfaces:**
- Consumes `useRelease()` e `releaseDownloadAliasUrl()` de Tasks 1–2.
- Todos os usos de `release.version`, `release.tag`, `downloads.windowsGui` e `githubReleasePageUrl` fixos devem desaparecer dos templates.

- [ ] **Step 1: Atualizar teste/grep de regressão antes da edição**

Adicionar uma verificação no teste de release que leia os arquivos de página e garanta que os caminhos principais não contenham `/releases/download/v2.0.1/`, `release.tag` ou `downloads.windowsGui`. O teste também deve exigir a presença de `/v1/releases/latest/download/` no `downloads.vue`.

- [ ] **Step 2: Rodar o teste para confirmar a falha**

Run: `npm test -- tests/release.test.ts`

Expected: FAIL porque as páginas ainda usam a fonte fixa.

- [ ] **Step 3: Refatorar os componentes para o composable**

Em cada componente que mostra versão usar:

```ts
const { release, status } = useRelease()
```

Em `downloads.vue`, usar aliases estáveis como `releaseDownloadAliasUrl('windowsGui')` e mostrar o nome real via `release.assets.windowsGui?.name`. Se o asset não existir, mostrar link para `release.pageUrl` em vez de inventar filename.

Trocar a mensagem de release por:

- `Release estável · v{{ release.version }}`;
- data publicada formatada em `pt-BR) quando `publishedAt` existir;
- aviso discreto “catálogo em cache” apenas para `status === 'stale'`;
- “Não foi possível confirmar a atualização automática” em `error`, mantendo o botão para a página da release.

Adicionar cards de GUI Windows, Linux e macOS usando `windowsGui`, `linuxGui`, `macDmg` e `macZip`. O texto deve chamar a GUI de “WireGuard por aplicativo” e deixar a GUI v2 como caminho recomendado.

Reescrever a seção de terminal para não prometer instaladores que no estado atual estão pausados: encaminhar para a GUI v2 e explicar que plugin WireGuard autônomo e standalone legado são caminhos separados, sujeitos à documentação/compatibilidade própria.

- [ ] **Step 4: Atualizar footer/status e links auxiliares**

`AppFooter` e `StatusPanel` devem consumir `useRelease`; o rodapé mostra `GoLiveBypass v{{ release.version }} · canal stable`. O link da página GitHub usa `release.pageUrl`; o fallback continua permitindo navegação offline.

- [ ] **Step 5: Rodar testes focados**

Run: `npm test -- tests/release.test.ts`  
Run: `npm run typecheck`

Expected: PASS; nenhuma página importa mais o objeto de downloads fixo.

- [ ] **Step 6: Commitar a integração de release**

```bash
git add website/pages website/components/AppFooter.vue website/components/StatusPanel.vue website/components/DownloadCard.vue website/tests/release.test.ts
git commit -m "feat(site): distribuir sempre a release estavel atual"
```

### Task 4: Reescrever a réplica `GuiViewer` para a GUI v2 atual

**Files:**
- Modify: `website/components/GuiViewer.vue`
- Modify: `website/components/BaseIcon.vue`
- Test: `website/tests/gui-viewer.test.ts`

**Interfaces:**
- Consumes `useRelease()` e `useTheme()` existentes.
- Produces apenas estado local de demonstração; não importa `window.api`, não chama endpoints de ativação e não lê arquivos/credenciais.

- [ ] **Step 1: Escrever um teste de contrato visual estático**

Criar `website/tests/gui-viewer.test.ts` que leia o componente em UTF-8 e exija os textos/seletores `Ação principal`, `Só o Discord usa o túnel`, `Proton Otimizado`, `Arquivo .conf`, `Otimizar rota`, `Troca automática de rota` e `Canal beta`, e rejeite `gateway · roteado`, `áudio e vídeo · direto`, `SOCKS5` e `proxy pública`.

- [ ] **Step 2: Rodar o teste para confirmar a falha**

Run: `npm test -- tests/gui-viewer.test.ts`

Expected: FAIL enquanto o viewer antigo ainda contém modos proxy/preview legados.

- [ ] **Step 3: Reescrever o script setup com estados seguros**

Implementar estes estados:

```ts
type ConnectionTab = 'proton' | 'custom'
const active = ref(false)
const startupEnabled = ref(false)
const connectionTab = ref<ConnectionTab>('proton')
const protonConnected = ref(false)
const optimizing = ref(false)
const customImported = ref(false)
const customTested = ref(false)
const settingsOpen = ref(false)
const autoUpdateEnabled = ref(true)
const autoFailoverEnabled = ref(true)
const betaEnabled = ref(false)
```

As ações devem somente alternar esses refs. `Otimizar rota` mostra “Medindo rota…” e depois “Rota otimizada”, sem chamada de rede. `Importar` alterna uma configuração demonstrativa sem `<input type=file>`. `Testar` mostra “Configuração demonstrativa válida”. O botão de reportar bug não envia nada e pode exibir a nota local “Disponível no aplicativo instalado”.

- [ ] **Step 4: Reescrever o template espelhando `golive-gui/index.html`**

Manter a estrutura e os textos reais da GUI:

1. wordmark, `Go Live · Brasil · v{{ release.version }}` e tagline;
2. três ações de canto: reportar bug, suporte e configurações;
3. `control-layout` com `bypass-column` e `connection-column`;
4. status `Pronto`/`Ativo`, botão `Ativar bypass`/`Desativar bypass`, startup e nota `Só o Discord usa o túnel`;
5. cartão `Conexão segura` com tabs acessíveis Proton/.conf;
6. painel Proton com “Conta Proton desconectada”/“Conta conectada”, “Conectar conta Proton”, plano, país, “Otimizar rota” e badge de rota;
7. painel customizado com drop zone não funcional, Importar e Testar demonstrativos;
8. footer explicando “Prévia da GUI v2. O download abre a instalação real.”;
9. diálogo de configurações com Aparência, Avisar sobre atualizações, Troca automática de rota e Canal beta.

O cartão deve mostrar “Demonstração no site” para evitar que os controles sejam confundidos com a GUI instalada.

- [ ] **Step 5: Reescrever CSS scoped com tokens da GUI real**

Substituir os estilos antigos `.gui-viewer__segmented` e `.gui-viewer__proxy-*` por namespace alinhado aos nomes da GUI: `.gui-viewer__control-layout`, `.gui-viewer__bypass-column`, `.gui-viewer__connection-column`, `.gui-viewer__vpn-mode-tabs`, `.gui-viewer__vpn-panel`, `.gui-viewer__proton-*`, `.gui-viewer__conf-*` e `.gui-viewer__settings-*`.

Usar estes tokens base:

```css
--gui-canvas: #0f0f12;
--gui-surface: #1a1a1f;
--gui-surface-muted: #232329;
--gui-ink: #e6e6ea;
--gui-ink-strong: #f5f5f7;
--gui-muted: #a6a6b0;
--gui-line: #26262d;
--gui-line-strong: #34343c;
--gui-ok-bg: #16301b;
--gui-ok-ink: #7bc98c;
--gui-go-bg: #bce0bf;
--gui-go-ink: #0f3318;
```

Manter variante `html[data-theme='light']`, foco `:focus-visible`, layouts responsivos e `@media (prefers-reduced-motion: reduce)` com transições desligadas. Não importar `golive-gui/src/style.css`, porque seus seletores globais `body`, `#app` e `html` vazariam para o site.

- [ ] **Step 6: Adicionar ícones faltantes sem dependência nova**

Se os controles exigirem ícones inexistentes, adicionar apenas paths SVG inline ao `BaseIcon.vue` para `bug`, `settings`, `bolt`, `file`, `upload`, `eye` e `check-circle`, mantendo o tipo `IconName` fechado e os atributos de acessibilidade atuais.

- [ ] **Step 7: Rodar contrato e typecheck**

Run: `npm test -- tests/gui-viewer.test.ts`  
Run: `npm run typecheck`

Expected: PASS e nenhum uso de `window.api`, `File`, senha, proxy ou URL de ativação no `GuiViewer.vue`.

- [ ] **Step 8: Commitar o viewer**

```bash
git add website/components/GuiViewer.vue website/components/BaseIcon.vue website/tests/gui-viewer.test.ts
git commit -m "feat(site): espelhar gui v2 no index"
```

### Task 5: Atualizar textos e diagramas para a arquitetura WireGuard por aplicativo

**Files:**
- Modify: `website/pages/index.vue`
- Modify: `website/pages/como-funciona.vue`
- Modify: `website/pages/instalacao.vue`
- Modify: `website/pages/faq.vue`
- Modify: `website/assets/css/main.css`
- Test: `website/tests/site-copy.test.ts`

**Interfaces:**
- Consumes o catálogo dinâmico e o `GuiViewer` de Tasks 1–4.
- Não altera o comportamento do backend nem do app; somente conteúdo e apresentação pública.

- [ ] **Step 1: Adicionar teste de copy contra premissas antigas**

Criar `website/tests/site-copy.test.ts` que leia as quatro páginas e exija as frases `WireGuard por aplicativo`, `Só o Discord usa o túnel`, `WireSock` e `app.asar permanece vanilla`. O teste deve rejeitar como arquitetura principal as frases `gateway por uma saída alternativa`, `mídia continua direta`, `injeta direto no Discord`, `proxy pública` e `PAC`.

- [ ] **Step 2: Rodar o teste para confirmar a falha**

Run: `npm test -- tests/site-copy.test.ts`

Expected: FAIL por causa do copy/diagramas atuais.

- [ ] **Step 3: Atualizar o index**

Trocar o hero para “Discord pelo túnel certo. O resto da máquina segue normal.” O `GuiViewer` será o visual principal. Substituir o diagrama gateway/mídia por:

```text
Discord ──► WireGuard por aplicativo ──► saída configurada
outros apps ───────────────────────────► rede normal do computador
```

Atualizar cards para GUI v2, conexão Proton otimizada e arquivo `.conf`, sem misturar plugin/standalone como se fossem o mesmo runtime. Atualizar o FAQ preview para “O túnel pega o computador inteiro?”, “O que é WireSock?” e “O status ativo prova o país da saída?”.

- [ ] **Step 4: Reescrever `como-funciona.vue`**

Explicar que a GUI cria/coordena um túnel WireGuard restrito ao processo do Discord; Windows usa WireSock; Linux usa helper/namespace quando aplicável; a rede normal do host continua fora do túnel; probes de IP/HTTP/telemetria são diagnóstico e não bloqueiam a ativação. Remover o fluxo Gateway → media direta.

Incluir comparação “passa pelo túnel” versus “fica na rede normal” e uma nota de que “Ativo” confirma processo/túnel iniciados, não prova geográfica.

- [ ] **Step 5: Reescrever `instalacao.vue`**

Passos da GUI:

1. baixar a release estável pela página de downloads;
2. abrir o app para Windows/Linux/macOS conforme o asset disponível;
3. escolher Proton Otimizado ou importar `.conf` na GUI instalada;
4. ativar o bypass e confirmar o status;
5. usar logs/diagnóstico se houver problema.

Remover instruções de “injeção”, reinício obrigatório do Discord e comandos que apontam para scripts atualmente pausados. Adicionar bloco separado explicando que plugin WireGuard autônomo e standalone legado não compartilham estado com a GUI e não devem ser apresentados como alternativas equivalentes.

- [ ] **Step 6: Reescrever `faq.vue`**

Usar perguntas e respostas atuais:

- “Todo o computador passa pelo túnel?” → não, somente o Discord conforme o escopo por aplicativo;
- “O que o WireSock faz?” → transporte/helper Windows da GUI;
- “A GUI altera o `app.asar`?” → não, permanece vanilla;
- “O status ativo garante uma saída estrangeira?” → não, é estado operacional;
- “Os probes bloqueiam a ativação?” → não, são diagnóstico;
- “Onde encontro beta?” → o site distribui somente a stable; beta é opt-in na GUI/GitHub.

Manter orientação de suporte sem pedir senhas, tokens ou credenciais Proton.

- [ ] **Step 7: Ajustar somente estilos necessários**

Reaproveitar o sistema editorial existente. Alterar estilos de `.route-schematic`, `.flow-diagram` e cards apenas para acomodar o novo fluxo de dois caminhos e não para criar uma identidade paralela à GUI. Garantir que o viewer ocupe a coluna visual sem overflow em 320px.

- [ ] **Step 8: Rodar testes de copy e typecheck**

Run: `npm test -- tests/site-copy.test.ts`  
Run: `npm run typecheck`

Expected: PASS, sem copy legado nas páginas públicas.

- [ ] **Step 9: Commitar o conteúdo**

```bash
git add website/pages website/assets/css/main.css website/tests/site-copy.test.ts
git commit -m "docs(site): alinhar arquitetura WireGuard por aplicativo"
```

### Task 6: Atualizar documentação do site e fazer QA final

**Files:**
- Modify: `website/README.md`
- Test: `website/tests/release.test.ts`
- Test: `website/tests/gui-viewer.test.ts`
- Test: `website/tests/site-copy.test.ts`

- [ ] **Step 1: Atualizar README**

Remover “edite `data/release.ts` para trocar tag, versão e assets”. Documentar:

- API padrão `https://api.skyplaceia.com/bugs`;
- `NUXT_PUBLIC_RELEASE_API_BASE_URL` para desenvolvimento;
- que a API resolve somente stable e os downloads usam aliases;
- fallback 2.0.4 apenas como contingência de indisponibilidade;
- comandos `npm test`, `npm run typecheck` e `npm run generate`.

- [ ] **Step 2: Rodar a suíte completa do site**

Run: `npm test` em `website/`  
Run: `npm run typecheck` em `website/`  
Run: `npm run generate` em `website/`

Expected: todos os testes passam, typecheck limpo e geração estática concluída.

- [ ] **Step 3: Fazer inspeção visual local**

Run: `npm run dev -- --host 127.0.0.1` em `website/`

Verificar no index e downloads:

- versão fallback aparece antes do fetch e a resposta da API substitui o valor;
- Windows/Linux/macOS apontam para aliases `/v1/releases/latest/download/...`;
- viewer replica as duas colunas da GUI em desktop e empilha em mobile;
- abas Proton/.conf, botão do bypass e configurações alteram somente a prévia;
- nenhum campo de senha ou seletor de arquivo é enviado pelo site;
- tema claro/escuro e foco visível funcionam;
- erro/API indisponível mantém página navegável e link da release.

- [ ] **Step 4: Rodar verificação final de diff**

Run: `git diff --check`  
Run: `git status --short`

Expected: somente alterações do site/API e documentação desta tarefa; alterações existentes do usuário em outros diretórios permanecem intocadas.

- [ ] **Step 5: Commitar documentação e QA**

```bash
git add website/README.md website/tests
git commit -m "docs(site): documentar sincronizacao automatica de releases"
```
