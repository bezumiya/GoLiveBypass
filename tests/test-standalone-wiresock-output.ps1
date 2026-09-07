$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$standalonePath = Join-Path $repoRoot 'standalone\GoLiveBypass-Standalone.ps1'
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($standalonePath, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw "Standalone possui erros de sintaxe: $($errors[0].Message)" }
$ensureAst = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Ensure-WireSock' }, $true)
if (-not $ensureAst) { throw 'Ensure-WireSock nao encontrada no standalone.' }

# Carrega somente a funcao sob teste. O entrypoint do standalone continua desabilitado
# e nao deve ser executado por esta regressao.
. ([scriptblock]::Create($ensureAst.Extent.Text))
function Write-Step([string]$message) { Write-Host $message }
function Write-Warn([string]$message) { Write-Host $message }

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) "glb-wiresock-output-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
$oldProgramW6432 = $env:ProgramW6432
$oldWingetExit = $env:GLB_WINGET_EXIT
$oldWiresockCreate = $env:GLB_WIRESOCK_CREATE
$oldWiresockCandidate = $env:GLB_WIRESOCK_CANDIDATE
$pass = 0
$fail = 0

function Assert-True([bool]$condition, [string]$description) {
    if ($condition) { $script:pass++; Write-Host "[OK] $description" }
    else { $script:fail++; Write-Host "[FAIL] $description"; throw $description }
}

try {
    $env:ProgramW6432 = $tempRoot
    $candidateDir = Join-Path $tempRoot 'WireSock Secure Connect\sdk'
    $candidate = Join-Path $candidateDir 'wiresock-client.exe'
    $script:expectedCandidate = $candidate
    $wingetCmd = Join-Path $tempRoot 'winget.cmd'
    $env:GLB_WIRESOCK_CANDIDATE = $candidate

    # Get-Command e resolvido pelo cmdlet real para o executavel instalado; somente
    # winget.exe e redirecionado para o simulador .cmd controlado pelo teste.
    function Get-Command {
        param([Parameter(Position=0)][string]$Name, [Parameter(ValueFromRemainingArguments=$true)]$Remaining)
        if ($Name -eq 'winget.exe') {
            return [pscustomobject]@{ Source = $script:glbWingetCmd }
        }
        if ($Name -eq 'wiresock-client.exe') { return $null }
        Microsoft.PowerShell.Core\Get-Command -Name $Name @Remaining
    }
    function Test-Path {
        param([Parameter(Position=0)][string]$LiteralPath, [Parameter(ValueFromRemainingArguments=$true)]$Remaining)
        if ($LiteralPath -match '(?i)[\\/]WireSock Secure Connect[\\/]sdk[\\/]wiresock-client\.exe$') {
            return [bool]($LiteralPath -eq $script:expectedCandidate -and [IO.File]::Exists($script:expectedCandidate))
        }
        Microsoft.PowerShell.Management\Test-Path -LiteralPath $LiteralPath @Remaining
    }

    # Caso 1: instalacao previa retorna apenas o caminho.
    New-Item -ItemType Directory -Path $candidateDir -Force | Out-Null
    [IO.File]::WriteAllText($candidate, '')
    $previous = @(& Ensure-WireSock)
    Assert-True ($previous.Count -eq 1 -and $previous[0] -eq $candidate) 'instalado previamente retorna uma string unica'
    Remove-Item -LiteralPath $candidate -Force

    # O simulador escreve stdout, cria o executavel e termina com codigo configuravel.
    $script:glbWingetCmd = $wingetCmd
    [IO.File]::WriteAllText($wingetCmd, "@echo winget-output`r`nif /i `"%GLB_WIRESOCK_CREATE%`"==`"1`" type nul > `"%GLB_WIRESOCK_CANDIDATE%`"`r`nexit /b %GLB_WINGET_EXIT%`r`n")

    # Caso 2: stdout + sucesso nao contamina o retorno.
    $env:GLB_WINGET_EXIT = '0'
    $env:GLB_WIRESOCK_CREATE = '1'
    $success = @(& Ensure-WireSock)
    Assert-True ($success.Count -eq 1 -and $success[0] -eq $candidate) 'winget com stdout e sucesso retorna apenas o caminho'
    Remove-Item -LiteralPath $candidate -Force

    # Caso 3: sem executavel apos winget produz falha real.
    $env:GLB_WIRESOCK_CREATE = '0'
    $failure = $null
    try { @(& Ensure-WireSock) | Out-Null } catch { $failure = $_.Exception.Message }
    Assert-True ($failure -and $failure -match 'Nao consegui instalar') 'winget sem executavel preserva a falha de instalacao'

    # Caso 4: codigo nativo diferente de zero aparece na falha; a saida do winget
    # continua sendo enviada ao host e nao vira valor de retorno.
    $env:GLB_WINGET_EXIT = '17'
    $nonZero = $null
    try { @(& Ensure-WireSock) | Out-Null } catch { $nonZero = $_.Exception.Message }
    Assert-True ($nonZero -and $nonZero -match 'codigo 17') 'codigo nao zero do winget nao e silenciado'

    # Mesmo com codigo nao zero, um executavel que ficou disponivel continua sendo
    # aceito pela semantica existente apos a tentativa de instalacao.
    $env:GLB_WIRESOCK_CREATE = '1'
    $visible = @(& Ensure-WireSock)
    Assert-True ($visible.Count -eq 1 -and $visible[0] -eq $candidate) 'codigo nao zero com executavel visivel retorna apenas o caminho'
} finally {
    $env:ProgramW6432 = $oldProgramW6432
    $env:GLB_WINGET_EXIT = $oldWingetExit
    $env:GLB_WIRESOCK_CREATE = $oldWiresockCreate
    $env:GLB_WIRESOCK_CANDIDATE = $oldWiresockCandidate
    Remove-Variable -Name glbWingetCmd -Scope Script -ErrorAction SilentlyContinue
    Remove-Variable -Name expectedCandidate -Scope Script -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}

if ($fail -gt 0) { exit 1 }
Write-Host "standalone wiresock output: $pass passed"
