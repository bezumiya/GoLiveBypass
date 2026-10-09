import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as child_process from 'child_process';
import * as crypto from 'crypto';
import { app } from 'electron';

const DEFAULT_REPO = 'bezumiya/GoLiveBypass';

/** Repo de releases: `updateRepo` do package.json empacotado (definido no build) ou o padrão. */
export function updateRepo(pkgJson: string | null): string {
  try {
    const repo = pkgJson ? JSON.parse(pkgJson).updateRepo : undefined;
    if (typeof repo === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return repo;
  } catch { /* package.json ilegível: usa o padrão */ }
  return DEFAULT_REPO;
}

function releasesUrl(): string {
  // GOLIVE_UPDATE_FEED aponta para um feed local (http://127.0.0.1) só em testes
  if (process.env.GOLIVE_UPDATE_FEED) return process.env.GOLIVE_UPDATE_FEED;
  let pkg: string | null = null;
  try { pkg = fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8'); } catch {}
  return `https://api.github.com/repos/${updateRepo(pkg)}/releases?per_page=100`;
}

export interface UpdateInfo {
  available: boolean;
  latestVersion?: string;
  downloadUrl?: string;
  sha256?: string;
  currentVersion: string;
}

export interface PendingUpdate { downloadUrl: string; sha256: string }

const isLocal = (u: string) => /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u);

/** GET com redirecionamentos; http só é aceito para localhost. */
function request(url: string, redirects = 5): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https://') ? https : isLocal(url) ? http : null;
    if (!mod) return reject(new Error(`URL não permitida: ${url}`));
    mod.get(url, {
      headers: { 'User-Agent': 'GoLiveBypass-Updater', Accept: 'application/vnd.github+json, application/octet-stream' },
      timeout: 30_000,
    }, (res) => {
      const code = res.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
        res.resume();
        if (redirects <= 0) return reject(new Error('Redirecionamentos demais'));
        return resolve(request(new URL(res.headers.location, url).toString(), redirects - 1));
      }
      if (code !== 200) { res.resume(); return reject(new Error(`HTTP ${code}`)); }
      resolve(res);
    }).on('error', reject).on('timeout', function (this: http.ClientRequest) { this.destroy(new Error('timeout')); });
  });
}

async function httpsGet(url: string): Promise<string> {
  const res = await request(url);
  let data = '';
  for await (const c of res) data += c.toString();
  return data;
}

export async function downloadFile(url: string, dest: string): Promise<void> {
  const res = await request(url);
  await new Promise<void>((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    res.pipe(file);
    file.on('finish', () => file.close(() => resolve()));
    file.on('error', reject);
    res.on('error', reject);
  });
}

function semverGt(a: string, b: string): boolean {
  const parse = (v: string) => v.replace(/^v/, '').split('.').map(Number);
  const [am, an, ap] = parse(a);
  const [bm, bn, bp] = parse(b);
  if (am !== bm) return am > bm;
  if (an !== bn) return an > bn;
  return ap > bp;
}

// Só o DMG deste app; o GoLiveBypass.dmg das releases upstream é outro produto
const ASSET_RE = /^GoLiveBypass-macos-.+-(arm64|x64|universal)\.dmg$/;
// Releases macOS usam a tag macos-vX.Y.Z; vX.Y.Z fica aceito para releases de forks
const TAG_RE = /^(?:macos-)?v?(\d+\.\d+\.\d+)$/;
const SHA_RE = /^[0-9a-f]{64}$/;

export function pickAsset(assets: any[], arch: string = process.arch): any | undefined {
  const mine = (assets ?? []).filter((a: any) => ASSET_RE.test(a?.name ?? ''));
  const want = arch === 'arm64' ? 'arm64' : 'x64';
  return mine.find((a: any) => a.name.endsWith(`-${want}.dmg`))
      ?? mine.find((a: any) => a.name.endsWith('-universal.dmg'));
}

/** SHA-256 publicado do asset: o digest do GitHub ou o sidecar <nome>.sha256. */
export async function expectedSha256(asset: any, assets: any[], get: (url: string) => Promise<string> = httpsGet): Promise<string | null> {
  const digest = /^sha256:([0-9a-f]{64})$/i.exec(String(asset?.digest ?? ''));
  if (digest) return digest[1].toLowerCase();
  const sidecar = (assets ?? []).find((a: any) => a?.name === `${asset.name}.sha256`);
  if (!sidecar?.browser_download_url) return null;
  try {
    const hex = (await get(sidecar.browser_download_url)).trim().split(/\s+/)[0]?.toLowerCase() ?? '';
    return SHA_RE.test(hex) ? hex : null;
  } catch { return null; }
}

/** Maior versão estável com DMG deste app acima da atual (a ordem da API não importa). */
export function pickRelease(releases: any[], current: string, arch: string = process.arch) {
  let best: { version: string; asset: any; assets: any[] } | null = null;
  for (const release of releases ?? []) {
    if (release?.draft || release?.prerelease) continue;
    const m = TAG_RE.exec(String(release?.tag_name ?? ''));
    if (!m) continue;
    const asset = pickAsset(release.assets, arch);
    if (!asset) continue;
    if (!semverGt(m[1], current)) continue;
    if (!best || semverGt(m[1], best.version)) best = { version: m[1], asset, assets: release.assets };
  }
  return best;
}

/** Consulta GitHub Releases estáveis e retorna info de atualização */
export async function checkForUpdate(): Promise<UpdateInfo> {
  const current = app.getVersion();
  try {
    const releases = JSON.parse(await httpsGet(releasesUrl())) as any[];
    const best = pickRelease(releases, current);
    if (!best) return { available: false, currentVersion: current };
    // Sem hash publicado não há como conferir o download: a atualização não é oferecida
    const sha256 = await expectedSha256(best.asset, best.assets);
    if (!sha256) return { available: false, currentVersion: current };
    return {
      available: true, latestVersion: best.version, downloadUrl: best.asset.browser_download_url,
      sha256, currentVersion: current,
    };
  } catch {}
  return { available: false, currentVersion: current };
}

export function fileSha256(p: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(p).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

/** Baixa a nova versão, confere o SHA-256 e só então abre o DMG */
export async function downloadAndInstall(
  update: PendingUpdate,
  onProgress: (msg: string) => void,
): Promise<{ ok: boolean; error?: string }> {
  const tmpDir = path.join(app.getPath('temp'), 'golivebypass-update');
  fs.mkdirSync(tmpDir, { recursive: true });
  const dmgPath = path.join(tmpDir, 'GoLiveBypass-update.dmg');

  try {
    if (!SHA_RE.test(update.sha256)) throw new Error('SHA-256 publicado inválido');
    onProgress('Baixando atualização…');
    await downloadFile(update.downloadUrl, dmgPath);
    onProgress('Conferindo SHA-256…');
    if (await fileSha256(dmgPath) !== update.sha256) {
      fs.rmSync(dmgPath, { force: true });
      throw new Error('o arquivo baixado não confere com o SHA-256 publicado');
    }
    onProgress('Abrindo instalador…');
    child_process.spawn('open', [dmgPath], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e.message ?? String(e) };
  }
}
