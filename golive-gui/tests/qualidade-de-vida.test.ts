import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

// Mesmo estilo do ativacao-guard: o main.ts nao e importavel sem Electron, entao as regras
// que importam sao presas pelo texto do codigo.
const main = fs.readFileSync(path.resolve(process.cwd(), "electron/main.ts"), "utf8");
const html = fs.readFileSync(path.resolve(process.cwd(), "index.html"), "utf8");
const renderer = fs.readFileSync(path.resolve(process.cwd(), "src/main.ts"), "utf8");

describe("reiniciar bypass e checar updates", () => {
  it("reiniciar refaz a ativacao inteira, sem a guarda de 'ja esta ativo com a mesma assinatura'", () => {
    const start = main.indexOf('ipcMain.handle("restart-bypass"');
    const body = main.slice(start, main.indexOf('ipcMain.handle("check-updates"', start));
    expect(body).toContain('assinaturaUltimaAtivacao = ""');
    expect(body).toContain("await activateBypass(null)");
    expect(body).toContain("cancelStartupBypassRestore()");
  });

  it("checar updates forca a consulta e o botao fica ao lado do Como funciona", () => {
    expect(main).toMatch(/ipcMain\.handle\("check-updates"[\s\S]{0,700}force: true/);
    expect(html).toMatch(/id="guideBtn"[\s\S]{0,900}id="checkUpdatesBtn"/);
  });
});

describe("janela redimensionavel", () => {
  it("e redimensionavel, com minimo, e o app para de forcar a altura apos resize manual", () => {
    const create = main.slice(main.indexOf("function createWindow()"), main.indexOf("function loadLogsPage"));
    // Redimensionavel por padrao; so a janela compacta trava o tamanho (teste mais abaixo).
    expect(create).toContain("resizable: !compacta");
    expect(create).toContain("minWidth:");
    expect(create).toContain("tamanhoManual = true");
    const handler = main.slice(main.indexOf('ipcMain.on("resize-window"'), main.indexOf("set-theme"));
    expect(handler).toMatch(/if \(tamanhoManual \|\| mainWindow\.isMaximized\(\)\) return;/);
    // A largura vem da janela, nao da constante fixa de 720.
    expect(handler).not.toContain("setContentSize(MAIN_WINDOW_WIDTH");
  });

  it("estreita, as colunas empilham na vertical", () => {
    const css = fs.readFileSync(path.resolve(process.cwd(), "src/style.css"), "utf8");
    expect(css).toMatch(/@media \(max-width: 560px\) \{[\s\S]{0,200}grid-template-columns: 1fr;/);
  });
});

describe("sondas e varreduras", () => {
  it("a sonda periodica que copiava um .exe para a pasta do Discord saiu do app", () => {
    expect(main).not.toContain("diagnoseWindowsRoute");
    expect(main).not.toContain("prepareDiscordScopeProbes(");
  });

  it("a leitura de trafego do tunel usa netsh e so cai no PowerShell se o netsh falhar", () => {
    const wiresock = fs.readFileSync(path.resolve(process.cwd(), "electron/wiresock.ts"), "utf8");
    const fn = wiresock.slice(wiresock.indexOf("export async function getWireSockAdapterTrafficAsync"));
    expect(fn.indexOf('"netsh"')).toBeGreaterThan(-1);
    expect(fn.indexOf('"netsh"')).toBeLessThan(fn.indexOf('"powershell.exe"'));
  });

  it("o card de trafego e o modo desenvolvedor ficam nas telas esperadas", () => {
    expect(html).toContain('id="trafficCard"');
    expect(html).toMatch(/id="settingsDialog"[\s\S]*id="devModeToggle"[\s\S]*id="guideDialog"/);
    expect(renderer).not.toContain("import.meta.env.DEV");
  });
});

describe("processos em segundo plano (amostrador de failover, a cada 3 s)", () => {
  const wiresock = fs.readFileSync(path.resolve(process.cwd(), "electron/wiresock.ts"), "utf8");

  it("o amostrador le o estado do WireSock uma vez e repassa a resposta", () => {
    const sample = main.slice(main.indexOf("async function collectProtonFailoverSample"), main.indexOf("function stopProtonFailoverMonitor"));
    expect(sample).toContain("getWireSockConnectionStatusAsync({ activeHint: tunnelActive })");
    expect(sample.match(/isWireSockActiveAsync\(/g)?.length).toBe(1);
    expect(wiresock).toContain("options.activeHint ?? await isWireSockActiveAsync()");
  });

  it("com o tunel ativo, o tasklist responde antes dos dois sc query", () => {
    const fn = wiresock.slice(wiresock.indexOf("export async function isWireSockActiveAsync"), wiresock.indexOf("export async function getWireSockConnectionStatusAsync"));
    expect(fn.indexOf('"tasklist"')).toBeGreaterThan(-1);
    expect(fn.indexOf('"tasklist"')).toBeLessThan(fn.indexOf('"sc.exe"'));
    // A mesma leitura do original: servico em RUNNING, agora pelo codigo do SCM
    // (o rotulo `STATE` do `sc query` e traduzido e nao pode ser usado).
    expect(fn).toContain("scQueryShowsRunning(output)");
  });

  it("a procura da CLI do WireSock e guardada em cache (evita `where` sincrono a cada tique)", () => {
    expect(wiresock).toMatch(/export const findWireSockCli = memoizeWithTtl\(procurarWireSockCli, 60_000\)/);
  });

});

describe("integridade do CSS", () => {
  it("as chaves e os comentarios do style.css estao balanceados", () => {
    // Uma chave sem fechar nao da erro: o navegador aninha tudo que vem depois dentro da regra
    // aberta e as regras seguintes deixam de valer, sem aviso. Ja aconteceu numa fusao de conflito.
    const css = fs.readFileSync(path.resolve(process.cwd(), "src/style.css"), "utf8");
    const semComentarios = css.replace(/\/\*[\s\S]*?\*\//g, "");
    expect((css.match(/\/\*/g) ?? []).length).toBe((css.match(/\*\//g) ?? []).length);
    expect((semComentarios.match(/\{/g) ?? []).length).toBe((semComentarios.match(/\}/g) ?? []).length);
  });

  it("as regras do fim do arquivo ficam na raiz (nao aninhadas em outra regra)", () => {
    const css = fs.readFileSync(path.resolve(process.cwd(), "src/style.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    let profundidade = 0;
    let maxNoFim = 0;
    const fim = css.indexOf(".corner--tr3 {");
    expect(fim).toBeGreaterThan(-1);
    for (let i = 0; i < fim; i++) {
      if (css[i] === "{") profundidade++;
      else if (css[i] === "}") profundidade--;
    }
    maxNoFim = profundidade;
    expect(maxNoFim).toBe(0);
  });
});

describe("menos processos: leituras compartilhadas e fora da thread principal", () => {
  const wiresock = fs.readFileSync(path.resolve(process.cwd(), "electron/wiresock.ts"), "utf8");

  it("o amostrador de failover faz um tasklist so e deriva Discord e WireSock dele", () => {
    const sample = main.slice(main.indexOf("async function collectProtonFailoverSample"), main.indexOf("function stopProtonFailoverMonitor"));
    expect(sample).toContain("await listRunningImageNamesAsync()");
    expect(sample).toContain('imagens.has("wiresock-client.exe")');
    expect(sample).toContain("isWireSockActiveAsync({ processAlive:");
    // Se o tasklist unico falhar, cada pergunta cai no caminho proprio, como antes.
    expect(sample).toContain(": await discordIsRunningAsync()");
  });

  it("a espera da ativacao nao usa mais execSync (congelava a janela ate ~5 s por ativacao)", () => {
    const fn = wiresock.slice(wiresock.indexOf("async function isWireSockProcessPidAlive"), wiresock.indexOf("// Fonte de verdade"));
    expect(fn).toContain("await execFileText(");
    expect(fn).not.toContain("execSync");
    expect(wiresock).not.toMatch(/\bexecSync\(/);
  });

  it("o monitor do card consulta o ping a cada 10 s e revisa o netsh de 30 em 30 s sem o adaptador", () => {
    expect(main).toContain("trafficMonitorPlan(tique++, contadoresDisponiveis)");
    expect(main).toMatch(/whenProcessStops\(discordProcessStateAsync[\s\S]{0,900}intervalMs: 10_000/);
  });
});

describe("ilustracao animada do Como funciona", () => {
  const css = fs.readFileSync(path.resolve(process.cwd(), "src/style.css"), "utf8");

  it("o desenho esta no painel, e acessivel e usa as cores do tema", () => {
    const painel = html.slice(html.indexOf('id="guideDialog"'), html.indexOf('class="guide-intro"'));
    expect(painel).toMatch(/<svg class="guide-art"[^>]*role="img"/);
    expect(painel).toContain('<title id="guideArtTitle">');
    expect(painel).toContain('<desc id="guideArtDesc">');
    expect(painel).not.toMatch(/fill="#|stroke="#/); // sem cor fixa: claro e escuro vem do CSS
  });

  it("nao encolhe a altura 0 dentro do painel flex (bug real: o desenho sumia)", () => {
    const regra = css.slice(css.indexOf(".guide-art {"), css.indexOf(".guide-art .ga-box {"));
    expect(regra).toContain("flex: 0 0 auto;");
  });

  it("anima os pacotes e fica parado com prefers-reduced-motion", () => {
    expect(css).toContain("@keyframes ga-flow");
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]{0,300}\.guide-art \.ga-packet \{ animation: none;/);
  });
});

describe("janela compacta (trava no tamanho minimo, em coluna)", () => {
  const preload = fs.readFileSync(path.resolve(process.cwd(), "electron/preload.ts"), "utf8");

  it("abre na largura minima e travada quando a preferencia esta ligada", () => {
    const create = main.slice(main.indexOf("function createWindow()"), main.indexOf("function loadLogsPage"));
    expect(main).toContain("const COMPACT_WINDOW_WIDTH = 360;");
    expect(create).toContain("width: compacta ? COMPACT_WINDOW_WIDTH : MAIN_WINDOW_WIDTH");
    expect(create).toContain("resizable: !compacta");
    // A largura compacta e a mesma do minimo: o layout em coluna ja foi medido nela.
    expect(create).toMatch(/minWidth: COMPACT_WINDOW_WIDTH/);
  });

  it("ligar ou desligar vale na hora e nao conta como redimensionamento manual", () => {
    const ipc = main.slice(main.indexOf('ipcMain.handle("set-compact-window"'), main.indexOf('ipcMain.handle("restart-bypass"'));
    expect(ipc).toContain("setResizable(");
    expect(ipc).toContain("tamanhoPedidoPeloApp = ");
    expect(ipc).toContain("tamanhoManual = false");
    expect(ipc).toContain("janelaCompacta");
    expect(main).toContain('ipcMain.handle("get-compact-window"');
    expect(preload).toContain("setCompactWindow");
    expect(preload).toContain("getCompactWindow");
  });

  it("o interruptor fica nas Configuracoes e a preferencia e lida ao abrir o dialogo", () => {
    expect(html).toMatch(/id="settingsDialog"[\s\S]*id="compactWindowToggle"[\s\S]*id="guideDialog"/);
    expect(renderer).toContain("window.api.setCompactWindow(");
    expect(renderer).toContain("window.api.getCompactWindow()");
  });
});

describe("failover: o netsh nao e repetido quando o adaptador ProTUN nao existe", () => {
  const wiresock = fs.readFileSync(path.resolve(process.cwd(), "electron/wiresock.ts"), "utf8");

  it("lembra a ausencia por 30 s, mas so quando o chamador pede (a prontidao nao pede)", () => {
    const fn = wiresock.slice(wiresock.indexOf("export async function getWireSockAdapterTrafficAsync"), wiresock.indexOf("function tunelConfirmado"));
    expect(fn).toContain("options.lembrarAusencia && Date.now() < adaptadorAusenteAte");
    expect(fn).toContain("adaptadorAusenteAte = Date.now() + 30_000");
    const sample = main.slice(main.indexOf("async function collectProtonFailoverSample"), main.indexOf("function stopProtonFailoverMonitor"));
    expect(sample).toContain("getWireSockAdapterTrafficAsync({ lembrarAusencia: true })");
    const readiness = main.slice(main.indexOf("async function waitForWindowsWgReady"), main.indexOf("function iniciarWgStatsWatchdog") > 0 ? main.indexOf("function iniciarWgStatsWatchdog") : undefined);
    expect(readiness).not.toContain("lembrarAusencia");
  });
});

describe("Sair com o bypass ativo nao trava", () => {
  const quit = main.slice(main.indexOf('app.on("before-quit"'), main.indexOf('app.on("window-all-closed"'));

  it("no Windows o Sair chama o deactivateAll direto, sem embrulhar na fila (que nao e reentrante)", () => {
    expect(quit).toContain("? deactivateAll()");
    expect(quit).not.toContain('withWireSockLifecycle("encerrar-windows"');
    // O deactivateAll se serializa sozinho: se deixasse de fazer isso, o Sair perderia a serializacao.
    const fn = main.slice(main.indexOf("async function deactivateAll("), main.indexOf("// O status do Windows e sempre lido"));
    expect(fn).toContain('withWireSockLifecycle("desativacao"');
  });

  it("a limpeza tem prazo: se travar, o app encerra assim mesmo", () => {
    expect(main).toContain("const QUIT_CLEANUP_TIMEOUT_MS = 90_000;");
    expect(quit).toContain("settlesWithin(limpeza, QUIT_CLEANUP_TIMEOUT_MS)");
    expect(quit).toMatch(/\.finally\(\(\) => app\.quit\(\)\)/);
  });
});

describe("checar updates nao finge que verificou", () => {
  it("avisa quando ja ha uma verificacao em andamento em vez de responder ok", () => {
    const updater = fs.readFileSync(path.resolve(process.cwd(), "electron/updater.ts"), "utf8");
    expect(updater).toContain("export function isCheckingForUpdate(): boolean {");
    const ipc = main.slice(main.indexOf('ipcMain.handle("check-updates"'), main.indexOf('ipcMain.handle("restore-internet"'));
    expect(ipc).toContain("const jaVerificando = isCheckingForUpdate();");
    expect(ipc).toContain("jaVerificando");
    expect(renderer).toContain("result.jaVerificando");
  });
});
