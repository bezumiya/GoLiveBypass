// tests-pr64/test-try-return-to-manual.js
// Testes da funcao tryReturnToManual() e sua chamada dentro do beat().
// PR 64: a cada batimento, se a saida ativa nao e manual E nao tem midia em
// andamento E o cooldown passou, faz probe da saida manual e troca.
//
// Apos os 3 fixes do rev-estatico (B1: routeMode=tor sai cedo; B2: isManualAddress
// consistente com parseProxy; B3: troca silenciosa sem chamar trocarPara), o teste
// checa o efeito observavel (chosenExit muda) em vez de mockar trocarPara.
"use strict";
const { createSandbox } = require("./sandbox");

let pass = 0;
let fail = 0;
const failures = [];

function t(name, fn) {
    return Promise.resolve().then(fn).then(() => {
        pass++;
        console.log("  [OK]   " + name);
    }).catch(e => {
        fail++;
        failures.push({ name, error: e.message });
        console.log("  [FAIL] " + name + ": " + e.message);
    });
}

function assertEq(actual, expected, label) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e) throw new Error((label || "valores") + ": esperado " + e + ", recebi " + a);
}
function assertTrue(v, label) { if (v !== true) throw new Error((label || "valor") + ": esperado true, recebi " + JSON.stringify(v)); }
function assertFalse(v, label) { if (v !== false) throw new Error((label || "valor") + ": esperado false, recebi " + JSON.stringify(v)); }

const MANUAL = "socks5://u:p@h:10000-10050";
const FREE = "socks5://free:free@some-free-proxy:8080";

// Cria sandbox. Como o tryReturnToManual agora troca chosenExit diretamente
// (sem chamar trocarPara), basta observar chosenExit e os logs do bypass.
function freshSandbox(settings) {
    const { sandbox } = createSandbox(settings);
    sandbox.runInContext("__probeCalls = []; __logLines = [];");
    sandbox.runInContext(`
        probe = async function(proxy, timeoutMs) {
            __probeCalls.push({ proxy, timeoutMs });
            return { proxy, ms: 100 };
        };
        // Captura logs do bypass para inspecionar "saida.trocada" etc
        const __origLog = log;
        log = function(line) {
            __logLines.push(line);
            __origLog(line);
        };
    `);
    return {
        sandbox,
        getProbeCalls: () => sandbox.runInContext("__probeCalls"),
        getLogLines: () => sandbox.runInContext("__logLines"),
        resetCalls: () => sandbox.runInContext("__probeCalls = []; __logLines = [];"),
    };
}

// Seta o estado canonico do "caminho feliz" (cenario A)
function setHappy(sandbox) {
    sandbox.chosenExit = FREE;
    sandbox.ultimaMidiaEm = Date.now() - 10 * 60_000;  // 10 min atras
    sandbox.lastManualRetryAt = 0;
}

function isTrocaLine(line) {
    return typeof line === "string" && line.indexOf("saida.trocada") === 0
        && line.indexOf("motivo=saida manual voltou a responder") > 0;
}

(async () => {
console.log("test-try-return-to-manual.js: testes do tryReturnToManual()");
console.log("============================================================\n");

// Cenario A: caminho feliz
console.log("[A] Saida ativa NAO manual, midia antiga, cooldown ok, probe ok -> TROCA chosenExit");
{
    const h = freshSandbox({ proxy: MANUAL });
    setHappy(h.sandbox);
    const before = h.sandbox.chosenExit;
    await t("Cenario A: tryReturnToManual -> chosenExit muda para porta do range", async () => {
        await h.sandbox.tryReturnToManual();
        assertTrue(h.sandbox.chosenExit !== before, "chosenExit mudou");
        assertTrue(h.sandbox.chosenExit.indexOf("h:") > 0, "chosenExit agora tem host h");
        // chosenExit deve estar no range 10000-10050
        const portStr = h.sandbox.chosenExit.split(":").pop();
        const port = parseInt(portStr, 10);
        assertTrue(port >= 10000 && port <= 10050, "porta " + port + " esta no range 10000-10050");
        // Deve ter logado saida.trocada
        const logs = h.getLogLines();
        const trocaLog = logs.find(isTrocaLine);
        assertTrue(trocaLog !== undefined, "log saida.trocada presente");
    });
}

console.log("\n[B] saida ativa JA e manual -> nao troca");
{
    const h = freshSandbox({ proxy: MANUAL });
    setHappy(h.sandbox);
    // Forcar chosenExit para uma porta do range manual
    h.sandbox.chosenExit = "socks5://u:p@h:10030";
    await t("Cenario B: tryReturnToManual -> nao mexe quando chosenExit ja e manual", async () => {
        await h.sandbox.tryReturnToManual();
        assertEq(h.sandbox.chosenExit, "socks5://u:p@h:10030", "chosenExit intacto");
        assertEq(h.getProbeCalls().length, 0, "probe nao chamado");
    });
}

console.log("\n[C] ultimaMidiaEm recente (<5min) -> nao troca");
{
    const h = freshSandbox({ proxy: MANUAL });
    setHappy(h.sandbox);
    h.sandbox.ultimaMidiaEm = Date.now() - 60_000; // 1 min atras
    await t("Cenario C: tryReturnToManual -> nao mexe durante midia recente", async () => {
        await h.sandbox.tryReturnToManual();
        assertEq(h.sandbox.chosenExit, FREE, "chosenExit intacto");
        assertEq(h.getProbeCalls().length, 0, "probe nao chamado");
    });
    // Limiar
    await t("Cenario C limiar: ultimaMidiaEm = 5min + 1ms -> troca", async () => {
        h.sandbox.ultimaMidiaEm = Date.now() - (5 * 60_000 + 1);
        h.sandbox.lastManualRetryAt = 0;
        h.resetCalls();
        await h.sandbox.tryReturnToManual();
        assertEq(h.getProbeCalls().length, 1, "probe chamado");
    });
}

console.log("\n[D] Cooldown (90s) nao passou na segunda chamada -> nao troca na 2a");
{
    const h = freshSandbox({ proxy: MANUAL });
    setHappy(h.sandbox);
    await t("Cenario D.1: 1a chamada troca, 2a imediata NAO", async () => {
        await h.sandbox.tryReturnToManual();
        const after1 = h.sandbox.chosenExit;
        assertTrue(after1 !== FREE, "1a: chosenExit mudou");
        await h.sandbox.tryReturnToManual();
        // 2a chamada: cooldown nao passou, nao mexe
        assertEq(h.sandbox.chosenExit, after1, "2a: chosenExit intacto");
    });

    await t("Cenario D.2: apos 90s+ o cooldown libera", async () => {
        const realNow = Date.now;
        const baseTime = realNow.call(Date);
        let fakeNow = baseTime;
        Date.now = () => fakeNow;
        try {
            h.sandbox.chosenExit = FREE;
            h.sandbox.ultimaMidiaEm = baseTime - 10 * 60_000;
            h.sandbox.lastManualRetryAt = 0;
            h.resetCalls();

            // 1a chamada
            await h.sandbox.tryReturnToManual();
            const trocaLog1 = h.getLogLines().find(isTrocaLine);
            assertTrue(trocaLog1 !== undefined, "1a: log saida.trocada presente");
            const after1 = h.sandbox.chosenExit;

            // 2a chamada com +89s (ainda em cooldown)
            fakeNow += 89_000;
            h.resetCalls();
            await h.sandbox.tryReturnToManual();
            assertEq(h.getProbeCalls().length, 0, "89s: probe nao chamado (cooldown)");

            // 3a chamada com +91s total (cooldown liberou)
            // NOTA: chosenExit ja e' manual aqui (trocou na 1a), entao isManualAddress
            // retorna true e a funcao sai CEDO sem chamar probe. Isso e' o comportamento
            // correto: o tryReturnToManual NAO troca uma ativa que ja e' manual.
            // Para validar o cooldown, voltamos chosenExit para free antes da 3a:
            h.sandbox.chosenExit = FREE;
            fakeNow += 2_000;
            h.resetCalls();
            await h.sandbox.tryReturnToManual();
            assertEq(h.getProbeCalls().length, 1, "91s: probe chamado (cooldown ok)");
        } finally {
            Date.now = realNow;
        }
    });
}

console.log("\n[E] probe retorna null (manual morta) -> nao troca");
{
    const h = freshSandbox({ proxy: MANUAL });
    setHappy(h.sandbox);
    // Override do probe para retornar null
    h.sandbox.runInContext(`
        probe = async function(proxy, timeoutMs) {
            __probeCalls.push({ proxy, timeoutMs });
            return null;
        };
    `);
    h.resetCalls();
    await t("Cenario E: tryReturnToManual -> probe chamado, chosenExit nao muda", async () => {
        await h.sandbox.tryReturnToManual();
        assertEq(h.getProbeCalls().length, 1, "probe foi chamado");
        assertEq(h.sandbox.chosenExit, FREE, "chosenExit intacto (probe null)");
    });
}

console.log("\n[F] Sem manual configurado (usingManualProxy false) -> noop");
{
    const h = freshSandbox({}); // sem proxy
    setHappy(h.sandbox);
    await t("Cenario F: tryReturnToManual -> sem probe, sem troca", async () => {
        await h.sandbox.tryReturnToManual();
        assertEq(h.getProbeCalls().length, 0, "probe nao chamado");
        assertEq(h.sandbox.chosenExit, FREE, "chosenExit intacto");
    });
}

console.log("\n[H] probe lanca excecao -> beat() captura");
{
    const h = freshSandbox({ proxy: MANUAL });
    setHappy(h.sandbox);
    h.sandbox.runInContext(`
        probe = async function(proxy, timeoutMs) {
            throw new Error("probe explodiu");
        };
    `);
    await t("Cenario H: beat() chama tryReturnToManual dentro de try/catch e nao quebra", async () => {
        await h.sandbox.beat();
        // Se chegou aqui, nao quebrou. O chosenExit pode ter sido mexido por checkPool
        // mas o importante e' que nao houve unhandled rejection.
    });
}

console.log("\n[I] 2 batimentos em paralelo: single-flight");
{
    const h = freshSandbox({ proxy: MANUAL });
    setHappy(h.sandbox);
    h.sandbox.beating = false;
    await t("Cenario I: Promise.all([beat, beat]) -> segundo beat sai cedo (beating=true)", async () => {
        h.resetCalls();
        // Calcula o baseline: 1 beat sozinho
        const solo = await h.sandbox.beat();
        const refProbe = h.getProbeCalls().length;
        h.resetCalls();
        // 2 beats em paralelo
        await Promise.all([h.sandbox.beat(), h.sandbox.beat()]);
        const parallelProbe = h.getProbeCalls().length;
        // O segundo beat() deve ter saido cedo pelo if (beating) return
        // Entao o parallelProbe deve ser <= refProbe (mesmo batimento)
        assertTrue(parallelProbe <= refProbe, "parallel probe (" + parallelProbe + ") <= solo ref (" + refProbe + ")");
    });
}

console.log("\n[J] chosenExit = null -> roda normalmente");
{
    const h = freshSandbox({ proxy: MANUAL });
    h.sandbox.chosenExit = null;
    h.sandbox.ultimaMidiaEm = Date.now() - 10 * 60_000;
    h.sandbox.lastManualRetryAt = 0;
    await t("Cenario J: tryReturnToManual -> probe e troca mesmo com chosenExit=null", async () => {
        await h.sandbox.tryReturnToManual();
        assertEq(h.getProbeCalls().length, 1, "probe chamado");
        assertTrue(h.sandbox.chosenExit !== null, "chosenExit agora tem valor");
        assertTrue(h.sandbox.chosenExit.indexOf("h:") > 0, "chosenExit tem host h");
    });
}

// ==================== FIXES ====================

console.log("\n[FIX B1] routeMode === 'tor' -> tryReturnToManual sai cedo");
{
    const h = freshSandbox({ proxy: MANUAL, routeMode: "tor" });
    setHappy(h.sandbox);
    await t("Cenario B1: routeMode=tor, manual nao-Tor configurada -> nao tenta", async () => {
        await h.sandbox.tryReturnToManual();
        assertEq(h.getProbeCalls().length, 0, "probe nao chamado (routeMode=tor)");
        assertEq(h.sandbox.chosenExit, FREE, "chosenExit intacto");
    });
}

console.log("\n[FIX B2] isManualAddress consistente com parseProxy para range invalido");
{
    const h = freshSandbox({ proxy: "socks5://u:p@h:100-50" }); // range invertido
    setHappy(h.sandbox);
    await t("Cenario B2: range invertido 100-50 -> isManualAddress trata como porta unica", async () => {
        // parseProxy aceita 100-50 e retorna port=100 (degradacao suave)
        // isManualAddress(100) DEVE retornar true com o fix
        // Antes do fix: isManualAddress(100) retornava false (100 <= 50 = false)
        // Apos o fix: isManualAddress(100) retorna true (portEnd < portStart => porta unica)
        const probeStr = "socks5://u:p@h:100";
        const isM = h.sandbox.isManualAddress(probeStr);
        assertTrue(isM, "isManualAddress(host:100) = true com range 100-50 (consistente com parseProxy)");
    });

    // Tambem testar com range onde portEnd > 65535
    const h2 = freshSandbox({ proxy: "socks5://u:p@h:10000-65536" });
    setHappy(h2.sandbox);
    await t("Cenario B2.b: range 10000-65536 -> isManualAddress(host:10000) = true", async () => {
        const isM = h2.sandbox.isManualAddress("socks5://u:p@h:10000");
        assertTrue(isM, "isManualAddress(host:10000) = true com range 10000-65536");
    });

    // Sem range (porta unica) - deve continuar funcionando
    const h3 = freshSandbox({ proxy: "socks5://u:p@h:1080" });
    setHappy(h3.sandbox);
    await t("Cenario B2.c: porta unica 1080 - isManualAddress(host:1080) = true", async () => {
        const isM = h3.sandbox.isManualAddress("socks5://u:p@h:1080");
        assertTrue(isM, "isManualAddress(host:1080) = true com proxy sem range");
        const isM2 = h3.sandbox.isManualAddress("socks5://u:p@h:1081");
        assertFalse(isM2, "isManualAddress(host:1081) = false (fora)");
    });
}

console.log("\n[FIX B3] Troca silenciosa: zera gatewayConnCount, nao dispara banner");
{
    const h = freshSandbox({ proxy: MANUAL });
    setHappy(h.sandbox);
    h.sandbox.gatewayConnCount = 5;  // simular historico de reconexoes
    await t("Cenario B3: tryReturnToManual zera gatewayConnCount (evita banner)", async () => {
        await h.sandbox.tryReturnToManual();
        assertTrue(h.sandbox.chosenExit !== FREE, "chosenExit mudou");
        assertEq(h.sandbox.gatewayConnCount, 0, "gatewayConnCount zerado (proxima reconexao nao dispara banner)");
    });
}

console.log("\n============================================================");
console.log("Resultado: " + pass + " passou, " + fail + " falhou");
if (fail > 0) {
    console.log("\nFalhas:");
    for (const f of failures) {
        console.log("  - " + f.name + ": " + f.error);
    }
}
process.exit(fail > 0 ? 1 : 0);
})();
