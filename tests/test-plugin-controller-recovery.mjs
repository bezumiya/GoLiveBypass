import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../goLiveBypass/vpn-controller.ts", import.meta.url), "utf8");
const initialize = source.slice(source.indexOf("public initialize()"), source.indexOf("\n    public getStatus"));
const initializeInternal = source.slice(source.indexOf("private async initializeInternal"), source.indexOf("\n    public getStatus"));
const optimization = source.slice(source.indexOf("public async optimizeProton"), source.indexOf("\n    public cancelOptimization"));

test("falha no boot libera uma nova tentativa de inicialização", () => {
    const recovery = initializeInternal.slice(initializeInternal.indexOf("} catch (error)"));
    assert.match(recovery, /this\.initialized = false;/);
    assert.match(recovery, /this\.state = "recovery_required";/);
});

test("relaunch não confirmado suspende autostart, mas enable manual libera retry", () => {
    assert.match(initialize, /const relaunchWasNotConfirmed = owner\?\.restarting === true/);
    assert.match(initialize, /if \(relaunchWasNotConfirmed\) this\.automaticBootSuppressed = true;/);
    assert.match(initialize, /this\.state = "recovery_required";[\s\S]*ativação automática suspensa/);
    assert.match(source, /public shouldSkipAutomaticEnable\(\): boolean/);
    const enable = source.slice(
        source.indexOf("public enable(): Promise<VpnOperationResult>"),
        source.indexOf("public shutdown(", source.indexOf("public enable(): Promise<VpnOperationResult>")),
    );
    assert.match(enable, /this\.automaticBootSuppressed = false;/);
});

test("falha ao restaurar uma VPN própria com o plugin desativado não sela o boot", () => {
    assert.match(initialize, /const cleanup = await this\.stopInternal\(false\);/);
    assert.match(initialize, /if \(!cleanup\.success\) this\.initialized = false;/);
});

test("o retry não altera a regra de não assumir WireSock externo", () => {
    assert.match(source, /if \(inspection\.reliable && inspection\.active && !inspection\.owned\)/);
    assert.match(source, /this\.blockExternal/);
    assert.match(source, /if \(isUnknownWireSockInspection\(inspection\)\)/);
    assert.match(source, /estado do WireSock é desconhecido/);
    assert.doesNotMatch(initialize, /taskkill|process\.kill/);
});

test("diagnóstico assíncrono ignora resposta depois de stop ou troca de geração", () => {
    assert.match(source, /private diagnosticGeneration = 0;/);
    assert.match(source, /const diagnosticGeneration = this\.diagnosticGeneration;/);
    assert.match(source, /const isCurrent = \(\) => this\.diagnosticGeneration === diagnosticGeneration/);
    assert.match(source, /if \(!isCurrent\(\)\) return;/);
    assert.match(source, /this\.diagnosticGeneration\+\+;/);
});

test("restaurar uma rota ativa após otimização não solicita relaunch", () => {
    const start = optimization.indexOf("const restorePreviousRoute");
    const end = optimization.indexOf("if (operationController.signal.aborted)", start);
    const restore = optimization.slice(start, end);
    assert.match(restore, /this\.startInternal\(false\)/);
    assert.doesNotMatch(restore, /this\.startInternal\(true\)/);
});

test("restaurar, reiniciar ou fechar cancela uma otimização pendente antes da fila", () => {
    assert.match(source, /public shutdown\(relaunch = true\): Promise<VpnOperationResult> \{\s*this\.cancelProtonLogin\(\);\s*this\.optimization\?\.controller\.abort\(\);/);
    assert.match(source, /public restoreNetwork\(\): Promise<VpnOperationResult> \{\s*this\.cancelProtonLogin\(\);\s*this\.optimization\?\.controller\.abort\(\);/);
    assert.match(source, /public restartDiscord\(\): Promise<VpnOperationResult> \{\s*this\.cancelProtonLogin\(\);\s*this\.optimization\?\.controller\.abort\(\);/);
});

test("modo customizado sem caminho não reutiliza um perfil Proton antigo", () => {
    const activation = source.slice(source.indexOf("private async startInternal"), source.indexOf("private async stopInternal"));
    assert.match(activation, /if \(!settings\.customConfigPath\) throw new Error\("Configure um arquivo WireGuard personalizado antes de ativar\."\)/);
});

console.log("plugin controller recovery tests: 8/8");
