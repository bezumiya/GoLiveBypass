#!/usr/bin/env node
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));
const workspace = mkdtempSync(path.join(os.tmpdir(), "golive-plugin-proton-edge-"));
const moduleSource = readFileSync(path.join(repository, "goLiveBypass", "vpn-proton.ts"), "utf8");
const isolatedSource = moduleSource.replaceAll("__dirname", "process.cwd()").replace(
    'import { normalizeProtonUsername, protonUsernamesMatch, safeDiagnosticDetail } from "./vpn-types";',
    `function safeDiagnosticDetail(value, max = 300) {
    return String(value instanceof Error ? value.message : value ?? "")
        .replace(/[\\r\\n\\t]+/g, " ")
        .replace(/(PrivateKey\\s*=\\s*)\\S+/gi, "$1<redacted>")
        .replace(/(password|token|secret|authorization)\\s*[:=]\\s*\\S+/gi, "$1=<redacted>")
        .slice(0, max);
}
function normalizeProtonUsername(value) {
    return value.trim().replace(/@(protonmail\\.com|proton\\.me|pm\\.me)$/i, "");
}
function protonUsernamesMatch(expected, actual) {
    return normalizeProtonUsername(expected).toLowerCase() === normalizeProtonUsername(actual).toLowerCase();
}`,
);
const modulePath = path.join(workspace, "vpn-proton.ts");
writeFileSync(modulePath, isolatedSource, "utf8");

const helperPath = path.join(workspace, "fake-proton-confgen");
writeFileSync(helperPath, `#!/bin/sh
cat >/dev/null
username=""
session=""
previous=""
for arg in "$@"; do
    if [ "$previous" = "-username" ]; then username="$arg"; fi
    if [ "$previous" = "-session-file" ]; then session="$arg"; fi
    previous="$arg"
done
if [ -n "$session" ]; then printf '{"username":"%s"}\\n' "$username" > "$session"; fi
if [ "$GOLIVE_FAKE_QUEUE" = "1" ]; then
    printf 'start:%s\\n' "$username" >> "$GOLIVE_FAKE_QUEUE_EVENTS"
    case "$username" in
        old@example.com) sleep 0.15 ;;
    esac
    printf 'end:%s\\n' "$username" >> "$GOLIVE_FAKE_QUEUE_EVENTS"
    printf '{"success":true,"username":"%s"}\\n' "$username"
    exit 0
fi
if [ -n "$GOLIVE_FAKE_STDOUT" ]; then printf '%s\\n' "$GOLIVE_FAKE_STDOUT"; fi
if [ "$GOLIVE_FAKE_HANG" = "1" ]; then sleep 5; fi
exit "\${GOLIVE_FAKE_EXIT_CODE:-0}"
`, "utf8");
chmodSync(helperPath, 0o700);

const environmentNames = [
    "GOLIVE_PLUGIN_PROTON_CONFGEN",
    "GOLIVE_FAKE_STDOUT",
    "GOLIVE_FAKE_EXIT_CODE",
    "GOLIVE_FAKE_HANG",
    "GOLIVE_FAKE_QUEUE",
    "GOLIVE_FAKE_QUEUE_EVENTS",
];
const previousEnvironment = new Map(environmentNames.map(name => [name, process.env[name]]));
process.env.GOLIVE_PLUGIN_PROTON_CONFGEN = helperPath;
for (const name of environmentNames.slice(1)) delete process.env[name];

const proton = await import(`${pathToFileURL(modulePath).href}?edge=${Date.now()}`);
let passed = 0;

async function test(name, fn) {
    await fn();
    passed++;
    process.stdout.write(`ok ${passed} - ${name}\n`);
}

try {
    await test("runConfgen encerra stdin mesmo sem segredo", async () => {
        process.env.GOLIVE_FAKE_STDOUT = JSON.stringify({ success: true });
        const result = await proton.runConfgen({ args: [], timeoutMs: 1_000 });
        assert.equal(result.code, 0);
        assert.deepEqual(result.json, { success: true });
    });

    await test("login não aceita JSON de sucesso com exit code diferente de zero", async () => {
        process.env.GOLIVE_FAKE_STDOUT = JSON.stringify({ success: true, username: "alice@example.com" });
        process.env.GOLIVE_FAKE_EXIT_CODE = "9";
        const result = await proton.loginProton(path.join(workspace, "login-invalid-exit"), "alice@example.com", "senha-local");
        assert.equal(result.success, false);
    });

    await test("checagem de sessão exige exit code zero", async () => {
        process.env.GOLIVE_FAKE_STDOUT = JSON.stringify({ valid: true, username: "alice@example.com" });
        process.env.GOLIVE_FAKE_EXIT_CODE = "9";
        const result = await proton.checkProtonSession(path.join(workspace, "session-invalid-exit"), "alice@example.com");
        assert.equal(result.valid, false);
    });

    await test("códigos estruturados de 2FA e CAPTCHA são preservados sem texto bruto", async () => {
        process.env.GOLIVE_FAKE_STDOUT = JSON.stringify({ code: "TWO_FACTOR_REQUIRED", error: "senha=SEGREDO" });
        process.env.GOLIVE_FAKE_EXIT_CODE = "1";
        let result = await proton.loginProton(path.join(workspace, "two-factor"), "alice@example.com", "senha-local");
        assert.equal(result.code, "TWO_FACTOR_REQUIRED", JSON.stringify(result));
        assert.match(result.message, /2FA|duas etapas/i);
        assert.doesNotMatch(JSON.stringify(result), /SEGREDO/);

        process.env.GOLIVE_FAKE_STDOUT = JSON.stringify({
            code: "CAPTCHA_REQUIRED",
            error: "password=SEGREDO token=TOKEN_ECOADO",
            captchaUrl: "https://vpn-api.proton.me/core/v4/captcha?Token=challenge-123&return=https%3A%2F%2Fevil.example%2F",
        });
        result = await proton.loginProton(path.join(workspace, "captcha-required"), "alice@example.com", "senha-local");
        assert.equal(result.code, "CAPTCHA_REQUIRED");
        assert.equal(result.captchaUrl, "https://vpn-api.proton.me/core/v4/captcha?Token=challenge-123");
        assert.doesNotMatch(JSON.stringify(result), /SEGREDO|TOKEN_ECOADO/);

        process.env.GOLIVE_FAKE_STDOUT = JSON.stringify({ code: "CAPTCHA_CANCELLED", error: "password=SEGREDO" });
        result = await proton.loginProton(path.join(workspace, "captcha-cancelled"), "alice@example.com", "senha-local");
        assert.equal(result.code, "CAPTCHA_CANCELLED");
        assert.match(result.message, /cancelad/i);
        assert.doesNotMatch(JSON.stringify(result), /SEGREDO/);
    });

    await test("falha temporária do helper com 'temporarily' vira erro de rede", async () => {
        const classified = proton.classifyProtonError("Proton authentication temporarily unavailable");
        assert.equal(classified.code, "NETWORK_ERROR");
        assert.equal(classified.retryable, true);
    });

    await test("senha ausente falha como configuração sem iniciar o helper", async () => {
        process.env.GOLIVE_FAKE_STDOUT = JSON.stringify({ success: true });
        process.env.GOLIVE_FAKE_EXIT_CODE = "0";
        const dataDir = path.join(workspace, "missing-password");
        const result = await proton.loginProton(dataDir, "alice@example.com");
        assert.equal(result.success, false);
        assert.equal(result.code, "CONFIGURATION_ERROR");
        assert.equal(existsSync(dataDir), false);
    });

    await test("falha de armazenamento não escapa como exceção crua", async () => {
        const filePath = path.join(workspace, "not-a-directory");
        writeFileSync(filePath, "sentinel", "utf8");
        const result = await proton.loginProton(filePath, "alice@example.com", "senha-local");
        assert.equal(result.success, false);
        assert.equal(result.code, "SESSION_PERSISTENCE");
        assert.doesNotMatch(JSON.stringify(result), /senha-local|sentinel/);
    });

    await test("timeout rejeita no prazo", async () => {
        const startedAt = Date.now();
        await assert.rejects(
            proton.runConfgen({ exePath: process.execPath, args: ["-e", "setTimeout(()=>{},4000)"], timeoutMs: 35 }),
            error => /Tempo limite excedido/.test(String(error?.message)) && error?.name !== "AbortError",
        );
        assert.ok(Date.now() - startedAt < 1_500, "timeout não pode aguardar o processo filho");
    });

    await test("cancelamento rejeita com AbortError e encerra o processo", async () => {
        const controller = new AbortController();
        const pending = proton.runConfgen({ exePath: process.execPath, args: ["-e", "setTimeout(()=>{},4000)"], signal: controller.signal });
        setTimeout(() => controller.abort(), 35).unref?.();
        await assert.rejects(pending, error => error?.name === "AbortError");
    });

    await test("corrida entre abort e registro do listener é cancelada", async () => {
        const controller = new AbortController();
        let reads = 0;
        const raceSignal = {
            get aborted() {
                reads += 1;
                if (reads === 2) controller.abort();
                return controller.signal.aborted;
            },
            addEventListener: controller.signal.addEventListener.bind(controller.signal),
            removeEventListener: controller.signal.removeEventListener.bind(controller.signal),
        };
        const startedAt = Date.now();
        await assert.rejects(
            proton.runConfgen({ exePath: process.execPath, args: ["-e", "setTimeout(()=>{},4000)"], timeoutMs: 1_000, signal: raceSignal }),
            error => error?.name === "AbortError",
        );
        assert.ok(Date.now() - startedAt < 700, "a corrida de abort não pode virar timeout");
    });

    await test("stdout preserva UTF-8 dividido entre chunks", async () => {
        const payload = Buffer.from(JSON.stringify({ success: true, text: "é" }));
        const splitAt = payload.indexOf(Buffer.from("é")) + 1;
        const script = `const b=Buffer.from(${JSON.stringify([...payload])});process.stdout.write(b.subarray(0,${splitAt}));setTimeout(()=>process.stdout.write(b.subarray(${splitAt})),20);`;
        const result = await proton.runConfgen({ exePath: process.execPath, args: ["-e", script], timeoutMs: 1_000 });
        assert.equal(result.json?.text, "é");
    });

    await test("checagem de sessão retorna erro estruturado para armazenamento", async () => {
        const filePath = path.join(workspace, "session-not-a-directory");
        writeFileSync(filePath, "sentinel", "utf8");
        const result = await proton.checkProtonSession(filePath, "alice@example.com");
        assert.equal(result.valid, false);
        assert.equal(result.code, "SESSION_PERSISTENCE");
        assert.doesNotMatch(JSON.stringify(result), /sentinel|alice@example/);
    });

    await test("geração de configuração não escapa erro de armazenamento", async () => {
        const filePath = path.join(workspace, "config-not-a-directory");
        writeFileSync(filePath, "sentinel", "utf8");
        const result = await proton.generateOptimalProtonConfig(filePath, { username: "alice@example.com" });
        assert.equal(result.success, false);
        assert.match(result.error ?? "", /armazenamento local/i);
        assert.doesNotMatch(JSON.stringify(result), /sentinel|alice@example/);
    });

    await test("resposta de sessão de outra conta não é aceita", async () => {
        process.env.GOLIVE_FAKE_STDOUT = JSON.stringify({ valid: true, username: "mallory@example.com" });
        process.env.GOLIVE_FAKE_EXIT_CODE = "0";
        const result = await proton.checkProtonSession(path.join(workspace, "session-mismatch"), "alice@example.com");
        assert.equal(result.valid, false);
        assert.equal(result.code, "UNKNOWN");
        assert.doesNotMatch(JSON.stringify(result), /mallory/);
    });

    await test("login de outra conta não é aceito", async () => {
        process.env.GOLIVE_FAKE_STDOUT = JSON.stringify({ success: true, username: "mallory@example.com" });
        const result = await proton.loginProton(path.join(workspace, "login-mismatch"), "alice@example.com", "senha-local");
        assert.equal(result.success, false);
        assert.equal(result.code, "UNKNOWN");
        assert.doesNotMatch(JSON.stringify(result), /mallory/);
    });

    await test("cancelamento preserva a sessão Proton anterior", async () => {
        process.env.GOLIVE_FAKE_STDOUT = "";
        process.env.GOLIVE_FAKE_EXIT_CODE = "0";
        process.env.GOLIVE_FAKE_HANG = "1";
        const dataDir = path.join(workspace, "cancel-login");
        mkdirSync(dataDir);
        const sessionFile = proton.protonSessionFile(dataDir);
        writeFileSync(sessionFile, "previous-session", "utf8");
        process.env.GOLIVE_FAKE_QUEUE = "";
        const pending = proton.loginProton(dataDir, "alice@example.com", "senha-local");
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(proton.cancelProtonLogin(dataDir), true);
        const result = await pending;
        assert.equal(result.success, false);
        assert.equal(result.code, "CANCELLED");
        assert.match(result.message ?? "", /cancelado/i);
        assert.equal(readFileSync(sessionFile, "utf8"), "previous-session");
        assert.deepEqual(readdirSync(dataDir).filter(name => /^\.protonvpn-session-.*\.tmp$/.test(name)), []);
        delete process.env.GOLIVE_FAKE_HANG;
    });

    await test("diretório existente do cache fica privado no POSIX", async () => {
        const dataDir = path.join(workspace, "wide-cache");
        mkdirSync(dataDir);
        chmodSync(dataDir, 0o755);
        process.env.GOLIVE_FAKE_STDOUT = JSON.stringify({ valid: false, error: "saved session expired or invalid" });
        process.env.GOLIVE_FAKE_EXIT_CODE = "0";
        await proton.checkProtonSession(dataDir, "alice@example.com");
        if (process.platform !== "win32") assert.equal(statSync(dataDir).mode & 0o777, 0o700);
    });

    await test("URL de CAPTCHA mantém somente o desafio oficial", async () => {
        const parsed = proton.parseCaptchaUrl("https://vpn-api.proton.me/core/v4/captcha?Token=challenge-123&return=https%3A%2F%2Fevil.example%2F#fragment");
        assert.equal(parsed?.url, "https://vpn-api.proton.me/core/v4/captcha?Token=challenge-123");
        assert.equal(proton.parseCaptchaUrl("https://vpn-api.proton.me/core/v4/captcha?Token=a&Token=b"), null);
        assert.equal(proton.parseCaptchaUrl("https://user:password@vpn-api.proton.me/core/v4/captcha?Token=abc"), null);
        assert.equal(proton.parseCaptchaUrl("https://vpn-api.proton.me:444/core/v4/captcha?Token=abc"), null);
        assert.equal(proton.validateCaptchaResponse("challenge-123:answer", "challenge-123"), true);
        assert.equal(proton.validateCaptchaResponse(" challenge-123:answer ", "challenge-123"), false);
    });

    await test("classificação separa 2FA obrigatório de código inválido", async () => {
        assert.equal(proton.classifyProtonError("2FA required for VPN operations").code, "TWO_FACTOR_REQUIRED");
        assert.equal(proton.classifyProtonError("two-factor code is invalid").code, "TWO_FACTOR_INVALID");
        assert.equal(proton.classifyProtonError("CAPTCHA_CANCELLED").code, "CAPTCHA_CANCELLED");
    });

    await test("logins concorrentes não sobrescrevem o cache com conta antiga", async () => {
        const dataDir = path.join(workspace, "serialized-logins");
        const events = path.join(workspace, "serialized-logins.events");
        process.env.GOLIVE_FAKE_QUEUE = "1";
        process.env.GOLIVE_FAKE_QUEUE_EVENTS = events;
        const first = proton.loginProton(dataDir, "old@example.com", "old-secret");
        const second = proton.loginProton(dataDir, "new@example.com", "new-secret");
        const results = await Promise.all([first, second]);
        assert.equal(results[0].success, true);
        assert.equal(results[1].success, true);
        assert.deepEqual(readFileSync(events, "utf8").trim().split(/\r?\n/), [
            "start:old@example.com",
            "end:old@example.com",
            "start:new@example.com",
            "end:new@example.com",
        ]);
        assert.equal(JSON.parse(readFileSync(path.join(dataDir, "proton-session.json"), "utf8")).username, "new@example.com");
    });
} finally {
    for (const [name, value] of previousEnvironment) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    rmSync(workspace, { recursive: true, force: true });
}

process.stdout.write(`1..${passed}\n`);
