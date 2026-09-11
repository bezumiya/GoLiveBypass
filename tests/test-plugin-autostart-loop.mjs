import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const controller = readFileSync(new URL("../goLiveBypass/vpn-controller.ts", import.meta.url), "utf8");
const nativeSource = readFileSync(new URL("../goLiveBypass/native.ts", import.meta.url), "utf8");
const renderer = readFileSync(new URL("../goLiveBypass/index.tsx", import.meta.url), "utf8");

// Relato real na VM Windows: depois de injetar e ativar, o Discord não fechava (só pelo
// gerenciador de tarefas) e a interface não voltava. O log do plugin mostrou 87 boots com o
// ciclo stop -> start -> relaunch a cada ~31s, por horas: `enable()` (usado pelo botão E pelo
// boot) limpava a suspensão de autostart e relançava o Discord em toda ativação, então um
// relaunch não confirmado virava laço infinito -- cada processo novo lançava outro.
const automaticBlock = controller.slice(
    controller.indexOf("public enableAutomatic()"),
    controller.indexOf("public shutdown("),
);

test("ativação automática do boot não relança o Discord nem libera o autostart", () => {
    assert.ok(automaticBlock.length > 0, "enableAutomatic não encontrado");
    // Nunca relança: o relaunch é da ativação explícita do usuário.
    assert.doesNotMatch(automaticBlock, /startInternal\(true\)/);
    assert.doesNotMatch(automaticBlock, /requestRelaunch/);
    // Não limpa a suspensão -- limpá-la era o que fechava o ciclo de reinícios.
    assert.doesNotMatch(automaticBlock, /automaticBootSuppressed = false/);
    assert.match(automaticBlock, /if \(this\.automaticBootSuppressed\)/);
    assert.match(automaticBlock, /suppressed: true/);
    // E só adota túnel já ativo: subir o túnel sem relaunch deixaria o Discord fora do filtro.
    assert.match(automaticBlock, /if \(!inspection\.active \|\| !inspection\.owned\)/);
    assert.match(automaticBlock, /this\.startInternal\(false\)/);
});

test("o caminho explícito do usuário continua relançando e liberando o autostart", () => {
    const explicit = controller.slice(
        controller.indexOf("public enable(): Promise<VpnOperationResult>"),
        controller.indexOf("public enableAutomatic()"),
    );
    assert.match(explicit, /this\.automaticBootSuppressed = false;/);
    assert.match(explicit, /this\.startInternal\(true\)/);
});

test("boot e renderer chamam a ativação automática, não o enable do usuário", () => {
    const boot = nativeSource.slice(nativeSource.indexOf("pluginRuntimeVersion = currentPluginVersion()"));
    assert.match(nativeSource, /export function enableAutomatic\(_?: IpcMainInvokeEvent\)/);
    assert.match(boot, /await controller\.enableAutomatic\(\)/);
    assert.doesNotMatch(boot, /await controller\.enable\(\)/);
    assert.match(boot, /!result\.success && !result\.suppressed/);
    assert.match(renderer, /enableAutomatic/);
});

test("falha de ativação não derruba o túnel de outra instância", () => {
    // O catch de startInternal derrubava qualquer WireSock ativo, inclusive o de outra
    // instância viva que tinha recusado o lock -- matar essa VPN alimentava o laço.
    const start = controller.slice(controller.indexOf("private async startInternal"));
    const recovery = start.slice(start.indexOf("} catch (error)"));
    assert.match(recovery, /const ownsCurrentTunnel = sameOwnership\(this\.ownershipToken, this\.readOwner\(\)\)/);
    assert.match(recovery, /if \(started \|\| \(currentInspection\.reliable && currentInspection\.active && currentInspection\.owned && ownsCurrentTunnel\)\)/);
});
