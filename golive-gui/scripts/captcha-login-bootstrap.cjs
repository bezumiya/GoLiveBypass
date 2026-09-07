#!/usr/bin/env node
/* Bootstrap for the isolated Linux CAPTCHA login fixture. */
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, ipcMain } = require('electron');

const root = __dirname;
const config = JSON.parse(fs.readFileSync(process.env.GOLIVE_CAPTCHA_E2E_CONFIG, 'utf8'));
const eventsFile = process.env.GOLIVE_CAPTCHA_E2E_EVENTS;
const resultFile = process.env.GOLIVE_CAPTCHA_E2E_RESULT;
const stateFile = process.env.GOLIVE_CAPTCHA_E2E_STATE;
const artifactDir = path.dirname(resultFile);
const events = [];
const errors = [];
let protocolRequests = 0;
let captchaWindows = new Set();
let captchaWindowCount = 0;
let finalState = null;
let callRows = [];
let ipcBaseline = 0;

function record(event, data = {}) {
  const row = { at: new Date().toISOString(), event, ...data };
  events.push(row);
  fs.appendFileSync(eventsFile, JSON.stringify(row) + '\n');
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function fail(message) { throw new Error(message); }
function tokenFrom(url) { return new URL(url).searchParams.get('Token') || ''; }
function captchaHtml(token) {
  const answer = `${token}:e2e-answer`;
  let messages = '';
  if (config.action === 'success' || config.action === 'double-click' || config.action === 'early-response' || config.action === 'retry') messages = `window.postMessage(${JSON.stringify({ type: 'proton_captcha', token: answer })}, '*');`;
  if (config.action === 'invalid-immediate-valid') messages = `window.postMessage({type:'proton_captcha',token:'wrong-answer'},'*');window.postMessage(${JSON.stringify({ type: 'proton_captcha', token: answer })}, '*');`;
  if (config.action === 'invalid') messages = Array.from({length: 10}, () => `window.postMessage({type:'proton_captcha',token:'wrong-answer'},'*');`).join('');
  return `<!doctype html><meta charset="utf-8"><title>CAPTCHA fixture</title><script>${messages}</script><button id="solve">Solve</button>`;
}
function isCaptchaWindow(win) {
  const prefs = win.webContents.getLastWebPreferences?.() || {};
  const preload = String(prefs.preload || '');
  // Electron 43 omits `preload` from getLastWebPreferences; the production
  // CAPTCHA window is the only sandboxed, isolated window in this fixture.
  return preload.endsWith('proton-captcha-preload.cjs') || (!preload && prefs.contextIsolation === true && prefs.sandbox === true);
}

process.on('uncaughtException', error => { errors.push(error); record('uncaughtException', { message: error.message }); });
process.on('unhandledRejection', error => { errors.push(error); record('unhandledRejection', { message: String(error) }); });
app.on('window-all-closed', event => event.preventDefault());
app.on('browser-window-created', (_event, win) => {
  if (!isCaptchaWindow(win)) { record('window-created', { captcha: false, url: win.webContents.getURL() }); win.webContents.on('did-finish-load', () => record('did-finish-load', { url: win.webContents.getURL() })); return; }
  captchaWindows.add(win);
  captchaWindowCount++;
  const ses = win.webContents.session;
  ses.protocol.handle('https', async request => {
    const url = new URL(request.url);
    if (url.hostname !== 'vpn-api.proton.me' || url.pathname !== '/core/v4/captcha') return new Response('blocked', { status: 403 });
    protocolRequests++;
    record('protocol-request', { origin: url.origin, pathname: url.pathname, token: tokenFrom(request.url) });
    if (config.loadFailure) return Response.error();
    return new Response(captchaHtml(tokenFrom(request.url)), { headers: { 'content-type': 'text/html; charset=utf-8' } });
  });
  record('captcha-protocol-installed', { preload: String(win.webContents.getLastWebPreferences().preload) });
  win.on('closed', () => record('captcha-window-closed', { destroyed: win.isDestroyed() }));
  if (config.action === 'close') win.webContents.once('did-finish-load', () => win.close());
  if (config.action === 'destroy') win.webContents.once('did-finish-load', () => win.destroy());
});

async function waitFor(predicate, timeout, label) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(25);
  }
  fail(`timeout aguardando ${label}`);
}
async function main() {
  app.setPath('userData', process.env.GOLIVE_CAPTCHA_E2E_USER_DATA);
  app.setPath('sessionData', process.env.GOLIVE_CAPTCHA_E2E_USER_DATA);
  if (process.platform === 'linux') app.disableHardwareAcceleration();
  await import(pathToFileURL(path.join(root, 'golive-gui', 'dist-electron', 'main.js')).href);
  await app.whenReady();
  const mainWindow = await waitFor(async () => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (isCaptchaWindow(win) || win.isDestroyed()) continue;
      const hasForm = await win.webContents.executeJavaScript('!!document.querySelector("#protonLoginBtn")').catch(() => false);
      if (hasForm) return win;
    }
    return false;
  }, 15000, 'janela principal');
  await waitFor(async () => !mainWindow.isDestroyed() && await mainWindow.webContents.executeJavaScript('document.readyState === "complete"'), 15000, 'DOM principal');
  ipcBaseline = ipcMain.listenerCount('proton-captcha-response');
  await mainWindow.webContents.executeJavaScript(`(() => {
    const u = document.querySelector('#protonUsername'), p = document.querySelector('#protonPassword'), b = document.querySelector('#protonLoginBtn');
    if (!u || !p || !b) throw new Error('formulario Proton ausente');
    u.value = 'e2e@example.invalid'; p.value = 'e2e-password';
    u.dispatchEvent(new Event('input', { bubbles: true })); p.dispatchEvent(new Event('input', { bubbles: true })); ${config.action === 'double-click' ? 'b.click(); b.click();' : 'b.click();'}
  })()`);
  const deadline = Date.now() + (config.action === 'timeout' ? 135000 : 15000);
  while (Date.now() < deadline) {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!isCaptchaWindow(win) || win.isDestroyed()) continue;
    }
    finalState = await mainWindow.webContents.executeJavaScript('(() => { const b=document.querySelector("#protonLoginBtn"); const v=document.querySelector("#protonConnectedView"); const f=document.querySelector("#protonFeedback"); return {busy:!!b?.disabled,connected:!!v && !v.hidden,feedback:f?.textContent||"",feedbackClass:f?.className||""}; })()').catch(error => ({ error: error.message }));
    if ((finalState.connected && !finalState.busy) || (!finalState.busy && finalState.feedback)) break;
    await sleep(25);
  }
  if (!finalState || (finalState.busy && !finalState.connected)) fail(`estado final não estabilizou: ${JSON.stringify(finalState)}`);
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const callLog = `${stateFile}.calls.ndjson`;
  callRows = fs.existsSync(callLog) ? fs.readFileSync(callLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const expectedToken = `e2e-${config.caseId}-1:e2e-answer`;
  const expectedVerification = config.action === 'retry' ? 2 : 1;
  const calls = state.initialCalls === 1 && state.verificationCalls === expectedVerification;
  const expectedTokens = config.action === 'retry' ? [expectedToken, `e2e-${config.caseId}-2:e2e-answer`] : [expectedToken];
  const loginRows = callRows.filter(row => row.loginOnly);
  const exactTokens = loginRows.length === expectedVerification + 1 && loginRows.slice(1).every((row, index) => row.hvToken === expectedTokens[index]);
  const expectedSuccess = ['success', 'double-click', 'early-response', 'retry', 'invalid-immediate-valid'].includes(config.action);
  if (expectedSuccess && (!finalState.connected || finalState.busy)) fail(`estado positivo inválido: ${JSON.stringify(finalState)}`);
  if (expectedSuccess && (!calls || !exactTokens || !state.sessionSaved || state.tokenMatches?.length < 1 || !state.tokenMatches.every(Boolean))) fail(`assertions helper: ${JSON.stringify({ state, callRows })}`);
  const helperMissing = config.action === 'missing-helper';
  const expectedFeedback = { close: 'cancel', destroy: 'cancelada', invalid: 'inválida', 'loadfailure': 'carregar', 'missing-helper': 'componente', 'missing-preload': 'preparar', 'corrupt-preload': 'preparar', timeout: 'expirou' }[config.action];
  if (!expectedSuccess && ((!helperMissing && (state.initialCalls !== 1 || state.verificationCalls !== 0)) || state.sessionSaved || finalState.connected || finalState.busy || (expectedFeedback && !finalState.feedback.toLowerCase().includes(expectedFeedback)))) fail(`assertions negativo: ${JSON.stringify({ state, finalState, expectedFeedback })}`);
  const expectedRequests = ['missing-helper', 'missing-preload'].includes(config.action) ? 0 : (config.action === 'retry' ? 2 : 1);
  const expectedWindows = ['missing-helper', 'missing-preload'].includes(config.action) ? 0 : (config.action === 'retry' ? 2 : 1);
  const ipcAfter = ipcMain.listenerCount('proton-captcha-response');
  if (protocolRequests !== expectedRequests || captchaWindowCount !== expectedWindows || [...captchaWindows].some(win => !win.isDestroyed()) || ipcAfter !== ipcBaseline || errors.length) fail(`assertions protocolo/cleanup/IPC: ${JSON.stringify({ protocolRequests, captchaWindowCount, expectedWindows, ipcBaseline, ipcAfter, errors: errors.map(e => e.message) })}`);
  const remaining = [...captchaWindows].filter(win => !win.isDestroyed()).length;
  if (remaining) fail(`janela CAPTCHA ainda aberta: ${remaining}`);
  const image = await mainWindow.webContents.capturePage();
  fs.writeFileSync(path.join(artifactDir, 'final.png'), image.toPNG());
  record('success-assertions', { initialCalls: state.initialCalls, verificationCalls: state.verificationCalls, tokenMatches: state.tokenMatches, sessionSaved: state.sessionSaved, protocolRequests, captchaWindowsOpen: remaining });
  fs.writeFileSync(resultFile, JSON.stringify({ result: 'PASS', config, events, errors: errors.map(e => ({ message: e.message })), state, callRows, finalState, assertions: { protocolRequests, captchaWindowCount, ipcBaseline, ipcAfter }, }, null, 2) + '\n');
  app.exit(0);
}
main().catch(error => {
  record('failure', { message: error.message, stack: error.stack });
  fs.writeFileSync(resultFile, JSON.stringify({ result: 'FAIL', config, events, errors: errors.map(e => ({ message: e.message })), state: fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {}, callRows, finalState, protocolRequests, failure: error.message }, null, 2) + '\n');
  app.exit(1);
});
