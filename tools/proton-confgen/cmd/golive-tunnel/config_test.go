package main

import (
	"errors"
	"net/netip"
	"strings"
	"testing"
	"time"
)

const (
	testPrivate = "yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk="
	testPublic  = "xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg="
)

func protonLikeConfig() string {
	return `# Proton VPN
[Interface]
PrivateKey = ` + testPrivate + `
Address = 10.2.0.2/32
DNS = 10.2.0.1

[Peer]
PublicKey = ` + testPublic + `
AllowedIPs = 0.0.0.0/0, ::/0
Endpoint = 149.88.27.237:51820
PersistentKeepalive = 10
#@ws:AllowedApps = Discord.exe
`
}

func TestParseConfigProtonProfile(t *testing.T) {
	cfg, err := ParseConfig(protonLikeConfig())
	if err != nil {
		t.Fatal(err)
	}
	if cfg.MTU != defaultMTU || cfg.Keepalive != 10 || cfg.Endpoint != "149.88.27.237:51820" {
		t.Fatalf("config inesperada: %+v", cfg)
	}
	if len(cfg.Addresses) != 1 || cfg.Addresses[0] != netip.MustParsePrefix("10.2.0.2/32") {
		t.Fatalf("endereços inesperados: %v", cfg.Addresses)
	}
}

func TestParseConfigDualStackAddressAndMTU(t *testing.T) {
	raw := strings.Replace(protonLikeConfig(), "Address = 10.2.0.2/32", "Address = 10.2.0.2/32, 2a07:b944::2:2/128\nMTU = 1380", 1)
	cfg, err := ParseConfig(raw)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.MTU != 1380 || len(cfg.Addresses) != 2 || !cfg.Addresses[1].Addr().Is6() {
		t.Fatalf("config inesperada: %+v", cfg)
	}
}

func TestParseConfigRejectsBrokenProfiles(t *testing.T) {
	cases := map[string]string{
		"sem peer":     strings.Split(protonLikeConfig(), "[Peer]")[0],
		"dois peers":   protonLikeConfig() + "\n[Peer]\nPublicKey = " + testPublic + "\nEndpoint = 1.1.1.1:1\n",
		"chave ruim":   strings.Replace(protonLikeConfig(), testPrivate, "abc", 1),
		"sem endpoint": strings.Replace(protonLikeConfig(), "Endpoint = 149.88.27.237:51820", "", 1),
		"sem address":  strings.Replace(protonLikeConfig(), "Address = 10.2.0.2/32", "", 1),
		"mtu absurdo":  strings.Replace(protonLikeConfig(), "DNS = 10.2.0.1", "MTU = 70000", 1),
		"linha solta":  strings.Replace(protonLikeConfig(), "DNS = 10.2.0.1", "lixo", 1),
	}
	for name, raw := range cases {
		if _, err := ParseConfig(raw); err == nil {
			t.Errorf("%s: esperava erro", name)
		}
	}
}

func TestUAPIRestrictsNothingAndReplacesPeers(t *testing.T) {
	cfg, err := ParseConfig(protonLikeConfig())
	if err != nil {
		t.Fatal(err)
	}
	uapi, err := cfg.UAPI(netip.MustParseAddrPort("149.88.27.237:51820"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"replace_peers=true", "endpoint=149.88.27.237:51820", "persistent_keepalive_interval=10", "allowed_ip=0.0.0.0/0", "allowed_ip=::/0"} {
		if !strings.Contains(uapi, want) {
			t.Errorf("UAPI sem %q:\n%s", want, uapi)
		}
	}
	if strings.Contains(uapi, testPrivate) {
		t.Fatal("UAPI deve usar chaves em hex, não Base64")
	}
}

func TestResolveEndpoint(t *testing.T) {
	lookup := func(string) ([]netip.Addr, error) {
		return []netip.Addr{netip.MustParseAddr("2001:db8::1"), netip.MustParseAddr("203.0.113.9")}, nil
	}
	got, err := ResolveEndpoint("vpn.example:51820", lookup)
	if err != nil || got != netip.MustParseAddrPort("203.0.113.9:51820") {
		t.Fatalf("esperava IPv4 preferido, veio %v (%v)", got, err)
	}
	if _, err := ResolveEndpoint("vpn.example:51820", func(string) ([]netip.Addr, error) { return nil, errors.New("nx") }); err == nil {
		t.Fatal("esperava erro de resolução")
	}
	if _, err := ResolveEndpoint("1.2.3.4:0", lookup); err == nil {
		t.Fatal("esperava erro de porta")
	}
}

func TestDiscordRoutesCoverGatewayAndVoice(t *testing.T) {
	routes := append(append([]netip.Prefix(nil), discordStaticPrefixes...), discordSeedHosts()...)
	for _, addr := range []string{"162.159.130.234", "162.159.136.232", "66.22.196.10", "104.29.143.38", "104.29.150.198", "2a0e:5940::1"} {
		if !EndpointConflict(netip.MustParseAddr(addr), routes) {
			t.Errorf("%s deveria entrar no túnel", addr)
		}
	}
	for _, addr := range []string{"149.88.27.237", "8.8.8.8", "162.159.200.1", "104.18.48.115"} {
		if EndpointConflict(netip.MustParseAddr(addr), routes) {
			t.Errorf("%s não deveria entrar no túnel", addr)
		}
	}
}

func TestAcceptResolvedAddress(t *testing.T) {
	for _, addr := range []string{"162.159.130.234", "2606:4700:7::a29f:80eb"} {
		if !AcceptResolvedAddress(netip.MustParseAddr(addr)) {
			t.Errorf("%s deveria ser aceito", addr)
		}
	}
	for _, addr := range []string{"127.0.0.1", "192.168.0.10", "10.2.0.1", "100.64.1.1", "169.254.1.1", "fe80::1", "::", "224.0.0.1"} {
		if AcceptResolvedAddress(netip.MustParseAddr(addr)) {
			t.Errorf("%s deveria ser recusado", addr)
		}
	}
}

func TestParseIpcGet(t *testing.T) {
	now := time.Unix(1_800_000_100, 0)
	stats := ParseIpcGet("public_key=ab\nendpoint=149.88.27.237:51820\nlast_handshake_time_sec=1800000070\nlast_handshake_time_nsec=0\nrx_bytes=1024\ntx_bytes=2048\n", now)
	if stats.HandshakeAgoS == nil || *stats.HandshakeAgoS != 30 || *stats.RxBytes != 1024 || *stats.TxBytes != 2048 || stats.Endpoint != "149.88.27.237:51820" {
		t.Fatalf("stats inesperadas: %+v", stats)
	}
	never := ParseIpcGet("last_handshake_time_sec=0\nlast_handshake_time_nsec=0\nrx_bytes=0\n", now)
	if never.HandshakeAgoS != nil {
		t.Fatal("handshake zero deve significar nunca")
	}
}
