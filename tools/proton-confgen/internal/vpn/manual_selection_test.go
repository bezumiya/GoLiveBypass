package vpn

import (
	"encoding/base64"
	"strings"
	"testing"
	"time"

	"protonvpn-wg-confgen/internal/api"
	"protonvpn-wg-confgen/internal/config"
	"protonvpn-wg-confgen/internal/constants"
)

func manualSelectionPeer(ip, publicKey string) api.PhysicalServer {
	return api.PhysicalServer{
		EntryIP:            ip,
		Status:             constants.StatusOnline,
		X25519PublicKey:    publicKey,
		ServicesDownReason: "",
	}
}

func manualSelectionServer(name, country string, tier int, peer api.PhysicalServer) api.LogicalServer {
	return api.LogicalServer{
		Name:        name,
		ExitCountry: country,
		Tier:        tier,
		Status:      constants.StatusOnline,
		Servers:     []api.PhysicalServer{peer},
	}
}

func TestSelectManualWithPingRequiresAnExactEligibleServer(t *testing.T) {
	validKey := base64.StdEncoding.EncodeToString(make([]byte, 32))
	validPeer := manualSelectionPeer("192.0.2.10", validKey)
	servers := []api.LogicalServer{
		manualSelectionServer("US#90", "US", api.TierFree, validPeer),
		manualSelectionServer("US#9", "US", api.TierFree, validPeer),
	}

	selector := NewServerSelector(&config.Config{
		ServerName: "US#9",
		FreeOnly:   true,
		Countries:  []string{"US"},
	})
	selector.manualPing = func(string, time.Duration) int { return 188 }

	selected, ping, err := selector.SelectManualWithPing(servers)
	if err != nil {
		t.Fatalf("SelectManualWithPing() error = %v", err)
	}
	if selected == nil || selected.Name != "US#9" {
		t.Fatalf("selected = %+v, want exact server US#9", selected)
	}
	if ping != 188 {
		t.Fatalf("ping = %d, want 188", ping)
	}
}

func TestSelectManualWithPingReappliesCurrentFilters(t *testing.T) {
	validKey := base64.StdEncoding.EncodeToString(make([]byte, 32))
	validPeer := manualSelectionPeer("192.0.2.11", validKey)

	tests := []struct {
		name   string
		cfg    config.Config
		server api.LogicalServer
	}{
		{
			name:   "plan rejects premium route in free mode",
			cfg:    config.Config{ServerName: "US#premium", FreeOnly: true},
			server: manualSelectionServer("US#premium", "US", api.TierPlus, validPeer),
		},
		{
			name:   "country rejects route outside selected country",
			cfg:    config.Config{ServerName: "US#1", Countries: []string{"NL"}},
			server: manualSelectionServer("US#1", "US", api.TierPlus, validPeer),
		},
		{
			name:   "excluded country rejects route",
			cfg:    config.Config{ServerName: "BR#1", ExcludedCountries: []string{"BR"}},
			server: manualSelectionServer("BR#1", "BR", api.TierPlus, validPeer),
		},
		{
			name:   "excluded server rejects route",
			cfg:    config.Config{ServerName: "US#blocked", ExcludedServers: []string{"US#blocked"}},
			server: manualSelectionServer("US#blocked", "US", api.TierPlus, validPeer),
		},
		{
			name: "offline route is rejected",
			cfg:  config.Config{ServerName: "US#offline"},
			server: func() api.LogicalServer {
				server := manualSelectionServer("US#offline", "US", api.TierPlus, validPeer)
				server.Status = 0
				return server
			}(),
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			selector := NewServerSelector(&tt.cfg)
			selector.manualPing = func(string, time.Duration) int {
				t.Fatal("a filtered route must not be pinged")
				return 0
			}
			selected, _, err := selector.SelectManualWithPing([]api.LogicalServer{tt.server})
			if err == nil || selected != nil {
				t.Fatalf("selection = (%+v, %v), want a filtered-route error", selected, err)
			}
		})
	}
}

func TestSelectManualWithPingRejectsAnUnusableWireGuardPeer(t *testing.T) {
	validKey := base64.StdEncoding.EncodeToString(make([]byte, 32))
	tests := []struct {
		name string
		peer api.PhysicalServer
	}{
		{
			name: "missing entry IP",
			peer: manualSelectionPeer("", validKey),
		},
		{
			name: "invalid public key",
			peer: manualSelectionPeer("192.0.2.12", "not-a-wireguard-key"),
		},
		{
			name: "service is down",
			peer: func() api.PhysicalServer {
				peer := manualSelectionPeer("192.0.2.12", validKey)
				peer.ServicesDownReason = "maintenance"
				return peer
			}(),
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg := &config.Config{ServerName: "US#broken"}
			selector := NewServerSelector(cfg)
			selector.manualPing = func(string, time.Duration) int {
				t.Fatal("an unusable peer must not be pinged")
				return 0
			}
			selected, _, err := selector.SelectManualWithPing([]api.LogicalServer{
				manualSelectionServer("US#broken", "US", api.TierPlus, tt.peer),
			})
			if err == nil || selected != nil || !strings.Contains(err.Error(), "WireGuard") {
				t.Fatalf("selection = (%+v, %v), want unusable WireGuard peer error", selected, err)
			}
		})
	}
}

func TestSelectManualWithPingRejectsUnreachablePing(t *testing.T) {
	validKey := base64.StdEncoding.EncodeToString(make([]byte, 32))
	selector := NewServerSelector(&config.Config{ServerName: "US#1"})
	selector.manualPing = func(string, time.Duration) int { return 999 }

	selected, ping, err := selector.SelectManualWithPing([]api.LogicalServer{
		manualSelectionServer("US#1", "US", api.TierPlus, manualSelectionPeer("192.0.2.13", validKey)),
	})
	if err == nil || selected != nil || ping != 999 {
		t.Fatalf("selection = (%+v, %d, %v), want unreachable ping error", selected, ping, err)
	}
}

func TestSelectManualWithPingRequiresServerName(t *testing.T) {
	selector := NewServerSelector(&config.Config{})
	selected, ping, err := selector.SelectManualWithPing(nil)
	if err == nil || selected != nil || ping != 0 || !strings.Contains(err.Error(), "requires -server") {
		t.Fatalf("selection = (%+v, %d, %v), want missing -server error", selected, ping, err)
	}
}
