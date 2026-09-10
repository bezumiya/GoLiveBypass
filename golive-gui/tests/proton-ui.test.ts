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

  it("exibe a rota selecionada no dropdown sem alterar o identificador interno", () => {
    const html = fs.readFileSync(path.resolve(process.cwd(), "index.html"), "utf8");
    expect(html).toContain('id="protonCountrySelect"');
    expect(html).not.toContain('id="protonServerBadge"');
    expect(html).not.toContain('id="protonServerFlag"');
    const source = fs.readFileSync(path.resolve(process.cwd(), "src/main.ts"), "utf8");
    expect(source).toContain("function formatProtonServerName");
    expect(source).toContain("formatProtonServerName(event.server)");
    expect(source).toContain("protonSelectedRoute = rememberedServer");
    expect(source).toContain("const selectedServerName = formatProtonServerName(res.server)");
    expect(source).toContain("renderProtonCountryFlag");
    expect(source).toContain("protonMeasurementRows.get(event.server)");
  });

  it("mantém o diálogo de otimização enxuto e deixa a seleção no dropdown", () => {
    const html = fs.readFileSync(path.resolve(process.cwd(), "index.html"), "utf8");
    expect(html).not.toContain('id="protonManualFallback"');
    expect(html).not.toContain('id="protonManualRecommendationBtn"');
    expect(html).toContain('id="protonMeasurementActions"');
    const source = fs.readFileSync(path.resolve(process.cwd(), "src/main.ts"), "utf8");
    expect(source).toContain("reduceManualRouteEvent");
    expect(source).toContain("sortManualRouteCandidates");
    expect(source).toContain("recommendManualRoute");
    expect(source).toContain("const orderedCandidates = recommendedServer");
    expect(source).toContain("const routes: ProtonRouteOption[] = orderedCandidates.map");
    expect(source).toContain("isManualRouteActionable");
    expect(source).toContain(".filter(isManualRouteSelectable)");
    expect(source).not.toContain("renderManualRouteChoices");
    expect(source).not.toContain("protonManualFallback");
    expect(source).toContain("needsManualPingRecovery");
    expect(source).toContain("measurePing = false");
    expect(source).toContain("...(measurePing ? { measurePing: true } : {})");
    expect(source).toContain("window.api.selectProtonRoute({ measurementId: protonManualMeasurementId, server })");
    expect(source).toContain("toggleBtn.disabled = busy || protonOptimizationInFlight");
    expect(source).toContain("protonCloseMeasurementBtn.disabled = busy");
    expect(source).toContain("if (protonOptimizationInFlight || protonManualSelectionInFlight) return;");
  });
  it("exibe skeleton, catálogo progressivo e preserva a rota manual salva", () => {
    const renderer = fs.readFileSync(path.resolve(process.cwd(), "src/main.ts"), "utf8");
    const preload = fs.readFileSync(path.resolve(process.cwd(), "electron/preload.ts"), "utf8");
    const electron = fs.readFileSync(path.resolve(process.cwd(), "electron/main.ts"), "utf8");
    const routePool = fs.readFileSync(path.resolve(process.cwd(), "../tools/proton-confgen/cmd/protonvpn-wg/main.go"), "utf8");
    const select = fs.readFileSync(path.resolve(process.cwd(), "src/proton-route-select.ts"), "utf8");
    const styles = fs.readFileSync(path.resolve(process.cwd(), "src/style.css"), "utf8");
    expect(renderer).toContain("window.api.discoverProtonRoutes({");
    expect(renderer).toContain("protonCountrySelect?.setLoading(true)");
    expect(renderer).toContain("protonManualMeasurementId = result.measurementId");
    expect(renderer).toContain("void discoverProtonRoutesInBackground()");
    expect(renderer).toContain("let protonRouteCatalogCandidates = new Map");
    expect(renderer).toContain("function mergedProtonManualCandidates()");
    expect(renderer).toContain("function updateProtonRouteDiscoveryProgress");
    expect(renderer).toContain("event.phase !== 'catalog'");
    expect(renderer).not.toContain("PROTON_ROUTE_POOL_SIZE");
    expect(renderer).not.toContain("protonRouteDiscoveryPreviewCandidates");
    expect(renderer).not.toContain("slice(0, 3)");
    expect(renderer).toContain("sortManualRouteCandidates(mergedProtonManualCandidates().values())");
    expect(renderer).toContain("protonRouteCatalogCandidates = candidates");
    expect(renderer).not.toContain("protonManualCandidates = new Map(candidates)");
    expect(renderer).toContain("function flushProtonRouteDiscovery()");
    expect(renderer).toContain("function queueProtonRouteDiscoveryAfterOptimization");
    expect(renderer).toContain("queueProtonRouteDiscoveryAfterOptimization(needsManualPingRecovery)");
    expect(renderer).toContain("Rota manual salva · execute uma nova medição para trocar");
    expect(renderer).toContain("protonRouteDiscoveryRetryPending");
    expect(renderer).toContain("rota de boot ainda está sendo restaurada");
    expect(renderer).not.toContain("protonManualCatalogRetryBtn");
    expect(preload).toContain("ipcRenderer.invoke('discover-proton-routes', options)");
    expect(preload).toContain("proton-route-discovery-progress");
    expect(electron).toContain('ipcMain.handle("discover-proton-routes"');
    expect(electron).toContain("generateProtonRouteCatalog");
    expect(electron).toContain("excludeServers: previousServer ? [previousServer] : []");
    expect(electron).toContain("onProgress: sendDiscoveryProgress");
    expect(routePool).toContain("SpeedCandidatesWithProgressExcluding(servers, cfg.RoutePoolSize, excluded, pingProgress)");
    expect(select).toContain("proton-route-select__loading");
    expect(select).toContain("this.measuredRoutes.forEach((option) => this.menu.appendChild(this.createOption(option)))");
    expect(select).toContain("const selectableRouteCount = this.measuredRoutes.filter((option) => !option.disabled).length");
    expect(select).toContain("ROUTE_LOADING_PLACEHOLDERS");
    expect(select).toContain("this.loadingState ? []");
    expect(select).toContain("Rotas Proton disponíveis");
    expect(select).toContain("proton-route-select__option-description-row");
    expect(select).toContain("recommendedBadge = document.createElement('span')");
    expect(select).toContain("button.appendChild(recommendedBadge)");
    expect(select).not.toContain("descriptionRow.appendChild(badge)");
    expect(select).not.toContain("label: 'Automático'");
    expect(select).not.toContain("proton-route-select__group");
    expect(styles).toContain("max-height: 164px;");
    expect(styles).toContain("min-height: 48px;");
    expect(styles).toContain("grid-template-rows: minmax(0, 1fr) auto;");
    expect(styles).toContain("overflow-y: auto;");
    expect(styles).toContain("scrollbar-width: thin;");
    expect(styles).toContain(".proton-route-select__menu::-webkit-scrollbar");
    expect(styles).toContain(".proton-route-select__menu::-webkit-scrollbar-thumb");
    expect(styles).not.toContain(".proton-manual-fallback");
    expect(styles).toContain("width: 5px;");
    expect(styles).toContain(".vpn-config-card:has(.proton-route-select.is-open)");
    expect(styles).toContain("grid-template-columns: auto minmax(0, 1fr);");
  });


  it("mantém a escolha automática ou manual entre sessões", () => {
    const renderer = fs.readFileSync(path.resolve(process.cwd(), "src/main.ts"), "utf8");
    const electron = fs.readFileSync(path.resolve(process.cwd(), "electron/main.ts"), "utf8");
    expect(renderer).not.toContain("renderManualRouteChoices('cancelled')");
    expect(renderer).toContain("protonRoutePreference = manualPreference ? 'manual' : 'auto';");
    expect(renderer).toContain("protonRememberedManualRoute = manualPreference && rememberedServer");
    expect(renderer).toContain("Rota manual salva · execute uma nova medição para trocar");
    expect(renderer).toContain("protonSelectedRoute = rememberedServer");
    expect(renderer).toContain("country: ''");
    expect(renderer).not.toContain("protonCountryFilter");
    expect(renderer).toContain("currentVpnMode === 'proton' && isProtonAuthenticated && shouldOptimizeProtonAutomatically()");
    expect(electron).toContain('protonRoutePreference: "manual"');
    expect(electron).toContain('protonRoutePreference: "auto"');
    expect(electron).toContain('if (sessions && ("deferred" in result && result.deferred))');
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
