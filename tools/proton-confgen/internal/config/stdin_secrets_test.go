package config

import (
	"strings"
	"testing"
)

func TestReadStdinSecrets(t *testing.T) {
	cfg := &Config{StdinSecrets: true}
	input := `{"password":"p a s s","twoFactorCode":"123456","humanVerificationToken":"challenge:answer"}`
	if err := readStdinSecrets(strings.NewReader(input), cfg); err != nil {
		t.Fatalf("readStdinSecrets() error = %v", err)
	}
	if cfg.Password != "p a s s" || cfg.TwoFactorCode != "123456" || cfg.HVToken != "challenge:answer" {
		t.Fatalf("secrets were not populated correctly: %+v", cfg)
	}
}

func TestReadStdinSecretsRejectsMalformedInputWithoutEchoingIt(t *testing.T) {
	cfg := &Config{StdinSecrets: true}
	err := readStdinSecrets(strings.NewReader(`{"password":"super-secret`), cfg)
	if err == nil {
		t.Fatal("expected malformed input to fail")
	}
	if strings.Contains(err.Error(), "super-secret") {
		t.Fatalf("error echoed a secret: %v", err)
	}
}

func TestReadStdinSecretsRequiresPassword(t *testing.T) {
	cfg := &Config{StdinSecrets: true}
	if err := readStdinSecrets(strings.NewReader(`{"twoFactorCode":"123456"}`), cfg); err == nil {
		t.Fatal("expected missing password to fail")
	}
}
