# Guarda de geração no lifecycle do plugin

Data: 2026-09-09

## Problema

`start()` dispara operações assíncronas no renderer (`getPluginUpdateStatus`,
`Native.enable()` e a abertura atrasada do onboarding). Se o plugin for
desativado enquanto uma dessas operações aguarda IPC, a resposta pode chegar
depois de `stop()` e exibir um toast ou abrir um modal em um plugin já
desmontado. A operação nativa de rede deve continuar sendo encerrada pelo
`shutdown()` existente; o problema deste ciclo é o efeito tardio na UI e no
diagnóstico do renderer.

## Objetivos

- Invalidar respostas e timers associados a uma execução anterior de `start()`.
- Impedir toast de erro/sucesso e abertura do onboarding depois de `stop()`.
- Invalidar também a execução anterior quando `start()` for chamado novamente
  antes de um `stop()` completo.
- Preservar a ativação, o shutdown, o isolamento WireGuard e a persistência sem
  introduzir cancelamento agressivo ou novas chamadas privilegiadas.

## Não objetivos

- Não cancelar promises IPC já enviadas.
- Não alterar o contrato nativo, a sessão Proton, o updater, a rota ou o
  comportamento visual enquanto o lifecycle ainda estiver ativo.
- Não transformar o `stop()` em uma prova de que a rota já foi restaurada; isso
  continua pertencendo ao controller nativo.

## Design

`index.tsx` terá um contador global `pluginLifecycleGeneration`. Cada `start()`
incrementa o contador e captura sua geração local. Os callbacks assíncronos
criados por esse `start()` consultam `isLifecycleCurrent()` antes de abrir o
onboarding, emitir toasts ou registrar falhas do renderer. `stop()` incrementa
novamente o contador antes de limpar timers e solicitar o shutdown, invalidando
respostas que ainda estejam pendentes. Um novo `start()` invalida do mesmo modo
callbacks do start anterior.

O callback do timer inicial de status continuará usando o mecanismo nativo real;
apenas descartará a resposta se a geração não for mais atual. O callback de
`Native.enable()` seguirá reportando falhas enquanto o plugin estiver ativo,
mas ignorará a resposta tardia após a invalidação. O timer do onboarding terá a
mesma guarda.

## Verificação

- Adicionar regressões em `tests/test-plugin-lifecycle.mjs` exigindo a geração
  capturada em `start()`, a invalidação em `stop()` e guardas nos três caminhos
  assíncronos.
- Rodar o teste focado antes da implementação para registrar a falha.
- Rodar todos os testes de plugin, o helper Go, o E2E do userplugin e
  `git diff --check` depois da implementação.
- Empacotar a fonte final, instalar na VM Windows 11 com backup e executar
  `pnpm.cmd testTsc` e `pnpm.cmd build`.
- Registrar que a guarda é validada por fonte/lifecycle e que o runtime visual
  do updater continua limitado se a VM permanecer sem uma conta autenticada.
