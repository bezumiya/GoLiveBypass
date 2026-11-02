package bugreport

import (
	"fmt"
	"strings"
	"testing"
)

func TestValidateTitle(t *testing.T) {
	long := strings.Repeat("a", MaxTitleLen+1)

	tests := []struct {
		name    string
		title   string
		wantErr bool
	}{
		{"titulo normal", "Go Live não sobe", false},
		{"titulo no limite", strings.Repeat("a", MaxTitleLen), false},
		{"titulo vazio", "", true},
		{"titulo so espacos", "   \t ", true},
		{"titulo longo", long, true},
		// O limite e em caracteres, como no formulario: 200 letras acentuadas
		// passam de 200 bytes e ainda assim cabem.
		{"titulo acentuado no limite", strings.Repeat("ã", MaxTitleLen), false},
		{"titulo com emoji no limite", strings.Repeat("🎮", MaxTitleLen), false},
		{"titulo acentuado longo", strings.Repeat("ã", MaxTitleLen+1), true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rep := &Report{Title: tt.title, Meta: map[string]string{}}
			err := rep.Validate(262144)
			if (err != nil) != tt.wantErr {
				t.Fatalf("Validate() error = %v, wantErr = %v", err, tt.wantErr)
			}
		})
	}
}

func TestValidateTrimsTitle(t *testing.T) {
	rep := &Report{Title: "  título com espaço  "}
	if err := rep.Validate(262144); err != nil {
		t.Fatalf("Validate() error = %v", err)
	}
	if rep.Title != "título com espaço" {
		t.Errorf("Title = %q, nao foi feito trim", rep.Title)
	}
}

func TestValidateDescriptionTooLong(t *testing.T) {
	rep := &Report{Title: "t", Description: strings.Repeat("a", MaxDescriptionLen+1)}
	if err := rep.Validate(262144); err == nil {
		t.Fatal("Validate() esperava erro com descricao longa")
	}
}

func TestValidateDescriptionAcentuadaNoLimite(t *testing.T) {
	rep := &Report{Title: "t", Description: strings.Repeat("é", MaxDescriptionLen)}
	if err := rep.Validate(262144); err != nil {
		t.Fatalf("Validate() error = %v, descricao no limite em caracteres deveria passar", err)
	}
	rep = &Report{Title: "t", Description: strings.Repeat("é", MaxDescriptionLen+1)}
	if err := rep.Validate(262144); err == nil {
		t.Fatal("Validate() esperava erro com descricao acima do limite em caracteres")
	}
}

func TestValidateMeta(t *testing.T) {
	campos := func(n, tamanhoValor int) map[string]string {
		m := make(map[string]string, n)
		for i := range n {
			m[fmt.Sprintf("k%02d", i)] = strings.Repeat("v", tamanhoValor)
		}
		return m
	}
	tests := []struct {
		name    string
		meta    map[string]string
		wantErr bool
	}{
		{"meta tipico", map[string]string{"versao": "2.0.13", "plataforma": "win32-x64"}, false},
		{"campos no limite", campos(MaxMetaKeys, 10), false},
		{"campos demais", campos(MaxMetaKeys+1, 1), true},
		{"bytes no limite", map[string]string{"k": strings.Repeat("v", MaxMetaBytes-1)}, false},
		{"bytes demais", map[string]string{"k": strings.Repeat("v", MaxMetaBytes)}, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rep := &Report{Title: "t", Meta: tt.meta}
			if err := rep.Validate(262144); (err != nil) != tt.wantErr {
				t.Fatalf("Validate() error = %v, wantErr = %v", err, tt.wantErr)
			}
		})
	}
}

func TestBuildIssueBodyPiorCasoCabeNoGitHub(t *testing.T) {
	// Pior caso que Validate deixa passar: descricao no limite com runes de 4 bytes e
	// meta no teto feito de "|" (o escape da tabela dobra). Tem de caber sem depender
	// do corte do log.
	meta := make(map[string]string, MaxMetaKeys)
	porCampo := MaxMetaBytes / MaxMetaKeys
	for i := range MaxMetaKeys {
		k := fmt.Sprintf("%02d", i)
		meta[k] = strings.Repeat("|", porCampo-len(k))
	}
	rep := &Report{Title: "t", Description: strings.Repeat("🎮", MaxDescriptionLen), Meta: meta}
	body := BuildIssueBody(*rep)
	if len(body) > MaxIssueBodyLen {
		t.Fatalf("body com %d bytes, limite %d", len(body), MaxIssueBodyLen)
	}
}

func TestValidateTruncatesLog(t *testing.T) {
	rep := &Report{Title: "t", Log: strings.Repeat("x", 1024)}
	if err := rep.Validate(100); err != nil {
		t.Fatalf("Validate() error = %v", err)
	}
	if len(rep.Log) != 100 {
		t.Errorf("Log com %d bytes, want 100", len(rep.Log))
	}
}

func TestBuildIssueBodyCompleto(t *testing.T) {
	rep := Report{
		Title:       "t",
		Description: "passo 1\npasso 2",
		Log:         "linha1\n```\nlinha2",
		Meta:        map[string]string{"os": "linux x64", "app": "golive-gui", "zebra": "com | pipe"},
	}
	body := BuildIssueBody(rep)
	for _, want := range []string{
		"**Sistema:**",
		"| app | golive-gui |",
		"| os | linux x64 |\n| zebra | com \\| pipe |",
		"**Descrição:**",
		"passo 1\npasso 2",
		"**Log:**",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("corpo sem %q", want)
		}
	}
	if !strings.Contains(body, logFence) {
		t.Error("corpo sem fence de log")
	}
}

func TestBuildIssueBodyLogComFenceInterno(t *testing.T) {
	// Qualquer sequencia de crases do log (3, 4, 5, 8) fica dentro de uma cerca
	// maior, sem alterar o conteudo: nada do log escapa para o Markdown da issue.
	for _, n := range []int{3, 4, 5, 8} {
		crases := strings.Repeat("`", n)
		log := "inicio\n" + crases + "\n[link](https://exemplo.invalid)\nmeio ``` fim"
		body := BuildIssueBody(Report{Title: "t", Log: log})
		fence := strings.Repeat("`", max(len(logFence), n+1))
		want := "**Log:**\n\n" + fence + "\n" + log + "\n" + fence + "\n"
		if !strings.HasSuffix(body, want) {
			t.Errorf("log com %d crases: corpo %q, want sufixo %q", n, body, want)
		}
	}
}

func TestBuildIssueBodyVazio(t *testing.T) {
	body := BuildIssueBody(Report{Title: "t"})
	if !strings.Contains(body, "API de bug reports") {
		t.Errorf("corpo minimo sem cabecalho: %q", body)
	}
	if strings.Contains(body, "**Sistema:**") || strings.Contains(body, "**Log:**") {
		t.Errorf("secoes vazias nao deveriam aparecer: %q", body)
	}
}

func TestBuildIssueBodyTruncaLogNoLimiteDoGitHub(t *testing.T) {
	// Log gigante (o que a GUI manda com logs completos) — o body montado precisa
	// caber em MaxIssueBodyLen (64KB), senao o GitHub recusa com 422.
	logGrande := strings.Repeat("linha de log de diagnostico\n", 20_000)
	rep := Report{
		Title:       "t",
		Description: "descricao do bug",
		Log:         "=== sessao GUI (inicio do diagnostico) ===\n" + logGrande + "=== fim do log (eventos recentes) ===",
		Meta:        map[string]string{"os": "linux", "versao": "1.1.6"},
	}
	body := BuildIssueBody(rep)
	if len(body) > MaxIssueBodyLen {
		t.Fatalf("body com %d bytes, limite %d — GitHub recusaria", len(body), MaxIssueBodyLen)
	}
	// O que importa foi preservado: cabecalho, meta e descricao intactos.
	for _, want := range []string{"**Sistema:**", "| os | linux |", "**Descrição:**", "descricao do bug"} {
		if !strings.Contains(body, want) {
			t.Errorf("corpo truncado perdeu %q", want)
		}
	}
	// Head+tail: o INICIO do log (deteccao) e o FIM (eventos recentes) sobrevivem.
	if !strings.Contains(body, "=== sessao GUI (inicio do diagnostico) ===") {
		t.Error("inicio do log foi perdido — deveria preservar head+tail")
	}
	if !strings.Contains(body, "=== fim do log (eventos recentes) ===") {
		t.Error("fim do log foi perdido")
	}
	// E o log foi cortado no meio com o marcador e o fence fechado.
	if !strings.Contains(body, "[... log truncado no meio ...]") {
		t.Error("marcador de truncamento ausente")
	}
	if !strings.HasSuffix(body, "\n"+logFence+"\n") {
		t.Error("fence final nao foi fechado apos truncar")
	}
}
