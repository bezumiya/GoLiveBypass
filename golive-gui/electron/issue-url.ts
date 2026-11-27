// Link da issue devolvido pela API de relatos. A janela monta o "Ver issue" com ele e o
// "Relatar problema" abre o endereço com shell.openExternal. Como a janela roda com
// nodeIntegration e sem contextIsolation, e openExternal aceita qualquer protocolo
// (file:, javascript:, handlers do sistema), só passa uma issue do GitHub:
// https://github.com/<dono>/<repo>/issues/<número>, sem query nem fragmento.
const ISSUE_URL = /^https:\/\/github\.com\/[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}\/issues\/[1-9]\d{0,9}$/;

/** O endereço, se for o de uma issue do GitHub; qualquer outra coisa vira undefined. */
export function safeIssueUrl(value: unknown): string | undefined {
  return typeof value === "string" && ISSUE_URL.test(value) ? value : undefined;
}

/** Número de issue válido (inteiro positivo); qualquer outra coisa vira undefined. */
export function safeIssueNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
