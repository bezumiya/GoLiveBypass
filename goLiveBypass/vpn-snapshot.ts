/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * Leitura da resposta que a inspeção do WireSock recebe do Windows. Fica separado de
 * `vpn-windows.ts` por ser uma unidade pura: o JSON vem do `ConvertTo-Json` do PowerShell 5.1,
 * cujas formas (array de um item virado em objeto, campos nulos, serviço ausente) decidem se o
 * túnel é do plugin -- e isso é testável sem Windows.
 */

export interface WireSockServiceSnapshot {
    name: string;
    running: boolean | null;
    command: string | null;
    processId: number | null;
}

export interface WireSockSnapshot {
    services: WireSockServiceSnapshot[];
    processes: Array<{ pid: number; commandLine: string | null }>;
}

// `ConvertTo-Json` do PowerShell 5.1 não garante array para uma propriedade com um único
// elemento (e um host pode devolver o objeto direto). Aceitar as duas formas evita que a
// leitura inteira vire "desconhecida" numa máquina com exatamente um serviço ou um processo.
function snapshotRows(value: unknown): unknown[] | null {
    if (value === undefined || value === null) return [];
    if (Array.isArray(value)) return value;
    if (typeof value === "object") return [value];
    return null;
}

export function parseWireSockSnapshot(raw: string, expectedServices: readonly string[]): WireSockSnapshot | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw) as unknown;
    } catch {
        return null;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const value = parsed as { services?: unknown; processes?: unknown };
    const serviceRows = snapshotRows(value.services);
    const processRows = snapshotRows(value.processes);
    if (serviceRows === null || processRows === null) return null;
    const services = serviceRows.flatMap(row => {
        if (row === null || typeof row !== "object") return [];
        const item = row as { name?: unknown; state?: unknown; command?: unknown; processId?: unknown };
        if (typeof item.name !== "string" || item.name.length === 0) return [];
        const state = typeof item.state === "string" ? item.state : "";
        // "Missing" é resposta definitiva (o serviço não existe), como o código 1060 do
        // sc.exe; qualquer outro valor -- inclusive estado transicional -- é desconhecido.
        const running = /^Running$/i.test(state) ? true : /^(?:Stopped|Missing)$/i.test(state) ? false : null;
        const pid = Number(item.processId);
        return [{
            name: item.name,
            running,
            command: typeof item.command === "string" && item.command.trim().length > 0 ? item.command : null,
            processId: Number.isInteger(pid) && pid > 0 ? pid : null,
        }];
    });
    // Resposta que não cobre exatamente os serviços pedidos é leitura parcial: não serve para
    // concluir ausência, mesmo que o resto do JSON esteja bem formado.
    if (services.length !== expectedServices.length) return null;
    if (expectedServices.some(name => !services.some(service => service.name === name))) return null;
    const processes = processRows.flatMap(row => {
        if (row === null || typeof row !== "object") return [];
        const item = row as { pid?: unknown; commandLine?: unknown };
        const pid = Number(item.pid);
        if (!Number.isInteger(pid) || pid <= 0) return [];
        return [{ pid, commandLine: typeof item.commandLine === "string" ? item.commandLine : null }];
    });
    return { services, processes };
}
