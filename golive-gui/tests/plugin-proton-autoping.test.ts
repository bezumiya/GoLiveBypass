import { describe, expect, it } from "vitest";
import { protonNeedsAutoPing } from "../../goLiveBypass/vpn-proton";

// #398: o plugin aceitava país vazio com auto-ping desligado e o helper respondia
// "countries flag is required", cru, na tela. Sem país só a escolha automática funciona.
describe("auto-ping do helper Proton no plugin", () => {
  it("sem país o auto-ping vai mesmo com a preferência desligada", () => {
    expect(protonNeedsAutoPing({ autoPing: false, country: "" })).toBe(true);
    expect(protonNeedsAutoPing({ autoPing: false, country: "   " })).toBe(true);
    expect(protonNeedsAutoPing({ autoPing: false })).toBe(true);
  });

  it("com país a preferência do usuário é respeitada", () => {
    expect(protonNeedsAutoPing({ autoPing: false, country: "US" })).toBe(false);
    expect(protonNeedsAutoPing({ autoPing: true, country: "US" })).toBe(true);
    expect(protonNeedsAutoPing({ country: "NL" })).toBe(true);
  });
});
