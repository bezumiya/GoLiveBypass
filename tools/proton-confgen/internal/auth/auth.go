// Package auth handles ProtonVPN authentication using the SRP protocol.
package auth

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"protonvpn-wg-confgen/internal/api"
	"protonvpn-wg-confgen/internal/config"
	"protonvpn-wg-confgen/internal/constants"
	"protonvpn-wg-confgen/internal/timeutil"

	"github.com/ProtonMail/go-srp"
	"golang.org/x/term"
)

// Client handles ProtonVPN authentication
type Client struct {
	config              *config.Config
	httpClient          *http.Client
	sessionStore        *SessionStore
	operationMu         sync.Mutex
	commitMu            sync.Mutex
	operationGeneration uint64
	activeCancel        context.CancelFunc
}

// HumanVerificationError is intentionally safe to serialize: it never carries
// the solved token, only the challenge URL that the user must open.
type HumanVerificationError struct {
	Code       string
	CaptchaURL string
	Retryable  bool
	Message    string
}

func (e HumanVerificationError) Error() string { return e.Message }

// TemporarySessionError keeps transport/server failures separate from an
// invalid credential. Callers can show a retryable state without deleting the
// cached session or misleading the user into logging in again.
type TemporarySessionError struct {
	Err       error
	Operation string
}

func (e *TemporarySessionError) Error() string {
	if e == nil {
		return "temporary Proton session operation failure"
	}
	if strings.TrimSpace(e.Operation) != "" {
		return fmt.Sprintf("Proton %s temporarily unavailable", e.Operation)
	}
	return "temporary Proton session operation failure"
}

func (e *TemporarySessionError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Err
}

// IsTemporarySessionError reports whether a session check failed because the
// verification request could not be completed reliably.
func IsTemporarySessionError(err error) bool {
	var temporaryErr *TemporarySessionError
	return errors.As(err, &temporaryErr)
}

const maxAuthResponseBytes int64 = 1 << 20

func normalizeAuthContext(ctx context.Context) (context.Context, error) {
	if ctx == nil {
		return nil, errors.New("authentication context cannot be nil")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return ctx, nil
}

func classifyAuthTransportError(ctx context.Context, err error) error {
	// A caller deadline/cancellation is a control-flow result, not evidence
	// that Proton rejected the credential. A deadline created internally by
	// http.Client.Timeout has not canceled ctx and remains retryable instead.
	if ctx != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return ctxErr
		}
	}
	if errors.Is(err, context.Canceled) {
		return context.Canceled
	}
	return &TemporarySessionError{Err: err}
}

func isTemporaryHTTPStatus(status int) bool {
	return status == http.StatusRequestTimeout ||
		status == http.StatusTooEarly ||
		status == http.StatusTooManyRequests ||
		status >= 500
}

// doAuthJSON is deliberately local to auth. api.Do is used by older
// non-authentication clients and includes a response-body snippet in errors;
// authentication responses can contain challenge material or server-provided
// details, so they must be bounded and never echoed.
func doAuthJSON(ctx context.Context, client *http.Client, req *http.Request, operation string, out any) (int, error) {
	ctx, err := normalizeAuthContext(ctx)
	if err != nil {
		return 0, err
	}
	req = req.WithContext(ctx)
	resp, err := client.Do(req)
	if err != nil {
		return 0, classifyAuthTransportError(ctx, err)
	}
	defer func() { _ = resp.Body.Close() }()

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxAuthResponseBytes+1))
	if err != nil {
		clear(body)
		return resp.StatusCode, classifyAuthTransportError(ctx, err)
	}
	defer clear(body)
	if int64(len(body)) > maxAuthResponseBytes {
		return resp.StatusCode, &ProtocolError{Operation: operation, StatusCode: resp.StatusCode}
	}
	if err := ctx.Err(); err != nil {
		return resp.StatusCode, err
	}
	if isTemporaryHTTPStatus(resp.StatusCode) {
		return resp.StatusCode, &TemporarySessionError{Err: fmt.Errorf("HTTP %d", resp.StatusCode), Operation: operation}
	}
	if err := json.Unmarshal(body, out); err != nil {
		return resp.StatusCode, &ProtocolError{Operation: operation, StatusCode: resp.StatusCode}
	}
	return resp.StatusCode, nil
}

func (c *Client) beginAuthentication(ctx context.Context) (context.Context, uint64, func(), error) {
	ctx, err := normalizeAuthContext(ctx)
	if err != nil {
		return nil, 0, nil, err
	}
	c.commitMu.Lock()
	c.operationMu.Lock()
	if c.activeCancel != nil {
		c.activeCancel()
	}
	opCtx, cancel := context.WithCancel(ctx)
	c.operationGeneration++
	generation := c.operationGeneration
	c.activeCancel = cancel
	c.operationMu.Unlock()
	c.commitMu.Unlock()

	finish := func() {
		c.operationMu.Lock()
		if c.operationGeneration == generation {
			c.activeCancel = nil
		}
		c.operationMu.Unlock()
		cancel()
	}
	return opCtx, generation, finish, nil
}

func (c *Client) operationIsCurrent(generation uint64) bool {
	if generation == 0 {
		return true
	}
	c.operationMu.Lock()
	defer c.operationMu.Unlock()
	return c.operationGeneration == generation && c.activeCancel != nil
}

func (c *Client) requireCurrentOperation(ctx context.Context, generation uint64) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if !c.operationIsCurrent(generation) {
		return context.Canceled
	}
	return nil
}

func (c *Client) cancelActiveAuthentication() {
	c.commitMu.Lock()
	cancel := c.cancelActiveAuthenticationLocked()
	c.commitMu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (c *Client) cancelActiveAuthenticationLocked() context.CancelFunc {
	c.operationMu.Lock()
	c.operationGeneration++
	cancel := c.activeCancel
	c.activeCancel = nil
	c.operationMu.Unlock()
	return cancel
}

// NewClient creates a new authentication client
func NewClient(cfg *config.Config) *Client {
	return &Client{
		config:       cfg,
		sessionStore: NewSessionStore(cfg.SessionFile),
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
			Transport: &http.Transport{
				TLSClientConfig: &tls.Config{
					InsecureSkipVerify: false,
					MinVersion:         tls.VersionTLS12,
				},
			},
		},
	}
}

// SessionUsername returns only the cached account identity. The session store
// decrypts/migrates the file before parsing it, so callers never need to know
// the on-disk protection format.
func (c *Client) SessionUsername() (string, error) {
	return c.sessionStore.Username()
}

// Logout cancels an in-flight authentication operation and removes the local
// session under the same commit lock used by authentication. Proton logout is
// represented locally here because the helper has no long-lived API session to
// invalidate remotely.
func (c *Client) Logout() error {
	c.commitMu.Lock()
	cancel := c.cancelActiveAuthenticationLocked()
	err := c.sessionStore.Delete()
	c.commitMu.Unlock()
	if cancel != nil {
		cancel()
	}
	return err
}

// CheckSession checks if a saved session exists and is valid.
func (c *Client) CheckSession() (*api.Session, time.Duration, error) {
	return c.CheckSessionContext(context.Background())
}

// CheckSessionContext is the cancellable form used by integrations that keep
// the helper process alive while the UI owns the operation.
func (c *Client) CheckSessionContext(ctx context.Context) (*api.Session, time.Duration, error) {
	ctx, err := normalizeAuthContext(ctx)
	if err != nil {
		return nil, 0, err
	}
	savedSession, timeUntilExpiry, err := c.sessionStore.LoadContext(ctx, c.config.Username)
	if err != nil {
		return nil, 0, err
	}
	if savedSession == nil {
		return nil, 0, fmt.Errorf("no saved session found")
	}
	valid, verifyErr := VerifySessionStatusContext(ctx, c.httpClient, c.config.APIURL, savedSession)
	if verifyErr != nil {
		return nil, 0, verifyErr
	}
	if !valid {
		return nil, 0, &SessionInvalidError{}
	}
	return savedSession, timeUntilExpiry, nil
}

// handleSessionRefresh attempts to refresh a session and save it if successful
func (c *Client) handleSessionRefresh(savedSession *api.Session, reason string) (*api.Session, error) {
	return c.handleSessionRefreshContext(context.Background(), savedSession, reason)
}

func (c *Client) handleSessionRefreshContext(ctx context.Context, savedSession *api.Session, reason string) (*api.Session, error) {
	return c.handleSessionRefreshWithGeneration(ctx, 0, savedSession, reason)
}

func (c *Client) handleSessionRefreshWithGeneration(ctx context.Context, generation uint64, savedSession *api.Session, reason string) (*api.Session, error) {
	ctx, err := normalizeAuthContext(ctx)
	if err != nil {
		return nil, err
	}
	if err := c.requireCurrentOperation(ctx, generation); err != nil {
		return nil, err
	}
	fmt.Println(reason)
	refreshedSession, err := RefreshSessionContext(ctx, c.httpClient, c.config.APIURL, savedSession)
	if err != nil {
		if errors.Is(err, context.Canceled) || IsTemporarySessionError(err) {
			fmt.Println("Could not refresh the saved Proton session temporarily; keeping it for a later retry.")
			return nil, err
		}
		if !IsSessionInvalid(err) {
			// A malformed local cache or protocol response is not proof that the
			// refresh token was revoked. Preserve the cache for diagnosis/retry.
			return nil, err
		}
		fmt.Println("Saved Proton session was rejected; re-authenticating with password...")
		fmt.Println("(Your trusted device status for MFA will be preserved)")
		if deleteErr := c.deleteSessionIfCurrent(ctx, generation, savedSession); deleteErr != nil {
			return nil, fmt.Errorf("failed to remove rejected saved session: %w", deleteErr)
		}
		return nil, nil
	}

	fmt.Println("Session refreshed successfully!")
	// Check if refresh token was rotated
	if savedSession.RefreshToken != refreshedSession.RefreshToken {
		fmt.Println("Refresh token was rotated")
	}

	// Save the refreshed session
	if err := c.saveSessionIfCurrent(ctx, generation, refreshedSession); err != nil {
		return nil, fmt.Errorf("failed to save refreshed session: %w", err)
	}

	return refreshedSession, nil
}

// tryExistingSession attempts to use an existing saved session
func (c *Client) tryExistingSession() (*api.Session, error) {
	return c.tryExistingSessionContext(context.Background())
}

func (c *Client) tryExistingSessionContext(ctx context.Context) (*api.Session, error) {
	return c.tryExistingSessionWithGeneration(ctx, 0)
}

func (c *Client) tryExistingSessionWithGeneration(ctx context.Context, generation uint64) (*api.Session, error) {
	ctx, err := normalizeAuthContext(ctx)
	if err != nil {
		return nil, err
	}
	if err := c.requireCurrentOperation(ctx, generation); err != nil {
		return nil, err
	}
	savedSession, timeUntilExpiry, err := c.sessionStore.LoadContext(ctx, c.config.Username)
	if err != nil {
		fmt.Printf("Warning: Failed to load saved session: %v\n", err)
		return nil, err
	}

	if savedSession == nil {
		return nil, nil
	}

	// Determine what to do with the saved session
	if c.config.ForceRefresh {
		reason := fmt.Sprintf("Forcing session refresh (current session expires in %s)", timeutil.HumanizeDuration(timeUntilExpiry))
		return c.handleSessionRefreshWithGeneration(ctx, generation, savedSession, reason)
	}
	if timeUntilExpiry < time.Duration(constants.SessionRefreshDays)*24*time.Hour && timeUntilExpiry > 0 {
		reason := fmt.Sprintf("Session expires soon (in %s), attempting refresh...", timeutil.HumanizeDuration(timeUntilExpiry))
		return c.handleSessionRefreshWithGeneration(ctx, generation, savedSession, reason)
	}

	valid, verifyErr := VerifySessionStatusContext(ctx, c.httpClient, c.config.APIURL, savedSession)
	if verifyErr != nil {
		if IsSessionInvalid(verifyErr) {
			fmt.Println("Saved session invalid, re-authenticating...")
			if err := c.deleteSessionIfCurrent(ctx, generation, savedSession); err != nil {
				return nil, fmt.Errorf("failed to remove invalid saved session: %w", err)
			}
			return nil, nil
		}
		if IsTemporarySessionError(verifyErr) {
			fmt.Println("Could not verify the saved Proton session because the network is temporarily unavailable; keeping it for a later retry.")
		}
		return nil, verifyErr
	}
	if valid {
		if err := c.requireCurrentOperation(ctx, generation); err != nil {
			return nil, err
		}
		fmt.Printf("Using saved session (expires in %s)\n", timeutil.HumanizeDuration(timeUntilExpiry))
		return savedSession, nil
	}

	return nil, &ProtocolError{Operation: "session verification"}
}

// Authenticate performs the full authentication flow
func (c *Client) Authenticate() (*api.Session, error) {
	return c.AuthenticateContext(context.Background())
}

// AuthenticateContext performs authentication while honoring cancellation for
// all network requests. A canceled operation never falls through to a fresh
// login and never removes the cached session as if it had been revoked.
func (c *Client) AuthenticateContext(ctx context.Context) (*api.Session, error) {
	ctx, generation, finish, err := c.beginAuthentication(ctx)
	if err != nil {
		return nil, err
	}
	defer finish()
	if err := c.requireCurrentOperation(ctx, generation); err != nil {
		return nil, err
	}
	if err := c.ensureUsername(); err != nil {
		return nil, err
	}

	// Try existing session unless clearing or disabled
	session, err := c.handleExistingSessionWithGeneration(ctx, generation)
	if err != nil {
		return nil, err
	}
	if session != nil {
		if err := c.requireCurrentOperation(ctx, generation); err != nil {
			return nil, err
		}
		// A cached session may be valid for the account API but still lack the
		// VPN scope. Re-run the same 2FA upgrade used after fresh login before
		// handing it to certificate/configuration operations.
		hadVPNScope, _ := c.checkSessionScopes(session)
		if err := c.upgradeSessionIfNeededContext(ctx, session); err != nil {
			return nil, err
		}
		if !hadVPNScope {
			if hasVPNScope, _ := c.checkSessionScopes(session); hasVPNScope {
				if err := c.saveSessionIfCurrent(ctx, generation, session); err != nil {
					return nil, fmt.Errorf("authenticated session could not be persisted: %w", err)
				}
			}
		}
		return session, nil
	}

	if err := c.ensurePassword(); err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	// Perform fresh authentication
	freshSession, err := c.performFreshAuthContext(ctx)
	if err != nil {
		return nil, err
	}

	// Handle session scope upgrade if needed
	if err := c.upgradeSessionIfNeededContext(ctx, freshSession); err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	if err := c.saveSessionIfCurrent(ctx, generation, freshSession); err != nil {
		return nil, fmt.Errorf("authentication succeeded but session persistence failed: %w", err)
	}
	return freshSession, nil
}

// handleExistingSession handles session clearing or reuse
func (c *Client) handleExistingSession() (*api.Session, error) {
	return c.handleExistingSessionContext(context.Background())
}

func (c *Client) handleExistingSessionContext(ctx context.Context) (*api.Session, error) {
	return c.handleExistingSessionWithGeneration(ctx, 0)
}

func (c *Client) handleExistingSessionWithGeneration(ctx context.Context, generation uint64) (*api.Session, error) {
	ctx, err := normalizeAuthContext(ctx)
	if err != nil {
		return nil, err
	}
	if c.config.ClearSession {
		fmt.Println("Clearing saved session...")
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if err := c.deleteSessionIfCurrent(ctx, generation, nil); err != nil {
			return nil, fmt.Errorf("failed to clear saved session: %w", err)
		}
		return nil, nil
	}

	if c.config.NoSession {
		return nil, nil
	}

	return c.tryExistingSessionWithGeneration(ctx, generation)
}

// performFreshAuth performs SRP authentication and returns a new session
func (c *Client) performFreshAuth() (*api.Session, error) {
	return c.performFreshAuthContext(context.Background())
}

func (c *Client) performFreshAuthContext(ctx context.Context) (*api.Session, error) {
	ctx, err := normalizeAuthContext(ctx)
	if err != nil {
		return nil, err
	}
	authInfo, err := c.getAuthInfoContext(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to get auth info: %w", err)
	}

	clientProofs, err := c.generateSRPProofs(authInfo)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	authReq := c.buildAuthRequest(authInfo, clientProofs)

	// Handle 2FA if needed
	if authInfo.TwoFA.Enabled == constants.EnabledTrue && authInfo.TwoFA.TOTP == constants.EnabledTrue {
		code := c.config.TwoFactorCode
		if code == "" {
			if c.config.JSONOutput {
				return nil, ErrTwoFactorRequired
			}
			var err error
			code, err = c.get2FACode()
			if err != nil {
				return nil, err
			}
		} else {
			code, err = validateTOTPCode(code)
			if err != nil {
				return nil, err
			}
		}
		authReq["TwoFactorCode"] = code
	}

	session, err := c.sendAuthRequestContext(ctx, authReq)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	// Verify server proof
	if session.ServerProof != base64.StdEncoding.EncodeToString(clientProofs.ExpectedServerProof) {
		return nil, fmt.Errorf("server proof verification failed")
	}

	return session, nil
}

// generateSRPProofs generates SRP client proofs for authentication
func (c *Client) generateSRPProofs(authInfo *api.AuthInfoResponse) (*srp.Proofs, error) {
	auth, err := srp.NewAuth(
		authInfo.Version,
		c.config.Username,
		[]byte(c.config.Password),
		authInfo.Salt,
		authInfo.Modulus,
		authInfo.ServerEphemeral,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create SRP auth: %w", err)
	}

	proofs, err := auth.GenerateProofs(2048)
	if err != nil {
		return nil, fmt.Errorf("failed to generate SRP proofs: %w", err)
	}
	return proofs, nil
}

// buildAuthRequest builds the authentication request payload
func (c *Client) buildAuthRequest(authInfo *api.AuthInfoResponse, proofs *srp.Proofs) map[string]any {
	return map[string]any{
		"Username":        c.config.Username,
		"ClientEphemeral": base64.StdEncoding.EncodeToString(proofs.ClientEphemeral),
		"ClientProof":     base64.StdEncoding.EncodeToString(proofs.ClientProof),
		"SRPSession":      authInfo.SRPSession,
	}
}

// upgradeSessionIfNeeded upgrades session with 2FA if VPN scope is missing
func (c *Client) upgradeSessionIfNeeded(session *api.Session) error {
	return c.upgradeSessionIfNeededContext(context.Background(), session)
}

func (c *Client) upgradeSessionIfNeededContext(ctx context.Context, session *api.Session) error {
	ctx, err := normalizeAuthContext(ctx)
	if err != nil {
		return err
	}
	hasVPNScope, hasTwoFactorScope := c.checkSessionScopes(session)

	if hasVPNScope || !hasTwoFactorScope {
		return nil
	}

	code := c.config.TwoFactorCode
	if code == "" {
		if c.config.JSONOutput {
			return ErrTwoFactorRequired
		}
		fmt.Println("Session lacks VPN scope - 2FA verification required to upgrade session...")
		code, err = c.get2FACode()
		if err != nil {
			return fmt.Errorf("failed to get 2FA code: %w", err)
		}
	} else {
		code, err = validateTOTPCode(code)
		if err != nil {
			return err
		}
	}

	updatedScopes, err := c.submit2FAContext(ctx, session, code)
	if err != nil {
		return err
	}
	if !hasScope(updatedScopes, "vpn") {
		return &ProtocolError{Operation: "2FA scope upgrade"}
	}
	session.Scopes = updatedScopes
	fmt.Println("2FA verified - session upgraded with VPN scope")
	return nil
}

// checkSessionScopes checks if session has VPN and twofactor scopes
func (c *Client) checkSessionScopes(session *api.Session) (hasVPN, hasTwoFactor bool) {
	if session == nil {
		return false, false
	}
	for _, scope := range session.Scopes {
		switch scope {
		case "vpn":
			hasVPN = true
		case "twofactor":
			hasTwoFactor = true
		}
	}
	return
}

func hasScope(scopes []string, wanted string) bool {
	for _, scope := range scopes {
		if scope == wanted {
			return true
		}
	}
	return false
}

// saveSessionIfEnabled saves the session if persistence is enabled
func (c *Client) saveSessionIfEnabled(session *api.Session) error {
	return c.saveSessionIfEnabledContext(context.Background(), session)
}

func (c *Client) saveSessionIfEnabledContext(ctx context.Context, session *api.Session) error {
	if c.config.NoSession {
		return nil
	}

	sessionDuration, err := timeutil.ParseSessionDuration(c.config.SessionDuration)
	if err != nil {
		fmt.Printf("Warning: Invalid session duration, using default: %v\n", err)
		sessionDuration = 0
	}

	if err := c.sessionStore.SaveContext(ctx, session, c.config.Username, sessionDuration); err != nil {
		return err
	}
	return nil
}

func (c *Client) saveSessionIfCurrent(ctx context.Context, generation uint64, session *api.Session) error {
	c.commitMu.Lock()
	defer c.commitMu.Unlock()
	if err := c.requireCurrentOperation(ctx, generation); err != nil {
		return err
	}
	return c.saveSessionIfEnabledContext(ctx, session)
}

func (c *Client) deleteSessionIfCurrent(ctx context.Context, generation uint64, expected *api.Session) error {
	c.commitMu.Lock()
	defer c.commitMu.Unlock()
	if err := c.requireCurrentOperation(ctx, generation); err != nil {
		return err
	}
	if expected == nil {
		return c.sessionStore.DeleteContext(ctx)
	}
	return c.sessionStore.DeleteIfMatchesContext(ctx, expected)
}

func (c *Client) ensureUsername() error {
	if c.config.Username == "" {
		fmt.Print("Username (without @protonmail.com): ")
		reader := bufio.NewReader(os.Stdin)
		username, err := reader.ReadString('\n')
		if err != nil {
			return fmt.Errorf("error reading username: %w", err)
		}
		c.config.Username = strings.TrimSpace(username)
		if c.config.Username == "" {
			return fmt.Errorf("username cannot be empty")
		}
	}
	return nil
}

func (c *Client) ensurePassword() error {
	if c.config.Password == "" {
		const stdinFileDescriptor = 0
		fmt.Print("Password: ")
		passwordBytes, err := term.ReadPassword(stdinFileDescriptor)
		fmt.Println()
		if err != nil {
			return fmt.Errorf("error reading password: %w", err)
		}
		c.config.Password = string(passwordBytes)
	}
	return nil
}

func (c *Client) get2FACode() (string, error) {
	fmt.Print("2FA Code: ")
	reader := bufio.NewReader(os.Stdin)
	code, err := reader.ReadString('\n')
	if err != nil {
		return "", fmt.Errorf("error reading 2FA code: %w", err)
	}
	return validateTOTPCode(code)
}

func validateTOTPCode(code string) (string, error) {
	code = strings.TrimSpace(code)
	if code == "" {
		return "", fmt.Errorf("2FA code cannot be empty")
	}
	if len(code) != 6 {
		return "", fmt.Errorf("2FA code must contain exactly 6 digits")
	}
	for _, digit := range code {
		if digit < '0' || digit > '9' {
			return "", fmt.Errorf("2FA code must be numeric (TOTP only).\n" +
				"FIDO2/WebAuthn security keys are not supported.\n" +
				"Please ensure you have TOTP (authenticator app) configured as your 2FA method")
		}
	}
	return code, nil
}

func (c *Client) getAuthInfo() (*api.AuthInfoResponse, error) {
	return c.getAuthInfoContext(context.Background())
}

func (c *Client) getAuthInfoContext(ctx context.Context) (*api.AuthInfoResponse, error) {
	req, err := api.NewRequest(http.MethodPost, c.config.APIURL+constants.AuthInfoPath,
		map[string]any{"Username": c.config.Username}, nil)
	if err != nil {
		return nil, err
	}

	var authInfo api.AuthInfoResponse
	status, err := doAuthJSON(ctx, c.httpClient, req, "auth info", &authInfo)
	if err != nil {
		return nil, err
	}
	if isTemporaryHTTPStatus(status) {
		return nil, &TemporarySessionError{Err: fmt.Errorf("HTTP %d", status), Operation: "auth info"}
	}
	if status < 200 || status >= 300 {
		if authInfo.Code != 0 && !constants.IsSuccessCode(authInfo.Code) {
			return nil, newAuthenticationError(authInfo.Code)
		}
		return nil, &ProtocolError{Operation: "auth info", StatusCode: status}
	}

	if !constants.IsSuccessCode(authInfo.Code) {
		if authInfo.Code == 0 {
			return nil, &ProtocolError{Operation: "auth info", StatusCode: status}
		}
		return nil, newAuthenticationError(authInfo.Code)
	}

	// Validate required fields
	if authInfo.Version <= 0 || strings.TrimSpace(authInfo.Modulus) == "" ||
		strings.TrimSpace(authInfo.ServerEphemeral) == "" ||
		strings.TrimSpace(authInfo.Salt) == "" || strings.TrimSpace(authInfo.SRPSession) == "" {
		return nil, &ProtocolError{Operation: "auth info", StatusCode: status}
	}

	return &authInfo, nil
}

func (c *Client) sendAuthRequest(authReq map[string]any) (*api.Session, error) {
	return c.sendAuthRequestContext(context.Background(), authReq)
}

func (c *Client) sendAuthRequestContext(ctx context.Context, authReq map[string]any) (*api.Session, error) {
	req, err := api.NewRequest(http.MethodPost, c.config.APIURL+constants.AuthPath, authReq, nil)
	if err != nil {
		return nil, err
	}
	api.SetHumanVerification(req, c.config.HVToken, constants.HVMethodCaptcha)

	var session api.Session
	status, err := doAuthJSON(ctx, c.httpClient, req, "authentication", &session)
	if err != nil {
		return nil, err
	}
	if isTemporaryHTTPStatus(status) {
		return nil, &TemporarySessionError{Err: fmt.Errorf("HTTP %d", status), Operation: "authentication"}
	}
	if status < 200 || status >= 300 {
		if session.Code != 0 && !constants.IsSuccessCode(session.Code) {
			if session.Code == CodeCaptchaRequired {
				return nil, captchaError(&session, c.config.APIURL, c.config.HVToken != "")
			}
			return nil, newAuthenticationError(session.Code)
		}
		return nil, &ProtocolError{Operation: "authentication", StatusCode: status}
	}

	// Handle mailbox password request (2-password mode)
	// Code 10013 means the account uses legacy 2-password mode which requires a separate mailbox password
	// VPN doesn't need mailbox decryption, but the auth flow requires completing it
	if session.Code == CodeMailboxPasswordError {
		return nil, fmt.Errorf("your account uses legacy 2-password mode which is not supported.\n" +
			"Please switch to single-password mode:\n" +
			"  1. Go to account.proton.me\n" +
			"  2. Settings -> All settings -> Account and password -> Passwords\n" +
			"  3. Switch to 'One-password mode'\n" +
			"This is recommended by Proton for most users and is required for this tool")
	}

	if session.Code == CodeCaptchaRequired {
		return nil, captchaError(&session, c.config.APIURL, c.config.HVToken != "")
	}

	if !constants.IsSuccessCode(session.Code) {
		if session.Code == 0 {
			return nil, &ProtocolError{Operation: "authentication", StatusCode: status}
		}
		return nil, newAuthenticationError(session.Code)
	}
	if !sessionHasCredentials(&session) || session.ExpiresIn <= 0 {
		return nil, &ProtocolError{Operation: "authentication", StatusCode: status}
	}

	return &session, nil
}

// captchaError explains a 9001 response and points at the CAPTCHA widget for
// this API entry point.
//
// The widget emits "<challenge>:<solved-response>" (see sendToken in the page
// it serves), and that combined string is what the API accepts back. Replaying
// the bare challenge token just earns a fresh challenge.
func captchaError(session *api.Session, apiURL string, replayed bool) error {
	code := "CAPTCHA_REQUIRED"
	msg := "O Proton solicitou uma verificação de segurança."
	if replayed {
		code = "CAPTCHA_INVALID"
		msg = "A verificação de segurança expirou ou foi recusada. Resolva o novo CAPTCHA para tentar novamente."
	}
	challenge := session.Details.HumanVerificationToken
	if challenge == "" {
		return HumanVerificationError{Code: code, Retryable: true, Message: msg}
	}
	base, err := url.Parse(apiURL + constants.CaptchaPath)
	if err != nil {
		return HumanVerificationError{Code: code, Retryable: true, Message: msg}
	}
	q := base.Query()
	q.Set("Token", challenge)
	base.RawQuery = q.Encode()
	return HumanVerificationError{Code: code, CaptchaURL: base.String(), Retryable: true, Message: msg}
}

// submit2FA submits a 2FA code to upgrade the session with additional scopes (like VPN)
func (c *Client) submit2FA(session *api.Session, code string) ([]string, error) {
	return c.submit2FAContext(context.Background(), session, code)
}

func (c *Client) submit2FAContext(ctx context.Context, session *api.Session, code string) ([]string, error) {
	normalizedCode, err := validateTOTPCode(code)
	if err != nil {
		return nil, err
	}
	req, err := api.NewRequest(http.MethodPost, c.config.APIURL+constants.TwoFAPath,
		map[string]any{"TwoFactorCode": normalizedCode}, session)
	if err != nil {
		return nil, err
	}

	var twoFAResp struct {
		Code   int      `json:"Code"`
		Scopes []string `json:"Scopes"`
	}
	status, err := doAuthJSON(ctx, c.httpClient, req, "2FA", &twoFAResp)
	if err != nil {
		return nil, err
	}
	if isTemporaryHTTPStatus(status) {
		return nil, &TemporarySessionError{Err: fmt.Errorf("HTTP %d", status), Operation: "2FA"}
	}
	if status < 200 || status >= 300 {
		if twoFAResp.Code != 0 && !constants.IsSuccessCode(twoFAResp.Code) {
			return nil, &TwoFactorError{Code: twoFAResp.Code}
		}
		return nil, &ProtocolError{Operation: "2FA", StatusCode: status}
	}

	if !constants.IsSuccessCode(twoFAResp.Code) {
		if twoFAResp.Code == 0 {
			return nil, &ProtocolError{Operation: "2FA", StatusCode: status}
		}
		return nil, &TwoFactorError{Code: twoFAResp.Code}
	}
	if !hasScope(twoFAResp.Scopes, "vpn") {
		return nil, &ProtocolError{Operation: "2FA scope upgrade", StatusCode: status}
	}

	return twoFAResp.Scopes, nil
}
