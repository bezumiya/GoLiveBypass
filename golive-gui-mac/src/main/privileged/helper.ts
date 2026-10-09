import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as child_process from 'child_process';
import { promisify } from 'util';
import { DISCORD_ALLOWED_IPS, DISCORD_REJECT_V6 } from '../config/rewrite';

const execFile = promisify(child_process.execFile);

export const HELPER_DIR  = '/Library/PrivilegedHelperTools/GoLiveBypass';
export const HELPER_PATH = `${HELPER_DIR}/helper`;
const SUDOERS_PATH = '/etc/sudoers.d/golivebypass';
const SUDO_DENIED  = /sudo:\s*(no tty|a terminal|a password is required|password is required)/i;

export type HelperAction = 'up' | 'down';

interface ExecResult { code: number; stdout: string; stderr: string; }

// Pedidos de senha esperam o usuário: precisam de mais tempo que um comando comum
const PROMPT_TIMEOUT_MS = 5 * 60_000;

async function execCmd(cmd: string, args: string[], timeout = 90_000): Promise<ExecResult & { timedOut?: boolean }> {
  try {
    const r = await execFile(cmd, args, { encoding: 'utf8', timeout }) as any;
    return { code: 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  } catch (e: any) {
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      stdout: e.stdout ?? '', stderr: e.stderr ?? String(e.message ?? ''),
      timedOut: e.killed === true && e.signal === 'SIGTERM',
    };
  }
}

export const HELPER_BINS = ['wg', 'wg-quick', 'wireguard-go'];

/** Hash dos binários empacotados: mudar qualquer um força reinstalar o helper. */
export function binsHash(binDir: string): string {
  const h = crypto.createHash('sha256');
  for (const b of HELPER_BINS) h.update(b).update(fs.readFileSync(path.join(binDir, b)));
  return h.digest('hex');
}

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Helper root. O conf do usuário é sanitizado (sem PostUp/DNS etc.) e o
 * AllowedIPs é sempre forçado para os ranges do Discord, qualquer que seja o
 * conf. Binários ficam numa pasta root-owned, nunca no bundle gravável do app.
 */
export function helperScript(bins = ''): string {
  const D = HELPER_DIR;
  const v6 = DISCORD_REJECT_V6.join(' ');
  return `#!/bin/bash
# GoLiveBypass privileged helper v4 — não edite; gerado pelo app.
# bins: ${bins}
set -euo pipefail
export PATH='${D}/bin:/usr/bin:/bin:/usr/sbin:/sbin'
export WG_QUICK_USERSPACE_IMPLEMENTATION=wireguard-go
umask 077

sudouser="\${SUDO_USER:-}"
case "$sudouser" in ''|root|*[!A-Za-z0-9._-]*) echo bad_user >&2; exit 64;; esac
home=$(dscl . -read "/Users/$sudouser" NFSHomeDirectory 2>/dev/null | awk '{print $2}')
[ -n "$home" ] && [ -d "$home" ] || { echo bad_home >&2; exit 64; }
src="$home/Library/Application Support/GoLiveBypass/golive.conf"
conf='${D}/golive.conf'
name_file=/var/run/wireguard/golive.name

sanitize() {
  [ -f "$src" ] && [ ! -L "$src" ] || { echo no_config >&2; exit 65; }
  awk -v allowed='${DISCORD_ALLOWED_IPS}' '
    BEGIN {
      keep["privatekey"]="PrivateKey"; keep["address"]="Address"; keep["listenport"]="ListenPort"
      keep["mtu"]="MTU"; keep["publickey"]="PublicKey"; keep["presharedkey"]="PresharedKey"
      keep["endpoint"]="Endpoint"; keep["persistentkeepalive"]="PersistentKeepalive"
    }
    { t=$0; sub(/\\r$/,"",t); gsub(/^[ \\t]+|[ \\t]+$/,"",t); lt=tolower(t) }
    lt=="[interface]" {print "[Interface]"; next}
    lt=="[peer]" {print "[Peer]"; print "AllowedIPs = " allowed; next}
    {
      i=index(t,"="); if (i==0) next
      k=tolower(substr(t,1,i-1)); gsub(/[ \\t]+$/,"",k)
      v=substr(t,i+1); gsub(/^[ \\t]+/,"",v)
      if (k in keep) print keep[k] " = " v
    }
  ' "$src" > "$conf.tmp"
  mv -f "$conf.tmp" "$conf"
}

v6_reject_add() { for n in ${v6}; do route -q -n add -inet6 -net "$n" ::1 -reject >/dev/null 2>&1 || true; done; }
v6_reject_del() { for n in ${v6}; do route -q -n delete -inet6 -net "$n" ::1 -reject >/dev/null 2>&1 || true; done; }

case "\${1:-}" in
  up)
    sanitize
    wg-quick down "$conf" >/dev/null 2>&1 || true
    rm -f "$name_file" 2>/dev/null || true
    wg-quick up "$conf"
    real_iface=golive
    [ -f "$name_file" ] && real_iface="$(cat "$name_file")"

    ok=0
    for i in $(seq 1 15); do
      hs=$(wg show "$real_iface" latest-handshakes 2>/dev/null | awk '{print $2}' | head -1 || true)
      if [ -n "$hs" ] && [ "$hs" != "0" ]; then ok=1; break; fi
      sleep 1
    done
    if [ "$ok" != "1" ]; then
      wg-quick down "$conf" || true
      echo handshake_timeout >&2; exit 2
    fi
    # Discord via IPv6 escaparia do túnel (IPv4-only): rejeita só os ranges dele
    v6_reject_add
    ;;

  down)
    v6_reject_del
    [ -f "$conf" ] || sanitize
    wg-quick down "$conf" || true
    ;;

  *) echo usage >&2; exit 64;;
esac
`;
}

/** Rotas de rejeição IPv6 do helper ainda no sistema (sobram se o app morrer com o túnel ativo). */
export function hasV6Rejects(netstatInet6: string): boolean {
  return netstatInet6.split(/\r?\n/).some(l => {
    const [dest, , flags] = l.trim().split(/\s+/);
    return DISCORD_REJECT_V6.includes(dest) && /R/.test(flags ?? '');
  });
}

/**
 * Sem túnel ativo, remove rejeições IPv6 que sobraram de um crash. Só pelo
 * sudo sem senha: na abertura do app não cabe um pedido de senha.
 */
export async function cleanupStaleV6Rejects(binDir: string): Promise<boolean> {
  const routes = await execCmd('/usr/sbin/netstat', ['-rn', '-f', 'inet6']);
  if (!hasV6Rejects(routes.stdout) || !helperReady(binDir)) return false;
  return (await execCmd('/usr/bin/sudo', ['-n', HELPER_PATH, 'down'])).code === 0;
}

/** Vale para qualquer administrador; o helper acha o conf de cada um pelo SUDO_USER. */
export function sudoersContent(): string {
  return (
    `Defaults!${HELPER_PATH} !requiretty\n` +
    `%admin ALL=(root) NOPASSWD: ${HELPER_PATH} up, ${HELPER_PATH} down\n`
  );
}

/** Pronto = sudoers presente e helper root-owned com o conteúdo desta versão e destes binários. */
export function helperReady(binDir: string): boolean {
  try {
    if (!fs.existsSync(SUDOERS_PATH)) return false;
    const st = fs.statSync(HELPER_PATH);
    if (st.uid !== 0 || (st.mode & 0o022) !== 0) return false;
    return fs.readFileSync(HELPER_PATH, 'utf8') === helperScript(binsHash(binDir));
  } catch { return false; }
}

/** Instala/atualiza helper, binários e sudoers via osascript (prompt de admin). */
export async function installHelper(binDir: string): Promise<{ ok: boolean; error?: string }> {
  const installScript = `
set -e
mkdir -p ${shq(HELPER_DIR)}/bin
for b in ${HELPER_BINS.join(' ')}; do cp -f ${shq(binDir)}/"$b" ${shq(HELPER_DIR)}/bin/"$b"; done
chown -R root:wheel ${shq(HELPER_DIR)}
chmod 755 ${shq(HELPER_DIR)} ${shq(HELPER_DIR)}/bin ${shq(HELPER_DIR)}/bin/*
cat > ${shq(HELPER_PATH)} << 'HELPEREOF'
${helperScript(binsHash(binDir))}HELPEREOF
chmod 755 ${shq(HELPER_PATH)}
chown root:wheel ${shq(HELPER_PATH)}
cat > ${shq(SUDOERS_PATH)}.tmp << 'SUDOERSEOF'
${sudoersContent()}SUDOERSEOF
chmod 440 ${shq(SUDOERS_PATH)}.tmp
chown root:wheel ${shq(SUDOERS_PATH)}.tmp
visudo -c -f ${shq(SUDOERS_PATH)}.tmp >/dev/null
mv -f ${shq(SUDOERS_PATH)}.tmp ${shq(SUDOERS_PATH)}
`;
  const b64 = Buffer.from(installScript).toString('base64');
  const osaCmd = `printf %s '${b64}' | base64 -D | bash 2>&1`;
  const r = await execCmd('osascript', ['-e', `do shell script "${osaCmd}" with administrator privileges`], PROMPT_TIMEOUT_MS);
  if (r.code !== 0) {
    const out = r.stdout + r.stderr;
    if (r.timedOut) return { ok: false, error: 'o pedido de senha expirou sem resposta' };
    if (/user cancel|-128/i.test(out)) return { ok: false, error: 'user_cancelled' };
    return { ok: false, error: out.trim() || 'install_failed' };
  }
  return { ok: true };
}

/** Executa a ação via sudo -n (NOPASSWD); cai no prompt de admin se o sudo negar. */
export async function runViaHelper(
  action: HelperAction,
  user: string,
): Promise<{ code: number; stderr: string; usedPrompt: boolean }> {
  const r = await execCmd('/usr/bin/sudo', ['-n', HELPER_PATH, action]);
  if (r.code === 0) return { code: 0, stderr: r.stdout + r.stderr, usedPrompt: false };
  const out = r.stderr + r.stdout;
  if (!SUDO_DENIED.test(out)) return { code: r.code, stderr: out, usedPrompt: false };
  if (!/^[A-Za-z0-9._-]+$/.test(user)) return { code: 64, stderr: 'bad_user', usedPrompt: false };

  // Fora do sudo não há SUDO_USER; o helper usa-o para achar o conf do usuário
  const osaCmd = `SUDO_USER=${user} ${HELPER_PATH} ${action} 2>&1`;
  const o = await execCmd('osascript', ['-e', `do shell script "${osaCmd}" with administrator privileges`], PROMPT_TIMEOUT_MS);
  return { code: o.code, stderr: o.stdout + o.stderr, usedPrompt: true };
}
