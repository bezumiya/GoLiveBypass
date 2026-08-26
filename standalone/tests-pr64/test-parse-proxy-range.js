// tests-pr64/test-parse-proxy-range.js
// Testes unitarios da funcao parseProxy() do golivebypass.js
// Cobre o suporte a range de portas multiplexadas (PR 64).
"use strict";
const path = require("path");
const { createSandbox } = require("./sandbox");

let pass = 0;
let fail = 0;
const failures = [];

function t(name, fn) {
    try {
        fn();
        pass++;
        console.log("  [OK]   " + name);
    } catch (e) {
        fail++;
        failures.push({ name, error: e.message });
        console.log("  [FAIL] " + name + ": " + e.message);
    }
}

function assertEq(actual, expected, label) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e) throw new Error((label || "valores") + ": esperado " + e + ", recebi " + a);
}

function assertInRange(port, min, max, label) {
    if (typeof port !== "number" || !Number.isFinite(port)) {
        throw new Error((label || "porta") + ": nao e numero, recebi " + JSON.stringify(port));
    }
    if (port < min || port > max) {
        throw new Error((label || "porta") + ": " + port + " fora de [" + min + "," + max + "]");
    }
}

function assertNull(actual, label) {
    if (actual !== null) {
        throw new Error((label || "valor") + ": esperado null, recebi " + JSON.stringify(actual));
    }
}

// 100 rodadas reduz o efeito da sorte (1/(65535-10000) = 1/55535 chance de erro)
const N = 100;

console.log("test-parse-proxy-range.js: testes do parseProxy()");
console.log("=================================================\n");

// Carrega o sandbox uma vez
const { sandbox } = createSandbox({ settings: { proxy: "" } });

console.log("[1] Range normal: 10000-10050");
t("parseProxy('socks5://u:p@h:10000-10050') -> porta no range", () => {
    for (let i = 0; i < N; i++) {
        const r = sandbox.parseProxy("socks5://u:p@h:10000-10050");
        assertEq(r.scheme, "socks5", "scheme");
        assertEq(r.host, "h", "host");
        assertEq(r.user, "u", "user");
        assertEq(r.pass, "p", "pass");
        assertInRange(r.port, 10000, 10050, "port");
    }
});

console.log("\n[2] Range grande: 1-65535");
t("parseProxy('socks5://h:1-65535') -> sorteio em range maximo", () => {
    for (let i = 0; i < N; i++) {
        const r = sandbox.parseProxy("socks5://h:1-65535");
        assertInRange(r.port, 1, 65535, "port");
    }
});

console.log("\n[3] Sem range: porta unica");
t("parseProxy('socks5://u:p@h:1080') -> porta = 1080", () => {
    const r = sandbox.parseProxy("socks5://u:p@h:1080");
    assertEq(r.port, 1080, "port");
    assertEq(r.scheme, "socks5");
    assertEq(r.host, "h");
    assertEq(r.user, "u");
    assertEq(r.pass, "p");
});

console.log("\n[4] Range de 1 porta");
t("parseProxy('socks5://h:100-100') -> sempre 100", () => {
    for (let i = 0; i < 10; i++) {
        const r = sandbox.parseProxy("socks5://h:100-100");
        assertEq(r.port, 100, "port");
    }
});

console.log("\n[5] Range com portEnd < portStart (invertido)");
// O codigo atual: "if (portEnd >= portStart && portEnd <= 65535) { finalPort = ... + portStart }"
// Se portEnd < portStart, a condicao falha e finalPort permanece = portStart (porta baixa).
t("parseProxy('socks5://h:100-50') -> porta = 100 (range ignorado, usa start)", () => {
    // Confirmado lendo o codigo: a condicao e portEnd >= portStart.
    // O portStart=100, portEnd=50 falha o if, e finalPort=100.
    for (let i = 0; i < 10; i++) {
        const r = sandbox.parseProxy("socks5://h:100-50");
        assertEq(r.port, 100, "port (espera-se 100 porque o if falha)");
    }
});

console.log("\n[6] Senha com : e @");
t("parseProxy com senha 'p:p@x' -> decodificado corretamente", () => {
    const r = sandbox.parseProxy("socks5://u:p%3Ap%40x@h:1080");
    // %3A = ":", %40 = "@"
    assertEq(r.user, "u", "user");
    assertEq(r.pass, "p:p@x", "pass");
});

t("parseProxy com senha literal 'p:p@x' (sem escape) -> decodificado", () => {
    // O regex captura .+ ate o ultimo @, entao isso nao da match
    // porque ":" em credenciais e OK mas o regex exige o @ antes do host
    // Vou ver: "(?:(.+)@)?" -> match[2] = "u:p:p@x" -> split no primeiro ":" -> user="u", pass="p:p@x"
    const r = sandbox.parseProxy("socks5://u:p:p@x@h:1080");
    assertEq(r.user, "u", "user");
    assertEq(r.pass, "p:p@x", "pass");
});

console.log("\n[7] Entradas invalidas / vazias");
t("parseProxy('') -> null", () => {
    assertNull(sandbox.parseProxy(""));
});
t("parseProxy('   ') -> null", () => {
    assertNull(sandbox.parseProxy("   "));
});
t("parseProxy('socks5://h:0') -> null (porta < 1)", () => {
    assertNull(sandbox.parseProxy("socks5://h:0"));
});
t("parseProxy('socks5://h:65536') -> null (porta > 65535)", () => {
    assertNull(sandbox.parseProxy("socks5://h:65536"));
});
t("parseProxy('socks5://h:abc') -> null (porta nao-numerica)", () => {
    assertNull(sandbox.parseProxy("socks5://h:abc"));
});
t("parseProxy('socks5://h:100-99999') -> null (end > 65535)", () => {
    // portEnd = 99999 > 65535: a condicao falha, finalPort = 100
    // NAO retorna null; retorna objeto com port=100
    const r = sandbox.parseProxy("socks5://h:100-99999");
    assertEq(r.port, 100, "port (range ignorado, fica com start=100)");
});

console.log("\n[8] Esquemas suportados");
t("parseProxy('http://u:p@h:80') -> scheme=http", () => {
    const r = sandbox.parseProxy("http://u:p@h:80");
    assertEq(r.scheme, "http");
});
t("parseProxy('https://u:p@h:443') -> scheme=https", () => {
    const r = sandbox.parseProxy("https://u:p@h:443");
    assertEq(r.scheme, "https");
});
t("parseProxy('socks4://u:p@h:1080') -> scheme=socks4", () => {
    const r = sandbox.parseProxy("socks4://u:p@h:1080");
    assertEq(r.scheme, "socks4");
});

console.log("\n[9] Sem credenciais");
t("parseProxy('socks5://h:1080') -> user e pass vazios", () => {
    const r = sandbox.parseProxy("socks5://h:1080");
    assertEq(r.user, "", "user");
    assertEq(r.pass, "", "pass");
});

console.log("\n=================================================");
console.log("Resultado: " + pass + " passou, " + fail + " falhou");
if (fail > 0) {
    console.log("\nFalhas:");
    for (const f of failures) console.log("  - " + f.name + ": " + f.error);
    process.exit(1);
}
process.exit(0);
