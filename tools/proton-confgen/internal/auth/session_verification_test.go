package auth

import (
	"fmt"
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
