package auth

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"protonvpn-wg-confgen/internal/api"
	"protonvpn-wg-confgen/internal/config"
)

func auditSession(access, refresh string, expiresIn int) *api.Session {
	return &api.Session{AccessToken: access, RefreshToken: refresh, UID: "uid-audit", ExpiresIn: expiresIn}
}

func TestAuthenticatePropagatesTemporaryCachedSessionFailure(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "proton-session.json")
	store := NewSessionStore(file)
	if err := store.Save(auditSession("access-old", "refresh-old", 30*24*60*60), "audit@example.com", 30*24*time.Hour); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if r.URL.Path != "/vpn/v1/logicals" {
			t.Fatalf("unexpected fresh-auth request: %s", r.URL.Path)
		}
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer server.Close()

	client := NewClient(&config.Config{
		APIURL:      server.URL,
		Username:    "audit@example.com",
		Password:    "not-a-real-password",
		SessionFile: file,
	})
	_, err := client.Authenticate()
	if !IsTemporarySessionError(err) {
		t.Fatalf("Authenticate() error = %v; want TemporarySessionError", err)
	}
	if got := requests.Load(); got != 1 {
		t.Fatalf("server request count = %d; want one session verification and no fresh login", got)
	}
	if _, err := os.Stat(file); err != nil {
		t.Fatalf("cached session was removed after temporary failure: %v", err)
	}
}

func TestAuthenticateUpgradesCachedSessionMissingVPNScope(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "proton-session.json")
	session := auditSession("access-scope", "refresh-scope", 30*24*60*60)
	session.Scopes = []string{"twofactor"}
	if err := NewSessionStore(file).Save(session, "scope@example.com", 30*24*time.Hour); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	var upgrades atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/vpn/v1/logicals":
			_, _ = fmt.Fprint(w, `{"Code":1000}`)
		case "/auth/2fa":
			upgrades.Add(1)
			_, _ = fmt.Fprint(w, `{"Code":1000,"Scopes":["twofactor","vpn"]}`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	client := NewClient(&config.Config{
		APIURL:          server.URL,
		Username:        "scope@example.com",
		SessionFile:     file,
		TwoFactorCode:   "123456",
		SessionDuration: "0",
	})
	loaded, err := client.Authenticate()
	if err != nil {
		t.Fatalf("Authenticate() error = %v", err)
	}
	if loaded == nil || !hasScope(loaded.Scopes, "vpn") {
		t.Fatalf("Authenticate() scopes = %#v; want vpn scope", loaded)
	}
	if got := upgrades.Load(); got != 1 {
		t.Fatalf("2FA upgrade requests = %d; want one", got)
	}
	saved, _, err := NewSessionStore(file).Load("scope@example.com")
	if err != nil || saved == nil || !hasScope(saved.Scopes, "vpn") {
		t.Fatalf("saved scopes = %#v, error = %v; want upgraded VPN scope", saved, err)
	}
}

func TestRefreshTemporaryHTTPFailureKeepsCachedSession(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "proton-session.json")
	store := NewSessionStore(file)
	if err := store.Save(auditSession("access-old", "refresh-old", int(time.Hour/time.Second)), "audit@example.com", time.Hour); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadGateway)
		_, _ = fmt.Fprint(w, `{"Code":1000,"AccessToken":"unexpected","UID":"uid-audit","ExpiresIn":3600}`)
	}))
	defer server.Close()

	client := NewClient(&config.Config{
		APIURL:       server.URL,
		Username:     "audit@example.com",
		SessionFile:  file,
		ForceRefresh: true,
	})
	if session, err := client.tryExistingSession(); session != nil || !IsTemporarySessionError(err) {
		t.Fatalf("tryExistingSession() = session %v, error %v; want temporary error and no session", session != nil, err)
	}
	if _, err := os.Stat(file); err != nil {
		t.Fatalf("cached session was removed after temporary refresh failure: %v", err)
	}
}

func TestRefreshInvalidCodeAllowsReauthenticationPath(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "proton-session.json")
	store := NewSessionStore(file)
	if err := store.Save(auditSession("access-old", "refresh-old", 3600), "audit@example.com", time.Hour); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, `{"Code":10013,"Error":"refresh token rejected"}`)
	}))
	defer server.Close()

	client := NewClient(&config.Config{
		APIURL:       server.URL,
		Username:     "audit@example.com",
		SessionFile:  file,
		ForceRefresh: true,
	})
	if session, err := client.tryExistingSession(); session != nil || err != nil {
		t.Fatalf("tryExistingSession() = session %v, error %v; want reauthentication path", session != nil, err)
	}
	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Fatalf("rejected cached session still exists; stat error = %v", err)
	}
}

func TestLoadRejectsIncompleteCachedSession(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "proton-session.json")
	store := NewSessionStore(file)
	if err := os.WriteFile(file, []byte(`{"username":"audit@example.com","expires_at":"2099-01-01T00:00:00Z"}`), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
	if session, _, err := store.Load("audit@example.com"); session != nil || err != nil {
		t.Fatalf("Load() = session %v, error %v; want no usable session", session != nil, err)
	}
	if _, err := store.Username(); err == nil || !strings.Contains(err.Error(), "incomplete") {
		t.Fatalf("Username() error = %v; want incomplete-session error", err)
	}
}

func TestSessionStoreRejectsSessionSymlink(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "real-session.json")
	link := filepath.Join(root, "proton-session.json")
	if err := NewSessionStore(target).Save(auditSession("access", "refresh", 3600), "audit@example.com", time.Hour); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symbolic links unavailable: %v", err)
	}

	store := NewSessionStore(link)
	if _, _, err := store.Load("audit@example.com"); err == nil || !strings.Contains(err.Error(), "regular file") {
		t.Fatalf("Load() error = %v; want symlink rejection", err)
	}
	if err := store.Delete(); err != nil {
		t.Fatalf("Delete() error = %v", err)
	}
	if _, err := os.Stat(target); err != nil {
		t.Fatalf("deleting the link also removed the target: %v", err)
	}
}

func TestDeleteIfMatchesPreservesReplacement(t *testing.T) {
	root := t.TempDir()
	store := NewSessionStore(filepath.Join(root, "proton-session.json"))
	oldSession := auditSession("access-old", "refresh-old", 3600)
	newSession := auditSession("access-new", "refresh-new", 3600)
	if err := store.Save(oldSession, "audit@example.com", time.Hour); err != nil {
		t.Fatalf("Save(old) error = %v", err)
	}
	if err := store.Save(newSession, "audit@example.com", time.Hour); err != nil {
		t.Fatalf("Save(new) error = %v", err)
	}
	if err := store.DeleteIfMatches(oldSession); err != nil {
		t.Fatalf("DeleteIfMatches() error = %v", err)
	}
	loaded, _, err := store.Load("audit@example.com")
	if err != nil || loaded == nil || loaded.AccessToken != "access-new" {
		t.Fatalf("Load() = %#v, %v; newer cached session was not preserved", loaded, err)
	}
}

func TestVerifySessionStatusRejectsIncompleteSessionWithoutRequest(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	valid, err := VerifySessionStatus(server.Client(), server.URL, &api.Session{AccessToken: "access-only"})
	if valid || err != nil {
		t.Fatalf("VerifySessionStatus() = valid %v, error %v; want invalid without transport error", valid, err)
	}
	if got := requests.Load(); got != 0 {
		t.Fatalf("server request count = %d; incomplete credentials must not be sent", got)
	}
}

func TestVerifySessionStatusChecksProtonCodeInSuccessfulHTTPResponse(t *testing.T) {
	tests := []struct {
		name      string
		body      string
		wantValid bool
		wantError bool
	}{
		{name: "api invalid", body: `{"Code":10013}`, wantValid: false, wantError: true},
		{name: "api valid", body: `{"Code":1000}`, wantValid: true},
		{name: "gateway body", body: `<html>temporarily unavailable</html>`, wantError: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusOK)
				_, _ = fmt.Fprint(w, tt.body)
			}))
			defer server.Close()

			valid, err := VerifySessionStatus(server.Client(), server.URL, auditSession("access", "refresh", 3600))
			if valid != tt.wantValid || (err != nil) != tt.wantError {
				t.Fatalf("VerifySessionStatus() = valid %v, error %v; want valid %v, error %v", valid, err, tt.wantValid, tt.wantError)
			}
		})
	}
}

func TestRefreshSessionRetainsUnrotatedRefreshToken(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, `{"Code":1000,"AccessToken":"access-new","UID":"uid-audit","ExpiresIn":3600}`)
	}))
	defer server.Close()

	refreshed, err := RefreshSession(server.Client(), server.URL, auditSession("access-old", "refresh-old", 3600))
	if err != nil {
		t.Fatalf("RefreshSession() error = %v", err)
	}
	if refreshed.RefreshToken != "refresh-old" {
		t.Fatalf("RefreshToken = %q; want previous token when response omits rotation", refreshed.RefreshToken)
	}
}
