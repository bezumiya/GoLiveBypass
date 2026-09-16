#!/usr/bin/env node

import assert from "node:assert/strict";
import { test } from "node:test";

import {
    DESCRIPTION_MAX,
    DEDUP_WINDOW_SECONDS,
    LOG_MAX_BYTES,
    SESSION_MAX,
    TITLE_MAX,
    assinaturaDoRelato,
    complementoDaCauda,
    cortarCauda,
    decidirEnvio,
    estadoDeEnvioValido,
    interpretarResposta,
    interpretarStatusDeBloqueio,
    limparEntradaDoRenderer,
    montarLog,
    montarMeta,
    montarPayload,
    montarPedido,
    montarPedidoDeStatus,
    redigir,
    segredosRemanescentes,
} from "../goLiveBypass/bug-report.ts";

// Marcadores que provam vazamento quando aparecem no que sairia da máquina.
const SENHA_MARCADOR = "NAOVAZA123";
const TOKEN_MARCADOR = "NAOVAZA-TOKEN-MARCADOR";
const SEGREDO_LITERAL = "ZQX9-SEGREDO-LITERAL";
const CHAVE_WIREGUARD = "aG9sYUNsYXZlUHJpdmFkYU5hby5Qb2RlVmF6YXI=";

function metaBase() {
    return montarMeta({
        versao: "2.0.6-beta-20",
        plataforma: "linux-x64",
        electron: "43.0.0",
        node: "22.0.0",
        estadoVpn: { state: "active", active: true, owned: true, generation: 7 },
        modo: "proton",
        onboarding: true,
    });
}

test("L1 mascara credenciais em URL, headers, token Discord, gateway, e-mail e home", () => {
    const linha = [
        "proxy=socks5://ana:" + SENHA_MARCADOR + "@10.0.0.1:1080",
        "Authorization: Bearer abcdef123456",
        "token mfa.abcdefghijklmnopqrstuvwxyz123456 do usuario",
        "gateway wss=https://gateway-us-east1.discord.gg/?encoding=etf&v=9",
        "contato ana.silva@exemplo.com",
        "perfil /home/ana/.local/share/GoLiveBypass/plugin-vpn/wiresock-discord.conf",
    ].join("\n");

    const limpo = redigir(linha, [], TOKEN_MARCADOR);

    assert.doesNotMatch(limpo, new RegExp(SENHA_MARCADOR));
    assert.match(limpo, /socks5:\/\/ana:\*\*\*@10\.0\.0\.1:1080/);
    assert.match(limpo, /Authorization: \*\*\*/);
    assert.doesNotMatch(limpo, /mfa\./);
    assert.match(limpo, /gateway-us-east1\.discord\.gg\/\?<params>/);
    assert.doesNotMatch(limpo, /ana\.silva@exemplo\.com/);
    assert.doesNotMatch(limpo, /\/home\/ana\//);

    // A asserção que importa: o payload final não carrega nenhum marcador.
    const { payload, bloqueado } = montarPayload({
        titulo: "Go Live nao sobe",
        descricao: "depois do update",
        log: linha,
        meta: metaBase(),
        segredos: [],
        token: TOKEN_MARCADOR,
    });
    assert.equal(bloqueado, false);
    const corpo = JSON.stringify(payload);
    assert.doesNotMatch(corpo, new RegExp(SENHA_MARCADOR));
    assert.doesNotMatch(corpo, /mfa\./);
    assert.doesNotMatch(corpo, /ana\.silva@exemplo\.com/);
});

test("L1 nova: Endpoint WireGuard e PrivateKey nunca saem no relato", () => {
    const perfil = [
        "[Interface]",
        `PrivateKey = ${CHAVE_WIREGUARD}`,
        "Address = 10.7.0.2/32",
        "[Peer]",
        "Endpoint = 203.0.113.7:51820",
        "AllowedIPs = 0.0.0.0/0",
    ].join("\n");

    const limpo = redigir(perfil, [], TOKEN_MARCADOR);
    assert.doesNotMatch(limpo, /203\.0\.113\.7/);
    assert.doesNotMatch(limpo, new RegExp(CHAVE_WIREGUARD));
    assert.match(limpo, /Endpoint = <redacted>/);
    assert.match(limpo, /PrivateKey = <redacted>/);
});

test("L2 remove termos conhecidos da máquina mesmo fora de padrão", () => {
    const textos = {
        titulo: `erro ao ler ${SEGREDO_LITERAL}`,
        descricao: `o caminho /home/ana quebrou e o usuario ana@proton.me falhou`,
        log: `boot | segredo=${SEGREDO_LITERAL}`,
    };
    const segredos = ["/home/ana", "ana@proton.me", SEGREDO_LITERAL];

    const { payload, bloqueado } = montarPayload({
        titulo: textos.titulo,
        descricao: textos.descricao,
        log: textos.log,
        meta: metaBase(),
        segredos,
        token: TOKEN_MARCADOR,
    });

    assert.equal(bloqueado, false);
    const corpo = JSON.stringify(payload);
    for (const segredo of segredos) assert.equal(corpo.includes(segredo), false, `segredo vazou: ${segredo}`);
    assert.equal(segredosRemanescentes(corpo, segredos, TOKEN_MARCADOR).length, 0);
});

test("L3 bloqueia o envio quando um termo conhecido sobrevive em campo não redigido", () => {
    // O meta é montado fora do pipeline de redação: se um valor conhecido escapar para
    // lá, a varredura final precisa impedir o envio — e o payload bloqueado não pode
    // devolver o segredo.
    const meta = { ...metaBase(), origem: `/home/ana/${SEGREDO_LITERAL}` };

    const resultado = montarPayload({
        titulo: "Go Live nao sobe",
        descricao: "descricao limpa",
        log: "log limpo",
        meta,
        segredos: [SEGREDO_LITERAL],
        token: TOKEN_MARCADOR,
    });

    assert.equal(resultado.bloqueado, true);
    assert.equal(resultado.code, "SEGREDO_REMANESCENTE");
    assert.deepEqual(resultado.payload, { title: "", description: "", meta: {} });
    assert.equal(JSON.stringify(resultado).includes(SEGREDO_LITERAL), false);
});

test("título vazio é recusado localmente, sem montar corpo", () => {
    const resultado = montarPayload({
        titulo: "   ",
        descricao: "sem resumo",
        log: "log",
        meta: metaBase(),
        segredos: [],
        token: TOKEN_MARCADOR,
    });

    assert.equal(resultado.bloqueado, true);
    assert.equal(resultado.code, "TITULO_OBRIGATORIO");
    assert.deepEqual(resultado.payload, { title: "", description: "", meta: {} });
});

test("corte preserva o fim, não começa no meio de uma linha e cabe no teto", () => {
    const linhas = Array.from({ length: 5_000 }, (_, indice) => `linha ${String(indice).padStart(6, "0")} ${"x".repeat(64)}`);
    const original = linhas.join("\n");
    assert.ok(Buffer.byteLength(original, "utf8") > LOG_MAX_BYTES, "o caso de teste precisa passar do teto");

    const cortado = cortarCauda(original, LOG_MAX_BYTES);

    assert.ok(Buffer.byteLength(cortado, "utf8") <= LOG_MAX_BYTES, "o resultado precisa caber no teto");
    assert.ok(cortado.startsWith("[...] "), "falta o marcador de truncamento");
    assert.ok(cortado.endsWith(linhas[linhas.length - 1]), "a última linha do original precisa sobreviver");

    const primeira = cortado.split("\n")[0];
    assert.ok(linhas.includes(primeira.slice("[...] ".length)), "o trecho não pode começar no meio de uma linha");
    for (const linha of cortado.split("\n").slice(1)) assert.ok(linhas.includes(linha), `linha partida: ${linha.slice(0, 40)}`);
});

test("montagem do log deduplica o ring com a cauda e descarta a cauda sem âncora", () => {
    const segredos = [];
    const comAncora = montarLog({
        ring: "A\nB\nC",
        caudaArquivo: "X\nA\nB\nC",
        sessao: "=== sessao ===",
        segredos,
        token: TOKEN_MARCADOR,
    });

    assert.match(comAncora, /=== plugin \(memoria\) ===/);
    assert.match(comAncora, /=== plugin-vpn\.log \(antes do ring\) ===/);
    assert.ok(comAncora.includes("X"), "o trecho anterior ao ring precisa entrar");
    assert.equal(comAncora.split("B").length - 1, 1, "a sessão não pode aparecer duas vezes");

    const semAncora = montarLog({
        ring: "A\nB\nC",
        caudaArquivo: "Z\nW",
        sessao: "",
        segredos,
        token: TOKEN_MARCADOR,
    });
    assert.equal(complementoDaCauda("A\nB\nC", "Z\nW"), "");
    assert.doesNotMatch(semAncora, /Z/, "sem âncora a cauda é descartada");

    const semRing = montarLog({ ring: "", caudaArquivo: "Z\nW", sessao: "", segredos, token: TOKEN_MARCADOR });
    assert.doesNotMatch(semRing, /Z/, "sem ring não há como provar que a cauda não repete a sessão");
});

test("assinatura depende do que o usuário escreveu, não do log", () => {
    const a = assinaturaDoRelato("  Go Live nao sobe  ", "passos: abrir o Discord");
    const b = assinaturaDoRelato("Go Live nao sobe", "passos: abrir o Discord");
    const c = assinaturaDoRelato("Go Live nao sobe", "passos: abrir o Discord e entrar na call");

    assert.equal(a, b, "espaços nas bordas não mudam a assinatura");
    assert.equal(a.length, 16);
    assert.notEqual(b, c);
});

test("dedup de 48h só reprova a mesma assinatura dentro da janela", () => {
    const agora = 1_757_786_400;
    const relato = { signature: "9f2c1a7b3d4e5f60", issueUrl: "https://github.com/bezumiya/GoLiveBypass/issues/123", at: agora - 60 };

    assert.deepEqual(decidirEnvio(relato, relato.signature, agora), { enviar: false, issueUrl: relato.issueUrl });
    assert.deepEqual(decidirEnvio(relato, "outra-assinatura", agora), { enviar: true });
    assert.deepEqual(decidirEnvio(relato, relato.signature, agora + DEDUP_WINDOW_SECONDS + 1), { enviar: true });
    assert.deepEqual(decidirEnvio(null, relato.signature, agora), { enviar: true });
    assert.equal(estadoDeEnvioValido({ signature: "x", issueUrl: "y", at: 1 })?.issueUrl, "y");
    assert.equal(estadoDeEnvioValido({ signature: "x", issueUrl: "y" }), null);
    assert.equal(estadoDeEnvioValido("lixo"), null);
});

test("meta é lista branca e não carrega caminho, endpoint nem token", () => {
    const meta = montarMeta({
        versao: "2.0.6-beta-20",
        plataforma: "linux-x64",
        electron: "43.0.0",
        node: "22.0.0",
        estadoVpn: { state: "active", active: true, owned: false, generation: 3 },
        modo: "custom",
        onboarding: false,
    });

    assert.deepEqual(Object.keys(meta).sort(), [
        "app", "electron", "node", "onboarding", "plataforma", "versao",
        "vpn_ativa", "vpn_estado", "vpn_geracao", "vpn_modo", "vpn_propria",
    ]);
    assert.deepEqual(meta, {
        app: "golive-plugin",
        versao: "2.0.6-beta-20",
        plataforma: "linux-x64",
        electron: "43.0.0",
        node: "22.0.0",
        vpn_estado: "active",
        vpn_ativa: "sim",
        vpn_propria: "nao",
        vpn_geracao: "3",
        vpn_modo: "custom",
        onboarding: "nao",
    });

    const corpo = JSON.stringify(meta);
    assert.equal(corpo.includes(TOKEN_MARCADOR), false);
    for (const valor of Object.values(meta)) assert.equal(/[/\\]/.test(valor), false, `caminho no meta: ${valor}`);
});

test("resposta da API vira código de UI, sem ecoar token nem corpo bruto", () => {
    const criada = interpretarResposta(201, 0, JSON.stringify({ issue_number: 321, issue_url: "https://github.com/bezumiya/GoLiveBypass/issues/321" }));
    assert.deepEqual(criada, { ok: true, code: "OK", issueUrl: "https://github.com/bezumiya/GoLiveBypass/issues/321", issueNumber: 321 });

    assert.equal(interpretarResposta(400, 0, JSON.stringify({ error: "title e obrigatorio" })).code, "INVALIDO");
    assert.equal(interpretarResposta(400, 0, JSON.stringify({ error: "title e obrigatorio" })).error, "title e obrigatorio");
    assert.equal(interpretarResposta(401, 0, "{}").code, "NAO_AUTORIZADO");
    assert.equal(interpretarResposta(413, 0, "{}").code, "LOG_GRANDE");
    assert.equal(interpretarResposta(502, 0, "{}").code, "GITHUB");
    assert.equal(interpretarResposta(503, 0, "{}").code, "API_INDISPONIVEL");

    const bloqueio = interpretarResposta(429, 300, "{}");
    assert.equal(bloqueio.code, "BLOQUEADO");
    assert.equal(bloqueio.blocked, true);
    assert.equal(bloqueio.retryAfter, 300);
    // Sem header, o tempo vem do corpo.
    assert.equal(interpretarResposta(429, 0, JSON.stringify({ retry_after: 42 })).retryAfter, 42);

    for (const resultado of [criada, bloqueio, interpretarResposta(500, 0, "nao e json")]) {
        for (const chave of ["token", "authorization", "endpoint", "log"]) assert.equal(chave in resultado, false, `campo vazando: ${chave}`);
    }
});

test("o token só viaja no header Authorization do pedido montado", () => {
    const log = `boot | Authorization: Bearer ${TOKEN_MARCADOR} | sessao aberta`;
    const { payload, bloqueado } = montarPayload({
        titulo: "relato",
        descricao: "descricao",
        log,
        meta: metaBase(),
        segredos: ["/home/ana"],
        token: TOKEN_MARCADOR,
    });
    assert.equal(bloqueado, false);

    const pedido = montarPedido(payload, { url: "https://api.exemplo.test/v1/reports", token: TOKEN_MARCADOR });
    assert.equal(pedido.method, "POST");
    assert.equal(pedido.headers.Authorization, `Bearer ${TOKEN_MARCADOR}`);
    assert.equal(pedido.body.includes(TOKEN_MARCADOR), false, "o corpo nunca carrega o token");
    for (const [chave, valor] of Object.entries(pedido.headers)) {
        if (chave === "Authorization") continue;
        assert.equal(valor.includes(TOKEN_MARCADOR), false, `header ${chave} carrega o token`);
    }

    const status = montarPedidoDeStatus({ url: "https://api.exemplo.test/v1/block-status", token: TOKEN_MARCADOR });
    assert.equal(status.method, "GET");
    assert.equal(status.headers.Authorization, `Bearer ${TOKEN_MARCADOR}`);
    assert.equal(status.body, undefined);
});

test("status de bloqueio só é lido quando a API responde 200", () => {
    assert.deepEqual(interpretarStatusDeBloqueio(200, JSON.stringify({ blocked: false, remaining: 9 })), { blocked: false, retryAfter: 0, remaining: 9 });
    assert.deepEqual(interpretarStatusDeBloqueio(200, JSON.stringify({ blocked: true, retry_after: 120 })), { blocked: true, retryAfter: 120, remaining: 0 });
    // Falha na consulta nunca inventa bloqueio: o POST dá o veredito real.
    assert.deepEqual(interpretarStatusDeBloqueio(503, ""), { blocked: false, retryAfter: 0, remaining: 0 });
    assert.deepEqual(interpretarStatusDeBloqueio(200, "nao e json"), { blocked: false, retryAfter: 0, remaining: 0 });
});

test("entrada do renderer é cortada nos limites do contrato", () => {
    const limpo = limparEntradaDoRenderer({
        title: "t".repeat(TITLE_MAX + 50),
        description: "d".repeat(DESCRIPTION_MAX + 50),
        includeLogs: false,
        session: "s".repeat(SESSION_MAX + 50),
    });

    assert.equal(limpo.title.length, TITLE_MAX);
    assert.equal(limpo.description.length, DESCRIPTION_MAX);
    assert.equal(limpo.session.length, SESSION_MAX);
    assert.equal(limpo.includeLogs, false);

    const vazio = limparEntradaDoRenderer({ title: 42, description: null, session: undefined });
    assert.deepEqual(vazio, { title: "", description: "", includeLogs: true, session: "" });
    assert.deepEqual(limparEntradaDoRenderer(null), { title: "", description: "", includeLogs: true, session: "" });
});
