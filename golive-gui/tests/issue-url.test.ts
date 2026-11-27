import { describe, expect, it } from "vitest";
import { safeIssueNumber, safeIssueUrl } from "../electron/issue-url";

describe("safeIssueUrl", () => {
  it.each([
    "https://github.com/bezumiya/GoLiveBypass/issues/474",
    "https://github.com/pdl-clay/GoLiveBypass/issues/1",
    // Dono só tem letras, números e hífen; o repositório também aceita ponto e sublinhado.
    "https://github.com/dono-x9/repo.com-ponto_e-hifen/issues/9999999999",
  ])("aceita a issue do GitHub %s", (url) => {
    expect(safeIssueUrl(url)).toBe(url);
  });

  it.each([
    ["javascript:", "javascript:alert(1)"],
    ["file:", "file:///C:/Windows/System32/calc.exe"],
    ["outro protocolo do sistema", "ms-msdt:/id PCWDiagnostic"],
    ["http sem TLS", "http://github.com/bezumiya/GoLiveBypass/issues/474"],
    ["domínio parecido", "https://github.com.evil.example/bezumiya/GoLiveBypass/issues/474"],
    ["GitHub no caminho de outro site", "https://evil.example/https://github.com/bezumiya/GoLiveBypass/issues/474"],
    ["aspas para escapar do atributo", 'https://github.com/bezumiya/GoLiveBypass/issues/474" onmouseover="alert(1)'],
    ["tag no fim", "https://github.com/bezumiya/GoLiveBypass/issues/474<img src=x onerror=alert(1)>"],
    ["quebra de linha", "https://github.com/bezumiya/GoLiveBypass/issues/474\n"],
    ["espaço na frente", " https://github.com/bezumiya/GoLiveBypass/issues/474"],
    ["query", "https://github.com/bezumiya/GoLiveBypass/issues/474?x=1"],
    ["fragmento", "https://github.com/bezumiya/GoLiveBypass/issues/474#x"],
    ["barra no fim", "https://github.com/bezumiya/GoLiveBypass/issues/474/"],
    ["PR em vez de issue", "https://github.com/bezumiya/GoLiveBypass/pull/474"],
    ["issue zero", "https://github.com/bezumiya/GoLiveBypass/issues/0"],
    ["sem número", "https://github.com/bezumiya/GoLiveBypass/issues/"],
    ["caminho a mais", "https://github.com/bezumiya/GoLiveBypass/extra/issues/474"],
    ["vazio", ""],
  ])("recusa %s", (_caso, url) => {
    expect(safeIssueUrl(url)).toBeUndefined();
  });

  it.each([474, null, undefined, {}, ["https://github.com/bezumiya/GoLiveBypass/issues/474"]])(
    "recusa o que não é texto: %j",
    (valor) => {
      expect(safeIssueUrl(valor)).toBeUndefined();
    },
  );
});

describe("safeIssueNumber", () => {
  it("aceita inteiro positivo", () => {
    expect(safeIssueNumber(474)).toBe(474);
    expect(safeIssueNumber(1)).toBe(1);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, "474", null, undefined])(
    "recusa %j",
    (valor) => {
      expect(safeIssueNumber(valor)).toBeUndefined();
    },
  );
});
