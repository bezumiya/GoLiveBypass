package auth

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"protonvpn-wg-confgen/internal/api"
	"protonvpn-wg-confgen/internal/constants"
)

// SessionStore handles persistent session storage
type SessionStore struct {
	filePath string
}

// NewSessionStore creates a new session store
func NewSessionStore(customPath string) *SessionStore {
	if customPath != "" {
		return &SessionStore{filePath: customPath}
	}
	homeDir, err := os.UserHomeDir()
	if err != nil {
		// Fallback to current directory
		homeDir = "."
	}

	return &SessionStore{
		filePath: filepath.Join(homeDir, constants.SessionFileName),
	}
}

// SavedSession represents a session with metadata
type SavedSession struct {
	Session   *api.Session `json:"session"`
	Username  string       `json:"username"`
	SavedAt   time.Time    `json:"saved_at"`
	ExpiresAt time.Time    `json:"expires_at"`
}

const encryptedSessionHeader = "GoLiveBypass-DPAPI-Session-v1\n"
const maxSessionFileBytes int64 = 1 << 20
const maxRefreshResponseBytes int64 = 1 << 20
const maxSessionVerificationResponseBytes int64 = 256 << 10

// sealSessionPayload protects the on-disk representation when the helper is
// running inside the Windows plugin. Other platforms keep the historical
// owner-only file format because their standalone clients do not have a
// portable OS keychain contract; the plugin itself is Windows x64 only.
func sealSessionPayload(payload []byte) ([]byte, error) {
	if !sessionStorageUsesEncryption() {
		return append([]byte(nil), payload...), nil
	}
	ciphertext, err := protectSessionBytes(payload)
	if err != nil {
		return nil, err
	}
	sealed := make([]byte, 0, len(encryptedSessionHeader)+len(ciphertext))
	sealed = append(sealed, encryptedSessionHeader...)
	sealed = append(sealed, ciphertext...)
	return sealed, nil
}

func openSessionPayload(raw []byte) (payload []byte, encrypted bool, err error) {
	if !bytes.HasPrefix(raw, []byte(encryptedSessionHeader)) {
		return append([]byte(nil), raw...), false, nil
	}
	if !sessionStorageUsesEncryption() {
		return nil, true, fmt.Errorf("encrypted Proton session requires the Windows plugin helper")
	}
	payload, err = unprotectSessionBytes(raw[len(encryptedSessionHeader):])
	return payload, true, err
}

func (s *SessionStore) validateStorageDirectory() error {
	directory := filepath.Dir(s.filePath)
	info, err := os.Lstat(directory)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return fmt.Errorf("session directory is not a regular directory")
	}
	return nil
}

func (s *SessionStore) ensureStorageDirectory() error {
	directory := filepath.Dir(s.filePath)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return fmt.Errorf("failed to create session directory: %w", err)
	}
	if err := s.validateStorageDirectory(); err != nil {
		return err
	}
	if !sessionStorageUsesEncryption() {
		if err := os.Chmod(directory, 0o700); err != nil {
			return fmt.Errorf("failed to protect session directory: %w", err)
		}
	}
	return nil
}

func (s *SessionStore) validateSessionTarget() error {
	info, err := os.Lstat(s.filePath)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return fmt.Errorf("session file is not a regular file")
	}
	if info.Size() > maxSessionFileBytes {
		return fmt.Errorf("session file exceeds the permitted size")
	}
	return nil
}

func sessionHasCredentials(session *api.Session) bool {
	return session != nil && strings.TrimSpace(session.AccessToken) != "" && strings.TrimSpace(session.UID) != ""
}

func sameSession(a, b *api.Session) bool {
	return a != nil && b != nil && a.AccessToken == b.AccessToken && a.RefreshToken == b.RefreshToken && a.UID == b.UID
}

// Save stores the session to disk
func (s *SessionStore) Save(session *api.Session, username string, duration time.Duration) error {
	return s.SaveContext(context.Background(), session, username, duration)
}

// SaveContext persists a session while honoring cancellation while acquiring
// the cross-process cache lock.
func (s *SessionStore) SaveContext(ctx context.Context, session *api.Session, username string, duration time.Duration) error {
	ctx, err := normalizeAuthContext(ctx)
	if err != nil {
		return err
	}
	if session == nil {
		return fmt.Errorf("cannot save a nil session")
	}
	if strings.TrimSpace(username) == "" || !sessionHasCredentials(session) || session.ExpiresIn <= 0 {
		return fmt.Errorf("cannot save an incomplete session")
	}
	if duration < 0 {
		return fmt.Errorf("session duration cannot be negative")
	}
	if err := s.ensureStorageDirectory(); err != nil {
		return err
	}

	return s.withSessionLockContext(ctx, func() error {
		if err := s.validateStorageDirectory(); err != nil {
			return err
		}
		if err := s.validateSessionTarget(); err != nil {
			return err
		}
		savedSession := &SavedSession{
			Session:  session,
			Username: username,
			SavedAt:  time.Now(),
		}

		// Calculate expiration based on API response.
		apiExpiration := time.Now().Add(time.Duration(session.ExpiresIn) * time.Second)

		if duration == 0 {
			// Use the API's expiration.
			savedSession.ExpiresAt = apiExpiration
		} else {
			// Use the user-specified duration, but cap it at API expiration.
			userExpiration := time.Now().Add(duration)
			if userExpiration.After(apiExpiration) {
				savedSession.ExpiresAt = apiExpiration
			} else {
				savedSession.ExpiresAt = userExpiration
			}
		}

		data, err := json.MarshalIndent(savedSession, "", "  ")
		if err != nil {
			return fmt.Errorf("failed to marshal session: %w", err)
		}
		defer clear(data)
		protected, err := sealSessionPayload(data)
		if err != nil {
			return fmt.Errorf("failed to protect session: %w", err)
		}
		defer clear(protected)
		return s.writeAtomic(protected)
	})
}

func (s *SessionStore) writeAtomic(data []byte) error {
	if err := s.validateStorageDirectory(); err != nil {
		return fmt.Errorf("failed to access session directory: %w", err)
	}
	if err := s.validateSessionTarget(); err != nil {
		return fmt.Errorf("failed to access session file: %w", err)
	}
	tmp, err := os.CreateTemp(filepath.Dir(s.filePath), ".protonvpn-session-*.tmp")
	if err != nil {
		return fmt.Errorf("failed to create temporary session file: %w", err)
	}
	tmpPath := tmp.Name()
	defer func() { _ = os.Remove(tmpPath) }()
	if err = tmp.Chmod(constants.SessionFileMode); err == nil {
		_, err = tmp.Write(data)
	}
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return fmt.Errorf("failed to write session file: %w", err)
	}
	if err = replaceSessionFile(tmpPath, s.filePath); err != nil {
		return fmt.Errorf("failed to commit session file: %w", err)
	}

	return nil
}

// readPayload obtains the session lock for callers that only need a snapshot.
// Compound operations such as Load and DeleteIfMatches use readPayloadLocked
// so the comparison and mutation happen under the same lock.
func (s *SessionStore) readPayload() ([]byte, error) {
	return s.readPayloadContext(context.Background())
}

func (s *SessionStore) readPayloadContext(ctx context.Context) ([]byte, error) {
	var payload []byte
	err := s.withSessionLockContext(ctx, func() error {
		var err error
		payload, err = s.readPayloadLocked()
		return err
	})
	return payload, err
}

func (s *SessionStore) readPayloadLocked() ([]byte, error) {
	if err := s.validateStorageDirectory(); err != nil {
		return nil, err
	}
	if err := s.validateSessionTarget(); err != nil {
		return nil, err
	}
	file, err := os.Open(s.filePath)
	if err != nil {
		return nil, err
	}
	defer func() { _ = file.Close() }()
	if size, statErr := file.Stat(); statErr != nil {
		return nil, statErr
	} else if !size.Mode().IsRegular() || size.Size() > maxSessionFileBytes {
		return nil, fmt.Errorf("session file exceeds the permitted size")
	}
	raw, err := io.ReadAll(io.LimitReader(file, maxSessionFileBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(raw)) > maxSessionFileBytes {
		clear(raw)
		return nil, fmt.Errorf("session file exceeds the permitted size")
	}
	payload, encrypted, err := openSessionPayload(raw)
	clear(raw)
	if err != nil {
		return nil, fmt.Errorf("failed to decrypt session file: %w", err)
	}
	if !encrypted && sessionStorageUsesEncryption() {
		// Migrate the old private JSON format as soon as it is successfully
		// read. A DPAPI failure cannot silently fall back to plaintext.
		protected, protectErr := sealSessionPayload(payload)
		if protectErr != nil {
			clear(payload)
			return nil, fmt.Errorf("failed to migrate session file: %w", protectErr)
		}
		writeErr := s.writeAtomic(protected)
		clear(protected)
		if writeErr != nil {
			clear(payload)
			return nil, fmt.Errorf("failed to migrate session file: %w", writeErr)
		}
	}
	return payload, nil
}

// Username returns the cached account identity without exposing session tokens.
func (s *SessionStore) Username() (string, error) {
	return s.UsernameContext(context.Background())
}

func (s *SessionStore) UsernameContext(ctx context.Context) (string, error) {
	var username string
	err := s.withSessionLockContext(ctx, func() error {
		data, err := s.readPayloadLocked()
		if err != nil {
			return err
		}
		var saved SavedSession
		if err := json.Unmarshal(data, &saved); err != nil {
			clear(data)
			return fmt.Errorf("failed to unmarshal session: %w", err)
		}
		clear(data)
		if strings.TrimSpace(saved.Username) == "" || !sessionHasCredentials(saved.Session) {
			return fmt.Errorf("saved session is incomplete")
		}
		username = strings.TrimSpace(saved.Username)
		return nil
	})
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", err
	}
	return username, nil
}

// Load retrieves a saved session from disk
func (s *SessionStore) Load(username string) (*api.Session, time.Duration, error) {
	return s.LoadContext(context.Background(), username)
}

func (s *SessionStore) LoadContext(ctx context.Context, username string) (*api.Session, time.Duration, error) {
	var loaded *api.Session
	var timeUntilExpiry time.Duration
	err := s.withSessionLockContext(ctx, func() error {
		data, err := s.readPayloadLocked()
		if err != nil {
			return err
		}

		var savedSession SavedSession
		err = json.Unmarshal(data, &savedSession)
		clear(data)
		if err != nil {
			return fmt.Errorf("failed to unmarshal session: %w", err)
		}

		// Proton usernames are account identifiers rather than case-sensitive
		// secrets. Treat capitalization and incidental surrounding whitespace as
		// equivalent so a valid cached session is reused after a UI edit.
		if !strings.EqualFold(strings.TrimSpace(savedSession.Username), strings.TrimSpace(username)) {
			return nil
		}
		if !sessionHasCredentials(savedSession.Session) {
			return nil
		}

		// Check if session has expired.
		now := time.Now()
		if !now.Before(savedSession.ExpiresAt) {
			// The read and delete are one locked operation, so a newer Save cannot
			// be removed between the comparison and the unlink.
			if err := s.deleteLocked(); err != nil {
				return fmt.Errorf("failed to remove expired session: %w", err)
			}
			return nil
		}

		loaded = savedSession.Session
		timeUntilExpiry = savedSession.ExpiresAt.Sub(now)
		return nil
	})
	if err != nil {
		if os.IsNotExist(err) {
			return nil, 0, nil // No saved session
		}
		return nil, 0, fmt.Errorf("failed to read session file: %w", err)
	}
	return loaded, timeUntilExpiry, nil
}

// Delete removes the saved session
func (s *SessionStore) Delete() error {
	return s.DeleteContext(context.Background())
}

func (s *SessionStore) DeleteContext(ctx context.Context) error {
	err := s.withSessionLockContext(ctx, s.deleteLocked)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

func (s *SessionStore) deleteLocked() error {
	if err := s.validateStorageDirectory(); err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("failed to access session directory: %w", err)
	}
	info, err := os.Lstat(s.filePath)
	if os.IsNotExist(err) {
		return s.removeTemporaryFilesLocked()
	}
	if err != nil {
		return fmt.Errorf("failed to inspect session file: %w", err)
	}
	if !info.Mode().IsRegular() && info.Mode()&os.ModeSymlink == 0 {
		return fmt.Errorf("session file is not a regular file")
	}
	err = os.Remove(s.filePath)
	if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("failed to delete session file: %w", err)
	}
	return s.removeTemporaryFilesLocked()
}

func (s *SessionStore) removeTemporaryFilesLocked() error {
	entries, err := os.ReadDir(filepath.Dir(s.filePath))
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("failed to inspect temporary session files: %w", err)
	}
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), ".protonvpn-session-") || !strings.HasSuffix(entry.Name(), ".tmp") {
			continue
		}
		info, infoErr := entry.Info()
		if infoErr != nil || !info.Mode().IsRegular() {
			continue
		}
		if err := os.Remove(filepath.Join(filepath.Dir(s.filePath), entry.Name())); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("failed to delete temporary session file: %w", err)
		}
	}
	return nil
}

// DeleteIfMatches removes the cache only when it still contains the session
// observed by the caller. This prevents a failed refresh in one helper process
// from deleting a newer session saved by another process.
func (s *SessionStore) DeleteIfMatches(expected *api.Session) error {
	return s.DeleteIfMatchesContext(context.Background(), expected)
}

func (s *SessionStore) DeleteIfMatchesContext(ctx context.Context, expected *api.Session) error {
	if expected == nil {
		return fmt.Errorf("cannot compare a nil session")
	}
	err := s.withSessionLockContext(ctx, func() error {
		data, err := s.readPayloadLocked()
		if err != nil {
			if os.IsNotExist(err) {
				return nil
			}
			return err
		}
		var saved SavedSession
		err = json.Unmarshal(data, &saved)
		clear(data)
		if err != nil {
			return fmt.Errorf("failed to unmarshal session: %w", err)
		}
		if !sameSession(expected, saved.Session) {
			return nil
		}
		return s.deleteLocked()
	})
	if os.IsNotExist(err) {
		return nil
	}
	return err
}

// RefreshSession attempts to refresh the session using the refresh token.
// It returns a new session with updated tokens if successful.
func RefreshSession(httpClient *http.Client, apiURL string, oldSession *api.Session) (*api.Session, error) {
	return RefreshSessionContext(context.Background(), httpClient, apiURL, oldSession)
}

// RefreshSessionContext is the cancellable refresh operation. Only an
// explicit Proton rejection is considered evidence that the cached session is
// invalid; transport, timeout and malformed responses preserve it.
func RefreshSessionContext(ctx context.Context, httpClient *http.Client, apiURL string, oldSession *api.Session) (*api.Session, error) {
	ctx, err := normalizeAuthContext(ctx)
	if err != nil {
		return nil, err
	}
	if !sessionHasCredentials(oldSession) || strings.TrimSpace(oldSession.RefreshToken) == "" {
		return nil, &ProtocolError{Operation: "session refresh"}
	}

	// Based on proton-python-client/proton/api.py refresh() method
	reqBody := map[string]any{
		"ResponseType": "token",
		"GrantType":    "refresh_token",
		"RefreshToken": oldSession.RefreshToken,
		"RedirectURI":  "http://protonmail.ch",
	}

	req, err := api.NewRequest(http.MethodPost, apiURL+constants.RefreshPath, reqBody, oldSession)
	if err != nil {
		return nil, err
	}
	req = req.WithContext(ctx)

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, classifyAuthTransportError(ctx, err)
	}
	defer func() { _ = resp.Body.Close() }()

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxRefreshResponseBytes+1))
	if err != nil {
		clear(body)
		return nil, classifyAuthTransportError(ctx, err)
	}
	defer clear(body)
	if int64(len(body)) > maxRefreshResponseBytes {
		return nil, &ProtocolError{Operation: "session refresh", StatusCode: resp.StatusCode}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	// A gateway/rate-limit response is not evidence that the refresh token is
	// invalid. Keep the cache so a later attempt can retry it.
	if resp.StatusCode == http.StatusRequestTimeout || resp.StatusCode == http.StatusTooEarly || resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500 {
		return nil, &TemporarySessionError{Err: fmt.Errorf("HTTP %d", resp.StatusCode), Operation: "session refresh"}
	}

	var session api.Session
	decodeErr := json.Unmarshal(body, &session)

	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		// HTTP authentication rejection is sufficient evidence of an invalid
		// cached session even when a gateway returns an empty/non-JSON body.
		// Do not echo that body and do not let its shape decide whether the
		// caller may re-authenticate.
		if decodeErr == nil && session.Code != 0 && !constants.IsSuccessCode(session.Code) {
			return nil, &SessionInvalidError{Code: session.Code, StatusCode: resp.StatusCode}
		}
		return nil, &SessionInvalidError{StatusCode: resp.StatusCode}
	}

	if decodeErr != nil {
		return nil, &ProtocolError{Operation: "session refresh", StatusCode: resp.StatusCode}
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		if session.Code != 0 && !constants.IsSuccessCode(session.Code) {
			return nil, &SessionInvalidError{Code: session.Code, StatusCode: resp.StatusCode}
		}
		return nil, &TemporarySessionError{Err: fmt.Errorf("HTTP %d", resp.StatusCode), Operation: "session refresh"}
	}

	// A non-success code means the refresh token is spent; re-authentication follows.
	if !constants.IsSuccessCode(session.Code) {
		if session.Code == 0 {
			return nil, &ProtocolError{Operation: "session refresh", StatusCode: resp.StatusCode}
		}
		return nil, &SessionInvalidError{Code: session.Code, StatusCode: resp.StatusCode}
	}
	if strings.TrimSpace(session.AccessToken) == "" || strings.TrimSpace(session.UID) == "" || session.ExpiresIn <= 0 {
		return nil, &ProtocolError{Operation: "session refresh", StatusCode: resp.StatusCode}
	}
	if strings.TrimSpace(session.RefreshToken) == "" {
		// Proton may rotate the refresh token, but an omitted field is not the
		// same as an explicit rotation to an empty token.
		session.RefreshToken = oldSession.RefreshToken
	}

	return &session, nil
}

// VerifySessionStatus checks a saved session without conflating a temporary
// transport failure with a revoked credential. The distinction matters because
// callers must not delete a still-valid session merely because the network is
// unavailable.
func VerifySessionStatus(httpClient *http.Client, apiURL string, session *api.Session) (valid bool, temporaryErr error) {
	return VerifySessionStatusContext(context.Background(), httpClient, apiURL, session)
}

// VerifySessionStatusContext is the cancellable form of session verification.
func VerifySessionStatusContext(ctx context.Context, httpClient *http.Client, apiURL string, session *api.Session) (valid bool, statusErr error) {
	ctx, err := normalizeAuthContext(ctx)
	if err != nil {
		return false, err
	}
	if !sessionHasCredentials(session) {
		return false, nil
	}

	// Make a simple request to verify the session. This one inspects the status
	// code and a bounded Proton result envelope directly, so it does not use
	// api.Do's unbounded body/error handling.
	req, err := api.NewRequest(http.MethodGet, apiURL+constants.LogicalsPath, nil, session)
	if err != nil {
		return false, err
	}
	req = req.WithContext(ctx)

	resp, err := httpClient.Do(req)
	if err != nil {
		return false, classifyAuthTransportError(ctx, err)
	}
	defer func() { _ = resp.Body.Close() }()

	// If we get a 401/403, the session is invalid. Other non-2xx responses are
	// kept as temporary failures because a gateway or rate limiter can produce
	// them without saying anything about the token.
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return false, &SessionInvalidError{StatusCode: resp.StatusCode}
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return false, &TemporarySessionError{Err: fmt.Errorf("HTTP %d", resp.StatusCode), Operation: "session verification"}
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxSessionVerificationResponseBytes+1))
	if err != nil {
		clear(body)
		return false, classifyAuthTransportError(ctx, err)
	}
	defer clear(body)
	if int64(len(body)) > maxSessionVerificationResponseBytes {
		return false, &ProtocolError{Operation: "session verification", StatusCode: resp.StatusCode}
	}
	if err := ctx.Err(); err != nil {
		return false, err
	}
	if len(bytes.TrimSpace(body)) == 0 {
		// Some API-compatible test/proxy endpoints return no body. The successful
		// HTTP status is sufficient in that case.
		return true, nil
	}
	var envelope struct {
		Code *int `json:"Code"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		return false, &ProtocolError{Operation: "session verification", StatusCode: resp.StatusCode}
	}
	if envelope.Code == nil {
		return false, &ProtocolError{Operation: "session verification", StatusCode: resp.StatusCode}
	}
	if constants.IsSuccessCode(*envelope.Code) {
		return true, nil
	}
	return false, &SessionInvalidError{Code: *envelope.Code, StatusCode: resp.StatusCode}
}

// VerifySession is retained for callers that only need a boolean result.
func VerifySession(httpClient *http.Client, apiURL string, session *api.Session) bool {
	valid, _ := VerifySessionStatus(httpClient, apiURL, session)
	return valid
}
