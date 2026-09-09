package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/labstack/echo/v5"

	"github.com/bezumiya/GoLiveBypass/api/internal/config"
	"github.com/bezumiya/GoLiveBypass/api/internal/gh"
	"github.com/bezumiya/GoLiveBypass/api/internal/server"
	"github.com/bezumiya/GoLiveBypass/api/internal/updates"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		slog.Error("configuracao invalida", "err", err)
		os.Exit(1)
	}

	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: parseLevel(cfg.LogLevel)}))
	slog.SetDefault(logger)

	client := gh.New(cfg.GitHubToken, cfg.GitHubRepo)
	// Fail-fast no boot: se as labels de ISSUE_LABELS nao existem no repo alvo (ex.:
	// deploy novo com repo trocado), aborta com mensagem clara em vez de responder
	// 422 no primeiro report real. Erro de auth/rede tambem falha o boot.
	checkCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	err = client.VerifyLabels(checkCtx, cfg.Labels)
	cancel()
	if err != nil {
		logger.Error("labels do repo alvo nao conferem — abortando (crie as labels antes de subir)", "err", err, "repo", cfg.GitHubRepo)
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	broker := updates.NewBroker()
	e := server.NewWithBroker(cfg, client, logger, broker, client)
	updates.NewReleasePoller(cfg.GitHubToken, cfg.GitHubRepo, broker, logger).Start(ctx)

	sc := echo.StartConfig{
		Address:         ":" + cfg.Port,
		HideBanner:      true,
		HidePort:        true,
		GracefulTimeout: 10 * time.Second,
		OnShutdownError: func(err error) { logger.Error("falha no desligamento", "err", err) },
		BeforeServeFunc: func(s *http.Server) error {
			s.ReadHeaderTimeout = 5 * time.Second
			s.IdleTimeout = 60 * time.Second
			return nil
		},
	}

	logger.Info("API de bug reports e pulso de releases no ar", "addr", sc.Address, "repo", cfg.GitHubRepo)
	if err := sc.Start(ctx, e); err != nil && !errors.Is(err, http.ErrServerClosed) {
		logger.Error("servidor encerrado com erro", "err", err)
		os.Exit(1)
	}
	logger.Info("servidor desligado")
}

func parseLevel(s string) slog.Level {
	switch s {
	case "debug":
		return slog.LevelDebug
	case "warn":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}
