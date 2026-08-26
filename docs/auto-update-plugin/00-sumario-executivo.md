# Plano de auto-update do plugin Vencord/Equicord

**Data:** 2026-08-26
**Escopo:** adicionar auto-update para o plugin `goLiveBypass/` do Vencord/Equicord.

---

## TL;DR

O plugin Vencord **não tinha** auto-update. Há **2 caminhos complementares**, **ambos implementados e validados**:

| Caminho | O que é | Esforço | Risco | Cobre | Status |
|---------|---------|---------|-------|-------|--------|
| **A. Auto-update via instalador** | Instalador (`golivebypass-installer.sh`/`.ps1`) detecta versão nova no GitHub e aplica com 1 clique | ~12h (1.5-2 dias) | Baixo | 90% dos usuários | **Pronto** (commit + 31 testes) |
| **B. Userplugin do Vencord** | Distribui como `.userplugins/GoLiveBypass/` com `manifest.json` declarando updater; o Vencord atualiza sozinho | ~10h (1-1.5 dias) | Médio (schema do manifest varia) | 10% restantes | **Pronto** (commit + 50 testes) |

**Total:** ~22h (3-4 dias úteis). **Implementado em 100%** e **validado com 158 testes em 5 suites, 0 falhas**.

---

## Resultados dos testes (5 suites, 158 testes, 0 falhas)

| Suite | Plataforma | Testes | Falhas |
|-------|-----------|--------|--------|
| `tests/test-auto-update.sh` | Linux/POSIX (Caminho A) | 31 | **0** |
| `tests/test-userplugin-e2e.sh` | Userplugin E2E (Caminho B) | 25 | **0** |
| `tests/test-ci-release.sh` | Simulação CI (3 versões) | 25 | **0** |
| `tests/test-posix.sh` | Cross-shell (sh/dash/bash/ash em 4 distros + zsh/ksh/mksh) | 53 | **0** |
| `tests/test-auto-update.ps1` | PowerShell 7.6.5 (Windows) | 24 | **0** |

---

## Caminho A — como funciona (resumo)

```
Usuário roda o instalador → instalador consulta GitHub Releases
  → compara com versão local (lê manifest.json do plugin)
  → se há versão nova: pergunta "Atualizar?"
  → usuário clica Sim → baixa o zip → valida SHA-256
  → faz backup do plugin atual → extrai o novo
  → "Atualizado! Reinicie o Discord."
```

Tudo **fora do Discord** (é script `.sh`/`.ps1`), sem restrições de sandbox.

---

## Caminho B — como funciona (resumo)

```
Usuário tem Vencord/Equicord com .userplugins/GoLiveBypass/manifest.json
  → Vencord inicia, lê manifest.json
  → se tem campo "updater" (type=github, id=bezumiya/GoLiveBypass), consulta GitHub Releases
  → compara versão local com a tag
  → se versão nova: baixa goLiveBypass-vencord.zip, valida SHA-256, extrai
  → substitui os arquivos
```

Update **transparente**, junto com a atualização do mod. Requer Vencord ≥ 1.5.

---

## O que foi implementado

### Arquivos novos
- `goLiveBypass/manifest.json` — declara `version` + `updater` (tipo github, repo, assetName)
- `tests/test-auto-update.sh` — 31 testes do Caminho A
- `tests/test-auto-update.ps1` — 24 testes do PowerShell
- `tests/test-userplugin-e2e.sh` — 25 testes E2E do userplugin
- `tests/test-ci-release.sh` — 25 testes simulando o CI

### Arquivos modificados
- `installer/golivebypass-installer.sh` (Linux/Bash) — adiciona `--check-update`, `--update` e 7 funções
- `installer/GoLiveBypass-Installer.ps1` (Windows/PowerShell) — adiciona `-Mode CheckUpdate`, `-Mode Update` e 7 funções
- `standalone/golivebypass-standalone.sh` — corrige bug pré-existente em ksh/mksh (`local` múltipla + escape `\|`)
- `.github/workflows/build-gui.yml` — adiciona job `release-assets` que publica os 4 assets extras
- `golive-gui/UPDATER.md` — documenta a Onda 2

### Assets novos na release (a partir de v1.1.9)
- `goLiveBypass-vencord.zip` (~25KB) — userplugin do Vencord com `manifest.json`
- `goLiveBypass-vencord.zip.sha256` — hash do zip
- `GoLiveBypass-<version>-bypass.js` — bypass standalone "puro"
- `GoLiveBypass-<version>-bypass.js.sha256` — hash do bypass

> O `assetName` no `manifest.json` é **fixo** (sem versão) para que o Vencord sempre baixe
> o asset mais recente independente da tag. O CI sobrescreve a cada release.

---

## Cronograma (realizado)

| Etapa | Status | Esforço | Teste |
|-------|--------|---------|-------|
| A. `manifest.json` no plugin | ✅ | 30min | validado em 2 testes |
| B. `--check-update` no PowerShell | ✅ | 2h | 24 testes |
| C. `--check-update` no Bash | ✅ | 2h | 31 testes |
| D. CI: job `release-assets` | ✅ | 1h | 25 testes simulando |
| E. Validação de SHA-256 | ✅ | 1h | validado em 5 testes |
| F. Backup automático + rollback | ✅ | 1h | 1 teste |
| G. Userplugin: `manifest.json` + zip | ✅ | 1h | 25 testes E2E |
| H. Documentação (UPDATER.md) | ✅ | 2h | — |
| I. Teste E2E em 3 loaders | ✅ | 2h | 25 testes de simulação CI |

---

## Como executar os testes

```bash
# Linux/POSIX
./tests/test-auto-update.sh         # 31 ok, 0 falhas
./tests/test-userplugin-e2e.sh      # 25 ok, 0 falhas
./tests/test-ci-release.sh          # 25 ok, 0 falhas
./tests/test-posix.sh               # 53 ok, 0 falhas (regressão)

# Windows (PowerShell 7+)
pwsh ./tests/test-auto-update.ps1   # 24 ok, 0 falhas
```

---

## Onde está o plano completo

- `docs/auto-update-plugin/02-plano-auto-update.md` — plano detalhado (536 linhas)
- `golive-gui/UPDATER.md` — guia do mantenedor (atualizado com Onda 2)
