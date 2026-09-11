import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../goLiveBypass/index.tsx", import.meta.url), "utf8");
const nativeSource = readFileSync(new URL("../goLiveBypass/native.ts", import.meta.url), "utf8");

test("start e stop toleram bridge nativa ausente", () => {
    assert.match(source, /if \(!onboardingRequired && typeof Native\?\.enable === "function"\)/);
    assert.match(source, /if \(typeof Native\?\.shutdown === "function"\)/);
    assert.match(source, /if \(typeof Native\?\.logFromRenderer === "function"\)/);
    assert.match(source, /typeof Native\?\.cancelProtonOptimization !== "function"/);
    assert.match(source, /Promise\.resolve\(Native\.cancelProtonOptimization\(activeRequestId\)\)\.catch/);
    assert.doesNotMatch(source, /Native\?\.enable\(\)\.then/);
    assert.doesNotMatch(source, /Native\?\.shutdown\(\)\.catch/);
    assert.doesNotMatch(source, /Native\?\.logFromRenderer\(message\)\.catch/);
});

test("desativar o plugin não solicita relaunch automático", () => {
    const shutdown = nativeSource.slice(nativeSource.indexOf("export function shutdown"), nativeSource.indexOf("export function restoreNetwork"));
    const restart = nativeSource.slice(nativeSource.indexOf("export function restartDiscord"), nativeSource.indexOf("export function getVpnStatus"));
    // Desativar o userplugin não reinicia o Discord no Windows (para não interromper chamadas
    // em andamento); só o Linux pede o relaunch externo, porque um processo dentro do netns
    // não consegue voltar à rede host sozinho. A asserção antiga exigia o literal
    // `shutdown(false)` e ficou obsoleta quando o argumento virou a condição de plataforma --
    // ela falhava sem que o comportamento tivesse mudado.
    assert.match(shutdown, /controller\.shutdown\(process\.platform === "linux"\)/);
    assert.match(shutdown, /controller\.cancelProtonLogin\(\)/);
    assert.doesNotMatch(shutdown, /controller\.shutdown\(true\)/);
    assert.match(restart, /controller\.restartDiscord\(\)/);
});

test("cancelamento de login é exposto ao renderer e ao fechamento do processo", () => {
    assert.match(nativeSource, /export function cancelProtonLogin\(/);
    assert.match(nativeSource, /controller\.cancelProtonLogin\(typeof requestId === "string"/);
    const beforeQuit = nativeSource.slice(nativeSource.indexOf('app.on("before-quit"'), nativeSource.indexOf("app.on(\"before-quit\"") + 2_000);
    assert.match(beforeQuit, /controller\.cancelProtonLogin\(\)/);
    assert.match(source, /const loginRequestIdRef = React\.useRef<string \| null>\(null\)/);
    assert.match(source, /Native\.loginProton\(\{ username: username\.trim\(\), password, twoFactorCode, requestId: loginRequestId \}\)/);
    assert.match(source, /const cancelActiveLogin = \(\) =>/);
});

test("start e stop invalidam callbacks assíncronos de uma geração anterior", () => {
    const startBlock = source.slice(source.indexOf("    start()"), source.indexOf("    stop()"));
    const stopBlock = source.slice(source.indexOf("    stop()"));

    assert.match(source, /let pluginLifecycleGeneration = 0/);
    assert.match(startBlock, /const lifecycleGeneration = \+\+pluginLifecycleGeneration/);
    assert.match(startBlock, /const isLifecycleCurrent = \(\) => lifecycleGeneration === pluginLifecycleGeneration/);
    assert.match(startBlock, /if \(isLifecycleCurrent\(\) && settings\.store\.onboardingCompleted !== true\) openPluginOnboarding\(\)/);
    assert.match(source, /function schedulePluginUpdateStatusObservation\(lifecycleGeneration: number\)/);
    assert.match(source, /const statusRequest = readPluginUpdateStatus\(\);\n\s+if \(!statusRequest\) \{[\s\S]*?statusRequest\.then\(status => \{\n\s+if \(lifecycleGeneration !== pluginLifecycleGeneration\) return;/);
    assert.match(startBlock, /schedulePluginUpdateStatusObservation\(lifecycleGeneration\)/);
    assert.match(startBlock, /Native\.enable\(\)\.then\(result => \{\n\s+if \(!isLifecycleCurrent\(\)\) return;/);
    assert.match(source, /if \(lifecycleGeneration === pluginLifecycleGeneration\) logger\.error\("Falha ao consultar atualização pendente do plugin"/);
    assert.match(startBlock, /if \(isLifecycleCurrent\(\)\) logger\.error\("Failed to reach the desktop process"/);
    assert.match(stopBlock, /pluginLifecycleGeneration\+\+/);
    assert.match(stopBlock, /lastNotifiedUpdateErrorKey = null/);
    assert.match(stopBlock, /lastSuppressedUpdateErrorKey = null/);
});

test("o fechamento do Discord sempre conclui, mesmo sem confirmar a restauração", () => {
    // Relato real: com a VPN ativa, fechar o Discord cancelava o quit (event.preventDefault)
    // e, quando a restauração não confirmava, o quit era ABANDONADO -- `quitting = false` e
    // nada re-tentava. Como as janelas já tinham sido destruídas, o app ficava vivo sem
    // interface: não fechava (só pelo gerenciador de tarefas) e não reabria, porque o processo
    // antigo continuava segurando o lugar. O log do plugin registrava
    // "fechamento aguardou porque a restauração da VPN não foi confirmada".
    //
    // A referência é o before-quit da GUI: restore.catch(log).finally(app.quit). O quit
    // completa sempre; o que sobrar é adotado no boot seguinte.
    const beforeQuit = nativeSource.slice(
        nativeSource.indexOf('app.on("before-quit"'),
        nativeSource.indexOf('app.whenReady()'),
    );
    assert.ok(beforeQuit.length > 0, "before-quit não encontrado");

    // A restauração continua sendo tentada antes da saída.
    assert.match(beforeQuit, /controller\.shutdown\(false\)/);
    assert.match(beforeQuit, /event\.preventDefault\(\)/);

    // Nenhuma saída de emergência pode reverter o quit: era isso que deixava o processo vivo.
    assert.doesNotMatch(beforeQuit, /quitting = false/);

    // E a saída precisa acontecer nos dois caminhos (sucesso e falha).
    assert.match(beforeQuit, /\.finally\(\(\) => \{\s*app\.exit\(0\);\s*\}\)/);
});

test("lock assumido por outra instância não vira falha de restauração", () => {
    // Cadeia real do relato (log do plugin na VM):
    //   18:24:07 abrindo plugin VPN            -> a instância nova do relaunch sobe
    //   18:24:08 probe ... stage=adoption      -> ela adota o WireSock e grava o próprio pid
    //   18:24:14 WireSock ... verificados como parados
    //   18:24:14 erro=A rede foi restaurada, mas o lock da VPN ficou pendente
    //   18:24:19 Outra instância do GoLiveBypass já controla a VPN (a VPN nunca mais ativou)
    //
    // A instância que sai tentava liberar um lock que a nova já tinha assumido. Tratar isso
    // como falha marcava recovery_required e (com o quit abandonado no before-quit) deixava o
    // processo vivo sem interface -- só matável pelo gerenciador de tarefas.
    const controllerSource = readFileSync(new URL("../goLiveBypass/vpn-controller.ts", import.meta.url), "utf8");

    assert.match(controllerSource, /private ownershipTakenOver\(owner: VpnOwnerRecord\): boolean/);
    assert.match(controllerSource, /const current = this\.readOwner\(\);\s*return current !== null && !sameOwnership\(current, owner\);/);

    // Cada caminho de parada precisa distinguir "não consegui liberar" de "passou para outra":
    // rede ativa, rede já inativa e o caminho Linux.
    const guards = controllerSource.match(/if \(this\.ownershipTakenOver\(owner\)\) \{/g) ?? [];
    assert.equal(guards.length, 3, `guarda de handover esperada nos três caminhos de parada, achei ${guards.length}`);

    // E o caso legítimo (lock inválido que não é de ninguém) continua falhando.
    assert.match(controllerSource, /A rede foi restaurada, mas o lock da VPN ficou pendente\./);
    assert.match(controllerSource, /A rede está inativa, mas o lock da VPN ficou pendente\./);
    assert.match(controllerSource, /A rede foi restaurada, mas o owner Linux ficou pendente\./);
});

console.log("plugin lifecycle source tests: 6/6");
