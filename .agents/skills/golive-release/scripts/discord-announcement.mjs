#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function announcement(release, notes = '') {
  if (release.draft) throw new Error('A release ainda é draft.');
  const match = /^v?(\d+\.\d+\.\d+)(-[0-9A-Za-z.-]+)?$/.exec(release.tag_name);
  if (!match || Boolean(match[2]) !== release.prerelease) throw new Error('Versão e classificação prerelease inconsistentes.');
  const assets = release.assets ?? [];
  if (!assets.length) throw new Error('Release sem artefatos publicados.');
  const platforms = [
    assets.some(a => /\.exe$/i.test(a.name)) && 'Windows',
    assets.some(a => /\.AppImage$/i.test(a.name)) && 'Linux',
    assets.some(a => /\.dmg$/i.test(a.name)) && 'macOS',
  ].filter(Boolean);
  const text = [
    `GoLiveBypass ${release.tag_name} — ${release.prerelease ? 'BETA' : 'ESTÁVEL'}`,
    notes.trim(),
    platforms.length ? `Downloads disponíveis: ${platforms.join(', ')}.` : 'Artefatos disponíveis na página da release.',
    release.prerelease ? 'Versão de teste. Para receber betas no app, ative Canal beta nas configurações.' : 'Nova versão estável disponível.',
    release.html_url,
  ].filter(Boolean).join('\n\n');
  if (text.length > 2000) throw new Error('Aviso excede 2000 caracteres; reduza o resumo.');
  return { content: text, allowed_mentions: { parse: [] } };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Uso: discord-announcement.mjs --repo OWNER/REPO --tag TAG [--notes-file FILE] [--copy | --channel ID --send]\nSem --send, nenhuma mensagem é enviada. Webhook opcional: DISCORD_WEBHOOK_URL.');
    return;
  }
  const opts = {};
  while (args.length) {
    const key = args.shift();
    if (['--send', '--copy'].includes(key)) opts[key] = true;
    else if (['--repo', '--tag', '--channel', '--notes-file'].includes(key) && args[0] && !args[0].startsWith('--')) opts[key] = args.shift();
    else throw new Error('Argumento inválido; use --help.');
  }
  const repo = opts['--repo'];
  const tag = opts['--tag'];
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '') || !/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag ?? '')) throw new Error('Informe --repo OWNER/REPO e --tag válidos.');
  if (opts['--copy'] && opts['--send']) throw new Error('Escolha --copy ou --send.');
  const release = JSON.parse(execFileSync('gh', ['api', `repos/${repo}/releases/tags/${encodeURIComponent(tag)}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  const payload = announcement(release, opts['--notes-file'] ? readFileSync(opts['--notes-file'], 'utf8') : '');
  console.log(payload.content);
  if (opts['--copy']) {
    for (const [cmd, params] of [['wl-copy', []], ['xclip', ['-selection', 'clipboard']]]) {
      const result = spawnSync(cmd, params, { input: payload.content, timeout: 5000, stdio: ['pipe', 'ignore', 'ignore'] });
      if (!result.error && result.status === 0) { console.log('\nCopiado. Confira a conta local e o canal antes de enviar.'); return; }
    }
    throw new Error('Clipboard indisponível. Copie a prévia acima manualmente.');
  }
  if (!opts['--send']) return;
  if (!/^\d{17,20}$/.test(opts['--channel'] ?? '')) throw new Error('Envio exige --channel com o ID confirmado do canal.');
  let url;
  try { url = new URL(process.env.DISCORD_WEBHOOK_URL); } catch { throw new Error('Configure DISCORD_WEBHOOK_URL no ambiente local.'); }
  if (url.origin !== 'https://discord.com' || !/^\/api(?:\/v10)?\/webhooks\/\d+\/[\w-]+$/.test(url.pathname)) throw new Error('URL de webhook Discord inválida.');
  url.search = ''; url.hash = '';
  const request = async (options = {}) => {
    let response;
    try { response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(20000) }); }
    catch { throw new Error('Falha de rede. Se ocorreu durante o envio, confira o canal antes de repetir.'); }
    if (!response.ok) throw new Error(`Discord respondeu HTTP ${response.status}. Confira o canal antes de repetir; não houve retentativa automática.`);
    return response.json();
  };
  const webhook = await request();
  if (webhook.channel_id !== opts['--channel']) throw new Error('O webhook pertence a outro canal. Envio cancelado.');
  url.searchParams.set('wait', 'true');
  const message = await request({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!message.id) throw new Error('Resposta sem ID. Confira o canal antes de repetir.');
  console.log(`\nMensagem enviada. ID: ${message.id}; canal: ${message.channel_id}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    // Erros de subprocesso podem conter stderr: não despejar credenciais/respostas.
    console.error(error.status !== undefined ? 'Falha ao consultar release com gh; confira autenticação, repo e tag.' : error.message);
    process.exitCode = 1;
  });
}
