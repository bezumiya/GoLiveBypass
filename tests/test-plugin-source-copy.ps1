# Regressao Windows: o instalador deve copiar toda a fonte do plugin antes do pnpm build.
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$installerPath = Join-Path $repoRoot 'installer\GoLiveBypass-Installer.ps1'
$installerContent = Get-Content -LiteralPath $installerPath -Raw
$bannerIndex = $installerContent.LastIndexOf('Show-Banner')
if ($bannerIndex -lt 0) { throw 'Nao consegui carregar as funcoes do instalador.' }
$tempInstaller = Join-Path ([IO.Path]::GetTempPath()) "golive-plugin-copy-$([Guid]::NewGuid().ToString('N')).ps1"
Set-Content -LiteralPath $tempInstaller -Value $installerContent.Substring(0, $bannerIndex) -Encoding UTF8
. $tempInstaller

# O helper binario nao faz parte desta regressao; a copia de fontes e o build sao reais.
function Copy-PluginHelper($target) { }
# Os pre-requisitos de git do build tem regressao propria (test-error-handling.ps1, 2.9);
# o checkout temporario daqui nao e um repositorio.
function Assert-CheckoutBuildPreReqs($root) { }
$script:ExpectedRoot = $null
function Invoke-Pnpm([string[]]$Arguments) {
    # O build sempre e precedido pela sincronizacao das dependencias.
    if ($Arguments -contains 'install') { $script:PnpmExitCode = 0; return }
    if ($Arguments -notcontains 'build') { throw "build fake inesperado: $($Arguments -join ' ')" }
    foreach ($file in $PluginFiles) {
        $candidate = Join-Path $script:ExpectedRoot "src\userplugins\$PluginDirName\$(Split-Path -Leaf $file)"
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { throw "build fake sem $file" }
        if ((Get-Item -LiteralPath $candidate).Length -le 0) { throw "build fake com $file vazio" }
    }
    $script:PnpmExitCode = 0
    Write-Output 'fake pnpm build ok'
}

$work = Join-Path ([IO.Path]::GetTempPath()) "golive-plugin-copy-$([Guid]::NewGuid().ToString('N'))"
$source = Join-Path $work 'source'
$root = Join-Path $work 'Equicord'
$incomplete = Join-Path $work 'incomplete'
try {
    New-Item -ItemType Directory -Path $source, $root, $incomplete, (Join-Path $root 'node_modules') -Force | Out-Null
    $script:PluginSource = $source
    foreach ($file in $PluginFiles) {
        $leaf = Split-Path -Leaf $file
        Set-Content -LiteralPath (Join-Path $source $leaf) -Value "module $leaf" -Encoding utf8
        Set-Content -LiteralPath (Join-Path $incomplete $leaf) -Value "module $leaf" -Encoding utf8
    }

    $script:ExpectedRoot = $root
    Copy-PluginFromRepo $root
    Build-Mod $root
    Write-Host 'ok - copia completa atende o build fake'

    Remove-Item -LiteralPath (Join-Path $incomplete 'stability.ts') -Force
    $staleTarget = Join-Path $work 'Stale\src\userplugins\goLiveBypass'
    New-Item -ItemType Directory -Path $staleTarget -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $staleTarget 'stability.ts') -Value 'stale' -Encoding utf8
    $staleRoot = Join-Path $work 'Stale'
    $script:PluginSource = $incomplete
    try {
        Copy-PluginFromRepo $staleRoot
        throw 'arvore incompleta foi aceita'
    } catch {
        if ($_.Exception.Message -notmatch 'Nao achei stability\.ts') { throw }
    }
    Write-Host 'ok - copia incompleta falha antes do build'
} finally {
    Remove-Item -LiteralPath $work, $tempInstaller -Recurse -Force -ErrorAction SilentlyContinue
}
