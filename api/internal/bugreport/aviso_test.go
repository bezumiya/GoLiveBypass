package bugreport

import (
	"strings"
	"testing"
)

var avisosPorNome = map[string]string{
	"windows": avisoGUIWindows,
	"linux":   avisoGUILinux,
	"plugin":  avisoPlugin,
}

func nomeDoAviso(aviso string) string {
	if aviso == "" {
		return "nenhum"
	}
	for nome, texto := range avisosPorNome {
		if texto == aviso {
			return nome
		}
	}
	return "desconhecido"
}

func TestOutdatedClientNotice(t *testing.T) {
	// Linhas como as do #474: GUI 2.0.13 presa num update pendente, com 5003 a cada login.
	const logComPendente = "=== sessao GUI (ring buffer) ===\n" +
		"[18:51:15] [info][app] iniciado | versao=2.0.13 plataforma=win32\n" +
		"[18:51:18] [info][updater] update pendente recuperado: 2.0.18\n" +
		"[18:51:33] [warn][proton] falha na autenticação ProtonVPN | codigo_saida=1 erro_json=authentication failed with code: 5003"
	const logSemPendente = "=== sessao GUI (ring buffer) ===\n" +
		"[18:51:15] [info][app] iniciado | versao=2.0.13 plataforma=win32\n" +
		"[18:51:33] [warn][proton] falha na autenticação ProtonVPN | codigo_saida=1 erro_json=authentication failed with code: 5003"

	gui := func(versao, plataforma string) map[string]string {
		return map[string]string{"versao": versao, "plataforma": plataforma, "locale": "pt-BR", "modoRoteamento": "wireguard"}
	}
	plugin := func(versao, plataforma string) map[string]string {
		return map[string]string{"app": "golive-plugin", "versao": versao, "plataforma": plataforma, "vpn_modo": "proton"}
	}
	// O cliente macOS manda a versão do macOS em "macos" e não manda "app".
	mac := func(versao string) map[string]string {
		return map[string]string{"versao": versao, "plataforma": "darwin-arm64", "macos": "15.1", "modoRoteamento": "wireguard-split-ip"}
	}

	tests := []struct {
		name string
		meta map[string]string
		log  string
		want string // nome do aviso esperado; "" = corpo sem aviso
	}{
		{"GUI Windows 2.0.13 com update pendente", gui("2.0.13", "win32-x64"), logComPendente, "windows"},
		{"GUI Windows 2.0.13 sem a linha do update pendente", gui("2.0.13", "win32-x64"), logSemPendente, "windows"},
		{"GUI Windows 2.0.13 sem log", gui("2.0.13", "win32-x64"), "", "windows"},
		{"GUI Windows 2.0.17-beta-4, ultima sem a correcao", gui("2.0.17-beta-4", "win32-x64"), "", "windows"},
		{"GUI Windows 2.0.0, primeira com login Proton", gui("2.0.0", "win32-x64"), "", "windows"},
		{"GUI Windows ARM 2.0.16", gui("2.0.16", "win32-arm64"), "", "windows"},
		{"GUI Linux 2.0.15", gui("2.0.15", "linux-x64"), logSemPendente, "linux"},
		{"GUI Windows 2.0.17 ja corrigida", gui("2.0.17", "win32-x64"), "", ""},
		{"GUI Windows 2.0.19", gui("2.0.19", "win32-x64"), logComPendente, ""},
		{"GUI Linux 2.0.19", gui("2.0.19", "linux-x64"), "", ""},
		{"GUI 1.x, proxy legado sem login Proton", gui("1.1.11", "win32-x64"), "", ""},
		{"GUI antiga no macOS (2.x)", gui("2.0.13", "darwin-arm64"), "", ""},
		// O cliente macOS fica de fora: só a 0.9.0 em diante manda relato, já corrigida.
		{"macOS 0.8.0 (nao manda relato, mas se mandasse)", mac("0.8.0"), "", ""},
		{"macOS 0.9.0, primeira com relato", mac("0.9.0"), "", ""},
		{"plugin Windows 2.0.16", plugin("2.0.16", "win32-x64"), "", "plugin"},
		{"plugin Linux 2.0.17-beta-1", plugin("2.0.17-beta-1", "linux-x64"), "", "plugin"},
		{"plugin 2.0.17", plugin("2.0.17", "win32-x64"), "", ""},
		{"plugin 2.0.19", plugin("2.0.19", "linux-x64"), "", ""},
		{"plugin sem versao legivel", plugin("unknown", "win32-x64"), "", ""},
		{"plugin com versao desconhecida", plugin("desconhecida", "linux-x64"), "", ""},
		{"outro app com versao antiga", map[string]string{"app": "cli", "versao": "2.0.13", "plataforma": "linux-x64"}, "", ""},
		{"standalone Windows", map[string]string{"versao": "standalone", "plataforma": "win32-AMD64"}, "", ""},
		{"versao incompleta", gui("2.0", "win32-x64"), "", ""},
		{"versao lixo", gui("dois.zero.treze", "linux-x64"), "", ""},
		{"versao com texto junto", gui("2.0.13 (portable)", "win32-x64"), "", ""},
		{"versao vazia", gui("", "win32-x64"), "", ""},
		{"sem versao", map[string]string{"plataforma": "win32-x64"}, "", ""},
		{"sem plataforma", map[string]string{"versao": "2.0.13"}, "", ""},
		{"sem meta (standalone Linux)", nil, "", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rep := Report{Title: "t", Description: "Não consigo entrar na conta Proton", Log: tt.log, Meta: tt.meta}
			aviso := OutdatedClientNotice(rep.Meta)
			want := tt.want
			if want == "" {
				want = "nenhum"
			}
			if got := nomeDoAviso(aviso); got != want {
				t.Fatalf("aviso = %s, want %s", got, want)
			}

			// O resto do corpo sai byte a byte igual ao de sempre.
			corpo := BuildIssueBodyWithNotice(rep, aviso)
			semAviso := BuildIssueBody(rep)
			wantCorpo := semAviso
			if aviso != "" {
				wantCorpo = aviso + separadorDoAviso + semAviso
			}
			if corpo != wantCorpo {
				t.Errorf("corpo =\n%s\nwant\n%s", corpo, wantCorpo)
			}
		})
	}
}

func TestAvisosCurtosEComOCaminhoDeSaida(t *testing.T) {
	const titulo = "**Esta versão do GoLiveBypass não consegue mais entrar na conta Proton (código 5003).**\n"
	const ultimaVersao = "https://github.com/bezumiya/GoLiveBypass/releases/latest"
	tests := []struct {
		nome   string
		contem []string
	}{
		{"windows", []string{"2.0.17", "botão direito", `"^"`, "**Reiniciar para atualizar**", "**Checar updates**", "segunda volta", "**Sair**", ultimaVersao}},
		{"linux", []string{"2.0.17", "**Avisar sobre atualizações**", "**Reiniciar agora**", "**Reiniciar para atualizar**", "AppImage", ultimaVersao}},
		{"plugin", []string{"2.0.17", "**Atualizações do GoLiveBypass**", "**Verificar**", "**Atualizar**", "feche o Discord", "(https://github.com/bezumiya/GoLiveBypass#instalação-do-plugin-recomendado-para-equicord-vencord-e-vesktop)"}},
	}
	for _, tt := range tests {
		t.Run(tt.nome, func(t *testing.T) {
			aviso := avisosPorNome[tt.nome]
			if !strings.HasPrefix(aviso, titulo) {
				t.Fatalf("aviso nao comeca pela linha em negrito: %q", aviso)
			}
			linhas := 0
			for _, linha := range strings.Split(aviso, "\n") {
				if strings.TrimSpace(linha) != "" {
					linhas++
				}
			}
			if linhas < 3 || linhas > 6 {
				t.Errorf("aviso com %d linhas, want 3 a 6", linhas)
			}
			// Markdown simples: sem HTML, e o separador do corpo e quem fecha o bloco.
			if strings.ContainsAny(aviso, "<>") || strings.HasSuffix(aviso, "\n") {
				t.Errorf("aviso com HTML ou quebra no fim: %q", aviso)
			}
			for _, want := range tt.contem {
				if !strings.Contains(aviso, want) {
					t.Errorf("aviso sem %q", want)
				}
			}
		})
	}
}

func TestAvisoComLogGrandeCabeNoLimiteDoGitHub(t *testing.T) {
	// O relato da GUI costuma chegar no teto (o #474 tinha 65.378 bytes): o aviso posto na
	// frente do corpo pronto passaria dos 64 KB e o GitHub recusaria a issue com 422.
	rep := Report{
		Title:       "t",
		Description: "descricao do bug",
		Log: "=== sessao GUI (ring buffer) ===\n[18:51:18] [info][updater] update pendente recuperado: 2.0.18\n" +
			strings.Repeat("linha de log de diagnostico\n", 20_000) + "=== fim do log (eventos recentes) ===",
		Meta: map[string]string{"versao": "2.0.13", "plataforma": "win32-x64"},
	}
	aviso := OutdatedClientNotice(rep.Meta)
	if aviso == "" {
		t.Fatal("GUI 2.0.13 no Windows deveria receber o aviso")
	}
	semAviso := BuildIssueBody(rep)
	if ingenuo := len(aviso) + len(separadorDoAviso) + len(semAviso); ingenuo <= MaxIssueBodyLen {
		t.Fatalf("o cenario nao exercita o corte: aviso + corpo = %d bytes", ingenuo)
	}

	corpo := BuildIssueBodyWithNotice(rep, aviso)
	if len(corpo) > MaxIssueBodyLen {
		t.Fatalf("body com %d bytes, limite %d — GitHub recusaria", len(corpo), MaxIssueBodyLen)
	}
	if !strings.HasPrefix(corpo, aviso+separadorDoAviso+"Relato enviado pela API de bug reports.\n\n") {
		t.Error("aviso nao ficou no topo, antes do cabecalho do relato")
	}
	for _, want := range []string{
		"| plataforma | win32-x64 |", "| versao | 2.0.13 |", "descricao do bug",
		"update pendente recuperado: 2.0.18", "[... log truncado no meio ...]", "=== fim do log (eventos recentes) ===",
	} {
		if !strings.Contains(corpo, want) {
			t.Errorf("corpo truncado perdeu %q", want)
		}
	}
	if !strings.HasSuffix(corpo, "\n"+logFence+"\n") {
		t.Error("fence final nao foi fechado apos truncar")
	}
}
