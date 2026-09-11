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

Write-Host ''
Write-Host '  [BETA] GoLiveBypass para Equicord/Vencord — canal beta WireGuard.' -ForegroundColor Yellow
Write-Host '         Este instalador entrega a versao beta atual do plugin; resultados podem mudar.' -ForegroundColor DarkGray
Write-Host '         O standalone continua separado e nao e alterado por este instalador.' -ForegroundColor DarkGray
Write-Host ''

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# Libera a execucao so para este processo. Em maquina com politica de dominio isso pode ser
# recusado, e nesse caso nao ha o que fazer aqui: o proprio .bat ja abre com -ExecutionPolicy Bypass.
try { Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force } catch { }

$RepoRaw = 'https://raw.githubusercontent.com/bezumiya/GoLiveBypass/main'
$PluginFiles = @(
    'goLiveBypass/index.tsx',
    'goLiveBypass/native.ts',
    'goLiveBypass/update-channel.ts',
    'goLiveBypass/update-security.ts',
    'goLiveBypass/stability.ts',
    'goLiveBypass/vpn-controller.ts',
    'goLiveBypass/vpn-proton.ts',
    'goLiveBypass/vpn-types.ts',
    'goLiveBypass/vpn-windows.ts',
    'goLiveBypass/manifest.json'
)
$PluginHelperRelative = 'bin\win32-x64\proton-confgen.exe'
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

# Apaga arquivo/pasta SEM passar pelo provider do PowerShell: Remove-Item
# -LiteralPath explode com PSArgumentException ("Nao existe um objeto no caminho
# especificado C:\Users\JOO~1...") em caminhos com nome curto 8.3 — o provider
# normaliza o caminho mesmo com -LiteralPath, e -ErrorAction SilentlyContinue nao
# segura essa (issue #155). O .NET apaga direto.
function Remove-CaminhoSilencioso($caminho) {
    if (-not $caminho) { return }
    try {
        $cheio = [System.IO.Path]::GetFullPath($caminho)
        if ([System.IO.File]::Exists($cheio)) { [System.IO.File]::Delete($cheio); return }
        if ([System.IO.Directory]::Exists($cheio)) { [System.IO.Directory]::Delete($cheio, $true) }
    } catch { }
}

function Show-Banner {
    Write-Host ''
    Write-Host '  GoLiveBypass' -ForegroundColor Cyan
    Write-Host '  Go Live e camera de volta no Discord' -ForegroundColor DarkGray
    Write-Host '  https://github.com/bezumiya/GoLiveBypass' -ForegroundColor DarkGray
    Write-Host ''
}

function Read-Escolha($prompt) {
    # Console sem teclado (stdin com handle morto — o instalador lancado por
    # atalho/automacao que nao abre console de verdade): o Read-Host explode
    # dentro do FileStream com "Invalid handle. Parameter name: handle" — e a
    # pessoa so ve um crash cru (issue #146). Mensagem com o que fazer; e
    # ambiente de uso, nao bug, entao nao vira issue.
    try {
        return (Read-Host $prompt)
    } catch {
        throw 'Este console nao aceita entrada de teclado. Feche e rode o instalador de novo com duplo clique no GoLiveBypass-Installer.bat (ou de uma janela normal do PowerShell).'
    }
}

# Diferente do #146 acima (console SEM teclado): aqui o console TEM teclado, mas a janela
# some sozinha assim que o script termina — "Executar com o PowerShell" no menu de contexto
# do Explorer (ou duplo clique num .ps1 associado a isso) spawna powershell.exe -File sem
# -NoExit, e ela fecha ao sair mesmo com erro. Sem pausa aqui a pessoa nunca le a mensagem
# (relato: Windows 10 sem winget falha e "fecha sozinho", parecendo silencioso — o .bat ja
# tem "pause" pra isso, mas quem roda so o .ps1 baixado direto nao passa por ele).
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
    if ($Yes) { return } # automacao: nada le a tela, nao ha por que travar aqui
    if (-not (Test-JanelaTransitoria)) { return } # console normal ou automacao: quem chamou continua vendo a saida
    Write-Host ''
    Write-Host '  Pressione Enter para fechar esta janela.' -ForegroundColor DarkGray
    try { [void][Console]::ReadLine() } catch { }
}

function Confirm-Action($question) {
    if ($Yes) { return $true }
    return (Read-Escolha "  $question [s/N]") -match '^[sSyY]'
}

# =========================================================================== Report de bugs
# Igual a GUI: ao falhar, monta diagnostico sanitizado e POST na API de bugs
# (abre issue no bezumiya/GoLiveBypass). Nunca bloqueia o fluxo.

$script:BugApiUrl = 'https://api.skyplaceia.com/bugs/v1/reports'
$script:BugApiToken = 'c3d0bff691ecc3ddc6f6ca10037b9ac967c62547e681d3749204e50800504511'

function Invoke-BugReport([string]$title, [string]$description, [string]$log = '', [hashtable]$meta = @{}) {
    if ($Yes) { return }  # automacao: nao spammar a API
    # Dedupe: o mesmo erro NAO reabre issue. Os 3 reports duplos da 1.1.11
    # (issues 124-126) vieram daqui: cada rodada do mesmo bug abria issue nova.
    # Assinatura = titulo + primeira linha da descricao, com data; janela de 48h.
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
        # A LINHA do script: sem ela um "Invalid handle" de FileStream nao diz nada
        # (issue #127). O catch do instalador mostra no console; o report so via aqui.
        $info = $ErrorRecord.InvocationInfo
        if ($info -and $info.ScriptLineNumber) {
            $desc += "`nlinha do script: $($info.ScriptLineNumber): $($info.Line.Trim())"
        } elseif ($ErrorRecord.ScriptStackTrace) {
            # Excecao .NET surfada pelo pipeline as vezes chega sem InvocationInfo
            # util (#136: DriveNotFoundException sem linha nenhuma no relato). O
            # ScriptStackTrace e preenchido sempre que existe frame de script.
            $pilha = ($ErrorRecord.ScriptStackTrace -split "`n" | Select-Object -First 2) -join ' | '
            $desc += "`npilha: " + $pilha
        }
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
    # console sem teclado (issue #146): ambiente de uso, o aviso ja diz o que fazer
    if ($msg -like '*Este console nao aceita entrada de teclado*') { return $false }
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
        # Get-DiscordResources devolve STRINGS (caminhos de resources), nao objetos:
        # .Flavour/.Resources numa string devolvem $null no PowerShell — a TUI de
        # selecao mostrava checkboxes vazios e o Split-Path da injecao recebia nulo
        # ("Nao e possivel associar o argumento ao parametro Path").
        $resources = [string]$install
        if (-not $resources.Trim()) { continue }
        $flavour = Split-Path -Leaf (Split-Path -Parent (Split-Path -Parent $resources))
        $targets += [pscustomobject]@{ Flavour = $flavour; Resources = $resources; Tipo = 'O' }
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
    # Defesa em profundidade (#136): um alvo com Resources vazio ou nao-string,
    # usado como path la na frente, virava o DriveNotFoundException
    # "A drive with the name '@{Flavour=Discord; Resources=C' does not exist" —
    # o PowerShell entende o trecho antes do ":" como nome de drive. Nunca deve
    # acontecer; se acontecer, para AQUI com o motivo na mesa em vez de explodir
    # longe da causa.
    foreach ($t in $targets) {
        if (-not $t.Resources -or -not ($t.Resources -is [string]) -or -not $t.Resources.Trim()) {
            throw "Alvo de injecao nasceu sem caminho (Flavour='$($t.Flavour)'). Bug do instalador — reporte com este print."
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

# Qual .asar cada mod consegue gerar para cada cliente paralelo. Equicord e Vencord sao forks
# DIFERENTES: o build do Equicord so empacota equibop.asar (o cliente dele), o do Vencord so
# vesktop.asar (o dele) -- nenhum dos dois gera o .asar do outro. Legcord e um projeto A PARTE
# (nao e fork de nenhum dos dois): nenhum checkout Equicord/Vencord gera legcord.asar, entao
# "rode pnpm build e tente de novo" era enganoso nesse caso -- nenhum build ia gerar aquele
# arquivo. Isso e a causa raiz por tras de #123/#130/#132/#133 (sempre Vesktop detectado com
# um checkout Equicord): o "aviso acima" que a mensagem de erro citava nunca chegava no relato
# de bug (so ia para o console), entao a causa ficava invisivel para quem nao colava o
# terminal inteiro.
$ParallelAsarPorMod = @{
    Equicord = @{ Equibop = 'equibop.asar' }
    Vencord  = @{ Vesktop = 'vesktop.asar' }
}

function Copy-PatchParallel($root, $resources) {
    # Patch direto em cliente paralelo: o build do mod gera dist\<cliente>.asar;
    # copia sobre o app.asar do cliente, com backup _app.asar (idempotente).
    $nome = $null
    switch -Regex ($resources) {
        '(?i)equibop' { $nome = 'Equibop' }
        '(?i)vesktop' { $nome = 'Vesktop' }
        '(?i)legcord' { $nome = 'Legcord' }
        default {
            $motivo = "cliente paralelo desconhecido: $resources"
            Write-Warn $motivo
            return [pscustomobject]@{ Ok = $false; Motivo = $motivo }
        }
    }

    $mod = Get-CheckoutMod $root
    $asarName = $ParallelAsarPorMod[$mod][$nome]
    if (-not $asarName) {
        $motivo = "$nome nao e gerado por um checkout $mod (Equicord builda so o Equibop, Vencord so o Vesktop; Legcord e um app a parte -- nenhum dos dois builda ele). Use um checkout do mod certo para $nome (-Source), ou injete o $nome pelo instalador dele mesmo."
        Write-Warn $motivo
        return [pscustomobject]@{ Ok = $false; Motivo = $motivo }
    }

    $asar = Join-Path $root "dist\$asarName"
    if (-not (Test-Path -LiteralPath $asar)) {
        $motivo = "o build nao gerou $asar. Rode 'pnpm build' no checkout $mod e tente de novo."
        Write-Warn $motivo
        return [pscustomobject]@{ Ok = $false; Motivo = $motivo }
    }
    $appAsar = Join-Path $resources 'app.asar'
    $backup = Join-Path $resources '_app.asar'
    if (-not (Test-Path -LiteralPath $backup) -and (Test-Path -LiteralPath $appAsar)) {
        Copy-Item -LiteralPath $appAsar -Destination $backup
        Write-Ok "Backup criado em $backup"
    }
    Copy-Item -LiteralPath $asar -Destination $appAsar -Force
    Write-Ok "$nome patcheado: $appAsar"
    return [pscustomobject]@{ Ok = $true; Motivo = '' }
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

    switch (Read-Escolha '  Escolha') {
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
        Wait-AntesDeFechar
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

function Resolve-LocalPluginHelper($source) {
    # Somente layouts que o usuario apontou (-PluginSource) ou onde o proprio
    # instalador esta (um pacote de release extraido). Nada de varrer Downloads:
    # copiar um binario arbitrario de la para dentro do userplugin seria pior do
    # que falhar e mandar baixar da release com SHA-256 conferido.
    $candidates = @()
    $bases = @()
    if ($source -and -not [string]::IsNullOrWhiteSpace($source)) { $bases += $source }
    if ($PSScriptRoot -and $PSScriptRoot -ne $source) { $bases += $PSScriptRoot }

    foreach ($base in $bases) {
        if (-not (Test-Path -LiteralPath $base)) { continue }
        if (Test-Path -LiteralPath $base -PathType Leaf) { $base = Split-Path -Parent $base }
        $candidates += (Join-Path $base $PluginHelperRelative)
        # Pacote de release extraido: os fontes do plugin (e o bin) ficam sob goLiveBypass\.
        $candidates += (Join-Path $base (Join-Path 'goLiveBypass' $PluginHelperRelative))
        # Checkout do repositorio: o binario e produzido por npm run build:proton.
        $candidates += (Join-Path $base 'tools\proton-confgen\build\proton-confgen.exe')
        $candidates += (Join-Path (Join-Path $base '..') 'tools\proton-confgen\build\proton-confgen.exe')
        $candidates += (Join-Path (Join-Path $base '..') (Join-Path 'goLiveBypass' $PluginHelperRelative))
        # Helper baixado avulso da release, com o nome do asset ao lado do instalador.
        $candidates += (Join-Path $base 'proton-confgen.exe')
        $candidates += @(Get-ChildItem -LiteralPath $base -Filter 'proton-confgen*-win-x64.exe' -File -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
    }

    foreach ($cand in $candidates) {
        if ($cand -and (Test-Path -LiteralPath $cand)) {
            $item = Get-Item -LiteralPath $cand -ErrorAction SilentlyContinue
            if ($item -and -not $item.PSIsContainer -and $item.Length -gt 0) {
                return $item.FullName
            }
        }
    }

    return $null
}

function Test-HelperSha256($filePath) {
    if (-not (Test-Path -LiteralPath $filePath)) { return $false }
    $dir = Split-Path -Parent $filePath
    $manifestPath = Join-Path $dir 'proton-confgen-manifest.json'
    $expectedSha = $null
    if (Test-Path -LiteralPath $manifestPath) {
        try {
            $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
            if ($manifest.assets -and $manifest.assets.'win32-x64' -and $manifest.assets.'win32-x64'.sha256) {
                $expectedSha = $manifest.assets.'win32-x64'.sha256.ToLowerInvariant()
            }
        } catch { }
    }
    if (-not $expectedSha) {
        $shaFile = "$filePath.sha256"
        if (Test-Path -LiteralPath $shaFile) {
            try {
                $content = (Get-Content -LiteralPath $shaFile -Raw).Trim()
                $expectedSha = ($content -split '\s+')[0].ToLowerInvariant()
            } catch { }
        }
    }
    if ($expectedSha -and $expectedSha -match '^[0-9a-f]{64}$') {
        $actual = (Get-FileHash -LiteralPath $filePath -Algorithm SHA256).Hash.ToLowerInvariant()
        return ($actual -eq $expectedSha)
    }
    return $true
}

function Copy-PluginHelper($target) {
    $destination = Join-Path $target $PluginHelperRelative
    $destinationDir = Split-Path -Parent $destination
    if (-not (Test-Path -LiteralPath $destinationDir)) {
        New-Item -ItemType Directory -Path $destinationDir -Force | Out-Null
    }

    # 1. Verificar candidatos locais (checkout local, PluginSource, Downloads, zip descompactado)
    $local = Resolve-LocalPluginHelper $PluginSource
    if ($local -and (Test-Path -LiteralPath $local)) {
        if (Test-HelperSha256 $local) {
            Copy-Item -LiteralPath $local -Destination $destination -Force
            Write-Ok "Helper Proton copiado de $local"
            return
        } else {
            Write-Warn "Helper local em $local divergiu do hash esperado; tentando download da release."
        }
    }

    # 2. O helper e binario e nao pode ser obtido por raw.githubusercontent.com. Quando o
    # instalador baixa as fontes da main, busca o helper x64 da beta mais recente e valida
    # o SHA-256 publicado antes de grava-lo no userplugin.
    $asset = Get-LatestBetaHelperAsset
    if (-not $asset) {
        throw 'Nao encontrei o helper proton-confgen da beta. Use um pacote de release ou -PluginSource com bin\win32-x64\proton-confgen.exe.'
    }

    $temporary = Join-Path $env:TEMP ("golivebypass-proton-confgen-{0}.exe" -f ([guid]::NewGuid().ToString('N')))
    try {
        Write-Step "Baixando helper Proton da beta $($asset.Tag)"
        Invoke-WebRequest -Uri $asset.Url -OutFile $temporary -UseBasicParsing -TimeoutSec 60
        $actual = (Get-FileHash -LiteralPath $temporary -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -ne $asset.Sha256) {
            throw "SHA-256 do helper nao confere: esperado $($asset.Sha256), obtido $actual."
        }
        Copy-Item -LiteralPath $temporary -Destination $destination -Force
        Write-Ok 'Helper Proton instalado (SHA-256 confere)'
    } finally {
        Remove-CaminhoSilencioso $temporary
    }
}

function Copy-Plugin($root) {
    if (-not $root) { throw 'Caminho do checkout invalido para copiar o plugin.' }
    $target = Join-Path $root "src\userplugins\$PluginDirName"
    Write-Step "Instalando o plugin em $target"

    if (-not (Test-Path -LiteralPath $target)) { New-Item -ItemType Directory -Path $target -Force | Out-Null }

    # versoes antigas usavam index.ts; deixar os dois quebra o build
    $stale = Join-Path $target 'index.ts'
    if (Test-Path -LiteralPath $stale) { Remove-Item -LiteralPath $stale -Force }

    $sourceBase = $PluginSource
    if ($PluginSource -and -not [string]::IsNullOrWhiteSpace($PluginSource)) {
        if (-not (Test-Path -LiteralPath (Join-Path $PluginSource (Split-Path -Leaf $PluginFiles[0])))) {
            $sub = Join-Path $PluginSource $PluginDirName
            if (Test-Path -LiteralPath (Join-Path $sub (Split-Path -Leaf $PluginFiles[0]))) {
                $sourceBase = $sub
            }
        }
    }

    foreach ($file in $PluginFiles) {
        $leaf = Split-Path -Leaf $file
        if (-not $PluginSource -or [string]::IsNullOrWhiteSpace($PluginSource)) {
            Save-Text (Join-Path $target $leaf) (Get-RepoFile $file)
            continue
        }

        $local = Join-Path $sourceBase $leaf
        if (-not (Test-Path -LiteralPath $local)) { throw "Nao achei $leaf em $PluginSource." }
        Copy-Item -LiteralPath $local -Destination (Join-Path $target $leaf) -Force
    }

    Copy-PluginHelper $target

    if ($PluginSource -and -not [string]::IsNullOrWhiteSpace($PluginSource)) {
        Write-Warn "Plugin copiado de $PluginSource, e nao do GitHub."
    }
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
        # Detalhe por alvo: sem isto o relato automatico chegava so com a mensagem
        # generica e o log do RUNTIME (que nada diz sobre a injecao) -- issue #120.
        $detalhes = [System.Collections.Generic.List[string]]::new()
        foreach ($t in @($targets)) {
            if ($t.Tipo -eq 'P') {
                $resultado = Copy-PatchParallel $root $t.Resources
                if (-not $resultado.Ok) {
                    $falha = $true
                    # O motivo real (nao mais "no aviso acima"): antes disto, o motivo so ia
                    # para o console via Write-Warn e nunca chegava no relato automatico de bug
                    # (issues #123/#130/#132/#133, todas com "--- logs ---" vazio).
                    $detalhes.Add("cliente paralelo ($($t.Resources)): $($resultado.Motivo)")
                }
                continue
            }
            Write-Step "Injetando no $($t.Flavour)"
            # O --location espera a RAIZ da instalacao (...\Discord), nao o app-1.0.x:
            # e de la que o instalador do mod varre os app-*\resources. Espelho do
            # install_location() do .sh (dois dirnames). Passar o app-1.0.x fazia o
            # injector nao achar a instalacao e toda instalacao nova pela linha de
            # comando falhar (relato 1.1.11-beta.1).
            $loc = Split-Path -Parent (Split-Path -Parent $t.Resources)
            & pnpm run inject -- --location $loc
            if ($LASTEXITCODE -ne 0) {
                # Nem todo pnpm come o -- : cai no caminho de sempre (o instalador
                # do mod pergunta) — espelho do run_inject do .sh.
                & pnpm inject
                if ($LASTEXITCODE -ne 0) {
                    $falha = $true
                    $detalhes.Add("$($t.Flavour): pnpm inject saiu com codigo $LASTEXITCODE ($($t.Resources))")
                }
            }
        }
        if ($falha) {
            $msg = 'Falha ao injetar em algum dos Discords escolhidos.'
            if ($detalhes.Count -gt 0) { $msg = "$msg -- " + ($detalhes -join '; ') }
            throw $msg
        }
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

    switch (Read-Escolha '  Escolha') {
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
            Remove-CaminhoSilencioso $archive
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
        Remove-CaminhoSilencioso $archive
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
        $vbs = Join-Path (Split-Path -Parent $torrc) 'GoLiveBypassTor.vbs'
        $inner = "`"$exe`" -f `"$torrc`"".Replace('"', '""')
        # Unicode (UTF-16 com BOM): wscript detecta o BOM e le caminhos com acento
        # que o ANSI do sistema nao representaria.
        [System.IO.File]::WriteAllText($vbs, "CreateObject(`"WScript.Shell`").Run `"$inner`", 0, False", [System.Text.Encoding]::Unicode)
        $command = "`"$env:SystemRoot\System32\wscript.exe`" `"$vbs`""
        Set-ItemProperty -Path $key -Name 'GoLiveBypassTor' -Value $command
        Write-Ok 'Tor registrado para subir no proximo logon, sem janela de terminal (GoLiveBypassTor).'
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
    # O wrapper invisivel que o Set-RunKey gravou ao lado do torrc tambem sai.
    try {
        Remove-Item -LiteralPath (Join-Path (Get-TorBaseDir) 'GoLiveBypassTor.vbs') -Force -ErrorAction SilentlyContinue
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

    switch (Read-Escolha '  Escolha') {
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
            $manual = (Read-Escolha '  Endereco da proxy').Trim()
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

    return (Read-Escolha '  Escolha') -ne '2'
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
            'Instalar o GoLiveBypass',
            'Verificar atualizacoes do plugin',
            'Atualizar o plugin',
            'Remover so o plugin (o mod continua)',
            'Restaurar tudo (remove o plugin e desfaz a injecao)',
            'Sair'
        )
        switch ($tui) {
            1 { Invoke-Install $root }
            2 { Invoke-CheckUpdate }
            3 { Invoke-Update }
            4 { Invoke-Uninstall }
            5 { Invoke-RestoreEverything }
            default { Write-Host '  Ate mais.' -ForegroundColor DarkGray }
        }
        return
    }

    Write-Host '  O que voce quer fazer?' -ForegroundColor White
    Write-Host ''
    Write-Host '    [1] Instalar o GoLiveBypass' -ForegroundColor Green
    Write-Host '    [2] Verificar atualizacoes do plugin' -ForegroundColor Cyan
    Write-Host '    [3] Atualizar o plugin' -ForegroundColor Green
    Write-Host '    [4] Remover so o plugin (o mod continua)' -ForegroundColor Yellow
    Write-Host '    [5] Restaurar tudo (remove o plugin e desfaz a injecao)' -ForegroundColor Red
    Write-Host '    [0] Sair' -ForegroundColor Gray
    Write-Host ''

    switch (Read-Escolha '  Escolha') {
        '1' { Invoke-Install $root }
        '2' { Invoke-CheckUpdate }
        '3' { Invoke-Update }
        '4' { Invoke-Uninstall }
        '5' { Invoke-RestoreEverything }
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

function Get-LatestBetaHelperAsset {
    try {
        $headers = @{ 'User-Agent' = 'GoLiveBypass-Installer' }
        $apiHeaders = @{ 'User-Agent' = 'GoLiveBypass-Installer'; 'Accept' = 'application/vnd.github+json' }
        $releases = Invoke-RestMethod -Uri "$GitHubApi/releases?per_page=20" -Headers $apiHeaders -TimeoutSec 15
        foreach ($release in @($releases)) {
            if ($release.draft -or -not $release.prerelease) { continue }

            $sha256 = $null
            $asset = $null

            # 1. Preferir proton-confgen-manifest.json para nome canonico e hash SHA-256
            $manifestAsset = @($release.assets) |
                Where-Object { $_.name -eq 'proton-confgen-manifest.json' } |
                Select-Object -First 1
            if ($manifestAsset) {
                try {
                    $manifestContent = Invoke-RestMethod -Uri $manifestAsset.browser_download_url -Headers $headers -TimeoutSec 15
                    if ($manifestContent.assets -and $manifestContent.assets.'win32-x64') {
                        $expectedName = $manifestContent.assets.'win32-x64'.asset
                        $expectedSha = $manifestContent.assets.'win32-x64'.sha256
                        if ($expectedName -and $expectedSha -and $expectedSha -match '^[0-9a-f]{64}$') {
                            $asset = @($release.assets) | Where-Object { $_.name -eq $expectedName } | Select-Object -First 1
                            if ($asset) {
                                $sha256 = $expectedSha.ToLowerInvariant()
                            }
                        }
                    }
                } catch { }
            }

            # 2. Fallback: procurar executavel por padrao de nome e arquivo companion .sha256
            if (-not $asset) {
                $asset = @($release.assets) |
                    Where-Object { $_.name -match '(^|-)proton-confgen.*-win-x64\.exe$' } |
                    Select-Object -First 1
            }
            if (-not $asset) { continue }

            if (-not $sha256) {
                $shaAsset = @($release.assets) |
                    Where-Object { $_.name -eq "$($asset.name).sha256" } |
                    Select-Object -First 1
                if (-not $shaAsset) { continue }

                $shaResponse = Invoke-WebRequest -Uri $shaAsset.browser_download_url -Headers $headers -UseBasicParsing -TimeoutSec 15
                $shaContent = if ($shaResponse.Content -is [byte[]]) {
                    [Text.Encoding]::UTF8.GetString($shaResponse.Content).Trim()
                } else {
                    ([string]$shaResponse.Content).Trim()
                }
                $sha256 = ($shaContent -split '\s+')[0].ToLowerInvariant()
            }

            if (-not $sha256 -or $sha256 -notmatch '^[0-9a-f]{64}$') { continue }

            return [PSCustomObject]@{
                Tag = ($release.tag_name -replace '^v', '')
                Url = $asset.browser_download_url
                Sha256 = $sha256
            }
        }
    } catch {
        return $null
    }
    return $null
}

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

    $local = [string]$installed -replace '^[vV]', ''
    $remote = [string]$latest -replace '^[vV]', ''
    $localDash = $local.IndexOf('-')
    $remoteDash = $remote.IndexOf('-')
    $localCore = if ($localDash -ge 0) { $local.Substring(0, $localDash) } else { $local }
    $localPre = if ($localDash -ge 0) { $local.Substring($localDash + 1) } else { '' }
    $remoteCore = if ($remoteDash -ge 0) { $remote.Substring(0, $remoteDash) } else { $remote }
    $remotePre = if ($remoteDash -ge 0) { $remote.Substring($remoteDash + 1) } else { '' }

    $a = [version]$localCore
    $b = [version]$remoteCore
    if ($b -gt $a) { return -1 }
    if ($b -lt $a) { return  1 }

    # Mesma versao base: um sufixo de pre-release (-beta.N) sempre conta como
    # mais antigo que a mesma base sem sufixo, nunca como versao igual.
    if ($localPre -and -not $remotePre) { return -1 }
    if (-not $localPre -and $remotePre) { return 1 }
    if ($localPre -and $remotePre) { return [string]::Compare($localPre, $remotePre, [System.StringComparison]::Ordinal) }
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
                $ans = Read-Escolha "  Atualizar mesmo assim? (S/N)"
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
        Remove-CaminhoSilencioso $tempDir
        throw "Download do zip falhou: $($_.Exception.Message)"
    }

    Write-Step "Validando SHA-256"
    $shaUrl = "$zipUrl.sha256"
    $shaExpected = $null
    try {
        $shaResponse = Invoke-WebRequest -Uri $shaUrl -UseBasicParsing -TimeoutSec 15
        # Windows PowerShell 5.1 pode expor Content como byte[] para assets
        # binários/redirects do GitHub; normalize antes de aplicar Trim().
        $shaContent = if ($shaResponse.Content -is [byte[]]) {
            [Text.Encoding]::UTF8.GetString($shaResponse.Content).Trim()
        } else {
            ([string]$shaResponse.Content).Trim()
        }
        $shaExpected = ($shaContent -split '\s+')[0].ToLower()
    } catch {
        Remove-CaminhoSilencioso $tempDir
        throw "Release sem arquivo .sha256 (asset companion). Sem hash, sem update."
    }
    $shaActual = (Get-FileHash -LiteralPath $zipFile -Algorithm SHA256).Hash.ToLower()
    if ($shaActual -ne $shaExpected) {
        Remove-CaminhoSilencioso $tempDir
        throw "SHA-256 nao confere: esperado $shaExpected, obtido $shaActual."
    }
    Write-Ok 'SHA-256 confere'

    Write-Step "Extraindo o plugin"
    $extractDir = Join-Path $tempDir 'extract'
    New-Item -ItemType Directory -Path $extractDir -Force | Out-Null
    try {
        Expand-Archive -LiteralPath $zipFile -DestinationPath $extractDir -Force
    } catch {
        Remove-CaminhoSilencioso $tempDir
        throw "Extracao falhou: $($_.Exception.Message)"
    }

    $target = Join-Path $root "src\userplugins\$PluginDirName"
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
    New-Item -ItemType Directory -Path $target -Force | Out-Null

    # O zip tem a pasta raiz goLiveBypass/; copia o conteudo
    $extracted = Get-ChildItem -LiteralPath $extractDir -Directory | Select-Object -First 1
    if (-not $extracted) {
        Remove-CaminhoSilencioso $tempDir
        throw 'Zip nao tem a pasta esperada (goLiveBypass/).'
    }
    Get-ChildItem -LiteralPath $extracted.FullName -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $target -Recurse -Force
    }

    Remove-CaminhoSilencioso $tempDir
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
    Wait-AntesDeFechar
    exit 1
}

Write-Host ''
Wait-AntesDeFechar
