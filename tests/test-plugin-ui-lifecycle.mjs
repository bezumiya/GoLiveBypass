import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../goLiveBypass/index.tsx", import.meta.url), "utf8");

function updateSettingsSource() {
  const start = source.indexOf("function PluginUpdateSettings");
  const end = source.indexOf("const settings", start);
  assert.notEqual(start, -1, "PluginUpdateSettings não encontrado");
  assert.notEqual(end, -1, "fim de PluginUpdateSettings não encontrado");
  return source.slice(start, end);
}

function vpnPanelSource() {
  const start = source.indexOf("function VpnPanel");
  const end = source.indexOf("function forcedRegion", start);
  assert.notEqual(start, -1, "VpnPanel não encontrado");
  assert.notEqual(end, -1, "fim de VpnPanel não encontrado");
  return source.slice(start, end);
}

test("o polling do overlay ignora respostas stale e erros após desmontagem", () => {
  const block = updateSettingsSource();

  assert.match(source, /function withTimeout<[\s\S]*?setTimeout\(/);
  assert.match(source, /const PLUGIN_UPDATE_STATUS_TIMEOUT_MS = \d+_/);
  assert.match(source, /let pluginUpdateStatusFlight: Promise<PluginUpdateStatus> \| null = null/);
  assert.match(source, /function readPluginUpdateStatus\(\): Promise<PluginUpdateStatus> \| null/);
  assert.match(source, /if \(pluginUpdateStatusFlight\) return pluginUpdateStatusFlight/);
  assert.match(source, /PLUGIN_UPDATE_STATUS_TIMEOUT_MS/);
  assert.match(source, /statusRequest\.then\(status =>/);
  assert.match(block, /const mountedRef = React\.useRef\(false\)/);
  assert.match(block, /const policyRevisionRef = React\.useRef\(0\)/);
  assert.match(block, /const statusRequestRef = React\.useRef\(0\)/);
  assert.match(block, /const operationIdRef = React\.useRef\(0\)/);
  assert.match(block, /const operationBusyRef = React\.useRef\(false\)/);
  assert.match(block, /const request = \+\+statusRequestRef\.current/);
  assert.match(block, /const isRequestCurrent = \(\) => isCurrent\(revision\) && request === statusRequestRef\.current/);
  assert.match(block, /const statusRequest = readPluginUpdateStatus\(\)/);
  assert.match(block, /pluginUpdateStatusMatchesPolicy\(next, selectedUpdatePolicy\)/);
  assert.match(block, /const next = await statusRequest;\n\s+if \(!isRequestCurrent\(\)\) return null;\n\s+if \(!pluginUpdateStatusMatchesPolicy\(next, selectedUpdatePolicy\)\) return null;\n\s+setStatus\(next\)/);
  assert.match(block, /if \(isRequestCurrent\(\)\) logger\.error\("Falha ao consultar o estado do updater do plugin"/);
  assert.match(source, /schedulePluginUpdateStatusObservation[\s\S]*?const statusRequest = readPluginUpdateStatus\(\)/);
  assert.match(source, /pluginUpdateStatusMatchesRendererPolicy\(status\)/);
});

test("check e update não atualizam a UI quando a operação perdeu o lifecycle", () => {
  const block = updateSettingsSource();

  assert.match(block, /const beginOperation = \(nextOperation: "checking" \| "updating"\)/);
  assert.match(block, /if \(!Native \|\| busy \|\| operationBusyRef\.current\) return null/);
  assert.match(source, /const PLUGIN_UPDATE_OPERATION_TIMEOUT_MS = \d+_/);
  assert.match(block, /const isOperationMounted = \(\) => isCurrent\(operationRevision\) && operationId === operationIdRef\.current/);
  assert.match(block, /withTimeout\([\s\S]*?native\.checkPluginUpdate\(selectedUpdatePolicy\)[\s\S]*?PLUGIN_UPDATE_OPERATION_TIMEOUT_MS/);
  assert.match(block, /withTimeout\([\s\S]*?native\.updatePlugin\(selectedUpdatePolicy\)[\s\S]*?PLUGIN_UPDATE_OPERATION_TIMEOUT_MS/);
  assert.match(block, /await refreshStatus\(operationRevision\);\n\s+if \(!isOperationMounted\(\)\) return;/);
  assert.match(block, /operationBusyRef\.current = true/);
  assert.match(block, /operationId === operationIdRef\.current\) operationBusyRef\.current = false/);
  assert.match(block, /if \(isOperationMounted\(\)\) \{\n\s+setBusy\(false\);\n\s+setOperation\(null\);\n\s+\}/);
});

test("cleanup invalida timers e não adiciona ação invasiva", () => {
  const block = updateSettingsSource();

  assert.match(block, /mountedRef\.current = false/);
  assert.match(block, /policyRevisionRef\.current\+\+/);
  assert.match(block, /statusRequestRef\.current\+\+/);
  assert.match(block, /operationIdRef\.current\+\+/);
  assert.match(block, /clearInterval\(timer\)/);
  assert.doesNotMatch(block, /window\.location\.reload|app\.(quit|relaunch)|taskkill|process\.kill/);
  assert.doesNotMatch(block, /Native\.(shutdown|enable)\(/);
});

test("polling do painel VPN não sobrescreve conta nova nem atualiza após desmontagem", () => {
  const block = vpnPanelSource();

  assert.match(block, /const mountedRef = React\.useRef\(false\)/);
  assert.match(block, /const usernameRef = React\.useRef\(""\)/);
  assert.match(block, /const refreshRequestRef = React\.useRef\(0\)/);
  assert.match(block, /const request = \+\+refreshRequestRef\.current/);
  assert.match(block, /const isCurrent = \(\) => mountedRef\.current && request === refreshRequestRef\.current/);
  assert.match(block, /if \(!isCurrent\(\)\) return;\n\s+setStatus\(nextStatus/);
  assert.match(block, /if \(!usernameRef\.current && typeof savedUsername === "string" && savedUsername\)/);
  assert.match(block, /usernameRef\.current = value; setUsername\(value\)/);
  assert.match(block, /mountedRef\.current = false/);
  assert.match(block, /refreshRequestRef\.current\+\+/);
  assert.match(block, /if \(!mountedRef\.current\) return;/);
  assert.match(block, /const loginRequestIdRef = React\.useRef<string \| null>\(null\)/);
  assert.match(block, /Native\.loginProton\(\{ username, password, twoFactorCode, requestId \}\)/);
  assert.match(block, /const cancelLogin = \(\) =>/);
  assert.match(block, /Native\.cancelProtonLogin\(activeRequestId\)/);
});

test("trocar a conta invalida credenciais e a rota preparada anteriormente", () => {
  const block = source.slice(source.indexOf("function PluginOnboardingModal"), source.indexOf("function openPluginOnboarding"));

  assert.match(block, /onChange=\{value => \{[\s\S]*?setPassword\(\"\"\);[\s\S]*?setTwoFactorCode\(\"\"\);[\s\S]*?setOptimization\(null\);[\s\S]*?setRequestId\(null\);/);
  assert.match(block, /optimizationAttemptRef\.current\+\+/);
  assert.match(block, /requireFreshOptimizationRef\.current = true/);
});

test("status e tentativas de rota descartam respostas stale e estados de falha reais", () => {
  const block = source.slice(source.indexOf("function PluginOnboardingModal"), source.indexOf("function openPluginOnboarding"));

  assert.match(block, /if \(page !== "route" \|\| customMode \|\| !Native\) return;/);
  assert.match(block, /const optimizationStatusRequestRef = React\.useRef\(0\)/);
  assert.match(block, /const request = \+\+optimizationStatusRequestRef\.current/);
  assert.match(block, /request === optimizationStatusRequestRef\.current\s*\n\s+&& !requireFreshOptimizationRef\.current/);
  assert.match(block, /const belongsToCurrentAttempt = typeof currentRequestId === "string"[\s\S]*?next\.requestId === currentRequestId/);
  assert.match(block, /&& belongsToCurrentAttempt\) setOptimization\(next\)/);
  assert.match(block, /const attempt = \+\+optimizationAttemptRef\.current/);
  assert.match(block, /const isOptimizationCurrent = \(\) => !disposedRef\.current && attempt === optimizationAttemptRef\.current/);
  assert.match(block, /progress\?\.phase === "preparing" \? "validando configuração"/);
  assert.match(block, /phase: "failed"/);
  assert.match(block, /if \(isOptimizationCurrent\(\)\) \{[\s\S]*?setError\(detail\);/);
});

test("validação customizada tem deadline, cancelamento lógico e libera o onboarding", () => {
  const block = source.slice(source.indexOf("function PluginOnboardingModal"), source.indexOf("function openPluginOnboarding"));

  assert.match(source, /const CUSTOM_WIREGUARD_VALIDATION_TIMEOUT_MS = \d+_/);
  assert.match(block, /withTimeout\([\s\S]*?Native\.testWireGuardConfig\(settings\.store\.customConfigPath\)[\s\S]*?CUSTOM_WIREGUARD_VALIDATION_TIMEOUT_MS/);
  assert.match(block, /optimizationRequestRef\.current = customMode \? null : nextRequestId/);
  assert.match(block, /const cancelOptimization = \(\) =>/);
  assert.match(block, /cancelActiveOptimization\(\);\n\s+setRequestId\(null\)/);
  assert.match(block, /customMode \? "Validação cancelada\. Você pode tentar novamente\."/);
  assert.match(block, /setBusy\(false\)/);
  assert.match(block, /text: "Cancelar validação", variant: "danger"/);
  assert.doesNotMatch(block, /customMode[\s\S]*?text: "Validando…"[\s\S]*?disabled: true/);
  assert.match(block, /const isOptimizationCurrent = \(\) => !disposedRef\.current && attempt === optimizationAttemptRef\.current/);
  assert.match(block, /optimizationStatusRequestRef\.current\+\+;\n\s+clearInterval\(timer\)/);
  assert.match(block, /const loginRequestIdRef = React\.useRef<string \| null>\(null\)/);
  assert.match(block, /requestId: loginRequestId/);
  assert.match(block, /cancelActiveLogin\(\)/);
  assert.match(block, /text: loginCancelRequested \? "Cancelando…" : "Cancelar login"/);
});

test("erro manual do updater conserva o contexto real para não duplicar overlay", () => {
  const block = updateSettingsSource();

  assert.match(block, /let failureContext: \{ current\?: string; channel: PluginUpdateChannel; detail: string \} \| null = null/);
  assert.match(block, /failureContext = \{ current: result\.current, channel: result\.channel \|\| selectedUpdatePolicy\.channel, detail \}/);
  assert.match(block, /const currentVersion = failureContext\?\.current \|\| status\?\.current \|\| PLUGIN_VERSION/);
  assert.match(block, /failureContext\?\.detail \|\| detail/);
});

console.log("plugin UI lifecycle source tests: 8/8");
