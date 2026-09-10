// Package main provides the command-line interface for generating ProtonVPN WireGuard configurations.
package main

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"protonvpn-wg-confgen/internal/api"
	"protonvpn-wg-confgen/internal/auth"
	"protonvpn-wg-confgen/internal/config"
	"protonvpn-wg-confgen/internal/constants"
	"protonvpn-wg-confgen/internal/routeprobe"
	"protonvpn-wg-confgen/internal/speedtest"
	"protonvpn-wg-confgen/internal/vpn"
	"protonvpn-wg-confgen/internal/wireguard"

	"github.com/ProtonVPN/go-vpn-lib/ed25519"
)

func main() {
	if err := run(); err != nil {
		isJSON := false
		for _, arg := range os.Args {
			if arg == "-json" || arg == "--json" {
				isJSON = true
				break
			}
		}
		if isJSON {
			response := jsonErrorResponse(err)
			data, _ := json.Marshal(response)
			fmt.Println(string(data))
		} else {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		}
		os.Exit(1)
	}
}

func jsonErrorResponse(err error) map[string]any {
	response := map[string]any{
		"success": false,
		"error":   err.Error(),
	}
	var hvErr auth.HumanVerificationError
	if errors.As(err, &hvErr) {
		response["code"] = hvErr.Code
		response["retryable"] = hvErr.Retryable
		if hvErr.CaptchaURL != "" {
			response["captchaUrl"] = hvErr.CaptchaURL
		}
		return response
	}
	if errors.Is(err, auth.ErrTwoFactorRequired) {
		response["code"] = "TWO_FACTOR_REQUIRED"
		response["retryable"] = false
		return response
	}
	if auth.IsTwoFactorError(err) {
		response["code"] = "TWO_FACTOR_INVALID"
		response["retryable"] = false
		return response
	}
	if auth.IsInvalidCredentials(err) {
		response["code"] = "INVALID_CREDENTIALS"
		response["retryable"] = false
		return response
	}
	if auth.IsTemporarySessionError(err) {
		response["code"] = "NETWORK_ERROR"
		response["retryable"] = true
	}
	return response
}

func run() error {
	if hasArg("-route-probe", "--route-probe") {
		result := routeprobe.Run(context.Background())
		data, _ := json.Marshal(result)
		fmt.Println(string(data))
		return nil
	}

	cfg, err := config.Parse()
	if err != nil {
		config.PrintUsage()
		return err
	}
	if err := config.ReadStdinSecrets(cfg); err != nil {
		return err
	}

	authClient := auth.NewClient(cfg)

	if cfg.SessionUsername {
		username, usernameErr := authClient.SessionUsername()
		if cfg.JSONOutput {
			data, _ := json.Marshal(map[string]any{
				"success":  usernameErr == nil,
				"username": username,
				"error": func() string {
					if usernameErr != nil {
						return "Não foi possível ler a sessão Proton."
					}
					return ""
				}(),
			})
			fmt.Println(string(data))
			return nil
		}
		if usernameErr != nil {
			return fmt.Errorf("failed to read cached session username: %w", usernameErr)
		}
		fmt.Println(username)
		return nil
	}

	if cfg.CheckSession {
		session, timeUntilExpiry, err := authClient.CheckSession()
		if err != nil || session == nil {
			errorMessage := "Sessão expirada ou não encontrada"
			if auth.IsTemporarySessionError(err) {
				errorMessage = "Não foi possível verificar a sessão Proton temporariamente"
			}
			if cfg.JSONOutput {
				data, _ := json.Marshal(map[string]any{
					"success": false,
					"valid":   false,
					"error":   errorMessage,
				})
				fmt.Println(string(data))
				return nil
			}
			return errors.New(errorMessage)
		}
		if cfg.JSONOutput {
			data, _ := json.Marshal(map[string]any{
				"success":   true,
				"valid":     true,
				"username":  cfg.Username,
				"expiresIn": timeUntilExpiry.String(),
			})
			fmt.Println(string(data))
			return nil
		}
		fmt.Printf("Sessão válida para %s (expira em %s)\n", cfg.Username, timeUntilExpiry.String())
		return nil
	}

	if cfg.CheckPlan {
		session, _, sessionErr := authClient.CheckSession()
		if sessionErr != nil || session == nil {
			errorMessage := "Sessão Proton expirada ou não encontrada."
			if auth.IsTemporarySessionError(sessionErr) {
				errorMessage = "Não foi possível verificar a sessão Proton temporariamente."
			}
			if cfg.JSONOutput {
				data, _ := json.Marshal(map[string]any{
					"success": false,
					"status":  "unknown",
					"error":   errorMessage,
				})
				fmt.Println(string(data))
				return nil
			}
			return errors.New(errorMessage)
		}

		plan, planErr := vpn.NewClient(cfg, session).GetAccountPlan()
		if planErr != nil || plan == nil {
			if cfg.JSONOutput {
				data, _ := json.Marshal(map[string]any{
					"success": false,
					"status":  "unknown",
					"error":   "Não foi possível confirmar o plano Proton.",
				})
				fmt.Println(string(data))
				return nil
			}
			return fmt.Errorf("não foi possível confirmar o plano Proton")
		}

		status := "premium"
		if plan.MaxTier == api.TierFree {
			status = "free"
		}
		if cfg.JSONOutput {
			data, _ := json.Marshal(map[string]any{
				"success":   true,
				"status":    status,
				"maxTier":   plan.MaxTier,
				"planName":  plan.PlanName,
				"planTitle": plan.PlanTitle,
			})
			fmt.Println(string(data))
			return nil
		}
		fmt.Printf("Plano Proton: %s (MaxTier %d)\n", status, plan.MaxTier)
		return nil
	}

	session, err := authClient.Authenticate()
	if err != nil {
		return fmt.Errorf("authentication failed: %w", err)
	}
	if !cfg.JSONOutput {
		fmt.Println("Authentication successful!")
	}

	if cfg.LoginOnly {
		if cfg.JSONOutput {
			data, _ := json.Marshal(map[string]any{
				"success":  true,
				"username": cfg.Username,
			})
			fmt.Println(string(data))
			return nil
		}
		fmt.Printf("Login successful for %s!\n", cfg.Username)
		return nil
	}

	vpnClient := vpn.NewClient(cfg, session)

	switch {
	case cfg.ListConfigs:
		return listConfigs(vpnClient)
	case cfg.RouteCatalog:
		return catalogServers(cfg, vpnClient)
	case cfg.ListServers:
		return listServers(cfg, vpnClient)
	case cfg.RenewSerial != "":
		return renewSerial(cfg, vpnClient)
	case cfg.RoutePool:
		return generateRoutePool(cfg, vpnClient)
	default:
		return generateConfig(cfg, vpnClient)
	}
}

func hasArg(names ...string) bool {
	for _, arg := range os.Args[1:] {
		for _, name := range names {
			if arg == name {
				return true
			}
		}
	}
	return false
}

func generateConfig(cfg *config.Config, vpnClient *vpn.Client) error {
	keyPair, err := ed25519.NewKeyPair()
	if err != nil {
		return fmt.Errorf("failed to generate key pair: %w", err)
	}
	cfg.ClientPrivateKey = keyPair.ToX25519Base64()

	vpnInfo, err := vpnClient.GetCertificate(keyPair)
	if err != nil {
		return fmt.Errorf("failed to get VPN certificate: %w", err)
	}

	servers, err := vpnClient.GetServers()
	if err != nil {
		return fmt.Errorf("failed to get servers: %w", err)
	}

	selector := vpn.NewServerSelector(cfg)
	var server *api.LogicalServer
	var pingMs int
	var measured *speedtest.Result
	if cfg.ManualProbe {
		progress := speedtest.ProgressFunc(nil)
		if cfg.ProgressJSON || cfg.SpeedTestTrace {
			progress = func(event speedtest.ProgressEvent) {
				if cfg.ProgressJSON {
					data, _ := json.Marshal(event)
					fmt.Fprintf(os.Stderr, "GOLIVE_PROGRESS %s\n", data)
				}
				if cfg.SpeedTestTrace {
					printSpeedTrace(event)
				}
			}
			progress(speedtest.ProgressEvent{Phase: "ping", Total: 0, Tested: 0, Succeeded: 0})
		}

		server, pingMs, err = selector.SelectManualWithPing(servers)
		if err != nil {
			return err
		}
		if progress != nil {
			progress(speedtest.ProgressEvent{
				Phase: "ping", Total: 1, Tested: 1, Succeeded: 1,
				Server: server.Name, PingMs: pingMs, Status: "success",
			})
			progress(speedtest.ProgressEvent{
				Phase: "preparing", Total: 1, Tested: 0, Succeeded: 0,
				Server: server.Name, Status: "testing",
			})
		}

		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		probeErr := speedtest.ProbeCandidate(ctx, cfg.ClientPrivateKey, *server)
		cancel()
		if progress != nil {
			status := "success"
			succeeded := 1
			if probeErr != nil {
				status = "failed"
				succeeded = 0
			}
			progress(speedtest.ProgressEvent{
				Phase: "preparing", Total: 1, Tested: 1, Succeeded: succeeded,
				Server: server.Name, Status: status,
			})
		}
		if probeErr != nil {
			return fmt.Errorf("manual route preflight failed: %w", probeErr)
		}
	} else if cfg.SpeedTest {
		const (
			pingTriageLimit       = 12
			speedMeasurementLimit = 6
			preflightConcurrency  = 4
		)
		progress := speedtest.ProgressFunc(nil)
		if cfg.ProgressJSON || cfg.SpeedTestTrace {
			progress = func(event speedtest.ProgressEvent) {
				if cfg.ProgressJSON {
					data, _ := json.Marshal(event)
					fmt.Fprintf(os.Stderr, "GOLIVE_PROGRESS %s\n", data)
				}
				if cfg.SpeedTestTrace {
					printSpeedTrace(event)
				}
			}
			progress(speedtest.ProgressEvent{Phase: "ping", Total: 0, Tested: 0, Succeeded: 0})
		}
		var candidates []api.LogicalServer
		var pings map[string]int
		if cfg.ServerName != "" {
			requested, requestedPing, selectErr := selector.SelectBestWithPing(servers)
			if selectErr != nil {
				return selectErr
			}
			candidates = []api.LogicalServer{*requested}
			pings = map[string]int{requested.Name: requestedPing}
			if progress != nil {
				status := "failed"
				if requestedPing > 0 && requestedPing < 999 {
					status = "success"
				}
				progress(speedtest.ProgressEvent{Phase: "ping", Total: 1, Tested: 1, Succeeded: boolInt(status == "success"), Server: requested.Name, PingMs: requestedPing, Status: status})
			}
			if cfg.SpeedTestTrace {
				printSpeedShortlist(candidates, pings)
			}
		} else {
			// Stage 1 probes every normalized regional route. Stage 2 then keeps
			// only the twelve lowest-latency routes for tunnel preflight.
			var pingProgress vpn.PingProgressFunc
			if progress != nil {
				pingProgress = func(event vpn.PingProgressEvent) {
					progress(speedtest.ProgressEvent{
						Phase:     "ping",
						Total:     event.Total,
						Tested:    event.Tested,
						Succeeded: event.Succeeded,
						Server:    event.Server,
						PingMs:    event.PingMs,
						ElapsedMs: event.ElapsedMs,
						Status:    event.Status,
					})
				}
			}
			candidates, pings, err = selector.SpeedCandidatesWithProgress(servers, pingTriageLimit, pingProgress)
			if err != nil {
				return err
			}
			if cfg.SpeedTestTrace {
				printSpeedShortlist(candidates, pings)
			}
		}
		ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
		healthyCandidates, probeErr := speedtest.FilterReachableCandidatesConcurrent(ctx, cfg.ClientPrivateKey, candidates, pingTriageLimit, preflightConcurrency, progress)
		if probeErr != nil {
			cancel()
			return probeErr
		}
		primaryCount := min(speedMeasurementLimit, len(healthyCandidates))
		primary := healthyCandidates[:primaryCount]
		fallbacks := healthyCandidates[primaryCount:]
		result, measureErr := speedtest.SelectWithProgressFallbacks(ctx, cfg.ClientPrivateKey, primary, fallbacks, speedMeasurementLimit, progress)
		cancel()
		if measureErr != nil {
			return measureErr
		}
		measured = &result
		server, pingMs = &result.Server, result.LatencyMs
	} else {
		server, pingMs, err = selector.SelectBestWithPing(servers)
		if err != nil {
			return err
		}
	}

	features := api.GetFeatureNames(server.Features)
	featureStr := ""
	if len(features) > 0 {
		featureStr = fmt.Sprintf(", Features: %s", strings.Join(features, ", "))
	}

	countryStr := server.ExitCountry
	if server.HostCountry != "" && server.HostCountry != server.ExitCountry {
		countryStr = fmt.Sprintf("%s (host: %s)", server.ExitCountry, server.HostCountry)
	}

	if !cfg.JSONOutput {
		pingInfo := ""
		if pingMs > 0 {
			pingInfo = fmt.Sprintf(", Ping: %dms", pingMs)
		}
		fmt.Printf("Selected server: %s (Country: %s, City: %s, Tier: %s, Load: %d%%, Score: %.2f%s, Servers: %d%s)\n",
			server.Name, countryStr, server.City, api.GetTierName(server.Tier),
			server.Load, server.Score, pingInfo, len(server.Servers), featureStr)
	}

	physicalServer := vpn.GetBestWireGuardPhysicalServer(server)
	if physicalServer == nil {
		return fmt.Errorf("no usable WireGuard physical servers available")
	}

	generator := wireguard.NewConfigGenerator(cfg)
	if err := generator.Generate(server, physicalServer, cfg.ClientPrivateKey, vpnInfo); err != nil {
		return fmt.Errorf("failed to generate WireGuard config: %w", err)
	}

	if cfg.JSONOutput {
		resp := map[string]any{
			"success":   true,
			"server":    server.Name,
			"country":   server.ExitCountry,
			"city":      server.City,
			"tier":      api.GetTierName(server.Tier),
			"load":      server.Load,
			"score":     server.Score,
			"pingMs":    pingMs,
			"endpoint":  fmt.Sprintf("%s:%d", physicalServer.EntryIP, constants.WireGuardPort),
			"confFile":  cfg.OutputFile,
			"expiresAt": vpnInfo.ExpirationTime,
		}
		if cfg.ManualProbe {
			resp["manual"] = true
			resp["preflight"] = "success"
		}
		if measured != nil {
			resp["downloadMbps"] = measured.DownloadMbps
			resp["uploadMbps"] = measured.UploadMbps
			resp["speedTested"] = measured.Tested
			resp["speedSucceeded"] = measured.Succeeded
		}
		data, _ := json.Marshal(resp)
		fmt.Println(string(data))
		return nil
	}

	if measured != nil {
		fmt.Printf("Measured through tunnel: download %.2f Mbps, upload %.2f Mbps (%d/%d candidates completed)\n", measured.DownloadMbps, measured.UploadMbps, measured.Succeeded, measured.Tested)
	}
	fmt.Printf("WireGuard configuration written to: %s\n", cfg.OutputFile)
	if vpnInfo.DeviceName != "" {
		fmt.Printf("Device name: %s (visible in ProtonVPN dashboard)\n", vpnInfo.DeviceName)
	}
	mode := vpnInfo.Mode
	if mode == "" {
		mode = "session"
	}
	fmt.Printf("Certificate: %s, expires %s\n",
		mode, time.Unix(vpnInfo.ExpirationTime, 0).UTC().Format("2006-01-02 15:04 UTC"))
	fmt.Printf("\nSuccessfully generated config for %s\n", server.ExitCountry)
	return nil
}

// generateRoutePool prepares reserve profiles for the GUI. It performs only
// the regional ping ranking and config generation: no temporary WireGuard
// interface is opened while the user's active tunnel is carrying Discord.
func generateRoutePool(cfg *config.Config, vpnClient *vpn.Client) error {
	if cfg.RoutePoolOutputDir == "" {
		return fmt.Errorf("route-pool-output-dir is required")
	}
	if err := os.MkdirAll(cfg.RoutePoolOutputDir, 0o700); err != nil {
		return fmt.Errorf("failed to create route pool directory: %w", err)
	}

	keyPair, err := ed25519.NewKeyPair()
	if err != nil {
		return fmt.Errorf("failed to generate route-pool key pair: %w", err)
	}
	cfg.ClientPrivateKey = keyPair.ToX25519Base64()

	// Session-only certificates avoid accumulating persistent dashboard devices
	// each time a reserve is renewed. The GUI still stores the generated profiles
	// locally with restrictive permissions.
	vpnInfo, err := vpnClient.GetCertificate(keyPair)
	if err != nil {
		return fmt.Errorf("failed to get route-pool VPN certificate: %w", err)
	}
	servers, err := vpnClient.GetServers()
	if err != nil {
		return fmt.Errorf("failed to get route-pool servers: %w", err)
	}

	excluded := make(map[string]struct{}, len(cfg.ExcludedServers))
	for _, name := range cfg.ExcludedServers {
		name = strings.TrimSpace(name)
		if name != "" {
			excluded[name] = struct{}{}
		}
	}
	selector := vpn.NewServerSelector(cfg)
	var pingProgress vpn.PingProgressFunc
	if cfg.ProgressJSON || cfg.SpeedTestTrace {
		emitProgress := func(event speedtest.ProgressEvent) {
			if cfg.ProgressJSON {
				data, _ := json.Marshal(event)
				fmt.Fprintf(os.Stderr, "GOLIVE_PROGRESS %s\n", data)
			}
			if cfg.SpeedTestTrace {
				printSpeedTrace(event)
			}
		}
		emitProgress(speedtest.ProgressEvent{Phase: "ping", Total: 0, Tested: 0, Succeeded: 0})
		pingProgress = func(event vpn.PingProgressEvent) {
			emitProgress(speedtest.ProgressEvent{
				Phase:     "ping",
				Total:     event.Total,
				Tested:    event.Tested,
				Succeeded: event.Succeeded,
				Server:    event.Server,
				PingMs:    event.PingMs,
				ElapsedMs: event.ElapsedMs,
				Status:    event.Status,
			})
		}
	}
	candidates, pings, err := selector.SpeedCandidatesWithProgressExcluding(servers, cfg.RoutePoolSize, excluded, pingProgress)
	if err != nil {
		return err
	}

	type routeJSON struct {
		Success   bool    `json:"success"`
		Server    string  `json:"server"`
		Country   string  `json:"country"`
		City      string  `json:"city"`
		Tier      string  `json:"tier"`
		Load      int     `json:"load"`
		Score     float64 `json:"score"`
		PingMs    int     `json:"pingMs"`
		Endpoint  string  `json:"endpoint"`
		ConfFile  string  `json:"confFile"`
		ExpiresAt int64   `json:"expiresAt"`
	}
	routes := make([]routeJSON, 0, len(candidates))
	created := make([]string, 0, len(candidates))
	for index := range candidates {
		candidate := &candidates[index]
		pingMs := pings[candidate.Name]
		// An unmeasured fallback is not a validated reserve. If the account has
		// fewer live regions than requested, fail the pool atomically instead of
		// pretending that an unknown route is ready for a silent swap.
		if pingMs <= 0 || pingMs >= 999 {
			continue
		}
		physical := vpn.GetBestWireGuardPhysicalServer(candidate)
		if physical == nil || physical.EntryIP == "" || physical.X25519PublicKey == "" {
			continue
		}
		output := filepath.Join(cfg.RoutePoolOutputDir, fmt.Sprintf("route-%02d.conf", len(routes)))
		wasPresent := false
		if _, statErr := os.Stat(output); statErr == nil {
			wasPresent = true
		}
		routeCfg := *cfg
		routeCfg.OutputFile = output
		routeCfg.RoutePool = false
		routeCfg.NoSave = true
		generator := wireguard.NewConfigGenerator(&routeCfg)
		if err := generator.Generate(candidate, physical, cfg.ClientPrivateKey, vpnInfo); err != nil {
			if !wasPresent {
				_ = os.Remove(output)
			}
			return fmt.Errorf("failed to generate reserve route %s: %w", candidate.Name, err)
		}
		if !wasPresent {
			created = append(created, output)
		}
		routes = append(routes, routeJSON{
			Success:   true,
			Server:    candidate.Name,
			Country:   candidate.ExitCountry,
			City:      candidate.City,
			Tier:      api.GetTierName(candidate.Tier),
			Load:      candidate.Load,
			Score:     candidate.Score,
			PingMs:    pingMs,
			Endpoint:  fmt.Sprintf("%s:%d", physical.EntryIP, constants.WireGuardPort),
			ConfFile:  output,
			ExpiresAt: vpnInfo.ExpirationTime,
		})
	}
	if len(routes) < cfg.RoutePoolSize {
		for _, file := range created {
			_ = os.Remove(file)
		}
		return fmt.Errorf("only %d validated reserve routes were available; need %d", len(routes), cfg.RoutePoolSize)
	}

	if cfg.JSONOutput {
		data, _ := json.Marshal(map[string]any{
			"success":   true,
			"routes":    routes,
			"expiresAt": vpnInfo.ExpirationTime,
		})
		fmt.Println(string(data))
		return nil
	}
	fmt.Printf("Generated %d ping-validated Proton route reserves in %s\n", len(routes), cfg.RoutePoolOutputDir)
	return nil
}

func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

// printSpeedTrace is the human-readable counterpart of the JSON progress
// stream consumed by the GUI. It deliberately reports only route names and
// measurements, never keys, tokens, or tunnel internals.
func printSpeedTrace(event speedtest.ProgressEvent) {
	switch event.Phase {
	case "ping":
		if event.Server == "" {
			if event.Total == 0 {
				fmt.Fprintln(os.Stderr, "[1/4] Ping: iniciando a triagem das rotas")
			}
			return
		}
		ping := "sem resposta"
		if event.Status == "success" && event.PingMs > 0 && event.PingMs < 999 {
			ping = fmt.Sprintf("%d ms", event.PingMs)
		}
		fmt.Fprintf(os.Stderr, "[1/4] Ping %d/%d · %s · %s%s\n", event.Tested, event.Total, event.Server, ping, formatElapsed(event.ElapsedMs))
	case "preparing":
		if event.Server == "" {
			fmt.Fprintf(os.Stderr, "[3/4] Túnel: validando %d rotas selecionadas\n", event.Total)
			return
		}
		status := "descartada"
		if event.Status == "success" {
			status = "respondeu"
		}
		fmt.Fprintf(os.Stderr, "[3/4] Túnel %d/%d · %s · %s%s\n", event.Tested, event.Total, event.Server, status, formatElapsed(event.ElapsedMs))
	case "testing":
		if event.Server == "" {
			fmt.Fprintf(os.Stderr, "[4/4] Velocidade: medindo %d rotas saudáveis\n", event.Total)
			return
		}
		switch event.Status {
		case "testing":
			fmt.Fprintf(os.Stderr, "[4/4] Velocidade %d/%d · %s · medindo\n", event.Tested, event.Total, event.Server)
		case "success":
			fmt.Fprintf(os.Stderr, "[4/4] Velocidade %d/%d · %s · ↓ %.1f Mbps · ↑ %.1f Mbps%s\n", event.Tested, event.Total, event.Server, event.DownloadMbps, event.UploadMbps, formatElapsed(event.ElapsedMs))
		default:
			fmt.Fprintf(os.Stderr, "[4/4] Velocidade %d/%d · %s · falhou%s\n", event.Tested, event.Total, event.Server, formatElapsed(event.ElapsedMs))
		}
	case "finalizing":
		fmt.Fprintf(os.Stderr, "[4/4] Velocidade concluída: %d/%d medições válidas\n", event.Succeeded, event.Total)
	}
}

func formatElapsed(elapsedMs int) string {
	if elapsedMs <= 0 {
		return ""
	}
	return fmt.Sprintf(" · %d ms", elapsedMs)
}

func printSpeedShortlist(candidates []api.LogicalServer, pings map[string]int) {
	fmt.Fprintf(os.Stderr, "[2/4] Triagem de ping concluída: %d rotas selecionadas para o túnel\n", len(candidates))
	for index, candidate := range candidates {
		ping := pings[candidate.Name]
		if ping > 0 && ping < 999 {
			fmt.Fprintf(os.Stderr, "       %2d. %s · %d ms\n", index+1, candidate.Name, ping)
		} else {
			fmt.Fprintf(os.Stderr, "       %2d. %s · ping sem resposta\n", index+1, candidate.Name)
		}
	}
}

func listServers(cfg *config.Config, vpnClient *vpn.Client) error {
	servers, err := vpnClient.GetServers()
	if err != nil {
		return fmt.Errorf("failed to get servers: %w", err)
	}

	filtered := vpn.EligibleServers(cfg, servers)

	if len(filtered) == 0 {
		if len(cfg.Countries) > 0 {
			return fmt.Errorf("no online servers found for countries: %v", cfg.Countries)
		}
		return fmt.Errorf("no online servers found")
	}

	slices.SortFunc(filtered, func(a, b api.LogicalServer) int {
		if c := cmp.Compare(a.ExitCountry, b.ExitCountry); c != 0 {
			return c
		}
		return cmp.Compare(a.Score, b.Score)
	})

	if cfg.JSONOutput {
		type serverJSON struct {
			Name     string   `json:"name"`
			Country  string   `json:"country"`
			City     string   `json:"city"`
			Tier     string   `json:"tier"`
			Load     int      `json:"load"`
			Score    float64  `json:"score"`
			Features []string `json:"features"`
		}
		list := make([]serverJSON, len(filtered))
		for i := range filtered {
			list[i] = serverJSON{
				Name:     filtered[i].Name,
				Country:  filtered[i].ExitCountry,
				City:     filtered[i].City,
				Tier:     api.GetTierName(filtered[i].Tier),
				Load:     filtered[i].Load,
				Score:    filtered[i].Score,
				Features: api.GetFeatureNames(filtered[i].Features),
			}
		}
		data, _ := json.Marshal(list)
		fmt.Println(string(data))
		return nil
	}

	fmt.Printf("%-7s  %-14s  %-18s  %5s  %6s  %-10s  %s\n",
		"Country", "Server", "City", "Load", "Score", "Tier", "Features")
	fmt.Println(strings.Repeat("-", 100))

	for i := range filtered {
		s := &filtered[i]
		features := api.GetFeatureNames(s.Features)
		featureStr := "-"
		if len(features) > 0 {
			featureStr = strings.Join(features, ", ")
		}

		serverName := s.Name
		if s.HostCountry != "" && s.HostCountry != s.ExitCountry {
			serverName = fmt.Sprintf("%s(%s)", s.Name, s.HostCountry)
		}
		fmt.Printf("%-7s  %-14s  %-18s  %3d%%  %6.2f  %-10s  %s\n",
			s.ExitCountry, serverName, s.City, s.Load, s.Score,
			api.GetTierName(s.Tier), featureStr)
	}

	// Count unique countries
	seen := map[string]struct{}{}
	for i := range filtered {
		seen[filtered[i].ExitCountry] = struct{}{}
	}
	fmt.Printf("\n%d servers found across %d countries.\n", len(filtered), len(seen))
	return nil
}

type routeCatalogEntry struct {
	Server  string  `json:"server"`
	Country string  `json:"country"`
	City    string  `json:"city"`
	Tier    string  `json:"tier"`
	Load    int     `json:"load"`
	Score   float64 `json:"score"`
	PingMs  int     `json:"pingMs,omitempty"`
}

type routeCatalogResult struct {
	Success bool                `json:"success"`
	Routes  []routeCatalogEntry `json:"routes"`
}

func eligibleRouteServers(cfg *config.Config, servers []api.LogicalServer) []api.LogicalServer {
	filtered := vpn.EligibleServers(cfg, servers)
	filtered = slices.DeleteFunc(filtered, func(server api.LogicalServer) bool {
		return slices.Contains(cfg.ExcludedServers, server.Name)
	})
	slices.SortFunc(filtered, func(a, b api.LogicalServer) int {
		if c := cmp.Compare(a.ExitCountry, b.ExitCountry); c != 0 {
			return c
		}
		if c := cmp.Compare(a.City, b.City); c != 0 {
			return c
		}
		if c := cmp.Compare(a.Score, b.Score); c != 0 {
			return c
		}
		if c := cmp.Compare(a.Load, b.Load); c != 0 {
			return c
		}
		return cmp.Compare(a.Name, b.Name)
	})
	return filtered
}

func routeCatalogEntries(servers []api.LogicalServer) []routeCatalogEntry {
	entries := make([]routeCatalogEntry, len(servers))
	for i := range servers {
		entries[i] = routeCatalogEntry{
			Server:  servers[i].Name,
			Country: servers[i].ExitCountry,
			City:    servers[i].City,
			Tier:    api.GetTierName(servers[i].Tier),
			Load:    servers[i].Load,
			Score:   servers[i].Score,
		}
	}
	return entries
}

func eligibleRouteCatalog(cfg *config.Config, servers []api.LogicalServer) []routeCatalogEntry {
	return routeCatalogEntries(eligibleRouteServers(cfg, servers))
}

func attachRouteCatalogPings(entries []routeCatalogEntry, pings map[string]int) {
	for i := range entries {
		ping := pings[entries[i].Server]
		if ping > 0 && ping < 999 {
			entries[i].PingMs = ping
		}
	}
}

func emitRouteCatalogProgress(entries []routeCatalogEntry, emit func(speedtest.ProgressEvent)) {
	if emit == nil {
		return
	}
	emit(speedtest.ProgressEvent{
		Phase: "catalog",
		Total: len(entries),
	})
	for index, entry := range entries {
		emit(speedtest.ProgressEvent{
			Phase:     "catalog",
			Total:     len(entries),
			Tested:    index + 1,
			Succeeded: index + 1,
			Server:    entry.Server,
			Country:   entry.Country,
			City:      entry.City,
			Tier:      entry.Tier,
			Load:      entry.Load,
			Score:     entry.Score,
			PingMs:    entry.PingMs,
			Status:    "success",
		})
	}
}

func catalogServers(cfg *config.Config, vpnClient *vpn.Client) error {
	servers, err := vpnClient.GetServers()
	if err != nil {
		return fmt.Errorf("failed to get servers: %w", err)
	}

	eligible := eligibleRouteServers(cfg, servers)
	entries := routeCatalogEntries(eligible)
	if len(entries) == 0 {
		if len(cfg.Countries) > 0 {
			return fmt.Errorf("no online servers found for countries: %v", cfg.Countries)
		}
		return fmt.Errorf("no online servers found")
	}
	if cfg.AutoPing {
		_, pings, _ := vpn.NewServerSelector(cfg).SpeedCandidatesWithProgress(eligible, len(eligible), nil)
		attachRouteCatalogPings(entries, pings)
	}

	if cfg.ProgressJSON {
		emitRouteCatalogProgress(entries, func(event speedtest.ProgressEvent) {
			data, _ := json.Marshal(event)
			fmt.Fprintf(os.Stderr, "GOLIVE_PROGRESS %s\n", data)
		})
	}

	if cfg.JSONOutput {
		data, _ := json.Marshal(routeCatalogResult{Success: true, Routes: entries})
		fmt.Println(string(data))
		return nil
	}

	fmt.Printf("%-7s  %-14s  %-18s  %5s  %6s  %-10s\n",
		"Country", "Server", "City", "Load", "Score", "Tier")
	fmt.Println(strings.Repeat("-", 86))
	for i := range entries {
		entry := &entries[i]
		fmt.Printf("%-7s  %-14s  %-18s  %3d%%  %6.2f  %-10s\n",
			entry.Country, entry.Server, entry.City, entry.Load, entry.Score, entry.Tier)
	}
	fmt.Printf("\n%d routes found across %d countries.\n", len(entries), countCatalogCountries(entries))
	return nil
}

func countCatalogCountries(entries []routeCatalogEntry) int {
	seen := make(map[string]struct{}, len(entries))
	for _, entry := range entries {
		seen[entry.Country] = struct{}{}
	}
	return len(seen)
}

func renewSerial(cfg *config.Config, vpnClient *vpn.Client) error {
	certs, err := vpnClient.ListCertificates()
	if err != nil {
		return fmt.Errorf("failed to list certificates: %w", err)
	}

	var target *api.VPNCertificate
	for i := range certs {
		if certs[i].SerialNumber == cfg.RenewSerial {
			target = &certs[i]
			break
		}
	}

	if target == nil {
		return fmt.Errorf("certificate with SerialNumber %s not found (use -list-configs to see available certificates)", cfg.RenewSerial)
	}

	if target.ClientKey == "" {
		return fmt.Errorf("certificate %s has no public key data", cfg.RenewSerial)
	}

	deviceName := target.DeviceName
	if deviceName == "" {
		return fmt.Errorf("certificate %s has no device name", cfg.RenewSerial)
	}

	vpnInfo, err := vpnClient.RenewCertificate(target.ClientKey, deviceName)
	if err != nil {
		return fmt.Errorf("failed to renew certificate: %w", err)
	}

	fmt.Printf("Certificate renewed: %s\n", cfg.RenewSerial)
	fmt.Printf("Device name: %s\n", deviceName)
	fmt.Printf("New expiry: %s\n", time.Unix(vpnInfo.ExpirationTime, 0).UTC().Format("2006-01-02 15:04 UTC"))
	return nil
}

func listConfigs(vpnClient *vpn.Client) error {
	certs, err := vpnClient.ListCertificates()
	if err != nil {
		return fmt.Errorf("failed to list configurations: %w", err)
	}
	if len(certs) == 0 {
		fmt.Println("No persistent configurations found.")
		return nil
	}

	fmt.Printf("%-40s  %-30s  %-20s  %s\n", "SerialNumber", "DeviceName", "Expires", "Fingerprint")
	fmt.Println(strings.Repeat("-", 120))
	for _, c := range certs {
		exp := time.Unix(c.ExpirationTime, 0).UTC().Format("2006-01-02 15:04 UTC")
		name := c.DeviceName
		if name == "" {
			name = "-"
		}
		fmt.Printf("%-40s  %-30s  %-20s  %s\n", c.SerialNumber, name, exp, c.ClientKeyFingerprint)
	}
	fmt.Printf("\nTotal: %d\n", len(certs))
	return nil
}
