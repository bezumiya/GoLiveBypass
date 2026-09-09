package auth

import (
	"path/filepath"
	"testing"
	"time"

	"protonvpn-wg-confgen/internal/api"
)

func TestSessionStoreSaveCreatesParentAndRecoversUsername(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "nested", "proton-session.json")
	store := NewSessionStore(file)
	session := &api.Session{AccessToken: "access", RefreshToken: "refresh", UID: "uid", ExpiresIn: 3600}

	if err := store.Save(session, "account@example.com", time.Hour); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	if got, err := store.Username(); err != nil || got != "account@example.com" {
		t.Fatalf("Username() = %q, %v", got, err)
	}
	if _, _, err := store.Load("account@example.com"); err != nil {
		t.Fatalf("Load() error = %v", err)
	}
}

func TestSessionStoreLoadMatchesUsernameCaseInsensitively(t *testing.T) {
	root := t.TempDir()
	store := NewSessionStore(filepath.Join(root, "proton-session.json"))
	session := &api.Session{AccessToken: "access", RefreshToken: "refresh", UID: "uid", ExpiresIn: 3600}

	if err := store.Save(session, "Account@Example.com", time.Hour); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	loaded, _, err := store.Load("  account@example.COM  ")
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if loaded == nil || loaded.AccessToken != "access" {
		t.Fatalf("Load() = %#v; want cached session", loaded)
	}
}
