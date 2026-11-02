import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { getPluginUpdateStatus } from "../../goLiveBypass/native";

/**
 * Relato beta (painel do plugin): "v2.0.10 · atualização falhou — Último erro do updater:
 * digest da árvore preparada não confere com a fonte atual; nova preparação é necessária".
 *
 * A mensagem prometia nova preparação, mas o marcador ficava no slot ativo: toda consulta
 * seguinte lançava o mesmo erro ANTES de baixar, e nenhum caminho do updater limpava ou
 * quarentenava o journal. Qualquer escrita na árvore depois do preparo (o instalador copia
 * outro conjunto de arquivos, outro checkout compartilha o mesmo data dir, edição manual)
 * deixava o updater travado para sempre, sem saída pela interface.
 *
 * O teste monta um checkout falso e um journal real no data dir do plugin, e cobra o que o
 * painel mostra (`getPluginUpdateStatus`) mais o estado do marcador no disco.
 */

vi.mock("@main/settings", () => ({ RendererSettings: { store: { plugins: {} } } }), { virtual: true });
vi.mock("electron", () => ({
  app: { exit: vi.fn(), quit: vi.fn(), relaunch: vi.fn(), on: vi.fn(), whenReady: () => Promise.withResolvers<void>().promise },
  BrowserWindow: class {
    static fromWebContents() { return null; }
  },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => false },
}));

const raiz = fs.mkdtempSync(path.join(os.tmpdir(), "golive-updater-journal-"));
const dataDir = path.join(raiz, "data", "GoLiveBypass", "plugin-vpn");
const checkout = path.join(raiz, "checkout");
const pluginDir = path.join(checkout, "src", "userplugins", "goLiveBypass");
const journalPath = path.join(dataDir, "plugin-update-pending.json");
const DIGEST_ESPERADO = "0".repeat(64);
const envAntes = { XDG_DATA_HOME: process.env.XDG_DATA_HOME, LOCALAPPDATA: process.env.LOCALAPPDATA, APPDATA: process.env.APPDATA };

let status: typeof getPluginUpdateStatus;

function escreverJournal(conteudo: Record<string, unknown>): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(journalPath, `${JSON.stringify({
    version: "2.0.10-beta-4",
    channel: "beta",
    prerelease: true,
    digest: "a".repeat(64),
    phase: "prepared",
    backupName: "goLiveBypass-1750000000000",
    createdAt: 1_750_000_000_000,
    ...conteudo,
  })}\n`);
}

function marcadoresQuarentenados(motivo: string): string[] {
  if (!fs.existsSync(dataDir)) return [];
  return fs.readdirSync(dataDir).filter(nome => nome.startsWith(`plugin-update-pending.json.${motivo}-`));
}

beforeAll(async () => {
  // Import estático não serve aqui: `VPN_DATA_DIR` e a origem do checkout são resolvidos no
  // carregamento do módulo, e o vitest iça os imports estáticos antes de qualquer setup.
  // XDG_DATA_HOME so vale no Linux; no Windows o plugin usa LOCALAPPDATA/APPDATA, e sem
  // apontar os dois para a raiz o teste lia e escrevia no %LOCALAPPDATA% real.
  process.env.XDG_DATA_HOME = path.join(raiz, "data");
  process.env.LOCALAPPDATA = path.join(raiz, "data");
  process.env.APPDATA = path.join(raiz, "data");
  delete process.env.VENCORD_SOURCE_DIR;
  delete process.env.VENCORD_SRC;
  delete process.env.EQUICORD_SRC;
  process.env.EQUICORD_SOURCE_DIR = checkout;

  fs.mkdirSync(pluginDir, { recursive: true });
  fs.cpSync(path.resolve(process.cwd(), "..", "goLiveBypass"), pluginDir, { recursive: true });
  // No Windows a árvore válida exige o helper compilado, que não está nas fontes do repo.
  const helperWindows = path.join(pluginDir, "bin", "win32-x64", "proton-confgen.exe");
  fs.mkdirSync(path.dirname(helperWindows), { recursive: true });
  fs.writeFileSync(helperWindows, "helper de teste");
  fs.writeFileSync(path.join(checkout, "package.json"), JSON.stringify({ name: "checkout-de-teste", private: true }));

  const native = await import("../../goLiveBypass/native");
  status = native.getPluginUpdateStatus as typeof status;
});

afterAll(() => {
  delete process.env.EQUICORD_SOURCE_DIR;
  for (const [k, v] of Object.entries(envAntes)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(raiz, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(path.join(checkout, ".golivebypass-update-backups"), { recursive: true, force: true });
  if (!fs.existsSync(dataDir)) return;
  for (const nome of fs.readdirSync(dataDir)) {
    if (nome.startsWith("plugin-update-pending.json")) fs.rmSync(path.join(dataDir, nome), { force: true });
  }
});

describe("journal do updater do plugin", () => {
  it("libera nova preparação quando a árvore preparada foi substituída por fora", async () => {
    const backup = path.join(checkout, ".golivebypass-update-backups", "goLiveBypass-1750000000000");
    fs.mkdirSync(backup, { recursive: true });
    fs.writeFileSync(path.join(backup, "index.tsx"), "// versão anterior\n");
    escreverJournal({ sourceDigest: DIGEST_ESPERADO });

    const resultado = await status({} as never);

    expect(resultado.lastError).toBeNull();
    expect(resultado.pending).toBe(false);
    expect(fs.existsSync(journalPath)).toBe(false);
    expect(marcadoresQuarentenados("stale-source")).toHaveLength(1);
    // O backup do update que sumiu não pode virar lixo sem dono na pasta de backups.
    expect(fs.existsSync(backup)).toBe(false);
  });

  it("libera nova preparação quando o download perdeu a fonte em staging", async () => {
    escreverJournal({
      phase: "staged",
      sourceDigest: DIGEST_ESPERADO,
      stagedPath: path.join(checkout, "src", "userplugins", ".golivebypass-update-staging", "ausente", "extract", "goLiveBypass"),
    });

    const resultado = await status({} as never);

    expect(resultado.lastError).toBeNull();
    expect(resultado.pending).toBe(false);
    expect(fs.existsSync(journalPath)).toBe(false);
    expect(marcadoresQuarentenados("missing-staging")).toHaveLength(1);
  });

  it("libera nova preparação para marcador legado sem digest da fonte", async () => {
    escreverJournal({ sourceDigest: undefined, phase: "prepared" });

    const resultado = await status({} as never);

    expect(resultado.lastError).toBeNull();
    expect(fs.existsSync(journalPath)).toBe(false);
    expect(marcadoresQuarentenados("legacy")).toHaveLength(1);
  });

  it("deixa a recuperação cuidar da intenção interrompida, sem quarentenar", async () => {
    // Journal em fase de recuperação (o processo morreu antes da troca da árvore): quem
    // resolve é a recuperação no boot, que descarta a intenção — a quarentena nova não pode
    // roubar esse caminho nem deixar sobra no data dir.
    escreverJournal({ phase: "preparing", sourceDigest: DIGEST_ESPERADO });

    const resultado = await status({} as never);

    expect(resultado.lastError).toBeNull();
    expect(resultado.pending).toBe(false);
    expect(fs.existsSync(journalPath)).toBe(false);
        expect(marcadoresQuarentenados("stale-source")).toHaveLength(0);
        expect(marcadoresQuarentenados("missing-staging")).toHaveLength(0);
    });

    it("cria o log do plugin na primeira escrita de uma instalação nova", async () => {
        // Regressão: a poda da cauda do log lia o arquivo ANTES do append; sem arquivo o
        // readFileSync lançava, o catch engolia a linha e o log nunca nascia — o relato de
        // bug de uma instalação nova saía sem diagnóstico nenhum.
        const logPath = path.join(dataDir, "plugin-vpn.log");
        fs.rmSync(logPath, { force: true });
        escreverJournal({ sourceDigest: undefined, phase: "prepared" });

        const resultado = await status({} as never);

        expect(resultado.lastError).toBeNull();
        expect(fs.existsSync(logPath)).toBe(true);
        expect(fs.readFileSync(logPath, "utf8")).toContain("quarentena");
    });
});
