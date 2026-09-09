//go:build windows

package auth

import (
	"path/filepath"
	"testing"
)

func TestWindowsSessionFileLockAcquireAndRelease(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.lock")

	lock, err := acquireSessionFileLock(path)
	if err != nil {
		t.Fatalf("acquireSessionFileLock() error = %v", err)
	}
	if err := lock.release(); err != nil {
		t.Fatalf("release session lock: %v", err)
	}

	lock, err = acquireSessionFileLock(path)
	if err != nil {
		t.Fatalf("reacquireSessionFileLock() error = %v", err)
	}
	if err := lock.release(); err != nil {
		t.Fatalf("release reacquired session lock: %v", err)
	}
}
