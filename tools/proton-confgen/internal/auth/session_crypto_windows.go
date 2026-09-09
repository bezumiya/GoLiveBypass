//go:build windows

package auth

import (
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

func sessionStorageUsesEncryption() bool { return true }

func protectSessionBytes(payload []byte) ([]byte, error) {
	if len(payload) == 0 {
		return nil, fmt.Errorf("cannot protect an empty session")
	}
	in := windows.DataBlob{Size: uint32(len(payload)), Data: &payload[0]}
	var out windows.DataBlob
	if err := windows.CryptProtectData(&in, nil, nil, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &out); err != nil {
		return nil, fmt.Errorf("Windows DPAPI protect failed: %w", err)
	}
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(out.Data)))
	return append([]byte(nil), unsafe.Slice(out.Data, out.Size)...), nil
}

func unprotectSessionBytes(ciphertext []byte) ([]byte, error) {
	if len(ciphertext) == 0 {
		return nil, fmt.Errorf("encrypted session is empty")
	}
	in := windows.DataBlob{Size: uint32(len(ciphertext)), Data: &ciphertext[0]}
	var out windows.DataBlob
	if err := windows.CryptUnprotectData(&in, nil, nil, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &out); err != nil {
		return nil, fmt.Errorf("Windows DPAPI unprotect failed: %w", err)
	}
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(out.Data)))
	return append([]byte(nil), unsafe.Slice(out.Data, out.Size)...), nil
}
