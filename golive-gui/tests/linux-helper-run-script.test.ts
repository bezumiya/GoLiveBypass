import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import { PassThrough } from "stream";

vi.mock("electron", () => ({ app: { getAppPath: () => "/app" } }));
vi.mock("fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("fs")>();
  return { ...real, default: { ...real, existsSync: () => true }, existsSync: () => true };
});

const filho = vi.hoisted(() => ({ atual: null as null | (EventEmitter & { stdout: PassThrough; stderr: PassThrough; unref: () => void }) }));
vi.mock("child_process", () => ({
  spawn: () => {
    const c = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), unref: () => {} });
    filho.atual = c;
    return c;
  },
}));

import { runScript } from "../electron/linux-helper";

describe("runScript", () => {
  it("caractere UTF-8 dividido entre dois pedacos da saida chega inteiro", async () => {
    const pedacos: string[] = [];
    const resultado = runScript(["--status", "--json"], (s) => pedacos.push(s));
    const c = filho.atual!;
    // "ã" = c3 a3: o pipe pode entregar cada byte numa leitura diferente.
    const json = Buffer.from('{"path":"/home/joão/.config"}');
    const meio = json.indexOf(0xc3) + 1;
    c.stdout.write(json.subarray(0, meio));
    c.stdout.write(json.subarray(meio));
    const aviso = Buffer.from("atenção\n");
    c.stderr.write(aviso.subarray(0, 5));
    c.stderr.write(aviso.subarray(5));
    await new Promise((r) => setImmediate(r));
    c.emit("close", 0);

    const { stdout, stderr } = await resultado;
    expect(stdout).toBe('{"path":"/home/joão/.config"}');
    expect(stderr).toBe("atenção\n");
    expect(pedacos.join("")).not.toContain("�");
  });
});
