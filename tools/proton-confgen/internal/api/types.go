// Package api defines the data structures for ProtonVPN API responses.
package api

// AuthInfoResponse represents the response from the auth info endpoint
type AuthInfoResponse struct {
	Code            int    `json:"Code"`
	Version         int    `json:"Version"`
	Modulus         string `json:"Modulus"`
	ServerEphemeral string `json:"ServerEphemeral"`
	Salt            string `json:"Salt"`
	SRPSession      string `json:"SRPSession"`
	TwoFA           struct {
		Enabled int `json:"Enabled"`
		TOTP    int `json:"TOTP"`
	} `json:"2FA"`
}

// Session represents a ProtonVPN session
type Session struct {
	Code         int      `json:"Code"`
	AccessToken  string   `json:"AccessToken"`
	RefreshToken string   `json:"RefreshToken"`
	TokenType    string   `json:"TokenType"`
	Scopes       []string `json:"Scopes"`
	UID          string   `json:"UID"`
	UserID       string   `json:"UserID"`
	EventID      string   `json:"EventID"`
	ServerProof  string   `json:"ServerProof"`
	PasswordMode int      `json:"PasswordMode"`
	ExpiresIn    int      `json:"ExpiresIn"` // Session expiration in seconds
	Error        string   `json:"Error,omitempty"`
	TwoFA        struct {
		Enabled int `json:"Enabled"`
		TOTP    int `json:"TOTP"`
	} `json:"2FA"`
	Details ErrorDetails `json:"Details"`
}

// ErrorDetails carries the extra payload the API attaches to some failures,
// most usefully the human verification challenge behind code 9001.
type ErrorDetails struct {
	HumanVerificationToken   string   `json:"HumanVerificationToken"`
	HumanVerificationMethods []string `json:"HumanVerificationMethods"`
}

// VPNInfo represents VPN certificate information
type VPNInfo struct {
	Code                 int    `json:"Code"`
	Error                string `json:"Error,omitempty"`
	SerialNumber         string `json:"SerialNumber"`
	ClientKeyFingerprint string `json:"ClientKeyFingerprint"`
	ClientKey            string `json:"ClientKey"`
	Certificate          string `json:"Certificate"`
	ExpirationTime       int64  `json:"ExpirationTime"`
	RefreshTime          int64  `json:"RefreshTime"`
	Mode                 string `json:"Mode"`
	DeviceName           string `json:"DeviceName"`
	ServerPublicKeyMode  string `json:"ServerPublicKeyMode"`
	ServerPublicKey      string `json:"ServerPublicKey"`
	Features             struct {
		Bouncing       bool `json:"bouncing"`
		ModerateNAT    bool `json:"moderate-nat"`
		NetshieldLevel int  `json:"netshield-level"`
		PortForwarding bool `json:"port-forwarding"`
		VPNAccelerator bool `json:"vpn-accelerator"`
	} `json:"Features"`
}

// VPNCertificate represents a single certificate entry returned by /vpn/v1/certificate/all.
type VPNCertificate struct {
	SerialNumber         string `json:"SerialNumber"`
	ClientKeyFingerprint string `json:"ClientKeyFingerprint"`
	ClientKey            string `json:"ClientKey"`
	DeviceName           string `json:"DeviceName,omitempty"`
	Mode                 string `json:"Mode"`
	ExpirationTime       int64  `json:"ExpirationTime"`
	RefreshTime          int64  `json:"RefreshTime"`
}

// CertListResponse is the response body for GET /vpn/v1/certificate/all.
type CertListResponse struct {
	Code         int              `json:"Code"`
	Error        string           `json:"Error,omitempty"`
	Certificates []VPNCertificate `json:"Certificates"`
	Total        int              `json:"Total"`
}

// LogicalServer represents a ProtonVPN logical server
type LogicalServer struct {
	ID           string           `json:"ID"`
	Name         string           `json:"Name"`
	EntryCountry string           `json:"EntryCountry"`
	ExitCountry  string           `json:"ExitCountry"`
	Domain       string           `json:"Domain"`
	Tier         int              `json:"Tier"`
	Features     int              `json:"Features"`
	Region       string           `json:"Region"`
	City         string           `json:"City"`
	Score        float64          `json:"Score"`
	Load         int              `json:"Load"`
	Status       int              `json:"Status"`
	Servers      []PhysicalServer `json:"Servers"`
	HostCountry  string           `json:"HostCountry"`
	Location     struct {
		Lat  float64 `json:"Lat"`
		Long float64 `json:"Long"`
	} `json:"Location"`
}

// PhysicalServer represents a physical VPN server
type PhysicalServer struct {
	ID                 string `json:"ID"`
	EntryIP            string `json:"EntryIP"`
	ExitIP             string `json:"ExitIP"`
	Domain             string `json:"Domain"`
	Status             int    `json:"Status"`
	Label              string `json:"Label"`
	X25519PublicKey    string `json:"X25519PublicKey"`
	Generation         int    `json:"Generation"`
	ServicesDownReason string `json:"ServicesDownReason"`
}

// LogicalsResponse represents the response from the logicals endpoint
type LogicalsResponse struct {
	Code           int             `json:"Code"`
	LogicalServers []LogicalServer `json:"LogicalServers"`
}

// VPNPlanInfo is the account-level plan information returned by GET /vpn/v2.
// MaxTier is a pointer on purpose: a missing field is not equivalent to the
// Free tier and must be treated as an indeterminate response by callers.
type VPNPlanInfo struct {
	PlanName  string `json:"PlanName"`
	PlanTitle string `json:"PlanTitle"`
	MaxTier   *int   `json:"MaxTier"`
}

// VPNSettingsResponse is the subset of GET /vpn/v2 needed to classify the
// account. The endpoint includes many other settings which are intentionally
// ignored here.
type VPNSettingsResponse struct {
	Code  int          `json:"Code"`
	Error string       `json:"Error,omitempty"`
	VPN   *VPNPlanInfo `json:"VPN"`
}

// AccountPlan is the validated, minimal plan value used by the CLI and GUI.
type AccountPlan struct {
	MaxTier   int
	PlanName  string
	PlanTitle string
}

// Server feature constants
const (
	FeatureSecureCore = 1
	FeatureTor        = 2
	FeatureP2P        = 4
	FeatureStreaming  = 8
	FeatureIPv6       = 16
)

// Server tier constants
const (
	TierFree = 0
	TierPlus = 2
	TierPM   = 3
)

// GetTierName returns a human-readable name for the server tier
func GetTierName(tier int) string {
	switch tier {
	case TierFree:
		return "Free"
	case TierPlus:
		return "Plus"
	case TierPM:
		return "ProtonMail"
	default:
		return "Unknown"
	}
}

// GetFeatureNames returns a list of enabled features for a server
func GetFeatureNames(features int) []string {
	var result []string
	if features&FeatureSecureCore != 0 {
		result = append(result, "SecureCore")
	}
	if features&FeatureTor != 0 {
		result = append(result, "Tor")
	}
	if features&FeatureP2P != 0 {
		result = append(result, "P2P")
	}
	if features&FeatureStreaming != 0 {
		result = append(result, "Streaming")
	}
	if features&FeatureIPv6 != 0 {
		result = append(result, "IPv6")
	}
	return result
}
