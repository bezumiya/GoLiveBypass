import assert from "node:assert/strict";
import { test } from "node:test";

import { parseWireSockSnapshot } from "../goLiveBypass/vpn-snapshot.ts";

const NAMES = ["wiresock-client-service", "wiresock-pro-client-service"];
const PARADO = { name: "wiresock-pro-client-service", state: "Stopped", command: "C:\\outro\\wiresock.exe", processId: 0 };

// O JSON vem do `ConvertTo-Json` do PowerShell 5.1. As formas abaixo são as que ele realmente
// produz -- inclusive a de um único item, em que o array pode vir virado em objeto -- e é o
// que a inspeção lê a cada 15s para decidir se o túnel é do plugin. Errar a leitura aqui é o
// que faz o controller classificar um WireSock alheio como próprio (ou o contrário).
test("lê um único processo quando o JSON não preserva o array", () => {
    const raw = JSON.stringify({
        services: [
            { name: "wiresock-client-service", state: "Running", command: "C:\\Program Files\\WireSock\\wiresock-client.exe service -config C:\\plugin\\wiresock-discord.conf", processId: 4321 },
            { name: "wiresock-pro-client-service", state: "Missing", command: null, processId: 0 },
        ],
        // Um único processo é o caso real (um túnel = um wiresock-client.exe): o PowerShell
        // pode devolver o objeto direto em vez de uma lista de um item.
        processes: { pid: 4321, commandLine: "C:\\Program Files\\WireSock\\wiresock-client.exe" },
    });
    const snapshot = parseWireSockSnapshot(raw, NAMES);
    assert.ok(snapshot, "snapshot deveria ser aceito");
    assert.equal(snapshot.services.length, 2);
    assert.deepEqual(snapshot.processes, [{ pid: 4321, commandLine: "C:\\Program Files\\WireSock\\wiresock-client.exe" }]);
});

test("lê as duas formas de lista e distingue serviço ausente de serviço parado", () => {
    const raw = JSON.stringify({
        services: [
            { name: "wiresock-client-service", state: "Running", command: "C:\\w\\wiresock.exe service -config C:\\plugin\\wiresock-discord.conf", processId: 99 },
            PARADO,
        ],
        processes: [],
    });
    const snapshot = parseWireSockSnapshot(raw, NAMES);
    assert.ok(snapshot);
    assert.deepEqual(snapshot.services.map(service => [service.name, service.running]), [
        ["wiresock-client-service", true],
        ["wiresock-pro-client-service", false],
    ]);
    assert.deepEqual(snapshot.processes, []);

    // "Missing" é o que o script emite quando o nome não existe no host: resposta definitiva,
    // como o código 1060 do sc.exe -- não pode virar leitura desconhecida, senão o plugin
    // fica "recovery_required" numa máquina que simplesmente nunca instalou o serviço.
    const ausente = parseWireSockSnapshot(JSON.stringify({
        services: [
            { name: NAMES[0], state: "Missing", command: null, processId: 0 },
            { name: NAMES[1], state: "Missing", command: null, processId: 0 },
        ],
        processes: [],
    }), NAMES);
    assert.ok(ausente, "serviço ausente é resposta definitiva, não leitura desconhecida");
    assert.equal(ausente.services[0].running, false);
    assert.equal(ausente.services[0].command, null);
});

test("estado transicional não vira ausência nem presença", () => {
    const raw = JSON.stringify({
        services: [
            { name: NAMES[0], state: "Start Pending", command: "C:\\w\\wiresock.exe", processId: 7 },
            PARADO,
        ],
        processes: [],
    });
    const snapshot = parseWireSockSnapshot(raw, NAMES);
    assert.ok(snapshot);
    assert.equal(snapshot.services[0].running, null, "meio-ativo não pode ser lido como parado");
});

test("leitura parcial ou corrompida vira null, não ausência", () => {
    // Só um dos dois serviços respondidos: não dá para concluir que o outro está parado.
    const parcial = JSON.stringify({
        services: [{ name: NAMES[0], state: "Stopped", command: "C:\\w\\wiresock.exe", processId: 0 }],
        processes: [],
    });
    assert.equal(parseWireSockSnapshot(parcial, NAMES), null);

    // Serviço trocado por outro nome: também não cobre o que foi pedido.
    const trocado = JSON.stringify({
        services: [
            { name: "wiresock-client-service", state: "Running", command: "C:\\w\\wiresock.exe", processId: 1 },
            { name: "outro-servico", state: "Running", command: "C:\\x", processId: 2 },
        ],
        processes: [],
    });
    assert.equal(parseWireSockSnapshot(trocado, NAMES), null);

    assert.equal(parseWireSockSnapshot("", NAMES), null);
    assert.equal(parseWireSockSnapshot("PowerShell parou no meio", NAMES), null);
    assert.equal(parseWireSockSnapshot("[]", NAMES), null);
    assert.equal(parseWireSockSnapshot(JSON.stringify({ services: NAMES.map(name => ({ name, state: "Stopped", command: null, processId: 0 })), processes: "?" }), NAMES), null);
});

test("processo sem linha de comando continua sendo reportado", () => {
    const raw = JSON.stringify({
        services: NAMES.map(name => ({ name, state: "Stopped", command: null, processId: 0 })),
        processes: [{ pid: 501, commandLine: null }, { pid: "não-numérico", commandLine: "x" }, { pid: -3 }],
    });
    const snapshot = parseWireSockSnapshot(raw, NAMES);
    assert.ok(snapshot);
    // O pid sem commandLine é o caso que a inspeção trata como dono via ProcessId do serviço;
    // entradas sem pid válido são descartadas em vez de virar um processo fantasma.
    assert.deepEqual(snapshot.processes, [{ pid: 501, commandLine: null }]);
});
