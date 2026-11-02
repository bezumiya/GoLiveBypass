// Fragmentos IP que chegam ao Windows enquanto o tunel esta ligado. So diagnostico: nao troca
// rota, nao bloqueia nada e nao mostra aviso.
//
// Por que existe: o anexo que "carrega e some" nas rotas gratis do Mexico (2.0.14) vem de pacotes
// que chegam fragmentados em IP por dentro do tunel. O WireSock grava o checksum TCP calculado so
// sobre o primeiro fragmento e o Windows descarta o pacote remontado. A escolha automatica de rota
// evita o Mexico, mas o defeito continua no WireSock, e os relatos de outras rotas (video que nao
// carrega, imagem que nao sobe) nao diziam se a rota da pessoa estava fragmentando. Os contadores
// de remontagem do proprio Windows respondem isso sem captura de pacotes.
//
// O que os numeros NAO dizem: o contador e da maquina inteira (outro programa e o trafego de fora
// do tunel tambem contam) e sobe devagar mesmo com o Discord parado. Por isso nada aqui decide
// nada: o log e o relatorio levam so os numeros, e quem le compara a serie com a hora do problema.

import { execFile } from "child_process";
import * as logger from "./logger";

export interface ContadoresFragmentos {
  /** Fragmentos IPv4 recebidos que precisaram ser remontados (acumulado desde o boot). */
  v4Fragmentos: number;
  /** Remontagens IPv4 que falharam (fragmento que nunca completou, por exemplo). */
  v4Falhas: number;
  /** Fragmentos IPv6; null quando a secao do IPv6 nao veio no formato esperado. */
  v6Fragmentos: number | null;
}

export interface AmostraFragmentos {
  ms: number;
  c: ContadoresFragmentos;
}

// `netstat -s -p ip` (e `-p ipv6`) imprime 17 contadores "legenda = numero", sempre na ordem do
// MIB de IP. A legenda muda com o idioma do Windows e sai na pagina de codigo do console, entao a
// leitura e pela posicao: 11 = remontagem necessaria, 12 = bem-sucedida, 13 = falhas.
const CONTADORES_NETSTAT = 17;

export function contadoresDaSecaoNetstat(saida: string): { fragmentos: number; falhas: number } | null {
  const numeros: number[] = [];
  for (const linha of saida.split("\n")) {
    const m = /=\s*(\d+)\s*$/.exec(linha);
    if (m) numeros.push(Number(m[1]));
  }
  if (numeros.length !== CONTADORES_NETSTAT) return null;
  const [fragmentos, remontados, falhas] = numeros.slice(11, 14);
  // Cada datagrama remontado consome pelo menos dois fragmentos. Mais remontados que fragmentos =
  // a ordem nao e a esperada: melhor ficar sem numero do que publicar o numero errado.
  if (remontados > fragmentos) return null;
  return { fragmentos, falhas };
}

export function parseContadoresFragmentos(saidaV4: string, saidaV6: string | null): ContadoresFragmentos | null {
  const v4 = contadoresDaSecaoNetstat(saidaV4);
  if (!v4) return null;
  const v6 = saidaV6 === null ? null : contadoresDaSecaoNetstat(saidaV6);
  return { v4Fragmentos: v4.fragmentos, v4Falhas: v4.falhas, v6Fragmentos: v6?.fragmentos ?? null };
}

function lerSecaoNetstat(protocolo: "ip" | "ipv6"): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      // latin1 so para nao perder bytes: as legendas acentuadas saem em CP850 no pt-BR, mas daqui
      // so os numeros importam.
      execFile("netstat.exe", ["-s", "-p", protocolo], { encoding: "latin1", windowsHide: true, timeout: 5000 },
        (erro, saida) => resolve(erro ? null : String(saida ?? "")));
    } catch {
      resolve(null);
    }
  });
}

/** Le os contadores do Windows (dezenas de milissegundos, sem administrador). Nunca lanca. */
export async function lerContadoresFragmentos(): Promise<ContadoresFragmentos | null> {
  const [v4, v6] = await Promise.all([lerSecaoNetstat("ip"), lerSecaoNetstat("ipv6")]);
  return v4 === null ? null : parseContadoresFragmentos(v4, v6);
}

/** Janela do relatorio: os ultimos 15 minutos de leituras. */
export const FRAGMENTOS_JANELA_MS = 15 * 60_000;
/** Linha de log com o acumulado, no mesmo ritmo da linha de saude do tunel. */
export const FRAGMENTOS_LOG_MS = 5 * 60_000;

// Contador menor que o anterior (pilha de rede reiniciada) fica sem valor, nunca negativo.
function delta(antes: number | null, depois: number | null): number | null {
  if (antes === null || depois === null || depois < antes) return null;
  return depois - antes;
}

function somar(valores: Array<number | null>): number | null {
  let total: number | null = null;
  for (const v of valores) if (v !== null) total = (total ?? 0) + v;
  return total;
}

const segundos = (ms: number) => Math.max(0, Math.round(ms / 1000));

export interface ResumoFragmentos {
  /** Fragmentos IPv4 na janela; null quando nenhuma leitura da janela teve valor. */
  v4: number | null;
  v4Falhas: number | null;
  v6: number | null;
  /** Fragmentos IPv4 por leitura, da mais antiga para a mais recente (null = contador voltou). */
  serie: Array<number | null>;
  /** Tempo coberto pela janela, da amostra que a abre ate a ultima. */
  janelaS: number | null;
  /** Ha quanto tempo foi a ultima leitura. */
  amostraHaS: number | null;
}

export function resumirFragmentos(
  lista: readonly AmostraFragmentos[],
  agoraMs: number,
  janelaMs = FRAGMENTOS_JANELA_MS,
): ResumoFragmentos {
  const ultima = lista[lista.length - 1];
  const amostraHaS = ultima ? segundos(agoraMs - ultima.ms) : null;
  if (lista.length < 2) return { v4: null, v4Falhas: null, v6: null, serie: [], janelaS: null, amostraHaS };
  // A janela abre na amostra mais recente que ja tinha 15 min quando a ultima foi lida (ou na
  // primeira): o tunel parado ha uma hora ainda mostra os seus ultimos 15 minutos.
  let inicio = 0;
  for (let i = lista.length - 2; i >= 0; i--) {
    if (lista[i].ms <= ultima.ms - janelaMs) {
      inicio = i;
      break;
    }
  }
  const serie: Array<number | null> = [];
  const falhas: Array<number | null> = [];
  const v6: Array<number | null> = [];
  for (let i = inicio + 1; i < lista.length; i++) {
    const antes = lista[i - 1].c;
    const depois = lista[i].c;
    serie.push(delta(antes.v4Fragmentos, depois.v4Fragmentos));
    falhas.push(delta(antes.v4Falhas, depois.v4Falhas));
    v6.push(delta(antes.v6Fragmentos, depois.v6Fragmentos));
  }
  return {
    v4: somar(serie),
    v4Falhas: somar(falhas),
    v6: somar(v6),
    serie,
    janelaS: segundos(ultima.ms - lista[inicio].ms),
    amostraHaS,
  };
}

type LeitorFragmentos = () => Promise<ContadoresFragmentos | null>;
let leitorDeTeste: LeitorFragmentos | null = null;

// Estado da sessao: comeca quando o vigia do tunel comeca (ativacao ou troca de rota) e continua
// depois que ele para, para um relatorio feito com o bypass desligado ainda mostrar a ultima.
let sessao = 0;
let amostras: AmostraFragmentos[] = []; // so a janela, mais a amostra que a abre
let leituras = 0;
let falhasDeLeitura = 0;
let inicioMs: number | null = null;
let v4DesdeInicio = 0;
let ultimoLogMs = Number.NEGATIVE_INFINITY;
// Acumulado desde a ultima linha de log.
let doLog = { desdeMs: 0, v4: 0, v4MaiorLeitura: 0, v4Falhas: 0, v6: null as number | null };

function registrar(nova: AmostraFragmentos) {
  const anterior = amostras[amostras.length - 1];
  leituras++;
  inicioMs ??= nova.ms;
  if (!anterior) {
    amostras.push(nova);
    doLog.desdeMs = nova.ms;
    return;
  }
  const v4 = delta(anterior.c.v4Fragmentos, nova.c.v4Fragmentos);
  const falhas = delta(anterior.c.v4Falhas, nova.c.v4Falhas);
  const v6 = delta(anterior.c.v6Fragmentos, nova.c.v6Fragmentos);
  if (v4 !== null) {
    v4DesdeInicio += v4;
    doLog.v4 += v4;
    doLog.v4MaiorLeitura = Math.max(doLog.v4MaiorLeitura, v4);
  }
  if (falhas !== null) doLog.v4Falhas += falhas;
  if (v6 !== null) doLog.v6 = (doLog.v6 ?? 0) + v6;
  if (nova.ms > anterior.ms) {
    amostras.push(nova);
    while (amostras.length > 1 && amostras[1].ms <= nova.ms - FRAGMENTOS_JANELA_MS) amostras.shift();
  } else {
    // O relogio do Windows voltou: as idades da janela deixam de valer e ela recomeca aqui.
    amostras = [nova];
    ultimoLogMs = Math.min(ultimoLogMs, nova.ms);
  }
  if (nova.ms - ultimoLogMs >= FRAGMENTOS_LOG_MS) {
    logger.info("wg", "fragmentos.ip", {
      v4: doLog.v4,
      v4_maior_leitura: doLog.v4MaiorLeitura,
      v4_falhas: doLog.v4Falhas,
      v6: doLog.v6 ?? "?",
      janela_s: segundos(nova.ms - doLog.desdeMs),
      v4_desde_tunel: v4DesdeInicio,
    });
    ultimoLogMs = nova.ms;
    doLog = { desdeMs: nova.ms, v4: 0, v4MaiorLeitura: 0, v4Falhas: 0, v6: null };
  }
}

/**
 * Uma leitura, feita pelo vigia do tunel. So faz algo no Windows (ou com o leitor de teste), nunca
 * lanca e nunca espera mais que o timeout do netstat.
 */
export async function amostrarERegistrarFragmentos(agoraMs?: number): Promise<void> {
  try {
    const ler = leitorDeTeste ?? (process.platform === "win32" ? lerContadoresFragmentos : null);
    if (!ler) return;
    const daSessao = sessao;
    let c: ContadoresFragmentos | null;
    try {
      c = await ler();
    } catch {
      c = null;
    }
    // Um tunel novo comecou durante a leitura: ela era da sessao anterior.
    if (daSessao !== sessao) return;
    if (!c) {
      falhasDeLeitura++;
      if (falhasDeLeitura === 1) logger.info("wg", "fragmentos.indisponivel");
      return;
    }
    registrar({ ms: agoraMs ?? Date.now(), c });
  } catch {
    // Diagnostico nunca derruba o vigia do tunel.
  }
}

/** Tunel novo: a janela e a contagem "desde o tunel" recomecam. */
export function reiniciarFragmentos(): void {
  sessao++;
  amostras = [];
  leituras = 0;
  falhasDeLeitura = 0;
  inicioMs = null;
  v4DesdeInicio = 0;
  ultimoLogMs = Number.NEGATIVE_INFINITY;
  doLog = { desdeMs: 0, v4: 0, v4MaiorLeitura: 0, v4Falhas: 0, v6: null };
}

/** Uso de testes: troca o netstat por um leitor falso (null volta ao netstat). */
export function definirLeitorFragmentos(leitor: LeitorFragmentos | null): void {
  leitorDeTeste = leitor;
}

const texto = (n: number | null) => (n === null ? "?" : String(n));

/**
 * Campos do relatorio de bug, so no Windows. Apenas numeros e estado: "sem_amostras" = menos de
 * duas leituras (tunel recem-ligado ou nenhum tunel nesta execucao da GUI); "indisponivel" = o
 * netstat nao respondeu no formato esperado.
 */
export function metaFragmentos(agoraMs: number, windows: boolean): Record<string, string> {
  if (!windows) return {};
  if (leituras < 2) return { fragmentos_ip: falhasDeLeitura > 0 ? "indisponivel" : "sem_amostras" };
  const r = resumirFragmentos(amostras, agoraMs);
  const ultima = amostras[amostras.length - 1];
  const meta: Record<string, string> = {
    fragmentos_ip: "ok",
    fragmentos_v4_15min: texto(r.v4),
    fragmentos_v4_falhas_15min: texto(r.v4Falhas),
    fragmentos_v6_15min: texto(r.v6),
    fragmentos_serie: r.serie.length > 0 ? r.serie.map(texto).join(",") : "?",
    fragmentos_janela_s: texto(r.janelaS),
    fragmentos_amostra_ha_s: texto(r.amostraHaS),
    fragmentos_v4_desde_tunel: String(v4DesdeInicio),
    fragmentos_desde_tunel_s: texto(inicioMs === null || !ultima ? null : segundos(ultima.ms - inicioMs)),
  };
  if (falhasDeLeitura > 0) meta.fragmentos_leituras_falhas = String(falhasDeLeitura);
  return meta;
}
