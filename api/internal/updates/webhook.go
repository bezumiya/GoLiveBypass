package updates

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
)

var ErrIgnoredEvent = errors.New("evento de release ignorado")

var releaseTagPattern = regexp.MustCompile(`^v?[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$`)

// VerifySignature valida o corpo bruto recebido do GitHub. O prefixo faz
// parte do formato X-Hub-Signature-256.
func VerifySignature(body []byte, header, secret string) bool {
	if secret == "" || !strings.HasPrefix(header, "sha256=") {
		return false
	}
	digest, err := hex.DecodeString(strings.TrimPrefix(header, "sha256="))
	if err != nil || len(digest) != sha256.Size {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write(body)
	return hmac.Equal(digest, mac.Sum(nil))
}

type githubReleasePayload struct {
	Action     string `json:"action"`
	Repository struct {
		FullName string `json:"full_name"`
	} `json:"repository"`
	Release struct {
		TagName     string `json:"tag_name"`
		Draft       bool   `json:"draft"`
		Prerelease  bool   `json:"prerelease"`
		PublishedAt string `json:"published_at"`
	} `json:"release"`
}

func ParsePublishedRelease(body []byte, expectedRepo string) (ReleaseEvent, error) {
	var payload githubReleasePayload
	if err := json.Unmarshal(body, &payload); err != nil {
		return ReleaseEvent{}, err
	}
	if payload.Action != "published" || payload.Release.Draft {
		return ReleaseEvent{}, ErrIgnoredEvent
	}
	if expectedRepo == "" || !strings.EqualFold(payload.Repository.FullName, expectedRepo) {
		return ReleaseEvent{}, ErrIgnoredEvent
	}
	if !releaseTagPattern.MatchString(payload.Release.TagName) {
		return ReleaseEvent{}, ErrIgnoredEvent
	}
	return ReleaseEvent{
		Tag:         payload.Release.TagName,
		Prerelease:  payload.Release.Prerelease,
		PublishedAt: payload.Release.PublishedAt,
	}, nil
}
