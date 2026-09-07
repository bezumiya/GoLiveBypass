// Command proton-captcha-helper is a process-isolated, synthetic Proton
// confgen fixture for GUI E2E tests. It never contacts Proton or emits a real
// WireGuard credential.
package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const syntheticPassword = "e2e-password"

type config struct {
	CaseID           string `json:"caseId"`
	Scenario         string `json:"scenario"`
	ExpectedUsername string `json:"expectedUsername"`
}

type state struct {
	CaseID             string   `json:"caseId"`
	Scenario           string   `json:"scenario"`
	Calls              int      `json:"calls"`
	InitialCalls       int      `json:"initialCalls"`
	VerificationCalls  int      `json:"verificationCalls"`
	CheckSessionCalls  int      `json:"checkSessionCalls"`
	GenerateCalls      int      `json:"generateCalls"`
	StatusCalls        int      `json:"statusCalls"`
	ProbeCalls         int      `json:"probeCalls"`
	Challenges         []string `json:"challenges,omitempty"`
	TokenMatches       []bool   `json:"tokenMatches,omitempty"`
	LastUsername       string   `json:"lastUsername,omitempty"`
	SessionSaved       bool     `json:"sessionSaved"`
	Challenge1Resolved bool     `json:"challenge1Resolved"`
	LastError          string   `json:"lastError,omitempty"`
}

func main() {
	cfg, statePath, err := loadConfig()
	if err != nil {
		fail(err)
		return
	}
	args, err := parseArgs(os.Args[1:])
	if err != nil {
		fail(err)
		return
	}
	unlock, err := acquireStateLock(statePath)
	if err != nil {
		fail(err)
		return
	}
	defer unlock()
	st := state{CaseID: cfg.CaseID, Scenario: cfg.Scenario}
	_ = readJSON(statePath, &st)
	st.CaseID, st.Scenario = cfg.CaseID, cfg.Scenario
	st.Calls++
	st.LastUsername = args.username
	if err := appendCall(statePath, args); err != nil {
		fail(err)
		return
	}

	var response any
	switch {
	case args.routeProbe:
		st.ProbeCalls++
		response = map[string]any{"success": true, "observations": []any{}, "discordOk": true}
	case args.status:
		st.StatusCalls++
		response = map[string]any{"success": true, "status": "ready", "synthetic": true}
	case args.checkSession:
		st.CheckSessionCalls++
		response = checkSession(args, cfg, &st)
	case args.loginOnly:
		response = login(args, cfg, &st)
	default:
		st.GenerateCalls++
		response = generate(args, cfg)
	}

	if err := writeJSONAtomic(statePath, &st); err != nil {
		fail(err)
		return
	}
	if args.json {
		_ = json.NewEncoder(os.Stdout).Encode(response)
	} else {
		_ = json.NewEncoder(os.Stdout).Encode(response)
	}
}

type cliArgs struct {
	username, password, hvToken, sessionFile, output  string
	countries                                         string
	json, loginOnly, checkSession, routeProbe, status bool
}

func parseArgs(raw []string) (cliArgs, error) {
	var a cliArgs
	fs := flag.NewFlagSet("proton-captcha-helper", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	fs.StringVar(&a.username, "username", "", "")
	fs.StringVar(&a.password, "password", "", "")
	fs.StringVar(&a.hvToken, "hv-token", "", "")
	fs.StringVar(&a.sessionFile, "session-file", "", "")
	fs.StringVar(&a.output, "output", "protonvpn.conf", "")
	fs.StringVar(&a.countries, "countries", "", "")
	fs.BoolVar(&a.json, "json", false, "")
	fs.BoolVar(&a.loginOnly, "login-only", false, "")
	fs.BoolVar(&a.checkSession, "check-session", false, "")
	fs.BoolVar(&a.routeProbe, "route-probe", false, "")
	fs.BoolVar(&a.status, "status", false, "")
	// These flags are passed by the real GUI during generation.
	var ignored bool
	fs.BoolVar(&ignored, "ipv6", false, "")
	fs.BoolVar(&ignored, "auto-ping", false, "")
	fs.BoolVar(&ignored, "free-only", false, "")
	fs.BoolVar(&ignored, "speed-test", false, "")
	fs.BoolVar(&ignored, "no-save", false, "")
	var ignoredString string
	fs.StringVar(&ignoredString, "exclude-countries", "", "")
	if err := fs.Parse(raw); err != nil {
		return a, err
	}
	if len(fs.Args()) != 0 {
		return a, fmt.Errorf("unsupported positional argument: %s", fs.Args()[0])
	}
	if a.loginOnly && a.checkSession || a.routeProbe && (a.loginOnly || a.checkSession) {
		return a, errors.New("conflicting helper commands")
	}
	return a, nil
}

func loadConfig() (config, string, error) {
	path := os.Getenv("GOLIVE_CAPTCHA_E2E_CONFIG")
	statePath := os.Getenv("GOLIVE_CAPTCHA_E2E_STATE")
	if path == "" || statePath == "" {
		return config{}, "", errors.New("GOLIVE_CAPTCHA_E2E_CONFIG and GOLIVE_CAPTCHA_E2E_STATE are required")
	}
	var cfg config
	if err := readJSON(path, &cfg); err != nil {
		return cfg, statePath, fmt.Errorf("read fixture config: %w", err)
	}
	if cfg.CaseID == "" || cfg.ExpectedUsername == "" {
		return cfg, statePath, errors.New("fixture config requires caseId and expectedUsername")
	}
	if cfg.Scenario != "success" && cfg.Scenario != "retry" {
		return cfg, statePath, fmt.Errorf("unsupported fixture scenario %q (want success or retry)", cfg.Scenario)
	}
	return cfg, statePath, nil
}

func login(a cliArgs, cfg config, st *state) map[string]any {
	if a.username != cfg.ExpectedUsername || a.password != syntheticPassword {
		st.LastError = "INVALID_CREDENTIALS"
		return map[string]any{"success": false, "code": "INVALID_CREDENTIALS", "error": "synthetic credentials rejected", "retryable": false}
	}
	token1 := "e2e-" + cfg.CaseID + "-1:e2e-answer"
	token2 := "e2e-" + cfg.CaseID + "-2:e2e-answer"
	if a.hvToken == "" {
		st.InitialCalls++
		st.Challenges = append(st.Challenges, "e2e-"+cfg.CaseID+"-1")
		return captcha("CAPTCHA_REQUIRED", "e2e-"+cfg.CaseID+"-1")
	}
	st.VerificationCalls++
	challenge1Issued := contains(st.Challenges, "e2e-"+cfg.CaseID+"-1")
	challenge2Issued := contains(st.Challenges, "e2e-"+cfg.CaseID+"-2")
	match := !st.SessionSaved && ((a.hvToken == token1 && challenge1Issued && !challenge2Issued && !st.Challenge1Resolved) ||
		(a.hvToken == token2 && cfg.Scenario == "retry" && challenge2Issued && st.Challenge1Resolved))
	st.TokenMatches = append(st.TokenMatches, match)
	if !match {
		st.LastError = "CAPTCHA_INVALID"
		challenge := "e2e-" + cfg.CaseID + "-1"
		if challenge2Issued {
			challenge = "e2e-" + cfg.CaseID + "-2"
		}
		return map[string]any{"success": false, "code": "CAPTCHA_INVALID", "error": "synthetic token rejected", "retryable": true, "captchaUrl": "https://vpn-api.proton.me/core/v4/captcha?Token=" + challenge}
	}
	if a.hvToken == token1 {
		st.Challenge1Resolved = true
	}
	if cfg.Scenario == "retry" && a.hvToken == token1 {
		st.Challenges = append(st.Challenges, "e2e-"+cfg.CaseID+"-2")
		st.LastError = "CAPTCHA_INVALID"
		return captcha("CAPTCHA_INVALID", "e2e-"+cfg.CaseID+"-2")
	}
	if a.sessionFile == "" {
		return map[string]any{"success": false, "code": "SESSION_PERSISTENCE", "error": "session-file is required", "retryable": false}
	}
	if err := writeJSONAtomic(a.sessionFile, map[string]any{"username": cfg.ExpectedUsername, "synthetic": true, "expires_at": time.Now().Add(24 * time.Hour).UTC()}); err != nil {
		return map[string]any{"success": false, "code": "SESSION_PERSISTENCE", "error": err.Error(), "retryable": false}
	}
	st.SessionSaved = true
	st.LastError = ""
	return map[string]any{"success": true, "username": cfg.ExpectedUsername, "message": "Synthetic authentication completed."}
}

func captcha(code, challenge string) map[string]any {
	return map[string]any{"success": false, "code": code, "error": "synthetic CAPTCHA required", "retryable": true, "captchaUrl": "https://vpn-api.proton.me/core/v4/captcha?Token=" + challenge}
}

func checkSession(a cliArgs, cfg config, st *state) map[string]any {
	var session struct {
		Username  string `json:"username"`
		Synthetic bool   `json:"synthetic"`
	}
	if a.username == cfg.ExpectedUsername && readJSON(a.sessionFile, &session) == nil && session.Username == cfg.ExpectedUsername && session.Synthetic {
		return map[string]any{"valid": true, "username": cfg.ExpectedUsername, "expiresIn": "24h"}
	}
	return map[string]any{"valid": false, "error": "synthetic session missing or invalid"}
}

func generate(a cliArgs, cfg config) map[string]any {
	if a.username != cfg.ExpectedUsername {
		return map[string]any{"success": false, "error": "synthetic username rejected"}
	}
	if a.output == "" {
		return map[string]any{"success": false, "error": "output is required"}
	}
	content := "# TESTONLY synthetic fixture; unusable WireGuard configuration\n[Interface]\nPrivateKey = TESTONLY\n[Peer]\nPublicKey = TESTONLY\nEndpoint = e2e.invalid:51820\nAllowedIPs = 0.0.0.0/0\n"
	if err := writeFileAtomic(a.output, []byte(content)); err != nil {
		return map[string]any{"success": false, "error": err.Error()}
	}
	return map[string]any{"success": true, "server": "E2E-TESTONLY-1", "country": "ZZ", "city": "Synthetic", "tier": "free", "load": 1, "score": 1, "pingMs": 1, "endpoint": "e2e.invalid:51820", "synthetic": true}
}

func readJSON(path string, dst any) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, dst)
}

func writeJSONAtomic(path string, value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(path, append(data, '\n'))
}

func writeFileAtomic(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".e2e-atomic-")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if _, err = tmp.Write(data); err == nil {
		err = tmp.Chmod(0600)
	}
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}

func acquireStateLock(statePath string) (func(), error) {
	if err := os.MkdirAll(filepath.Dir(statePath), 0755); err != nil {
		return nil, fmt.Errorf("create fixture state directory: %w", err)
	}
	lockPath := statePath + ".lock"
	for attempt := 0; attempt < 10000; attempt++ {
		f, err := os.OpenFile(lockPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err == nil {
			_ = f.Close()
			return func() { _ = os.Remove(lockPath) }, nil
		}
		if !errors.Is(err, os.ErrExist) {
			return nil, fmt.Errorf("create fixture state lock: %w", err)
		}
		runtime.Gosched()
	}
	return nil, errors.New("fixture state lock contention")
}

func appendCall(statePath string, a cliArgs) error {
	path := statePath + ".calls.ndjson"
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0600)
	if err != nil {
		return fmt.Errorf("open fixture call log: %w", err)
	}
	defer f.Close()
	row := strings.Join([]string{
		`{"pid":` + strconv.Itoa(os.Getpid()),
		`"username":` + strconv.Quote(a.username),
		`"hvToken":` + strconv.Quote(a.hvToken),
		`"loginOnly":` + strconv.FormatBool(a.loginOnly),
		`"checkSession":` + strconv.FormatBool(a.checkSession),
		`"routeProbe":` + strconv.FormatBool(a.routeProbe),
		`"status":` + strconv.FormatBool(a.status) + `}`,
	}, ",")
	_, err = f.WriteString(row + "\n")
	return err
}

func contains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func fail(err error) { fmt.Fprintln(os.Stderr, err); os.Exit(2) }
