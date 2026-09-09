import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../goLiveBypass/vpn-windows.ts", import.meta.url), "utf8");
const inspection = source.slice(source.indexOf("export function inspectWireSock"), source.indexOf("export function wireSockSearchRoots"));
const serviceSlot = source.slice(source.indexOf("function assertPluginServiceSlot"), source.indexOf("function runningWireSockProcesses"));

test("falha ao consultar serviço ou processo vira estado desconhecido", () => {
    assert.match(source, /function serviceRunning\(name: string\): boolean \| null/);
    assert.match(source, /function runningWireSockProcesses\(\): Array<.*> \| null/);
    assert.match(inspection, /const reliable = serviceStateReliable && processSnapshot !== null/);
    assert.match(inspection, /if \(!reliable\) \{/);
    assert.match(inspection, /active: false/);
    assert.match(inspection, /owned: false/);
    assert.match(inspection, /reliable: false/);
    assert.match(inspection, /estado desconhecido/);
    assert.doesNotMatch(inspection, /active: true,[\s\S]*reliable: false/);
});

test("slot de serviço também bloqueia estado de serviço desconhecido", () => {
    assert.match(serviceSlot, /const running = serviceRunning\(name\)/);
    assert.match(serviceSlot, /if \(running === null\) throw new Error/);
    assert.match(serviceSlot, /if \(!running\) return/);
});

test("inspeção própria só é confirmada quando todos os processos conhecidos são do perfil", () => {
    assert.match(inspection, /const allServicesOwned = services\.every/);
    assert.match(inspection, /const allProcessesOwned = processes\.every/);
    assert.match(inspection, /reliable: true, services, processIds, reason: null/);
    assert.match(inspection, /WireSock próprio e externo foram detectados ao mesmo tempo/);
});

test("limpeza não assume ausência quando a inspeção é desconhecida", () => {
    assert.match(source, /const initial = inspectWireSock\(configPath\);[\s\S]*?if \(!initial\.reliable\) \{[\s\S]*?stopped: false/);
    assert.match(source, /const residual = inspectWireSock\(configPath\);[\s\S]*?const stopped = residual\.reliable && !residual\.active/);
});

console.log("plugin Windows inspection source tests: 4/4");
