# Design: contexto no overlay de atualização do plugin

## Contexto

O updater já conhece a versão instalada, a versão preparada e o canal selecionado, mas o toast de atualização pronta mostrava apenas a versão disponível. Isso dificulta confirmar se a atualização pertence ao canal stable/beta esperado.

## Decisão

O overlay receberá `currentVersion`, `availableVersion` e `channel` do mesmo status que disparou a notificação. Ele exibirá esse resumo junto da confirmação de que o pacote foi baixado, verificado e preparado.

## Invariantes

- O overlay continua sendo informativo e oferece apenas “Depois” ou recarregamento explícito.
- Nenhuma chamada de download, instalação, `shutdown`, `quit` ou relaunch automático será adicionada ao caminho de notificação.
- O canal exibido é normalizado para `stable` ou `beta`.
- Quando a origem não informar a versão atual, o fallback é a versão compilada do plugin.

## Aceitação

- O teste-fonte comprova que o componente exibe as três informações.
- Todos os testes do plugin, o helper Proton, o E2E e o build Windows continuam passando.
