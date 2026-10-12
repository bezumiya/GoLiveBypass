/**
 * Autostart multiplataforma.
 *
 * O Electron prove app.setLoginItemSettings() (e o getLoginItemSettings()), mas
 * em build portable do Windows ele NAO funciona: o metodo delega ao instalador
 * Squirrel/MSI para criar a entrada de Run, e o portable nao tem instalador. O
 * usuario clica "Iniciar com Windows", o app chama setLoginItemSettings({...}),
 * o metodo retorna sucesso -- e nada acontece. O checkbox no renderer continua
 * desmarcado na proxima abertura porque o getLoginItemSettings tambem le do
 * instalador (que nao escreveu nada), e nao tem como a interface saber que a
 * chamada "funcionou" sem efeito.
 *
 * Workaround: no Windows, escrever direto em HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run
 * via reg.exe. O reg.exe ja vem com o Windows, nao exige elevacao (HKCU e do
 * usuario), e o caminho do exe e o `process.execPath` (que no portable e o .exe
 * que o usuario esta rodando agora). Args = ["--hidden"] para subir so na
 * bandeja sem abrir a janela. Remover o autostart = reg delete.
 *
 * No macOS, o setLoginItemSettings funciona (foi reescrito no Electron 22+
 * para portable, e o app oficial e dmg/zip com category). Mantemos o caminho
 * antigo. No Linux, o caminho do .desktop em ~/.config/autostart continua.
 */
import { app } from "electron";
import path from "path";
import fs from "fs";
import { execFileSync } from "child_process";

const IS_WINDOWS = process.platform === "win32";
const IS_LINUX = process.platform === "linux";
const IS_MAC = process.platform === "darwin";

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const ENTRY_NAME = "GoLiveBypass";

export interface StartupResult {
  success: boolean;
  error?: string;
}

/**
 * Retorna o caminho do executavel que deve ser usado para iniciar o app no boot.
 *
 * No Linux, quando o app esta rodando de dentro de um AppImage, o `process.execPath`
 * e o caminho dentro do mountpoint FUSE temporario (`/tmp/.mount_GoLiveXXX/golive-gui`),
 * que NAO persiste entre sessoes -- o mountpoint e desmontado junto com o AppImage.
 * A variavel de ambiente `APPIMAGE` (definida pelo runtime do AppImage) guarda o
 * caminho real do .AppImage no disco, e e isso que o .desktop precisa usar.
 *
 * No Windows o portable NAO usa o process.execPath (veja realExecPath): ele aponta
 * para a extracao temporaria. No macOS, o app.asar/Contents/MacOS/GoLiveBypass.
 */
function realExecPath(): string {
  if (IS_LINUX) {
    const appImage = process.env.APPIMAGE;
    if (appImage && fs.existsSync(appImage)) return appImage;
  }
  // O portable do Windows se auto-extrai num dir %TEMP% aleatorio a CADA execucao:
  // o process.execPath dentro do app e o exe EXTRAIDO. Gravar a Run key com ele
  // morria quando o temp era limpo (Storage Sense/CCleaner) e apontava o boot para
  // uma copia velha depois de update — o "nao abre mesmo ativando" dos usuarios do
  // portable. O PORTABLE_EXECUTABLE_FILE e o exe ORIGINAL que o usuario rodou (o
  // updater ja usa a mesma variavel para se substituir).
  if (IS_WINDOWS && process.env.PORTABLE_EXECUTABLE_FILE &&
      fs.existsSync(process.env.PORTABLE_EXECUTABLE_FILE)) {
    return process.env.PORTABLE_EXECUTABLE_FILE;
  }
  return process.execPath;
}

// Escape minimo exigido pelo formato Desktop Entry para caminhos com espacos,
// aspas, barras invertidas ou caracteres especiais.
function desktopExecPath(value: string): string {
  return `"${value.replace(/([\\"`$])/g, "\\$1")}"`;
}

// Entradas da Run key que iniciam ESTE app. O nome do valor mudou entre
// versoes: o canonico e ENTRY_NAME, mas versoes antigas gravaram sob outros
// nomes (o nome do app do Electron, o nome do exe portatil renomeado). O
// toggle gerenciava so o valor canonico, entao desligar "deixava passar" as
// entradas legadas e o app continuava subindo no boot com o checkbox
// desligado. O criterio aqui e o ALVO do valor: qualquer registro cujo
// comando aponte para o exe do GoLiveBypass pertence a este toggle. Valores
// de terceiros e o GoLiveBypassTor do standalone (o alvo dele e o
// wscript/tor, nao este app) ficam de fora.
type RunEntry = { name: string; data: string };

function launchesThisApp(data: string): boolean {
  const quoted = data.match(/^"([^"]+)"/);
  const target = quoted ? quoted[1] : data.trim().split(/\s+/)[0] ?? "";
  const base = target.split(/[\\/]/).pop() ?? "";
  return /^golivebypass.*\.exe$/i.test(base);
}

function listOwnRunEntries(): RunEntry[] {
  let output: string;
  try {
    output = execFileSync("reg.exe", ["query", RUN_KEY], { encoding: "utf8", windowsHide: true });
  } catch {
    // Chave Run ilegivel (sessao sem perfil, politica de grupo): nao ha
    // entrada comprovada, e quem chama decide o que fazer com a lista vazia.
    return [];
  }
  const entries: RunEntry[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*(.+?)\s{2,}(REG_\w+)\s{2,}(.*)$/);
    if (!match) continue;
    const name = match[1].trim();
    const data = match[3].trim();
    if (name === ENTRY_NAME || launchesThisApp(data)) entries.push({ name, data });
  }
  return entries;
}

function deleteRunValue(name: string): void {
  try {
    execFileSync("reg.exe", [
      "delete",
      RUN_KEY,
      "/v", name,
      "/f",
    ], { stdio: "ignore", windowsHide: true });
  } catch {
    // Ignorar quando a entrada nao existe: o `reg delete` falha com nivel
    // de erro 1 quando o valor nao esta presente, e o caller nao distingue
    // isso de um erro real. O resultado final e conferido com uma nova
    // listagem depois da exclusao -- nunca por sucesso presumido.
  }
}

/**
 * Marca o app para iniciar com o login do usuario.
 * - Windows: HKCU\...\Run via reg.exe (funciona em portable)
 * - macOS: app.setLoginItemSettings (funciona em dmg/zip)
 * - Linux: ~/.config/autostart/golivebypass.desktop
 *
 * Args de execucao: ["--hidden"] para subir so na bandeja no login, sem abrir
 * a janela do GUI. A primeira coisa que o main faz com --hidden e a checagem
 * launchedHidden() (ver main.ts), que decide se cria a janela visivel.
 */
export function setStartup(enabled: boolean): StartupResult {
  if (IS_WINDOWS) {
    if (enabled) {
      const executable = realExecPath();
      if (!executable || !fs.existsSync(executable)) {
        return { success: false, error: "O executável atual do GoLiveBypass não foi encontrado." };
      }
      // Aspas escapadas: o caminho do exe pode ter espacos (o portable e
      // "GoLiveBypass-1.1.9.exe" em C:\Program Files\ por exemplo). reg.exe
      // interpreta a string como valor REG_SZ, e espacos sem aspas quebram
      // o registro. O prefixo " so serve se o valor comecar com aspas;
      // aqui o caminho e o valor inteiro do registro.
      const value = `\"${executable}\" --hidden`;
      try {
        execFileSync("reg.exe", [
          "add",
          RUN_KEY,
          "/v", ENTRY_NAME,
          "/t", "REG_SZ",
          "/d", value,
          "/f",
        ], { stdio: "ignore", windowsHide: true });
      } catch (error) {
        // Sem HKCU: usuario sem perfil movel, ou sessao sem permissao (raro
        // mas pode acontecer em kiosk). Silencioso -- a UI nao foi projetada
        // para mostrar erro, e o usuario pode re-tentar.
        console.error("falha ao adicionar entrada de Run:", error);
        return { success: false, error: "O Windows recusou a criação da inicialização automática." };
      }
      // Normaliza: com a entrada canonica no lugar, entrada legada do mesmo
      // app sobrando iniciaria uma segunda copia no login.
      for (const entry of listOwnRunEntries()) {
        if (entry.name !== ENTRY_NAME) deleteRunValue(entry.name);
      }
      if (!getStartup()) return { success: false, error: "A entrada foi criada, mas não pôde ser confirmada no registro do Windows." };
    } else {
      // Desligar precisa limpar TODAS as entradas do app e provar que limpou:
      // apagar so o valor canonico deixava as entradas legadas vivas, e o
      // sucesso retornado sem verificacao fazia a UI mentir ("desligado")
      // enquanto o app continuava subindo com o Windows.
      for (const entry of listOwnRunEntries()) deleteRunValue(entry.name);
      const remaining = listOwnRunEntries();
      if (remaining.length > 0) {
        return {
          success: false,
          error: "O Windows manteve a inicialização automática (" +
            remaining.map((entry) => entry.name).join(", ") +
            "). Remova a entrada manualmente em Inicializar (msconfig) e reporte o resultado do diagnostico.ps1.",
        };
      }
    }
    return { success: true };
  }

  if (IS_LINUX) {
    const file = path.join(app.getPath("home"), ".config", "autostart", "golivebypass.desktop");
    if (enabled) {
      const dir = path.dirname(file);
      try {
        fs.mkdirSync(dir, { recursive: true });
        const content = [
          "[Desktop Entry]",
          "Type=Application",
          "Name=GoLiveBypass",
          "Comment=Devolve o Go Live e a camera no Discord",
          `Exec=${desktopExecPath(realExecPath())} --hidden`,
          `TryExec=${desktopExecPath(realExecPath())}`,
          "X-GNOME-Autostart-enabled=true",
          "X-GNOME-Autostart-Delay=5",
          "",
        ].join("\n");
        const temp = `${file}.tmp-${process.pid}`;
        fs.writeFileSync(temp, content);
        fs.renameSync(temp, file);
        if (!fs.existsSync(file)) return { success: false, error: "O arquivo de inicialização não foi criado." };
      } catch (error) {
        console.error("falha ao escrever .desktop:", error);
        return { success: false, error: "Não foi possível criar a inicialização automática do Linux." };
      }
    } else if (fs.existsSync(file)) {
      try {
        fs.unlinkSync(file);
      } catch (error) {
        console.error("falha ao remover .desktop:", error);
        return { success: false, error: "Não foi possível desativar a inicialização automática do Linux." };
      }
    }
    return { success: true };
  }

  if (IS_MAC) {
    // setLoginItemSettings no Electron 22+ funciona em dmg/zip (foi
    // reescrito para suportar portable, mas o app oficial do projeto e
    // dmg). Mantemos o caminho padrao.
    app.setLoginItemSettings({
      openAtLogin: enabled,
      args: ["--hidden"],
    });
    return { success: true };
  }
  return { success: true };
}

/**
 * Le o estado atual do autostart. Retorna true se o app vai subir com o
 * login, false caso contrario.
 *
 * No Windows, lemos diretamente do registro. Usar getLoginItemSettings do
 * Electron daria sempre false em portable (porque nao escreve nada), e o
 * checkbox no renderer viraria sempre desmarcado mesmo com o registro
 * configurado -- e a queixa da issue #84.
 */
export function getStartup(): boolean {
  if (IS_LINUX) {
    const file = path.join(app.getPath("home"), ".config", "autostart", "golivebypass.desktop");
    return fs.existsSync(file);
  }
  if (IS_WINDOWS) {
    // Qualquer entrada do app vale: valor legado sob outro nome tambem
    // inicia o app, e o checkbox precisa refletir o que o Windows vai fazer.
    return listOwnRunEntries().length > 0;
  }
  return app.getLoginItemSettings().openAtLogin;
}

/**
 * Reescreve a entrada de Run com o caminho ATUAL do exe, se a entrada existir.
 *
 * O valor da Run key congela o caminho de quando o usuario ativou o toggle — e o
 * portable muda de lugar o tempo todo (baixa na Downloads, move para o Desktop,
 * renomeia, o updater substitui). O Windows falha em SILENCIO quando o caminho do
 * valor nao existe mais: o app simplesmente nao abre no boot, com o checkbox
 * marcado — getStartup() so confere se a ENTRADA existe, nao se o caminho dela e
 * valido. Rodar isto a cada abertura do app cura todos esses casos (um reg add
 * idempotente, custo desprezivel) e devolve a flag --hidden se ela se perdeu.
 */
export function syncStartupEntry(): void {
  if (!IS_WINDOWS) return;
  if (!getStartup()) return;
  setStartup(true);
}

/**
 * Detecta se o app foi iniciado pelo autostart (Run key no Windows,
 * openAsHidden do macOS, ou o .desktop do Linux). Usado para nao abrir a
 * janela visivel em boots automaticos -- o usuario so precisa do icone
 * na bandeja.
 */
export function launchedHidden(): boolean {
  if (process.argv.includes("--hidden")) return true;
  if (IS_MAC) {
    return app.getLoginItemSettings().wasOpenedAtLogin;
  }
  if (IS_LINUX) {
    return process.argv.includes("--hidden");
  }
  return false;
}
