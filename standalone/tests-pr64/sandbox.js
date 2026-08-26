// tests-pr64/sandbox.js
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const vm = require("vm");
const Module = require("module");

const REPO = path.resolve(__dirname, "..", "..");
const BYPASS = path.join(REPO, "standalone", "golivebypass.js");

const EXPOSE = [
    "chosenExit", "ultimaMidiaEm", "lastManualRetryAt", "beating",
    "settings", "usingManualProxy", "routeMode",
    "MIDIA_RECENTE_MS", "MANUAL_RETRY_COOLDOWN_MS",
    "HEARTBEAT_TIMEOUT_MS", "HEARTBEAT_MS", "pool",
    // Adicionados no rev-estatico do PR 64 (B3: troca silenciosa)
    "gatewayConnCount", "ultimaTrocaProativaEm", "gatewayReconexoes",
    "missedBeats", "rttEma", "rttLentoSeguidas", "lastExitAt",
];

function trimSource(source) {
    let out = source;
    out = out.replace(
        /setInterval\(\(\) => \{ beat\(\); \}, HEARTBEAT_MS\);/,
        "// beat interval removido para testes"
    );
    const startMarker = "try {\n    const discordPkg = require(join(asarPath, ";
    const startIdx = out.indexOf(startMarker);
    if (startIdx >= 0) {
        const endIdx = out.indexOf("app.whenReady().then");
        if (endIdx > startIdx) {
            out = out.slice(0, startIdx) +
                "try { /* discord load desativado */ } catch (e) { /* ignora */ }\n" +
                out.slice(endIdx);
        }
    }
    return out;
}

function buildExposeBlock() {
    const parts = EXPOSE.map(v => {
        return `Object.defineProperty(globalThis, ${JSON.stringify(v)}, { ` +
               `get() { return ${v}; }, ` +
               `set(value) { ${v} = value; }, ` +
               `configurable: true, enumerable: true });`;
    });
    return "\n// --- exposed by tests-pr64 ---\n" + parts.join("\n") + "\n";
}

function createSandbox(settings, options = {}) {
    if (settings && "settings" in settings && !("proxy" in settings)) {
        settings = settings.settings;
    }
    settings = settings || {};

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "golivebypass-test-"));
    const resourcesDir = path.join(tmpDir, "resources");
    const appAsar = path.join(resourcesDir, "app.asar");
    const origAsar = path.join(resourcesDir, "_app.asar");
    fs.mkdirSync(appAsar, { recursive: true });
    fs.mkdirSync(origAsar, { recursive: true });
    fs.writeFileSync(path.join(appAsar, "package.json"), JSON.stringify({ name: "discord", main: "index.js" }));
    fs.writeFileSync(path.join(appAsar, "index.js"), "// discord fake");
    fs.writeFileSync(path.join(appAsar, "settings.json"), JSON.stringify(settings));
    fs.writeFileSync(path.join(origAsar, "package.json"), JSON.stringify({ name: "discord", main: "index.js" }));
    fs.writeFileSync(path.join(origAsar, "index.js"), "// discord original");

    const appStub = {
        on: () => {},
        whenReady: () => ({ then: () => {} }),
        setAppPath: () => {},
    };
    const sessionStub = {
        defaultSession: {
            resolveProxy: async () => "DIRECT",
            setProxy: async () => {},
        },
    };
    const electronStub = {
        app: appStub,
        session: sessionStub,
        BrowserWindow: { getAllWindows: () => [] },
    };

    const sandboxRequire = (name) => {
        if (name === "electron") return electronStub;
        if (name === "original-fs") return require("fs");
        if (name === "path") return require("path");
        return Module._load(name, { filename: BYPASS }, false);
    };
    sandboxRequire.main = { filename: path.join(appAsar, "index.js") };

    const sandboxProcess = Object.assign({}, process, {
        argv: [process.argv[0], appAsar, ...process.argv.slice(2)],
    });

    const sandbox = {
        require: sandboxRequire,
        module: { exports: {} },
        exports: {},
        __dirname: appAsar,
        __filename: BYPASS,
        console,
        process: sandboxProcess,
        Buffer,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        URL,
        URLSearchParams,
        Date,
    };
    sandbox.module.exports = sandbox.exports;
    sandbox.global = sandbox;
    vm.createContext(sandbox);

    let code = fs.readFileSync(BYPASS, "utf8");
    code = trimSource(code);
    code = code + buildExposeBlock();
    try {
        vm.runInContext(code, sandbox, { filename: BYPASS });
    } catch (error) {
        if (options.debug) {
            const m = error.stack && error.stack.match(/golivebypass\.js:(\d+)/);
            console.error("[sandbox] erro na linha", m ? m[1] : "?", error.message);
        }
    }

    // helper: roda codigo dentro do contexto (para mockar funcoes no escopo do bypass)
    sandbox.runInContext = function(code) { return vm.runInContext(code, sandbox); };

    return { sandbox, tmpDir, appAsar };
}

module.exports = { createSandbox, BYPASS, EXPOSE };
