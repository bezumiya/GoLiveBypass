// Command golive-tunnel is the macOS transport of the GoLiveBypass GUI.
//
// macOS has no per-process routing primitive equivalent to WireSock/WFP or a
// Linux network namespace, and a Network Extension would require an Apple
// Developer signature. The helper therefore routes by destination: it brings
// up a userspace WireGuard device on a utun interface and installs routes only
// for Discord's own address space (voice servers) and the dedicated Cloudflare
// addresses of Discord's gateway/API. Every other destination keeps using the
// normal network.
//
// This file holds the platform-independent parts so they can be tested on any
// OS; the privileged runtime lives in the *_darwin.go files.
package main

import (
	"bufio"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"sort"
	"strconv"
	"strings"
	"time"
)

const defaultMTU = 1420

// discordStaticPrefixes are registered to Discord Inc. (RIPE ORG-DI90-RIPE):
// voice/video media servers answer from these blocks.
//
// 104.29.128.0/19 is Cloudflare space, not Discord's, but it is where the
// voice/video/Go Live UDP of the São Paulo (c-gru*) servers answers today:
// the WebSocket goes to c-gru*.discord.media (162.159.x) while the media
// "server:" candidates in Discord's logs are 104.29.135-159.x. Without it
// the media server sees the Brazilian address and refuses the stream even
// though the gateway gate already passed.
var discordStaticPrefixes = []netip.Prefix{
	netip.MustParsePrefix("66.22.192.0/18"),
	netip.MustParsePrefix("195.62.89.0/24"),
	netip.MustParsePrefix("104.29.128.0/19"),
	netip.MustParsePrefix("2a0e:5940::/29"),
}

// discordHostnames are resolved periodically and routed as host routes. The
// gateway WebSocket is the address Discord uses to decide the region gate,
// so it must never leave through the normal network.
var discordHostnames = []string{
	"gateway.discord.gg",
	"gateway-us-east1-b.discord.gg",
	"gateway-us-east1-c.discord.gg",
	"gateway-us-east1-d.discord.gg",
	"discord.gg",
	"discord.com",
	"discordapp.com",
	"ptb.discord.com",
	"canary.discord.com",
	"status.discord.com",
	"updates.discord.com",
	"cdn.discordapp.com",
	"media.discordapp.net",
	"images-ext-1.discordapp.net",
	"images-ext-2.discordapp.net",
	"discord.media",
	"latency.discord.media",
}

// discordSeedHosts cover Discord's dedicated Cloudflare addresses before the
// first DNS refresh finishes, so the very first gateway connection after the
// relaunch already uses the tunnel. Observed pattern: 162.159.128-138.232-235.
func discordSeedHosts() []netip.Prefix {
	var seeds []netip.Prefix
	for third := 128; third <= 138; third++ {
		for fourth := 232; fourth <= 235; fourth++ {
			addr := netip.AddrFrom4([4]byte{162, 159, byte(third), byte(fourth)})
			seeds = append(seeds, netip.PrefixFrom(addr, 32))
		}
	}
	return seeds
}

// Config is the subset of a wg-quick configuration the helper understands.
// AllowedIPs and DNS are deliberately ignored: the helper decides which
// destinations enter the tunnel and never touches the system resolver.
type Config struct {
	PrivateKey   string
	PublicKey    string
	PresharedKey string
	Endpoint     string
	Keepalive    int
	MTU          int
	Addresses    []netip.Prefix
}

func ParseConfig(raw string) (Config, error) {
	cfg := Config{MTU: defaultMTU}
	section := ""
	peers := 0
	scanner := bufio.NewScanner(strings.NewReader(raw))
	scanner.Buffer(make([]byte, 64*1024), 64*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if i := strings.IndexAny(line, "#;"); i >= 0 {
			line = strings.TrimSpace(line[:i])
		}
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			section = strings.ToLower(strings.TrimSpace(line[1 : len(line)-1]))
			if section == "peer" {
				peers++
			}
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			return Config{}, fmt.Errorf("linha inválida na configuração: %q", truncate(line, 40))
		}
		key = strings.ToLower(strings.TrimSpace(key))
		value = strings.TrimSpace(value)
		switch section {
		case "interface":
			switch key {
			case "privatekey":
				cfg.PrivateKey = value
			case "address":
				for _, part := range strings.Split(value, ",") {
					prefix, err := parseAddress(strings.TrimSpace(part))
					if err != nil {
						return Config{}, err
					}
					cfg.Addresses = append(cfg.Addresses, prefix)
				}
			case "mtu":
				mtu, err := strconv.Atoi(value)
				if err != nil || mtu < 1280 || mtu > 9000 {
					return Config{}, errors.New("MTU inválido")
				}
				cfg.MTU = mtu
			}
		case "peer":
			if peers > 1 {
				continue
			}
			switch key {
			case "publickey":
				cfg.PublicKey = value
			case "presharedkey":
				cfg.PresharedKey = value
			case "endpoint":
				cfg.Endpoint = value
			case "persistentkeepalive":
				keepalive, err := strconv.Atoi(value)
				if err != nil || keepalive < 0 || keepalive > 65535 {
					return Config{}, errors.New("PersistentKeepalive inválido")
				}
				cfg.Keepalive = keepalive
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return Config{}, err
	}
	if peers != 1 {
		return Config{}, fmt.Errorf("a configuração precisa de exatamente um [Peer] (encontrados: %d)", peers)
	}
	if _, err := keyToHex(cfg.PrivateKey); err != nil {
		return Config{}, errors.New("PrivateKey inválida")
	}
	if _, err := keyToHex(cfg.PublicKey); err != nil {
		return Config{}, errors.New("PublicKey inválida")
	}
	if cfg.PresharedKey != "" {
		if _, err := keyToHex(cfg.PresharedKey); err != nil {
			return Config{}, errors.New("PresharedKey inválida")
		}
	}
	if len(cfg.Addresses) == 0 {
		return Config{}, errors.New("a configuração não contém Address")
	}
	if _, _, err := net.SplitHostPort(cfg.Endpoint); err != nil {
		return Config{}, errors.New("Endpoint inválido")
	}
	return cfg, nil
}

func parseAddress(value string) (netip.Prefix, error) {
	if prefix, err := netip.ParsePrefix(value); err == nil {
		return netip.PrefixFrom(prefix.Addr(), prefix.Addr().BitLen()), nil
	}
	addr, err := netip.ParseAddr(value)
	if err != nil {
		return netip.Prefix{}, fmt.Errorf("Address inválido: %q", truncate(value, 60))
	}
	return netip.PrefixFrom(addr, addr.BitLen()), nil
}

func keyToHex(value string) (string, error) {
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(value))
	if err != nil || len(decoded) != 32 {
		return "", errors.New("chave WireGuard inválida")
	}
	return hex.EncodeToString(decoded), nil
}

// UAPI renders the configuration for device.IpcSet. The endpoint must
// already be resolved to an address; see ResolveEndpoint.
func (c Config) UAPI(endpoint netip.AddrPort) (string, error) {
	private, err := keyToHex(c.PrivateKey)
	if err != nil {
		return "", err
	}
	public, err := keyToHex(c.PublicKey)
	if err != nil {
		return "", err
	}
	var b strings.Builder
	fmt.Fprintf(&b, "private_key=%s\nreplace_peers=true\npublic_key=%s\n", private, public)
	if c.PresharedKey != "" {
		psk, err := keyToHex(c.PresharedKey)
		if err != nil {
			return "", err
		}
		fmt.Fprintf(&b, "preshared_key=%s\n", psk)
	}
	fmt.Fprintf(&b, "endpoint=%s\n", endpoint.String())
	if c.Keepalive > 0 {
		fmt.Fprintf(&b, "persistent_keepalive_interval=%d\n", c.Keepalive)
	}
	// Cryptokey routing accepts any inner address: the kernel routes installed
	// by the helper are what restrict the tunnel to Discord.
	b.WriteString("replace_allowed_ips=true\nallowed_ip=0.0.0.0/0\nallowed_ip=::/0\n")
	return b.String(), nil
}

func ResolveEndpoint(endpoint string, lookup func(host string) ([]netip.Addr, error)) (netip.AddrPort, error) {
	host, portText, err := net.SplitHostPort(endpoint)
	if err != nil {
		return netip.AddrPort{}, errors.New("Endpoint inválido")
	}
	port, err := strconv.Atoi(portText)
	if err != nil || port < 1 || port > 65535 {
		return netip.AddrPort{}, errors.New("porta do Endpoint inválida")
	}
	if addr, err := netip.ParseAddr(host); err == nil {
		return netip.AddrPortFrom(addr.Unmap(), uint16(port)), nil
	}
	addrs, err := lookup(host)
	if err != nil || len(addrs) == 0 {
		return netip.AddrPort{}, fmt.Errorf("não consegui resolver o Endpoint %s", truncate(host, 80))
	}
	// Prefer IPv4: most home connections in Brazil still have partial IPv6.
	sort.SliceStable(addrs, func(i, j int) bool { return addrs[i].Is4() && !addrs[j].Is4() })
	return netip.AddrPortFrom(addrs[0].Unmap(), uint16(port)), nil
}

// EndpointConflict reports whether the WireGuard endpoint itself would be
// routed into the tunnel, which would make the tunnel unreachable.
func EndpointConflict(endpoint netip.Addr, prefixes []netip.Prefix) bool {
	for _, prefix := range prefixes {
		if prefix.Contains(endpoint) {
			return true
		}
	}
	return false
}

// AcceptResolvedAddress filters DNS answers before they become routes. A
// hijacked or split-horizon resolver must not be able to pull LAN or special
// addresses into the tunnel.
func AcceptResolvedAddress(addr netip.Addr) bool {
	addr = addr.Unmap()
	if !addr.IsValid() || addr.IsUnspecified() || addr.IsLoopback() || addr.IsPrivate() ||
		addr.IsLinkLocalUnicast() || addr.IsLinkLocalMulticast() || addr.IsMulticast() ||
		addr.IsInterfaceLocalMulticast() {
		return false
	}
	if addr.Is4() {
		// 100.64.0.0/10 (CGNAT) is common on Brazilian ISPs and is never Discord.
		if netip.MustParsePrefix("100.64.0.0/10").Contains(addr) {
			return false
		}
	}
	return addr.IsGlobalUnicast()
}

// TunnelStats mirrors WgTunnelStats in the GUI.
type TunnelStats struct {
	HandshakeAgoS *int64 `json:"handshakeAgoS"`
	RxBytes       *int64 `json:"rxBytes"`
	TxBytes       *int64 `json:"txBytes"`
	Endpoint      string `json:"endpoint"`
}

// ParseIpcGet extracts peer statistics from device.IpcGet output.
func ParseIpcGet(raw string, now time.Time) TunnelStats {
	var stats TunnelStats
	var handshakeSec, handshakeNsec int64
	sawHandshake := false
	for _, line := range strings.Split(raw, "\n") {
		key, value, ok := strings.Cut(strings.TrimSpace(line), "=")
		if !ok {
			continue
		}
		number, numErr := strconv.ParseInt(value, 10, 64)
		switch key {
		case "last_handshake_time_sec":
			if numErr == nil {
				handshakeSec = number
				sawHandshake = true
			}
		case "last_handshake_time_nsec":
			if numErr == nil {
				handshakeNsec = number
			}
		case "rx_bytes":
			if numErr == nil {
				stats.RxBytes = &number
			}
		case "tx_bytes":
			if numErr == nil {
				stats.TxBytes = &number
			}
		case "endpoint":
			stats.Endpoint = value
		}
	}
	if sawHandshake && (handshakeSec > 0 || handshakeNsec > 0) {
		ago := int64(now.Sub(time.Unix(handshakeSec, handshakeNsec)).Seconds())
		if ago < 0 {
			ago = 0
		}
		stats.HandshakeAgoS = &ago
	}
	return stats
}

func truncate(value string, max int) string {
	if len(value) <= max {
		return value
	}
	return value[:max] + "…"
}
