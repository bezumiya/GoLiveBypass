// Publica a release macOS com make_latest=false e falha se qualquer regra de
// scripts/release-guard.mjs não for cumprida, antes ou depois de publicar.
//
// Uso: node scripts/release-mac.mjs --repo bezumiya/GoLiveBypass --notes-file notas.md [--draft]
//      [--dmg dist-build/GoLiveBypass-macos-<versão>-universal.dmg] [--target <commit>]
//      node scripts/release-mac.mjs --repo bezumiya/GoLiveBypass --publish-draft
// Um draft se publica com --publish-draft, nunca pelo botão da interface do GitHub,
// que marca "Set as the latest release" por padrão.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  createPayload, dmgName, postflightErrors, preflightErrors, publishPayload, releaseTag,
} from './release-guard.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}
const flag = name => process.argv.includes(`--${name}`);

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')}: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
}
const gh = (args, input) => run('gh', args, input === undefined ? {} : { input });
const sha256 = p => createHash('sha256').update(readFileSync(p)).digest('hex');
function fail(errors) {
  for (const e of errors) console.error(`✗ ${e}`);
  process.exit(1);
}

function inspectDmg(dmg) {
  const mount = mkdtempSync(path.join(tmpdir(), 'glb-dmg-'));
  run('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, dmg]);
  try {
    const res = path.join(mount, 'GoLiveBypass.app', 'Contents', 'Resources');
    const asar = require('@electron/asar');
    const pkg = JSON.parse(asar.extractFile(path.join(res, 'app.asar'), 'package.json').toString('utf8'));
    const pcDir = path.join(res, 'extra', 'proton-confgen');
    const manifest = JSON.parse(readFileSync(path.join(pcDir, 'proton-confgen-manifest.json'), 'utf8'));
    return {
      version: pkg.version,
      updateRepo: pkg.updateRepo,
      protonSha: sha256(path.join(pcDir, 'proton-confgen')),
      protonManifestSha: manifest?.universal?.sha256,
    };
  } finally {
    run('hdiutil', ['detach', mount, '-quiet']);
  }
}

async function latestTag(repo) {
  const r = spawnSync('gh', ['api', `repos/${repo}/releases/latest`, '--jq', '.tag_name'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() || null : null;
}

/** Release com a tag, drafts incluídos (GET /releases/tags/{tag} não devolve drafts). */
function findRelease(repo, tag) {
  const ids = gh(['api', '--paginate', `repos/${repo}/releases?per_page=100`, '--jq', `.[] | select(.tag_name == "${tag}") | .id`]);
  const list = ids.split('\n').filter(Boolean);
  if (list.length > 1) fail([`há ${list.length} releases com a tag ${tag}; resolva à mão antes de continuar`]);
  return list.length ? JSON.parse(gh(['api', `repos/${repo}/releases/${list[0]}`])) : null;
}

const patch = (repo, id, body) => gh(['api', '-X', 'PATCH', `repos/${repo}/releases/${id}`, '--input', '-'], JSON.stringify(body));

/** Publica o draft e confere tudo; se algo falhar, volta para draft e devolve a latest. */
async function publishAndVerify(repo, version, draft, dmgSha) {
  const latestBefore = await latestTag(repo);
  patch(repo, draft.id, publishPayload());
  const release = JSON.parse(gh(['api', `repos/${repo}/releases/${draft.id}`]));
  const latestAfter = await latestTag(repo);
  const post = postflightErrors({ version, release, latestTagBefore: latestBefore, latestTagAfter: latestAfter, dmgSha256: dmgSha });
  if (!post.length) return { release, latestAfter };
  patch(repo, draft.id, { draft: true, make_latest: 'false' });
  post.push(`${releaseTag(version)} voltou para draft`);
  if (latestBefore && latestAfter !== latestBefore) {
    const prev = JSON.parse(gh(['api', `repos/${repo}/releases/tags/${latestBefore}`]));
    patch(repo, prev.id, { make_latest: 'true' });
    post.push(`latest devolvida para ${latestBefore}`);
  }
  fail(post);
}

const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const repo = arg('repo');
const tag = releaseTag(version);

if (flag('publish-draft')) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? '')) fail([`repositório inválido: ${repo}`]);
  const draft = findRelease(repo, tag);
  if (!draft) fail([`não há release ${tag} em ${repo}`]);
  if (!draft.draft) fail([`${tag} já está publicada`]);
  // O digest do DMG vem do próprio sidecar publicado no draft
  const side = (draft.assets ?? []).find(a => a.name === `${dmgName(version)}.sha256`);
  const dmgSha = side ? gh(['api', '-H', 'Accept: application/octet-stream', `repos/${repo}/releases/assets/${side.id}`]).split(/\s+/)[0] : '';
  const { release, latestAfter } = await publishAndVerify(repo, version, draft, dmgSha);
  console.log(`✓ ${release.html_url} publicada; latest continua ${latestAfter ?? 'nenhuma'}`);
  process.exit(0);
}

const notesFile = arg('notes-file');
const dmg = path.resolve(arg('dmg', path.join(root, 'dist-build', dmgName(version))));
const target = arg('target', run('git', ['rev-parse', 'HEAD'], { cwd: root }));

if (!notesFile || !existsSync(notesFile)) fail(['--notes-file é obrigatório']);
const files = {};
if (existsSync(dmg)) {
  const sidecar = `${dmg}.sha256`;
  writeFileSync(sidecar, `${sha256(dmg)}  ${path.basename(dmg)}\n`);
  files[path.basename(dmg)] = dmg;
  files[path.basename(sidecar)] = sidecar;
}
const bundled = files[dmgName(version)] ? inspectDmg(dmg) : null;
const pre = preflightErrors({ version, repo, files, bundled });
if (!pre.length && findRelease(repo, tag)) pre.push(`a release ${tag} já existe em ${repo} (draft incluído); apague-a ou use --publish-draft`);
if (pre.length) fail(pre);

const created = JSON.parse(gh(['api', '-X', 'POST', `repos/${repo}/releases`, '--input', '-'],
  JSON.stringify(createPayload({ version, target, notes: readFileSync(notesFile, 'utf8') }))));
console.log(`release ${tag} criada como draft (id ${created.id})`);
gh(['release', 'upload', tag, ...Object.values(files), '--repo', repo]);

if (flag('draft')) {
  const release = JSON.parse(gh(['api', `repos/${repo}/releases/${created.id}`]));
  const names = (release.assets ?? []).map(a => a.name).sort().join(', ');
  console.log(`✓ draft ${release.html_url} com ${names}. Publique com --publish-draft (não pelo botão do GitHub).`);
} else {
  const { release, latestAfter } = await publishAndVerify(repo, version, created, sha256(dmg));
  console.log(`✓ ${release.html_url} publicada; latest continua ${latestAfter ?? 'nenhuma'}`);
}
