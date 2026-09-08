package updates

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"testing"
)

func TestVerifySignature(t *testing.T) {
	secret := "segredo-webhook"
	body := []byte(`{"action":"published"}`)
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write(body)
	valid := "sha256=" + hex.EncodeToString(mac.Sum(nil))

	if !VerifySignature(body, valid, secret) {
		t.Fatal("assinatura valida foi recusada")
	}
	if VerifySignature(body, valid, "outro-segredo") {
		t.Fatal("assinatura com segredo diferente foi aceita")
	}
	if VerifySignature(body, "sha256=nao-hex", secret) {
		t.Fatal("assinatura malformada foi aceita")
	}
	if VerifySignature(body, "", secret) {
		t.Fatal("assinatura ausente foi aceita")
	}
}

func TestParsePublishedRelease(t *testing.T) {
	body := []byte(`{
        "action":"published",
        "repository":{"full_name":"pdl-clay/GoLiveBypass"},
        "release":{"tag_name":"v2.0.6","draft":false,"prerelease":false,"published_at":"2026-09-07T12:00:00Z"}
    }`)
	event, err := ParsePublishedRelease(body, "pdl-clay/GoLiveBypass")
	if err != nil {
		t.Fatalf("ParsePublishedRelease() error = %v", err)
	}
	if event.Tag != "v2.0.6" || event.Prerelease || event.PublishedAt == "" {
		t.Fatalf("evento = %+v", event)
	}

	ignored := []struct {
		name string
		body string
	}{
		{"acao diferente", `{"action":"edited","repository":{"full_name":"pdl-clay/GoLiveBypass"},"release":{"tag_name":"v2.0.6"}}`},
		{"draft", `{"action":"published","repository":{"full_name":"pdl-clay/GoLiveBypass"},"release":{"tag_name":"v2.0.6","draft":true}}`},
		{"repo diferente", `{"action":"published","repository":{"full_name":"outro/repo"},"release":{"tag_name":"v2.0.6"}}`},
		{"tag invalida", `{"action":"published","repository":{"full_name":"pdl-clay/GoLiveBypass"},"release":{"tag_name":"release/latest"}}`},
	}
	for _, tt := range ignored {
		t.Run(tt.name, func(t *testing.T) {
			_, err := ParsePublishedRelease([]byte(tt.body), "pdl-clay/GoLiveBypass")
			if err != ErrIgnoredEvent {
				t.Fatalf("erro = %v, want ErrIgnoredEvent", err)
			}
		})
	}
}

func TestBrokerPublishesAndReplaysLatest(t *testing.T) {
	broker := NewBroker()
	subscription, latest, err := broker.Subscribe("203.0.113.10")
	if err != nil || latest != nil {
		t.Fatalf("inscricao inicial = (%v, %v, %v)", subscription, latest, err)
	}
	defer subscription.Close()

	event := ReleaseEvent{Tag: "v2.0.6", PublishedAt: "agora"}
	if !broker.Publish("delivery-1", event) {
		t.Fatal("primeiro delivery foi ignorado")
	}
	got := <-subscription.Events()
	if got.DeliveryID != "delivery-1" || got.Tag != event.Tag {
		t.Fatalf("evento recebido = %+v", got)
	}

	second, replay, err := broker.Subscribe("203.0.113.11")
	if err != nil {
		t.Fatalf("segunda inscricao: %v", err)
	}
	defer second.Close()
	if replay == nil || replay.DeliveryID != "delivery-1" || replay.Tag != "v2.0.6" {
		t.Fatalf("ultimo evento = %+v", replay)
	}
	if broker.Publish("delivery-1", event) {
		t.Fatal("delivery duplicado foi publicado")
	}
}

func TestBrokerRejectsOlderRelease(t *testing.T) {
	broker := NewBroker()
	subscription, _, err := broker.Subscribe("203.0.113.30")
	if err != nil {
		t.Fatal(err)
	}
	defer subscription.Close()

	if !broker.Publish("beta-12", ReleaseEvent{Tag: "v2.0.5-beta-12", Prerelease: true}) {
		t.Fatal("beta-12 foi recusada")
	}
	if broker.Publish("beta-9", ReleaseEvent{Tag: "v2.0.5-beta-9", Prerelease: true}) {
		t.Fatal("beta-9 rebaixou o broker")
	}
	if got := <-subscription.Events(); got.Tag != "v2.0.5-beta-12" {
		t.Fatalf("evento recebido = %+v", got)
	}

	second, replay, err := broker.Subscribe("203.0.113.31")
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	if replay == nil || replay.Tag != "v2.0.5-beta-12" {
		t.Fatalf("replay = %+v, want beta-12", replay)
	}
}

func TestBrokerSeedsLatestWithoutPublishing(t *testing.T) {
	broker := NewBroker()
	if !broker.SeedLatest(ReleaseEvent{
		DeliveryID: "github-poll:v2.0.5-beta-12|2026-09-08T02:00:00Z",
		Tag:        "v2.0.5-beta-12",
		Prerelease: true,
	}) {
		t.Fatal("baseline nao foi registrada")
	}

	subscription, replay, err := broker.Subscribe("203.0.113.32")
	if err != nil {
		t.Fatal(err)
	}
	defer subscription.Close()
	if replay == nil || replay.Tag != "v2.0.5-beta-12" || replay.DeliveryID == "" {
		t.Fatalf("replay da baseline = %+v", replay)
	}
	select {
	case event := <-subscription.Events():
		t.Fatalf("baseline acordou cliente: %+v", event)
	default:
	}
	if broker.Publish("atrasado-beta-9", ReleaseEvent{Tag: "v2.0.5-beta-9", Prerelease: true}) {
		t.Fatal("webhook atrasado rebaixou a baseline")
	}
}

func TestBrokerLimitsConnectionsPerIP(t *testing.T) {
	broker := NewBroker()
	first, _, err := broker.Subscribe("203.0.113.12")
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	second, _, err := broker.Subscribe("203.0.113.12")
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	if _, _, err := broker.Subscribe("203.0.113.12"); err != ErrTooManyConnections {
		t.Fatalf("terceira conexao = %v, want ErrTooManyConnections", err)
	}
}
