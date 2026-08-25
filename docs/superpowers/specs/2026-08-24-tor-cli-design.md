# Design — Tor automático nos CLIs (plugin + standalone, Windows + Linux)

**Data:** 2026-08-24
**Status:** Aprovado pelo usuário (design revisado no chat)
**Meta:** os 4 CLIs ganham o modo "Tor automático" que baixa/instala/sobe o Tor como a GUI faz, para o Discord (plugin ou standalone) conectar pelo Tor sem depender da GUI aberta.

## 1. Arquitetura geral

Os 4 scripts são auto-contidos (sem funções compartilhadas, cada um roda sem dependências). Rotina espelhada `.ps1` ↔ `.sh`:

```
1. Porta 127.0.0.1:9060 viva?        → reusa (pode ser o Tor da GUI, que morre com ela)
2. Tor do sistema rodando?           → reusa (portas 9050/9150/9250/9052)
3. Baixa expert bundle 13.5          → archive.torproject.org/tor-package-archive/torbrowser/13.5/...
   (exatamente a URL + SHA-256 da GUI: golive-gui/electron/main.ts → TOR_BUNDLE/TOR_SHA256)
4. Confere SHA-256, extrai           → Windows: %LOCALAPPDATA%\GoLiveBypass\Tor\
                                      Linux: $XDG_DATA_HOME/GoLiveBypass/Tor ou ~/.local/share/GoLiveBypass/Tor
5. Registra como serviço persistente → Windows: tor.exe --service install (+ Run key sem admin)
                                      Linux: systemd user unit (ou system com sudo)
6. Valida (TCP 127.0.0.1:9060 + túnel SOCKS5 até gateway.discord.gg:443) → grava settings
```

**Porta:** `9060` (constante `TOR_PORTA` da GUI). torrc gerado: `SocksPort 9060`, `DataDirectory` absoluto, `GeoIPFile`/`GeoIPv6File` (se existirem), `Log notice stdout` — espelhando o spawnTor da GUI.

## 2. Plugin Vencord/Equicord (`installer/` + `goLiveBypass/`)

### 2.1 `installer/GoLiveBypass-Installer.ps1` / `installer/golivebypass-installer.sh`
- Menu `[2]` muda de "Tor local (você precisa ter o Tor)" → **"Tor automático (instala e sobe sozinho)"**.
- Ao escolher: chama rotina de instalação; sucesso → grava `plugins.GoLiveBypass.proxy = socks5://127.0.0.1:9060`; falha (download/SHA/serviço) → avisa e cai para gratuitas (`proxy = ""`).
- Novas funções: `.ps1`: `Get-TorAsset` (URL+nome+sha), `Install-Tor`, `Test-TorReady`; `.sh`: `tor_asset`, `ensure_tor`, `tor_ready`.
- Uninstall do plugin: para/desabilita o serviço do Tor (se foi ele quem instalou).

### 2.2 `goLiveBypass/native.ts`
- `TOR_PORTS`: `[9052, 9150, 9050, 9250]` → **`[9060, 9052, 9150, 9050, 9250]`** (nosso Tor primeiro).
- `torExit()` e demais lógica: **sem mudança** (já tenta lista na ordem).
- Com `proxy` preenchido, o plugin usa a saída manual (o Tor instalado). Se o Tor cair: gateway **segura** (nunca vaza direto) — comportamento já existente para saída manual.

## 3. Standalone (`standalone/`)

### 3.1 `standalone/GoLiveBypass-Standalone.ps1`
- Flag `-Tor` → chama `Install-Tor`.
- `Install-Patcher` grava `settings.json` com `routeMode: "tor"`, `torAddr: "127.0.0.1:9060"` (além de `enabled`/`excludedCountries`), quando `-Tor`; caso contrário, mantém comportamento atual (só preserva).
- `-Uninstall` remove o serviço (Run key).

### 3.2 `standalone/golivebypass-standalone.sh`
- Flag `--tor` → chama `ensure_tor`.
- `install_patcher` grava `routeMode: "tor"` + `torAddr: "127.0.0.1:9060"` **definidos** (hoje só preserva) quando `--tor`.
- Uninstall remove a unit.
- Elevação sudo já existente → unit **system** com `User=<SUDO_USER>` quando sem systemd user.

### 3.3 `standalone/golivebypass.js`
- **Sem mudanças.** Já lê `routeMode`/`torAddr` e segura o gateway até o Tor responder.

## 4. Serviço persistente (detalhe)

- **Windows:** preferido `tor.exe --service install --service start` (admin). Sem admin → fallback **Run key** `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` com `GoLiveBypassTor = tor.exe -f <torrc>` — sobe no logon, sem privilégio.
- **Linux:** unit **user** `~/.config/systemd/user/golivebypass-tor.service` (`systemctl --user enable --now`). Se elevado (sudo) e sem systemd user → unit **system** `/etc/systemd/system/golivebypass-tor.service` com `User=<SUDO_USER>`. Último recurso (sem systemd): `nohup` + aviso de que não sobrevive ao boot.
- DataDirectory: `.../GoLiveBypass/Tor/data-state`.

## 5. Erros e casos de borda

| Caso | Comportamento |
|---|---|
| Porta 9060 ocupada (Tor da GUI) | Reusa; log avisa que o Tor é da GUI e morre com ela |
| SHA-256 não confere | Apaga arquivo, aborta, **não** registra serviço; plugin cai para gratuitas, standalone avisa |
| Download sem internet | Mesmo fallback |
| Serviço não sobe | Lê log em `GoLiveBypass/Tor/`, mostra erro claro |
| Tor caiu no meio | Gateway segura (nunca direto) — já existente |

## 6. Verificação

- `bash -n` nos `.sh`; parse do `.ps1` com `pwsh`.
- **Linux (niri):** `--tor` standalone → `systemctl --user status golivebypass-tor`, `ss -tlnp | grep 9060`, conferir `settings.json`; plugin installer `[2]` → settings do mod + serviço; uninstall remove tudo.
- **Windows (VM):** `-Tor` standalone + plugin `[2]` → conferir serviço/Run key, `settings.json`, Discord conectando roteado.
- **Sem rebuild de bundling:** `native.ts` entra via `pnpm build` do mod; instaladores são assets soltos; `golivebypass.js` não muda (não precisa `sync-bypass`).

## 7. Arquivos a modificar

- `installer/GoLiveBypass-Installer.ps1`
- `installer/golivebypass-installer.sh`
- `goLiveBypass/native.ts`
- `standalone/GoLiveBypass-Standalone.ps1`
- `standalone/golivebypass-standalone.sh`
- `standalone/golivebypass.js` — **só legibilidade/nenhuma mudança** (confirmar que não precisa)

## 8. Referências (constantes da GUI a reusar)

- `golive-gui/electron/main.ts`:
  - `TOR_BUNDLE = "13.5"`
  - `TOR_PORTA = 9060`
  - `TOR_SHA256` (4 entradas: linux-x86_64, windows-x86_64, macos-aarch64, macos-x86_64)
  - `torAsset()` → base `https://archive.torproject.org/tor-package-archive/torbrowser/13.5/`
  - `ensureTor()` → SHA-256 antes de gravar/extrair; `tar -xzf ... --exclude tor/pluggable_transports/* --exclude debug/* data tor`
  - `spawnTor()` → torrc: SocksPort 9060 / DataDirectory / GeoIP / GeoIPv6 / Log notice
