package auth

import (
	"errors"
	"fmt"

	"protonvpn-wg-confgen/internal/constants"
)

// ErrTwoFactorRequired is returned when the server requires a TOTP code but
// the caller is running in a mode where it cannot prompt for one. Keep this
// sentinel stable for JSON/non-interactive callers.
var ErrTwoFactorRequired = errors.New("2FA_REQUIRED")

// Error codes from ProtonVPN API
// Official source: github.com/ProtonMail/protoncore_android/.../ResponseCodes.kt
// See API_REFERENCE.md for full documentation.
const (
	CodeSuccess              = constants.APICodeSuccess
	CodeWrongPassword        = 8002  // PASSWORD_WRONG: Incorrect password
	CodeWrongPasswordFormat  = 8004  // Password format is incorrect (observed)
	CodeCaptchaRequired      = 9001  // HUMAN_VERIFICATION_REQUIRED: CAPTCHA needed
	Code2FARequiredForVPN    = 9100  // VPN-specific: certificate endpoint requires 2FA session (not in official docs)
	CodeAccountDeleted       = 10002 // ACCOUNT_DELETED: Account has been deleted
	CodeAccountDisabled      = 10003 // ACCOUNT_DISABLED: Account has been disabled
	CodeMailboxPasswordError = 10013 // Legacy 2-password mode / invalid refresh token (context-dependent)
)

// Error represents an authentication error with ProtonVPN-specific error code
type Error struct {
	Code    int
	Message string
}

// Error implements the error interface
func (e Error) Error() string {
	return e.Message
}

// NewError creates a new authentication error from an API response code
func NewError(code int) error {
	message := getErrorMessage(code)
	return Error{
		Code:    code,
		Message: message,
	}
}

// InvalidCredentialsError identifies a rejected password/username without
// retaining or echoing any server-provided detail.
type InvalidCredentialsError struct {
	Code int
}

func (e *InvalidCredentialsError) Error() string {
	if e == nil {
		return "incorrect username or password"
	}
	return getErrorMessage(e.Code)
}

// IsInvalidCredentials reports whether an authentication attempt was rejected
// as an invalid credential rather than failing because of transport or MFA.
func IsInvalidCredentials(err error) bool {
	var target *InvalidCredentialsError
	return errors.As(err, &target)
}

// TwoFactorError identifies a rejected TOTP submission. Its message contains
// only the numeric API code; the submitted code is never retained.
type TwoFactorError struct {
	Code int
}

func (e *TwoFactorError) Error() string {
	if e == nil {
		return "2FA verification failed"
	}
	return fmt.Sprintf("2FA verification failed (code %d)", e.Code)
}

// IsTwoFactorError reports whether the failure came from the dedicated 2FA
// endpoint or a 2FA validation step.
func IsTwoFactorError(err error) bool {
	var target *TwoFactorError
	return errors.As(err, &target)
}

// SessionInvalidError identifies a cached session rejected by Proton. It is
// deliberately separate from TemporarySessionError so callers can remove the
// cache only when the server actually rejected it.
type SessionInvalidError struct {
	Code       int
	StatusCode int
}

func (e *SessionInvalidError) Error() string {
	if e == nil {
		return "saved Proton session was rejected"
	}
	if e.Code != 0 {
		return fmt.Sprintf("saved Proton session was rejected (code %d)", e.Code)
	}
	if e.StatusCode > 0 {
		return fmt.Sprintf("saved Proton session was rejected (HTTP %d)", e.StatusCode)
	}
	return fmt.Sprintf("saved Proton session was rejected (code %d)", e.Code)
}

// IsSessionInvalid reports whether a refresh response explicitly rejected the
// cached session.
func IsSessionInvalid(err error) bool {
	var target *SessionInvalidError
	return errors.As(err, &target)
}

// ProtocolError represents an unusable response shape/status. It never
// includes the response body, which may contain credentials or challenge
// material supplied by an intermediary.
type ProtocolError struct {
	Operation  string
	StatusCode int
}

func (e *ProtocolError) Error() string {
	if e == nil {
		return "invalid Proton authentication response"
	}
	if e.StatusCode > 0 {
		return fmt.Sprintf("Proton %s returned an invalid HTTP status (%d)", e.Operation, e.StatusCode)
	}
	return fmt.Sprintf("Proton %s returned an invalid response", e.Operation)
}

func newAuthenticationError(code int) error {
	switch code {
	case CodeWrongPassword, CodeWrongPasswordFormat:
		return &InvalidCredentialsError{Code: code}
	default:
		return NewError(code)
	}
}

// getErrorMessage returns a human-readable error message for a given error code
func getErrorMessage(code int) string {
	switch code {
	case CodeWrongPassword:
		return "incorrect username or password"
	case CodeWrongPasswordFormat:
		return "password format is incorrect"
	case CodeCaptchaRequired:
		return "CAPTCHA verification required"
	case Code2FARequiredForVPN:
		return "2FA required for VPN operations - your session was authenticated without 2FA (device trust). Use -clear-session to force re-authentication with 2FA"
	case CodeAccountDeleted:
		return "account has been deleted"
	case CodeAccountDisabled:
		return "account has been disabled"
	case CodeMailboxPasswordError:
		return "account uses legacy 2-password mode - please switch to single-password mode at account.proton.me"
	default:
		return fmt.Sprintf("authentication failed with code: %d", code)
	}
}
