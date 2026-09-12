package config

import (
	"testing"

	"protonvpn-wg-confgen/internal/constants"
)

func TestValidateFeatureFlags(t *testing.T) {
	tests := []struct {
		name    string
		cfg     Config
		wantErr bool
	}{
		{name: "defaults", cfg: Config{Duration: constants.DefaultCertDuration}},
		{name: "port forwarding", cfg: Config{Duration: constants.DefaultCertDuration, PortForwarding: true}},
		{name: "moderate NAT", cfg: Config{Duration: constants.DefaultCertDuration, ModerateNAT: true}},
		{
			name:    "mutually exclusive features",
			cfg:     Config{Duration: constants.DefaultCertDuration, PortForwarding: true, ModerateNAT: true},
			wantErr: true,
		},

		// Duration bounds, measured against the live API. See API_REFERENCE.md.
		{name: "minimum duration", cfg: Config{Duration: "10m"}},
		{name: "below minimum duration", cfg: Config{Duration: "9m"}, wantErr: true},
		{name: "above maximum duration", cfg: Config{Duration: "366d"}, wantErr: true},
		{name: "unparseable duration", cfg: Config{Duration: "soon"}, wantErr: true},

		// The API silently clamps session certificates to 7d, so reject longer
		// requests instead of handing back something shorter than asked for.
		{name: "session at cap", cfg: Config{Duration: "7d", NoSave: true}},
		{name: "session over cap", cfg: Config{Duration: "8d", NoSave: true}, wantErr: true},
		{name: "persistent over session cap", cfg: Config{Duration: constants.DefaultCertDuration}},
		{name: "Discord reachability with speed test", cfg: Config{Duration: constants.DefaultCertDuration, SpeedTest: true, RequireDiscord: true}},
		{name: "Discord reachability without speed test", cfg: Config{Duration: constants.DefaultCertDuration, RequireDiscord: true}, wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateFeatureFlags(&tt.cfg)
			if (err != nil) != tt.wantErr {
				t.Fatalf("validateFeatureFlags() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}
