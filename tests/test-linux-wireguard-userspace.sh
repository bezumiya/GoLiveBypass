#!/usr/bin/env bash
# Regressao do fallback real: o daemon deve manter o uplink fora de discord-vpn,
# registrar seu PID vivo e encerrar junto com o tunel. Dois peers wireguard-go e
# HTTP local comprovam handshake, download e upload sem depender da Internet.
# Tudo vive em user+net+mount namespaces descartaveis; nenhuma rede do host muda.
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "$0")/.." && pwd)"
BINARY="${WIREGUARD_GO_BINARY:-$ROOT/tools/wireguard-go/build/wireguard-go}"
skip() { printf 'SKIP: %s\n' "$1"; exit 0; }
fail() { printf 'FALHA: %s\n' "$1" >&2; exit 1; }
[ -x "$BINARY" ] || skip "wireguard-go nao compilado"
for dependency in unshare wg ip curl python3; do
    command -v "$dependency" >/dev/null 2>&1 || skip "$dependency ausente"
done
[ -e /dev/net/tun ] && [ -e /sys/class/misc/tun ] || skip "driver tun indisponivel"
if [ "${1:-}" != --isolated ]; then
    unshare -Urnm true 2>/dev/null || skip "user+net+mount namespace indisponivel"
    exec unshare -Urnm bash "$0" --isolated
fi
if [[ $(readlink /proc/1/ns/mnt) == $(readlink /proc/self/ns/mnt) || \
      $(readlink /proc/1/ns/net) == $(readlink /proc/self/ns/net) ]]; then
    fail "execucao sem isolamento de mounts/rede"
fi

umask 077
work="$(mktemp -d)"
STANDALONE_SRC="$work/standalone.sh"
WG_GO_SRC="$work/wireguard-go"
cp "$ROOT/standalone/golivebypass-standalone.sh" "$STANDALONE_SRC"
cp "$BINARY" "$WG_GO_SRC"
chmod +x "$WG_GO_SRC"
server=''; peer=''
cleanup() {
    trap - EXIT
    teardown_wireguard_netns >/dev/null 2>&1 || true
    [[ -z "$server" ]] || kill "$server" 2>/dev/null || true
    [[ -z "$peer" ]] || kill "$peer" 2>/dev/null || true
    # Tambem limpa o daemon orfao quando a regressao roda contra o codigo antigo.
    for entry in /proc/[0-9]*; do
        [[ $(cat "$entry/comm" 2>/dev/null || true) == wireguard-go ]] || continue
        [[ $(readlink "$entry/ns/user" 2>/dev/null || true) == $(readlink /proc/self/ns/user) ]] || continue
        kill "${entry##*/}" 2>/dev/null || true
    done
    wait 2>/dev/null || true
    rm -rf "$work"
}
trap cleanup EXIT
mount --make-rprivate /
mount -t tmpfs golive-userspace-test /run
mkdir -p /run/netns /run/wireguard "$work/netns-dns"
mount --bind "$work/netns-dns" /etc/netns
ip link set lo up
ip route > "$work/uplink-routes-before"
uplink_ns="$(readlink /proc/self/ns/net)"

# Carrega a implementacao mantida, sem executar o instalador/Discord.
python3 - "$STANDALONE_SRC" "$work/helper.sh" <<'PY'
import sys
from pathlib import Path
s = Path(sys.argv[1]).read_text()
marker = "printf '\\n  %sGoLiveBypass standalone%s\\n'"
Path(sys.argv[2]).write_text(s[:s.index(marker)])
PY
wg genkey > "$work/client.key"
wg genkey > "$work/peer.key"
wg pubkey < "$work/client.key" > "$work/client.pub"
wg pubkey < "$work/peer.key" > "$work/peer.pub"
cat > "$work/client.conf" <<EOF
[Interface]
PrivateKey = $(cat "$work/client.key")
Address = 10.9.0.2/32
[Peer]
PublicKey = $(cat "$work/peer.pub")
Endpoint = 127.0.0.1:51998
AllowedIPs = 0.0.0.0/0
PersistentKeepalive = 1
EOF
export GOLIVE_GUI=1 XDG_DATA_HOME="$work/data" SCRIPT_PATH="$STANDALONE_SRC"
source "$work/helper.sh" --real-home "$work" --yes --wg-conf "$work/client.conf" --wireguard-go "$WG_GO_SRC"
# So a selecao da capacidade do kernel e mascarada. Daemon, TUN, namespace,
# wg/UAPI, peer e HTTP sao reais, mesmo se o modulo do host estiver carregado.
wireguard_module_loaded() { return 1; }
MODPROBE_BINARY=/usr/bin/false
trap cleanup EXIT

"$WG_GO_SRC" -f wg-peer > "$work/peer.log" 2>&1 &
peer=$!
for _ in {1..50}; do
    [[ -S /run/wireguard/wg-peer.sock ]] && break
    sleep .1
done
wg set wg-peer private-key "$work/peer.key" listen-port 51998 peer "$(cat "$work/client.pub")" allowed-ips 10.9.0.2/32
ip address add 10.9.0.1/32 dev wg-peer
ip link set wg-peer up
ip route add 10.9.0.2/32 dev wg-peer

cat > "$work/server.py" <<'PY'
from http.server import BaseHTTPRequestHandler, HTTPServer
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = b'wireguard-userspace-ok'
        self.send_response(200); self.end_headers(); self.wfile.write(body)
    def do_POST(self):
        body = self.rfile.read(int(self.headers['Content-Length']))
        self.send_response(200); self.end_headers(); self.wfile.write(str(len(body)).encode())
    def log_message(self, *args): pass
HTTPServer(('10.9.0.1', 8768), Handler).serve_forever()
PY
python3 "$work/server.py" > "$work/http.log" 2>&1 &
server=$!
ensure_wireguard_device
setup_wireguard_netns
daemon="$(cat "$(wireguard_go_pid_file)")"
sleep .3
kill -0 "$daemon" 2>/dev/null || fail "pidfile aponta para um pai morto em vez do daemon"
[[ $(cat "/proc/$daemon/comm") == wireguard-go ]] || fail "pidfile nao identifica wireguard-go"
[[ $(readlink "/proc/$daemon/ns/net") == "$uplink_ns" ]] || fail "daemon perdeu o uplink original"
ip link show wg-discord >/dev/null 2>&1 && fail "TUN permaneceu na rede de saida"
ip -n "$NETNS_NAME" link show wg-discord >/dev/null || fail "TUN nao entrou no namespace Discord"

download=''
for _ in {1..30}; do
    download="$(ip netns exec "$NETNS_NAME" curl --noproxy '*' -fsS --max-time 1 http://10.9.0.1:8768/ 2>/dev/null)" && break
    sleep .1
done
[[ "$download" == wireguard-userspace-ok ]] || fail "download HTTP nao atravessou o tunel"
dd if=/dev/zero of="$work/upload.bin" bs=1024 count=256 status=none
uploaded="$(ip netns exec "$NETNS_NAME" curl --noproxy '*' -fsS --max-time 5 --data-binary "@$work/upload.bin" http://10.9.0.1:8768/)"
[[ "$uploaded" == 262144 ]] || fail "upload HTTP incompleto"
ip netns exec "$NETNS_NAME" wg show "$WG_IF" latest-handshakes | awk '$2 > 0 {ok=1} END {exit !ok}' || fail "handshake ausente"
ip netns exec "$NETNS_NAME" wg show "$WG_IF" transfer | awk '$2 > 0 && $3 > 262144 {ok=1} END {exit !ok}' || fail "transferencia real ausente"

teardown_wireguard_netns
kill -0 "$daemon" 2>/dev/null && fail "daemon ficou vivo depois do teardown"
[[ ! -e "$(wireguard_go_pid_file)" ]] || fail "pidfile permaneceu depois do teardown"
netns_exists && fail "namespace permaneceu depois do teardown"
[[ ! -S /run/wireguard/wg-discord.sock ]] || fail "socket UAPI permaneceu depois do teardown"
ip link del wg-peer
kill "$peer" 2>/dev/null || true
wait "$peer" 2>/dev/null || true
peer=''
ip route > "$work/uplink-routes-after"
cmp "$work/uplink-routes-before" "$work/uplink-routes-after" || fail "rota de saida nao restaurada"
printf 'OK: fallback do helper real, PID vivo no uplink, TUN isolado, handshake/download/upload e teardown sem residuos\n'
