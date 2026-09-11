import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../goLiveBypass/index.tsx", import.meta.url), "utf8");

function sliceBetween(startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start + startMarker.length);
    assert.notEqual(start, -1, `marcador inicial ausente: ${startMarker}`);
    assert.notEqual(end, -1, `marcador final ausente: ${endMarker}`);
    return source.slice(start, end);
}

test("onboarding tem foco de página, rótulos acessíveis e conteúdo redimensionável", () => {
    const onboarding = sliceBetween("function PluginOnboardingModal", "function openPluginOnboarding");

    assert.match(onboarding, /const pageHeadingRef = React\.useRef<HTMLHeadingElement \| null>\(null\)/);
    assert.match(onboarding, /pageHeadingRef\.current\?\.focus\(\{ preventScroll: true \}\)/);
    assert.match(onboarding, /maxHeight: "min\(60vh, 560px\)"/);
    assert.match(onboarding, /overflowY: "auto"/);
    assert.match(onboarding, /aria-label="Usuário ProtonVPN"/);
    assert.match(onboarding, /aria-label="Senha ProtonVPN"/);
    assert.match(onboarding, /aria-label="Código 2FA \(se solicitado\)"/);
    assert.match(onboarding, /role="alert" aria-live="assertive"/);
    assert.match(onboarding, /aria-label="Progresso da validação da rota"/);
    assert.match(onboarding, /role="status" aria-live="polite" aria-busy=\{busy\}/);
    assert.match(onboarding, /const progressIsIndeterminate = progress\?\.active === true && progressPercent === null/);
    assert.match(onboarding, /progressPercent === null \? \{\} : \{ value: progressPercent \}/);
});

test("indicador de onboarding continua legível em larguras estreitas", () => {
    const steps = sliceBetween("function OnboardingSteps", "function PluginOnboardingModal");

    assert.match(steps, /flexWrap: "wrap"/);
    // A largura minima e' ajustavel; o que o teste protege e' o indicador continuar
    // quebrando linha em terminal estreito em vez de estourar a largura.
    assert.match(steps, /flex: "1 1 \d+px"/);
    assert.match(steps, /role="list"/);
    assert.match(steps, /role="listitem"/);
    assert.match(steps, /aria-current=\{index === active \? "step" : undefined\}/);
});

test("desmontagem fecha o modal do onboarding e cancela otimização ativa", () => {
    const onboarding = sliceBetween("function PluginOnboardingModal", "function openPluginOnboarding");
    const stop = sliceBetween("    stop()", "\n    }\n});");

    assert.match(source, /let onboardingModalKey: string \| null = null/);
    assert.match(source, /let onboardingModalToken = 0/);
    assert.match(source, /const modalKey = openModal\(/);
    assert.match(onboarding, /const optimizationRequestRef = React\.useRef<string \| null>\(null\)/);
    assert.match(onboarding, /cancelActiveOptimization\(\)/);
    assert.match(stop, /closeDiscordModal\(modalKey\)/);
    assert.match(stop, /onboardingOpen = false/);
});

test("overlays de atualização são dispensáveis sem remover toast global de outro plugin", () => {
    const updateToast = sliceBetween("function PluginUpdateToast", "function PluginUpdateFailureToast");
    const failureToast = sliceBetween("function PluginUpdateFailureToast", "interface PluginUpdateErrorContext");
    const stop = sliceBetween("    stop()", "\n    }\n});");

    assert.match(source, /const pluginUpdateOverlayDismissers = new Set<\(\) => void>\(\)/);
    assert.match(source, /function dismissPluginUpdateOverlays\(\)/);
    assert.match(updateToast, /pluginUpdateOverlayDismissers\.add\(dismiss\)/);
    assert.match(failureToast, /pluginUpdateOverlayDismissers\.add\(dismiss\)/);
    assert.match(updateToast, /lifecycleGeneration !== pluginLifecycleGeneration/);
    assert.match(failureToast, /lifecycleGeneration !== pluginLifecycleGeneration/);
    assert.doesNotMatch(source, /Toasts\.pop\(\)/);
    assert.match(stop, /dismissPluginUpdateOverlays\(\)/);
    assert.match(stop, /lastNotifiedPendingVersion = null/);
});

test("Card usa apenas variantes suportadas pelo componente do Discord", () => {
    const settings = sliceBetween("function PluginUpdateSettings", "const settings");

    // O invariante e' nao passar ao Card variante que o componente do Discord nao conhece.
    // A fonte ja usou uma var `cardVariant` derivada de `busy` (hoje o Card vai sem variante,
    // usando defaultPadding); prender aquela forma exata quebrava sem indicar defeito.
    assert.match(settings, /<Card\b/);
    assert.doesNotMatch(settings, /"brand"|"primary"/);
    // Se voltar a escolher variante, ela precisa estar no conjunto suportado.
    const usos = [...settings.matchAll(/variant=\{?([^}\n]+)\}?/g)].map(m => m[1]);
    for (const uso of usos) {
        assert.match(uso, /"(normal|info|warning|success)"|cardVariant/);
    }
    assert.match(settings, /role="status" aria-live="polite" aria-busy=\{busy\}/);
});

test("reinício só é alcançado pela ação explícita do overlay", () => {
    const observer = sliceBetween("function schedulePluginUpdateStatusObservation", "interface RegionSelectProps");
    const start = sliceBetween("    start()", "\n    stop() {");

    assert.match(source, /function reloadForPreparedPluginUpdate\(\)/);
    assert.match(source, /restart\(\)/);
    assert.doesNotMatch(observer, /restartDiscord|app\.(quit|relaunch)|window\.location\.reload/);
    assert.doesNotMatch(start, /restartDiscord|app\.(quit|relaunch)|window\.location\.reload/);
});

console.log("plugin UI audit source tests: 6/6");
