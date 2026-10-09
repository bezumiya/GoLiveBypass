// Compila o proton-confgen de tools/proton-confgen (fonte do repositório) para
// darwin x64 e arm64, junta num binário universal e grava o manifesto com os
// SHA-256. O app confere o manifesto antes de executar o binário.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const src = path.join(root, '..', 'tools', 'proton-confgen');
const work = path.join(src, 'build', 'darwin');
const outDir = path.join(root, 'resources', 'extra', 'proton-confgen');
const out = path.join(outDir, 'proton-confgen');
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} saiu com ${r.status}`);
  return r.stdout.trim();
}
const sha256 = p => createHash('sha256').update(readFileSync(p)).digest('hex');

// Mesmas flags determinísticas da GUI Windows/Linux (golive-gui/scripts/build-proton.mjs)
const buildArgs = ['build', '-buildvcs=false', '-trimpath', '-ldflags=-s -w -buildid=', '-o'];
const targets = [
  { key: 'darwin-x64', goarch: 'amd64' },
  { key: 'darwin-arm64', goarch: 'arm64' },
];

rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
mkdirSync(outDir, { recursive: true });

const slices = {};
for (const t of targets) {
  const file = path.join(work, `proton-confgen-${t.key}`);
  run('go', [...buildArgs, file, './cmd/protonvpn-wg'], {
    cwd: src, env: { ...process.env, GOOS: 'darwin', GOARCH: t.goarch, CGO_ENABLED: '0' },
  });
  slices[t.key] = { sha256: sha256(file) };
}

run('lipo', ['-create', ...targets.map(t => path.join(work, `proton-confgen-${t.key}`)), '-output', out]);
// O afterPack assina de novo com o mesmo nome de arquivo; a assinatura ad-hoc
// é determinística, então o hash abaixo continua valendo dentro do .app.
run('codesign', ['--force', '--sign', '-', out]);
if (!statSync(out).size) throw new Error('proton-confgen universal vazio');

const repoRoot = path.join(root, '..');
let buildCommit = null;
let sourceCommit = null;
try {
  buildCommit = run('git', ['rev-parse', 'HEAD'], { cwd: repoRoot });
  // Num clone raso o git log atribui tudo ao commit-enxerto: sem histórico, não há como saber
  if (run('git', ['rev-parse', '--is-shallow-repository'], { cwd: repoRoot }) === 'false') {
    sourceCommit = run('git', ['log', '-1', '--format=%H', '--', 'tools/proton-confgen'], { cwd: repoRoot }) || null;
  }
} catch {}

const manifest = {
  version,
  source: 'tools/proton-confgen',
  buildCommit,
  sourceCommit,
  goVersion: run('go', ['env', 'GOVERSION'], { cwd: src }),
  buildArgs: buildArgs.slice(0, -1),
  slices,
  universal: { file: 'proton-confgen', sha256: sha256(out) },
};
writeFileSync(path.join(outDir, 'proton-confgen-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`proton-confgen universal ${manifest.universal.sha256}`);
