// Bundle with esbuild; the resulting .cjs needs only Node and Windows PowerShell.
const { wireSockDirectScript, wireSockServiceScript, elevatedPowerShellFileArgs } = require('../electron/wiresock-service.ts');
const { classifyWireSockDirectResult, mayUseServiceCompatibility, classifyWireSockActivationFailure } = require('../electron/wiresock.ts');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

if (process.platform !== 'win32') {
  console.error('SKIP: contrato Windows; nenhuma ativação real foi testada. Execute com Node no Windows.');
  process.exit(2);
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'golive-contract-'));
const work = path.join(root, "João 漢字 d'Ávila");
fs.mkdirSync(work);
const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const literal = s => "'" + s.replace(/'/g, "''") + "'";
const report = { scope: 'CONTRACT ONLY: fake executable, mocked service/process discovery; no WireSock, driver, UAC or routing validation', root, cases: [] };
function run(file, result) {
  const args = result ? elevatedPowerShellFileArgs(file, result) : ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file];
  const r = cp.spawnSync(ps, args, { encoding: 'utf8', timeout: 30000, windowsHide: true });
  if (r.error) throw r.error;
  return r;
}
function writePS(name, text) {
  const file = path.join(work, name);
  fs.writeFileSync(file, text, 'utf8');
  return file;
}
try {
  // Compile a console executable locally with the built-in .NET C# compiler.
  // It never accesses the network and exits automatically after 15s at most.
  const exe = path.join(work, 'golive-contract-fake.exe');
  const source = `using System; using System.IO; using System.Diagnostics; using System.Threading;
public class Fake { public static int Main(string[] args) {
  if(args.Length != 7) return 91;
  if(args[0] != "run" || args[1] != "-config" || args[3] != "-log-level" || args[4] != "info" || args[5] != "-network-lock" || args[6] != "disabled") return 92;
  string config = args[2]; string mode = File.ReadAllText(config).Trim();
  File.WriteAllText(config + ".args", string.Join("\\n", args));
  File.WriteAllText(config + ".pid", Process.GetCurrentProcess().Id.ToString());
  Console.WriteLine("unknown command\\tservice"); Console.Error.WriteLine("stderr marker");
  if(mode == "stay") { Thread.Sleep(15000); return 0; }
  return mode == "exit0" ? 0 : 7;
} }`;
  const compile = writePS('compile.ps1', '\uFEFF$ErrorActionPreference = \'Stop\'\nAdd-Type -TypeDefinition ' + literal(source) + ' -Language CSharp -OutputAssembly ' + literal(exe) + ' -OutputType ConsoleApplication\n');
  const compiled = run(compile);
  assert.equal(compiled.status, 0, compiled.stderr);
  assert.ok(fs.existsSync(exe));

  // Demonstrate decoding separately, including a control WITHOUT a BOM.
  // UTF-8 system locales may decode both correctly, so the control is observed,
  // never assumed to fail. Both outputs have explicit UTF-8 encoding.
  const unicode = "João 漢字 d'Ávila";
  for (const bom of [false, true]) {
    const out = path.join(root, bom ? 'bom.txt' : 'no-bom.txt');
    const file = writePS(bom ? 'bom.ps1' : 'no-bom.ps1', (bom ? '\uFEFF' : '') + '[IO.File]::WriteAllText(' + literal(out) + ', ' + literal(unicode) + ', [Text.UTF8Encoding]::new($false))');
    const r = run(file);
    const actual = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null;
    report.cases.push({ name: bom ? 'BOM Unicode' : 'no-BOM control', exit: r.status, preserved: actual === unicode, actual });
    if (bom) { assert.equal(r.status, 0, r.stderr); assert.equal(actual, unicode); }
  }

  // Exact generated service script retained for inspection; NEVER executed.
  const service = wireSockServiceScript(exe, path.join(work, 'unused.conf'), path.join(work, 'unused-result.txt'));
  assert.equal(service.charCodeAt(0), 0xfeff);
  writePS('service-NOT-EXECUTED.ps1', service);

  // Only discovery is mocked. The real Start-Process, stdout/stderr capture,
  // three-second liveness check, result writer and exit handling run unchanged.
  // Tripwires prevent accidental service/process mutation if production changes.
  const isolation = `
function Get-Service { param($Name, $ErrorAction) return $null }
function Get-Process { param($Name, $ErrorAction) if ($Name -ne 'wiresock-client') { throw 'Unexpected process query' }; return }
function Stop-Service { throw 'CONTRACT SAFETY: Stop-Service forbidden' }
function Start-Service { throw 'CONTRACT SAFETY: Start-Service forbidden' }
function Stop-Process { process { throw 'CONTRACT SAFETY: Stop-Process forbidden' } }
`;
  for (const mode of ['exit0', 'exit7', 'stay']) {
    const config = path.join(work, mode + '.conf');
    const result = path.join(work, mode + '-result.txt');
    fs.writeFileSync(config, mode);
    const generated = wireSockDirectScript(exe, config, result);
    assert.equal(generated.charCodeAt(0), 0xfeff);
    const file = writePS(mode + '.ps1', '\uFEFF' + isolation + generated.slice(1));
    let pid;
    try {
      const r = run(file, result);
      const detail = fs.existsSync(result) ? fs.readFileSync(result, 'utf8') : '';
      if (fs.existsSync(config + '.pid')) pid = Number(fs.readFileSync(config + '.pid', 'utf8'));
      const entry = { name: mode, exit: r.status, detail, pid, generatedSha256: crypto.createHash('sha256').update(generated).digest('hex') };
      report.cases.push(entry);
      // Same result-envelope removal as the GUI, then its actual classifier.
      const classified = classifyWireSockDirectResult(detail.replace(/^\d+\s*/, '').trim());
      entry.classified = classified;
      entry.serviceFallbackAllowed = mayUseServiceCompatibility(classified);
      assert.equal(fs.readFileSync(config + '.args', 'utf8'), ['run', '-config', config, '-log-level', 'info', '-network-lock', 'disabled'].join('\n'));
      if (mode === 'stay') {
        assert.equal(classified.kind, 'running');
        assert.equal(r.status, 0, r.stderr);
        assert.match(detail, /^0\s+DIRECT_RUNNING: pid=\d+/);
        assert.equal(Number(detail.match(/pid=(\d+)/)[1]), pid);
        process.kill(pid, 0); // Check only the fake PID recorded by this case.
      } else {
        assert.equal(r.status, 1, r.stderr);
        assert.equal(entry.serviceFallbackAllowed, false, 'unknown service is not unsupported run');
        assert.match(detail, new RegExp('DIRECT_EXITED: codigo=' + (mode === 'exit0' ? '0' : '7')));
        assert.match(detail, /unknown command service/);
        assert.match(detail, /stderr marker/);
        assert.doesNotMatch(detail, /DIRECT_RUNNING/);
        if (mode === 'exit0') {
          assert.equal(classified.code, 'WIRESOCK_DIRECT_EXITED_0');
          assert.equal(entry.serviceFallbackAllowed, false, 'EXIT0 must never select the service fallback');
        }
      }
      entry.passed = true;
    } finally {
      if (mode === 'stay' && Number.isSafeInteger(pid) && pid > 0) {
        try { process.kill(pid); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    }
  }
  // Pure classification contract; no service command is executed here.
  const failure = classifyWireSockActivationFailure('GOLIVE_WIRESOCK_ERROR: START_FAILED: Win32ExitCode=1060');
  assert.equal(failure.code, 'WIRESOCK_SERVICE');
  report.cases.push({ name: 'service diagnostic classification only', passed: true, code: failure.code });
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error.stack || String(error);
  process.exitCode = 1;
} finally {
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log('CONTRACT ONLY. Evidências preservadas em: ' + root);
}
