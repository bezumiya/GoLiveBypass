package updates

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"testing"
	"time"
)

type fakeReleaseHTTP struct {
	bodies [][]byte
	index  int
}

func (f *fakeReleaseHTTP) Do(_ *http.Request) (*http.Response, error) {
	body := f.bodies[f.index]
	if f.index < len(f.bodies)-1 {
		f.index++
	}
	return &http.Response{
		StatusCode: http.StatusOK,
		Status:     "200 OK",
		Body:       io.NopCloser(strings.NewReader(string(body))),
	}, nil
}

func TestReleasePollerEstablishesBaselineAndPublishesNewRelease(t *testing.T) {
	broker := NewBroker()
	subscription, _, err := broker.Subscribe("203.0.113.20")
	if err != nil {
		t.Fatal(err)
	}
	defer subscription.Close()

	httpClient := &fakeReleaseHTTP{bodies: [][]byte{
		[]byte(`[{
			"tag_name":"v2.0.5-beta.6",
			"draft":false,
			"prerelease":true,
			"published_at":"2026-09-07T22:49:19Z"
		}]`),
		[]byte(`[{
			"tag_name":"v2.0.5-beta.7",
			"draft":false,
			"prerelease":true,
			"published_at":"2026-09-07T23:49:19Z"
		}]`),
	}}
	poller := NewReleasePoller("token", "owner/repo", broker, slog.New(slog.NewTextHandler(io.Discard, nil)))
	poller.client = httpClient

	if err := poller.PollOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	select {
	case event := <-subscription.Events():
		t.Fatalf("poll inicial publicou evento antigo: %+v", event)
	default:
	}

	if err := poller.PollOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	select {
	case event := <-subscription.Events():
		if event.Tag != "v2.0.5-beta.7" || !event.Prerelease || event.DeliveryID == "" {
			t.Fatalf("evento publicado = %+v", event)
		}
	case <-time.After(time.Second):
		t.Fatal("poll novo nao publicou evento")
	}
}

func TestBrokerDeduplicatesWebhookAndPollingForSameRelease(t *testing.T) {
	broker := NewBroker()
	subscription, _, err := broker.Subscribe("203.0.113.21")
	if err != nil {
		t.Fatal(err)
	}
	defer subscription.Close()

	event := ReleaseEvent{Tag: "v2.0.5-beta.7", Prerelease: true, PublishedAt: "2026-09-07T23:49:19Z"}
	if !broker.Publish("github-webhook-delivery", event) {
		t.Fatal("webhook nao foi publicado")
	}
	if broker.Publish("github-poll:v2.0.5-beta.7|2026-09-07T23:49:19Z", event) {
		t.Fatal("polling publicou novamente o mesmo release")
	}
	if got := <-subscription.Events(); got.DeliveryID != "github-webhook-delivery" {
		t.Fatalf("evento recebido = %+v", got)
	}
}
