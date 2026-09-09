# Plano: contexto no overlay de atualização

## Checklist

- [x] Registrar o contrato de exibição e os invariantes.
- [x] Adicionar regressão para versão atual, disponível e canal.
- [x] Propagar o status do updater ao toast.
- [x] Executar testes locais e `git diff --check`.
- [x] Reempacotar e validar o build Windows sem interromper a sessão ativa.
- [x] Registrar o ciclo no relatório de validação.

## Status

Concluído em 2026-09-09. A validação Windows foi feita sem injeção/reload; a
call/transmissão `TESTE-TELA` permaneceu ativa.
