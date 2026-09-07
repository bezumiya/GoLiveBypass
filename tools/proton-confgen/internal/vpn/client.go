// Package vpn manages VPN certificate generation and server interactions.
package vpn

import (
	"fmt"
	"net/http"
	"time"

	"protonvpn-wg-confgen/internal/api"
	"protonvpn-wg-confgen/internal/config"
	"protonvpn-wg-confgen/internal/constants"
	"protonvpn-wg-confgen/internal/timeutil"

	"github.com/ProtonVPN/go-vpn-lib/ed25519"
)

// Client handles VPN operations
type Client struct {
	config     *config.Config
	session    *api.Session
	httpClient *http.Client
}

// NewClient creates a new VPN client
func NewClient(cfg *config.Config, session *api.Session) *Client {
	return &Client{
		config:     cfg,
		session:    session,
		httpClient: &http.Client{Timeout: 10 * time.Second},
	}
}

// doJSON performs an authenticated request and decodes the JSON response into out.
func (c *Client) doJSON(method, url string, body, out any) error {
	req, err := api.NewRequest(method, url, body, c.session)
	if err != nil {
		return err
	}
	return api.Do(c.httpClient, req, out)
}

// requestCertificate posts a certificate request and validates the response code.
func (c *Client) requestCertificate(certReq map[string]any) (*api.VPNInfo, error) {
	var vpnInfo api.VPNInfo
	if err := c.doJSON(http.MethodPost, c.config.APIURL+constants.CertificatePath, certReq, &vpnInfo); err != nil {
		return nil, err
	}

	if !constants.IsSuccessCode(vpnInfo.Code) {
		if vpnInfo.Error != "" {
			return nil, fmt.Errorf("certificate error (code %d): %s", vpnInfo.Code, vpnInfo.Error)
		}
		return nil, fmt.Errorf("certificate request failed, code: %d", vpnInfo.Code)
	}

	return &vpnInfo, nil
}

// GetCertificate generates a VPN certificate
func (c *Client) GetCertificate(keyPair *ed25519.KeyPair) (*api.VPNInfo, error) {
	publicKeyPEM, err := keyPair.PublicKeyPKIXPem()
	if err != nil {
		return nil, fmt.Errorf("failed to get public key PEM: %w", err)
	}

	durationStr, err := timeutil.ParseToMinutes(c.config.Duration)
	if err != nil {
		return nil, fmt.Errorf("failed to parse duration: %w", err)
	}

	// Build certificate request matching official ProtonVPN API format
	// Feature keys from: python-proton-vpn-api-core/proton/vpn/session/fetcher.py
	certReq := map[string]any{
		"ClientPublicKey":     publicKeyPEM,
		"ClientPublicKeyMode": constants.PublicKeyMode,
		"Duration":            durationStr,
		"Features":            c.certificateFeatures(),
	}

	// When NoSave is set, omit Mode and DeviceName so the cert is session-only
	// and won't appear in the ProtonVPN dashboard.
	if !c.config.NoSave {
		certReq["Mode"] = constants.CertMode // "persistent"
		certReq["DeviceName"] = c.deviceName()
	}

	return c.requestCertificate(certReq)
}

// RenewCertificate renews an existing persistent certificate by reusing its public key.
// Unlike GetCertificate, this does not generate a new key pair and sends Renew: true.
func (c *Client) RenewCertificate(publicKeyPEM, deviceName string) (*api.VPNInfo, error) {
	durationStr, err := timeutil.ParseToMinutes(c.config.Duration)
	if err != nil {
		return nil, fmt.Errorf("failed to parse duration: %w", err)
	}

	return c.requestCertificate(map[string]any{
		"ClientPublicKey":     publicKeyPEM,
		"ClientPublicKeyMode": constants.PublicKeyMode,
		"Mode":                constants.CertMode,
		"DeviceName":          deviceName,
		"Duration":            durationStr,
		"Features":            c.certificateFeatures(),
		"Renew":               true,
	})
}

// GetServers fetches the list of VPN servers
func (c *Client) GetServers() ([]api.LogicalServer, error) {
	var response api.LogicalsResponse
	if err := c.doJSON(http.MethodGet, c.config.APIURL+constants.LogicalsPath, nil, &response); err != nil {
		return nil, err
	}

	if !constants.IsSuccessCode(response.Code) {
		return nil, fmt.Errorf("API returned error code: %d", response.Code)
	}

	return response.LogicalServers, nil
}

// GetAccountPlan fetches the account plan from the authenticated VPN settings
// endpoint. It deliberately does not request a certificate or open a tunnel:
// plan classification is an account API concern, independent of route reachability.
func (c *Client) GetAccountPlan() (*api.AccountPlan, error) {
	var response api.VPNSettingsResponse
	if err := c.doJSON(http.MethodGet, c.config.APIURL+constants.VPNSettingsPath, nil, &response); err != nil {
		return nil, err
	}

	if response.Code != 0 && !constants.IsSuccessCode(response.Code) {
		if response.Error != "" {
			return nil, fmt.Errorf("account plan error (code %d): %s", response.Code, response.Error)
		}
		return nil, fmt.Errorf("account plan request failed, code: %d", response.Code)
	}
	if response.VPN == nil || response.VPN.MaxTier == nil {
		return nil, fmt.Errorf("account plan response did not include VPN.MaxTier")
	}
	if *response.VPN.MaxTier < 0 {
		return nil, fmt.Errorf("account plan response included an invalid MaxTier")
	}

	return &api.AccountPlan{
		MaxTier:   *response.VPN.MaxTier,
		PlanName:  response.VPN.PlanName,
		PlanTitle: response.VPN.PlanTitle,
	}, nil
}

// ListCertificates fetches all persistent certificates on the account, paginating via BeginID.
func (c *Client) ListCertificates() ([]api.VPNCertificate, error) {
	const pageSize = 50
	var all []api.VPNCertificate
	var beginID string

	for {
		u := fmt.Sprintf("%s%s/all?Mode=%s&Limit=%d", c.config.APIURL, constants.CertificatePath, constants.CertMode, pageSize)
		if beginID != "" {
			u += "&BeginID=" + beginID
		}

		var page api.CertListResponse
		if err := c.doJSON(http.MethodGet, u, nil, &page); err != nil {
			return nil, err
		}
		if !constants.IsSuccessCode(page.Code) {
			if page.Error != "" {
				return nil, fmt.Errorf("list certificates error (code %d): %s", page.Code, page.Error)
			}
			return nil, fmt.Errorf("list certificates failed, code: %d", page.Code)
		}

		all = append(all, page.Certificates...)
		if len(page.Certificates) < pageSize {
			break
		}
		beginID = page.Certificates[len(page.Certificates)-1].SerialNumber
	}

	return all, nil
}

// deviceName returns the configured device name, generating one if unset.
func (c *Client) deviceName() string {
	if c.config.DeviceName != "" {
		return c.config.DeviceName
	}
	return fmt.Sprintf("WireGuard-%s-%d", c.config.Username, time.Now().Unix())
}

func (c *Client) certificateFeatures() map[string]any {
	return map[string]any{
		"NetShieldLevel": 0,
		// Proton's API field is inverted: RandomNAT=false enables Moderate NAT.
		"RandomNAT":      !c.config.ModerateNAT,
		"PortForwarding": c.config.PortForwarding,
		"SplitTCP":       c.config.EnableAccelerator,
	}
}
