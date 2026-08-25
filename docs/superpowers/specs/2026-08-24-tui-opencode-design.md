# Design — TUI ANSI estilo OpenCode nos instaladores

**Data:** 2026-08-24
**Status:** Aprovado pelo usuário (design apresentado em seções: arquitetura + telas/fluxos; implementação aprovada)
**Objetivo:** substituir os menus `[1]/[2]/[3]` dos 4 CLIs por uma TUI interativa estilo OpenCode (dark, monospace, caixas, setas/Enter, mouse onde o terminal permite), embutida nos próprios scripts — sem binário, sem dependências novas.

## 1. Princípios

- **TUI artesanal ANSI puro**, dentro de cada script (PowerShell no Win, POSIX sh no Linux) — sem Node, sem .NET, sem pacote.
- **Visual estilo OpenCode:** background escuro, texto claro monoespaçado, caixas `┌─┐│└┘`, seleção `●/○`, input no rodapé, barra de hints `[↑↓] navegar · [Enter] escolher · [Esc] cancelar`.
- **Mouse como trade-off:** só em terminais com SGR mouse reporting (Windows Terminal, kitty, alacritty, wezterm, foot). Onde não há, cai para teclado (setas/Enter/j/k). Nunca quebra.
- **TTY interativo → TUI; sem TTY ou `-Yes/--yes` → comportamento atual (menus/flags).** Automação e testes (que rodam `--yes`) nunca entram na TUI.

## 2. Arquitetura

### 2.1 Primitivos TUI (mesma API nos 4, implementações separadas ps1/sh)

| Primitivo | Uso |
|---|---|
| `tui_is_interactive()` | `[ -t 0 ] && [ -t 1 ]` (sh) / `-not [Console]::IsInputRedirected` (ps1) |
| `tui_box` | desenha caixa com título |
| `tui_title` | header (logo + versão) |
| `tui_menu(items)` | lista selecionável `●/○` (retorna índice) |
| `tui_select(title, opts)` | menu de opções (retorna opção) |
| `tui_input(label)` | campo de texto com cursor |
| `tui_confirm(question)` | `s/N` estilizado |
| `tui_status(...)` | tela de status |
| `tui_progress(step_text)` | spinner/status de execução |

### 2.2 Eventos

- **Setas:** `Up`/`Down` / `k`/`j` movem o cursor.
- **Enter:** confirma; **Esc:** cancela/volta.
- **Mouse:** `\e[?1000h\e[?1006h` liga; interpreta `\e[<b>;<x>;<y>M`/`m` (SGR cliques); converte `y` em índice. Desliga ao sair (`\e[?1000l\e[?1006l`).

## 3. Telas por CLI

### 3.1 Instalador plugin (`installer/*`)

```
[1] Menu principal: Instalar/Atualizar · Remover plugin · Restaurar tudo · Ver status · Sair
[2] Wizard destino (se sem $root): Usar existente · Baixar outro
[3] Rede: Proxy gratuita · Tor automático · Proxy minha
[4] Input (se Proxy minha): socks5://host:porta
[5] Persistência: Permanente · Temporário
[6] Resumo + confirmação
[7] Execução com progresso (spinner) → OK
```

- `Select-Proxy`/`Select-Persistence`/`Select-Target`/`Show-ModChoice` viram `tui_select` (retornam o mesmo valor que hoje — ex.: `socks5://127.0.0.1:9060`, `''`, `$true/$false`).
- `Install-Tor` e demais ações inalteradas; só o feedback vira `tui_progress`.

### 3.2 Standalone (`standalone/*`)

```
[1] Menu: Instalar/Atualizar · Ver status · Desinstalar · Sair
[2] Rede (se instalar): Tor automático · Proxy gratuita · Proxy minha
[3] Confirmar
[4] Execução (spinner) → OK
```

- `-Mode Install` sem flags → TUI se interativo; com `-Tor`/`-Proxy`/`-Yes` → direto (flags), como hoje.
- `-Mode Status`/`Uninstall`/`Restore` sem TTY → atual; com TTY, uninstall/restore ganham `tui_confirm`.

## 4. Integração com o código existente

- As funções de domínio (instalação, Tor, settings, injeção, restore) **não mudam** — apenas os pontos de entrada de menu (`Show-MainMenu`/`main_menu`, `Select-*`, fluxo principal) passam a usar os primitivos TUI.
- Fallback: quando `tui_is_interactive()` é falso, chamamos os mesmos códigos de menu/flags de hoje (funções existentes intactas).

## 5. Erros e casos de borda

| Caso | Comportamento |
|---|---|
| Sem TTY (pipe/automação/CI) | Menus/flags atuais, sem TUI |
| `--yes`/`-Yes` | Direto (flags), nunca TUI |
| Terminal sem SGR mouse | Teclado apenas (setas/Enter/j/k) — sem erro |
| Ctrl+C durante TUI | Restaura terminal (`\e[?25h` cursor, mouse off), sai limpo |
| Terminal muito pequeno | Caixa se adapta (mín. 2 linhas de folga) ou avisa |

## 6. Verificação

- `bash -n` nos sh; parse dos ps1 (na VM Windows ou `pwsh` local se disponível).
- `tests/test-posix.sh` completa (roda sem TTY/`--yes` — garante que nada regrediu).
- Simulação de TTY no Linux: `script -qec "..."` ou pty (exercita `tui_menu`), com setas/Enter via alimentação de entrada.
- Na VM Windows: rodar o instalador em terminal interativo (ou pty via `winpty`) e navegar com setas/clique.

## 7. Arquivos

- `installer/GoLiveBypass-Installer.ps1` — TUI + fallback
- `installer/golivebypass-installer.sh` — TUI + fallback
- `standalone/GoLiveBypass-Standalone.ps1` — TUI + fallback
- `standalone/golivebypass-standalone.sh` — TUI + fallback
