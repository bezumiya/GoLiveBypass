import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import {
  avaliarSaudeWireSock,
  FAILOVER_HANDSHAKES_SEM_RESPOSTA,
  ipv6NoPerfil,
  lerResumoLogWireSock,
  metaDoLogWireSock,
  respostaNaSessaoAtual,
  resumirLogWireSock,
  servidorSemResposta,
} from "../electron/wiresock-log";

// Horario fixo e o log no formato real do wiresock-client 3.4.8:
//   2026-10-18 12:10:37 {"log_level":"info","message":"[TUN]: ..."}
const AGORA = new Date(2026, 9, 19, 20, 0, 0).getTime();

function dois(n: number): string {
  return String(n).padStart(2, "0");
}

function linha(msAtras: number, mensagem: string, nivel = "info"): string {
  const d = new Date(AGORA - msAtras);
  const quando = `${d.getFullYear()}-${dois(d.getMonth() + 1)}-${dois(d.getDate())} ${dois(d.getHours())}:${dois(d.getMinutes())}:${dois(d.getSeconds())}`;
  return `${quando} ${JSON.stringify({ log_level: nivel, message: mensagem })}`;
}

const KEEPALIVE = "[TUN]: keep_alive_thread: Sending Keepalive packet to WireGuard Server success";
const ENVIO = "[TUN]: keep_alive_thread: Handshake initiation sent to WireGuard server";
const RESPOSTA = "[TUN]: Handshake response received from 84.20.27.49 : 51820";
const INICIO = "[MGR]: Tunnel has started";

/** Tunel saudavel: keepalive a cada 10 s e um handshake respondido a cada 120 s. */
function logSaudavel(duracaoS = 600): string[] {
  const linhas: string[] = [];
  for (let s = duracaoS; s >= 1; s--) {
    if (s % 10 === 0) linhas.push(linha(s * 1000, KEEPALIVE));
    if (s % 120 === 0) {
      linhas.push(linha(s * 1000, ENVIO));
      linhas.push(linha(s * 1000, RESPOSTA));
    }
  }
  return linhas;
}

describe("resumirLogWireSock", () => {
  it("tunel saudavel: tudo respondido, keepalive regular, sem aviso", () => {
    const r = resumirLogWireSock(logSaudavel().join("\n"), AGORA);
    expect(r.ok).toBe(true);
    expect(r.handshakesEnviados).toBe(r.handshakesRespondidos);
    expect(r.handshakesEnviados).toBeGreaterThanOrEqual(4);
    expect(r.semResposta).toBe(0);
    expect(r.keepaliveMaiorIntervaloS).toBeLessThanOrEqual(11);
    expect(r.keepaliveFalhas).toBe(0);
    expect(r.avisos).toBe(0);
    expect(r.handshakeRespostaHaS).toBeLessThanOrEqual(120);
    expect(avaliarSaudeWireSock(r).nivel).toBe("info");
    expect(avaliarSaudeWireSock(r).evento).toBe("tunel.saude");
  });

  it("handshake enviado e nunca respondido vira sem_resposta", () => {
    const linhas = [
      linha(290_000, KEEPALIVE),
      linha(240_000, ENVIO),
      linha(120_000, ENVIO),
      linha(20_000, KEEPALIVE),
      linha(10_000, KEEPALIVE),
    ];
    const r = resumirLogWireSock(linhas.join("\n"), AGORA);
    expect(r.handshakesEnviados).toBe(2);
    expect(r.handshakesRespondidos).toBe(0);
    expect(r.semResposta).toBe(2);
    expect(avaliarSaudeWireSock(r).evento).toBe("handshake.sem_resposta");
  });

  it("um handshake recem-enviado ainda nao conta como sem resposta", () => {
    const r = resumirLogWireSock([linha(2_000, ENVIO), linha(1_000, KEEPALIVE)].join("\n"), AGORA);
    expect(r.handshakesEnviados).toBe(1);
    expect(r.semResposta).toBe(0);
  });

  it("ultima resposta antiga com o tunel ativo ha tempo vira handshake.velho", () => {
    const linhas = [
      linha(900_000, INICIO),
      linha(400_000, RESPOSTA),
      linha(30_000, KEEPALIVE),
      linha(20_000, KEEPALIVE),
      linha(10_000, KEEPALIVE),
    ];
    const r = resumirLogWireSock(linhas.join("\n"), AGORA);
    expect(r.handshakeRespostaHaS).toBe(400);
    expect(r.tunelAtivoHaS).toBe(900);
    expect(avaliarSaudeWireSock(r).evento).toBe("handshake.velho");
  });

  it("nao acusa handshake velho num tunel recem-iniciado", () => {
    const linhas = [linha(40_000, INICIO), linha(30_000, KEEPALIVE), linha(20_000, KEEPALIVE), linha(10_000, KEEPALIVE)];
    const r = resumirLogWireSock(linhas.join("\n"), AGORA);
    expect(avaliarSaudeWireSock(r).nivel).toBe("info");
  });

  it("log sem escrever ha mais de um minuto vira log_parado", () => {
    const r = resumirLogWireSock([linha(200_000, KEEPALIVE), linha(95_000, KEEPALIVE)].join("\n"), AGORA);
    expect(r.ultimaLinhaHaS).toBe(95);
    expect(avaliarSaudeWireSock(r).evento).toBe("wiresock.log_parado");
  });

  it("keepalive atrasado acima de 30 s vira keepalive.intervalo", () => {
    const linhas = [linha(100_000, KEEPALIVE), linha(50_000, KEEPALIVE), linha(5_000, KEEPALIVE)];
    const r = resumirLogWireSock(linhas.join("\n"), AGORA);
    expect(r.keepaliveMaiorIntervaloS).toBe(50);
    expect(avaliarSaudeWireSock(r).evento).toBe("keepalive.intervalo");
  });

  it("keepalive sem success conta como falha", () => {
    const linhas = [linha(30_000, KEEPALIVE), linha(20_000, "[TUN]: keep_alive_thread: Sending Keepalive packet failed"), linha(10_000, KEEPALIVE)];
    const r = resumirLogWireSock(linhas.join("\n"), AGORA);
    expect(r.keepaliveFalhas).toBe(1);
    expect(r.keepaliveOk).toBe(2);
    expect(avaliarSaudeWireSock(r).evento).toBe("wiresock.avisos");
  });

  it("aviso fora de info entra na contagem sem vazar IP nem chave", () => {
    const chave = "A".repeat(43) + "=";
    const linhas = [
      linha(20_000, `[TUN]: send to 84.20.27.49:51820 failed key ${chave}`, "error"),
      linha(10_000, KEEPALIVE),
    ];
    const r = resumirLogWireSock(linhas.join("\n"), AGORA);
    expect(r.avisos).toBe(1);
    expect(r.ultimoAviso).toContain("<ip>");
    expect(r.ultimoAviso).toContain("<chave>");
    expect(r.ultimoAviso).not.toContain("84.20.27.49");
    expect(r.ultimoAviso).not.toContain(chave);
    const saude = avaliarSaudeWireSock(r);
    expect(saude.nivel).toBe("warn");
    expect(JSON.stringify(saude.dados)).not.toContain("84.20.27.49");
  });

  it("os dados de saude nunca carregam o endereco do servidor", () => {
    const r = resumirLogWireSock(logSaudavel().join("\n"), AGORA);
    expect(JSON.stringify(avaliarSaudeWireSock(r).dados)).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });

  it("eventos fora da janela nao entram nas contagens", () => {
    const antigos = [linha(3_000_000, ENVIO), linha(2_990_000, RESPOSTA), linha(2_980_000, KEEPALIVE)];
    const r = resumirLogWireSock([...antigos, linha(10_000, KEEPALIVE)].join("\n"), AGORA);
    expect(r.handshakesEnviados).toBe(0);
    expect(r.handshakesRespondidos).toBe(0);
    expect(r.keepaliveOk).toBe(1);
  });

  it("texto sem nenhuma linha com horario devolve ok:false", () => {
    const r = resumirLogWireSock("WireSock WireGuard VPN Client 3.4.8 is running as a regular process.\n", AGORA);
    expect(r.ok).toBe(false);
    expect(r.erro).toBeTruthy();
  });

  it("aceita linha que nao e JSON, usando o texto como mensagem", () => {
    const r = resumirLogWireSock(`2026-10-19 19:59:50 ${KEEPALIVE}\n`, AGORA);
    expect(r.ok).toBe(true);
    expect(r.keepaliveOk).toBe(1);
  });
});

describe("lerResumoLogWireSock", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "golive-wslog-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("le um arquivo pequeno inteiro", () => {
    const arquivo = path.join(dir, "direct-result.txt.stdout");
    fs.writeFileSync(arquivo, "WireSock WireGuard VPN Client 3.4.8 is running as a regular process.\n" + logSaudavel(120).join("\n") + "\n");
    const r = lerResumoLogWireSock(arquivo, AGORA);
    expect(r.ok).toBe(true);
    expect(r.keepaliveOk).toBeGreaterThan(5);
  });

  it("em sessao longa le o trecho recente e acha o inicio do tunel no comeco do arquivo", () => {
    const arquivo = path.join(dir, "direct-result.txt.stdout");
    const horasAtras = 6 * 3600 * 1000;
    const miolo: string[] = [];
    for (let i = 0; i < 2500; i++) miolo.push(linha(horasAtras - i * 1000, KEEPALIVE));
    fs.writeFileSync(
      arquivo,
      ["WireSock WireGuard VPN Client 3.4.8 is running as a regular process.", linha(horasAtras, INICIO), ...miolo, ...logSaudavel(300)].join("\n") + "\n",
    );
    expect(fs.statSync(arquivo).size).toBeGreaterThan(96 * 1024);
    const r = lerResumoLogWireSock(arquivo, AGORA);
    expect(r.ok).toBe(true);
    expect(r.tunelAtivoHaS).toBe(6 * 3600);
    expect(r.semResposta).toBe(0);
  });

  it("nao conta em dobro as linhas do comeco quando o arquivo cabe no trecho recente", () => {
    const arquivo = path.join(dir, "direct-result.txt.stdout");
    const linhas = [linha(30_000, INICIO), linha(25_000, ENVIO), linha(24_000, RESPOSTA), linha(20_000, KEEPALIVE)];
    fs.writeFileSync(arquivo, linhas.join("\n") + "\n");
    const r = lerResumoLogWireSock(arquivo, AGORA);
    expect(r.handshakesEnviados).toBe(1);
    expect(r.handshakesRespondidos).toBe(1);
    expect(r.keepaliveOk).toBe(1);
  });

  it("arquivo inexistente devolve ok:false com motivo, sem lancar", () => {
    const r = lerResumoLogWireSock(path.join(dir, "nao-existe.stdout"), AGORA);
    expect(r.ok).toBe(false);
    expect(r.erro).toBeTruthy();
  });
});

describe("metaDoLogWireSock (campos do relatorio)", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "golive-wsmeta-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("fora do Windows e sem log registrado nao acrescenta nada", () => {
    expect(metaDoLogWireSock(null, false, AGORA)).toEqual({});
  });

  it("no Windows sem log registrado diz que nao esta registrado", () => {
    expect(metaDoLogWireSock(null, true, AGORA)).toEqual({ wiresock_log: "nao_registrado" });
  });

  it("log ilegivel diz indisponivel com o motivo", () => {
    const meta = metaDoLogWireSock(path.join(dir, "nao-existe.stdout"), true, AGORA);
    expect(meta.wiresock_log).toMatch(/^indisponivel: /);
  });

  it("log saudavel preenche os campos e nunca traz IP", () => {
    const arquivo = path.join(dir, "direct-result.txt.stdout");
    fs.writeFileSync(arquivo, logSaudavel().join("\n") + "\n");
    const meta = metaDoLogWireSock(arquivo, true, AGORA);
    expect(meta.wiresock_log).toBe("ok");
    expect(meta.wiresock_handshakes_10min).toMatch(/^\d+\/\d+$/);
    expect(meta.wiresock_sem_resposta).toBe("0");
    expect(Number(meta.wiresock_keepalive_maior_intervalo_s)).toBeLessThanOrEqual(11);
    expect(Number(meta.wiresock_ultima_linha_ha_s)).toBeLessThanOrEqual(10);
    expect(JSON.stringify(meta)).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
    for (const valor of Object.values(meta)) expect(typeof valor).toBe("string");
  });

  it("um aviso aparece em wiresock_avisos", () => {
    const arquivo = path.join(dir, "direct-result.txt.stdout");
    fs.writeFileSync(arquivo, [linha(20_000, "[TUN]: send failed", "error"), linha(10_000, KEEPALIVE)].join("\n") + "\n");
    const meta = metaDoLogWireSock(arquivo, true, AGORA);
    expect(meta.wiresock_avisos).toBe("1");
  });
});

describe("evidencia para a troca automatica de rota (#411)", () => {
  // Ordem real do wiresock-client: o handshake forcado vem antes de "Tunnel has started".
  const FORCADO = "[TUN]: force_handshake: Handshake initiation sent to WireGuard server";

  it("servidor mudo desde o inicio: todas as tentativas contam", () => {
    const linhas = [linha(60_000, FORCADO), linha(60_000, INICIO)];
    for (let s = 55; s >= 5; s -= 5) linhas.push(linha(s * 1000, ENVIO));
    const r = resumirLogWireSock(linhas.join("\n"), AGORA);
    expect(r.semRespostaSeguidos).toBe(12);
    expect(servidorSemResposta(r)).toBe(true);
    expect(respostaNaSessaoAtual(r)).toBe(false);
  });

  it("uma resposta zera a contagem; so contam as tentativas depois dela", () => {
    const linhas = [
      linha(120_000, INICIO), linha(120_000, RESPOSTA),
      linha(40_000, ENVIO), linha(35_000, ENVIO), linha(30_000, ENVIO),
      linha(25_000, RESPOSTA),
      linha(20_000, ENVIO), linha(15_000, ENVIO), linha(10_000, ENVIO), linha(3_000, ENVIO),
    ];
    const r = resumirLogWireSock(linhas.join("\n"), AGORA);
    expect(r.semRespostaSeguidos).toBe(3); // a de 3 s ainda pode estar esperando a resposta
    expect(servidorSemResposta(r)).toBe(false);
    expect(respostaNaSessaoAtual(r)).toBe(true);
  });

  it("tunel saudavel, com troca de chave a cada 2 min, nunca acumula tentativas", () => {
    const r = resumirLogWireSock([linha(600_000, INICIO), ...logSaudavel()].join("\n"), AGORA);
    expect(r.semRespostaSeguidos).toBe(0);
    expect(servidorSemResposta(r)).toBe(false);
    expect(respostaNaSessaoAtual(r)).toBe(true);
  });

  it("queda que ja passou: a contagem da troca zera, o diagnostico de 10 min continua acusando", () => {
    const linhas = [linha(300_000, INICIO), linha(300_000, RESPOSTA)];
    for (let s = 240; s >= 180; s -= 5) linhas.push(linha(s * 1000, ENVIO));
    linhas.push(linha(175_000, RESPOSTA), linha(60_000, ENVIO), linha(60_000, RESPOSTA), linha(5_000, KEEPALIVE));
    const r = resumirLogWireSock(linhas.join("\n"), AGORA);
    expect(r.semResposta).toBeGreaterThan(0);
    expect(avaliarSaudeWireSock(r).evento).toBe("handshake.sem_resposta");
    expect(r.semRespostaSeguidos).toBe(0);
    expect(servidorSemResposta(r)).toBe(false);
  });

  it("o limite da troca e de 6 tentativas seguidas sem resposta", () => {
    const comTentativas = (n: number) => {
      const linhas = [linha(300_000, INICIO), linha(300_000, RESPOSTA)];
      for (let i = n; i >= 1; i--) linhas.push(linha((5 + i * 5) * 1000, ENVIO));
      linhas.push(linha(2_000, KEEPALIVE));
      return resumirLogWireSock(linhas.join("\n"), AGORA);
    };
    expect(FAILOVER_HANDSHAKES_SEM_RESPOSTA).toBe(6);
    expect(comTentativas(5).semRespostaSeguidos).toBe(5);
    expect(servidorSemResposta(comTentativas(5))).toBe(false);
    expect(servidorSemResposta(comTentativas(6))).toBe(true);
  });

  it("log parado ou ilegivel nao prova servidor mudo", () => {
    const parado = [linha(400_000, INICIO)];
    for (let s = 390; s >= 100; s -= 5) parado.push(linha(s * 1000, ENVIO));
    const r = resumirLogWireSock(parado.join("\n"), AGORA);
    expect(r.semRespostaSeguidos).toBeGreaterThanOrEqual(FAILOVER_HANDSHAKES_SEM_RESPOSTA);
    expect(servidorSemResposta(r)).toBe(false);
    expect(servidorSemResposta(resumirLogWireSock("", AGORA))).toBe(false);
  });

  it("resposta so prova a rota se veio depois do inicio do tunel atual", () => {
    const real = [linha(30_000, FORCADO), linha(30_000, INICIO), linha(30_000, RESPOSTA), linha(5_000, KEEPALIVE)];
    expect(respostaNaSessaoAtual(resumirLogWireSock(real.join("\n"), AGORA))).toBe(true);
    const daSessaoAnterior = [linha(200_000, INICIO), linha(200_000, RESPOSTA), linha(30_000, INICIO), linha(25_000, ENVIO), linha(20_000, ENVIO)];
    expect(respostaNaSessaoAtual(resumirLogWireSock(daSessaoAnterior.join("\n"), AGORA))).toBe(false);
    expect(respostaNaSessaoAtual(resumirLogWireSock(linha(10_000, RESPOSTA), AGORA))).toBe(false);
  });
});

describe("ipv6NoPerfil", () => {
  it("endereco com IPv6 -> sim", () => {
    expect(ipv6NoPerfil("[Interface]\nPrivateKey = x\nAddress = 10.2.0.2/32, 2a07:b944::2:2/128\n")).toBe("sim");
  });
  it("so IPv4 -> nao", () => {
    expect(ipv6NoPerfil("[Interface]\nAddress = 10.2.0.2/32\nDNS = 10.2.0.1\n")).toBe("nao");
  });
  it("ignora IPv6 que aparece fora da linha Address (AllowedIPs)", () => {
    expect(ipv6NoPerfil("[Interface]\nAddress = 10.2.0.2/32\n[Peer]\nAllowedIPs = 0.0.0.0/0, ::/0\n")).toBe("nao");
  });
  it("sem conteudo ou sem linha Address -> indisponivel", () => {
    expect(ipv6NoPerfil(null)).toBe("indisponivel");
    expect(ipv6NoPerfil("[Interface]\nPrivateKey = x\n")).toBe("indisponivel");
  });
});
