package auth

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"protonvpn-wg-confgen/internal/api"
	"protonvpn-wg-confgen/internal/config"
)

// appVersionRejectionBody is what Proton answers, with HTTP 422, to a client
// whose x-pm-appversion it no longer supports.
const appVersionRejectionBody = `{"Code":5003,"Error":"This version of the app is no longer supported"}`

func requireAppVersionError(t *testing.T, err error, wantCode int) {
	t.Helper()
	var target *AppVersionError
	if !errors.As(err, &target) {
		t.Fatalf("error = %T %v; want *AppVersionError", err, err)
	}
	if target.Code != wantCode {
		t.Fatalf("AppVersionError.Code = %d; want %d", target.Code, wantCode)
	}
	if IsSessionInvalid(err) || IsTemporarySessionError(err) || IsInvalidCredentials(err) || IsTwoFactorError(err) {
		t.Fatalf("app-version rejection also matched another classification: %T %v", err, err)
	}
	if strings.Contains(err.Error(), "no longer supported") {
		t.Fatalf("error echoed the server-provided detail: %v", err)
	}
}

func appVersionServer(t *testing.T, status, code int) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = fmt.Fprintf(w, `{"Code":%d,"Error":"This version of the app is no longer supported"}`, code)
	}))
	t.Cleanup(server.Close)
	return server
}

func TestNewAuthenticationErrorMapsAppVersionCodes(t *testing.T) {
	for _, code := range []int{5001, 5003, 5005} {
		err := newAuthenticationError(code)
		requireAppVersionError(t, err, code)
		want := fmt.Sprintf("Proton no longer accepts this app version (code %d); update GoLiveBypass", code)
		if err.Error() != want {
			t.Fatalf("newAuthenticationError(%d) = %q; want %q", code, err.Error(), want)
		}
		requireAppVersionError(t, newTwoFactorError(code), code)
		if !IsAppVersionError(fmt.Errorf("authentication failed: %w", err)) {
			t.Fatalf("wrapped code %d lost its app-version classification", code)
		}
	}

	// Codes outside the app-version set keep their historical classification.
	if err := newAuthenticationError(CodeWrongPassword); !IsInvalidCredentials(err) || IsAppVersionError(err) {
		t.Fatalf("newAuthenticationError(%d) = %T %v; want invalid credentials", CodeWrongPassword, err, err)
	}
	if err := newAuthenticationError(CodeAccountDisabled); IsAppVersionError(err) || err.Error() != "account has been disabled" {
		t.Fatalf("newAuthenticationError(%d) = %T %v; want generic account error", CodeAccountDisabled, err, err)
	}
	if err := newTwoFactorError(CodeWrongPassword); !IsTwoFactorError(err) || IsAppVersionError(err) {
		t.Fatalf("newTwoFactorError(%d) = %T %v; want 2FA error", CodeWrongPassword, err, err)
	}
	if IsAppVersionError(&SessionInvalidError{Code: CodeMailboxPasswordError}) || IsSessionInvalid(&AppVersionError{Code: CodeAppVersionBad}) {
		t.Fatal("AppVersionError and SessionInvalidError must never match each other")
	}
}

// Every login endpoint can be the first to see the rejection; none of them may
// report it as a generic "authentication failed with code: 5003", a wrong
// password or a wrong TOTP code.
func TestLoginEndpointsReportAppVersionRejection(t *testing.T) {
	for _, status := range []int{http.StatusUnprocessableEntity, http.StatusOK} {
		t.Run(fmt.Sprintf("HTTP %d", status), func(t *testing.T) {
			server := appVersionServer(t, status, CodeAppVersionBad)
			client := NewClient(&config.Config{APIURL: server.URL, Username: "synthetic-user"})

			_, err := client.getAuthInfo()
			requireAppVersionError(t, err, CodeAppVersionBad)

			_, err = client.sendAuthRequest(map[string]any{usernameField: "synthetic-user"})
			requireAppVersionError(t, err, CodeAppVersionBad)

			_, err = client.submit2FA(&api.Session{AccessToken: "synthetic-access", UID: "synthetic-uid"}, "123456")
			requireAppVersionError(t, err, CodeAppVersionBad)
		})
	}
}

var appVersionRejectionCases = []struct {
	status int
	code   int
}{
	{status: http.StatusUnprocessableEntity, code: CodeAppVersionBad},
	{status: http.StatusUnprocessableEntity, code: CodeAppVersionMissing},
	{status: http.StatusUnprocessableEntity, code: CodeAPIVersionInvalid},
	{status: http.StatusBadRequest, code: CodeAppVersionBad},
	{status: http.StatusUnauthorized, code: CodeAppVersionBad},
	{status: http.StatusForbidden, code: CodeAppVersionBad},
	{status: http.StatusOK, code: CodeAppVersionBad},
	{status: http.StatusServiceUnavailable, code: CodeAppVersionBad},
}

func TestRefreshSessionReportsAppVersionRejectionForAnyStatus(t *testing.T) {
	for _, tt := range appVersionRejectionCases {
		t.Run(fmt.Sprintf("HTTP %d code %d", tt.status, tt.code), func(t *testing.T) {
			server := appVersionServer(t, tt.status, tt.code)
			refreshed, err := RefreshSession(server.Client(), server.URL, auditSession("synthetic-access", "synthetic-refresh", 3600))
			if refreshed != nil {
				t.Fatal("RefreshSession() returned a session for an app-version rejection")
			}
			requireAppVersionError(t, err, tt.code)
		})
	}
}

func TestVerifySessionStatusReportsAppVersionRejectionForAnyStatus(t *testing.T) {
	for _, tt := range appVersionRejectionCases {
		t.Run(fmt.Sprintf("HTTP %d code %d", tt.status, tt.code), func(t *testing.T) {
			server := appVersionServer(t, tt.status, tt.code)
			valid, err := VerifySessionStatus(server.Client(), server.URL, auditSession("synthetic-access", "synthetic-refresh", 3600))
			if valid {
				t.Fatal("VerifySessionStatus() accepted a session after an app-version rejection")
			}
			requireAppVersionError(t, err, tt.code)
		})
	}
}

// Proton rejects an outdated app version before it looks at the token, so the
// saved session must survive both the refresh and the verification paths.
// Deleting it would force a password login that Proton refuses the same way,
// and the user would lose the session that works again after the update.
func TestAuthenticateKeepsSavedSessionWhenAppVersionIsRejected(t *testing.T) {
	const verification = 30 * 24 * time.Hour // beyond SessionRefreshDays: verify only
	const refresh = time.Hour                // inside SessionRefreshDays: refresh first
	tests := []struct {
		name     string
		lifetime time.Duration
		path     string
		status   int
	}{
		{name: "verification HTTP 422", lifetime: verification, path: "/vpn/v1/logicals", status: http.StatusUnprocessableEntity},
		{name: "verification HTTP 200", lifetime: verification, path: "/vpn/v1/logicals", status: http.StatusOK},
		{name: "verification HTTP 401", lifetime: verification, path: "/vpn/v1/logicals", status: http.StatusUnauthorized},
		{name: "refresh HTTP 422", lifetime: refresh, path: "/auth/refresh", status: http.StatusUnprocessableEntity},
		{name: "refresh HTTP 200", lifetime: refresh, path: "/auth/refresh", status: http.StatusOK},
		{name: "refresh HTTP 401", lifetime: refresh, path: "/auth/refresh", status: http.StatusUnauthorized},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			file := filepath.Join(t.TempDir(), "proton-session.json")
			saved := auditSession("access-kept", "refresh-kept", int(tt.lifetime/time.Second))
			if err := NewSessionStore(file).Save(saved, "audit@example.com", tt.lifetime); err != nil {
				t.Fatalf("Save() error = %v", err)
			}

			var rejected, unexpected atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != tt.path {
					// /auth/info or /auth: a password login after the rejection.
					unexpected.Add(1)
					http.NotFound(w, r)
					return
				}
				rejected.Add(1)
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(tt.status)
				_, _ = fmt.Fprint(w, appVersionRejectionBody)
			}))
			defer server.Close()

			client := NewClient(&config.Config{
				APIURL:      server.URL,
				Username:    "audit@example.com",
				Password:    "not-a-real-password",
				SessionFile: file,
			})
			session, err := client.Authenticate()
			if session != nil {
				t.Fatal("Authenticate() returned a session after an app-version rejection")
			}
			requireAppVersionError(t, err, CodeAppVersionBad)
			if got := rejected.Load(); got != 1 {
				t.Fatalf("%s requests = %d; want 1", tt.path, got)
			}
			if got := unexpected.Load(); got != 0 {
				t.Fatalf("other requests = %d; want no password re-authentication", got)
			}
			loaded, _, loadErr := NewSessionStore(file).Load("audit@example.com")
			if loadErr != nil || loaded == nil || !sameSession(loaded, saved) {
				t.Fatalf("saved session after the rejection = %#v, %v; want it kept unchanged", loaded, loadErr)
			}
		})
	}
}

func TestCheckSessionKeepsSavedSessionWhenAppVersionIsRejected(t *testing.T) {
	file := filepath.Join(t.TempDir(), "proton-session.json")
	saved := auditSession("access-kept", "refresh-kept", 30*24*60*60)
	if err := NewSessionStore(file).Save(saved, "audit@example.com", 30*24*time.Hour); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	server := appVersionServer(t, http.StatusUnprocessableEntity, CodeAppVersionBad)

	client := NewClient(&config.Config{APIURL: server.URL, Username: "audit@example.com", SessionFile: file})
	session, _, err := client.CheckSession()
	if session != nil {
		t.Fatal("CheckSession() returned a session after an app-version rejection")
	}
	requireAppVersionError(t, err, CodeAppVersionBad)
	loaded, _, loadErr := NewSessionStore(file).Load("audit@example.com")
	if loadErr != nil || loaded == nil || !sameSession(loaded, saved) {
		t.Fatalf("saved session after the rejection = %#v, %v; want it kept unchanged", loaded, loadErr)
	}
}
