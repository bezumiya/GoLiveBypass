package auth

import (
	"context"
	"encoding/json"
	"errors"
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

const syntheticResponseMarker = "synthetic-response-marker"

func TestAuthenticationRejectsCredentialsWithoutEchoingServerDetail(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(w, `{"Code":%d,"Error":%q}`, CodeWrongPassword, syntheticResponseMarker)
	}))
	defer server.Close()

	client := NewClient(&config.Config{APIURL: server.URL})
	_, err := client.sendAuthRequest(map[string]any{usernameField: "synthetic-user"})
	if !IsInvalidCredentials(err) {
		t.Fatalf("sendAuthRequest() error = %T %v; want invalid-credentials error", err, err)
	}
	if IsTemporarySessionError(err) || strings.Contains(err.Error(), syntheticResponseMarker) {
		t.Fatalf("credential error leaked detail or was classified temporary: %v", err)
	}
}

func TestAuthenticationTreatsTemporaryHTTPAsRetryableWithoutEchoingBody(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = fmt.Fprint(w, syntheticResponseMarker)
	}))
	defer server.Close()

	client := NewClient(&config.Config{APIURL: server.URL})
	_, err := client.sendAuthRequest(map[string]any{usernameField: "synthetic-user"})
	if !IsTemporarySessionError(err) {
		t.Fatalf("sendAuthRequest() error = %T %v; want temporary error", err, err)
	}
	if strings.Contains(err.Error(), syntheticResponseMarker) {
		t.Fatalf("temporary error echoed an untrusted response body: %v", err)
	}
}

func TestTemporaryErrorStringDoesNotExposeWrappedDetail(t *testing.T) {
	wrapped := errors.New(syntheticResponseMarker)
	err := &TemporarySessionError{Err: wrapped, Operation: "authentication"}
	if strings.Contains(err.Error(), syntheticResponseMarker) {
		t.Fatalf("TemporarySessionError.Error() exposed wrapped detail: %q", err.Error())
	}
	if !errors.Is(err, wrapped) {
		t.Fatal("TemporarySessionError lost its unwrap target")
	}
}

func TestTransportDeadlineClassificationDistinguishesCallerAndClientTimeout(t *testing.T) {
	callerCtx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()
	if err := classifyAuthTransportError(callerCtx, context.DeadlineExceeded); !errors.Is(err, context.DeadlineExceeded) || IsTemporarySessionError(err) {
		t.Fatalf("caller deadline = %T %v; want cancellation, not temporary network failure", err, err)
	}

	if err := classifyAuthTransportError(context.Background(), context.DeadlineExceeded); !IsTemporarySessionError(err) {
		t.Fatalf("client timeout = %T %v; want retryable temporary network failure", err, err)
	}
}

func TestTwoFactorFailureDoesNotEchoServerDetail(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(w, `{"Code":%d,"Error":%q}`, CodeWrongPassword, syntheticResponseMarker)
	}))
	defer server.Close()

	client := NewClient(&config.Config{APIURL: server.URL})
	_, err := client.submit2FA(&api.Session{AccessToken: "synthetic-access", UID: "synthetic-uid"}, "123456")
	if !IsTwoFactorError(err) {
		t.Fatalf("submit2FA() error = %T %v; want 2FA error", err, err)
	}
	if strings.Contains(err.Error(), syntheticResponseMarker) {
		t.Fatalf("2FA error echoed an untrusted response body: %v", err)
	}
}

func TestRefreshRejectionIsTypedAndDoesNotEchoServerDetail(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(w, `{"Code":%d,"Error":%q}`, CodeMailboxPasswordError, syntheticResponseMarker)
	}))
	defer server.Close()

	_, err := RefreshSession(server.Client(), server.URL, auditSession("synthetic-access", "synthetic-refresh", 3600))
	if !IsSessionInvalid(err) {
		t.Fatalf("RefreshSession() error = %T %v; want typed session-invalid error", err, err)
	}
	if IsTemporarySessionError(err) || strings.Contains(err.Error(), syntheticResponseMarker) {
		t.Fatalf("refresh rejection was misclassified or leaked detail: %v", err)
	}
}

func TestRefreshHTTPRejectionIsTypedEvenWithoutJSONBody(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = fmt.Fprint(w, syntheticResponseMarker)
	}))
	defer server.Close()

	_, err := RefreshSession(server.Client(), server.URL, auditSession("synthetic-access", "synthetic-refresh", 3600))
	if !IsSessionInvalid(err) {
		t.Fatalf("RefreshSession() error = %T %v; want session-invalid error", err, err)
	}
	if strings.Contains(err.Error(), syntheticResponseMarker) {
		t.Fatalf("HTTP rejection echoed an untrusted response body: %v", err)
	}
}

func TestMalformedRefreshResponseDoesNotDeleteCachedSession(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "proton-session.json")
	old := auditSession("synthetic-access", "synthetic-refresh", 3600)
	if err := NewSessionStore(file).Save(old, "synthetic-user", time.Hour); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, `{"Code":1000}`)
	}))
	defer server.Close()

	client := NewClient(&config.Config{
		APIURL:       server.URL,
		Username:     "synthetic-user",
		SessionFile:  file,
		ForceRefresh: true,
	})
	var protocolErr *ProtocolError
	if _, err := client.tryExistingSession(); !errors.As(err, &protocolErr) {
		t.Fatalf("tryExistingSession() error = %T %v; want protocol error", err, err)
	}
	if _, statErr := os.Stat(file); statErr != nil {
		t.Fatalf("malformed refresh response deleted cached session: %v", statErr)
	}
}

func TestRefreshWithMissingRefreshCredentialDoesNotDeleteCache(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "proton-session.json")
	if err := NewSessionStore(file).Save(auditSession("synthetic-access", "synthetic-refresh", 3600), "synthetic-user", time.Hour); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	client := NewClient(&config.Config{
		APIURL:       "http://127.0.0.1:1",
		Username:     "synthetic-user",
		SessionFile:  file,
		ForceRefresh: true,
	})
	if _, err := client.handleSessionRefresh(&api.Session{AccessToken: "synthetic-access", UID: "synthetic-uid"}, "synthetic refresh"); err == nil || !strings.Contains(err.Error(), "invalid response") {
		t.Fatalf("handleSessionRefresh() error = %v; want protocol error", err)
	}
	if _, statErr := os.Stat(file); statErr != nil {
		t.Fatalf("missing refresh credential deleted cached session: %v", statErr)
	}
}

func TestTOTPValidationRejectsMalformedConfiguredCodes(t *testing.T) {
	for _, code := range []string{"", "12345", "1234567", "12345x"} {
		if normalized, err := validateTOTPCode(code); err == nil || normalized != "" {
			t.Fatalf("validateTOTPCode(%q) = %q, %v; want rejection", code, normalized, err)
		}
	}
	if normalized, err := validateTOTPCode(" 123456\n"); err != nil || normalized != "123456" {
		t.Fatalf("validateTOTPCode(valid) = %q, %v", normalized, err)
	}
}

func TestExpiredSessionIsRemovedLocallyAndAccountSwitchDoesNotDeleteOtherAccount(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "proton-session.json")
	store := NewSessionStore(file)
	expired := SavedSession{
		Session:   auditSession("synthetic-expired", "synthetic-refresh", 3600),
		Username:  "synthetic-user",
		SavedAt:   time.Now().Add(-time.Hour),
		ExpiresAt: time.Now().Add(-time.Minute),
	}
	data, err := json.Marshal(expired)
	if err != nil {
		t.Fatalf("Marshal(expired) error = %v", err)
	}
	if err := os.WriteFile(file, data, 0o600); err != nil {
		t.Fatalf("WriteFile(expired) error = %v", err)
	}
	if session, _, err := store.Load("synthetic-user"); session != nil || err != nil {
		t.Fatalf("Load(expired) = %#v, %v; want no session", session, err)
	}
	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Fatalf("expired session was not removed; stat error = %v", err)
	}

	if err := store.Save(auditSession("synthetic-account-a", "synthetic-refresh", 3600), "account-a", time.Hour); err != nil {
		t.Fatalf("Save(account-a) error = %v", err)
	}
	if session, _, err := store.Load("account-b"); err != nil || session != nil {
		t.Fatalf("Load(account-b) = %#v, %v; account switch should not consume account-a cache", session, err)
	}
	if session, _, err := store.Load("account-a"); err != nil || session == nil {
		t.Fatalf("Load(account-a) = %#v, %v; original cache was deleted during account switch", session, err)
	}
}

func TestCanceledAuthenticationPreservesCachedSession(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "proton-session.json")
	if err := NewSessionStore(file).Save(auditSession("synthetic-access", "synthetic-refresh", 3600), "synthetic-user", time.Hour); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	started := make(chan struct{})
	released := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		select {
		case <-r.Context().Done():
		case <-released:
		}
	}))
	defer server.Close()
	defer close(released)

	client := NewClient(&config.Config{
		APIURL:      server.URL,
		Username:    "synthetic-user",
		Password:    "synthetic-password",
		SessionFile: file,
	})
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() {
		_, err := client.AuthenticateContext(ctx)
		result <- err
	}()

	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("session verification did not start")
	}
	cancel()
	err := <-result
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("AuthenticateContext() error = %T %v; want context.Canceled", err, err)
	}
	if IsInvalidCredentials(err) || IsSessionInvalid(err) {
		t.Fatalf("cancellation was misclassified as credential/session invalid: %v", err)
	}
	if _, statErr := os.Stat(file); statErr != nil {
		t.Fatalf("cached session was removed after cancellation: %v", statErr)
	}
}

func TestSessionStoreSerializesDifferentStoreInstances(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "proton-session.json")
	first := NewSessionStore(file)
	second := NewSessionStore(file)
	if err := first.Save(auditSession("synthetic-first", "synthetic-refresh", 3600), "synthetic-user", time.Hour); err != nil {
		t.Fatalf("initial Save() error = %v", err)
	}

	lock, err := acquireSessionFileLock(file + sessionLockSuffix)
	if err != nil {
		t.Fatalf("acquireSessionFileLock() error = %v", err)
	}
	done := make(chan error, 1)
	go func() {
		done <- second.Save(auditSession("synthetic-second", "synthetic-refresh", 3600), "synthetic-user", time.Hour)
	}()

	select {
	case err := <-done:
		_ = lock.release()
		t.Fatalf("concurrent Save() completed while lock was held: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	if err := lock.release(); err != nil {
		t.Fatalf("release session lock: %v", err)
	}
	if err := <-done; err != nil {
		t.Fatalf("serialized Save() error = %v", err)
	}
	loaded, _, err := first.Load("synthetic-user")
	if err != nil || loaded == nil || loaded.AccessToken != "synthetic-second" {
		t.Fatalf("Load() = %#v, %v; serialized replacement was not committed", loaded, err)
	}
}

func TestSessionStoreLockAcquisitionHonorsCancellation(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "proton-session.json")
	first := NewSessionStore(file)
	second := NewSessionStore(file)
	if err := first.Save(auditSession("synthetic-first", "synthetic-refresh", 3600), "synthetic-user", time.Hour); err != nil {
		t.Fatalf("initial Save() error = %v", err)
	}
	lock, err := acquireSessionFileLock(file + sessionLockSuffix)
	if err != nil {
		t.Fatalf("acquireSessionFileLock() error = %v", err)
	}
	defer lock.release()

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, _, err := second.LoadContext(ctx, "synthetic-user")
		done <- err
	}()
	select {
	case err := <-done:
		t.Fatalf("LoadContext() completed while lock was held: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("LoadContext() error = %v; want context.Canceled", err)
	}
}

func TestSupersededAuthenticationCannotCommitSession(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "proton-session.json")
	client := NewClient(&config.Config{
		SessionFile: file,
		Username:    "synthetic-user",
	})
	ctx, generation, finish, err := client.beginAuthentication(context.Background())
	if err != nil {
		t.Fatalf("beginAuthentication() error = %v", err)
	}
	defer finish()

	client.cancelActiveAuthentication()
	if err := client.saveSessionIfCurrent(ctx, generation, auditSession("synthetic-stale", "synthetic-refresh", 3600)); !errors.Is(err, context.Canceled) {
		t.Fatalf("saveSessionIfCurrent() error = %v; want context.Canceled", err)
	}
	if _, statErr := os.Stat(file); !os.IsNotExist(statErr) {
		t.Fatalf("superseded authentication wrote a session; stat error = %v", statErr)
	}
}

func TestLogoutCancelsGenerationBeforeRemovingCache(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "proton-session.json")
	store := NewSessionStore(file)
	if err := store.Save(auditSession("synthetic-current", "synthetic-refresh", 3600), "synthetic-user", time.Hour); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	client := NewClient(&config.Config{SessionFile: file, Username: "synthetic-user"})
	ctx, generation, finish, err := client.beginAuthentication(context.Background())
	if err != nil {
		t.Fatalf("beginAuthentication() error = %v", err)
	}
	defer finish()

	if err := client.Logout(); err != nil {
		t.Fatalf("Logout() error = %v", err)
	}
	if ctx.Err() != context.Canceled {
		t.Fatalf("operation context error = %v; want context.Canceled", ctx.Err())
	}
	if _, statErr := os.Stat(file); !os.IsNotExist(statErr) {
		t.Fatalf("Logout() left cached session behind; stat error = %v", statErr)
	}
	if err := client.saveSessionIfCurrent(ctx, generation, auditSession("synthetic-after-logout", "synthetic-refresh", 3600)); !errors.Is(err, context.Canceled) {
		t.Fatalf("stale save after Logout() error = %v; want context.Canceled", err)
	}
}
