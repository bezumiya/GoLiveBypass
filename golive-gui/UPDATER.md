# Auto-update do GoLiveBypass — guia do mantenedor

O app recebe um **pulso SSE** da API Go quando uma release é publicada e então
consulta as **releases do GitHub** (`api.github.com`) diretamente. A API não
entrega executáveis nem digests: ela só acorda o updater. Este documento explica
como configurar, publicar e testar — inclui o que é obrigatório para o
auto-update funcionar em cada SO.

## Como funciona

| SO | Mecanismo | Requisito |
|----|-----------|-----------|
| Windows | Updater **portable** próprio (`electron/updater.ts`): recebe o pulso, consulta a release, baixa e confere o `.exe`, deixa o update pendente e agenda a troca via `PORTABLE_EXECUTABLE_FILE` somente após o pedido de reinício | Nenhum (não precisa assinar) |
| Linux | `electron-updater` nativo (AppImageUpdater) com **download diferencial** (blockMap), acordado pelo pulso | Nenhum |
| macOS | **desligado por enquanto** — ver abaixo | **Obrigatório: app assinado** (sem assinatura o download falha) |

O `publish` está configurado em `golive-gui/package.json`:

```json
"publish": {
  "provider": "github",
  "owner": "pdl-clay",
  "repo": "GoLiveBypass",
  "releaseType": "release"
}
```

## API do pulso

A GUI conecta em:

```text
https://api.skyplaceia.com/bugs/v1/updates/stream
```

O servidor mantém o SSE público com limite de 100 conexões, no máximo 2 por IP
e heartbeat de 20 segundos. A conexão reconecta com backoff quando a API cai.
O fallback continua existindo: a GUI consulta o updater no boot e uma vez por
hora. Se o GitHub ainda não tiver propagado o asset na hora do webhook, há duas
retentativas em 30 s e 120 s.

No deploy da API, configure `GITHUB_WEBHOOK_SECRET` e o webhook do repositório:

```text
POST https://api.skyplaceia.com/bugs/v1/updates/github/webhook
X-GitHub-Event: release
```

O webhook deve usar `application/json`, o mesmo segredo HMAC e somente o evento
**Release**. A API aceita apenas `action=published`, `draft=false` e o
`GITHUB_REPO` configurado. Consulte [api/deploy/README.md](../api/deploy/README.md)
para o checklist do servidor.

## Publicar uma release (fluxo do CI)

1. Crie a tag no formato `vX.Y.Z` (ex.: `v1.1.5`) no commit desejado
2. Dispare o workflow **build-gui** (manual, `workflow_dispatch`) informando a tag
3. O CI roda `npm run publish:win|linux|mac` — o `electron-builder --publish always`
   gera e publica na release:
   - `GoLiveBypass.exe` + `latest.yml` (Windows)
   - `GoLiveBypass.AppImage` + `latest-linux.yml` (Linux)
   - `GoLiveBypass.dmg` + `GoLiveBypass.zip` + `latest-mac.yml` (macOS)

> O caminho Windows desta aplicação consulta a API do GitHub e confere o digest
> SHA-256 do anexo; ele não depende de `latest.yml`. Linux e macOS continuam
> dependendo do metadata gerado pelo `electron-updater`.

## macOS: por que está desligado

O `MacUpdater` recusa aplicar uma atualização se o app não estiver assinado com um certificado
Developer ID, e esse certificado ainda não existe neste projeto. Deixar ligado seria pior do que
desligar: o app detectaria a versão nova, tentaria baixar e falharia — a pessoa ficaria esperando
uma atualização que nunca chega.

O bloco que desliga está em `electron/updater.ts`, logo no começo do `setupUpdater`, e diz
exatamente isso. Para religar: configure os secrets da seção abaixo e apague o bloco.

Enquanto isso, quem usa macOS baixa a versão nova pela página de releases.

## Assinatura (macOS — obrigatória; Windows — opcional)

O auto-update do macOS só funciona com o app **assinado e notarizado**. O
mantenedor precisa gerar os certificados e configurar os secrets do repositório
(Settings → Secrets and variables → Actions):

| Secret | O que é | Obrigatório para |
|--------|---------|------------------|
| `CSC_LINK` | Certificado de desenvolvedor da Apple (base64 do `.p12`) | macOS (e Windows, se quiser assinar) |
| `CSC_KEY_PASSWORD` | Senha do certificado | macOS / Windows |
| `APPLE_ID` | Apple ID do desenvolvedor | Notarização do macOS |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password do Apple ID | Notarização do macOS |
| `APPLE_TEAM_ID` | Team ID do desenvolvedor | Notarização do macOS |

Para macOS:
1. Gere o certificado "Developer ID Application" no Apple Developer portal
2. Exporte como `.p12` e codifique em base64: `base64 -i cert.p12`
3. Configure `CSC_LINK` com o base64, `CSC_KEY_PASSWORD` com a senha
4. Gere um app-specific password em appleid.apple.com e configure
   `APPLE_APP_SPECIFIC_PASSWORD` (+ `APPLE_ID` e `APPLE_TEAM_ID`)

Sem os secrets, o CI builda sem assinatura e o auto-update do macOS fica
desabilitado (o app funciona, mas não atualiza sozinho).

> No Windows o portable **não exige assinatura** (o updater próprio substitui o
> exe sem checagem de assinatura). Se quiser evitar o SmartScreen, assine com um
> certificado de código (pode usar o mesmo `CSC_LINK` do Mac).

## Notificação ao usuário

O fluxo de atualização avisa antes de instalar:

- **Linux**: o download corre em background; ao terminar, aparece um diálogo
  *"GoLiveBypass X.Y.Z foi baixada — Reiniciar agora?"* — só instala com o OK
- **Windows portable**: ao receber o pulso, baixa e valida em background; ao
  terminar, pergunta *"Reiniciar agora?"*. Se o usuário escolher **Depois** ou
  o app estiver apenas na bandeja, o arquivo fica guardado com seu digest e o
  item **Reiniciar para atualizar** aparece na bandeja. A preferência de
  atualizações desliga o pulso e as consultas automáticas.

## Teste E2E (procedimento validado)

### Linux (AppImage) — fluxo completo

```bash
# 1. Build da versão "nova" apontando para o fork de teste
cd golive-gui
sed -i 's/"owner": "bezumiya"/"owner": "SEU_FORK"/' package.json
sed -i 's/"version": "1.0.0"/"version": "1.1.5"/' package.json
npm run build:linux

# 2. Publica a release de teste no fork (AppImage + latest-linux.yml)
gh release create v1.1.5-test --repo SEU_FORK/GoLiveBypass \
  dist-app/GoLiveBypass.AppImage dist-app/latest-linux.yml

# 3. Build da versão "antiga" (1.0.0) e extrai para rodar sem o AppImageLauncher
sed -i 's/"version": "1.1.5"/"version": "1.0.0"/' package.json
npm run build:linux
./dist-app/GoLiveBypass.AppImage --appimage-extract   # gera squashfs-root/

# 4. Roda a antiga com APPIMAGE apontando para o arquivo a substituir
APPIMAGE=$PWD/dist-app/GoLiveBypass.AppImage \
  ./squashfs-root/golive-gui --no-sandbox
```

**Resultado esperado no log**: `Checking for update` → `Found version 1.1.5` →
`New version 1.1.5 has been downloaded` → o arquivo `GoLiveBypass.AppImage` é
substituído (tamanho muda) → reexecuta.

> ⚠️ O AppImageLauncher (binfmt) intercepta AppImages e quebra o teste. A
> extração com `--appimage-extract` + env `APPIMAGE` contorna isso.

### Windows (portable) — procedimento

```bash
# 1. Build da versão "nova" no fork
sed -i 's/"owner": "bezumiya"/"owner": "SEU_FORK"/' package.json
sed -i 's/"version": "1.0.0"/"version": "1.1.5"/' package.json
npm run build:win          # ou publish:win com GH_TOKEN

# 2. Publica a release com GoLiveBypass.exe (+ latest.yml)
gh release create v1.1.5-test --repo SEU_FORK/GoLiveBypass \
  dist-app/GoLiveBypass.exe dist-app/latest.yml

# 3. Roda o exe antigo (1.0.0); o webhook acorda a consulta, ele baixa/confere,
#    pergunta "Reiniciar agora?", encerra o processo, troca o exe pelo helper
#    externo e reabre. Escolha "Depois" e confira o item da bandeja.
#    a versão nova
```

**Pontos de atenção no Windows**:
- O updater usa `PORTABLE_EXECUTABLE_FILE` (variável do electron-builder
  portable) para achar o exe em uso — sem ela o update é pulado
- O helper externo espera até 90 tentativas, com aproximadamente 1s entre elas,
  e só move o exe atual depois que o processo antigo liberou a imagem
- Teste também o fluxo "Depois": o app continua rodando, o update permanece
  pendente após reiniciar a GUI e o item da bandeja permite aplicar sem novo
  download

### macOS — procedimento

```bash
# Com os secrets de assinatura configurados:
npm run publish:mac          # gera dmg/zip assinados + latest-mac.yml

# Roda o app antigo (1.0.0) num Mac; o autoUpdater detecta, baixa em background,
# mostra "Reiniciar agora?" e aplica no quit (Squirrel.Mac aplica no relaunch)
```

**Validações no macOS**:
- `codesign -dv --verbose=2 GoLiveBypass.app` deve mostrar `Developer ID Application`
- `spctl -a -vv GoLiveBypass.dmg` deve passar (notarização ok)
- O `latest-mac.yml` precisa estar na release junto do dmg/zip

## Testes por distro Linux

O AppImage roda em qualquer distro, mas o comportamento do auto-update varia
com o ambiente. Validar em pelo menos uma de cada grupo:

### Grupo A — sem AppImageLauncher (mais comum: Ubuntu, Fedora, Arch puros)

O fluxo padrão do electron-updater funciona sem ajustes: o AppImage é
substituído in-place e reexecutado.

```bash
# 1. Publica a release de teste (v1.1.5) no fork (ver seção anterior)
# 2. Copia o AppImage antigo (v1.0.0) para um diretório e roda
mkdir -p ~/teste-update && cp dist-app/GoLiveBypass-1.0.0.AppImage ~/teste-update/
chmod +x ~/teste-update/GoLiveBypass-1.0.0.AppImage
~/teste-update/GoLiveBypass-1.0.0.AppImage
# 3. Confirma: detecta -> baixa -> dialogo -> antigo morre -> novo abre
#    (o arquivo em ~/teste-update agora tem o tamanho/versao da 1.1.5)
```

### Grupo B — com AppImageLauncher (KDE neon, Kubuntu, alguns Arch)

O launcher intercepta AppImages e os renomeia com hash ao integrar
(`GoLiveBypass-1.1.5_<hash>.AppImage`). O fluxo funciona, mas:

- O arquivo atualizado aparece com nome `GoLiveBypass-1.1.5_<hash>` em
  `~/Applications/` — **não** sobrescreve o antigo
- O app antigo deve **morrer** (o `markQuittingForUpdate` garante) e o novo
  abre integrado

**Teste**: rodar o AppImage antigo de `~/Applications/` (integrado), atualizar,
e conferir que o processo antigo sumiu (`pgrep -af golive-gui`) e o novo subiu.

### Grupo C — sandbox/flatpak ou AppImage lido de mount temporário

Se o AppImage for montado de um path temporário (ex.: teste extraído com
`--appimage-extract`), o `APPIMAGE` env aponta para um arquivo que o updater
não consegue substituir de forma estável. **Não é um cenário de produção** —
use o AppImage inteiro (grupo A/B).

## Solução de problemas

| Sintoma | Causa provável |
|---------|----------------|
| `Cannot find latest-linux.yml ... 404` | Release sem o metadata (CI antigo ou upload manual) — publique com `--publish always` |
| `APPIMAGE env is not defined` | App rodando fora do runtime AppImage (teste extraído) — rode o AppImage normal ou set `APPIMAGE` |
| `Update for version X is not available` | A release tem a **mesma versão** do app rodando — suba a versão no package.json |
| macOS: download falha/instalação falha | App sem assinatura — configure `CSC_LINK`/`CSC_KEY_PASSWORD`/`APPLE_*` |
| `downgrade is disallowed` | A release é mais antiga que a versão local — publique uma versão maior |
| Windows: `EBUSY` ao renomear o exe | Build antigo tentou trocar o próprio arquivo ainda em execução; o helper pós-saída do build atual deve fazer a troca |
| App fecha mas não abre após atualizar | Confira o log `[updater]`, a existência do helper no `%TEMP%` e se o `before-quit` não adia o quit durante o update (`markQuittingForUpdate`) |
| AppImageLauncher renomeia o arquivo com hash | Esperado: o nome versionado (`GoLiveBypass-1.1.5_<hash>`) evita sobrescrever o antigo; o app novo abre integrado |
