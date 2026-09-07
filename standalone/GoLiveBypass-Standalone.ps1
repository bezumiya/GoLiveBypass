<#
    GoLiveBypass standalone - instalador

    Instala direto no Discord, sem Equicord e sem Vencord. Nao precisa de Node, nem de pnpm,
    nem de git: o bypass e um arquivo .js que o proprio Discord carrega.

    Uso:
      .\GoLiveBypass-Standalone.ps1
      .\GoLiveBypass-Standalone.ps1 -Proxy "socks5://127.0.0.1:9050"
      .\GoLiveBypass-Standalone.ps1 -Mode Uninstall
      .\GoLiveBypass-Standalone.ps1 -Mode CheckUpdate
      .\GoLiveBypass-Standalone.ps1 -Mode Update
#>

[CmdletBinding()]
param(
    [ValidateSet('Install', 'Uninstall', 'Status', 'CheckUpdate', 'Update')]
    [string] $Mode = 'Install',

    [string] $Proxy = '',

    [string] $WgConf = '',

    [string] $ExcludedCountries = 'BR',

    # Instala e sobe o Tor embutido, e aponta o bypass para ele (rota automatica tor).
    [switch] $Tor,

    [switch] $Yes
)

$ErrorActionPreference = 'Stop'
$StandaloneVersion = '1.1.12-beta.13'
$StandaloneRepoApi = 'https://api.github.com/repos/bezumiya/GoLiveBypass/releases/latest'
$StandaloneRepoRoot = 'https://raw.githubusercontent.com/bezumiya/GoLiveBypass'
try { Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force } catch { }

Write-Host ''
Write-Host '  [AVISO] O standalone CLI esta temporariamente indisponivel.' -ForegroundColor Yellow
Write-Host '          Estamos portando o novo sistema WireGuard para esta variante.' -ForegroundColor DarkGray
Write-Host '          Use a GUI 2.0.0 de teste enquanto isso; ela e a variante mantida no momento.' -ForegroundColor DarkGray
Write-Host ''
exit 1

# "Executar com o PowerShell" no menu de contexto do Explorer (ou duplo clique num .ps1
# associado a isso) spawna powershell.exe -File sem -NoExit: a janela fecha sozinha ao sair,
# mesmo com erro. Sem pausa aqui a pessoa nunca le a mensagem (o .bat ja tem "pause" pra
# isso, mas quem roda so o .ps1 baixado direto do README nao passa por ele). Mesmo padrao
# usado no installer/GoLiveBypass-Installer.ps1 (achado por um relato de winget ausente no
# Windows 10 "fechando sozinho"). Definida cedo: a checagem de proxy invalida, logo abaixo,
# ja pode sair antes de qualquer outra funcao existir.
function Test-JanelaTransitoria {
    try {
        $atual = Get-CimInstance Win32_Process -Filter "ProcessId=$PID" -ErrorAction Stop
        $pai = Get-CimInstance Win32_Process -Filter "ProcessId=$($atual.ParentProcessId)" -ErrorAction Stop
        return $pai.Name -eq 'explorer.exe'
    } catch {
        return $false
    }
}

function Wait-AntesDeFechar {
    if ($Yes) { return }
    if (-not (Test-JanelaTransitoria)) { return }
    Write-Host ''
    Write-Host '  Pressione Enter para fechar esta janela.' -ForegroundColor DarkGray
    try { [void][Console]::ReadLine() } catch { }
}

# O trecho antes do @ e opcional e casado com ganancia, para a senha poder conter @ e :
# codificados. Sem validar aqui, um endereco com erro de digitacao viraria configuracao e o
# bypass cairia para a lista gratuita sem dizer por que.
if ($Proxy -ne '' -and $Proxy -notmatch '^(socks5|socks4|https?)://(?:.+@)?[^:/@\s]+:\d{1,5}(?:-\d{1,5})?$') {
    Write-Host ''
    Write-Host '  [X] Endereco de proxy invalido.' -ForegroundColor Red
    Write-Host '      Use socks5://host:porta, ou socks5://usuario:senha@host:porta.' -ForegroundColor DarkGray
    Write-Host '      Senha com @ ou : precisa vir codificada (@ vira %40, : vira %3A).' -ForegroundColor DarkGray
    Write-Host ''
    Wait-AntesDeFechar
    exit 1
}

# O caminho base tem que RESOLVER, nao apenas existir na variavel: perfil com nome
# acentuado/especial pode ter %LOCALAPPDATA% gravado na forma 8.3 curta (ex.
# C:\Users\CSAR~1\AppData\Local), que para de resolver quando a geracao de nomes
# curtos esta desligada no Windows (#94: "Nao existe um objeto no caminho
# especificado C:\Users\CSAR~1"). A cadeia cai entao para o GetFolderPath, que
# devolve o caminho longo canonico, e por ultimo monta a partir do USERPROFILE.
function Get-EffectiveLocalApp {
    if ($env:LOCALAPPDATA -and (Test-Path -LiteralPath $env:LOCALAPPDATA)) { return $env:LOCALAPPDATA }
    try {
        $shell = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
        if ($shell -and (Test-Path -LiteralPath $shell)) { return $shell }
    } catch { }
    if ($env:USERPROFILE) { return (Join-Path $env:USERPROFILE 'AppData\Local') }
    return $env:LOCALAPPDATA
}
$LocalApp = Get-EffectiveLocalApp
$InstallDir = Join-Path $LocalApp 'GoLiveBypass'
$PatcherName = 'golivebypass.js'
$DiscordFlavours = @('Discord', 'DiscordPTB', 'DiscordCanary')
$StubPackage = '{"name":"discord","main":"index.js","version":"1.0.0"}'

# Tor embutido: mesma versao, mesmos hashes e mesma porta da GUI (golive-gui/electron/main.ts).
$TorBundle = '13.5'
$TorPort = 9060
$TorDir = Join-Path $InstallDir 'Tor'
$TorExe = Join-Path $TorDir 'tor\tor.exe'
$TorTorrc = Join-Path $TorDir 'torrc'
$TorArchiveName = 'tor-expert-bundle-windows-x86_64-13.5.tar.gz'
$TorUrl = "https://archive.torproject.org/tor-package-archive/torbrowser/$TorBundle/$TorArchiveName"
$TorSha256 = '5978ccc2a7fed783c329474888e87f5e6349aa132d9c43016418bff296c7becb'

$EmbeddedWgConf = @'
[Interface]
PrivateKey = sLPBSsrhzoqZSOY/XxAzGAy5F+sQKQIIE3WoxG8buWM=
Address = 10.2.0.2/32
DNS = 10.2.0.1

[Peer]
# MX-FREE#16
PublicKey = mkI+cC9ggzfMdZy1cl3Fl01gPJJxsLXjshXAN8EedQ8=
AllowedIPs = 0.0.0.0/0, ::/0
Endpoint = 84.20.27.53:51820
PersistentKeepalive = 25
'@

function Ensure-WireGuardConf {
    $wgFile = Join-Path $InstallDir 'wireguard.conf'
    if ($WgConf -and (Test-Path -LiteralPath $WgConf)) {
        New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
        Copy-Item -LiteralPath $WgConf -Destination $wgFile -Force
        Write-Ok "Configuracao WireGuard importada de $WgConf"
        return $wgFile
    }
    if (Test-Path -LiteralPath $wgFile) {
        return $wgFile
    }
    
    $dl = Join-Path $env:USERPROFILE 'Downloads'
    $foundDl = Get-ChildItem -Path $dl -Filter 'wg-*.conf' -ErrorAction SilentlyContinue | Select-Object -First 1
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    if ($foundDl) {
        Copy-Item -LiteralPath $foundDl.FullName -Destination $wgFile -Force
        Write-Ok "Configuracao WireGuard encontrada em $($foundDl.FullName)"
    } else {
        [IO.File]::WriteAllText($wgFile, $EmbeddedWgConf, (New-Object Text.UTF8Encoding $false))
        Write-Ok "Configuracao padrao WireGuard (Mexico) gravada em $wgFile"
    }
    return $wgFile
}

function Ensure-WireSock {
    $wsCmd = Get-Command 'wiresock-client.exe' -ErrorAction SilentlyContinue
    if ($wsCmd) { return $wsCmd.Source }

    $programFiles = @($env:ProgramW6432, $env:ProgramFiles, ${env:ProgramFiles(x86)}, 'C:\Program Files') |
        Where-Object { $_ } | Select-Object -Unique
    foreach ($base in $programFiles) {
        $candidate = Join-Path $base 'WireSock Secure Connect\sdk\wiresock-client.exe'
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }

    $winget = Get-Command 'winget.exe' -ErrorAction SilentlyContinue
    if (-not $winget) {
        $downloadPage = 'https://v3.wiresock.net/wiresock-sdk'
        try { Start-Process $downloadPage } catch { }
        throw "Este Windows nao tem o winget (comum no Windows 10). A pagina oficial do WireSock CLI foi aberta: instale a versao do seu sistema, reabra o GoLiveBypass e ative novamente."
    }
    
    Write-Step "Instalando WireSock VPN Client..."
    $installError = ''
    try {
        & $winget.Source install --id 'NTKERNEL.WireSockVPNClientCLI' --exact --source winget --accept-package-agreements --accept-source-agreements --silent --disable-interactivity | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "winget terminou com codigo $LASTEXITCODE" }
    } catch {
        $installError = $_.Exception.Message
        Write-Warn "A instalacao pelo winget falhou: $installError"
    }

    $wsCmd = Get-Command 'wiresock-client.exe' -ErrorAction SilentlyContinue
    if ($wsCmd) { return $wsCmd.Source }
    foreach ($base in $programFiles) {
        $candidate = Join-Path $base 'WireSock Secure Connect\sdk\wiresock-client.exe'
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    
    throw "Nao consegui instalar o WireSock VPN Client pelo winget. $installError Tente executar como administrador ou instale manualmente com: winget install --id NTKERNEL.WireSockVPNClientCLI --exact"
}

function Install-WireSockTunnel {
    $rawWg = Ensure-WireGuardConf
    $wsExe = Ensure-WireSock
    $wsConf = Join-Path $InstallDir 'wiresock-discord.conf'

    $lines = Get-Content -LiteralPath $rawWg
    $hasAllowedApps = $false
    $newLines = @()
    foreach ($line in $lines) {
        if ($line -match '^\s*DNS\s*=') {
            continue
        } elseif ($line -match '^\s*(?:#@ws:)?AllowedApps\s*=') {
            $hasAllowedApps = $true
            $newLines += '#@ws:AllowedApps = Discord, Discord.exe, Update.exe'
        } else {
            $newLines += $line
        }
    }
    if (-not $hasAllowedApps) {
        $newLines += '#@ws:AllowedApps = Discord, Discord.exe, Update.exe'
    }
    [IO.File]::WriteAllLines($wsConf, $newLines, (New-Object Text.UTF8Encoding $false))

    Write-Step "Configurando servico WireSock..."
    $name = 'wiresock-client-service'
    $svc = Get-Service -Name $name -ErrorAction SilentlyContinue
    if ($svc) {
        if ($svc.Status -ne 'Stopped') {
            Stop-Service -Name $name -Force -ErrorAction Stop
            $svc.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(20))
        }
    } else {
        & $wsExe install -start-type 3 -config $wsConf -log-level info -network-lock disabled | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Falha ao instalar o servico WireSock." }
    }
    $expected = '"' + $wsExe + '" service -config "' + $wsConf + '" -log-level info -network-lock disabled'
    $serviceInfo = Get-CimInstance Win32_Service -Filter "Name='$name'" -ErrorAction Stop
    if (-not $serviceInfo) { throw "Servico WireSock nao encontrado." }
    $change = Invoke-CimMethod -InputObject $serviceInfo -MethodName Change -Arguments @{PathName=$expected; StartMode='Manual'} -ErrorAction Stop
    if ($change.ReturnValue -ne 0) { throw "Falha ao atualizar o perfil do servico: $($change.ReturnValue)" }
    $actual = Get-CimInstance Win32_Service -Filter "Name='$name'" -ErrorAction Stop
    if ($actual.PathName -cne $expected) { throw "O servico WireSock permaneceu com outra configuracao." }
    Start-Service -Name $name -ErrorAction Stop
    (Get-Service -Name $name).WaitForStatus('Running', [TimeSpan]::FromSeconds(20))
    Write-Ok "Servico WireSock iniciado com a configuracao selecionada."
}

function Stop-WireSockTunnel {
    Stop-Service -Name 'wiresock-client-service' -Force -ErrorAction SilentlyContinue
    Stop-Process -Name 'wiresock-client' -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
    Get-NetAdapter -IncludeHidden | Where-Object { $_.Name -match 'ProTUN|WireSock' -or $_.InterfaceDescription -match 'WireSock|WireGuard' } | ForEach-Object {
        Set-DnsClientServerAddress -InterfaceIndex $_.ifIndex -ResetServerAddresses -ErrorAction SilentlyContinue
    }
    $wsCmd = Get-Command 'wiresock-client.exe' -ErrorAction SilentlyContinue
    if ($wsCmd) { & $wsCmd.Source reset-network-lock 2>$null | Out-Null }
    ipconfig.exe /flushdns | Out-Null
    Write-Ok "Tunel WireSock parado."
}

function Write-Step($m) { Write-Host "  [*] $m" -ForegroundColor Cyan }
function Write-Ok($m)   { Write-Host "  [OK] $m" -ForegroundColor Green }
function Write-Warn($m) { Write-Host "  [!] $m" -ForegroundColor Yellow }
function Write-Bad($m)  { Write-Host "  [X] $m" -ForegroundColor Red }

function Confirm-Action($question) {
    if ($Yes) { return $true }
    Write-Host ''
    $answer = Read-Host "  $question [s/N]"
    return $answer -match '^[sSyY]'
}

# =========================================================================== Report de bugs
# Igual a GUI: ao falhar, monta diagnostico sanitizado e POST na API de bugs
# (abre issue no bezumiya/GoLiveBypass). Nunca bloqueia o fluxo.

$script:BugApiUrl = 'https://api.skyplaceia.com/bugs/v1/reports'
$script:BugApiToken = 'c3d0bff691ecc3ddc6f6ca10037b9ac967c62547e681d3749204e50800504511'

function Invoke-BugReport([string]$title, [string]$description, [string]$log = '', [hashtable]$meta = @{}) {
    if ($Yes) { return }  # automacao: nao spammar a API
    # Dedupe: o mesmo erro NAO reabre issue (os reports duplos da 1.1.11 vieram
    # daqui — cada rodada do mesmo bug abria issue nova). Assinatura = titulo +
    # primeira linha da descricao, com data; janela de 48h.
    try {
        $primeiraLinha = ($description -split "`n" | Select-Object -First 1)
        if ($primeiraLinha.Length -gt 300) { $primeiraLinha = $primeiraLinha.Substring(0, 300) }
        $sha = [System.Security.Cryptography.SHA256]::Create()
        $hash = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes("$title|$primeiraLinha"))) -replace '-', '').Substring(0, 16)
        $sha.Dispose()
        $stateFile = Join-Path (Get-EffectiveLocalApp) 'GoLiveBypass\.last-report'
        if (Test-Path -LiteralPath $stateFile) {
            $campos = @((Get-Content -LiteralPath $stateFile -First 1) -split ' ')
            if ($campos.Count -ge 2 -and $campos[0] -eq $hash) {
                try {
                    $ultimo = [datetime]::ParseExact($campos[1], 'yyyyMMddHHmm', [Globalization.CultureInfo]::InvariantCulture)
                    if (((Get-Date) - $ultimo).TotalHours -lt 48) {
                        Write-Host '  [i] Esse erro ja foi reportado a menos de 48h — nao vou reabrir a issue.' -ForegroundColor DarkGray
                        return
                    }
                } catch { }
            }
        }
        New-Item -ItemType Directory -Path (Split-Path -Parent $stateFile) -Force -ErrorAction SilentlyContinue | Out-Null
        Set-Content -LiteralPath $stateFile -Value "$hash $(Get-Date -Format 'yyyyMMddHHmm')" -ErrorAction SilentlyContinue
    } catch { }
    $desc = Invoke-SanitizeBug $description
    # Mesma forma do payload da GUI (golive-gui/electron/bugreport.ts): {title,
    # description, log, meta}. O formato antigo (includeLogs) nunca foi lido pela
    # API -- os reports do standalone chegavam no GitHub com log e metadata vazios
    # (ex.: issue #94).
    $body = @{ title = $title; description = $desc; log = $log; meta = $meta } | ConvertTo-Json
    try {
        Invoke-RestMethod -Method Post -Uri $script:BugApiUrl -Body $body -ContentType 'application/json' -Headers @{ Authorization = "Bearer $($script:BugApiToken)" } -TimeoutSec 15 -ErrorAction Stop | Out-Null
        Write-Host ''
        Write-Host '  [OK] Relatorio enviado. Obrigado — os devs vao ver a issue no GitHub.' -ForegroundColor Green
    } catch {
        Write-Host ''
        Write-Host '  [!] Nao consegui enviar o relatorio automatico. Rode de novo e mande a saida.' -ForegroundColor Yellow
    }
}

function Invoke-SanitizeBug([string]$text) {
    $text = [regex]::Replace($text, '([a-z][a-z0-9+.-]*://)([^/ @:]+):([^/@]+)@', '$1$2:***@')
    $text = [regex]::Replace($text, '\b(mfa\.[A-Za-z0-9_-]{20,}|[A-Za-z0-9_-]{23,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{27,})\b', '***')
    $text = [regex]::Replace($text, '(https://gateway[^ ?]+)\?[^ ]*', '$1?<params>')
    # proxy personalizada salva
    try {
        $settings = Join-Path $InstallDir 'settings.json'
        if (Test-Path -LiteralPath $settings) {
            $p = (Get-Content -LiteralPath $settings -Raw | ConvertFrom-Json).proxy
            if ($p) { $text = $text.Replace($p, '<proxy-pessoal>') }
        }
    } catch { }
    return $text
}

# Metadata do report, mesmo espirito da GUI (bugreport.ts montarMeta): so flags de
# diagnostico, sem caminhos completos do usuario. caminho_8_3 marca variaveis de
# ambiente gravadas na forma curta (ex. C:\Users\CSAR~1) -- o cenario da issue #94.
function Get-ReportMeta($ErrorRecord) {
    $short = $false
    foreach ($v in @($env:LOCALAPPDATA, $env:USERPROFILE, $env:TEMP)) {
        if ($v -and $v -match '~\d($|\\)') { $short = $true; break }
    }
    $modo = 'gratuitas'
    try {
        $settingsFile = Join-Path $LocalApp 'GoLiveBypass\settings.json'
        if (Test-Path -LiteralPath $settingsFile) {
            $rm = (Get-Content -LiteralPath $settingsFile -Raw | ConvertFrom-Json).routeMode
            if ($rm) { $modo = $rm }
        }
    } catch { }
    $meta = @{
        versao                = 'standalone'
        plataforma            = "win32-$env:PROCESSOR_ARCHITECTURE"
        locale                = "$(if ($PSUICulture -and $PSUICulture.Name) { $PSUICulture.Name } else { '?' })"
        modoRoteamento        = $modo
        localappdata_presente = "$(if ($env:LOCALAPPDATA) { 'sim' } else { 'nao' })"
        caminho_8_3           = "$(if ($short) { 'sim' } else { 'nao' })"
    }
    if ($ErrorRecord -and $ErrorRecord.Exception) {
        $meta['excecao'] = $ErrorRecord.Exception.GetType().FullName
    }
    return $meta
}

function Invoke-AutoBugReport([string]$summary, [string]$extra = '', $ErrorRecord = $null) {
    # Erros de uso (dependencia, CLI typo, path errado, ferramenta externa) nao viram issue.
    # O filtro roda sobre a mensagem crua; tipo/stack entram depois, so no texto do report.
    if (-not (Test-ShouldReport $extra)) { return }
    # monta a descricao: extra + cauda do log (se existir)
    $logPath = Join-Path $InstallDir 'golivebypass.log'
    $tail = ''
    if (Test-Path -LiteralPath $logPath) {
        $tail = (Get-Content -LiteralPath $logPath -Tail 40 -ErrorAction SilentlyContinue | Out-String)
    }
    $desc = $extra
    if ($ErrorRecord -and $ErrorRecord.Exception) {
        $frame = ''
        try {
            $st = $ErrorRecord.Exception.StackTrace
            if ($st) { $frame = (($st -split "`n") | Select-Object -First 1).Trim() }
        } catch { }
        $desc += "`n`nexcecao: " + $ErrorRecord.Exception.GetType().FullName
        if ($frame) { $desc += "`nframe: " + $frame }
        # A LINHA do script: sem ela um "Invalid handle" de FileStream nao diz nada
        # (issue #127). O catch do instalador mostra no console; o report so via aqui.
        $info = $ErrorRecord.InvocationInfo
        if ($info -and $info.ScriptLineNumber) {
            $desc += "`nlinha do script: $($info.ScriptLineNumber): $($info.Line.Trim())"
        }
    }
    if ($desc -or $tail) {
        Invoke-BugReport $summary $desc $tail (Get-ReportMeta $ErrorRecord)
    }
}

# Test-ShouldReport <mensagem>: $false se a mensagem NAO deve abrir issue.
# Mesmo espelho do should_report() do .sh: erros de uso (dependencia faltando,
# CLI digitada errada, path errado, ferramenta externa quebrada) nao viram
# issue. O resto (bug real) continua reportando.
function Test-ShouldReport([string]$msg) {
    # cancelamento e instrucoes de uso
    if ($msg -eq 'Cancelado.') { return $false }
    # Cancelamento via Ctrl+C no Read-Host: ver nota no installer.ps1.
    if ($msg -like '*cancelada pelo usu*rio*') { return $false }
    if ($msg -like '*canceled by the user*') { return $false }
    if ($msg -like '*cadeia de caracteres vazia*') { return $false }
    if ($msg -like '*empty string*') { return $false }
    if ($msg -like 'Illegal characters in path*') { return $false }
    if ($msg -like '*associar*par*metro*') { return $false }
    if ($msg -like '*Cannot bind argument*') { return $false }
    if ($msg -like '*porque ele ? nulo*' -or $msg -like '*because it is null*') { return $false }
    if ($msg -like 'Nao e possivel associar*') { return $false }
    if ($msg -like 'O Discord nao fechou*') { return $false }
    # input / uso do usuario
    if ($msg -like 'Opcao desconhecida: *') { return $false }
    if ($msg -like 'Formato invalido. Use socks5://*') { return $false }
    if ($msg -like 'Endereco da proxy invalido*') { return $false }
    if ($msg -like 'Nao consegui baixar *') { return $false }
    # dependencia faltando (ambiente)
    if ($msg -like 'Instale *') { return $false }
    if ($msg -like 'O npm nao conseguiu instalar o pnpm*') { return $false }
    if ($msg -like 'Nao consegui deixar o pnpm funcionando*') { return $false }
    # path / checkout errado
    if ($msg -like 'Nao encontrei o checkout do Equicord/Vencord*') { return $false }
    if ($msg -like 'Nao achei *') { return $false }
    if ($msg -like '*ja existe e nao parece um checkout*') { return $false }
    if ($msg -like 'Nao achei o patcher *') { return $false }
    if ($msg -like 'Nao achei nenhum Discord instalado*') { return $false }
    # ferramenta externa (ambiente)
    if ($msg -eq 'git clone falhou') { return $false }
    if ($msg -eq 'pnpm install falhou') { return $false }
    if ($msg -eq 'pnpm build falhou') { return $false }
    if ($msg -eq 'pnpm inject falhou') { return $false }
    # desinstalacao / elevacao parcial
    if ($msg -like 'Nao consegui desinstalar de todos*') { return $false }
    if ($msg -like 'NADA foi injetado*') { return $false }
    # default: e bug, reporta
    return $true
}

# =========================================================================== /Report de bugs

# =========================================================================== TUI (PowerShell)
# Interface no estilo OpenCode (dark, caixas, setas/Enter). Mouse: console do Windows nao
# expoe cliques de forma confiavel; navegacao por teclado. Sem TTY ou com -Yes → flags.

# Diz se o console suporta ANSI (modo VT). O conhost classico do Windows (cmd rodando o
# powershell.exe) NAO interpreta escapes por padrao: a TUI apareceria cheia de "[48;5;235m".
# Tentamos habilitar o modo VT via P/Invoke; se der certo, ANSI funciona (Windows Terminal,
# VS Code, conhost com VT ativo). Se nao der, a TUI cai para os menus/flags simples.
function Test-TuiAnsi {
    try {
        Add-Type -Namespace Win32 -Name Console -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError = true)]
public static extern IntPtr GetStdHandle(int nStdHandle);
[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool GetConsoleMode(IntPtr hConsoleHandle, out uint lpMode);
[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool SetConsoleMode(IntPtr hConsoleHandle, uint dwMode);
'@ -ErrorAction Stop
        $h = [Win32.Console]::GetStdHandle(-11)
        if ($h -eq [IntPtr]::Zero) { return $false }
        $mode = [uint32]0
        if (-not [Win32.Console]::GetConsoleMode($h, [ref]$mode)) { return $false }
        if (($mode -band 0x0004) -eq 0x0004) { return $true }
        $novo = $mode -bor 0x0004
        [Win32.Console]::SetConsoleMode($h, $novo) | Out-Null
        return $true
    } catch {
        return $false
    }
}

function Test-TuiInteractive {
    if ($Yes) { return $false }
    if ([Console]::IsInputRedirected -or [Console]::IsOutputRedirected) { return $false }
    # Sem ANSI de verdade (conhost classico) os escapes quebram a tela: cai para os scripts
    # por flags/confirmações simples.
    return (Test-TuiAnsi)
}

$script:TuiBg = "$([char]27)[48;5;235m"
$script:TuiFg = "$([char]27)[38;5;252m"
$script:TuiAccent = "$([char]27)[38;5;75m"
$script:TuiOk = "$([char]27)[38;5;114m"
$script:TuiDim = "$([char]27)[38;5;240m"
$script:TuiBold = "$([char]27)[1m"
$script:TuiRset = "$([char]27)[0m"

function Tui-HideCursor { Write-Host "$([char]27)[?25l" -NoNewline }
function Tui-ShowCursor { Write-Host "$([char]27)[?25h" -NoNewline }
function Tui-ClearBelow([int]$row) { Write-Host "$([char]27)[$row;0H$([char]27)[J" -NoNewline }

function Tui-GetKey {
    # Drenar buffer: SSH/conhost injeta Enter espúrio no início da sessão.
    if ([Console]::KeyAvailable) {
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        while ([Console]::KeyAvailable -and $sw.ElapsedMilliseconds -lt 80) {
            [void][Console]::ReadKey($true)
        }
    }
    try {
        $k = [Console]::ReadKey($true)
        switch ($k.Key) {
            'UpArrow'  { return 'up' }
            'DownArrow' { return 'down' }
            'Enter'    { return 'enter' }
            'Escape'   { return 'esc' }
            default {
                if ($k.KeyChar -eq 'j') { return 'down' }
                if ($k.KeyChar -eq 'k') { return 'up' }
                if ($k.KeyChar -eq 'q') { return 'esc' }
                if ($k.KeyChar -eq ' ') { return 'space' }
                if ($k.KeyChar -eq 'a') { return 'all' }
                return 'other'
            }
        }
    } catch { return 'other' }
}

function Tui-Menu([string]$title, [string[]]$items) {
    if (-not (Test-TuiInteractive)) { return 0 }
    $sel = 0
    $n = $items.Count
    Tui-HideCursor
    try {
        while ($true) {
            Tui-ClearBelow 1
            Write-Host "`r" -NoNewline
            $top = '─' * (62 - 8)
            Write-Host "$($script:TuiBg)$($script:TuiRset)┌─ $($script:TuiAccent)$title$($script:TuiRset) ─$($script:TuiDim)$top$($script:TuiRset)" -NoNewline
            Write-Host ''
            for ($i = 0; $i -lt $n; $i++) {
                $txt = $items[$i]
                $pad = ' ' * [Math]::Max(0, (62 - 6 - $txt.Length))
                if ($i -eq $sel) {
                    Write-Host "$($script:TuiBg)│ $($script:TuiAccent)●$($script:TuiRset) $($script:TuiBold)$txt$($script:TuiRset)$pad │$($script:TuiRset)" -NoNewline
                } else {
                    Write-Host "$($script:TuiBg)│ $($script:TuiDim)○$($script:TuiRset) $txt$pad │$($script:TuiRset)" -NoNewline
                }
                Write-Host ''
            }
            Write-Host "$($script:TuiBg)└$('─' * (62 - 2))┘$($script:TuiRset)" -NoNewline
            Write-Host ''
            Write-Host "  $($script:TuiDim)[↑↓] navegar · [Enter] escolher · [Esc] cancelar$($script:TuiRset)" -NoNewline
            $key = Tui-GetKey
            switch ($key) {
                'up'   { if ($sel -gt 0) { $sel-- } }
                'down' { if ($sel -lt $n - 1) { $sel++ } }
                'enter' { break }
                'esc'  { $sel = -1; break }
            }
            if ($key -eq 'enter' -or $key -eq 'esc') { break }
        }
    } finally {
        Tui-ShowCursor
    }
    if ($sel -ge 0) { return $sel + 1 } else { return 0 }
}

function Tui-MenuMulti([string]$title, [string[]]$items) {
    # Multi-selecao estilo checkbox (escolher QUAL Discord patchear): Espaco
    # marca/desmarca, 'a' marca/desmarca todos, Enter confirma (exige >= 1),
    # Esc cancela. Devolve os indices (1..N) marcados em ordem, ou nada se
    # cancelado.
    if (-not (Test-TuiInteractive)) { return $null }
    $sel = 0
    $n = $items.Count
    $marks = New-Object bool[] $n
    Tui-HideCursor
    try {
        while ($true) {
            Tui-ClearBelow 1
            Write-Host "`r" -NoNewline
            $top = '─' * (62 - 8)
            Write-Host "$($script:TuiBg)$($script:TuiRset)┌─ $($script:TuiAccent)$title$($script:TuiRset) ─$($script:TuiDim)$top$($script:TuiRset)" -NoNewline
            Write-Host ''
            for ($i = 0; $i -lt $n; $i++) {
                $txt = $items[$i]
                $pad = ' ' * [Math]::Max(0, (62 - 8 - $txt.Length))
                $box = if ($marks[$i]) { '[x]' } else { '[ ]' }
                $cor = if ($marks[$i]) { $script:TuiFg } else { $script:TuiDim }
                if ($i -eq $sel) {
                    Write-Host "$($script:TuiBg)│ $($script:TuiAccent)$box$($script:TuiRset) $($script:TuiBold)$txt$($script:TuiRset)$pad │$($script:TuiRset)" -NoNewline
                } else {
                    Write-Host "$($script:TuiBg)│ $($script:TuiDim)$box$($script:TuiRset) $cor$txt$($script:TuiRset)$pad │$($script:TuiRset)" -NoNewline
                }
                Write-Host ''
            }
            Write-Host "$($script:TuiBg)└$('─' * (62 - 2))┘$($script:TuiRset)" -NoNewline
            Write-Host ''
            Write-Host "  $($script:TuiDim)[↑↓] navegar · [Espaço] marcar · [a] todos · [Enter] confirmar · [Esc] cancelar$($script:TuiRset)" -NoNewline
            $key = Tui-GetKey
            if ($key -eq 'space') { $marks[$sel] = -not $marks[$sel]; continue }
            if ($key -eq 'all') {
                $tudoMarcado = $true
                foreach ($m in $marks) { if (-not $m) { $tudoMarcado = $false; break } }
                $novo = -not $tudoMarcado
                for ($i = 0; $i -lt $n; $i++) { $marks[$i] = $novo }
                continue
            }
            switch ($key) {
                'up'   { if ($sel -gt 0) { $sel-- } }
                'down' { if ($sel -lt $n - 1) { $sel++ } }
            }
            if ($key -eq 'esc') { $sel = -1; break }
            if ($key -eq 'enter') {
                $algum = $false
                foreach ($m in $marks) { if ($m) { $algum = $true; break } }
                if ($algum) { break }
            }
        }
    } finally {
        Tui-ShowCursor
    }
    if ($sel -lt 0) { return $null }
    $out = @()
    for ($i = 0; $i -lt $n; $i++) { if ($marks[$i]) { $out += ($i + 1) } }
    return $out
}

function Tui-Input([string]$label, [string]$initial = '') {
    Write-Host "$($script:TuiBg)$($script:TuiFg)  ${label}: $($script:TuiAccent)$initial" -NoNewline
    Tui-ShowCursor
    $v = Read-Host
    Tui-HideCursor
    return ($v -replace '\s+$', '')
}

function Tui-Confirm([string]$question) {
    if (-not (Test-TuiInteractive)) { return (Confirm-Action $question) }
    $ans = Read-Host "$($script:TuiBg)$($script:TuiFg)  $question [s/N]"
    return ($ans -match '^[sSyY]')
}

# =========================================================================== /TUI

function Test-DiscordResourcesReady($resources) {
    if (-not $resources) { return $false }
    $asar = Join-Path $resources 'app.asar'
    $original = Join-Path $resources '_app.asar'
    return (Test-Path -LiteralPath $asar) -or (Test-Path -LiteralPath $original)
}

# Cada versao do Discord vive numa pasta app-VERSAO propria. A que importa e a mais nova
# completa: durante um update o Squirrel cria a pasta nova antes de copiar app.asar.
function Get-DiscordResources {
    $found = @()
    if (-not $LocalApp) { return $found }
    foreach ($flavour in $DiscordFlavours) {
        $root = Join-Path $LocalApp $flavour
        if (-not (Test-Path -LiteralPath $root)) { continue }

        $versions = Get-ChildItem -LiteralPath $root -Directory -Filter 'app-*' -ErrorAction SilentlyContinue |
            Sort-Object { [Version]($_.Name -replace '^app-', '') } -Descending -ErrorAction SilentlyContinue
        if (-not $versions) { continue }

        $resources = $null
        foreach ($ver in $versions) {
            if (-not $ver -or -not $ver.FullName) { continue }
            $candidate = Join-Path $ver.FullName 'resources'
            if (Test-DiscordResourcesReady $candidate) {
                $resources = $candidate
                break
            }
        }
        if ($resources) {
            $found += [pscustomobject]@{ Flavour = $flavour; Resources = $resources }
        }
    }
    return $found
}

# Tres estados possiveis, e confundir eles apagaria a instalacao de outra pessoa:
#   Vanilla   - Discord intocado
#   Nosso     - ja tem o standalone
#   OutroMod  - Equicord, Vencord ou parecido ja esta injetado
# Devolve o estado da injecao em $resources. Pode ser:
#   "Vanilla"        - o Discord nunca foi tocado (sem _app.asar)
#   "Nosso"          - a injeção anterior foi o nosso patcher (safe pra sobrescrever)
#   "OutroMod"       - tem outro mod (Vesktop/Equibop/Legcord) - nao da pra saber qual pelo disco
#   "Vencord"        - detectamos o stub do Vencord (require para %APPDATA%/Vencord/...)
#   "Equicord"       - detectamos o stub do Equicord (require para .../Equicord/...)
#   "VencordPlugin"  - detectamos o stub do nosso proprio goLiveBypass-vencord.zip
#                      (Vencord com o plugin do GoLiveBypass ja rodando - estado IDEAL,
#                      o user nao deveria ter rodado o standalone)
#
# Vencord/Equicord sao protegidos: o standalone ocupa o mesmo lugar, sobrescrever
# apaga os outros plugins do mod. O fluxo de install checa isso e pede Confirm-Action
# com texto especifico. Vesktop/Equibop/Legcord sao clientes paralelos - o user
# perde a identidade do cliente mas nao tem plugins de Vencord perdidos.
function Get-InjectionState($resources) {
    $svc = Get-Service -Name 'wiresock-client-service' -ErrorAction SilentlyContinue
    if ($svc -and $svc.Status -eq 'Running') { return 'Nosso' }

    if (-not $resources) { return 'Vanilla' }
    $asar = Join-Path $resources 'app.asar'
    $original = Join-Path $resources '_app.asar'

    if (-not (Test-Path -LiteralPath $original)) { return 'Vanilla' }

    # Quando o app.asar eh nosso patcher, ele eh um diretorio com index.js dentro.
    # Quando o app.asar eh o stub do Vencord/Equicord, ele eh um arquivo - o stub do
    # mod vive dentro desse arquivo, nao eh acessivel por filesystem. Os dois
    # caminhos abaixo cobrem os dois casos.
    $content = ''
    $index = Join-Path $asar 'index.js'
    if (Test-Path -LiteralPath $index -PathType Leaf) {
        # Caso 1: app.asar eh diretorio (nosso patcher).
        $content = [IO.File]::ReadAllText($index, [Text.Encoding]::UTF8)
    } elseif (Test-Path -LiteralPath $asar -PathType Leaf) {
        # Caso 2: app.asar eh arquivo (stub do Vencord/Equicord/Vesktop/etc). Lemos
        # o proprio arquivo - o stub tem ~200 bytes e contem o require("...")
        # que aponta pro patcher do mod (sai nos primeiros KBs).
        $bytes = [IO.File]::ReadAllBytes($asar)
        if ($bytes.Length -gt 0) {
            $snippet = if ($bytes.Length -gt 4096) { $bytes[0..4095] } else { $bytes }
            $content = [Text.Encoding]::UTF8.GetString($snippet)
        }
    }

    if ($content -like "*$PatcherName*") { return 'Nosso' }
    if ($content -match '(?i)vencord') { return 'Vencord' }
    if ($content -match '(?i)equicord') { return 'Equicord' }
    if ($content -match '(?i)equibop')  { return 'OutroMod' }
    if ($content -match '(?i)vesktop')  { return 'OutroMod' }
    if ($content -match '(?i)legcord')  { return 'OutroMod' }
    return 'OutroMod'
}

# Clientes paralelos no Windows (Vesktop/Equibop/Legcord): mesmo padrao
# electron-builder do Discord. O .sh ja cobre isso no Linux; aqui e o espelho
# Windows (relato: Discord oficial + Vesktop com conta secundaria).
$ParallelNames = @('Vesktop', 'Equibop', 'Legcord')

function Get-PatchTargets {
    # Oficiais + paralelos num formato so (Flavour|Resources|Paralelo) para o
    # seletor e para os loops de Install/Uninstall.
    $targets = @()
    foreach ($install in (Get-DiscordResources)) {
        # ATENCAO: o Get-DiscordResources daqui devolve OBJETOS {Flavour, Resources}
        # (diferente do do instalador, que devolve strings de caminho). Nao troque por
        # "$install" — stringificar o objeto virava o path "@{Flavour=...; Resources=C}"
        # e o Join-Path morria com "Cannot find drive" (regressao minha, 1.1.11-beta.3).
        $targets += [pscustomobject]@{ Flavour = $install.Flavour; Resources = $install.Resources; Paralelo = $false }
    }
    if ($env:LOCALAPPDATA) {
        foreach ($name in $ParallelNames) {
            foreach ($base in @((Join-Path $env:LOCALAPPDATA $name), (Join-Path $env:LOCALAPPDATA "Programs\$name"))) {
                if (-not (Test-Path -LiteralPath $base)) { continue }
                # Padrao Squirrel: app-<versao>\resources. Direto: <base>\resources.
                $candidate = Join-Path $base 'resources'
                if (-not (Test-DiscordResourcesReady $candidate)) {
                    $versions = Get-ChildItem -LiteralPath $base -Directory -Filter 'app-*' -ErrorAction SilentlyContinue |
                        Sort-Object Name -Descending
                    foreach ($ver in $versions) {
                        $c = Join-Path $ver.FullName 'resources'
                        if (Test-DiscordResourcesReady $c) { $candidate = $c; break }
                    }
                }
                if (Test-DiscordResourcesReady $candidate) {
                    $targets += [pscustomobject]@{ Flavour = $name; Resources = $candidate; Paralelo = $true }
                    break
                }
            }
        }
    }
    return $targets
}

function Get-StateLabel($resources) {
    switch (Get-InjectionState $resources) {
        'Vanilla'  { 'sem nada instalado' }
        'Nosso'    { 'com o GoLiveBypass standalone' }
        'Vencord'  { 'com Vencord' }
        'Equicord' { 'com Equicord' }
        default    { 'com Equicord/Vencord (ou outro mod)' }
    }
}

function Select-PatchTargets($targets, [string]$acao) {
    # 1 alvo: sem pergunta (como antes). -Yes ou sem TTY: todos (comportamento
    # de antes do seletor). Com TTY e mais de um: multi-select - um, varios ou
    # todos; Esc cancela a operacao.
    if (-not $targets -or @($targets).Count -le 1) { return $targets }
    if ($Yes -or -not (Test-TuiInteractive)) { return $targets }

    $labels = foreach ($t in $targets) {
        $suf = if ($t.Paralelo) { ' (cliente paralelo)' } else { '' }
        "$($t.Flavour)$suf - $(Get-StateLabel $t.Resources)"
    }
    $escolha = Tui-MenuMulti "Quais Discords quer $acao?" $labels
    if (-not $escolha) { throw 'Cancelado.' }
    $escolhidos = @()
    foreach ($i in $escolha) { $escolhidos += $targets[$i - 1] }
    return $escolhidos
}

function Stop-Discord {
    $running = @()
    foreach ($flavour in $DiscordFlavours) {
        $procs = Get-Process -Name $flavour -ErrorAction SilentlyContinue
        if ($procs) { $running += $flavour }
    }
    if (-not $running) { return }

    Write-Step "Fechando o Discord ($($running -join ', '))"
    foreach ($flavour in $running) {
        Get-Process -Name $flavour -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    }

    # Esperar a saida de verdade: gravar por cima de um processo vivo falha no Windows.
    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Milliseconds 250
        $alive = $false
        foreach ($flavour in $DiscordFlavours) {
            if (Get-Process -Name $flavour -ErrorAction SilentlyContinue) { $alive = $true }
        }
        if (-not $alive) { return }
    }
    throw 'O Discord nao fechou. Feche na mao e rode de novo.'
}

function Rename-DiscordAsarWithRetry([string]$path, [string]$newName) {
    # Mesmo depois de o processo sair, o Windows pode levar alguns segundos para
    # liberar o handle do app.asar (updater, antivírus ou encerramento do Electron).
    # Uma tentativa única transformava uma corrida transitória em IOException.
    $lastError = $null
    for ($i = 0; $i -lt 40; $i++) {
        try {
            Rename-Item -LiteralPath $path -NewName $newName -Force -ErrorAction Stop
            return
        } catch {
            $lastError = $_
            if ($i -eq 0) {
                Write-Warn 'O Windows ainda esta liberando o Discord; aguardando para trocar o app.asar.'
            }
            if ($i -lt 39) { Start-Sleep -Milliseconds 250 }
        }
    }
    throw $lastError.Exception
}

function Install-Patcher {
    $source = if ($PSScriptRoot) { Join-Path $PSScriptRoot $PatcherName } else { Join-Path (Get-Location).Path $PatcherName }
    $code = $null
    if (Test-Path -LiteralPath $source) {
        $code = [IO.File]::ReadAllText($source)
    } else {
        Write-Step "Baixando $PatcherName do GitHub"
        $url = "https://raw.githubusercontent.com/bezumiya/GoLiveBypass/main/standalone/$PatcherName"
        try {
            $code = (Invoke-WebRequest -UseBasicParsing -Uri $url).Content
        } catch {
            throw "Nao achei $PatcherName localmente e nao consegui baixar do GitHub: $($_.Exception.Message)"
        }
    }

    if (-not (Test-Path -LiteralPath $InstallDir)) { New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null }
    [IO.File]::WriteAllText((Join-Path $InstallDir $PatcherName), $code, (New-Object Text.UTF8Encoding $false))
    Write-Ok "Bypass gravado em $InstallDir"

    # As configuracoes ficam fora da pasta do Discord de proposito: uma atualizacao do Discord
    # apaga resources/ inteiro, e levaria a proxy do usuario junto.
    $settingsPath = Join-Path $InstallDir 'settings.json'
    $settings = @{}
    if (Test-Path -LiteralPath $settingsPath) {
        try { $settings = Get-Content -LiteralPath $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $settings = @{} }
    }

    $result = [ordered]@{
        enabled = $true
        proxy = $Proxy
        excludedCountries = $ExcludedCountries
        # Recuperacao de gateway/RTC e critica; builds novos nunca preservam
        # o opt-out legado de uma GUI anterior.
        autoRevive = $true
    }
    if ($Proxy -eq '' -and $settings.proxy) { $result.proxy = $settings.proxy }

    # Modo Tor: aponta o bypass para a porta dedicada e limpa a proxy manual (o Tor tem
    # prioridade no golivebypass.js quando routeMode='tor' e torAddr definido).
    if ($Tor) {
        $result.routeMode = 'tor'
        $result.torAddr = "127.0.0.1:$TorPort"
        $result.proxy = ''
    } elseif ($settings.routeMode) {
        # Sem -Tor, preserva a escolha anterior (rotina do script).
        $result.routeMode = $settings.routeMode
        $result.torAddr = $settings.torAddr
    }

    [IO.File]::WriteAllText($settingsPath, ($result | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))
    Write-Ok "Configuracao gravada em $settingsPath"
}

# =============================================================== Tor embutido

function Test-TorReady {
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $task = $client.ConnectAsync('127.0.0.1', $TorPort)
        if (-not $task.Wait(1500)) { $client.Close(); return $false }
        if (-not $client.Connected) { $client.Close(); return $false }
        $client.Close()
        return $true
    } catch { return $false }
}

function Install-Tor {
    # Ja esta atendendo? Reusa (pode ser o Tor da GUI, que morre com ela, ou o servico nosso).
    if (Test-TorReady) {
        Write-Ok "Tor ja esta atendendo em 127.0.0.1:$TorPort."
        return $true
    }

    if (-not (Test-Path -LiteralPath $TorExe)) {
        Write-Step "Baixando o Tor ($TorArchiveName, ~30 MB)"
        $temp = if ($env:TEMP -and (Test-Path -LiteralPath $env:TEMP)) { $env:TEMP } else { [System.IO.Path]::GetTempPath() }
        $archive = Join-Path $temp $TorArchiveName
        try {
            Invoke-WebRequest -UseBasicParsing -Uri $TorUrl -OutFile $archive
        } catch {
            Write-Warn "Falha ao baixar o Tor: $($_.Exception.Message)"
            return $false
        }

        Write-Step 'Conferindo SHA-256'
        $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLower()
        if ($hash -ne $TorSha256.ToLower()) {
            Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
            Write-Warn 'O download do Tor veio corrompido (SHA-256 diferente). Abortando.'
            return $false
        }

        Write-Step 'Extraindo o Tor'
        New-Item -ItemType Directory -Path $TorDir -Force | Out-Null
        & tar -xzf $archive -C $TorDir --exclude 'tor/pluggable_transports/*' --exclude 'debug/*'
        if ($LASTEXITCODE -ne 0) {
            Write-Warn 'Falha ao extrair o bundle do Tor.'
            return $false
        }
        Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
    }

    if (-not (Test-Path -LiteralPath $TorExe)) {
        Write-Warn "O binario do Tor nao apareceu em $TorExe."
        return $false
    }

    $dataDir = Join-Path $TorDir 'data-state'
    New-Item -ItemType Directory -Path $dataDir -Force | Out-Null

    $geoipLines = ''
    if (Test-Path -LiteralPath (Join-Path $TorDir 'tor\data\geoip')) {
        $geoipLines += "GeoIPFile $(Join-Path $TorDir 'tor\data\geoip')`n"
    }
    if (Test-Path -LiteralPath (Join-Path $TorDir 'tor\data\geoip6')) {
        $geoipLines += "GeoIPv6File $(Join-Path $TorDir 'tor\data\geoip6')`n"
    }
    [IO.File]::WriteAllText($TorTorrc, "SocksPort $TorPort`nDataDirectory $dataDir`n$geoipLines`Log notice stdout`n", (New-Object Text.UTF8Encoding $false))

    # O caminho do Windows: o servico (tor.exe --service install) roda como LocalService e
    # nao tem acesso a %LOCALAPPDATA% do usuario, entao o Tor nao consegue escrever no
    # DataDirectory e o servico fica parado. A Run key sobe o Tor no logon do USUARIO — mesmo
    # contexto da GUI — e e o caminho que funciona para o standalone/plugin, com ou sem admin.
    # So vale a pena o servico se o DataDirectory morar em ProgramData (acessivel por
    # LocalService); isso e o caso da GUI, nao dos instaladores.
    Write-Step 'Registrando o Tor na inicializacao do usuario (sobe no logon)'
    Set-RunKey

    # A Run key so vale no proximo logon; para a sessao atual, sobe o daemon agora.
    Write-Step 'Iniciando o Tor'
    Start-Process -FilePath $TorExe -ArgumentList '-f', $TorTorrc -WindowStyle Hidden

    Write-Step 'Esperando o Tor subir'
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Milliseconds 1000
        if (Test-TorReady) { break }
    }

    if (-not (Test-TorReady)) {
        Write-Warn "Tor nao subiu em 30s. Veja o log em $TorDir\tor\data-state."
        return $false
    }
    Write-Ok "Tor atendendo em 127.0.0.1:$TorPort"
    return $true
}

function Set-RunKey {
    try {
        # ATENCAO: nada de "New-Item -Path <chave> -Force" aqui. No provider de
        # registro (diferente do de arquivos) o -Force numa chave que ja existe
        # APAGA a chave e recria vazia, levando junto todas as entradas de
        # inicializacao do usuario (Spotify, Steam, Discord...).
        # A chave Run sempre existe no Windows; so criamos se realmente faltar.
        $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
        if (-not (Test-Path -LiteralPath $key)) {
            New-Item -Path $key -Force | Out-Null
        }
        # O tor.exe e binario CONSOLE: a Run key apontando direto para ele abre uma
        # janela de terminal visivel a cada logon. O wrapper .vbs via wscript.exe
        # (aplicacao GUI-subsystem) lanca o tor com janela 0 = invisivel, sem o
        # flash de console.
        $vbs = Join-Path (Split-Path -Parent $TorTorrc) 'GoLiveBypassTor.vbs'
        $inner = "`"$TorExe`" -f `"$TorTorrc`"".Replace('"', '""')
        # Unicode (UTF-16 com BOM): wscript detecta o BOM e le caminhos com acento
        # que o ANSI do sistema nao representaria.
        [System.IO.File]::WriteAllText($vbs, "CreateObject(`"WScript.Shell`").Run `"$inner`", 0, False", [System.Text.Encoding]::Unicode)
        $command = "`"$env:SystemRoot\System32\wscript.exe`" `"$vbs`""
        Set-ItemProperty -Path $key -Name 'GoLiveBypassTor' -Value $command
        Write-Ok 'Tor registrado para subir no proximo logon, sem janela de terminal (GoLiveBypassTor).'
    } catch {
        Write-Warn "Nao consegui registrar a inicializacao: $($_.Exception.Message)"
    }
}

function Remove-Tor {
    # Remove a Run key (o que este script cria). Se um servico "tor" existir de uma instalacao
    # anterior (ex.: GUI), o deixamos em paz? Nao — se o binario e nosso (pasta GoLiveBypass),
    # o servico aponta para ele e deve sair; senao e de outra pessoa.
    try {
        $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
        Remove-ItemProperty -Path $key -Name 'GoLiveBypassTor' -ErrorAction SilentlyContinue
    } catch { }
    # O wrapper invisivel que o Set-RunKey gravou ao lado do torrc tambem sai.
    try {
        Remove-Item -LiteralPath (Join-Path (Split-Path -Parent $TorTorrc) 'GoLiveBypassTor.vbs') -Force -ErrorAction SilentlyContinue
    } catch { }

    if (Test-Path -LiteralPath $TorExe) {
        try {
            $service = Get-CimInstance Win32_Service -Filter "Name='tor' AND PathName LIKE '%GoLiveBypass%'" -ErrorAction SilentlyContinue
            if ($service) {
                Write-Step 'Removendo o servico do Tor'
                & $TorExe --service stop 2>&1 | Out-Null
                & $TorExe --service remove 2>&1 | Out-Null
            }
        } catch { }
    }

    # O binario fica: a GUI usa o mesmo e sem ele nao faz mal.
    if (Test-Path -LiteralPath $TorExe) {
        Write-Host '  [*] O binario do Tor em %LOCALAPPDATA%\GoLiveBypass\Tor permanece (usado tambem pela GUI).' -ForegroundColor DarkGray
    }
}

function Install-Injection($resources) {
    if (-not $resources) { throw 'Caminho de instalacao invalido.' }
    $asar = Join-Path $resources 'app.asar'
    $original = Join-Path $resources '_app.asar'
    $patcher = Join-Path $InstallDir $PatcherName

    # Vencord/Equicord deixam o _app.asar DELES na frente (o backup que eles fizeram do
    # original), e o fluxo so limpa isso para o estado OutroMod. Sem restaurar aqui, o
    # Rename-Item abaixo explode com "Cannot create a file when that file already exists":
    # o -Force do Rename-Item nao sobrescreve destino existente, so atributos escondidos
    # (issue #103). Tambem cobre corrida com o updater/patchNewerSiblings entre a checagem
    # de estado e este ponto.
    if (Test-Path -LiteralPath $original) { Remove-Injection $resources | Out-Null }

    Rename-DiscordAsarWithRetry $asar '_app.asar'
    try {
        New-Item -ItemType Directory -Path $asar -Force | Out-Null
        [IO.File]::WriteAllText((Join-Path $asar 'package.json'), $StubPackage, (New-Object Text.UTF8Encoding $false))
        [IO.File]::WriteAllText((Join-Path $asar 'index.js'), "require($($patcher | ConvertTo-Json));", (New-Object Text.UTF8Encoding $false))
    } catch {
        # Sem o desfazer, uma falha aqui deixaria o Discord sem app.asar nenhum: ele nao abriria
        # mais, e o usuario nao teria como saber o porque.
        if (Test-Path -LiteralPath $asar) { Remove-Item -LiteralPath $asar -Recurse -Force -ErrorAction SilentlyContinue }
        try { Rename-DiscordAsarWithRetry $original 'app.asar' } catch { }
        throw
    }
}

function Remove-Injection($resources) {
    if (-not $resources) { return $false }
    $asar = Join-Path $resources 'app.asar'
    $original = Join-Path $resources '_app.asar'

    if (-not (Test-Path -LiteralPath $original)) { return $false }

    if (Test-Path -LiteralPath $asar) { Remove-Item -LiteralPath $asar -Recurse -Force }
    Rename-DiscordAsarWithRetry $original 'app.asar'
    return $true
}

function Compare-StandaloneVersion([string]$local, [string]$remote) {
    $local = $local -replace '^v', ''
    $remote = $remote -replace '^v', ''
    $localDash = $local.IndexOf('-')
    $remoteDash = $remote.IndexOf('-')
    $localCore = if ($localDash -ge 0) { $local.Substring(0, $localDash) } else { $local }
    $localPre = if ($localDash -ge 0) { $local.Substring($localDash + 1) } else { '' }
    $remoteCore = if ($remoteDash -ge 0) { $remote.Substring(0, $remoteDash) } else { $remote }
    $remotePre = if ($remoteDash -ge 0) { $remote.Substring($remoteDash + 1) } else { '' }
    $a = $localCore.Split('.')
    $b = $remoteCore.Split('.')
    for ($i = 0; $i -lt [Math]::Max($a.Count, $b.Count); $i++) {
        $left = if ($i -lt $a.Count) { [int]($a[$i] -replace '[^0-9].*$', '') } else { 0 }
        $right = if ($i -lt $b.Count) { [int]($b[$i] -replace '[^0-9].*$', '') } else { 0 }
        if ($left -ne $right) { return $(if ($left -lt $right) { -1 } else { 1 }) }
    }
    # Mesma versao base: um sufixo de pre-release (-beta.N) sempre conta como
    # mais antigo que a mesma base sem sufixo, nunca como um componente extra.
    if ($localPre -and -not $remotePre) { return -1 }
    if (-not $localPre -and $remotePre) { return 1 }
    if ($localPre -and $remotePre) { return [string]::Compare($localPre, $remotePre, [System.StringComparison]::Ordinal) }
    return 0
}

function Get-StandaloneRelease {
    $headers = @{ 'User-Agent' = 'GoLiveBypass-Standalone' }
    $release = Invoke-RestMethod -Uri $StandaloneRepoApi -Headers $headers -TimeoutSec 20
    if ($release.draft -or $release.prerelease) { throw 'a release estavel nao esta disponivel' }
    $asset = @($release.assets) | Where-Object { $_.name -match '-bypass\.js$' } | Select-Object -First 1
    if (-not $asset) { throw 'release sem asset do payload standalone' }
    return [pscustomobject]@{ Tag = ($release.tag_name -replace '^v', ''); TagRef = $release.tag_name; PayloadUrl = $asset.browser_download_url }
}

function Invoke-StandaloneCheckUpdate {
    try { $release = Get-StandaloneRelease } catch { Write-Warn "Nao consegui consultar a release estavel: $($_.Exception.Message)"; return }
    $cmp = Compare-StandaloneVersion $StandaloneVersion $release.Tag
    Write-Host "  standalone: v$StandaloneVersion"
    Write-Host "  remoto:     v$($release.Tag)"
    if ($cmp -lt 0) { Write-Host '  resultado:  ha uma atualizacao' -ForegroundColor Yellow }
    elseif ($cmp -eq 0) { Write-Host '  resultado:  ja esta atualizado' -ForegroundColor Green }
    else { Write-Host '  resultado:  versao local e mais nova' -ForegroundColor DarkGray }
}

function Invoke-StandaloneUpdate {
    $release = Get-StandaloneRelease
    if ((Compare-StandaloneVersion $StandaloneVersion $release.Tag) -ge 0) { Write-Ok "Standalone ja esta na v$StandaloneVersion"; return }
    $tmp = Join-Path ([IO.Path]::GetTempPath()) "golivebypass-$($release.Tag).ps1"
    $backup = "$PSCommandPath.bak.$(Get-Date -Format yyyyMMddHHmmss)"
    # Script e payload sempre vem da MESMA tag da release: buscar o script em
    # main misturaria uma versao do script com um payload de outra release.
    $scriptUrl = "$StandaloneRepoRoot/$($release.TagRef)/standalone/GoLiveBypass-Standalone.ps1"
    Invoke-WebRequest -Uri $scriptUrl -OutFile $tmp -UseBasicParsing -TimeoutSec 60
    Copy-Item -LiteralPath $PSCommandPath -Destination $backup -Force
    Move-Item -LiteralPath $tmp -Destination $PSCommandPath -Force
    $installed = Join-Path $InstallDir $PatcherName
    if (Test-Path -LiteralPath $installed) {
        $payloadTmp = Join-Path ([IO.Path]::GetTempPath()) "golivebypass-payload-$($release.Tag).js"
        Invoke-WebRequest -Uri $release.PayloadUrl -OutFile $payloadTmp -UseBasicParsing -TimeoutSec 60
        Copy-Item -LiteralPath $installed -Destination "$installed.bak.$(Get-Date -Format yyyyMMddHHmmss)" -Force
        Move-Item -LiteralPath $payloadTmp -Destination $installed -Force
    }
    Write-Ok "Standalone atualizado para v$($release.Tag). Backup: $backup"
}

function Show-Status {
    Write-Host "`n=== STATUS DO DISCORD E REDE ===" -ForegroundColor Cyan
    try {
        $sysIp = (curl.exe -s -m 3 https://api.ipify.org).Trim()
        Write-Host "  [Rede Normal do PC]"
        Write-Host "    IP Publico : $sysIp (todo o restante do PC navega por aqui)"
    } catch {
        Write-Host "    IP Publico : Desconhecido"
    }

    Write-Host "`n  [Tunel WireGuard para o Discord]"
    $svc = Get-Service -Name 'wiresock-client-service' -ErrorAction SilentlyContinue
    if ($svc -and $svc.Status -eq 'Running') {
        Write-Ok "WireSock ATIVO (Servico em execucao)."
        try {
            $tmpCurl = Join-Path $InstallDir 'Discord.exe'
            Copy-Item (Get-Command curl.exe).Source $tmpCurl -Force
            $trace = & $tmpCurl -s -m 5 https://cloudflare.com/cdn-cgi/trace
            Remove-Item $tmpCurl -Force -ErrorAction SilentlyContinue
            
            $loc = ($trace | Select-String "^loc=").ToString().Trim()
            $ip  = ($trace | Select-String "^ip=").ToString().Trim()
            Write-Host "    IP no Discord : $ip"
            Write-Host "    Pais          : $loc"
            Write-Ok "TODO o trafego do Discord esta 100% envelopado na VPN (sem proxy)!"
        } catch { }
    } else {
        Write-Warn "WireSock NAO esta em execucao."
    }

    Write-Host "`n  [Instalacoes do Discord]"
    $installs = Get-DiscordResources
    if ($installs) {
        foreach ($install in $installs) {
            $state = Get-InjectionState $install.Resources
            Write-Host "  $($install.Flavour): $state" -ForegroundColor White
            Write-Host "    $($install.Resources)" -ForegroundColor DarkGray
        }
    }
}

Write-Host ''
Write-Host '  GoLiveBypass standalone' -ForegroundColor Magenta
Write-Host '  Go Live e camera de volta, direto no Discord' -ForegroundColor DarkGray
Write-Host ''

if ($Mode -eq 'Status') { Show-Status; Wait-AntesDeFechar; return }
if ($Mode -eq 'CheckUpdate') { Invoke-StandaloneCheckUpdate; Wait-AntesDeFechar; return }
if ($Mode -eq 'Update') { Invoke-StandaloneUpdate; Wait-AntesDeFechar; return }

$installs = @(Get-PatchTargets)
if (-not $installs) { Write-Bad 'Nao achei nenhum Discord instalado.'; Wait-AntesDeFechar; return }

# corpo principal protegido: qualquer erro nao tratado vira report automatico
try {
# ---------------------------------------------------------------------------
# Modo interativo (TUI): rodando sem -Mode Uninstall/Status, sem flags de proxy/tor
# e com TTY, mostra um menu estilo OpenCode e deixa escolher a rede. Com -Yes ou
# sem TTY, o fluxo continua por flags (comportamento atual).
if ($Mode -eq 'Install' -and (Test-TuiInteractive)) {
    $tuiChoice = Tui-Menu 'GoLiveBypass standalone' @(
        'Instalar o bypass',
        'Ver status',
        'Verificar atualizacoes',
        'Atualizar standalone',
        'Desinstalar',
        'Sair'
    )
    switch ($tuiChoice) {
        2 {
            Show-Status
            Wait-AntesDeFechar
            return
        }
        3 {
            Invoke-StandaloneCheckUpdate
            Wait-AntesDeFechar
            return
        }
        4 {
            Invoke-StandaloneUpdate
            Wait-AntesDeFechar
            return
        }
        5 {
            $Mode = 'Uninstall'
        }
        0 { Write-Host '  Ate mais.' -ForegroundColor DarkGray; Wait-AntesDeFechar; return }
        default { }
    }
}

if ($Mode -eq 'Uninstall') {
    Stop-Discord
    Stop-WireSockTunnel
    $alvos = @(Select-PatchTargets $installs 'remover o bypass de')
    foreach ($install in $alvos) {
        if (Test-Path -LiteralPath (Join-Path $install.Resources '_app.asar')) {
            Remove-Injection $install.Resources | Out-Null
            Write-Ok "$($install.Flavour) restaurado para vanilla."
        }
    }
    Remove-Tor
    Write-Host ''
    Write-Host "  GoLiveBypass desinstalado e Discord restaurado." -ForegroundColor Green
    return
}

# Selecao de alvos: 1 alvo = sem pergunta (como antes); varios = escolher quais
# recebem o patch (um, varios ou todos).
$alvos = @(Select-PatchTargets $installs 'patchear')
foreach ($install in $alvos) {
    $state = Get-InjectionState $install.Resources
    Write-Host "  $($install.Flavour): $state" -ForegroundColor White

    if ($state -eq 'Vencord' -or $state -eq 'Equicord') {
        # Caso mais grave: o user tem Vencord/Equicord injetado, sobrescrever apaga
        # os outros plugins do mod. O instalador automatico do plugin (golive.ps1) eh
        # o caminho certo - sai em todo release do GoLiveBypass e convive com tudo.
        $modName = if ($state -eq 'Vencord') { 'Vencord' } else { 'Equicord' }
        Write-Warn "Este Discord ja tem $modName injetado."
        Write-Host "      O standalone ocupa o mesmo lugar, entao instalar aqui desliga o $modName e os outros plugins dele." -ForegroundColor DarkGray
        Write-Host "      Caminho certo: instale o GoLiveBypass como userplugin do $modName." -ForegroundColor DarkGray
        # O link do instalador automatico do plugin: o user cola esse comando e o
        # Vencord/Equicord + GoLiveBypass sao instalados juntos, sem sobrescrever nada.
        $cmd1 = 'irm https://raw.githubusercontent.com/bezumiya/GoLiveBypass/main/installer/GoLiveBypass-Installer.ps1 -OutFile $env:TEMP\glb.ps1'
        $cmd2 = 'powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\glb.ps1" -Mod Vencord -Yes'
        Write-Host "      Comando:" -ForegroundColor DarkGray
        Write-Host ("        " + $cmd1) -ForegroundColor DarkGray
        Write-Host ("        " + $cmd2) -ForegroundColor DarkGray
        if (-not (Confirm-Action "Substituir o $modName em $($install.Flavour) pelo standalone mesmo assim? (perde o mod e os plugins dele)")) {
            Write-Warn "$($install.Flavour) ficou como estava."
            Write-Host "      Para nao perder o $modName, instale o GoLiveBypass como plugin dele:" -ForegroundColor DarkGray
            Write-Host "      baixe o goLiveBypass-vencord.zip na aba Releases do GitHub e siga" -ForegroundColor DarkGray
            Write-Host "      o tutorial do README ('Instalação: passo a passo completo')." -ForegroundColor DarkGray
            continue
        }
    } elseif ($state -eq 'OutroMod') {
        # Cliente paralelo (Vesktop/Equibop/Legcord): o user perde a identidade do
        # cliente, mas nao tem plugins de Vencord perdidos. Aviso mais leve.
        Write-Warn 'Este Discord ja tem outro mod (Vesktop/Equibop/Legcord).'
        Write-Host '      O standalone ocupa o mesmo lugar, entao instalar aqui desliga o mod.' -ForegroundColor DarkGray
        if (-not (Confirm-Action "Substituir o mod em $($install.Flavour) pelo standalone?")) {
            Write-Warn "$($install.Flavour) ficou como estava."
            continue
        }
    }

    # Com -Tor, prepara o daemon antes de injetar: o settings.json do patcher aponta para ele
    # e o gateway segura ate o Tor responder (o bypass nunca cai direto no modo tor).
    if ($Tor -and -not (Install-Tor)) {
        Write-Warn 'O Tor nao subiu. Nao vou instalar o standalone no modo tor; tente de novo ou use -Proxy.'
        break
    }

    Install-WireSockTunnel
    Stop-Discord

    if (Test-Path -LiteralPath (Join-Path $install.Resources '_app.asar')) {
        Remove-Injection $install.Resources | Out-Null
        Write-Ok "Injecao legada de proxy removida de $($install.Flavour) (Discord restaurado para vanilla)."
    }

    Write-Ok "$($install.Flavour) pronto para execucao no WireGuard."
}

Write-Host ''
Write-Host '  Abra o Discord. O Go Live deve voltar sozinho.' -ForegroundColor Green
Write-Host "  Se algo der errado, o registro fica em $(Join-Path $InstallDir 'golivebypass.log')" -ForegroundColor DarkGray
Write-Host '  Para desfazer: .\GoLiveBypass-Standalone.ps1 -Mode Uninstall' -ForegroundColor DarkGray
Write-Host ''
} catch {
    Write-Host ''
    Write-Bad "Erro: $($_.Exception.Message)"
    Invoke-AutoBugReport 'Falha no GoLiveBypass standalone' $_.Exception.Message $_
    Wait-AntesDeFechar
}

Write-Host ''
Wait-AntesDeFechar
