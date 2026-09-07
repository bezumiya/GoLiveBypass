package speedtest

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"slices"
	"sync/atomic"
	"time"

	"protonvpn-wg-confgen/internal/api"
	"protonvpn-wg-confgen/internal/vpn"
)

const (
	downloadBytes = 4 * 1024 * 1024
	uploadBytes   = 1024 * 1024
	speedEndpoint = "https://speed.cloudflare.com"
)

type Measurement struct {
	DownloadMbps float64 `json:"downloadMbps"`
	UploadMbps   float64 `json:"uploadMbps"`
	LatencyMs    int     `json:"latencyMs"`
}

type Result struct {
	Server api.LogicalServer
	Measurement
	Tested    int `json:"tested"`
	Succeeded int `json:"succeeded"`
}

// ProgressEvent describes one step of the sequential candidate measurement.
// It is deliberately limited to public server metrics; it never contains
// credentials, keys, or tunnel details.
type ProgressEvent struct {
	Phase        string  `json:"phase"`
	Total        int     `json:"total"`
	Tested       int     `json:"tested"`
	Succeeded    int     `json:"succeeded"`
	Server       string  `json:"server,omitempty"`
	DownloadMbps float64 `json:"downloadMbps,omitempty"`
	UploadMbps   float64 `json:"uploadMbps,omitempty"`
	PingMs       int     `json:"pingMs,omitempty"`
	ElapsedMs    int     `json:"elapsedMs,omitempty"`
	Status       string  `json:"status,omitempty"`
}

// ProgressFunc receives progress synchronously after each state transition.
// Callers that do not need progress should use Select, which remains
// compatible with the original API.
type ProgressFunc func(ProgressEvent)

// MeasureCandidate opens and closes its own tunnel. DNS and all HTTP traffic
// use netstack exclusively; a failed WireGuard handshake cannot fall back direct.
func MeasureCandidate(ctx context.Context, privateKey string, server api.LogicalServer) (Measurement, error) {
	peer := vpn.GetBestWireGuardPhysicalServer(&server)
	if peer == nil {
		return Measurement{}, errors.New("servidor sem um peer WireGuard utilizável")
	}
	client, closeTunnel, err := tunnelClient(privateKey, *peer)
	if err != nil {
		return Measurement{}, err
	}
	defer closeTunnel()
	return measureHTTP(ctx, client, speedEndpoint, downloadBytes, uploadBytes)
}

type countingReader struct {
	reader io.Reader
	count  atomic.Int64
}

func (r *countingReader) Read(p []byte) (int, error) {
	n, err := r.reader.Read(p)
	r.count.Add(int64(n))
	return n, err
}

func request(ctx context.Context, client *http.Client, method, url string, body []byte, expected int64) (time.Duration, error) {
	sent := &countingReader{reader: bytes.NewReader(body)}
	var requestBody io.Reader
	if method == http.MethodPost {
		requestBody = sent
	}
	req, err := http.NewRequestWithContext(ctx, method, url, requestBody)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Cache-Control", "no-store")
	if method == http.MethodPost {
		req.ContentLength = int64(len(body))
		req.Header.Set("Content-Type", "application/octet-stream")
	}
	start := time.Now()
	res, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("medição HTTP %d", res.StatusCode)
	}
	// Download must have exactly the requested bytes. Upload response is small
	// and untrusted: consume at most 64 KiB, accepting only completed responses.
	limit := expected + 1
	if expected < 0 {
		limit = 64 * 1024
	}
	n, err := io.Copy(io.Discard, io.LimitReader(res.Body, limit))
	if err != nil {
		return 0, err
	}
	if (expected >= 0 && n != expected) || (expected < 0 && n >= limit) {
		return 0, errors.New("resposta de medição incompleta ou inválida")
	}
	if method == http.MethodPost && sent.count.Load() != int64(len(body)) {
		return 0, errors.New("upload não foi enviado por completo")
	}
	return time.Since(start), nil
}

func measureHTTP(ctx context.Context, client *http.Client, base string, downBytes, upBytes int64) (Measurement, error) {
	// Warm up WireGuard, DNS and TLS; do not count their setup as transfer RTT.
	if _, err := request(ctx, client, http.MethodGet, base+"/__down?bytes=0", nil, 0); err != nil {
		return Measurement{}, err
	}
	latencies := make([]int, 0, 3)
	for range 3 {
		elapsed, err := request(ctx, client, http.MethodGet, base+"/__down?bytes=0", nil, 0)
		if err != nil {
			return Measurement{}, err
		}
		latencies = append(latencies, max(1, int(elapsed.Milliseconds())))
	}
	slices.Sort(latencies)
	down, err := request(ctx, client, http.MethodGet, fmt.Sprintf("%s/__down?bytes=%d", base, downBytes), nil, downBytes)
	if err != nil {
		return Measurement{}, err
	}
	payload := make([]byte, upBytes)
	if _, err := rand.Read(payload); err != nil {
		return Measurement{}, err
	}
	up, err := request(ctx, client, http.MethodPost, base+"/__up", payload, -1)
	if err != nil {
		return Measurement{}, err
	}
	return Measurement{DownloadMbps: float64(downBytes) * 8 / down.Seconds() / 1e6, UploadMbps: float64(upBytes) * 8 / up.Seconds() / 1e6, LatencyMs: latencies[1]}, nil
}

func capacity(m Measurement) float64 {
	if m.DownloadMbps <= 0 || m.UploadMbps <= 0 || math.IsNaN(m.DownloadMbps) || math.IsNaN(m.UploadMbps) || math.IsInf(m.DownloadMbps, 0) || math.IsInf(m.UploadMbps, 0) {
		return 0
	}
	// Harmonic mean prevents excellent download from hiding unusable upload.
	return 2 / (1/m.DownloadMbps + 1/m.UploadMbps)
}

func best(results []Result) (Result, error) {
	maxCapacity := 0.0
	for _, r := range results {
		maxCapacity = math.Max(maxCapacity, capacity(r.Measurement))
	}
	if maxCapacity == 0 {
		return Result{}, errors.New("nenhum servidor concluiu download e upload pelo túnel; a rota anterior foi preservada")
	}
	var chosen Result
	bestCapacity := -1.0
	for _, r := range results {
		c := capacity(r.Measurement)
		if c <= 0 {
			continue
		}
		better := c > bestCapacity
		if c == bestCapacity {
			// Ping is a tie-breaker only. Unknown ping loses to a known ping,
			// and the name makes fully tied results deterministic.
			pingRank := r.LatencyMs
			if pingRank <= 0 {
				pingRank = math.MaxInt
			}
			chosenPing := chosen.LatencyMs
			if chosenPing <= 0 {
				chosenPing = math.MaxInt
			}
			better = pingRank < chosenPing || (pingRank == chosenPing && r.Server.Name < chosen.Server.Name)
		}
		if better {
			chosen, bestCapacity = r, c
		}
	}
	if bestCapacity < 0 {
		return Result{}, errors.New("nenhuma medição válida de capacidade")
	}
	return chosen, nil
}

// Select measures sequentially: simultaneous transfers would compete for the
// user's bandwidth and corrupt the comparison. Each candidate has a 12s budget.
func Select(ctx context.Context, privateKey string, candidates []api.LogicalServer) (Result, error) {
	return SelectWithProgress(ctx, privateKey, candidates, nil)
}

// SelectWithProgress is Select with an optional progress callback.
func SelectWithProgress(ctx context.Context, privateKey string, candidates []api.LogicalServer, progress ProgressFunc) (Result, error) {
	return selectMeasuredWithProgress(ctx, candidates, func(ctx context.Context, s api.LogicalServer) (Measurement, error) {
		return MeasureCandidate(ctx, privateKey, s)
	}, progress)
}

// SelectWithProgressFallbacks measures the primary candidates in ping order
// and only opens fallback routes when a primary transfer fails. It stops as
// soon as target successful measurements are available, so a transient speed
// failure does not leave the comparison with fewer samples than requested.
// Fallbacks are expected to have already passed the tunnel preflight and are
// kept in the same ping order as the primary slice.
func SelectWithProgressFallbacks(ctx context.Context, privateKey string, primary, fallbacks []api.LogicalServer, target int, progress ProgressFunc) (Result, error) {
	return selectMeasuredWithFallbacks(ctx, primary, fallbacks, target, func(ctx context.Context, s api.LogicalServer) (Measurement, error) {
		return MeasureCandidate(ctx, privateKey, s)
	}, progress)
}

func selectMeasured(ctx context.Context, candidates []api.LogicalServer, measure func(context.Context, api.LogicalServer) (Measurement, error)) (Result, error) {
	return selectMeasuredWithProgress(ctx, candidates, measure, nil)
}

func selectMeasuredWithProgress(ctx context.Context, candidates []api.LogicalServer, measure func(context.Context, api.LogicalServer) (Measurement, error), progress ProgressFunc) (Result, error) {
	var results []Result
	tested := 0
	emit := func(event ProgressEvent) {
		if progress != nil {
			progress(event)
		}
	}
	emit(ProgressEvent{Phase: "testing", Total: len(candidates), Tested: 0, Succeeded: 0})
	for _, s := range candidates {
		if ctx.Err() != nil {
			break
		}
		emit(ProgressEvent{Phase: "testing", Total: len(candidates), Tested: tested, Succeeded: len(results), Server: s.Name, Status: "testing"})
		started := time.Now()
		candidateCtx, cancel := context.WithTimeout(ctx, 12*time.Second)
		m, err := measure(candidateCtx, s)
		cancel()
		tested++
		elapsedMs := max(0, int(time.Since(started).Milliseconds()))
		if err == nil {
			results = append(results, Result{Server: s, Measurement: m})
			emit(ProgressEvent{Phase: "testing", Total: len(candidates), Tested: tested, Succeeded: len(results), Server: s.Name, DownloadMbps: m.DownloadMbps, UploadMbps: m.UploadMbps, PingMs: m.LatencyMs, ElapsedMs: elapsedMs, Status: "success"})
		} else {
			emit(ProgressEvent{Phase: "testing", Total: len(candidates), Tested: tested, Succeeded: len(results), Server: s.Name, ElapsedMs: elapsedMs, Status: "failed"})
		}
	}
	// A global deadline means the comparison was incomplete. Do not promote a
	// fast early result as if all finalists had been measured; the caller can
	// retry while preserving the previous profile. Explicit cancellation is
	// kept compatible with the legacy Select contract, where a successful last
	// candidate may still be returned.
	if tested < len(candidates) && errors.Is(ctx.Err(), context.DeadlineExceeded) {
		emit(ProgressEvent{Phase: "finalizing", Total: len(candidates), Tested: tested, Succeeded: len(results)})
		return Result{Tested: tested, Succeeded: len(results)}, ctx.Err()
	}
	result, err := best(results)
	result.Tested, result.Succeeded = tested, len(results)
	event := ProgressEvent{Phase: "finalizing", Total: len(candidates), Tested: tested, Succeeded: len(results)}
	if err == nil {
		event.Server, event.DownloadMbps, event.UploadMbps, event.PingMs = result.Server.Name, result.DownloadMbps, result.UploadMbps, result.LatencyMs
	}
	emit(event)
	return result, err
}

func selectMeasuredWithFallbacks(ctx context.Context, primary, fallbacks []api.LogicalServer, target int, measure func(context.Context, api.LogicalServer) (Measurement, error), progress ProgressFunc) (Result, error) {
	allCandidates := make([]api.LogicalServer, 0, len(primary)+len(fallbacks))
	allCandidates = append(allCandidates, primary...)
	allCandidates = append(allCandidates, fallbacks...)
	if len(allCandidates) == 0 {
		return Result{}, errors.New("nenhum candidato disponível para a medição")
	}
	target = min(max(1, target), len(allCandidates))
	tested, succeeded := 0, 0
	results := make([]Result, 0, target)
	total := min(len(primary), len(allCandidates))
	if total == 0 {
		total = 1
	}
	emit := func(event ProgressEvent) {
		if progress != nil {
			progress(event)
		}
	}
	emit(ProgressEvent{Phase: "testing", Total: total, Tested: 0, Succeeded: 0})

	for index, server := range allCandidates {
		if succeeded >= target || ctx.Err() != nil {
			break
		}
		if index >= total {
			// A fallback is added to the visible work only when it is needed.
			// This keeps the normal six-route progress unchanged while making
			// extra attempts explicit when a route fails.
			total = index + 1
		}
		emit(ProgressEvent{Phase: "testing", Total: total, Tested: tested, Succeeded: succeeded, Server: server.Name, Status: "testing"})
		started := time.Now()
		candidateCtx, cancel := context.WithTimeout(ctx, 12*time.Second)
		measurement, err := measure(candidateCtx, server)
		cancel()
		tested++
		elapsedMs := max(0, int(time.Since(started).Milliseconds()))
		if err == nil {
			results = append(results, Result{Server: server, Measurement: measurement})
			succeeded++
			emit(ProgressEvent{Phase: "testing", Total: total, Tested: tested, Succeeded: succeeded, Server: server.Name, DownloadMbps: measurement.DownloadMbps, UploadMbps: measurement.UploadMbps, PingMs: measurement.LatencyMs, ElapsedMs: elapsedMs, Status: "success"})
		} else {
			emit(ProgressEvent{Phase: "testing", Total: total, Tested: tested, Succeeded: succeeded, Server: server.Name, ElapsedMs: elapsedMs, Status: "failed"})
		}
	}

	if tested < len(allCandidates) && succeeded < target && errors.Is(ctx.Err(), context.DeadlineExceeded) {
		emit(ProgressEvent{Phase: "finalizing", Total: total, Tested: tested, Succeeded: succeeded})
		return Result{Tested: tested, Succeeded: succeeded}, ctx.Err()
	}
	result, err := best(results)
	result.Tested, result.Succeeded = tested, succeeded
	event := ProgressEvent{Phase: "finalizing", Total: total, Tested: tested, Succeeded: succeeded}
	if err == nil {
		event.Server, event.DownloadMbps, event.UploadMbps, event.PingMs = result.Server.Name, result.DownloadMbps, result.UploadMbps, result.LatencyMs
	}
	emit(event)
	return result, err
}
