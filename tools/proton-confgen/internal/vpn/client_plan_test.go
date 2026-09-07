package vpn

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"protonvpn-wg-confgen/internal/api"
	"protonvpn-wg-confgen/internal/config"
)

func TestGetAccountPlanRequestsAuthenticatedVPNSettings(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("method = %s, want GET", r.Method)
		}
		if r.URL.Path != "/vpn/v2" {
			t.Errorf("path = %s, want /vpn/v2", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer access-token" {
			t.Errorf("Authorization = %q, want bearer token", got)
		}
		if got := r.Header.Get("x-pm-uid"); got != "uid-123" {
			t.Errorf("x-pm-uid = %q, want uid-123", got)
		}
		if r.Header.Get("x-pm-appversion") == "" {
			t.Error("x-pm-appversion header was not sent")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, `{"VPN":{"MaxTier":2,"PlanName":"plus","PlanTitle":"VPN Plus"}}`)
	}))
	defer server.Close()

	cfg := &config.Config{APIURL: server.URL}
	client := NewClient(cfg, &api.Session{AccessToken: "access-token", UID: "uid-123"})
	plan, err := client.GetAccountPlan()
	if err != nil {
		t.Fatalf("GetAccountPlan() error = %v", err)
	}
	if plan.MaxTier != 2 || plan.PlanName != "plus" || plan.PlanTitle != "VPN Plus" {
		t.Fatalf("plan = %+v, want MaxTier 2 and Plus metadata", plan)
	}
}

func TestGetAccountPlanClassifiesFreeAndPremiumTiers(t *testing.T) {
	tests := []struct {
		name    string
		maxTier int
	}{
		{name: "free", maxTier: 0},
		{name: "plus", maxTier: 2},
		{name: "professional", maxTier: 3},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = fmt.Fprintf(w, `{"VPN":{"MaxTier":%d}}`, tt.maxTier)
			}))
			defer server.Close()

			client := NewClient(&config.Config{APIURL: server.URL}, &api.Session{})
			plan, err := client.GetAccountPlan()
			if err != nil {
				t.Fatalf("GetAccountPlan() error = %v", err)
			}
			if plan.MaxTier != tt.maxTier {
				t.Fatalf("MaxTier = %d, want %d", plan.MaxTier, tt.maxTier)
			}
		})
	}
}

func TestGetAccountPlanRejectsErrorAndIncompleteResponses(t *testing.T) {
	tests := []struct {
		name string
		body string
	}{
		{name: "api error", body: `{"Code":2001,"Error":"unauthorized"}`},
		{name: "missing vpn", body: `{}`},
		{name: "missing max tier", body: `{"VPN":{"PlanTitle":"VPN Plus"}}`},
		{name: "negative max tier", body: `{"VPN":{"MaxTier":-1}}`},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = fmt.Fprint(w, tt.body)
			}))
			defer server.Close()

			client := NewClient(&config.Config{APIURL: server.URL}, &api.Session{})
			if plan, err := client.GetAccountPlan(); err == nil || plan != nil {
				t.Fatalf("GetAccountPlan() = (%+v, %v), want an error", plan, err)
			}
		})
	}
}
