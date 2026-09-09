// Encode PowerShell instead of interpolating paths into cmd.exe. The service
// must use the selected profile even when another application installed it.
export function wireSockServiceScript(executable: string, config: string, resultPath?: string): string {
  for (const value of [executable, config, resultPath].filter((value): value is string => Boolean(value))) {
    if (!value || /["\r\n\0]/.test(value)) throw new Error("Caminho WireSock inválido");
  }
  const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;
  const command = `"${executable}" service -config "${config}" -log-level info -network-lock disabled`;
  const result = resultPath ? literal(resultPath) : "$null";
  return `$ErrorActionPreference = 'Stop'
$resultPath = ${result}
function Complete-WireSock([int]$code, [string]$detail) {
  if ($resultPath) {
    try { [IO.File]::WriteAllText($resultPath, "$code\n$detail", [Text.UTF8Encoding]::new($false)) } catch {}
  }
  exit $code
}
try {
  $serviceNames = @('wiresock-client-service', 'wiresock-pro-client-service')
  $expected = ${literal(command)}
  function Get-WireSockInfo {
    foreach ($candidate in $serviceNames) {
      $info = Get-CimInstance Win32_Service -Filter "Name='$candidate'" -ErrorAction SilentlyContinue
      if ($info) { return $info }
    }
    return $null
  }
  function Wait-WireSockState([string]$serviceName, [string]$state, [int]$seconds) {
    $deadline = (Get-Date).AddSeconds($seconds)
    do {
      $current = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
      if ($current -and $current.Status -eq $state) { return $true }
      Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)
    return $false
  }
  function Stop-WireSockService([string]$serviceName) {
    $current = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
    if (-not $current -or $current.Status -eq 'Stopped') { return }
    try { Stop-Service -Name $serviceName -Force -ErrorAction Stop } catch {
      # A service in STOP_PENDING can reject a second Stop-Service. The state
      # poll below is authoritative and avoids starting over a live WFP child.
      $current = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
    }
    if (-not (Wait-WireSockState $serviceName 'Stopped' 45)) {
      $info = Get-CimInstance Win32_Service -Filter "Name='$serviceName'" -ErrorAction SilentlyContinue
      throw "STOP_TIMEOUT: servico=$serviceName estado=$($info.State) Win32ExitCode=$($info.ExitCode) ServiceSpecificExitCode=$($info.ServiceSpecificExitCode)"
    }
  }

  $serviceInfo = Get-WireSockInfo
  if (-not $serviceInfo) {
    & ${literal(executable)} install -start-type 3 -config ${literal(config)} -log-level info -network-lock disabled
    $installCode = $LASTEXITCODE
    $serviceInfo = Get-WireSockInfo
    if ($installCode -ne 0 -and -not $serviceInfo) { throw "INSTALL_FAILED: codigo=$installCode" }
  }
  if (-not $serviceInfo) { throw 'SERVICE_MISSING: Serviço WireSock não encontrado após instalação' }
  $name = [string]$serviceInfo.Name
  Stop-WireSockService $name

  $change = Invoke-CimMethod -InputObject $serviceInfo -MethodName Change -Arguments @{PathName=$expected; StartMode='Manual'}
  if ($change.ReturnValue -ne 0) { throw "CONFIG_FAILED: codigo=$($change.ReturnValue)" }
  $actual = Get-WireSockInfo
  if (-not $actual -or $actual.PathName -cne $expected) { throw 'CONFIG_FAILED: O serviço WireSock permaneceu com outra configuração' }

  $lastStartError = ''
  for ($attempt = 1; $attempt -le 2; $attempt++) {
    try {
      Start-Service -Name $name -ErrorAction Stop
      if (Wait-WireSockState $name 'Running' 45) {
        $running = Get-WireSockInfo
        Complete-WireSock 0 "SERVICE_RUNNING: name=$name pid=$($running.ProcessId) Win32ExitCode=$($running.ExitCode) ServiceSpecificExitCode=$($running.ServiceSpecificExitCode) path=$($running.PathName)"
      }
      $info = Get-WireSockInfo
      $lastStartError = "name=$name estado=$($info.State) pid=$($info.ProcessId) Win32ExitCode=$($info.ExitCode) ServiceSpecificExitCode=$($info.ServiceSpecificExitCode)"
    } catch {
      $lastStartError = "name=$name erro=$($_.Exception.Message)"
    }
    if ($attempt -lt 2) { Start-Sleep -Seconds 2; Stop-WireSockService $name }
  }
  throw "START_FAILED: $lastStartError"
} catch {
  $detail = "GOLIVE_WIRESOCK_ERROR: $($_.Exception.Message)"
  [Console]::Error.WriteLine($detail)
  Complete-WireSock 1 $detail
}`;
}

/**
 * Starts WireSock in its official application mode. This is the primary path:
 * it routes only the configured applications for the logged-in user and avoids
 * inheriting a stale global Windows service profile.
 */
export function wireSockDirectScript(executable: string, config: string, resultPath: string): string {
  for (const value of [executable, config, resultPath]) {
    if (!value || /["\r\n\0]/.test(value)) throw new Error("Caminho WireSock inválido");
  }
  const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;
  return `$ErrorActionPreference = 'Stop'
$resultPath = ${literal(resultPath)}
$stdoutPath = ${literal(resultPath + '.stdout')}
$stderrPath = ${literal(resultPath + '.stderr')}
function Complete-WireSock([int]$code, [string]$detail) {
  try { [IO.File]::WriteAllText($resultPath, "$code\n$detail", [Text.UTF8Encoding]::new($false)) } catch {}
  exit $code
}
function Read-Captured([string]$path) {
  try {
    if (-not (Test-Path -LiteralPath $path)) { return '' }
    $text = [IO.File]::ReadAllText($path)
    $text = [regex]::Replace($text, '\s+', ' ').Trim()
    if ($text.Length -gt 1200) { return $text.Substring(0, 1200) + '…' }
    return $text
  } catch { return '' }
}
function Wait-ServiceStopped([string]$name, [int]$seconds) {
  $service = Get-Service -Name $name -ErrorAction SilentlyContinue
  if (-not $service -or $service.Status -eq 'Stopped') { return }
  try { Stop-Service -Name $name -Force -ErrorAction Stop } catch {}
  $deadline = (Get-Date).AddSeconds($seconds)
  do {
    $service = Get-Service -Name $name -ErrorAction SilentlyContinue
    if (-not $service -or $service.Status -eq 'Stopped') { return }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  throw "DIRECT_STOP_TIMEOUT: servico=$name estado=$($service.Status)"
}
try {
  foreach ($name in @('wiresock-client-service', 'wiresock-pro-client-service')) {
    Wait-ServiceStopped $name 45
  }
  Get-Process -Name 'wiresock-client' -ErrorAction SilentlyContinue |
    Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500
  Remove-Item -LiteralPath $resultPath, $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
  $arguments = @('run', '-config', ('"' + ${literal(config)} + '"'), '-log-level', 'info', '-network-lock', 'disabled')
  $child = Start-Process -FilePath ${literal(executable)} -ArgumentList $arguments -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -WindowStyle Hidden -PassThru -ErrorAction Stop
  Start-Sleep -Seconds 3
  $child.Refresh()
  if ($child.HasExited) {
    $stdout = Read-Captured $stdoutPath
    $stderr = Read-Captured $stderrPath
    throw "DIRECT_EXITED: codigo=$($child.ExitCode) stdout=$stdout stderr=$stderr"
  }
  Complete-WireSock 0 "DIRECT_RUNNING: pid=$($child.Id)"
} catch {
  $stdout = Read-Captured $stdoutPath
  $stderr = Read-Captured $stderrPath
  $detail = "GOLIVE_WIRESOCK_DIRECT_ERROR: $($_.Exception.Message)"
  if ($stdout -or $stderr) { $detail += " stdout=$stdout stderr=$stderr" }
  [Console]::Error.WriteLine($detail)
  Complete-WireSock 1 $detail
}`;
}

/**
 * Runs a PowerShell file through UAC without copying the file contents into
 * an encoded command-line argument. Windows has a relatively small command
 * line limit; the WireSock service script is intentionally detailed enough
 * to exceed it when the script is nested in the elevation wrapper.
 */
export function elevatedPowerShellFileArgs(scriptPath: string): string[] {
  if (!scriptPath || /["\r\n\0]/.test(scriptPath)) throw new Error("Caminho do script PowerShell inválido");
  const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;
  const wrapper = `$ErrorActionPreference='Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$scriptPath = ${literal(scriptPath)}
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $scriptPath
  exit $LASTEXITCODE
}
$child = Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File', ('"' + $scriptPath + '"'))
exit $child.ExitCode`;
  return ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(wrapper, "utf16le").toString("base64")];
}
