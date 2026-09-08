import fs from "fs";
import path from "path";

export interface WindowsDiscordInstall {
  appDir: string;
  resources: string;
  exePath: string;
}

type ExistsSync = (target: string) => boolean;

// WireSock classifica pacotes pelo executavel, nao pelo carregador Electron. Nao ler app.asar
// evita acoplamento com BetterDiscord, Vencord e qualquer outro mod que troque resources/.
// Os clientes paralelos instalados pelos instaladores atuais usam a pasta raiz diretamente
// (ex.: %LOCALAPPDATA%\\equibop\\equibop.exe), enquanto o Discord oficial continua usando
// subpastas Squirrel app-<versao>. Os dois formatos precisam ser aceitos.
export function findWindowsDiscordInstall(
  rootPath: string,
  flavour: string,
  existsSync: ExistsSync = fs.existsSync,
  readdirSync: (target: string) => string[] = (target) => fs.readdirSync(target),
): WindowsDiscordInstall | null {
  const directExeNames = [`${flavour}.exe`, `${flavour.toLowerCase()}.exe`];
  const directExePath = directExeNames
    .map((name) => path.join(rootPath, name))
    .find((candidate, index, candidates) =>
      candidates.indexOf(candidate) === index && existsSync(candidate),
    );
  if (directExePath) {
    return {
      appDir: rootPath,
      resources: path.join(rootPath, "resources"),
      exePath: directExePath,
    };
  }

  let dirs: string[];
  try {
    dirs = readdirSync(rootPath).filter((dir) => dir.startsWith("app-"));
  } catch {
    return null;
  }

  const candidates = dirs
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .map((appDir) => {
      const appPath = path.join(rootPath, appDir);
      const resources = path.join(appPath, "resources");
      return {
        appDir,
        resources,
        exePath: path.join(appPath, `${flavour}.exe`),
      };
    })
    .filter((candidate) => existsSync(candidate.exePath));

  return candidates[0] ?? null;
}
