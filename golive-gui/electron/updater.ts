// Atualizacao automatica via GitHub Releases — sem servidor proprio.
//
// Windows: o target e portable, e o electron-updater nao suporta portable (so NSIS).
// Entao o update do Windows e proprio: consulta as releases na API do GitHub (canal
// estavel so ve releases "de verdade"; o canal beta dos testadores inclui as
// prereleases — regra de escolha no updater-channel.ts), baixa e confere o exe novo,
// agenda a troca via PORTABLE_EXECUTABLE_FILE (a variavel que o electron-builder
// portable define) depois da saida do processo e reabre a versao nova.
//
// Mac e Linux: o autoUpdater do electron-updater cuida (dmg/zip assinado e AppImage).
// O canal beta do Linux e nativo do electron-updater: allowPrerelease faz ele ler o
// canal beta.yml — que o electron-builder publica sozinho para versao com sufixo
// de prerelease — em vez do latest.yml.

import { app, dialog, BrowserWindow } from "electron";
import { createWriteStream, readFileSync } from "fs";
import { createHash } from "crypto";
import { rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { autoUpdater } from "electron-updater";
import { request } from "https";
import { cleanupOldExe, spawnWindowsUpdateHelper } from "./updater-replace";
import { escolherRelease, type Canal, type ReleaseCandidata } from "./updater-channel";

// O fork pdl-clay e o canal de distribuicao desta linha de testes/releases.
// O updater e o publisher precisam apontar para o mesmo repositorio: consultar o
// upstream aqui faria o app detectar uma versao que nunca conseguiria baixar do
// fork (ou ignorar completamente a release beta criada para os testadores).
const REPO = "pdl-clay/GoLiveBypass";
// O artifactName leva a versao (GoLiveBypass-1.1.5.exe): o AppImageLauncher e
// outros integradores nao sobrescrevem o arquivo quando o nome muda por versao.
const EXE_PREFIX = "GoLiveBypass-";
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // re-checa a cada 4h

let lastCheckAt = 0;
let checking = false;
let updateReady = false;

// ------------------------------------------------------------------ GitHub API

// Lista as releases recentes (20 dao e sobram: a escolha e por VERSAO, nao por
// ordem). A API publica nao devolve drafts; devolve prereleases — que o canal
// estavel filtra e o canal beta consome (regras no updater-channel.ts).
function githubReleases(): Promise<ReleaseCandidata[]> {
  return new Promise((resolve) => {
    console.log(`[updater] consultando releases do fork ${REPO}`);
    const req = request(
      {
        host: "api.github.com",
        path: `/repos/${REPO}/releases?per_page=20`,
        method: "GET",
        headers: { "User-Agent": "GoLiveBypass", Accept: "application/vnd.github+json" },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          console.warn(`[updater] consulta de releases falhou: HTTP ${res.statusCode ?? "desconhecido"}`);
          return resolve([]);
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          body += c;
          if (body.length > 2_000_000) req.destroy(new Error("resposta de releases grande demais"));
        });
        res.on("error", (error) => {
          console.warn("[updater] leitura das releases falhou:", error);
          resolve([]);
        });
        res.on("end", () => {
          try {
            const data = JSON.parse(body) as Array<Record<string, unknown>>;
            const releases: ReleaseCandidata[] = [];
            for (const item of data) {
              if (item.draft === true) continue;
              const assets = (item.assets || []) as Array<{
                name: string;
                browser_download_url?: string;
                digest?: string;
              }>;
              const asset = assets.find(
                (a) =>
                  typeof a?.name === "string" &&
                  a.name.startsWith(EXE_PREFIX) &&
                  a.name.endsWith(".exe"),
              );
              if (!asset || !asset.browser_download_url) continue;
              releases.push({
                tag: String(item.tag_name),
                url: asset.browser_download_url,
                digest: typeof asset.digest === "string" ? asset.digest : null,
                prerelease: item.prerelease === true,
              });
            }
            console.log(`[updater] releases com executavel encontradas: ${releases.length}`);
            resolve(releases);
          } catch {
            console.warn("[updater] resposta de releases invalida");
            resolve([]);
          }
        });
      },
    );
    req.on("error", (error) => {
      console.warn("[updater] consulta de releases falhou:", error);
      resolve([]);
    });
    req.setTimeout(15_000, () => req.destroy(new Error("timeout consultando releases")));
    req.end();
  });
}

// O browser_download_url do GitHub sempre responde 302 para release-assets.githubusercontent.com,
// e o request do Node nao segue redirecionamento sozinho. Sem isto o download do Windows falhava
// em toda tentativa: o app achava a versao nova e nunca conseguia baixar.
const MAX_REDIRECTS = 5;

function downloadFile(url: string, dest: string, hops = MAX_REDIRECTS): Promise<void> {
  return new Promise((resolve, reject) => {
    // So https: um redirecionamento para http rebaixaria a conexao em silencio, e o que vem por
    // ela substitui o executavel em uso.
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return reject(new Error("URL de download invalida"));
    }
    if (parsedUrl.protocol !== "https:") {
      return reject(new Error("recusando destino que nao e https: " + url));
    }
    console.log(`[updater] iniciando download pelo host ${parsedUrl.hostname}`);

    const req = request(url, { headers: { "User-Agent": "GoLiveBypass" } }, (res) => {
      const { statusCode, headers } = res;
      res.on("error", reject);

      if (statusCode !== undefined && statusCode >= 300 && statusCode < 400 && headers.location) {
        res.resume();
        if (hops <= 0) return reject(new Error("redirecionamentos demais"));
        let redirecionada: string;
        try {
          redirecionada = new URL(headers.location, url).toString();
        } catch {
          return reject(new Error("redirecionamento de download invalido"));
        }
        console.log(`[updater] seguindo redirecionamento para ${new URL(redirecionada).hostname}`);
        return downloadFile(redirecionada, dest, hops - 1).then(resolve, reject);
      }

      if (statusCode !== 200) {
        res.resume();
        return reject(new Error("download falhou: HTTP " + statusCode));
      }

      let bytes = 0;
      res.on("data", (chunk: Buffer) => { bytes += chunk.length; });
      const out = createWriteStream(dest);
      res.pipe(out);
      // Aguarda o fechamento do descritor, nao apenas o evento finish. Isso evita
      // ler o arquivo enquanto o ultimo flush ainda esta terminando no Windows.
      out.on("close", () => {
        console.log(`[updater] download concluido: ${bytes} bytes`);
        resolve();
      });
      out.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

// A API do GitHub devolve o digest do anexo na mesma resposta autenticada por TLS de onde sai a
// URL. Conferir aqui deixa o Windows no mesmo nivel de Linux e macOS, que ganham a checagem de
// graca pelo electron-updater. Sem isto, um arquivo truncado no meio do caminho viraria o
// executavel em uso.
function digestMatches(file: string, digest: string | null): boolean {
  if (digest === null) {
    console.warn("[updater] anexo sem digest na API; nao vou instalar sem conferir.");
    return false;
  }

  const [algo, esperado] = digest.split(":", 2);
  if (algo !== "sha256" || esperado === undefined || !/^[0-9a-f]{64}$/i.test(esperado)) return false;

  try {
    const obtido = createHash(algo).update(readFileSync(file)).digest("hex");
    if (obtido === esperado) return true;

    console.error(`[updater] ${algo} nao confere: esperado ${esperado}, obtido ${obtido}`);
    return false;
  } catch (error) {
    console.error("[updater] falhei ao conferir o digest:", error);
    return false;
  }
}

// ------------------------------------------------------------------ Windows portable

function portableExePath(): string | null {
  // O electron-builder portable define esta variavel com o caminho do exe em uso.
  const current = process.env.PORTABLE_EXECUTABLE_FILE;
  return current && current.trim() !== "" ? current : null;
}

async function updateWindowsPortable(url: string, digest: string | null): Promise<boolean> {
  const current = portableExePath();
  if (current === null) {
    console.warn("[updater] PORTABLE_EXECUTABLE_FILE nao definido; pulando update.");
    return false;
  }

  // Um nome por processo evita reaproveitar um parcial deixado por outra cópia
  // portable ou por uma tentativa interrompida.
  const downloaded = join(tmpdir(), `GoLiveBypass-update-${process.pid}.exe`);
  try {
    await downloadFile(url, downloaded);
  } catch (error) {
    await rm(downloaded, { force: true }).catch(() => {});
    console.error("[updater] download falhou:", error);
    return false;
  }

  // Conferido antes de encostar no exe em uso: o helper so recebe um arquivo que bate
  // com o digest publicado; um arquivo invalido e apagado e a versao atual continua.
  if (!digestMatches(downloaded, digest)) {
    console.error("[updater] digest do executavel baixado nao confere");
    await rm(downloaded, { force: true }).catch(() => {});
    return false;
  }
  console.log("[updater] digest conferido; agendando troca apos encerrar o executavel portable");

  // O Windows nao permite renomear o exe que ainda esta em execucao. O helper faz a
  // troca somente depois que este processo sair; se ele nao puder ser agendado, mantem
  // o app aberto e permite uma nova tentativa, em vez de fechar sem atualizar.
  if (!spawnWindowsUpdateHelper(current, downloaded)) {
    await rm(downloaded, { force: true }).catch(() => {});
    console.error("[updater] nao consegui agendar a troca do exe portable.");
    return false;
  }

  // O quit nao reverte o bypass: o processo novo assume e o before-quit do processo
  // antigo desfaria a injecao apenas em uma saida normal.
  markQuittingForUpdate();
  console.log("[updater] helper de relancamento agendado; encerrando processo atual");
  return true;
}

// O main process consulta esta flag no before-quit: quando o auto-update esta
// aplicando, o quit nao pode ser segurado (senao o app antigo fica vivo e o
// novo morre no lock de instancia unica — o "fecha mas nao abre").
let quittingForUpdate = false;
export function markQuittingForUpdate() {
  quittingForUpdate = true;
}
export function isQuittingForUpdate() {
  return quittingForUpdate;
}

// ------------------------------------------------------------------ API publica

export function setupUpdater(
  getMainWindow: () => BrowserWindow | null,
  isAutoUpdateEnabled: () => boolean = () => true,
  canalAtual: () => Canal = () => "stable",
) {
  // Em desenvolvimento nao existe um AppImage/portable que possa receber update. Forcar
  // electron-updater a usar dev-app-update.yml fazia o npm run dev consultar uma release
  // com a versao local (ex.: v1.1.12-dev.8) e registrar um 404 ruidoso no terminal.
  // Updates sao comportamento do aplicativo empacotado; o dev so valida a interface.
  const isDev = !app.isPackaged;
  if (isDev) {
    console.log("[updater] desenvolvimento: checagem de atualizacoes desativada.");
    return;
  }

  // macOS fica de fora por enquanto. O MacUpdater exige app assinado com Developer ID, e o
  // certificado ainda nao existe (os secrets CSC_LINK/CSC_KEY_PASSWORD nao estao configurados).
  // Sem assinatura ele detecta a versao nova, tenta baixar e falha: pior do que nao oferecer,
  // porque a pessoa fica esperando uma atualizacao que nunca chega. Para religar, basta
  // configurar os secrets (ver UPDATER.md) e apagar este bloco.
  if (process.platform === "darwin") {
    console.log("[updater] macOS: auto-update desligado ate o app ser assinado.");
    return;
  }

  // Linux: updater nativo do AppImage, com download diferencial.
  if (process.platform !== "win32") {
    autoUpdater.autoDownload = true;
    autoUpdater.logger = console;

    // Canal beta (Linux): allowPrerelease faz o electron-updater ler o canal
    // beta.yml — que o electron-builder publica sozinho para versao com sufixo
    // de prerelease — em vez do latest.yml. Lido no boot: o electron-updater
    // checa uma vez por sessao, entao o toggle vale no proximo reinicio do app.
    // Desligar nao faz downgrade: a stable mais nova substitui a beta pelo
    // semver do proprio electron-updater (1.1.12 > 1.1.12-beta.7).
    autoUpdater.allowPrerelease = canalAtual() === "beta";

    // O download corre sozinho em background; ao terminar, avisa o usuario e
    // so instala com o OK dele — atualizar sem avisar derruba o app na hora.
    autoUpdater.on("update-downloaded", async (info) => {
      if (!isAutoUpdateEnabled()) return;
      updateReady = true;
      const win = getMainWindow();
      // showMessageBox (assincrono), nao showMessageBoxSync: o sincrono bloqueia a
      // thread JS do processo principal ate a pessoa clicar um botao -- inclusive o
      // setInterval do watchdog do Tor (ver golive-gui/electron/main.ts), que fica
      // sem checar o daemon por todo o tempo que o dialogo ficar aberto sem resposta.
      // O restante do arquivo ja usa a versao async (main.ts:1162); so este trecho
      // ficara para tras usando a sincrona.
      const choice = win
        ? (await dialog.showMessageBox(win, {
            type: "info",
            title: "Atualização disponível",
            message: `GoLiveBypass ${info.version} foi baixada.`,
            detail: "Reiniciar agora para aplicar a atualização? O app fecha e reabre sozinho.",
            buttons: ["Reiniciar agora", "Depois"],
            defaultId: 0,
            cancelId: 1,
          })).response
        : 0;

      // Em dev o quitAndInstall nao funciona: nao ha runtime AppImage montado,
      // e o processo e gerenciado pelo vite — o arquivo ate e substituido, mas
      // o app nao reinicia (e o arquivo some). O dev serve para verificar a
      // notificacao; a instalacao real so vale no app empacotado.
      if (choice === 0 && !isDev) {
        markQuittingForUpdate();
        autoUpdater.quitAndInstall();
      }
    });

    if (isAutoUpdateEnabled()) {
      autoUpdater.checkForUpdatesAndNotify().catch(() => {});
    }
    return;
  }

  // Windows portable: checagem periodica em background.
  // Sobra de um update anterior: o ".old" de ontem nao roda mais, entao agora e a
  // hora de apagar (no momento da troca ele ainda estava em execucao).
  const atual = portableExePath();
  if (atual !== null) cleanupOldExe(atual);
  // O canal vai como GETTER: a checagem de 4h le o valor VIVO — ligar o canal beta
  // vale na proxima checagem, sem reiniciar o app.
  setInterval(() => void checkWindowsUpdate(getMainWindow, isAutoUpdateEnabled, canalAtual), CHECK_INTERVAL_MS);
  void checkWindowsUpdate(getMainWindow, isAutoUpdateEnabled, canalAtual);
}

export async function checkWindowsUpdate(
  getMainWindow: () => BrowserWindow | null,
  isAutoUpdateEnabled: () => boolean = () => true,
  canalAtual: () => Canal = () => "stable",
) {
  if (checking || updateReady) return;
  if (!isAutoUpdateEnabled()) return;
  if (Date.now() - lastCheckAt < 60_000) return; // no minimo 1min entre checagens
  checking = true;
  lastCheckAt = Date.now();

  try {
    const canal = canalAtual();
    console.log(`[updater] verificando versao ${app.getVersion()} no canal ${canal}`);
    const releases = await githubReleases();
    const escolhida = escolherRelease(releases, app.getVersion(), canal);
    if (escolhida === null) {
      console.log("[updater] nenhuma versao mais nova disponivel");
      return;
    }

    const latest = escolhida.tag.replace(/^v/, "");
    const ehBeta = escolhida.prerelease;
    console.log(`[updater] candidata ${latest} encontrada (beta=${ehBeta} digest=${escolhida.digest !== null})`);
    const win = getMainWindow();
    // showMessageBox (assincrono): ver comentario equivalente no caminho Linux acima --
    // a versao Sync bloqueia o watchdog do Tor (setInterval) enquanto o dialogo espera.
    const choice = win
      ? (await dialog.showMessageBox(win, {
          type: "info",
          title: "Atualização disponível",
          message: `GoLiveBypass ${latest}${ehBeta ? " (beta)" : ""} está disponível.`,
          detail: ehBeta
            ? "Versão de teste do canal beta. Baixar e instalar agora? O app reabre sozinho ao terminar."
            : "Baixar e instalar agora? O app reabre sozinho ao terminar.",
          buttons: ["Atualizar agora", "Depois"],
          defaultId: 0,
          cancelId: 1,
        })).response
      : 0;

    if (choice !== 0) return;

    const ok = await updateWindowsPortable(escolhida.url, escolhida.digest);
    if (ok) {
      updateReady = true;
      app.quit();
    } else {
      console.error("[updater] falha ao aplicar o update portable.");
      // Sem isto o clique em "Atualizar agora" morre em silencio (issue #135): o
      // popup fecha, nada acontece, e a pessoa nao sabe que a versao atual segue
      // valendo nem o que fazer.
      const win = getMainWindow();
      const aviso = {
        type: "warning" as const,
        title: "Falha na atualização",
        message: `Não foi possível instalar o GoLiveBypass ${latest}.`,
        detail:
          "A versão atual continua funcionando. Tente de novo mais tarde, ou baixe a versão nova manualmente em github.com/pdl-clay/GoLiveBypass/releases.",
        buttons: ["OK"],
      };
      if (win) await dialog.showMessageBox(win, aviso);
      else await dialog.showMessageBox(aviso);
    }
  } finally {
    checking = false;
  }
}
