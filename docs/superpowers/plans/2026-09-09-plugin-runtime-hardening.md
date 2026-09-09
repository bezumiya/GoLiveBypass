# Plugin Runtime Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fechar os riscos residuais de ciclo de vida, updater e observabilidade WireGuard identificados na revisão do plugin, mantendo o Discord oficial abrindo e preservando os invariantes de rede.
**Architecture:** Correções pequenas e compatíveis nos contratos existentes de `index.tsx`, `native.ts`, `vpn-controller.ts`, `vpn-windows.ts` e `stability.ts`; sem compartilhar estado com GUI/standalone e sem alterar o transporte WireGuard.
**Tech Stack:** TypeScript/React, Vencord native bridge, Node.js tests, Go helper, Vite/Vencord build e VM Windows controlada por `vmctl.sh`.
**Spec:** `docs/superpowers/specs/2026-09-09-plugin-runtime-hardening-design.md`

## Global Constraints

- Preservar alterações existentes e não editar `golive-gui/electron/bypass.ts` manualmente.
- Não introduzir bloqueio de ativação baseado em probes, geo ou telemetria.
- Não fazer auto-reload, auto-restart, publicação, commit ou envio externo.
- Não usar credenciais reais em fixtures, logs, screenshots ou relatório.
- Cada worker edita somente os arquivos do seu bloco; o coordenador revisa o diff antes de integrar.

---

## Task 1: endurecer UI, onboarding e polling do updater

**Arquivos permitidos:** `goLiveBypass/index.tsx`, testes de UI/lifecycle e contratos GUI diretamente relacionados.

- [x] Criar helper/revisão para chamadas de status com timeout e single-flight.
- [x] Garantir que check manual e polling reflitam o resultado atual sem aceitar resposta stale.
- [x] Dar deadline e cancelamento lógico à validação customizada, liberando a UI mesmo se a native atrasar.
- [x] Adicionar semântica acessível de status/ocupação e progresso indeterminado.
- [x] Atualizar testes para hung IPC, tentativa cancelada, resposta tardia e markup acessível.
- [x] Rodar os testes focados do plugin/UI e registrar arquivos alterados.

## Task 2: endurecer consistência e recuperação do updater

**Arquivos permitidos:** `goLiveBypass/native.ts`, `goLiveBypass/update-security.ts` se necessário, testes de updater/native.

- [x] Preservar marcador pendente quando faltar backup e expor o erro sem apagar evidência.
- [x] Invalidar ou versionar `lastError`/`lastCheckedAt` ao trocar política e impedir finally stale de sobrescrever o estado.
- [x] Expor `pendingChannel` e manter o canal do marcador independente do canal selecionado.
- [x] Validar digest da árvore/source preparada ou tratar marcador legado sem essa prova como não confiável.
- [x] Fazer source instalada inválida aparecer como desconhecida para reconciliação, sem fallback enganoso.
- [x] Adicionar testes de troca de canal durante operação, backup ausente, marcador legado e fonte inválida.
- [x] Rodar a suíte focada de updater/native e registrar limitações de compatibilidade.

## Task 3: endurecer estado WireSock e estabilidade de transmissão

**Arquivos permitidos:** `goLiveBypass/vpn-controller.ts`, `goLiveBypass/vpn-windows.ts`, `goLiveBypass/stability.ts`, testes de rota/estabilidade.

- [x] Propagar `reliable=false` como desconhecido, sem classificar como bloqueio externo.
- [x] Tornar estado/mensagem coerentes quando a ausência do WireSock for confirmada.
- [x] Resetar a janela temporal após observação desconhecida.
- [x] Proteger gravação de diagnóstico assíncrono contra stop/troca de geração.
- [x] Cobrir as transições com testes direcionados e preservar ausência de bloqueio por probe.
- [x] Rodar testes de rota/estabilidade e registrar evidências.

## Task 4: revisão, integração e validação na VM

**Responsável:** coordenador.

- [x] Inspecionar os diffs do escopo do hardening contra a especificação; alterações preexistentes fora do escopo foram preservadas.
- [x] Rodar todos os testes de plugin, helper Proton, GUI, TypeScript e `git diff --check`.
- [x] Gerar pacote novo e conferir hash/tamanho sem publicar.
- [x] Instalar por share FAT na VM, executar `testTsc`, `build` e `inject`.
- [x] Abrir o Discord oficial, confirmar UI normal, plugin habilitado, painel de updater e comportamento do overlay possível sem autoaplicar atualização.
- [x] Restaurar a rede, desmontar/destruir o share e confirmar que só o disco normal permanece anexado.
- [x] Atualizar o relatório com evidência, limitações e o que ainda falta para a meta maior.

## Verificação final

- [x] Nenhuma suíte existente regrediu.
- [x] O cliente oficial abre na VM após a nova injeção.
- [x] Nenhum resultado stale mantém UI ocupada ou estado ativo incorreto.
- [x] Nenhum probe virou requisito de ativação ou prova geográfica.
- [x] O relatório separa fatos observados, correlações e hipóteses restantes.
