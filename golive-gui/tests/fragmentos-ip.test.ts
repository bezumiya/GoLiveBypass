import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as logger from "../electron/logger";
import {
  type AmostraFragmentos,
  type ContadoresFragmentos,
  amostrarERegistrarFragmentos,
  contadoresDaSecaoNetstat,
  definirLeitorFragmentos,
  metaFragmentos,
  parseContadoresFragmentos,
  reiniciarFragmentos,
  resumirFragmentos,
} from "../electron/fragmentos-ip";

// Saida real de `netstat -s -p ip` e `-p ipv6` num Windows em portugues (02/11/2026, so
// contadores), com o CRLF do console. A legenda muda com o idioma; a ordem dos 17, nao.
const secao = (titulo: string, linhas: string[]) => ["", titulo, "", ...linhas].join("\r\n") + "\r\n";

const NETSTAT_V4_PT = secao("Estatísticas de IPv4", [
  "  Pacotes recebidos                  = 57748363",
  "  Erros de cabeçalho recebidos       = 0",
  "  Erros de endereço recebidos        = 0",
  "  Datagramas encaminhados            = 0",
  "  Protocolos desconhecidos recebidos = 194",
  "  Pacotes recebidos descartados      = 74979",
  "  Pacotes recebidos entregues        = 58139110",
  "  Solicitações de saída              = 27923360",
  "  Descartes de roteamento            = 0",
  "  Pacotes de saída descartados       = 1145",
  "  Pacote de saída sem rota           = 20",
  "  Reagrupamento necessário           = 6102",
  "  Reagrupamento bem-sucedido         = 1939",
  "  Falhas de reagrupamento            = 0",
  "  Datagramas fragmentados c/ êxito   = 27",
  "  Falhas/ fragmentação de datagramas = 0",
  "  Fragmentos criados                 = 54",
]);

const NETSTAT_V6_PT = secao("Estatísticas de IPv6", [
  "  Pacotes recebidos                  = 1206",
  "  Erros de cabeçalho recebidos       = 0",
  "  Erros de endereço recebidos        = 180",
  "  Datagramas encaminhados            = 0",
  "  Protocolos desconhecidos recebidos = 27",
  "  Pacotes recebidos descartados      = 1524",
  "  Pacotes recebidos entregues        = 225919",
  "  Solicitações de saída              = 297071",
  "  Descartes de roteamento            = 0",
  "  Pacotes de saída descartados       = 61",
  "  Pacote de saída sem rota           = 0",
  "  Reagrupamento necessário           = 0",
  "  Reagrupamento bem-sucedido         = 0",
  "  Falhas de reagrupamento            = 0",
  "  Datagramas fragmentados c/ êxito   = 0",
  "  Falhas/ fragmentação de datagramas = 0",
  "  Fragmentos criados                 = 0",
]);

// Mesmo formato com as legendas do Windows em ingles (numeros ilustrativos).
const NETSTAT_V4_EN = secao("IPv4 Statistics", [
  "  Packets Received                   = 1000",
  "  Received Header Errors             = 0",
  "  Received Address Errors            = 0",
  "  Datagrams Forwarded                = 0",
  "  Unknown Protocols Received         = 0",
  "  Received Packets Discarded         = 3",
  "  Received Packets Delivered         = 990",
  "  Output Requests                    = 800",
  "  Routing Discards                   = 0",
  "  Discarded Output Packets           = 0",
  "  Output Packet No Route             = 0",
  "  Reassembly Required                = 40",
  "  Reassembly Successful              = 20",
  "  Reassembly Failures                = 1",
  "  Datagrams Successfully Fragmented  = 0",
  "  Datagrams Failing Fragmentation    = 0",
  "  Fragments Created                  = 0",
]);

function contadores(v4: number, falhas = 0, v6: number | null = 0): ContadoresFragmentos {
  return { v4Fragmentos: v4, v4Falhas: falhas, v6Fragmentos: v6 };
}

const T0 = new Date(2026, 10, 2, 20, 0, 0).getTime();
const amostra = (segundos: number, v4: number, falhas = 0, v6: number | null = 0): AmostraFragmentos => ({
  ms: T0 + segundos * 1000,
  c: contadores(v4, falhas, v6),
});

describe("contadoresDaSecaoNetstat", () => {
  it("le pela posicao a saida real em portugues", () => {
    expect(contadoresDaSecaoNetstat(NETSTAT_V4_PT)).toEqual({ fragmentos: 6102, falhas: 0 });
    expect(contadoresDaSecaoNetstat(NETSTAT_V4_PT.replace(/\r\n/g, "\n"))).toEqual({ fragmentos: 6102, falhas: 0 });
  });

  it("nao depende do idioma do Windows", () => {
    expect(contadoresDaSecaoNetstat(NETSTAT_V4_EN)).toEqual({ fragmentos: 40, falhas: 1 });
  });

  it("formato inesperado -> null, sem adivinhar", () => {
    const semUmaLinha = NETSTAT_V4_PT.split("\r\n").filter((l) => !l.includes("Fragmentos criados")).join("\r\n");
    expect(contadoresDaSecaoNetstat(semUmaLinha)).toBeNull();
    expect(contadoresDaSecaoNetstat(NETSTAT_V4_PT.replace("= 57748363", "= 57.748.363"))).toBeNull();
    expect(contadoresDaSecaoNetstat("")).toBeNull();
    expect(contadoresDaSecaoNetstat("Acesso negado.")).toBeNull();
  });

  it("mais datagramas remontados que fragmentos (ordem errada) -> null", () => {
    expect(contadoresDaSecaoNetstat(NETSTAT_V4_PT.replace("= 1939", "= 9999"))).toBeNull();
  });
});

describe("parseContadoresFragmentos", () => {
  it("junta IPv4 e IPv6", () => {
    expect(parseContadoresFragmentos(NETSTAT_V4_PT, NETSTAT_V6_PT)).toEqual({
      v4Fragmentos: 6102,
      v4Falhas: 0,
      v6Fragmentos: 0,
    });
  });

  it("sem o IPv6 (ou ilegivel), o IPv4 vale sozinho", () => {
    expect(parseContadoresFragmentos(NETSTAT_V4_PT, null)?.v6Fragmentos).toBeNull();
    expect(parseContadoresFragmentos(NETSTAT_V4_PT, "lixo")?.v6Fragmentos).toBeNull();
    expect(parseContadoresFragmentos(NETSTAT_V4_PT, "lixo")?.v4Fragmentos).toBe(6102);
  });

  it("IPv4 ilegivel -> null", () => {
    expect(parseContadoresFragmentos("lixo", NETSTAT_V6_PT)).toBeNull();
  });
});

describe("resumirFragmentos", () => {
  it("serie por leitura, total da janela e idade da ultima leitura", () => {
    const r = resumirFragmentos([amostra(0, 100), amostra(45, 100), amostra(90, 128), amostra(135, 128)], T0 + 140_000);
    expect(r.serie).toEqual([0, 28, 0]);
    expect(r.v4).toBe(28);
    expect(r.janelaS).toBe(135);
    expect(r.amostraHaS).toBe(5);
  });

  it("a janela cobre os ultimos 15 minutos de leitura", () => {
    const lista = [amostra(0, 0), amostra(60, 500), amostra(1000, 500), amostra(1060, 510)];
    const r = resumirFragmentos(lista, T0 + 1060_000);
    expect(r.serie).toEqual([0, 10]);
    expect(r.v4).toBe(10);
    expect(r.janelaS).toBe(1000);
  });

  it("tunel parado ha uma hora ainda mostra os seus ultimos 15 minutos", () => {
    const lista = [amostra(0, 0), amostra(60, 500), amostra(1000, 500), amostra(1060, 510)];
    const r = resumirFragmentos(lista, T0 + (1060 + 3600) * 1000);
    expect(r.v4).toBe(10);
    expect(r.amostraHaS).toBe(3600);
  });

  it("contador que voltou fica sem valor, nunca negativo", () => {
    const r = resumirFragmentos([amostra(0, 900), amostra(45, 950), amostra(90, 3), amostra(135, 8)], T0 + 135_000);
    expect(r.serie).toEqual([50, null, 5]);
    expect(r.v4).toBe(55);
  });

  it("falhas de remontagem e IPv6 tambem entram", () => {
    const r = resumirFragmentos([amostra(0, 0, 0, 0), amostra(45, 10, 2, 6)], T0 + 45_000);
    expect(r.v4Falhas).toBe(2);
    expect(r.v6).toBe(6);
  });

  it("IPv6 sem leitura fica sem valor, sem afetar o IPv4", () => {
    const r = resumirFragmentos([amostra(0, 0, 0, null), amostra(45, 10, 0, null)], T0 + 45_000);
    expect(r.v6).toBeNull();
    expect(r.v4).toBe(10);
  });

  it("menos de duas leituras -> sem numeros", () => {
    expect(resumirFragmentos([], T0)).toMatchObject({ v4: null, serie: [], amostraHaS: null });
    expect(resumirFragmentos([amostra(0, 5)], T0 + 10_000)).toMatchObject({ v4: null, serie: [], amostraHaS: 10 });
  });
});

describe("amostrarERegistrarFragmentos e metaFragmentos", () => {
  let fila: Array<ContadoresFragmentos | null | Error>;
  const ler = async (...instantesS: number[]) => {
    for (const s of instantesS) await amostrarERegistrarFragmentos(T0 + s * 1000);
  };
  const linhasDeLog = () => logger.getRecent().split("\n").filter((l) => l.includes("fragmentos."));

  beforeEach(() => {
    logger._resetForTests();
    reiniciarFragmentos();
    fila = [];
    definirLeitorFragmentos(async () => {
      const proximo = fila.shift();
      if (proximo instanceof Error) throw proximo;
      return proximo ?? null;
    });
  });

  afterEach(() => {
    definirLeitorFragmentos(null);
    reiniciarFragmentos();
  });

  it("fora do Windows o relatorio nao ganha campos", () => {
    expect(metaFragmentos(T0, false)).toEqual({});
  });

  it("sem leitura nenhuma, ou com uma so, ainda nao ha numero", async () => {
    expect(metaFragmentos(T0, true)).toEqual({ fragmentos_ip: "sem_amostras" });
    fila.push(contadores(10));
    await ler(0);
    expect(metaFragmentos(T0 + 5_000, true)).toEqual({ fragmentos_ip: "sem_amostras" });
  });

  it("com leituras, o relatorio traz so numeros", async () => {
    fila.push(contadores(100), contadores(100), contadores(128, 1, 4));
    await ler(0, 45, 90);
    const meta = metaFragmentos(T0 + 95_000, true);
    expect(meta).toEqual({
      fragmentos_ip: "ok",
      fragmentos_v4_15min: "28",
      fragmentos_v4_falhas_15min: "1",
      fragmentos_v6_15min: "4",
      fragmentos_serie: "0,28",
      fragmentos_janela_s: "90",
      fragmentos_amostra_ha_s: "5",
      fragmentos_v4_desde_tunel: "28",
      fragmentos_desde_tunel_s: "90",
    });
    for (const valor of Object.values(meta)) expect(valor).toMatch(/^(ok|[0-9?,]+)$/);
  });

  it("'desde o tunel' continua certo depois que as leituras antigas saem da janela", async () => {
    const instantes: number[] = [];
    for (let i = 0; i <= 120; i++) {
      fila.push(contadores(i * 2));
      instantes.push(i * 45);
    }
    await ler(...instantes);
    expect(metaFragmentos(T0 + 5400_000, true)).toMatchObject({
      fragmentos_v4_desde_tunel: "240",
      fragmentos_desde_tunel_s: "5400",
      fragmentos_v4_15min: "40",
      fragmentos_janela_s: "900",
    });
  });

  it("leitor que falha ou lanca nao quebra nada e nao vira amostra", async () => {
    fila.push(null, new Error("netstat sumiu"));
    await expect(amostrarERegistrarFragmentos(T0)).resolves.toBeUndefined();
    await expect(amostrarERegistrarFragmentos(T0 + 45_000)).resolves.toBeUndefined();
    expect(metaFragmentos(T0 + 50_000, true)).toEqual({ fragmentos_ip: "indisponivel" });
    expect(linhasDeLog()).toHaveLength(1);
    expect(linhasDeLog()[0]).toContain("[info][wg] fragmentos.indisponivel");
  });

  it("falha no meio da sessao aparece como contagem, sem apagar os numeros", async () => {
    fila.push(contadores(0), null, contadores(10));
    await ler(0, 45, 90);
    expect(metaFragmentos(T0 + 90_000, true)).toMatchObject({
      fragmentos_ip: "ok",
      fragmentos_v4_15min: "10",
      fragmentos_leituras_falhas: "1",
    });
  });

  it("registra no log a cada 5 minutos, so numeros e sem aviso", async () => {
    const instantes: number[] = [];
    for (let i = 0; i <= 14; i++) {
      fila.push(contadores(i * 3));
      instantes.push(i * 45);
    }
    await ler(...instantes);
    // Primeira linha na primeira diferenca (45 s); a seguinte, 5 minutos depois (360 s).
    expect(linhasDeLog()).toHaveLength(2);
    expect(linhasDeLog()[0]).toContain(
      "[info][wg] fragmentos.ip | v4=3 v4_maior_leitura=3 v4_falhas=0 v6=0 janela_s=45 v4_desde_tunel=3",
    );
    expect(linhasDeLog()[1]).toContain(
      "[info][wg] fragmentos.ip | v4=21 v4_maior_leitura=3 v4_falhas=0 v6=0 janela_s=315 v4_desde_tunel=24",
    );
    expect(logger.getRecent()).not.toContain("[warn]");
  });

  it("leitura que termina depois de um tunel novo nao entra na sessao nova", async () => {
    let liberar: ((c: ContadoresFragmentos) => void) | undefined;
    definirLeitorFragmentos(() => new Promise((resolve) => (liberar = resolve)));
    const antiga = amostrarERegistrarFragmentos(T0);
    reiniciarFragmentos();
    liberar?.(contadores(500));
    await antiga;

    definirLeitorFragmentos(async () => fila.shift() as ContadoresFragmentos);
    fila.push(contadores(600), contadores(607));
    await ler(45, 90);
    expect(metaFragmentos(T0 + 90_000, true)).toMatchObject({
      fragmentos_v4_desde_tunel: "7",
      fragmentos_serie: "7",
    });
  });

  it("relogio que volta nao gera numero negativo", async () => {
    fila.push(contadores(0), contadores(10), contadores(15), contadores(20));
    await ler(0, 45, 30, 75);
    const meta = metaFragmentos(T0 + 80_000, true);
    expect(meta).toMatchObject({
      fragmentos_v4_desde_tunel: "20",
      fragmentos_v4_15min: "5",
      fragmentos_serie: "5",
      fragmentos_janela_s: "45",
    });
    for (const valor of Object.values(meta)) expect(valor).not.toContain("-");
  });

  it("reiniciarFragmentos (tunel novo) zera a sessao", async () => {
    fila.push(contadores(0), contadores(50));
    await ler(0, 45);
    reiniciarFragmentos();
    expect(metaFragmentos(T0 + 50_000, true)).toEqual({ fragmentos_ip: "sem_amostras" });
  });
});
