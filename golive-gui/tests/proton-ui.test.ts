import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

describe("controles Proton", () => {
  it("explica quando a rota otimizada passa a valer", () => {
    const html = fs.readFileSync(path.resolve(process.cwd(), "index.html"), "utf8");
    const button = html.match(/<button[^>]*id="protonOptimizeBtn"[^>]*>/)?.[0] ?? "";
    expect(button).toContain("title=\"Com o bypass ativo, o Discord fecha durante a medição e reabre após iniciar a nova rota.\"");
    expect(button).toContain("aria-label=");
  });

  it("nao chama a rota de conectada antes de o bypass estar ativo", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "src/main.ts"), "utf8");
    const fnStart = source.indexOf("async function optimizeProtonRoute");
    const fnEnd = source.indexOf("protonOptimizeBtn?.addEventListener", fnStart);
    const fnBody = source.slice(fnStart, fnEnd > fnStart ? fnEnd : undefined);
    expect(fnBody).toContain("const rotaEmUso = currentState === 'ACTIVE';");
    expect(fnBody).toContain("Rota ${selectedServerName} selecionada!");
    expect(fnBody).toContain("rotaEmUso");
    expect(fnBody).toContain("Rota ${selectedServerName} aplicada!");
  });

  it("refaz a otimização automática na abertura em vez de reutilizar o cache", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "src/main.ts"), "utf8");
    expect(source).toContain("refreshOnStartup: onStartup");
    expect(source).not.toContain("reuseMeasured: onStartup");
  });

  it("automatiza o CAPTCHA sem pedir token manual", () => {
    const html = fs.readFileSync(path.resolve(process.cwd(), "index.html"), "utf8");
    expect(html).not.toContain('id="protonCaptchaPanel"');
    expect(html).not.toContain('id="protonCaptchaOpenBtn"');
    expect(html).not.toContain('id="protonCaptchaToken"');
    const source = fs.readFileSync(path.resolve(process.cwd(), "src/main.ts"), "utf8");
    expect(source).toContain("onProtonCaptchaStatus");
    expect(source).not.toContain("humanVerificationToken: hvToken");
    expect(source).toContain("CAPTCHA_INVALID");
  });

  it("explica a interrupção durante a medição", () => {
    const html = fs.readFileSync(path.resolve(process.cwd(), "index.html"), "utf8");
    expect(html).toContain("o Discord fecha durante a medição e reabre após iniciar a nova rota");
  });

  it("renderiza progresso honesto e preserva métricas no encerramento", () => {
    const html = fs.readFileSync(path.resolve(process.cwd(), "index.html"), "utf8");
    expect(html).toContain('id="protonMeasurement"');
    expect(html).toContain('id="protonMeasurementCount"');
    expect(html).toContain('role="progressbar"');
    expect(html).not.toContain('aria-valuenow="0"');
    const source = fs.readFileSync(path.resolve(process.cwd(), "src/main.ts"), "utf8");
    expect(source).toContain("event.status !== undefined");
    expect(source).toContain("event.requestId !== protonOptimizationRequestId");
    expect(source).toContain("faltam ${Math.max(0, total - tested)}");
  });

  it("mostra a triagem de ping antes do preflight do túnel", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "src/main.ts"), "utf8");
    expect(source).toContain("event.phase === 'ping' ? 'rotas pingadas'");
    expect(source).toContain("Medindo o ping das rotas elegíveis");
    expect(source).toContain("Sem resposta ao ping");
  });

  it("exibe o servidor no formato país#servidor sem alterar o identificador interno", () => {
    const html = fs.readFileSync(path.resolve(process.cwd(), "index.html"), "utf8");
    expect(html).toContain('id="protonServerFlag"');
    expect(html).toContain('class="proton-country-flag proton-server-flag"');
    const source = fs.readFileSync(path.resolve(process.cwd(), "src/main.ts"), "utf8");
    expect(source).toContain("function formatProtonServerName");
    expect(source).toContain("formatProtonServerName(event.server)");
    expect(source).toContain("formatProtonServerName(s.lastServer.server)");
    expect(source).toContain("const selectedServerName = formatProtonServerName(res.server)");
    expect(source).toContain("renderProtonCountryFlag");
    expect(source).toContain("protonMeasurementRows.get(event.server)");
  });

  it("distingue a prova funcional da telemetria auxiliar", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "src/main.ts"), "utf8");
    expect(source).not.toContain("res.readiness?.verified === false");
    expect(source).not.toContain("Não foi possível confirmar a telemetria auxiliar do WireSock.");
  });

  it("mostra o estado do plano sem expor detalhes da sessão", () => {
    const html = fs.readFileSync(path.resolve(process.cwd(), "index.html"), "utf8");
    expect(html).toContain('id="protonPlanStatus"');
    expect(html).toContain('id="protonPlanRefreshBtn"');
    expect(html).toContain('aria-live="polite"');
    const source = fs.readFileSync(path.resolve(process.cwd(), "src/main.ts"), "utf8");
    expect(source).toContain("getProtonPlan({ force: forcePlan })");
    expect(source).toContain("Plano: não confirmado");
    expect(source).toContain("plan.status === 'premium'");
  });

  it("mantém cache e invalidação do plano por conta no processo principal", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "electron/main.ts"), "utf8");
    expect(source).toContain("15 * 60 * 1000");
    expect(source).toContain("cached.inFlight");
    expect(source).toContain("invalidateProtonPlanCache");
    expect(source).toContain('ipcMain.handle("get-proton-plan"');
  });
});
