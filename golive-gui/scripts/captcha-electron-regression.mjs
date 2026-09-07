#!/usr/bin/env node
/**
 * CAPTCHA lifecycle regression.
 * Prepare with: node scripts/captcha-electron-regression.mjs --prepare /tmp/captcha.cjs
 * Run with: DISPLAY=:1 CAPTCHA_PRELOAD="$PWD/dist-electron/proton-captcha-preload.cjs" electron --no-sandbox /tmp/captcha.cjs
 * The generated runner uses real BrowserWindow/WebContents and the compiled
 * sandbox preload; it serves a local HTTPS fixture through the CAPTCHA session.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..");
const mainPath = path.join(root, "electron", "main.ts");
const captchaPath = path.join(root, "electron", "proton-captcha.ts");

function extractFunction(source, name) {
  const file = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const matches = file.statements.filter((statement) =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  if (matches.length !== 1) throw new Error(`expected exactly one function ${name}, found ${matches.length}`);
  return matches[0].getText(file);
}

function replaceExactly(source, needle, replacement) {
  const occurrences = source.split(needle).length - 1;
  if (occurrences !== 1) throw new Error(`expected exactly one occurrence of ${JSON.stringify(needle)}, found ${occurrences}`);
  return source.replace(needle, replacement);
}

function transpile(source) {
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

function prepare(destination) {
  const helpers = transpile(fs.readFileSync(captchaPath, "utf8"));
  let solverSource = extractFunction(fs.readFileSync(mainPath, "utf8"), "solveProtonCaptcha");
  solverSource = replaceExactly(solverSource, 'path.join(__dirname, "proton-captcha-preload.cjs")', "process.env.CAPTCHA_PRELOAD");
  solverSource = replaceExactly(
    solverSource,
    "const preventDownload = (event: Electron.Event) => event.preventDefault();",
    "globalThis.__captchaWindow = captchaWindow;\n    const preventDownload = (event: Electron.Event) => event.preventDefault();",
  );
  const solver = transpile(solverSource);
  const runner = `
const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");
const helperModule = { exports: {} };
new Function("require", "module", "exports", ${JSON.stringify(helpers)})(require, helperModule, helperModule.exports);
const helpers = helperModule.exports;
const solve = new Function(
  "BrowserWindow", "ipcMain", "path", "fs", "parseProtonCaptchaChallenge", "isAllowedProtonCaptchaNavigation",
  "validateProtonCaptchaResponse", "PROTON_CAPTCHA_IPC_CHANNEL",
  ${JSON.stringify(solver)} + "\\nreturn solveProtonCaptcha;",
)(BrowserWindow, ipcMain, path, fs, helpers.parseProtonCaptchaChallenge, helpers.isAllowedProtonCaptchaNavigation,
  helpers.validateProtonCaptchaResponse, helpers.PROTON_CAPTCHA_IPC_CHANNEL);
const logPath = process.env.CAPTCHA_LOG || "/tmp/golive-triage/captcha-after.log";
fs.mkdirSync(path.dirname(logPath), { recursive: true });
fs.writeFileSync(logPath, "");
const errors = [];
const openWindows = new Set();
const write = (event, details = {}) => {
  const row = { at: new Date().toISOString(), event, ...details };
  fs.appendFileSync(logPath, JSON.stringify(row) + "\\n");
  process.stdout.write(JSON.stringify(row) + "\\n");
};
process.on("uncaughtException", (error) => {
  errors.push(error);
  write("uncaught-exception", { name: error.name, message: error.message, stack: error.stack });
});
process.on("unhandledRejection", (error) => {
  errors.push(error);
  write("unhandled-rejection", { message: String(error), stack: error && error.stack });
});
app.on("window-all-closed", (event) => event.preventDefault());
const deadline = (promise, ms, label) => {
  let timer;
  const expiry = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
};
async function cycle(number, action) {
  delete globalThis.__captchaWindow;
  const listenerBaseline = ipcMain.listenerCount("proton-captcha-response");
  const created = new Promise((resolve) => app.once("browser-window-created", (_event, browserWindow) => {
    // dom-ready occurs after the sandbox preload has run, but before did-finish-load.
    browserWindow.webContents.session.protocol.handle("https", async (request) => {
      const url = new URL(request.url);
      if (url.hostname !== "proton.me" || url.pathname !== "/core/v4/captcha") return new Response("not found", { status: 404 });
      const token = url.searchParams.get("Token") === "cycle-early" ? "cycle-early:answer" : "";
      const script = token ? "<script>window.postMessage({type:'proton_captcha',token:'" + token + "'},'*')</script>" : "<p>captcha fixture</p>";
      return new Response("<!doctype html><html><body>" + script + "</body></html>", { headers: { "content-type": "text/html" } });
    });
    browserWindow.webContents.once("dom-ready", () => resolve(browserWindow));
  }));
  const promise = solve("https://proton.me/core/v4/captcha?Token=" + (action === "early" ? "cycle-early" : "cycle-" + number), null);
  const window = await deadline(created, 4000, "window creation timeout");
  openWindows.add(window);
  if (action !== "early") await deadline(new Promise((resolve) => window.webContents.once("did-finish-load", resolve)), 4000, "page load timeout");
  write("loaded", { cycle: number, action, destroyed: window.isDestroyed() });
  if (action === "success") {
    await new Promise(setImmediate);
    await window.webContents.executeJavaScript("window.postMessage({type:'proton_captcha',token:'cycle-" + number + ":answer'}, '*')");
  } else if (action === "invalid-valid") {
    await window.webContents.executeJavaScript("window.postMessage({type:'proton_captcha',token:'wrong'}, '*'); window.postMessage({type:'proton_captcha',token:'cycle-" + number + ":answer'}, '*')");
  } else if (action === "close") window.close();
  else if (action === "destroy") window.destroy();
  const result = await deadline(promise, 4000, "cycle " + number + " promise pending");
  write("resolved", { cycle: number, action, result, destroyed: window.isDestroyed() });
  if (!window.isDestroyed()) throw new Error("captcha window cleanup mismatch");
  if (ipcMain.listenerCount("proton-captcha-response") !== listenerBaseline) throw new Error("IPC listener cleanup mismatch");
  if (action === "early" && (!result.ok || result.token !== "cycle-early:answer")) throw new Error("early result mismatch");
  if ((action === "success" || action === "invalid-valid") && (!result.ok || result.token !== "cycle-" + number + ":answer")) throw new Error("success result mismatch");
  if ((action === "close" || action === "destroy") && (result.ok || result.code !== "CAPTCHA_CANCELLED")) throw new Error("cancel result mismatch");
  openWindows.delete(window);
}
async function main() {
  await app.whenReady();
  write("start", { electron: process.versions.electron, cycles: 13, preload: process.env.CAPTCHA_PRELOAD || "" });
  let number = 0;
  for (let count = 0; count < 5; count += 1) await cycle(++number, "close");
  for (let count = 0; count < 5; count += 1) await cycle(++number, "destroy");
  await cycle(++number, "early");
  await cycle(++number, "invalid-valid");
  await cycle(++number, "success");
  if (errors.length) throw new Error("uncaught Electron errors: " + errors.map(String).join(" | "));
  if (openWindows.size !== 0) throw new Error("open CAPTCHA windows remain");
  write("summary", { result: "PASS", cycles: number });
}
main().then(() => app.exit(0), (error) => {
  write("summary", { result: "FAIL", message: error.message, stack: error.stack });
  for (const window of openWindows) if (!window.isDestroyed()) window.destroy();
  app.exit(1);
});
`;
  fs.writeFileSync(destination, runner);
  console.log(`Prepared ${destination}`);
}

if (process.argv[2] !== "--prepare" || !process.argv[3]) {
  console.error("Usage: node scripts/captcha-electron-regression.mjs --prepare <runner.cjs>");
  process.exit(2);
}
prepare(path.resolve(process.argv[3]));
