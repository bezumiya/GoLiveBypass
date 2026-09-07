package server

import (
	"bufio"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/labstack/echo/v5"

	"github.com/bezumiya/GoLiveBypass/api/internal/config"
	"github.com/bezumiya/GoLiveBypass/api/internal/gh"
)

type fakeIssues struct {
	got gh.Issue
	res gh.IssueResult
	err error
}

func (f *fakeIssues) CreateIssue(_ context.Context, iss gh.Issue) (gh.IssueResult, error) {
	f.got = iss
	return f.res, f.err
}

func newTestApp(t *testing.T, cfg *config.Config, f *fakeIssues) *echo.Echo {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	return New(cfg, f, logger)
}

func testConfig() *config.Config {
	return &config.Config{
		APIToken:            "segredo",
		GitHubToken:         "gh",
		GitHubWebhookSecret: "webhook-secret",
		GitHubRepo:          "owner/repo",
		Labels:              []string{"bug"},
		Port:                "8080",
		RateLimitPerMin:     1000,
		BlockSeconds:        300,
		MaxLogBytes:         262144,
		LogLevel:            "info",
	}
}

func do(t *testing.T, e *echo.Echo, method, path, token, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)
	return rec
}

func TestHealthz(t *testing.T) {
	e := newTestApp(t, testConfig(), &fakeIssues{})
	rec := do(t, e, http.MethodGet, "/healthz", "", "")

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got := strings.TrimSpace(rec.Body.String()); got != `{"status":"ok"}` {
		t.Errorf("body = %s", got)
	}
}

func signedWebhook(body []byte, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write(body)
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
}

func webhookBody(action, repo, tag string, draft, prerelease bool) []byte {
	return []byte(fmt.Sprintf(`{"action":%q,"repository":{"full_name":%q},"release":{"tag_name":%q,"draft":%t,"prerelease":%t,"published_at":"2026-09-07T12:00:00Z"}}`, action, repo, tag, draft, prerelease))
}

func TestGitHubWebhookAndUpdateStream(t *testing.T) {
	e := newTestApp(t, testConfig(), &fakeIssues{})
	ts := httptest.NewServer(e)
	defer ts.Close()

	body := webhookBody("published", "owner/repo", "v2.0.6", false, false)
	req, err := http.NewRequest(http.MethodPost, ts.URL+"/v1/updates/github/webhook", strings.NewReader(string(body)))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-GitHub-Event", "release")
	req.Header.Set("X-GitHub-Delivery", "delivery-1")
	req.Header.Set("X-Hub-Signature-256", signedWebhook(body, "webhook-secret"))
	webhookResponse, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	webhookResponse.Body.Close()
	if webhookResponse.StatusCode != http.StatusAccepted {
		t.Fatalf("webhook status = %d, want 202", webhookResponse.StatusCode)
	}

	duplicate, err := http.NewRequest(http.MethodPost, ts.URL+"/v1/updates/github/webhook", strings.NewReader(string(body)))
	if err != nil {
		t.Fatal(err)
	}
	duplicate.Header.Set("X-GitHub-Event", "release")
	duplicate.Header.Set("X-GitHub-Delivery", "delivery-1")
	duplicate.Header.Set("X-Hub-Signature-256", signedWebhook(body, "webhook-secret"))
	duplicateResponse, err := ts.Client().Do(duplicate)
	if err != nil {
		t.Fatal(err)
	}
	duplicateResponse.Body.Close()
	if duplicateResponse.StatusCode != http.StatusNoContent {
		t.Fatalf("webhook duplicado status = %d, want 204", duplicateResponse.StatusCode)
	}

	streamResponse, err := ts.Client().Get(ts.URL + "/v1/updates/stream")
	if err != nil {
		t.Fatal(err)
	}
	defer streamResponse.Body.Close()
	if streamResponse.StatusCode != http.StatusOK {
		t.Fatalf("stream status = %d, want 200", streamResponse.StatusCode)
	}
	reader := bufio.NewReader(streamResponse.Body)
	line, err := reader.ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	if line != "event: release\n" {
		t.Fatalf("primeira linha SSE = %q", line)
	}
	if line, err = reader.ReadString('\n'); err != nil || !strings.HasPrefix(line, "id: delivery-1") {
		t.Fatalf("id SSE = %q, erro = %v", line, err)
	}
}

func TestGitHubWebhookRejectsInvalidSignature(t *testing.T) {
	e := newTestApp(t, testConfig(), &fakeIssues{})
	body := webhookBody("published", "owner/repo", "v2.0.6", false, false)
	req := httptest.NewRequest(http.MethodPost, "/v1/updates/github/webhook", strings.NewReader(string(body)))
	req.Header.Set("X-GitHub-Event", "release")
	req.Header.Set("X-GitHub-Delivery", "delivery-invalid")
	req.Header.Set("X-Hub-Signature-256", "sha256=0000000000000000000000000000000000000000000000000000000000000000")
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestCreateReportHappyPath(t *testing.T) {
	f := &fakeIssues{res: gh.IssueResult{Number: 42, URL: "https://github.com/owner/repo/issues/42"}}
	e := newTestApp(t, testConfig(), f)

	body := `{"title":"  Go Live não sobe  ","description":"reproduz assim","log":"linha1\n` + "````" + `\nlinha2","meta":{"os":"linux x64"}}`
	rec := do(t, e, http.MethodPost, "/v1/reports", "segredo", body)

	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201 (body = %s)", rec.Code, rec.Body.String())
	}
	var out struct {
		Number int    `json:"issue_number"`
		URL    string `json:"issue_url"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decodificando resposta: %v", err)
	}
	if out.Number != 42 || out.URL != "https://github.com/owner/repo/issues/42" {
		t.Errorf("resposta = %+v", out)
	}

	if f.got.Title != "Go Live não sobe" {
		t.Errorf("title enviado = %q (esperado sem espacos)", f.got.Title)
	}
	if len(f.got.Labels) != 1 || f.got.Labels[0] != "bug" {
		t.Errorf("labels enviadas = %v", f.got.Labels)
	}
	if !strings.Contains(f.got.Body, "| os | linux x64 |") {
		t.Error("corpo sem metadados")
	}
	if !strings.Contains(f.got.Body, "````") {
		t.Error("corpo sem fence do log")
	}
}

func TestCreateReportNoAuth(t *testing.T) {
	e := newTestApp(t, testConfig(), &fakeIssues{})
	rec := do(t, e, http.MethodPost, "/v1/reports", "", `{"title":"x"}`)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestCreateReportBadToken(t *testing.T) {
	e := newTestApp(t, testConfig(), &fakeIssues{})
	rec := do(t, e, http.MethodPost, "/v1/reports", "errado", `{"title":"x"}`)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestCreateReportInvalidPayload(t *testing.T) {
	e := newTestApp(t, testConfig(), &fakeIssues{})

	tests := []struct {
		name string
		body string
	}{
		{"json malformado", `{"title":`},
		{"titulo vazio", `{"title":""}`},
		{"payload nao-json", `isso nao e json`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := do(t, e, http.MethodPost, "/v1/reports", "segredo", tt.body)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400 (body = %s)", rec.Code, rec.Body.String())
			}
		})
	}
}

func TestCreateReportGitHubFalha(t *testing.T) {
	f := &fakeIssues{err: context.DeadlineExceeded}
	e := newTestApp(t, testConfig(), f)

	rec := do(t, e, http.MethodPost, "/v1/reports", "segredo", `{"title":"x"}`)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "DeadlineExceeded") {
		t.Errorf("resposta vazou detalhe interno: %s", rec.Body.String())
	}
}

func TestRateLimit(t *testing.T) {
	cfg := testConfig()
	cfg.RateLimitPerMin = 1 // agressivo: 1 request por min
	e := newTestApp(t, cfg, &fakeIssues{res: gh.IssueResult{Number: 1, URL: "u"}})

	first := do(t, e, http.MethodPost, "/v1/reports", "segredo", `{"title":"x"}`)
	if first.Code != http.StatusCreated {
		t.Fatalf("primeira chamada: status = %d, want 201", first.Code)
	}
	second := do(t, e, http.MethodPost, "/v1/reports", "segredo", `{"title":"x"}`)
	if second.Code != http.StatusTooManyRequests {
		t.Fatalf("segunda chamada: status = %d, want 429", second.Code)
	}
	if got := second.Header().Get("Retry-After"); got != "300" {
		t.Errorf("Retry-After = %q, want 300 (BlockSeconds)", got)
	}
	if got := second.Header().Get("X-RateLimit-Remaining"); got != "0" {
		t.Errorf("X-RateLimit-Remaining = %q, want 0", got)
	}
}

func TestBlockStatusRefleteBloqueio(t *testing.T) {
	cfg := testConfig()
	cfg.RateLimitPerMin = 2
	e := newTestApp(t, cfg, &fakeIssues{res: gh.IssueResult{Number: 1, URL: "u"}})

	// Antes de estourar: nao bloqueado.
	rec := do(t, e, http.MethodGet, "/v1/block-status", "segredo", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("block-status inicial: status = %d, want 200", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `"blocked":false`) {
		t.Errorf("block-status inicial = %s, want blocked:false", rec.Body.String())
	}

	// Estoura a janela (3 requests com teto 2).
	for i := 0; i < 3; i++ {
		do(t, e, http.MethodPost, "/v1/reports", "segredo", `{"title":"x"}`)
	}

	rec = do(t, e, http.MethodGet, "/v1/block-status", "segredo", "")
	if !strings.Contains(rec.Body.String(), `"blocked":true`) {
		t.Errorf("block-status apos estourar = %s, want blocked:true", rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"retry_after"`) {
		t.Errorf("block-status apos estourar sem retry_after: %s", rec.Body.String())
	}
}

func TestBlockExpira(t *testing.T) {
	cfg := testConfig()
	cfg.RateLimitPerMin = 1
	cfg.BlockSeconds = 1 // bloqueio curto para o teste
	e := newTestApp(t, cfg, &fakeIssues{res: gh.IssueResult{Number: 1, URL: "u"}})

	do(t, e, http.MethodPost, "/v1/reports", "segredo", `{"title":"x"}`)
	blocked := do(t, e, http.MethodPost, "/v1/reports", "segredo", `{"title":"x"}`)
	if blocked.Code != http.StatusTooManyRequests {
		t.Fatalf("esperava 429 no bloqueio, got %d", blocked.Code)
	}

	// Depois de expirar o bloqueio de 1s, volta a aceitar.
	time.Sleep(1200 * time.Millisecond)
	rec := do(t, e, http.MethodGet, "/v1/block-status", "segredo", "")
	if !strings.Contains(rec.Body.String(), `"blocked":false`) {
		t.Errorf("apos expirar = %s, want blocked:false", rec.Body.String())
	}
	post := do(t, e, http.MethodPost, "/v1/reports", "segredo", `{"title":"x"}`)
	if post.Code != http.StatusCreated {
		t.Fatalf("apos expirar, POST = %d, want 201", post.Code)
	}
}

func TestBodyLimit(t *testing.T) {
	e := newTestApp(t, testConfig(), &fakeIssues{})
	big := `{"title":"` + strings.Repeat("a", 512*1024) + `"}`
	rec := do(t, e, http.MethodPost, "/v1/reports", "segredo", big)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", rec.Code)
	}
}

func TestMethodNotAllowed(t *testing.T) {
	e := newTestApp(t, testConfig(), &fakeIssues{})
	rec := do(t, e, http.MethodGet, "/v1/reports", "segredo", "")
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", rec.Code)
	}
}

func TestBasePath(t *testing.T) {
	cfg := testConfig()
	cfg.BasePath = "bugs"
	e := newTestApp(t, cfg, &fakeIssues{})

	rec := do(t, e, http.MethodGet, "/bugs/healthz", "", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body = %s)", rec.Code, rec.Body.String())
	}

	rec = do(t, e, http.MethodPost, "/bugs/v1/reports", "segredo", `{"title":"x"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201 (rota sob prefixo deve existir)", rec.Code)
	}

	rec = do(t, e, http.MethodGet, "/healthz", "", "")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 (sem prefixo nao deve existir)", rec.Code)
	}
}
