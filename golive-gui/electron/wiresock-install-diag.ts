import fs from "fs";
import os from "os";
import path from "path";

// Diagnóstico de uma instalação do WireSock SDK que falhou. Num Windows "enxugado" sem a pasta
// %SystemRoot%\Installer, o setup 3.8.2.1 saía com 1632 e a mensagem era só
// "Command failed: powershell.exe …": o código de saída, o pacote que falhou e a pasta ausente
// só apareceram depois de vários logs pedidos à pessoa. Aqui fica o que a GUI coleta sozinha.
// O plugin tem a mesma lógica em goLiveBypass/vpn-windows.ts (árvores separadas).

const INSTALLER_EXIT_MEANINGS: Record<number, string> = {
  1601: "o serviço Windows Installer não está acessível",
  1602: "a instalação foi cancelada",
  1603: "erro fatal durante a instalação",
  1612: "o pacote da versão instalada sumiu e o Windows não consegue removê-la",
  1618: "outra instalação já está em andamento; espere terminar ou reinicie o Windows",
  1619: "o pacote de instalação não pôde ser aberto",
  1620: "o pacote de instalação não pôde ser aberto",
  1625: "uma política do sistema bloqueia a instalação",
  1632: "o Windows Installer não consegue gravar na pasta temporária ou na pasta Installer do Windows",
  1638: "outra versão do WireSock já está instalada",
};

/** Normaliza o código (HRESULT 0x8007xxxx vira o código Win32) e devolve o texto conhecido. */
export function describeWireSockInstallerExit(rawCode: unknown): { code: number | null; meaning: string } {
  let code = typeof rawCode === "number" ? rawCode : Number(rawCode);
  if (rawCode === null || rawCode === undefined || !Number.isFinite(code)) return { code: null, meaning: "" };
  const unsigned = code < 0 ? code + 0x1_0000_0000 : code;
  if (unsigned >= 0x8007_0000 && unsigned <= 0x8007_ffff) code = unsigned & 0xffff;
  return { code, meaning: INSTALLER_EXIT_MEANINGS[code] ?? "" };
}

/**
 * Linhas de erro do log do setup (`%TEMP%\WireSock_Secure_Connect_SDK_*.log`), sem o prefixo de
 * processo/horário do Burn e sem caminhos (o Windows da pessoa pode estar em B:\Users\<nome>).
 */
export function extractWireSockInstallerLogErrors(text: string, max = 6): string[] {
  const lines: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!/\berror\b|\bfailed\b|0x8007[0-9a-f]{4}/i.test(raw)) continue;
    const line = raw
      .replace(/^\[[0-9A-Fa-f]+:[0-9A-Fa-f]+\]\[[^\]]+\]/, "")
      .replace(/[A-Za-z]:\\[^\s"',;]*/g, "<caminho>")
      .replace(/\\\\[^\s"',;]+/g, "<caminho>")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200);
    if (line && !lines.includes(line)) lines.push(line);
  }
  return lines.slice(-max);
}

/** Erros dos logs do setup gravados a partir de `sinceMs` (mais 5 s de folga de relógio). */
export function collectWireSockInstallerLogErrors(sinceMs: number, dir: string = os.tmpdir()): string[] {
  try {
    const files = fs.readdirSync(dir)
      .filter((name) => /^WireSock_Secure_Connect_SDK_.*\.log$/i.test(name))
      .map((name) => ({ name, mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
      .filter((file) => file.mtime >= sinceMs - 5_000)
      .sort((a, b) => a.mtime - b.mtime);
    const lines: string[] = [];
    for (const file of files.slice(-4)) {
      const text = fs.readFileSync(path.join(dir, file.name), "utf8").slice(-256 * 1024);
      for (const line of extractWireSockInstallerLogErrors(text)) if (!lines.includes(line)) lines.push(line);
    }
    return lines.slice(-6);
  } catch {
    return [];
  }
}

/** null quando não dá para saber (sem SystemRoot); false quando a pasta não existe. */
export function windowsInstallerFolderPresent(env: NodeJS.ProcessEnv = process.env): boolean | null {
  const root = env.SystemRoot || env.windir;
  if (!root) return null;
  try { return fs.statSync(path.join(root, "Installer")).isDirectory(); } catch { return false; }
}

/**
 * Causa provável e o reparo manual, por extenso no log. O app NÃO mexe na pasta do sistema: só deixa
 * escrito o que falta e o que a pessoa (ou quem atende o relato) precisa fazer como administrador.
 */
export function installerFolderDiagnosis(installerFolder: boolean | null): { causa_provavel: string; acao_manual: string } | null {
  if (installerFolder !== false) return null;
  return {
    causa_provavel: "pasta %SystemRoot%\\Installer ausente: o Windows Installer recusa qualquer pacote MSI (codigo 1632)",
    acao_manual: "como administrador, recriar %SystemRoot%\\Installer (SYSTEM e Administradores: controle total; Todos: leitura; oculta e de sistema) e ativar de novo",
  };
}

/** Frase para o popup: código, significado e a pasta do Windows Installer quando faltar. */
export function wireSockInstallerFailureDetail(rawCode: unknown, installerFolder: boolean | null): string {
  const exit = describeWireSockInstallerExit(rawCode);
  // 1 é o próprio wrapper do PowerShell (Start-Process falhou), não um código do setup.
  const exitText = exit.code !== null && exit.code !== 1
    ? `O instalador saiu com o código ${exit.code}${exit.meaning ? ` (${exit.meaning})` : ""}.`
    : "";
  const folderText = installerFolder === false
    ? "A pasta Installer do Windows (%SystemRoot%\\Installer) não existe; sem ela nenhum pacote MSI instala."
    : "";
  return [exitText, folderText].filter(Boolean).join(" ");
}
