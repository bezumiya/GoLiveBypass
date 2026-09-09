# Plano: guarda de ativação durante o onboarding

## Escopo

Corrigir a ordem de inicialização em `goLiveBypass/index.tsx` para que a primeira execução apresente o onboarding antes de qualquer ativação automática potencialmente capaz de relançar o Discord.

## Checklist

- [x] Registrar a decisão e os invariantes no design.
- [x] Adicionar teste-fonte para a guarda de `Native.enable()`.
- [x] Condicionar a ativação automática ao onboarding concluído.
- [x] Executar testes do plugin, helper Proton, E2E e `git diff --check`.
- [x] Gerar pacote Windows e validar `testTsc`/`build` na VM sem interromper a sessão ativa.
- [x] Registrar artefato, hash, evidências e limitação no relatório de validação.

## Status

Concluído em 2026-09-09. A validação Windows foi feita sem injeção/reload; a
call/transmissão `TESTE-TELA` permaneceu ativa.
