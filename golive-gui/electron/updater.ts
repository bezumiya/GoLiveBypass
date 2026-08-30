// Atualizacao automatica via GitHub Releases — sem servidor proprio.
//
// Windows: o target e portable, e o electron-updater nao suporta portable (so NSIS).
// Entao o update do Windows e proprio: consulta a release mais recente na API do
// GitHub, baixa o exe novo, substitui o atual (via PORTABLE_EXECUTABLE_FILE, a
// variavel que o electron-builder portable define) e reabre a versao nova.
//
// Mac e Linux: o autoUpdater do electron-updater cuida (dmg/zip assinado e AppImage).

import { app, dialog, BrowserWindow } from "electron";
import { createWriteStream, readFileSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { spawn } from "child_process";
import { autoUpdater } from "electron-updater";
import { request } from "https";

const REPO = "bezumiya/GoLiveBypass";
// O artifactName leva a versao (GoLiveBypass-1.1.5.exe): o AppImageLauncher e
// outros integradores nao sobrescrevem o arquivo quando o nome muda por versao.
const EXE_PREFIX = "GoLiveBypass-";
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // re-checa a cada 4h
const RETRY_COUNT = 10; // o exe em uso no Windows recusa rename por um tempo
const RETRY_DELAY_MS = 1000;

let lastCheckAt = 0;
let checking = false;
let updateReady = false;

// ------------------------------------------------------------------ GitHub API

function githubLatestRelease(): Promise<{ tag: string; url: string; digest: string | null } | null> {
  return new Promise((resolve) => {
    const req = request(
      {
        host: "api.github.com",
        path: `/repos/${REPO}/releases/latest`,
        method: "GET",
        headers: { "User-Agent": "GoLiveBypass", Accept: "application/vnd.github+json" },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return resolve(null);
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          body += c;
          if (body.length > 1_000_000) req.destroy();
        });
        res.on("end", () => {
          try {
            const data = JSON.parse(body);
            const asset = (data.assets || []).find(
              (a: { name: string }) =>
                a.name.startsWith(EXE_PREFIX) && a.name.endsWith(".exe"),
            );
            if (!asset || !asset.browser_download_url) return resolve(null);
            resolve({
              tag: String(data.tag_name),
              url: asset.browser_download_url,
              digest: typeof asset.digest === "string" ? asset.digest : null,
            });
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on("error", () => resolve(null));
    req.setTimeout(15_000, () => req.destroy());
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
    if (!url.startsWith("https://")) {
      return reject(new Error("recusando destino que nao e https: " + url));
    }

    const req = request(url, { headers: { "User-Agent": "GoLiveBypass" } }, (res) => {
      const { statusCode, headers } = res;

      if (statusCode !== undefined && statusCode >= 300 && statusCode < 400 && headers.location) {
        res.resume();
        if (hops <= 0) return reject(new Error("redirecionamentos demais"));
        return downloadFile(new URL(headers.location, url).toString(), dest, hops - 1).then(resolve, reject);
      }

      if (statusCode !== 200) {
        res.resume();
        return reject(new Error("download falhou: HTTP " + statusCode));
      }

      const out = createWriteStream(dest);
      res.pipe(out);
      out.on("finish", () => {
        out.close();
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

  const [algo, esperado] = digest.split(":");
  if (algo === undefined || esperado === undefined) return false;

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

export function buildWindowsUpdateScript(
  target: string,
  downloaded: string,
  vbsPath?: string,
): string {
  const lines = [
    `@echo off`,
    `set "TARGET=${target}"`,
    `set "DOWNLOADED=${downloaded}"`,
  ];
  if (vbsPath) {
    lines.push(`set "VBS_FILE=${vbsPath}"`);
  }
  lines.push(
    `set "TRIES=30"`,
    ``,
    `:loop`,
    `move /y "%DOWNLOADED%" "%TARGET%" >NUL 2>&1`,
    `if not errorlevel 1 (`,
    `    start "" "%TARGET%"`,
    `    goto finish`,
    `)`,
    ``,
    `set /a TRIES-=1`,
    `if %TRIES% leq 0 goto finish`,
    ``,
    `ping 127.0.0.1 -n 2 >NUL`,
    `goto loop`,
    ``,
    `:finish`,
  );
  if (vbsPath) {
    lines.push(`if exist "%VBS_FILE%" del "%VBS_FILE%" >NUL 2>&1`);
  }
  lines.push(`del "%~f0" >NUL 2>&1`, ``);
  return lines.join("\r\n");
}

export function spawnWindowsUpdateHelper(
  target: string,
  downloaded: string,
): boolean {
  try {
    const timestamp = Date.now();
    const batPath = join(tmpdir(), `GoLiveBypass-update-${timestamp}.bat`);
    const vbsPath = join(tmpdir(), `GoLiveBypass-update-${timestamp}.vbs`);

    const batContent = buildWindowsUpdateScript(target, downloaded, vbsPath);
    writeFileSync(batPath, batContent, "utf8");

    // O wscript.exe e um executavel de subsistema GUI (nao console), garantindo
    // que nenhuma janela de terminal (CMD) pisque ou apareca para o usuario.
    const vbsContent = [
      `Set WshShell = CreateObject("WScript.Shell")`,
      `WshShell.Run chr(34) & "${batPath.replace(/\\/g, "\\\\")}" & chr(34), 0, False`,
    ].join("\r\n");
    writeFileSync(vbsPath, vbsContent, "utf8");

    const child = spawn("wscript.exe", ["//b", "//nologo", vbsPath], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return true;
  } catch (err) {
    console.error("[updater] erro ao disparar helper de update do Windows:", err);
    return false;
  }
}

async function updateWindowsPortable(url: string, digest: string | null): Promise<boolean> {
  const current = portableExePath();
  if (current === null) {
    console.warn("[updater] PORTABLE_EXECUTABLE_FILE nao definido; pulando update.");
    return false;
  }

  const downloaded = join(tmpdir(), "GoLiveBypass-update.exe");
  try {
    await downloadFile(url, downloaded);
  } catch (error) {
    console.error("[updater] download falhou:", error);
    return false;
  }

  // Conferido antes de encostar no exe em uso: depois da substituicao nao ha volta.
  // Um arquivo que nao bate e apagado e a versao atual continua valendo.
  if (!digestMatches(downloaded, digest)) {
    await rm(downloaded, { force: true }).catch(() => {});
    return false;
  }

  // No Windows, o executavel portable do electron-builder e um launcher NSIS que
  // mantem um handle aberto no PORTABLE_EXECUTABLE_FILE enquanto o processo estiver vivo.
  // Disparamos um helper em background desacoplado que aguarda o encerramento do processo
  // atual, substitui o executavel no disco e o reinicia na versao atualizada.
  if (!spawnWindowsUpdateHelper(current, downloaded)) {
    console.error("[updater] nao consegui agendar a substituicao do executavel.");
    return false;
  }

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
) {
  // Dev (npm run dev): o app roda fora do pacote, sem o app-update.yml embutido.
  // O electron-updater usa o dev-app-update.yml na raiz do projeto + esta flag.
  const isDev = !app.isPackaged;
  if (isDev) {
    autoUpdater.forceDevUpdateConfig = true;
    // Em dev nao existe o runtime AppImage; sem este env o AppImageUpdater aborta
    // antes de baixar. Aponta para um AppImage buildado (so o caminho importa aqui).
    if (process.env.APPIMAGE === undefined) {
      process.env.APPIMAGE = join(app.getAppPath(), "dist-app", `GoLiveBypass-${app.getVersion()}.AppImage`);
    }
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

    // O download corre sozinho em background; ao terminar, avisa o usuario e
    // so instala com o OK dele — atualizar sem avisar derruba o app na hora.
    autoUpdater.on("update-downloaded", (info) => {
      if (!isAutoUpdateEnabled()) return;
      updateReady = true;
      const win = getMainWindow();
      const choice = win
        ? dialog.showMessageBoxSync(win, {
            type: "info",
            title: "Atualização disponível",
            message: `GoLiveBypass ${info.version} foi baixada.`,
            detail: "Reiniciar agora para aplicar a atualização? O app fecha e reabre sozinho.",
            buttons: ["Reiniciar agora", "Depois"],
            defaultId: 0,
            cancelId: 1,
          })
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

  // Windows portable: limpa .old remanescente de atualizacao previa e agenda checagem periodica.
  const current = portableExePath();
  if (current) {
    try {
      const { rmSync } = require("fs");
      rmSync(`${current}.old`, { force: true });
    } catch {
      // silencioso se nao existir ou estiver bloqueado
    }
  }
  setInterval(() => void checkWindowsUpdate(getMainWindow, isAutoUpdateEnabled), CHECK_INTERVAL_MS);
  void checkWindowsUpdate(getMainWindow, isAutoUpdateEnabled);
}

export async function checkWindowsUpdate(
  getMainWindow: () => BrowserWindow | null,
  isAutoUpdateEnabled: () => boolean = () => true,
) {
  if (checking || updateReady) return;
  if (!isAutoUpdateEnabled()) return;
  if (Date.now() - lastCheckAt < 60_000) return; // no minimo 1min entre checagens
  checking = true;
  lastCheckAt = Date.now();

  try {
    const release = await githubLatestRelease();
    if (release === null) return;

    const current = app.getVersion();
    const latest = release.tag.replace(/^v/, "");
    const isNewer = latest !== current;
    if (!isNewer) return;

    const win = getMainWindow();
    const choice = win
      ? dialog.showMessageBoxSync(win, {
          type: "info",
          title: "Atualização disponível",
          message: `GoLiveBypass ${latest} está disponível.`,
          detail: "Baixar e instalar agora? O app reabre sozinho ao terminar.",
          buttons: ["Atualizar agora", "Depois"],
          defaultId: 0,
          cancelId: 1,
        })
      : 0;

    if (choice !== 0) return;

    const ok = await updateWindowsPortable(release.url, release.digest);
    if (ok) {
      updateReady = true;
      markQuittingForUpdate();
      try {
        const win = getMainWindow();
        if (win && !win.isDestroyed()) {
          win.destroy();
        }
      } catch {}
      app.exit(0);
    } else {
      console.error("[updater] falha ao aplicar o update portable.");
    }
  } finally {
    checking = false;
  }
}
