package wireguard

import (
	"strings"
	"testing"

	"protonvpn-wg-confgen/internal/api"
	"protonvpn-wg-confgen/internal/config"
)

func TestConfigGeneration(t *testing.T) {
	cfg := &config.Config{
		DNSServers: []string{"10.2.0.1"},
		AllowedIPs: []string{"0.0.0.0/0"},
		OutputFile: "test.conf",
	}

	generator := NewConfigGenerator(cfg)

	server := &api.LogicalServer{
		Name: "Test-Server",
	}

	physicalServer := &api.PhysicalServer{
		EntryIP:         "192.168.1.1",
		X25519PublicKey: "testPublicKey123=",
	}

	privateKey := "testPrivateKey456="

	result, err := generator.buildConfig(server, physicalServer, privateKey, nil)
	if err != nil {
		t.Fatalf("buildConfig failed: %v", err)
	}

	// Check that config starts with comment header
	if !strings.HasPrefix(result, "# ProtonVPN WireGuard Configuration") {
		t.Errorf("Expected config to start with header comment, got:\n%s", result[:100])
	}

	// Check that metadata is present
	if !strings.Contains(result, "# - Name: Test-Server") {
		t.Errorf("Expected server name in metadata")
	}

	// Check for proper WireGuard sections
	if !strings.Contains(result, "[Interface]") {
		t.Error("Expected [Interface] section")
	}

	if !strings.Contains(result, "[Peer]") {
		t.Error("Expected [Peer] section")
	}

	// Verify key content
	expectedContent := []string{
		"PrivateKey = testPrivateKey456=",
		"Address = 10.2.0.2/32",
		"DNS = 10.2.0.1",
		"PublicKey = testPublicKey123=",
		"AllowedIPs = 0.0.0.0/0",
		"Endpoint = 192.168.1.1:51820",
		"PersistentKeepalive = 10",
	}

	for _, expected := range expectedContent {
		if !strings.Contains(result, expected) {
			t.Errorf("Expected config to contain '%s'\nGot:\n%s", expected, result)
		}
	}

	// Check section order: [Interface] should come before [Peer]
	interfaceIdx := strings.Index(result, "[Interface]")
	peerIdx := strings.Index(result, "[Peer]")
	if interfaceIdx >= peerIdx {
		t.Error("[Interface] section should come before [Peer] section")
	}
}

func TestConfigGenerationWithIPv6(t *testing.T) {
	cfg := &config.Config{
		DNSServers: []string{"10.2.0.1", "2a07:b944::2:1"},
		AllowedIPs: []string{"0.0.0.0/0", "::/0"},
		OutputFile: "test.conf",
		EnableIPv6: true,
	}

	generator := NewConfigGenerator(cfg)

	server := &api.LogicalServer{
		Name: "Test-Server",
	}

	physicalServer := &api.PhysicalServer{
		EntryIP:         "192.168.1.1",
		X25519PublicKey: "testPublicKey123=",
	}

	privateKey := "testPrivateKey456="

	result, err := generator.buildConfig(server, physicalServer, privateKey, nil)
	if err != nil {
		t.Fatalf("buildConfig failed: %v", err)
	}

	// Check that IPv6 address is included
	if !strings.Contains(result, "Address = 10.2.0.2/32, 2a07:b944::2:2/128") {
		t.Errorf("Expected IPv6 address in config, got:\n%s", result)
	}

	// Check DNS servers
	if !strings.Contains(result, "DNS = 10.2.0.1, 2a07:b944::2:1") {
		t.Errorf("Expected both DNS servers in config, got:\n%s", result)
	}

	// Check AllowedIPs
	if !strings.Contains(result, "AllowedIPs = 0.0.0.0/0, ::/0") {
		t.Errorf("Expected both IPv4 and IPv6 in AllowedIPs, got:\n%s", result)
	}
}
