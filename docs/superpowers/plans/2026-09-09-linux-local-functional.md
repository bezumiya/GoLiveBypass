# Linux Local Functional Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tornar o caminho Linux local do GoLiveBypass funcional e verificável, preservando o isolamento por aplicativo em `discord-vpn`, a restauração da rede e o caráter diagnóstico dos probes.

**Architecture:** A GUI Electron chama `standalone/golivebypass-standalone.sh` com `GOLIVE_GUI=1`. O script cria/gerencia o namespace Linux e a interface `wg-discord`; o Discord deve ser iniciado dentro do namespace sem alterar a rota padrão do host. O preflight continua somente leitura e os probes não bloqueiam a ativação.

**Tech Stack:** Bash, WireGuard/iproute2, Electron/TypeScript, Vitest e testes Linux em shell.

**Spec:** Reproduzir o estado da máquina Linux local, corrigir o primeiro defeito real encontrado no caminho GUI/preflight/ativação/status, e validar com os testes unitários e de namespace disponíveis. Se o host não tiver dependências, privilégios ou um Discord executável, registrar isso como limitação operacional e não mascará-lo com mudanças no código.

## Global Constraints

- Não modificar a rota padrão, DNS global ou tráfego de outros aplicativos.
- Não transformar handshake, IP, HTTP ou telemetria em bloqueio de ativação.
- Não remover a barreira do standalone público; a GUI deve continuar sendo o chamador autorizado (`GOLIVE_GUI=1`).
- Preservar alterações existentes e não incluir `.codex/` ou `tmp/` locais.
- Não instalar pacotes ou executar ações privilegiadas automaticamente sem evidência de que são necessárias e sem informar a limitação real.
- Usar `apply_patch` para edições e registrar fatos observados separadamente de hipóteses.

---

## Task 1: Establish the local Linux baseline

- [x] Run the standalone syntax check and inspect preflight/status in non-interactive read-only mode.
- [x] Run the focused Linux shell tests and the relevant Vitest suites, recording capability-related skips/failures.
- [x] Confirm distro, `ip`, `wg`, namespace support, elevation method, and Discord discovery without exposing credentials.

## Task 2: Fix the first reproducible Linux defect

- [x] Trace the reported path from the observed command/log to the responsible Linux helper, standalone function, or GUI integration.
- [x] Confirm that no implementation defect was reproducible: the restricted executor lacked `CAP_NET_ADMIN`, while the real host passed the same namespace tests and preflight. No code workaround was applied that would weaken isolation or hide this limitation.
- [x] No regression test was needed because the observed failure was environmental; the existing focused tests already cover the path.

## Task 3: Validate implementation and real local behavior

- [x] Run shell syntax, focused unit/regression tests, the full 52-file/412-test Vitest suite, TypeScript compilation, and the Linux AppImage build.
- [x] Run disposable namespace/WireGuard diagnostics and the one-cycle Linux stability loop on the host.
- [x] Exercise preflight/status and the packaged standalone preflight; confirm the official Discord PID is in `discord-vpn` and the host default route is unchanged.

## Task 4: Report the result

- [x] Summarize changes, commands/results, real limitations, and whether Linux is functional on this host or blocked by external state.
- [x] Leave unrelated local files untouched and do not push or publish unless explicitly requested.

## Evidence from 2026-09-09

- CachyOS host: preflight `ok=true`; `wg`, `ip`, `curl`, sudo provider, WireGuard kernel support and Discord discovery all present.
- Official Discord PID `1590514` was identified in namespace `discord-vpn`; the host route remained `default via 192.168.100.1 dev enp3s0`.
- `tests/test-linux-netns-detection.sh`, `tests/test-linux-wireguard-diagnostic.sh`, `tests/test-linux-diagnostic.sh`, `tests/test-netmode-linux.sh`, the Linux matrix and one stability-loop cycle passed with zero failures.
- The current `2.0.6-beta-6` AppImage built and started on the host. Strict `ldd` inside a minimal Arch container reported base-image libraries missing; this is kept as an audit limitation because host `ldd` found no missing libraries and the AppImage ran successfully.
- Standalone status from an independent non-interactive process cannot read WireGuard handshake without a cached sudo authorization; this remains diagnostic-only by design and did not stop the active Discord process or alter the host route.
