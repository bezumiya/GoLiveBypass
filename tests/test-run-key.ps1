# PowerShell test script for Set-RunKey - regressao do startup do usuario
#
# Contexto: no provider de registro do PowerShell (ao contrario do provider de
# arquivos) o `New-Item -Path <chave> -Force` numa chave que JA EXISTE apaga a
# chave e a recria vazia, levando junto todos os valores. Set-RunKey usava esse
# padrao em HKCU\Software\Microsoft\Windows\CurrentVersion\Run, entao toda
# execucao do instalador ou do standalone limpava as entradas de inicializacao
# da maquina e deixava so a nossa.
#
# Este teste extrai a Set-RunKey dos dois scripts via AST, aponta ela para uma
# chave descartavel em HKCU e verifica que os vizinhos sobrevivem. Nao toca na
# chave Run real em nenhum momento.

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $repoRoot) { $repoRoot = (Get-Location).Path }

$installerPath  = Join-Path $repoRoot 'installer\GoLiveBypass-Installer.ps1'
$standalonePath = Join-Path $repoRoot 'standalone\GoLiveBypass-Standalone.ps1'

# Literal exatamente como aparece no codigo, para redirecionar a funcao.
$RealRunKeyLiteral = "'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'"
$DestructiveCall   = "New-Item -Path $RealRunKeyLiteral -Force"
$ScratchRoot       = 'HKCU:\Software\GoLiveBypassTest'
$ScratchKey        = 'HKCU:\Software\GoLiveBypassTest\RunKeyRegression'

# Valores do Tor usados pela versao standalone (script scope) e pela do
# instalador (parametros). Caminhos falsos: Set-RunKey so grava string.
$TorExe   = 'C:\GoLiveBypassTest\tor\tor.exe'
$TorTorrc = 'C:\GoLiveBypassTest\torrc'

# Stubs: Set-RunKey chama essas funcoes, definidas noutra parte dos scripts.
function Write-Ok($msg) { }
function Write-Warn($msg) { }

$pass = 0
$fail = 0

function Assert-Equal($actual, $expected, $desc) {
    if ($actual -eq $expected) {
        $script:pass++
        Write-Host "  [OK] $desc (Resultado: $actual)" -ForegroundColor Green
    } else {
        $script:fail++
        Write-Host "  [FAIL] $desc (Esperado: $expected, Obtido: $actual)" -ForegroundColor Red
    }
}

function Assert-True($actual, $desc) {
    Assert-Equal ([bool]$actual) $true $desc
}

function Get-FunctionText($path, $name) {
    $tokens = $null
    $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
    if ($errors.Count -gt 0) {
        throw "$path possui erros de sintaxe; rode tests/test-error-handling.ps1"
    }
    $fn = $ast.Find({
        param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
    }, $true)
    if (-not $fn) { throw "funcao $name nao encontrada em $path" }
    return $fn.Extent.Text
}

function Get-ValueOrNull($key, $name) {
    try { return Get-ItemPropertyValue -Path $key -Name $name -ErrorAction Stop } catch { return $null }
}

function Reset-ScratchKey([switch]$Absent) {
    Remove-Item -LiteralPath $ScratchKey -Recurse -Force -ErrorAction SilentlyContinue
    if (-not $Absent) { New-Item -Path $ScratchKey -Force | Out-Null }
}

function Test-SetRunKey($label, $path, $callArgs) {
    Write-Host "`n-- $label --" -ForegroundColor Yellow

    $text = Get-FunctionText $path 'Set-RunKey'

    # 1. Estatico: o padrao destrutivo nao pode voltar num refactor.
    Assert-True (-not $text.Contains($DestructiveCall)) `
        "$label nao chama New-Item -Force direto sobre a chave Run"

    # 2. Estatico: a criacao da chave tem que estar guardada por Test-Path.
    Assert-True ($text -match 'Test-Path') `
        "$label guarda a criacao da chave com Test-Path"

    # Redireciona a funcao para a chave descartavel e define no escopo local.
    $redirected = $text.Replace($RealRunKeyLiteral, "'$ScratchKey'")
    Invoke-Expression $redirected

    # 3. Chave ja existente: os vizinhos precisam sobreviver.
    Reset-ScratchKey
    Set-ItemProperty -Path $ScratchKey -Name 'Spotify' -Value 'spotify.exe --autostart'
    Set-ItemProperty -Path $ScratchKey -Name 'Steam'   -Value 'steam.exe -silent'
    Set-ItemProperty -Path $ScratchKey -Name 'Discord' -Value 'Update.exe --processStart Discord.exe'

    Set-RunKey @callArgs | Out-Null

    $names = @((Get-Item $ScratchKey).GetValueNames())
    Assert-Equal $names.Count 4 "$label preserva os 3 vizinhos e adiciona o proprio valor"
    foreach ($n in 'Spotify', 'Steam', 'Discord') {
        Assert-True ($names -contains $n) "$label mantem a entrada $n"
    }
    Assert-True ($names -contains 'GoLiveBypassTor') "$label grava GoLiveBypassTor"
    Assert-Equal (Get-ValueOrNull $ScratchKey 'Spotify') 'spotify.exe --autostart' `
        "$label nao altera o valor do vizinho Spotify"
    Assert-True ((Get-ValueOrNull $ScratchKey 'GoLiveBypassTor') -like '*tor.exe*') `
        "$label aponta GoLiveBypassTor para o tor.exe"

    # 4. Chave ausente: ainda precisa ser criada (a intencao original do -Force).
    Reset-ScratchKey -Absent
    Assert-True (-not (Test-Path -LiteralPath $ScratchKey)) "$label parte de chave ausente"

    Set-RunKey @callArgs | Out-Null

    Assert-True (Test-Path -LiteralPath $ScratchKey) "$label cria a chave quando ela realmente falta"
    $names = @((Get-Item $ScratchKey).GetValueNames())
    Assert-Equal $names.Count 1 "$label deixa so o proprio valor na chave recem-criada"
    Assert-True ($names -contains 'GoLiveBypassTor') "$label grava GoLiveBypassTor na chave nova"
}

Write-Host "`n========================================================" -ForegroundColor Cyan
Write-Host " Set-RunKey: regressao do startup do usuario" -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan

try {
    # Standalone: Set-RunKey sem parametros, le $TorExe/$TorTorrc do escopo.
    Test-SetRunKey 'Standalone' $standalonePath @()

    # Instalador: Set-RunKey($exe, $torrc).
    Test-SetRunKey 'Instalador' $installerPath @($TorExe, $TorTorrc)
} finally {
    Remove-Item -LiteralPath $ScratchRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "`n========================================================" -ForegroundColor Cyan
Write-Host " Resumo dos Testes: $pass passaram, $fail falharam" -ForegroundColor $(if ($fail -eq 0) { 'Green' } else { 'Red' })
Write-Host "========================================================`n" -ForegroundColor Cyan

if ($fail -gt 0) { exit 1 }
