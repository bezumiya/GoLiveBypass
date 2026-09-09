package auth

import (
	"context"
	"fmt"
	"os"
)

const sessionLockSuffix = ".lock"

// sessionFileLock is an OS-backed exclusive lock. Keeping the lock file next
// to the cache serializes different helper processes as well as goroutines in
// one process; the file never contains session material.
type sessionFileLock interface {
	release() error
}

func validateSessionLockPath(path string) error {
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return fmt.Errorf("session lock is not a regular file")
	}
	return nil
}

func (s *SessionStore) withSessionLock(fn func() error) (err error) {
	return s.withSessionLockContext(context.Background(), fn)
}

func (s *SessionStore) withSessionLockContext(ctx context.Context, fn func() error) (err error) {
	ctx, err = normalizeAuthContext(ctx)
	if err != nil {
		return err
	}
	lockPath := s.filePath + sessionLockSuffix
	if err := validateSessionLockPath(lockPath); err != nil {
		return err
	}
	lock, err := acquireSessionFileLockContext(lockPath, ctx)
	if err != nil {
		return err
	}
	defer func() {
		if releaseErr := lock.release(); err == nil && releaseErr != nil {
			err = fmt.Errorf("failed to release session lock: %w", releaseErr)
		}
	}()
	return fn()
}
