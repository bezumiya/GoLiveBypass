#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Testes do auto-update do instalador GoLiveBypass para Windows.
.DESCRIPTION
    Valida a sintaxe do PowerShell, as funcoes de auto-update (Get-LatestRelease,
    Get-InstalledPluginVersion, Compare-Version, Backup-Plugin, Invoke-CheckUpdate,
    Invoke-Update, Invoke-UpdateFromZip), e a integracao com manifest.json.
.NOTES
    Requer PowerShell 7+ (pwsh). Em Windows, pode ser executado com powershell
    ou pwsh (PowerShell Core).
.EXAMPLE
    ./tests/test-auto-update.ps1
#>

$ErrorActionPreference = 'Stop'
$REPO = "/tmp/golive-test"  # caminho do repo no ambiente de teste

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
$tempScript = Join-Path "/tmp/golive-test" "golive-truncated-installer.ps1"
Set-Content -LiteralPath $tempScript -Value $truncated
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
$funcs = @('Get-LatestRelease', 'Get-InstalledPluginVersion', 'Compare-Version', 'Backup-Plugin', 'Invoke-CheckUpdate', 'Invoke-Update', 'Invoke-UpdateFromZip')
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
    @{ Installed='1.10.0'; Latest='1.9.0'; Expected=1;  Desc='1.10 > 1.9' }
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

# Resultado
Write-Host ""
Write-Host "== Resultado: $pass ok, $fail falhas =="
Remove-Item $tempScript -ErrorAction SilentlyContinue
if ($fail -gt 0) { exit 1 } else { exit 0 }
