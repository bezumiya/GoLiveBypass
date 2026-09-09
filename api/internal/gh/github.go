package gh

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const (
	apiBase        = "https://api.github.com"
	apiAccept      = "application/vnd.github+json"
	apiVersion     = "2022-11-28"
	requestTimeout = 10 * time.Second
)

type Client struct {
	baseURL string
	token   string
	repo    string
	http    *http.Client
}

func New(token, repo string) *Client {
	return &Client{
		baseURL: apiBase,
		token:   token,
		repo:    repo,
		http:    &http.Client{Timeout: requestTimeout},
	}
}

type Issue struct {
	Title  string   `json:"title"`
	Body   string   `json:"body"`
	Labels []string `json:"labels,omitempty"`
}

type Release struct {
	TagName     string         `json:"tag_name"`
	Name        string         `json:"name"`
	Draft       bool           `json:"draft"`
	Prerelease  bool           `json:"prerelease"`
	PublishedAt string         `json:"published_at"`
	HTMLURL     string         `json:"html_url"`
	Assets      []ReleaseAsset `json:"assets"`
}

type ReleaseAsset struct {
	Name               string `json:"name"`
	BrowserDownloadURL string `json:"browser_download_url"`
}

func (c *Client) LatestStableRelease(ctx context.Context) (Release, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/repos/"+c.repo+"/releases/latest", nil)
	if err != nil {
		return Release{}, fmt.Errorf("montando requisicao de release: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Accept", apiAccept)
	req.Header.Set("X-GitHub-Api-Version", apiVersion)
	req.Header.Set("User-Agent", "GoLiveBypass-release-catalog")

	resp, err := c.http.Do(req)
	if err != nil {
		return Release{}, fmt.Errorf("consultando release no GitHub: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return Release{}, fmt.Errorf("GitHub respondeu %s ao consultar release: %s", resp.Status, strings.TrimSpace(string(body)))
	}

	var release Release
	if err := json.Unmarshal(body, &release); err != nil {
		return Release{}, fmt.Errorf("decodificando release (%s): %w", resp.Status, err)
	}
	return release, nil
}

// VerifyLabels confere no boot que cada label de ISSUE_LABELS existe no repo alvo.
// Sem isso, o primeiro report real devolveria 422 do GitHub e o usuario acharia
// que a API quebrou. Erro de auth/rede tambem falha: melhor abortar o boot do que
// aceitar requests enquanto a criacao de issues esta garantidamente quebrada.
func (c *Client) VerifyLabels(ctx context.Context, labels []string) error {
	if len(labels) == 0 {
		return nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/repos/"+c.repo+"/labels", nil)
	if err != nil {
		return fmt.Errorf("montando requisicao: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Accept", apiAccept)
	req.Header.Set("X-GitHub-Api-Version", apiVersion)
	req.Header.Set("User-Agent", "GoLiveBypass-bugreport-api")

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("conferindo labels no GitHub: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))

	switch resp.StatusCode {
	case http.StatusOK:
		var got []struct {
			Name string `json:"name"`
		}
		if err := json.Unmarshal(body, &got); err != nil {
			return fmt.Errorf("decodificando labels (%s): %w", resp.Status, err)
		}
		have := make(map[string]bool, len(got))
		for _, l := range got {
			have[l.Name] = true
		}
		for _, want := range labels {
			if !have[want] {
				return fmt.Errorf("a label %q nao existe no repo %s — crie-a em Settings → Labels antes de subir", want, c.repo)
			}
		}
		return nil
	case http.StatusUnauthorized, http.StatusForbidden:
		return fmt.Errorf("autenticacao no GitHub falhou (%s): %s", resp.Status, strings.TrimSpace(string(body)))
	default:
		return fmt.Errorf("GitHub respondeu %s ao conferir labels: %s", resp.Status, strings.TrimSpace(string(body)))
	}
}

type IssueResult struct {
	Number int    `json:"number"`
	URL    string `json:"html_url"`
}

func (c *Client) CreateIssue(ctx context.Context, iss Issue) (IssueResult, error) {
	payload, err := json.Marshal(iss)
	if err != nil {
		return IssueResult{}, fmt.Errorf("serializando issue: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/repos/"+c.repo+"/issues", bytes.NewReader(payload))
	if err != nil {
		return IssueResult{}, fmt.Errorf("montando requisicao: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Accept", apiAccept)
	req.Header.Set("X-GitHub-Api-Version", apiVersion)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "GoLiveBypass-bugreport-api")

	resp, err := c.http.Do(req)
	if err != nil {
		return IssueResult{}, fmt.Errorf("chamando a API do GitHub: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))

	switch resp.StatusCode {
	case http.StatusCreated:
		var res IssueResult
		if err := json.Unmarshal(body, &res); err != nil {
			return IssueResult{}, fmt.Errorf("decodificando resposta (%s): %w", resp.Status, err)
		}
		return res, nil
	case http.StatusUnauthorized, http.StatusForbidden:
		return IssueResult{}, fmt.Errorf("autenticacao no GitHub falhou (%s): %s", resp.Status, strings.TrimSpace(string(body)))
	case http.StatusUnprocessableEntity:
		return IssueResult{}, fmt.Errorf("GitHub rejeitou a issue (%s) — confira se as labels existem no repo %s: %s", resp.Status, c.repo, strings.TrimSpace(string(body)))
	default:
		return IssueResult{}, fmt.Errorf("GitHub respondeu %s: %s", resp.Status, strings.TrimSpace(string(body)))
	}
}
