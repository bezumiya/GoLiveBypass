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

    Obrigado ao Vithor (https://github.com/Vith0r), que escreveu o primeiro instalador do
    GoLiveBypass e abriu o caminho para este aqui.
#>

[CmdletBinding()]
param(
    [ValidateSet('Menu', 'Install', 'Uninstall', 'Restore')]
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
$PluginFiles = @('goLiveBypass/index.tsx', 'goLiveBypass/native.ts')
$PluginDirName = 'goLiveBypass'
$DiscordNames = @('Discord', 'DiscordCanary', 'DiscordPTB')

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

function Save-Text($path, $text) {
    $dir = Split-Path -Parent $path
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    [IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))
}

function Get-RepoFile($relativePath) {
    if ($PSScriptRoot) {
        $local = Join-Path (Split-Path -Parent $PSScriptRoot) ($relativePath -replace '/', '\')
        if (Test-Path -LiteralPath $local) { return [IO.File]::ReadAllText($local) }
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
    $asar = Join-Path $resources 'app.asar'
    $original = Join-Path $resources '_app.asar'
    return (Test-Path -LiteralPath $asar) -or (Test-Path -LiteralPath $original)
}

function Get-DiscordResources {
    $found = @()
    foreach ($name in $DiscordNames) {
        $root = Join-Path $env:LOCALAPPDATA $name
        if (-not (Test-Path -LiteralPath $root)) { continue }

        $apps = Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match '^app-[0-9]' } |
            Sort-Object -Descending -Property @{ Expression = {
                try { [version]($_.Name -replace '^app-', '') } catch { [version]'0.0.0' }
            } }

        foreach ($app in $apps) {
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
        $root = Split-Path -Parent (Split-Path -Parent $injected)
        if (Test-ModCheckout $root) { return $root }
    }
    return $null
}

function Find-CheckoutOnDisk {
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
            if (Test-ModCheckout $dir.FullName) { return $dir.FullName }
        }
    }

    Write-Step 'Procurando um pouco mais fundo no seu perfil'
    $deep = Get-ChildItem -LiteralPath $env:USERPROFILE -Directory -Recurse -Depth 3 -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^(Equicord|Vencord)$' } |
        Select-Object -First 20

    foreach ($dir in $deep) {
        if (Test-ModCheckout $dir.FullName) { return $dir.FullName }
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
    foreach ($resources in Get-DiscordResources) {
        $injected = Get-InjectedPath $resources
        if ($injected -and $injected.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    }
    return $false
}

function Show-ModChoice {
    if ($Mod) { return $Mod }

    $installed = Get-InstalledMod

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

function Invoke-Injection($root) {
    Push-Location -LiteralPath $root
    try {
        Stop-Discord
        Write-Step 'Injetando no Discord'
        & pnpm inject
        if ($LASTEXITCODE -ne 0) { throw 'pnpm inject falhou' }
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

    $weInjected = -not (Test-InjectedFromCheckout $root)
    if ($weInjected) {
        Invoke-Injection $root
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
    return (Join-Path $env:LOCALAPPDATA 'GoLiveBypass\Tor')
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
        $archive = Join-Path $env:TEMP $asset.Url.Split('/')[-1]
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
        New-Item -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Force | Out-Null
        Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'GoLiveBypassTor' -Value $command
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

Show-Banner

try {
    switch ($Mode) {
        'Install' { Invoke-Install (Find-Checkout) }
        'Uninstall' { Invoke-Uninstall }
        'Restore' { Invoke-RestoreEverything }
        default { Show-MainMenu }
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
    exit 1
}

Write-Host ''
