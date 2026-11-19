package constants

import (
	"regexp"
	"strings"
	"testing"
)

func TestAppVersionMatchesOfficialLinuxClient(t *testing.T) {
	t.Logf("x-pm-appversion=%s user-agent=%s", AppVersion, UserAgent)
	if !regexp.MustCompile(`^linux-vpn-gui@\d+\.\d+\.\d+\+[a-z0-9-]+$`).MatchString(AppVersion) {
		t.Fatalf("AppVersion = %q, want linux-vpn-gui@X.Y.Z+arch", AppVersion)
	}
	if !strings.HasPrefix(AppVersion, "linux-vpn-gui@"+ClientVersion+"+") {
		t.Fatalf("AppVersion = %q does not carry ClientVersion %q", AppVersion, ClientVersion)
	}
	// Proton answers code 5003 to the old linux-vpn@<GTK app version> identifier.
	if strings.HasPrefix(AppVersion, "linux-vpn@") {
		t.Fatalf("AppVersion = %q uses the legacy linux-vpn@ identifier", AppVersion)
	}
	if want := "ProtonVPN/" + ClientVersion + " (Linux; ubuntu/26.04)"; UserAgent != want {
		t.Fatalf("UserAgent = %q, want %q", UserAgent, want)
	}
}

func TestOfficialArch(t *testing.T) {
	for goarch, want := range map[string]string{
		"amd64":   "x86-64",
		"arm64":   "aarch64",
		"arm":     "armv7l",
		"riscv64": "riscv64",
	} {
		if got := officialArch(goarch); got != want {
			t.Errorf("officialArch(%q) = %q, want %q", goarch, got, want)
		}
	}
}
