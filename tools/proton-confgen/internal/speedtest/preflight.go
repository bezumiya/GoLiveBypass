package speedtest

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"time"

	"protonvpn-wg-confgen/internal/api"
	"protonvpn-wg-confgen/internal/vpn"
)

const (
	// A zero-byte request proves the expensive parts that an IP ping cannot:
	// the WireGuard peer key, UDP handshake, DNS and the HTTPS path used by the
	// real transfer. A cold userspace handshake can take a few seconds, so do
	// not use the 1.2s ping budget here. The optimized pool retries rejected
	// handshakes serially because Proton can briefly reject several tunnels
	// opened with the same freshly registered client key.
	candidateProbeTimeout = 6 * time.Second
)

// ProbeCandidate performs the lightweight tunnel check used before the
// bandwidth comparison. It never creates a host interface or a system route.
func ProbeCandidate(ctx context.Context, privateKey string, server api.LogicalServer) error {
	peer := vpn.GetBestWireGuardPhysicalServer(&server)
	if peer == nil {
		return errors.New("servidor sem um peer WireGuard utilizável")
	}
	client, closeTunnel, err := tunnelClient(privateKey, *peer)
	if err != nil {
		return err
	}
	defer closeTunnel()
	probeCtx, cancel := context.WithTimeout(ctx, candidateProbeTimeout)
	defer cancel()
	_, err = request(probeCtx, client, http.MethodGet, speedEndpoint+"/__down?bytes=0", nil, 0)
	return err
}

// FilterReachableCandidates removes ping finalists whose WireGuard tunnel or
// measurement endpoint does not answer a zero-byte request. Every finalist is
// probed, even after the requested number of healthy routes is reached, so the
// progress stream reflects the complete tunnel triage. The input order is
// preserved, so the preceding ping ranking remains the tie-breaker for which
// healthy routes reach the full speed test.
func FilterReachableCandidates(ctx context.Context, privateKey string, candidates []api.LogicalServer, limit int, progress ProgressFunc) ([]api.LogicalServer, error) {
	return filterReachableCandidates(ctx, privateKey, candidates, limit, ProbeCandidate, progress)
}

// FilterReachableCandidatesConcurrent uses a small probe pool to overlap
// handshakes to different Proton endpoints. Any failed concurrent probe is
// retried serially before selection, because a server may reject two handshakes
// made with the same client key at once. The serial public function remains the
// conservative default for callers that do not need the optimization.
func FilterReachableCandidatesConcurrent(ctx context.Context, privateKey string, candidates []api.LogicalServer, limit, concurrency int, progress ProgressFunc) ([]api.LogicalServer, error) {
	return filterReachableCandidatesWithConcurrency(ctx, privateKey, candidates, limit, max(1, concurrency), ProbeCandidate, progress)
}

type candidateProbeFunc func(context.Context, string, api.LogicalServer) error

func filterReachableCandidates(ctx context.Context, privateKey string, candidates []api.LogicalServer, limit int, probe candidateProbeFunc, progress ProgressFunc) ([]api.LogicalServer, error) {
	return filterReachableCandidatesWithConcurrency(ctx, privateKey, candidates, limit, 1, probe, progress)
}

func filterReachableCandidatesWithConcurrency(ctx context.Context, privateKey string, candidates []api.LogicalServer, limit, concurrency int, probe candidateProbeFunc, progress ProgressFunc) ([]api.LogicalServer, error) {
	if len(candidates) == 0 {
		return nil, errors.New("nenhum candidato elegível para a verificação rápida")
	}
	target := min(max(0, limit), len(candidates))
	if target == 0 {
		return nil, errors.New("limite de candidatos inválido")
	}

	passed := make([]bool, len(candidates))
	errorsByIndex := make([]error, len(candidates))
	tested, succeeded := 0, 0
	if progress != nil {
		progress(ProgressEvent{Phase: "preparing", Total: len(candidates), Tested: 0, Succeeded: 0})
	}
	probeOne := func(index int) error {
		probeCtx, cancel := context.WithTimeout(ctx, candidateProbeTimeout)
		defer cancel()
		return probe(probeCtx, privateKey, candidates[index])
	}

	// The default path is intentionally simple and fully serial. The optimized
	// path records every result first, so failed parallel handshakes can be
	// retried one at a time without changing the ping order used for selection.
	if concurrency <= 1 {
		for index := range candidates {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			started := time.Now()
			err := probeOne(index)
			tested++
			elapsedMs := max(0, int(time.Since(started).Milliseconds()))
			errorsByIndex[index] = err
			if err == nil {
				passed[index] = true
				succeeded++
			}
			emitPreflightProgress(progress, candidates[index].Name, len(candidates), tested, succeeded, err, elapsedMs)
		}
	} else {
		workers := min(max(1, concurrency), len(candidates))
		type outcome struct {
			index     int
			err       error
			elapsedMs int
		}
		jobs := make(chan int)
		outcomes := make(chan outcome, len(candidates))
		var wg sync.WaitGroup
		for range workers {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for index := range jobs {
					if ctx.Err() != nil {
						continue
					}
					started := time.Now()
					err := probeOne(index)
					outcomes <- outcome{index: index, err: err, elapsedMs: max(0, int(time.Since(started).Milliseconds()))}
				}
			}()
		}
		go func() {
			defer close(outcomes)
			defer wg.Wait()
			defer close(jobs)
			for index := range candidates {
				select {
				case jobs <- index:
				case <-ctx.Done():
					return
				}
			}
		}()
		for result := range outcomes {
			tested++
			errorsByIndex[result.index] = result.err
			if result.err == nil {
				passed[result.index] = true
				succeeded++
			}
			emitPreflightProgress(progress, candidates[result.index].Name, len(candidates), tested, succeeded, result.err, result.elapsedMs)
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		for index, err := range errorsByIndex {
			if err == nil {
				continue
			}
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			started := time.Now()
			retryErr := probeOne(index)
			elapsedMs := max(0, int(time.Since(started).Milliseconds()))
			errorsByIndex[index] = retryErr
			if retryErr == nil && !passed[index] {
				passed[index] = true
				succeeded++
				// tested already includes this route's first attempt. Emit the
				// corrected status without inflating the total counter.
				emitPreflightProgress(progress, candidates[index].Name, len(candidates), tested, succeeded, nil, elapsedMs)
			}
		}
	}
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if succeeded == 0 {
		return nil, errors.New("nenhum candidato respondeu pelo túnel na verificação rápida")
	}

	selected := make([]api.LogicalServer, 0, min(target, succeeded))
	for index, candidate := range candidates {
		if !passed[index] {
			continue
		}
		selected = append(selected, candidate)
		if len(selected) == target {
			break
		}
	}
	if len(selected) == 0 {
		return nil, errors.New("nenhum candidato selecionado para a medição")
	}
	return selected, nil
}

func emitPreflightProgress(progress ProgressFunc, server string, total, tested, succeeded int, err error, elapsedMs int) {
	if progress == nil {
		return
	}
	status := "failed"
	if err == nil {
		status = "success"
	}
	progress(ProgressEvent{
		Phase:     "preparing",
		Total:     total,
		Tested:    tested,
		Succeeded: succeeded,
		Server:    server,
		ElapsedMs: elapsedMs,
		Status:    status,
	})
}
