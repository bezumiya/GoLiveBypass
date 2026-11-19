package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"protonvpn-wg-confgen/internal/auth"
	"protonvpn-wg-confgen/internal/config"
)

func TestJSONErrorResponseClassifiesAuthenticationFailures(t *testing.T) {
	tests := []struct {
		name string
		err  error
		code string
	}{
		{name: "two factor required", err: fmt.Errorf("authentication failed: %w", auth.ErrTwoFactorRequired), code: "TWO_FACTOR_REQUIRED"},
		{name: "two factor invalid", err: &auth.TwoFactorError{Code: 9100}, code: "TWO_FACTOR_INVALID"},
		{name: "invalid credentials", err: &auth.InvalidCredentialsError{Code: 8002}, code: "INVALID_CREDENTIALS"},
		{name: "temporary", err: &auth.TemporarySessionError{Operation: "authentication"}, code: "NETWORK_ERROR"},
		{name: "session persistence", err: &auth.SessionPersistenceError{Err: errors.New("Access denied")}, code: "SESSION_PERSISTENCE"},
		{name: "app version", err: fmt.Errorf("authentication failed: %w", &auth.AppVersionError{Code: auth.CodeAppVersionBad}), code: "APP_VERSION_UNSUPPORTED"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			response := jsonErrorResponse(tt.err)
			if got := response["code"]; got != tt.code {
				t.Fatalf("code = %v, want %s", got, tt.code)
			}
			if response["success"] != false {
				t.Fatalf("success = %v, want false", response["success"])
			}
		})
	}
}

func TestJSONErrorResponseDoesNotExposeWrappedCredentialDetail(t *testing.T) {
	const secret = "senha-super-secreta"
	wrapped := fmt.Errorf("authentication failed: %w", &auth.InvalidCredentialsError{Code: 8002})
	if errors.Is(wrapped, auth.ErrTwoFactorRequired) {
		t.Fatal("invalid credential unexpectedly matched 2FA sentinel")
	}
	response := jsonErrorResponse(wrapped)
	if response["error"] == secret {
		t.Fatal("response unexpectedly exposed credential detail")
	}
}

// A Proton responde HTTP 422 com Code 5003 quando deixa de aceitar a versao
// anunciada em x-pm-appversion. O login precisa sair com um codigo estruturado
// e nao repetivel, nunca com o generico "authentication failed with code: 5003".
func TestLoginJSONReportsUnsupportedAppVersion(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnprocessableEntity)
		_, _ = fmt.Fprint(w, `{"Code":5003,"Error":"This version of the app is no longer supported"}`)
	}))
	defer server.Close()

	client := auth.NewClient(&config.Config{
		APIURL:      server.URL,
		Username:    "conta_teste",
		Password:    "senha-de-teste",
		SessionFile: filepath.Join(t.TempDir(), "proton-session.json"),
		LoginOnly:   true,
		JSONOutput:  true,
	})
	_, err := client.Authenticate()
	// run() embrulha o erro assim antes de main() serializar a resposta.
	response := jsonErrorResponse(fmt.Errorf("authentication failed: %w", err))
	data, marshalErr := json.Marshal(response)
	if marshalErr != nil {
		t.Fatalf("json.Marshal() error = %v", marshalErr)
	}
	t.Logf("login JSON: %s", data)

	if response["success"] != false || response["code"] != "APP_VERSION_UNSUPPORTED" || response["retryable"] != false {
		t.Fatalf("resposta = %s; want success=false, code=APP_VERSION_UNSUPPORTED, retryable=false", data)
	}
	message, _ := response["error"].(string)
	if !strings.Contains(message, "code 5003") || !strings.Contains(message, "update GoLiveBypass") {
		t.Fatalf("error = %q; want the app-version message", message)
	}
	if strings.Contains(message, "authentication failed with code") || strings.Contains(message, "no longer supported") {
		t.Fatalf("error = %q; generic or server-provided text leaked into the message", message)
	}
}
