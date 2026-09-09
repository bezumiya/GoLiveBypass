//go:build !windows

package auth

import (
	"context"
	"os"
	"syscall"
	"time"
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
		err = syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			break
		}
		if err == syscall.EINTR {
			continue
		}
		if err != syscall.EWOULDBLOCK && err != syscall.EAGAIN {
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
	var unlockErr error
	for {
		unlockErr = syscall.Flock(int(l.file.Fd()), syscall.LOCK_UN)
		if unlockErr != syscall.EINTR {
			break
		}
	}
	closeErr := l.file.Close()
	if unlockErr != nil {
		return unlockErr
	}
	return closeErr
}
