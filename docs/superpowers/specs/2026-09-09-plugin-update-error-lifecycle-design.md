# Limpeza de deduplicação do updater no lifecycle

Data: 2026-09-09

## Problema

O renderer guarda duas chaves de erro do updater para deduplicar overlays:
`lastNotifiedUpdateErrorKey` e `lastSuppressedUpdateErrorKey`. Como elas vivem
no módulo, um erro manual ocorrido antes de `stop()` pode permanecer depois da
reativação do plugin. A primeira observação automática da mesma falha então é
consumida como se ainda fosse a observação imediatamente posterior à ação
manual, escondendo feedback que deveria reaparecer no novo lifecycle.

## Design

No início de `stop()`, depois de invalidar a geração e antes de terminar a
desmontagem, limpar as duas chaves de erro. O próximo `start()` poderá notificar
uma falha persistente uma vez; a deduplicação continua valendo dentro do
lifecycle ativo e o adiamento de atualizações preparadas permanece persistido
separadamente. Não alterar o contrato nativo, a sessão Proton, rotas ou toasts
manuais.

## Verificação

- Exigir no teste de lifecycle que `stop()` limpe ambas as chaves.
- Rodar o teste focado antes da implementação para registrar a falha e depois
  novamente para confirmar a correção.
- Repetir testes de plugin, helper Go, E2E, diff check e compilação Windows.
- Registrar a alteração junto da evidência final do ciclo.
