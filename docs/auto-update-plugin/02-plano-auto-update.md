# Plano: Auto-update do plugin Vencord/Equicord

**Data:** 2026-08-26
**Escopo:** plano detalhado de auto-update para o plugin `goLiveBypass/` do Vencord/Equicord.
**Status atual:** o plugin **não tem** auto-update. Quem tem o plugin precisa rodar o instalador de novo (ou `git pull + pnpm build + pnpm inject`).

---

## 1. Estado atual

| Forma de distribuição | Tem auto-update? | Como atualiza hoje |
|----------------------|------------------|---------------------|
| **Plugin via `src/userplugins/`** (Vencord/Equicord) | **NÃO** | Manual: `git pull` + `pnpm install` + `pnpm build` + `pnpm inject` |
| **Plugin via instalador** (`golivebypass-installer.sh`/`.ps1`) | **NÃO** | Manual: rodar o instalador de novo. Ele **baixa do GitHub** mas só sob clique. |
| **Plugin mergeado upstream** (Equicord/Vencord oficial) | **SIM** (junto com o mod) | Usuário atualiza o Equicord/Vencord |
| **Bypass standalone** (injetado em `app.asar` do Discord) | **NÃO** | Reinstalar |
| **GUI Electron** | **SIM** | GitHub Releases (atual hoje) |

A GUI Electron já tem auto-update funcionando (`golive-gui/electron/updater.ts`). O instalador (`golivebypass-installer.sh`/`.ps1`) já consulta o GitHub para baixar o plugin — só falta avisar que há versão nova e disparar isso automaticamente.

Este plano foca no **plugin Vencord/Equicord**. O bypass standalone **não está no escopo** (o usuário optou por não tratar).

---

## 2. Decisão de design: 2 caminhos paralelos

Há **2 caminhos viáveis** para auto-update do plugin. Eles não competem — são complementares.

### Caminho A — Auto-update via instalador (recomendado, baixo risco)

O instalador (`golivebypass-installer.sh` / `GoLiveBypass-Installer.ps1`) **já baixa o plugin do GitHub hoje**. Falta:
1. Verificar se há versão nova ao rodar (e ao final do dia, em background).
2. Oferecer atualizar com 1 clique.
3. Atualizar sem perder configurações (preservar `settings.json` do Vencord, `verifiedProxy`, etc).

**Vantagens:**
- Reaproveita 100% do instalador que já existe. Nenhuma mudança no Vencord/Equicord.
- Roda **fora do Discord** (é script `.sh`/`.ps1`), sem restrições de sandbox.
- O usuário já roda o instalador 1x para instalar; rodar de novo para atualizar é natural.
- Funciona igual nos 3 SOs (Windows / macOS / Linux).

**Desvantagens:**
- Requer ação do usuário (abrir o instalador). Mas: pode ser disparado pelo tray da GUI, e o tray já existe.

### Caminho B — Userplugin do Vencord (alto risco, alto retorno)

Distribuir o plugin como **userplugin** no formato `.userplugins/GoLiveBypass/`, com `manifest.json` declarando updater. O Vencord consulta o GitHub Releases e atualiza.

**Vantagens:**
- Update **transparente**, junto com a atualização do Vencord.
- Sem ação do usuário.
- Padrão moderno (Vencord ≥ 1.5 tem suporte oficial a userplugins com auto-update).

**Desvantagens:**
- Requer que o Vencord/Equicord **ative o mecanismo de auto-update de userplugin**. Hoje, em algumas versões, isso está desabilitado por padrão (por segurança).
- O tamanho do userplugin é limitado (~50MB típico). O plugin nosso é pequeno (< 100KB), então OK.
- Requer manifest.json + zip com assets. Mais CI.
- **Mecanismo exato varia** entre Vencord/Equicord/Vesktop/Equibop. Cada um tem o seu.

### Recomendação

**Implementar Caminho A primeiro** (1-2 dias, baixo risco, cobre 90% dos casos).
**Implementar Caminho B depois** (2-3 dias, alto retorno mas requer investigação).

---

## 3. Arquitetura do Caminho A (auto-update via instalador)

### 3.1. Fluxo de uso

```
Usuário                                    Instalador                          GitHub Releases
   │                                            │                                    │
   │ 1. Roda o instalador (1x para instalar,    │                                    │
   │    Nx para atualizar)                       │                                    │
   ├───────────────────────────────────────────►│                                    │
   │                                            │                                    │
   │                                            │ 2. GET /repos/.../releases/latest  │
   │                                            ├───────────────────────────────────►│
   │                                            │                                    │
   │                                            │ 3. tag="v1.1.9", assets=[zip]     │
   │                                            │◄───────────────────────────────────┤
   │                                            │                                    │
   │ 4. "Você tem v1.1.8, há v1.1.9. Atualizar?│                                    │
   │    [Sim] [Depois] [Ignorar esta versão]"   │                                    │
   │◄───────────────────────────────────────────┤                                    │
   │                                            │                                    │
   │ 5. Usuário clica Sim                       │                                    │
   ├───────────────────────────────────────────►│                                    │
   │                                            │                                    │
   │                                            │ 6. Baixa o zip da release          │
   │                                            ├───────────────────────────────────►│
   │                                            │                                    │
   │                                            │ 7. Extrai o plugin em              │
   │                                            │    Vencord/src/userplugins/        │
   │                                            │    goLiveBypass/                   │
   │                                            │                                    │
   │                                            │ 8. Salva backup de                 │
   │                                            │    Vencord/src/userplugins/        │
   │                                            │    goLiveBypass/ → .bak/           │
   │                                            │                                    │
   │                                            │ 9. Roda pnpm install + build +     │
   │                                            │    inject no Vencord/Equicord      │
   │                                            │                                    │
   │ 10. "Atualizado! Reinicie o Discord."      │                                    │
   │◄───────────────────────────────────────────┤                                    │
```

### 3.2. Detalhes

#### Detecção de versão atual

O instalador precisa saber **qual versão está instalada**. Hoje, não tem como (o plugin não tem versão exposta).

**Solução:** adicionar um campo `version` no `manifest.json` (que o Vencord lê) ou no `package.json` (que o instalador pode ler). Se o plugin já está no `src/userplugins/goLiveBypass/`, ler o `package.json` ou o `manifest.json` lá.

```json
// Vencord/src/userplugins/goLiveBypass/package.json (novo)
{
  "name": "go-live-bypass",
  "version": "1.1.8",
  "description": "Devolve o Go Live e a câmera para contas brasileiras",
  "author": "bezumiya"
}
```

#### Detecção de versão nova

Reusar a função que o instalador já tem (`githubLatestRelease`). Está em:
- `installer/GoLiveBypass-Installer.ps1` (PowerShell)
- `installer/golivebypass-installer.sh` (Bash)

Ambas já chamam a API do GitHub para descobrir a release. Falta **comparar com a versão instalada** e exibir o aviso.

#### Validação de integridade

Conferir o SHA-256 do zip **antes** de extrair:

```bash
# PowerShell
$hash = (Get-FileHash -Algorithm SHA256 -Path $zip).Hash.ToLower()
if ($hash -ne $expected) { throw "hash nao confere" }

# Bash
expected=$(curl -s "$releaseUrl.sha256" | awk '{print $1}')
actual=$(sha256sum "$zip" | awk '{print $1}')
if [ "$actual" != "$expected" ]; then
  echo "hash nao confere" >&2
  exit 1
fi
```

Adicionar `.sha256` como asset companion na release (mais robusto que `digest` do GitHub).

#### Backup e rollback

Antes de sobrescrever, mover o plugin atual para `.bak`:
```bash
mv Vencord/src/userplugins/goLiveBypass    Vencord/src/userplugins/goLiveBypass.bak.$(date +%Y%m%d%H%M%S)
```

Se a próxima ativação falhar (próxima vez que rodar o instalador), o instalador detecta e oferece rollback.

#### Preservar configurações

O `verifiedProxy` e `bootPending` ficam no Vencord (não no plugin). O instalador **não mexe** neles — só substitui `src/userplugins/goLiveBypass/`. Configurações são preservadas automaticamente.

#### Comando `--check-update`

Adicionar um parâmetro `--check-update` em ambos os scripts:

```bash
./golivebypass-installer.sh --check-update
# Saída: "Você tem v1.1.8, há v1.1.9. Roda sem --check-update para atualizar."
```

Útil para:
- CI smoke test (detecta versão nova).
- Adicionar ao `crontab`/`Task Scheduler` para checagem periódica.
- Botão "Verificar atualizações" no tray da GUI.

---

## 4. Arquitetura do Caminho B (userplugin do Vencord)

### 4.1. Formato

```
bezumiya/GoLiveBypass/releases/download/v1.1.9/
└── goLiveBypass-vencord.zip
    ├── goLiveBypass/
    │   ├── index.tsx
    │   ├── native.ts
    │   ├── package.json
    │   └── manifest.json
```

#### `manifest.json` (novo)

```json
{
  "name": "GoLiveBypass",
  "description": "Devolve o Go Live e a câmera para contas brasileiras",
  "authors": [{ "name": "bezumiya", "id": "1366453661970071633" }],
  "version": "1.1.8",
  "updater": {
    "type": "github",
    "id": "bezumiya/GoLiveBypass",
    "assetName": "goLiveBypass-vencord.zip"
  }
}
```

> **Observação:** o formato exato de `updater` varia entre Vencord/Equicord/Vesktop. Antes de implementar, testar em pelo menos Equicord + Vencord vanilla.

### 4.2. Como o Vencord detecta o update

Quando o Vencord inicia, ele:
1. Lê `.userplugins/GoLiveBypass/manifest.json`.
2. Se tem `updater`, consulta `https://api.github.com/repos/{id}/releases/latest`.
3. Compara `tag_name` (sem `v`) com `version` do manifest.
4. Se maior, baixa o asset `assetName` e extrai.

### 4.3. Restrições conhecidas

| Item | Restrição | Mitigação |
|------|-----------|-----------|
| Tamanho do asset | ~50MB (depende do loader) | Plugin nosso é < 100KB. OK. |
| Auto-update habilitado por padrão | **Variável** entre Equicord, Vencord vanilla, Vesktop | Documentar; não controlar |
| `manifest.json` schema | Mudou entre versões do Vencord | Testar com a versão mais recente do Equicord + Vencord vanilla |
| `assetName` case-sensitive | Sim | Padronizar em lowercase |

### 4.4. Risco principal

O Vencord tem histórico de **mudar o schema do `manifest.json`** entre versões. Um schema errado faz o Vencord **ignorar o plugin silenciosamente** — não atualiza, não avisa, não dá erro. Mitigação: documentar a versão mínima do Vencord e o schema testado.

---

## 5. CI / Release pipeline (cobre os 2 caminhos)

### 5.1. Hoje (já existe)

`.github/workflows/build-gui.yml`:
```yaml
on: workflow_dispatch
jobs:
  windows:  # GoLiveBypass.exe
  linux:    # GoLiveBypass.AppImage
  macos:    # GoLiveBypass.dmg/zip
```

Publica em `bezumiya/GoLiveBypass/releases/<tag>`:
- `GoLiveBypass-{version}.exe`
- `GoLiveBypass-{version}.AppImage`
- `GoLiveBypass-{version}.dmg/zip`
- `latest.yml`, `latest-linux.yml`, `latest-mac.yml` (metadata GUI)

### 5.2. Adicionar (cobre Caminho A e B)

Novo job `release-plugin` no mesmo workflow:

```yaml
release-plugin:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
      with: { ref: ${{ inputs.tag }} }

    - name: Determinar versão
      id: version
      run: |
        # Semver: v1.2.3 → 1.2.3
        echo "version=${GITHUB_REF_NAME#v}" >> $GITHUB_OUTPUT
        echo "tag=${GITHUB_REF_NAME}" >> $GITHUB_OUTPUT

    - name: Zip do plugin para userplugin (Caminho B)
      run: |
        cd goLiveBypass
        # Injetar a versão no manifest antes de zipar
        sed -i "s/"version": "[^"]*"/"version": "${{ steps.version.outputs.version }}"/" manifest.json
        cd ..
        zip -r "goLiveBypass-vencord-${{ steps.version.outputs.version }}.zip" goLiveBypass/

    - name: SHA-256 dos assets
      run: |
        sha256sum "goLiveBypass-vencord-${{ steps.version.outputs.version }}.zip" > "goLiveBypass-vencord-${{ steps.version.outputs.version }}.zip.sha256"
        sha256sum "standalone/golivebypass.js" > "golivebypass.js.sha256"

    - name: Upload para a release
      uses: softprops/action-gh-release@v2
      with:
        tag_name: ${{ inputs.tag }}
        files: |
          goLiveBypass-vencord-${{ steps.version.outputs.version }}.zip
          goLiveBypass-vencord-${{ steps.version.outputs.version }}.zip.sha256
          standalone/golivebypass.js
          golivebypass.js.sha256
        fail_on_unmatched_files: true
```

Resultado: a release passa a ter **4 novos assets**:
- `goLiveBypass-vencord-{version}.zip` (para o Vencord userplugin)
- `goLiveBypass-vencord-{version}.zip.sha256` (hash para validação)
- `standalone/golivebypass.js` (bypass puro, útil para distribuição manual)
- `golivebypass.js.sha256` (hash)

### 5.3. Versionamento centralizado

Hoje: `golive-gui/package.json` tem `"version": "1.1.8"`. O plugin **não tem versão própria**.

**Solução:** ler a versão da release do GitHub (a tag), e o instalador/userplugin usam essa versão. **Não** precisa de sincronização manual — o CI é a fonte da verdade.

---

## 6. Detalhes de implementação por arquivo

### 6.1. Instalador PowerShell (`installer/GoLiveBypass-Installer.ps1`)

**Hoje:** o script tem `githubLatestRelease()` que retorna a tag da release mais recente. Falta comparar com a versão local e fazer o update.

**Adicionar:**

```powershell
# Estado atual: qual versão do plugin está instalada
function Get-InstalledPluginVersion {
    param([string]$UserPluginPath)
    $manifestPath = Join-Path $UserPluginPath "manifest.json"
    $pkgPath = Join-Path $UserPluginPath "package.json"
    if (Test-Path $manifestPath) {
        $m = Get-Content $manifestPath -Raw | ConvertFrom-Json
        if ($m.version) { return $m.version }
    }
    if (Test-Path $pkgPath) {
        $p = Get-Content $pkgPath -Raw | ConvertFrom-Json
        if ($p.version) { return $p.version }
    }
    return $null
}

# Compara versões (semver)
function Compare-PluginVersion {
    param([string]$Installed, [string]$Latest)
    if (-not $Installed) { return "update" }  # nunca instalado = update
    try {
        $a = [version]($Installed -replace '-.*$', '')
        $b = [version]($Latest -replace '-.*$', '')
        if ($b -gt $a) { return "update" }
        return "current"
    } catch { return "update" }  # versão malformada = update
}

# Comandos novos:
#   --check-update   só checa, exibe status
#   --update         aplica update (assume interativo)
#   --auto-update    aplica update sem perguntar (uso em CI)
```

### 6.2. Instalador Bash (`installer/golivebypass-installer.sh`)

**Adicionar (análogo ao PowerShell):**

```bash
get_installed_version() {
    local userplugins_dir="$1"
    local manifest="$userplugins_dir/manifest.json"
    local pkg="$userplugins_dir/package.json"
    if [ -f "$manifest" ]; then
        grep -o '"version": *"[^"]*"' "$manifest" | head -1 | sed 's/.*: *"\(.*\)"//'
    elif [ -f "$pkg" ]; then
        grep -o '"version": *"[^"]*"' "$pkg" | head -1 | sed 's/.*: *"\(.*\)"//'
    fi
}

compare_version() {
    # 1.1.8 < 1.1.9 → "update"
    # 1.1.9 = 1.1.9 → "current"
    # 1.1.9 > 1.2.0 → "current" (downgrade)
    local installed="$1" latest="$2"
    [ -z "$installed" ] && { echo "update"; return; }
    [ "$installed" = "$latest" ] && { echo "current"; return; }
    local lowest=$(printf '%s
%s' "$installed" "$latest" | sort -V | head -1)
    [ "$lowest" = "$latest" ] && { echo "update"; return; }
    echo "current"
}
```

### 6.3. Plugin Vencord — adicionar `manifest.json`

**Arquivo novo:** `goLiveBypass/manifest.json`

```json
{
  "name": "GoLiveBypass",
  "description": "Devolve o Go Live e a câmera para contas brasileiras",
  "authors": [{ "name": "bezumiya", "id": "1366453661970071633" }],
  "version": "1.1.8",
  "updater": {
    "type": "github",
    "id": "bezumiya/GoLiveBypass",
    "assetName": "goLiveBypass-vencord.zip"
  }
}
```

> Versão inicial = a versão atual. Atualizada automaticamente pelo CI.

### 6.4. Adicionar campo `version` ao `index.tsx` (diagnóstico)

Para o `/golivebypass` report mostrar a versão:

```tsx
// No AboutPlugin, adicionar:
<Paragraph>
    Versão instalada: <code>{VERSION}</code> ...
</Paragraph>
```

Onde `VERSION` é lido do `manifest.json` (build-time) ou hardcoded (mais simples).

---

## 7. Compatibilidade e migração

### 7.1. Usuários existentes

| Cenário | Impacto |
|---------|---------|
| Usuário com plugin via `src/userplugins/` (instalação manual) | **Transparente.** O instalador agora detecta a versão pelo `manifest.json` (ou `package.json`, se já tiver). Primeira vez que rodar `--check-update`, vê o status. |
| Usuário com plugin mergeado upstream (Equicord/Vencord) | **Sem impacto.** Update vem pelo mod, não pelo nosso repo. |
| Usuário com bypass standalone (sem mod) | **Sem impacto.** Não usa o instalador. |
| Usuário com GUI Electron | **Sem impacto.** GUI tem seu próprio update. |

### 7.2. Rollback

Se uma atualização quebrar algo, o usuário tem 2 caminhos:

1. **Volta para versão anterior específica** (via instalador):
   ```bash
   ./golivebypass-installer.sh --version v1.1.7
   ```
   (a implementar: parâmetro `--version` no instalador)

2. **Restaura backup** (criado automaticamente antes de cada update):
   ```bash
   mv Vencord/src/userplugins/goLiveBypass.bak.20260826*       Vencord/src/userplugins/goLiveBypass
   ```
   (manual, mas documentado no README)

### 7.3. Versionamento SemVer

- `1.1.8` → `1.1.9`: patch (bugfix), update sempre.
- `1.1.8` → `1.2.0`: minor (nova feature), update sempre.
- `1.1.8` → `2.0.0`: major (breaking change), **opt-in** (aviso: "Atualização com mudanças grandes. Continuar?").

---

## 8. Cronograma (Caminho A — instalador)

| Etapa | Esforço | Quem | Dependência |
|-------|---------|------|-------------|
| **A. Adicionar `manifest.json` ao plugin** | 30min | mantenedor | nenhuma |
| **B. Adicionar `--check-update` e `--update` ao instalador PowerShell** | 2h | mantenedor | A |
| **C. Adicionar `--check-update` e `--update` ao instalador Bash** | 2h | mantenedor | A |
| **D. CI: novo job `release-plugin`** | 1h | mantenedor | A |
| **E. Adicionar validação de SHA-256** | 1h | mantenedor | D |
| **F. Backup automático + rollback** | 1h | mantenedor | C |
| **G. Documentação no README + UPDATER.md** | 2h | mantenedor | todas |
| **H. Teste E2E com release de teste em fork** | 2h | mantenedor | A-G |

**Total Caminho A:** ~12h, **1.5-2 dias úteis**.

### Cronograma (Caminho B — userplugin)

| Etapa | Esforço | Quem | Dependência |
|-------|---------|------|-------------|
| **I. Investigar schema atual do `manifest.json` em Equicord + Vencord vanilla + Vesktop** | 4h | mantenedor | nenhuma |
| **J. Criar estrutura do userplugin zip** | 1h | mantenedor | I |
| **K. CI: zip do userplugin no `release-plugin`** | 1h | mantenedor | D, J |
| **L. Teste E2E em 3 loaders (Equicord, Vencord, Vesktop)** | 4h | mantenedor | K |

**Total Caminho B:** ~10h, **1-1.5 dias úteis**.

**Total combinado (A + B):** ~22h, **3-4 dias úteis**.

---

## 9. Riscos e mitigações

| Risco | Probabilidade | Impacto | Mitigação |
|-------|---------------|---------|-----------|
| Hash errado na release | baixa | alto (sobrescreve plugin por código errado) | Conferir SHA-256 antes de extrair; rejeitar se não bater |
| Versão do `manifest.json` incompatível com o Vencord do usuário | média | alto (Vencord ignora o plugin) | Documentar versão mínima do Vencord testada |
| `pnpm install/build/inject` quebra (mudança no Equicord) | média | médio (update falha) | Mensagem clara + manter backup `.bak` para rollback manual |
| Usuário em caminho de rede ruim (download interrompido) | média | baixo | Re-download é idempotente; resumir de onde parou via HTTP range |
| Conflito com versão mergeada upstream | baixa | alto (Vencord usa a do upstream) | Documentar: se mergeado upstream, preferir update pelo mod |
| `manifest.json` mudar de schema no futuro | média | médio | Validar na hora de criar a release; ter 2 manifestos (legacy + novo) se precisar |
| Instalador roda como root e cria permissões erradas | baixa | baixo | Verificar permissão do destino antes de escrever |
| Backup `.bak` cresce sem limite | média | baixo | Manter só os últimos 3 backups; limpar automaticamente |

---

## 10. Decisão recomendada

**Implementar em 2 ondas:**

### Onda 1 — Caminho A (instalador), P1, ~12h (1.5-2 dias)
- A. `manifest.json` no plugin
- B. `--check-update` no PowerShell
- C. `--check-update` no Bash
- D. CI: `release-plugin` job
- E. Validação de SHA-256
- F. Backup + rollback
- G. Documentação
- H. Teste E2E

**Resultado da Onda 1:** o instalador detecta e aplica updates com validação de hash. Quem já tem o plugin (qualquer loader) atualiza com 1 comando. **Cobre 90% dos usuários.**

### Onda 2 — Caminho B (userplugin), P2, ~10h (1-1.5 dias)
- I. Investigar schema atual
- J. Estrutura do userplugin
- K. CI: zip do userplugin
- L. Teste E2E em 3 loaders

**Resultado da Onda 2:** quem tem Vencord/Equicord/Vesktop moderno recebe update **transparente**, junto com a atualização do mod. **Cobre os 10% que não rodam o instalador.**

### Onda 3 — opcional
- Botão "Verificar atualizações" no tray da GUI que aciona o `--check-update` do instalador
- Notificação via Vencord `sendNotification` quando há update (Caminho B)
- Cache local do último "visto" para evitar consultas repetidas

---

## 11. Resumo executivo (1 parágrafo)

O plugin Vencord/Equicord **não tem auto-update hoje**. Há **2 caminhos complementares**: (A) atualizar o instalador para detectar e aplicar updates com validação de hash — baixo risco, ~12h, cobre 90% dos usuários; (B) distribuir como userplugin do Vencord com `manifest.json` declarando updater — alto retorno, ~10h, requer investigar o schema atual. Recomendação: implementar A primeiro (1.5-2 dias), B depois (1-1.5 dias). Total: ~3-4 dias úteis. O CI precisa de **1 job novo** (`release-plugin`) que zipa o plugin e gera hashes; **4 assets novos** na release. Sem dependência externa.
