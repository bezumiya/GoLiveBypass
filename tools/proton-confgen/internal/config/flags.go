// Package config handles command-line argument parsing and configuration management.
package config

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"protonvpn-wg-confgen/internal/constants"
	"protonvpn-wg-confgen/internal/timeutil"
	"protonvpn-wg-confgen/internal/validation"
)

// Parse parses command-line flags and returns a Config
func Parse() (*Config, error) {
	cfg := &Config{}

	var countriesFlag string
	var excludedCountriesFlag string
	var dnsServersFlag string
	var allowedIPsFlag string
	var excludedServersFlag string

	// Set default DNS and allowed IPs based on IPv6 support
	defaultDNS := constants.DefaultDNSIPv4
	defaultAllowedIPs := constants.DefaultAllowedIPsIPv4

	// Authentication flags
	flag.StringVar(&cfg.Username, "username", "", "ProtonVPN username")
	flag.StringVar(&cfg.Password, "password", "", "ProtonVPN password (will prompt if not provided)")

	// Server selection flags
	flag.StringVar(&excludedCountriesFlag, "exclude-countries", "", "Exclude exit countries from automatic selection (comma-separated codes)")
	flag.StringVar(&countriesFlag, "countries", "", "Comma-separated list of country codes (e.g., US,NL,CH)")
	flag.StringVar(&cfg.ServerName, "server", "", "Select a specific server by name (e.g., UA#122)")
	flag.BoolVar(&cfg.P2PServersOnly, "p2p-only", constants.DefaultP2POnly, "Use only P2P-enabled servers")
	flag.BoolVar(&cfg.SecureCoreOnly, "secure-core", false, "Use only Secure Core servers (multi-hop through privacy-friendly countries)")
	flag.BoolVar(&cfg.FreeOnly, "free-only", false, "Use only Free tier servers (tier 0)")

	// Output configuration
	flag.StringVar(&cfg.OutputFile, "output", "protonvpn.conf", "Output WireGuard configuration file")
	flag.StringVar(&cfg.DeviceName, "device-name", "", "Device name for WireGuard config (auto-generated if empty)")

	// Network configuration
	flag.BoolVar(&cfg.EnableIPv6, "ipv6", false, "Enable IPv6 support")
	flag.StringVar(&dnsServersFlag, "dns", "", "Comma-separated list of DNS servers (defaults based on IPv6 setting)")
	flag.StringVar(&allowedIPsFlag, "allowed-ips", "", "Comma-separated list of allowed IPs (defaults based on IPv6 setting)")
	flag.BoolVar(&cfg.EnableAccelerator, "accelerator", true, "Enable VPN accelerator")
	flag.BoolVar(&cfg.PortForwarding, "port-forwarding", false, "Enable NAT-PMP port forwarding (Plus tier, P2P servers only)")
	flag.BoolVar(&cfg.ModerateNAT, "moderate-nat", false, "Enable Moderate NAT (paid plans; incompatible with port forwarding)")

	// Certificate configuration
	flag.StringVar(&cfg.Duration, "duration", constants.DefaultCertDuration, "Certificate duration (e.g., 30m, 24h, 7d, 1h30m). Min: 10m, max: 365d (7d with -no-save)")

	// Session management
	flag.BoolVar(&cfg.ClearSession, "clear-session", false, "Clear saved session and force re-authentication")
	flag.BoolVar(&cfg.NoSession, "no-session", false, "Don't save or use session persistence")
	flag.BoolVar(&cfg.ForceRefresh, "force-refresh", false, "Force session refresh even if not expired")
	flag.StringVar(&cfg.SessionDuration, "session-duration", "0", "Session cache duration (e.g., 12h, 24h, 7d). 0 = no expiration")

	// Human verification
	flag.StringVar(&cfg.HVToken, "hv-token", "", "Human verification token to replay after solving a CAPTCHA (see the code 9001 error)")
	flag.BoolVar(&cfg.StdinSecrets, "stdin-secrets", false, "Read plugin authentication secrets from a private JSON object on stdin")

	// Advanced configuration
	flag.StringVar(&cfg.APIURL, "api-url", constants.DefaultAPIURL, "ProtonVPN API URL")
	flag.BoolVar(&cfg.Debug, "debug", false, "Enable debug output")

	// Non-persistent mode
	flag.BoolVar(&cfg.NoSave, "no-save", false, "Generate config without registering on the account (session-only, max 7 days)")

	// List mode (enumerates persistent configurations registered on the account)
	flag.BoolVar(&cfg.ListConfigs, "list-configs", false, "List all persistent WireGuard configurations on the account and exit")

	// Server listing mode
	flag.BoolVar(&cfg.ListServers, "list-servers", false, "List available servers and exit (optionally filter by -countries)")

	// Renew mode
	flag.StringVar(&cfg.RenewSerial, "renew-serial", "", "Renew a persistent configuration by SerialNumber (reuses existing key, no config file generated)")

	// Automated GUI & Ping extensions
	flag.BoolVar(&cfg.SpeedTest, "speed-test", false, "Ping all regional routes, validate twelve, then measure download/upload on up to six healthy finalists (up to 30 MiB, about 3m)")
	flag.BoolVar(&cfg.ManualProbe, "manual-probe", false, "Validate and generate one explicitly selected server without speed test")
	flag.BoolVar(&cfg.ProgressJSON, "progress-json", false, "Emit speed-test progress events as JSON on stderr")
	flag.BoolVar(&cfg.SpeedTestTrace, "speed-test-trace", false, "Print the four speed-test stages in the terminal (ping, shortlist, tunnel, speed)")
	flag.StringVar(&cfg.TwoFactorCode, "2fa", "", "2FA TOTP code for non-interactive authentication")
	flag.StringVar(&cfg.SessionFile, "session-file", "", "Custom path for session cache file")
	flag.BoolVar(&cfg.AutoPing, "auto-ping", false, "Compare all eligible regions, prioritizing lower load over measured ping (not a bandwidth test)")
	flag.BoolVar(&cfg.JSONOutput, "json", false, "Output results in JSON format")
	flag.BoolVar(&cfg.CheckSession, "check-session", false, "Check if cached session is valid and exit")
	flag.BoolVar(&cfg.CheckPlan, "check-plan", false, "Check the cached account plan and exit (does not prompt for a password)")
	flag.BoolVar(&cfg.LoginOnly, "login-only", false, "Authenticate, save session, and exit")
	flag.BoolVar(&cfg.SessionUsername, "session-username", false, "Print the username stored in the cached session and exit")
	flag.BoolVar(&cfg.RoutePool, "route-pool", false, "Generate a local pool of ping-validated routes")
	flag.IntVar(&cfg.RoutePoolSize, "route-pool-size", 2, "Number of profiles to generate in route-pool mode")
	flag.StringVar(&cfg.RoutePoolOutputDir, "route-pool-output-dir", "", "Directory for route-pool profiles")
	flag.StringVar(&excludedServersFlag, "exclude-servers", "", "Exclude server names from automatic selection (comma-separated)")

	flag.Parse()

	// Session certificates max out at 7 days, so fall back to that instead of
	// the 365d persistent default when -duration was not given explicitly.
	// Route-pool profiles are disposable reserves and must never create a new
	// persistent device in the Proton dashboard, even for direct CLI callers.
	if cfg.RoutePool {
		cfg.NoSave = true
	}
	if cfg.NoSave && !isFlagSet("duration") {
		cfg.Duration = constants.DefaultSessionCertDuration
	}

	if err := validateFeatureFlags(cfg); err != nil {
		return nil, err
	}
	if cfg.RoutePool && (cfg.RoutePoolSize < 1 || cfg.RoutePoolSize > 3) {
		return nil, fmt.Errorf("route-pool-size must be between 1 and 3")
	}
	if cfg.RoutePool && strings.TrimSpace(cfg.RoutePoolOutputDir) == "" {
		return nil, fmt.Errorf("route-pool-output-dir is required in route-pool mode")
	}

	// Parse and validate country codes (needed by most modes)
	cfg.ExcludedCountries = parseCountries(excludedCountriesFlag)
	cfg.ExcludedServers = parseCommaSeparatedList(excludedServersFlag)
	if countriesFlag != "" {
		cfg.Countries = parseCountries(countriesFlag)
		for _, country := range cfg.Countries {
			if !validation.IsValidCountryCode(country) {
				return nil, fmt.Errorf("invalid country code: %s", country)
			}
		}
	}

	// -list-configs does not need a country filter.
	if cfg.ListConfigs {
		cfg.Username = validation.CleanUsername(cfg.Username)
		return cfg, nil
	}

	// -list-servers does not need a country filter either.
	if cfg.ListServers {
		cfg.Username = validation.CleanUsername(cfg.Username)
		return cfg, nil
	}

	// -renew-serial may optionally filter by country, but doesn't require it.
	if cfg.RenewSerial != "" {
		cfg.Username = validation.CleanUsername(cfg.Username)
		return cfg, nil
	}

	// -check-session does not need country filter or server.
	if cfg.CheckSession {
		cfg.Username = validation.CleanUsername(cfg.Username)
		return cfg, nil
	}

	// -check-plan uses only the cached session and does not need a country
	// filter, server, certificate or password prompt.
	if cfg.CheckPlan {
		cfg.Username = validation.CleanUsername(cfg.Username)
		return cfg, nil
	}

	// -login-only does not need country filter or server.
	if cfg.LoginOnly {
		cfg.Username = validation.CleanUsername(cfg.Username)
		return cfg, nil
	}

	// -session-username only reads the local cache and does not need any
	// authentication or route-selection flags.
	if cfg.SessionUsername {
		cfg.Username = validation.CleanUsername(cfg.Username)
		return cfg, nil
	}

	// Validate required flags: countries are needed unless -server or -auto-ping is specified
	if cfg.SpeedTest {
		cfg.AutoPing = true
	}
	if countriesFlag == "" && cfg.ServerName == "" && !cfg.AutoPing {
		return nil, fmt.Errorf("countries flag is required (or use -server to select a specific server, or -auto-ping for global regional selection)")
	}

	// Set defaults based on IPv6 setting
	if cfg.EnableIPv6 {
		defaultDNS = fmt.Sprintf("%s,%s", constants.DefaultDNSIPv4, constants.DefaultDNSIPv6)
		defaultAllowedIPs = fmt.Sprintf("%s,%s", constants.DefaultAllowedIPsIPv4, constants.DefaultAllowedIPsIPv6)
	}

	// Use defaults if flags are empty
	if dnsServersFlag == "" {
		dnsServersFlag = defaultDNS
	}
	if allowedIPsFlag == "" {
		allowedIPsFlag = defaultAllowedIPs
	}

	// Parse lists (with space trimming)
	cfg.DNSServers = parseCommaSeparatedList(dnsServersFlag)
	cfg.AllowedIPs = parseCommaSeparatedList(allowedIPsFlag)

	// Clean up username
	cfg.Username = validation.CleanUsername(cfg.Username)

	return cfg, nil
}

type stdinSecrets struct {
	Password               string `json:"password"`
	TwoFactorCode          string `json:"twoFactorCode"`
	HumanVerificationToken string `json:"humanVerificationToken"`
}

// ReadStdinSecrets consumes the private credential envelope used by the Discord
// plugin. Secrets are intentionally never accepted in diagnostics or printed.
func ReadStdinSecrets(cfg *Config) error {
	if !cfg.StdinSecrets {
		return nil
	}
	return readStdinSecrets(os.Stdin, cfg)
}

func readStdinSecrets(reader io.Reader, cfg *Config) error {
	data, err := io.ReadAll(io.LimitReader(reader, 32*1024))
	if err != nil {
		return fmt.Errorf("failed to read private authentication input: %w", err)
	}
	var input stdinSecrets
	if err := json.Unmarshal(data, &input); err != nil {
		return fmt.Errorf("private authentication input is invalid")
	}
	if cfg.Password == "" {
		cfg.Password = input.Password
	}
	if cfg.TwoFactorCode == "" {
		cfg.TwoFactorCode = input.TwoFactorCode
	}
	if cfg.HVToken == "" {
		cfg.HVToken = input.HumanVerificationToken
	}
	if cfg.Password == "" {
		return fmt.Errorf("private authentication input does not contain a password")
	}
	return nil
}

func validateFeatureFlags(cfg *Config) error {
	if cfg.PortForwarding && cfg.ModerateNAT {
		return fmt.Errorf("port-forwarding and moderate-nat cannot be enabled together")
	}
	if cfg.ManualProbe {
		if strings.TrimSpace(cfg.ServerName) == "" {
			return fmt.Errorf("manual-probe requires -server")
		}
		if cfg.SpeedTest {
			return fmt.Errorf("manual-probe cannot be used with -speed-test")
		}
	}
	return validateDuration(cfg)
}

// validateDuration enforces the API's certificate duration bounds up front, so
// out-of-range values fail before authenticating rather than after.
func validateDuration(cfg *Config) error {
	duration, err := timeutil.ParseDuration(cfg.Duration)
	if err != nil {
		return fmt.Errorf("invalid duration format: %s", cfg.Duration)
	}
	// The API rejects shorter durations with code 2001.
	if duration < constants.MinCertDuration {
		return fmt.Errorf("duration must be at least 10 minutes")
	}
	if duration > constants.MaxCertDuration*24*time.Hour {
		return fmt.Errorf("duration cannot exceed %dd", constants.MaxCertDuration)
	}
	if cfg.NoSave && duration > constants.MaxSessionCertDuration*24*time.Hour {
		return fmt.Errorf("duration cannot exceed %dd with -no-save (the API silently clamps session certificates to %dd)",
			constants.MaxSessionCertDuration, constants.MaxSessionCertDuration)
	}
	return nil
}

// isFlagSet reports whether the named flag was provided on the command line.
func isFlagSet(name string) bool {
	found := false
	flag.Visit(func(f *flag.Flag) {
		if f.Name == name {
			found = true
		}
	})
	return found
}

// parseCommaSeparatedList parses a comma-separated string into a trimmed slice
func parseCommaSeparatedList(input string) []string {
	parts := strings.Split(input, ",")
	var result []string
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part != "" {
			result = append(result, part)
		}
	}
	return result
}

// parseCountries parses and normalizes country codes (deduplicated)
func parseCountries(countriesFlag string) []string {
	raw := parseCommaSeparatedList(strings.ToUpper(countriesFlag))
	seen := make(map[string]struct{}, len(raw))
	result := make([]string, 0, len(raw))
	for _, c := range raw {
		if _, ok := seen[c]; !ok {
			seen[c] = struct{}{}
			result = append(result, c)
		}
	}
	return result
}

// PrintUsage prints usage information
func PrintUsage() {
	fmt.Fprintf(os.Stderr, "Usage: %s -username <username> -countries <country-codes> [options]\n", os.Args[0])
	fmt.Fprintf(os.Stderr, "       %s -username <username> -server <server-name> [options]\n\n", os.Args[0])
	flag.PrintDefaults()
}
