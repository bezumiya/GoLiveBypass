/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * Modelo puro da seleção manual de rotas Proton do plugin.
 *
 * Este arquivo deliberadamente não importa React, Vencord, Electron ou Node:
 * é o mesmo domínio (redução, ordenação, selecionabilidade e recomendação) já
 * comprovado na GUI, adaptado ao catálogo progressivo do plugin. As duas
 * superfícies (assistente e painel) derivam tudo daqui, então as regras não
 * podem divergir entre elas.
 */

export type ProtonCandidateStatus = "not-tested" | "pending" | "success" | "failed";

export type ProtonRouteProgressPhase =
    | "catalog"
    | "ping"
    | "preparing"
    | "testing"
    | "finalizing"
    | "completed"
    | "failed"
    | "cancelled";

/** Entrada pública do catálogo. Nunca carrega endpoint, chave, sessão ou token. */
export interface ProtonRouteCatalogEntry {
    server: string;
    country?: string;
    city?: string;
    tier?: string;
    load?: number;
    score?: number;
    pingMs?: number;
    status?: "testing" | "success" | "failed";
}

export interface ProtonRouteCandidate {
    server: string;
    country?: string;
    city?: string;
    tier?: string;
    load?: number;
    score?: number;
    pingMs?: number;
    downloadMbps?: number;
    uploadMbps?: number;
    pingStatus: ProtonCandidateStatus;
    preflightStatus: ProtonCandidateStatus;
    speedStatus: ProtonCandidateStatus;
    /** Motivo de falha já sanitizado (sem quebras de linha, tamanho limitado). */
    failureReason?: string;
    failurePhase?: ProtonRouteProgressPhase;
}

export interface ProtonRouteProgressEvent extends ProtonRouteCatalogEntry {
    phase: ProtonRouteProgressPhase;
    downloadMbps?: number;
    uploadMbps?: number;
}

const CANDIDATE_PHASES = new Set<ProtonRouteProgressPhase>([
    "catalog",
    "ping",
    "preparing",
    "testing",
]);

const MAX_REASON_LENGTH = 200;

/** Ping só vale quando é finito, positivo e menor que 999 ms. */
export function isValidProtonPing(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value > 0 && value < 999;
}

function isPositiveFinite(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isPublicText(value: unknown, max: number): value is string {
    return typeof value === "string" && value.trim() !== "" && value.length <= max;
}

function cleanText(value: string, max: number): string {
    return value.replace(/[\r\n\t]+/g, " ").trim().slice(0, max);
}

function statusForEvent(status: ProtonRouteProgressEvent["status"]): ProtonCandidateStatus {
    if (status === "success") return "success";
    if (status === "failed") return "failed";
    return "pending";
}

function emptyCandidate(server: string): ProtonRouteCandidate {
    return {
        server,
        pingStatus: "not-tested",
        preflightStatus: "not-tested",
        speedStatus: "not-tested",
    };
}

function setPhaseCandidateStatus(candidate: ProtonRouteCandidate, phase: ProtonRouteProgressPhase, status: ProtonCandidateStatus): void {
    if (phase === "ping" || phase === "catalog") candidate.pingStatus = status;
    else if (phase === "preparing") candidate.preflightStatus = status;
    else if (phase === "testing") candidate.speedStatus = status;
}

function failureReasonFor(phase: ProtonRouteProgressPhase): string | undefined {
    if (phase === "ping" || phase === "catalog") return "Sem resposta ao ping";
    if (phase === "preparing") return "Falha no túnel ou HTTPS";
    if (phase === "testing") return "Não foi possível medir a velocidade";
    return undefined;
}

/**
 * Aplica um evento de progresso na candidata indexada pelo nome exato do
 * servidor. `catalog` semeia a entrada (e o ping, quando o helper já o traz) e
 * as demais fases atualizam a mesma entrada sem perder metadados públicos.
 */
export function reduceProtonRouteEvent(
    current: ReadonlyMap<string, ProtonRouteCandidate>,
    event: ProtonRouteProgressEvent,
): Map<string, ProtonRouteCandidate> {
    const next = new Map(current);
    if (
        !event
        || !CANDIDATE_PHASES.has(event?.phase)
        || typeof event.server !== "string"
        || event.server.trim() === ""
    ) {
        return next;
    }

    const server = event.server;
    const candidate = { ...(next.get(server) ?? emptyCandidate(server)) };

    if (isPublicText(event.country, 64)) candidate.country = cleanText(event.country, 64);
    if (isPublicText(event.city, 96)) candidate.city = cleanText(event.city, 96);
    if (isPublicText(event.tier, 64)) candidate.tier = cleanText(event.tier, 64);
    if (typeof event.load === "number" && Number.isFinite(event.load) && event.load >= 0 && event.load <= 100) candidate.load = event.load;
    if (typeof event.score === "number" && Number.isFinite(event.score) && event.score >= 0) candidate.score = event.score;
    if (isValidProtonPing(event.pingMs)) candidate.pingMs = event.pingMs;
    if (isPositiveFinite(event.downloadMbps)) candidate.downloadMbps = event.downloadMbps;
    if (isPositiveFinite(event.uploadMbps)) candidate.uploadMbps = event.uploadMbps;

    const status = statusForEvent(event.status);
    if (event.phase === "catalog") {
        // O catálogo não conclui medição: sem status explícito a entrada apenas
        // fica pendente (a interface mostra "Medindo ping").
        if (event.status) {
            setPhaseCandidateStatus(candidate, "catalog", status);
        } else if (candidate.pingStatus === "not-tested") {
            candidate.pingStatus = "pending";
        }
    } else {
        setPhaseCandidateStatus(candidate, event.phase, status);
    }

    if (status === "failed") {
        const reason = failureReasonFor(event.phase);
        if (reason) {
            candidate.failureReason = reason;
            candidate.failurePhase = event.phase;
        }
    } else if (candidate.failurePhase === event.phase) {
        delete candidate.failureReason;
        delete candidate.failurePhase;
    }

    next.set(server, candidate);
    return next;
}

/** Mescla o catálogo devolvido pela descoberta no mesmo mapa de candidatas. */
export function mergeProtonRouteCatalog(
    current: ReadonlyMap<string, ProtonRouteCandidate>,
    entries: Iterable<ProtonRouteCatalogEntry>,
): Map<string, ProtonRouteCandidate> {
    let next = new Map(current);
    for (const entry of entries ?? []) {
        if (!entry || typeof entry.server !== "string" || entry.server.trim() === "") continue;
        next = reduceProtonRouteEvent(next, {
            ...entry,
            phase: "catalog",
            server: entry.server,
        });
    }
    return next;
}

function compareServerNames(left: ProtonRouteCandidate, right: ProtonRouteCandidate): number {
    const leftNormalized = left.server.normalize("NFKC").toLocaleLowerCase("en-US");
    const rightNormalized = right.server.normalize("NFKC").toLocaleLowerCase("en-US");
    if (leftNormalized < rightNormalized) return -1;
    if (leftNormalized > rightNormalized) return 1;
    if (left.server < right.server) return -1;
    if (left.server > right.server) return 1;
    return 0;
}

function compareRoutesByPing(left: ProtonRouteCandidate, right: ProtonRouteCandidate): number {
    const leftPing = hasValidProtonRoutePing(left) ? left.pingMs : undefined;
    const rightPing = hasValidProtonRoutePing(right) ? right.pingMs : undefined;
    if (leftPing !== undefined && rightPing === undefined) return -1;
    if (leftPing === undefined && rightPing !== undefined) return 1;
    if (leftPing !== undefined && rightPing !== undefined && leftPing !== rightPing) return leftPing - rightPing;
    return compareServerNames(left, right);
}

/** Selecionáveis primeiro (ping crescente, nome como desempate), resto no fim. */
export function sortProtonRouteCandidates(candidates: Iterable<ProtonRouteCandidate>): ProtonRouteCandidate[] {
    return [...candidates].sort(compareRoutesByPing);
}

export function isProtonRouteSelectable(candidate: ProtonRouteCandidate): boolean {
    return Boolean(
        candidate
        && typeof candidate.server === "string"
        && candidate.server.trim() !== ""
        && hasValidProtonRoutePing(candidate)
        && candidate.preflightStatus !== "failed",
    );
}

export function hasValidProtonRoutePing(candidate: ProtonRouteCandidate): boolean {
    return candidate.pingStatus !== "failed" && isValidProtonPing(candidate.pingMs);
}

function protonRouteCapacity(candidate: ProtonRouteCandidate): number | undefined {
    if (candidate.speedStatus !== "success" || !isPositiveFinite(candidate.downloadMbps) || !isPositiveFinite(candidate.uploadMbps)) return undefined;
    return (2 * candidate.downloadMbps * candidate.uploadMbps) / (candidate.downloadMbps + candidate.uploadMbps);
}

/**
 * A recomendação nunca implica aplicação: usa a capacidade harmônica quando há
 * medição de velocidade completa e, caso contrário, o menor ping. Rota sem ping
 * válido ou reprovada no preflight nunca é recomendada.
 */
export function recommendProtonRoute(candidates: Iterable<ProtonRouteCandidate>): string | undefined {
    const eligible = [...candidates].filter(isProtonRouteSelectable);
    if (eligible.length === 0) return undefined;

    const measured = eligible
        .map(candidate => ({ candidate, capacity: protonRouteCapacity(candidate) }))
        .filter((entry): entry is { candidate: ProtonRouteCandidate; capacity: number } => entry.capacity !== undefined);

    if (measured.length > 0) {
        measured.sort((left, right) => {
            if (left.capacity !== right.capacity) return right.capacity - left.capacity;
            return compareRoutesByPing(left.candidate, right.candidate);
        });
        return measured[0]?.candidate.server;
    }

    return sortProtonRouteCandidates(eligible)[0]?.server;
}

/**
 * Falha da otimização automática não pode deixar o usuário sem saída. Sem
 * nenhuma rota selecionável — lista vazia, só pings sem resposta ou todas
 * reprovadas no preflight — o catálogo precisa ser medido de novo para a lista
 * manual (ordenada por ping) voltar a oferecer escolha. Com uma rota já
 * selecionável, remedir só custaria outra rodada de ping sem mudar a decisão.
 */
export function shouldMeasureRouteCatalogOnFailure(candidates: Iterable<ProtonRouteCandidate> | null | undefined): boolean {
    for (const candidate of candidates ?? []) {
        if (isProtonRouteSelectable(candidate)) return false;
    }
    return true;
}

// ------------------------------------------------------------------ apresentação

export function formatProtonRoutePing(pingMs?: number): string {
    return isValidProtonPing(pingMs) ? `${Math.round(pingMs)} ms` : "—";
}

export function protonRouteLocation(candidate: ProtonRouteCatalogEntry): string | undefined {
    const parts = [candidate.country, candidate.city].filter((part): part is string => typeof part === "string" && part.trim() !== "");
    return parts.length > 0 ? parts.join(" · ") : undefined;
}

export function protonRouteTierLabel(candidate: ProtonRouteCatalogEntry): string | undefined {
    const parts: string[] = [];
    if (typeof candidate.tier === "string" && candidate.tier.trim() !== "") parts.push(candidate.tier);
    if (typeof candidate.load === "number" && Number.isFinite(candidate.load)) parts.push(`carga ${Math.round(candidate.load)}%`);
    return parts.length > 0 ? parts.join(" · ") : undefined;
}

/**
 * Estado visível da linha: durante a descoberta uma entrada ainda sem medição
 * aparece como "Medindo ping"; depois disso, sem ping válido, é "Indisponível".
 */
export function protonRouteStateLabel(
    candidate: ProtonRouteCandidate,
    options?: { discoveryActive?: boolean },
): string {
    if (isProtonRouteSelectable(candidate)) return "";
    if (candidate.failureReason) return candidate.failureReason;
    if (candidate.pingStatus === "failed") return "Sem resposta ao ping";
    if (candidate.preflightStatus === "failed") return candidate.failureReason || "Indisponível";
    if (candidate.pingStatus === "not-tested" || candidate.pingStatus === "pending") {
        return options?.discoveryActive ? "Medindo ping" : "Indisponível";
    }
    return "Indisponível";
}

export type ProtonLoginPresentationCode =
    | "INVALID_CREDENTIALS"
    | "TWO_FACTOR_REQUIRED"
    | "TWO_FACTOR_INVALID"
    | "CAPTCHA_REQUIRED"
    | "CAPTCHA_INVALID"
    | "CAPTCHA_CANCELLED"
    | "CANCELLED"
    | "NETWORK_ERROR"
    | "TIMEOUT"
    | "MISSING_EXECUTABLE"
    | "SESSION_PERSISTENCE"
    | "HELPER_ERROR"
    | "CONFIGURATION_ERROR"
    | "APP_VERSION_UNSUPPORTED"
    | "UNKNOWN";

export interface ProtonLoginPresentation {
    message: string;
    /** Só a credencial explicitamente rejeitada devolve o foco ao campo de senha. */
    focusPassword: boolean;
}

/**
 * A Proton recusou a versão do app (código 5003): nem a senha nem uma nova
 * tentativa resolvem. Mesma frase no login e no status da sessão guardada.
 */
export const PROTON_APP_VERSION_UNSUPPORTED_MESSAGE = "A Proton deixou de aceitar esta versão do GoLiveBypass. Atualize o GoLiveBypass para continuar.";

const PROTON_LOGIN_MESSAGES: Record<ProtonLoginPresentationCode, string> = {
    INVALID_CREDENTIALS: "Usuário ou senha incorretos. Confira os dados e tente novamente.",
    TWO_FACTOR_REQUIRED: "Esta conta exige o código 2FA.",
    TWO_FACTOR_INVALID: "O código 2FA está incorreto ou expirou.",
    CAPTCHA_REQUIRED: "O Proton solicitou uma verificação de segurança.",
    CAPTCHA_INVALID: "A verificação expirou ou foi recusada. Tente novamente.",
    CAPTCHA_CANCELLED: "A verificação Proton foi cancelada.",
    CANCELLED: "Login Proton cancelado. Você pode tentar novamente.",
    NETWORK_ERROR: "Não foi possível conectar aos servidores ProtonVPN. Verifique a rede e tente novamente.",
    TIMEOUT: "O ProtonVPN demorou demais para responder. Tente novamente.",
    MISSING_EXECUTABLE: "O componente ProtonVPN não foi encontrado no pacote do plugin. Reinstale ou atualize o plugin.",
    SESSION_PERSISTENCE: "O login foi processado, mas o plugin não conseguiu acessar o armazenamento seguro da sessão.",
    HELPER_ERROR: "O componente ProtonVPN falhou antes de concluir o login. Reinicie o Discord e tente novamente.",
    CONFIGURATION_ERROR: "A configuração do plugin está incompleta ou em estado incompatível.",
    APP_VERSION_UNSUPPORTED: PROTON_APP_VERSION_UNSUPPORTED_MESSAGE,
    UNKNOWN: "O Proton recusou ou não concluiu o login por um motivo não reconhecido.",
};

function loginCode(value: unknown): ProtonLoginPresentationCode | undefined {
    return typeof value === "string" && Object.prototype.hasOwnProperty.call(PROTON_LOGIN_MESSAGES, value)
        ? value as ProtonLoginPresentationCode
        : undefined;
}

/**
 * Apresentação única dos dois superfícies. O código estruturado do helper tem
 * precedência absoluta: só `CONFIGURATION_ERROR` e `UNKNOWN` mostram o detalhe
 * recebido, porque são os únicos em que a orientação genérica não serve.
 */
export function protonLoginPresentation(result: {
    code?: unknown;
    message?: unknown;
    error?: unknown;
    retryable?: unknown;
} | null | undefined): ProtonLoginPresentation {
    const code = loginCode(result?.code) ?? "UNKNOWN";
    const detail = code === "CONFIGURATION_ERROR" || code === "UNKNOWN"
        ? cleanText(String(result?.error ?? result?.message ?? ""), 240)
        : "";
    return {
        message: detail || PROTON_LOGIN_MESSAGES[code],
        focusPassword: code === "INVALID_CREDENTIALS",
    };
}
