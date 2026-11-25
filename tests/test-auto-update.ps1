#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Testes do auto-update do instalador GoLiveBypass para Windows.
.DESCRIPTION
    Valida a sintaxe do PowerShell, as funcoes de auto-update (Get-LatestRelease,
    Get-PluginInstallRelease, Get-InstalledPluginVersion, Compare-Version, Backup-Plugin,
    Invoke-CheckUpdate, Invoke-Update, Invoke-UpdateFromZip), a escolha da fonte do plugin
    (Install-PluginSource, Copy-PluginFromRepo) e a integracao com manifest.json.
.NOTES
    Requer PowerShell 7+ (pwsh). Em Windows, pode ser executado com powershell
    ou pwsh (PowerShell Core).
.EXAMPLE
    ./tests/test-auto-update.ps1
#>

$ErrorActionPreference = 'Stop'
$REPO = if (Test-Path -LiteralPath "/tmp/golive-test") { "/tmp/golive-test" } else { Split-Path -Parent $PSScriptRoot }
if (-not $REPO) { $REPO = (Get-Location).Path }

# 1. Sintaxe do PowerShell
Write-Host ""
Write-Host "== 1. Sintaxe do instalador =="
$tokens = $null
$errors = $null
[System.Management.Automation.Language.Parser]::ParseFile(
    (Join-Path $REPO "installer/GoLiveBypass-Installer.ps1"),
    [ref]$tokens, [ref]$errors) | Out-Null
if ($errors.Count -gt 0) {
    Write-Host "  [FAIL] erros de parsing:"
    $errors | ForEach-Object { Write-Host "    linha $($_.Extent.StartLineNumber): $($_.Message)" }
    exit 1
}
Write-Host "  [OK] instalador sem erros de sintaxe"

# Carrega o script (cortando o main switch)
$content = Get-Content -LiteralPath (Join-Path $REPO "installer/GoLiveBypass-Installer.ps1") -Raw
$idx = $content.LastIndexOf("Show-Banner")
if ($idx -lt 0) { Write-Host "  [FAIL] Show-Banner nao encontrado"; exit 1 }
$truncated = $content.Substring(0, $idx)
$tempDir = if (Test-Path -LiteralPath "/tmp/golive-test") { "/tmp/golive-test" } else { [System.IO.Path]::GetTempPath() }
$tempScript = Join-Path $tempDir "golive-truncated-installer.ps1"
Set-Content -LiteralPath $tempScript -Value $truncated -Encoding UTF8
. $tempScript

$pass = 0
$fail = 0
function Ok($msg) { $script:pass++; Write-Host "  [OK] $msg" }
function Bad($msg) { $script:fail++; Write-Host "  [FAIL] $msg" }

# 2. PLUGIN_FILES inclui manifest.json
Write-Host ""
Write-Host "== 2. PLUGIN_FILES inclui manifest.json =="
if ($content -match "goLiveBypass/manifest.json") {
    Ok "PluginFiles inclui manifest.json"
} else {
    Bad "PluginFiles NAO inclui manifest.json"
}

# 3. Param ValidateSet inclui CheckUpdate e Update
Write-Host ""
Write-Host "== 3. ValidateSet inclui CheckUpdate e Update =="
if ($content -match "ValidateSet\('Menu', 'Install', 'Uninstall', 'Restore', 'CheckUpdate', 'Update'\)") {
    Ok "ValidateSet inclui CheckUpdate e Update"
} else {
    Bad "ValidateSet missing CheckUpdate/Update"
}

# 4. Funcoes de auto-update definidas
Write-Host ""
Write-Host "== 4. Funcoes de auto-update definidas =="
$funcs = @('Get-LatestRelease', 'Get-PluginInstallRelease', 'Get-InstalledPluginVersion', 'Compare-Version', 'Backup-Plugin', 'Invoke-CheckUpdate', 'Invoke-Update', 'Invoke-UpdateFromZip', 'Install-PluginSource', 'Copy-PluginFromRepo')
foreach ($fn in $funcs) {
    $cmd = Get-Command $fn -ErrorAction SilentlyContinue
    if ($cmd) { Ok "funcao $fn definida" } else { Bad "funcao $fn NAO definida" }
}

# 5. Compare-Version (semver)
Write-Host ""
Write-Host "== 5. Compare-Version (semver) =="
$tests = @(
    @{ Installed='1.1.8'; Latest='1.1.8'; Expected=0;  Desc='mesma versao' },
    @{ Installed='1.1.8'; Latest='1.1.9'; Expected=-1; Desc='patch update' },
    @{ Installed='1.1.8'; Latest='1.2.0'; Expected=-1; Desc='minor update' },
    @{ Installed='1.1.8'; Latest='2.0.0'; Expected=-1; Desc='major update' },
    @{ Installed='1.1.9'; Latest='1.1.8'; Expected=1;  Desc='downgrade' },
    @{ Installed='1.2.0'; Latest='1.1.8'; Expected=1;  Desc='minor downgrade' },
    @{ Installed='';      Latest='1.1.8'; Expected=-1; Desc='instalado vazio' },
    @{ Installed='1.1.8'; Latest='';      Expected=0;  Desc='latest vazio' },
    @{ Installed='1.9.0'; Latest='1.10.0'; Expected=-1; Desc='10 > 9 (sort -V)' },
    @{ Installed='1.10.0'; Latest='1.9.0'; Expected=1;  Desc='1.10 > 1.9' },
    @{ Installed='v1.1.8'; Latest='1.1.8'; Expected=0;  Desc='prefixo v no instalado' },
    @{ Installed='1.1.8'; Latest='v1.1.8'; Expected=0;  Desc='prefixo v no latest' },
    @{ Installed='1.1.8'; Latest='v1.1.7'; Expected=1;  Desc='downgrade com prefixo v' },
    @{ Installed='1.1.12-beta.13'; Latest='1.1.12'; Expected=-1; Desc='beta para release estavel correspondente' },
    @{ Installed='1.1.12'; Latest='1.1.12-beta.13'; Expected=1;  Desc='release estavel nao faz downgrade para beta' },
    @{ Installed='1.1.12-beta.1'; Latest='1.1.12-beta.2'; Expected=-1; Desc='beta 1 para beta 2' },
    @{ Installed='1.1.12-beta.2'; Latest='1.1.12-beta.1'; Expected=1;  Desc='beta 2 para beta 1' }
)
foreach ($t in $tests) {
    $result = Compare-Version $t.Installed $t.Latest
    if ($result -eq $t.Expected) {
        Ok "Compare-Version($($t.Installed), $($t.Latest)) = $result  [$($t.Desc)]"
    } else {
        Bad "Compare-Version($($t.Installed), $($t.Latest)) = $result (esperado $($t.Expected))  [$($t.Desc)]"
    }
}

# 6. Get-InstalledPluginVersion
Write-Host ""
Write-Host "== 6. Get-InstalledPluginVersion =="
$root = "/tmp/golive-test-checkout"
if (Test-Path $root) { Remove-Item $root -Recurse -Force }
New-Item -ItemType Directory -Path "$root/src/userplugins/goLiveBypass" -Force | Out-Null

Set-Content -LiteralPath "$root/src/userplugins/goLiveBypass/manifest.json" -Value '{"version":"2.0.0","name":"GoLiveBypass"}'
$result = Get-InstalledPluginVersion $root
if ($result -eq '2.0.0') { Ok "Get-InstalledPluginVersion = 2.0.0" } else { Bad "Get-InstalledPluginVersion: $result" }

Set-Content -LiteralPath "$root/src/userplugins/goLiveBypass/manifest.json" -Value '{"name":"X"}'
$result = Get-InstalledPluginVersion $root
if ($null -eq $result) { Ok "Get-InstalledPluginVersion returns null when no version" } else { Bad "Get-InstalledPluginVersion: $result" }

Remove-Item "$root/src/userplugins/goLiveBypass/manifest.json" -Force
$result = Get-InstalledPluginVersion $root
if ($null -eq $result) { Ok "Get-InstalledPluginVersion returns null when manifest missing" } else { Bad "Get-InstalledPluginVersion: $result" }
Remove-Item $root -Recurse -Force

# 7. Backup-Plugin
Write-Host ""
Write-Host "== 7. Backup-Plugin =="
$root = "/tmp/golive-test-backup"
if (Test-Path $root) { Remove-Item $root -Recurse -Force }
New-Item -ItemType Directory -Path "$root/src/userplugins/goLiveBypass" -Force | Out-Null
Set-Content -LiteralPath "$root/src/userplugins/goLiveBypass/test.txt" -Value 'hello'

Backup-Plugin $root
$backupDir = "$root/src/userplugins/.goLiveBypass.bak"
if (Test-Path $backupDir) {
    $count = (Get-ChildItem $backupDir -Directory).Count
    if ($count -ge 1) { Ok "Backup-Plugin created $count backup(s)" } else { Bad "no backup found" }
} else { Bad "backup dir not created" }

# Teste de retencao (4 backups, espera <= 3)
for ($i = 0; $i -lt 4; $i++) {
    Backup-Plugin $root
    Start-Sleep -Seconds 1
}
$count = (Get-ChildItem $backupDir -Directory).Count
if ($count -le 3) { Ok "Backup-Plugin retem <=3 backups (encontrou $count)" } else { Bad "Backup-Plugin tem $count backups (esperado <=3)" }
Remove-Item $root -Recurse -Force

# 8. Canais, SemVer, assets e persistencia
Write-Host ""
Write-Host "== 8. Canais stable/beta e persistencia =="
if ($content -match "ValidateSet\('stable', 'beta'\)") { Ok "parametro -Channel aceita stable/beta" } else { Bad "parametro -Channel ausente" }
if ($content -match 'Stable e a opcao recomendada' -and $content -match 'Beta e opcional' -and $content -match 'ajuda a comunidade') {
    Ok "mensagens de canal sao claras e encorajadoras"
} else { Bad "mensagens de canal ausentes" }
if ($content -match 'CheckUpdate.*pode persistir.*sem baixar ZIP') { Ok "CheckUpdate documenta persistencia sem download" } else { Bad "documentacao CheckUpdate desatualizada" }
if ($content -match "installer\.selected.*channel" -and $content -match "installer\.completed.*channel") { Ok "eventos selected/completed incluem canal" } else { Bad "eventos selected/completed sem canal" }
$detectBlock = [regex]::Match($content, 'function Find-Checkout[\s\S]*?function Test-InjectedFromCheckout').Value
if ($detectBlock -notmatch "installer\.selected.*detect.*channel" -and
    $content -match "installer\.selected.*preparing.*channel" -and
    $content -match "installer\.completed.*channel") {
    Ok "settings beta nao cria canal falso no detect; preparing/completed mantem canal"
} else { Bad "canal aparece falso no detect ou falta apos selecao" }
$installModBlock = [regex]::Match($content, 'function Install-Mod[\s\S]*?function Stop-Discord').Value
if ($installModBlock -notmatch "installer\.selected.*channel") { Ok "download do mod nao fixa stable antes da selecao" } else { Bad "download do mod registra canal antes da selecao" }
if ($content -match 'Get-PluginReleaseCandidates' -and $content -match 'releases\?per_page=30' -and $content -notmatch 'api\.github\.com[^\r\n]*releases/latest' -and $content -notmatch '\$GitHubApi/releases/latest') {
    Ok "selecao de canal nao usa o endpoint /releases/latest da API"
} else { Bad "selecao de canal usa endpoint latest da API" }
if ($content -match 'function Invoke-ChangeChannel' -and
    $content -match 'Mudar canal de atualizacoes' -and
    $content -match 'Invoke-ChangeChannel \$root; continue') {
    Ok "menu Windows possui item de canal e retorna ao menu apos acoes"
} else { Bad "menu Windows sem item/retorno do canal" }
$originalFindCheckout = (Get-Command Find-Checkout -CommandType Function).ScriptBlock
$script:tuiCalls = 0
$script:changeCalls = 0
$script:textMenuCalls = 0
function Find-Checkout { return $null }
function Show-Status($root) { }
function Test-TuiInteractive { return $true }
function Tui-Menu {
    $script:tuiCalls++
    if ($script:tuiCalls -eq 1) { return 4 }
    return 7
}
function Invoke-ChangeChannel($root) { $script:changeCalls++ }
function Read-Escolha($prompt) { $script:textMenuCalls++; return '0' }
Show-MainMenu
if ($script:tuiCalls -eq 2 -and $script:changeCalls -eq 1 -and $script:textMenuCalls -eq 0) {
    Ok "TUI volta ao loop apos mudar canal sem cair no menu textual"
} else {
    Bad "TUI caiu no menu textual ou nao voltou apos mudar canal"
}
Set-Item -Path Function:\Find-Checkout -Value $originalFindCheckout

function Invoke-RestMethod {
    param([string]$Uri, [hashtable]$Headers, [int]$TimeoutSec)
    return @(
        [pscustomobject]@{ draft = $true; prerelease = $true; tag_name = 'v9.9.9-beta-1'; assets = @(
            [pscustomobject]@{ name = 'goLiveBypass-vencord.zip'; browser_download_url = 'https://fake/draft.zip' },
            [pscustomobject]@{ name = 'goLiveBypass-vencord.zip.sha256'; browser_download_url = 'https://fake/draft.sha' }
        ) },
        [pscustomobject]@{ draft = $false; prerelease = $true; tag_name = 'v2.1.0-beta-10'; assets = @(
            [pscustomobject]@{ name = 'goLiveBypass-vencord.zip'; browser_download_url = 'https://fake/b10.zip' },
            [pscustomobject]@{ name = 'goLiveBypass-vencord.zip.sha256'; browser_download_url = 'https://fake/b10.sha' }
        ) },
        [pscustomobject]@{ draft = $false; prerelease = $false; tag_name = 'v2.0.0'; assets = @(
            [pscustomobject]@{ name = 'goLiveBypass-vencord.zip'; browser_download_url = 'https://fake/stable.zip' },
            [pscustomobject]@{ name = 'goLiveBypass-vencord.zip.sha256'; browser_download_url = 'https://fake/stable.sha' }
        ) },
        [pscustomobject]@{ draft = $false; prerelease = $false; tag_name = 'v3.0.0'; assets = @(
            [pscustomobject]@{ name = 'goLiveBypass-vencord.zip.sha256'; browser_download_url = 'https://fake/no-zip.sha' }
        ) }
    )
}
$stable = Get-PluginReleaseForChannel stable
$beta = Get-PluginReleaseForChannel beta
if ($stable.Version -eq '2.0.0') { Ok "stable ignora beta/draft/missing SHA" } else { Bad "stable selecionou release incorreta" }
if ($beta.Version -eq '2.1.0-beta-10') { Ok "beta seleciona maior SemVer mesmo com lista embaralhada" } else { Bad "beta selecionou release incorreta" }
if ((Compare-Version '2.0.0-beta-9' '2.0.0-beta-10') -lt 0 -and
    (Compare-Version '2.0.0-beta-10' '2.0.0-beta-9') -gt 0 -and
    (Compare-Version '2.0.0' '2.0.0-beta-10') -gt 0) {
    Ok "SemVer beta-9/beta-10 e stable sem downgrade"
} else { Bad "ordem SemVer ou no-downgrade incorreta" }

$settingsRoot = Join-Path ([IO.Path]::GetTempPath()) ("golive-channel-" + [guid]::NewGuid().ToString('N'))
$archiveRoot = Join-Path ([IO.Path]::GetTempPath()) ("golive-archive-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path (Join-Path $archiveRoot 'goLiveBypass') -Force | Out-Null
Set-Content -LiteralPath (Join-Path $archiveRoot 'goLiveBypass\manifest.json') -Value '{"name":"GoLiveBypass","version":"1.9.9"}'
$badZip = Join-Path $archiveRoot 'bad.zip'
Compress-Archive -Path (Join-Path $archiveRoot 'goLiveBypass') -DestinationPath $badZip -Force
$badHash = (Get-FileHash -LiteralPath $badZip -Algorithm SHA256).Hash.ToLowerInvariant()
$updateRoot = Join-Path $archiveRoot 'Equicord'
New-Item -ItemType Directory -Path (Join-Path $updateRoot 'src\userplugins\goLiveBypass') -Force | Out-Null
Set-Content -LiteralPath (Join-Path $updateRoot 'src\userplugins\goLiveBypass\manifest.json') -Value '{"name":"GoLiveBypass","version":"1.0.0"}'
$script:fakeDownloadZip = $badZip
$script:fakeDownloadSha = $badHash
function Invoke-WebRequest {
    param([string]$Uri, [string]$OutFile, [switch]$UseBasicParsing, [int]$TimeoutSec)
    if ($OutFile) { Copy-Item -LiteralPath $script:fakeDownloadZip -Destination $OutFile -Force; return }
    return [pscustomobject]@{ Content = "$script:fakeDownloadSha  plugin.zip" }
}
try {
    Invoke-UpdateFromZip $updateRoot 'https://fake/plugin.zip' '2.0.0'
    Bad "zip com manifest divergente foi aceito"
} catch {
    $kept = Get-Content -LiteralPath (Join-Path $updateRoot 'src\userplugins\goLiveBypass\manifest.json') -Raw
    if ($kept -match '"version":"1.0.0"') { Ok "manifest divergente e rejeitado antes de substituir target" } else { Bad "target foi substituido antes da validacao do manifest" }
}
Set-Content -LiteralPath (Join-Path $archiveRoot 'goLiveBypass\manifest.json') -Value '{"name":"GoLiveBypass","version":"2.0.0"}'
$goodZip = Join-Path $archiveRoot 'good.zip'
Compress-Archive -Path (Join-Path $archiveRoot 'goLiveBypass') -DestinationPath $goodZip -Force
$script:fakeDownloadZip = $goodZip
$script:fakeDownloadSha = (Get-FileHash -LiteralPath $goodZip -Algorithm SHA256).Hash.ToLowerInvariant()
try {
    Invoke-UpdateFromZip $updateRoot 'https://fake/plugin.zip' '2.0.0'
    $accepted = Get-Content -LiteralPath (Join-Path $updateRoot 'src\userplugins\goLiveBypass\manifest.json') -Raw
    if ($accepted -match '"version":"2.0.0"') { Ok "manifest correspondente e aceito antes de substituir target" } else { Bad "zip valido nao foi instalado" }
} catch {
    Bad "manifest correspondente foi rejeitado: $($_.Exception.Message)"
}
Remove-Item $archiveRoot -Recurse -Force
$env:APPDATA = $settingsRoot
New-Item -ItemType Directory -Path (Join-Path $settingsRoot 'Equicord\settings') -Force | Out-Null
Set-Content -LiteralPath (Join-Path $settingsRoot 'Equicord\settings\settings.json') -Value '{"autoUpdate":false,"other":{"keep":true}}'
$fakeCheckout = Join-Path $settingsRoot 'Equicord'
New-Item -ItemType Directory -Path (Join-Path $fakeCheckout 'src\utils') -Force | Out-Null
Set-Content -LiteralPath (Join-Path $fakeCheckout 'package.json') -Value '{"name":"Equicord"}'
Set-Content -LiteralPath (Join-Path $fakeCheckout 'src\utils\types.ts') -Value 'type T = string'
Set-UpdateChannelPreference $fakeCheckout beta | Out-Null
$merged = Get-Content -LiteralPath (Join-Path $settingsRoot 'Equicord\settings\settings.json') -Raw | ConvertFrom-Json
if ($merged.autoUpdate -eq $false -and $merged.other.keep -and $merged.plugins.GoLiveBypass.updateChannel -eq 'beta') {
    Ok "merge persiste updateChannel e preserva outras configuracoes"
} else { Bad "merge de settings perdeu configuracoes" }
Set-Content -LiteralPath (Join-Path $settingsRoot 'Equicord\settings\settings.json') -Value '{invalid'
$beforeInvalid = Get-Content -LiteralPath (Join-Path $settingsRoot 'Equicord\settings\settings.json') -Raw
Set-UpdateChannelPreference $fakeCheckout stable | Out-Null
$afterInvalid = Get-Content -LiteralPath (Join-Path $settingsRoot 'Equicord\settings\settings.json') -Raw
if ($beforeInvalid -eq $afterInvalid) { Ok "settings JSON invalido permanece intacto" } else { Bad "settings invalido foi sobrescrito" }

$script:webRequests = 0
function Invoke-WebRequest { $script:webRequests++ }
$Source = $fakeCheckout
$Channel = 'beta'
$script:ChannelExplicit = $true
$Yes = $true
$checkOutput = (Invoke-CheckUpdate 6>&1 | Out-String)
if ($script:webRequests -eq 0 -and $checkOutput -match 'canal:\s*beta' -and $checkOutput -match 'remote:\s*2\.1\.0-beta-10') {
    Ok "-Mode CheckUpdate restaura Find-Checkout real, mostra canal/remote e nao baixa zip"
} else {
    Bad "-Mode CheckUpdate ficou falso-verde ou fez download"
}
Remove-Item $settingsRoot -Recurse -Force

# 9. API do GitHub fora: stable cai no redirect web, beta continua recusando
Write-Host ""
Write-Host "== 9. Fallback sem API do GitHub =="
$env:GLB_INSTALLER_LOG_DIR = Join-Path ([IO.Path]::GetTempPath()) ("golive-log-" + [guid]::NewGuid().ToString('N'))
function Invoke-RestMethod { throw 'Response status code does not indicate success: 403 (rate limit exceeded).' }
$script:fakeLatestTag = 'v2.0.19'
function Resolve-LatestStableTag { return $script:fakeLatestTag }
$fallback = Get-PluginReleaseForChannel stable 3>$null 6>$null
if ($fallback.Version -eq '2.0.19' -and
    $fallback.AssetUrl -eq 'https://github.com/bezumiya/GoLiveBypass/releases/download/v2.0.19/goLiveBypass-vencord.zip' -and
    $fallback.ShaUrl -eq 'https://github.com/bezumiya/GoLiveBypass/releases/download/v2.0.19/goLiveBypass-vencord.zip.sha256') {
    Ok "stable usa a latest do github.com, presa a tag, quando a API falha"
} else { Bad "stable sem fallback correto: $($fallback | Out-String)" }
if ($null -eq (Get-PluginReleaseForChannel beta 6>$null)) { Ok "beta nao cai na latest quando a API falha" } else { Bad "beta usou fallback de latest" }
$script:fakeLatestTag = 'v2.1.0-beta-1'
if ($null -eq (Get-PluginReleaseForChannel stable 6>$null)) { Ok "latest com sufixo de prerelease e recusada no stable" } else { Bad "stable aceitou latest prerelease" }
$logText = Get-Content -LiteralPath (Join-Path $env:GLB_INSTALLER_LOG_DIR 'installer.log') -Raw
if ($logText -match 'installer\.release_api_failed' -and $logText -match '403') { Ok "motivo da falha da API vai para o installer.log" } else { Bad "falha da API nao foi registrada no log" }
Remove-Item $env:GLB_INSTALLER_LOG_DIR -Recurse -Force -ErrorAction SilentlyContinue

# Resultado
Write-Host ""
Write-Host "== Resultado: $pass ok, $fail falhas =="
Remove-Item $tempScript -ErrorAction SilentlyContinue
if ($fail -gt 0) { exit 1 } else { exit 0 }
