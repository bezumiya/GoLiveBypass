# Design: guarda de ativação durante o onboarding do plugin

## Contexto

O `start()` do plugin agenda o assistente inicial, mas também chama `Native.enable()` imediatamente. Como a ativação pode relançar o Discord, a primeira inicialização pode iniciar a rota — ou relançar o cliente — antes de o usuário concluir a configuração Proton/WireGuard.

## Decisão

Enquanto `settings.store.onboardingCompleted` não for `true`, o plugin apenas agenda o assistente e não chama `Native.enable()`. A ativação automática existente continua para inicializações posteriores, depois que o usuário concluiu as duas etapas. O onboarding inicial não pode ser concluído na primeira página nem fechado antes da tela final; fechar o modal pelo X não marca o onboarding como concluído e também não libera ativação automática naquela inicialização.

## Invariantes

- O assistente continua com duas etapas e não ativa a rota ao chegar na tela final.
- A conclusão só grava `onboardingCompleted` na tela final, depois da preparação ou validação da rota; não existe atalho na primeira página.
- Um assistente aberto manualmente depois da conclusão continua podendo ser fechado antes da tela final.
- O modo customizado não passa a exigir sessão Proton.
- A guarda afeta somente a chamada inicial de `Native.enable()`; atualização, telemetria, restauração de região e ações manuais do painel permanecem inalteradas.

## Aceitação

- O teste-fonte comprova que `Native.enable()` fica condicionado ao onboarding concluído.
- Toda a suíte estática do plugin, o helper Proton e o E2E do userplugin continuam passando.
- O pacote pode ser compilado para Windows e o build TypeScript/Vencord passa na VM, sem interromper a chamada/transmissão ativa.
