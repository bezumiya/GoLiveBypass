import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const cwd = fileURLToPath(new URL('../../tools/proton-confgen/', import.meta.url));
const packageJson = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
const version = String(packageJson.version || '');
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`Versao da GUI invalida: ${version}`);

const targets = [
  { key: 'linux-x64', output: 'build/proton-confgen', env: { GOOS: 'linux', GOARCH: 'amd64', CGO_ENABLED: '0' } },
  { key: 'win32-x64', output: 'build/proton-confgen.exe', env: { GOOS: 'windows', GOARCH: 'amd64', CGO_ENABLED: '0' } },
];
// O estado VCS do checkout não pode alterar os bytes do helper entre a GUI e o
// asset de reparo publicado. Isso também torna o manifesto reproduzível no CI.
const buildArgs = ['build', '-buildvcs=false', '-trimpath', '-ldflags=-s -w -buildid=', '-o'];

// Explicit env objects work with cmd.exe, PowerShell and POSIX shells alike.
for (const target of targets) {
  const result = spawnSync('go', [...buildArgs, target.output, './cmd/protonvpn-wg'], {
    cwd,
    env: { ...process.env, ...target.env },
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const assetNames = {
  'linux-x64': `GoLiveBypass-${version}-proton-confgen-linux-x64`,
  'win32-x64': `GoLiveBypass-${version}-proton-confgen-win-x64.exe`,
};
const assets = {};
for (const target of targets) {
  const outputPath = path.join(cwd, target.output);
  const stats = statSync(outputPath);
  if (!stats.isFile() || stats.size <= 0) throw new Error(`Saida do proton-confgen ausente ou vazia: ${outputPath}`);
  const sha256 = createHash('sha256').update(readFileSync(outputPath)).digest('hex');
  assets[target.key] = { asset: assetNames[target.key], sha256 };
}
writeFileSync(path.join(cwd, 'build/proton-confgen-manifest.json'), `${JSON.stringify({ version, assets }, null, 2)}\n`, 'utf8');
