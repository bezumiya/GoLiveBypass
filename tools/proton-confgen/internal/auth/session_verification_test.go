package auth

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"protonvpn-wg-confgen/internal/api"
	"protonvpn-wg-confgen/internal/config"
)

func TestVerifySessionStatusDistinguishesTemporaryFailure(t *testing.T) {
	tests := []struct {
		name        string
		status      int
		wantValid   bool
		wantFailure bool
		wantInvalid bool
	}{
		{name: "valid", status: http.StatusOK, wantValid: true},
		{name: "revoked", status: http.StatusUnauthorized, wantFailure: true, wantInvalid: true},
		{name: "temporary", status: http.StatusServiceUnavailable, wantFailure: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tt.status)
			}))
			defer server.Close()

			valid, err := VerifySessionStatus(server.Client(), server.URL, &api.Session{AccessToken: "access", UID: "uid"})
			if valid != tt.wantValid {
				t.Fatalf("valid = %v, want %v", valid, tt.wantValid)
			}
			if (err != nil) != tt.wantFailure {
				t.Fatalf("temporary error = %v, want error %v", err, tt.wantFailure)
			}
			if got := IsSessionInvalid(err); got != tt.wantInvalid {
				t.Fatalf("session-invalid classification = %v, want %v (err %v)", got, tt.wantInvalid, err)
			}
		})
	}
}

// A verificação consulta /vpn/v1/logicals, cujo catálogo de servidores já
// passou do antigo limite de leitura de 256 KB. O envelope Code deve ser lido
// em streaming sem rejeitar a sessão nem baixar o corpo inteiro.
func TestVerifySessionStatusReadsCodeFromLargeCatalogBody(t *testing.T) {
	payload := `{"Code":1000,` + strings.Repeat(`"pad":"x",`, 64) + `"Details":[]}`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, payload)
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		_, _ = io.Copy(w, strings.NewReader(strings.Repeat("A", 3*1024*1024)))
	}))
	defer server.Close()

	valid, err := VerifySessionStatus(server.Client(), server.URL, &api.Session{AccessToken: "access", UID: "uid"})
	if !valid || err != nil {
		t.Fatalf("VerifySessionStatus() = (%v, %v); want valid session despite oversized catalog", valid, err)
	}
}

func TestVerifySessionStatusRejectsErrorCodeInsideLargeBody(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, `{"Code":8002}`)
		_, _ = io.Copy(w, strings.NewReader(strings.Repeat("A", 512*1024)))
	}))
	defer server.Close()

	valid, err := VerifySessionStatus(server.Client(), server.URL, &api.Session{AccessToken: "access", UID: "uid"})
	if valid || !IsSessionInvalid(err) {
		t.Fatalf("VerifySessionStatus() = (%v, %v); want session-invalid classification", valid, err)
	}
}

func TestVerifySessionStatusRejectsEnvelopeWithoutCode(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, `{"Unexpected":true}`)
	}))
	defer server.Close()

	valid, err := VerifySessionStatus(server.Client(), server.URL, &api.Session{AccessToken: "access", UID: "uid"})
	var protocolErr *ProtocolError
	if valid || !errors.As(err, &protocolErr) {
		t.Fatalf("VerifySessionStatus() = (%v, %v); want ProtocolError for missing Code", valid, err)
	}
}

func TestVerifySessionStatusKeepsTemporaryOnTruncatedBody(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Content-Length", "4096")
		_, _ = fmt.Fprint(w, `{"Code":`) // conexão encerrada no meio do envelope
	}))
	defer server.Close()

	valid, err := VerifySessionStatus(server.Client(), server.URL, &api.Session{AccessToken: "access", UID: "uid"})
	if valid || !IsTemporarySessionError(err) {
		t.Fatalf("VerifySessionStatus() = (%v, %v); want temporary error on truncated body", valid, err)
	}
}

func TestTemporarySessionVerificationKeepsCachedSession(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "proton-session.json")
	store := NewSessionStore(file)
	session := &api.Session{AccessToken: "access", RefreshToken: "refresh", UID: "uid", ExpiresIn: 30 * 24 * 60 * 60}
	if err := store.Save(session, "account@example.com", 30*24*time.Hour); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer server.Close()

	client := NewClient(&config.Config{
		APIURL:      server.URL,
		Username:    "account@example.com",
		SessionFile: file,
	})
	if session, err := client.tryExistingSession(); session != nil || err == nil {
		t.Fatalf("tryExistingSession() = session %v, error %v; want temporary error", session != nil, err)
	}
	if _, _, err := client.CheckSession(); !IsTemporarySessionError(err) {
		t.Fatalf("CheckSession() error = %v; want TemporarySessionError", err)
	}
	if _, err := os.Stat(file); err != nil {
		t.Fatalf("cached session was removed after a temporary failure: %v", err)
	}
}

func TestHandleSessionRefreshReturnsSaveFailure(t *testing.T) {
	root := t.TempDir()
	badParent := filepath.Join(root, "not-a-directory")
	if err := os.WriteFile(badParent, []byte("sentinel"), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, `{"Code":1000,"AccessToken":"new-access","RefreshToken":"new-refresh","UID":"uid","ExpiresIn":3600}`)
	}))
	defer server.Close()

	client := NewClient(&config.Config{
		APIURL:          server.URL,
		Username:        "account@example.com",
		SessionFile:     filepath.Join(badParent, "session.json"),
		SessionDuration: "24h",
	})
	_, err := client.handleSessionRefresh(&api.Session{
		AccessToken:  "old-access",
		RefreshToken: "old-refresh",
		UID:          "uid",
	}, "test refresh")
	if err == nil || !strings.Contains(err.Error(), "failed to save refreshed session") {
		t.Fatalf("handleSessionRefresh() error = %v; want save failure", err)
	}
}
