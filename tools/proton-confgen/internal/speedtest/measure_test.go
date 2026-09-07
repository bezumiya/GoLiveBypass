package speedtest

import (
	"context"
	"errors"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"slices"
	"strconv"
	"testing"
	"time"

	"protonvpn-wg-confgen/internal/api"
)

func speedHandler(t *testing.T) http.Handler {
	t.Helper()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/__down" {
			n, _ := strconv.Atoi(r.URL.Query().Get("bytes"))
			if n < 0 || n > downloadBytes {
				w.WriteHeader(400)
				return
			}
			w.Header().Set("Content-Length", strconv.Itoa(n))
			_, _ = w.Write(make([]byte, n))
		} else if r.URL.Path == "/__up" {
			n, err := io.Copy(io.Discard, r.Body)
			if err != nil || n == 0 {
				w.WriteHeader(400)
				return
			}
			_, _ = w.Write([]byte("{}"))
		} else {
			w.WriteHeader(404)
		}
	})
}

func TestMeasureHTTPTransfersAndRejectsTruncation(t *testing.T) {
	srv := httptest.NewServer(speedHandler(t))
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	m, err := measureHTTP(ctx, srv.Client(), srv.URL, 65536, 32768)
	if err != nil || capacity(m) <= 0 || m.LatencyMs <= 0 {
		t.Fatalf("measurement=%+v err=%v", m, err)
	}
	truncated := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("short")) }))
	defer truncated.Close()
	if _, err := request(ctx, truncated.Client(), http.MethodGet, truncated.URL, nil, 100); err == nil {
		t.Fatal("truncated payload accepted")
	}
}

func TestRankingPrioritizesRealThroughputAndUpload(t *testing.T) {
	results := []Result{
		{Server: api.LogicalServer{Name: "low-ping"}, Measurement: Measurement{DownloadMbps: 2, UploadMbps: 1, LatencyMs: 15}},
		{Server: api.LogicalServer{Name: "fast"}, Measurement: Measurement{DownloadMbps: 60, UploadMbps: 20, LatencyMs: 150}},
		{Server: api.LogicalServer{Name: "bad-upload"}, Measurement: Measurement{DownloadMbps: 500, UploadMbps: 0.1, LatencyMs: 10}},
	}
	got, err := best(results)
	if err != nil || got.Server.Name != "fast" {
		t.Fatalf("got %v %v", got, err)
	}
	results[0].Measurement = results[1].Measurement
	results[0].LatencyMs = 20
	got, err = best(results)
	if err != nil || got.Server.Name != "low-ping" {
		t.Fatalf("latency must break equal throughput: %v %v", got, err)
	}
	for _, invalid := range []float64{0, -1, math.NaN(), math.Inf(1)} {
		if _, err := best([]Result{{Measurement: Measurement{DownloadMbps: invalid, UploadMbps: 20, LatencyMs: 10}}}); err == nil {
			t.Fatal("invalid measurement accepted")
		}
	}
}

func TestRankingDoesNotLetPingOverrideThroughput(t *testing.T) {
	results := []Result{
		{Server: api.LogicalServer{Name: "low-ping"}, Measurement: Measurement{DownloadMbps: 10, UploadMbps: 10, LatencyMs: 1}},
		{Server: api.LogicalServer{Name: "fast"}, Measurement: Measurement{DownloadMbps: 12, UploadMbps: 12, LatencyMs: 500}},
	}
	got, err := best(results)
	if err != nil || got.Server.Name != "fast" {
		t.Fatalf("throughput must be ranked before ping: got=%+v err=%v", got, err)
	}
}

func TestSelectionSkipsFailuresAndRunsSequentially(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	order := []string{}
	got, err := selectMeasured(ctx, []api.LogicalServer{{Name: "bad"}, {Name: "good"}, {Name: "unused"}}, func(ctx context.Context, s api.LogicalServer) (Measurement, error) {
		if _, ok := ctx.Deadline(); !ok {
			t.Fatal("missing candidate deadline")
		}
		order = append(order, s.Name)
		if s.Name == "bad" {
			return Measurement{}, errors.New("timeout")
		}
		cancel()
		return Measurement{DownloadMbps: 20, UploadMbps: 10, LatencyMs: 50}, nil
	})
	if err != nil || got.Server.Name != "good" || got.Tested != 2 || got.Succeeded != 1 || len(order) != 2 {
		t.Fatalf("got=%+v order=%v err=%v", got, order, err)
	}
}

func TestSelectionReportsProgressForFailuresAndSuccesses(t *testing.T) {
	var events []ProgressEvent
	got, err := selectMeasuredWithProgress(context.Background(), []api.LogicalServer{{Name: "bad"}, {Name: "good"}}, func(ctx context.Context, s api.LogicalServer) (Measurement, error) {
		if s.Name == "bad" {
			return Measurement{}, errors.New("timeout")
		}
		return Measurement{DownloadMbps: 20, UploadMbps: 10, LatencyMs: 50}, nil
	}, func(event ProgressEvent) { events = append(events, event) })
	if err != nil || got.Server.Name != "good" {
		t.Fatalf("got=%+v err=%v", got, err)
	}
	if len(events) != 6 {
		t.Fatalf("expected preparing-independent testing/finalizing events, got %d: %+v", len(events), events)
	}
	if events[0] != (ProgressEvent{Phase: "testing", Total: 2}) {
		t.Fatalf("unexpected initial event: %+v", events[0])
	}
	if events[1].Server != "bad" || events[1].Status != "testing" || events[1].Tested != 0 {
		t.Fatalf("unexpected bad testing event: %+v", events[1])
	}
	if events[2].Server != "bad" || events[2].Status != "failed" || events[2].Tested != 1 || events[2].Succeeded != 0 {
		t.Fatalf("unexpected bad result event: %+v", events[2])
	}
	if events[4].Server != "good" || events[4].Status != "success" || events[4].Tested != 2 || events[4].Succeeded != 1 {
		t.Fatalf("unexpected good result event: %+v", events[4])
	}
	if events[5].Phase != "finalizing" || events[5].Tested != 2 || events[5].Succeeded != 1 {
		t.Fatalf("unexpected finalizing event: %+v", events[5])
	}
}

func TestSelectionUsesFallbackAfterSpeedFailure(t *testing.T) {
	var attempted []string
	var events []ProgressEvent
	primary := []api.LogicalServer{{Name: "primary-bad"}, {Name: "primary-good"}}
	fallbacks := []api.LogicalServer{{Name: "fallback-good"}, {Name: "fallback-unused"}}
	got, err := selectMeasuredWithFallbacks(context.Background(), primary, fallbacks, 2, func(_ context.Context, server api.LogicalServer) (Measurement, error) {
		attempted = append(attempted, server.Name)
		if server.Name == "primary-bad" {
			return Measurement{}, errors.New("transferência indisponível")
		}
		if server.Name == "primary-good" {
			return Measurement{DownloadMbps: 30, UploadMbps: 15, LatencyMs: 40}, nil
		}
		return Measurement{DownloadMbps: 20, UploadMbps: 10, LatencyMs: 40}, nil
	}, func(event ProgressEvent) { events = append(events, event) })
	if err != nil || got.Server.Name != "primary-good" || got.Tested != 3 || got.Succeeded != 2 {
		t.Fatalf("got=%+v attempted=%v err=%v", got, attempted, err)
	}
	if want := []string{"primary-bad", "primary-good", "fallback-good"}; !slices.Equal(attempted, want) {
		t.Fatalf("attempt order=%v want=%v", attempted, want)
	}
	if len(events) == 0 || events[len(events)-1].Total != 3 || events[len(events)-1].Tested != 3 || events[len(events)-1].Succeeded != 2 {
		t.Fatalf("fallback progress did not expose extra attempt: %+v", events)
	}
}

func TestSelectionDoesNotUseFallbackWhenPrimaryRoutesSucceed(t *testing.T) {
	var attempted []string
	got, err := selectMeasuredWithFallbacks(context.Background(), []api.LogicalServer{{Name: "primary-one"}, {Name: "primary-two"}}, []api.LogicalServer{{Name: "fallback"}}, 2, func(_ context.Context, server api.LogicalServer) (Measurement, error) {
		attempted = append(attempted, server.Name)
		return Measurement{DownloadMbps: 20, UploadMbps: 10, LatencyMs: 40}, nil
	}, nil)
	if err != nil || got.Tested != 2 || got.Succeeded != 2 {
		t.Fatalf("got=%+v err=%v", got, err)
	}
	if want := []string{"primary-one", "primary-two"}; !slices.Equal(attempted, want) {
		t.Fatalf("fallback was measured despite six healthy primary routes: %v", attempted)
	}
}

func TestSelectionDoesNotPromotePartialResultAfterGlobalDeadline(t *testing.T) {
	ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Millisecond))
	defer cancel()
	got, err := selectMeasuredWithProgress(ctx, []api.LogicalServer{{Name: "first"}, {Name: "second"}}, func(context.Context, api.LogicalServer) (Measurement, error) {
		return Measurement{DownloadMbps: 100, UploadMbps: 50, LatencyMs: 10}, nil
	}, nil)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected cancellation error, got %v", err)
	}
	if got.Server.Name != "" || got.Tested != 0 {
		t.Fatalf("partial result was promoted: %+v", got)
	}
}
