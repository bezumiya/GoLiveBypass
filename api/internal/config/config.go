package config

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
)

type Config struct {
	APIToken            string
	GitHubToken         string
	GitHubWebhookSecret string
	GitHubRepo          string
	Labels              []string
	Port                string
	BasePath            string
	// Rate limit agressivo por IP: quantos requests cabem na janela de 1min.
	// Estourar a janela bloqueia o IP por BlockSeconds.
	RateLimitPerMin float64
	BlockSeconds    int
	MaxLogBytes     int64
	LogLevel        string
}

func Load() (*Config, error) {
	cfg := &Config{
		GitHubRepo:      getenv("GITHUB_REPO", "pdl-clay/GoLiveBypass"),
		Port:            getenv("PORT", "8080"),
		RateLimitPerMin: getenvFloat("RATE_LIMIT", 10),
		BlockSeconds:    getenvInt("BLOCK_SECONDS", 300),
		MaxLogBytes:     getenvInt64("MAX_LOG_BYTES", 262144),
		LogLevel:        getenv("LOG_LEVEL", "info"),
	}

	cfg.APIToken = os.Getenv("API_TOKEN")
	if cfg.APIToken == "" {
		return nil, errors.New("API_TOKEN e obrigatoria")
	}
	cfg.GitHubToken = os.Getenv("GITHUB_TOKEN")
	if cfg.GitHubToken == "" {
		return nil, errors.New("GITHUB_TOKEN e obrigatoria")
	}
	cfg.GitHubWebhookSecret = os.Getenv("GITHUB_WEBHOOK_SECRET")
	if cfg.GitHubWebhookSecret == "" {
		return nil, errors.New("GITHUB_WEBHOOK_SECRET e obrigatoria")
	}
	if !strings.Contains(cfg.GitHubRepo, "/") {
		return nil, fmt.Errorf("GITHUB_REPO deve estar no formato owner/repo (recebido %q)", cfg.GitHubRepo)
	}
	cfg.Labels = splitCSV(getenv("ISSUE_LABELS", "bug,gui"))

	cfg.BasePath = strings.Trim(getenv("BASE_PATH", ""), "/")
	if cfg.BasePath != "" && !isValidBasePath(cfg.BasePath) {
		return nil, fmt.Errorf("BASE_PATH invalida: %q (use um segmento de path, ex.: bugs)", cfg.BasePath)
	}
	return cfg, nil
}

func isValidBasePath(s string) bool {
	if len(s) > 64 {
		return false
	}
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
		default:
			return false
		}
	}
	return true
}

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func getenvInt64(key string, def int64) int64 {
	v, err := strconv.ParseInt(os.Getenv(key), 10, 64)
	if err != nil {
		return def
	}
	return v
}

func getenvInt(key string, def int) int {
	v, err := strconv.Atoi(os.Getenv(key))
	if err != nil {
		return def
	}
	return v
}

func getenvFloat(key string, def float64) float64 {
	v, err := strconv.ParseFloat(os.Getenv(key), 64)
	if err != nil || v <= 0 {
		return def
	}
	return v
}

func splitCSV(s string) []string {
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if t := strings.TrimSpace(p); t != "" {
			out = append(out, t)
		}
	}
	return out
}
