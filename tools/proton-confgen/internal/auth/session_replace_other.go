//go:build !windows

package auth

import "os"

func replaceSessionFile(source, target string) error {
	return os.Rename(source, target)
}
