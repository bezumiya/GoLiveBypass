<#
    GoLiveBypass standalone - instalador

    Instala direto no Discord, sem Equicord e sem Vencord. Nao precisa de Node, nem de pnpm,
    nem de git: o bypass e um arquivo .js que o proprio Discord carrega.

    Uso:
      .\GoLiveBypass-Standalone.ps1
      .\GoLiveBypass-Standalone.ps1 -Proxy "socks5://127.0.0.1:9050"
      .\GoLiveBypass-Standalone.ps1 -Mode Uninstall
#>

[CmdletBinding()]
param(
    [ValidateSet('Install', 'Uninstall', 'Status')]
    [string] $Mode = 'Install',

    [string] $Proxy = '',

    [string] $ExcludedCountries = 'BR',

    # Instala e sobe o Tor embutido, e aponta o bypass para ele (rota automatica tor).
    [switch] $Tor,

    [switch] $Yes
)

$ErrorActionPreference = 'Stop'
try { Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force } catch { }

# O trecho antes do @ e opcional e casado com ganancia, para a senha poder conter @ e :
# codificados. Sem validar aqui, um endereco com erro de digitacao viraria configuracao e o
# bypass cairia para a lista gratuita sem dizer por que.
if ($Proxy -ne '' -and $Proxy -notmatch '^(socks5|socks4|https?)://(?:.+@)?[^:/@\s]+:\d{1,5}(?:-\d{1,5})?$') {
    Write-Host ''
    Write-Host '  [X] Endereco de proxy invalido.' -ForegroundColor Red
    Write-Host '      Use socks5://host:porta, ou socks5://usuario:senha@host:porta.' -ForegroundColor DarkGray
    Write-Host '      Senha com @ ou : precisa vir codificada (@ vira %40, : vira %3A).' -ForegroundColor DarkGray
    Write-Host ''
    exit 1
}

$InstallDir = Join-Path $env:LOCALAPPDATA 'GoLiveBypass'
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

function Invoke-BugReport([string]$title, [string]$description) {
    if ($Yes) { return }  # automacao: nao spammar a API
    $desc = Invoke-SanitizeBug $description
    $body = @{ title = $title; description = $desc; includeLogs = $true } | ConvertTo-Json
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

function Invoke-AutoBugReport([string]$summary, [string]$extra = '') {
    # Erros de uso (dependencia, CLI typo, path errado, ferramenta externa) nao viram issue.
    if (-not (Test-ShouldReport $extra)) { return }
    # monta a descricao: extra + cauda do log (se existir)
    $logPath = Join-Path $InstallDir 'golivebypass.log'
    $tail = ''
    if (Test-Path -LiteralPath $logPath) {
        $tail = (Get-Content -LiteralPath $logPath -Tail 40 -ErrorAction SilentlyContinue | Out-String)
    }
    if ($extra -or $tail) {
        Invoke-BugReport $summary ($extra + "`n`n--- log ---`n" + $tail)
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
    $asar = Join-Path $resources 'app.asar'
    $original = Join-Path $resources '_app.asar'
    return (Test-Path -LiteralPath $asar) -or (Test-Path -LiteralPath $original)
}

# Cada versao do Discord vive numa pasta app-VERSAO propria. A que importa e a mais nova
# completa: durante um update o Squirrel cria a pasta nova antes de copiar app.asar.
function Get-DiscordResources {
    $found = @()
    foreach ($flavour in $DiscordFlavours) {
        $root = Join-Path $env:LOCALAPPDATA $flavour
        if (-not (Test-Path -LiteralPath $root)) { continue }

        $versions = Get-ChildItem -LiteralPath $root -Directory -Filter 'app-*' -ErrorAction SilentlyContinue |
            Sort-Object { [Version]($_.Name -replace '^app-', '') } -Descending -ErrorAction SilentlyContinue
        if (-not $versions) { continue }

        $resources = $null
        foreach ($ver in $versions) {
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
function Get-InjectionState($resources) {
    $asar = Join-Path $resources 'app.asar'
    $original = Join-Path $resources '_app.asar'

    if (-not (Test-Path -LiteralPath $original)) { return 'Vanilla' }

    $index = Join-Path $asar 'index.js'
    if (Test-Path -LiteralPath $index) {
        $content = [IO.File]::ReadAllText($index, [Text.Encoding]::UTF8)
        if ($content -like "*$PatcherName*") { return 'Nosso' }
    }
    return 'OutroMod'
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

function Install-Patcher {
    $source = Join-Path $PSScriptRoot $PatcherName
    if (-not (Test-Path -LiteralPath $source)) {
        throw "Nao achei $PatcherName ao lado deste script."
    }

    if (-not (Test-Path -LiteralPath $InstallDir)) { New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null }
    Copy-Item -LiteralPath $source -Destination (Join-Path $InstallDir $PatcherName) -Force
    Write-Ok "Bypass copiado para $InstallDir"

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
        $archive = Join-Path $env:TEMP $TorArchiveName
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
        $command = "`"$TorExe`" -f `"$TorTorrc`""
        New-Item -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Force | Out-Null
        Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'GoLiveBypassTor' -Value $command
        Write-Ok 'Tor registrado para subir no proximo logon (GoLiveBypassTor).'
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
    $asar = Join-Path $resources 'app.asar'
    $original = Join-Path $resources '_app.asar'
    $patcher = Join-Path $InstallDir $PatcherName

    Rename-Item -LiteralPath $asar -NewName '_app.asar' -Force
    try {
        New-Item -ItemType Directory -Path $asar -Force | Out-Null
        [IO.File]::WriteAllText((Join-Path $asar 'package.json'), $StubPackage, (New-Object Text.UTF8Encoding $false))
        [IO.File]::WriteAllText((Join-Path $asar 'index.js'), "require($($patcher | ConvertTo-Json));", (New-Object Text.UTF8Encoding $false))
    } catch {
        # Sem o desfazer, uma falha aqui deixaria o Discord sem app.asar nenhum: ele nao abriria
        # mais, e o usuario nao teria como saber o porque.
        if (Test-Path -LiteralPath $asar) { Remove-Item -LiteralPath $asar -Recurse -Force -ErrorAction SilentlyContinue }
        Rename-Item -LiteralPath $original -NewName 'app.asar' -Force
        throw
    }
}

function Remove-Injection($resources) {
    $asar = Join-Path $resources 'app.asar'
    $original = Join-Path $resources '_app.asar'

    if (-not (Test-Path -LiteralPath $original)) { return $false }

    if (Test-Path -LiteralPath $asar) { Remove-Item -LiteralPath $asar -Recurse -Force }
    Rename-Item -LiteralPath $original -NewName 'app.asar' -Force
    return $true
}

function Show-Status {
    $installs = Get-DiscordResources
    if (-not $installs) { Write-Bad 'Nao achei nenhum Discord instalado.'; return }

    foreach ($install in $installs) {
        $state = Get-InjectionState $install.Resources
        $label = switch ($state) {
            'Vanilla'  { 'sem nada instalado' }
            'Nosso'    { 'com o GoLiveBypass standalone' }
            'OutroMod' { 'com Equicord/Vencord (ou outro mod)' }
        }
        Write-Host "  $($install.Flavour): $label" -ForegroundColor White
        Write-Host "    $($install.Resources)" -ForegroundColor DarkGray
    }

    $log = Join-Path $InstallDir 'golivebypass.log'
    if (Test-Path -LiteralPath $log) {
        Write-Host ''
        Write-Host '  ultimas linhas do registro:' -ForegroundColor White
        Get-Content -LiteralPath $log -Tail 12 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
    }
}

Write-Host ''
Write-Host '  GoLiveBypass standalone' -ForegroundColor Magenta
Write-Host '  Go Live e camera de volta, direto no Discord' -ForegroundColor DarkGray
Write-Host ''

if ($Mode -eq 'Status') { Show-Status; return }

$installs = Get-DiscordResources
if (-not $installs) { Write-Bad 'Nao achei nenhum Discord instalado.'; return }

# corpo principal protegido: qualquer erro nao tratado vira report automatico
try {
# ---------------------------------------------------------------------------
# Modo interativo (TUI): rodando sem -Mode Uninstall/Status, sem flags de proxy/tor
# e com TTY, mostra um menu estilo OpenCode e deixa escolher a rede. Com -Yes ou
# sem TTY, o fluxo continua por flags (comportamento atual).
if ($Mode -eq 'Install' -and (Test-TuiInteractive)) {
    $tuiChoice = Tui-Menu 'GoLiveBypass standalone' @(
        'Instalar / atualizar o bypass',
        'Ver status',
        'Desinstalar',
        'Sair'
    )
    switch ($tuiChoice) {
        2 {
            Show-Status
            return
        }
        3 {
            $Mode = 'Uninstall'
        }
        0 { Write-Host '  Ate mais.' -ForegroundColor DarkGray; return }
        default {
            # Instalar: pede a rede antes de prosseguir.
            $tuiNet = Tui-Menu 'Como o bypass vai sair?' @(
                'Tor automatico (recomendado, baixa e sobe sozinho)',
                'Proxy gratuita (escolhida e testada sozinha)',
                'Proxy minha (socks5://host:porta)'
            )
            if ($tuiNet -eq 1) { $Tor = $true }
            elseif ($tuiNet -eq 3) { $Proxy = (Tui-Input 'Endereco da proxy').Trim() }
        }
    }
}

if ($Mode -eq 'Uninstall') {
    Stop-Discord
    foreach ($install in $installs) {
        if ((Get-InjectionState $install.Resources) -ne 'Nosso') {
            Write-Warn "$($install.Flavour) nao tem o standalone, deixando como esta."
            continue
        }
        if (Remove-Injection $install.Resources) { Write-Ok "$($install.Flavour) voltou ao normal." }
    }
    Remove-Tor
    Write-Host ''
    Write-Host "  A pasta $InstallDir ficou, com o registro e a sua configuracao." -ForegroundColor DarkGray
    return
}

foreach ($install in $installs) {
    $state = Get-InjectionState $install.Resources
    Write-Host "  $($install.Flavour): $state" -ForegroundColor White

    if ($state -eq 'OutroMod') {
        Write-Warn 'Este Discord ja tem Equicord ou Vencord injetado.'
        Write-Host '      O standalone ocupa o mesmo lugar, entao instalar aqui desliga o outro mod.' -ForegroundColor DarkGray
        Write-Host '      Se voce usa Equicord ou Vencord, prefira o plugin: ele convive com o resto.' -ForegroundColor DarkGray
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

    Install-Patcher
    Stop-Discord

    if ($state -eq 'OutroMod') { Remove-Injection $install.Resources | Out-Null }
    if ((Get-InjectionState $install.Resources) -eq 'Nosso') {
        Write-Ok "$($install.Flavour) ja estava injetado, so atualizei o bypass."
        continue
    }

    Install-Injection $install.Resources
    Write-Ok "$($install.Flavour) pronto."
}

Write-Host ''
Write-Host '  Abra o Discord. O Go Live deve voltar sozinho.' -ForegroundColor Green
Write-Host "  Se algo der errado, o registro fica em $(Join-Path $InstallDir 'golivebypass.log')" -ForegroundColor DarkGray
Write-Host '  Para desfazer: .\GoLiveBypass-Standalone.ps1 -Mode Uninstall' -ForegroundColor DarkGray
Write-Host ''
} catch {
    Write-Host ''
    Write-Bad "Erro: $($_.Exception.Message)"
    Invoke-AutoBugReport 'Falha no GoLiveBypass standalone' $_.Exception.Message
}
