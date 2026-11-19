// Package constants defines constants used throughout the application.
package constants

import "runtime"

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

// ClientVersion is the version the official Linux client advertises: proton-vpn-gtk-app sends the
// version of python-proton-vpn-api-core, not its own. Source of truth:
// https://raw.githubusercontent.com/ProtonVPN/python-proton-vpn-api-core/stable/versions.yml
// Below Proton's minimum every request fails with HTTP 422, code 5003 ("This version of the app is
// no longer supported"); the old linux-vpn@4.17.2 identifier was cut off on 2026-11-19. Bump it here
// or at build time: go build -ldflags "-X .../internal/constants.ClientVersion=X.Y.Z"
var ClientVersion = "6.1.2"

// API version headers, filled in by init() in the official client's format unless overridden with
// go build -ldflags "-X .../internal/constants.AppVersion=linux-vpn-gui@X.Y.Z+x86-64"
var (
	AppVersion = ""
	UserAgent  = ""
)

func init() {
	if AppVersion == "" {
		AppVersion = "linux-vpn-gui@" + ClientVersion + "+" + officialArch(runtime.GOARCH)
	}
	if UserAgent == "" {
		UserAgent = "ProtonVPN/" + ClientVersion + " (Linux; ubuntu/26.04)"
	}
}

// officialArch spells the CPU architecture the way the official client does (Python's
// platform.machine() with "_" replaced by "-"), so x86_64 becomes "x86-64".
func officialArch(goarch string) string {
	switch goarch {
	case "amd64":
		return "x86-64"
	case "arm64":
		return "aarch64"
	case "arm":
		return "armv7l"
	default:
		return goarch
	}
}

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
