package main

import (
	"encoding/json"
	"strings"
	"testing"

	"protonvpn-wg-confgen/internal/api"
	"protonvpn-wg-confgen/internal/config"
	"protonvpn-wg-confgen/internal/constants"
	"protonvpn-wg-confgen/internal/speedtest"
)

func catalogTestServer(name, country, city string, tier int, load int, score float64) api.LogicalServer {
	return api.LogicalServer{
		Name:        name,
		ExitCountry: country,
		City:        city,
		Tier:        tier,
		Load:        load,
		Score:       score,
		Status:      constants.StatusOnline,
		Servers:     []api.PhysicalServer{{Status: constants.StatusOnline}},
	}
}

func TestEligibleRouteCatalogFiltersExcludesAndSorts(t *testing.T) {
	offline := catalogTestServer("offline", "NL", "Amsterdam", api.TierFree, 1, 0)
	offline.Status = 0
	servers := []api.LogicalServer{
		catalogTestServer("US#2", "US", "New York", api.TierFree, 20, 2),
		catalogTestServer("NL#2", "NL", "Amsterdam", api.TierFree, 40, 2),
		catalogTestServer("US#1", "US", "New York", api.TierFree, 30, 1),
		catalogTestServer("NL#1", "NL", "Amsterdam", api.TierFree, 50, 1),
		catalogTestServer("US#premium", "US", "New York", api.TierPlus, 1, 0.5),
		catalogTestServer("BR#1", "BR", "São Paulo", api.TierFree, 10, 1),
		offline,
		{Name: "empty", ExitCountry: "NL", Tier: api.TierFree, Status: constants.StatusOnline},
	}

	free := &config.Config{
		FreeOnly:          true,
		ExcludedCountries: []string{"BR"},
		ExcludedServers:   []string{"US#2"},
	}
	got := eligibleRouteCatalog(free, servers)
	if len(got) != 3 {
		t.Fatalf("got %d routes, want 3: %+v", len(got), got)
	}
	wantNames := []string{"NL#1", "NL#2", "US#1"}
	for index, want := range wantNames {
		if got[index].Server != want {
			t.Fatalf("route %d = %q, want %q; got %+v", index, got[index].Server, want, got)
		}
		if got[index].Tier != "Free" {
			t.Fatalf("route %q tier = %q, want Free", got[index].Server, got[index].Tier)
		}
	}

	premium := eligibleRouteCatalog(&config.Config{}, servers)
	if len(premium) != 1 || premium[0].Server != "US#premium" || premium[0].Tier != "Plus" {
		t.Fatalf("premium catalog = %+v, want only US#premium", premium)
	}
}

func TestAttachRouteCatalogPingsKeepsOnlyValidMeasurements(t *testing.T) {
	entries := []routeCatalogEntry{
		{Server: "NL#1"},
		{Server: "US#1"},
		{Server: "DE#1"},
		{Server: "CH#1"},
	}
	attachRouteCatalogPings(entries, map[string]int{
		"NL#1": 42,
		"US#1": 0,
		"DE#1": 999,
		"CH#1": -4,
		"NO#1": 18,
	})

	if entries[0].PingMs != 42 {
		t.Fatalf("valid ping = %d, want 42", entries[0].PingMs)
	}
	for _, entry := range entries[1:] {
		if entry.PingMs != 0 {
			t.Fatalf("invalid or absent ping for %s = %d, want 0", entry.Server, entry.PingMs)
		}
	}
}


func TestRouteCatalogProgressAndJSONContainOnlyPublicMetadata(t *testing.T) {
	entries := []routeCatalogEntry{
		{Server: "NL#1", Country: "NL", City: "Amsterdam", Tier: "Free", Load: 14, Score: 1.25},
		{Server: "US#1", Country: "US", City: "New York", Tier: "Free", Load: 21, Score: 2.5},
	}
	var events []speedtest.ProgressEvent
	emitRouteCatalogProgress(entries, func(event speedtest.ProgressEvent) {
		events = append(events, event)
	})
	if len(events) != 3 {
		t.Fatalf("got %d progress events, want initial plus one per route", len(events))
	}
	if events[0].Phase != "catalog" || events[0].Total != 2 || events[0].Tested != 0 || events[0].Succeeded != 0 {
		t.Fatalf("unexpected initial event: %+v", events[0])
	}
	if events[2].Server != "US#1" || events[2].Country != "US" || events[2].City != "New York" ||
		events[2].Tier != "Free" || events[2].Load != 21 || events[2].Score != 2.5 ||
		events[2].Tested != 2 || events[2].Succeeded != 2 || events[2].Status != "success" {
		t.Fatalf("unexpected route event: %+v", events[2])
	}

	data, err := json.Marshal(routeCatalogResult{Success: true, Routes: entries})
	if err != nil {
		t.Fatalf("marshal catalog: %v", err)
	}
	var payload struct {
		Success bool                `json:"success"`
		Routes  []routeCatalogEntry `json:"routes"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		t.Fatalf("unmarshal catalog: %v", err)
	}
	if !payload.Success || len(payload.Routes) != 2 || payload.Routes[0].Server != "NL#1" {
		t.Fatalf("catalog payload = %+v", payload)
	}
	if string(data) == "" || containsCatalogSecret(string(data)) {
		t.Fatalf("catalog payload exposes unexpected secret-shaped data: %s", data)
	}
}

func containsCatalogSecret(value string) bool {
	for _, field := range []string{"endpoint", "confFile", "privateKey", "certificate"} {
		if strings.Contains(value, field) {
			return true
		}
	}
	return false
}
