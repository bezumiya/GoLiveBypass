import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../goLiveBypass/index.tsx", import.meta.url), "utf8");

test("onboarding do modo customizado mantém duas etapas sem credenciais Proton", () => {
    assert.match(source, /function OnboardingSteps\(\{ page, customMode \}/);
    // O que importa e' o COMPORTAMENTO: no modo personalizado os rotulos nao mencionam
    // conta Proton; no modo Proton, mencionam. Prender o array literal (que ja teve 2 e
    // hoje tem 3 etapas) so quebrava a cada ajuste de redacao sem apontar defeito nenhum.
    const labels = source.slice(source.indexOf("const labels = customMode"), source.indexOf("</div>", source.indexOf("const labels = customMode")));
    assert.match(labels, /customMode[\s\S]*?Configuração WireGuard/);
    assert.match(labels, /:\s*\[[\s\S]*?Conta Proton/);
    assert.doesNotMatch(labels.slice(0, labels.indexOf(":")), /Conta Proton/);
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
    assert.match(startBlock, /if \(!onboardingRequired && typeof Native\?\.enableAutomatic === "function"\)/);
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

test("concluir a configuração ativa a VPN e reinicia o Discord", () => {
    const complete = source.slice(source.indexOf("const complete = ()"), source.indexOf("const checkSession"));
    assert.match(complete, /settings\.store\.onboardingCompleted = true;/);
    assert.match(complete, /closeModal\(\);/);
    // A página final prometia "a ativação continua sendo uma ação separada no painel";
    // quem instala deve sair com o túnel de pé e o cliente relançado dentro da rota.
    assert.match(complete, /Native\.enable\(\)/);
    assert.match(complete, /não conseguiu ativar a VPN/);
    assert.match(source, /Ativar VPN e reiniciar o Discord/);
});

test("sessão Proton salva e válida pula a página de credenciais", () => {
    const load = source.slice(source.indexOf("const saved = await Native.getProtonSettings()"), source.indexOf("}, [customMode]));"));
    assert.match(load, /const result = await checkSession\(savedUsername\)/);
    // Pedir email e senha de novo com a sessão já válida é atrito puro: vai direto
    // para a rota, que é o passo que falta. "Voltar" continua reabrindo a conta.
    assert.match(load, /if \(!disposed && !disposedRef\.current && result\?\.valid\) \{[\s\S]*?setError\(null\);[\s\S]*?enterRoute\(\);/);
});

test("erros locais da sessão não são apresentados como expiração nem pedem senha automaticamente", () => {
  assert.match(source, /SESSION_PERSISTENCE/);
  assert.match(source, /case "MISSING_EXECUTABLE"/);
  assert.match(source, /case "SESSION_PERSISTENCE"/);
  const continueBlock = source.slice(source.indexOf("const continueToRoute"), source.indexOf("const optimizeRoute"));
  assert.match(continueBlock, /session && !session\.valid && session\.code && session\.code !== "INVALID_SESSION"/);
  // Sem senha o motivo pelo qual a sessão guardada não serve entra na mensagem
  // (sem chamá-la de expirada); com senha o login é sempre tentado -- antes,
  // um código como SESSION_PERSISTENCE virava beco sem saída na tela e o
  // usuário não conseguia entrar nem digitando as credenciais certas.
  const passwordGate = continueBlock.slice(continueBlock.indexOf("if (!password) {"));
  assert.match(passwordGate, /Informe a senha para entrar novamente/);
  assert.ok(
    passwordGate.indexOf("return;") < passwordGate.indexOf("Native.loginProton"),
    "com senha, o login precisa ser tentado mesmo quando a sessão guardada falhou",
  );
});

test("a UI avisa quando a máquina não guarda a sessão Proton", () => {
  const onboarding = source.slice(source.indexOf("function PluginOnboardingModal"), source.indexOf("function openPluginOnboarding"));
  const panel = source.slice(source.indexOf("function VpnPanel"), source.indexOf("function buildReport"));
  for (const [name, block] of [["onboarding", onboarding], ["painel", panel]]) {
    assert.match(block, /sessionStorage === "memory-only"/, `${name}: aviso do modo memória ausente`);
    assert.match(block, /vale só enquanto o Discord estiver aberto|vale só nesta execução/, `${name}: texto do aviso do modo memória`);
  }
  // O toast do painel não pode prometer que a sessão foi salva quando ela só existe na memória.
  const login = panel.slice(panel.indexOf("const login = async"), panel.indexOf("const cancelLogin"));
  assert.match(login, /result\.persisted === false/);
  assert.match(login, /não guarda a sessão/);
});

test("o status exposto à UI informa onde a sessão Proton é guardada", () => {
  const native = readFileSync(new URL("../goLiveBypass/native.ts", import.meta.url), "utf8");
  assert.match(native, /export function getVpnStatus\(_: IpcMainInvokeEvent\) \{[\s\S]*?sessionStorage: proton\.protonSessionStorageMode\(\)/);
  assert.match(native, /import \* as proton from "\.\/vpn-proton";/);
});

console.log("plugin onboarding source tests: 12/12");
