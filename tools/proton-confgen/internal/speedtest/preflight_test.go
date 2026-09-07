package speedtest

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"protonvpn-wg-confgen/internal/api"
)

func TestFilterReachableCandidatesDropsProbeFailuresAndKeepsPingOrder(t *testing.T) {
	candidates := []api.LogicalServer{{Name: "low-ping-bad"}, {Name: "second-ping-good"}, {Name: "third-ping-good"}}
	var events []ProgressEvent
	probe := func(ctx context.Context, _ string, server api.LogicalServer) error {
		if _, ok := ctx.Deadline(); !ok {
			t.Fatal("candidate probe must have a deadline")
		}
		if server.Name == "low-ping-bad" {
			return errors.New("handshake timeout")
		}
		return nil
	}
	got, err := filterReachableCandidates(context.Background(), "private-key", candidates, 2, probe, func(event ProgressEvent) {
		events = append(events, event)
	})
	if err != nil || len(got) != 2 || got[0].Name != "second-ping-good" || got[1].Name != "third-ping-good" {
		t.Fatalf("got=%v err=%v", got, err)
	}
	if len(events) != 4 || events[0].Phase != "preparing" || events[0].Total != 3 {
		t.Fatalf("unexpected preflight progress: %+v", events)
	}
	seen := map[string]string{}
	for _, event := range events[1:] {
		seen[event.Server] = event.Status
	}
	if seen["low-ping-bad"] != "failed" || seen["second-ping-good"] != "success" || seen["third-ping-good"] != "success" {
		t.Fatalf("unexpected candidate statuses: %+v", seen)
	}
}

func TestFilterReachableCandidatesChecksAllTwelveBeforeSelectingSix(t *testing.T) {
	candidates := make([]api.LogicalServer, 12)
	for index := range candidates {
		candidates[index].Name = fmt.Sprintf("route-%02d", index+1)
	}
	var probed []string
	var events []ProgressEvent
	probe := func(_ context.Context, _ string, server api.LogicalServer) error {
		probed = append(probed, server.Name)
		return nil
	}
	got, err := filterReachableCandidates(context.Background(), "private-key", candidates, 6, probe, func(event ProgressEvent) {
		events = append(events, event)
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 6 || len(probed) != 12 || len(events) != 13 {
		t.Fatalf("selected=%d probed=%d events=%d; expected six selected after twelve probes", len(got), len(probed), len(events))
	}
	if last := events[len(events)-1]; last.Tested != 12 || last.Succeeded != 12 {
		t.Fatalf("final preflight progress=%+v; expected 12/12", last)
	}
	for index, server := range got {
		if server.Name != candidates[index].Name {
			t.Fatalf("selected route %d = %q, want %q", index, server.Name, candidates[index].Name)
		}
	}
}

func TestFilterReachableCandidatesStopsOnCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := filterReachableCandidates(ctx, "private-key", []api.LogicalServer{{Name: "one"}}, 1, func(ctx context.Context, _ string, _ api.LogicalServer) error {
		return ctx.Err()
	}, nil)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected cancellation, got %v", err)
	}
}

func TestFilterReachableCandidatesSerializesTunnelProbes(t *testing.T) {
	var active, maxActive atomic.Int32
	probe := func(ctx context.Context, _ string, _ api.LogicalServer) error {
		current := active.Add(1)
		for {
			previous := maxActive.Load()
			if current <= previous || maxActive.CompareAndSwap(previous, current) {
				break
			}
		}
		defer active.Add(-1)
		select {
		case <-time.After(5 * time.Millisecond):
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	_, err := filterReachableCandidates(context.Background(), "private-key", []api.LogicalServer{
		{Name: "one"}, {Name: "two"}, {Name: "three"},
	}, 3, probe, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := maxActive.Load(); got != 1 {
		t.Fatalf("concurrent tunnel probes reached %d; expected one at a time", got)
	}
}

func TestFilterReachableCandidatesConcurrentRetriesFailuresSerially(t *testing.T) {
	var active, maxActive atomic.Int32
	var attemptsMu sync.Mutex
	attempts := make(map[string]int)
	var events []ProgressEvent
	probe := func(ctx context.Context, _ string, server api.LogicalServer) error {
		current := active.Add(1)
		for {
			previous := maxActive.Load()
			if current <= previous || maxActive.CompareAndSwap(previous, current) {
				break
			}
		}
		defer active.Add(-1)
		select {
		case <-time.After(time.Millisecond):
		case <-ctx.Done():
			return ctx.Err()
		}
		attemptsMu.Lock()
		attempts[server.Name]++
		attempt := attempts[server.Name]
		attemptsMu.Unlock()
		if attempt == 1 {
			return errors.New("concorrência simulada")
		}
		return nil
	}
	candidates := []api.LogicalServer{{Name: "one"}, {Name: "two"}, {Name: "three"}, {Name: "four"}}
	got, err := filterReachableCandidatesWithConcurrency(context.Background(), "private-key", candidates, 2, 2, probe, func(event ProgressEvent) {
		events = append(events, event)
	})
	if err != nil || len(got) != 2 || got[0].Name != "one" || got[1].Name != "two" {
		t.Fatalf("got=%v err=%v", got, err)
	}
	if maxActive.Load() != 2 {
		t.Fatalf("expected two concurrent probes, got max=%d", maxActive.Load())
	}
	if len(events) < len(candidates)+1 || events[len(events)-1].Tested != len(candidates) || events[len(events)-1].Succeeded != len(candidates) {
		t.Fatalf("retry progress did not settle all routes: %+v", events)
	}
}

func TestProbeCandidateRejectsMalformedPeerBeforeOpeningTunnel(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	err := ProbeCandidate(ctx, "bad-private-key", api.LogicalServer{Name: "broken"})
	if err == nil || err.Error() != "servidor sem um peer WireGuard utilizável" {
		t.Fatalf("expected malformed peer error, got %v", err)
	}
}
