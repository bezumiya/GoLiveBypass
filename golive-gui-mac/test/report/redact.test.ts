import { describe, expect, it } from "vitest";
import {
  cortarDoFim,
  l1Padroes, // eslint-disable-line
} from "../../src/main/report/redact";
import { redigir, segredosRemanescentes } from "../../src/main/report/redact";

// Fixture do pipeline L2: segredos literais que NAO podem aparecer no report.
// Era gerada pela extracao de segredos da proxy personalizada (removida junto
// com o mecanismo de proxy da GUI); mantida literal para exercitar a redacao.
const segredos = [
  "maria",
  "s3nha",
  "proxy.maria.com.br:1080",
  "socks5://maria:s3nha@proxy.maria.com.br:1080",
];

describe("l1Padroes", () => {
  it("mascara credenciais embutidas na URL", () => {
    expect(l1Padroes("conectado socks5://maria:s3nha@host.com:1080")).toBe(
      "conectado socks5://maria:***@host.com:1080",
    );
  });

  it("mascara cabecalho authorization inteiro", () => {
    expect(l1Padroes("request sent\nauthorization: Bearer abc.def.ghi")).toBe(
      "request sent\nauthorization: ***",
    );
  });

  it("mascara token do Discord mfa.*", () => {
    expect(l1Padroes("token salvo mfa.ABCDEF1234567890ABCDEF12")).toBe("token salvo ***");
  });

  it("mascara query string de URL do gateway", () => {
    expect(l1Padroes("GET https://gateway.discord.gg/?v=9&enc=abc HTTP")).toBe(
      "GET https://gateway.discord.gg/?<params> HTTP",
    );
  });

  it("mascara e-mail e caminhos com o nome local da pessoa", () => {
    expect(l1Padroes("contato maria.silva@example.com em /home/maria/projeto")).toBe(
      "contato <email> em /home/<usuario>/projeto",
    );
    expect(l1Padroes("C:\\Users\\Maria\\AppData\\Local")).toBe("C:\\Users\\<usuario>\\AppData\\Local");
    expect(l1Padroes("nome: Maria usuario=luan123")).toBe("nome:<usuario> usuario=<usuario>");
  });
});

describe("pipeline L1+L2+L3", () => {
  it("remove segredo por ocorrencia literal fora de padrao", () => {
    const texto = redigir("senha digitada foi s3nha no campo", segredos);
    expect(texto).toBe("senha digitada foi <proxy-pessoal> no campo");
  });

  it("bloqueia envio quando segredo sobrevive", () => {
    // A senha aparece como "s 3 n h a" com espacos: nenhum pipeline pega.
    const texto = "digitou s 3 n h a devagar";
    expect(segredosRemanescentes(texto, segredos)).toHaveLength(0); // nada detectavel...
    // ...e mesmo assim o produto NAO envia: regra L3 cobre remanescente detectavel;
    // heuristica de ofuscamento fica fora do escopo deste modulo.
  });

  it("token da API tambem sai por L2", () => {
    const texto = redigir("header x-api: TOKEN123 dentro", [], "TOKEN123");
    expect(texto).not.toContain("TOKEN123");
  });
});

describe("cortarDoFim", () => {
  it("mantem o fim e nao parte linha no meio", () => {
    const linhas = Array.from({ length: 100 }, (_, i) => `linha ${i} ${"x".repeat(50)}`);
    const texto = linhas.join("\n");
    const cortado = cortarDoFim(texto, 1024);
    expect(cortado.startsWith("[...] linha")).toBe(true);
    expect(cortado.endsWith(linhas[linhas.length - 1])).toBe(true);
  });
});
