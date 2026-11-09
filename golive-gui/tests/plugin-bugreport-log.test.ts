import { describe, expect, it } from "vitest";
import { LOG_ISSUE_MAX, montarLog } from "../../goLiveBypass/bug-report";

describe("log do relatorio do plugin", () => {
  it("cabe na issue e preserva o fim do ring quando o plugin-vpn.log antigo e grande", () => {
    const antigo = Array.from({ length: 4000 }, (_, i) => `00:${String(i % 60).padStart(2, "0")}:00.000 [info] [plugin.native] antigo ${i} ${"y".repeat(40)}`);
    const ring = Array.from({ length: 1500 }, (_, i) => `01:00:${String(i % 60).padStart(2, "0")}.000 [info] [plugin.native] helper.progress_sampled ${i} ${"z".repeat(60)}`);
    ring.push("01:59:59.000 [error] [plugin.native] operation.vpn-activation.failed | error=FALHA-RECENTE");
    // A cauda do arquivo contem o ring inteiro depois das linhas antigas.
    const log = montarLog({
      ring: ring.join("\n"),
      caudaArquivo: [...antigo, ...ring].join("\n"),
      sessao: "GoLiveBypass, diagnostico",
      segredos: [],
      token: "token",
    });
    expect(Buffer.byteLength(log, "utf8")).toBeLessThanOrEqual(LOG_ISSUE_MAX + 1024);
    expect(log).toContain("FALHA-RECENTE");
    expect(log).toContain("=== plugin-vpn.log (antes do ring) ===");
    expect(log).toContain("antigo 3999");
    expect(log).not.toContain("antigo 0 ");
  });
});
