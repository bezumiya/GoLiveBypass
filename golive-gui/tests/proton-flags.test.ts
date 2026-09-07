import { describe, expect, it } from "vitest";
import { renderProtonCountryFlag } from "../src/proton-flags";

describe("bandeiras das rotas Proton", () => {
  it("renderiza uma bandeira SVG para países conhecidos", () => {
    const flag = renderProtonCountryFlag("us");
    expect(flag).toContain('<svg class="proton-country-flag-svg"');
    expect(flag).toContain("#3C3B6E");
    expect(renderProtonCountryFlag("PE")).toContain("#D91023");
  });

  it("mantém um fallback visual para códigos que a Proton adicionar", () => {
    const flag = renderProtonCountryFlag("zz");
    expect(flag).toContain("ZZ");
    expect(flag).toContain("proton-country-flag-svg");
  });
});
