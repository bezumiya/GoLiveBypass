package releases

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/bezumiya/GoLiveBypass/api/internal/gh"
)

type fakeSource struct {
	release gh.Release
	err     error
	calls   int
}

func (f *fakeSource) LatestStableRelease(context.Context) (gh.Release, error) {
	f.calls++
	return f.release, f.err
}

func validRelease() gh.Release {
	return gh.Release{
		TagName:     "v2.0.4",
		Name:        "GoLiveBypass 2.0.4",
		PublishedAt: "2026-09-05T12:00:00Z",
		HTMLURL:     "https://github.com/owner/repo/releases/tag/v2.0.4",
		Assets: []gh.ReleaseAsset{
			{Name: "GoLiveBypass-2.0.4.exe", BrowserDownloadURL: "https://github.com/owner/repo/releases/download/v2.0.4/GoLiveBypass-2.0.4.exe"},
			{Name: "GoLiveBypass-2.0.4.AppImage", BrowserDownloadURL: "https://github.com/owner/repo/releases/download/v2.0.4/GoLiveBypass-2.0.4.AppImage"},
			{Name: "GoLiveBypass.dmg", BrowserDownloadURL: "https://github.com/owner/repo/releases/download/v2.0.4/GoLiveBypass.dmg"},
			{Name: "GoLiveBypass.zip", BrowserDownloadURL: "https://github.com/owner/repo/releases/download/v2.0.4/GoLiveBypass.zip"},
			{Name: "goLiveBypass-vencord.zip", BrowserDownloadURL: "https://github.com/owner/repo/releases/download/v2.0.4/goLiveBypass-vencord.zip"},
			{Name: "goLiveBypass-vencord.zip.sha256", BrowserDownloadURL: "https://github.com/owner/repo/releases/download/v2.0.4/goLiveBypass-vencord.zip.sha256"},
			{Name: "GoLiveBypass-2.0.4-bypass.js", BrowserDownloadURL: "https://github.com/owner/repo/releases/download/v2.0.4/GoLiveBypass-2.0.4-bypass.js"},
			{Name: "GoLiveBypass-2.0.4-bypass.js.sha256", BrowserDownloadURL: "https://github.com/owner/repo/releases/download/v2.0.4/GoLiveBypass-2.0.4-bypass.js.sha256"},
		},
	}
}

func TestBuildCatalogStableAliases(t *testing.T) {
	catalog, err := buildCatalog(validRelease())
	if err != nil {
		t.Fatalf("buildCatalog() error = %v", err)
	}
	if catalog.Version != "2.0.4" || catalog.Channel != "stable" || catalog.Stale {
		t.Fatalf("catalog = %+v", catalog)
	}
	for _, alias := range []string{"windows", "linux", "mac-dmg", "mac-zip", "plugin", "plugin-sha", "standalone", "standalone-sha"} {
		if catalog.Assets[alias].URL == "" {
			t.Errorf("asset %q ausente", alias)
		}
	}
}

func TestBuildCatalogRejectsPrereleaseAndUnsafeURLs(t *testing.T) {
	release := validRelease()
	release.Prerelease = true
	if _, err := buildCatalog(release); !errors.Is(err, ErrNoStableRelease) {
		t.Fatalf("prerelease err = %v", err)
	}

	release = validRelease()
	release.Assets[0].BrowserDownloadURL = "http://github.com/owner/repo/download.exe"
	catalog, err := buildCatalog(release)
	if err != nil {
		t.Fatalf("URL insegura nao deveria invalidar catalogo inteiro: %v", err)
	}
	if _, ok := catalog.Assets["windows"]; ok {
		t.Fatal("asset HTTP nao deveria ser exposto")
	}
}

func TestCatalogCacheUsesTTLAndRefreshes(t *testing.T) {
	source := &fakeSource{release: validRelease()}
	cache := NewCatalogCache(source, time.Minute)
	now := time.Unix(100, 0)
	cache.now = func() time.Time { return now }

	first, err := cache.Latest(context.Background())
	if err != nil {
		t.Fatalf("primeira consulta: %v", err)
	}
	if source.calls != 1 || first.Stale {
		t.Fatalf("primeira consulta = %+v, calls=%d", first, source.calls)
	}

	now = now.Add(30 * time.Second)
	if _, err := cache.Latest(context.Background()); err != nil {
		t.Fatalf("consulta no TTL: %v", err)
	}
	if source.calls != 1 {
		t.Fatalf("source foi consultada %d vezes dentro do TTL", source.calls)
	}

	now = now.Add(31 * time.Second)
	if _, err := cache.Latest(context.Background()); err != nil {
		t.Fatalf("consulta apos TTL: %v", err)
	}
	if source.calls != 2 {
		t.Fatalf("source foi consultada %d vezes apos expirar", source.calls)
	}
}

func TestCatalogCacheServesStaleFallback(t *testing.T) {
	source := &fakeSource{release: validRelease()}
	cache := NewCatalogCache(source, time.Minute)
	cache.now = func() time.Time { return time.Unix(100, 0) }
	if _, err := cache.Latest(context.Background()); err != nil {
		t.Fatal(err)
	}

	source.err = errors.New("github fora do ar")
	cache.Invalidate()
	catalog, err := cache.Latest(context.Background())
	if err != nil {
		t.Fatalf("fallback retornou erro: %v", err)
	}
	if !catalog.Stale || catalog.Version != "2.0.4" {
		t.Fatalf("fallback = %+v", catalog)
	}
}

func TestCatalogDownloadOnlyAllowsKnownAliases(t *testing.T) {
	source := &fakeSource{release: validRelease()}
	cache := NewCatalogCache(source, time.Minute)
	if got, err := cache.Download(context.Background(), "windows"); err != nil || got == "" {
		t.Fatalf("windows = %q, err = %v", got, err)
	}
	if _, err := cache.Download(context.Background(), "https://evil.example"); !errors.Is(err, ErrUnknownAsset) {
		t.Fatalf("alias arbitrario err = %v", err)
	}
}
