# Testes do caminho de restauracao de cliente do instalador Windows:
#
#   -Mode ClientStatus   -> Get-ClientAsarState()
#   -Mode RestoreClient  -> Restore-ClientAsar() / Invoke-RestoreClient()
#   -Mode Uninstall      -> Update-ParallelPatches()
#
# Mesmos invariantes de tests/test-client-restore.sh, do lado do PowerShell: o cliente paralelo
# tem o app.asar trocado pelo build do mod com o original guardado em _app.asar, e sem caminho
# de volta um build quebrado deixa o cliente sem abrir (#268/#258).
#
# Roda em qualquer PowerShell 7 (Linux/macOS/Windows) sem privilégio, sobre diretorios fake:
#
#   podman run --rm -v "$PWD:/work:ro" mcr.microsoft.com/powershell:latest \
#     pwsh -NoProfile -File /work/tests/test-client-restore.ps1
#
# Nao toca em processos do Discord: Stop-Discord/Start-Discord sao substituidos por stubs.

$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$installer = Join-Path $repo 'installer/GoLiveBypass-Installer.ps1'

$falhas = 0
function Check($nome, $condicao) {
    if ($condicao) {
        Write-Host "  [OK] $nome"
    } else {
        $script:falhas++
        Write-Host "  [FAIL] $nome"
    }
}

# --------------------------------------------------------------- carrega so as funcoes
# O script tem codigo de topo no final (Show-Banner + dispatch); corta antes disso para nao
# abrir menu nem tocar em nada da maquina.
$linhas = Get-Content -LiteralPath $installer
$corte = ($linhas | Select-String -Pattern '^Show-Banner\s*$' | Select-Object -First 1).LineNumber
if (-not $corte) { throw "nao achei o marcador 'Show-Banner' em $installer" }
$extrato = Join-Path ([System.IO.Path]::GetTempPath()) 'golive-funcoes.ps1'
Set-Content -LiteralPath $extrato -Value ($linhas[0..($corte - 2)]) -Encoding UTF8
. $extrato

# ------------------------------------------------------- stubs (nada de processo real)
$script:eventos = @()
function Write-InstallerEvent { param($level, $event, $phase, $data) $script:eventos += , @{ level = $level; event = $event; phase = $phase; data = $data } }
function Stop-Discord { }
function Start-Discord { }
function Find-Checkout { return $null }

$trabalho = Join-Path ([System.IO.Path]::GetTempPath()) ("golive-restore-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $trabalho -Force | Out-Null

function Novo-Cliente($nome, $conteudoApp, $conteudoBackup) {
    $dir = Join-Path (Join-Path $trabalho $nome) 'resources'
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    if ($null -ne $conteudoApp) { Set-Content -LiteralPath (Join-Path $dir 'app.asar') -Value $conteudoApp -NoNewline }
    if ($null -ne $conteudoBackup) { Set-Content -LiteralPath (Join-Path $dir '_app.asar') -Value $conteudoBackup -NoNewline }
    return $dir
}

# ---------------------------------------------------------------- patch do GoLiveBypass
$golive = Novo-Cliente 'golive/Equibop' 'build com GoLiveBypass dentro' 'ORIGINAL-1'
Check 'classifica patch do GoLiveBypass como golive' ((Get-ClientAsarState $golive) -eq 'golive')
Check 'restauracao do patch do GoLiveBypass conclui' (Restore-ClientAsar $golive 'Equibop')
Check 'app.asar voltou a ser o original' ((Get-Content -LiteralPath (Join-Path $golive 'app.asar') -Raw) -eq 'ORIGINAL-1')
Check '_app.asar sai do caminho depois de devolvido' (-not (Test-Path -LiteralPath (Join-Path $golive '_app.asar')))
Check 'patch antigo preservado em .golive-patched.bak' (Test-Path -LiteralPath (Join-Path $golive 'app.asar.golive-patched.bak'))
Check 'cliente restaurado passa a constar como original' ((Get-ClientAsarState $golive) -eq 'vanilla')

# ------------------------------------------------ stub do mod apontando para alvo ausente
$quebrado = Novo-Cliente 'quebrado/Equibop' 'require("/nao/existe/dist/desktop")' 'ORIGINAL-2'
Check 'stub com alvo ausente e classificado como quebrado' ((Get-ClientAsarState $quebrado) -eq 'mod-quebrado')
Check 'cliente quebrado e restaurado sem -Force' (Restore-ClientAsar $quebrado 'Equibop')
Check 'app.asar do cliente quebrado voltou ao original' ((Get-Content -LiteralPath (Join-Path $quebrado 'app.asar') -Raw) -eq 'ORIGINAL-2')

# ------------------------------------------------- stub do mod com alvo presente (funciona)
$saudavel = Novo-Cliente 'saudavel/Equibop' $null 'ORIGINAL-3'
New-Item -ItemType Directory -Path (Join-Path $saudavel 'target/dist/desktop') -Force | Out-Null
Set-Content -LiteralPath (Join-Path $saudavel 'app.asar') -Value ('require("{0}/target/dist/desktop")' -f $saudavel) -NoNewline
Check 'stub com alvo presente e classificado como mod funcionando' ((Get-ClientAsarState $saudavel) -eq 'mod')
Check 'mod funcionando NAO e desfeito sem -Force' (-not (Restore-ClientAsar $saudavel 'Equibop'))
Check 'app.asar do mod funcionando ficou intacto' ((Get-Content -LiteralPath (Join-Path $saudavel 'app.asar') -Raw) -ne 'ORIGINAL-3')
Check 'backup do mod funcionando ficou intacto' (Test-Path -LiteralPath (Join-Path $saudavel '_app.asar'))
Check 'com -Force o mod e desfeito' (Restore-ClientAsar $saudavel 'Equibop' -Force)
Check 'com -Force o original volta' ((Get-Content -LiteralPath (Join-Path $saudavel 'app.asar') -Raw) -eq 'ORIGINAL-3')

# ------------------------------------------------------------------- cliente sem injecao
$vanilla = Novo-Cliente 'vanilla/Equibop' 'ORIGINAL-4' $null
Check 'cliente sem injecao e classificado como original' ((Get-ClientAsarState $vanilla) -eq 'vanilla')
Check 'cliente ja original nao e mexido' (-not (Restore-ClientAsar $vanilla 'Equibop'))

# ----------------------------------------------------- stub quebrado sem backup disponivel
$semBackup = Novo-Cliente 'sembackup/Equibop' 'require("/sumiu/dist/desktop")' $null
Check 'stub sem backup continua classificado como quebrado' ((Get-ClientAsarState $semBackup) -eq 'mod-quebrado')
Check 'sem _app.asar a restauracao recusa' (-not (Restore-ClientAsar $semBackup 'Equibop' -Force))
Check 'sem backup o app.asar nao e sobrescrito' (Test-Path -LiteralPath (Join-Path $semBackup 'app.asar'))

# ------------------------------------------------------------------------ rotulos/marca
Check 'rotulo Equibop vem do caminho' ((Get-ClientLabel $golive) -eq 'Equibop')
Check 'caminho do Discord cai no rotulo Discord' ((Get-ClientLabel '/x/discord/resources') -eq 'Discord')
Check 'marca do plugin e detectada no asar patchado' (Test-AsarContainsMark (Join-Path $golive 'app.asar.golive-patched.bak'))
Check 'marca nao aparece num asar vanilla' (-not (Test-AsarContainsMark (Join-Path $vanilla 'app.asar')))

# ------------------------- patch paralelo atualizado quando o plugin e removido (uninstall)
$checkout = Join-Path $trabalho 'Equicord'
New-Item -ItemType Directory -Path (Join-Path $checkout 'dist') -Force | Out-Null
Set-Content -LiteralPath (Join-Path $checkout 'package.json') -Value '{"name":"equicord"}'
Set-Content -LiteralPath (Join-Path $checkout 'dist/equibop.asar') -Value 'build SEM o plugin' -NoNewline
$patchado = Join-Path (Join-Path $trabalho 'patchado/Equibop') 'resources'
New-Item -ItemType Directory -Path $patchado -Force | Out-Null
Set-Content -LiteralPath (Join-Path $patchado 'app.asar') -Value 'build antigo COM GoLiveBypass' -NoNewline
Set-Content -LiteralPath (Join-Path $patchado '_app.asar') -Value 'ORIGINAL-5' -NoNewline
function Get-DiscordResources { return @($patchado) }
Update-ParallelPatches $checkout
Check 'patch paralelo passa a ser o build sem o plugin' ((Get-Content -LiteralPath (Join-Path $patchado 'app.asar') -Raw) -eq 'build SEM o plugin')
Check 'backup do cliente paralelo e preservado no refresh' (Test-Path -LiteralPath (Join-Path $patchado '_app.asar'))

# ------------------------------------------------- restauracao em lote pelo driver do CLI
$lote = Novo-Cliente 'lote/Equibop' 'build com GoLiveBypass' 'ORIGINAL-6'
function Get-DiscordResources { return @($lote) }
Invoke-RestoreClient ''
Check 'driver devolve o original do cliente em lote' ((Get-Content -LiteralPath (Join-Path $lote 'app.asar') -Raw) -eq 'ORIGINAL-6')

# ------------------------- Equibop instalado: status/restore enxergam o cliente paralelo
$env:LOCALAPPDATA = Join-Path $trabalho 'local'
$env:APPDATA = Join-Path $trabalho 'roaming'
Remove-Item Env:\EQUICORD_USER_DATA_DIR -ErrorAction SilentlyContinue
$equibop = Join-Path $env:LOCALAPPDATA 'Programs\Equibop\resources'
New-Item -ItemType Directory -Path $equibop -Force | Out-Null
Set-Content -LiteralPath (Join-Path $equibop 'app.asar') -Value 'equibop.asar do Equicord com GoLiveBypass' -NoNewline
Set-Content -LiteralPath (Join-Path $equibop '_app.asar') -Value 'EQUIBOP-ORIGINAL' -NoNewline
function Get-DiscordResources { return @() }
$status = (Show-ClientStates 6>&1 | Out-String)
Check 'ClientStatus lista o Equibop' ($status -match 'Equibop' -and $status -notmatch 'nenhum cliente')
Invoke-RestoreClient 'equibop'
Check 'RestoreClient -Client Equibop devolve o app.asar original' ((Get-Content -LiteralPath (Join-Path $equibop 'app.asar') -Raw) -eq 'EQUIBOP-ORIGINAL')

# ------------- install no Equibop: Equicord Location no state.json, sem tocar no app.asar
$checkout = Join-Path $trabalho 'Equicord'
New-Item -ItemType Directory -Path (Join-Path $checkout 'dist\equibop') -Force | Out-Null
Set-Content -LiteralPath (Join-Path $checkout 'dist\equibop\main.js') -Value '//' -NoNewline
Set-Content -LiteralPath (Join-Path $equibop 'app.asar') -Value 'equibop.asar do Equicord com GoLiveBypass' -NoNewline
Set-Content -LiteralPath (Join-Path $equibop '_app.asar') -Value 'EQUIBOP-ORIGINAL' -NoNewline
$dados = Join-Path $env:APPDATA 'Equibop'
New-Item -ItemType Directory -Path $dados -Force | Out-Null
Set-Content -LiteralPath (Join-Path $dados 'state.json') -Value '{"firstLaunch":false,"windowBounds":{"x":1}}' -NoNewline
$r = Set-EquibopEquicordDir $checkout $equibop 6>$null
$state = Get-Content -LiteralPath (Join-Path $dados 'state.json') -Raw | ConvertFrom-Json
Check 'Equibop recebe equicordDir apontando para o dist do checkout' ($r.Ok -and $state.equicordDir -eq (Join-Path $checkout 'dist'))
Check 'state.json do Equibop preserva as outras chaves' ($state.firstLaunch -eq $false -and $state.windowBounds.x -eq 1)
Check 'app.asar quebrado pela copia antiga volta ao original' ((Get-Content -LiteralPath (Join-Path $equibop 'app.asar') -Raw) -eq 'EQUIBOP-ORIGINAL')
$cfg = Get-Content -LiteralPath (Join-Path $dados 'settings\settings.json') -Raw | ConvertFrom-Json
Check 'plugin ativado nas configuracoes do Equicord do Equibop' ($cfg.plugins.GoLiveBypass.enabled -eq $true)
Remove-Item -LiteralPath (Join-Path $checkout 'dist\equibop\main.js') -Force
Check 'sem dist\equibop\main.js o Equibop nao e configurado' (-not (Set-EquibopEquicordDir $checkout $equibop 3>$null 6>$null).Ok)

Remove-Item -LiteralPath $trabalho -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $extrato -Force -ErrorAction SilentlyContinue

Write-Host ''
Write-Host "== Resultado: $falhas falhas =="
exit $falhas
