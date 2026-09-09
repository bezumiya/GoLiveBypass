package auth

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"protonvpn-wg-confgen/internal/api"
	"protonvpn-wg-confgen/internal/config"
	"protonvpn-wg-confgen/internal/constants"
)

const usernameField = "Username"

// TestSendAuthRequestHumanVerification checks that -hv-token reaches the /auth
// request as the headers Proton expects, and is absent when unset.
func TestSendAuthRequestHumanVerification(t *testing.T) {
	tests := []struct {
		name      string
		hvToken   string
		wantToken string
		wantType  string
	}{
		{name: "unset"},
		{name: "set", hvToken: "TOKEN-XYZ", wantToken: "TOKEN-XYZ", wantType: "captcha"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var gotToken, gotType string
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				gotToken = r.Header.Get("x-pm-human-verification-token")
				gotType = r.Header.Get("x-pm-human-verification-token-type")
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"Code":1000,"AccessToken":"synthetic-access","UID":"synthetic-uid","ExpiresIn":3600}`))
			}))
			defer srv.Close()

			c := NewClient(&config.Config{APIURL: srv.URL, HVToken: tt.hvToken})
			if _, err := c.sendAuthRequest(map[string]any{usernameField: "u"}); err != nil {
				t.Fatalf("sendAuthRequest: %v", err)
			}

			if gotToken != tt.wantToken {
				t.Errorf("token header = %q, want %q", gotToken, tt.wantToken)
			}
			if gotType != tt.wantType {
				t.Errorf("token type header = %q, want %q", gotType, tt.wantType)
			}
		})
	}
}

// TestCaptchaError checks that a 9001 response is structured without leaking
// the challenge token into diagnostics.
func TestCaptchaError(t *testing.T) {
	session := &api.Session{Code: 9001}
	session.Details.HumanVerificationMethods = []string{constants.HVMethodCaptcha}
	session.Details.HumanVerificationToken = "tok-123"

	err := captchaError(session, "https://vpn-api.proton.me", false)
	hv, ok := err.(HumanVerificationError)
	if !ok {
		t.Fatalf("captcha error type = %T", err)
	}
	if hv.Code != "CAPTCHA_REQUIRED" || hv.CaptchaURL != "https://vpn-api.proton.me/core/v4/captcha?Token=tok-123" {
		t.Fatalf("unexpected challenge: %+v", hv)
	}
	if strings.Contains(hv.Message, "tok-123") {
		t.Fatal("challenge leaked into message")
	}

	// A resposta rejeitada traz um desafio novo; a GUI precisa dessa URL para
	// reabrir o CAPTCHA sem pedir que o usuário copie tokens manualmente.
	invalid := captchaError(session, "https://vpn-api.proton.me", true).(HumanVerificationError)
	if invalid.Code != "CAPTCHA_INVALID" || invalid.CaptchaURL == "" {
		t.Fatalf("invalid replay should offer a fresh challenge: %+v", invalid)
	}

	// With no token there is nothing to replay, so do not advertise the flag.
	bare := &api.Session{Code: 9001}
	if err := captchaError(bare, "https://vpn-api.proton.me", true); err.(HumanVerificationError).Code != "CAPTCHA_INVALID" {
		t.Fatal("replayed captcha should be invalid")
	}
}
