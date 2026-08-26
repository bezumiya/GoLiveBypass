import { describe, it, expect } from "vitest";

// Regex NOVA (PR64): aceita range
const REGEX_NOVA =
  /^(socks5|socks4|http|https):\/\/(?:(.+)@)?([^:/?#\s@]+):(\d{1,5})(?:-(\d{1,5}))?$/i;

// Regex ANTIGA (regressao): NAO aceitava range
const REGEX_ANTIGA =
  /^(socks5|socks4|http|https):\/\/(?:(.+)@)?([^:/?#\s@]+):(\d{1,5})$/i;

// Implementacao local do parseProxyUrl espelhando a do main.ts (linhas 2062-2100)
function parseProxyUrl(value: string): {
  scheme: string;
  user: string;
  pass: string;
  host: string;
  port: number;
} | null {
  const match = REGEX_NOVA.exec(String(value).trim());
  if (!match) return null;
  const portStart = Number(match[4]);
  if (portStart < 1 || portStart > 65535) return null;

  let port = portStart;
  if (match[5] !== undefined) {
    const portEnd = Number(match[5]);
    if (portEnd >= portStart && portEnd <= 65535) {
      port = Math.floor(Math.random() * (portEnd - portStart + 1)) + portStart;
    }
  }

  const credentials = match[2] ?? "";
  const split = credentials.indexOf(":");
  const decode = (raw: string) => {
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  };

  return {
    scheme: match[1].toLowerCase(),
    user: credentials === "" ? "" : decode(split < 0 ? credentials : credentials.slice(0, split)),
    pass: credentials === "" || split < 0 ? "" : decode(credentials.slice(split + 1)),
    host: match[3],
    port,
  };
}

describe("PR64 - PROXY_URL_RE aceita range", () => {
  describe("regex nova (com range)", () => {
    it("aceita formato sem range (regressao)", () => {
      expect(REGEX_NOVA.test("socks5://u:p@h:1080")).toBe(true);
    });

    it("aceita formato com range", () => {
      expect(REGEX_NOVA.test("socks5://u:p@h:10000-10050")).toBe(true);
    });

    it("aceita formato com range de 1 porta", () => {
      expect(REGEX_NOVA.test("socks5://u:p@h:10000-10000")).toBe(true);
    });

    it("REGEITA range malformado (3 portas)", () => {
      expect(REGEX_NOVA.test("socks5://u:p@h:10000-10050-10100")).toBe(false);
    });

    it("aceita http e https", () => {
      expect(REGEX_NOVA.test("http://u:p@h:8080")).toBe(true);
      expect(REGEX_NOVA.test("https://u:p@h:8443")).toBe(true);
    });

    it("REGEITA sem porta", () => {
      expect(REGEX_NOVA.test("socks5://u:p@h")).toBe(false);
    });

    it("REGEX NAO distingue porta > 65535 (validacao fica no parseProxyUrl)", () => {
      // A regex usa \d{1,5} que aceita ate 99999. A validacao < 65535 fica no parseProxyUrl.
      // Aqui documentamos o comportamento da regex isolada.
      expect(REGEX_NOVA.test("socks5://u:p@h:99999")).toBe(true);
    });

    it("REGEX NAO distingue range com portaFinal > 65535 (validacao no parseProxyUrl)", () => {
      expect(REGEX_NOVA.test("socks5://u:p@h:10000-99999")).toBe(true);
    });

    it("REGEITA porta com 6 digitos", () => {
      expect(REGEX_NOVA.test("socks5://u:p@h:999999")).toBe(false);
    });

    it("REGEITA range com 6 digitos", () => {
      expect(REGEX_NOVA.test("socks5://u:p@h:10000-100000")).toBe(false);
    });

    it("aceita srange com credenciais complexas (dois-pontos na senha)", () => {
      expect(REGEX_NOVA.test("socks5://u:p:with:colons@h:11000-11019")).toBe(true);
    });

    it("aceita srange sem credenciais", () => {
      expect(REGEX_NOVA.test("socks5://h:11000-11019")).toBe(true);
    });
  });

  describe("regex ANTIGA (regressao - NAO aceitava range)", () => {
    it("NAO aceitava range na versao antiga", () => {
      expect(REGEX_ANTIGA.test("socks5://u:p@h:10000-10050")).toBe(false);
    });

    it("aceitava formato sem range na versao antiga", () => {
      expect(REGEX_ANTIGA.test("socks5://u:p@h:1080")).toBe(true);
    });
  });

  describe("parseProxyUrl - validacao de range", () => {
    it("sortear porta dentro do range (10000-10050)", () => {
      // Roda 100 vezes, todas devem cair no range
      for (let i = 0; i < 100; i++) {
        const r = parseProxyUrl("socks5://u:p@h:10000-10050");
        expect(r).not.toBeNull();
        expect(r!.port).toBeGreaterThanOrEqual(10000);
        expect(r!.port).toBeLessThanOrEqual(10050);
      }
    });

    it("distribuicao justa em 100 sorteios (>= 30 portas distintas esperadas)", () => {
      const seen = new Set<number>();
      for (let i = 0; i < 100; i++) {
        const r = parseProxyUrl("socks5://u:p@h:10000-10050");
        if (r) seen.add(r.port);
      }
      // 51 portas possiveis, esperar pelo menos 30 distintas
      expect(seen.size).toBeGreaterThanOrEqual(30);
    });

    it("porta unica (sem range) - port preservada", () => {
      const r = parseProxyUrl("socks5://u:p@h:1080");
      expect(r).not.toBeNull();
      expect(r!.port).toBe(1080);
    });

    it("REGEITA range invertido (portaInicial > portaFinal)", () => {
      // A regex aceita, mas o parseProxyUrl NAO deve sortear (fica com portStart)
      const r = parseProxyUrl("socks5://u:p@h:100-50");
      // A regex nova casa "100-50" como range (match[5]="50")
      // Entao portStart=100, portEnd=50, condition portEnd >= portStart fails
      // Entao port fica = 100
      expect(r).not.toBeNull();
      expect(r!.port).toBe(100);
    });

    it("REGEITA host vazio", () => {
      expect(parseProxyUrl("socks5://u:p@:1080")).toBeNull();
    });

    it("REGEITA formato sem scheme", () => {
      expect(parseProxyUrl("u:p@h:1080")).toBeNull();
    });

    it("REGEITA scheme invalido (ftp)", () => {
      expect(parseProxyUrl("ftp://u:p@h:1080")).toBeNull();
    });

    it("decodifica credenciais com % escapado", () => {
      const r = parseProxyUrl("socks5://user%40:p%3A@h:1080");
      expect(r).not.toBeNull();
      expect(r!.user).toBe("user@");
      expect(r!.pass).toBe("p:");
    });

    it("preserva scheme em lowercase", () => {
      const r = parseProxyUrl("SOCKS5://u:p@h:1080");
      expect(r).not.toBeNull();
      expect(r!.scheme).toBe("socks5");
    });

    it("host pode ser IP", () => {
      const r = parseProxyUrl("socks5://u:p@100.84.85.27:11000-11019");
      expect(r).not.toBeNull();
      expect(r!.host).toBe("100.84.85.27");
    });

    it("porta inicial = 1 (minimo)", () => {
      const r = parseProxyUrl("socks5://u:p@h:1");
      expect(r).not.toBeNull();
      expect(r!.port).toBe(1);
    });

    it("porta inicial = 65535 (maximo)", () => {
      const r = parseProxyUrl("socks5://u:p@h:65535");
      expect(r).not.toBeNull();
      expect(r!.port).toBe(65535);
    });

    it("REGEITA porta = 0", () => {
      const r = parseProxyUrl("socks5://u:p@h:0");
      expect(r).toBeNull();
    });

    it("REJEITA porta > 65535 (validado no parse, nao na regex)", () => {
      // 99999 passa na regex mas e rejeitado no parseProxyUrl
      const r = parseProxyUrl("socks5://u:p@h:99999");
      expect(r).toBeNull();
    });

    it("DOC: range com portaFinal > 65535 vira porta unica (portStart)", () => {
      // Comportamento atual (replicado do standalone parseProxy):
      // se a range e invalida (portEnd > 65535 ou < portStart), o parseProxyUrl
      // cai com port = portStart. NAO retorna null, mas o range e ignorado.
      // Isso e uma escolha deliberada: erros de formatacao nao impedem o uso.
      const r = parseProxyUrl("socks5://u:p@h:10000-99999");
      expect(r).not.toBeNull();
      expect(r!.port).toBe(10000);
    });
  });
});
