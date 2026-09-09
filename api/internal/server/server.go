package server

import (
	"log/slog"
	"net/http"

	"github.com/labstack/echo/v5"
	"github.com/labstack/echo/v5/middleware"

	"github.com/bezumiya/GoLiveBypass/api/internal/config"
	"github.com/bezumiya/GoLiveBypass/api/internal/releases"
	"github.com/bezumiya/GoLiveBypass/api/internal/updates"
)

func New(cfg *config.Config, issues IssueCreator, logger *slog.Logger, releaseSource releases.Source) *echo.Echo {
	return NewWithBroker(cfg, issues, logger, updates.NewBroker(), releaseSource)
}

func NewWithBroker(cfg *config.Config, issues IssueCreator, logger *slog.Logger, broker *updates.Broker, releaseSources ...releases.Source) *echo.Echo {
	e := echo.NewWithConfig(echo.Config{NoGroupAutoRegister404Routes: true})
	e.Logger = logger
	e.HTTPErrorHandler = echo.DefaultHTTPErrorHandler(false)
	e.IPExtractor = echo.ExtractIPFromXFFHeader(echo.TrustLoopback(true), echo.TrustPrivateNet(true))

	e.Use(middleware.Recover())
	e.Use(middleware.RequestLogger())

	store := newBlockStore(cfg)
	var releaseCatalog *releases.CatalogCache
	if len(releaseSources) > 0 && releaseSources[0] != nil {
		releaseCatalog = releases.NewCatalogCache(releaseSources[0], releases.DefaultTTL)
	}
	h := &handler{cfg: cfg, issues: issues, store: store, updates: broker, releases: releaseCatalog}
	e.GET(cfg.BasePath+"/healthz", h.health)

	updateV1 := e.Group(cfg.BasePath + "/v1/updates")
	updateV1.POST("/github/webhook", h.githubWebhook, middleware.BodyLimit(1024*1024))
	updateV1.GET("/stream", h.updateStream)

	v1 := e.Group(cfg.BasePath+"/v1",
		authMiddleware(cfg.APIToken),
		rateLimitMiddleware(cfg, store),
		middleware.BodyLimit(512*1024),
	)
	v1.POST("/reports", h.createReport)

	// O status de bloqueio e a rota que a GUI consulta ANTES de tentar enviar —
	// nao pode ser bloqueado pelo proprio rate limit (senao nao da para saber
	// quando o bloqueio termina). Fica autenticado, sem rate limit.
	status := e.Group(cfg.BasePath+"/v1", authMiddleware(cfg.APIToken))
	status.GET("/block-status", h.blockStatus)

	releaseV1 := e.Group(cfg.BasePath+"/v1/releases",
		middleware.CORSWithConfig(middleware.CORSConfig{
			AllowOrigins: cfg.WebsiteOrigins,
			AllowMethods: []string{http.MethodGet, http.MethodOptions},
			AllowHeaders: []string{echo.HeaderOrigin, echo.HeaderAccept, echo.HeaderContentType},
			MaxAge:       300,
		}),
	)
	releaseV1.GET("/latest", h.latestRelease)
	releaseV1.GET("/latest/download/:asset", h.downloadRelease)

	return e
}
