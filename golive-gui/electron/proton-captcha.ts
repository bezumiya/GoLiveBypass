export const PROTON_CAPTCHA_IPC_CHANNEL = "proton-captcha-response";

export interface ProtonCaptchaChallenge {
  url: string;
  origin: string;
  challenge: string;
}

function isOfficialProtonHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "proton.me" || normalized.endsWith(".proton.me");
}

export function parseProtonCaptchaChallenge(rawUrl: string): ProtonCaptchaChallenge | null {
  try {
    const parsed = new URL(rawUrl);
    const challenge = parsed.searchParams.get("Token")?.trim() ?? "";
    if (parsed.protocol !== "https:" || !isOfficialProtonHost(parsed.hostname)) return null;
    if (parsed.pathname !== "/core/v4/captcha" || challenge.length < 3 || challenge.length > 4096) return null;
    parsed.hash = "";
    return { url: parsed.toString(), origin: parsed.origin, challenge };
  } catch {
    return null;
  }
}

export function isAllowedProtonCaptchaNavigation(rawUrl: string, expected: ProtonCaptchaChallenge): boolean {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === "https:" && parsed.origin === expected.origin && parsed.pathname === "/core/v4/captcha";
  } catch {
    return false;
  }
}

export function validateProtonCaptchaResponse(token: unknown, expectedChallenge: string): token is string {
  if (typeof token !== "string" || token.length > 16_384) return false;
  const prefix = `${expectedChallenge}:`;
  return token.startsWith(prefix) && token.length > prefix.length;
}
