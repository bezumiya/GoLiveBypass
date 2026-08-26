/*
 * GoLiveBypass standalone - devolve o Go Live e a camera para contas brasileiras
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Roda dentro do processo principal do Discord, sem Equicord e sem Vencord. Nao ha renderer,
 * nao ha patch de webpack e nao ha etapa de build: este arquivo e carregado direto, entao o
 * usuario nao precisa de Node, nem de pnpm, nem de git.
 *
 * Por que so o processo principal basta: a trava do cliente vem de um experimento que o
 * servidor atribui a partir do IP de origem do websocket de gateway. Com o gateway saindo por
 * um IP nao bloqueado o experimento nao e atribuido, e os botoes ficam livres sozinhos. Nao ha
 * o que corrigir no cliente quando a origem esta certa.
 *
 * E por que o roteamento e por host, e nao pela sessao inteira: sem renderer nao existe o
 * aviso de "a sessao abriu", que e quando a versao de plugin solta o proxy. Uma regra que vale
 * so para o gateway nao precisa ser solta nunca, entao o resto do Discord sai direto o tempo
 * todo, na velocidade normal.
 */

"use strict";

const { app, session } = require("electron");
const { createServer, connect } = require("net");
const { connect: connectTls } = require("tls");
const { request } = require("https");
const fs = require("original-fs");
const { join, dirname, basename } = require("path");

const DISCORD_HOST = "discord.com";
const GEO_HOST = "cloudflare.com";

// So estes hosts atravessam o tunel. O gate e decidido na conexao do gateway, entao rotear
// mais que isso custaria velocidade em tudo sem comprar nada.
const ROUTED_HOSTS = ["gateway.discord.gg", "remote-auth-gateway.discord.gg"];

const PROBE_TIMEOUT_MS = 6000;
// Mais candidatas por lote nao custa relogio, porque elas correm juntas: custa a mais lenta,
// nao a soma. E com mais candidatas o minimo escolhido e melhor, o que se traduz direto em
// menos latencia em tudo que passa pelo gateway.
const PARALLEL_PROBES = 30;
// Cinco em vez de tres: as candidatas do lote correm juntas, entao guardar mais reserva nao
// custa relogio nenhum na busca e e exatamente o que sobra quando uma saida morre no meio de
// uma transmissao.
const POOL_SIZE = 5;
// Com cinco fontes, o limite alto de candidatas permite varrer uma fatia grande da oferta;
// o probe em paralelo faz a varredura custar o tempo do mais lento, nao a soma.
const MAX_CANDIDATES = 80;
const MIN_UPTIME = 90;
const MAX_LISTED_TIMEOUT = 1500;
const TOR_PORTS = [9052, 9150, 9050, 9250];
const TOR_PORT_TIMEOUT_MS = 400;
// Quanto uma conexao de gateway espera por uma saida antes de sair direta. Segurar para sempre
// travaria o login; soltar na hora perderia a corrida em toda abertura fria.
const HOLD_BUDGET_MS = 12_000;
// No modo "tor" o bootstrap do daemon leva ~20s numa maquina fria, e neste modo estourar o
// prazo nao vira saida direta (o serveSocks recusa), entao esperar mais e barato: o custo e
// o gateway demorar a conectar, nao vazar.
const TOR_HOLD_BUDGET_MS = 45_000;
// O pool guardado vale por este tempo. A revalidacao acontece na abertura (probe real em
// cada saida), entao uma idade longa e segura: o que importa e ter candidatas para revalidar
// em vez de baixar a lista inteira (lenta) com o gateway ja conectando. 30min fazia o pool
// expirar entre aberturas do Discord e o gateway nascia direto — o "carregando infinitamente".
const CACHE_MAX_AGE_MS = 2 * 60 * 60 * 1000;
// Depois de uma busca por saida nova falhar, espera este intervalo antes de tentar de novo:
// a API de saidas gratuitas custa e nao responde mais rapido por repeticao. Quinze segundos
// mantem a resposta razoavel para a sessao que ficou sem saida (com vinte e cinco a morte da
// ativa virava quase um minuto enxugando o gateway).
const REFRESH_COOLDOWN_MS = 15_000;

// Trava da reposicao de rotina. Tres minutos, igual ao plugin: sem ela, um pote que nao
// consegue encher viraria uma varredura inteira da lista gratuita a cada trinta segundos, pela
// sessao toda. E separada da trava acima para a rotina nunca adiar a emergencia.
const STOCK_COOLDOWN_MS = 3 * 60_000;

// Prazo do tunel no trafego vivo, bem menor que o do teste: uma saida agonizante que demora a
// falhar faria o Chromium desistir do roteador inteiro.
const RELAY_TIMEOUT_MS = 2500;

// De quanto em quanto tempo as saidas sao reconferidas com a sessao ja aberta. O refreshExit
// conserta depois que uma conexao falha; o batimento existe para que ela nao chegue a falhar.
// Trinta segundos e curto o bastante para a reserva estar quente quando o gateway reconectar,
// e longo o bastante para nao virar carga na saida gratuita, que costuma limitar conexoes.
const HEARTBEAT_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 4000;

// Quantos batimentos seguidos uma saida pode errar antes de sair do pote. Cortar no primeiro
// seria cruel com saida gratuita congestionada, que erra um e volta; nunca cortar deixaria o
// pote cheio de endereco morto, que e o mesmo que nao ter reserva nenhuma.
const MAX_MISSED_BEATS = 2;

// Abaixo disto o batimento vai atras de reservas novas. Uma so nao e reserva: e a proxima a
// morrer.
const MIN_LIVE_RESERVES = 2;

// ------------------------------------------------------------------ estabilidade da sessao
// Uma saida gratuita passa no probe e ainda assim entrega mal: RTT alto e instavel faz o
// websocket do gateway perder heartbeat e reconectar em loop, derrubando o carregamento.
// A troca proativa ataca antes de a conexao sofrer.

// Acima disto a saida e considerada lenta demais para o gateway. Medido como EMA do RTT
// dos probes (a media exponencial suaviza picos momentaneos sem ignorar degradacao real).
const RTT_TROCA_MS = 450;
// RTT lento por N batimentos seguidos vira troca: um pico isolado nao aposenta saida boa.
const RTT_TROCA_BATIDAS = 3;
// Fator da EMA (0.3 = o RTT novo pesa 30%, o historico 70%).
const RTT_EMA_ALPHA = 0.3;

// O medidor mais confiavel de sofrimento e o proprio gateway: reconexoes em rajada (3+ em
// 180s) significam que a saida nao esta aguentando o trafego vivo, mesmo passando no probe.
// Acima disto, troca forcada de saida — e reseta o contador.
const RECONEXAO_JANELA_MS = 180_000;
const RECONEXAO_LIMITE = 3;

// Cooldown das trocas PROATIVAS (por RTT ou por rajada): quando o pool inteiro esta lento,
// trocar em cascata vira ping-pong entre ruins — cada troca faz o gateway renascer e a
// sessao recarregar. Esperar o cooldown suaviza; a troca por saida MORTA e emergencia e
// nao passa por aqui.
const SWAP_COOLDOWN_MS = 60_000;
// Nas trocas proativas, so vale trocar para uma reserva pELO MENOS tao boa quanto a atual:
// trocar para outra lenta (ou pior) nao ajuda o gateway e ainda o faz renascer a toa.
const SWAP_RESERVA_RAZAO = 1.2;

// Prazo global da busca por saidas, do inicio ao fim (nao por lote): o probe completo numa
// candidata de RTT medio leva ~4-8s (duas conexoes + TLS), entao um prazo curto por lote
// cortava os probes antes de aprovarem e a busca voltava vazia — o gateway nascia direto e
// a sessao ficava bloqueada (video nunca chega, so audio). Os lotes correm ate este prazo e
// a melhor aprovada que tiver chegado vence.
const HUNT_BUSCA_TOTAL_MS = 10_000;

const MAX_LOG_BYTES = 2 * 1024 * 1024;

// ------------------------------------------------------------------ recarga apos gateway direto
// O roteador abre direto para um host de gateway quando nenhuma saida entrega; essa sessao
// nasce pelo IP brasileiro e o servidor bloqueia (o "carregando infinitamente"). Quando a
// saida voltar a ficar pronta, recarregar a janela do Discord faz o gateway renascer atras
// dela. Guardas contra loop: teto por execucao, cooldown, single-flight e a saida tem que
// estar comprovadamente entregando antes do reload.
const RELOAD_MAX_RETRIES = 2;
const RELOAD_COOLDOWN_MS = 30_000;
// Depois de quanto tempo sem ver o gateway direto o sinal expira: uma recarga tardia
// derrubaria uma sessao que ja se recuperou sozinha.
const DIRECT_SIGNAL_TTL_MS = 60_000;
// A janela do cliente, nao a splash (que nunca tem URL discord.com).
const CLIENT_URL_RE = /^https:\/\/(?:canary|ptb\.)?discord\.com\/(?:app|channels|login)/;

const HERE = __dirname;
const SETTINGS_FILE = join(HERE, "settings.json");
const STATE_FILE = join(HERE, "state.json");

// O log vai para uma pasta ESTAVEL, nao para HERE. Quando a GUI injeta, HERE e a pasta do
// app.asar do Discord: um lugar que ninguem adivinha e que some quando o Discord se atualiza
// ou o bypass e desativado. A pasta abaixo e a mesma que o app e o plugin usam (%LOCALAPPDATA%
// \GoLiveBypass no Windows, $XDG_DATA_HOME/GoLiveBypass no Linux/Mac) -- e onde a pessoa
// naturalmente procura, e um arquivo so, que sobrevive a atualizacao do Discord.
function logDir() {
    const base = process.platform === "win32"
        ? process.env.LOCALAPPDATA
        : (process.env.XDG_DATA_HOME
            || (process.env.HOME ? join(process.env.HOME, ".local", "share") : undefined));
    return base ? join(base, "GoLiveBypass") : null;
}
const LOG_FILE = logDir() === null ? null : join(logDir(), "golivebypass.log");

let socksPort = 0;
let chosenExit = null;
let exitSettled = false;
// Reservas ja testadas. Uma saida gratuita morre sem avisar, e sem reserva a unica alternativa
// seria refazer a busca inteira no meio da sessao.
let pool = [];
const waitingForExit = [];
// Estado da re-selecao em runtime: so uma busca por vez, e nunca antes do cooldown.
let refreshingExit = null;
let lastRefreshAt = 0;
let lastStockAt = 0;
// Quantos batimentos seguidos cada saida errou. Fora do pote de proposito: o pote vai para
// disco, e isto e estado desta sessao.
const missedBeats = new Map();
let beating = false;
let stocking = null;

// Medicao de qualidade por saida (estado desta sessao): EMA do RTT dos probes e quantos
// batimentos seguidos ela ficou acima do teto. A troca por RTT so acontece depois de
// RTT_TROCA_BATIDAS leituras ruins seguidas — pico momentaneo nao aposenta saida boa.
const rttEma = new Map();          // proxy -> EMA do RTT (ms)
const rttLentoSeguidas = new Map(); // proxy -> batimentos ruins consecutivos

// Janela deslizante das reconexoes do gateway (so o cliente real conecta em
// gateway-*.discord.gg). A rajada e o sinal de que a saida nao aguenta o trafego vivo.
const gatewayReconexoes = [];      // timestamps das reconexoes na janela
let ultimaTrocaProativaEm = 0;    // cooldown das trocas proativas (RTT/rajada)

// Quarentena de saidas que ja causaram sofrimento: a saida passa no probe e mesmo assim o
// gateway sofre; sem um "nao voltar para essa agora", o refresh reelege exatamente ela (a
// mesma mai famosa do dia). Fica de fora por QUARENTENA_MS e o pool e obrigado a testar
// alternativas.
const QUARENTENA_MS = 90_000;
const quarentena = new Map();     // proxy -> ate quando fica evitada

function quarentenar(proxy, motivo) {
    if (proxy === null) return;
    if (proxy === manualProxy()) {
        log(safeProxy(proxy) + " poupada da quarentena por ser a saida configurada (" + motivo + ")");
        return;
    }
    const ate = Date.now() + QUARENTENA_MS;
    const ja = quarentena.get(proxy);
    if (ja === undefined || ate > ja) quarentena.set(proxy, ate);
    log(safeProxy(proxy) + " em quarentena ate daqui a " + Math.round(QUARENTENA_MS / 1000) + "s (" + motivo + ")");
}

function foraDeQuarentena(itens) {
    const agora = Date.now();
    for (const [proxy, ate] of quarentena) if (ate <= agora) quarentena.delete(proxy);
    return itens.filter(item => !quarentena.has(typeof item === "string" ? item : item.proxy));
}

// Troca proativa de saida com cooldown: impede o ping-pong entre saidas ruins quando o pool
// inteiro esta lento. A troca por saida MORTA (emergencia) chama trocarPara direto.
function trocaProativaPode() {
    return Date.now() - ultimaTrocaProativaEm > SWAP_COOLDOWN_MS;
}

function trocarPara(nova, motivo) {
    ultimaTrocaProativaEm = Date.now();
    gatewayReconexoes.length = 0;
    missedBeats.delete(nova);
    rttLentoSeguidas.delete(nova);
    const antiga = chosenExit;
    const vida = antiga === null || lastExitAt === 0 ? "?" : Math.round((Date.now() - lastExitAt) / 1000) + "s";
    log("saida.trocada | de=" + (antiga === null ? "nenhuma" : safeProxy(antiga)) +
        " para=" + safeProxy(nova) +
        " motivo=" + motivo +
        " vida_da_antiga=" + vida);
    chosenExit = nova;
    // Corrige o "saida pronta ha Ns" mentindo: sem isto, trocas em runtime
    // (openThroughPool) nao atualizavam e o log do gateway mostrava a idade
    // da saida ORIGINAL.
    lastExitAt = Date.now();
}

// Estado da recarga pos-gateway-direto.
let gatewayWentDirectAt = 0;   // quando o roteador abriu direto para um host de gateway
let reloadCount = 0;           // recargas nesta execucao (reseta quando a sessao volta roteada)
let lastReloadAt = 0;          // cooldown
let reloading = false;         // single-flight

// Pasta estavel onde a GUI le os logs (sobrevive a updates do Discord e a
// desativacao). Espelhar aqui e o que permite o report de bug pegar o log do
// bypass mesmo depois de o app.asar injetado ser apagado.
const MIRROR_DIR = (() => {
    try {
        if (process.platform === "win32" && process.env.LOCALAPPDATA) {
            return join(process.env.LOCALAPPDATA, "GoLiveBypass", "logs");
        }
        const base = process.env.XDG_DATA_HOME || join(require("os").homedir(), ".local", "share");
        return join(base, "GoLiveBypass", "logs");
    } catch {
        return "";
    }
})();
const MIRROR_MAX_BYTES = 2 * 1024 * 1024;

function log(line) {
    const stamp = new Date().toTimeString().slice(0, 8);
    if (LOG_FILE !== null) try {
        // Sem comando de diagnostico aqui, o arquivo e a unica forma de saber o que aconteceu.
        // Ele e cortado sozinho para nao crescer sem fim numa maquina que ninguem limpa.
        if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > MAX_LOG_BYTES) {
            fs.writeFileSync(LOG_FILE, fs.readFileSync(LOG_FILE, "utf8").slice(-MAX_LOG_BYTES / 2));
        } else if (!fs.existsSync(LOG_FILE)) {
            // A pasta pode nao existir ainda (injecao numa maquina que nunca rodou o app).
            fs.mkdirSync(dirname(LOG_FILE), { recursive: true });
        }
        fs.appendFileSync(LOG_FILE, stamp + " " + line + "\n");
    } catch {
        // Ficar sem registro e ruim; derrubar o Discord por causa do registro e pior.
    }

    // Espelho para a pasta estavel (falha silenciosa: nunca derruba o Discord).
    if (MIRROR_DIR !== "") {
        try {
            const alvo = join(MIRROR_DIR, "bypass.log");
            fs.mkdirSync(MIRROR_DIR, { recursive: true });
            if (fs.existsSync(alvo) && fs.statSync(alvo).size > MIRROR_MAX_BYTES) {
                fs.renameSync(alvo, join(MIRROR_DIR, "bypass.1.log"));
            }
            fs.appendFileSync(alvo, stamp + " " + line + "\n");
        } catch {
            // silencioso
        }
    }

    console.log("[GoLiveBypass]", line);
}

function readJson(file, fallback) {
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
        return fallback;
    }
}

function writeJson(file, value) {
    try {
        fs.writeFileSync(file, JSON.stringify(value, null, 4));
    } catch (error) {
        log("nao consegui gravar " + basename(file) + ": " + error.message);
    }
}

const settings = readJson(SETTINGS_FILE, {});
const excludedCountries = new Set(
    (typeof settings.excludedCountries === "string" ? settings.excludedCountries : "BR")
        .split(",").map(code => code.trim().toUpperCase()).filter(code => /^[A-Z]{2}$/.test(code))
);

// Rede de saida escolhida na GUI. "auto" (ou vazio) = comportamento classico: Tor local se
// houver, senao gratuitas. "tor" = SO o Tor (a GUI sobe o proprio). "free" = pula o Tor e
// vai so as gratuitas (para quem nao quer Tor).
const routeMode = typeof settings.routeMode === "string" ? settings.routeMode : "auto";
// O endereco do Tor pode vir das settings (a GUI sobe o proprio numa porta dedicada).
const TOR_ADDR = typeof settings.torAddr === "string" && settings.torAddr !== ""
    ? settings.torAddr
    : "127.0.0.1:9050";

// O trecho antes do @ e opcional e casado com ganancia, para a senha poder conter @ e : sem
// precisar de escape: quem recebe um endereco pronto da AWS costuma cola-lo como veio.
// Agora suporta RANGE de portas para proxies multiplexados, ex: 10000-10050
const PROXY_RE = /^(socks5|socks4|http|https):\/\/(?:(.+)@)?([^:/?#\s@]+):(\d{1,5})(?:-(\d{1,5}))?$/;

function parseProxy(value) {
    const match = PROXY_RE.exec(String(value).trim());
    if (match === null) return null;

    const portStart = Number(match[4]);
    if (portStart < 1 || portStart > 65535) return null;
    let finalPort = portStart;

    // Se tiver range, sorteia uma porta do range
    if (match[5] !== undefined) {
        const portEnd = Number(match[5]);
        if (portEnd >= portStart && portEnd <= 65535) {
            finalPort = Math.floor(Math.random() * (portEnd - portStart + 1)) + portStart;
        }
    }

    // Dividido no primeiro dois-pontos, entao a senha pode ter quantos quiser.
    const credentials = match[2] === undefined ? "" : match[2];
    const split = credentials.indexOf(":");
    const decode = value => {
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
        port: finalPort
    };
}

// Nunca registrar a senha: o registro vai para arquivo e as pessoas colam ele em relato de
// problema.
function safeProxy(value) {
    const parsed = parseProxy(value);
    if (parsed === null) return "endereco invalido";

    return parsed.scheme + "://" + (parsed.user === "" ? "" : parsed.user + ":***@") + parsed.host + ":" + parsed.port;
}

function manualProxy() {
    const raw = settings.proxy;
    if (typeof raw !== "string" || raw.trim() === "") return "";

    const parsed = parseProxy(raw);
    if (parsed === null) return null;

    // Retorna a string ja renderizada com a porta sorteada (se houver range)
    return parsed.scheme + "://" +
           (parsed.user !== "" ? parsed.user + ":" + parsed.pass + "@" : "") +
           parsed.host + ":" + parsed.port;
}

// Saida manual/privada configurada (com ou sem range multiplexado). Usada para desligar a
// reposicao de reserva e a troca proativa por RTT: sao mecanismos pensados para saida
// GRATUITA, que morre sem avisar e precisa de troca em segundo plano. Numa saida privada,
// entrar neles so custa (ver trySwapByRtt e stockReserves).
const usingManualProxy = typeof settings.proxy === "string" && settings.proxy.trim() !== "" && parseProxy(settings.proxy) !== null;

// A saida ativa e uma das portas configuradas pela pessoa? Comparacao por string falha
// para range: manualProxy() sorteia uma porta nova a cada chamada, entao a mesma saida
// ativa nunca bateria com uma leitura nova. Aqui confere host e se a porta cai dentro do
// intervalo configurado (um range vira um intervalo de 1 porta so).
function isManualAddress(proxy) {
    if (proxy === null || !usingManualProxy) return false;
    const match = PROXY_RE.exec(String(settings.proxy).trim());
    if (match === null) return false;
    const candidato = parseProxy(proxy);
    if (candidato === null || candidato.host !== match[3]) return false;
    const portStart = Number(match[4]);
    if (match[5] === undefined) return candidato.port === portStart;
    // Mesma convencao do parseProxy: range invalido (portEnd < portStart ou > 65535) cai
    // para porta unica (portStart). Sem isto, isManualAddress rejeita uma porta que o
    // parseProxy aceitou -- o tryReturnToManual nunca reconhece a ativa como manual e
    // fica tentando trocar a cada 90s para uma porta que ele mesmo ja' sorteou.
    const portEnd = Number(match[5]);
    if (portEnd < portStart || portEnd > 65535) return candidato.port === portStart;
    return candidato.port >= portStart && candidato.port <= portEnd;
}

// ------------------------------------------------------------------ falar com uma saida

function readReply(socket, size, done) {
    const chunks = [];
    let settled = false;

    const finish = reply => {
        if (settled) return;
        settled = true;
        socket.off("data", onData);
        socket.off("close", onClose);
        done(reply);
    };

    const onData = chunk => {
        chunks.push(chunk);
        const buffer = Buffer.concat(chunks);
        const wanted = size(buffer);
        if (wanted < 0 || buffer.length < wanted) return;

        socket.pause();
        if (buffer.length > wanted) socket.unshift(buffer.subarray(wanted));
        finish(buffer.subarray(0, wanted));
    };

    // Uma saida que aceita a conexao e fecha limpo no meio da negociacao nao gera erro nenhum:
    // FIN nao e erro. Sem escutar o fechamento o retorno so viria quando o prazo estourasse.
    const onClose = () => finish(null);

    socket.on("data", onData);
    socket.on("close", onClose);
    socket.resume();
}

function negotiateSocks5(socket, host, port, credentials, done) {
    // Oferecer o metodo 2 so quando ha credencial: um proxy que aceita os dois escolheria a
    // autenticacao a toa, e ai um usuario vazio seria recusado.
    socket.write(credentials.user === "" ? Buffer.from([5, 1, 0]) : Buffer.from([5, 2, 0, 2]));

    readReply(socket, buffer => (buffer.length < 2 ? -1 : 2), greeting => {
        if (greeting === null || greeting[0] !== 5) return done(false, "etapa=greeting motivo=sem_resposta");

        // 0 = sem autenticacao, 2 = usuario e senha (RFC 1929). Qualquer outra coisa, inclusive
        // 0xFF, significa que o proxy nao aceita nada que a gente sabe fazer.
        if (greeting[1] === 2) {
            const user = Buffer.from(credentials.user, "utf8");
            const pass = Buffer.from(credentials.pass, "utf8");
            if (user.length > 255 || pass.length > 255) return done(false, "etapa=auth motivo=credencial_longa");

            readReply(socket, buffer => (buffer.length < 2 ? -1 : 2), reply => {
                if (reply === null || reply[1] !== 0) return done(false, "etapa=auth motivo=recusada code=socks5:0x" + (reply && reply[1] !== undefined ? reply[1].toString(16) : "??"));
                sendTarget();
            });

            socket.write(Buffer.concat([
                Buffer.from([1, user.length]), user,
                Buffer.from([pass.length]), pass
            ]));
            return;
        }

        if (greeting[1] !== 0) return done(false, "etapa=greeting code=socks5:0x" + greeting[1].toString(16));
        sendTarget();
    });

    function sendTarget() {
        const name = Buffer.from(host, "utf8");
        const message = Buffer.alloc(7 + name.length);
        message[0] = 5;
        message[1] = 1;
        message[2] = 0;
        message[3] = 3;
        message[4] = name.length;
        name.copy(message, 5);
        message.writeUInt16BE(port, 5 + name.length);
        socket.write(message);

        readReply(socket, buffer => {
            if (buffer.length < 5) return -1;
            if (buffer[3] === 1) return 10;
            if (buffer[3] === 4) return 22;
            if (buffer[3] === 3) return 7 + buffer[4];
            return -1;
        }, reply => {
            if (reply !== null && reply[1] === 0) return done(true);
            const code = reply === null ? "??" : "0x" + reply[1].toString(16);
            done(false, "etapa=connect code=socks5:" + code);
        });
    }
}

function negotiateConnect(socket, host, port, credentials, done) {
    // O proxy HTTP nao negocia metodo: ou a credencial vai junto do CONNECT, ou ele responde
    // 407 e a conexao ja era.
    const auth = credentials.user === ""
        ? ""
        : "Proxy-Authorization: Basic " + Buffer.from(credentials.user + ":" + credentials.pass, "utf8").toString("base64") + "\r\n";

    socket.write("CONNECT " + host + ":" + port + " HTTP/1.1\r\nHost: " + host + ":" + port + "\r\n" + auth + "\r\n");

    readReply(socket, buffer => {
        const end = buffer.indexOf("\r\n\r\n");
        return end < 0 ? -1 : end + 4;
    }, reply => {
        if (reply === null) return done(false, "etapa=http motivo=sem_resposta");
        const linha = reply.toString("latin1").split("\r\n")[0];
        if (/ 200 /.test(linha)) return done(true);
        const status = (linha.match(/^HTTP\/\d\.\d (\d{3})/) || [])[1] || "??";
        done(false, "etapa=http code=" + status);
    });
}

function openTunnel(proxy, host, port, timeoutMs) {
    return new Promise(resolve => {
        const parsed = parseProxy(proxy);
        if (parsed === null) return resolve(null);

        let settled = false;
        const inicio = Date.now();
        const finish = (value, motivo) => {
            if (settled) return;
            settled = true;
            if (value === null) socket.destroy();
            else socket.setTimeout(0);
            // Log da causa da falha do tunel — o diagnostico que hoje some:
            // etapa (tcp/greeting/auth/connect/tls), errno (ECONNREFUSED/ETIMEDOUT)
            // e code (rep SOCKS / status HTTP do CONNECT).
            if (value === null && motivo) {
                log("[net] tunel.falha | alvo=" + host + ":" + port + " saida=" + safeProxy(proxy) + " " + motivo + " ms=" + (Date.now() - inicio));
            }
            resolve(value);
        };

        const socket = connect({ host: parsed.host, port: parsed.port });
        socket.setTimeout(timeoutMs || PROBE_TIMEOUT_MS, () => finish(null, "etapa=tcp motivo=timeout"));
        socket.on("error", e => finish(null, "etapa=tcp errno=" + (e && e.code ? e.code : "desconhecido")));
        socket.once("connect", () => {
            const done = (ok, motivo) => finish(ok ? socket : null, ok ? undefined : motivo);
            if (parsed.scheme === "socks5") negotiateSocks5(socket, host, port, parsed, done);
            else negotiateConnect(socket, host, port, parsed, done);
        });
    });
}

function readOverTls(socket, host, path, timeoutMs) {
    return new Promise(resolve => {
        let body = "";
        let settled = false;

        const finish = value => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            tls.destroy();
            resolve(value);
        };

        const timer = setTimeout(() => finish(null), timeoutMs || PROBE_TIMEOUT_MS);
        const tls = connectTls({ socket, servername: host, host }, () => {
            tls.write("GET " + path + " HTTP/1.1\r\nHost: " + host + "\r\nAccept: */*\r\nConnection: close\r\n\r\n");
        });

        tls.setEncoding("latin1");
        tls.on("error", () => finish(null));
        tls.on("data", chunk => {
            body += chunk;
            if (body.length > 65536) finish(body);
        });
        tls.on("end", () => finish(body));
    });
}

// So o aperto de mao TLS, sem pedir pagina nenhuma. Serve para hosts que nao respondem HTTP --
// o gateway e websocket -- e ainda assim prova o que importa: a saida alcanca o host e o
// certificado fecha, entao ela nao esta sendo barrada por reputacao ali.
function tlsHandshake(socket, host, timeoutMs) {
    return new Promise(resolve => {
        let settled = false;

        const finish = value => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            tls.destroy();
            resolve(value);
        };

        const timer = setTimeout(() => finish(false), timeoutMs || PROBE_TIMEOUT_MS);
        const tls = connectTls({ socket, servername: host, host }, () => finish(true));

        tls.on("error", () => finish(false));
        // Um host que aceita a conexao e fecha limpo antes do handshake nao gera erro: sem
        // isto o retorno so viria quando o prazo estourasse.
        tls.on("close", () => finish(false));
    });
}

// Prova o que interessa numa saida: o tunel negocia, o TLS fecha com certificado valido para o
// Discord, e o Discord responde 200 por ela. Saida barrada por reputacao falha exatamente aqui,
// que e o motivo de o teste nao ser contra um endereco qualquer.
async function probe(proxy, timeoutMs) {
    const started = Date.now();

    // No modo "tor" o teste e feito contra o host que a saida REALMENTE vai carregar. O
    // discord.com fica atras da Cloudflare, que recusa o handshake TLS vindo de exit de Tor
    // ("tls alert handshake failure", medido em 2026-08-23) -- e o roteador nunca manda
    // discord.com pela saida, so *.discord.gg. Ou seja: a saida era reprovada por um host que
    // ela nunca ia atender, e o modo tor ficava preso em "porta aberta mas nao respondeu como
    // proxy" com o Tor de pe e o gateway alcancavel (TLS ate gateway.discord.gg em ~600ms).
    //
    // Aqui a prova e o handshake TLS ate o gateway: o /api/v9/gateway nao existe nesse host
    // (ele e websocket), entao exigir HTTP 200 nao faria sentido. Um exit que fecha TLS com o
    // gateway entrega o que precisamos.
    const host = routeMode === "tor" ? ROUTED_HOSTS[0] : DISCORD_HOST;

    const socket = await openTunnel(proxy, host, 443, timeoutMs);
    if (socket === null) return null;

    if (routeMode === "tor") {
        if (!await tlsHandshake(socket, host, timeoutMs)) return null;
    } else {
        const response = await readOverTls(socket, host, "/api/v9/gateway", timeoutMs);
        if (response === null || (!response.startsWith("HTTP/1.1 200") && !response.startsWith("HTTP/1.1 404"))) return null;
    }

    const ms = Date.now() - started;
    // Alimenta a EMA de RTT da saida: a troca proativa por lentidao le desta leitura.
    const ema = rttEma.has(proxy) ? rttEma.get(proxy) : ms;
    rttEma.set(proxy, ema + RTT_EMA_ALPHA * (ms - ema));

    return { proxy: proxy, ms: ms };
}

// O host que reporta o pais de saida quando o trace da Cloudflare nao traz um loc de pais
// real — exatamente o que acontece com exits do Tor (o loc vem como "T1") e com varias
// gratuitas. O ipwho.is responde via Tor/US; ifconfig.co provou ser instavel demais.
const GEO_FALLBACK_HOST = "ipwho.is";

async function exitCountry(proxy, timeoutMs) {
    // O trace da Cloudflare prova o tunel e o pais numa conexao so; e o caminho rapido.
    const socket = await openTunnel(proxy, GEO_HOST, 443, timeoutMs);
    if (socket !== null) {
        const response = await readOverTls(socket, GEO_HOST, "/cdn-cgi/trace", timeoutMs);
        const match = response === null ? null : /^loc=([A-Z]{2})/m.exec(response);
        // "T1" e o codigo especial que a Cloudflare usa para exits do Tor: nao e um pais.
        if (match !== null && match[1] !== "T1") return match[1];
    }

    // Fallback: sem um pais de verdade no trace, pergunta ao ipwho.is (JSON com
    // country_code). Sem isto, Tor e varias gratuitas eram recusadas como "saida em pais
    // desconhecido" mesmo com o tunel funcionando.
    try {
        const fallback = await openTunnel(proxy, GEO_FALLBACK_HOST, 443, timeoutMs);
        if (fallback !== null) {
            const json = await readOverTls(fallback, GEO_FALLBACK_HOST, "/?fields=country_code", timeoutMs);
            const iso = json === null ? null : /"country_code"\s*:\s*"([A-Z]{2})"/.exec(json);
            if (iso !== null) return iso[1];
        }
    } catch {
        // sem o pais, o chamador recusa a saida — melhor que assumption errada
    }

    return null;
}

// As duas conexoes em sequencia de proposito: saida gratuita sobrecarregada costuma limitar
// conexoes simultaneas, e abrir duas de uma vez reprovaria candidata boa. O paralelismo que
// importa e entre candidatas, no lote que chama esta funcao.
async function probeExit(proxy) {
    const result = await probe(proxy);
    if (result === null) return null;

    result.country = await exitCountry(proxy);
    return result;
}

// ------------------------------------------------------------------ escolher a saida

function downloadText(url, timeoutMs) {
    return new Promise((resolve, reject) => {
        const req = request(url, res => {
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error("resposta inesperada: " + res.statusCode));
            }

            let body = "";
            res.setEncoding("utf8");
            res.on("data", chunk => {
                body += chunk;
                if (body.length > 4_000_000) req.destroy(new Error("resposta grande demais"));
            });
            res.on("end", () => resolve(body));
        });

        req.on("error", reject);
        req.setTimeout(timeoutMs || 15_000, () => req.destroy(new Error("tempo esgotado")));
        req.end();
    });
}

// As listas gratuitas de uma fonte so mudam de vez em quando e variam de qualidade; juntar
// varias fontes dilui a dependencia de uma unica lista e aumenta a chance de achar uma saida
// com RTT decente. A proxyscrape (formato JSON com uptime) segue sendo a primeira; as demais
// trazem candidatas de outras redes. Tudo e testado de verdade pelo probe antes de usar.
const FREE_PROXY_API = "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=socks5&proxy_format=protocolipport&format=json&timeout=1500";
const FREE_PROXY_FONTES = [
    { tipo: "proxyscrape", url: FREE_PROXY_API },
    { tipo: "plain", url: "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt" },
    { tipo: "plain", url: "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt" },
    { tipo: "plain", url: "https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt" },
    { tipo: "geonode", url: "https://proxylist.geonode.com/api/proxy-list?limit=80&page=1&sort_by=lastChecked&sort_type=desc&protocols=socks5" }
];
// As fontes sao baixadas juntas; prazo curto para a mais lenta nao atrasar a escolha (o
// gateway espera no roteador por ate HOLD_BUDGET_MS).
const FONTES_TIMEOUT_MS = 6000;

// Cada formato de fonte vira a mesma coisa: { proxy, uptime?, timeout?, country? }. O
// timeout quando a fonte reporta e a latencia declarada — usada no ranqueamento, nao como
// verdade (o probe decide).
function parsePlain(body) {
    const itens = [];
    for (const linha of body.split("\n")) {
        const p = linha.trim();
        if (p === "" || p.startsWith("#")) continue;
        // listas "host:port" e "socks5://host:port" convivem; normaliza para o segundo.
        const proxy = p.includes("://") ? p : "socks5://" + p;
        if (parseProxy(proxy) !== null) itens.push({ proxy: proxy });
    }
    return itens;
}

function parseGeonode(body) {
    const data = JSON.parse(body);
    const list = Array.isArray(data.data) ? data.data : [];
    return list.map(entry => ({
        proxy: "socks5://" + entry.ip + ":" + entry.port,
        uptime: typeof entry.upTime === "number" ? entry.upTime : undefined,
        timeout: typeof entry.latency === "number" ? entry.latency : undefined,
        country: String(entry.country || "")
    })).filter(item => parseProxy(item.proxy) !== null);
}

function parseProxyScrape(body) {
    const data = JSON.parse(body);
    const list = Array.isArray(data.proxies) ? data.proxies : [];
    return list.map(entry => ({
        proxy: String(entry.proxy || ""),
        uptime: typeof entry.uptime === "number" ? entry.uptime : undefined,
        timeout: typeof entry.timeout === "number" ? entry.timeout : undefined,
        country: String((entry.ip_data && entry.ip_data.countryCode) || "")
    })).filter(item => item.proxy !== "" && parseProxy(item.proxy) !== null);
}

async function fetchFreeProxies() {
    // Se o usuario configurou um range multiplexado, usamos ele como nosso "pool publico" privado.
    // Isso impede que ao falhar a porta principal o app vaze para uma proxy publica aleatoria.
    const raw = settings.proxy;
    if (typeof raw === "string" && raw.trim() !== "") {
        const match = PROXY_RE.exec(raw.trim());
        if (match !== null && match[5] !== undefined) {
            const portStart = Number(match[4]);
            const portEnd = Number(match[5]);
            if (portEnd >= portStart && portEnd <= 65535) {
                const poolManual = [];
                for (let p = portStart; p <= portEnd; p++) {
                    const str = `${match[1]}://${match[2] ? match[2] + '@' : ''}${match[3]}:${p}`;
                    poolManual.push({ proxy: str, country: "BR" });
                }
                log("usando " + poolManual.length + " portas do pool multiplexado ao inves de proxies publicas");
                return poolManual;
            }
        }
    }

    const porFonte = await Promise.all(FREE_PROXY_FONTES.map(async fonte => {
        try {
            const body = await downloadText(fonte.url, FONTES_TIMEOUT_MS);
            log("fonte " + fonte.tipo + ": ok (" + body.length + " bytes)");
            if (fonte.tipo === "plain") return parsePlain(body);
            if (fonte.tipo === "geonode") return parseGeonode(body);
            return parseProxyScrape(body);
        } catch (e) {
            log("fonte " + fonte.tipo + ": falhou (" + (e && e.message ? e.message : "erro") + ")");
            return [];
        }
    }));

    // Junta as fontes e tira duplicata (primeira vence; a ordem das fontes define a
    // precedencia quando a mesma saida aparece em duas listas).
    const unicos = new Map();
    for (const itens of porFonte) {
        for (const item of itens) if (!unicos.has(item.proxy)) unicos.set(item.proxy, item);
    }
    return [...unicos.values()];
}

function rankFreeProxies(lista) {
    const base = foraDeQuarentena(lista)
        .filter(entry => entry && entry.proxy)
        .filter(entry => typeof entry.uptime !== "number" || entry.uptime >= MIN_UPTIME)
        .filter(entry => typeof entry.timeout !== "number" || entry.timeout <= MAX_LISTED_TIMEOUT)
        // A porta 4145 e quase toda de intermediario que responde por qualquer destino sem
        // encaminhar nada. Ela reprova no teste, mas so depois de gastar o prazo.
        .filter(entry => !String(entry.proxy).endsWith(":4145"))
        .filter(entry => !excludedCountries.has(String(entry.country).toUpperCase()));

    // As listas sem metadado (plain) nao tem timeout declarado: ordenar so por ele jogaria
    // ~2700 candidatas para o fim e o primeiro lote testaria apenas fontes com campo de
    // latencia — que podem estar todas mortas. Intercala mantendo a melhor de cada lado.
    const comTimeout = base.filter(e => typeof e.timeout === "number").sort((a, b) => a.timeout - b.timeout);
    const semTimeout = base.filter(e => typeof e.timeout !== "number");
    const intercalado = [];
    const fim = Math.max(comTimeout.length, semTimeout.length);
    for (let i = 0; i < fim && intercalado.length < MAX_CANDIDATES; i++) {
        if (i < comTimeout.length) intercalado.push(comTimeout[i]);
        if (i < semTimeout.length && intercalado.length < MAX_CANDIDATES) intercalado.push(semTimeout[i]);
    }

    return intercalado.map(entry => String(entry.proxy));
}

function listening(port, timeoutMs) {
    return new Promise(resolve => {
        const socket = connect({ host: "127.0.0.1", port: port });
        const finish = value => {
            socket.destroy();
            resolve(value);
        };

        socket.setTimeout(timeoutMs, () => finish(false));
        socket.on("error", () => finish(false));
        socket.once("connect", () => finish(true));
    });
}

function savePool() {
    writeJson(STATE_FILE, { pool: pool, at: Date.now() });
}

// Unica janela para o estado das saidas: chosenExit e pool sao locais deste arquivo, e sem isto
// nem o registro nem um teste conseguem dizer o que o batimento decidiu.
function poolStatus() {
    return {
        active: chosenExit,
        pool: pool.map(entry => entry.proxy),
        missed: [...missedBeats.entries()]
    };
}

async function detectTor() {
    // No modo "tor" o endereco vem das settings (a GUI sobe o proprio Tor). Nos outros
    // modos, procura as portas classicas de clientes Tor da maquina.
    const candidatas = routeMode === "tor"
        ? [TOR_ADDR]
        : TOR_PORTS.map(port => "127.0.0.1:" + port);

    for (const addr of candidatas) {
        const proxy = "socks5://" + addr;
        const port = Number(addr.split(":")[1] || 0);
        if (!await listening(port, TOR_PORT_TIMEOUT_MS)) continue;
        if (await probe(proxy) === null) {
            log("porta " + port + " esta aberta mas nao respondeu como proxy");
            continue;
        }

        // No modo "tor" a checagem de geo nem roda: dos ~10.600 relays de saida do mundo,
        // ~37 sao brasileiros (menos de 0.4%), e a checagem so pagava uma ida-e-volta pelo
        // Tor (1-1.4s de RTT) para martelar um terceiro (ipwho.is) com IPs de saida do Tor
        // compartilhados por milhares de usuarios -- cota que estoura sozinha e nao depende
        // de nada que a gente fez. Quando estoura, a checagem falha pra sempre (sem TTL: o
        // Tor troca de circuito a cada ~10min, entao um cache de horas descreveria uma saida
        // que ja nao existe), e o modo tor ja aceitava pais desconhecido mesmo assim -- ou
        // seja, a checagem quase nunca barra nada na pratica. Quem escolhe Tor esta pedindo
        // uma saida que nao se identifica; nao sair pelo IP brasileiro o proprio Tor garante.
        if (routeMode === "tor") {
            log("Tor encontrado na porta " + port + " (geo nao verificada em modo tor)");
            return proxy;
        }

        const country = await exitCountry(proxy);

        if (country !== null && excludedCountries.has(country)) {
            log("Tor na porta " + port + " recusado: saida em " + country);
            continue;
        }

        if (country === null) {
            log("Tor na porta " + port + " recusado: saida em pais desconhecido");
            continue;
        }

        log("Tor encontrado na porta " + port + ", saida em " + country);
        return proxy;
    }

    return null;
}

// Devolve as aprovadas da busca, sem mexer no pote nem na saida ativa: quem chama decide se
// isto e a escolha da sessao ou so reserva chegando por baixo. As aprovadas vem ORDENADAS
// pelo RTT do probe (menor primeiro): a primeira aprovada que chega costuma ser so a mais
// rapida de CHEGAR, nao a mais rapida de verdade — e colocar uma saida de 1.7s quando a
// busca tinha uma de 400ms e a propria instabilidade que derruba o gateway. Parou de cortar
// probes por lote: o prazo agora e global, e quem completa dentro dele entra na escolha.
async function huntExits() {
    let candidates;
    try {
        // Baixa as fontes juntas, junta sem duplicata e filtra/ranqueia.
        candidates = rankFreeProxies(await fetchFreeProxies());
    } catch (error) {
        log("nao consegui baixar a lista de saidas: " + error.message);
        return [];
    }

    log(candidates.length + " candidatas depois do ranqueamento");

    const prazoFinal = Date.now() + HUNT_BUSCA_TOTAL_MS;

    for (let i = 0; i < candidates.length; i += PARALLEL_PROBES) {
        const restante = prazoFinal - Date.now();
        if (restante <= 0) break;

        const batch = candidates.slice(i, i + PARALLEL_PROBES);

        // Todas as probes do lote podem completar; a escolha sai no prazo global OU quando o
        // lote terminou — o que vier primeiro. Uma aprovada que chega antes ja entra.
        const aprovadas = await new Promise(resolve => {
            const found = [];
            let pending = batch.length;
            let settled = false;
            const prazo = setTimeout(terminar, restante);

            function terminar() {
                if (settled) return;
                settled = true;
                clearTimeout(prazo);
                resolve(found);
            }

            for (const candidate of batch) {
                probeExit(candidate).then(r => {
                    if (settled) return;

                    if (r !== null && r.country !== null && !excludedCountries.has(r.country)) {
                        found.push(r);
                    } else if (r !== null) {
                        log(r.proxy + " recusada: saida em " + (r.country || "pais desconhecido"));
                    }

                    if (--pending === 0) terminar();
                });
            }
        });

        if (aprovadas.length === 0) continue;

        // Menor RTT primeiro: a ativa vira a melhor da busca, e o pool herda a mesma ordem.
        return aprovadas.sort((a, b) => a.ms - b.ms);
    }

    return [];
}

async function pickFreeExit() {
    const aprovadas = await huntExits();
    if (aprovadas.length === 0) return null;

    pool = aprovadas.slice(0, POOL_SIZE);
    log("escolhida " + pool[0].proxy + ": " + pool[0].ms + "ms, saida em " + pool[0].country);
    if (pool.length > 1) {
        log("reservas: " + pool.slice(1).map(e => e.proxy + " (" + e.ms + "ms " + e.country + ")").join(", "));
    }

    savePool();
    return pool[0].proxy;
}

async function cachedExit() {
    // No modo "tor" saida guardada nao vale nada: o cache so guarda gratuitas, e deixar
    // ele vencer a escolha fazia o gateway NASCER por proxy gratuita com o Tor de pe
    // (reprovado em teste: cache quente + routeMode tor -> "reaproveitando 3 de 3" e
    // saida gratuita usada sem o Tor ser consultado).
    if (routeMode === "tor") return null;
    const state = readJson(STATE_FILE, null);
    if (state === null || typeof state.at !== "number") return null;
    if (Date.now() - state.at > CACHE_MAX_AGE_MS) return null;

    // Versoes anteriores guardavam uma saida so, em state.proxy. As que estao em quarentena
    // nao sao reeleitas: quem causou sofrimento no passado recente nao volta so por estar
    // guardada.
    const guardadas = foraDeQuarentena(
        Array.isArray(state.pool)
            ? state.pool.filter(e => e && typeof e.proxy === "string")
            : (typeof state.proxy === "string" ? [{ proxy: state.proxy, ms: 0, country: "?" }] : [])
    );

    // Testadas em paralelo e escolhida a mais rapida de agora: a ordem de ontem nao vale hoje,
    // e testar uma por vez gastaria o orcamento inteiro na primeira que tivesse morrido.
    const vivas = (await Promise.all(guardadas.map(async e => {
        const r = await probe(e.proxy, 2500);
        return r === null ? null : { proxy: e.proxy, ms: r.ms, country: e.country };
    }))).filter(Boolean).sort((a, b) => a.ms - b.ms);

    if (vivas.length === 0) return null;

    pool = vivas;
    log("reaproveitando " + vivas.length + " de " + guardadas.length + " saidas guardadas, a melhor com " + vivas[0].ms + "ms");
    return vivas[0].proxy;
}

async function chooseExit() {
    const manual = manualProxy();
    if (manual === null) {
        log("o endereco em proxy nao e valido, ignorando");
    } else if (manual !== "") {
        // Saida escolhida e gravada pela pessoa nas settings: usar NA HORA, sem probe.
        // O probe completo (TLS ate o Discord) gasta ~1s, e o gateway conecta em menos —
        // com a escolha devagar a corrida morre e a sessao nasce direta pelo IP brasileiro
        // (o "carregando infinitamente" no video). Com a saida na mao em milissegundos o
        // gateway ja nasce roteado; o batimento valida a cada 30s, e se ela estiver morta
        // o trafego vivo cai para reserva/cache/lista antes de ir direto.
        log("usando a saida que voce configurou: " + safeProxy(manual));
        probe(manual, 2500).then(ok => {
            if (ok === null) log("a saida que voce configurou nao respondeu ao probe em segundo plano: " + safeProxy(manual));
        });
        return manual;
    }

    const cached = await cachedExit();
    if (cached !== null) return cached;

    // Modo "tor": SO o Tor conta. Sem Tor nao ha saida — o gateway fica segurado (nunca
    // vaza direto para o IP brasileiro), e o refresh continua tentando ate o Tor voltar.
    if (routeMode === "tor") {
        const tor = await detectTor();
        if (tor !== null) return tor;
        log("modo tor: nenhum Tor respondeu em " + TOR_ADDR + ", segurando o gateway (sem saida direta)");
        return null;
    }

    // Modo "free": pula o Tor (quem escolheu gratuitas nao quer depender de Tor).
    if (routeMode === "free") {
        return await pickFreeExit();
    }

    return await detectTor() || await pickFreeExit();
}

let lastExitAt = 0; // quando a saida atual foi escolhida (para o log do gateway visto)

function settleExit(proxy) {
    chosenExit = proxy;
    exitSettled = true;
    if (proxy !== null) lastExitAt = Date.now();
    while (waitingForExit.length > 0) waitingForExit.shift()(proxy);

    // Saida nova no ar e o gateway tinha saido direto ha pouco: esta sessao nasceu bloqueada
    // e so um reload faz o gateway renascer atras da saida. Avalia (com todas as guardas).
    if (proxy !== null && gatewayWentDirectAt !== 0) {
        maybeReloadAfterDirect();
    }
}

// ------------------------------------------------------------------ recarga pos-gateway-direto

function clientWindow() {
    for (const win of require("electron").BrowserWindow.getAllWindows()) {
        if (win.isDestroyed()) continue;
        const url = win.webContents.getURL();
        if (CLIENT_URL_RE.test(url)) return win;
    }
    return null;
}

// Reservas vivas no pool (excluindo a ativa). A recarga depende disto: renascer o gateway
// com o pool de 1 so deixava a sessao vulneravel a morte da ativa no renascimento (o caso
// do ciclo 7 do teste de estresse — 8s de "carregando" sem reserva para assumir).
const RELOAD_MIN_RESERVES = 1;
const RELOAD_RESERVE_WAIT_MS = 10_000;

function liveReserveCount() {
    return pool.filter(entry => entry.proxy !== chosenExit).length;
}

function maybeReloadAfterDirect() {
    // Sinal expirado: o gateway direto foi ha tempo demais, a sessao pode ter se recuperado.
    if (Date.now() - gatewayWentDirectAt > DIRECT_SIGNAL_TTL_MS) {
        gatewayWentDirectAt = 0;
        return;
    }
    if (reloading || reloadCount >= RELOAD_MAX_RETRIES) return;
    if (Date.now() - lastReloadAt < RELOAD_COOLDOWN_MS) return;

    const exit = chosenExit;
    if (exit === null) return;

    reloading = true;
    // A saida tem que estar comprovadamente entregando AGORA: recarregar com saida morta
    // repetiria a mesma falha e gastaria uma tentativa a toa.
    probe(exit, 2500).then(ok => {
        if (ok === null) {
            log("saida " + safeProxy(exit) + " nao respondeu, adiando a recarga");
            return;
        }

        // NAO cancela por roteado recente: a reconexao roteada depois da corrida perdida nao
        // desbloqueia a sessao (o veredito foi no CONNECTION_OPEN original, direto). So a
        // recarga da janela faz o gateway renascer atras da saida de verdade.

        // Espera por reserva viva (ate RELOAD_RESERVE_WAIT_MS): o renascimento pos-recarga
        // precisa de uma reserva para assumir na hora se a ativa morrer (o caso raro do ciclo
        // 7). Se o pool ja tem, segue direto. Se o gateway rotear no meio (corrida ganha),
        // cancela — a recarga nao e mais necessaria.
        ensureReserveThenReload(exit);
    }).catch(error => {
        log("a checagem antes da recarga falhou: " + error.message);
    }).finally(() => {
        reloading = false;
    });
}

function ensureReserveThenReload(exit) {
    const tryReload = () => {
        // Cancela se a sessao se resolveu sozinha (gateway passou pela saida).
        if (Date.now() - lastRoutedAt < 3000) {
            log("gateway ja passou pela saida, recarga desnecessaria");
            gatewayWentDirectAt = 0;
            return;
        }
        const win = clientWindow();
        if (win === null) {
            log("nao achei a janela do cliente Discord para recarregar");
            return;
        }
        reloadCount++;
        lastReloadAt = Date.now();
        gatewayWentDirectAt = 0; // so recarrega uma vez por sinal
        log("o gateway tinha saido direto, recarregando atras de " + safeProxy(exit) + " (tentativa " + reloadCount + " de " + RELOAD_MAX_RETRIES + ")");
        win.webContents.reload();
    };

    if (liveReserveCount() >= RELOAD_MIN_RESERVES) return tryReload();

    // Sem reserva: busca em background e espera um pouco. A sessao ja esta bloqueada, entao
    // esperar nao piora; recarregar vulneravel deixaria o renascimento a merce da ativa.
    log("sem reserva viva, enchendo o pote antes de recarregar");
    stockReserves(liveReserveCount());

    const deadline = Date.now() + RELOAD_RESERVE_WAIT_MS;
    const poll = setInterval(() => {
        if (Date.now() - lastRoutedAt < 3000) {
            clearInterval(poll);
            log("gateway ja passou pela saida, recarga desnecessaria");
            gatewayWentDirectAt = 0;
            return;
        }
        if (liveReserveCount() >= RELOAD_MIN_RESERVES) {
            clearInterval(poll);
            log("reserva disponivel, recarregando agora");
            tryReload();
            return;
        }
        if (Date.now() >= deadline) {
            clearInterval(poll);
            // Prazo estourado: recarrega mesmo sem reserva — a sessao ja esta bloqueada, e
            // segurar mais so prolonga o "carregando". O refresh runtime cobre a morte.
            log("prazo de reserva estourado, recarregando mesmo assim");
            tryReload();
        }
    }, 2000);
}

// A sessao voltou a nascer roteada (conexao de gateway passou pela saida): reseta o teto de
// recargas — e o sinal de que a ultima recarga (se houve) funcionou.
let lastRoutedAt = 0;
// A saida ativa entregou trafego de gateway recentemente (isto e o probe mais fiel possivel:
// o proprio gateway esta vivo por ela). O batimento usa isto para NAO abrir uma conexao de
// probe na ativa a cada 30s — saida gratuita limita conexoes simultaneas, e o probe extra
// concorre com a conexao do gateway e pode derruba-la. A morte real da ativa aparece no
// trafego vivo (openThroughPool), nao precisa do probe para ser percebida.
let ativaEntregouEm = 0;
// Quantas vezes o gateway nasceu roteado nesta execucao. A primeira e so a abertura normal;
// da segunda em diante e uma RECONEXAO de verdade no meio da sessao (confirmado ao vivo em
// 2026-08-23, com CDP: mesmo uma troca limpa, sem vazar direto, sem trocar de saida visivel,
// trava o video do Go Live so-audio — o motor de voz/video do Discord e WASM fechado, entao
// nao da pra restartar so o stream por fora sem mexer no binario. O que da pra fazer com
// seguranca e avisar: a pessoa decide se vale reiniciar (Ctrl+R sai da call) ou nao.
let gatewayConnCount = 0;

// Quando vimos um websocket de voz/video pela ultima vez. O aviso de reconexao so faz sentido
// com chamada ou transmissao em andamento: fora disso a reconexao do gateway nao quebra nada
// visivel, e avisar so assustaria -- ainda por cima sugerindo um Ctrl+R que derruba a call.
let ultimaMidiaEm = 0;
const MIDIA_RECENTE_MS = 5 * 60_000;

// Um Ctrl+R (ou a nossa propria recarga) comeca uma sessao NOVA: o gateway que nascer depois
// dela e o primeiro dela, nao uma reconexao no meio de nada. Sem zerar aqui, o aviso voltava
// justamente para quem seguiu o conselho dele -- recarregou por causa do aviso e levou o mesmo
// aviso de novo, agora sem motivo.
function watchReloads() {
    const electron = require("electron");
    electron.app.on("browser-window-created", (_evento, win) => {
        win.webContents.on("did-start-loading", () => {
            // A URL ainda e a de antes quando a recarga comeca: se era a do cliente, isto e um
            // reload de verdade, e nao a splash abrindo.
            let url = "";
            try {
                url = win.webContents.getURL();
            } catch {
                return; // janela morrendo
            }
            if (!CLIENT_URL_RE.test(url)) return;
            if (gatewayConnCount === 0) return;

            log("a janela do Discord recarregou: contagem de reconexao zerada");
            gatewayConnCount = 0;
        });
    });
}

// Telemetria de sessao para o log: contagens acumuladas (a rotacao do arquivo
// apaga historia — uma linha resumida a cada janela preserva o quadro geral).
let sessaoRoteadas = 0;
let sessaoDiretas = 0;
let sessaoReloads = 0;
let ultimoVistoAt = 0;      // quando o gateway foi visto pela ultima vez (gw.visto)
let ultimoRoteadoAt = 0;    // quando o gateway roteou pela ultima vez (gw.roteado)
let sessaoInicio = Date.now();
let estatTimer = null;

function emitirEstat() {
    estatTimer = null;
    log("estat.sessao | uptime=" + Math.round((Date.now() - sessaoInicio) / 1000) + "s" +
        " roteadas=" + sessaoRoteadas + " diretas=" + sessaoDiretas +
        " reloads=" + sessaoReloads +
        " reconexoes_janela=" + (typeof gatewayReconexoes !== "undefined" ? gatewayReconexoes.length : "?") +
        " saida_atual=" + (chosenExit === null ? "nenhuma" : safeProxy(chosenExit)));
}
function agendarEstat() {
    if (estatTimer === null) {
        estatTimer = setTimeout(emitirEstat, 180_000);
    }
}

function markGatewayRouted() {
    lastRoutedAt = Date.now();
    ativaEntregouEm = Date.now();
    sessaoRoteadas++;
    if (reloadCount > 0) {
        // A recarga que foi disparada (maybeReloadAfterDirect) acabou de renascer:
        // mede o tempo entre o disparo (lastReloadAt) e este roteado.
        const levou = lastReloadAt === 0 ? "?" : (Date.now() - lastReloadAt) + "ms";
        log("recarga.renasceu | levou=" + levou +
            " saida=" + (chosenExit === null ? "nenhuma" : safeProxy(chosenExit)));
        sessaoReloads++;
    }
    reloadCount = 0;

    gatewayConnCount++;
    const vistoHa = ultimoVistoAt === 0 ? -1 : Date.now() - ultimoVistoAt;
    log("gw.roteado | n_sessao=" + gatewayConnCount +
        " visto_ha=" + (vistoHa < 0 ? "?" : vistoHa + "ms") +
        " saida=" + (chosenExit === null ? "nenhuma" : safeProxy(chosenExit)));
    if (gatewayConnCount > 1) {
        const comMidia = Date.now() - ultimaMidiaEm < MIDIA_RECENTE_MS;
        log("gateway reconectou no meio da sessao (recorrencia " + (gatewayConnCount - 1) + ")"
            + (comMidia ? ": avisando na tela" : ", sem chamada em andamento: nao avisa"));
        if (comMidia) showReconnectWarning(gatewayConnCount - 1);
    }
    agendarEstat();
}

// Aviso visual DENTRO do Discord (nao um dialogo do sistema): um elemento nosso, flutuante,
// injetado via CDP. Nao mexe em nada do Discord, so soma um div — furtivo o bastante para nao
// atrapalhar a transmissao, visivel o bastante para a pessoa perceber e decidir.
const WARN_BANNER_TEXT = "GoLiveBypass: o gateway reconectou no meio da sessao. Se o video da " +
    "sua transmissao travou (ficou so o audio), de Ctrl+R no Discord para corrigir " +
    "-- isso sai da chamada de voz.";

function showReconnectWarning(recorrencias) {
    const win = clientWindow();
    if (win === null) return;

    // Um elemento so, sempre reaproveitado: se a pessoa nao fechar, a proxima reconexao
    // atualiza o texto (com a contagem) em vez de empilhar um banner por cima do outro.
    const script = "(function(){\n" +
        "  var el = document.getElementById('golivebypass-warn');\n" +
        "  if (!el) {\n" +
        "    el = document.createElement('div');\n" +
        "    el.id = 'golivebypass-warn';\n" +
        "    el.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:2147483647;" +
        "display:flex;align-items:flex-start;gap:10px;width:320px;" +
        "background:#2b2d31;color:#f2f3f5;padding:14px 16px;border-radius:10px;" +
        "border-left:4px solid #f0b232;" +
        "font:13px/1.45 \"gg sans\",-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;" +
        "box-shadow:0 8px 24px rgba(0,0,0,.45);" +
        "opacity:0;transform:translateY(8px);transition:opacity .2s ease,transform .2s ease;'; \n" +
        "    var icon = document.createElement('div');\n" +
        "    icon.textContent = '\\u26A0\\uFE0F';\n" +
        "    icon.style.cssText = 'font-size:18px;line-height:1;flex-shrink:0;margin-top:1px;';\n" +
        "    var body = document.createElement('div');\n" +
        "    body.style.cssText = 'flex:1;min-width:0;';\n" +
        "    var title = document.createElement('div');\n" +
        "    title.textContent = 'GoLiveBypass';\n" +
        "    title.style.cssText = 'font-weight:600;margin-bottom:3px;color:#fff;';\n" +
        "    var text = document.createElement('div');\n" +
        "    text.id = 'golivebypass-warn-text';\n" +
        "    text.style.cssText = 'color:#d8dadf;';\n" +
        "    body.appendChild(title);\n" +
        "    body.appendChild(text);\n" +
        "    var closeBtn = document.createElement('div');\n" +
        "    closeBtn.textContent = '\\u2715';\n" +
        "    closeBtn.style.cssText = 'cursor:pointer;color:#949ba4;font-size:14px;flex-shrink:0;padding:2px;';\n" +
        "    closeBtn.onmouseenter = function(){ closeBtn.style.color = '#f2f3f5'; };\n" +
        "    closeBtn.onmouseleave = function(){ closeBtn.style.color = '#949ba4'; };\n" +
        "    closeBtn.onclick = function(){ el.remove(); };\n" +
        "    el.appendChild(icon);\n" +
        "    el.appendChild(body);\n" +
        "    el.appendChild(closeBtn);\n" +
        "    document.body.appendChild(el);\n" +
        "    requestAnimationFrame(function(){ el.style.opacity = '1'; el.style.transform = 'translateY(0)'; });\n" +
        "  }\n" +
        "  document.getElementById('golivebypass-warn-text').textContent = " + JSON.stringify(WARN_BANNER_TEXT) + " + " +
        "(" + recorrencias + " > 1 ? ' (aconteceu ' + " + recorrencias + " + ' vezes nesta sessao)' : '');\n" +
        "})();";

    win.webContents.executeJavaScript(script).catch(error => log("falhei ao mostrar aviso: " + error.message));
}

// Exposto para a bateria de testes (tests/test-exit-refresh.sh) marcar o sinal sem depender
// de uma conexao de gateway real no sandbox. Inofensivo em producao: so seta o mesmo
// timestamp que o serveSocks setaria ao abrir direto.
function _testMarkGatewayDirect() {
    gatewayWentDirectAt = Date.now();
}

// Uma conexao de gateway que chega antes de existir saida espera aqui, e nao para sempre:
// estourado o prazo ela sai direta. Discord aberto sem bypass e ruim; Discord que nao abre e
// muito pior, e foi o pior defeito que este projeto ja teve.
function currentExit() {
    if (exitSettled) return Promise.resolve(chosenExit);

    return new Promise(resolve => {
        // No modo "tor" o prazo e maior: o bootstrap do Tor leva ~20s, bem mais que o orcamento
        // pensado para uma saida gratuita, e estourar o prazo aqui nao devolve conexao direta
        // (o serveSocks recusa neste modo) -- devolve so uma reconexao a toa do gateway.
        const prazo = routeMode === "tor" ? TOR_HOLD_BUDGET_MS : HOLD_BUDGET_MS;

        const timer = setTimeout(() => {
            const index = waitingForExit.indexOf(deliver);
            if (index >= 0) waitingForExit.splice(index, 1);
            log(routeMode === "tor"
                ? "a saida nao ficou pronta a tempo; no modo tor a conexao sera recusada, nao direta"
                : "a saida nao ficou pronta a tempo, esta conexao vai sair direta");
            resolve(null);
        }, prazo);

        const deliver = proxy => {
            clearTimeout(timer);
            resolve(proxy);
        };

        waitingForExit.push(deliver);
    });
}

// Todas as saidas conhecidas morreram no meio da sessao (acontece o tempo todo com saida
// gratuita). Em vez de cair para direto — que e o IP bloqueado, e o "carregando para sempre" —
// procura uma saida nova agora. Cooldown e dedupe: uma busca por vez, e nunca antes de 30s
// depois da ultima, senao uma saida ruim derrubaria a API de saidas num loop.
function refreshExit() {
    if (refreshingExit !== null) return refreshingExit;
    if (Date.now() - lastRefreshAt < REFRESH_COOLDOWN_MS) return Promise.resolve(null);

    lastRefreshAt = Date.now();
    refreshingExit = (async () => {
        log("nenhuma saida do pool entregou, procurando uma saida nova");
        // Modo "tor": a reposicao tambem SO considera o Tor — cair para gratuita aqui
        // trocaria a garantia escolhida pelo usuario por um IP qualquer. Sem Tor no ar,
        // devolve null e o gateway fica segurado ate o Tor voltar.
        const fresh = routeMode === "tor" ? await detectTor() : await pickFreeExit();
        if (fresh !== null) {
            settleExit(fresh);
            log("saida nova encontrada: " + safeProxy(fresh));
        } else {
            log("nenhuma saida nova disponivel agora");
        }
        return fresh;
    })();

    return refreshingExit.finally(() => { refreshingExit = null; });
}

// ------------------------------------------------------------------ manter reserva viva

// Saida gratuita nao avisa que morreu: ela para de encaminhar, e quem descobre e a conexao que
// estava passando por ela. No meio de uma transmissao isso custa a sessao inteira -- o gateway
// reconecta, e se reconectar direto o servidor reavalia a conta e o video cai. O refreshExit
// conserta isso depois que a conexao ja falhou; o batimento existe para que ela nao falhe: de
// trinta em trinta segundos a ativa e as reservas sao reconferidas, e a troca acontece antes de
// o Discord precisar.
// Quanto esperar entre tentativas de voltar pra saida manual depois que a sessao caiu dela
// (para free/pool). Uma queda na VM pode ser passageira -- medido ao vivo em 2026-08-26: uma
// saida manual ficou fora por 48min e voltou sozinha -- e sem isto o app nunca mais tentava a
// saida de confianca da pessoa, nem com ela ja saudavel de novo: so reabrir o Discord resolvia.
const MANUAL_RETRY_COOLDOWN_MS = 90_000;
let lastManualRetryAt = 0;

// So mexe fora de chamada/transmissao em andamento (ultimaMidiaEm): reconectar o gateway no
// meio de uma Live e o proprio problema que a saida manual foi blindada contra em
// trySwapByRtt. Recuperar e melhor que ficar preso em gratuita, mas nao a troco de derrubar
// uma Live que por acaso esteja de pe na saida de fallback.
//
// Modo "tor" tem politica propria (so Tor conta) -- trocar a saida ativa Tor por uma proxy
// nao-Tor configurada em settings.proxy violaria a escolha da pessoa, igual ao que
// trySwapByRtt e stockReserves ja fazem.
async function tryReturnToManual() {
    if (routeMode === "tor") return;
    if (!usingManualProxy || isManualAddress(chosenExit)) return;
    if (Date.now() - ultimaMidiaEm < MIDIA_RECENTE_MS) return;
    if (Date.now() - lastManualRetryAt < MANUAL_RETRY_COOLDOWN_MS) return;
    lastManualRetryAt = Date.now();

    const manual = manualProxy();
    if (manual === null || manual === "") return;

    const ok = await probe(manual, HEARTBEAT_TIMEOUT_MS);
    if (ok === null) return;

    // Troca silenciosa: NAO chama trocarPara() para nao disparar o banner amarelo de
    // "reconexao no meio da sessao" na proxima reconexao. A guarda de midia recente
    // (MIDIA_RECENTE_MS) acima ja garante que NAO estamos em Live agora, mas a proxima
    // reconexao pode acontecer minutos depois, com o timestamp de midia ja ultrapassando
    // o MIDIA_RECENTE_MS (cenario: Live terminou ha 4-5 min, troca acontece em 5min01,
    // gateway reconecta em 5min02, banner dispara sem motivo). Zera o contador para que
    // a proxima reconexao seja contada como a primeira desta "sub-sessao" (sem recorrencia
    // para o banner). Mantem o cooldown de SWAP_COOLDOWN_MS manualmente para nao abrir
    // porta para trySwapByRtt em seguida.
    ultimaTrocaProativaEm = Date.now();
    gatewayReconexoes.length = 0;
    missedBeats.delete(manual);
    rttLentoSeguidas.delete(manual);
    const antiga = chosenExit;
    const vida = antiga === null || lastExitAt === 0 ? "?" : Math.round((Date.now() - lastExitAt) / 1000) + "s";
    log("saida.trocada | de=" + (antiga === null ? "nenhuma" : safeProxy(antiga)) +
        " para=" + safeProxy(manual) +
        " motivo=saida manual voltou a responder" +
        " vida_da_antiga=" + vida);
    chosenExit = manual;
    lastExitAt = Date.now();
    gatewayConnCount = 0;
}

async function beat() {
    // Um batimento lento nunca pode se sobrepor ao proximo: seriam duas rodadas de conexoes na
    // mesma saida ao mesmo tempo, que e justamente o que derruba as fracas.
    if (beating) return;
    beating = true;

    try {
        // Modo "tor" sem saida ativa (arranque sem Tor, ou Tor morreu antes de qualquer
        // escolha): re-tenta o Tor AQUI. Sem isto ninguem mais chamaria detectTor — os
        // caminhos do batimento so rodam com uma saida ativa — e a sessao ficaria presa
        // para sempre recusando conexoes mesmo depois de o Tor voltar.
        if (routeMode === "tor" && chosenExit === null) {
            const tor = await detectTor();
            if (tor !== null) {
                settleExit(tor);
                log("modo tor: Tor respondeu de novo em " + TOR_ADDR + ", religando a rota");
            }
            return;
        }
        await checkPool();
        await tryReturnToManual();
    } catch (error) {
        // Batimento e rede de seguranca. Se ele falhar, o caminho antigo continua valendo:
        // falhar no trafego vivo, cair para a reserva e, no fim, o refreshExit.
        log("o batimento falhou: " + error.message);
    } finally {
        beating = false;
    }
}

async function checkPool() {
    const active = chosenExit;

    // A ativa entra na rodada mesmo estando fora do pote: proxy do settings.json e Tor local
    // nunca sao guardados, e sao exatamente os que a pessoa mais sente quando caem.
    const targets = [];
    // Camada 3: se a ativa entregou trafego de gateway dentro da janela do batimento, ela
    // esta viva por definicao — pular o probe dela poupa uma conexao na saida gratuita, que
    // limita conexoes simultaneas. A morte real cai no openThroughPool e vira troca ali.
    if (active !== null && Date.now() - ativaEntregouEm > HEARTBEAT_MS) targets.push(active);
    for (const entry of pool) if (!targets.includes(entry.proxy)) targets.push(entry.proxy);
    if (targets.length === 0) return;

    const beats = await Promise.all(targets.map(async proxy => ({
        proxy: proxy,
        ok: await probe(proxy, HEARTBEAT_TIMEOUT_MS) !== null
    })));

    const dead = [];
    for (const entry of beats) {
        if (entry.ok) {
            missedBeats.delete(entry.proxy);
            continue;
        }

        const count = (missedBeats.get(entry.proxy) || 0) + 1;
        missedBeats.set(entry.proxy, count);
        if (count >= MAX_MISSED_BEATS) dead.push(entry.proxy);
    }

    if (dead.length > 0) {
        const survivors = pool.filter(entry => !dead.includes(entry.proxy));
        if (survivors.length !== pool.length) {
            log("fora do pote: " + dead.map(safeProxy).join(", ") + " (sem resposta em " + MAX_MISSED_BEATS + " batimentos)");
            pool = survivors;
            savePool();
        }

        for (const proxy of dead) missedBeats.delete(proxy);
    }

    const live = beats.filter(entry => entry.ok).map(entry => entry.proxy);

    // A ativa que foi pulada (entregou trafego na janela) e considerada viva: ela nao passou
    // por probe, mas tem prova viva de que funciona.
    if (active !== null && !targets.includes(active) && !live.includes(active)) live.push(active);

    // A ativa e trocada no primeiro erro, nao no segundo: trocar nao custa nada -- socket que ja
    // esta de pe continua no tunel antigo, so conexao nova nasce pela reserva -- e a proxima
    // conexao do gateway pode ser a reconexao que decide a transmissao.
    if (active !== null && !live.includes(active)) {
        const reserve = live.find(proxy => proxy !== active);
        if (reserve === undefined) {
            // Nada vivo. Comeca a busca agora, em vez de esperar a proxima conexao descobrir:
            // o refreshExit ja tem dedupe e cooldown, entao chamar daqui nao duplica trabalho.
            log(safeProxy(active) + " perdeu o batimento e nao ha reserva viva");
            refreshExit().catch(error => log("a busca por saida nova falhou: " + error.message));
            return;
        }

        // Emergencia (a ativa morreu): troca direto, sem cooldown.
        // No modo "tor" nao existe reserva que valha a pena: o Tor e a escolha explicita e
        // trocar para gratuita violaria o pedido. Segura — o refresh continua tentando o Tor.
        if (routeMode === "tor") {
            log("modo tor: o Tor caiu, segurando o gateway (sem saida direta)");
            refreshExit().catch(error => log("a busca pelo Tor falhou: " + error.message));
            return;
        }
        trocarPara(reserve, "perdeu o batimento");
    } else if (active !== null) {
        // A ativa esta viva no probe. Mesmo viva, pode estar lenta demais para o gateway
        // (RTT EMA alto): trocar antes de o websocket sofrer.
        const trocar = trySwapByRtt(active, live);
        if (trocar !== null) chosenExit = trocar;
    }

    // Sempre ordena o pool pelo RTT (EMA) ao salvar: a melhor reserva para assumir na hora
    // e a mais rapida, nao a que chegou primeiro.
    pool = [...pool].sort((a, b) => (a.proxy === chosenExit ? -1 : b.proxy === chosenExit ? 1 : (rttEma.get(a.proxy) ?? a.ms) - (rttEma.get(b.proxy) ?? b.ms)));
    savePool();

    stockReserves(live.filter(proxy => proxy !== chosenExit).length);
}

// A saida ativa passa no probe mas esta entregando mal (RTT EMA acima do teto por
// RTT_TROCA_BATIDAS batimentos seguidos). Troca para a reserva viva mais rapida antes de o
// gateway sofrer. Devolve a nova saida, ou null se nao houver troca.
function trySwapByRtt(active, live) {
    // No modo "tor" a saida e uma escolha explicita da pessoa: o RTT alto do Tor e normal
    // (1-1.4s medido) e trocar para gratuita violaria a escolha. Soh troca se o Tor morrer.
    if (routeMode === "tor") return null;

    // Saida manual/privada: as "reservas" no range multiplexado sao portas do MESMO servidor,
    // com RTT praticamente identico -- entao SWAP_RESERVA_RAZAO quase sempre deixa passar, e
    // qualquer chacoalhada de rede vira troca. Toda troca reconecta o gateway, e o motor de
    // voz/video do Discord (WASM) nao sobrevive a isso com a Live no ar: o video cai pra
    // sempre (so audio) mesmo trocando para uma saida boa. Nao vale o risco por causa de RTT.
    if (usingManualProxy) return null;

    const ema = rttEma.get(active);
    if (ema === undefined || ema < RTT_TROCA_MS) {
        rttLentoSeguidas.delete(active);
        return null;
    }

    const ruins = (rttLentoSeguidas.get(active) || 0) + 1;
    rttLentoSeguidas.set(active, ruins);
    if (ruins < RTT_TROCA_BATIDAS) {
        log(safeProxy(active) + " com RTT alto (" + Math.round(ema) + "ms), " + ruins + "/" + RTT_TROCA_BATIDAS + " batimentos");
        return null;
    }

    // Cooldown: quando o pool inteiro esta lento, esperar o cooldown antes de trocar de
    // novo evita o ping-pong entre ruins (cada troca renasce o gateway a toa).
    if (!trocaProativaPode()) {
        rttLentoSeguidas.delete(active);
        return null;
    }

    // Pelo menos 1 batimento de folga antes de trocar de novo pela mesma causa: evita
    // cascata quando a reserva tambem esta lenta.
    const alvo = live
        .filter(proxy => proxy !== active)
        .sort((a, b) => (rttEma.get(a) ?? Infinity) - (rttEma.get(b) ?? Infinity))[0];
    if (alvo === undefined) {
        log(safeProxy(active) + " lento mas sem reserva viva para trocar");
        rttLentoSeguidas.delete(active);
        return null;
    }

    // So vale trocar para uma reserva que nao seja visivelmente pior: a atual ja esta ruim,
    // mas piorar (ou trocar pelo mesmo nivel) so renasce o gateway a toa.
    const emaAlvo = rttEma.get(alvo) ?? Infinity;
    if (emaAlvo > ema * SWAP_RESERVA_RAZAO) {
        log(safeProxy(active) + " lento (" + Math.round(ema) + "ms EMA) e reserva pior (" + Math.round(emaAlvo) + "ms), mantendo e buscando reserva melhor");
        rttLentoSeguidas.delete(active);
        return null;
    }

    trocarPara(alvo, "ativa lenta " + Math.round(ema) + "ms EMA");
    rttLentoSeguidas.delete(active);
    return alvo;
}

// Repor reserva nao pode passar pelo refreshExit: aquele caminho troca a saida ativa, e trocar
// de IP com a ativa saudavel pediria uma reavaliacao do servidor a toa. Aqui o pote enche por
// baixo e quem esta entregando continua entregando.
function stockReserves(liveReserves) {
    // No modo "tor" nao existe reserva legitima: encher o pote com gratuitas violava a
    // escolha da pessoa e um dia essas gratuitas venciam o fallback do openThroughPool,
    // trocando a sessao pra fora do Tor sem ninguem pedir (visto ao vivo em 2026-08-23).
    if (routeMode === "tor") return;

    // Saida manual/privada (com ou sem range): nao ha ganho em manter reserva quente. O pote
    // so serve para a troca proativa por RTT (desligada para manual, ver trySwapByRtt) e para
    // o fallback de trafego morto no openThroughPool -- que ja tem seu proprio caminho via
    // refreshExit/huntExits quando a ativa falha de verdade. Manter isto vazio evita testar o
    // range inteiro (ate 51 portas em paralelo) a cada poucos minutos so para guardar reserva
    // que nunca vai ser usada.
    if (usingManualProxy) return;
    if (liveReserves >= MIN_LIVE_RESERVES || stocking !== null) return;

    // Relogio proprio, separado do refreshExit de proposito. Compartilhar os dois fazia a
    // reposicao de rotina adiar a busca de emergencia: o pote esvazia justamente quando as
    // saidas estao morrendo, que e quando a ativa tambem morre, entao a conexao de gateway que
    // pedisse socorro nessa janela sairia direta. Era a falha que este batimento existe para
    // impedir.
    if (Date.now() - lastStockAt < STOCK_COOLDOWN_MS) return;

    lastStockAt = Date.now();
    log("o pote esta com " + liveReserves + " reserva(s) viva(s), procurando mais em segundo plano");

    stocking = huntExits().then(aprovadas => {
        const known = pool.map(entry => entry.proxy);
        const fresh = aprovadas.filter(entry => !known.includes(entry.proxy));
        if (fresh.length === 0) return;

        // A ativa fica no pote mesmo sendo mais lenta que as novas: ela e o IP que o servidor ja
        // aceitou nesta sessao, e trocar por velocidade custaria uma reavaliacao.
        pool = [...pool, ...fresh]
            .sort((a, b) => (a.proxy === chosenExit ? -1 : b.proxy === chosenExit ? 1 : a.ms - b.ms))
            .slice(0, POOL_SIZE);

        savePool();
        log(fresh.length + " reserva(s) nova(s) no pote");
    }).catch(error => log("a busca de reserva falhou: " + error.message))
        .finally(() => { stocking = null; lastStockAt = Date.now(); });
}

// ------------------------------------------------------------------ o roteador local

function refuse(client) {
    if (!client.destroyed) client.end(Buffer.from([5, 2, 0, 1, 0, 0, 0, 0, 0, 0]));
}

function readTarget(client, done) {
    readReply(client, buffer => {
        if (buffer.length < 5) return -1;
        if (buffer[3] === 1) return 10;
        if (buffer[3] === 4) return 22;
        if (buffer[3] === 3) return 7 + buffer[4];
        return -1;
    }, message => {
        if (message === null || message[1] !== 1) return done(null);

        if (message[3] === 3) {
            const length = message[4];
            return done({ host: message.subarray(5, 5 + length).toString("utf8"), port: message.readUInt16BE(5 + length) });
        }
        if (message[3] === 1) return done({ host: Array.from(message.subarray(4, 8)).join("."), port: message.readUInt16BE(8) });

        return done(null);
    });
}

function openDirect(target) {
    return new Promise(resolve => {
        let settled = false;
        const finish = value => {
            if (settled) return;
            settled = true;
            if (value === null) direct.destroy();
            else direct.setTimeout(0);
            resolve(value);
        };

        const direct = connect({ host: target.host, port: target.port });
        direct.setTimeout(PROBE_TIMEOUT_MS, () => finish(null));
        direct.on("error", () => finish(null));
        direct.once("connect", () => finish(direct));
    });
}

// Abre o mesmo destino por varias saidas ao mesmo tempo e fica com a primeira que responder.
// Quem chega depois e fechado na hora: tunel aberto e esquecido segura uma conexao do outro
// lado, e saida gratuita costuma ter poucas.
function firstTunnel(candidates, target, timeoutMs) {
    return new Promise(resolve => {
        let pending = candidates.length;
        if (pending === 0) return resolve(null);

        let settled = false;

        for (const candidate of candidates) {
            openTunnel(candidate, target.host, target.port, timeoutMs).then(socket => {
                if (socket !== null && !settled) {
                    settled = true;
                    return resolve({ proxy: candidate, socket: socket });
                }

                if (socket !== null) socket.destroy();
                if (--pending === 0 && !settled) resolve(null);
            });
        }
    });
}

// Tenta a saida ativa e, se ela nao entregar, as reservas ja testadas. Trocar aqui custa uma
// conexao; esperar a proxima abertura do Discord custa a sessao inteira sem bypass.
async function openThroughPool(target) {
    const active = await currentExit();
    if (active === null) return null;

    // A ativa sozinha primeiro: ela e o IP que o servidor ja viu nesta sessao, e trocar sem
    // precisar seria pedir uma reavaliacao a toa.
    const tAtiva = Date.now();
    const direto = await openTunnel(active, target.host, target.port, RELAY_TIMEOUT_MS);
    if (direto !== null) {
        markGatewayRouted();
        log("tunel.aberto | alvo=" + target.host + " saida=" + safeProxy(active) + " via=ativa latencia=" + (Date.now() - tAtiva) + "ms");
        return direto;
    }

    log(safeProxy(active) + " nao entregou " + target.host);

    // As reservas correm todas juntas em vez de uma por vez: enfileiradas, o prazo de cada uma
    // somava com o gateway ja reconectando, e o Chromium desiste do roteador antes disso.
    const won = await firstTunnel(pool.map(entry => entry.proxy).filter(proxy => proxy !== active), target, RELAY_TIMEOUT_MS);
    if (won !== null) {
        log("a saida " + safeProxy(active) + " parou de entregar, troquei para " + safeProxy(won.proxy));
        chosenExit = won.proxy;
        lastExitAt = Date.now();
        missedBeats.delete(active);
        pool = pool.filter(entry => entry.proxy !== active);
        savePool();
        markGatewayRouted();
        log("tunel.aberto | alvo=" + target.host + " saida=" + safeProxy(won.proxy) + " via=reserva latencia=" + (Date.now() - tAtiva) + "ms");
        return won.socket;
    }

    // Pool inteiro morto: antes de render a conexao ao IP brasileiro (o "carregando para
    // sempre"), tenta o cache do state.json (revalidacao rapida, ~1-2s) e so entao a lista
    // nova (lenta, ~4s+). No caso do ciclo 7 o pool tinha 1 saida que morreu; o cache teria
    // saidas guardadas de aberturas anteriores para assumir na hora.
    const cached = await cachedExit();
    if (cached !== null) {
        const socket = await openTunnel(cached, target.host, target.port, PROBE_TIMEOUT_MS);
        if (socket !== null) {
            chosenExit = cached;
            lastExitAt = Date.now();
            markGatewayRouted();
            log("tunel.aberto | alvo=" + target.host + " saida=" + safeProxy(cached) + " via=cache latencia=" + (Date.now() - tAtiva) + "ms");
            return socket;
        }
        log(safeProxy(cached) + " do cache nao entregou " + target.host);
    }

    const fresh = await refreshExit();
    if (fresh !== null) {
        const socket = await openTunnel(fresh, target.host, target.port, PROBE_TIMEOUT_MS);
        if (socket !== null) {
            chosenExit = fresh;
            lastExitAt = Date.now();
            markGatewayRouted();
            log("tunel.aberto | alvo=" + target.host + " saida=" + safeProxy(fresh) + " via=nova latencia=" + (Date.now() - tAtiva) + "ms");
            return socket;
        }
        log(safeProxy(fresh) + " nao entregou " + target.host + " logo depois de escolhida");
    }

    return null;
}

// O PAC roteia por sufixo de dominio de proposito: o Discord conecta o gateway em
// subdominios regionais (gateway-us-east1-b.discord.gg — o "-us-east1-b" vem ANTES de
// discord.gg), e o match exato deixava essas conexoes fora do roteador: o gateway nascia
// direto pelo IP brasileiro e o servidor bloqueava a sessao (o "carregando infinitamente").
// Roteamos *.discord.gg inteiro (gateway, remote-auth-gateway e qualquer subdominio futuro);
// os CDNs de midia sao discordapp.com, outro dominio, e nao passam por aqui.
const ROUTE_SUFFIX = ".discord.gg";

function isRoutedHost(host) {
    return host === "discord.gg" || host.endsWith(ROUTE_SUFFIX);
}

function serveSocks(client) {
    client.on("error", () => client.destroy());
    // Entrada malformada deixaria o socket pendurado para sempre, porque a negociacao nunca
    // completa e ninguem fecha. O prazo cobre isso.
    client.setTimeout(PROBE_TIMEOUT_MS, () => client.destroy());

    readReply(client, buffer => (buffer.length < 2 ? -1 : 2 + buffer[1]), greeting => {
        if (greeting === null || greeting[0] !== 5) return client.destroy();

        client.write(Buffer.from([5, 0]));
        readTarget(client, async target => {
            if (target === null) return refuse(client);

            // O roteador so aceita os hosts que o PAC manda para ele. Sem esta linha ele seria
            // um SOCKS aberto no loopback: qualquer processo da maquina usaria a sua saida para
            // qualquer destino, com a identidade do Discord no firewall.
            if (!isRoutedHost(target.host)) {
                log("recusando destino fora da lista: " + target.host);
                return refuse(client);
            }

            // Sucesso respondido antes de saber a saida, de proposito: o Chromium para de usar
            // um roteador que responda lento, e segurar a resposta aqui deixava o Discord
            // "carregando" por ate 12s (o prazo da escolha da saida). Se a saida falhar, o
            // socket fecha no meio do handshake e o cliente do gateway reconecta com backoff.
            client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
            client.setTimeout(0);

            let upstream = await openThroughPool(target);

            if (upstream === null) {
                // No modo "tor" a promessa e outra: sem Tor nenhuma sessao presta (o gateway
                // nasceria pelo IP brasileiro e o video nunca viria). Recusar a conexao faz
                // o cliente do gateway re-tentar com backoff; o batimento religa a rota assim
                // que um Tor responder. Nao marca gatewayWentDirectAt: recusa nao e vazo.
                if (routeMode === "tor") {
                    log("modo tor: nenhuma saida entregou " + target.host + ", recusando esta conexao (sem vazo direta)");
                    client.destroy();
                    return;
                }
                // Recusar aqui prendia o Discord em "conectando" para sempre: o PAC nao tem
                // alternativa depois do ponto e virgula, entao uma recusa nao vira conexao
                // direta, vira nada. Sair direto custa o bypass desta conexao; recusar custa o
                // Discord inteiro, e saida gratuita morre no meio da sessao o tempo todo.
                log("nenhuma saida entregou " + target.host + ", esta conexao vai sair direta");
                // Sinal para o watchdog de recarga: o roteador abriu direto para um host de
                // gateway — a sessao nasceu (ou vai nascer) pelo IP brasileiro, e o servidor
                // provavelmente bloqueou. So o roteador sabe disto; e o gatilho confiavel.
                gatewayWentDirectAt = Date.now();
                sessaoDiretas++;
                log("saida.direta | alvo=" + target.host +
                    " saida_atual=" + (chosenExit === null ? "nenhuma" : safeProxy(chosenExit)));
                const tDireto = Date.now();
                upstream = await openDirect(target);
                // A saida pode ter estado de pe e falhado so nesta conexao (congestionamento,
                // giro de IP): com saida viva, a recarga repara a sessao na hora, em vez de
                // esperar o Ctrl+R da pessoa. Sem saida, o settleExit futuro chama isto.
                if (upstream !== null) {
                    log("direto.aberto | alvo=" + target.host + " levou=" + (Date.now() - tDireto) + "ms");
                    maybeReloadAfterDirect();
                } else {
                    log("direto: " + target.host + " falhou (sem rota local?)");
                }
            }

            if (upstream === null) return client.destroy();
            if (client.destroyed) return upstream.destroy();

            const saidaInfo = typeof chosenExit === "string" && chosenExit ? safeProxy(chosenExit) : "direta";
            const tTunel = Date.now();
            upstream.on("error", e => log("[net] tunel.caiu | alvo=" + target.host +
                " saida=" + saidaInfo +
                " errno=" + (e && e.code ? e.code : "desconhecido") +
                " vida=" + Math.round((Date.now() - tTunel) / 1000) + "s"));
            client.on("error", e => log("[net] cliente.falha | alvo=" + target.host + " errno=" + (e && e.code ? e.code : "desconhecido")));
            client.on("close", () => upstream.destroy());
            upstream.on("close", () => client.destroy());
            upstream.pipe(client);
            client.pipe(upstream);
        });
    });
}

function startRouter() {
    return new Promise(resolve => {
        const server = createServer(serveSocks);
        server.on("error", error => {
            log("o roteador local nao subiu: " + error.message);
            resolve(false);
        });
        // Loopback e porta escolhida pelo sistema: nao ha colisao possivel, e nada de fora da
        // maquina alcanca isto.
        server.listen(0, "127.0.0.1", () => {
            socksPort = server.address().port;
            log("roteador local escutando em 127.0.0.1:" + socksPort);
            resolve(true);
        });
    });
}

function pacScript(fallback) {
    // Sem alternativa depois do ponto e virgula de proposito. Com uma, uma falha faria o
    // Chromium marcar o roteador como ruim e mandar tudo pela alternativa sem avisar: PAC
    // servido, roteador de pe, e nenhuma conexao passando. A rede de seguranca fica dentro do
    // roteador, que cai para direto sozinho e registra isso.
    //
    // Casamento por sufixo de dominio (ver isRoutedHost): o gateway real conecta em
    // subdominios regionais (gateway-us-east1-b.discord.gg). endsWith("." + dominio) e nao
    // indexOf: aquele casaria discord.gg.evil.com.
    return "var routed = " + JSON.stringify(ROUTE_SUFFIX) + ";\n"
        + "function FindProxyForURL(url, host) {\n"
        + "    if (host === \"discord.gg\" || host.endsWith(routed)) return \"SOCKS5 127.0.0.1:" + socksPort + "\";\n"
        + "    return " + JSON.stringify(fallback) + ";\n"
        + "}\n";
}

async function installPac() {
    let fallback = "DIRECT";
    try {
        // Quem esta atras de proxy corporativo perderia o Discord se a regra virasse DIRECT na
        // marra, entao a regra do sistema e lida antes e devolvida a todo host nao roteado.
        const resolved = await session.defaultSession.resolveProxy("https://" + DISCORD_HOST);
        if (typeof resolved === "string" && resolved.trim() !== "") fallback = resolved.trim();
    } catch (error) {
        log("nao consegui ler a regra do sistema, usando DIRECT: " + error.message);
    }

    try {
        await session.defaultSession.setProxy({ mode: "pac_script", pacScript: "data:application/x-ns-proxy-autoconfig;base64," + Buffer.from(pacScript(fallback), "utf8").toString("base64") });
    } catch (error) {
        log("o Chromium recusou a regra: " + error.message);
        return false;
    }

    // Conferir em vez de supor: se a regra nao pegou, e melhor saber agora do que descobrir
    // pelo usuario dizendo que nao funciona. O canônico e um subdominio regional de exemplo:
    // o gateway real conecta em subdominios, e um PAC que so roteia o canônico passaria no
    // teste antigo mesmo estando quebrado para o que importa.
    try {
        const checks = [
            "https://" + ROUTED_HOSTS[0],
            "https://gateway-us-east1-b.discord.gg"
        ];
        const results = await Promise.all(checks.map(url => session.defaultSession.resolveProxy(url)));
        const ok = results.every(r => String(r).includes(String(socksPort)));
        if (!ok) {
            log("a regra foi aceita mas nao esta valendo (" + results.join(", ") + "), voltando para o sistema");
            await session.defaultSession.setProxy({ mode: "system" });
            return false;
        }
        log("regra no ar: *" + ROUTE_SUFFIX + " pelo roteador, o resto por " + fallback);

        // Fecha as conexoes existentes: o Discord reaberto rapido REUSA o websocket antigo
        // (fast connect), que nasceu direto antes do PAC e continuaria direto — o bypass
        // ficaria inerte (o teste de estresse pegou isto: "gateway visto" sem "roteado").
        // Sem fechar, a sessao bloqueada de antes continua valendo apos reabrir.
        try {
            await session.defaultSession.closeAllConnections();
            log("conexoes antigas fechadas, o gateway vai renascer pela rota");
        } catch (error) {
            log("nao consegui fechar as conexoes antigas: " + error.message);
        }
    } catch (error) {
        log("nao consegui conferir a regra: " + error.message);
    }

    return true;
}

// ------------------------------------------------------------------ sobreviver a atualizacao

const STUB_PACKAGE = JSON.stringify({ name: "discord", main: "index.js", version: "1.0.0" });

function patchResources(resources, patcherPath) {
    const asar = join(resources, "app.asar");
    const original = join(resources, "_app.asar");
    if (fs.existsSync(original) || !fs.existsSync(asar)) return false;

    try {
        if (fs.lstatSync(asar).isDirectory()) return false;
        fs.renameSync(asar, original);
        fs.mkdirSync(asar);
        fs.writeFileSync(join(asar, "package.json"), STUB_PACKAGE);
        fs.writeFileSync(join(asar, "index.js"), "require(" + JSON.stringify(patcherPath) + ");");
        return true;
    } catch (error) {
        log("nao consegui aplicar em " + resources + ": " + error.message);
        return false;
    }
}

// O Discord se atualiza numa pasta app-VERSAO nova, sem a nossa injecao, e o bypass sumiria em
// silencio na proxima abertura. Como esta versao ainda esta rodando quando a nova aparece, da
// para deixar ela pronta aqui.
function patchNewerSiblings(currentResources) {
    if (process.platform !== "win32") return;

    const currentDir = dirname(currentResources);
    const root = dirname(currentDir);
    const current = basename(currentDir);

    let names;
    try {
        names = fs.readdirSync(root);
    } catch {
        return;
    }

    for (const name of names) {
        if (!name.startsWith("app-") || name === current) continue;
        if (name.localeCompare(current, undefined, { numeric: true }) <= 0) continue;

        const resources = join(root, name, "resources");
        if (!fs.existsSync(resources)) continue;
        if (patchResources(resources, join(HERE, basename(__filename)))) log("versao nova encontrada, ja deixei pronta: " + name);
    }
}

// ------------------------------------------------------------------ entrada

// O Discord oficial carrega o app com require.main.filename apontando para o index.js do stub.
// Os clientes paralelos (Vesktop, Equibop, Legcord) passam o app como argumento e o
// require.main.filename vira "electron" — o argv[1] e o caminho confiavel nos dois casos.
// argv[1] aponta para o diretorio app.asar; require.main.filename para o index.js dentro dele.
const injectorPath = process.argv[1] || require.main.filename;
const stubDir = fs.existsSync(injectorPath) && fs.statSync(injectorPath).isDirectory() ? injectorPath : dirname(injectorPath);
const resourcesDir = join(stubDir, "..");
const asarPath = join(resourcesDir, "_app.asar");

async function start() {
    log("--- abrindo ---");

    if (settings.enabled === false) {
        log("desligado em settings.json, nao vou mexer em nada");
        return;
    }

    // A regra do PAC nao carrega usuario e senha: ela so diz o endereco. Quando a saida pede
    // autenticacao, quem responde e o Chromium, por este evento. Sem isto a saida com senha
    // passaria no nosso teste, que negocia na mao, e falharia no uso de verdade.
    app.on("login", (event, _webContents, _request, authInfo, callback) => {
        // Sem esta checagem responderiamos a qualquer site que pedisse senha, entregando a
        // credencial da saida para quem nao tem nada a ver com ela.
        if (!authInfo.isProxy || chosenExit === null) return;

        const parsed = parseProxy(chosenExit);
        if (parsed === null || parsed.user === "") return;
        if (authInfo.host !== parsed.host || authInfo.port !== parsed.port) return;

        event.preventDefault();
        callback(parsed.user, parsed.pass);
    });

    if (!await startRouter()) return;
    if (!await installPac()) return;

    // Observa os handshakes websocket do cliente: o gateway real conecta em subdominios
    // regionais (gateway-us-east1-b.discord.gg). O registro mostra se o gateway nasceu com
    // ou sem saida na mao — o diagnostico da corrida. A marcacao de "nasceu direto" fica no
    // serveSocks, no momento em que a conexao realmente sai direta; marcar aqui era cedo
    // demais, porque a conexao de gateway espera a saida no currentExit (ate 12s) e passa
    // roteada quando ela chega. O falso positivo ativava o fluxo de recarga em toda abertura
    // e o cancelava em seguida ("recarga desnecessaria"), deixando o mecanismo sem efeito
    // justamente nos casos em que a sessao tinha nascido direta de verdade.
    //
    // Este observador tambem e o medidor de sofrimento da saida: cada handshake NOVO do
    // gateway (reconexao) e contado numa janela. Rajada de reconexoes = a saida nao esta
    // aguentando o trafego vivo, mesmo passando no probe. Acima do limite, troca forcada
    // para a reserva mais rapida — o sinal mais confiavel que temos.
    // Zera a contagem de reconexao quando a janela recarrega: dali em diante e sessao nova.
    try {
        watchReloads();
    } catch (error) {
        log("nao consegui observar as recargas da janela: " + error.message);
    }

    // O callback e obrigatorio (sem ele a request pendura para sempre); nao modificamos nada.
    try {
        session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
            // Os websockets de voz/video moram em *.discord.media e nao passam pela saida (so
            // o gateway passa). Servem aqui como sinal de que existe chamada ou transmissao
            // em andamento -- e so nesse caso uma reconexao de gateway tem o que estragar.
            if (details.resourceType === "webSocket") {
                try {
                    if (new URL(details.url).hostname.endsWith(".discord.media")) {
                        ultimaMidiaEm = Date.now();
                    }
                } catch {
                    // url estranha; ignora
                }
            }

            if (details.resourceType === "webSocket" && isRoutedHost(new URL(details.url).hostname)) {
                // NUNCA logar a URL: a query do handshake autenticado carrega o token
                // do Discord. So o hostname + contagem da janela — o suficiente para
                // diagnosticar reconexoes sem vazar credencial.
                const agora = Date.now();
                const host = new URL(details.url).hostname;
                const saidaInfo = chosenExit === null
                    ? "sem saida ainda"
                    : "saida pronta ha " + Math.round((Date.now() - lastExitAt) / 1000) + "s";
                const ultimoVistoHa = ultimoVistoAt === 0 ? "?" : (agora - ultimoVistoAt) + "ms";
                ultimoVistoAt = agora;
                log("gw.visto | host=" + host +
                    " n_janela=" + gatewayReconexoes.length + "/180s" +
                    " n_sessao=" + (gatewayConnCount + 1) +
                    " ultimo_visto_ha=" + ultimoVistoHa +
                    " | " + saidaInfo);

                // Reconexao em rajada (ignora a primeira conexao da sessao, que nao e sinal).
                if (chosenExit !== null) {
                    gatewayReconexoes.push(agora);
                    while (gatewayReconexoes.length > 0 && gatewayReconexoes[0] < agora - RECONEXAO_JANELA_MS) gatewayReconexoes.shift();

                    // Segunda reconexao na janela: ja e sinal de saida agonizante. Dispara o
                    // refresh em segundo plano — quando a rajada fechar (3+), ha candidato
                    // novo para trocar em vez de so a sauda velha do pool.
                    if (gatewayReconexoes.length === RECONEXAO_LIMITE - 1) {
                        log("gw.rajada_antecipada | n=" + gatewayReconexoes.length + "/180s");
                        refreshExit().catch(error => log("a busca antecipada falhou: " + error.message));
                    }

                    if (gatewayReconexoes.length >= RECONEXAO_LIMITE) {
                        // Intervalos entre as reconexoes da rajada (para o log).
                        const deltas = [];
                        for (let i = 1; i < gatewayReconexoes.length; i++) deltas.push(gatewayReconexoes[i] - gatewayReconexoes[i - 1]);
                        const minD = deltas.length ? Math.min(...deltas) : 0;
                        const medD = deltas.length ? Math.round(deltas.reduce((a, b) => a + b, 0) / deltas.length) : 0;

                        const emaAtual = rttEma.get(chosenExit) ?? Infinity;
                        // Cooldown + reserva que preste: trocar entre saidas ruins em cascata
                        // so renasce o gateway a toa; sem reserva melhor, a atual vai para a
                        // quarentena e a busca em 2o plano escolhe outra.
                        const alvo = pool
                            .map(entry => entry.proxy)
                            .filter(proxy => proxy !== chosenExit)
                            .sort((a, b) => (rttEma.get(a) ?? Infinity) - (rttEma.get(b) ?? Infinity))[0];
                        const emaAlvo = alvo === undefined ? Infinity : (rttEma.get(alvo) ?? Infinity);
                        const podeTrocar = alvo !== undefined && trocaProativaPode() && emaAlvo <= emaAtual * SWAP_RESERVA_RAZAO;
                        log("gw.rajada_limite | n=" + gatewayReconexoes.length + "/180s" +
                            " intervalo_min=" + minD + "ms intervalo_med=" + medD + "ms" +
                            " ema_atual=" + (emaAtual === Infinity ? "?" : Math.round(emaAtual) + "ms") +
                            " ema_alvo=" + (emaAlvo === Infinity ? "?" : Math.round(emaAlvo) + "ms") +
                            " troca=" + (podeTrocar ? "sim" : "nao") +
                            " motivo=" + (alvo === undefined ? "sem_reserva" : !trocaProativaPode() ? "cooldown" : "reserva_pior"));
                        if (podeTrocar) {
                            const antiga = chosenExit;
                            trocarPara(alvo, RECONEXAO_LIMITE + "+ reconexoes do gateway na janela");
                            quarentenar(antiga, "rajada de reconexoes");
                        } else {
                            gatewayReconexoes.length = 0;
                            quarentenar(chosenExit, RECONEXAO_LIMITE + "+ reconexoes sem troca util");
                            log(safeProxy(chosenExit) + " com " + RECONEXAO_LIMITE + "+ reconexoes do gateway sem troca util (cooldown ou reserva pior), em quarentena");
                        }
                    }
                }
            }
            callback({});
        });
    } catch (error) {
        log("nao consegui observar os websockets: " + error.message);
    }

    const exit = await chooseExit();
    if (exit === null && routeMode === "tor") {
        // Modo "tor": sem Tor no arranque NAO libera as conexoes pendentes para o direct.
        // Elas ficam seguradas ate o prazo delas; o batimento continua e quando um Tor
        // responder settleExit(tor) religa a rota. Vazar direto aqui renasceria o gateway
        // pelo IP brasileiro — exatamente o carregamento infinito que o projeto combate.
        log("modo tor: sem Tor no arranque, conexoes ficam seguradas ate um Tor responder");
    } else {
        settleExit(exit);
        log(exit === null ? "nenhuma saida respondeu, o gateway vai sair direto" : "saida escolhida: " + safeProxy(exit));
    }

    // So depois da primeira escolha: batimento correndo junto da busca inicial disputaria banda
    // com ela, e e a busca inicial que segura o gateway.
    setInterval(() => { beat(); }, HEARTBEAT_MS);
    log("batimento ligado: reconfiro as saidas a cada " + Math.round(HEARTBEAT_MS / 1000) + "s");
}

try {
    const discordPkg = require(join(asarPath, "package.json"));
    require.main.filename = join(asarPath, discordPkg.main);
    app.setAppPath(asarPath);
} catch (error) {
    // Sem o Discord original nao ha o que fazer, e travar aqui deixaria o usuario sem app.
    console.error("[GoLiveBypass] nao achei o Discord original em " + asarPath, error);
    throw error;
}

app.whenReady().then(() => {
    // Nada aguarda isto de proposito: o Discord carrega em paralelo, e o gateway que chegar
    // antes da saida espera no roteador em vez de segurar a abertura inteira.
    start().catch(error => log("falhei ao preparar o bypass: " + error.message));

    try {
        patchNewerSiblings(resourcesDir);
    } catch (error) {
        log("falhei ao procurar versao nova: " + error.message);
    }
});

log("carregando o Discord original");
try {
    require(require.main.filename);
} catch (error) {
    // O Legcord (e quem mais empacotar o app como ESM com top-level await) nao carrega por
    // require — o import() dinamico cobre os dois mundos.
    if (error && (error.code === "ERR_REQUIRE_ASYNC_MODULE" || error.code === "ERR_REQUIRE_ESM")) {
        import(require.main.filename).catch((importError) => {
            console.error("[GoLiveBypass] nao consegui carregar o Discord original por import: " + importError.message);
            throw importError;
        });
    } else {
        throw error;
    }
}
