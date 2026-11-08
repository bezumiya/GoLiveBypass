<#
    GoLiveBypass - instalador automatico

    Encontra sozinho o Equicord ou o Vencord que voce tem, instala o plugin, compila e
    injeta. Se voce nao tiver nenhum dos dois, pergunta qual quer e instala junto.

    Uso:
      .\GoLiveBypass-Installer.ps1
      .\GoLiveBypass-Installer.ps1 -Channel stable
      .\GoLiveBypass-Installer.ps1 -Channel beta -Mode Update
      .\GoLiveBypass-Installer.ps1 -Source "C:\caminho\do\Equicord"
      .\GoLiveBypass-Installer.ps1 -PluginSource "C:\caminho\do\GoLiveBypass\goLiveBypass"
      .\GoLiveBypass-Installer.ps1 -Mod Equicord -Yes
      .\GoLiveBypass-Installer.ps1 -Mode Uninstall
      .\GoLiveBypass-Installer.ps1 -Mode CheckUpdate   # consulta a API e pode persistir o canal, sem baixar ZIP
      .\GoLiveBypass-Installer.ps1 -Mode Update        # aplica update se houver
      .\GoLiveBypass-Installer.ps1 -Mode ClientStatus  # estado da injecao em cada cliente (nao altera nada)
      .\GoLiveBypass-Installer.ps1 -Mode RestoreClient # devolve o app.asar original (cliente que nao abre)
      .\GoLiveBypass-Installer.ps1 -Mode RestoreClient -Client Equibop -Force

    Obrigado ao Vithor (https://github.com/Vith0r), que escreveu o primeiro instalador do
    GoLiveBypass e abriu o caminho para este aqui.
#>

[CmdletBinding()]
param(
    [ValidateSet('Menu', 'Install', 'Uninstall', 'Restore', 'CheckUpdate', 'Update', 'RestoreClient', 'ClientStatus')]
    [string] $Mode = 'Menu',

    [ValidateSet('Equicord', 'Vencord')]
    [string] $Mod = '',

    [string] $Source = '',

    # Instala o plugin de uma pasta local em vez de baixar do GitHub. Serve para testar uma
    # mudanca antes de publicar: sem isto o instalador sempre traz o que esta no repositorio,
    # e um teste feito assim mede a versao errada sem avisar.
    [string] $PluginSource = '',

    [ValidateSet('stable', 'beta')]
    [string] $Channel = 'stable',

    [switch] $Yes,

    # -Mode RestoreClient: nome do cliente a restaurar (Equibop, Vesktop, Legcord, Discord).
    # Vazio restaura todos os que tem patch/backup.
    [string] $Client = '',

    # Desfaz tambem um mod Vencord/Equicord que esta funcionando (o cliente perde o mod).
    [switch] $Force
)

$script:ChannelExplicit = $PSBoundParameters.ContainsKey('Channel')
$script:SelectedChannel = $Channel

Write-Host ''
Write-Host '  GoLiveBypass para Equicord/Vencord — escolha seu canal de atualizacoes.' -ForegroundColor Cyan
Write-Host '         Stable e a opcao recomendada: canal mais previsivel, somente releases estaveis.' -ForegroundColor DarkGray
Write-Host '         Beta e opcional: canal de testes; voce ajuda a comunidade ao testar, encontrar' -ForegroundColor DarkGray
Write-Host '         e corrigir erros antes da versao estavel. O sistema ainda nao e estavel; nenhum canal promete estabilidade.' -ForegroundColor DarkGray
Write-Host '         Ao testar, encontrar e corrigir erros, relate em https://github.com/bezumiya/GoLiveBypass/issues.' -ForegroundColor DarkGray
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
    'goLiveBypass/plugin-build.ts',
    'goLiveBypass/plugin-log.ts',
    'goLiveBypass/bug-report.ts',
    'goLiveBypass/update-channel.ts',
    'goLiveBypass/update-security.ts',
    'goLiveBypass/proton-manual-selection.ts',
    'goLiveBypass/stability.ts',
    'goLiveBypass/vpn-controller.ts',
    'goLiveBypass/vpn-proton.ts',
    'goLiveBypass/vpn-types.ts',
    'goLiveBypass/vpn-snapshot.ts',
    'goLiveBypass/vpn-snapshot-worker.ts',
    'goLiveBypass/vpn-windows.ts',
    'goLiveBypass/vpn-linux.ts',
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
# O npm instala pnpm.ps1, pnpm.cmd e, em algumas variantes, pnpm.exe lado a lado. O
# command discovery do PowerShell prefere o .ps1, mas esse shim pode apontar para um
# entrypoint antigo e falhar mesmo depois de `pnpm --version` responder. Resolva somente
# Application (.exe/.cmd) e, para .cmd, execute o entrypoint do pacote diretamente com Node.
$script:PnpmEntrypoints = @('pnpm.cjs', 'pnpm.mjs', 'pnpm')
$script:PnpmExitCode = 0

function Find-PnpmApplications {
    $candidates = @()
    $found = Get-Command 'pnpm' -CommandType Application -ErrorAction SilentlyContinue
    if ($found) { $candidates += @($found | ForEach-Object { $_.Source }) }
    $candidates += @(
        $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'pnpm\pnpm.exe' }),
        $(if ($env:APPDATA) { Join-Path $env:APPDATA 'npm\pnpm.cmd' }),
        $(if ($env:USERPROFILE) { Join-Path $env:USERPROFILE 'AppData\Roaming\npm\pnpm.cmd' }),
        $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'pnpm\pnpm.cmd' }),
        $(if ($env:ProgramW6432) { Join-Path $env:ProgramW6432 'nodejs\pnpm.cmd' }),
        $(if ($env:ProgramFiles) { Join-Path $env:ProgramFiles 'nodejs\pnpm.cmd' }),
        $(if (${env:ProgramFiles(x86)}) { Join-Path ${env:ProgramFiles(x86)} 'nodejs\pnpm.cmd' })
    )

    $seen = @{}
    foreach ($candidate in $candidates) {
        if (-not $candidate -or -not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
        $key = $candidate.ToLowerInvariant()
        if ($seen.ContainsKey($key)) { continue }
        $seen[$key] = $true
        $candidate
    }
}

function Resolve-PnpmInvocation([string[]]$Arguments) {
    $fallbackShim = $null
    foreach ($shim in @(Find-PnpmApplications)) {
        if ([IO.Path]::GetExtension($shim) -ieq '.exe') {
            return [pscustomobject]@{ Command = $shim; Arguments = $Arguments }
        }
        if (-not $fallbackShim) { $fallbackShim = $shim }

        $shimDir = Split-Path -Parent $shim
        $packageRoots = @(
            (Join-Path $shimDir 'node_modules\pnpm'),
            (Join-Path (Split-Path -Parent $shimDir) 'pnpm')
        )
        foreach ($root in $packageRoots) {
            foreach ($name in $script:PnpmEntrypoints) {
                $entrypoint = Join-Path $root "bin\$name"
                if (-not (Test-Path -LiteralPath $entrypoint -PathType Leaf)) { continue }

                $nodeCandidates = @(
                    (Join-Path $shimDir 'node.exe'),
                    $(if ($env:ProgramW6432) { Join-Path $env:ProgramW6432 'nodejs\node.exe' }),
                    $(if ($env:ProgramFiles) { Join-Path $env:ProgramFiles 'nodejs\node.exe' }),
                    $(if (${env:ProgramFiles(x86)}) { Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe' })
                )
                $node = $nodeCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -First 1
                if (-not $node) { $node = 'node.exe' }
                return [pscustomobject]@{ Command = $node; Arguments = @($entrypoint) + $Arguments }
            }
        }
    }

    if (-not $fallbackShim) { return $null }
    $windowsRoot = if ($env:SystemRoot) { $env:SystemRoot } elseif ($env:WINDIR) { $env:WINDIR } else { 'C:\Windows' }
    $cmd = if ($env:ComSpec -and (Test-Path -LiteralPath $env:ComSpec -PathType Leaf)) {
        $env:ComSpec
    } else {
        Join-Path $windowsRoot 'System32\cmd.exe'
    }
    return [pscustomobject]@{ Command = $cmd; Arguments = @('/d', '/s', '/c', 'call', $fallbackShim) + $Arguments }
}

# Stderr de processo nativo e diagnostico, nunca falha — mas no Windows PowerShell 5.1 a
# primeira linha que chega por ele vira erro TERMINATIVO enquanto ErrorActionPreference=Stop,
# mesmo com 2>&1 (o mesmo caso que ja derrubava o probe do corepack mais abaixo). O pnpm
# escreve o proprio banner (`$ node scripts/runInstaller.mjs ...`) em stderr e o Equilotl,
# injetor atual do Equicord, loga TUDO em stderr: sem esta guarda a injecao morria em menos de
# um segundo com exit=-1 e "pos-condicao nao confirmada", sem nunca ter chamado o injetor
# (log do instalador na VM: installer.inject failure/POSTCONDITION_NOT_CONFIRMED com o banner
# do pnpm como unico detalhe). O codigo de saida continua sendo lido aqui e a pos-condicao
# segue autoridade sobre ele.
function Invoke-Pnpm([string[]]$Arguments) {
    $invocation = Resolve-PnpmInvocation $Arguments
    if (-not $invocation) {
        $script:PnpmExitCode = 127
        return
    }

    $command = $invocation.Command
    $commandArguments = @($invocation.Arguments)
    $anterior = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $command @commandArguments 2>&1
        $script:PnpmExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $anterior
    }
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

# =========================================================================== log local
# Observabilidade LOCAL do instalador (escopo B): eventos em installer.log (JSONL) no
# diretorio de dados existente. Nao ha POST, webhook ou telemetria — o usuario copia a
# saida do terminal ou abre o log manualmente. Falha de escrita NUNCA derruba a instalacao.
$script:InstallerLogMaxBytes = 256 * 1024
$script:InstallerComponent = 'installer.windows'
$script:InstallerOperationId = 'installer-' + ([guid]::NewGuid().ToString('N').Substring(0, 12))
$script:InstallerPhase = 'detect'
# Chave proibida vira <redacted>; chave fora da allowlist e descartada (fail-closed).
$script:InstallerForbiddenKey = '(?i)(password|senha|token|captcha|secret|private[_]?key|public[_]?key|authorization|cookie|session|credential|stdin|rawconfig|^config$|endpoint)'
$script:InstallerAllowedKeys = @(
    'mode', 'channel', 'permanent', 'we_injected', 'target_count', 'candidate_count', 'candidate_kind',
    'discord_count', 'mod_kind', 'reason', 'reason_code', 'result', 'exit_code',
    'duration_ms', 'path_present', 'path_kind', 'active', 'preserved', 'identity', 'count',
    # Contexto de um build que falhou (installer.build_context): versoes e estado do checkout, sem caminho.
    'pnpm_version', 'pnpm_esperado', 'node_version', 'node_modules', 'deps_sync', 'saida_vazia'
)

function Get-InstallerLogDir {
    if ($env:GLB_INSTALLER_LOG_DIR) { return $env:GLB_INSTALLER_LOG_DIR }
    return (Join-Path (Get-EffectiveLocalApp) 'GoLiveBypass')
}

function Get-InstallerLogFile { return (Join-Path (Get-InstallerLogDir) 'installer.log') }

function ConvertTo-InstallerSafeText([string]$value, [int]$max = 300) {
    # fail-closed: credenciais e caminhos pessoais nunca chegam ao log compartilhavel.
    $text = [string]$value
    if (-not $text) { return '' }
    $text = [regex]::Replace($text, '[\r\n\t]+', ' ')
    # Cabecalho de autenticacao consome o resto; token Bearer isolado tambem.
    $text = [regex]::Replace($text, '(?i)((?:proxy-)?authorization\s*:\s*)(?:\S+\s+)?\S+', '$1<redacted>')
    $text = [regex]::Replace($text, '(?i)(bearer\s+)\S+', '$1<redacted>')
    $text = [regex]::Replace($text, '(?i)\bmfa\.[A-Za-z0-9_-]{20,}', '<redacted>')
    $text = [regex]::Replace($text, '\b[A-Za-z0-9_-]{23,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{27,}\b', '<redacted>')
    # URL com credenciais: usuário, senha, host e path são privados.
    $text = [regex]::Replace($text, '(?i)\b[a-z][a-z0-9+.-]*://[^/\s@]+(?::[^/\s@]*)?@[^\s]+', '<redacted-url>')
    # E-mail.
    $text = [regex]::Replace($text, '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', '<email>')
    # chave=valor de credencial.
    $text = [regex]::Replace($text, '(?i)(password|senha|token|secret|private[_]?key|public[_]?key|authorization|cookie|session|credential|captchatoken|twofactorcode)\s*[:=]\s*\S+', '$1=<redacted>')
    # Caminhos: Windows, UNC e POSIX absoluto. As regras exigem fronteira/nao-barra
    # para nao destruir URL publica (https://...) nem o "s:/" do proprio scheme.
    $text = [regex]::Replace($text, '(?i)(^|[^A-Za-z0-9])[a-z]:[\\/][^\s]*', '$1<path>')
    $text = [regex]::Replace($text, '\\\\[^\s]+', '<path>')
    $text = [regex]::Replace($text, '(^|[\s:=])/[^/\s][^\s]*', '$1<path>')
    if ($text.Length -gt $max) { $text = $text.Substring(0, $max) }
    return $text
}

function ConvertTo-InstallerData($data) {
    $out = [ordered]@{}
    if ($null -eq $data) { return $out }
    foreach ($k in @($data.Keys)) {
        $key = [string]$k
        if ($key -match $script:InstallerForbiddenKey) { $out[$key] = '<redacted>'; continue }
        if ($script:InstallerAllowedKeys -notcontains $key) { continue }
        $value = $data[$k]
        if ($value -is [bool]) { $out[$key] = $value; continue }
        if ($value -is [int] -or $value -is [long] -or $value -is [double]) { $out[$key] = $value; continue }
        if ($value -is [System.Collections.IDictionary] -or ($value -is [System.Collections.IEnumerable] -and $value -isnot [string])) {
            # Objeto/lista nunca e stringificado: chave aninhada poderia carregar segredo.
            $out[$key] = '<redacted>'
            continue
        }
        $out[$key] = ConvertTo-InstallerSafeText ([string]$value)
    }
    return $out
}

function Trim-InstallerLogFile([string]$file) {
    if (-not (Test-Path -LiteralPath $file)) { return }
    $bytes = [IO.File]::ReadAllBytes($file)
    if ($bytes.Length -le $script:InstallerLogMaxBytes) { return }
    $keep = [int][Math]::Floor($script:InstallerLogMaxBytes / 2)
    $start = [Math]::Max(0, $bytes.Length - $keep)
    $tail = [Text.Encoding]::UTF8.GetString($bytes, $start, $bytes.Length - $start)
    $nl = $tail.IndexOf("`n")
    $tail = if ($nl -lt 0) { '' } else { $tail.Substring($nl + 1) }
    [IO.File]::WriteAllText($file, $tail, (New-Object System.Text.UTF8Encoding($false)))
}

function Write-InstallerEvent([string]$level, [string]$event, [string]$phase, $data = $null) {
    try {
        $record = [ordered]@{
            schema_version = 1
            ts             = ((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fff') + 'Z')
            level          = $level
            component      = $script:InstallerComponent
            event          = $event
            operation_id   = $script:InstallerOperationId
            phase          = $phase
            platform       = 'win32'
            arch           = $(if ($env:PROCESSOR_ARCHITECTURE) { [string]$env:PROCESSOR_ARCHITECTURE } else { 'unknown' })
            data           = (ConvertTo-InstallerData $data)
        }
        $line = ConvertTo-Json -InputObject $record -Compress -Depth 6
        $file = Get-InstallerLogFile
        $dir = Split-Path -Parent $file
        if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        $utf8 = New-Object System.Text.UTF8Encoding($false)
        Trim-InstallerLogFile $file
        [IO.File]::AppendAllText($file, $line + [Environment]::NewLine, $utf8)
        Trim-InstallerLogFile $file
    } catch {
        # Diagnostico nunca pode derrubar a instalacao.
    }
}
# =========================================================================== /log local

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

# O corepack cria o atalho do pnpm antes de saber que versao usar. Na primeira execucao ele
# busca essa versao no registro do npm e confere a assinatura com chaves embutidas nele; as
# chaves do corepack que vem no Node 22 estao velhas, entao o atalho existe e mesmo assim
# quebra com "Cannot find matching keyid". So testar se o comando existe nao prova nada.
$script:PnpmVersion = ''

function Test-Pnpm {
    # Um atalho do corepack existe mesmo quando nao funciona, entao a unica prova que vale e
    # executar o resolvedor real. A saida e capturada inteira antes de olhar o codigo.
    try { $found = @(Invoke-Pnpm @('--version') 2>$null) } catch { return $false }
    if ($script:PnpmExitCode -ne 0) { return $false }

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

function Test-TargetInjectedFromCheckout($root, $resources) {
    if (-not $root -or -not $resources) { return $false }
    $injected = Get-InjectedPath $resources
    if (-not $injected) { return $false }
    try {
        $normalizedRoot = [IO.Path]::GetFullPath($root).TrimEnd('\', '/')
        $normalizedInjected = [IO.Path]::GetFullPath($injected)
        return $normalizedInjected.Equals($normalizedRoot, [StringComparison]::OrdinalIgnoreCase) -or
            $normalizedInjected.StartsWith("$normalizedRoot\", [StringComparison]::OrdinalIgnoreCase)
    } catch {
        return $false
    }
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
    $discordCount = @(Get-DiscordResources).Count
    Write-InstallerEvent 'info' 'installer.discord_detected' 'detect' @{ discord_count = $discordCount }
    $installedMod = Get-InstalledMod
    if ($installedMod) { Write-InstallerEvent 'info' 'installer.mod_detected' 'detect' @{ mod_kind = $installedMod } }

    if ($Source) {
        Write-InstallerEvent 'info' 'installer.checkout_candidate' 'detect' @{ candidate_kind = 'source'; candidate_count = 1 }
        if (Test-ModCheckout $Source) {
            Write-InstallerEvent 'info' 'installer.selected' 'detect' @{ candidate_kind = 'source'; path_present = $true }
            return $Source
        }
        Write-InstallerEvent 'warn' 'installer.checkout_rejected' 'detect' @{ candidate_kind = 'source'; reason_code = 'SOURCE_NOT_A_CHECKOUT' }
        throw "Nao encontrei um checkout do Equicord ou Vencord em $Source"
    }

    Write-InstallerEvent 'info' 'installer.checkout_candidate' 'detect' @{ candidate_kind = 'injection' }
    $root = Find-CheckoutFromInjection
    if ($root) {
        Write-InstallerEvent 'info' 'installer.selected' 'detect' @{ candidate_kind = 'injection'; path_present = $true }
        Write-Ok "Achei pelo Discord: $root"
        return $root
    }

    Write-InstallerEvent 'info' 'installer.checkout_candidate' 'detect' @{ candidate_kind = 'disk' }
    $root = Find-CheckoutOnDisk
    if ($root) {
        Write-InstallerEvent 'info' 'installer.selected' 'detect' @{ candidate_kind = 'disk'; path_present = $true }
        Write-Ok "Achei no disco: $root"
        return $root
    }

    # Mod detectado sem checkout provado (#293): o caminho nao substitui app.asar; a
    # distincao fica por codigo, sem levar caminho pessoal ao log.
    $reasonCode = if ($installedMod) { 'MOD_INSTALLED_WITHOUT_CHECKOUT' } else { 'CHECKOUT_NOT_FOUND' }
    Write-InstallerEvent 'warn' 'installer.checkout_rejected' 'detect' @{ reason_code = $reasonCode; mod_kind = [string]$installedMod }
    return $null
}

function Test-InjectedFromCheckout($root) {
    if (-not $root) { return $false }
    foreach ($resources in Get-DiscordResources) {
        if (Test-TargetInjectedFromCheckout $root $resources) { return $true }
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
    $existingInjection = Get-InjectedPath $resources
    if ($existingInjection) {
        Write-InstallerEvent 'warn' 'installer.preserved' 'inject' @{ reason_code = 'PARALLEL_ALREADY_PATCHED'; target_count = 1 }
        $motivo = "$nome ja tem um patch em $existingInjection; app.asar e _app.asar foram preservados."
        Write-Warn $motivo
        return [pscustomobject]@{ Ok = $false; Motivo = $motivo }
    }
    $backup = Join-Path $resources '_app.asar'
    if (-not (Test-Path -LiteralPath $backup) -and (Test-Path -LiteralPath $appAsar)) {
        Copy-Item -LiteralPath $appAsar -Destination $backup
        Write-Ok "Backup criado em $backup"
    }
    Copy-Item -LiteralPath $asar -Destination $appAsar -Force
    Write-Ok "$nome patcheado: $appAsar"
    return [pscustomobject]@{ Ok = $true; Motivo = '' }
}

# ---------------------------------------------------------------- restauracao de cliente
#
# Copy-PatchParallel troca o app.asar do cliente paralelo pelo dist\<cliente>.asar do checkout e
# guarda o original em _app.asar. Se o checkout, o build ou a versao do mod mudarem depois, o
# cliente fica sem abrir -- e nao havia caminho de volta: Uninstall/Restore removiam o userplugin
# e recompilavam, deixando o app.asar patchado no lugar. Estas funcoes devolvem o original.

function Get-ClientLabel($resources) {
    switch -Regex ($resources) {
        '(?i)equibop' { return 'Equibop' }
        '(?i)vesktop' { return 'Vesktop' }
        '(?i)legcord' { return 'Legcord' }
        default       { return 'Discord' }
    }
}

function Test-AsarContainsMark($path) {
    # O build do mod feito com o GoLiveBypass dentro carrega o nome do plugin; o stub do
    # Vencord/Equicord (so um require, <64 KB) nunca casa.
    if (-not (Test-Path -LiteralPath $path)) { return $false }
    try {
        $bytes = [System.IO.File]::ReadAllBytes($path)
        # Latin-1 mapeia byte a byte (sem perder posicoes como o UTF-8 faria) e o IndexOf roda
        # em codigo nativo: varrer 16 MB de asar em script levaria minutos.
        $text = [System.Text.Encoding]::GetEncoding(28591).GetString($bytes)
        return $text.IndexOf('GoLiveBypass', [System.StringComparison]::Ordinal) -ge 0
    } catch {
        return $false
    }
}

function Get-ClientAsarState($resources) {
    # Rotulos estaveis (menu, log e suporte):
    #   golive       patch do GoLiveBypass (copia do dist do checkout)
    #   mod-quebrado stub do Vencord/Equicord com alvo ausente -> o cliente nao abre
    #   mod          stub do Vencord/Equicord funcionando (nao e nosso; so com -Force)
    #   outro        tem _app.asar mas o app.asar atual nao e reconhecido
    #   vanilla      sem _app.asar: nunca foi injetado
    #   ausente      sem app.asar nesse resources
    $app = Join-Path $resources 'app.asar'
    $backup = Join-Path $resources '_app.asar'
    if (-not (Test-Path -LiteralPath $app)) {
        if (Test-Path -LiteralPath $backup) { return 'outro' }
        return 'ausente'
    }
    if (Test-AsarContainsMark $app) { return 'golive' }
    $injected = Get-InjectedPath $resources
    if ($injected) {
        if (Test-Path -LiteralPath $injected) { return 'mod' }
        return 'mod-quebrado'
    }
    if (Test-Path -LiteralPath $backup) { return 'outro' }
    return 'vanilla'
}

function Get-ClientStateLabel($state) {
    switch ($state) {
        'golive'       { return 'patch do GoLiveBypass (revertivel)' }
        'mod-quebrado' { return 'injecao QUEBRADA: o alvo do require nao existe, o cliente nao abre' }
        'mod'          { return 'mod Vencord/Equicord funcionando' }
        'outro'        { return 'patch de outro programa (nao mexemos sem -Force)' }
        'vanilla'      { return 'original, sem injecao' }
        default        { return 'sem app.asar nesse diretorio' }
    }
}

function Restore-ClientAsar($resources, $label, [switch]$Force) {
    $app = Join-Path $resources 'app.asar'
    $backup = Join-Path $resources '_app.asar'
    $state = Get-ClientAsarState $resources

    switch ($state) {
        'golive' { }
        'mod-quebrado' { Write-Warn "$label : a injecao do mod aponta para um alvo que nao existe mais; devolvendo o original." }
        'mod' {
            if (-not $Force) {
                Write-Warn "$label : o mod Vencord/Equicord esta funcionando; restaurar tiraria o mod deste cliente. Use -Force se e isso mesmo."
                Write-InstallerEvent 'warn' 'installer.client_restore' 'restore' @{ reason_code = 'MOD_FUNCIONANDO'; target_count = 1 }
                return $false
            }
        }
        'outro' {
            if (-not $Force) {
                Write-Warn "$label : o app.asar atual nao e um patch reconhecido do GoLiveBypass. Use -Force para devolver o backup mesmo assim."
                Write-InstallerEvent 'warn' 'installer.client_restore' 'restore' @{ reason_code = 'PATCH_DESCONHECIDO'; target_count = 1 }
                return $false
            }
        }
        'vanilla' {
            Write-Warn "$label : o app.asar ja e o original; nada para restaurar."
            return $false
        }
        default {
            Write-Warn "$label : nao encontrei app.asar em $resources."
            return $false
        }
    }

    if (-not (Test-Path -LiteralPath $backup)) {
        Write-Warn "$label : nao ha backup _app.asar; sem ele nao da para devolver o original automaticamente."
        Write-InstallerEvent 'warn' 'installer.client_restore' 'restore' @{ reason_code = 'BACKUP_AUSENTE'; target_count = 1 }
        return $false
    }

    Write-InstallerEvent 'info' 'installer.client_restore' 'restore' @{ reason_code = $state; target_count = 1 }

    # Preserva o patch atual: se o cliente voltar a precisar do mod, o arquivo fica ali.
    try { Copy-Item -LiteralPath $app -Destination "$app.golive-patched.bak" -Force } catch { }

    # Copia para um temporario no MESMO diretorio e so entao troca: um erro no meio nao deixa o
    # cliente sem app.asar nenhum.
    try {
        Copy-Item -LiteralPath $backup -Destination "$app.restore.tmp" -Force
        $hashTmp = (Get-FileHash -LiteralPath "$app.restore.tmp" -Algorithm SHA256).Hash
        $hashBackup = (Get-FileHash -LiteralPath $backup -Algorithm SHA256).Hash
        if ($hashTmp -ne $hashBackup) {
            Remove-Item -LiteralPath "$app.restore.tmp" -Force -ErrorAction SilentlyContinue
            Write-Warn "$label : a copia de restauracao saiu diferente do backup; nao toquei no app.asar."
            return $false
        }
        Move-Item -LiteralPath "$app.restore.tmp" -Destination $app -Force
    } catch {
        Write-Warn "$label : falhei ao devolver o app.asar ($($_.Exception.Message))."
        return $false
    }

    if ((Get-FileHash -LiteralPath $app -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $backup -Algorithm SHA256).Hash) {
        Write-Warn "$label : o app.asar restaurado nao confere com o backup; o _app.asar foi preservado."
        return $false
    }

    # O backup cumpriu o papel; sai do caminho para o proximo install criar um limpo.
    Move-Item -LiteralPath $backup -Destination "$resources\_app.asar.restaurado.bak" -Force -ErrorAction SilentlyContinue

    Write-Ok "$label : app.asar original restaurado (patch anterior em app.asar.golive-patched.bak)"
    Write-InstallerEvent 'info' 'installer.client_restore' 'done' @{ reason_code = $state; target_count = 1 }
    return $true
}

function Show-ClientStates {
    $seen = 0
    foreach ($resources in Get-DiscordResources) {
        if (-not $resources) { continue }
        $label = Get-ClientLabel $resources
        $state = Get-ClientAsarState $resources
        Write-Host ("    {0,-9} {1}" -f $label, (Get-ClientStateLabel $state)) -ForegroundColor DarkGray
        Write-Host ("      {0}" -f $resources) -ForegroundColor DarkGray
        $seen++
    }
    if ($seen -eq 0) { Write-Host '    nenhum cliente encontrado' -ForegroundColor DarkGray }
}

function Invoke-RestoreClient($alvo = '') {
    $alvo = "$alvo".Trim().ToLowerInvariant()
    $alvos = @()
    foreach ($resources in Get-DiscordResources) {
        if (-not $resources) { continue }
        $label = Get-ClientLabel $resources
        $state = Get-ClientAsarState $resources
        if ($state -eq 'vanilla' -or $state -eq 'ausente') { continue }
        if ($alvo -and -not $label.ToLowerInvariant().StartsWith($alvo)) { continue }
        $alvos += , @{ Resources = $resources; Label = $label }
    }

    if ($alvos.Count -eq 0) {
        Write-Warn 'Nenhum cliente com injecao ou backup para restaurar.'
        return
    }

    # O app.asar restaurado so vale no proximo inicio, e deixar o cliente aberto rodando o patch
    # antigo confunde o diagnostico.
    Stop-Discord
    $algum = $false
    foreach ($item in $alvos) {
        if (Restore-ClientAsar $item.Resources $item.Label -Force:$Force) { $algum = $true }
    }
    Start-Discord
    if (-not $algum) { throw 'Nenhum cliente pode ser restaurado com os argumentos dados.' }
}

function Update-ParallelPatches($root) {
    # Depois de remover o userplugin, um cliente paralelo continuaria rodando o build antigo (que
    # ainda tem o GoLiveBypass dentro): recopia o asar recem-buildado, quando ele existir.
    if (-not $root) { return }
    $mod = Get-CheckoutMod $root
    foreach ($resources in Get-DiscordResources) {
        if (-not $resources) { continue }
        if ($resources -notmatch '(?i)equibop|vesktop|legcord') { continue }
        $app = Join-Path $resources 'app.asar'
        if (-not (Test-AsarContainsMark $app)) { continue }
        $label = Get-ClientLabel $resources
        $asarName = $ParallelAsarPorMod[$mod][$label]
        if (-not $asarName) {
            Write-Warn "$label : patch antigo preservado (o checkout $mod nao gera build para ele)."
            continue
        }
        $asar = Join-Path $root "dist\$asarName"
        if (-not (Test-Path -LiteralPath $asar)) {
            Write-Warn "$label : rode 'pnpm build' em $root e reinstale para tirar o plugin do cliente."
            continue
        }
        try {
            Copy-Item -LiteralPath $asar -Destination $app -Force
            Write-Ok "$label : patch atualizado com o build sem o plugin."
        } catch {
            Write-Warn "$label : nao consegui atualizar o patch; o cliente segue com o build antigo."
        }
    }
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
    $script:InstallerPhase = 'preparing'
    Write-InstallerEvent 'info' 'installer.selected' 'preparing' @{ mode = 'download'; mod_kind = $choice; path_present = $true }

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

# O Update.exe (Squirrel) mora na raiz da instalacao do Discord e e ele quem reabre o
# cliente depois que o processo morre. Sem fecha-lo, o injetor encontra o app.asar em uso
# no meio do unpatch (Equilotl: "Discord's files are used by a different process") e o
# cliente pode ficar sem o mod. Outros Update.exe (Vesktop, Equibop, apps de terceiros)
# tem outro caminho e nao entram aqui.
function Get-DiscordUpdaterProcesses {
    $raizes = @()
    $localApp = Get-EffectiveLocalApp
    foreach ($base in @($localApp, $env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:ProgramW6432)) {
        if (-not $base) { continue }
        foreach ($nome in $DiscordNames) { $raizes += (Join-Path $base $nome) }
    }
    $raizes = @($raizes | Where-Object { $_ -and (Test-Path -LiteralPath $_) })
    if ($raizes.Count -eq 0) { return @() }

    $achados = @()
    foreach ($proc in @(Get-Process -Name 'Update' -ErrorAction SilentlyContinue)) {
        $caminho = $null
        try { $caminho = $proc.Path } catch { }
        if (-not $caminho) { continue }
        foreach ($raiz in $raizes) {
            if ($caminho.StartsWith($raiz + '\', [StringComparison]::OrdinalIgnoreCase)) { $achados += $proc; break }
        }
    }
    return $achados
}

function Get-DiscordProcesses {
    return @(@(Get-Process -Name $DiscordNames -ErrorAction SilentlyContinue) + @(Get-DiscordUpdaterProcesses) | Where-Object { $_ })
}

function Stop-DiscordProcesses($processos) {
    foreach ($proc in @($processos)) {
        if ($proc) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    }
}

# Processo morto nao devolve o handle na hora, e um updater pode reabrir o cliente no meio
# do caminho. Abrir o arquivo sem compartilhamento e a mesma prova que o injetor precisa
# para gravar: se falha, o Equilotl vai falhar logo depois com "files are used by a
# different process" — melhor descobrir antes de desfazer o patch do cliente.
function Test-ArquivoLivre([string]$caminho) {
    if (-not $caminho -or -not (Test-Path -LiteralPath $caminho)) { return $true }
    try {
        $fluxo = [IO.File]::Open($caminho, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        $fluxo.Close()
        return $true
    } catch {
        return $false
    }
}

function Get-DiscordResourcesTravados($resources) {
    $travados = @()
    foreach ($item in @($resources)) {
        if (-not $item) { continue }
        foreach ($nome in @('app.asar', '_app.asar')) {
            $arquivo = Join-Path $item $nome
            if ((Test-Path -LiteralPath $arquivo) -and -not (Test-ArquivoLivre $arquivo)) { $travados += $arquivo }
        }
    }
    return $travados
}

function Stop-Discord {
    [CmdletBinding()]
    param(
        # Recursos que vao ser injetados: alem de fechar os processos, espera a trava de
        # app.asar sair antes de deixar o injetor trabalhar.
        [string[]] $Resources = @(),
        [int] $TentativasProcessos = 30,
        [int] $TentativasTravas = 20
    )

    $processos = Get-DiscordProcesses
    if ($processos.Count -gt 0) {
        Write-Step 'Fechando o Discord'
        Stop-DiscordProcesses $processos
    }

    for ($i = 0; $i -lt $TentativasProcessos; $i++) {
        Start-Sleep -Milliseconds 300
        $processos = Get-DiscordProcesses
        if ($processos.Count -eq 0) { break }
        Stop-DiscordProcesses $processos
    }
    if ((Get-DiscordProcesses).Count -gt 0) {
        throw 'O Discord nao fechou. Feche pelo icone na bandeja e rode de novo.'
    }

    if (@($Resources).Count -eq 0) { return }

    for ($i = 0; $i -lt $TentativasTravas; $i++) {
        $travados = Get-DiscordResourcesTravados $Resources
        if ($travados.Count -eq 0) { return }
        $processos = Get-DiscordProcesses
        if ($processos.Count -gt 0) { Stop-DiscordProcesses $processos }
        Start-Sleep -Milliseconds 500
    }

    $travados = Get-DiscordResourcesTravados $Resources
    if ($travados.Count -gt 0) {
        $lista = (@($travados) | Select-Object -First 3) -join ', '
        throw "Os arquivos do Discord continuam em uso ($lista). Feche o Discord pelo icone da bandeja, confirme no Gerenciador de Tarefas que nao sobrou nem 'Discord' nem 'Update' e rode de novo."
    }
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

    # 2. O helper e binario e nao pode ser obtido por raw.githubusercontent.com.
    # O canal escolhido decide a release do helper quando a fonte local nao o traz.
    $asset = Get-LatestBetaHelperAsset
    if (-not $asset) {
        throw "Nao encontrei o helper proton-confgen do canal $script:SelectedChannel. Use um pacote de release ou -PluginSource com bin\win32-x64\proton-confgen.exe."
    }

    $temporary = Join-Path $env:TEMP ("golivebypass-proton-confgen-{0}.exe" -f ([guid]::NewGuid().ToString('N')))
    try {
        Write-Step "Baixando helper Proton do canal $script:SelectedChannel ($($asset.Tag))"
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
function Assert-PluginSourceTree($target) {
    if (-not $target) { throw 'Destino invalido para a fonte do plugin.' }
    foreach ($file in $PluginFiles) {
        $leaf = Split-Path -Leaf $file
        $candidate = Join-Path $target $leaf
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            throw "Arquivo obrigatorio do plugin ausente: $leaf."
        }
        $item = Get-Item -LiteralPath $candidate
        if ($item.Length -le 0) {
            throw "Arquivo obrigatorio do plugin vazio: $leaf."
        }
    }
}

function Copy-PluginFromRepo($root) {
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
        if (-not (Test-Path -LiteralPath $local -PathType Leaf)) { throw "Nao achei $leaf em $PluginSource." }
        Copy-Item -LiteralPath $local -Destination (Join-Path $target $leaf) -Force
    }

    # Nunca compilar uma arvore parcial: um arquivo ausente ou vazio deve interromper a
    # instalacao explicitamente, em vez de reutilizar um modulo stale no destino.
    Assert-PluginSourceTree $target
    Copy-PluginHelper $target

    if ($PluginSource -and -not [string]::IsNullOrWhiteSpace($PluginSource)) {
        Write-Warn "Plugin copiado de $PluginSource, e nao do GitHub."
    }
}


# De onde vem o plugin instalado. A fonte normal e uma release validada pelo canal.
function Install-PluginSource($root) {
    if ($PluginSource -and -not [string]::IsNullOrWhiteSpace($PluginSource)) {
        Copy-PluginFromRepo $root
        return
    }

    if ($PSScriptRoot) {
        $parent = Split-Path -Parent $PSScriptRoot
        if ($parent -and (Test-Path -LiteralPath (Join-Path $parent "$PluginDirName\index.tsx"))) {
            Write-Step 'Usando o checkout do repositorio que esta ao lado do instalador'
            Copy-PluginFromRepo $root
            return
        }
    }

    $release = Get-PluginInstallRelease $script:SelectedChannel
    if (-not $release) {
        throw "Nao encontrei uma release $script:SelectedChannel valida com zip e SHA-256; ela pode estar ausente, em metadata incoerente ou indisponivel por rede/rate limit. Use -PluginSource com uma fonte local explicita."
    }
    Write-Step "Instalando o plugin da release $($release.Version) (canal $script:SelectedChannel)"
    Invoke-UpdateFromZip $root $release.AssetUrl $release.Version $release.ShaUrl
}
# O script de build do Vencord/Equicord depende do Git por dentro: "git rev-parse HEAD"
# (common.mjs) e "git remote get-url origin" (git-remote-plugin do UserAgent) rodam no
# meio do build e o Node explode com um stack criptico quando o Git nao esta no PATH, o
# checkout nao tem historico, o repositorio esta quebrado ou veio de zip do GitHub (que
# nao traz nada disso). Rodar os dois comandos aqui custa milissegundos e troca um muro
# de stack trace por uma frase do que fazer.
function Find-GitApplication {
    return (Get-Command 'git' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1)
}

# Costura do teste: roda um comando git sem deixar o stderr dele virar erro terminativo
# (o mesmo caso do Invoke-Pnpm) e devolve se o codigo de saida foi zero.
function Test-GitComandoOk([string]$GitSource, [string[]]$GitArgs) {
    $anterior = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $GitSource @GitArgs 2>$null | Out-Null
        return ($LASTEXITCODE -eq 0)
    } finally {
        $ErrorActionPreference = $anterior
    }
}

function Assert-CheckoutBuildPreReqs($root) {
    $git = Find-GitApplication
    if (-not $git) {
        throw "Para compilar o mod, o Git precisa estar instalado e no PATH: o build dele roda 'git rev-parse' e 'git remote get-url origin'. Instale o Git (https://git-scm.com/download/win), abra uma janela nova do instalador e tente de novo."
    }
    if (-not (Test-Path -LiteralPath (Join-Path $root '.git'))) {
        throw "O checkout do mod em $root nao tem historico do Git (.git ausente) e o build dele roda 'git rev-parse' e 'git remote get-url origin', que falham sem isso. Baixe o checkout com 'git clone' (ou pelo GitHub Desktop) e selecione essa pasta."
    }
    if (-not (Test-GitComandoOk $git.Source @('-C', $root, 'rev-parse', 'HEAD'))) {
        throw "O checkout do mod em $root e um repositorio Git quebrado ('git rev-parse HEAD' falhou). Faca um 'git clone' novo e selecione essa pasta."
    }
    if (-not (Test-GitComandoOk $git.Source @('-C', $root, 'remote', 'get-url', 'origin'))) {
        throw "O checkout do mod em $root nao tem o remote 'origin' ('git remote get-url origin' falhou) e o build dele precisa dele. Faca um 'git clone' novo e selecione essa pasta."
    }
}

# O build/install falha por motivo do proprio checkout (git ausente, entrypoint quebrado
# do pnpm, erro do esbuild) e o relato dizia apenas "pnpm build falhou", sem nenhuma linha
# do erro real. Manda junto o fim da saida do pnpm, sanitizado como o detalhe da injecao.
function Format-PnpmDetail($saida) {
    $ansi = [char]27 + '\[[0-9;]*[A-Za-z]'
    $linhas = @(@($saida) |
        ForEach-Object { ([string]$_) -replace $ansi, '' } |
        Where-Object { ($_ -replace '\s+', ' ').Trim() } |
        Select-Object -Last 10)
    $text = ($linhas -join ' | ') -replace '\s+', ' '
    # Vazio nao pode virar "falhou (exit=1): " e nada mais: o relato parecia cortado pela pessoa.
    # Sair calado e um sintoma em si (prompt que o pnpm nao conseguiu mostrar, por exemplo).
    if (-not $text.Trim()) { return '(o pnpm saiu sem nenhuma mensagem; rode "pnpm build" na pasta do mod para ver o erro)' }
    return ConvertTo-InstallerSafeText $text.Trim() 600
}

# O que um "pnpm build falhou" precisa para ser entendido sem perguntar nada: versao do pnpm em uso
# contra a que o projeto pede, versao do node e se o node_modules existia. No relato do Equicord
# atualizado (verifyDepsBeforeRun) o log trazia so "exit=1" e o resto teve de ser reproduzido.
function Get-ModBuildContext($root) {
    $ctx = [ordered]@{
        pnpm_version = [string]$script:PnpmVersion
        node_modules = [bool](Test-Path -LiteralPath (Join-Path $root 'node_modules'))
    }
    try {
        $pkg = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw -ErrorAction Stop | ConvertFrom-Json
        if ($pkg.packageManager) { $ctx.pnpm_esperado = [string]$pkg.packageManager }
    } catch {}
    try {
        $node = Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1
        $ctx.node_version = [string](& $node.Source --version 2>$null | Select-Object -First 1)
    } catch {}
    return $ctx
}

# O Equicord liga `verifyDepsBeforeRun: prompt` no pnpm-workspace.yaml. Depois que o checkout
# muda (git pull, updater do proprio mod) e o node_modules fica fora de sincronia com o lockfile,
# o `pnpm build` tenta perguntar "rodar install?". Com a saida canalizada pelo instalador num
# console de verdade, ele morre com exit 1 em ~50 ms sem escrever nada alem do WARN de versao
# do pnpm: o relato chegava como "pnpm build falhou (exit=1): " vazio, todas as vezes. Instalar
# so quando o node_modules faltava deixava esse checkout preso. Sincronizar antes de todo build
# custa quase nada quando ja esta em dia. --frozen-lockfile nao reescreve o pnpm-lock.yaml do
# checkout (o updater do mod faz git pull nele); o install comum fica de reserva para quando o
# lockfile nao bate com o package.json. confirm-modules-purge=false evita o outro prompt do
# pnpm (recriar o node_modules feito por outra versao), que travaria do mesmo jeito.
# Devolve $null quando deu certo, ou a mensagem de falha com o fim da saida do pnpm.
function Sync-ModDeps($root) {
    if (Test-Path -LiteralPath (Join-Path $root 'node_modules')) {
        Write-Step 'Conferindo as dependencias do mod'
    } else {
        Write-Step 'Instalando dependencias (na primeira vez demora alguns minutos)'
    }
    $saidaInstall = @()
    Invoke-Pnpm @('install', '--frozen-lockfile', '--config.confirm-modules-purge=false') | Tee-Object -Variable saidaInstall | Out-Host
    if ($script:PnpmExitCode -eq 0) { return $null }
    $saidaInstall = @()
    Invoke-Pnpm @('install', '--config.confirm-modules-purge=false') | Tee-Object -Variable saidaInstall | Out-Host
    if ($script:PnpmExitCode -eq 0) { return $null }
    return "pnpm install falhou (exit=$($script:PnpmExitCode)): $(Format-PnpmDetail $saidaInstall)"
}

function Build-Mod($root) {
    if (-not $root) { throw 'Caminho do checkout invalido para compilar o mod.' }
    $script:InstallerPhase = 'build'
    Write-InstallerEvent 'info' 'installer.build' 'build' @{ mod_kind = (Get-CheckoutMod $root) }
    Assert-CheckoutBuildPreReqs $root
    Push-Location -LiteralPath $root
    try {
        $falhaDeps = Sync-ModDeps $root
        if ($falhaDeps) {
            $ctx = Get-ModBuildContext $root
            $ctx.deps_sync = 'falhou'
            Write-InstallerEvent 'error' 'installer.build_context' 'build' $ctx
            throw $falhaDeps
        }

        Write-Step 'Compilando'
        $saidaBuild = @()
        Invoke-Pnpm @('build') | Tee-Object -Variable saidaBuild | Out-Host
        if ($script:PnpmExitCode -ne 0) {
            $exitBuild = $script:PnpmExitCode
            $detalhe = Format-PnpmDetail $saidaBuild
            $ctx = Get-ModBuildContext $root
            $ctx.deps_sync = 'ok'
            $ctx.exit_code = $exitBuild
            $ctx.saida_vazia = [bool]($detalhe -like '(o pnpm saiu sem nenhuma mensagem*')
            Write-InstallerEvent 'error' 'installer.build_context' 'build' $ctx
            throw "pnpm build falhou (exit=$exitBuild): $detalhe"
        }
    } finally {
        Pop-Location
    }
}
function Remove-PluginSource($root) {
    $target = Join-Path $root "src\userplugins\$PluginDirName"
    if (-not (Test-Path -LiteralPath $target)) { return }
    Write-Step 'Removendo apenas o plugin GoLiveBypass'
    Remove-CaminhoSilencioso $target
    Push-Location -LiteralPath $root
    try {
        $falhaDeps = Sync-ModDeps $root
        if ($falhaDeps) { Write-Warn $falhaDeps }
        $saidaBuild = @()
        Invoke-Pnpm @('build') | Tee-Object -Variable saidaBuild | Out-Host
        if ($script:PnpmExitCode -ne 0) { Write-Warn "Nao consegui recompilar o mod sem o GoLiveBypass (exit=$($script:PnpmExitCode)): $(Format-PnpmDetail $saidaBuild)" }
    } finally {
        Pop-Location
    }
}

function Format-InjectionDetail($value) {
    $text = (@($value) | ForEach-Object { [string]$_ }) -join ' '
    $text = ($text -replace '\s+', ' ').Trim()
    $text = ConvertTo-InstallerSafeText $text 600
    if ($text.Length -gt 600) { return $text.Substring(0, 600) + '...' }
    return $text
}
function Invoke-Injection($root, $targets) {
    if (-not $root) { throw 'Caminho do checkout invalido para injetar o mod.' }
    Push-Location -LiteralPath $root
    try {
        $script:InstallerPhase = 'inject'
        Write-InstallerEvent 'info' 'installer.inject' 'inject' @{ result = 'started'; target_count = @($targets).Count }
        # A trava de app.asar e conferida antes de qualquer unpatch: o Equilotl desfaz o
        # patch atual antes de aplicar o novo, e um arquivo em uso no meio disso deixa o
        # cliente sem o mod.
        Stop-Discord -Resources @(@($targets) | ForEach-Object { $_.Resources })
        $falha = $false
        # Detalhe por alvo: sem isto o relato automatico chegava so com a mensagem
        # generica e o log do RUNTIME (que nada diz sobre a injecao) -- issue #120.
        $detalhes = [System.Collections.Generic.List[string]]::new()
        foreach ($t in @($targets)) {
            if ($t.Tipo -eq 'P') {
                $resultado = Copy-PatchParallel $root $t.Resources
                if (-not $resultado.Ok) {
                    $falha = $true
                    $detalhes.Add("cliente paralelo ($($t.Resources)): $($resultado.Motivo)")
                }
                continue
            }
            Write-Step "Injetando no $($t.Flavour)"
            # O --location espera a RAIZ da instalacao (...\Discord), nao o app-1.0.x.
            $loc = Split-Path -Parent (Split-Path -Parent $t.Resources)
            $tentativa = 0
            while ($true) {
                $tentativa++
                $script:PnpmExitCode = $null
                $saida = @()
                $excecao = $null
                try {
                    # O pnpm recebe os argumentos do script diretamente; o separador -- extra
                    # fazia alguns wrappers repassarem --location como argumento posicional.
                    # O Invoke-Pnpm ja junta o stderr na propria saida; aqui so capturamos tudo
                    # para o detalhe do erro que vira POSTCONDITION_NOT_CONFIRMED.
                    $saida = @(Invoke-Pnpm @('run', 'inject', '--location', $loc))
                } catch {
                    $excecao = $_.Exception.Message
                    if ($null -eq $script:PnpmExitCode) { $script:PnpmExitCode = -1 }
                }
                # Exit code e diagnostico, nao autoridade: o stub deste alvo precisa apontar
                # para o checkout selecionado, sem permitir que outro Discord aprove este.
                $confirmado = Test-TargetInjectedFromCheckout $root $t.Resources
                $detalhe = Format-InjectionDetail @($saida, $excecao)
                if ($confirmado) { break }
                # O Equilotl avisa que o arquivo esta em uso e desfaz o patch antes de tentar:
                # o Discord pode ter sido reaberto pelo updater entre o Stop-Discord e o
                # injetor. Fecha tudo de novo (agora esperando a trava sair) e repete UMA vez.
                if ($tentativa -lt 2 -and ($detalhe -match 'used by a different process|already patched\. Unpatching first')) {
                    Write-Warn 'O injetor achou arquivo do Discord em uso; vou fechar de novo e repetir uma vez.'
                    Stop-Discord -Resources @($t.Resources)
                    continue
                }
                break
            }
            if (-not $confirmado) {
                $falha = $true
                $motivo = "pos-condicao nao confirmada (exit=$($script:PnpmExitCode))"
                if ($detalhe) { $motivo += ": $detalhe" }
                $detalhes.Add("$($t.Flavour): $motivo")
                Write-InstallerEvent 'error' 'installer.inject' 'inject' @{
                    result = 'failure'
                    reason_code = 'POSTCONDITION_NOT_CONFIRMED'
                    exit_code = if ($null -eq $script:PnpmExitCode) { -1 } else { [int]$script:PnpmExitCode }
                }
                continue
            }
            if ($excecao -or ($null -ne $script:PnpmExitCode -and $script:PnpmExitCode -ne 0)) {
                $motivo = "injecao confirmada pela pos-condicao apesar de exit=$($script:PnpmExitCode)"
                if ($detalhe) { $motivo += ": $detalhe" }
                Write-InstallerEvent 'warn' 'installer.inject' 'inject' @{
                    result = 'warning'
                    reason_code = 'POSTCONDITION_CONFIRMED_NONZERO'
                    exit_code = [int]$script:PnpmExitCode
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
    [void](Select-UpdateChannel $root)
    Write-InstallerEvent 'info' 'installer.selected' 'preparing' @{ mode = 'install'; mod_kind = (Get-CheckoutMod $root); path_present = $true; channel = $script:SelectedChannel }
    $permanent = Select-Persistence

    Install-Toolchain $false
    Install-PluginSource $root
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

    # Nos injetamos = havia alvo pendente entre os escolhidos. Esta gravacao e o que o modo
    # temporario le no fim da funcao: sem ela $weInjected fica nulo, o instalador cai sempre
    # no aviso de "ja estava injetado" e a injecao sobrevive ao fechamento do Discord — o
    # modo temporario virava permanente. (perdida no commit da multi-selecao de alvos)
    $weInjected = $oficialPendente -or $paralelos.Count -gt 0
    if ($weInjected) {
        Invoke-Injection $root $targets
    } else {
        Write-Step 'O Discord ja carrega deste checkout, so reiniciando'
        Stop-Discord
    }

    # Com o Discord fechado: aberto, ele regrava o settings.json a partir da memoria e
    # apaga o que escrevemos aqui.
    Set-PluginSettings $root

    Start-Discord

    $script:InstallerPhase = 'completed'
    Write-InstallerEvent 'info' 'installer.completed' 'completed' @{ permanent = [bool]$permanent; we_injected = [bool]$weInjected; channel = $script:SelectedChannel }

    Write-Host ''
    Write-Ok 'Pronto. O plugin ja vem ativado, nao precisa mexer em nada.'
    Write-Host '  Na primeira ativacao o plugin pede a conta Proton, dentro do Discord.' -ForegroundColor DarkGray
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
    # Cliente paralelo patchado continuaria rodando o build antigo, que ainda tem o plugin
    # dentro: atualiza o patch com o build recem-saido (sem o plugin).
    Update-ParallelPatches $root
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
function Get-PersistedUpdateChannel($root) {
    if (-not $root) { return $null }
    $file = Get-ModSettingsFile $root
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return $null }
    try {
        $settings = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
        $value = $settings.plugins.GoLiveBypass.updateChannel
        if ($value -eq 'stable' -or $value -eq 'beta') { return [string]$value }
    } catch { }
    return $null
}

function Set-UpdateChannelPreference($root, [string]$channel) {
    if (-not $root -or $channel -notin @('stable', 'beta')) { return $false }
    $file = Get-ModSettingsFile $root
    $settings = $null
    if (Test-Path -LiteralPath $file -PathType Leaf) {
        try { $settings = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json }
        catch {
            Write-Warn "Nao consegui ler $file; a preferencia do canal nao foi alterada."
            return $false
        }
    }
    if ($null -eq $settings -or $settings -is [array] -or $settings -is [string]) { $settings = [pscustomobject]@{} }
    if (-not $settings.PSObject.Properties['plugins'] -or $null -eq $settings.plugins -or $settings.plugins -is [array] -or $settings.plugins -is [string]) {
        $settings | Add-Member -NotePropertyName plugins -NotePropertyValue ([pscustomobject]@{}) -Force
    }
    $plugin = if ($settings.plugins.PSObject.Properties['GoLiveBypass'] -and $settings.plugins.GoLiveBypass -isnot [array] -and $settings.plugins.GoLiveBypass -isnot [string]) {
        $settings.plugins.GoLiveBypass
    } else { [pscustomobject]@{} }
    $plugin | Add-Member -NotePropertyName updateChannel -NotePropertyValue $channel -Force
    $settings.plugins | Add-Member -NotePropertyName GoLiveBypass -NotePropertyValue $plugin -Force
    try {
        Save-Text $file ($settings | ConvertTo-Json -Depth 100)
        return $true
    } catch {
        Write-Warn "Nao consegui salvar a preferencia do canal em $file."
        return $false
    }
}

function Select-UpdateChannel($root) {
    if ($script:ChannelExplicit) { $script:SelectedChannel = $Channel; return $Channel }
    $persisted = Get-PersistedUpdateChannel $root
    $interactive = $false
    try { $interactive = -not [Console]::IsInputRedirected -and -not [Console]::IsOutputRedirected } catch { }
    if ($Yes -or -not $interactive) {
        $script:SelectedChannel = if ($persisted) { $persisted } else { 'stable' }
        return $script:SelectedChannel
    }
    Write-Host ''
    Write-Host '  Canal de atualizacoes do plugin:' -ForegroundColor White
    Write-Host '    [1] Stable (recomendado)' -ForegroundColor Green
    Write-Host '        Canal mais previsivel, somente releases estaveis.' -ForegroundColor DarkGray
    Write-Host '    [2] Beta (opt-in)' -ForegroundColor Yellow
    Write-Host '        Canal de testes; voce ajuda a comunidade ao testar, encontrar e corrigir erros antes da versao estavel.' -ForegroundColor DarkGray
    Write-Host '        Nenhum canal promete estabilidade.' -ForegroundColor DarkGray
    $choice = Read-Escolha '  Escolha [1]'
    $script:SelectedChannel = if ($choice -eq '2') { 'beta' } else { 'stable' }
    return $script:SelectedChannel
}

function Set-PluginSettings($root) {
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
    if (-not $plugin.PSObject.Properties['excludedCountries']) {
        $plugin | Add-Member -NotePropertyName excludedCountries -NotePropertyValue 'BR' -Force
    }

    if ($script:SelectedChannel -in @('stable', 'beta')) {
        $plugin | Add-Member -NotePropertyName updateChannel -NotePropertyValue $script:SelectedChannel -Force
    }
    $settings.plugins | Add-Member -NotePropertyName GoLiveBypass -NotePropertyValue $plugin -Force

    Save-Text $file ($settings | ConvertTo-Json -Depth 100)

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
        $currentChannel = Get-PersistedUpdateChannel $root
        if (-not $currentChannel) { $currentChannel = 'stable' }
        Write-Host "    Canal     $currentChannel" -ForegroundColor DarkGray
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


# =============================================================== Tor legado

# O instalador nao oferece mais escolha de saida: a conta Proton e configurada dentro do
# plugin na primeira ativacao, e o plugin WireGuard nao le `proxy` do settings.json. O que
# sobra aqui e a limpeza do que as versoes anteriores deste instalador deixaram na maquina
# de quem escolheu aquela opcao.

function Get-TorBaseDir {
    return (Join-Path (Get-EffectiveLocalApp) 'GoLiveBypass\Tor')
}

function Get-TorExe {
    return (Join-Path (Get-TorBaseDir) 'tor\tor.exe')
}

function Remove-Tor {
    # Desinstala o que as versoes anteriores deste instalador criaram: a Run key e o wrapper
    # .vbs. Se existir um servico "tor" apontando para a nossa pasta, remove tambem; se for de
    # outra pessoa, nao mexe.
    $exe = Get-TorExe
    try {
        $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
        Remove-ItemProperty -Path $key -Name 'GoLiveBypassTor' -ErrorAction SilentlyContinue
    } catch { }
    # O wrapper invisivel gravado ao lado do torrc tambem sai.
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
    Write-Warn 'Deixe esta janela aberta. Quando voce fechar o Discord, removo apenas o plugin GoLiveBypass.'
    Write-Host '  Se fechar esta janela antes, rode: .\GoLiveBypass-Installer.ps1 -Mode Uninstall' -ForegroundColor DarkGray

    try {
        # Esperar o Discord APARECER antes de esperar ele sumir. Sem isso, o Update.exe ainda
        # nao trocou de processo e o laco acha que ja fechou, desfazendo tudo em 5 segundos.
        for ($i = 0; $i -lt 90; $i++) {
            if (Get-Process -Name $DiscordNames -ErrorAction SilentlyContinue) { break }
            Start-Sleep -Seconds 1
        }

        if (-not (Get-Process -Name $DiscordNames -ErrorAction SilentlyContinue)) {
            Write-Warn 'O Discord nao abriu em 90s. Vou remover apenas o GoLiveBypass agora.'
        } else {
            while (Get-Process -Name $DiscordNames -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 2 }
            Write-Host ''
            Write-Step 'Discord fechado, removendo apenas o plugin GoLiveBypass'
        }
    } finally {
        Remove-PluginSource $root
        Write-Ok 'GoLiveBypass removido; Vencord/Equicord preservado.'
    }
}

function Invoke-RestoreEverything {
    $root = Find-Checkout
    if ($root) {
        Remove-PluginSource $root
        Stop-Discord
    } else {
        Write-Warn 'Nao achei o fonte do mod, entao so posso parar por aqui.'
    }

    Remove-Tor
    Write-Host ''
    Write-Ok 'GoLiveBypass removido; Vencord/Equicord e o Discord foram preservados.'
}
function Invoke-ChangeChannel($root) {
    if (-not $root) {
        Write-Warn 'Para persistir o canal, primeiro prepare um checkout do Equicord/Vencord.'
        Write-Host '  A instalacao inicial perguntara o canal depois de preparar o mod.' -ForegroundColor DarkGray
        return
    }
    $current = Get-PersistedUpdateChannel $root
    if (-not $current) { $current = 'stable' }
    if ($script:ChannelExplicit) {
        Write-Host "  Canal fixado por -Channel: $Channel. Nada foi alterado pelo submenu." -ForegroundColor DarkGray
        return
    }
    if ($Yes) {
        if (Set-UpdateChannelPreference $root $current) { Write-Ok "Canal mantido em $current." }
        return
    }

    $selected = $null
    if (Test-TuiInteractive) {
        $choice = Tui-Menu "Canal de atualizacoes (atual: $current)" @(
            'Stable (recomendado) — canal mais previsivel, somente releases estaveis',
            'Beta (opt-in) — canal de testes; ajuda a encontrar e corrigir erros',
            'Cancelar'
        )
        if ($choice -eq 1) { $selected = 'stable' }
        elseif ($choice -eq 2) { $selected = 'beta' }
    } else {
        Write-Host ''
        Write-Host "  Canal de atualizacoes (atual: $current)" -ForegroundColor White
        Write-Host '    [1] Stable (recomendado)' -ForegroundColor Green
        Write-Host '        Canal mais previsivel, somente releases estaveis.' -ForegroundColor DarkGray
        Write-Host '    [2] Beta (opt-in)' -ForegroundColor Yellow
        Write-Host '        Canal de testes; voce ajuda a comunidade a testar, encontrar e corrigir erros antes da versao estavel.' -ForegroundColor DarkGray
        Write-Host '    [0] Cancelar' -ForegroundColor DarkGray
        $choice = Read-Escolha '  Escolha'
        if ($choice -eq '1') { $selected = 'stable' }
        elseif ($choice -eq '2') { $selected = 'beta' }
    }
    if (-not $selected) {
        Write-Host '  Canal nao alterado. Voltando ao menu.' -ForegroundColor DarkGray
        return
    }
    if (-not (Set-UpdateChannelPreference $root $selected)) {
        Write-Warn 'Nao consegui salvar o canal; nenhuma instalacao ou atualizacao foi executada.'
        return
    }
    if ((Get-PersistedUpdateChannel $root) -eq $selected) {
        Write-Ok "Canal salvo: $selected. Voltando ao menu."
    } else {
        Write-Warn 'Nao consegui confirmar o canal salvo; nenhuma outra acao foi executada.'
    }
}

function Show-MainMenu {
    :menuLoop while ($true) {
        $root = Find-Checkout
        Show-Status $root

        if (Test-TuiInteractive) {
            $tui = Tui-Menu 'O que voce quer fazer?' @(
                'Instalar o GoLiveBypass',
                'Verificar atualizacoes do plugin',
                'Atualizar o plugin',
                'Mudar canal de atualizacoes',
                'Remover so o plugin (o mod continua)',
                'Restaurar tudo (remove o plugin; preserva o mod)',
                'Ver estado dos clientes (injecao/backup)',
                'Restaurar cliente que nao abre (devolve o app.asar)',
                'Sair'
            )
            switch ($tui) {
                1 { Invoke-Install $root; return }
                2 { Invoke-CheckUpdate; return }
                3 { Invoke-Update; return }
                4 { Invoke-ChangeChannel $root; continue menuLoop }
                5 { Invoke-Uninstall; return }
                6 { Invoke-RestoreEverything; return }
                7 { Show-ClientStates; continue menuLoop }
                8 { Invoke-RestoreClient $Client; continue menuLoop }
                default { Write-Host '  Ate mais.' -ForegroundColor DarkGray; return }
            }
        }

        Write-Host '  O que voce quer fazer?' -ForegroundColor White
        Write-Host ''
        Write-Host '    [1] Instalar o GoLiveBypass' -ForegroundColor Green
        Write-Host '    [2] Verificar atualizacoes do plugin' -ForegroundColor Cyan
        Write-Host '    [3] Atualizar o plugin' -ForegroundColor Green
        Write-Host '    [4] Mudar canal de atualizacoes' -ForegroundColor Cyan
        Write-Host '    [5] Remover so o plugin (o mod continua)' -ForegroundColor Yellow
        Write-Host '    [6] Restaurar tudo (remove o plugin; preserva o mod)' -ForegroundColor Red
        Write-Host '    [7] Ver estado dos clientes (injecao/backup)' -ForegroundColor Cyan
        Write-Host '    [8] Restaurar cliente que nao abre (devolve o app.asar)' -ForegroundColor Yellow
        Write-Host '    [0] Sair' -ForegroundColor Gray
        Write-Host ''

        switch (Read-Escolha '  Escolha') {
            '1' { Invoke-Install $root; return }
            '2' { Invoke-CheckUpdate; return }
            '3' { Invoke-Update; return }
            '4' { Invoke-ChangeChannel $root; continue menuLoop }
            '5' { Invoke-Uninstall; return }
            '6' { Invoke-RestoreEverything; return }
            '7' { Show-ClientStates; continue menuLoop }
            '8' { Invoke-RestoreClient $Client; continue menuLoop }
            default { Write-Host '  Ate mais.' -ForegroundColor DarkGray; return }
        }
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
            if ($release.draft) { continue }
            $releaseVersion = ConvertTo-PluginVersion $release.tag_name
            if (-not $releaseVersion) { continue }
            $releaseIsBeta = $releaseVersion.Pre.Count -gt 0
            if (($script:SelectedChannel -eq 'stable' -and $releaseIsBeta) -or
                ($script:SelectedChannel -eq 'beta' -and -not $releaseIsBeta)) { continue }

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

# Release candidates are selected from the API collection for both channels. Never
function ConvertTo-PluginVersion($value) {
    if ($null -eq $value) { return $null }
    $text = ([string]$value).Trim()
    $match = [regex]::Match($text, '^[vV]?([0-9]+)\.([0-9]+)\.([0-9]+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$')
    if (-not $match.Success) { return $null }
    foreach ($part in @($match.Groups[1].Value, $match.Groups[2].Value, $match.Groups[3].Value)) {
        if ($part.Length -gt 1 -and $part.StartsWith('0')) { return $null }
    }
    $identifiers = @()
    if ($match.Groups[4].Success) {
        $pre = $match.Groups[4].Value
        $legacy = [regex]::Match($pre, '^beta[.-]([0-9]+)$')
        if ($legacy.Success) {
            if ($legacy.Groups[1].Value.Length -gt 1 -and $legacy.Groups[1].Value.StartsWith('0')) { return $null }
            $identifiers = @('beta', $legacy.Groups[1].Value)
        } else {
            $identifiers = @($pre -split '\.')
            foreach ($identifier in $identifiers) {
                if ($identifier -match '^[0-9]+$' -and $identifier.Length -gt 1 -and $identifier.StartsWith('0')) { return $null }
            }
        }
    }
    [pscustomobject]@{
        Major = [System.Numerics.BigInteger]::Parse($match.Groups[1].Value)
        Minor = [System.Numerics.BigInteger]::Parse($match.Groups[2].Value)
        Patch = [System.Numerics.BigInteger]::Parse($match.Groups[3].Value)
        Pre = $identifiers
        Normalized = "$($match.Groups[1].Value).$($match.Groups[2].Value).$($match.Groups[3].Value)" + $(if ($identifiers.Count) { "-$($identifiers -join '-')" } else { '' })
    }
}

function Compare-Version($installed, $latest) {
    $a = ConvertTo-PluginVersion $installed
    $b = ConvertTo-PluginVersion $latest
    if (-not $b) { return 0 }
    if (-not $a) { return -1 }
    foreach ($name in @('Major', 'Minor', 'Patch')) {
        if ($a.$name -lt $b.$name) { return -1 }
        if ($a.$name -gt $b.$name) { return 1 }
    }
    if ($a.Pre.Count -eq 0 -and $b.Pre.Count -eq 0) { return 0 }
    if ($a.Pre.Count -eq 0) { return 1 }
    if ($b.Pre.Count -eq 0) { return -1 }
    $count = [Math]::Max($a.Pre.Count, $b.Pre.Count)
    for ($i = 0; $i -lt $count; $i++) {
        if ($i -ge $a.Pre.Count) { return -1 }
        if ($i -ge $b.Pre.Count) { return 1 }
        $left = [string]$a.Pre[$i]; $right = [string]$b.Pre[$i]
        $leftNumeric = $left -match '^[0-9]+$'; $rightNumeric = $right -match '^[0-9]+$'
        if ($leftNumeric -and $rightNumeric) {
            $cmp = [System.Numerics.BigInteger]::Compare([System.Numerics.BigInteger]::Parse($left), [System.Numerics.BigInteger]::Parse($right))
        } elseif ($leftNumeric -ne $rightNumeric) {
            $cmp = if ($leftNumeric) { -1 } else { 1 }
        } else {
            $cmp = [string]::CompareOrdinal($left, $right)
        }
        if ($cmp -ne 0) { return $(if ($cmp -lt 0) { -1 } else { 1 }) }
    }
    return 0
}
# Consulta a coleção /releases?per_page=30; não usa /releases/latest, pois o
# endpoint latest oculta prereleases e não fornece o contrato completo de assets.
function Get-PluginReleaseCandidates([string]$channel = $script:SelectedChannel) {
    try {
        $headers = @{ 'User-Agent' = 'GoLiveBypass-Installer'; 'Accept' = 'application/vnd.github+json' }
        $releases = Invoke-RestMethod -Uri "$GitHubApi/releases?per_page=30" -Headers $headers -TimeoutSec 15
        foreach ($release in @($releases)) {
            if (-not $release -or -not $release.PSObject.Properties['draft'] -or $release.draft -ne $false -or -not $release.tag_name) { continue }
            $version = ConvertTo-PluginVersion $release.tag_name
            if (-not $version) { continue }
            $isPrerelease = $version.Pre.Count -gt 0
            if (-not $release.PSObject.Properties['prerelease'] -or $release.prerelease -isnot [bool] -or [bool]$release.prerelease -ne $isPrerelease) { continue }
            if ($channel -eq 'stable' -and $isPrerelease) { continue }
            $zip = @($release.assets) | Where-Object { $_.name -eq 'goLiveBypass-vencord.zip' } | Select-Object -First 1
            $sha = @($release.assets) | Where-Object { $_.name -eq 'goLiveBypass-vencord.zip.sha256' } | Select-Object -First 1
            if (-not $zip -or -not $sha) { continue }
            if ($zip.browser_download_url -notmatch '^https://') { continue }
            if ($sha.browser_download_url -notmatch '^https://') { continue }
            [pscustomobject]@{
                Tag = $version.Normalized
                Version = $version.Normalized
                AssetUrl = [string]$zip.browser_download_url
                ShaUrl = [string]$sha.browser_download_url
                Prerelease = [bool]$isPrerelease
                Release = $release
            }
        }
    } catch {
        return
    }
}

function Get-PluginReleaseForChannel([string]$channel = $script:SelectedChannel) {
    $best = $null
    foreach ($candidate in @(Get-PluginReleaseCandidates $channel)) {
        if (-not $best -or (Compare-Version $best.Version $candidate.Version) -lt 0) { $best = $candidate }
    }
    return $best
}

function Get-PluginInstallRelease([string]$channel = $script:SelectedChannel) {
    return Get-PluginReleaseForChannel $channel
}

# The update check intentionally uses the same fully validated release object as install/update.
function Get-LatestRelease([string]$channel = $script:SelectedChannel) {
    return Get-PluginReleaseForChannel $channel
}

# Le a versao do manifest.json em $root/src/userplugins/$PluginDirName.
function Get-InstalledPluginVersion($root) {
    if (-not $root) { return $null }
    $manifest = Join-Path $root "src\userplugins\$PluginDirName\manifest.json"
    if (-not (Test-Path -LiteralPath $manifest)) { return $null }
    try {
        $j = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
        $version = if ($j.PSObject.Properties['version']) { [string]$j.version } else { $null }
        if (ConvertTo-PluginVersion $version) { return $version }
    } catch {}
    return $null
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

# --check-update: consulta canal selecionado e nunca baixa.
function Invoke-CheckUpdate {
    $root = Find-Checkout
    if (-not $root) {
        Write-Host "  plugin: nao encontrado (rode uma vez para instalar)"
        return
    }
    $channel = Select-UpdateChannel $root
    $installed = Get-InstalledPluginVersion $root
    if ($installed) { Write-Host "  plugin: instalado (v$installed)" }
    else { Write-Host "  plugin: instalado (versao desconhecida)" -ForegroundColor Yellow }
    $release = Get-LatestRelease $channel
    if (-not $release) {
        Write-Host "  remote: nenhuma release $channel valida com zip e SHA-256 (ausente, metadata incoerente, rede ou rate limit)" -ForegroundColor DarkGray
        return
    }
    [void](Set-UpdateChannelPreference $root $channel)
    Write-Host "  canal: $channel"
    Write-Host "  remote: $($release.Version)"
    if (-not $installed) {
        Write-Host "  resultado: versao local desconhecida - rode -Mode Update para alinhar" -ForegroundColor Yellow
        return
    }
    switch (Compare-Version $installed $release.Version) {
        0  { Write-Host "  resultado: voce esta na versao mais recente" -ForegroundColor Green }
        1  { Write-Host "  resultado: versao local mais nova que a release (nenhum downgrade)" -ForegroundColor DarkGray }
        -1 { Write-Host "  resultado: ha versao nova - rode -Mode Update para atualizar" -ForegroundColor Yellow }
    }
}

# --update: baixa somente o zip da release validada do canal e nunca faz downgrade.
function Invoke-Update {
    $root = Find-Checkout
    if (-not $root) { throw "Nao achei o checkout do mod. Rode o instalador uma vez (sem --update) para descobrir." }
    $channel = Select-UpdateChannel $root
    $installed = Get-InstalledPluginVersion $root
    if (-not $installed -and (Test-Path -LiteralPath (Join-Path $root "src\userplugins\$PluginDirName\manifest.json"))) {
        throw "A versao instalada do plugin e invalida; nenhum update seguro foi aplicado."
    }
    $release = Get-LatestRelease $channel
    if (-not $release) { throw "Nao encontrei uma release $channel valida com zip e SHA-256; ela pode estar ausente, em metadata incoerente ou indisponivel por rede/rate limit." }
    if ($installed -and (Compare-Version $installed $release.Version) -ge 0) {
        [void](Set-UpdateChannelPreference $root $channel)
        if ((Compare-Version $installed $release.Version) -eq 0) { Write-Ok "Voce ja esta na versao $($release.Version) (canal $channel)." }
        else { Write-Warn "Versao local (v$installed) e mais nova; nenhum downgrade foi feito." }
        return
    }
    Write-Step "Fazendo backup do plugin atual"
    Backup-Plugin $root
    Invoke-UpdateFromZip $root $release.AssetUrl $release.Version $release.ShaUrl
    Build-Mod $root
    if (-not (Test-InjectedFromCheckout $root)) { Invoke-Injection $root @((Get-PatchTargets) | Where-Object { $_.Tipo -eq 'O' }) }
    [void](Set-UpdateChannelPreference $root $channel)
    Write-Host ''
    Write-Ok "Atualizado para $($release.Version) (canal $channel). Reinicie o Discord para carregar a nova versao."
}

# Baixa o zip do userplugin, valida SHA-256 e extrai. O SHA URL vem do mesmo
# objeto de release para evitar misturar assets de canais/releases diferentes.
function Invoke-UpdateFromZip($root, $zipUrl, $expectedVersion, $shaUrl = $null) {
    $tempDir = Join-Path $env:TEMP "GoLiveBypass-plugin-$expectedVersion"
    if (Test-Path -LiteralPath $tempDir) { Remove-Item -LiteralPath $tempDir -Recurse -Force }
    New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
    $zipFile = Join-Path $tempDir 'plugin.zip'
    Write-Step "Baixando $zipUrl"
    try { Invoke-WebRequest -Uri $zipUrl -OutFile $zipFile -UseBasicParsing -TimeoutSec 60 }
    catch { Remove-CaminhoSilencioso $tempDir; throw "Download do zip falhou: $($_.Exception.Message)" }
    Write-Step "Validando SHA-256"
    if (-not $shaUrl) { $shaUrl = "$zipUrl.sha256" }
    try {
        $shaResponse = Invoke-WebRequest -Uri $shaUrl -UseBasicParsing -TimeoutSec 15
        $shaContent = if ($shaResponse.Content -is [byte[]]) {
            [Text.Encoding]::UTF8.GetString($shaResponse.Content).Trim()
        } else { ([string]$shaResponse.Content).Trim() }
        $shaExpected = ($shaContent -split '\s+')[0].ToLower()
    } catch {
        Remove-CaminhoSilencioso $tempDir
        throw "Release sem arquivo .sha256 (asset companion). Sem hash, sem update."
    }
    if ($shaExpected -notmatch '^[0-9a-f]{64}$') {
        Remove-CaminhoSilencioso $tempDir
        throw 'Release com SHA-256 invalido. Sem hash, sem update.'
    }
    $shaActual = (Get-FileHash -LiteralPath $zipFile -Algorithm SHA256).Hash.ToLower()
    if ($shaActual -ne $shaExpected) {
        Remove-CaminhoSilencioso $tempDir
        throw "SHA-256 nao confere: esperado $shaExpected, obtido $shaActual."
    }
    Write-Ok 'SHA-256 confere'
    $extractDir = Join-Path $tempDir 'extract'
    New-Item -ItemType Directory -Path $extractDir -Force | Out-Null
    try { Expand-Archive -LiteralPath $zipFile -DestinationPath $extractDir -Force }
    catch { Remove-CaminhoSilencioso $tempDir; throw "Extracao falhou: $($_.Exception.Message)" }
    $extracted = Get-ChildItem -LiteralPath $extractDir -Directory | Select-Object -First 1
    if (-not $extracted -or $extracted.Name -ne $PluginDirName) {
        Remove-CaminhoSilencioso $tempDir
        throw 'Zip nao tem a pasta esperada (goLiveBypass/).'
    }
    $manifestPath = Join-Path $extracted.FullName 'manifest.json'
    $extractedVersion = $null
    try {
        $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
        if ($manifest.PSObject.Properties['version']) { $extractedVersion = [string]$manifest.version }
    } catch { }
    if (-not $extractedVersion -or -not (ConvertTo-PluginVersion $extractedVersion) -or (Compare-Version $extractedVersion $expectedVersion) -ne 0) {
        Remove-CaminhoSilencioso $tempDir
        throw "Manifest do plugin nao corresponde a release $expectedVersion."
    }
    $target = Join-Path $root "src\userplugins\$PluginDirName"
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
    New-Item -ItemType Directory -Path $target -Force | Out-Null
    Get-ChildItem -LiteralPath $extracted.FullName -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $target -Recurse -Force
    }
    Remove-CaminhoSilencioso $tempDir
    Write-Ok 'Plugin extraido'
}

Show-Banner

$script:InstallerPhase = 'detect'
Write-InstallerEvent 'info' 'installer.detect.started' 'detect' @{ mode = $Mode }

try {
    switch ($Mode) {
        'Install'     { Invoke-Install (Find-Checkout) }
        'Uninstall'   { Invoke-Uninstall }
        'Restore'     { Invoke-RestoreEverything }
        'RestoreClient' { Invoke-RestoreClient $Client }
        'ClientStatus'  { Show-ClientStates }
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
    Write-Host "      Log local: $(Get-InstallerLogFile)" -ForegroundColor DarkGray
    Write-Host '      Copie a saida acima ou abra o log para relatar.' -ForegroundColor DarkGray

    Write-InstallerEvent 'error' 'installer.failed' $script:InstallerPhase @{ reason = $_.Exception.Message }
    Wait-AntesDeFechar
    exit 1
}

Write-Host ''
Wait-AntesDeFechar
