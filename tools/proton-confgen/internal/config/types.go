package config

// Config holds all configuration options
type Config struct {
	// Authentication
	Username string
	Password string

	// Server selection
	Countries         []string
	ExcludedCountries []string
	ServerName        string
	P2PServersOnly    bool
	SecureCoreOnly    bool
	FreeOnly          bool

	// Output configuration
	OutputFile       string
	ClientPrivateKey string
	DeviceName       string

	// Network configuration
	DNSServers        []string
	AllowedIPs        []string
	EnableAccelerator bool
	EnableIPv6        bool
	PortForwarding    bool
	ModerateNAT       bool

	// Certificate configuration
	Duration string

	// Session management
	ClearSession    bool
	NoSession       bool
	ForceRefresh    bool
	SessionDuration string

	// Advanced configuration
	APIURL string
	Debug  bool

	// Management mode
	ListConfigs bool

	// List servers mode
	ListServers bool

	// Route catalog mode lists public route metadata without generating profiles.
	RouteCatalog bool

	// Renew certificate by serial number
	RenewSerial string

	// Non-persistent mode (do not register on account)
	NoSave bool

	// Human verification token replayed after solving a CAPTCHA out of band
	HVToken string

	// StdinSecrets enables the private JSON credential handoff used by the plugin.
	// It keeps passwords, 2FA codes and CAPTCHA tokens out of the process arguments.
	StdinSecrets bool

	// Automated GUI & Ping extensions
	TwoFactorCode   string
	SessionFile     string
	AutoPing        bool
	SpeedTest       bool
	RequireDiscord  bool
	ManualProbe     bool
	ProgressJSON    bool
	SpeedTestTrace  bool
	JSONOutput      bool
	CheckSession    bool
	CheckPlan       bool
	LoginOnly       bool
	SessionUsername bool

	// Route pool mode generates several ping-ranked profiles without opening
	// concurrent tunnels. It is used by the GUI's Proton Free failover path.
	RoutePool          bool
	RoutePoolSize      int
	RoutePoolOutputDir string
	ExcludedServers    []string
}
