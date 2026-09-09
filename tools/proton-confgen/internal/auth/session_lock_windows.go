//go:build windows

package auth

import (
	"context"
	"os"
	"time"

	"golang.org/x/sys/windows"
)

type platformSessionFileLock struct {
	file *os.File
}

func acquireSessionFileLock(path string) (sessionFileLock, error) {
	return acquireSessionFileLockContext(path, context.Background())
}

func acquireSessionFileLockContext(path string, ctx context.Context) (sessionFileLock, error) {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := file.Chmod(0o600); err != nil {
		_ = file.Close()
		return nil, err
	}
	for {
		// LockFileEx requires a valid OVERLAPPED structure even when the
		// operation is requested synchronously. Passing nil can crash the
		// Windows helper with STATUS_ACCESS_VIOLATION before it returns an
		// ordinary API error.
		var overlapped windows.Overlapped
		err := windows.LockFileEx(windows.Handle(file.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &overlapped)
		if err == nil {
			break
		}
		if err != windows.ERROR_LOCK_VIOLATION {
			_ = file.Close()
			return nil, err
		}
		timer := time.NewTimer(10 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			_ = file.Close()
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
	return &platformSessionFileLock{file: file}, nil
}

func (l *platformSessionFileLock) release() error {
	var overlapped windows.Overlapped
	unlockErr := windows.UnlockFileEx(windows.Handle(l.file.Fd()), 0, 1, 0, &overlapped)
	closeErr := l.file.Close()
	if unlockErr != nil {
		return unlockErr
	}
	return closeErr
}
