package updates

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"
)

const (
	githubReleasePollInterval = 30 * time.Second
	githubReleaseRequestLimit = 1 << 20
)

type githubRelease struct {
	TagName     string `json:"tag_name"`
	Draft       bool   `json:"draft"`
	Prerelease  bool   `json:"prerelease"`
	PublishedAt string `json:"published_at"`
}

type httpDoer interface {
	Do(*http.Request) (*http.Response, error)
}

// ReleasePoller e uma redundancia para o webhook do GitHub. O webhook continua
// sendo o caminho imediato; o polling evita que uma falha de configuracao ou
// permissao do webhook deixe os clientes SSE sem pulso.
type ReleasePoller struct {
	token    string
	repo     string
	broker   *Broker
	client   httpDoer
	interval time.Duration
	logger   *slog.Logger
	lastKey  string
}

func NewReleasePoller(token, repo string, broker *Broker, logger *slog.Logger) *ReleasePoller {
	if logger == nil {
		logger = slog.Default()
	}
	return &ReleasePoller{
		token:    token,
		repo:     repo,
		broker:   broker,
		client:   &http.Client{Timeout: 10 * time.Second},
		interval: githubReleasePollInterval,
		logger:   logger,
	}
}

// Start faz uma leitura inicial para criar a linha de base sem acordar clientes
// para uma release antiga. As leituras seguintes publicam apenas releases novas.
func (p *ReleasePoller) Start(ctx context.Context) {
	go func() {
		if err := p.pollOnce(ctx); err != nil && ctx.Err() == nil {
			p.logger.Warn("polling inicial de release falhou", "err", err)
		}

		ticker := time.NewTicker(p.interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := p.pollOnce(ctx); err != nil && ctx.Err() == nil {
					p.logger.Warn("polling de release falhou", "err", err)
				}
			}
		}
	}()
}

// PollOnce fica exportado para a verificacao do caminho real sem esperar o
// intervalo de producao. O primeiro poll apenas estabelece a linha de base.
func (p *ReleasePoller) PollOnce(ctx context.Context) error {
	return p.pollOnce(ctx)
}

func (p *ReleasePoller) pollOnce(ctx context.Context) error {
	release, err := p.newestRelease(ctx)
	if err != nil {
		return err
	}
	key := release.TagName + "|" + release.PublishedAt
	if p.lastKey == "" {
		p.lastKey = key
		p.logger.Info("linha de base do polling de releases definida", "tag", release.TagName)
		return nil
	}
	if key == p.lastKey {
		return nil
	}
	p.lastKey = key

	event := ReleaseEvent{
		Tag:         release.TagName,
		Prerelease:  release.Prerelease,
		PublishedAt: release.PublishedAt,
	}
	deliveryID := "github-poll:" + key
	if p.broker.Publish(deliveryID, event) {
		p.logger.Info("release nova distribuida por polling", "tag", event.Tag, "prerelease", event.Prerelease)
	}
	return nil
}

func (p *ReleasePoller) newestRelease(ctx context.Context) (githubRelease, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.github.com/repos/"+p.repo+"/releases?per_page=20", nil)
	if err != nil {
		return githubRelease{}, fmt.Errorf("montando consulta de releases: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+p.token)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	req.Header.Set("User-Agent", "GoLiveBypass-update-api")

	resp, err := p.client.Do(req)
	if err != nil {
		return githubRelease{}, fmt.Errorf("consultando releases no GitHub: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, githubReleaseRequestLimit))
		return githubRelease{}, fmt.Errorf("GitHub respondeu %s: %s", resp.Status, string(body))
	}

	var releases []githubRelease
	if err := json.NewDecoder(io.LimitReader(resp.Body, githubReleaseRequestLimit)).Decode(&releases); err != nil {
		return githubRelease{}, fmt.Errorf("decodificando releases do GitHub: %w", err)
	}

	var newest githubRelease
	for _, release := range releases {
		if release.Draft || release.PublishedAt == "" || !releaseTagPattern.MatchString(release.TagName) {
			continue
		}
		if _, valid := CompareReleaseTags(release.TagName, release.TagName); !valid {
			continue
		}
		if newest.PublishedAt == "" {
			newest = release
			continue
		}
		comparison, valid := CompareReleaseTags(release.TagName, newest.TagName)
		if !valid {
			continue
		}
		if comparison > 0 || (comparison == 0 && release.PublishedAt > newest.PublishedAt) {
			newest = release
		}
	}
	if newest.PublishedAt == "" {
		return githubRelease{}, fmt.Errorf("nenhuma release publicada valida em %s", p.repo)
	}
	return newest, nil
}
