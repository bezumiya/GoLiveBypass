<#
    GoLiveBypass - instalador automatico

    Encontra sozinho o Equicord ou o Vencord que voce tem, instala o plugin, compila e
    injeta. Se voce nao tiver nenhum dos dois, pergunta qual quer e instala junto.

    Uso:
      .\GoLiveBypass-Installer.ps1
      .\GoLiveBypass-Installer.ps1 -Source "C:\caminho\do\Equicord"
      .\GoLiveBypass-Installer.ps1 -PluginSource "C:\caminho\do\GoLiveBypass\goLiveBypass"
      .\GoLiveBypass-Installer.ps1 -Mod Equicord -Yes
      .\GoLiveBypass-Installer.ps1 -Mode Uninstall
      .\GoLiveBypass-Installer.ps1 -Mode CheckUpdate   # so consulta o GitHub, nao mexe
      .\GoLiveBypass-Installer.ps1 -Mode Update        # aplica update se houver

    Obrigado ao Vithor (https://github.com/Vith0r), que escreveu o primeiro instalador do
    GoLiveBypass e abriu o caminho para este aqui.
#>

[CmdletBinding()]
param(
    [ValidateSet('Menu', 'Install', 'Uninstall', 'Restore', 'CheckUpdate', 'Update')]
    [string] $Mode = 'Menu',

    [ValidateSet('Equicord', 'Vencord')]
    [string] $Mod = '',

    [string] $Source = '',

    # Instala o plugin de uma pasta local em vez de baixar do GitHub. Serve para testar uma
    # mudanca antes de publicar: sem isto o instalador sempre traz o que esta no repositorio,
    # e um teste feito assim mede a versao errada sem avisar.
    [string] $PluginSource = '',

    [switch] $Yes
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# Libera a execucao so para este processo. Em maquina com politica de dominio isso pode ser
# recusado, e nesse caso nao ha o que fazer aqui: o proprio .bat ja abre com -ExecutionPolicy Bypass.
try { Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force } catch { }

$RepoRaw = 'https://raw.githubusercontent.com/bezumiya/GoLiveBypass/main'
$PluginFiles = @('goLiveBypass/index.tsx', 'goLiveBypass/native.ts', 'goLiveBypass/manifest.json')
$PluginDirName = 'goLiveBypass'
$DiscordNames = @('Discord', 'DiscordCanary', 'DiscordPTB')

# O caminho base tem que RESOLVER, nao apenas existir na variavel (mesmo raciocinio do
# standalone): perfil com nome acentuado/especial pode ter %LOCALAPPDATA% gravado na
# forma 8.3 curta (ex. C:\Users\CSAR~1\AppData\Local), que para de resolver quando a
# geracao de nomes curtos esta desligada no Windows (#94: "Nao existe um objeto no
# caminho especificado C:\Users\CSAR~1"). A cadeia cai para o GetFolderPath (caminho
# longo canonico) e por ultimo monta a partir do USERPROFILE.
function Get-EffectiveLocalApp {
    if ($env:LOCALAPPDATA -and (Test-Path -LiteralPath $env:LOCALAPPDATA)) { return $env:LOCALAPPDATA }
    try {
        $shell = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
        if ($shell -and (Test-Path -LiteralPath $shell)) { return $shell }
    } catch { }
    if ($env:USERPROFILE) { return (Join-Path $env:USERPROFILE 'AppData\Local') }
    return $env:LOCALAPPDATA
}

$Mods = @{
    Equicord = @{ Git = 'https://github.com/Equicord/Equicord'; Label = 'Equicord'; Note = 'recomendado, inclui tudo do Vencord e mais plugins' }
    Vencord  = @{ Git = 'https://github.com/Vendicated/Vencord'; Label = 'Vencord'; Note = 'o original, mais enxuto' }
}

# Tor embutido: mesma versao e mesmos hashes da GUI (golive-gui/electron/main.ts), para os
# instaladores de linha de comando entregarem exatamente o mesmo daemon que ela usa. A porta
# dedicada 9060 evita conflito com um Tor do sistema (9050) ou do Tor Browser (9150).
$TorBundle = '13.5'
$TorPort = 9060
$TorUrls = @{
    'tor-expert-bundle-windows-x86_64-13.5.tar.gz' = @{
        Url = 'https://archive.torproject.org/tor-package-archive/torbrowser/13.5/tor-expert-bundle-windows-x86_64-13.5.tar.gz'
        Sha256 = '5978ccc2a7fed783c329474888e87f5e6349aa132d9c43016418bff296c7becb'
    }
}

function Write-Step($text) { Write-Host "  [*] $text" -ForegroundColor DarkGray }
function Write-Ok($text) { Write-Host "  [OK] $text" -ForegroundColor Green }
function Write-Warn($text) { Write-Host "  [!] $text" -ForegroundColor Yellow }
function Write-Err($text) { Write-Host "  [X] $text" -ForegroundColor Red }

function Show-Banner {
    Write-Host ''
    Write-Host '  GoLiveBypass' -ForegroundColor Cyan
    Write-Host '  Go Live e camera de volta no Discord' -ForegroundColor DarkGray
    Write-Host '  https://github.com/bezumiya/GoLiveBypass' -ForegroundColor DarkGray
    Write-Host ''
}

function Confirm-Action($question) {
    if ($Yes) { return $true }
    return (Read-Host "  $question [s/N]") -match '^[sSyY]'
}

# =========================================================================== Report de bugs
# Igual a GUI: ao falhar, monta diagnostico sanitizado e POST na API de bugs
# (abre issue no bezumiya/GoLiveBypass). Nunca bloqueia o fluxo.

$script:BugApiUrl = 'https://api.skyplaceia.com/bugs/v1/reports'
$script:BugApiToken = 'c3d0bff691ecc3ddc6f6ca10037b9ac967c62547e681d3749204e50800504511'

function Invoke-BugReport([string]$title, [string]$description, [string]$log = '', [hashtable]$meta = @{}) {
    if ($Yes) { return }  # automacao: nao spammar a API
    $desc = Invoke-SanitizeBug $description
    # Mesma forma do payload da GUI (golive-gui/electron/bugreport.ts): {title,
    # description, log, meta}. O formato antigo (includeLogs) nunca foi lido pela
    # API -- os reports do instalador/standalone chegavam no GitHub com log e
    # metadata vazios (ex.: issue #94).
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
    # proxy personalizada digitada na instalacao (nunca sai)
    if ($script:UltimaProxy) { $text = $text.Replace($script:UltimaProxy, '<proxy-pessoal>') }
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
    $meta = @{
        versao                = 'instalador'
        plataforma            = "win32-$env:PROCESSOR_ARCHITECTURE"
        locale                = "$(if ($PSUICulture -and $PSUICulture.Name) { $PSUICulture.Name } else { '?' })"
        localappdata_presente = "$(if ($env:LOCALAPPDATA) { 'sim' } else { 'nao' })"
        caminho_8_3           = "$(if ($short) { 'sim' } else { 'nao' })"
    }
    if ($ErrorRecord -and $ErrorRecord.Exception) {
        $meta['excecao'] = $ErrorRecord.Exception.GetType().FullName
    }
    return $meta
}

function Invoke-SendAutoReport([string]$summary, [string]$extra = '', $ErrorRecord = $null) {
    if ($Yes) { return }
    $desc = "$extra`n`n--- logs ---`n"
    $tail = ''
    try {
        $logDir = Join-Path (Get-EffectiveLocalApp) 'GoLiveBypass'
        foreach ($log in @('golivebypass.log', 'gui.log')) {
            $lp = Join-Path $logDir $log
            if (Test-Path -LiteralPath $lp) {
                $tail += (Get-Content -LiteralPath $lp -Tail 40 -ErrorAction SilentlyContinue | Out-String)
            }
        }
    } catch { }
    if ($ErrorRecord -and $ErrorRecord.Exception) {
        $frame = ''
        try {
            $st = $ErrorRecord.Exception.StackTrace
            if ($st) { $frame = (($st -split "`n") | Select-Object -First 1).Trim() }
        } catch { }
        $desc += "`n`nexcecao: " + $ErrorRecord.Exception.GetType().FullName
        if ($frame) { $desc += "`nframe: " + $frame }
    }
    Invoke-BugReport $summary $desc $tail (Get-ReportMeta $ErrorRecord)
}

# Test-ShouldReport <mensagem>: $false se a mensagem NAO deve abrir issue.
# Mesmo espelho do should_report() do .sh: erros de uso (dependencia faltando,
# CLI digitada errada, path errado, ferramenta externa quebrada) nao viram
# issue. O resto (bug real) continua reportando.
function Test-ShouldReport([string]$msg) {
    # cancelamento e instrucoes de uso
    if ($msg -eq 'Cancelado.') { return $false }
    # Cancelamento via Ctrl+C no Read-Host: PowerShell lanca a mensagem nativa
    # "Esse comando nao pode ser executado devido ao erro: A operacao foi cancelada
    # pelo usuario." (PT-BR) / "This command cannot be executed ... The operation
    # was canceled by the user." (EN). E cancelamento do usuario, nao bug.
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
# Interface no estilo OpenCode: dark, caixas, setas/Enter. Mouse: o console do Windows
# nao expoe cliques de forma confiavel por aqui; a navegacao e por teclado (up/down/Enter/Esc/j/k)
# e o mouse SGR fica como melhoria futura. Sem TTY (pipe) ou com -Yes, cai para os menus atuais.

# Diz se o console suporta ANSI (modo VT). O conhost classico do Windows (cmd rodando o
# powershell.exe) NAO interpreta escapes por padrao: a TUI apareceria cheia de "[48;5;235m".
# Tentamos habilitar o modo VT via P/Invoke; se der certo, ANSI funciona (Windows Terminal,
# VS Code, conhost com VT ativo). Se nao der, a TUI cai para os menus [1]/[2]/[3] simples.
function Test-TuiAnsi {
    try {
        # GetStdHandle(-11) = stdout; o modo VT e um bit (0x0004).
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
        # Venv: 0x0004 = ENABLE_VIRTUAL_TERMINAL_PROCESSING
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
    # Sem ANSI de verdade (conhost classico) os escapes quebram a tela: cai para os menus
    # [1]/[2]/[3] atuais, que funcionam em qualquer console.
    return (Test-TuiAnsi)
}

function Tui-Color($fg, $bg) { "$([char]27)[$fg$([char]27)[$bg" }  # acento/reset via ANSI

# Pequena paleta da TUI (sempre ANSI; o console padrao do Windows suporta no WT/PowerShell 7).
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
    # Na janela do Windows (powershell.exe), [Console]::ReadKey($true) captura setas e Enter.
    # Drenar o buffer antes: SSH/conhost costuma injetar um Enter espúrio no início da
    # sessão que faria o TUI pular direto o primeiro item. Aqui limpamos tudo que estiver
    # enfileirado e lemos só a próxima tecla "real" do usuário.
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

function Tui-Box([string]$title, [string[]]$lines) {
    $w = 62
    $top = '─' * ($w - 8)
    $bottom = '─' * ($w - 2)
    Write-Host "$($script:TuiBg)$($script:TuiRset)┌─ $($script:TuiAccent)$title$($script:TuiRset) ─$($script:TuiDim)$top$($script:TuiRset)" -NoNewline
    Write-Host ''
    foreach ($txt in $lines) {
        $pad = ' ' * [Math]::Max(0, ($w - 4 - $txt.Length))
        Write-Host "$($script:TuiBg)$($script:TuiRset)│ $txt$pad │$($script:TuiRset)" -NoNewline
        Write-Host ''
    }
    Write-Host "$($script:TuiBg)$($script:TuiRset)└$bottom┘$($script:TuiRset)" -NoNewline
    Write-Host ''
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

function Tui-Progress([string]$msg) { Write-Host "$($script:TuiBg)$([char]27)[2K`r$($script:TuiAccent)[*]$($script:TuiRset) $msg" -NoNewline }
function Tui-Done { Write-Host "$($script:TuiBg)$([char]27)[2K`r$($script:TuiOk)[OK]$($script:TuiRset)" }

# =========================================================================== /TUI

function Save-Text($path, $text) {
    if (-not $path) { return }
    $dir = Split-Path -Parent $path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    [IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))
}

function Get-RepoFile($relativePath) {
    if ($PSScriptRoot) {
        $parent = Split-Path -Parent $PSScriptRoot
        if ($parent) {
            $local = Join-Path $parent ($relativePath -replace '/', '\')
            if (Test-Path -LiteralPath $local) { return [IO.File]::ReadAllText($local) }
        }
    }

    try {
        return (Invoke-WebRequest -UseBasicParsing -Uri "$RepoRaw/$relativePath").Content
    } catch {
        throw "Nao consegui baixar $relativePath. Verifique sua conexao."
    }
}

function Test-Tool($name) {
    return [bool] (Get-Command $name -ErrorAction SilentlyContinue)
}

# O endereco da proxy pode carregar usuario e senha, e ele e mostrado na tela e em resumo de
# instalacao. A senha some daqui.
function Hide-ProxySecret($proxy) {
    if ($proxy -match '^([a-z0-9]+)://(?:([^:@]+)(?::[^@]*)?@)?(.+)$') {
        $user = if ($matches[2]) { "$($matches[2]):***@" } else { '' }
        return "$($matches[1])://$user$($matches[3])"
    }
    return $proxy
}

# O corepack cria o atalho do pnpm antes de saber que versao usar. Na primeira execucao ele
# busca essa versao no registro do npm e confere a assinatura com chaves embutidas nele; as
# chaves do corepack que vem no Node 22 estao velhas, entao o atalho existe e mesmo assim
# quebra com "Cannot find matching keyid". So testar se o comando existe nao prova nada.
$script:PnpmVersion = ''

function Test-Pnpm {
    if (-not (Test-Tool 'pnpm')) { return $false }

    # Um atalho do corepack existe mesmo quando nao funciona, entao a unica prova que vale e
    # executar. O 2>$null evita assustar quem so vai ver a instalacao seguir depois.
    # A saida e capturada inteira antes de olhar o codigo. Filtrar com Select-Object no meio do
    # cano interrompe o comando por cima, e o codigo de saida deixa de valer: um pnpm que
    # funciona era reprovado.
    # O atalho do corepack pode nao so falhar como EXPLODIR: a pergunta "Corepack is about to
    # download" sem resposta vira erro terminante por causa do ErrorActionPreference=Stop daqui.
    # Sem o try/catch a excecao escapava do probe e derrubava o instalador inteiro, em vez de
    # cair no npm install -g. Relato real: o instalador morria apontando a linha 16 do shim.
    try { $found = & pnpm --version 2>$null } catch { return $false }
    if ($LASTEXITCODE -ne 0) { return $false }

    $script:PnpmVersion = ($found | Select-Object -First 1)
    return $true
}

function Update-PathFromEnvironment {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = @($machine, $user | Where-Object { $_ }) -join ';'
}

function Test-ModCheckout($path) {
    if (-not $path) { return $false }
    if (-not (Test-Path -LiteralPath (Join-Path $path 'package.json'))) { return $false }
    return Test-Path -LiteralPath (Join-Path $path 'src\utils\types.ts')
}

function Test-DiscordResourcesReady($resources) {
    if (-not $resources) { return $false }
    $asar = Join-Path $resources 'app.asar'
    $original = Join-Path $resources '_app.asar'
    return (Test-Path -LiteralPath $asar) -or (Test-Path -LiteralPath $original)
}

function Get-DiscordResources {
    $found = @()
    $localApp = Get-EffectiveLocalApp
    if (-not $localApp) { return $found }
    foreach ($name in $DiscordNames) {
        $root = Join-Path $localApp $name
        if (-not (Test-Path -LiteralPath $root)) { continue }

        $apps = Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match '^app-[0-9]' } |
            Sort-Object -Descending -Property @{ Expression = {
                try { [version]($_.Name -replace '^app-', '') } catch { [version]'0.0.0' }
            } }

        foreach ($app in $apps) {
            if (-not $app -or -not $app.FullName) { continue }
            $resources = Join-Path $app.FullName 'resources'
            if (Test-DiscordResourcesReady $resources) {
                $found += $resources
            }
        }
    }
    return $found
}

function Get-InjectedPath($resources) {
    # O instalador do Equicord e o do Vencord trocam o app.asar por um stub cujo index.js so
    # faz require da pasta de build. Numa instalacao a partir do fonte esse require aponta
    # direto para <checkout>\dist\desktop, que e a forma mais confiavel de achar o checkout.
    if (-not $resources) { return $null }
    $candidates = @()

    $stub = Join-Path $resources 'app.asar'
    if (Test-Path -LiteralPath $stub) {
        $item = Get-Item -LiteralPath $stub
        # app.asar pode ser uma pasta; nesse caso .Length devolve 1 e nao o tamanho do arquivo.
        # E a leitura precisa ser UTF-8: em ASCII um caminho com acento vira "Jo??o".
        if ($item -is [IO.FileInfo] -and $item.Length -lt 65536) {
            $candidates += [IO.File]::ReadAllText($stub)
        }
    }

    $index = Join-Path $resources 'app\index.js'
    if (Test-Path -LiteralPath $index) {
        $candidates += Get-Content -LiteralPath $index -Raw -ErrorAction SilentlyContinue
    }

    foreach ($text in $candidates) {
        if (-not $text) { continue }
        $match = [regex]::Match($text, 'require\("(.+?)"\)')
        if ($match.Success) { return $match.Groups[1].Value -replace '\\\\', '\' }
    }

    return $null
}

function Get-InstalledMod {
    foreach ($resources in Get-DiscordResources) {
        $injected = Get-InjectedPath $resources
        if (-not $injected) { continue }
        if ($injected -match 'equibop') { return 'Equibop' }
        if ($injected -match 'equicord') { return 'Equicord' }
        if ($injected -match 'vesktop') { return 'Vesktop' }
        if ($injected -match 'vencord') { return 'Vencord' }
    }
    return $null
}

function Find-CheckoutFromInjection {
    foreach ($resources in Get-DiscordResources) {
        $injected = Get-InjectedPath $resources
        if (-not $injected) { continue }

        # <checkout>\dist\desktop -> <checkout>
        $parent1 = Split-Path -Parent $injected
        if (-not $parent1) { continue }
        $root = Split-Path -Parent $parent1
        if ($root -and (Test-ModCheckout $root)) { return $root }
    }
    return $null
}

function Find-CheckoutOnDisk {
    if (-not $env:USERPROFILE) { return $null }
    $roots = @($env:USERPROFILE)
    foreach ($sub in @('Documents', 'Desktop', 'Downloads', 'dev', 'repos', 'projects', 'git', 'source', 'source\repos')) {
        $roots += (Join-Path $env:USERPROFILE $sub)
    }
    foreach ($drive in (Get-PSDrive -PSProvider FileSystem -ErrorAction SilentlyContinue)) {
        if ($drive.Root -and $drive.Root -match '^[A-Za-z]:\\$') { $roots += $drive.Root }
    }

    $seen = @{}
    foreach ($root in $roots) {
        if (-not $root -or $seen.ContainsKey($root) -or -not (Test-Path -LiteralPath $root)) { continue }
        $seen[$root] = $true

        $candidates = Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match '^(Equicord|Vencord)$' }

        foreach ($dir in $candidates) {
            if ($dir -and $dir.FullName -and (Test-ModCheckout $dir.FullName)) { return $dir.FullName }
        }
    }

    Write-Step 'Procurando um pouco mais fundo no seu perfil'
    $deep = Get-ChildItem -LiteralPath $env:USERPROFILE -Directory -Recurse -Depth 3 -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^(Equicord|Vencord)$' } |
        Select-Object -First 20

    foreach ($dir in $deep) {
        if ($dir -and $dir.FullName -and (Test-ModCheckout $dir.FullName)) { return $dir.FullName }
    }

    return $null
}

function Find-Checkout {
    if ($Source) {
        if (Test-ModCheckout $Source) { return $Source }
        throw "Nao encontrei um checkout do Equicord ou Vencord em $Source"
    }

    $root = Find-CheckoutFromInjection
    if ($root) {
        Write-Ok "Achei pelo Discord: $root"
        return $root
    }

    $root = Find-CheckoutOnDisk
    if ($root) {
        Write-Ok "Achei no disco: $root"
        return $root
    }

    return $null
}

function Test-InjectedFromCheckout($root) {
    if (-not $root) { return $false }
    foreach ($resources in Get-DiscordResources) {
        $injected = Get-InjectedPath $resources
        if ($injected -and $injected.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    }
    return $false
}

# Clientes paralelos no Windows (Vesktop/Equibop/Legcord): mesmo padrao
# electron-builder do Discord. O instalador de mod deles nao reconhece esses
# clientes (recebem copia do dist\<cliente>.asar), os oficiais recebem pnpm
# inject --location.
$ParallelNames = @('Vesktop', 'Equibop', 'Legcord')

function Get-PatchTargets {
    # Oficiais + paralelos num formato so (Flavour|Resources|Tipo): 'O' recebe
    # pnpm inject --location, 'P' recebe a copia do asar do mod.
    $targets = @()
    foreach ($install in (Get-DiscordResources)) {
        $targets += [pscustomobject]@{ Flavour = $install.Flavour; Resources = $install.Resources; Tipo = 'O' }
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
                    $targets += [pscustomobject]@{ Flavour = $name; Resources = $candidate; Tipo = 'P' }
                    break
                }
            }
        }
    }
    return $targets
}

function Select-InjectionTargets($targets) {
    # 1 alvo: sem pergunta (como antes). -Yes: todos os oficiais (paralelos so
    # quando nao existe oficial — comportamento de antes do seletor). Com TTY e
    # mais de um: multi-select - um, varios ou todos; Esc cancela.
    if (-not $targets -or @($targets).Count -le 1) { return $targets }
    if ($Yes -or -not (Test-TuiInteractive)) {
        $oficiais = @($targets | Where-Object { $_.Tipo -eq 'O' })
        if ($oficiais.Count -gt 0) { return $oficiais }
        return $targets
    }
    $labels = foreach ($t in $targets) {
        $suf = if ($t.Tipo -eq 'P') { ' (cliente paralelo)' } else { '' }
        "$($t.Flavour)$suf"
    }
    $escolha = Tui-MenuMulti 'Quais Discords recebem o plugin?' $labels
    if (-not $escolha) { throw 'Cancelado.' }
    $escolhidos = @()
    foreach ($i in $escolha) { $escolhidos += $targets[$i - 1] }
    return $escolhidos
}

function Copy-PatchParallel($root, $resources) {
    # Patch direto em cliente paralelo: o build do mod gera dist\<cliente>.asar;
    # copia sobre o app.asar do cliente, com backup _app.asar (idempotente).
    $nome = $null; $asar = $null
    switch -Regex ($resources) {
        '(?i)equibop' { $nome = 'Equibop'; $asar = Join-Path $root 'dist\equibop.asar' }
        '(?i)vesktop' { $nome = 'Vesktop'; $asar = Join-Path $root 'dist\vesktop.asar' }
        '(?i)legcord' { $nome = 'Legcord'; $asar = Join-Path $root 'dist\legcord.asar' }
        default { Write-Warn "Cliente paralelo desconhecido: $resources"; return $false }
    }
    if (-not (Test-Path -LiteralPath $asar)) {
        Write-Warn "O build nao gerou $asar. Rode 'pnpm build' no checkout e tente de novo."
        return $false
    }
    $appAsar = Join-Path $resources 'app.asar'
    $backup = Join-Path $resources '_app.asar'
    if (-not (Test-Path -LiteralPath $backup) -and (Test-Path -LiteralPath $appAsar)) {
        Copy-Item -LiteralPath $appAsar -Destination $backup
        Write-Ok "Backup criado em $backup"
    }
    Copy-Item -LiteralPath $asar -Destination $appAsar -Force
    Write-Ok "$nome patcheado: $appAsar"
    return $true
}

function Show-ModChoice {
    if ($Mod) { return $Mod }

    $installed = Get-InstalledMod

    if (Test-TuiInteractive) {
        $tui = Tui-Menu 'Qual mod instalar?' @("Equicord — $($Mods.Equicord.Note)", "Vencord — $($Mods.Vencord.Note)")
        switch ($tui) {
            1 { return 'Equicord' }
            2 { return 'Vencord' }
            default { throw 'Cancelado.' }
        }
    }

    Write-Host ''
    if ($installed) {
        Write-Warn "Voce tem o $installed instalado, mas nao achei o codigo fonte dele."
        Write-Host '  Plugins de usuario so existem compilando do fonte, entao preciso baixar o repositorio.' -ForegroundColor DarkGray
    } else {
        Write-Warn 'Nao encontrei Equicord nem Vencord no seu computador.'
        Write-Host '  Posso baixar e instalar um dos dois junto com o plugin.' -ForegroundColor DarkGray
    }

    Write-Host ''
    Write-Host '  Qual voce quer instalar?' -ForegroundColor White
    Write-Host ''
    Write-Host "    [1] Equicord    $($Mods.Equicord.Note)" -ForegroundColor Green
    Write-Host "    [2] Vencord     $($Mods.Vencord.Note)" -ForegroundColor Cyan
    Write-Host '    [0] Cancelar' -ForegroundColor Gray
    Write-Host ''

    switch (Read-Host '  Escolha') {
        '1' { return 'Equicord' }
        '2' { return 'Vencord' }
        default { throw 'Cancelado.' }
    }
}

function Install-Pnpm {
    # O corepack vem ligado no Node 22 e cria um atalho do pnpm que quebra na primeira
    # execucao: as chaves de assinatura embutidas estao velhas ("Cannot find matching
    # keyid") ou ele pergunta "Corepack is about to download..." e, sem quem responder,
    # derruba o instalador. Desligar o corepack tira esse atalho do caminho; quem ja tiver
    # o pnpm de verdade instalado passa a ser encontrado de novo.
    # "disable pnpm", e nao "disable" seco: o segundo leva o atalho do yarn junto, e o yarn
    # nao e nosso para desligar. Esta funcao so roda com o pnpm ja reprovado no Test-Pnpm,
    # entao quem tem um corepack que funciona nunca passa por aqui.
    if (Test-Tool 'corepack') {
        Write-Step 'Desligando o atalho quebrado do pnpm no corepack'
        & corepack disable pnpm 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) { Update-PathFromEnvironment }
    }

    if (Test-Pnpm) { return }

    Write-Step 'Instalando o pnpm pelo npm'
    & npm install -g pnpm | Out-Host

    if ($LASTEXITCODE -eq 0) {
        Update-PathFromEnvironment
        if (Test-Pnpm) { return }
    }

    # O npm global mora na pasta do Node; com o Node instalado em "Arquivos de Programas"
    # (o instalador padrao do site), escrever ali exige admin e o npm falha com EPERM.
    # Num prefixo dentro do perfil o npm escreve sem admin, e o pnpm entra no PATH desta
    # sessao e fica registrado no PATH do usuario para as proximas.
    Write-Step 'O npm nao conseguiu escrever na pasta global; instalando num prefixo do seu perfil'
    $pnpmHome = Join-Path $env:LOCALAPPDATA 'pnpm-global'
    & npm install -g --prefix $pnpmHome pnpm | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw 'O npm nao conseguiu instalar o pnpm. Rode "npm install -g pnpm" num terminal como administrador e tente de novo.'
    }

    $env:Path = "$pnpmHome;$env:Path"
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ($userPath -notlike "*$pnpmHome*") {
        [Environment]::SetEnvironmentVariable('Path', "$pnpmHome;$userPath", 'User')
    }

    if (-not (Test-Pnpm)) {
        # Ultimo recurso, e o mais robusto: o instalador oficial baixa o binario standalone
        # do pnpm (que nem precisa do Node instalado) para %LOCALAPPDATA%\pnpm, sem admin
        # e sem depender do npm. O instalador pode ser 5.1 (sem verificacao de assinatura)
        # e ainda assim valida o checksum por baixo.
        Write-Step 'Baixando o pnpm do site oficial (pasta do usuario, sem admin)'
        $installer = Join-Path $env:TEMP 'install-pnpm.ps1'
        try {
            Invoke-WebRequest -UseBasicParsing -Uri 'https://get.pnpm.io/install.ps1' -OutFile $installer
            & powershell -NoProfile -ExecutionPolicy Bypass -File $installer 2>&1 | Out-Host
        } catch {
            Write-Step 'O download do site oficial falhou; seguindo para a checagem final.'
        }
        Update-PathFromEnvironment
        # O setup do pnpm grava o PATH do usuario; no caso de nao ter gravado, os dois
        # caminhos possiveis (com e sem \bin) entram aqui na sessao.
        $pnpmHome = Join-Path $env:LOCALAPPDATA 'pnpm'
        $env:Path = "$pnpmHome\bin;$pnpmHome;$env:Path"
    }

    if (-not (Test-Pnpm)) {
        throw 'Nao consegui deixar o pnpm funcionando. Abra um terminal e rode: npm install -g pnpm'
    }
}

function Install-Toolchain($needGit) {
    $missing = @()
    if ($needGit -and -not (Test-Tool 'git')) { $missing += 'git' }
    if (-not (Test-Tool 'node')) { $missing += 'node' }

    if ($missing.Count -gt 0) {
        Write-Warn "Faltando no seu PATH: $($missing -join ', ')"

        if (-not (Test-Tool 'winget')) {
            throw "Instale $($missing -join ' e ') manualmente e rode de novo."
        }

        if (-not (Confirm-Action 'Instalar agora com o winget?')) {
            throw "Instale $($missing -join ' e ') e rode de novo."
        }

        foreach ($tool in $missing) {
            $id = if ($tool -eq 'git') { 'Git.Git' } else { 'OpenJS.NodeJS.LTS' }
            Write-Step "winget install $id"
            & winget install --id $id --accept-source-agreements --accept-package-agreements --silent | Out-Host
        }

        Write-Host ''
        Write-Warn 'Feche este terminal, abra outro e rode o instalador de novo para o PATH atualizar.'
        exit 0
    }

    if (-not (Test-Pnpm)) { Install-Pnpm }

    Write-Ok "pnpm $script:PnpmVersion"
}

function Install-Mod($choice) {
    $info = $Mods[$choice]
    $target = Join-Path $env:USERPROFILE $info.Label

    Write-Host ''
    Write-Host '  Vou fazer:' -ForegroundColor White
    Write-Host "    1. Baixar o $($info.Label) em $target" -ForegroundColor DarkGray
    Write-Host '    2. Instalar as dependencias' -ForegroundColor DarkGray
    Write-Host '    3. Compilar junto com o GoLiveBypass' -ForegroundColor DarkGray
    Write-Host '    4. Injetar no Discord (o Discord vai fechar)' -ForegroundColor DarkGray
    Write-Host ''
    if (-not (Confirm-Action 'Pode seguir?')) { throw 'Cancelado.' }

    Install-Toolchain $true

    if (Test-Path -LiteralPath $target) {
        if (-not (Test-ModCheckout $target)) {
            throw "$target ja existe e nao parece um checkout. Apague a pasta ou use -Source."
        }
        Write-Step "Ja existe um checkout em $target, reaproveitando"
        return $target
    }

    Write-Step "git clone $($info.Git)"
    & git clone --depth 1 $info.Git $target | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'git clone falhou' }

    return $target
}

function Stop-Discord {
    if (-not (Get-Process -Name $DiscordNames -ErrorAction SilentlyContinue)) { return }

    Write-Step 'Fechando o Discord'
    Get-Process -Name $DiscordNames -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Milliseconds 300
        if (-not (Get-Process -Name $DiscordNames -ErrorAction SilentlyContinue)) { return }
    }

    throw 'O Discord nao fechou. Feche pelo icone na bandeja e rode de novo.'
}

function Copy-Plugin($root) {
    if (-not $root) { throw 'Caminho do checkout invalido para copiar o plugin.' }
    $target = Join-Path $root "src\userplugins\$PluginDirName"
    Write-Step "Instalando o plugin em $target"

    if (-not (Test-Path -LiteralPath $target)) { New-Item -ItemType Directory -Path $target -Force | Out-Null }

    # versoes antigas usavam index.ts; deixar os dois quebra o build
    $stale = Join-Path $target 'index.ts'
    if (Test-Path -LiteralPath $stale) { Remove-Item -LiteralPath $stale -Force }

    foreach ($file in $PluginFiles) {
        $leaf = Split-Path -Leaf $file
        if ($PluginSource -eq '') {
            Save-Text (Join-Path $target $leaf) (Get-RepoFile $file)
            continue
        }

        $local = Join-Path $PluginSource $leaf
        if (-not (Test-Path -LiteralPath $local)) { throw "Nao achei $leaf em $PluginSource." }
        Copy-Item -LiteralPath $local -Destination (Join-Path $target $leaf) -Force
    }

    if ($PluginSource -ne '') { Write-Warn "Plugin copiado de $PluginSource, e nao do GitHub." }
}

function Build-Mod($root) {
    if (-not $root) { throw 'Caminho do checkout invalido para compilar o mod.' }
    Push-Location -LiteralPath $root
    try {
        if (-not (Test-Path -LiteralPath (Join-Path $root 'node_modules'))) {
            Write-Step 'Instalando dependencias (na primeira vez demora alguns minutos)'
            & pnpm install
            if ($LASTEXITCODE -ne 0) { throw 'pnpm install falhou' }
        }

        Write-Step 'Compilando'
        & pnpm build
        if ($LASTEXITCODE -ne 0) { throw 'pnpm build falhou' }
    } finally {
        Pop-Location
    }
}

function Invoke-Injection($root, $targets) {
    if (-not $root) { throw 'Caminho do checkout invalido para injetar o mod.' }
    Push-Location -LiteralPath $root
    try {
        Stop-Discord
        $falha = $false
        foreach ($t in @($targets)) {
            if ($t.Tipo -eq 'P') {
                if (-not (Copy-PatchParallel $root $t.Resources)) { $falha = $true }
                continue
            }
            Write-Step "Injetando no $($t.Flavour)"
            # O --location espera a pasta de cima (a do app): e de la que o
            # instalador do mod descobre a instalacao (e o flatpak).
            $loc = Split-Path -Parent $t.Resources
            & pnpm run inject -- --location $loc
            if ($LASTEXITCODE -ne 0) {
                # Nem todo pnpm come o -- : cai no caminho de sempre (o instalador
                # do mod pergunta) — espelho do run_inject do .sh.
                & pnpm inject
                if ($LASTEXITCODE -ne 0) { $falha = $true }
            }
        }
        if ($falha) { throw 'Falha ao injetar em algum dos Discords escolhidos.' }
    } finally {
        Pop-Location
    }
}

function Start-Discord {
    foreach ($name in $DiscordNames) {
        $exe = Join-Path $env:LOCALAPPDATA "$name\Update.exe"
        if (Test-Path -LiteralPath $exe) {
            Start-Process -FilePath $exe -ArgumentList '--processStart', "$name.exe"
            return
        }
    }
}

function Invoke-Install($root) {
    $root = Select-Target $root

    # Um comando nativo escreve na saida da funcao que o chama, e Select-Target chama outras que
    # rodam npm e git. Se qualquer uma voltar a deixar escapar, $root chega como array e o
    # Test-Path quebra ao ligar um elemento vazio, com uma mensagem sobre parametro que nao diz
    # nada. Ficar com a ultima linha nao esconde erro: a checagem logo abaixo continua valendo.
    $root = @($root) | Where-Object { $_ } | Select-Object -Last 1

    # Sem esta checagem, um checkout que nao ficou pronto virava "nao e possivel associar o
    # argumento ao parametro Path", que nao diz nada a quem esta instalando.
    if (-not $root -or -not (Test-Path -LiteralPath $root)) {
        throw 'Nao consegui preparar a pasta do Equicord/Vencord. Rode de novo, ou use -Source "C:\caminho\do\Equicord" apontando para um checkout que voce ja tenha.'
    }
    $proxy = Select-Proxy
    $permanent = Select-Persistence

    Install-Toolchain $false
    Copy-Plugin $root
    Build-Mod $root

    $targets = @(Select-InjectionTargets @(Get-PatchTargets))
    $oficiais = @($targets | Where-Object { $_.Tipo -eq 'O' })
    $paralelos = @($targets | Where-Object { $_.Tipo -eq 'P' })

    # Ja injetado = TODOS os oficiais escolhidos ja apontam para este checkout.
    $oficialPendente = $false
    foreach ($t in $oficiais) {
        $inj = Get-InjectedPath $t.Resources
        if (-not $inj -or -not $inj.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { $oficialPendente = $true }
    }

    if ($oficialPendente -or $paralelos.Count -gt 0) {
        Invoke-Injection $root $targets
    } else {
        Write-Step 'O Discord ja carrega deste checkout, so reiniciando'
        Stop-Discord
    }

    # Com o Discord fechado: aberto, ele regrava o settings.json a partir da memoria e
    # apaga o que escrevemos aqui.
    Set-PluginSettings $root $proxy

    Start-Discord

    Write-Host ''
    Write-Ok 'Pronto. O plugin ja vem ativado, nao precisa mexer em nada.'
    if ($proxy) {
        # A senha nao aparece na tela: a pessoa costuma tirar print desta parte para mostrar que
        # deu certo.
        Write-Host "  Proxy: $(Hide-ProxySecret $proxy)" -ForegroundColor DarkGray
    } else {
        Write-Host '  Proxy: gratuita, escolhida e testada sozinha a cada abertura' -ForegroundColor DarkGray
    }
    Write-Host '  Entre numa call e use Go Live ou a camera.' -ForegroundColor DarkGray

    if (-not $permanent) {
        if ($weInjected) {
            Wait-DiscordExit $root
        } else {
            Write-Warn 'O Discord ja estava injetado antes de eu rodar, entao nao vou desfazer isso.'
            Write-Host '  Para remover depois: .\GoLiveBypass-Installer.ps1 -Mode Uninstall' -ForegroundColor DarkGray
        }
    }
}

function Invoke-Uninstall {
    $root = Find-Checkout
    if (-not $root) { throw 'Nao encontrei o checkout do Equicord/Vencord. Use -Source.' }

    $target = Join-Path $root "src\userplugins\$PluginDirName"
    if (Test-Path -LiteralPath $target) {
        Write-Step "Removendo $target"
        Remove-Item -LiteralPath $target -Recurse -Force
    } else {
        Write-Warn 'O plugin nao estava instalado nesse checkout.'
    }

    Remove-Tor
    Build-Mod $root
    Stop-Discord
    Start-Discord

    Write-Host ''
    Write-Ok 'Plugin removido. Seu Equicord/Vencord continua funcionando.'
}

# =============================================================================== interface

function Get-CheckoutMod($root) {
    # A identidade vem do package.json, nao do nome da pasta: quem baixou o ZIP tem o repo
    # numa pasta chamada Equicord-main, e ai o nome da pasta nao diz nada.
    $manifest = Join-Path $root 'package.json'
    if (Test-Path -LiteralPath $manifest) {
        try {
            $name = (Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json).name
            if ($name -match 'equicord') { return 'Equicord' }
            if ($name -match 'vencord') { return 'Vencord' }
        } catch { }
    }

    if ((Split-Path -Leaf $root) -match 'vencord') { return 'Vencord' }
    return 'Equicord'
}

function Get-ModSettingsFile($root) {
    # Mesma regra do proprio mod (src/main/utils/constants.ts):
    #   DATA_DIR = <MOD>_USER_DATA_DIR ?? %APPDATA%\<Mod>
    #   SETTINGS_FILE = DATA_DIR\settings\settings.json
    $mod = Get-CheckoutMod $root

    $override = [Environment]::GetEnvironmentVariable("$($mod.ToUpper())_USER_DATA_DIR")
    if ($override) { return (Join-Path $override 'settings\settings.json') }

    return (Join-Path $env:APPDATA "$mod\settings\settings.json")
}

function Set-PluginSettings($root, $proxy) {
    $file = Get-ModSettingsFile $root

    $settings = $null
    if (Test-Path -LiteralPath $file) {
        try { $settings = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json } catch { $settings = 'ilegivel' }
    }

    # Nunca reescrever por cima de um arquivo que nao deu para ler: isso apagaria todos os
    # plugins da pessoa. Melhor guardar uma copia e deixar ela ativar o plugin na mao.
    if ($settings -is [string]) {
        $backup = "$file.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
        Copy-Item -LiteralPath $file -Destination $backup -Force
        Write-Warn "Nao consegui ler $file, entao nao mexi nele. Copia em $backup"
        Write-Warn 'Ative o GoLiveBypass na mao em Configuracoes > Plugins.'
        return
    }

    if ($null -eq $settings) { $settings = [pscustomobject]@{} }

    if (-not $settings.PSObject.Properties['plugins']) {
        $settings | Add-Member -NotePropertyName plugins -NotePropertyValue ([pscustomobject]@{}) -Force
    }

    $existing = $settings.plugins.PSObject.Properties['GoLiveBypass']
    $plugin = if ($existing) { $existing.Value } else { [pscustomobject]@{} }

    $plugin | Add-Member -NotePropertyName enabled -NotePropertyValue $true -Force
    $plugin | Add-Member -NotePropertyName proxy -NotePropertyValue $proxy -Force
    if (-not $plugin.PSObject.Properties['excludedCountries']) {
        $plugin | Add-Member -NotePropertyName excludedCountries -NotePropertyValue 'BR' -Force
    }

    $settings.plugins | Add-Member -NotePropertyName GoLiveBypass -NotePropertyValue $plugin -Force

    Save-Text $file ($settings | ConvertTo-Json -Depth 10)

    $written = $null
    try { $written = (Get-Content -LiteralPath $file -Raw | ConvertFrom-Json).plugins.GoLiveBypass } catch { }
    if ($written -and $written.enabled) {
        Write-Step "Plugin ativado em $file"
    } else {
        Write-Warn "Nao consegui confirmar a escrita em $file"
        Write-Host '  Ative o GoLiveBypass na mao em Configuracoes > Plugins.' -ForegroundColor DarkGray
    }
}

function Show-Status($root) {
    $discord = (Get-DiscordResources).Count
    $mod = Get-InstalledMod

    Write-Host '  Detectado:' -ForegroundColor White
    if ($discord -gt 0) { Write-Host "    Discord   instalado ($discord versao(oes))" -ForegroundColor DarkGray }
    else { Write-Host '    Discord   nao encontrado' -ForegroundColor Yellow }

    if ($mod) { Write-Host "    Mod       $mod" -ForegroundColor DarkGray }
    else { Write-Host '    Mod       nenhum' -ForegroundColor DarkGray }

    if ($root) {
        Write-Host "    Fonte     $root" -ForegroundColor DarkGray
        $plugin = Join-Path $root "src\userplugins\$PluginDirName"
        if (Test-Path -LiteralPath $plugin) { Write-Host '    Plugin    ja instalado' -ForegroundColor Green }
        else { Write-Host '    Plugin    nao instalado' -ForegroundColor DarkGray }
    } else {
        Write-Host '    Fonte     nao encontrado' -ForegroundColor DarkGray
    }
    Write-Host ''
}

function Select-Target($root) {
    if (-not $root) { return (Install-Mod (Show-ModChoice)) }
    if ($Yes) { return $root }

    $name = Split-Path -Leaf $root

    if (Test-TuiInteractive) {
        $tui = Tui-Menu 'Onde instalar?' @("Usar o $name que ja esta aqui", "Baixar e usar outro (Equicord ou Vencord)")
        if ($tui -eq 2) { return (Install-Mod (Show-ModChoice)) }
        return $root
    }

    Write-Host '  Onde instalar?' -ForegroundColor White
    Write-Host ''
    Write-Host "    [1] Usar o $name que ja esta aqui" -ForegroundColor Green
    Write-Host "        $root" -ForegroundColor DarkGray
    Write-Host '    [2] Baixar e usar outro (Equicord ou Vencord)' -ForegroundColor Cyan
    Write-Host ''

    switch (Read-Host '  Escolha') {
        '2' { return (Install-Mod (Show-ModChoice)) }
        default { return $root }
    }
}

# =============================================================== Tor embutido

function Get-TorBaseDir {
    return (Join-Path (Get-EffectiveLocalApp) 'GoLiveBypass\Tor')
}

function Get-TorExe {
    return (Join-Path (Get-TorBaseDir) 'tor\tor.exe')
}

function Test-TorReady {
    # O probe barato: se a porta 9060 aceita conexao, um Tor ja esta escutando. Quem instalou
    # o Tor por aqui tem o daemon verificado na hora; se for o Tor da GUI, ele tambem serve.
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $task = $client.ConnectAsync('127.0.0.1', $TorPort)
        if (-not $task.Wait(1500)) { $client.Close(); return $false }
        if (-not $client.Connected) { $client.Close(); return $false }
        $client.Close()
        return $true
    } catch { return $false }
}

function Get-TorServiceStatus {
    try {
        $svc = Get-CimInstance Win32_Service -Filter "Name='tor'" -ErrorAction SilentlyContinue
        if ($svc -and $svc.State -eq 'Running') { return 'running' }
        return 'absent'
    } catch { return 'unknown' }
}

function Install-Tor {
    $base = Get-TorBaseDir
    $exe = Get-TorExe
    $torrc = Join-Path $base 'torrc'

    # Ja esta pondo a luz? Nada a fazer. Isso cobre um Tor do sistema (9050/9150) e o da GUI
    # (9060) que ja esteja rodando — a GUI morre com ela, mas se esta de pe agora, serve.
    if (Test-TorReady) {
        Write-Ok "Tor ja esta atendendo em 127.0.0.1:$TorPort — reaproveitando."
        return $true
    }

    # Primeiro tenta achar um Tor do sistema para reaproveitar o binario (sem baixar nada).
    if (Test-Tool 'tor') {
        Write-Step 'Tor do sistema encontrado; verificando se ele atende'
        # Um tor do sistema usa a porta dele; o nosso servicio usa a 9060. O daemon do sistema
        # so vale se ele ja estiver escutando na 9060 — senao, baixamos o nosso.
        if (-not (Test-TorReady)) {
            Write-Step 'Tor do sistema nao atende na porta 9060; baixando o bundle'
        }
    }

    if (-not (Test-Path -LiteralPath $exe)) {
        Write-Step 'Baixando o Tor (tor-expert-bundle 13.5, ~30 MB)'
        $asset = $TorUrls.Values | Select-Object -First 1
        $temp = if ($env:TEMP -and (Test-Path -LiteralPath $env:TEMP)) { $env:TEMP } else { [System.IO.Path]::GetTempPath() }
        $archive = Join-Path $temp $asset.Url.Split('/')[-1]
        try {
            Invoke-WebRequest -UseBasicParsing -Uri $asset.Url -OutFile $archive
        } catch {
            Write-Warn "Falha ao baixar o Tor: $($_.Exception.Message)"
            return $false
        }

        Write-Step 'Conferindo SHA-256'
        $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLower()
        if ($hash -ne $asset.Sha256.ToLower()) {
            Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
            Write-Warn 'O download do Tor veio corrompido (SHA-256 diferente). Abortando.'
            return $false
        }

        Write-Step 'Extraindo o Tor'
        New-Item -ItemType Directory -Path $base -Force | Out-Null
        # O bundle compacta um único diretório "tor"; tar.exe do Windows 11+ extrai direto.
        & tar -xzf $archive -C $base --exclude 'tor/pluggable_transports/*' --exclude 'debug/*'
        if ($LASTEXITCODE -ne 0) {
            Write-Warn 'Falha ao extrair o bundle do Tor.'
            return $false
        }
        Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
    }

    if (-not (Test-Path -LiteralPath $exe)) {
        Write-Warn "O binario do Tor nao apareceu em $exe."
        return $false
    }

    # torrc com a porta dedicada, como a GUI usa.
    $dataDir = Join-Path $base 'data-state'
    New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
    $geoip = Join-Path $base 'tor\data'
    $torrcText = @"
SocksPort $TorPort
DataDirectory $($dataDir -replace '\\','\')
$(
    if (Test-Path -LiteralPath (Join-Path $base 'tor\data\geoip')) {
        "GeoIPFile $(Join-Path $base 'tor\data\geoip')"
    }
)
$(
    if (Test-Path -LiteralPath (Join-Path $base 'tor\data\geoip6')) {
        "GeoIPv6File $(Join-Path $base 'tor\data\geoip6')"
    }
)
Log notice stdout
"@
    Save-Text $torrc $torrcText

    # O caminho do Windows: o servico (tor.exe --service install) roda como LocalService e
    # nao tem acesso a %LOCALAPPDATA% do usuario, entao o Tor nao consegue escrever no
    # DataDirectory e o servico fica parado. A Run key sobe o Tor no logon do USUARIO — mesmo
    # contexto da GUI — e e o caminho que funciona aqui, com ou sem admin. So vale a pena o
    # servico se o DataDirectory morar em ProgramData (caso da GUI), nao dos instaladores.
    Write-Step 'Registrando o Tor na inicializacao do usuario (sobe no logon)'
    Set-RunKey $exe $torrc

    # A Run key so vale no proximo logon; para a sessao atual, sobe o daemon agora.
    Write-Step 'Iniciando o Tor'
    Start-Process -FilePath $exe -ArgumentList '-f', $torrc -WindowStyle Hidden

    # Espera subir e valida com um tunel SOCKS de verdade.
    Write-Step 'Esperando o Tor subir'
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Milliseconds 1000
        if (Test-TorReady) { break }
    }

    if (-not (Test-TorReady)) {
        Write-Warn 'Tor nao subiu em 30s. Veja o log em tor/data-state.'
        return $false
    }
    Write-Ok "Tor atendendo em 127.0.0.1:$TorPort"
    return $true
}

function Set-RunKey($exe, $torrc) {
    try {
        $command = "`"$exe`" -f `"$torrc`""
        # ATENCAO: nada de "New-Item -Path <chave> -Force" aqui. No provider de
        # registro (diferente do de arquivos) o -Force numa chave que ja existe
        # APAGA a chave e recria vazia, levando junto todas as entradas de
        # inicializacao do usuario (Spotify, Steam, Discord...).
        # A chave Run sempre existe no Windows; so criamos se realmente faltar.
        $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
        if (-not (Test-Path -LiteralPath $key)) {
            New-Item -Path $key -Force | Out-Null
        }
        Set-ItemProperty -Path $key -Name 'GoLiveBypassTor' -Value $command
        Write-Ok 'Tor registrado para subir no proximo logon (GoLiveBypassTor).'
        return $true
    } catch {
        Write-Warn "Nao consegui registrar a inicializacao: $($_.Exception.Message)"
        return $false
    }
}

function Remove-Tor {
    # Desinstala o que este instalador criou: a Run key. Se existir um servico "tor" apontando
    # para a nossa pasta (instalacao anterior), remove tambem; se for de outra pessoa, nao mexe.
    $exe = Get-TorExe
    try {
        $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
        Remove-ItemProperty -Path $key -Name 'GoLiveBypassTor' -ErrorAction SilentlyContinue
    } catch { }

    if (Test-Path -LiteralPath $exe) {
        try {
            $service = Get-CimInstance Win32_Service -Filter "Name='tor' AND PathName LIKE '%GoLiveBypass%'" -ErrorAction SilentlyContinue
            if ($service) {
                Write-Step 'Removendo o servico do Tor'
                & $exe --service stop 2>&1 | Out-Null
                & $exe --service remove 2>&1 | Out-Null
            }
        } catch { }
    }

    # O binario fica: a GUI usa o mesmo e sem ela nao faz mal.
    if (Test-Path -LiteralPath $exe) {
        Write-Host '  [*] O binario do Tor em %LOCALAPPDATA%\GoLiveBypass\Tor permanece (usado tambem pela GUI).' -ForegroundColor DarkGray
    }
}

function Select-Proxy {
    if ($Yes) { return '' }

    if (Test-TuiInteractive) {
        $tui = Tui-Menu 'Como o bypass vai sair para fora do Brasil?' @(
            'Proxy gratuita (escolhida e testada sozinha)',
            'Tor automatico (baixa e sobe sozinho)',
            'Proxy minha (socks5://host:porta)'
        )
        switch ($tui) {
            2 {
                if (-not (Install-Tor)) {
                    Write-Warn 'Nao deu para preparar o Tor. Seguindo com proxy gratuita.'
                    return ''
                }
                return "socks5://127.0.0.1:$TorPort"
            }
            3 {
                $manual = (Tui-Input 'Endereco da proxy').Trim()
                if ($manual -notmatch '^(socks5|https?)://(?:.+@)?[a-z0-9.-]{1,253}:\d{1,5}(?:-\d{1,5})?$') {
                    throw 'Formato invalido. Use socks5://host:porta, ou socks5://usuario:senha@host:porta.'
                }
                return $manual
            }
            default { return '' }
        }
    }

    Write-Host ''
    Write-Host '  Como o bypass vai sair para fora do Brasil?' -ForegroundColor White
    Write-Host ''
    Write-Host '    [1] Proxy gratuita, escolhida e testada sozinha' -ForegroundColor Green
    Write-Host '        Nao precisa instalar nada. O plugin testa varias e usa a que passar.' -ForegroundColor DarkGray
    Write-Host '    [2] Tor automatico' -ForegroundColor Cyan
    Write-Host '        Baixa e instala o Tor sozinho (uma vez) e deixa ele sempre rodando.' -ForegroundColor DarkGray
    Write-Host '    [3] Proxy minha' -ForegroundColor Cyan
    Write-Host '        Voce informa o endereco, no formato socks5://host:porta.' -ForegroundColor DarkGray
    Write-Host ''

    switch (Read-Host '  Escolha') {
        '2' {
            if (-not (Install-Tor)) {
                Write-Warn 'Nao deu para preparar o Tor. Seguindo com proxy gratuita.'
                return ''
            }
            return "socks5://127.0.0.1:$TorPort"
        }
        '3' {
            Write-Host '  Se a sua proxy pedir login, use socks5://usuario:senha@host:porta' -ForegroundColor DarkGray
            Write-Host '  Senha com @ ou : precisa vir codificada (@ vira %40, : vira %3A)' -ForegroundColor DarkGray
            $manual = (Read-Host '  Endereco da proxy').Trim()
            # O trecho antes do @ e opcional e casado com ganancia, para a senha poder conter @ e
            # : codificados. Recusar isso aqui deixaria o suporte a login existindo so no plugin.
            if ($manual -notmatch '^(socks5|https?)://(?:.+@)?[a-z0-9.-]{1,253}:\d{1,5}(?:-\d{1,5})?$') {
                throw 'Formato invalido. Use socks5://host:porta, ou socks5://usuario:senha@host:porta.'
            }
            return $manual
        }
        default { return '' }
    }
}

function Select-Persistence {
    if ($Yes) { return $true }

    if (Test-TuiInteractive) {
        $tui = Tui-Menu 'Como voce quer deixar o Discord?' @(
            'Permanente (abre com o mod toda vez)',
            'Temporario (desfaz quando voce fechar o Discord)'
        )
        return $tui -ne 2
    }

    Write-Host ''
    Write-Host '  Como voce quer deixar o Discord?' -ForegroundColor White
    Write-Host ''
    Write-Host '    [1] Permanente' -ForegroundColor Green
    Write-Host '        O Discord abre com o mod toda vez, ate voce remover.' -ForegroundColor DarkGray
    Write-Host '    [2] Temporario' -ForegroundColor Yellow
    Write-Host '        Vale so nesta sessao. Quando voce fechar o Discord, a injecao e desfeita.' -ForegroundColor DarkGray
    Write-Host ''

    return (Read-Host '  Escolha') -ne '2'
}

function Wait-DiscordExit($root) {
    Write-Host ''
    Write-Ok 'Discord aberto com o GoLiveBypass.'
    Write-Warn 'Deixe esta janela aberta. Quando voce fechar o Discord, eu desfaco a injecao.'
    Write-Host '  Se fechar esta janela antes, rode: .\GoLiveBypass-Installer.ps1 -Mode Uninstall' -ForegroundColor DarkGray

    try {
        # Esperar o Discord APARECER antes de esperar ele sumir. Sem isso, o Update.exe ainda
        # nao trocou de processo e o laco acha que ja fechou, desfazendo tudo em 5 segundos.
        for ($i = 0; $i -lt 90; $i++) {
            if (Get-Process -Name $DiscordNames -ErrorAction SilentlyContinue) { break }
            Start-Sleep -Seconds 1
        }

        if (-not (Get-Process -Name $DiscordNames -ErrorAction SilentlyContinue)) {
            Write-Warn 'O Discord nao abriu em 90s. Vou desfazer a injecao agora.'
        } else {
            while (Get-Process -Name $DiscordNames -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 2 }
            Write-Host ''
            Write-Step 'Discord fechado, desfazendo a injecao'
        }
    } finally {
        # finally para que Ctrl+C tambem desfaca, em vez de deixar o Discord injetado.
        Push-Location -LiteralPath $root
        try {
            & pnpm uninject
            if ($LASTEXITCODE -ne 0) { Write-Warn 'O pnpm uninject falhou. Rode "pnpm uninject" na pasta do mod.' }
            else { Write-Ok 'Discord restaurado.' }
        } finally { Pop-Location }
    }
}

function Invoke-RestoreEverything {
    $root = Find-Checkout
    if ($root) {
        $target = Join-Path $root "src\userplugins\$PluginDirName"
        if (Test-Path -LiteralPath $target) {
            Write-Step "Removendo $target"
            Remove-Item -LiteralPath $target -Recurse -Force
        }

        Stop-Discord
        Push-Location -LiteralPath $root
        try {
            Write-Step 'Desfazendo a injecao'
            & pnpm uninject
        } finally { Pop-Location }
    } else {
        Write-Warn 'Nao achei o fonte do mod, entao so posso parar por aqui.'
    }

    Remove-Tor
    Write-Host ''
    Write-Ok 'Tudo restaurado. Seu Discord voltou ao normal.'
}

function Show-MainMenu {
    $root = Find-Checkout
    Show-Status $root

    if (Test-TuiInteractive) {
        $tui = Tui-Menu 'O que voce quer fazer?' @(
            'Instalar ou atualizar o GoLiveBypass',
            'Remover so o plugin (o mod continua)',
            'Restaurar tudo (remove o plugin e desfaz a injecao)',
            'Sair'
        )
        switch ($tui) {
            1 { Invoke-Install $root }
            2 { Invoke-Uninstall }
            3 { Invoke-RestoreEverything }
            default { Write-Host '  Ate mais.' -ForegroundColor DarkGray }
        }
        return
    }

    Write-Host '  O que voce quer fazer?' -ForegroundColor White
    Write-Host ''
    Write-Host '    [1] Instalar ou atualizar o GoLiveBypass' -ForegroundColor Green
    Write-Host '    [2] Remover so o plugin (o mod continua)' -ForegroundColor Yellow
    Write-Host '    [3] Restaurar tudo (remove o plugin e desfaz a injecao)' -ForegroundColor Red
    Write-Host '    [0] Sair' -ForegroundColor Gray
    Write-Host ''

    switch (Read-Host '  Escolha') {
        '1' { Invoke-Install $root }
        '2' { Invoke-Uninstall }
        '3' { Invoke-RestoreEverything }
        default { Write-Host '  Ate mais.' -ForegroundColor DarkGray }
    }
}


# -----------------------------------------------------------------------------
# Auto-update via GitHub Releases
#
# Compara a versao do plugin instalado (lida de goLiveBypass/manifest.json)
# com a tag da release mais recente do GitHub. Reusa Get-RepoFile para o
# caminho "nao tem zip" e adiciona o caminho "tem zip" (com validacao de
# SHA-256 contra o asset companion .sha256).
# -----------------------------------------------------------------------------

$GitHubRepo = 'bezumiya/GoLiveBypass'
$GitHubApi  = "https://api.github.com/repos/$GitHubRepo"

# Consulta a release mais recente. Devolve um objeto com .Tag e .AssetUrl
# (pode ser $null para qualquer um). RC=0 mesmo se a consulta falhou: o
# --check-update nao pode derrubar o instalador por falta de rede.
function Get-LatestRelease {
    try {
        $headers = @{ 'User-Agent' = 'GoLiveBypass-Installer'; 'Accept' = 'application/vnd.github+json' }
        $release = Invoke-RestMethod -Uri "$GitHubApi/releases/latest" -Headers $headers -TimeoutSec 15
    } catch {
        return $null
    }

    $tag = $null
    if ($release.PSObject.Properties['tag_name'] -and $release.tag_name) {
        # tag_name vem como "v1.1.8"; o manifest usa "1.1.8" (sem o v)
        $tag = $release.tag_name -replace '^v', ''
    }

    $zip = $null
    foreach ($a in $release.assets) {
        if ($a.name -like 'goLiveBypass-vencord*.zip') {
            $zip = $a.browser_download_url
            break
        }
    }

    return [PSCustomObject]@{ Tag = $tag; AssetUrl = $zip }
}

# Le a versao do manifest.json em $root/src/userplugins/$PluginDirName.
# Devolve $null se nao existir.
function Get-InstalledPluginVersion($root) {
    if (-not $root) { return $null }
    $manifest = Join-Path $root "src\userplugins\$PluginDirName\manifest.json"
    if (-not (Test-Path -LiteralPath $manifest)) { return $null }
    try {
        $j = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
        if ($j.PSObject.Properties['version'] -and $j.version) { return [string]$j.version }
    } catch {}
    return $null
}

# Compara duas versoes semver. Retorna -1/0/+1.
# [version] casts lidam com 1.2.3 mas nao com "1.2.3-beta" - usamos o tipo
# apenas para a parte numerica.
function Compare-Version($installed, $latest) {
    if (-not $latest) { return 0 }   # sem informacao do GitHub: sem atualizacao
    if (-not $installed) { return -1 }  # sem versao local: vale conferir

    $a = [version]($installed -replace '-.*$', '')
    $b = [version]($latest    -replace '-.*$', '')
    if ($b -gt $a) { return -1 }
    if ($b -lt $a) { return  1 }
    return 0
}

# Faz backup do plugin atual em $root/src/userplugins/.$PluginDirName.bak/
# com timestamp YYYYMMDDHHMMSS, mantendo so os 3 mais recentes.
function Backup-Plugin($root) {
    if (-not $root) { return }
    $target = Join-Path $root "src\userplugins\$PluginDirName"
    if (-not (Test-Path -LiteralPath $target)) { return }

    $backupRoot = Join-Path $root "src\userplugins\.${PluginDirName}.bak"
    if (-not (Test-Path -LiteralPath $backupRoot)) { New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null }

    $stamp = Get-Date -Format 'yyyyMMddHHmmss'
    $dest = Join-Path $backupRoot $stamp
    Copy-Item -LiteralPath $target -Destination $dest -Recurse -Force

    # Mantem so os 3 mais recentes (ordem alfabetica = timestamp)
    $items = Get-ChildItem -LiteralPath $backupRoot -Directory | Sort-Object Name
    if ($items.Count -gt 3) {
        $items | Select-Object -First ($items.Count - 3) | ForEach-Object {
            Remove-Item -LiteralPath $_.FullName -Recurse -Force
        }
    }
}

# --check-update: imprime o status e sai. NUNCA baixa nada.
function Invoke-CheckUpdate {
    $root = Find-Checkout
    if (-not $root) {
        Write-Host "  plugin: " -NoNewline
        Write-Host "nao encontrado" -ForegroundColor Yellow -NoNewline
        Write-Host " (rode uma vez para instalar)"
        return
    }

    $installed = Get-InstalledPluginVersion $root
    if ($installed) {
        Write-Host "  plugin: instalado (" -NoNewline
        Write-Host "v$installed" -ForegroundColor DarkGray -NoNewline
        Write-Host ")"
    } else {
        Write-Host "  plugin: " -NoNewline
        Write-Host "instalado (versao desconhecida)" -ForegroundColor Yellow
    }

    $release = Get-LatestRelease
    if (-not $release -or -not $release.Tag) {
        Write-Host "  remote: " -NoNewline
        Write-Host "nao consegui consultar (rede ou rate limit)" -ForegroundColor DarkGray
        return
    }

    Write-Host "  remote: " -NoNewline
        Write-Host "v$($release.Tag)" -ForegroundColor DarkGray

    if (-not $installed) {
        Write-Host "  resultado: " -NoNewline
        Write-Host "versao local desconhecida - rode --update para alinhar" -ForegroundColor Yellow
        return
    }

    $cmp = Compare-Version $installed $release.Tag
    switch ($cmp) {
        0  { Write-Host "  resultado: " -NoNewline
        Write-Host "voce esta na versao mais recente" -ForegroundColor Green }
        1  { Write-Host "  resultado: " -NoNewline
        Write-Host "versao local mais nova que a release (fork?)" -ForegroundColor DarkGray }
        -1 { Write-Host "  resultado: " -NoNewline
        Write-Host "ha versao nova - rode sem --check-update para atualizar" -ForegroundColor Yellow }
    }
}

# --update: faz o trabalho. Baixa o zip, valida SHA-256, extrai.
function Invoke-Update {
    $root = Find-Checkout
    if (-not $root) { throw "Nao achei o checkout do mod. Rode o instalador uma vez (sem --update) para descobrir." }

    $installed = Get-InstalledPluginVersion $root
    $release = Get-LatestRelease
    if (-not $release -or -not $release.Tag) { throw "Nao consegui consultar a release mais recente (rede ou rate limit do GitHub)." }

    if ($installed) {
        $cmp = Compare-Version $installed $release.Tag
        if ($cmp -eq 0) {
            Write-Ok "Voce ja esta na v$($release.Tag) (a mais recente)."
            return
        }
        if ($cmp -eq 1) {
            Write-Warn "Versao local (v$installed) e mais nova que a release (v$($release.Tag))."
            if (-not $Yes -and $Host.UI.RawUI) {
                $ans = Read-Host "  Atualizar mesmo assim? (S/N)"
                if ($ans -ne 'S' -and $ans -ne 's') { Write-Warn 'Atualizacao cancelada.'; return }
            }
        }
    }

    Write-Step "Fazendo backup do plugin atual"
    Backup-Plugin $root

    if ($release.AssetUrl) {
        Invoke-UpdateFromZip $root $release.AssetUrl $release.Tag
    } else {
        # Fallback: a release nao tem o asset do userplugin
        Write-Warn "Release v$($release.Tag) nao tem o zip do userplugin. Caindo no download via RepoRaw."
        Copy-Plugin $root
    }

    Build-Mod $root
    if (-not (Test-InjectedFromCheckout $root)) { Invoke-Injection $root @((Get-PatchTargets) | Where-Object { $_.Tipo -eq 'O' }) }

    Write-Host ''
    Write-Ok "Atualizado para v$($release.Tag). Reinicie o Discord para carregar a nova versao."
}

# Baixa o zip, valida SHA-256, extrai por cima do plugin atual.
function Invoke-UpdateFromZip($root, $zipUrl, $expectedVersion) {
    $tempDir = Join-Path $env:TEMP "GoLiveBypass-update-$expectedVersion"
    if (Test-Path -LiteralPath $tempDir) { Remove-Item -LiteralPath $tempDir -Recurse -Force }
    New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
    $zipFile = Join-Path $tempDir 'plugin.zip'

    Write-Step "Baixando $zipUrl"
    try {
        Invoke-WebRequest -Uri $zipUrl -OutFile $zipFile -UseBasicParsing -TimeoutSec 60
    } catch {
        Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
        throw "Download do zip falhou: $($_.Exception.Message)"
    }

    Write-Step "Validando SHA-256"
    $shaUrl = "$zipUrl.sha256"
    $shaExpected = $null
    try {
        $shaContent = (Invoke-WebRequest -Uri $shaUrl -UseBasicParsing -TimeoutSec 15).Content.Trim()
        $shaExpected = ($shaContent -split '\s+')[0].ToLower()
    } catch {
        Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
        throw "Release sem arquivo .sha256 (asset companion). Sem hash, sem update."
    }
    $shaActual = (Get-FileHash -LiteralPath $zipFile -Algorithm SHA256).Hash.ToLower()
    if ($shaActual -ne $shaExpected) {
        Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
        throw "SHA-256 nao confere: esperado $shaExpected, obtido $shaActual."
    }
    Write-Ok 'SHA-256 confere'

    Write-Step "Extraindo o plugin"
    $extractDir = Join-Path $tempDir 'extract'
    New-Item -ItemType Directory -Path $extractDir -Force | Out-Null
    try {
        Expand-Archive -LiteralPath $zipFile -DestinationPath $extractDir -Force
    } catch {
        Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
        throw "Extracao falhou: $($_.Exception.Message)"
    }

    $target = Join-Path $root "src\userplugins\$PluginDirName"
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
    New-Item -ItemType Directory -Path $target -Force | Out-Null

    # O zip tem a pasta raiz goLiveBypass/; copia o conteudo
    $extracted = Get-ChildItem -LiteralPath $extractDir -Directory | Select-Object -First 1
    if (-not $extracted) {
        Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
        throw 'Zip nao tem a pasta esperada (goLiveBypass/).'
    }
    Get-ChildItem -LiteralPath $extracted.FullName -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $target -Recurse -Force
    }

    Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
    Write-Ok 'Plugin extraido'
}

Show-Banner

try {
    switch ($Mode) {
        'Install'     { Invoke-Install (Find-Checkout) }
        'Uninstall'   { Invoke-Uninstall }
        'Restore'     { Invoke-RestoreEverything }
        'CheckUpdate' { Invoke-CheckUpdate }
        'Update'      { Invoke-Update }
        default       { Show-MainMenu }
    }
} catch {
    Write-Host ''
    Write-Err $_.Exception.Message

    # Sem isto o relato vira so a mensagem do PowerShell, que nao diz onde quebrou. Com a linha
    # e o comando, um print de tela ja basta para achar a causa.
    $info = $_.InvocationInfo
    if ($info -and $info.ScriptLineNumber) {
        Write-Host "      linha $($info.ScriptLineNumber): $($info.Line.Trim())" -ForegroundColor DarkGray
    }
    Write-Host '      Se for relatar, mande esta linha junto.' -ForegroundColor DarkGray

    # Report automatico (se nao for automacao): a issue abre no GitHub.
    # Erros de uso (dependencia, CLI typo, path errado, ferramenta externa) nao viram issue.
    if (Test-ShouldReport $_.Exception.Message) {
        Invoke-SendAutoReport "Falha no instalador GoLiveBypass: $($_.Exception.Message)" $_.Exception.Message $_
    }
    exit 1
}

Write-Host ''
