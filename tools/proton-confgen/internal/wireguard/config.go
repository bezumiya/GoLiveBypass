// Package wireguard generates WireGuard configuration files.
package wireguard

import (
	"bytes"
	"fmt"
	"os"
	"strings"
	"text/template"
	"time"

	"protonvpn-wg-confgen/internal/api"
	"protonvpn-wg-confgen/internal/config"
	"protonvpn-wg-confgen/internal/constants"
)

// wireguardConfigTemplate is the template for generating WireGuard configuration
const wireguardConfigTemplate = `[Interface]
PrivateKey = {{.PrivateKey}}
{{.AddressLine}}
DNS = {{.DNS}}

[Peer]
PublicKey = {{.PublicKey}}
AllowedIPs = {{.AllowedIPs}}
Endpoint = {{.Endpoint}}:{{.Port}}
PersistentKeepalive = 10
`

// configData holds the data for the WireGuard config template
type configData struct {
	PrivateKey  string
	AddressLine string
	DNS         string
	PublicKey   string
	AllowedIPs  string
	Endpoint    string
	Port        int
}

// ConfigGenerator generates WireGuard configuration files
type ConfigGenerator struct {
	config   *config.Config
	template *template.Template
}

// NewConfigGenerator creates a new configuration generator
func NewConfigGenerator(cfg *config.Config) *ConfigGenerator {
	tmpl := template.Must(template.New("wireguard").Parse(wireguardConfigTemplate))
	return &ConfigGenerator{
		config:   cfg,
		template: tmpl,
	}
}

// Generate creates a WireGuard configuration file
func (g *ConfigGenerator) Generate(server *api.LogicalServer, physicalServer *api.PhysicalServer, privateKey string, vpnInfo *api.VPNInfo) error {
	content, err := g.buildConfig(server, physicalServer, privateKey, vpnInfo)
	if err != nil {
		return err
	}

	if err := os.WriteFile(g.config.OutputFile, []byte(content), 0o600); err != nil {
		return fmt.Errorf("failed to write config file: %w", err)
	}

	return nil
}

func (g *ConfigGenerator) buildConfig(server *api.LogicalServer, physicalServer *api.PhysicalServer, privateKey string, vpnInfo *api.VPNInfo) (string, error) {
	// Build metadata header
	metadata := g.buildMetadata(server, physicalServer, vpnInfo)

	data := configData{
		PrivateKey:  privateKey,
		AddressLine: g.buildAddressLine(),
		DNS:         strings.Join(g.config.DNSServers, ", "),
		PublicKey:   physicalServer.X25519PublicKey,
		AllowedIPs:  strings.Join(g.config.AllowedIPs, ", "),
		Endpoint:    physicalServer.EntryIP,
		Port:        constants.WireGuardPort,
	}

	var buf bytes.Buffer
	if err := g.template.Execute(&buf, data); err != nil {
		return "", fmt.Errorf("failed to execute template: %w", err)
	}

	return metadata + buf.String(), nil
}

func (g *ConfigGenerator) buildAddressLine() string {
	if g.config.EnableIPv6 {
		return fmt.Sprintf("Address = %s, %s", constants.WireGuardIPv4, constants.WireGuardIPv6)
	}
	return fmt.Sprintf("Address = %s", constants.WireGuardIPv4)
}

func (g *ConfigGenerator) buildMetadata(server *api.LogicalServer, physicalServer *api.PhysicalServer, vpnInfo *api.VPNInfo) string {
	var metadata strings.Builder

	metadata.WriteString("# ProtonVPN WireGuard Configuration\n")
	fmt.Fprintf(&metadata, "# Generated: %s\n", time.Now().Format("2006-01-02 15:04:05 MST"))

	deviceName := g.config.DeviceName
	if vpnInfo != nil && vpnInfo.DeviceName != "" {
		deviceName = vpnInfo.DeviceName
	}
	if deviceName != "" {
		fmt.Fprintf(&metadata, "# Device: %s\n", deviceName)
	}
	metadata.WriteString("#\n")
	metadata.WriteString("# Server Information:\n")
	fmt.Fprintf(&metadata, "# - Name: %s\n", server.Name)
	fmt.Fprintf(&metadata, "# - Country: %s\n", server.ExitCountry)
	fmt.Fprintf(&metadata, "# - City: %s\n", server.City)
	fmt.Fprintf(&metadata, "# - Tier: %s\n", api.GetTierName(server.Tier))
	fmt.Fprintf(&metadata, "# - Load: %d%%\n", server.Load)
	fmt.Fprintf(&metadata, "# - Score: %.2f\n", server.Score)

	// Add features if any
	features := api.GetFeatureNames(server.Features)
	if len(features) > 0 {
		fmt.Fprintf(&metadata, "# - Features: %s\n", strings.Join(features, ", "))
	}

	// Add physical server info
	metadata.WriteString("#\n")
	metadata.WriteString("# Physical Server:\n")
	fmt.Fprintf(&metadata, "# - ID: %s\n", physicalServer.ID)
	fmt.Fprintf(&metadata, "# - Entry IP: %s\n", physicalServer.EntryIP)
	if physicalServer.ExitIP != physicalServer.EntryIP {
		fmt.Fprintf(&metadata, "# - Exit IP: %s\n", physicalServer.ExitIP)
	}

	// Add secure core routing info if applicable
	if server.EntryCountry != server.ExitCountry && server.EntryCountry != "" {
		metadata.WriteString("#\n")
		fmt.Fprintf(&metadata, "# Secure Core Routing: %s -> %s\n",
			server.EntryCountry, server.ExitCountry)
	}

	metadata.WriteString("#\n\n")

	return metadata.String()
}
