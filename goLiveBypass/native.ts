/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NativeSettings, RendererSettings } from "@main/settings";
import { app, IpcMainInvokeEvent, session } from "electron";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { request } from "https";
import { AddressInfo, connect, createServer, Server, Socket } from "net";
import { dirname, join } from "path";
import { connect as connectTls } from "tls";

const FREE_PROXY_API = "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=socks5&proxy_format=protocolipport&format=json&timeout=1500";
const DISCORD_HOST = "discord.com";

// O trace da Cloudflare (~200 bytes) confirma tunel, TLS valido e pais de saida numa conexao
// so. O ifconfig.co que estava aqui devolvia um JSON inteiro e, pior, um 429 dele nao casava
// o padrao e uma candidata boa era descartada como pais desconhecido.
const TRACE_HOST = "cloudflare.com";
const TRACE_PATH = "/cdn-cgi/trace";

// Os unicos hosts que precisam passar pela saida: e na conexao do gateway que o servidor
// decide se a conta pode transmitir. Imagem, anexo, GIF, video incorporado e a propria voz
// nunca encostam nela. Os hosts de login so entram na lista quando a pessoa pede, pela
// setting sessionRouting: esconde o IP real na autenticacao, ao custo de uma abertura lenta.
const GATEWAY_HOSTS = ["gateway.discord.gg", "remote-auth-gateway.discord.gg"];
const LOGIN_HOSTS = ["discord.com", "canary.discord.com", "ptb.discord.com"];

// Todo o dominio do gateway entra na rota, nao so os dois nomes acima: o Discord conecta em
// subdominios regionais (gateway-us-east1-b.discord.gg) que a lista exata deixava escapar.
// Os CDN de midia sao discordapp.com, outro dominio, e continuam fora daqui.
const ROUTE_SUFFIX = ".discord.gg";

function isGatewayHost(host: string): boolean {
    return host === "discord.gg" || host.endsWith(ROUTE_SUFFIX);
}

const MAX_LIST_BYTES = 1024 * 1024;
const PROBE_TIMEOUT_MS = 6000;

// Prazo curto para as checagens no caminho de abertura: cada segundo aqui sai do orcamento
// que segura o gateway a espera de uma saida.
const WARM_PROBE_TIMEOUT_MS = 2500;

const PARALLEL_PROBES = 12;
const MAX_CANDIDATES = 48;
const MIN_UPTIME = 90;
const MAX_LISTED_TIMEOUT = 1500;

// Portas SOCKS de clientes Tor, em ordem de preferencia: 9060 e a porta dedicada que o
// GoLiveBypass usa (GUI e instaladores), 9052 e a porta comum de um Tor configurado a mao
// com bridge, e as outras sao Tor Browser, daemon e Brave. Uma porta fechada recusa na
// hora, entao tentar todas nao custa relogio nenhum.
const TOR_PORTS = [9060, 9052, 9150, 9050, 9250];
const TOR_PORT_TIMEOUT_MS = 400;

const POOL_SIZE = 5;
const POOL_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// De quanto em quanto tempo as saidas do pote sao reconferidas com a sessao ja aberta. Trinta
// segundos e curto o bastante para a reserva estar quente quando o gateway reconectar, e longo
// o bastante para nao virar carga na saida gratuita, que costuma limitar conexoes.
const HEARTBEAT_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 4000;

// Quantos batimentos seguidos uma saida pode errar antes de sair do pote. Cortar no primeiro
// seria cruel com saida gratuita congestionada, que erra um e volta; nunca cortar deixaria o
// pote cheio de endereco morto, que e o mesmo que nao ter reserva nenhuma.
const MAX_MISSED_BEATS = 2;

// Abaixo disto o batimento vai atras de reservas novas. Uma so nao e reserva: e a proxima a
// morrer.
const MIN_LIVE_RESERVES = 2;

// Trava entre buscas de fundo: sem ela, um pote que nao consegue encher viraria uma varredura
// inteira da lista gratuita a cada trinta segundos, pela sessao toda.
const HUNT_COOLDOWN_MS = 3 * 60_000;

const MAX_LOG_LINES = 400;
const MAX_LOG_BYTES = 256 * 1024;
const MAX_RETRIES = 2;

// Quanto uma conexao de gateway espera por uma saida antes de sair direta. Segurar para
// sempre travaria o login; soltar na hora perderia a corrida em toda abertura fria. Se
// estourar, perde-se o Go Live daquela sessao, nunca o Discord.
const STALL_BUDGET_MS = 12_000;

// Menores que o teste de candidata: uma saida agonizante que demora a falhar no trafego vivo
// faria o Chromium desistir do roteador inteiro.
const RELAY_TUNNEL_TIMEOUT_MS = 2500;
const RELAY_DIRECT_TIMEOUT_MS = 8000;

const INTERCEPTING_PORTS = new Set([4145]);

// O trecho antes do @ e opcional e casado com ganancia, para a senha poder conter @ e : sem
// precisar de escape: quem recebe um endereco pronto da AWS costuma cola-lo como veio.
const PROXY_RULES_RE = /^(socks5|https?):\/\/(?:(.+)@)?([a-z0-9.-]{1,253}):(\d{1,5})(?:-(\d{1,5}))?$/;

export type Scope = "login" | "gateway" | "off";

interface PoolEntry {
    proxy: string;
    country: string;
    ms: number;
    at: number;
}

// A pasta e a mesma que o modo standalone usa. Quem experimentou os dois acha um arquivo so,
// em vez de descobrir depois que estava lendo o registro do outro.
function logDir() {
    const local = process.platform === "win32"
        ? process.env.LOCALAPPDATA
        : process.env.XDG_DATA_HOME ?? (process.env.HOME === undefined ? undefined : join(process.env.HOME, ".local", "share"));

    return local === undefined ? null : join(local, "GoLiveBypass");
}

const LOG_FILE = logDir() === null ? null : join(logDir() as string, "golivebypass.log");

const history: string[] = [];

let retries = 0;

function log(message: string) {
    const line = `${new Date().toISOString().slice(11, 23)} ${message}`;
    history.push(line);
    if (history.length > MAX_LOG_LINES) history.shift();

    if (LOG_FILE === null) return;
    try {
        // Cortado sozinho para nao crescer sem fim numa maquina que ninguem limpa.
        if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > MAX_LOG_BYTES)
            writeFileSync(LOG_FILE, readFileSync(LOG_FILE, "utf8").slice(-MAX_LOG_BYTES / 2));
        else if (!existsSync(LOG_FILE))
            mkdirSync(dirname(LOG_FILE), { recursive: true });

        appendFileSync(LOG_FILE, `${line}\n`);
    } catch (error) {
        // Ficar sem registro e ruim; derrubar o Discord por causa do registro e pior.
        history.push(`${new Date().toISOString().slice(11, 23)} nao consegui gravar o arquivo de registro: ${error instanceof Error ? error.message : String(error)}`);
    }
}

// O renderer tem o que o processo principal nao ve: a atribuicao do servidor, o estado da
// transmissao, a regiao. Sem isto o arquivo contaria metade da historia.
export function logFromRenderer(_: IpcMainInvokeEvent, message: unknown) {
    if (typeof message === "string" && message.length > 0) log(message.slice(0, 2000));
}

function parseProxy(proxyRules: string) {
    const match = PROXY_RULES_RE.exec(proxyRules);
    if (!match) return null;

    const port = Number(match[4]);
    if (port < 1 || port > 65535) return null;

    // Dividido no primeiro dois-pontos, entao a senha pode ter quantos quiser.
    const credentials = match[2] ?? "";
    const split = credentials.indexOf(":");
    const decode = (value: string) => {
        try {
            return decodeURIComponent(value);
        } catch {
            // Um % solto no meio da senha nao e escape, e literal.
            return value;
        }
    };

    return {
        scheme: match[1],
        user: credentials === "" ? "" : decode(split < 0 ? credentials : credentials.slice(0, split)),
        pass: credentials === "" || split < 0 ? "" : decode(credentials.slice(split + 1)),
        host: match[3],
        port
    };
}

// Nunca registrar a senha: o registro vai para arquivo e as pessoas colam ele em relato de
// problema.
function safeProxy(proxyRules: string) {
    const parsed = parseProxy(proxyRules);
    if (parsed === null) return "endereco invalido";

    const credentials = parsed.user === "" ? "" : `${parsed.user}:***@`;
    return `${parsed.scheme}://${credentials}${parsed.host}:${parsed.port}`;
}

function pluginSettings() {
    return RendererSettings.plain.plugins?.GoLiveBypass;
}

function pluginEnabled() {
    return pluginSettings()?.enabled === true;
}

// Tres respostas: campo vazio (procure sozinho), endereco bom (use este), lixo (nao invente
// uma saida que a pessoa nao escolheu: invalido nao pode virar "vazio", ou a sessao cairia
// na lista gratuita sem a pessoa saber).
function manualProxy(): { proxy: string; } | "auto" | "invalid" {
    const proxy = pluginSettings()?.proxy;
    if (typeof proxy !== "string" || proxy.trim() === "") return "auto";

    const trimmed = proxy.trim();
    return parseProxy(trimmed) === null ? "invalid" : { proxy: trimmed };
}

function excludedCountries() {
    const raw: unknown = pluginSettings()?.excludedCountries;
    const codes = typeof raw === "string" ? raw.split(",") : ["BR"];

    return new Set(codes.map(code => code.trim().toUpperCase()).filter(code => /^[A-Z]{2}$/.test(code)));
}

// O renderer manda a propria lista nas chamadas que ele inicia: e a copia que a pessoa esta
// vendo agora. O nome do parametro cobre o da funcao acima dentro daquelas funcoes, entao a
// leitura das settings precisa de nome proprio.
function requestedCountries(raw: unknown) {
    return new Set(
        typeof raw === "string"
            ? raw.split(",").map(code => code.trim().toUpperCase()).filter(code => /^[A-Z]{2}$/.test(code))
            : []
    );
}

function routesLogin() {
    return pluginSettings()?.sessionRouting === "login";
}

function readPool(): PoolEntry[] {
    let stored: unknown;
    try {
        stored = NativeSettings.plain.plugins?.GoLiveBypass?.pool;
    } catch {
        return [];
    }

    if (!Array.isArray(stored)) return [];

    return stored.filter((entry): entry is PoolEntry => {
        if (typeof entry !== "object" || entry === null) return false;

        const { proxy, country, ms, at } = entry as Partial<PoolEntry>;
        return typeof proxy === "string" && parseProxy(proxy) !== null
            && typeof country === "string" && typeof ms === "number"
            && typeof at === "number" && Date.now() - at < POOL_MAX_AGE_MS;
    });
}

// Duas instancias do Discord dividem este arquivo; gravar pode falhar por disputa. Perder o
// pote custa uma busca a mais no proximo boot -- deixar a excecao subir custava o processo.
function writePool(entries: PoolEntry[]) {
    try {
        NativeSettings.store.plugins.GoLiveBypass ??= {};
        NativeSettings.store.plugins.GoLiveBypass.pool = entries
            .sort((a, b) => a.ms - b.ms)
            .slice(0, POOL_SIZE);
    } catch {
        // sem pote guardado, o proximo boot procura de novo
    }
}

// ------------------------------------------------------------------ falar com uma saida

function readReply(socket: Socket, size: (buffer: Buffer) => number, done: (reply: Buffer | null) => void) {
    const chunks: Buffer[] = [];
    let settled = false;

    const finish = (reply: Buffer | null) => {
        if (settled) return;
        settled = true;
        socket.off("data", onData);
        socket.off("close", onClose);
        done(reply);
    };

    const onData = (chunk: Buffer) => {
        chunks.push(chunk);
        const buffer = Buffer.concat(chunks);
        const wanted = size(buffer);
        if (wanted < 0 || buffer.length < wanted) return;

        socket.pause();
        if (buffer.length > wanted) socket.unshift(buffer.subarray(wanted));
        finish(buffer.subarray(0, wanted));
    };

    // Um proxy que aceita a conexao e fecha limpo no meio da negociacao nao gera erro nenhum:
    // FIN nao e erro. Sem escutar o fechamento o callback nunca era chamado e a candidata
    // gastava o prazo inteiro antes de cair, uma por uma, no caminho sequencial.
    const onClose = () => finish(null);

    socket.on("data", onData);
    socket.on("close", onClose);
    socket.resume();
}

function socksReplySize(buffer: Buffer) {
    if (buffer.length < 4) return -1;
    if (buffer[3] === 1) return 10;
    if (buffer[3] === 4) return 22;
    return buffer.length < 5 ? -1 : 7 + buffer[4];
}

function negotiateSocks5(socket: Socket, host: string, port: number, credentials: { user: string; pass: string; }, done: (ok: boolean) => void) {
    const requestTarget = () => {
        readReply(socket, socksReplySize, reply => done(reply !== null && reply[1] === 0));

        const target = Buffer.from(host, "latin1");
        socket.write(Buffer.concat([
            Buffer.from([5, 1, 0, 3, target.length]),
            target,
            Buffer.from([port >> 8, port & 0xff])
        ]));
    };

    readReply(socket, buffer => buffer.length < 2 ? -1 : 2, greeting => {
        if (greeting === null || greeting[0] !== 5) return done(false);

        // 0 = sem autenticacao, 2 = usuario e senha (RFC 1929). Qualquer outro metodo, ou 0xFF,
        // significa que o proxy nao aceita nada que a gente sabe fazer.
        if (greeting[1] === 0) return requestTarget();
        if (greeting[1] !== 2) return done(false);

        const user = Buffer.from(credentials.user, "utf8");
        const pass = Buffer.from(credentials.pass, "utf8");
        if (user.length > 255 || pass.length > 255) return done(false);

        readReply(socket, buffer => buffer.length < 2 ? -1 : 2, reply => {
            if (reply === null || reply[1] !== 0) return done(false);
            requestTarget();
        });

        socket.write(Buffer.concat([
            Buffer.from([1, user.length]), user,
            Buffer.from([pass.length]), pass
        ]));
    });

    // Oferecer o metodo 2 so quando ha credencial: um proxy que aceita os dois escolheria a
    // autenticacao a toa, e ai um usuario vazio seria recusado.
    socket.write(credentials.user === "" ? Buffer.from([5, 1, 0]) : Buffer.from([5, 2, 0, 2]));
}

function negotiateConnect(socket: Socket, host: string, port: number, credentials: { user: string; pass: string; }, done: (ok: boolean) => void) {
    readReply(socket, buffer => {
        const end = buffer.indexOf("\r\n\r\n");
        return end < 0 ? -1 : end + 4;
    }, reply => done(reply !== null && /^HTTP\/1\.[01] 200/.test(reply.toString("latin1"))));

    // O proxy HTTP nao negocia metodo: ou a credencial vai junto do CONNECT, ou ele responde
    // 407 e a conexao ja era.
    const auth = credentials.user === ""
        ? ""
        : `Proxy-Authorization: Basic ${Buffer.from(`${credentials.user}:${credentials.pass}`, "utf8").toString("base64")}\r\n`;

    socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`);
}

function openDirect(host: string, port: number, timeoutMs: number): Promise<Socket | null> {
    return new Promise(resolve => {
        const socket = connect({ host, port });
        let settled = false;

        const finish = (result: Socket | null) => {
            if (settled) return;
            settled = true;
            clearTimeout(guard);
            socket.setTimeout(0);
            if (result === null) socket.destroy();
            resolve(result);
        };

        const guard = setTimeout(() => finish(null), timeoutMs);
        socket.setTimeout(timeoutMs, () => finish(null));
        socket.on("error", () => finish(null));
        socket.once("connect", () => finish(socket));
    });
}

function openTunnel(proxy: string, host: string, port: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<Socket | null> {
    const parsed = parseProxy(proxy);
    if (parsed === null) return Promise.resolve(null);

    return new Promise(resolve => {
        const socket = connect({ host: parsed.host, port: parsed.port });
        let settled = false;

        const finish = (tunnel: Socket | null) => {
            if (settled) return;
            settled = true;
            clearTimeout(guard);
            socket.setTimeout(0);
            if (tunnel === null) socket.destroy();
            resolve(tunnel);
        };

        const guard = setTimeout(() => finish(null), timeoutMs);
        socket.setTimeout(timeoutMs, () => finish(null));
        socket.on("error", () => finish(null));
        socket.once("connect", () => {
            const done = (ok: boolean) => finish(ok ? socket : null);
            if (parsed.scheme === "socks5") negotiateSocks5(socket, host, port, parsed, done);
            else negotiateConnect(socket, host, port, parsed, done);
        });
    });
}

// Abre o mesmo destino por varias saidas ao mesmo tempo e fica com a primeira que responder.
// Quem chega depois e fechado na hora: tunel aberto e esquecido segura uma conexao do outro
// lado, e saida gratuita costuma ter poucas.
function firstTunnel(candidates: string[], host: string, port: number, timeoutMs: number): Promise<{ proxy: string; socket: Socket; } | null> {
    return new Promise(resolve => {
        let pending = candidates.length;
        if (pending === 0) return resolve(null);

        let settled = false;

        for (const candidate of candidates) {
            openTunnel(candidate, host, port, timeoutMs).then(socket => {
                if (socket !== null && !settled) {
                    settled = true;
                    resolve({ proxy: candidate, socket });
                    return;
                }

                socket?.destroy();
                if (--pending === 0 && !settled) resolve(null);
            });
        }
    });
}

function readOverTls(socket: Socket, host: string, path: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<string | null> {
    return new Promise(resolve => {
        let body = "";
        let settled = false;

        const finish = (value: string | null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            tls.destroy();
            resolve(value);
        };

        const timer = setTimeout(() => finish(null), timeoutMs);
        const tls = connectTls({ socket, servername: host, host }, () => {
            tls.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nAccept: */*\r\nConnection: close\r\n\r\n`);
        });

        tls.setEncoding("latin1");
        tls.on("error", () => finish(null));
        tls.on("data", (chunk: string) => {
            body += chunk;
            if (body.length > 65536) finish(body);
        });
        tls.on("end", () => finish(body));
    });
}

function listening(port: number, timeoutMs: number): Promise<boolean> {
    return new Promise(resolve => {
        const socket = connect({ host: "127.0.0.1", port });
        const finish = (open: boolean) => {
            socket.destroy();
            resolve(open);
        };

        socket.setTimeout(timeoutMs, () => finish(false));
        socket.once("connect", () => finish(true));
        socket.on("error", () => finish(false));
    });
}

function downloadText(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const req = request(url, res => {
            if (res.statusCode !== 200) {
                res.resume();
                reject(new Error("Unexpected response status"));
                return;
            }

            const chunks: Buffer[] = [];
            let size = 0;
            let settled = false;

            res.on("data", (chunk: Buffer) => {
                if (settled) return;

                size += chunk.length;
                if (size > MAX_LIST_BYTES) {
                    settled = true;
                    res.destroy();
                    reject(new Error("Response too large"));
                    return;
                }

                chunks.push(chunk);
            });

            res.on("end", () => {
                if (settled) return;
                settled = true;
                resolve(Buffer.concat(chunks).toString("utf8"));
            });
        });

        req.on("error", reject);
        req.setTimeout(15_000, () => req.destroy(new Error("Request timed out")));
        req.end();
    });
}

// ------------------------------------------------------------------ provar uma saida

// O trace da Cloudflare prova que a saida chega na internet, nao que alcanca o Discord --
// uma rede que bloqueia so dominios do Discord passaria no Cloudflare e falharia aqui. Nao
// exige HTTP 200 (gateway.discord.gg responde 404 a um GET comum): qualquer status valido
// ja prova que a conexao e o TLS chegaram la.
async function reachesGateway(proxy: string, timeoutMs: number) {
    const socket = await openTunnel(proxy, GATEWAY_HOSTS[0], 443, timeoutMs);
    if (socket === null) return false;

    const response = await readOverTls(socket, GATEWAY_HOSTS[0], "/", timeoutMs);
    return response !== null && /^HTTP\/1\.[01] \d{3}/.test(response);
}

// Prova o que interessa numa saida: o tunel negocia (com login, se houver), o TLS fecha com
// certificado valido, o pais de saida e conhecido e o gateway do Discord responde por ela.
// Saida barrada por reputacao falha exatamente aqui, que e o motivo de o teste nao ser contra
// um endereco qualquer.
async function measure(proxy: string, timeoutMs = PROBE_TIMEOUT_MS) {
    const started = Date.now();

    const socket = await openTunnel(proxy, TRACE_HOST, 443, timeoutMs);
    if (socket === null) return null;

    const response = await readOverTls(socket, TRACE_HOST, TRACE_PATH, timeoutMs);
    if (response === null || !/^HTTP\/1\.[01] 200/.test(response)) return null;

    const country = /(?:^|\n)loc=([A-Za-z]{2})/.exec(response);
    if (country === null) return null;

    const ip = /(?:^|\n)ip=(\S+)/.exec(response);

    // As duas conexoes sao feitas em sequencia de proposito: proxy gratuita sobrecarregada
    // costuma limitar conexoes simultaneas, e abrir duas de uma vez reprovaria candidata boa.
    if (!(await reachesGateway(proxy, timeoutMs))) return null;

    return { proxy, country: country[1].toUpperCase(), ip: ip?.[1] ?? "", ms: Date.now() - started };
}

// Todo o lote anda junto e a primeira que responder bem ganha -- testar candidata por
// candidata podia somar um minuto sozinho, bem no caminho em que o gateway ja esta conectando.
function firstUsable(candidates: string[], excluded: Set<string>, timeoutMs: number): Promise<PoolEntry | null> {
    return new Promise(resolve => {
        let pending = candidates.length;
        if (pending === 0) return resolve(null);

        let settled = false;

        // candidates.map(measure) pareceria igual mas nao e: map passa (item, indice, array),
        // e o indice cairia em timeoutMs, dando zero ms para a candidata numero zero.
        for (const candidate of candidates) {
            measure(candidate, timeoutMs).then(result => {
                if (!settled && result !== null && !excluded.has(result.country)) {
                    settled = true;
                    log(`${safeProxy(result.proxy)} passou: ${result.ms}ms, saida em ${result.country}`);
                    resolve({ proxy: result.proxy, country: result.country, ms: result.ms, at: Date.now() });
                    return;
                }

                if (result !== null && excluded.has(result.country)) log(`${safeProxy(result.proxy)} recusada: saida em ${result.country}`);
                if (--pending === 0 && !settled) resolve(null);
            });
        }
    });
}

async function torExit(excluded: Set<string>, timeoutMs: number) {
    for (const port of TOR_PORTS) {
        const proxy = `socks5://127.0.0.1:${port}`;
        if (!await listening(port, TOR_PORT_TIMEOUT_MS)) continue;

        const found = await firstUsable([proxy], excluded, timeoutMs);
        if (found !== null) {
            log(`Tor local encontrado na porta ${port}`);
            return found;
        }

        log(`porta ${port} aberta mas nao respondeu como proxy, ignorando`);
    }

    return null;
}

function rankFreeProxies(body: string, excluded: Set<string>) {
    const data: unknown = JSON.parse(body);
    const { proxies } = data as { proxies?: unknown; };
    if (!Array.isArray(proxies)) return [];

    const usable: { proxy: string; uptime: number; timeout: number; }[] = [];

    for (const item of proxies) {
        if (typeof item !== "object" || item === null) continue;

        const entry = item as {
            proxy?: unknown;
            alive?: unknown;
            uptime?: unknown;
            timeout?: unknown;
            ip_data?: { countryCode?: unknown; };
        };

        if (typeof entry.proxy !== "string" || entry.alive !== true) continue;

        const parsed = parseProxy(entry.proxy);
        // A porta 4145 e quase toda de intermediario que responde por qualquer destino sem
        // encaminhar nada. Ela reprova no teste, mas so depois de gastar o prazo.
        if (parsed === null || INTERCEPTING_PORTS.has(parsed.port)) continue;

        const uptime = typeof entry.uptime === "number" ? entry.uptime : 0;
        const timeout = typeof entry.timeout === "number" ? entry.timeout : MAX_LISTED_TIMEOUT;
        if (uptime < MIN_UPTIME || timeout > MAX_LISTED_TIMEOUT) continue;

        const country = typeof entry.ip_data?.countryCode === "string" ? entry.ip_data.countryCode.toUpperCase() : "";
        if (excluded.has(country)) continue;

        usable.push({ proxy: entry.proxy, uptime, timeout });
    }

    return usable
        .sort((a, b) => b.uptime - a.uptime || a.timeout - b.timeout)
        .slice(0, MAX_CANDIDATES)
        .map(entry => entry.proxy);
}

async function freeExit(excluded: Set<string>, want: number): Promise<PoolEntry[]> {
    let candidates: string[];
    try {
        candidates = rankFreeProxies(await downloadText(FREE_PROXY_API), excluded);
    } catch {
        return [];
    }

    log(`${candidates.length} candidatas depois do ranqueamento`);

    const found: PoolEntry[] = [];

    for (let i = 0; i < candidates.length && found.length < want; i += PARALLEL_PROBES) {
        const winner = await firstUsable(candidates.slice(i, i + PARALLEL_PROBES), excluded, PROBE_TIMEOUT_MS);
        if (winner !== null) found.push(winner);
    }

    return found;
}

// Reabastecer o pote e uma escolha nova podem correr ao mesmo tempo; duas buscas paralelas
// disputam a mesma banda e dobram o tempo ate a primeira saida ficar pronta, que e exatamente
// a janela em que o gateway conecta sem protecao. Quem chegar depois espera a que ja corre.
let hunting: Promise<PoolEntry[]> | null = null;

function sharedFreeExit(excluded: Set<string>, want: number) {
    hunting ??= freeExit(excluded, want).finally(() => { hunting = null; });
    return hunting;
}

// ------------------------------------------------------------------ escolher a saida

let exit: string | null = null;
let exitSettled = false;
let waiting: ((value: string | null) => void)[] = [];

function settleExit(value: string | null) {
    exit = value;
    exitSettled = true;

    const pending = waiting;
    waiting = [];
    for (const resume of pending) resume(value);
}

// Uma conexao de gateway que chega antes de existir saida espera aqui, e nao para sempre:
// estourado o prazo ela sai direta. Discord aberto sem bypass e ruim; Discord que nao abre e
// muito pior, e foi o pior defeito que este projeto ja teve.
function currentExit(): Promise<string | null> {
    if (exitSettled) return Promise.resolve(exit);

    return new Promise(resolve => {
        const resume = (value: string | null) => {
            clearTimeout(guard);
            resolve(value);
        };

        const guard = setTimeout(() => {
            waiting = waiting.filter(entry => entry !== resume);
            log("nenhuma saida ficou pronta a tempo, esta conexao vai direta");
            resolve(null);
        }, STALL_BUDGET_MS);

        waiting.push(resume);
    });
}

// Saida que falhou no trafego vivo sai do pote e a busca recomeca em segundo plano. Ate a
// nova chegar, o roteador manda direto: custa o Go Live daquela sessao, nunca a conexao.
function dropExit(dead: string, excluded?: Set<string>) {
    if (exit !== dead) return;

    log(`${safeProxy(dead)} parou de entregar, tirando do pote e procurando outra`);
    writePool(readPool().filter(entry => entry.proxy !== dead));
    missed.delete(dead);
    exit = null;

    // Volta a segurar conexao nova enquanto a busca corre. Sem isto, toda conexao de gateway
    // que chegasse durante a troca sairia direta na hora -- e a reconexao logo depois de uma
    // saida morrer e justamente a que decide se a transmissao sobrevive. O then fecha a corrida
    // de a busca em curso ja ter passado pelo settleExit: sem ele os que esperam so sairiam
    // pelo prazo, doze segundos parados.
    exitSettled = false;
    void chooseExit(excluded).then(() => { if (!exitSettled) settleExit(exit); });
}

// Guarda a promessa, nao um booleano: retryWithProxy precisa esperar o resultado antes de
// recarregar, senao veria "ja tem alguem escolhendo" e recarregaria sem saida nenhuma.
let choosing: Promise<void> | null = null;

function chooseExit(excluded?: Set<string>) {
    choosing ??= runChoice(excluded ?? excludedCountries()).finally(() => { choosing = null; });
    return choosing;
}

// Nada aqui pode escapar: no processo principal do Discord, uma promessa rejeitada sem
// tratamento derruba o processo inteiro.
async function runChoice(excluded: Set<string>) {
    try {
        await pickExit(excluded);
    } catch {
        // Quem ja escolheu nao perde a saida por um erro vindo depois.
        if (!exitSettled) settleExit(null);
    }
}

async function pickExit(excluded: Set<string>) {
    const manual = manualProxy();
    if (manual === "invalid") {
        log("o endereco do campo Proxy nao e valido, nenhuma saida foi usada");
        return settleExit(null);
    }

    if (manual !== "auto") {
        // Sem testar, uma saida fora do ar viraria conexao direta dentro do roteador e o
        // bypass falharia em silencio, que foi exatamente o que aconteceu com o Tor fechado.
        const started = Date.now();
        if (await measure(manual.proxy, WARM_PROBE_TIMEOUT_MS) !== null) {
            log(`seu proxy respondeu em ${Date.now() - started}ms: ${safeProxy(manual.proxy)}`);
            return settleExit(manual.proxy);
        }

        log(`seu proxy nao respondeu: ${safeProxy(manual.proxy)}`);
        log("se for Tor, ele precisa estar aberto ANTES do Discord. Procurando alternativa.");
    }

    return autoExit(excluded);
}

async function autoExit(excluded: Set<string>) {
    const pool = readPool();
    if (pool.length > 0) {
        const warm = await firstUsable(pool.map(entry => entry.proxy), excluded, WARM_PROBE_TIMEOUT_MS);
        if (warm !== null) {
            log(`saida guardada revalidada em ${warm.ms}ms: ${safeProxy(warm.proxy)}`);
            settleExit(warm.proxy);

            // Solta sem esperar: o pote so serve para o proximo boot, e prender a escolha ate
            // encher deixaria a sessao atual esperando uma lista inteira a toa.
            refillPool(excluded, warm).catch(() => { });
            return;
        }

        log("as saidas guardadas morreram, procurando outra");
    }

    const tor = await torExit(excluded, PROBE_TIMEOUT_MS);
    if (tor !== null) return settleExit(tor.proxy);

    log(`procurando uma saida nova, o gateway fica segurado por ate ${Math.round(STALL_BUDGET_MS / 1000)}s`);
    const [first] = await sharedFreeExit(excluded, 1);
    log(first === undefined ? "nenhuma saida passou nos testes" : `saida escolhida: ${safeProxy(first.proxy)}`);

    settleExit(first?.proxy ?? null);
    if (first !== undefined) writePool([first]);
}

// A busca cara acontece com a sessao ja aberta, para o proximo boot ter opcao pronta --
// diferenca entre abrir em dois segundos e esperar meio minuto por uma lista.
async function refillPool(excluded: Set<string>, keep: PoolEntry) {
    try {
        const found = await sharedFreeExit(excluded, POOL_SIZE);
        writePool([keep, ...found.filter(entry => entry.proxy !== keep.proxy)]);
        log(`pote guardado com ${Math.min(found.length + 1, POOL_SIZE)} saida(s)`);
    } catch {
        writePool([keep]);
    }
}

// ------------------------------------------------------------------ manter reserva viva

// Saida gratuita nao avisa que morreu: ela para de encaminhar, e quem descobre e a conexao que
// estava passando por ela. No meio de uma transmissao isso custa a sessao inteira -- o gateway
// reconecta, e se reconectar direto o servidor reavalia a conta e o video cai. O batimento
// existe para que, quando isso acontecer, ja haja no pote uma reserva testada ha trinta
// segundos para assumir na hora, em vez de a busca comecar com o Discord ja reconectando.
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let beating = false;
let lastHunt = 0;

const missed = new Map<string, number>();

function startHeartbeat() {
    if (heartbeatTimer !== null) return;

    heartbeatTimer = setInterval(() => { void beat(); }, HEARTBEAT_MS);
    log(`batimento ligado: reconfiro as saidas a cada ${Math.round(HEARTBEAT_MS / 1000)}s`);
}

function stopHeartbeat() {
    if (heartbeatTimer === null) return;

    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    missed.clear();
}

async function beat() {
    // Um batimento lento nunca pode se sobrepor ao proximo: seriam duas rodadas de conexoes na
    // mesma saida ao mesmo tempo, que e justamente o que derruba as fracas.
    if (beating || scope === "off") return;
    beating = true;

    try {
        await checkPool();
    } catch {
        // Batimento e rede de seguranca. Se ele falhar, o caminho antigo continua valendo:
        // falhar no trafego vivo e cair para a reserva ali mesmo.
    } finally {
        beating = false;
    }
}

// Leve de proposito: um tunel ate o gateway e o TLS fechando nele, sem repetir o trace da
// Cloudflare. O pais ja foi decidido quando a saida entrou no pote, e cada checagem extra e
// mais uma conexao simultanea numa saida que talvez nao aceite duas.
async function checkPool() {
    const stored = readPool();
    const active = exit;

    // A ativa entra na rodada mesmo estando fora do pote: proxy do campo e Tor local nunca sao
    // guardados, e sao exatamente os que a pessoa mais sente quando caem.
    const targets = [...new Set([...(active === null ? [] : [active]), ...stored.map(entry => entry.proxy)])];
    if (targets.length === 0) return huntReserves(0);

    const beats = await Promise.all(targets.map(async proxy => ({ proxy, ok: await reachesGateway(proxy, HEARTBEAT_TIMEOUT_MS) })));

    const dead = new Set<string>();
    for (const { proxy, ok } of beats) {
        if (ok) {
            missed.delete(proxy);
            continue;
        }

        const count = (missed.get(proxy) ?? 0) + 1;
        missed.set(proxy, count);
        if (count >= MAX_MISSED_BEATS) dead.add(proxy);
    }

    if (dead.size > 0) {
        const survivors = stored.filter(entry => !dead.has(entry.proxy));
        if (survivors.length !== stored.length) {
            log(`fora do pote: ${[...dead].map(safeProxy).join(", ")} (sem resposta em ${MAX_MISSED_BEATS} batimentos)`);
            writePool(survivors);
        }

        for (const proxy of dead) missed.delete(proxy);
    }

    const live = beats.filter(entry => entry.ok).map(entry => entry.proxy);

    // A ativa e trocada no primeiro erro, nao no segundo: trocar nao custa nada -- socket que ja
    // esta de pe continua no tunel antigo, so conexao nova nasce pela reserva -- e a proxima
    // conexao do gateway pode ser a reconexao que decide a transmissao.
    if (active !== null && !live.includes(active)) {
        const reserve = live.find(proxy => proxy !== active);
        if (reserve === undefined) {
            log(`${safeProxy(active)} perdeu o batimento e nao ha reserva viva`);
            dropExit(active);
        } else {
            log(`${safeProxy(active)} perdeu o batimento, assumindo a reserva ${safeProxy(reserve)}`);
            exit = reserve;
        }
    }

    huntReserves(live.filter(proxy => proxy !== exit).length);
}

// A busca cara nunca acontece dentro do batimento: ela e solta em segundo plano e o pote so
// muda quando ela volta, entao um batimento continua custando o mesmo com o pote vazio.
function huntReserves(liveReserves: number) {
    if (liveReserves >= MIN_LIVE_RESERVES) return;
    if (Date.now() - lastHunt < HUNT_COOLDOWN_MS) return;

    lastHunt = Date.now();
    log(`o pote esta com ${liveReserves} reserva(s) viva(s), procurando mais em segundo plano`);

    sharedFreeExit(excludedCountries(), POOL_SIZE).then(found => {
        const known = new Set(readPool().map(entry => entry.proxy));
        const fresh = found.filter(entry => !known.has(entry.proxy));
        if (fresh.length === 0) return;

        writePool([...readPool(), ...fresh]);
        log(`${fresh.length} reserva(s) nova(s) no pote`);
    }).catch(() => { });
}

// ------------------------------------------------------------------ o roteador local

let socks: Server | undefined;
let scope: Scope = "off";
let fallbackRule = "DIRECT";

function refuse(client: Socket) {
    // 2 = "nao permitido pelas regras": o roteador so encaminha os hosts que o PAC manda.
    if (!client.destroyed) client.end(Buffer.from([5, 2, 0, 1, 0, 0, 0, 0, 0, 0]));
}

function readTarget(request: Buffer) {
    if (request[3] === 1) {
        return { host: Array.from(request.subarray(4, 8)).join("."), port: request.readUInt16BE(8) };
    }

    if (request[3] === 3) {
        const size = request[4];
        return { host: request.subarray(5, 5 + size).toString("latin1"), port: request.readUInt16BE(5 + size) };
    }

    return null;
}

function serveSocks(client: Socket) {
    client.on("error", () => client.destroy());
    // Entrada malformada deixaria o socket pendurado para sempre, porque a negociacao nunca
    // completa e ninguem fecha. O prazo cobre isso; ele e zerado assim que o tunel sobe.
    client.setTimeout(PROBE_TIMEOUT_MS, () => client.destroy());

    readReply(client, buffer => (buffer.length < 2 ? -1 : 2 + buffer[1]), greeting => {
        if (greeting === null || greeting[0] !== 5) return client.destroy();
        client.write(Buffer.from([5, 0]));

        readReply(client, socksReplySize, request => {
            // Cada conexao e isolada: o que der errado aqui fecha este socket e mais nada.
            // Sem o catch, um erro em qualquer await abaixo viraria rejeicao nao tratada e
            // levaria junto o processo principal do Discord.
            serveRequest(client, request).catch(() => client.destroy());
        });
    });
}

async function serveRequest(client: Socket, request: Buffer | null) {
    if (request === null || request[0] !== 5 || request[1] !== 1) return client.destroy();

    const target = readTarget(request);
    if (target === null) return refuse(client);

    // O roteador so aceita os hosts que o PAC manda para ele. Sem esta linha ele seria um
    // SOCKS aberto no loopback: qualquer processo da maquina usaria a sua saida para qualquer
    // destino, com a identidade do Discord no firewall.
    //
    // A regra acompanha a do PAC: todo o dominio do gateway, mais os hosts exatos do escopo.
    // Se so o PAC casasse por sufixo, o roteador recusaria justamente as conexoes regionais
    // que ele acabou de receber -- e o gateway continuaria sem rota.
    const aceito =
        (scope !== "off" && isGatewayHost(target.host)) || routedHosts().includes(target.host);
    if (!aceito) {
        log(`recusando destino fora da lista: ${target.host}`);
        return refuse(client);
    }

    // Sucesso respondido antes de saber a saida, de proposito: o Chromium para de usar um
    // roteador que responda lento ou negativo, sem avisar. Uma saida que falhe vira conexao
    // fechada (problema do destino, nao do proxy) -- o socket segue pausado pelo readReply.
    client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
    client.setTimeout(0);

    const through = await currentExit();
    if (client.destroyed) return;

    // Login (autenticacao) falha fechado -- diferente do gateway, onde cair para direto e
    // proposital. Vazar o IP real no login seria o oposto do que a setting promete.
    const isLoginHost = LOGIN_HOSTS.includes(target.host);

    let upstream: Socket | null = null;
    if (through !== null) {
        upstream = await openTunnel(through, target.host, target.port, RELAY_TUNNEL_TIMEOUT_MS);

        // Trocar para uma reserva ja testada custa uma conexao; esperar a proxima abertura do
        // Discord custa a sessao inteira sem bypass. As reservas correm juntas em vez de uma
        // por vez: com 2,5s de prazo cada, a fila somava mais de dez segundos com o gateway
        // reconectando, tempo de sobra para o Chromium desistir do roteador.
        if (upstream === null) {
            const won = await firstTunnel(
                readPool().map(entry => entry.proxy).filter(proxy => proxy !== through),
                target.host, target.port, RELAY_TUNNEL_TIMEOUT_MS
            );

            if (won !== null) {
                log(`${safeProxy(through)} falhou, usando a reserva ${safeProxy(won.proxy)}`);
                writePool(readPool().filter(entry => entry.proxy !== through));
                missed.delete(through);
                exit = won.proxy;
                upstream = won.socket;
            }
        }

        if (upstream === null) {
            dropExit(through);
            upstream = isLoginHost ? null : await openDirect(target.host, target.port, RELAY_DIRECT_TIMEOUT_MS);
        }
    } else {
        upstream = isLoginHost ? null : await openDirect(target.host, target.port, RELAY_DIRECT_TIMEOUT_MS);
    }

    if (upstream === null) return client.destroy();
    if (client.destroyed) return upstream.destroy();

    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());

    upstream.pipe(client);
    client.pipe(upstream);
}

function pacScript(socksPort: number, routed: string[]) {
    const list = routed.map(host => `"${host}"`).join(",");

    // Sem alternativa depois do ponto e virgula de proposito: uma vez que o Chromium marca o
    // SOCKS como ruim ele passa a usar a alternativa do PAC sem avisar -- regra servida,
    // roteador de pe, e nenhuma conexao passando. A rede de seguranca fica dentro do
    // roteador, que cai para direto sozinho e registra isso. Quem nao esta na lista mantem a
    // regra que o sistema ja usava (proxy corporativo, PAC, VPN).
    // O casamento e por SUFIXO de dominio para o gateway. O Discord conecta em subdominios
    // regionais (gateway-us-east1-b.discord.gg -- o "-us-east1-b" vem ANTES de discord.gg), e
    // com igualdade exata essas conexoes ficavam de fora do roteador: nasciam pelo IP
    // brasileiro e o servidor bloqueava a sessao, o "carregando infinitamente". E o mesmo
    // conserto que o standalone recebeu na v1.1.6; aqui tinha ficado para tras.
    //
    // endsWith("." + dominio) e nao indexOf: aquele casaria discord.gg.evil.com. Os hosts de
    // login (quando o escopo os inclui) seguem por igualdade exata -- ali subdominio nao
    // aparece, e abrir para *.discord.com pegaria muito mais do que precisamos.
    return `var routed = [${list}];\n`
        + `var sufixo = ${JSON.stringify(ROUTE_SUFFIX)};\n`
        + "function FindProxyForURL(url, host) {\n"
        + `    if (host === "discord.gg" || host.endsWith(sufixo)) return "SOCKS5 127.0.0.1:${socksPort}";\n`
        + "    for (var i = 0; i < routed.length; i++)\n"
        + `        if (host === routed[i]) return "SOCKS5 127.0.0.1:${socksPort}";\n`
        + `    return ${JSON.stringify(fallbackRule)};\n`
        + "}\n";
}

function routedHosts(): string[] {
    if (scope === "off") return [];
    return scope === "login" ? [...GATEWAY_HOSTS, ...LOGIN_HOSTS] : [...GATEWAY_HOSTS];
}

// PAC embutido na propria URL, nao servido de um HTTP local: buscar o arquivo com a rede
// ainda montando ja derrubou o processo principal em silencio numa build de Electron antiga.
function pacDataUrl(socksPort: number) {
    const script = pacScript(socksPort, routedHosts());
    return "data:application/x-ns-proxy-autoconfig;base64," + Buffer.from(script, "utf8").toString("base64");
}

async function installPac(redial: boolean) {
    if (socks === undefined) return false;

    try {
        const socksPort = (socks.address() as AddressInfo | null)?.port;
        if (socksPort === undefined) return false;

        await session.defaultSession.setProxy({ mode: "pac_script", pacScript: pacDataUrl(socksPort) });

        // Confere o endereco inteiro, nao so a porta: a regra do sistema (quando o PAC e
        // ignorado) pode conter os mesmos digitos da porta por coincidencia. E conferir em
        // vez de supor: se a regra nao pegou, melhor saber agora do que pelo usuario dizendo
        // que nao funciona.
        // Um subdominio regional entra no teste junto com o canonico: e ele que o gateway usa
        // de verdade, e uma regra que so cobrisse o canonico passaria aqui estando quebrada
        // para o que importa.
        const alvos = [`https://${GATEWAY_HOSTS[0]}`, "https://gateway-us-east1-b.discord.gg"];
        const rotas = await Promise.all(alvos.map(alvo => session.defaultSession.resolveProxy(alvo)));
        const route = rotas.find((r: unknown) => typeof r !== "string" || !r.includes(`127.0.0.1:${socksPort}`));
        if (route !== undefined) {
            log("o Chromium ignorou o PAC, voltando para a regra do sistema");

            // "system", nao "direct": arrancaria o proxy de quem esta atras de VPN/corporativo.
            await session.defaultSession.setProxy({ mode: "system" });
            return false;
        }

        // Regra nova nao muda socket que ja nasceu. Derrubar tudo depois do login reconectaria
        // a sessao recem autenticada a toa; no boot nao ha socket que valha preservar.
        if (redial) await session.defaultSession.closeAllConnections();
    } catch {
        // O setProxy pode ter pegado mesmo com uma etapa seguinte lancando excecao -- reverter
        // aqui tambem, senao o PAC fica roteando trafego enquanto a funcao devolve falha.
        log("nao consegui aplicar a regra de rota, revertendo para a regra do sistema");
        try { await session.defaultSession.setProxy({ mode: "system" }); } catch { }
        return false;
    }

    log(`rota aplicada: ${routedHosts().join(", ")} pelo roteador local, o resto em ${fallbackRule}`);
    return true;
}

async function startRouter(next: Scope) {
    scope = next;

    if (socks === undefined) {
        const server = createServer(serveSocks);
        server.on("error", () => { });

        // Resolve tambem no erro: esperar um listen que nunca acontece penduraria o boot.
        const started = await new Promise<boolean>(resolve => {
            server.once("error", () => resolve(false));
            server.listen(0, "127.0.0.1", () => resolve(true));
        });

        if (!started) {
            log("nao consegui subir o roteador local, a sessao inteira continua direta");
            scope = "off";
            return false;
        }

        socks = server;
        log(`roteador local de pe na porta ${(server.address() as AddressInfo).port}`);
    }

    // Loopback e porta escolhida pelo sistema: nao ha colisao possivel, e nada de fora da
    // maquina alcanca o roteador.
    if (await installPac(true)) return true;

    scope = "off";
    return false;
}

async function stopRouter() {
    scope = "off";
    stopHeartbeat();

    try {
        await session.defaultSession.setProxy({ mode: "system" });
        await session.defaultSession.closeAllConnections();
    } catch {
        // sessao ja fechando, nada a fazer
    }

    socks?.close();
    socks = undefined;
    log("roteador desligado, tudo volta a sair direto");
}

// ------------------------------------------------------------------ ciclo de vida

// Chamado pelo boot e pelo renderer ao ativar o plugin; a trava faz as duas chamadas
// dividirem uma unica subida em vez de duas.
let enabling: Promise<{ success: boolean; }> | null = null;

export function enable(_?: IpcMainInvokeEvent) {
    enabling ??= enableOnce().finally(() => { enabling = null; });
    return enabling;
}

async function enableOnce() {
    migrateLegacyPool();
    if (scope !== "off") return { success: true as const };

    try {
        // So da para embutir UMA regra fixa no PAC para o resto do trafego, mas um PAC ou
        // auto-detect de verdade pode variar por host (proxy corporativo, DLP). Compara 3
        // alvos bem diferentes: se baterem, a regra do sistema provavelmente e fixa e seguro
        // reaplicar. Falha fechado se o resolveProxy nao responder nada confiavel -- melhor
        // nao ligar o bypass do que arriscar ignorar a politica de proxy da empresa.
        const probeUrls = [`https://${DISCORD_HOST}`, "https://cdn.discordapp.com", "https://www.google.com"];
        let rules: (string | null)[];
        try {
            rules = await Promise.all(probeUrls.map(url => session.defaultSession.resolveProxy(url)));
        } catch {
            log("nao consegui ler a regra de proxy do sistema; nao vou arriscar ligar o roteador as cegas");
            return { success: false as const };
        }

        const discordRule = rules[0];
        if (typeof discordRule !== "string" || discordRule.trim() === "") {
            log("o sistema nao devolveu uma regra de proxy usavel; nao vou arriscar ligar o roteador as cegas");
            return { success: false as const };
        }

        const trimmed = discordRule.trim();
        const varies = rules.slice(1).some(rule => typeof rule === "string" && rule.trim() !== "" && rule.trim() !== trimmed);
        if (varies) {
            log("a regra do sistema varia por host (proxy corporativo ou PAC de verdade); nao vou arriscar substituir por uma regra fixa");
            return { success: false as const };
        }

        fallbackRule = trimmed;

        // O roteador sobe em milissegundos, antes do gateway nascer; a saida e escolhida
        // depois, com o gateway segurado pelo roteador em vez de a abertura inteira travada.
        const started = await startRouter(routesLogin() ? "login" : "gateway");
        if (!started) return { success: false as const };

        chooseExit();
        startHeartbeat();
        return { success: true as const };
    } catch {
        // Falhar aqui e abrir o Discord sem bypass. Deixar a excecao subir no boot era abrir
        // o Discord sem processo principal, ou seja, nao abrir.
        await stopRouter();
        return { success: false as const };
    }
}

// Versoes anteriores guardavam uma saida so, em verifiedProxy. Aproveitar ela como semente do
// pote poupa uma busca inteira no primeiro boot depois da atualizacao.
function migrateLegacyPool() {
    const stored: unknown = NativeSettings.plain.plugins?.GoLiveBypass?.verifiedProxy;
    if (typeof stored !== "object" || stored === null) return;

    const { proxy, at } = stored as { proxy?: unknown; at?: unknown; };
    if (typeof proxy === "string" && parseProxy(proxy) !== null && typeof at === "number"
        && Date.now() - at < POOL_MAX_AGE_MS && readPool().length === 0) {
        writePool([{ proxy, country: "?", ms: 0, at }]);
        log("saida guardada pela versao anterior aproveitada no pote");
    }

    try {
        if (NativeSettings.store.plugins.GoLiveBypass)
            delete NativeSettings.store.plugins.GoLiveBypass.verifiedProxy;
    } catch {
        // sobra inofensiva: a leitura acima e a unica que conhece a chave antiga
    }
}

export async function sessionOpened(_: IpcMainInvokeEvent) {
    // Escopo encolhe para o gateway apos o login; ele continua roteado de proposito, entao
    // uma reconexao (rede oscilando) nasce pela mesma saida e a liberacao sobrevive.
    if (scope === "login") await installPacWithScope("gateway");
    return { exit, scope };
}

export async function sessionClosed(_: IpcMainInvokeEvent) {
    if (routesLogin() && scope !== "off") await installPacWithScope("login");
}

// Escopo descreve o que esta instalado, nao o que foi pedido -- se a troca falhar, a rota
// antiga continua valendo, e o diagnostico e o retryWithProxy precisam enxergar isso.
async function installPacWithScope(next: Scope) {
    const installed = scope;
    scope = next;

    if (await installPac(false)) return true;

    if (scope === next) scope = installed;
    return false;
}

export async function shutdown(_: IpcMainInvokeEvent) {
    await stopRouter();
    settleExit(null);
    // Drenados os que esperavam, a proxima ativacao precisa segurar o gateway de novo ate
    // existir saida -- sem esta linha ela sairia direta sem esperar nada.
    exitSettled = false;
    return { success: true as const };
}

export function getActiveProxy(_: IpcMainInvokeEvent) {
    return exit;
}

export function getLog(_: IpcMainInvokeEvent) {
    return history.join("\n");
}

export function sessionWorked(_: IpcMainInvokeEvent) {
    if (retries > 0) log(`sessao liberada depois de ${retries} tentativa(s)`);
    retries = 0;
}

// Quando a sessao sobe sem passar pela saida, o servidor continua bloqueando video e nao ha
// como consertar sem refazer o gateway. Recarregar com a saida no ar resolve, mas so pode
// acontecer um numero fixo de vezes: sem teto isso vira a tela de carregamento infinita.
export async function retryWithProxy(event: IpcMainInvokeEvent, excludedCountries: unknown) {
    if (retries >= MAX_RETRIES) {
        log(`o servidor continuou bloqueando apos ${retries} tentativas, desistindo`);
        return { retried: false as const, reason: "tentativas esgotadas" };
    }

    // Reserva a vaga antes de qualquer await: reconexoes em rajada disparam chamadas
    // concorrentes que veriam o mesmo "retries" no intervalo entre awaits, furando o teto.
    // Devolve a vaga se a tentativa nao for adiante -- nao e falha do servidor.
    retries++;
    const attempt = retries;

    if (scope === "off") {
        retries--;
        log("o roteador nao esta de pe, recarregar repetiria a mesma falha");
        return { retried: false as const, reason: "roteador desligado" };
    }

    const requested = requestedCountries(excludedCountries);
    const excluded = requested.size > 0 ? requested : undefined;

    // Se a saida no ar ainda responde, foi corrida: o gateway nasceu antes dela e saiu direto.
    // Recarregar conserta sem reinstalar a rota.
    let through = exit;
    if (through !== null && await measure(through, PROBE_TIMEOUT_MS) === null) {
        log(`${safeProxy(through)} parou de responder no meio da sessao`);
        dropExit(through, excluded);

        // Le de volta em vez de assumir null: o trafego vivo pode ja ter achado outra saida.
        through = exit;
    }

    // Sem saida no ar nao ha corrida a ganhar com o gateway -- vale esperar a busca inteira.
    if (through === null) {
        await chooseExit(excluded);
        through = exit;
    }

    if (through === null) {
        retries--;
        log("nenhuma saida respondeu, a sessao continua direta");
        return { retried: false as const, reason: "nenhuma saida respondeu" };
    }

    if (event.sender.isDestroyed()) {
        retries--;
        return { retried: false as const, reason: "janela indisponivel" };
    }

    log(`o servidor bloqueou esta sessao, recarregando atras de ${safeProxy(through)} (tentativa ${attempt} de ${MAX_RETRIES})`);

    // event.sender e a janela que roda o plugin. Guardar a primeira janela criada nao servia:
    // a primeira do Discord e a tela de abertura, e recarregar ela nao recarrega o cliente.
    event.sender.reload();
    return { retried: true as const, attempt };
}

export async function testProxy(_: IpcMainInvokeEvent, proxyRules: unknown) {
    if (typeof proxyRules !== "string" || parseProxy(proxyRules.trim()) === null)
        return { success: false as const, error: "Invalid proxy format. Use socks5://host:port." };

    const result = await measure(proxyRules.trim());
    if (result === null)
        return { success: false as const, error: "The proxy could not carry a real request to Discord." };

    return { success: true as const, ms: result.ms, country: result.country, ip: result.ip };
}

app.whenReady().then(async () => {
    // Nao ha mais handler de "login" de proposito: com o roteador local, o Chromium so conversa
    // com 127.0.0.1, que nao pede credencial. A autenticacao da saida acontece dentro do
    // openTunnel, longe de qualquer site que pudesse recebe-la por engano.
    log("=".repeat(60));
    log(`abrindo | ${process.platform} ${process.arch} | electron ${process.versions.electron} | chrome ${process.versions.chrome}`);

    const stored: Record<string, unknown> = RendererSettings.plain.plugins?.GoLiveBypass ?? {};
    const show = (key: string, fallback: string) => (typeof stored[key] === "string" && stored[key] !== "" ? String(stored[key]) : fallback);
    log(`configuracao | proxy ${show("proxy", "") === "" ? "automatico" : "definido por voce"} | roteamento ${show("sessionRouting", "gateway")} | regiao de call ${show("voiceRegion", "automatica")} | regiao de stream ${show("streamRegion", "automatica")} | paises fora ${show("excludedCountries", "BR")}`);

    // O prazo de 2 minutos, a marca de boot pendente e o gancho did-fail-load sairam de
    // proposito: so o gateway depende da saida agora, e o resto cai para direto sozinho
    // dentro do roteador. Manter aquele prazo arrancaria uma sessao funcionando.
    if (pluginEnabled()) await enable();
}).catch(() => { });
