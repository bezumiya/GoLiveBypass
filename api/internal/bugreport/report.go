package bugreport

import (
	"fmt"
	"sort"
	"strings"
	"unicode/utf8"
)

const (
	MaxTitleLen       = 200
	MaxDescriptionLen = 8 * 1024
	// O GitHub recusa issues com body > 64KB (limite da API REST). O body montado
	// aqui (meta + descricao + log) precisa caber — corta-se o LOG por ultimo,
	// preservando meta e descricao que sao o diagnostico essencial.
	MaxIssueBodyLen = 64 * 1024
	// Meta e uma tabela pequena de diagnostico (os clientes mandam ~35 campos curtos,
	// 1-2 KB). Sem teto, meta + descricao passavam de MaxIssueBodyLen e o GitHub
	// recusava a issue. 8 KB, mesmo com o escape de "|" dobrando, deixa folga.
	MaxMetaKeys  = 64
	MaxMetaBytes = 8 * 1024
	// Cerca minima do log; cresce quando o log traz uma sequencia de crases maior.
	logFence = "````"
)

type Report struct {
	Title       string            `json:"title"`
	Description string            `json:"description"`
	Log         string            `json:"log"`
	Meta        map[string]string `json:"meta"`
}

func (r *Report) Validate(maxLogBytes int64) error {
	r.Title = strings.TrimSpace(r.Title)
	switch {
	case r.Title == "":
		return fmt.Errorf("title e obrigatorio")
	// Os clientes limitam em caracteres (maxlength/slice do JS); len() contaria
	// bytes e recusaria um titulo acentuado que o formulario deixou passar.
	case utf8.RuneCountInString(r.Title) > MaxTitleLen:
		return fmt.Errorf("title deve ter no maximo %d caracteres", MaxTitleLen)
	}
	if utf8.RuneCountInString(r.Description) > MaxDescriptionLen {
		return fmt.Errorf("description deve ter no maximo %d caracteres", MaxDescriptionLen)
	}
	if len(r.Meta) > MaxMetaKeys {
		return fmt.Errorf("meta deve ter no maximo %d campos", MaxMetaKeys)
	}
	metaBytes := 0
	for k, v := range r.Meta {
		metaBytes += len(k) + len(v)
	}
	if metaBytes > MaxMetaBytes {
		return fmt.Errorf("meta deve ter no maximo %d bytes", MaxMetaBytes)
	}
	if int64(len(r.Log)) > maxLogBytes {
		r.Log = r.Log[:maxLogBytes]
	}
	return nil
}

func BuildIssueBody(r Report) string {
	var b strings.Builder
	b.WriteString("Relato enviado pela API de bug reports.\n\n")

	if len(r.Meta) > 0 {
		b.WriteString("**Sistema:**\n\n| | |\n|---|---|\n")
		keys := make([]string, 0, len(r.Meta))
		for k := range r.Meta {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			fmt.Fprintf(&b, "| %s | %s |\n", tableCell(k), tableCell(r.Meta[k]))
		}
		b.WriteString("\n")
	}

	if d := strings.TrimSpace(r.Description); d != "" {
		b.WriteString("**Descrição:**\n\n")
		b.WriteString(d)
		b.WriteString("\n\n")
	}

	if l := r.Log; l != "" {
		log := l
		// Uma cerca so fecha com uma linha de crases do mesmo tamanho ou maior; uma
		// cerca mais longa que qualquer sequencia do log nunca fecha no meio dele.
		fence := logFence
		if n := maiorSequenciaDeCrases(log); n >= len(fence) {
			fence = strings.Repeat("`", n+1)
		}
		prefixo := b.String()
		fenceBloco := "\n" + fence + "\n"
		const marcador = "\n[... log truncado no meio ...]\n"
		// "**Log:**\n\n" + fence aberto + log + fence fechado — inclui o \n inicial
		// e reserva espaco para o marcador de truncamento.
		baseLen := len(prefixo) + len("\n**Log:**\n\n") + len(fence) + len(fenceBloco) + len(marcador)
		sobra := MaxIssueBodyLen - baseLen
		if sobra < 0 {
			sobra = 0
		}
		if len(log) > sobra {
			// Truncamento head+tail: preserva o INICIO (secoes de deteccao/installs,
			// o trace da GUI) e o FIM (eventos recentes do gateway), cortando o meio.
			// Cortar so o fim perdia exatamente o diagnostico de "nao achou o Vesktop".
			cabeca := sobra / 2
			cauda := sobra - cabeca

			// Cabeca: ate a ultima quebra de linha dentro da cota.
			if nova := strings.LastIndexByte(log[:cabeca], '\n'); nova > 0 {
				cabeca = nova + 1
			}
			// Cauda: a partir da primeira quebra de linha dentro da cota (nao
			// comeca no meio de uma linha).
			inicioCauda := len(log) - cauda
			if nova := strings.IndexByte(log[inicioCauda:], '\n'); nova >= 0 {
				inicioCauda += nova + 1
			}
			log = log[:cabeca] + marcador + log[inicioCauda:]
		}
		b.WriteString("**Log:**\n\n")
		b.WriteString(fence + "\n")
		b.WriteString(log)
		b.WriteString(fenceBloco)
	}
	return b.String()
}

func maiorSequenciaDeCrases(s string) int {
	maior, atual := 0, 0
	for i := 0; i < len(s); i++ {
		if s[i] == '`' {
			atual++
			maior = max(maior, atual)
		} else {
			atual = 0
		}
	}
	return maior
}

func tableCell(s string) string {
	return strings.NewReplacer("|", "\\|", "\n", " ").Replace(s)
}
