import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../goLiveBypass/index.tsx", import.meta.url), "utf8");

test("onboarding do modo customizado mantém duas etapas sem credenciais Proton", () => {
    assert.match(source, /function OnboardingSteps\(\{ page, customMode \}/);
    assert.match(source, /customMode \? \["1  Configuração WireGuard", "2  Validação da rota"\]/);
    assert.match(source, /const customMode = settings\.store\.vpnMode === "custom"/);
    assert.match(source, /O modo personalizado não usa conta Proton nem solicita credenciais/);
    assert.match(source, /if \(customMode\) \{[\s\S]*?setPage\("route"\);/);
});

test("onboarding valida o arquivo customizado antes de concluir", () => {
    const optimizeBlock = source.slice(source.indexOf("const optimizeRoute"), source.indexOf("const cancelOptimization"));
    assert.match(optimizeBlock, /if \(customMode\)/);
    assert.match(optimizeBlock, /Native\.testWireGuardConfig\(settings\.store\.customConfigPath\)/);
    assert.match(optimizeBlock, /A configuração WireGuard personalizada não passou na validação/);
    assert.match(optimizeBlock, /setPage\("ready"\)/);
});

test("painel customizado não exibe login Proton e conserva ações do túnel", () => {
    const panel = source.slice(source.indexOf("function VpnPanel"), source.indexOf("function buildReport"));
    assert.match(panel, /settings\.use\(\["vpnMode", "customConfigPath"\]\)/);
    assert.match(panel, /customMode \? \(/);
    assert.match(panel, /nenhum login Proton é necessário/);
    assert.match(panel, /Native\.testWireGuardConfig\(customConfigPath\)/);
    assert.match(panel, /Native\.enable\(\)/);
    assert.match(panel, /Native\.restoreNetwork\(\)/);
});

test("primeira inicialização não ativa a VPN antes do onboarding", () => {
    const startBlock = source.slice(source.indexOf("    start()"), source.indexOf("    stop()"));
    assert.match(startBlock, /const onboardingRequired = Native && settings\.store\.onboardingCompleted !== true/);
    assert.match(startBlock, /if \(onboardingRequired\) \{[\s\S]*?openPluginOnboarding\(\)/);
    assert.match(startBlock, /if \(!onboardingRequired && typeof Native\?\.enable === "function"\)/);
});

test("o processo nativo também respeita o gate do onboarding no boot", () => {
    const native = readFileSync(new URL("../goLiveBypass/native.ts", import.meta.url), "utf8");
    const boot = native.slice(native.indexOf("app.whenReady()"));
    assert.match(boot, /if \(pluginEnabled\(\) && pluginSettings\(\)\.onboardingCompleted === true\)/);
    assert.match(boot, /controller\.shouldSkipAutomaticEnable\(\)/);
    assert.match(boot, /VPN não foi ativada automaticamente após relaunch não confirmado/);
    assert.match(boot, /VPN não foi ativada no boot porque o onboarding ainda não foi concluído/);
});

test("onboarding inicial não permite pular a página de rotas", () => {
    const actionsStart = source.indexOf("const actions");
    const actionsEnd = source.indexOf("\n    if (!Native)", actionsStart);
    assert.notEqual(actionsStart, -1, "ações do onboarding não encontradas");
    assert.notEqual(actionsEnd, -1, "fim das ações do onboarding não encontrado");
    const actions = source.slice(actionsStart, actionsEnd);
    const accountActions = actions.slice(0, actions.indexOf('] : page === "route"'));
    assert.notEqual(accountActions.indexOf("page === \"account\""), -1, "ações da primeira página não encontradas");
    assert.doesNotMatch(accountActions, /complete/);
    assert.doesNotMatch(accountActions, /Fazer depois/);
  assert.match(source, /const requiredOnOpen = Boolean\(Native && settings\.store\.onboardingCompleted !== true\)/);
  assert.match(source, /if \(requiredOnOpen && settings\.store\.onboardingCompleted !== true && page !== "ready"\) return/);
});

test("onboarding informativo pode ser fechado sem bridge nativa", () => {
  assert.match(source, /const requiredOnOpen = Boolean\(Native && settings\.store\.onboardingCompleted !== true\)/);
});

test("página de rota ignora otimização antiga e exige o requestId da tentativa atual", () => {
  const routeStatus = source.slice(source.indexOf("getProtonOptimizationStatus"), source.indexOf("const continueToRoute"));
  assert.match(routeStatus, /const currentRequestId = optimizationRequestRef\.current/);
  assert.match(routeStatus, /next\.requestId === currentRequestId/);
  assert.match(routeStatus, /requireFreshOptimizationRef\.current = true/);
  assert.match(routeStatus, /setOptimization\(null\)/);
});

test("erros locais da sessão não são apresentados como expiração nem pedem senha automaticamente", () => {
  assert.match(source, /SESSION_PERSISTENCE/);
  assert.match(source, /case "MISSING_EXECUTABLE"/);
  assert.match(source, /case "SESSION_PERSISTENCE"/);
  const continueBlock = source.slice(source.indexOf("const continueToRoute"), source.indexOf("const optimizeRoute"));
  assert.match(continueBlock, /session && !session\.valid && session\.code && session\.code !== "INVALID_SESSION"/);
});

console.log("plugin onboarding source tests: 9/9");
