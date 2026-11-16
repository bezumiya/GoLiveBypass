// Saude do tunel lida do proprio log do wiresock-client (Windows, modo direto).
//
// Por que existe: o `wg show` que o wgstats.ts usa nao existe com o WireSock direto, entao todo
// relatorio trazia "handshake: indisponivel" e uma queda do tunel passava invisivel. Mas o
// wiresock-client, rodando com `-log-level info`, ja escreve no arquivo redirecionado pela
// ativacao (`direct-result.txt.stdout`) cada resposta de handshake (a cada ~2 min) e cada
// keepalive (a cada 10 s, o PersistentKeepalive dos perfis). Este modulo le esse arquivo.
//
// O que isto prova e o que NAO prova: da para ver tunel parado, handshake sem resposta (perda
// de pacotes ate o servidor) e keepalive atrasado. Um servidor que fica lento mas continua
// respondendo keepalive parece saudavel aqui, e "success" de keepalive so diz que o envio local
// funcionou. Entao um resultado "saudavel" separa "tunel vivo" de "tunel morto", nao e prova de
// que o Discord esteja transferindo bem.
//
// Nada daqui devolve endereco IP ou chave: so contagens e idades, o mesmo cuidado do restante
// do relatorio (a saida escolhida pela pessoa nao entra nos metadados).

import fs from "fs";

export interface WireSockLogSummary {
  ok: boolean;
  erro?: string;
  /** Janela, em segundos, a que se referem as contagens abaixo. */
  janelaS: number;
  /** Segundos desde a ultima linha do log; null se nenhuma linha tem horario. */
  ultimaLinhaHaS: number | null;
  /** Segundos desde "Tunnel has started"; null se a linha esta fora do trecho lido. */
  tunelAtivoHaS: number | null;
  /** Segundos desde a ultima resposta de handshake; null se nao ha nenhuma no trecho lido. */
  handshakeRespostaHaS: number | null;
  handshakesEnviados: number;
  handshakesRespondidos: number;
  /** Handshakes enviados ha mais de alguns segundos que nao tiveram resposta na janela. */
  semResposta: number;
  /** Handshakes enviados depois da ultima resposta (e ha mais de alguns segundos); zera a cada resposta. */
  semRespostaSeguidos: number;
  keepaliveOk: number;
  keepaliveFalhas: number;
  /** Maior espaco entre keepalives (e entre o ultimo e agora); null sem keepalive na janela. */
  keepaliveMaiorIntervaloS: number | null;
  /** Linhas fora de "info" ou com cara de falha. */
  avisos: number;
  ultimoAviso?: string;
}

export interface WireSockSaude {
  nivel: "info" | "warn";
  evento: string;
  dados: Record<string, string | number>;
}

export const WIRESOCK_LOG_JANELA_S = 600;
// Um handshake enviado ha menos que isto ainda pode estar esperando a resposta.
const HANDSHAKE_PENDENTE_S = 5;
// PersistentKeepalive dos perfis e 10 s: seis intervalos sem linha ja e o log (ou o processo) parado.
export const WIRESOCK_LOG_PARADO_S = 60;
export const WIRESOCK_KEEPALIVE_ATRASADO_S = 30;
const TAIL_BYTES = 96 * 1024;
const HEAD_BYTES = 8 * 1024;

let caminhoLog: string | null = null;

/** Chamado pela ativacao em modo direto; so existe no Windows. */
export function registrarLogWireSock(caminho: string | null): void {
  caminhoLog = caminho;
}

export function caminhoLogWireSock(): string | null {
  return caminhoLog;
}

function horarioDaLinha(linha: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\s|$)/.exec(linha);
  if (!m) return null;
  const ms = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function mensagemDaLinha(linha: string): { nivel: string; msg: string } {
  const resto = linha.slice(19).trim();
  try {
    const json = JSON.parse(resto);
    if (json && typeof json === "object" && typeof json.message === "string") {
      return { nivel: typeof json.log_level === "string" ? json.log_level.toLowerCase() : "info", msg: json.message };
    }
  } catch {
    // linha que nao e JSON: usa o texto como esta
  }
  return { nivel: "info", msg: resto };
}

function limparAviso(msg: string): string {
  return msg
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, "<ip>")
    .replace(/[A-Za-z0-9+/]{40,}={0,2}/g, "<chave>")
    .replace(/\{[0-9A-Fa-f-]{36}\}/g, "<guid>")
    .slice(0, 140);
}

const RE_RESPOSTA = /Handshake response received/i;
const RE_ENVIO = /Handshake initiation sent/i;
const RE_INICIO = /Tunnel has started/i;
const RE_KEEPALIVE = /Keepalive/i;
const RE_FALHA = /fail|error|erro|timeout|unreach|denied/i;

/**
 * `texto` e o trecho recente do log; `inicio` e o comeco do arquivo, onde fica "Tunnel has
 * started" quando a sessao e longa demais para o trecho recente.
 */
export function resumirLogWireSock(
  texto: string,
  agoraMs: number,
  inicio = "",
  janelaS = WIRESOCK_LOG_JANELA_S,
): WireSockLogSummary {
  const vazio: WireSockLogSummary = {
    ok: false,
    janelaS,
    ultimaLinhaHaS: null,
    tunelAtivoHaS: null,
    handshakeRespostaHaS: null,
    handshakesEnviados: 0,
    handshakesRespondidos: 0,
    semResposta: 0,
    semRespostaSeguidos: 0,
    keepaliveOk: 0,
    keepaliveFalhas: 0,
    keepaliveMaiorIntervaloS: null,
    avisos: 0,
  };
  const limiteJanela = agoraMs - janelaS * 1000;
  const limitePendente = agoraMs - HANDSHAKE_PENDENTE_S * 1000;

  let ultimaLinhaMs: number | null = null;
  let inicioTunelMs: number | null = null;
  let ultimaRespostaMs: number | null = null;
  let enviados = 0;
  let enviadosAntigos = 0;
  let respondidos = 0;
  let keepaliveFalhas = 0;
  let avisos = 0;
  let ultimoAviso: string | undefined;
  const keepalives: number[] = [];
  const envios: number[] = [];

  // O comeco do arquivo so serve para achar "Tunnel has started" numa sessao longa; contar as
  // suas linhas aqui duplicaria as do trecho recente quando os dois se sobrepoem.
  for (const linha of inicio.split(/\r?\n/)) {
    const quando = horarioDaLinha(linha);
    if (quando !== null && RE_INICIO.test(mensagemDaLinha(linha).msg)) {
      if (inicioTunelMs === null || quando > inicioTunelMs) inicioTunelMs = quando;
    }
  }

  for (const linha of texto.split(/\r?\n/)) {
    const quando = horarioDaLinha(linha);
    if (quando === null) continue;
    const { nivel, msg } = mensagemDaLinha(linha);
    if (ultimaLinhaMs === null || quando > ultimaLinhaMs) ultimaLinhaMs = quando;
    if (RE_INICIO.test(msg)) {
      if (inicioTunelMs === null || quando > inicioTunelMs) inicioTunelMs = quando;
      continue;
    }
    if (RE_RESPOSTA.test(msg)) {
      if (ultimaRespostaMs === null || quando > ultimaRespostaMs) ultimaRespostaMs = quando;
      if (quando >= limiteJanela) respondidos++;
      continue;
    }
    if (RE_ENVIO.test(msg)) {
      envios.push(quando);
      if (quando >= limiteJanela) {
        enviados++;
        if (quando <= limitePendente) enviadosAntigos++;
      }
      continue;
    }
    if (RE_KEEPALIVE.test(msg)) {
      if (quando >= limiteJanela) {
        if (/success/i.test(msg)) keepalives.push(quando);
        else keepaliveFalhas++;
      }
      continue;
    }
    if (quando >= limiteJanela && (nivel !== "info" || RE_FALHA.test(msg))) {
      avisos++;
      ultimoAviso = limparAviso(msg);
    }
  }

  if (ultimaLinhaMs === null) return { ...vazio, erro: "log sem linhas com horario" };

  keepalives.sort((a, b) => a - b);
  let maiorIntervaloMs: number | null = null;
  for (let i = 1; i < keepalives.length; i++) {
    maiorIntervaloMs = Math.max(maiorIntervaloMs ?? 0, keepalives[i] - keepalives[i - 1]);
  }
  if (keepalives.length > 0) {
    maiorIntervaloMs = Math.max(maiorIntervaloMs ?? 0, agoraMs - keepalives[keepalives.length - 1]);
  }
  const idadeS = (ms: number | null) => (ms === null ? null : Math.max(0, Math.round((agoraMs - ms) / 1000)));
  // Ao contrario do semResposta (janela de 10 min, diagnostico), so conta o que veio depois da
  // ultima resposta: um servidor que voltou a responder deixa de parecer mudo na hora.
  const semRespostaSeguidos = envios
    .filter((quando) => (ultimaRespostaMs === null || quando > ultimaRespostaMs) && quando <= limitePendente)
    .length;

  return {
    ok: true,
    janelaS,
    ultimaLinhaHaS: idadeS(ultimaLinhaMs),
    tunelAtivoHaS: idadeS(inicioTunelMs),
    handshakeRespostaHaS: idadeS(ultimaRespostaMs),
    handshakesEnviados: enviados,
    handshakesRespondidos: respondidos,
    semResposta: Math.max(0, enviadosAntigos - respondidos),
    semRespostaSeguidos,
    keepaliveOk: keepalives.length,
    keepaliveFalhas,
    keepaliveMaiorIntervaloS: maiorIntervaloMs === null ? null : Math.round(maiorIntervaloMs / 1000),
    avisos,
    ...(ultimoAviso ? { ultimoAviso } : {}),
  };
}

/** Le o inicio e o fim do arquivo (aberto pelo WireSock, entao sempre compartilhado) e resume. */
export function lerResumoLogWireSock(caminho: string, agoraMs = Date.now()): WireSockLogSummary {
  let fd: number | null = null;
  try {
    fd = fs.openSync(caminho, "r");
    const { size } = fs.fstatSync(fd);
    const lerTrecho = (posicao: number, bytes: number): string => {
      const buf = Buffer.alloc(Math.max(0, bytes));
      const lidos = fs.readSync(fd as number, buf, 0, buf.length, posicao);
      return buf.subarray(0, lidos).toString("utf8");
    };
    const inicio = lerTrecho(0, Math.min(size, HEAD_BYTES));
    let texto: string;
    if (size <= TAIL_BYTES) {
      texto = lerTrecho(0, size);
    } else {
      texto = lerTrecho(size - TAIL_BYTES, TAIL_BYTES);
      texto = texto.slice(texto.indexOf("\n") + 1); // descarta a linha partida
    }
    return resumirLogWireSock(texto, agoraMs, inicio);
  } catch (err) {
    return {
      ...resumirLogWireSock("", agoraMs),
      erro: String((err as Error)?.message ?? err).split("\n")[0].slice(0, 120),
    };
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* nada a fazer */ }
    }
  }
}

// O WireGuard repete o handshake a cada 5 s sem resposta: 6 tentativas sao cerca de 30 s com o
// servidor mudo. Menos que isso pegaria um soluco da rede e trocaria uma rota que funciona.
export const FAILOVER_HANDSHAKES_SEM_RESPOSTA = 6;

/**
 * O servidor da rota parou de responder? Evidencia para a troca automatica de rota no Windows,
 * onde o normal e nao ter wg.exe nem CLI de status: o log esta vivo e as ultimas tentativas de
 * handshake ficaram todas sem resposta.
 */
export function servidorSemResposta(r: WireSockLogSummary): boolean {
  return r.ok && r.ultimaLinhaHaS !== null && r.ultimaLinhaHaS <= WIRESOCK_LOG_PARADO_S &&
    r.semRespostaSeguidos >= FAILOVER_HANDSHAKES_SEM_RESPOSTA;
}

/**
 * O servidor respondeu ao handshake depois que o tunel atual comecou? Prova de rota viva sem
 * wg.exe nem CLI. Vale a ultima linha "Tunnel has started" do log, e a troca de rota abre um log
 * novo: uma resposta da sessao anterior nao conta. Sem a linha de inicio, nao ha prova.
 */
export function respostaNaSessaoAtual(r: WireSockLogSummary): boolean {
  return r.ok && r.handshakeRespostaHaS !== null && r.tunelAtivoHaS !== null &&
    r.handshakeRespostaHaS <= r.tunelAtivoHaS;
}

/** Decide o que registrar. So um evento por leitura, do mais grave ao menos grave. */
export function avaliarSaudeWireSock(
  r: WireSockLogSummary,
  opcoes: { handshakeVelhoS?: number } = {},
): WireSockSaude {
  const handshakeVelhoS = opcoes.handshakeVelhoS ?? 180;
  const dados: Record<string, string | number> = {
    ultima_linha_ha_s: r.ultimaLinhaHaS ?? "?",
    tunel_ativo_ha_s: r.tunelAtivoHaS ?? "?",
    handshake_resposta_ha_s: r.handshakeRespostaHaS ?? "nunca",
    handshakes_enviados_resp: `${r.handshakesEnviados}/${r.handshakesRespondidos}`,
    sem_resposta: r.semResposta,
    keepalive_maior_intervalo_s: r.keepaliveMaiorIntervaloS ?? "?",
    janela_s: r.janelaS,
  };
  if (r.avisos > 0) {
    dados.avisos = r.avisos;
    if (r.ultimoAviso) dados.ultimo_aviso = r.ultimoAviso;
  }
  if (r.keepaliveFalhas > 0) dados.keepalive_falhas = r.keepaliveFalhas;

  const ativoHaS = r.tunelAtivoHaS ?? Number.POSITIVE_INFINITY;
  if (r.ultimaLinhaHaS !== null && r.ultimaLinhaHaS > WIRESOCK_LOG_PARADO_S) {
    return { nivel: "warn", evento: "wiresock.log_parado", dados };
  }
  if (r.handshakeRespostaHaS !== null && r.handshakeRespostaHaS > handshakeVelhoS && ativoHaS > handshakeVelhoS) {
    return { nivel: "warn", evento: "handshake.velho", dados };
  }
  if (r.semResposta >= 2) return { nivel: "warn", evento: "handshake.sem_resposta", dados };
  if (r.keepaliveMaiorIntervaloS !== null && r.keepaliveMaiorIntervaloS > WIRESOCK_KEEPALIVE_ATRASADO_S) {
    return { nivel: "warn", evento: "keepalive.intervalo", dados };
  }
  if (r.avisos > 0 || r.keepaliveFalhas > 0) return { nivel: "warn", evento: "wiresock.avisos", dados };
  return { nivel: "info", evento: "tunel.saude", dados };
}

/**
 * Campos do relatorio de bug. Fora do Windows, e sem log registrado, nao ha o que dizer; no
 * Windows, a ausencia do dado e informacao (era o "handshake: indisponivel" de todo relatorio).
 * So numeros e textos fixos: nenhum IP, chave ou caminho sai daqui.
 */
export function metaDoLogWireSock(
  caminho: string | null,
  windows: boolean,
  agoraMs = Date.now(),
): Record<string, string> {
  if (!caminho) return windows ? { wiresock_log: "nao_registrado" } : {};
  const r = lerResumoLogWireSock(caminho, agoraMs);
  if (!r.ok) return { wiresock_log: `indisponivel: ${r.erro ?? "?"}` };
  const meta: Record<string, string> = {
    wiresock_log: "ok",
    wiresock_tunel_ativo_ha_s: String(r.tunelAtivoHaS ?? "?"),
    wiresock_ultima_linha_ha_s: String(r.ultimaLinhaHaS ?? "?"),
    wiresock_handshake_ha_s: String(r.handshakeRespostaHaS ?? "nunca"),
    wiresock_handshakes_10min: `${r.handshakesEnviados}/${r.handshakesRespondidos}`,
    wiresock_sem_resposta: String(r.semResposta),
    wiresock_keepalive_maior_intervalo_s: String(r.keepaliveMaiorIntervaloS ?? "?"),
  };
  if (r.keepaliveFalhas > 0) meta.wiresock_keepalive_falhas = String(r.keepaliveFalhas);
  if (r.avisos > 0) meta.wiresock_avisos = String(r.avisos);
  return meta;
}

/**
 * O perfil ativo tem endereco IPv6 no tunel? So olha a linha `Address` (o `::/0` do AllowedIPs
 * existe em todo perfil e nao diz nada). Devolve apenas sim/nao: o endereco nao sai daqui.
 */
export function ipv6NoPerfil(conteudoConf: string | null): "sim" | "nao" | "indisponivel" {
  if (!conteudoConf) return "indisponivel";
  const enderecos = [...conteudoConf.matchAll(/^\s*Address\s*=\s*(.+)$/gim)].map((m) => m[1]);
  if (enderecos.length === 0) return "indisponivel";
  return enderecos.some((linha) => linha.includes(":")) ? "sim" : "nao";
}
