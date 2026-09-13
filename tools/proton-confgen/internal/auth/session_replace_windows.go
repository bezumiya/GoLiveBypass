//go:build windows

package auth

import (
	"errors"
	"fmt"
	"time"

	"golang.org/x/sys/windows"
)

// moveTransientError reports whether a MoveFileEx failure belongs to the
// transient Windows sharing/lock class observed in production relatos (#271):
// the session file was momentarily held open (antivirus, sync client, a second
// helper instance). ERROR_ACCESS_DENIED is included as a plausible transient
// (a shell extension or indexador can hold the target briefly), accepting the
// cost of a short retry on a genuinely denied path — the retry is bounded and
// the final error keeps the Win32 code for diagnosis.
func moveTransientError(err error) bool {
	if err == nil {
		return false
	}
	for _, code := range []windows.Errno{
		windows.ERROR_SHARING_VIOLATION,
		windows.ERROR_LOCK_VIOLATION,
		windows.ERROR_ACCESS_DENIED,
	} {
		if errors.Is(err, code) {
			return true
		}
	}
	return false
}

// replaceSessionFile attempts the atomic MoveFileEx replace, retrying only
// the transient sharing/access class with a short backoff (issue #271).
// The returned error keeps the Win32 code text ("Access is denied." /
// "The process cannot access the file...") for diagnosis but never file
// contents or session material.
func replaceSessionFile(source, target string) error {
	sourcePtr, err := windows.UTF16PtrFromString(source)
	if err != nil {
		return err
	}
	targetPtr, err := windows.UTF16PtrFromString(target)
	if err != nil {
		return err
	}

	const attempts = 4
	var lastErr error
	for attempt := range attempts {
		if attempt > 0 {
			time.Sleep(time.Duration(attempt) * 150 * time.Millisecond)
		}
		err := windows.MoveFileEx(sourcePtr, targetPtr, windows.MOVEFILE_REPLACE_EXISTING|windows.MOVEFILE_WRITE_THROUGH)
		if err == nil {
			return nil
		}
		lastErr = err
		if !moveTransientError(err) {
			break
		}
	}
	return fmt.Errorf("replaceSessionFile: %w", lastErr)
}
