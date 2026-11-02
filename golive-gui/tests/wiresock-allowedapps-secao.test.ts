import { describe, expect, it } from "vitest";

import { sanitizeWireGuardConfig as perfilDaGui } from "../electron/wiresock";
import { sanitizeWireGuardConfig as perfilDoPlugin } from "../../goLiveBypass/vpn-types";

// O WireSock só lê #@ws:AllowedApps dentro de [Peer] (documentação de parâmetros avançados).
// Fora dela a linha é ignorada e o túnel passa a valer para o computador inteiro: visto no
// WireSock 3.4.8.1 real com a linha em [Interface], até um curl de controle entrou no túnel.
const APPS = "C:\\Discord\\Discord.exe, C:\\Discord\\Update.exe";
const INTERFACE = ["[Interface]", "PrivateKey = AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", "Address = 10.2.0.2/32", "DNS = 10.2.0.1"];
const PEER = ["[Peer]", "PublicKey = BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=", "AllowedIPs = 0.0.0.0/0", "Endpoint = 198.51.100.7:51820"];

function secoesDoAllowedApps(conf: string): string[] {
  let secao = "";
  const achadas: string[] = [];
  for (const linha of conf.split(/\r?\n/)) {
    const cabecalho = /^\s*\[([^\]]+)\]\s*$/.exec(linha);
    if (cabecalho) secao = cabecalho[1].toLowerCase();
    else if (/^\s*(?:#@ws:)?AllowedApps\s*=/i.test(linha)) achadas.push(secao);
  }
  return achadas;
}

const casos: Array<[string, string[]]> = [
  ["perfil comum ([Interface] e depois [Peer])", [...INTERFACE, "", ...PEER, ""]],
  ["AllowedApps vindo do arquivo dentro de [Interface]", [...INTERFACE, "AllowedApps = chrome", "", ...PEER]],
  ["#@ws:AllowedApps vindo do arquivo dentro de [Interface]", [...INTERFACE, "#@ws:AllowedApps = chrome", ...PEER]],
  ["[Peer] antes de [Interface]", [...PEER, "", ...INTERFACE, ""]],
];

for (const [nome, gerar] of [["GUI", perfilDaGui], ["plugin", perfilDoPlugin]] as const) {
  describe(`perfil WireSock da ${nome}: AllowedApps sempre dentro de [Peer]`, () => {
    for (const [caso, linhas] of casos) {
      it(caso, () => {
        const conf = gerar(linhas.join("\r\n"), APPS);
        expect(secoesDoAllowedApps(conf)).toEqual(["peer"]);
        expect(conf).toContain(`#@ws:AllowedApps = ${APPS}`);
        expect(conf).not.toMatch(/^\s*DNS\s*=/im);
        expect(conf).toContain("Endpoint = 198.51.100.7:51820");
      });
    }
  });
}
