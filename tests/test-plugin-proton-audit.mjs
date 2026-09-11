#!/usr/bin/env node
import assert from "node:assert/strict";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));
const workspace = mkdtempSync(path.join(os.tmpdir(), "golive-plugin-proton-audit-"));
const originalCwd = process.cwd();
const moduleSource = readFileSync(path.join(repository, "goLiveBypass", "vpn-proton.ts"), "utf8");
const isolatedSource = moduleSource.replaceAll("__dirname", "process.cwd()").replace(
    // Casa a linha inteira: o módulo real pode importar outros tipos de
    // "./vpn-types" (a lista já mudou uma vez e prendia o harness, não o código).
    /import \{[^}]*\} from "\.\/vpn-types";/,
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

const helperImpl = path.join(workspace, "audit-helper.mjs");
writeFileSync(helperImpl, `
import fs from "node:fs";

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { stdin += chunk; });
process.stdin.on("end", () => {
    let username = "";
    let session = "";
    let previous = "";
    for (const arg of process.argv.slice(2)) {
        if (previous === "-username") username = arg;
        if (previous === "-session-file") session = arg;
        previous = arg;
    }
    if (process.env.GOLIVE_AUDIT_HANG === "1") {
        if (process.env.GOLIVE_AUDIT_STARTED) fs.writeFileSync(process.env.GOLIVE_AUDIT_STARTED, "started");
        process.once("SIGTERM", () => {
            if (session) fs.writeFileSync(session, JSON.stringify({ username: "alice" }));
            process.exit(143);
        });
        setInterval(() => {}, 1_000);
        return;
    }
    if (session) fs.writeFileSync(session, JSON.stringify({ username }));
    process.stdout.write(JSON.stringify({ success: true, username }) + "\\n");
});
`, "utf8");
const helperPath = path.join(workspace, "proton-confgen");
const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
writeFileSync(helperPath, `#!/bin/sh
exec ${shellQuote(process.execPath)} ${shellQuote(helperImpl)} "$@"
`, "utf8");
chmodSync(helperPath, 0o700);

const environmentNames = [
    "GOLIVE_PLUGIN_PROTON_CONFGEN",
    "GOLIVE_AUDIT_HANG",
    "GOLIVE_AUDIT_STARTED",
];
const previousEnvironment = new Map(environmentNames.map(name => [name, process.env[name]]));
process.chdir(workspace);
process.env.GOLIVE_PLUGIN_PROTON_CONFGEN = helperPath;
for (const name of environmentNames.slice(1)) delete process.env[name];

const proton = await import(`${pathToFileURL(modulePath).href}?audit=${Date.now()}`);
let passed = 0;

async function test(name, fn) {
    await fn();
    passed++;
    process.stdout.write(`ok ${passed} - ${name}\n`);
}

try {
    let symlinksAvailable = true;
    const helperLink = path.join(workspace, "proton-confgen-link");
    try {
        symlinkSync(helperPath, helperLink);
    } catch {
        symlinksAvailable = false;
    }

    if (symlinksAvailable) {
        await test("seleção do helper rejeita symlink final", async () => {
            process.env.GOLIVE_PLUGIN_PROTON_CONFGEN = helperLink;
            assert.throws(() => proton.findProtonConfgenExe(), /não foi encontrado/i);
            process.env.GOLIVE_PLUGIN_PROTON_CONFGEN = helperPath;
        });

        await test("seleção do helper rejeita symlink em diretório pai", async () => {
            const realDir = path.join(workspace, "real-helper-dir");
            const linkedDir = path.join(workspace, "linked-helper-dir");
            mkdirSync(realDir);
            const nestedHelper = path.join(realDir, "proton-confgen");
            writeFileSync(nestedHelper, readFileSync(helperPath));
            chmodSync(nestedHelper, 0o700);
            symlinkSync(realDir, linkedDir, "dir");
            process.env.GOLIVE_PLUGIN_PROTON_CONFGEN = path.join(linkedDir, "proton-confgen");
            assert.throws(() => proton.findProtonConfgenExe(), /não foi encontrado/i);
            process.env.GOLIVE_PLUGIN_PROTON_CONFGEN = helperPath;
        });
    }

    await test("seleção do helper rejeita arquivo vazio", async () => {
        const emptyHelper = path.join(workspace, "empty-proton-confgen");
        writeFileSync(emptyHelper, "");
        chmodSync(emptyHelper, 0o700);
        process.env.GOLIVE_PLUGIN_PROTON_CONFGEN = emptyHelper;
        assert.throws(() => proton.findProtonConfgenExe(), /não foi encontrado/i);
        process.env.GOLIVE_PLUGIN_PROTON_CONFGEN = helperPath;
    });

    if (process.platform !== "win32") {
        await test("seleção do helper rejeita arquivo gravável por outro usuário", async () => {
            const writableHelper = path.join(workspace, "writable-proton-confgen");
            writeFileSync(writableHelper, readFileSync(helperPath));
            chmodSync(writableHelper, 0o702);
            process.env.GOLIVE_PLUGIN_PROTON_CONFGEN = writableHelper;
            assert.throws(() => proton.findProtonConfgenExe(), /não foi encontrado/i);
            process.env.GOLIVE_PLUGIN_PROTON_CONFGEN = helperPath;
        });
    }

    if (symlinksAvailable) {
        await test("diretório de sessão rejeita symlink", async () => {
            const realDir = path.join(workspace, "real-session-dir");
            const linkedDir = path.join(workspace, "linked-session-dir");
            mkdirSync(realDir);
            symlinkSync(realDir, linkedDir, "dir");
            const result = await proton.checkProtonSession(linkedDir, "alice");
            assert.equal(result.valid, false);
            assert.equal(result.code, "SESSION_PERSISTENCE");
            assert.equal(existsSync(path.join(realDir, "proton-session.json")), false);
        });
    }

    await test("login normaliza o identificador e exige retorno da mesma conta", async () => {
        const result = await proton.loginProton(path.join(workspace, "canonical-session"), "alice@proton.me", "dummy-password");
        assert.equal(result.success, true);
        assert.equal(result.username, "alice");
    });

    await test("logout limpa temporários do cache", async () => {
        const dataDir = path.join(workspace, "temporary-cache");
        mkdirSync(dataDir);
        const temporary = path.join(dataDir, ".protonvpn-session-leftover.tmp");
        writeFileSync(temporary, "leftover");
        assert.equal(proton.removeProtonSession(dataDir), true);
        assert.equal(existsSync(temporary), false);
    });

    await test("cancelamento preserva a sessão canônica anterior", async () => {
        const dataDir = path.join(workspace, "cancelled-session");
        const started = path.join(workspace, "cancelled-session.started");
        const sessionFile = proton.protonSessionFile(dataDir);
        mkdirSync(dataDir);
        writeFileSync(sessionFile, "previous-session", "utf8");
        process.env.GOLIVE_AUDIT_HANG = "1";
        process.env.GOLIVE_AUDIT_STARTED = started;
        const pending = proton.loginProton(dataDir, "alice", "dummy-password");
        const deadline = Date.now() + 1_000;
        while (!existsSync(started) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(existsSync(started), true, "helper simulado não iniciou a tempo");
        assert.equal(proton.cancelProtonLogin(dataDir), true);
        const result = await pending;
        assert.equal(result.success, false);
        assert.equal(result.code, "CANCELLED");
        assert.match(result.message ?? "", /cancelado/i);
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(readFileSync(sessionFile, "utf8"), "previous-session");
        delete process.env.GOLIVE_AUDIT_HANG;
        delete process.env.GOLIVE_AUDIT_STARTED;
    });
} finally {
    process.chdir(originalCwd);
    for (const [name, value] of previousEnvironment) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    rmSync(workspace, { recursive: true, force: true });
}

process.stdout.write(`1..${passed}\n`);
