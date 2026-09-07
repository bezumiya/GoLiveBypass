import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const pluginRoot = path.resolve(process.cwd(), "../goLiveBypass");
const read = (file: string) => fs.readFileSync(path.join(pluginRoot, file), "utf8");

describe("fronteira do transporte do plugin", () => {
  it("não leva o transporte legado para o native facade", () => {
    const native = read("native.ts");
    expect(native).not.toMatch(/session\.defaultSession|setProxy|createServer|NativeSettings|TOR_PORTS|pac_script|socks5:\/\//);
    expect(native).toContain("PluginVpnController");
    expect(native).toContain("getVpnStatus");
    expect(native).toContain("before-quit");
  });

  it("não expõe settings nem chamadas de proxy/PAC no renderer", () => {
    const index = read("index.tsx");
    expect(index).not.toMatch(/sessionRouting|excludedCountries|retryWithProxy|sessionOpened|sessionClosed|getActiveProxy|setProxy|pac_script|socks5:\/\//);
    expect(index).toContain("vpnMode");
    expect(index).toContain("Native.enable");
    expect(index).toContain("Native.restoreNetwork");
  });
});
