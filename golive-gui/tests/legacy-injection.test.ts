import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isOurLegacyInjection, neutralizeLegacyInjection } from "../electron/legacy-injection";

const raizes: string[] = [];
afterEach(() => {
  for (const raiz of raizes.splice(0)) fs.rmSync(raiz, { recursive: true, force: true });
});

function resources(): string {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), "golive-legacy-"));
  raizes.push(raiz);
  const dir = path.join(raiz, "app-1.0.9000", "resources");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function injecaoNossa(dir: string, settings?: unknown): void {
  fs.writeFileSync(path.join(dir, "_app.asar"), "asar original");
  fs.mkdirSync(path.join(dir, "app.asar"));
  fs.writeFileSync(path.join(dir, "app.asar", "index.js"), 'require("./golivebypass.js");\n');
  fs.writeFileSync(path.join(dir, "app.asar", "golivebypass.js"), "// runtime legado\n");
  if (settings !== undefined) fs.writeFileSync(path.join(dir, "app.asar", "settings.json"), JSON.stringify(settings));
}

const lerSettings = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, "app.asar", "settings.json"), "utf8"));

describe("injeção legada que sobrou no Windows (#379/#399)", () => {
  it("desliga a cópia nossa preservando o resto das settings, sem tocar no asar", () => {
    const dir = resources();
    injecaoNossa(dir, { routeMode: "free", excludedCountries: "BR" });
    expect(neutralizeLegacyInjection(dir, fs)).toBe("neutralizada");
    expect(lerSettings(dir)).toEqual({ routeMode: "free", excludedCountries: "BR", enabled: false });
    expect(fs.readFileSync(path.join(dir, "_app.asar"), "utf8")).toBe("asar original");
    expect(fs.existsSync(path.join(dir, "app.asar", "index.js"))).toBe(true);
    // Idempotente: a segunda ativação não regrava nada.
    expect(neutralizeLegacyInjection(dir, fs)).toBe("ja_neutra");
  });

  it("sem settings.json (ou corrompido) cria um que desliga", () => {
    const dir = resources();
    injecaoNossa(dir);
    expect(neutralizeLegacyInjection(dir, fs)).toBe("neutralizada");
    expect(lerSettings(dir)).toEqual({ enabled: false });

    const outro = resources();
    injecaoNossa(outro);
    fs.writeFileSync(path.join(outro, "app.asar", "settings.json"), "{ quebrado");
    expect(neutralizeLegacyInjection(outro, fs)).toBe("neutralizada");
    expect(lerSettings(outro)).toEqual({ enabled: false });
  });

  it("Discord vanilla e mod de terceiro ficam intocados", () => {
    const vanilla = resources();
    fs.writeFileSync(path.join(vanilla, "app.asar"), "asar vanilla");
    expect(isOurLegacyInjection(vanilla, fs)).toBe(false);
    expect(neutralizeLegacyInjection(vanilla, fs)).toBe("nao_nossa");

    // Vencord/Equicord: mesma estrutura de pasta + _app.asar, mas sem o nosso runtime.
    const mod = resources();
    fs.writeFileSync(path.join(mod, "_app.asar"), "asar original");
    fs.mkdirSync(path.join(mod, "app.asar"));
    fs.writeFileSync(path.join(mod, "app.asar", "index.js"), 'require("C:/Vencord/patcher.js");\n');
    fs.writeFileSync(path.join(mod, "app.asar", "package.json"), '{"name":"discord","main":"index.js"}');
    expect(neutralizeLegacyInjection(mod, fs)).toBe("nao_nossa");
    expect(fs.existsSync(path.join(mod, "app.asar", "settings.json"))).toBe(false);
  });
});
