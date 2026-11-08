# PowerShell test script for error handling and null-safety validation
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $repoRoot) { $repoRoot = (Get-Location).Path }

$installerPath = Join-Path $repoRoot 'installer\GoLiveBypass-Installer.ps1'
$standalonePath = Join-Path $repoRoot 'standalone\GoLiveBypass-Standalone.ps1'

# Garante UTF-8 com BOM para compatibilidade com o parser do Windows PowerShell 5.1
$utf8Bom = New-Object System.Text.UTF8Encoding($true)
foreach ($f in @($installerPath, $standalonePath)) {
    if (Test-Path -LiteralPath $f) {
        $text = [System.IO.File]::ReadAllText($f, [System.Text.Encoding]::UTF8)
        [System.IO.File]::WriteAllText($f, $text, $utf8Bom)
    }
}

Write-Host "`n========================================================" -ForegroundColor Cyan
Write-Host " 1. Validando Sintaxe dos Scripts PowerShell" -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan

function Test-ScriptSyntax($path) {
    $tokens = $null
    $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors) | Out-Null
    if ($errors.Count -gt 0) {
        Write-Host "  [FAIL] $path possui erros de sintaxe:" -ForegroundColor Red
        $errors | ForEach-Object { Write-Host "    Linha $($_.Extent.StartLineNumber): $($_.Message)" }
        return $false
    }
    Write-Host "  [OK] $($path | Split-Path -Leaf) - Sintaxe valida" -ForegroundColor Green
    return $true
}

$syntaxOk1 = Test-ScriptSyntax $installerPath
$syntaxOk2 = Test-ScriptSyntax $standalonePath
if (-not $syntaxOk1 -or -not $syntaxOk2) {
    exit 1
}

Write-Host "`n========================================================" -ForegroundColor Cyan
Write-Host " 2. Carregando e Testando Funcoes" -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan

# Carrega funcoes do instalador
$installerContent = Get-Content -LiteralPath $installerPath -Raw
$idx = $installerContent.LastIndexOf("Show-Banner")
$truncatedInstaller = $installerContent.Substring(0, $idx)
$tempInstaller = Join-Path ([System.IO.Path]::GetTempPath()) "test-temp-installer.ps1"
Set-Content -LiteralPath $tempInstaller -Value $truncatedInstaller -Encoding UTF8
. $tempInstaller

$installerWaitAntesDeFechar = ${function:Wait-AntesDeFechar}
$installerTestJanela = ${function:Test-JanelaTransitoria}

# Carrega funcoes do standalone; o marcador contempla LF e CRLF.
$standaloneContent = Get-Content -LiteralPath $standalonePath -Raw
$idx2 = $standaloneContent.IndexOf("Write-Host ''`nWrite-Host '  GoLiveBypass standalone'")
if ($idx2 -lt 0) { $idx2 = $standaloneContent.IndexOf("Write-Host ''`r`nWrite-Host '  GoLiveBypass standalone'") }
if ($idx2 -lt 0) { throw 'Nao consegui localizar o inicio seguro do standalone para o teste.' }

# O standalone mantido está pausado por um `exit 1` top-level antes das funções.
# Dot-sourcear esse recorte sem remover somente esse bloqueio encerra o próprio
# harness antes de Get-InjectionState existir. Remova a primeira ocorrência em
# uma cópia temporária; o CLI real nunca é executado e exits condicionais ficam
# intactos para não mascarar outros caminhos.
$standalonePrefix = $standaloneContent.Substring(0, $idx2)
$topLevelExit = [regex]::Match($standalonePrefix, '(?m)^[ \t]*exit 1[ \t]*(?:\r?\n|$)')
if ($topLevelExit.Success) {
    $standalonePrefix = $standalonePrefix.Remove($topLevelExit.Index, $topLevelExit.Length)
}
$truncatedStandalone = $standalonePrefix
$tempStandalone = Join-Path ([System.IO.Path]::GetTempPath()) "test-temp-standalone.ps1"
Set-Content -LiteralPath $tempStandalone -Value $truncatedStandalone -Encoding UTF8
. $tempStandalone

$standaloneShouldReport = ${function:Test-ShouldReport}
$standaloneWaitAntesDeFechar = ${function:Wait-AntesDeFechar}
$standaloneTestJanela = ${function:Test-JanelaTransitoria}

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

Write-Host "`n-- 2.1 Test-ShouldReport (Standalone) --" -ForegroundColor Yellow

$testMessages = @(
    # Mensagens que NAO devem reportar (retornam $false)
    @{ Msg = "Não é possível associar o argumento ao parâmetro 'Path' porque ele é nulo."; Expected = $false; Desc = "PT-BR com acentos (erro da issue)" },
    @{ Msg = "Nao e possivel associar o argumento ao parametro 'Path' porque ele e nulo."; Expected = $false; Desc = "PT-BR sem acentos" },
    @{ Msg = "Não é possível associar o argumento ao parâmetro 'LiteralPath' porque ele é uma cadeia de caracteres vazia."; Expected = $false; Desc = "PT-BR cadeia de caracteres vazia" },
    @{ Msg = "Cannot bind argument to parameter 'Path' because it is null."; Expected = $false; Desc = "EN parameter is null" },
    @{ Msg = "Cannot bind argument to parameter 'Path' because it is an empty string."; Expected = $false; Desc = "EN parameter empty string" },
    @{ Msg = "A operacao foi cancelada pelo usuario."; Expected = $false; Desc = "Cancelado pelo usuario PT" },
    @{ Msg = "A operação foi cancelada pelo usuário."; Expected = $false; Desc = "Cancelado pelo usuário acentuado" },
    @{ Msg = "The operation was canceled by the user."; Expected = $false; Desc = "Canceled by user EN" },
    @{ Msg = "Illegal characters in path."; Expected = $false; Desc = "Illegal characters" },
    @{ Msg = "O Discord nao fechou. Feche pelo icone na bandeja e rode de novo."; Expected = $false; Desc = "Discord nao fechou" },
    @{ Msg = "Opcao desconhecida: --foo"; Expected = $false; Desc = "Opcao desconhecida" },
    @{ Msg = "git clone falhou"; Expected = $false; Desc = "git clone falhou" },
    
    # Mensagens que DEVEM reportar (retornam $true)
    @{ Msg = "NullReferenceException: Object reference not set to an instance of an object."; Expected = $true; Desc = "Excecao inesperada" },
    @{ Msg = "Erro desconhecido ao processar pacote asar."; Expected = $true; Desc = "Erro desconhecido" }
)

# O instalador nao decide mais sobre envio remoto (escopo B): Test-ShouldReport saiu
# junto com a chamada automatica. O standalone mantem o comportamento proprio.
foreach ($t in $testMessages) {
    $resStand = & $standaloneShouldReport $t.Msg
    Assert-Equal $resStand $t.Expected "Standalone Test-ShouldReport: $($t.Desc)"
}

Write-Host "`n-- 2.2 Null/Empty Safety em Funcoes Auxiliares --" -ForegroundColor Yellow

# Test-DiscordResourcesReady
Assert-Equal (Test-DiscordResourcesReady $null) $false "Test-DiscordResourcesReady($null) retorna $false"
Assert-Equal (Test-DiscordResourcesReady "") $false "Test-DiscordResourcesReady('') retorna $false"

# Get-InjectedPath
Assert-Equal (Get-InjectedPath $null) $null "Get-InjectedPath($null) retorna $null"
Assert-Equal (Get-InjectedPath "") $null "Get-InjectedPath('') retorna $null"

# Test-InjectedFromCheckout
Assert-Equal (Test-InjectedFromCheckout $null) $false "Test-InjectedFromCheckout($null) retorna $false"
Assert-Equal (Test-InjectedFromCheckout "") $false "Test-InjectedFromCheckout('') retorna $false"

# Get-InstalledPluginVersion
Assert-Equal (Get-InstalledPluginVersion $null) $null "Get-InstalledPluginVersion($null) retorna $null"
Assert-Equal (Get-InstalledPluginVersion "") $null "Get-InstalledPluginVersion('') retorna $null"

# Backup-Plugin
try {
    Backup-Plugin $null
    Assert-Equal $true $true "Backup-Plugin($null) nao lanca excecao"
} catch {
    Assert-Equal $false $true "Backup-Plugin($null) lancou excecao: $($_.Exception.Message)"
}

# Save-Text
try {
    Save-Text $null "test content"
    Assert-Equal $true $true "Save-Text($null, ...) nao lanca excecao"
} catch {
    Assert-Equal $false $true "Save-Text($null, ...) lancou excecao: $($_.Exception.Message)"
}

# Get-InjectionState
Assert-Equal (Get-InjectionState $null) 'Vanilla' "Get-InjectionState($null) retorna Vanilla"
Assert-Equal (Get-InjectionState "") 'Vanilla' "Get-InjectionState('') retorna Vanilla"

# Test-ModCheckout
Assert-Equal (Test-ModCheckout $null) $false "Test-ModCheckout($null) retorna $false"
Assert-Equal (Test-ModCheckout "") $false "Test-ModCheckout('') retorna $false"

Write-Host "`n-- 2.3 Testando Install-Patcher sem PSScriptRoot --" -ForegroundColor Yellow

$origPSScriptRoot = $PSScriptRoot
$origInstallDir = $InstallDir
$testInstallDir = Join-Path ([System.IO.Path]::GetTempPath()) "GoLiveBypassTest_$([Guid]::NewGuid().ToString('N'))"
$InstallDir = $testInstallDir

try {
    $PSScriptRoot = $null
    Install-Patcher
    $installedPatcher = Join-Path $testInstallDir 'golivebypass.js'
    $settingsFile = Join-Path $testInstallDir 'settings.json'
    
    Assert-Equal (Test-Path -LiteralPath $installedPatcher) $true "Install-Patcher cria golivebypass.js mesmo sem PSScriptRoot"
    Assert-Equal (Test-Path -LiteralPath $settingsFile) $true "Install-Patcher cria settings.json mesmo sem PSScriptRoot"
} catch {
    Assert-Equal $false $true "Install-Patcher sem PSScriptRoot falhou: $($_.Exception.Message)"
} finally {
    if (Test-Path -LiteralPath $testInstallDir) {
        Remove-Item -LiteralPath $testInstallDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    $InstallDir = $origInstallDir
}

Write-Host "`n-- 2.4 Get-EffectiveLocalApp (caminho 8.3, issue #94) --" -ForegroundColor Yellow

$origLocalAppData = $env:LOCALAPPDATA
try {
    # LOCALAPPDATA apontando para caminho que NAO existe (forma 8.3 orfa): tem que
    # cair para o fallback que resolve, nunca devolver o caminho quebrado.
    $env:LOCALAPPDATA = Join-Path ([System.IO.Path]::GetTempPath()) "nao-existe-$(Get-Random)"
    $fallback = Get-EffectiveLocalApp
    Assert-Equal (Test-Path -LiteralPath $fallback) $true "Get-EffectiveLocalApp cai para fallback resolvivel com LOCALAPPDATA orfao"
    Assert-Equal ($fallback -eq $env:LOCALAPPDATA) $false "Get-EffectiveLocalApp nao devolve o caminho orfao"

    # LOCALAPPDATA valido: devolvido sem mudanca.
    $valido = [System.IO.Path]::GetTempPath().TrimEnd('\', '/')
    $env:LOCALAPPDATA = $valido
    Assert-Equal (Get-EffectiveLocalApp) $valido "Get-EffectiveLocalApp devolve LOCALAPPDATA valido sem alteracao"
} finally {
    $env:LOCALAPPDATA = $origLocalAppData
}

# Get-ReportMeta saiu junto com o envio automatico (escopo B: log local/manual).

Write-Host "`n-- 2.5 Descoberta e injecao segura de mod --" -ForegroundColor Yellow
$selectTargetStart = $installerContent.IndexOf('function Select-Target')
$selectTargetBody = $installerContent.Substring($selectTargetStart, 700)
Assert-Equal ($selectTargetBody -match 'Detectei .*nao encontrei o checkout fonte') $false "Fonte ausente nao bloqueia mod detectado"
Assert-Equal ($selectTargetBody -match 'Install-Mod \(Show-ModChoice\)') $true "Fonte ausente oferece download explicito"
Assert-Equal ($installerContent -match 'Get-InstallerLogFile') $true "Instalador grava log local"
Assert-Equal ($installerContent -match 'installer\.checkout_rejected') $true "Instalador registra rejeicao de checkout (#293)"
Assert-Equal ($installerContent -match 'MOD_INSTALLED_WITHOUT_CHECKOUT') $true "Rejeicao da #293 tem codigo proprio"
Assert-Equal ($installerContent -match 'Invoke-SendAutoReport|BugApiToken|includeLogs') $false "Instalador nao envia relatorio remoto"

Write-Host "`n-- 2.6 Log local do instalador (installer.log, sem telemetria) --" -ForegroundColor Yellow

$logTemp = Join-Path ([System.IO.Path]::GetTempPath()) "glb-installer-log-$([Guid]::NewGuid().ToString('N'))"
$origLogDir = $env:GLB_INSTALLER_LOG_DIR
$env:GLB_INSTALLER_LOG_DIR = $logTemp
try {
    Assert-Equal (Test-Path -LiteralPath $logTemp) $false "Diretorio de log nao existe antes do primeiro evento"

    Write-InstallerEvent 'info' 'installer.detect.started' 'detect' @{ mode = 'Install' }
    $logFile = Get-InstallerLogFile
    Assert-Equal (Test-Path -LiteralPath $logFile) $true "Write-InstallerEvent cria installer.log"
    Assert-Equal ($logFile -like '*GoLiveBypass') $false "Log de teste fica fora do diretorio de dados real"
    Assert-Equal (Split-Path -Leaf $logFile) 'installer.log' "log se chama installer.log"

    $lineRaw = (Get-Content -LiteralPath $logFile -First 1)
    $line = $lineRaw | ConvertFrom-Json
    Assert-Equal $line.schema_version 1 "linha JSONL tem schema_version"
    Assert-Equal $line.level 'info' "linha tem level"
    Assert-Equal $line.component 'installer.windows' "linha identifica installer.windows"
    Assert-Equal $line.event 'installer.detect.started' "linha tem o evento"
    Assert-Equal $line.phase 'detect' "linha tem a fase"
    Assert-Equal ($line.ts -match '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$') $true "ts ISO-8601 UTC com milissegundos"
    Assert-Equal $line.data.mode 'Install' "campo observável mode preservado"

    Write-InstallerEvent 'error' 'installer.failed' 'detect' @{ reason = 'falhou em C:\Users\alice\Equicord'; token = 'abc123'; senha = 's3cr3t'; campo_desconhecido = 'x' }
    $lastRaw = (Get-Content -LiteralPath $logFile -Last 1)
    $last = $lastRaw | ConvertFrom-Json
    Assert-Equal ($lastRaw -match 'alice|abc123|s3cr3t') $false "segredos originais nao fluem para o raw"
    Assert-Equal ([string]$last.data.reason -match '<path>$') $true "caminho absoluto vira <path> no fim do valor parseado"
    Assert-Equal $last.data.token '<redacted>' "chave proibida token vira <redacted>"
    Assert-Equal $last.data.senha '<redacted>' "chave proibida senha vira <redacted>"
    Assert-Equal ($last.data.PSObject.Properties.Name -contains 'campo_desconhecido') $false "chave desconhecida e descartada"

    # Cabecalho de autenticacao, URL com credencial e e-mail tambem sao redigidos.
    Write-InstallerEvent 'warn' 'installer.probe' 'detect' @{ reason = 'Authorization: Bearer eyJhbGciOi.abc.def em https://alice:s3cr3t@example.test/x contato alice@example.com' }
    $lastRaw = (Get-Content -LiteralPath $logFile -Last 1)
    $last = $lastRaw | ConvertFrom-Json
    Assert-Equal ($lastRaw -match 'eyJhbGciOi|s3cr3t|alice@example.com|example\.test/x') $false "segredos e host/path originais nao fluem para o raw"
    $reason = [string]$last.data.reason
    Assert-Equal ($reason -match 'Authorization=<redacted>') $true "cabecalho Authorization e redigido no valor parseado"
    Assert-Equal ($reason -match '<redacted-url>') $true "URL com credencial vira <redacted-url> no valor parseado"
    Assert-Equal ($reason -match 'example\.test/x') $false "host/path privado nao fluem no valor parseado"
    Assert-Equal ($reason -match '<email>') $true "e-mail vira <email> no valor parseado"

    # Valor aninhado nao e stringificado.
    Write-InstallerEvent 'warn' 'installer.probe' 'detect' @{ reason = @('a', 'b') }
    $last = (Get-Content -LiteralPath $logFile -Last 1) | ConvertFrom-Json
    Assert-Equal ([string]$last.data.reason) '<redacted>' "valor nao escalar vira <redacted> no valor parseado"

    # Falha de escrita nao pode lancar nem interromper o instalador.
    $env:GLB_INSTALLER_LOG_DIR = Join-Path $logFile 'nao-e-pasta'
    try {
        Write-InstallerEvent 'info' 'installer.probe' 'detect' @{ count = 1 }
        Assert-Equal $true $true "falha de escrita no log nao lanca"
    } catch {
        Assert-Equal $false $true "falha de escrita no log lancou: $($_.Exception.Message)"
    }
} finally {
    $env:GLB_INSTALLER_LOG_DIR = $origLogDir
    if (Test-Path -LiteralPath $logTemp) { Remove-Item -LiteralPath $logTemp -Recurse -Force -ErrorAction SilentlyContinue }
}

Write-Host "`n-- 2.7 Fixture de pnpm/injecao por alvo --" -ForegroundColor Yellow
$originalInvokePnpm = ${function:Invoke-Pnpm}
$originalFindPnpmApplications = ${function:Find-PnpmApplications}
$originalGetInjectedPath = ${function:Get-InjectedPath}
$originalStopDiscord = ${function:Stop-Discord}
$origInjectionLogDir = $env:GLB_INSTALLER_LOG_DIR
$injectionRoot = Join-Path ([System.IO.Path]::GetTempPath()) "GoLiveBypassInjection_$([Guid]::NewGuid().ToString('N'))"
$injectionLogDir = Join-Path $injectionRoot 'logs'
New-Item -ItemType Directory -Path $injectionRoot -Force | Out-Null
$resourcesOne = Join-Path $injectionRoot 'Discord\app-1.0.0\resources'
$resourcesTwo = Join-Path $injectionRoot 'DiscordPTB\app-1.0.0\resources'
$script:mockInjectedPaths = @{}
$script:mockInjectionMode = 'minus-one'
$script:mockInjectionArgs = @()
try {
    # Sem app pnpm descoberto, o wrapper devolve um código determinístico, sem executar
    # fallback cego nem confundir um LASTEXITCODE herdado.
    function Find-PnpmApplications { @() }
    $script:PnpmExitCode = -1
    Invoke-Pnpm @('run', 'inject', '--location', (Split-Path -Parent (Split-Path -Parent $resourcesOne)))
    Assert-Equal $script:PnpmExitCode 127 "Invoke-Pnpm usa exit=127 quando nao ha application pnpm"

    # Regressao do log real da VM: no Windows PowerShell 5.1 a primeira linha que um processo
    # nativo escreve em stderr vira erro TERMINATIVO com ErrorActionPreference=Stop, mesmo com
    # 2>&1 — era assim que a injecao morria em exit=-1/POSTCONDITION_NOT_CONFIRMED no banner do
    # pnpm antes de chamar o Equilotl (que loga tudo em stderr). O wrapper real tem que seguir,
    # guardar o codigo de saida e manter o texto no detalhe.
    $originalResolvePnpmInvocation = ${function:Resolve-PnpmInvocation}
    function Resolve-PnpmInvocation([string[]]$Arguments) {
        $hostExe = (Get-Process -Id $PID).Path
        # -Command com aspas cai no quoting do Windows PowerShell 5.1: o argumento com
        # espacos chega fatiado ao processo nativo, o stub nem compila e o teste mede
        # outra coisa. -EncodedCommand e um argumento base64 unico — o caso real fica
        # isolado: stderr do filho nativo e codigo de saida 7.
        $payload = '[Console]::Error.WriteLine("banner-de-teste"); exit 7'
        $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($payload))
        return [pscustomobject]@{
            Command = $hostExe
            Arguments = @('-NoProfile', '-NonInteractive', '-EncodedCommand', $encoded)
        }
    }
    try {
        $saidaStderr = @()
        $saidaStderr = @(Invoke-Pnpm @('run', 'inject'))
        Assert-Equal $script:PnpmExitCode 7 "stderr nativo nao interrompe o Invoke-Pnpm real"
        Assert-Equal (($saidaStderr -join ' ') -match 'banner-de-teste') $true "stderr fica capturado na saida do Invoke-Pnpm"
    } catch {
        Assert-Equal $false $true "stderr nativo lancou do Invoke-Pnpm real: $($_.Exception.Message)"
    } finally {
        Set-Item -Path Function:Resolve-PnpmInvocation -Value $originalResolvePnpmInvocation
    }

    function Invoke-Pnpm([string[]]$Arguments) {
        $script:mockInjectionArgs = @($Arguments)
        switch ($script:mockInjectionMode) {
            'zero' { $script:PnpmExitCode = 0; Write-Output 'injecao sintetica'; return }
            'nine' { $script:PnpmExitCode = 9; Write-Output ('diagnostico sintetico ' + ('x' * 700)); return }
            'exception' { $script:PnpmExitCode = $null; throw ('erro sintetico ' + ('x' * 700)) }
            # Primeiro tiro: o Equilotl avisa que o arquivo esta em uso e a pos-condicao
            # falha; segundo tiro: injeta e confirma. E o caminho do cliente reaberto pelo
            # Update.exe entre o Stop-Discord e o injetor.
            'lockonce' {
                $script:mockLockCalls = [int]$script:mockLockCalls + 1
                if ($script:mockLockCalls -eq 1) {
                    $script:PnpmExitCode = 1
                    $script:mockInjectedPaths.Remove([string]$script:mockLockKey)
                    Write-Output "INFO Patching $($script:mockLockKey) INFO is already patched. Unpatching first... ERROR Cannot patch because the files are used by a different process."
                    return
                }
                $script:PnpmExitCode = 0
                $script:mockInjectedPaths[[string]$script:mockLockKey] = Join-Path $injectionRoot 'dist\desktop'
                Write-Output 'injecao aplicada na segunda tentativa'
                return
            }
            default { $script:PnpmExitCode = -1; Write-Output ('diagnostico sintetico ' + ('x' * 700)) }
        }
    }
    function Get-InjectedPath($resources) { return $script:mockInjectedPaths[$resources] }
    $script:mockStopDiscordCalls = 0
    function Stop-Discord { $script:mockStopDiscordCalls = [int]$script:mockStopDiscordCalls + 1 }
    $env:GLB_INSTALLER_LOG_DIR = $injectionLogDir

    $targetOne = [pscustomobject]@{ Flavour = 'Discord'; Resources = $resourcesOne; Tipo = 'O' }
    $targetTwo = [pscustomobject]@{ Flavour = 'DiscordPTB'; Resources = $resourcesTwo; Tipo = 'O' }
    $script:mockInjectedPaths[$resourcesOne] = Join-Path $injectionRoot 'dist\desktop'
    Invoke-Injection $injectionRoot @($targetOne)
    Assert-Equal (($script:mockInjectionArgs -join '|') -eq 'run|inject|--location|' + (Split-Path -Parent (Split-Path -Parent $resourcesOne))) $true "Invoke-Injection envia a raiz sem -- extra"
    Assert-Equal $script:PnpmExitCode -1 "exit=-1 com stub confirmado nao falha"
    $events = @(Get-Content -LiteralPath (Get-InstallerLogFile) | ForEach-Object { $_ | ConvertFrom-Json })
    $warning = $events | Where-Object { $_.event -eq 'installer.inject' -and $_.data.result -eq 'warning' } | Select-Object -Last 1
    Assert-Equal ($null -ne $warning -and $warning.data.reason_code -eq 'POSTCONDITION_CONFIRMED_NONZERO' -and $warning.data.exit_code -eq -1) $true "exit=-1 confirmado vira warning no evento canonico"
    Assert-Equal ((Format-InjectionDetail ('x' * 700)).Length -le 603) $true "saida do injector e limitada"
    $redacted = Format-InjectionDetail 'Authorization: Bearer secret-token https://alice:secret@example.test/x mfa.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    Assert-Equal ($redacted -notmatch 'secret-token|secret@example|mfa\.A') $true "detalhe do injector nao vaza credencial ou token"

    $script:mockInjectionMode = 'zero'
    $script:mockInjectedPaths.Remove($resourcesOne)
    try {
        Invoke-Injection $injectionRoot @($targetOne)
        Assert-Equal $false $true "Exit zero sem pos-condicao deveria falhar"
    } catch {
        Assert-Equal ($_.Exception.Message -match 'pos-condicao nao confirmada') $true "Exit zero sem pos-condicao falha pelo estado do alvo"
    }

    $script:mockInjectedPaths[$resourcesOne] = Join-Path $injectionRoot 'dist\desktop'
    $script:mockInjectionMode = 'nine'
    Invoke-Injection $injectionRoot @($targetOne)
    Assert-Equal $script:PnpmExitCode 9 "exit=9 com stub confirmado nao falha"

    $script:mockInjectionMode = 'exception'
    Invoke-Injection $injectionRoot @($targetOne)
    Assert-Equal $script:PnpmExitCode -1 "excecao sem codigo recebe exit=-1 deterministico"

    $script:mockInjectionMode = 'zero'
    try {
        Invoke-Injection $injectionRoot @($targetOne, $targetTwo)
        Assert-Equal $false $true "Um alvo nao pode aprovar outro"
    } catch {
        Assert-Equal ($_.Exception.Message -match 'DiscordPTB: pos-condicao nao confirmada') $true "Pos-condicao e independente por alvo"
    }

    # Cliente reaberto pelo Update.exe entre o Stop-Discord e o injetor: o Equilotl avisa
    # que o arquivo esta em uso e desfaz o patch. O instalador tem que fechar de novo
    # (agora esperando a trava sair) e repetir UMA vez em vez de deixar o cliente sem o mod.
    $script:mockInjectionMode = 'lockonce'
    $script:mockLockCalls = 0
    $script:mockLockKey = $resourcesOne
    $script:mockInjectedPaths[$resourcesOne] = Join-Path $injectionRoot 'dist\desktop'
    $script:mockStopDiscordCalls = 0
    Invoke-Injection $injectionRoot @($targetOne)
    Assert-Equal $script:mockLockCalls 2 "injetor que acusa arquivo em uso e repetido uma vez"
    Assert-Equal $script:mockStopDiscordCalls 2 "a repeticao fecha o Discord de novo (1 inicial + 1 do retry)"
    Assert-Equal $script:PnpmExitCode 0 "segunda tentativa confirmada nao falha"
} finally {
    $env:GLB_INSTALLER_LOG_DIR = $origInjectionLogDir
    Set-Item -Path Function:Invoke-Pnpm -Value $originalInvokePnpm
    Set-Item -Path Function:Find-PnpmApplications -Value $originalFindPnpmApplications
    Set-Item -Path Function:Get-InjectedPath -Value $originalGetInjectedPath
    Set-Item -Path Function:Stop-Discord -Value $originalStopDiscord
    if (Test-Path -LiteralPath $injectionRoot) { Remove-Item -LiteralPath $injectionRoot -Recurse -Force -ErrorAction SilentlyContinue }
}

Write-Host "`n-- 2.8 Travas de arquivo do Discord (app.asar) --" -ForegroundColor Yellow
# O standalone define o proprio Stop-Discord e, por ser dot-sourced depois do instalador,
# ele sombreia o do instalador. Estas provas sao do instalador: recarrega as funcoes dele
# e devolve o standalone ao lugar no fim.
. $tempInstaller
$lockRoot = Join-Path ([System.IO.Path]::GetTempPath()) "GoLiveBypassLock_$([Guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $lockRoot -Force | Out-Null
$lockFile = Join-Path $lockRoot 'app.asar'
Set-Content -LiteralPath $lockFile -Value 'asar sintetico' -Encoding UTF8
$originalGetDiscordProcesses = ${function:Get-DiscordProcesses}
$trava = $null
try {
    # Nada de tocar em processos reais do Discord numa maquina de desenvolvimento.
    function Get-DiscordProcesses { return @() }
    Assert-Equal (Test-ArquivoLivre $lockFile) $true "app.asar sem trava passa"
    $trava = [IO.File]::Open($lockFile, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    Assert-Equal (Test-ArquivoLivre $lockFile) $false "app.asar com handle aberto nao passa"
    $travados = @(Get-DiscordResourcesTravados @($lockRoot))
    Assert-Equal ($travados.Count -eq 1 -and $travados[0] -eq $lockFile) $true "Get-DiscordResourcesTravados aponta o app.asar travado"
    try {
        Stop-Discord -Resources @($lockRoot) -TentativasProcessos 1 -TentativasTravas 2
        Assert-Equal $false $true "Stop-Discord nao pode liberar a injecao com o arquivo travado"
    } catch {
        Assert-Equal ($_.Exception.Message -match 'continuam em uso') $true "Stop-Discord explica a trava antes do unpatch do cliente"
    }
    $trava.Close(); $trava = $null
    Assert-Equal ((@(Get-DiscordResourcesTravados @($lockRoot))).Count -eq 0) $true "trava liberada sai da lista"
    $erroLivre = $null
    try { Stop-Discord -Resources @($lockRoot) -TentativasProcessos 1 -TentativasTravas 2 } catch { $erroLivre = $_.Exception.Message }
    Assert-Equal $erroLivre $null "Stop-Discord segue quando o arquivo esta livre"
} finally {
    if ($trava) { $trava.Close() }
    Set-Item -Path Function:Get-DiscordProcesses -Value $originalGetDiscordProcesses
    Remove-Item -LiteralPath $lockRoot -Recurse -Force -ErrorAction SilentlyContinue
    # A secao 3 volta a medir o standalone: devolve as definicoes dele ao lugar.
    . $tempStandalone
}

Write-Host "`n-- 2.9 Build do mod: pre-requisitos de git e falha diagnosticavel --" -ForegroundColor Yellow
# Causa real do relato "pnpm build falhou" sem detalhe (VM, 2026-10): o build do mod roda
# "git rev-parse" em scripts/build/common.mjs e morre com exit 1 quando o Git nao esta no
# PATH ou o checkout veio de zip (sem .git); o relato anterior so dizia "pnpm build falhou".
$buildRoot = Join-Path ([System.IO.Path]::GetTempPath()) "GoLiveBypassBuild_$([Guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path (Join-Path $buildRoot 'node_modules') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $buildRoot '.git') -Force | Out-Null
$originalInvokePnpmBuild = ${function:Invoke-Pnpm}
$originalFindGitApplication = ${function:Find-GitApplication}
$originalTestGitComandoOk = ${function:Test-GitComandoOk}
$origLogDirBuild = $env:GLB_INSTALLER_LOG_DIR
try {
    $env:GLB_INSTALLER_LOG_DIR = Join-Path $buildRoot 'logs'

    # git e checkout ok, mas o pnpm falha: a mensagem tem que carregar o FIM da saida.
    function Find-GitApplication { return [pscustomobject]@{ Source = 'git-stub' } }
    function Test-GitComandoOk([string]$GitSource, [string[]]$GitArgs) { return $true }
    function Invoke-Pnpm([string[]]$Arguments) {
        if ($Arguments -contains 'install') { $script:PnpmExitCode = 0; return }
        $script:PnpmExitCode = 1
        1..12 | ForEach-Object { Write-Output ("linha-de-enchimento-$_") }
        Write-Output 'Error: Command failed: git rev-parse HEAD'
        Write-Output '[ELIFECYCLE] Command failed with exit code 1.'
        return
    }
    $buildLogFile = Join-Path $env:GLB_INSTALLER_LOG_DIR 'installer.log'
    try {
        Build-Mod $buildRoot
        Assert-Equal $false $true "Build-Mod com pnpm exit=1 deveria falhar"
    } catch {
        $msg = $_.Exception.Message
        Assert-Equal ($msg -match 'pnpm build falhou') $true "falha do build mantem a mensagem original"
        Assert-Equal ($msg -match 'exit=1') $true "falha do build informa o codigo de saida"
        Assert-Equal ($msg -match 'ELIFECYCLE') $true "falha do build traz o fim da saida do pnpm"
        Assert-Equal ($msg -match 'linha-de-enchimento-1 ') $false "falha do build nao carrega a saida inteira"
    }
    # O log tem que explicar o build sem perguntar nada a pessoa: versoes, node_modules e exit.
    Set-Content -LiteralPath (Join-Path $buildRoot 'package.json') -Value '{"name":"equicord","packageManager":"pnpm@12.16.1"}' -Encoding ASCII
    $script:PnpmVersion = '12.8.1'
    Remove-Item -LiteralPath $buildLogFile -Force -ErrorAction SilentlyContinue
    try { Build-Mod $buildRoot } catch {}
    $ctxLinha = @(Get-Content -LiteralPath $buildLogFile -ErrorAction SilentlyContinue | Where-Object { $_ -match '"event":"installer.build_context"' }) | Select-Object -Last 1
    $ctx = if ($ctxLinha) { ($ctxLinha | ConvertFrom-Json).data } else { $null }
    Assert-Equal ([string]$ctx.pnpm_version) '12.8.1' "build_context traz o pnpm em uso"
    Assert-Equal ([string]$ctx.pnpm_esperado) 'pnpm@12.16.1' "build_context traz o pnpm que o projeto pede"
    Assert-Equal $ctx.node_modules $true "build_context diz se o node_modules existia"
    Assert-Equal ([string]$ctx.deps_sync) 'ok' "build_context diz que as dependencias foram sincronizadas"
    Assert-Equal $ctx.exit_code 1 "build_context traz o exit do build"
    Assert-Equal $ctx.saida_vazia $false "build_context marca saida nao vazia"
    Assert-Equal ($ctxLinha -match [regex]::Escape($buildRoot)) $false "build_context nao grava o caminho do checkout"

    # Checkout atualizado com node_modules antigo: o pnpm do Equicord (verifyDepsBeforeRun) morria
    # calado. A mensagem nao pode terminar em "falhou (exit=1): " e nada mais.
    Set-Item -Path Function:Invoke-Pnpm {
        param([string[]]$Arguments)
        if ($Arguments -contains 'install') { $script:PnpmExitCode = 0; return }
        $script:PnpmExitCode = 1
        Write-Output ' '
        return
    }
    Remove-Item -LiteralPath $buildLogFile -Force -ErrorAction SilentlyContinue
    try {
        Build-Mod $buildRoot
        Assert-Equal $false $true "Build-Mod com pnpm calado deveria falhar"
    } catch {
        Assert-Equal ($_.Exception.Message -match 'o pnpm saiu sem nenhuma mensagem') $true "build calado diz que o pnpm nao escreveu nada"
    }
    $ctxLinha = @(Get-Content -LiteralPath $buildLogFile -ErrorAction SilentlyContinue | Where-Object { $_ -match '"event":"installer.build_context"' }) | Select-Object -Last 1
    Assert-Equal (($ctxLinha | ConvertFrom-Json).data.saida_vazia) $true "build_context marca saida vazia"

    # Lockfile que nao bate com o package.json: o --frozen-lockfile falha e o install comum assume.
    $script:mockBuildPnpmArgs = @()
    Set-Item -Path Function:Invoke-Pnpm {
        param([string[]]$Arguments)
        $script:mockBuildPnpmArgs += ,($Arguments -join ' ')
        $script:PnpmExitCode = $(if ($Arguments -contains '--frozen-lockfile') { 1 } else { 0 })
        return
    }
    Build-Mod $buildRoot
    Assert-Equal ($script:mockBuildPnpmArgs -join '|') 'install --frozen-lockfile --config.confirm-modules-purge=false|install --config.confirm-modules-purge=false|build' "lockfile divergente cai no install comum e compila"

    # Install que falha nas duas tentativas: para antes do build, com a causa e o contexto.
    $script:mockBuildPnpmArgs = @()
    Set-Item -Path Function:Invoke-Pnpm {
        param([string[]]$Arguments)
        $script:mockBuildPnpmArgs += ,($Arguments -join ' ')
        $script:PnpmExitCode = $(if ($Arguments -contains 'install') { 1 } else { 0 })
        if ($Arguments -contains 'install') { Write-Output 'ERR_PNPM_FETCH_404 pacote ausente' }
        return
    }
    Remove-Item -LiteralPath $buildLogFile -Force -ErrorAction SilentlyContinue
    try {
        Build-Mod $buildRoot
        Assert-Equal $false $true "Build-Mod com install quebrado deveria falhar"
    } catch {
        Assert-Equal ($_.Exception.Message -match 'pnpm install falhou \(exit=1\).*ERR_PNPM_FETCH_404') $true "install quebrado traz exit e o fim da saida"
    }
    Assert-Equal (@($script:mockBuildPnpmArgs) -contains 'build') $false "install quebrado nao chega ao build"
    $ctxLinha = @(Get-Content -LiteralPath $buildLogFile -ErrorAction SilentlyContinue | Where-Object { $_ -match '"event":"installer.build_context"' }) | Select-Object -Last 1
    Assert-Equal ([string]($ctxLinha | ConvertFrom-Json).data.deps_sync) 'falhou' "build_context marca deps_sync=falhou"

    # Volta ao pnpm que falha so no build para os pre-requisitos de git abaixo.
    Set-Item -Path Function:Invoke-Pnpm {
        param([string[]]$Arguments)
        $script:PnpmExitCode = $(if ($Arguments -contains 'install') { 0 } else { 1 })
        return
    }

    # Git ausente do PATH: falha antes do build, com o que instalar.
    Set-Item -Path Function:Find-GitApplication { return $null }
    try {
        Build-Mod $buildRoot
        Assert-Equal $false $true "Build-Mod sem git deveria falhar antes do build"
    } catch {
        Assert-Equal ($_.Exception.Message -match 'Instale o Git') $true "sem git a mensagem pede a instalacao dele"
    }

    # Git presente, checkout sem historico (zip do GitHub): pede git clone.
    Set-Item -Path Function:Find-GitApplication { return [pscustomobject]@{ Source = 'git-stub' } }
    $rootSemGit = Join-Path ([System.IO.Path]::GetTempPath()) "GoLiveBypassBuildSemGit_$([Guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Path $rootSemGit -Force | Out-Null
    try {
        Build-Mod $rootSemGit
        Assert-Equal $false $true "Build-Mod em checkout sem .git deveria falhar"
    } catch {
        Assert-Equal ($_.Exception.Message -match 'git clone') $true "checkout sem .git pede git clone"
    }
    Remove-Item -LiteralPath $rootSemGit -Recurse -Force -ErrorAction SilentlyContinue

    # Repositorio quebrado: rev-parse falha e o pre-check nao deixa o build comecar.
    Set-Item -Path Function:Test-GitComandoOk {
        param([string]$GitSource, [string[]]$GitArgs)
        return (@($GitArgs) -notcontains 'rev-parse')
    }
    try {
        Build-Mod $buildRoot
        Assert-Equal $false $true "Build-Mod com repositorio quebrado deveria falhar"
    } catch {
        Assert-Equal ($_.Exception.Message -match 'repositorio Git quebrado') $true "repositorio quebrado tem mensagem propria"
    }

    # Sem remote origin (git init seco): o git-remote-plugin do build precisa dele.
    Set-Item -Path Function:Test-GitComandoOk {
        param([string]$GitSource, [string[]]$GitArgs)
        return (@($GitArgs) -notcontains 'remote')
    }
    try {
        Build-Mod $buildRoot
        Assert-Equal $false $true "Build-Mod sem remote origin deveria falhar"
    } catch {
        Assert-Equal ($_.Exception.Message -match "remote 'origin'") $true "checkout sem remote origin tem mensagem propria"
    }

    # Caminho feliz: node_modules presente ainda confere as dependencias (sem reescrever o
    # lockfile) antes do build; checkout atualizado com node_modules antigo travava aqui.
    Set-Item -Path Function:Test-GitComandoOk { param([string]$GitSource, [string[]]$GitArgs) return $true }
    $script:mockBuildPnpmArgs = @()
    Set-Item -Path Function:Invoke-Pnpm {
        param([string[]]$Arguments)
        $script:mockBuildPnpmArgs += ,($Arguments -join ' ')
        $script:PnpmExitCode = 0
        return
    }
    Build-Mod $buildRoot
    Assert-Equal ($script:mockBuildPnpmArgs -join '|') 'install --frozen-lockfile --config.confirm-modules-purge=false|build' "node_modules presente sincroniza com --frozen-lockfile e compila"

    # Detalhe sanitizado: mantem o fim, limita o tamanho e nao vaza credencial.
    $detalhe = Format-PnpmDetail @('preambulo', 'Authorization: Bearer secret-token', 'https://alice:secret@example.test/x', 'fim-importante')
    Assert-Equal ($detalhe -match 'fim-importante') $true "detalhe do build mantem o fim da saida"
    Assert-Equal ($detalhe -notmatch 'secret-token|alice:secret') $true "detalhe do build nao vaza credencial"
    Assert-Equal ((Format-PnpmDetail @(('x' * 900))).Length -le 600) $true "detalhe do build e limitado"
} finally {
    $env:GLB_INSTALLER_LOG_DIR = $origLogDirBuild
    Set-Item -Path Function:Invoke-Pnpm -Value $originalInvokePnpmBuild
    Set-Item -Path Function:Find-GitApplication -Value $originalFindGitApplication
    Set-Item -Path Function:Test-GitComandoOk -Value $originalTestGitComandoOk
    Remove-Item -LiteralPath $buildRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "`n========================================================" -ForegroundColor Cyan
Write-Host " 3. Wait-AntesDeFechar / Test-JanelaTransitoria" -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan
# Relato: no Windows 10 sem winget, o instalador falha e a janela "fecha sozinha" antes da
# pessoa ler o erro -- "Executar com o PowerShell" no Explorer spawna powershell.exe -File
# sem -NoExit. O .bat ja tem "pause" pra isso, mas quem roda so o .ps1 baixado direto (o
# link do README salva so o .ps1) nao passa por ele. Estes testes cobrem a parte
# deterministica (sem depender de bloquear em leitura de stdin, que nao e seguro forcar
# aqui): a deteccao devolve false neste ambiente (sem pai explorer.exe) e -Yes pula a
# checagem sem nem chamar Test-JanelaTransitoria. O caminho que de fato imprime o aviso e
# tenta ler Enter foi verificado manualmente (nao automatizado, para nao arriscar travar a
# suite se algum ambiente de CI conectar um stdin que nunca fecha).
foreach ($par in @(
    @{ nome = 'instalador'; wait = $installerWaitAntesDeFechar; janela = $installerTestJanela },
    @{ nome = 'standalone'; wait = $standaloneWaitAntesDeFechar; janela = $standaloneTestJanela }
)) {
    $Yes = $false
    Assert-Equal (& $par.janela) $false "Test-JanelaTransitoria ($($par.nome)) devolve false sem pai explorer.exe (ambiente de teste)"

    # Sem pai explorer.exe: Wait-AntesDeFechar precisa retornar sem tentar ler nada.
    & $par.wait
    Assert-Equal $true $true "Wait-AntesDeFechar ($($par.nome)) retorna sem bloquear quando nao e janela transitoria"

    # -Yes precisa pular a checagem de janela ANTES de chamar Test-JanelaTransitoria --
    # confirma substituindo a deteccao por uma que sempre explode; se Wait-AntesDeFechar
    # ainda assim chamar Test-JanelaTransitoria, o teste falha com excecao.
    $Yes = $true
    Set-Item "function:Test-JanelaTransitoria" { throw 'Test-JanelaTransitoria nao deveria ser chamada com -Yes' }
    try {
        & $par.wait
        Assert-Equal $true $true "Wait-AntesDeFechar ($($par.nome)) com -Yes nao chama Test-JanelaTransitoria"
    } catch {
        Assert-Equal $false $true "Wait-AntesDeFechar ($($par.nome)) com -Yes nao chama Test-JanelaTransitoria ($($_.Exception.Message))"
    }
    $Yes = $false
    # Restaura a deteccao real (nao remove): a proxima iteracao do loop tambem chama
    # Wait-AntesDeFechar, que resolve Test-JanelaTransitoria pelo nome em tempo de execucao.
    Set-Item "function:Test-JanelaTransitoria" $par.janela
}

# Confirma que os pontos de saida de sucesso e encerramento normal do standalone chamam Wait-AntesDeFechar
Assert-Equal ($standaloneContent.Trim().EndsWith("Wait-AntesDeFechar")) $true "Standalone tem Wait-AntesDeFechar no encerramento normal do script"
Assert-Equal ($standaloneContent -match 'Show-Status;\s*Wait-AntesDeFechar;\s*return') $true "Standalone chama Wait-AntesDeFechar antes de retornar de Show-Status"
Assert-Equal ($standaloneContent -match 'Invoke-StandaloneCheckUpdate;\s*Wait-AntesDeFechar;\s*return') $true "Standalone chama Wait-AntesDeFechar antes de retornar de CheckUpdate"
Assert-Equal ($standaloneContent -match 'Invoke-StandaloneUpdate;\s*Wait-AntesDeFechar;\s*return') $true "Standalone chama Wait-AntesDeFechar antes de retornar de Update"

# Confirma que a saida apos instalar dependencias via winget no instalador chama Wait-AntesDeFechar
Assert-Equal ($installerContent -match 'Feche este terminal[\s\S]*?Wait-AntesDeFechar[\s\S]*?exit 0') $true "Instalador chama Wait-AntesDeFechar antes de sair apos instalar dependencias"

# Cleanup temp files
Remove-Item -LiteralPath $tempInstaller, $tempStandalone -Force -ErrorAction SilentlyContinue

Write-Host "`n========================================================" -ForegroundColor Cyan
Write-Host " Resumo dos Testes: $pass passaram, $fail falharam" -ForegroundColor $(if ($fail -eq 0) { 'Green' } else { 'Red' })
Write-Host "========================================================`n" -ForegroundColor Cyan

if ($fail -gt 0) { exit 1 }
