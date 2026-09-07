package config

import (
	"reflect"
	"testing"
)

func TestLoadDefaults(t *testing.T) {
	t.Setenv("API_TOKEN", "app-secret")
	t.Setenv("GITHUB_TOKEN", "gh-secret")
	t.Setenv("GITHUB_WEBHOOK_SECRET", "webhook-secret")
	t.Setenv("ISSUE_LABELS", "") // forca o default

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.GitHubRepo != "bezumiya/GoLiveBypass" {
		t.Errorf("GitHubRepo = %q, want bezumiya/GoLiveBypass", cfg.GitHubRepo)
	}
	if cfg.GitHubWebhookSecret != "webhook-secret" {
		t.Errorf("GitHubWebhookSecret = %q, want webhook-secret", cfg.GitHubWebhookSecret)
	}
	if cfg.Port != "8080" {
		t.Errorf("Port = %q, want 8080", cfg.Port)
	}
	if cfg.RateLimitPerMin != 10 {
		t.Errorf("RateLimitPerMin = %v, want 10 (agressivo)", cfg.RateLimitPerMin)
	}
	if cfg.BlockSeconds != 300 {
		t.Errorf("BlockSeconds = %d, want 300", cfg.BlockSeconds)
	}
	if cfg.MaxLogBytes != 262144 {
		t.Errorf("MaxLogBytes = %d, want 262144", cfg.MaxLogBytes)
	}
	if !reflect.DeepEqual(cfg.Labels, []string{"bug", "gui"}) {
		t.Errorf("Labels = %v, want [bug gui]", cfg.Labels)
	}
}

func TestLoadMissingAPIToken(t *testing.T) {
	t.Setenv("API_TOKEN", "")
	t.Setenv("GITHUB_TOKEN", "gh-secret")
	t.Setenv("GITHUB_WEBHOOK_SECRET", "webhook-secret")

	if _, err := Load(); err == nil {
		t.Fatal("Load() esperava erro com API_TOKEN ausente")
	}
}

func TestLoadMissingGitHubToken(t *testing.T) {
	t.Setenv("API_TOKEN", "app-secret")
	t.Setenv("GITHUB_TOKEN", "")
	t.Setenv("GITHUB_WEBHOOK_SECRET", "webhook-secret")

	if _, err := Load(); err == nil {
		t.Fatal("Load() esperava erro com GITHUB_TOKEN ausente")
	}
}

func TestLoadMissingWebhookSecret(t *testing.T) {
	t.Setenv("API_TOKEN", "app-secret")
	t.Setenv("GITHUB_TOKEN", "gh-secret")
	t.Setenv("GITHUB_WEBHOOK_SECRET", "")

	if _, err := Load(); err == nil {
		t.Fatal("Load() esperava erro com GITHUB_WEBHOOK_SECRET ausente")
	}
}

func TestLoadInvalidRepo(t *testing.T) {
	t.Setenv("API_TOKEN", "app-secret")
	t.Setenv("GITHUB_TOKEN", "gh-secret")
	t.Setenv("GITHUB_WEBHOOK_SECRET", "webhook-secret")
	t.Setenv("GITHUB_REPO", "sem-barra")

	if _, err := Load(); err == nil {
		t.Fatal("Load() esperava erro com GITHUB_REPO invalido")
	}
}

func TestLoadOverrides(t *testing.T) {
	t.Setenv("API_TOKEN", "app-secret")
	t.Setenv("GITHUB_TOKEN", "gh-secret")
	t.Setenv("GITHUB_WEBHOOK_SECRET", "webhook-secret")
	t.Setenv("GITHUB_REPO", "pdl-clay/GoLiveBypass")
	t.Setenv("ISSUE_LABELS", "bug, triage , ")
	t.Setenv("RATE_LIMIT", "120")
	t.Setenv("BLOCK_SECONDS", "60")
	t.Setenv("PORT", "9090")
	t.Setenv("MAX_LOG_BYTES", "1000")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.GitHubRepo != "pdl-clay/GoLiveBypass" {
		t.Errorf("GitHubRepo = %q", cfg.GitHubRepo)
	}
	if cfg.GitHubWebhookSecret != "webhook-secret" {
		t.Errorf("GitHubWebhookSecret = %q", cfg.GitHubWebhookSecret)
	}
	if !reflect.DeepEqual(cfg.Labels, []string{"bug", "triage"}) {
		t.Errorf("Labels = %v", cfg.Labels)
	}
	if cfg.RateLimitPerMin != 120 {
		t.Errorf("RateLimitPerMin = %v, want 120", cfg.RateLimitPerMin)
	}
	if cfg.BlockSeconds != 60 {
		t.Errorf("BlockSeconds = %d, want 60", cfg.BlockSeconds)
	}
	if cfg.Port != "9090" {
		t.Errorf("Port = %q, want 9090", cfg.Port)
	}
	if cfg.MaxLogBytes != 1000 {
		t.Errorf("MaxLogBytes = %d, want 1000", cfg.MaxLogBytes)
	}
}

func TestLoadEmptyLabelsFallsBackToBugGui(t *testing.T) {
	t.Setenv("API_TOKEN", "app-secret")
	t.Setenv("GITHUB_TOKEN", "gh-secret")
	t.Setenv("GITHUB_WEBHOOK_SECRET", "webhook-secret")
	t.Setenv("ISSUE_LABELS", "")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if !reflect.DeepEqual(cfg.Labels, []string{"bug", "gui"}) {
		t.Errorf("Labels = %v, want [bug gui]", cfg.Labels)
	}
}

func TestLoadBasePath(t *testing.T) {
	t.Setenv("API_TOKEN", "app-secret")
	t.Setenv("GITHUB_TOKEN", "gh-secret")
	t.Setenv("GITHUB_WEBHOOK_SECRET", "webhook-secret")

	tests := []struct {
		name string
		in   string
		want string
	}{
		{"vazio usa default sem prefixo", "", ""},
		{"simples", "bugs", "bugs"},
		{"com barras nas bordas", "/bugs/", "bugs"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("BASE_PATH", tt.in)
			cfg, err := Load()
			if err != nil {
				t.Fatalf("Load() error = %v", err)
			}
			if cfg.BasePath != tt.want {
				t.Errorf("BasePath = %q, want %q", cfg.BasePath, tt.want)
			}
		})
	}
}

func TestLoadInvalidBasePath(t *testing.T) {
	t.Setenv("API_TOKEN", "app-secret")
	t.Setenv("GITHUB_TOKEN", "gh-secret")
	t.Setenv("GITHUB_WEBHOOK_SECRET", "webhook-secret")
	t.Setenv("BASE_PATH", "nao/valido")

	if _, err := Load(); err == nil {
		t.Fatal("Load() esperava erro com BASE_PATH invalida")
	}
}
