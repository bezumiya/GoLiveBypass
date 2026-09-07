// Package constants defines constants used throughout the application.
package constants

// API endpoints
// Paths match the ProtonVPN Linux reference client (python-proton-core/python-proton-vpn-api-core).
const (
	DefaultAPIURL   = "https://vpn-api.proton.me"
	AuthInfoPath    = "/auth/info"
	AuthPath        = "/auth"
	TwoFAPath       = "/auth/2fa"
	RefreshPath     = "/auth/refresh"
	VPNSettingsPath = "/vpn/v2"
	CertificatePath = "/vpn/v1/certificate"
	LogicalsPath    = "/vpn/v1/logicals"
	// CaptchaPath serves the human verification widget for this API entry point.
	CaptchaPath = "/core/v4/captcha"
)

// API version headers - can be overridden at build time via ldflags:
// go build -ldflags "-X .../internal/constants.AppVersion=linux-vpn@X.Y.Z"
var (
	AppVersion = "linux-vpn@4.17.2"
	UserAgent  = "ProtonVPN/4.17.2 (Linux; Ubuntu)"
)

// API response codes
// Reference: proton-python-client/proton/api.py checks for codes 1000 and 1001
const (
	APICodeSuccess     = 1000
	APICodeMultiStatus = 1001 // Also indicates success in some contexts
)

// IsSuccessCode checks if an API response code indicates success
func IsSuccessCode(code int) bool {
	return code == APICodeSuccess || code == APICodeMultiStatus
}

// Server/feature status values
const (
	StatusOnline = 1
	EnabledTrue  = 1
)
