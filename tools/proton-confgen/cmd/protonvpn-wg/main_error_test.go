package main

import (
	"errors"
	"fmt"
	"testing"

	"protonvpn-wg-confgen/internal/auth"
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
