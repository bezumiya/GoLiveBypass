package speedtest

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"testing"
	"time"

	"protonvpn-wg-confgen/internal/api"
	"protonvpn-wg-confgen/internal/constants"
)

func manualProbeKey(t *testing.T) string {
	t.Helper()
	key, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return base64.StdEncoding.EncodeToString(key.Bytes())
}

func TestProbeCandidateRejectsAnInvalidPeerBeforeOpeningUserspaceTunnel(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()

	err := ProbeCandidate(ctx, manualProbeKey(t), api.LogicalServer{
		Name: "US#manual",
		Servers: []api.PhysicalServer{{
			Status:          constants.StatusOnline,
			EntryIP:         "192.0.2.20",
			X25519PublicKey: "invalid",
		}},
	})
	if err == nil || err.Error() != "servidor sem um peer WireGuard utilizável" {
		t.Fatalf("ProbeCandidate() error = %v, want invalid-peer error", err)
	}
}

func TestProbeCandidateHonorsCanceledContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	started := time.Now()
	err := ProbeCandidate(ctx, manualProbeKey(t), api.LogicalServer{
		Name: "US#manual",
		Servers: []api.PhysicalServer{{
			Status:          constants.StatusOnline,
			EntryIP:         "192.0.2.21",
			X25519PublicKey: manualProbeKey(t),
		}},
	})
	if err == nil {
		t.Fatal("ProbeCandidate() succeeded with a canceled context")
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("canceled manual probe took %s", elapsed)
	}
}

func TestManualProbeFilteringUsesOneBoundedProbeAndNoSpeedMeasurement(t *testing.T) {
	candidates := []api.LogicalServer{{Name: "US#manual"}}
	var calls int
	got, err := filterReachableCandidates(context.Background(), "private-key", candidates, 1,
		func(ctx context.Context, _ string, server api.LogicalServer) error {
			calls++
			if server.Name != "US#manual" {
				t.Fatalf("probed server = %q", server.Name)
			}
			if _, ok := ctx.Deadline(); !ok {
				t.Fatal("manual preflight must have a bounded deadline")
			}
			return nil
		}, nil)
	if err != nil {
		t.Fatalf("filterReachableCandidates() error = %v", err)
	}
	if len(got) != 1 || got[0].Name != "US#manual" || calls != 1 {
		t.Fatalf("got=%v calls=%d, want one successful preflight and no speed retries", got, calls)
	}
}
