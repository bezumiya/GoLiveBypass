package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/labstack/echo/v5"

	"github.com/bezumiya/GoLiveBypass/api/internal/bugreport"
	"github.com/bezumiya/GoLiveBypass/api/internal/config"
	"github.com/bezumiya/GoLiveBypass/api/internal/gh"
	"github.com/bezumiya/GoLiveBypass/api/internal/releases"
	"github.com/bezumiya/GoLiveBypass/api/internal/updates"
)

type IssueCreator interface {
	CreateIssue(ctx context.Context, iss gh.Issue) (gh.IssueResult, error)
}

type handler struct {
	cfg      *config.Config
	issues   IssueCreator
	store    *blockStore
	updates  *updates.Broker
	releases *releases.CatalogCache
}

func (h *handler) createReport(c *echo.Context) error {
	var rep bugreport.Report
	if err := c.Bind(&rep); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "payload invalido")
	}
	if err := rep.Validate(h.cfg.MaxLogBytes); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, err.Error())
	}

	res, err := h.issues.CreateIssue(c.Request().Context(), gh.Issue{
		Title:  rep.Title,
		Body:   bugreport.BuildIssueBody(rep),
		Labels: h.cfg.Labels,
	})
	if err != nil {
		c.Logger().Error("falha ao criar issue no github", "err", err, "repo", h.cfg.GitHubRepo)
		return echo.NewHTTPError(http.StatusBadGateway, "falha ao criar a issue no GitHub")
	}

	return c.JSON(http.StatusCreated, map[string]any{
		"issue_number": res.Number,
		"issue_url":    res.URL,
	})
}

func (h *handler) blockStatus(c *echo.Context) error {
	blocked, retryAfter, remaining := h.store.blockStatus(c.RealIP())
	resp := map[string]any{"blocked": blocked}
	if blocked {
		resp["retry_after"] = retryAfter
	} else {
		resp["remaining"] = remaining
	}
	return c.JSON(http.StatusOK, resp)
}

func (h *handler) health(c *echo.Context) error {
	return c.JSON(http.StatusOK, map[string]string{"status": "ok"})
}

func (h *handler) latestRelease(c *echo.Context) error {
	if h.releases == nil {
		return echo.NewHTTPError(http.StatusServiceUnavailable, "catalogo de releases indisponivel")
	}
	catalog, err := h.releases.Latest(c.Request().Context())
	if err != nil {
		c.Logger().Error("falha ao atualizar catalogo de releases", "err", err, "repo", h.cfg.GitHubRepo)
		return echo.NewHTTPError(http.StatusBadGateway, "nao foi possivel consultar a release estavel")
	}
	return c.JSON(http.StatusOK, catalog)
}

func (h *handler) downloadRelease(c *echo.Context) error {
	if h.releases == nil {
		return echo.NewHTTPError(http.StatusServiceUnavailable, "catalogo de releases indisponivel")
	}
	asset := c.Param("asset")
	downloadURL, err := h.releases.Download(c.Request().Context(), asset)
	if err != nil {
		switch {
		case errors.Is(err, releases.ErrUnknownAsset), errors.Is(err, releases.ErrAssetUnavailable):
			return echo.NewHTTPError(http.StatusNotFound, "download indisponivel")
		default:
			c.Logger().Error("falha ao consultar asset da release", "err", err, "asset", asset)
			return echo.NewHTTPError(http.StatusBadGateway, "nao foi possivel consultar a release estavel")
		}
	}
	return c.Redirect(http.StatusFound, downloadURL)
}

func (h *handler) githubWebhook(c *echo.Context) error {
	body, err := io.ReadAll(io.LimitReader(c.Request().Body, 1024*1024+1))
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "payload invalido")
	}
	if len(body) > 1024*1024 {
		return echo.NewHTTPError(http.StatusRequestEntityTooLarge, "payload grande demais")
	}

	signature := c.Request().Header.Get("X-Hub-Signature-256")
	if !updates.VerifySignature(body, signature, h.cfg.GitHubWebhookSecret) {
		return echo.NewHTTPError(http.StatusUnauthorized, "assinatura invalida")
	}
	if c.Request().Header.Get("X-GitHub-Event") != "release" {
		return c.NoContent(http.StatusNoContent)
	}
	deliveryID := strings.TrimSpace(c.Request().Header.Get("X-GitHub-Delivery"))
	if deliveryID == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "delivery ausente")
	}
	event, err := updates.ParsePublishedRelease(body, h.cfg.GitHubRepo)
	if err != nil {
		if errors.Is(err, updates.ErrIgnoredEvent) {
			return c.NoContent(http.StatusNoContent)
		}
		return echo.NewHTTPError(http.StatusBadRequest, "payload de release invalido")
	}
	if !h.updates.Publish(deliveryID, event) {
		return c.NoContent(http.StatusNoContent)
	}
	if !event.Prerelease && h.releases != nil {
		h.releases.Invalidate()
	}
	c.Logger().Info("release publicada, clientes de update acordados", "tag", event.Tag, "prerelease", event.Prerelease)
	return c.NoContent(http.StatusAccepted)
}

func (h *handler) updateStream(c *echo.Context) error {
	subscription, latest, err := h.updates.Subscribe(c.RealIP())
	if err != nil {
		return echo.NewHTTPError(http.StatusTooManyRequests, "limite de conexoes de update excedido")
	}
	defer subscription.Close()

	writer := c.Response()
	writer.Header().Set("Content-Type", "text/event-stream")
	writer.Header().Set("Cache-Control", "no-cache, no-transform")
	writer.Header().Set("Connection", "keep-alive")
	writer.Header().Set("X-Accel-Buffering", "no")
	controller := http.NewResponseController(writer)
	// ResponseController.Flush chama o http.ResponseWriter subjacente e nao
	// atualiza Response.Committed no wrapper do Echo. Marcar o status antes do
	// flush evita que o primeiro Write do evento tente escrever os cabecalhos
	// uma segunda vez ("superfluous response.WriteHeader" no log do net/http).
	writer.WriteHeader(http.StatusOK)
	if err := controller.Flush(); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "stream de update indisponivel")
	}

	writeEvent := func(event updates.ReleaseEvent) error {
		data, err := json.Marshal(event)
		if err != nil {
			return err
		}
		id := strings.NewReplacer("\r", "", "\n", "").Replace(event.DeliveryID)
		if _, err := fmt.Fprintf(writer, "event: release\nid: %s\ndata: %s\n\n", id, data); err != nil {
			return err
		}
		return controller.Flush()
	}
	if latest != nil {
		if err := writeEvent(*latest); err != nil {
			return nil
		}
	}

	heartbeat := time.NewTicker(20 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case event := <-subscription.Events():
			if err := writeEvent(event); err != nil {
				return nil
			}
		case <-heartbeat.C:
			if _, err := io.WriteString(writer, ": heartbeat\n\n"); err != nil {
				return nil
			}
			if err := controller.Flush(); err != nil {
				return nil
			}
		case <-c.Request().Context().Done():
			return nil
		}
	}
}
