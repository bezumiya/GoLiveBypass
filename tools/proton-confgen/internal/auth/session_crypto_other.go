//go:build !windows

package auth

// The plugin is Windows x64 only. The standalone Linux helper keeps its
// existing owner-only session file contract until a platform keyring is
// selected for that separate product.
func sessionStorageUsesEncryption() bool { return false }

func protectSessionBytes(payload []byte) ([]byte, error) {
	return append([]byte(nil), payload...), nil
}

func unprotectSessionBytes(payload []byte) ([]byte, error) {
	return append([]byte(nil), payload...), nil
}
