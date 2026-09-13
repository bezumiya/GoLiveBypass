//go:build windows

package auth

import (
	"errors"
	"testing"

	"golang.org/x/sys/windows"
)

// moveTransientError must classify exactly the transient sharing/access class
// from issue #271 — retrying a permanent failure only delays an actionable
// error, and not retrying a transient one keeps login failing.
func TestMoveTransientErrorClassifiesTransientOnly(t *testing.T) {
	transient := []error{
		windows.ERROR_SHARING_VIOLATION,
		windows.ERROR_LOCK_VIOLATION,
		windows.ERROR_ACCESS_DENIED,
	}
	for _, err := range transient {
		if !moveTransientError(err) {
			t.Errorf("moveTransientError(%v) = false, want true", err)
		}
		if !moveTransientError(errors.Join(errors.New("wrapper"), err)) {
			t.Errorf("moveTransientError(wrapped %v) = false, want true", err)
		}
	}

	permanent := []error{
		windows.ERROR_FILE_NOT_FOUND,
		windows.ERROR_PATH_NOT_FOUND,
		windows.ERROR_NOT_READY,
		nil,
		errors.New("generic failure"),
	}
	for _, err := range permanent {
		if moveTransientError(err) {
			t.Errorf("moveTransientError(%v) = true, want false", err)
		}
	}
}
