import { describe, expect, it } from "vitest";

import {
  formatAllowedApps,
  isSupportedWindowsArchitecture,
  normalizeVpnSettings,
  sanitizeWireGuardConfig,
  validateWireGuardConfig,
} from "../../goLiveBypass/vpn-types";
import { validateCaptchaResponse } from "../../goLiveBypass/vpn-proton";

const PRIVATE_KEY = "EJmruxrw1y1dxNMn/MwWNjqh6RdtbrrajBqlnlxjoFw=";
const PUBLIC_KEY = "VIsNLxZusibbokXCLvUmRHmYhdIEUsWm+vGHoEvWd20=";

const VALID_CONFIG = `[Interface]
PrivateKey = ${PRIVATE_KEY}
Address = 10.2.0.2/32
DNS = 10.2.0.1

[Peer]
PublicKey = ${PUBLIC_KEY}
AllowedIPs = 0.0.0.0/0, ::/0
Endpoint = [2001:db8::10]:51820
`;

describe("contratos da VPN do plugin", () => {
  it("aceita WireGuard válido, inclusive endpoint IPv6, e rejeita chave corrompida", () => {
    expect(validateWireGuardConfig(VALID_CONFIG)).toEqual({ valid: true });
    expect(validateWireGuardConfig(VALID_CONFIG.replace(PRIVATE_KEY, "invalid"))).toMatchObject({ valid: false });
    expect(validateWireGuardConfig(VALID_CONFIG.replace("Endpoint = [2001:db8::10]:51820", "Endpoint = host:70000"))).toMatchObject({ valid: false });
    expect(validateWireGuardConfig(VALID_CONFIG.replace("AllowedIPs = 0.0.0.0/0, ::/0", "AllowedIPs = 10.0.0.0/8"))).toMatchObject({ valid: false });
  });

  it("normaliza o modo e os países sem carregar campos desconhecidos", () => {
    expect(normalizeVpnSettings({ mode: "custom", protonCountry: " us, nl, lixo ", unknown: "secret" })).toEqual({
      mode: "custom",
      customConfigPath: "",
      protonUsername: "",
      protonCountry: "US,NL",
      protonFreeOnly: true,
      protonAutoPing: true,
    });
  });

  it("mantém AllowedApps estreito e elimina DNS para o perfil WireSock", () => {
    const apps = formatAllowedApps(["C:\\Discord\\Discord.exe", "c:\\discord\\Discord.exe", "C:\\Discord\\Update.exe"]);
    expect(apps).toBe("C:\\Discord\\Discord.exe, C:\\Discord\\Update.exe");
    const sanitized = sanitizeWireGuardConfig(VALID_CONFIG, apps);
    expect(sanitized).not.toMatch(/^\s*DNS\s*=/im);
    expect(sanitized).toContain(`#@ws:AllowedApps = ${apps}`);
    expect(() => formatAllowedApps(["C:\\Apps, Inc\\Discord.exe"])).toThrow("AllowedApps");
  });

  it("limita a ativação ao Windows x64", () => {
    expect(isSupportedWindowsArchitecture("win32", "x64")).toBe(true);
    expect(isSupportedWindowsArchitecture("win32", "ia32")).toBe(false);
    expect(isSupportedWindowsArchitecture("linux", "x64")).toBe(false);
  });

  it("aceita somente a resposta CAPTCHA ligada ao desafio", () => {
    expect(validateCaptchaResponse("abc123:resposta", "abc123")).toBe(true);
    expect(validateCaptchaResponse("outro:resposta", "abc123")).toBe(false);
    expect(validateCaptchaResponse("abc123", "abc123")).toBe(false);
    expect(validateCaptchaResponse(123, "abc123")).toBe(false);
  });
});
