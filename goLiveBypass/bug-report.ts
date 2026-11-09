/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * Montagem e redação do relato de bug do plugin (desenho em
 * docs/superpowers/specs/2026-09-13-plugin-bug-report-design.md).
 *
 * Arquivo PURO: sem Electron, sem rede e sem estado global. O transporte HTTP fica em
 * `native.ts`, onde vivem o endpoint e o token; aqui só se decide o que sai da máquina.
 *
 * Camadas de privacidade:
 *   L1 — padrões conhecidos (regex): credenciais em URL, cabeçalhos de autenticação,
 *        tokens do Discord, query do gateway, e-mail, diretórios home, PrivateKey e
 *        Endpoint WireGuard.
 *   L2 — segredos conhecidos da máquina, removidos por ocorrência literal (inclui o
 *        próprio token da API).
 *   L3 — varredura final: se algum termo conhecido sobreviveu, o envio é bloqueado e o
 *        payload bloqueado nunca é devolvido.
 */

import { createHash } from "crypto";

export type SegredosConhecidos = string[];

export const TITLE_MAX = 200;
export const DESCRIPTION_MAX = 8 * 1024;
export const SESSION_MAX = 16 * 1024;
export const LOG_MAX_BYTES = 240 * 1024;
// Orcamento do que chega na issue (GitHub: body <= 64KB, com meta e descricao junto).
export const LOG_ISSUE_MAX = 52 * 1024;
const LOG_ANTERIOR_MAX = 8 * 1024;
const byteLength = (texto: string) => Buffer.byteLength(texto, "utf8");
export const DEDUP_WINDOW_SECONDS = 48 * 60 * 60;
export const SIGNATURE_LENGTH = 16;

const MARCADOR_TRUNCAMENTO = "[...] ";
const L2_SUBSTITUTO = "<segredo>";
const MIN_SEGREDO = 3;
const MAX_MENSAGEM = 300;

/**
 * Códigos do resultado devolvido ao renderer. `OK` cobre sucesso e dedup; os demais são
 * erro local (validação, bloqueio de segredo) ou resposta da API.
 */
export type BugReportCode =
    | "OK"
    | "TITULO_OBRIGATORIO"
    | "SEGREDO_REMANESCENTE"
    | "INVALIDO"
    | "NAO_AUTORIZADO"
    | "LOG_GRANDE"
    | "BLOQUEADO"
    | "GITHUB"
    | "API_INDISPONIVEL"
    | "REDE";

/** Campos fixos que atravessam a fronteira nativa -> renderer. */
export interface BugReportResult {
    ok: boolean;
    code: BugReportCode;
    issueUrl?: string;
    issueNumber?: number;
    deduped?: boolean;
    blocked?: boolean;
    retryAfter?: number;
    error?: string;
}

/** Pedido cru do renderer (não confiável; sempre passa por limparEntradaDoRenderer). */
export interface BugReportRequest {
    title: string;
    description: string;
    includeLogs: boolean;
    session: string;
}

export interface BugReportPayload {
    title: string;
    description: string;
    log?: string;
    meta: Record<string, string>;
}

export interface BugReportState {
    signature: string;
    issueUrl: string;
    at: number;
}

export interface BugReportVpnState {
    state?: unknown;
    active?: unknown;
    owned?: unknown;
    generation?: unknown;
}

export interface BugReportMetaSources {
    versao: string;
    plataforma: string;
    electron: string;
    node: string;
    estadoVpn: BugReportVpnState;
    modo: string;
    onboarding: boolean;
    /** Retrato do ambiente (ver `montarAmbiente`); ausente em quem chama sem coletar. */
    ambiente?: Record<string, unknown>;
}

/**
 * Lista branca do retrato do ambiente que vai no relato e no evento `env.snapshot`. Cada campo
 * existe porque já foi perguntado à mão numa issue: IPv6 no kernel, distro e empacotamento (#404),
 * build do Windows, pasta do Windows Installer e versão do WireSock (upgrade do SDK que falhava
 * com 1632 num Windows sem `%SystemRoot%\Installer`). Só rótulos técnicos: nada de usuário,
 * máquina, caminho, rede ou endpoint.
 */
export const CAMPOS_AMBIENTE = [
    "so", "so_build", "kernel", "distro", "ipv6_kernel", "wg_modulo", "empacotamento",
    "sessao_grafica", "cliente", "fuso", "wiresock_versao", "wiresock_upgrade", "msi_pasta_installer",
] as const;

export function montarAmbiente(fontes: Record<string, unknown> | undefined): Record<string, string> {
    const saida: Record<string, string> = {};
    if (!fontes) return saida;
    for (const campo of CAMPOS_AMBIENTE) {
        const valor = fontes[campo];
        const texto = typeof valor === "boolean" ? (valor ? "sim" : "nao") : textoCurto(valor, 80);
        // Letras, dígitos, espaço e . _ : + - entram ("nixos 25.05", "-03:00"); barra e o resto
        // viram "_", para que um valor inesperado nunca carregue caminho para a issue.
        if (texto) saida[campo] = texto.replace(/[^A-Za-z0-9 ._:+\-]/g, "_");
    }
    return saida;
}

export interface BugReportLogSources {
    ring: string;
    caudaArquivo: string;
    sessao: string;
    segredos: SegredosConhecidos;
    token: string;
}

export interface BugReportPayloadSources {
    titulo: string;
    descricao: string;
    log: string;
    meta: Record<string, string>;
    segredos: SegredosConhecidos;
    token: string;
}

export interface BugReportDecision {
    enviar: boolean;
    issueUrl?: string;
}

export interface BugReportHttpSpec {
    method: "GET" | "POST";
    url: string;
    headers: Record<string, string>;
    body?: string;
}

const RE_CREDS_URL = /(\w[\w+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/g;
const RE_HEADER_AUTH = /^((?:proxy-)?authorization\s*:\s*).+$/gim;
const RE_DISCORD_TOKEN = /\b(mfa\.[\w-]{20,}|[MN][\w-]{23}\.[\w-]{6}\.[\w-]{27,40})\b/g;
const RE_GATEWAY_QUERY = /(https:\/\/gateway[^?\s]+)\?\S*/g;
const RE_EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const RE_HOME_POSIX = /(\/(?:home|var\/home|Users)\/)[^/\s]+/g;
const RE_HOME_WINDOWS = /([A-Z]:\\Users\\)[^\\\s]+/gi;
// "as another user: Not authorized" é a frase fixa do pkexec, não um nome: sem a exclusão o relato
// perdia justamente o "Not" e a causa da recusa (#404, fechamento negado pelo polkit).
const RE_IDENTITY_LABEL = /\b(?<!another\s)(nome|name|usu[aá]rio|username|user)\s*([:=])\s*[^\s,;]+/gi;
// O endpoint WireGuard é a saída escolhida pela pessoa e a chave privada nunca deve
// aparecer num relato; as duas regras valem para o log montado e para o texto digitado.
const RE_PRIVATE_KEY = /(PrivateKey\s*=\s*)\S+/gi;
const RE_WG_ENDPOINT = /(Endpoint\s*=\s*)\S+/gi;

/** L1 — padrões conhecidos. Espelha `golive-gui/electron/redact.ts` (mais as duas regras
 * acima, que a GUI aplica em outro ponto do seu pipeline). */
export function l1Padroes(texto: string): string {
    return texto
        .replace(RE_CREDS_URL, (_tudo, scheme, user) => `${scheme}${user}:***@`)
        .replace(RE_HEADER_AUTH, "$1***")
        .replace(RE_DISCORD_TOKEN, "***")
        .replace(RE_GATEWAY_QUERY, "$1?<params>")
        .replace(RE_EMAIL, "<email>")
        .replace(RE_HOME_POSIX, "$1<usuario>")
        .replace(RE_HOME_WINDOWS, "$1<usuario>")
        .replace(RE_IDENTITY_LABEL, "$1$2<usuario>")
        .replace(RE_PRIVATE_KEY, "$1<redacted>")
        .replace(RE_WG_ENDPOINT, "$1<redacted>");
}

/** L2 — segredos conhecidos, por ocorrência literal (o valor pode ter metacaracteres). */
export function l2Segredos(texto: string, segredos: SegredosConhecidos): string {
    let saida = texto;
    for (const segredo of segredos) {
        if (segredo.length < MIN_SEGREDO) continue;
        saida = saida.split(segredo).join(L2_SUBSTITUTO);
    }
    return saida;
}

export function redigir(texto: string, segredos: SegredosConhecidos, token?: string): string {
    const todos = token ? [...segredos, token] : segredos;
    return l2Segredos(l1Padroes(texto), todos);
}

/** L3 — devolve os termos conhecidos que SOBREVIVERAM ao pipeline. Lista não-vazia
 * significa bloquear o envio. */
export function segredosRemanescentes(texto: string, segredos: SegredosConhecidos, token?: string): string[] {
    const todos = token ? [...segredos, token] : segredos;
    return todos.filter(segredo => segredo.length >= MIN_SEGREDO && texto.includes(segredo));
}

/** Corta preservando o fim (o recente importa mais), sem partir uma linha ao meio. O
 * resultado cabe em `maxBytes`, contando o marcador de truncamento. */
export function cortarCauda(texto: string, maxBytes: number): string {
    const buffer = Buffer.from(texto, "utf8");
    if (buffer.length <= maxBytes) return texto;

    const marcador = Buffer.byteLength(MARCADOR_TRUNCAMENTO, "utf8");
    const limite = Math.max(0, maxBytes - marcador);
    const cauda = buffer.subarray(buffer.length - limite);
    const primeiraQuebra = cauda.indexOf(10);
    const inicio = primeiraQuebra >= 0 ? primeiraQuebra + 1 : 0;
    return MARCADOR_TRUNCAMENTO + cauda.subarray(inicio).toString("utf8");
}

/**
 * Complemento da cauda do arquivo: só o que veio ANTES da primeira linha do ring, para
 * não repetir a sessão. Sem ring (ou quando a linha não está na cauda) a cauda é
 * descartada — a política é "nunca repetir", mesmo perdendo o trecho anterior à rotação.
 */
export function complementoDaCauda(ring: string, caudaArquivo: string): string {
    const cauda = caudaArquivo.trimEnd();
    if (!cauda.trim()) return "";

    const primeira = ring.split("\n").find(linha => linha.trim() !== "");
    if (!primeira) return "";

    const indice = cauda.indexOf(primeira);
    if (indice < 0) return "";

    return cauda.slice(0, indice).trim();
}

/** Bloco de log enviado: sessão do renderer, ring buffer do processo e o complemento da
 * cauda do arquivo, tudo redigido e cortado em `LOG_MAX_BYTES`. */
export function montarLog({ ring, caudaArquivo, sessao, segredos, token }: BugReportLogSources): string {
    const partes: string[] = [];

    const sessaoLimpa = sessao.trimEnd();
    if (sessaoLimpa.trim()) partes.push(`=== sessao do plugin (renderer) ===\n${sessaoLimpa}`);

    const ringLimpo = ring.trimEnd();
    const complemento = complementoDaCauda(ringLimpo, caudaArquivo);
    // A issue so comporta ~60KB de log e a API corta o meio para caber: com o arquivo
    // antigo no fim, o corte levava as linhas recentes do ring (a falha). O complemento
    // entra so pela cauda e o ring fica com o resto do orcamento (mesma regra da GUI).
    const complementoCurto = complemento ? cortarCauda(complemento, LOG_ANTERIOR_MAX) : "";
    if (ringLimpo.trim()) {
        const usado = byteLength(partes.join("\n")) + byteLength(complementoCurto);
        const cota = Math.max(8 * 1024, LOG_ISSUE_MAX - usado - 64);
        partes.push(`=== plugin (memoria) ===\n${cortarCauda(ringLimpo, cota)}`);
    }
    if (complementoCurto) partes.push(`=== plugin-vpn.log (antes do ring) ===\n${complementoCurto}`);

    return cortarCauda(redigir(partes.join("\n"), segredos, token), LOG_MAX_BYTES);
}

/** Meta por lista branca: nada de caminhos, endpoint, usuário Proton ou estado interno. */
export function montarMeta(fontes: BugReportMetaSources): Record<string, string> {
    const vpn = fontes.estadoVpn ?? {};
    return {
        app: "golive-plugin",
        versao: textoCurto(fontes.versao) ?? "desconhecida",
        plataforma: textoCurto(fontes.plataforma) ?? "desconhecida",
        electron: textoCurto(fontes.electron) ?? "desconhecido",
        node: textoCurto(fontes.node) ?? "desconhecido",
        vpn_estado: textoCurto(vpn.state) ?? "desconhecido",
        vpn_ativa: vpn.active === true ? "sim" : "nao",
        vpn_propria: vpn.owned === true ? "sim" : "nao",
        vpn_geracao: typeof vpn.generation === "number" && Number.isFinite(vpn.generation) ? String(vpn.generation) : "desconhecida",
        vpn_modo: fontes.modo === "custom" ? "custom" : "proton",
        onboarding: fontes.onboarding === true ? "sim" : "nao",
        ...montarAmbiente(fontes.ambiente),
    };
}

/** Entrada do renderer é não confiável: corta e tipa antes de qualquer uso. */
export function limparEntradaDoRenderer(value: unknown): BugReportRequest {
    const cru = value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
    return {
        title: textoLimitado(cru.title, TITLE_MAX),
        description: textoLimitado(cru.description, DESCRIPTION_MAX),
        includeLogs: cru.includeLogs !== false,
        session: textoLimitado(cru.session, SESSION_MAX),
    };
}

/**
 * Valida, redige, corta e fecha o corpo. Devolve `bloqueado` com o motivo quando o
 * título está vazio ou quando o L3 encontra um segredo conhecido — nesse caso nenhum
 * payload é devolvido.
 */
export function montarPayload({ titulo, descricao, log, meta, segredos, token }: BugReportPayloadSources): {
    payload: BugReportPayload;
    bloqueado: boolean;
    code: BugReportCode;
} {
    const vazio: BugReportPayload = { title: "", description: "", meta: {} };

    const title = redigir(titulo.trim(), segredos, token).slice(0, TITLE_MAX);
    if (!title) return { payload: vazio, bloqueado: true, code: "TITULO_OBRIGATORIO" };

    const payload: BugReportPayload = {
        title,
        description: redigir(descricao, segredos, token).slice(0, DESCRIPTION_MAX),
        meta: { ...meta },
    };
    const corpoDoLog = log.trim();
    if (corpoDoLog) payload.log = cortarCauda(redigir(corpoDoLog, segredos, token), LOG_MAX_BYTES);

    // L3 — última barreira: se algum termo conhecido sobreviveu, nada sai da máquina.
    if (segredosRemanescentes(JSON.stringify(payload), segredos, token).length > 0)
        return { payload: vazio, bloqueado: true, code: "SEGREDO_REMANESCENTE" };

    return { payload, bloqueado: false, code: "OK" };
}

/** Assinatura do relato para o dedup. O log fica de fora: ele muda a cada segundo e
 * anularia a comparação. */
export function assinaturaDoRelato(titulo: string, descricao: string): string {
    return createHash("sha256").update(`${titulo.trim()}\n${descricao.trim()}`, "utf8").digest("hex").slice(0, SIGNATURE_LENGTH);
}

export function estadoDeEnvioValido(value: unknown): BugReportState | null {
    if (value === null || typeof value !== "object") return null;
    const cru = value as Record<string, unknown>;
    const signature = textoCurto(cru.signature);
    const issueUrl = textoCurto(cru.issueUrl);
    const at = Number(cru.at);
    if (!signature || !issueUrl || !Number.isFinite(at)) return null;
    return { signature, issueUrl, at };
}

/** Mesma assinatura dentro da janela de 48 h → não posta e devolve a issue anterior. */
export function decidirEnvio(ultimoEnvio: BugReportState | null, assinatura: string, agora: number): BugReportDecision {
    if (!ultimoEnvio || !assinatura) return { enviar: true };
    if (ultimoEnvio.signature !== assinatura) return { enviar: true };

    const decorrido = agora - ultimoEnvio.at;
    if (decorrido >= 0 && decorrido < DEDUP_WINDOW_SECONDS) return { enviar: false, issueUrl: ultimoEnvio.issueUrl };

    return { enviar: true };
}

/** Resposta HTTP -> objeto do renderer. `retryAfter` pode vir do header (prioritário) ou
 * do corpo JSON. */
export function interpretarResposta(status: number, retryAfter: number, corpoTexto: string): BugReportResult {
    const corpo = corpoJson(corpoTexto);
    const doHeader = segundos(retryAfter);
    // Header 0 (ou ausente) não é informação: cai para o corpo.
    const retry = doHeader !== null && doHeader > 0 ? doHeader : segundos(corpo?.retry_after);

    if (status === 201) {
        const issueUrl = textoCurto(corpo?.issue_url) ?? textoCurto(corpo?.html_url);
        if (!issueUrl) return { ok: false, code: "API_INDISPONIVEL", error: "A API respondeu sem o endereco da issue." };
        const issueNumber = Number(corpo?.issue_number);
        return { ok: true, code: "OK", issueUrl, issueNumber: Number.isFinite(issueNumber) ? issueNumber : undefined };
    }

    if (status === 400) return { ok: false, code: "INVALIDO", error: mensagemDoServidor(corpo, "A API recusou o relato.") };
    if (status === 401) return { ok: false, code: "NAO_AUTORIZADO", error: "A API recusou o envio. Atualize o plugin." };
    if (status === 413) return { ok: false, code: "LOG_GRANDE", error: "O relato ficou grande demais para enviar." };
    if (status === 429) {
        return {
            ok: false,
            code: "BLOQUEADO",
            blocked: true,
            retryAfter: retry ?? 0,
            error: mensagemDoServidor(corpo, "Voce enviou relatos em excesso."),
        };
    }
    if (status === 502) return { ok: false, code: "GITHUB", error: "O GitHub recusou a criacao da issue. Tente mais tarde." };

    return { ok: false, code: "API_INDISPONIVEL", error: mensagemDoServidor(corpo, `A API respondeu ${status}.`) };
}

/** Sem resposta da API (offline, DNS, prazo): o texto digitado fica com o usuário. */
export function resultadoDeRede(): BugReportResult {
    return { ok: false, code: "REDE", error: "Sem resposta da API. Tente novamente." };
}

export function resultadoTituloObrigatorio(): BugReportResult {
    return { ok: false, code: "TITULO_OBRIGATORIO", error: "Informe um resumo curto do problema." };
}

export function resultadoSegredoRemanescente(): BugReportResult {
    return { ok: false, code: "SEGREDO_REMANESCENTE", error: "Nao enviei o relato por seguranca. Copie o diagnostico e revise antes de enviar." };
}

export function resultadoDeduplicado(issueUrl: string): BugReportResult {
    return { ok: true, code: "OK", deduped: true, issueUrl };
}

/** Pedido de envio: o token vai **somente** no header Authorization. */
export function montarPedido(payload: BugReportPayload, config: { url: string; token: string }): BugReportHttpSpec {
    return {
        method: "POST",
        url: config.url,
        headers: cabecalhosComToken(config.token),
        body: JSON.stringify(payload),
    };
}

/** Pedido de status de bloqueio (mesma autenticação, sem rate limit do lado da API). */
export function montarPedidoDeStatus(config: { url: string; token: string }): BugReportHttpSpec {
    return { method: "GET", url: config.url, headers: cabecalhosComToken(config.token) };
}

/** Status consultado antes de enviar. Sem URL/token: só o que a UI precisa mostrar. */
export function interpretarStatusDeBloqueio(status: number, corpoTexto: string): { blocked: boolean; retryAfter: number; remaining: number } {
    if (status !== 200) return { blocked: false, retryAfter: 0, remaining: 0 };

    const corpo = corpoJson(corpoTexto);
    return {
        blocked: corpo?.blocked === true,
        retryAfter: segundos(corpo?.retry_after) ?? 0,
        remaining: segundos(corpo?.remaining) ?? 0,
    };
}

function cabecalhosComToken(token: string): Record<string, string> {
    return {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": `Bearer ${token}`,
        "User-Agent": "GoLiveBypass-plugin/1.0",
    };
}

function corpoJson(texto: string): Record<string, unknown> | null {
    if (!texto) return null;
    try {
        const valor = JSON.parse(texto);
        return valor !== null && typeof valor === "object" ? valor as Record<string, unknown> : null;
    } catch {
        return null;
    }
}

function mensagemDoServidor(corpo: Record<string, unknown> | null, alternativa: string): string {
    return textoCurto(corpo?.error) ?? alternativa;
}

/** Texto curto e de uma linha só: nunca deixa o servidor (ou um campo inesperado) trazer
 * conteúdo com quebras de linha para a UI ou para o log. */
function textoCurto(value: unknown, max = MAX_MENSAGEM): string | null {
    if (typeof value !== "string") return null;
    const limpo = value.replace(/[\r\n\t]+/g, " ").trim().slice(0, max);
    return limpo || null;
}

function textoLimitado(value: unknown, max: number): string {
    return typeof value === "string" ? value.slice(0, max) : "";
}

function segundos(value: unknown): number | null {
    const total = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    if (!Number.isFinite(total) || total < 0) return null;
    return Math.floor(total);
}
