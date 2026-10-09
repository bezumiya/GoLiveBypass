import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as child_process from 'child_process';
import { downloadFile } from '../updater';

const CLI_URL = 'https://github.com/Vencord/Installer/releases/download/v1.4.2/VencordInstallerCli-darwin';
const CLI_SHA256 = 'f4c77a9dddd4a12deaae270b3dadfda25969dfcfa141cc2354cafe6344044b75';

/** Bloqueio do macOS "Gerenciamento de Apps" ao alterar o bundle do Discord. */
export class AppManagementDenied extends Error {}

const sha256 = (p: string) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

/** O instalador do Vencord move o asar original para _app.asar e põe o shim no lugar. */
export const isVencordInjected = (discordApp: string) =>
  fs.existsSync(path.join(discordApp, 'Contents', 'Resources', '_app.asar'));

/**
 * Sonda o "Gerenciamento de Apps": criar um arquivo no bundle do Discord é a
 * mesma operação que o instalador faz. A tentativa negada também faz o macOS
 * listar o GoLiveBypass no painel, pronto para ser ligado.
 */
export function canModifyApp(discordApp: string): boolean {
  const probe = path.join(discordApp, 'Contents', 'Resources', '.golivebypass-probe');
  try {
    fs.writeFileSync(probe, '');
    fs.rmSync(probe, { force: true });
    return true;
  } catch (e: any) {
    if (e?.code === 'EPERM' || e?.code === 'EACCES') return false;
    throw e;
  }
}

export function vencordSettingsPath(home: string): string {
  return path.join(home, 'Library', 'Application Support', 'Vencord', 'settings', 'settings.json');
}

/**
 * Liga o FakeNitro só se o usuário nunca escolheu nada para ele: um
 * `enabled` já gravado (ligado ou desligado) é preferência dele e fica.
 * Devolve se o arquivo foi alterado.
 */
export function enableFakeNitroIfUnset(home: string): boolean {
  const p = vencordSettingsPath(home);
  let settings: any = {};
  if (fs.existsSync(p)) {
    try { settings = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return false; /* ilegível: não reescreve */ }
  }
  if (typeof settings !== 'object' || settings === null) return false;
  if (typeof settings.plugins?.FakeNitro?.enabled === 'boolean') return false;
  settings.plugins ??= {};
  settings.plugins.FakeNitro = { ...(settings.plugins.FakeNitro ?? {}), enabled: true };
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(settings, null, 4));
  return true;
}

async function ensureCli(cacheDir: string, log: (m: string) => void): Promise<string> {
  const cli = path.join(cacheDir, 'VencordInstallerCli-darwin');
  if (fs.existsSync(cli) && sha256(cli) === CLI_SHA256) return cli;
  log('Baixando instalador do Vencord…');
  fs.mkdirSync(cacheDir, { recursive: true });
  const tmp = `${cli}.download`;
  await downloadFile(CLI_URL, tmp);
  if (sha256(tmp) !== CLI_SHA256) {
    fs.rmSync(tmp, { force: true });
    throw new Error('SHA-256 do instalador do Vencord não confere');
  }
  fs.chmodSync(tmp, 0o755);
  fs.renameSync(tmp, cli);
  return cli;
}

const fakeNitroMsg = (changed: boolean) =>
  changed ? 'FakeNitro ligado.' : 'FakeNitro mantido como você deixou no Vencord.';

/**
 * Injeta o Vencord (se ainda não estiver) e liga o FakeNitro se o usuário
 * nunca mexeu nele. Só é chamado com o opt-in ligado; nada é escrito antes
 * de a permissão estar confirmada.
 */
export async function injectVencord(opts: {
  home: string; discordApp: string; cacheDir: string; log: (m: string) => void;
}): Promise<void> {
  if (isVencordInjected(opts.discordApp)) {
    opts.log(`Vencord já injetado. ${fakeNitroMsg(enableFakeNitroIfUnset(opts.home))}`);
    return;
  }
  if (!canModifyApp(opts.discordApp)) throw new AppManagementDenied('sem permissão de Gerenciamento de Apps');
  const cli = await ensureCli(opts.cacheDir, opts.log);
  opts.log('Injetando Vencord no Discord…');
  const out = await new Promise<string>((resolve, reject) => {
    child_process.execFile(cli, ['-install', '-location', opts.discordApp], { timeout: 120_000 }, (err, stdout, stderr) => {
      const msg = (stderr || stdout || err?.message || '').trim();
      if (err && /operation not permitted/i.test(msg)) reject(new AppManagementDenied(msg.slice(-400)));
      else if (err) reject(new Error(msg.slice(-400)));
      else resolve(stdout);
    });
  });
  if (!isVencordInjected(opts.discordApp)) {
    if (/operation not permitted/i.test(out)) throw new AppManagementDenied(out.trim().slice(-400));
    throw new Error(`instalador terminou sem injetar: ${out.trim().slice(-300)}`);
  }
  opts.log(`Vencord injetado. ${fakeNitroMsg(enableFakeNitroIfUnset(opts.home))}`);
}
