// Para testes que simulam o spawn do helper: o produto ainda exige um arquivo de helper
// existente e, sem ele, tentaria baixar o runtime pela rede (lento e dependente de
// ambiente; no macOS nem há runtime). O stub é um arquivo temporário qualquer, pois o
// spawn é simulado. Uso: vi.mock("../electron/proton-runtime", async (original) =>
//   (await import("./helpers/confgen-runtime-stub")).stubProtonRuntime(await original<object>()));
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let stubDir = "";
let stubExe = "";
let embutidoAusente = false;

export function stubProtonRuntime<T extends object>(original: T): T {
  stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "golive-confgen-stub-"));
  stubExe = path.join(stubDir, process.platform === "win32" ? "proton-confgen.exe" : "proton-confgen");
  fs.writeFileSync(stubExe, "stub");
  return {
    ...original,
    findProtonConfgenPath: () => (embutidoAusente ? undefined : stubExe),
    ensureProtonConfgen: async () => stubExe,
  };
}

/** Pacote que perdeu o helper embutido (antivírus, extração incompleta): só o caminho de reparo acha. */
export function simularHelperEmbutidoAusente(ausente: boolean): void {
  embutidoAusente = ausente;
}

export function caminhoDoConfgenStub(): string {
  return stubExe;
}

export function removeConfgenStub(): void {
  if (stubDir) fs.rmSync(stubDir, { recursive: true, force: true });
}
