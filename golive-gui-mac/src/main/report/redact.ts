// Redacao do report em camadas — arquivo PURO (zero imports de Electron) para ser
// testavel com vitest sem mock de app.
//
//   L1 — padroes conhecidos (regex): credenciais em URL, cabecalhos de auth,
//        tokens do Discord, query string de URL do gateway, o proprio token da API.
//   L2 — segredos conhecidos: valores REAIS configurados pelo usuario (usuario,
//        senha e host da proxy personalizada em settings.json) removidos por
//        ocorrencia literal — pega vazamento fora de padrao tambem.
//   L3 — varredura final: sobrou algum segredo conhecido no payload? Entao nada
//        sai da maquina: o envio falha por seguranca.
//
// Regra do produto: hosts/portas de gateway do Discord e saidas podem aparecer
// (diagnostico precisa disso); credenciais da proxy personalizada JAMAIS.

export type SegredosConhecidos = string[];

// Credenciais embutidas na URL: scheme://usuario:senha@host -> usuario:***@host
const RE_CREDS_URL = /(\w[\w+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/g;
// Cabecalhos de autenticacao inteiros (linha em log de rede, dump, etc.)
const RE_HEADER_AUTH = /^((?:proxy-)?authorization\s*:\s*).+$/gim;
// Tokens do Discord (formato mfa.* e JWT-like de 3 segmentos)
const RE_DISCORD_TOKEN = /\b(mfa\.[\w-]{20,}|[MN][\w-]{23}\.[\w-]{6}\.[\w-]{27,40})\b/g;
// Query string de URL do gateway carrega params de sessao — so o host interessa
const RE_GATEWAY_QUERY = /(https:\/\/gateway[^?\s]+)\?\S*/g;
// Identificadores pessoais que podem aparecer em mensagens de erro, descricoes ou logs.
const RE_EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const RE_HOME_POSIX = /(\/(?:home|var\/home|Users)\/)[^/\s]+/g;
const RE_HOME_WINDOWS = /([A-Z]:\\Users\\)[^\\\s]+/gi;
// "as another user: Not authorized" e a frase fixa do pkexec, nao um nome: sem a exclusao o relato
// perdia justamente o "Not" e a causa da recusa (#404, fechamento negado pelo polkit).
const RE_IDENTITY_LABEL = /\b(?<!another\s)(nome|name|usu[aá]rio|username|user)\s*([:=])\s*[^\s,;]+/gi;

export function l1Padroes(texto: string): string {
  return (
    texto
      .replace(RE_CREDS_URL, (_tudo, scheme, user) => `${scheme}${user}:***@`)
      .replace(RE_HEADER_AUTH, "$1***")
      .replace(RE_DISCORD_TOKEN, "***")
      .replace(RE_GATEWAY_QUERY, "$1?<params>")
      .replace(RE_EMAIL, "<email>")
      .replace(RE_HOME_POSIX, "$1<usuario>")
      .replace(RE_HOME_WINDOWS, "$1<usuario>")
      .replace(RE_IDENTITY_LABEL, "$1$2<usuario>")
  );
}

export function l2Segredos(texto: string, segredos: SegredosConhecidos): string {
  let out = texto;
  for (const s of segredos) {
    if (s.length < 3) continue;
    // split/join em vez de replace com regex: segredo pode conter metacaracteres
    out = out.split(s).join("<proxy-pessoal>");
  }
  return out;
}

export function redigir(texto: string, segredos: SegredosConhecidos, tokenApi?: string): string {
  let out = l1Padroes(texto);
  const todos = tokenApi ? [...segredos, tokenApi] : segredos;
  return l2Segredos(out, todos);
}

// L3: devolve os segredos que SOBREVIVERAM ao pipeline. Lista nao-vazia = bloquear
// o envio (nada deve sair da maquina com segredo do usuario dentro).
export function segredosRemanescentes(
  texto: string,
  segredos: SegredosConhecidos,
  tokenApi?: string,
): string[] {
  const todos = tokenApi ? [...segredos, tokenApi] : segredos;
  return todos.filter((s) => s.length >= 3 && texto.includes(s));
}

// Corta preservando o fim (o recente importa mais) sem partir uma linha no meio.
export function cortarDoFim(texto: string, maxBytes: number): string {
  const buf = Buffer.from(texto, "utf8");
  if (buf.length <= maxBytes) return texto;
  const cauda = buf.subarray(buf.length - maxBytes);
  const primeiraQuebra = cauda.indexOf(10); // \n
  const inicio = primeiraQuebra >= 0 ? primeiraQuebra + 1 : 0;
  return "[...] " + cauda.subarray(inicio).toString("utf8");
}
