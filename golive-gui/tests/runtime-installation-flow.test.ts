import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.cwd(), "..");
const proton = fs.readFileSync(path.join(root, "golive-gui/electron/proton.ts"), "utf8");
const main = fs.readFileSync(path.join(root, "golive-gui/electron/main.ts"), "utf8");
const standalone = fs.readFileSync(path.join(root, "standalone/golivebypass-standalone.sh"), "utf8");

function sliceBetween(source: string, start: string, end: string): string {
  const startAt = source.indexOf(start);
  const endAt = source.indexOf(end, startAt + start.length);
  return source.slice(startAt, endAt < 0 ? undefined : endAt);
}

describe("preparação automática do ambiente", () => {
  it("prepara o helper Proton antes de cada operação que o executa", () => {
    for (const start of [
      "export async function checkProtonSession",
      "export async function getProtonPlan",
      "export async function loginProton",
      "export async function generateOptimalProtonConfig",
      "export async function generateProtonRoutePool",
    ]) {
      const section = sliceBetween(proton, start, "\nexport ");
      expect(section, start).toContain("ensureProtonConfgen");
    }
    expect(proton).toContain("sourceExePath || findProtonConfgenExe()");
  });

  it("mantém a instalação automática do WireSock antes de iniciar o serviço Windows", () => {
    const activation = sliceBetween(main, "async function activateBypass", "async function deactivateAll");
    expect(activation).toContain("ensureWireSockInstalled");
    expect(activation.indexOf("ensureWireSockInstalled")).toBeLessThan(activation.indexOf("startWireSockService"));
  });

  it("instala dependências Linux somente pelo caminho interno da GUI", () => {
    const activation = sliceBetween(main, "async function linuxActivate", "async function linuxDeactivate");
    expect(activation.indexOf("--ensure-dependencies")).toBeLessThan(activation.indexOf("--cleanup-legacy"));
    expect(standalone).toContain('if [ "${GOLIVE_GUI:-}" != "1" ]; then');
    expect(standalone).toContain("linux_ensure_dependencies");
    expect(standalone).toContain("elevate \"$package_manager\"");
  });
});
