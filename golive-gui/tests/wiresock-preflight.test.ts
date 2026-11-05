import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { isSupportedWireSockVersion, MIN_WIRESOCK_SDK, parseWireSockVersion, selectSupportedWireSock, type WireSockVersion } from "../electron/wiresock-preflight";

const version = (major: number, minor: number, patch: number, build = 0): WireSockVersion => ({ major, minor, patch, build });

describe("WireSock SDK preflight", () => {
  it("registra descoberta, fontes indisponíveis e versões sem incluir o perfil", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "electron/wiresock-preflight.ts"), "utf8");
    expect(source).toContain('logger.logEvent("info", "wiresock", "preflight.start"');
    expect(source).toContain('logger.logEvent("warn", "wiresock", "diagnostic.source_unavailable"');
    expect(source).toContain("executableVersion");
    expect(source).toContain("boosterVersion");
    expect(source).not.toContain("PrivateKey");
  });

  it("rejeita a versão legada 1.4.7.1 antes do serviço", () => {
    expect(isSupportedWireSockVersion(version(1, 4, 7, 1))).toBe(false);
    expect(() => selectSupportedWireSock([{ executable: "legacy.exe", booster: "wgbooster.dll", executableVersion: version(1, 4, 7, 1), boosterVersion: version(1, 4, 7, 1) }])).toThrow(/3\.8\.2\.1/);
    expect(isSupportedWireSockVersion(parseWireSockVersion("3.8.2.1-beta") ?? version(0, 0, 0, 0))).toBe(false);
  });

  // Até a 3.8.1.1 o checksum TCP de fragmentos IPv4 recebidos saía errado e o Windows
  // descartava o pacote (anexo travado, #373/#400; wiresock/WireSockUI#168).
  it("recusa as versões com o checksum de fragmentos errado", () => {
    expect(isSupportedWireSockVersion(version(3, 4, 8, 1))).toBe(false);
    expect(isSupportedWireSockVersion(version(3, 8, 1, 1))).toBe(false);
    expect(isSupportedWireSockVersion(version(3, 8, 2, 1))).toBe(true);
    expect(() => selectSupportedWireSock([
      { executable: "old.exe", booster: "old.dll", executableVersion: version(3, 4, 8, 1), boosterVersion: version(3, 4, 8, 1) },
    ])).toThrow(/3\.8\.2\.1/);
  });

  it("exige o par EXE + wgbooster.dll e escolhe a maior versão suportada", () => {
    const candidates = [
      { executable: "C:/Program Files/WireSock Secure Connect/sdk/wiresock-client.exe", booster: "C:/Program Files/WireSock Secure Connect/sdk/wgbooster.dll", executableVersion: version(3, 8, 2, 1), boosterVersion: version(3, 8, 2, 1) },
      { executable: "C:/Users/teste/AppData/Local/Microsoft/WinGet/Packages/WireSock/sdk/wiresock-client.exe", booster: "C:/Users/teste/AppData/Local/Microsoft/WinGet/Packages/WireSock/sdk/wgbooster.dll", executableVersion: version(3, 9, 0, 0), boosterVersion: version(3, 9, 0, 0) },
    ];
    expect(selectSupportedWireSock(candidates).executable).toContain("WinGet");
  });

  it("não seleciona mismatch ou DLL ausente", () => {
    expect(() => selectSupportedWireSock([
      { executable: "new.exe", booster: "old.dll", executableVersion: MIN_WIRESOCK_SDK, boosterVersion: version(1, 4, 7, 1) },
    ])).toThrow();
  });
});
