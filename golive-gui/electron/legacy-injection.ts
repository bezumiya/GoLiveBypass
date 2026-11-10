import path from "node:path";

/**
 * Injeção legada (proxy/PAC/Tor) que sobrou de versões antigas no Windows.
 *
 * A GUI atual não mexe em app.asar/_app.asar de propósito (restaurar apagava mods de terceiros
 * e dava falso positivo). Só que a injeção antiga continua rodando: o `golivebypass.js` copiado
 * para a pasta `app.asar` lê o `settings.json` da MESMA pasta, que nenhuma versão atual
 * atualiza, e segue roteando o gateway por SOCKS gratuito/Tor por cima do túnel WireGuard
 * (#379, #399: o relato vinha dominado por "escolhida socks5://..."). O runtime legado
 * respeita `enabled: false` ("desligado em settings.json, nao vou mexer em nada") e ainda
 * carrega o Discord original. Gravar isso na cópia dele desliga o roteamento sem tocar em
 * app.asar/_app.asar e sem chance de afetar mod de terceiro: só a pasta que é comprovadamente
 * nossa é alterada.
 */

export type LegacyInjectionResult = "neutralizada" | "ja_neutra" | "nao_nossa" | "erro";

export interface LegacyInjectionFs {
  existsSync(target: string): boolean;
  statSync(target: string): { isDirectory(): boolean; isFile(): boolean };
  readFileSync(target: string, encoding: "utf8"): string;
  writeFileSync(target: string, data: string): void;
  renameSync(from: string, to: string): void;
}

const PATCHER_NAME = "golivebypass.js";

export function isOurLegacyInjection(resources: string, fs: LegacyInjectionFs): boolean {
  try {
    const stub = path.join(resources, "app.asar");
    const original = path.join(resources, "_app.asar");
    if (!fs.existsSync(original) || !fs.existsSync(stub)) return false;
    if (!fs.statSync(stub).isDirectory()) return false;
    const index = path.join(stub, "index.js");
    if (!fs.existsSync(index) || !fs.existsSync(path.join(stub, PATCHER_NAME))) return false;
    return fs.readFileSync(index, "utf8").includes(PATCHER_NAME);
  } catch {
    return false;
  }
}

export function neutralizeLegacyInjection(resources: string, fs: LegacyInjectionFs): LegacyInjectionResult {
  if (!isOurLegacyInjection(resources, fs)) return "nao_nossa";
  const file = path.join(resources, "app.asar", "settings.json");
  try {
    let atual: Record<string, unknown> = {};
    if (fs.existsSync(file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) atual = parsed as Record<string, unknown>;
      } catch {
        // settings corrompido: o runtime cai no padrão (rotear); sobrescrever é o que o desliga.
      }
    }
    if (atual.enabled === false) return "ja_neutra";
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...atual, enabled: false }, null, 4));
    fs.renameSync(tmp, file);
    return "neutralizada";
  } catch {
    return "erro";
  }
}
