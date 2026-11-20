// Resumo que abre o log do relato de bug. O log inteiro tem teto (~52KB na issue) e e cortado
// pelo comeco; este bloco vem antes e nunca e cortado, entao a ativacao, o erro que a pessoa viu e
// o servidor escolhido continuam no relato mesmo quando a sessao foi longa. Tudo sai das linhas
// que ja estao no log (e ja passam pela redacao do relato): nada novo e coletado aqui.

const RESUMO_MAX_BYTES = 4 * 1024;
const LINHA_MAX = 240;
const MAX_OPERACOES = 8;
const MAX_ATIVACAO = 4;
const MAX_TELA = 5;
const MAX_AVISOS = 8;

interface LinhaDoLog {
  stamp: string;
  nivel: "info" | "warn" | "error";
  cat: string;
  msg: string; // evento + " | k=v ..." (pode terminar com o sufixo de repeticao "(xN...)")
  evento: string;
  dados: string;
  texto: string;
}

const FORMATO = /^\[((?:\d{2}-\d{2} )?\d{2}:\d{2}:\d{2})\] \[(info|warn|error)\]\[([^\]]+)\] (.*)$/;

function analisar(linha: string): LinhaDoLog | null {
  const m = FORMATO.exec(linha);
  if (!m) return null;
  const msg = m[4];
  const corte = msg.indexOf(" | ");
  return {
    stamp: m[1],
    nivel: m[2] as LinhaDoLog["nivel"],
    cat: m[3],
    msg,
    evento: (corte >= 0 ? msg.slice(0, corte) : msg).replace(/ \(x\d+.*\)$/, "").trim(),
    dados: corte >= 0 ? msg.slice(corte + 3) : "",
    texto: linha,
  };
}

function campo(dados: string, chave: string): string | undefined {
  const m = new RegExp(`(?:^| )${chave}=(\\S+)`).exec(dados);
  return m?.[1];
}

function curta(texto: string, max = LINHA_MAX): string {
  return texto.length > max ? `${texto.slice(0, max)}…` : texto;
}

function segundos(ms: string | undefined): string {
  const n = Number(ms);
  return Number.isFinite(n) ? `${Math.round(n / 100) / 10}s` : "?";
}

const EVENTO_ATIVACAO =
  /^(activation\.(completed|failed)|ativacao[._ ]|preflight concluido|readiness\.complete|relaunch\.|linux\.network\.(ready|failed)|ativacao duplicada)/;
const EVENTO_SERVIDOR = /^servidor ótimo selecionado/;
const EVENTO_TELA = "erro.exibido";

/**
 * Monta o bloco de resumo a partir das linhas do log (mais antiga -> mais recente).
 * `agora` e o carimbo do envio no mesmo formato das linhas.
 */
export function montarResumo(texto: string, agora: string): string {
  const linhas = texto.split("\n").map(analisar).filter((l): l is LinhaDoLog => l !== null);
  const saida: string[] = ["=== resumo ===", `relato enviado em ${agora}`];

  // Operacoes serializadas (ativar, desativar, trocar rota, login...) com resultado e duracao.
  const operacoes: string[] = [];
  let pendente: LinhaDoLog | null = null;
  for (const l of linhas) {
    if (l.evento === "inicio de operacao serializada") pendente = l;
    else if (l.evento === "fim de operacao serializada") {
      const op = campo(l.dados, "operation") ?? "?";
      const resultado = campo(l.dados, "resultado");
      const duracao = campo(l.dados, "duracao_ms");
      operacoes.push(`  [${l.stamp}] ${op}${resultado ? ` ${resultado}` : ""}${duracao ? ` em ${segundos(duracao)}` : ""}`);
      if (pendente && campo(pendente.dados, "operation") === op) pendente = null;
    }
  }
  if (pendente) operacoes.push(`  [${pendente.stamp}] ${campo(pendente.dados, "operation") ?? "?"} em andamento`);
  if (operacoes.length) saida.push("operacoes:", ...operacoes.slice(-MAX_OPERACOES));

  const ativacao = linhas.filter((l) => EVENTO_ATIVACAO.test(l.evento)).slice(-MAX_ATIVACAO);
  if (ativacao.length) saida.push("ativacao:", ...ativacao.map((l) => `  ${curta(l.texto)}`));

  const servidor = [...linhas].reverse().find((l) => EVENTO_SERVIDOR.test(l.evento));
  if (servidor) {
    const nome = campo(servidor.dados, "server") ?? "?";
    const ping = campo(servidor.dados, "ping");
    saida.push(`servidor escolhido: ${nome}${ping ? ` (ping ${ping}ms)` : ""} em ${servidor.stamp}`);
  }

  const tela = linhas.filter((l) => l.evento === EVENTO_TELA).slice(-MAX_TELA);
  if (tela.length) saida.push("erros mostrados na tela:", ...tela.map((l) => `  ${curta(l.texto)}`));

  // Avisos e erros restantes: o mais recente de cada evento, com quantas vezes apareceu.
  const jaMostradas = new Set([...ativacao, ...tela].map((l) => l.texto));
  const porEvento = new Map<string, { linha: LinhaDoLog; vezes: number }>();
  for (const l of linhas) {
    if (l.nivel === "info" || jaMostradas.has(l.texto)) continue;
    const chave = `${l.cat}|${l.evento}`;
    const anterior = porEvento.get(chave);
    porEvento.delete(chave); // reinsere no fim: a ordem do Map vira "mais recente por ultimo"
    porEvento.set(chave, { linha: l, vezes: (anterior?.vezes ?? 0) + 1 });
  }
  const avisos = [...porEvento.values()].slice(-MAX_AVISOS);
  if (avisos.length) {
    saida.push("avisos e erros (ultimo de cada tipo):");
    for (const { linha, vezes } of avisos) saida.push(`  ${curta(linha.texto)}${vezes > 1 ? ` [${vezes}x no log]` : ""}`);
  }

  if (saida.length === 2) saida.push("(nenhuma operacao, aviso ou erro no log)");
  return cortarResumo(saida.join("\n"));
}

function cortarResumo(texto: string): string {
  if (Buffer.byteLength(texto, "utf8") <= RESUMO_MAX_BYTES) return texto;
  const buf = Buffer.from(texto, "utf8").subarray(0, RESUMO_MAX_BYTES);
  const corte = buf.lastIndexOf(10);
  return `${buf.subarray(0, corte > 0 ? corte : buf.length).toString("utf8")}\n[resumo cortado]`;
}

/**
 * O que a tela recebeu de uma acao que falhou: a mensagem de `{ success: false }` ou o texto da
 * excecao que o IPC devolveu. Null quando nao houve falha.
 */
export function descreverFalhaDaTela(valor: unknown): { codigo?: string; mensagem: string } | null {
  if (valor instanceof Error) return { mensagem: curta(valor.message || valor.name, 400) };
  if (!valor || typeof valor !== "object") return null;
  const r = valor as Record<string, unknown>;
  if (r.success !== false && r.ok !== false) return null;
  const texto = [r.message, r.error].filter((x) => typeof x === "string" && x.trim()).join(" — ");
  if (!texto) return null;
  return { ...(typeof r.code === "string" ? { codigo: r.code } : {}), mensagem: curta(texto, 400) };
}
