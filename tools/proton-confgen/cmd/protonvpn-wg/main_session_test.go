package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"protonvpn-wg-confgen/internal/api"
	"protonvpn-wg-confgen/internal/auth"
	"protonvpn-wg-confgen/internal/config"
)

// A GUI decidia "deslogado" a partir de valid=false, entao uma falha temporaria
// de verificacao (rede/API) bloqueava o botao de ativar com o usuario ainda
// autenticado -- o relato de tres usuarios em 18/09 (#312, #316, #317). O codigo
// precisa distinguir os dois casos.
func TestSessionCheckResponseSeparatesTemporaryFailureFromInvalidSession(t *testing.T) {
	temporary := sessionCheckResponse(nil, &auth.TemporarySessionError{Operation: "check-session"}, "conta_teste", 0)
	if temporary["valid"] != false || temporary["success"] != false {
		t.Fatalf("falha temporaria marcada como valida: %v", temporary)
	}
	if temporary["code"] != "NETWORK_ERROR" {
		t.Fatalf("code = %v, want NETWORK_ERROR", temporary["code"])
	}
	if temporary["retryable"] != true {
		t.Fatalf("retryable = %v, want true", temporary["retryable"])
	}
	if message, _ := temporary["error"].(string); message == "" {
		t.Fatal("falha temporaria sem mensagem")
	}

	invalid := sessionCheckResponse(nil, errors.New("session expired"), "conta_teste", 0)
	if invalid["code"] != "INVALID_SESSION" {
		t.Fatalf("code = %v, want INVALID_SESSION", invalid["code"])
	}
	if invalid["retryable"] != false {
		t.Fatalf("retryable = %v, want false", invalid["retryable"])
	}

	// Sessao ausente sem erro tipado tambem e invalida, nunca temporaria.
	missing := sessionCheckResponse(nil, nil, "conta_teste", 0)
	if missing["code"] != "INVALID_SESSION" || missing["retryable"] != false {
		t.Fatalf("sessao ausente = %v, want INVALID_SESSION retryable=false", missing)
	}
}

// A Proton deixou de aceitar a versao do app (HTTP 422, Code 5003). Isso nao diz
// nada sobre o token: o -check-session precisa manter a sessao salva e marcar a
// falha como retryable, para a GUI nao deslogar o usuario nem bloquear a
// ativacao com o perfil ja gerado.
func TestCheckSessionReportsUnsupportedAppVersionAndKeepsSession(t *testing.T) {
	file := filepath.Join(t.TempDir(), "proton-session.json")
	saved := &api.Session{AccessToken: "access-teste", RefreshToken: "refresh-teste", UID: "uid-teste", ExpiresIn: 30 * 24 * 60 * 60}
	if err := auth.NewSessionStore(file).Save(saved, "conta_teste", 30*24*time.Hour); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnprocessableEntity)
		_, _ = fmt.Fprint(w, `{"Code":5003,"Error":"This version of the app is no longer supported"}`)
	}))
	defer server.Close()

	client := auth.NewClient(&config.Config{
		APIURL:       server.URL,
		Username:     "conta_teste",
		SessionFile:  file,
		CheckSession: true,
		JSONOutput:   true,
	})
	session, timeUntilExpiry, err := client.CheckSession()
	payload := sessionCheckResponse(session, err, "conta_teste", timeUntilExpiry)
	data, marshalErr := json.Marshal(payload)
	if marshalErr != nil {
		t.Fatalf("json.Marshal() error = %v", marshalErr)
	}
	t.Logf("-check-session JSON: %s", data)

	const want = `{"code":"APP_VERSION_UNSUPPORTED","error":"A Proton não aceita mais esta versão do GoLiveBypass","retryable":true,"success":false,"valid":false}`
	if string(data) != want {
		t.Fatalf("-check-session JSON = %s; want %s", data, want)
	}
	loaded, _, loadErr := auth.NewSessionStore(file).Load("conta_teste")
	if loadErr != nil || loaded == nil || loaded.AccessToken != "access-teste" || loaded.RefreshToken != "refresh-teste" {
		t.Fatalf("sessao salva depois da recusa = %#v, %v; want preservada", loaded, loadErr)
	}

	// O mesmo contrato vale para o erro embrulhado, sem afetar a classificacao
	// das outras falhas.
	wrapped := sessionCheckResponse(nil, fmt.Errorf("check: %w", &auth.AppVersionError{Code: auth.CodeAPIVersionInvalid}), "conta_teste", 0)
	if wrapped["code"] != "APP_VERSION_UNSUPPORTED" || wrapped["retryable"] != true || wrapped["valid"] != false {
		t.Fatalf("erro embrulhado = %v; want APP_VERSION_UNSUPPORTED retryable=true", wrapped)
	}
}

func TestSessionCheckResponseKeepsValidSessionContract(t *testing.T) {
	response := sessionCheckResponse(&api.Session{UID: "uid-teste"}, nil, "conta_teste", 90*time.Minute)
	if response["success"] != true || response["valid"] != true {
		t.Fatalf("sessao valida rejeitada: %v", response)
	}
	if response["username"] != "conta_teste" {
		t.Fatalf("username = %v, want conta_teste", response["username"])
	}
	if response["expiresIn"] != "1h30m0s" {
		t.Fatalf("expiresIn = %v, want 1h30m0s", response["expiresIn"])
	}
	// O contrato de sucesso nao carrega segredo: apenas identidade e validade.
	for _, leaked := range []string{"AccessToken", "RefreshToken", "PrivateKey"} {
		if _, ok := response[leaked]; ok {
			t.Fatalf("resposta expoe %s", leaked)
		}
	}
}
