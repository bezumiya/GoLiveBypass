# Gate nativo do modal de onboarding — design

## Problema

`PluginOnboardingModal` é aberto manualmente pelas configurações mesmo quando a
bridge `Native` não existe. Se o onboarding ainda não estiver marcado como
concluído, o guard de fechamento trata esse modal como obrigatório e impede que
a pessoa feche a mensagem de plataforma não suportada.

## Decisão

O onboarding será obrigatório somente quando `Native` estiver disponível e
`settings.store.onboardingCompleted` não for verdadeiro:

```ts
const requiredOnOpen = Boolean(Native && settings.store.onboardingCompleted !== true);
```

O fluxo de inicialização já abre o assistente somente quando `Native` existe,
portanto a mudança não libera uma ativação antecipada. Na ausência da bridge, o
modal informativo continuará dizendo que o transporte desktop Windows x64 não
está disponível e poderá ser fechado normalmente, sem marcar a configuração como
concluída nem alterar credenciais ou rotas.

## Alternativas consideradas

- Colocar uma exceção apenas em `closeModal` quando `Native` faltar: produz o
  mesmo efeito, mas deixa a noção de “obrigatório” incoerente com o modo de
  renderização.
- Marcar o onboarding como concluído quando `Native` faltar: rejeitado, pois
  esconderia o guia caso a mesma instalação passasse a oferecer a bridge depois.

## Verificação

Adicionar uma regressão fonte em `tests/test-plugin-onboarding.mjs` que exija a
guarda fechada pela presença da bridge e mantenha a asserção de que o startup só
chama `Native.enable()` após o onboarding. Rodar todos os testes do plugin, o
helper Go, E2E do userplugin, `git diff --check`, `testTsc` e `build` na VM.

## Limites

Este ciclo não muda o comportamento da ativação WireGuard, o modo customizado,
a persistência Proton ou o updater. Não exige login Discord nem altera perfis da
VM.
