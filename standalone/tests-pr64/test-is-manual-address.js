// tests-pr64/test-is-manual-address.js
// Testes unitarios da funcao isManualAddress() do golivebypass.js
// Adicionada no PR 64 para conferir se a saida ativa e uma porta do range
// configurado (porque manualProxy() sorteia uma porta nova a cada chamada).
"use strict";
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
function assertTrue(v, label) { if (v !== true) throw new Error((label || "valor") + ": esperado true, recebi " + JSON.stringify(v)); }
function assertFalse(v, label) { if (v !== false) throw new Error((label || "valor") + ": esperado false, recebi " + JSON.stringify(v)); }

console.log("test-is-manual-address.js: testes do isManualAddress()");
console.log("=======================================================\n");

// Cenario 1: range 10000-10050
console.log("[1] settings.proxy = 'socks5://u:p@h:10000-10050' (range)");
{
    const { sandbox } = createSandbox({ settings: { proxy: "socks5://u:p@h:10000-10050" } });
    t("usingManualProxy = true com range bem-formado", () => {
        assertTrue(sandbox.usingManualProxy);
    });
    t("isManualAddress('socks5://u:p@h:10030') -> true (porta no range)", () => {
        assertTrue(sandbox.isManualAddress("socks5://u:p@h:10030"), "10030");
    });
    t("isManualAddress('socks5://u:p@h:10000') -> true (extremo inferior)", () => {
        assertTrue(sandbox.isManualAddress("socks5://u:p@h:10000"), "10000");
    });
    t("isManualAddress('socks5://u:p@h:10050') -> true (extremo superior)", () => {
        assertTrue(sandbox.isManualAddress("socks5://u:p@h:10050"), "10050");
    });
    t("isManualAddress('socks5://u:p@h:11000') -> false (fora do range)", () => {
        assertFalse(sandbox.isManualAddress("socks5://u:p@h:11000"), "11000");
    });
    t("isManualAddress('socks5://u:p@h:9999') -> false (abaixo)", () => {
        assertFalse(sandbox.isManualAddress("socks5://u:p@h:9999"), "9999");
    });
    t("isManualAddress('socks5://u:p@h:10051') -> false (acima)", () => {
        assertFalse(sandbox.isManualAddress("socks5://u:p@h:10051"), "10051");
    });
    t("isManualAddress('socks5://u:p@other:10030') -> false (host diferente)", () => {
        assertFalse(sandbox.isManualAddress("socks5://u:p@other:10030"), "other:10030");
    });
    t("isManualAddress('socks5://u:p@h:10030') x 50 vezes -> sempre true", () => {
        // parseProxy sorteia porta nova a cada chamada, mas a string passada nao tem range
        for (let i = 0; i < 50; i++) {
            assertTrue(sandbox.isManualAddress("socks5://u:p@h:10030"), "iter " + i);
        }
    });
    t("isManualAddress(null) -> false", () => {
        assertFalse(sandbox.isManualAddress(null), "null");
    });
    t("isManualAddress('lixo') -> false (parseProxy falha)", () => {
        assertFalse(sandbox.isManualAddress("lixo"));
    });
}

// Cenario 2: sem range
console.log("\n[2] settings.proxy = 'socks5://u:p@h:1080' (porta unica)");
{
    const { sandbox } = createSandbox({ settings: { proxy: "socks5://u:p@h:1080" } });
    t("isManualAddress('socks5://u:p@h:1080') -> true", () => {
        assertTrue(sandbox.isManualAddress("socks5://u:p@h:1080"), "1080");
    });
    t("isManualAddress('socks5://u:p@h:1081') -> false", () => {
        assertFalse(sandbox.isManualAddress("socks5://u:p@h:1081"), "1081");
    });
    t("isManualAddress('socks5://u:p@h:1079') -> false", () => {
        assertFalse(sandbox.isManualAddress("socks5://u:p@h:1079"), "1079");
    });
}

// Cenario 3: settings.proxy vazio
console.log("\n[3] settings.proxy = '' (sem manual)");
{
    const { sandbox } = createSandbox({ settings: { proxy: "" } } );
    t("usingManualProxy e false quando proxy vazio", () => {
        assertFalse(sandbox.usingManualProxy, "usingManualProxy");
    });
    t("isManualAddress('socks5://u:p@h:10030') -> false (sem manual)", () => {
        assertFalse(sandbox.isManualAddress("socks5://u:p@h:10030"), "10030");
    });
    t("isManualAddress(null) -> false", () => {
        assertFalse(sandbox.isManualAddress(null), "null");
    });
}

// Cenario 4: settings.proxy com espaco
console.log("\n[4] settings.proxy = '   ' (string com espacos)");
{
    const { sandbox } = createSandbox({ settings: { proxy: "   " } });
    t("usingManualProxy e false com string de espacos", () => {
        assertFalse(sandbox.usingManualProxy, "usingManualProxy");
    });
    t("isManualAddress() -> false", () => {
        assertFalse(sandbox.isManualAddress("socks5://u:p@h:10030"));
    });
}

// Cenario 5: settings.proxy com range mas parseProxy falha
// (string com formato invalido que faz parseProxy retornar null)
console.log("\n[5] settings.proxy = 'socks5://h:abc' (parseProxy falha, mas trim != '')");
{
    const { sandbox } = createSandbox({ settings: { proxy: "socks5://h:abc" } });
    t("usingManualProxy = false (parseProxy falhou)", () => {
        assertFalse(sandbox.usingManualProxy);
    });
    t("isManualAddress -> sempre false mesmo com proxy 'socks5://h:abc' (que e o proprio settings.proxy)", () => {
        assertFalse(sandbox.isManualAddress("socks5://h:abc"));
    });
    t("isManualAddress('socks5://u:p@h:10030') -> false (sem manual)", () => {
        assertFalse(sandbox.isManualAddress("socks5://u:p@h:10030"));
    });
}

// Cenario 6: proxy com scheme diferente - documentacao do comportamento
console.log("\n[6] Comportamento de scheme: o codigo NAO compara scheme (apenas host+porta)");
{
    const { sandbox } = createSandbox({ settings: { proxy: "socks5://u:p@h:10000-10050" } });
    t("isManualAddress('socks4://u:p@h:10030') -> true (mesmo host/porta, scheme ignorado)", () => {
        // Comportamento documentado: isManualAddress so compara host e porta.
        // Isso significa que, por exemplo, se a saida ativa e socks4 e a manual e socks5
        // com mesmo host/porta, isManualAddress retorna true.
        // Nao chega a ser um bug porque a "saida manual" e a mesma conexao,
        // mas vale notar.
        assertTrue(sandbox.isManualAddress("socks4://u:p@h:10030"));
    });
    t("isManualAddress('http://u:p@h:10030') -> true (mesmo motivo)", () => {
        assertTrue(sandbox.isManualAddress("http://u:p@h:10030"));
    });
}

// Cenario 7: comparacao por string (nao range) - documentacao do bug pre-PR
console.log("\n[7] manualProxy() sorteia porta diferente a cada chamada, isManualAddress aceita todas");
{
    const { sandbox } = createSandbox({ settings: { proxy: "socks5://u:p@h:10000-10050" } });
    t("30 chamadas de manualProxy() produzem portas que isManualAddress aceita", () => {
        const ports = new Set();
        for (let i = 0; i < 30; i++) {
            const m = sandbox.manualProxy();
            const parsed = sandbox.parseProxy(m);
            ports.add(parsed.port);
            // isManualAddress deve aceitar essa porta
            assertTrue(sandbox.isManualAddress(m), "manual " + m);
        }
        if (ports.size > 1) {
            console.log("    [INFO] " + ports.size + " portas distintas sorteadas em 30 chamadas (range funciona)");
        }
    });
}

console.log("\n=======================================================");
console.log("Resultado: " + pass + " passou, " + fail + " falhou");
if (fail > 0) {
    console.log("\nFalhas:");
    for (const f of failures) console.log("  - " + f.name + ": " + f.error);
    process.exit(1);
}
process.exit(0);
