import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../goLiveBypass/vpn-windows.ts", import.meta.url), "utf8");
const inspection = source.slice(source.indexOf("export function inspectWireSock"), source.indexOf("export function wireSockSearchRoots"));
const serviceSlot = source.slice(source.indexOf("function assertPluginServiceSlot"), source.indexOf("function runningWireSockProcesses"));

test("falha ao consultar serviço ou processo vira estado desconhecido", () => {
    assert.match(source, /function readWireSockSnapshot\(names: readonly string\[\]\): WireSockSnapshot \| null/);
    assert.match(inspection, /const snapshot = readWireSockSnapshot\(VPN_SERVICE_NAMES\)/);
    assert.match(inspection, /const reliable = serviceStates\.every\(service => service\.running !== null\)/);
    assert.match(inspection, /if \(!reliable\) \{/);
    assert.match(inspection, /active: false/);
    assert.match(inspection, /owned: false/);
    assert.match(inspection, /reliable: false/);
    assert.match(inspection, /estado desconhecido/);
    assert.doesNotMatch(inspection, /active: true,[\s\S]*reliable: false/);
});

test("a inspeção periódica faz uma única consulta ao Windows", () => {
    // Custo medido na VM (recon4): a inspeção completa levava ~1,6s NA THREAD PRINCIPAL do
    // Discord -- sete spawns de PowerShell, ~220ms só para criar cada processo -- e o watchdog
    // repete isso a cada 15s. As consultas por campo (serviceRunning/serviceCommand/
    // serviceProcessId) voltam a inflar esse custo se alguém as reintroduzir aqui.
    assert.match(inspection, /readWireSockSnapshot\(VPN_SERVICE_NAMES\)/);
    assert.doesNotMatch(inspection, /serviceRunning\(/);
    assert.doesNotMatch(inspection, /serviceCommand\(/);
    assert.doesNotMatch(inspection, /serviceProcessId\(/);
    // E o snapshot é uma única chamada: os serviços e os processos saem da MESMA sessão.
    const snapshot = source.slice(source.indexOf("function readWireSockSnapshot"), source.indexOf("function assertPluginServiceSlot"));
    assert.equal((snapshot.match(/execFileSync\(/g) ?? []).length, 1);
    assert.match(snapshot, /services=\$svc; processes=\$procs/);
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


test("o veredito da limpeza não exige o reset do network-lock", () => {
    // O reset exige elevação (UAC) e a config do plugin instala o serviço com
    // "-network-lock disabled" — a sessão própria nunca engata esse lock. Exigi-lo fazia a
    // limpeza falhar com o túnel já derrubado e a rede restaurada, o que virava
    // recovery_required, mantinha o lock do plugin e deixava o Discord preso sem janela.
    //
    // A referência é a GUI: `const stopped = !isWireSockActive() && residual.length === 0`
    // (electron/wiresock.ts), com resetNetworkLock apenas REPORTADO no resultado.
    const veredito = source.match(/const stopped = ([^;]+);/);
    assert.ok(veredito, "linha do veredito não encontrada");
    assert.match(veredito[1], /residual\.reliable/);
    assert.match(veredito[1], /!residual\.active/);
    assert.doesNotMatch(veredito[1], /networkLockReset/);

    // O reset continua sendo tentado e reportado; a falha vira aviso, não erro.
    assert.match(source, /resetNetworkLock\(executable, log\)/);
    assert.match(source, /^\s+networkLockReset,$/m);
    assert.match(source, /o reset do network-lock não foi confirmado/);

    // E o erro do resultado só fala do que sobrou de verdade.
    assert.doesNotMatch(source, /Não foi possível confirmar a restauração do network-lock do WireSock\./);
});

console.log("plugin Windows inspection source tests: 5/5");
