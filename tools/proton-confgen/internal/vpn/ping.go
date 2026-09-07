package vpn

import (
	"context"
	"math"
	"net"
	"os/exec"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"protonvpn-wg-confgen/internal/api"
)

var (
	pingLinuxRegex   = regexp.MustCompile(`(?:time|tempo)=([0-9.]+)\s*ms`)
	pingWindowsRegex = regexp.MustCompile(`(?:time|tempo)[=<]([0-9]+)ms`)
)

// ProbePing measures round-trip time (RTT) to an IP address in milliseconds.
func ProbePing(ip string, timeout time.Duration) int {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	return probePingContext(ctx, ip)
}

func probePingContext(ctx context.Context, ip string) int {
	if ip == "" {
		return 999
	}

	// 1. Try system ICMP ping
	if ms, err := systemPingContext(ctx, ip); err == nil && ms > 0 {
		return ms
	}

	// 2. Fallback: TCP probe to port 443 or 80
	for _, port := range []string{"443", "80"} {
		start := time.Now()
		conn, err := (&net.Dialer{}).DialContext(ctx, "tcp", net.JoinHostPort(ip, port))
		if err == nil {
			_ = conn.Close()
			return max(1, int(time.Since(start).Milliseconds()))
		}
	}

	return 999
}

func systemPing(ip string, timeout time.Duration) (int, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	return systemPingContext(ctx, ip)
}

func systemPingContext(ctx context.Context, ip string) (int, error) {
	// Reserve time for TCP fallback when ICMP is filtered.
	icmpCtx, cancel := context.WithTimeout(ctx, 600*time.Millisecond)
	defer cancel()
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.CommandContext(icmpCtx, "ping", "-n", "1", "-w", "600", ip)
	} else {
		// Linux / macOS: 1 packet, 1s deadline
		cmd = exec.CommandContext(icmpCtx, "ping", "-c", "1", "-W", "1", ip)
	}

	out, err := cmd.CombinedOutput()
	if err != nil {
		return 0, err
	}

	text := strings.ToLower(string(out))
	if runtime.GOOS == "windows" {
		if strings.Contains(text, "<1ms") {
			return 1, nil
		}
		matches := pingWindowsRegex.FindStringSubmatch(text)
		if len(matches) > 1 {
			if val, err := strconv.Atoi(matches[1]); err == nil {
				return val, nil
			}
		}
	} else {
		matches := pingLinuxRegex.FindStringSubmatch(text)
		if len(matches) > 1 {
			if val, err := strconv.ParseFloat(matches[1], 64); err == nil {
				return max(1, int(math.Round(val))), nil
			}
		}
	}

	return 0, nil
}

// PingProgressEvent describes one logical route after its physical endpoint has
// been measured. A shared physical IP is probed once, but every logical route
// that points to it receives its own event so the progress count remains honest.
type PingProgressEvent struct {
	Total     int
	Tested    int
	Succeeded int
	Server    string
	PingMs    int
	ElapsedMs int
	Status    string
}

// PingProgressFunc receives ping progress synchronously after each route is
// accounted for. It is intentionally independent from speedtest.ProgressFunc
// so the VPN package does not depend on the measurement package.
type PingProgressFunc func(PingProgressEvent)

// ProbeCandidatesPing covers the regional candidates with bounded concurrency
// and a shared deadline. Shared entry IPs are measured once, avoiding duplicate
// probes to the same physical machine. Missing/failed probes are not winners.
func ProbeCandidatesPing(servers []api.LogicalServer, maxCandidates int) map[string]int {
	return ProbeCandidatesPingWithProgress(servers, maxCandidates, nil)
}

// ProbeCandidatesPingWithProgress is the observable form of
// ProbeCandidatesPing. The callback is used by the GUI and the terminal trace
// so both callers see the same ping stage and the same counters.
func ProbeCandidatesPingWithProgress(servers []api.LogicalServer, maxCandidates int, progress PingProgressFunc) map[string]int {
	ctx, cancel := context.WithTimeout(context.Background(), 18*time.Second)
	defer cancel()
	return probeCandidatesWithProgress(ctx, servers[:max(0, min(maxCandidates, len(servers)))], probePingContext, progress)
}

func probeCandidates(ctx context.Context, servers []api.LogicalServer, probe func(context.Context, string) int) map[string]int {
	return probeCandidatesWithProgress(ctx, servers, probe, nil)
}

type pingOutcome struct {
	ip        string
	ms        int
	elapsedMs int
}

func probeCandidatesWithProgress(ctx context.Context, servers []api.LogicalServer, probe func(context.Context, string) int, progress PingProgressFunc) map[string]int {
	byIP := make(map[string][]string)
	var ips []string
	var missing []string
	for _, srv := range servers {
		phys := GetBestPhysicalServer(&srv)
		if phys == nil || phys.EntryIP == "" {
			missing = append(missing, srv.Name)
			continue
		}
		if _, exists := byIP[phys.EntryIP]; !exists {
			ips = append(ips, phys.EntryIP)
		}
		byIP[phys.EntryIP] = append(byIP[phys.EntryIP], srv.Name)
	}
	results := make(map[string]int)
	tested, succeeded := 0, 0
	if progress != nil {
		progress(PingProgressEvent{Total: len(servers)})
	}
	emit := func(server string, ms, elapsedMs int) {
		tested++
		status := "failed"
		if ms > 0 && ms < 999 {
			succeeded++
			status = "success"
		}
		if progress != nil {
			progress(PingProgressEvent{
				Total:     len(servers),
				Tested:    tested,
				Succeeded: succeeded,
				Server:    server,
				PingMs:    ms,
				ElapsedMs: elapsedMs,
				Status:    status,
			})
		}
	}

	// Entries without an endpoint are accounted for as failed routes. Speed
	// selection normally removes them before this stage, but counting them here
	// keeps diagnostics truthful for callers that pass raw API data.
	for _, name := range missing {
		emit(name, 999, 0)
	}
	if len(ips) == 0 {
		return results
	}

	jobs := make(chan string)
	outcomes := make(chan pingOutcome, len(ips))
	var wg sync.WaitGroup
	for range min(32, len(ips)) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for ip := range jobs {
				if ctx.Err() != nil {
					continue
				}
				probeCtx, cancel := context.WithTimeout(ctx, 1200*time.Millisecond)
				started := time.Now()
				ms := probe(probeCtx, ip)
				cancel()
				outcomes <- pingOutcome{ip: ip, ms: ms, elapsedMs: max(0, int(time.Since(started).Milliseconds()))}
			}
		}()
	}

	go func() {
		defer close(outcomes)
		defer wg.Wait()
		defer close(jobs)
	send:
		for _, ip := range ips {
			select {
			case jobs <- ip:
			case <-ctx.Done():
				break send
			}
		}
	}()
	for outcome := range outcomes {
		for _, name := range byIP[outcome.ip] {
			results[name] = outcome.ms
			emit(name, outcome.ms, outcome.elapsedMs)
		}
	}
	return results
}
