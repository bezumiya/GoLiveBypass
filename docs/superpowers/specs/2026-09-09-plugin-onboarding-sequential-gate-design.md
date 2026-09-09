# Design: bloqueio sequencial das duas páginas do onboarding

## Contexto

O ciclo anterior impediu a ativação automática antes do onboarding, mas a primeira
página ainda oferecia “Fazer depois”. Essa ação marcava o onboarding como concluído
sem passar pela página de rotas, contrariando o requisito de liberar o fluxo normal
somente após as duas páginas sequenciais.

## Decisão

No onboarding inicial, a única ação da página de conta/configuração é avançar para a
página de rotas. A função `complete()` continua existindo somente na tela final.
Enquanto o componente foi aberto com `onboardingCompleted !== true`, `closeModal()`
ignora tentativas de fechar o modal antes da tela final. Um onboarding reaberto após
ser concluído mantém o comportamento normal e pode ser fechado manualmente.

## Invariantes

- Proton continua sendo necessário apenas no modo Proton; o modo customizado valida
  o arquivo WireGuard sem pedir credenciais.
- Falha, cancelamento e retorno permitem nova tentativa dentro do assistente, mas não
  gravam conclusão nem liberam ativação automática.
- A conclusão não ativa nem reinicia o Discord; a ativação do túnel continua separada.
- A proteção vale somente para o onboarding inicial; não altera o painel manual,
  updater, transporte WireGuard ou ownership de WireSock.

## Aceitação

- O teste-fonte rejeita “Fazer depois” e qualquer chamada de `complete` na primeira
  página.
- O teste-fonte verifica a guarda de fechamento até `page === "ready"`.
- A suíte do plugin, o helper Proton, o E2E do userplugin e o build Windows são
  executados; a sessão ativa na VM não é interrompida para obter evidência visual.
