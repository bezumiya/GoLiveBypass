# Supressão de duplicata manual no updater — design

## Problema

O processo principal expõe um único `lastError` para falhas automáticas e
manuais. O renderer já mostra o resultado da ação manual no card ou no toast de
erro; quando o polling seguinte observa o mesmo erro, o overlay automático pode
duplicar esse feedback.

## Decisão

O renderer manterá uma chave local de erro manual suprimida, formada pelo mesmo
canal, versão e detalhe truncado usados na deduplicação do overlay. Quando
`check` ou `update` manuais retornarem falha, registrarão essa chave. A primeira
observação posterior do mesmo erro pelo status consumirá a supressão sem abrir o
overlay. Se a mesma falha continuar na observação automática seguinte, ela será
notificada normalmente; assim, a supressão evita apenas a duplicata imediata e
não silencia uma falha persistente.

O status sem erro limpa as chaves locais. Não haverá novo campo IPC, mudança no
backend, atraso artificial, reinício ou alteração de rota.

## Alternativas consideradas

- Adicionar origem `automatic`/`manual` ao contrato nativo: rejeitado por ampliar
  IPC e persistência para resolver um problema exclusivamente de apresentação.
- Desligar o overlay depois de qualquer ação manual até recuperação: rejeitado,
  pois poderia esconder uma falha automática posterior.

## Verificação

Adicionar testes-fonte que exijam a chave comum, a supressão one-shot e chamadas
nos ramos de falha de `check`, `update` e da consulta de status. Preservar as
asserções de que o feedback manual e a ausência de ações privilegiadas continuam
intactos. Rodar suíte do plugin, helper Go, E2E, build Windows e `git diff --check`.
