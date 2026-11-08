/* Núcleo puro de eventos locais do plugin: sem Electron, filesystem ou Vencord. */

export type PluginLogLevel = "info" | "warn" | "error";

export interface PluginLogContext {
    operation_id?: string;
    attempt_id?: string;
    phase?: string;
    component?: string;
    plugin_version?: string;
    platform?: string;
    arch?: string;
}

export interface PluginLogRecord {
    schema_version: 1;
    ts: string;
    level: PluginLogLevel;
    component: string;
    event: string;
    operation_id?: string;
    attempt_id?: string;
    phase?: string;
    plugin_version?: string;
    platform?: string;
    arch?: string;
    message?: string;
    data?: Record<string, unknown>;
    count: number;
    first_ts: string;
    last_ts: string;
}

export interface PluginLoggerOptions {
    component: string;
    pluginVersion: string;
    platform: string;
    arch: string;
    maxEvents?: number;
    maxBytes?: number;
    now?: () => Date;
    onLine?: (line: string) => void;
}

export interface PluginLogger {
    emit(level: PluginLogLevel, event: string, context?: PluginLogContext, data?: Record<string, unknown>, message?: string): PluginLogRecord | null;
    info(event: string, context?: PluginLogContext, data?: Record<string, unknown>, message?: string): PluginLogRecord | null;
    warn(event: string, context?: PluginLogContext, data?: Record<string, unknown>, message?: string): PluginLogRecord | null;
    error(event: string, context?: PluginLogContext, data?: Record<string, unknown>, message?: string): PluginLogRecord | null;
    restore(lines: readonly string[]): void;
    records(): readonly PluginLogRecord[];
    getLog(): string;
}

const MAX_TEXT = 500;
const MAX_MESSAGE = 1000;
const MAX_DEPTH = 4;
const MAX_KEYS = 32;
const MAX_ARRAY = 32;
const SENSITIVE_KEY = /(?:password|senha|passphrase|token|captcha|2fa|twofactor|secret|private(?:_?key)?|public(?:_?key)?|authorization|cookie|session|credential|stdin|rawconfig|config|endpoint|commandline|allowedapps|profilepath|conf(?:ig)?file)/i;
const SAFE_KEYS: Record<string, true> = {
    mode: true, state: true, previous_state: true, next_state: true, phase: true, stage: true, status: true, outcome: true, reason: true, motivo: true, error: true, erro: true, error_code: true, code: true, codigo: true, codigo_saida: true, structured_code: true, codigo_estruturado: true, retryable: true, cancelled: true, aborted: true, suppressed: true, diagnostic_only: true, log_only: true, source: true, origin: true, origem: true, platform: true, architecture: true, arch: true, plugin_version: true, version: true, channel: true, current: true, latest: true, pending: true, pending_version: true, pending_channel: true, reload_required: true, relaunch_requested: true, duration_ms: true, timeout_ms: true, exit_code: true, signal: true, stdout_bytes: true, stderr_bytes: true, json: true, valid: true, authorized: true, storage: true, session_storage: true, account_present: true, candidate_count: true, tested: true, succeeded: true, total: true, measured: true, server: true, country: true, city: true, tier: true, load: true, score: true, ping_ms: true, download_mbps: true, upload_mbps: true, services: true, service: true, servico: true, process_ids: true, pids: true, pid: true, generation: true, measurement_id: true, request_id: true, count: true, first_ts: true, last_ts: true, removed: true, removidos: true, busy: true, ocupados: true, invalid: true, inválidos: true, recent: true, recentes: true, dns_ok: true, https_ok: true, network_lock_reset: true, dns_cleared: true, dns_flushed: true, preflight: true, updated_at: true, detected: true, identity: true, candidate_kind: true, install_count: true, selected: true, target_count: true, injected: true, preserved: true, build: true, verify: true, size_bytes: true, digest: true, redaction_applied: true,
    // Campos que o código já registrava e o filtro descartava em silêncio (#404: as contagens do
    // IPv6 pulado, versão/canal do updater, o que sobrou da restauração do Windows).
    canal: true, versão: true, versao: true, versao_atual: true, versao_nova: true, estado: true, modo: true, servicos: true, issue: true, namespace: true, namespace_removed: true, skipped_addresses: true, skipped_dns: true, driver_service: true, adapter_default_route: true, residual: true, allowed_apps_count: true, dropped_keys: true,
    // Retrato do ambiente (env.snapshot) e falhas de instalação: só rótulos técnicos, nunca caminho ou nome.
    so: true, so_build: true, kernel: true, distro: true, ipv6_kernel: true, wg_modulo: true, empacotamento: true, sessao_grafica: true, cliente: true, fuso: true, wiresock_versao: true, wiresock_upgrade: true, msi_pasta_installer: true, significado: true, passo: true, step: true, elevacao: true, esperado: true, setup_erros: true, causa_provavel: true, acao_manual: true, operacao: true, segundos_desde: true,
};
const DEDUPE_EVENT = /(?:watchdog|progress|probe|diagnostic|diagnóstico)/i;

let idCounter = 0;

function utf8Bytes(value: string): number {
    try { return new TextEncoder().encode(value).length; } catch { return value.length; }
}
export function trimJsonlTailByBytes(bytes: Uint8Array, maxBytes: number): Uint8Array {
    const limit = Math.max(1, Math.floor(maxBytes));
    if (bytes.byteLength <= limit) return bytes;
    const keep = Math.floor(limit / 2);
    const tail = bytes.subarray(Math.max(0, bytes.byteLength - keep));
    const newline = tail.indexOf(10);
    return newline < 0 ? tail.subarray(0, 0) : tail.subarray(newline + 1);
}

export function createOperationId(prefix: string): string {
    const safe = String(prefix || "operation").trim().replace(/[^A-Za-z0-9_-]+/g, "-") || "operation";
    idCounter = (idCounter + 1) % 1_000_000;
    return `${safe}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

function clip(value: unknown, max = MAX_TEXT): string {
    const text = String(value ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
    return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

function redactString(value: string): string {
    return clip(value)
        .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+(?::[^\s/@]*)?@[^\s]+/gi, "<redacted-url>")
        .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "<email>")
        .replace(/((?:proxy-)?authorization\s*:\s*)(?:bearer\s+)?[^\s,;]+/gi, "$1<redacted>")
        .replace(/\b(?:bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer <redacted>")
        .replace(/(\b(?:password|senha|token|secret|captcha(?:token)?|twoFactorCode|2fa|authorization|privateKey|publicKey|endpoint)\s*[:=]\s*)[^\s,;]+/gi, "$1<redacted>")
        .replace(/(^|[\\/])Users[\\/][^\\/\s]+/gi, "$1Users/<user>")
        .replace(/(^|[\\/])home[\\/][^\\/\s]+/gi, "$1home/<user>")
        .replace(/(^|[\\/])var[\\/]home[\\/][^\\/\s]+/gi, "$1var/home/<user>");
}

function safeKey(key: string): boolean {
    return SAFE_KEYS[key.toLowerCase()] === true;
}

function sanitize(value: unknown, key: string, depth: number): unknown {
    if (SENSITIVE_KEY.test(key)) return "<redacted>";
    if (depth > MAX_DEPTH) return "<omitted>";
    if (typeof value === "string") return redactString(value);
    if (typeof value === "number") return Number.isFinite(value) ? value : "<omitted>";
    if (typeof value === "boolean" || value === null) return value;
    if (Array.isArray(value)) return value.slice(0, MAX_ARRAY).map(item => sanitize(item, key, depth + 1));
    if (typeof value !== "object") return "<omitted>";

    const output: Record<string, unknown> = {};
    const dropped: string[] = [];
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>).slice(0, MAX_KEYS)) {
        // Campo opcional não preenchido: não vira "<omitted>" nem conta como descartado.
        if (childValue === undefined) continue;
        const normalized = childKey.replace(/[A-Z]/g, character => `_${character.toLowerCase()}`).toLowerCase();
        // Número e booleano não carregam nome, caminho nem segredo: passam com qualquer chave que
        // não seja sensível. Texto fora da lista branca continua fora, mas deixa o nome da chave
        // em dropped_keys: antes sumia sem marca, e quem lia o log achava que o dado nem existia.
        const harmless = typeof childValue === "boolean" || (typeof childValue === "number" && Number.isFinite(childValue));
        if (!safeKey(normalized) && !SENSITIVE_KEY.test(normalized) && !harmless
            && (childValue === null || typeof childValue !== "object")) {
            if (dropped.length < 8) dropped.push(clip(childKey, 40));
            continue;
        }
        output[childKey] = sanitize(childValue, normalized, depth + 1);
    }
    if (dropped.length) output.dropped_keys = dropped;
    return output;
}

export function redactPluginData(data?: Record<string, unknown>): Record<string, unknown> | undefined {
    if (!data) return undefined;
    const result = sanitize(data, "data", 0);
    return result && typeof result === "object" && !Array.isArray(result) ? result as Record<string, unknown> : undefined;
}

function validContext(value: unknown, max = 160): string | undefined {
    if (typeof value !== "string") return undefined;
    const text = value.trim();
    if (!text || text.length > max || /[\r\n\t]/.test(text)) return undefined;
    return text;
}

function eventName(value: string): string {
    const normalized = value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
    return normalized.slice(0, 120) || "plugin.event";
}
// O texto que vai no relato leva mês/dia e o "Z" do UTC: só o horário, sem data e sem fuso, fazia
// o "22:37" que a pessoa contava não bater com o "01:37" do log (#404), e o arquivo junta dias.
// Fase e operação vão na linha: sem elas, três "linux.network.phase" seguidos pareciam iguais.
function legacyLine(record: PluginLogRecord): string {
    const stamp = `${record.ts.slice(5, 23)}Z`;
    const label = record.message ? redactString(record.message) : record.event;
    const fields: string[] = [];
    if (record.operation_id) fields.push(`op=${record.operation_id}`);
    if (record.phase && record.data?.phase === undefined) fields.push(`phase=${record.phase}`);
    for (const [key, value] of Object.entries(record.data || {})) {
        const text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
        fields.push(`${key}=${clip(text, 300)}`);
    }
    if (record.count && record.count > 1) fields.push(`count=${record.count}`);
    return `${stamp} [${record.level}] [${record.component}] ${label}${fields.length ? ` | ${fields.join(" ")}` : ""}`;
}

function sameDedupe(a: PluginLogRecord, b: PluginLogRecord): boolean {
    return a.level === b.level && a.component === b.component && a.event === b.event && a.operation_id === b.operation_id
        && JSON.stringify(a.data || {}) === JSON.stringify(b.data || {});
}
function validTimestamp(value: unknown): string | undefined {
    if (typeof value !== "string" || value.length > 40 || Number.isNaN(Date.parse(value))) return undefined;
    return value;
}

/**
 * Relaunch no namespace aceito sem nenhuma abertura do plugin depois: o cliente relançado morreu
 * antes de carregar o plugin. Na #404 (SIGILL no NixOS) o log ficava em silêncio entre o relaunch
 * e a reabertura manual, e só o coredump mostrou o crash. Chamar antes de registrar a abertura atual.
 */
export function pendingNamespaceRelaunch(records: readonly PluginLogRecord[]): { at: string; namespace?: string; operation_id?: string } | null {
    for (let index = records.length - 1; index >= 0; index--) {
        const record = records[index];
        if (record.event === "plugin.process.started") return null;
        if (record.message?.includes("relaunch no namespace aceito")) {
            const namespace = typeof record.data?.namespace === "string" ? record.data.namespace : undefined;
            return { at: record.ts, namespace, operation_id: record.operation_id };
        }
    }
    return null;
}

export function createPluginLogger(options: PluginLoggerOptions): PluginLogger {
    const maxEvents = Math.max(1, Math.floor(options.maxEvents ?? 400));
    const maxBytes = Math.max(1024, Math.floor(options.maxBytes ?? 128 * 1024));
    const now = options.now || (() => new Date());
    const ring: PluginLogRecord[] = [];
    let ringBytes = 0;
    let lastDedupeAt = 0;
    const trimRing = () => {
        while (ring.length > maxEvents || ringBytes > maxBytes) {
            const removed = ring.shift();
            if (removed) ringBytes -= utf8Bytes(JSON.stringify(removed));
        }
    };
    const appendRing = (record: PluginLogRecord) => {
        ring.push(record);
        ringBytes += utf8Bytes(JSON.stringify(record));
        trimRing();
    };

    const mergeAggregate = (target: PluginLogRecord, incoming: PluginLogRecord): void => {
        const before = utf8Bytes(JSON.stringify(target));
        target.count = Math.max(target.count, incoming.count);
        target.first_ts = target.first_ts < incoming.first_ts ? target.first_ts : incoming.first_ts;
        target.last_ts = target.last_ts > incoming.last_ts ? target.last_ts : incoming.last_ts;
        ringBytes += utf8Bytes(JSON.stringify(target)) - before;
        trimRing();
    };

    const emit = (level: PluginLogLevel, rawEvent: string, context: PluginLogContext = {}, data?: Record<string, unknown>, message?: string): PluginLogRecord | null => {
        const date = now();
        const ts = date.toISOString();
        const event = eventName(rawEvent);
        const sanitizedData = redactPluginData(data);
        const record: PluginLogRecord = {
            schema_version: 1,
            ts,
            level,
            event,
            component: eventName(context.component || options.component),
            operation_id: validContext(context.operation_id),
            attempt_id: validContext(context.attempt_id),
            phase: validContext(context.phase, 80),
            plugin_version: validContext(context.plugin_version || options.pluginVersion, 80),
            platform: validContext(context.platform || options.platform, 40),
            arch: validContext(context.arch || options.arch, 40),
            message: message ? redactString(clip(message, MAX_MESSAGE)) : undefined,
            data: sanitizedData,
            count: 1,
            first_ts: ts,
            last_ts: ts,
        };
        const previous = ring[ring.length - 1];
        const elapsed = date.getTime() - lastDedupeAt;
        const dedupe = Boolean(previous && DEDUPE_EVENT.test(event) && sameDedupe(previous, record) && elapsed < (event.includes("progress") ? 2_000 : 60_000));
        if (dedupe && previous) {
            record.count = previous.count + 1;
            mergeAggregate(previous, record);
            try { options.onLine?.(`${JSON.stringify(previous)}\n`); } catch { /* logging never interrupts the operation */ }
            return previous;
        }
        if (DEDUPE_EVENT.test(event)) lastDedupeAt = date.getTime();
        appendRing(record);
        try { options.onLine?.(`${JSON.stringify(record)}\n`); } catch { /* logging never interrupts the operation */ }
        return record;
    };

    const restore = (lines: readonly string[]) => {
        for (const line of lines) {
            try {
                const value = JSON.parse(line) as PluginLogRecord;
                const ts = validTimestamp(value?.ts);
                if (value?.schema_version !== 1 || !ts || typeof value.event !== "string") continue;
                if (value.level !== "info" && value.level !== "warn" && value.level !== "error") continue;
                const restored: PluginLogRecord = {
                    schema_version: 1,
                    ts,
                    level: value.level,
                    component: eventName(typeof value.component === "string" ? value.component : options.component),
                    event: eventName(value.event),
                    operation_id: validContext(value.operation_id),
                    attempt_id: validContext(value.attempt_id),
                    phase: validContext(value.phase, 80),
                    plugin_version: validContext(value.plugin_version || options.pluginVersion, 80),
                    platform: validContext(value.platform || options.platform, 40),
                    arch: validContext(value.arch || options.arch, 40),
                    message: typeof value.message === "string" ? redactString(value.message) : undefined,
                    data: redactPluginData(value.data),
                    count: Number.isInteger(value.count) && Number(value.count) > 0 ? Math.min(Number(value.count), 1_000_000) : 1,
                    first_ts: validTimestamp(value.first_ts) || ts,
                    last_ts: validTimestamp(value.last_ts) || ts,
                };
                const previous = ring[ring.length - 1];
                if (previous && DEDUPE_EVENT.test(restored.event) && sameDedupe(previous, restored)) mergeAggregate(previous, restored);
                else appendRing(restored);
            } catch { /* ignore legacy or truncated lines */ }
        }
    };

    return {
        emit,
        info: (event, context, data, message) => emit("info", event, context, data, message),
        warn: (event, context, data, message) => emit("warn", event, context, data, message),
        error: (event, context, data, message) => emit("error", event, context, data, message),
        restore,
        records: () => ring,
        getLog: () => ring.map(legacyLine).join("\n"),
    };
}
