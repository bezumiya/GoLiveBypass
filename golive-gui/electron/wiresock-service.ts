// Encode PowerShell instead of interpolating paths into cmd.exe. The service
// must use the selected profile even when another application installed it.
export function wireSockServiceScript(executable: string, config: string): string {
  for (const value of [executable, config]) {
    if (!value || /["\r\n\0]/.test(value)) throw new Error("Caminho WireSock inválido");
  }
  const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;
  const command = `"${executable}" service -config "${config}" -log-level info -network-lock disabled`;
  return `$ErrorActionPreference = 'Stop'
try {
  $name = 'wiresock-client-service'
  $expected = ${literal(command)}
  function Get-WireSockInfo {
    return Get-CimInstance Win32_Service -Filter "Name='$name'" -ErrorAction SilentlyContinue
  }
  function Wait-WireSockState([string]$state, [int]$seconds) {
    $deadline = (Get-Date).AddSeconds($seconds)
    do {
      $current = Get-Service -Name $name -ErrorAction SilentlyContinue
      if ($current -and $current.Status -eq $state) { return $true }
      Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)
    return $false
  }
  function Stop-WireSockService {
    $current = Get-Service -Name $name -ErrorAction SilentlyContinue
    if (-not $current -or $current.Status -eq 'Stopped') { return }
    try { Stop-Service -Name $name -Force -ErrorAction Stop } catch {
      # A service in STOP_PENDING can reject a second Stop-Service. The state
      # poll below is authoritative and avoids starting over a live WFP child.
      $current = Get-Service -Name $name -ErrorAction SilentlyContinue
    }
    if (-not (Wait-WireSockState 'Stopped' 45)) {
      $info = Get-WireSockInfo
      throw "STOP_TIMEOUT: estado=$($info.State) win32=$($info.ExitCode) service=$($info.ServiceSpecificExitCode)"
    }
  }

  Stop-WireSockService
  $serviceInfo = Get-WireSockInfo
  if (-not $serviceInfo) {
    & ${literal(executable)} install -start-type 3 -config ${literal(config)} -log-level info -network-lock disabled
    $installCode = $LASTEXITCODE
    $serviceInfo = Get-WireSockInfo
    if ($installCode -ne 0 -and -not $serviceInfo) { throw "INSTALL_FAILED: codigo=$installCode" }
  }
  if (-not $serviceInfo) { throw 'SERVICE_MISSING: Serviço WireSock não encontrado após instalação' }

  $change = Invoke-CimMethod -InputObject $serviceInfo -MethodName Change -Arguments @{PathName=$expected; StartMode='Manual'}
  if ($change.ReturnValue -ne 0) { throw "CONFIG_FAILED: codigo=$($change.ReturnValue)" }
  $actual = Get-WireSockInfo
  if (-not $actual -or $actual.PathName -cne $expected) { throw 'CONFIG_FAILED: O serviço WireSock permaneceu com outra configuração' }

  $lastStartError = ''
  for ($attempt = 1; $attempt -le 2; $attempt++) {
    try {
      Start-Service -Name $name -ErrorAction Stop
      if (Wait-WireSockState 'Running' 45) { exit 0 }
      $info = Get-WireSockInfo
      $lastStartError = "estado=$($info.State) win32=$($info.ExitCode) service=$($info.ServiceSpecificExitCode)"
    } catch {
      $lastStartError = $_.Exception.Message
    }
    if ($attempt -lt 2) { Start-Sleep -Seconds 2; Stop-WireSockService }
  }
  throw "START_FAILED: $lastStartError"
} catch {
  [Console]::Error.WriteLine("GOLIVE_WIRESOCK_ERROR: $($_.Exception.Message)")
  exit 1
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
  & powershell.exe -NoProfile -NonInteractive -File $scriptPath
  exit $LASTEXITCODE
}
$child = Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList @('-NoProfile','-NonInteractive','-File', ('"' + $scriptPath + '"'))
exit $child.ExitCode`;
  return ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(wrapper, "utf16le").toString("base64")];
}
