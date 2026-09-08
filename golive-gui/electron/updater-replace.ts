// Substituicao do exe portable no Windows (target "portable" do electron-builder) e o
// relanço desacoplado depois da troca. Mora num modulo proprio, sem import do Electron,
// para o vitest exercitar a logica real de troca de arquivo (issue #135).
//
// No Windows, a imagem do exe em execucao permanece bloqueada para rename/delete.
// Portanto o processo Electron apenas baixa e confere o candidato, agenda o helper e
// encerra. O helper espera o processo antigo morrer e so entao faz a troca em quatro
// passos: renomeia o exe antigo para ".old", move o baixado para o lugar, abre a
// versao nova e so remove o ".old" depois de confirmar que ela continua viva.

import { spawnSync } from "child_process";
import { existsSync, rmSync, renameSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, win32 } from "path";

export const OLD_SUFFIX = ".old";

const VERSIONED_EXE_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function versionedPortableExePath(current: string, version: string): string {
  if (!VERSIONED_EXE_RE.test(version)) {
    throw new Error(`versao invalida para nome de executavel: ${version}`);
  }
  const isWindowsPath = /^[A-Za-z]:[\\/]/.test(current);
  const directory = isWindowsPath ? win32.dirname(current) : dirname(current);
  return isWindowsPath
    ? win32.join(directory, `GoLiveBypass-${version}.exe`)
    : join(directory, `GoLiveBypass-${version}.exe`);
}

// Uma unica troca; o chamador de teste pode decidir a retentativa. No fluxo real esta
// mesma ordem e executada pelo .bat depois que o processo antigo ja saiu.
export function attemptReplace(target: string, downloaded: string): void {
  const antigo = target + OLD_SUFFIX;
  if (existsSync(antigo)) {
    // Sobra de um update anterior que o boot nao limpou; sem isto o rename abaixo
    // falharia com destino existente.
    rmSync(antigo, { force: true });
  }
  renameSync(target, antigo);
  try {
    renameSync(downloaded, target);
  } catch (error) {
    // Rollback: sem ele o atalho do usuario apontaria para arquivo que nao existe.
    // (O app segue rodando — rename nao afeta a imagem em memoria.)
    try {
      renameSync(antigo, target);
    } catch {
      // Raro (antivirus segurando os dois); o proximo update limpa o ".old" antes.
    }
    throw error;
  }
}

// Boot do app atualizado: o ".old" de ontem nao roda mais, entao agora da para apagar.
export function cleanupOldExe(target: string): void {
  try {
    rmSync(target + OLD_SUFFIX, { force: true });
  } catch {
    // Antivirus pode segurar o arquivo por um tempo; tenta de novo no proximo boot.
  }
}

// ------------------------------------------------------------------ relanço externo (Windows)

// O .bat e disparado por um helper externo para trocar e reabrir o app depois que o
// processo velho morrer. O CONTEUDO do arquivo e 100% ASCII e os caminhos chegam como
// %1..%4:
// o cmd le o .bat no codepage OEM, entao path embutido no conteudo (username "Joao",
// pasta "Configuracoes") embaralharia na leitura — como argumento, porem, o caminho
// viaja em Unicode pelo CreateProcessW e sobrevive intacto.
//
// A sonda de espera e a tentativa de mover o exe atual: enquanto o processo velho
// estiver rodando, o Windows recusa o move; quando ele sai, a troca pode prosseguir.
// Se as tentativas esgotarem, restaura e relanca o exe antigo. Depois limpa o .vbs (em
// %4) e a si mesmo.
export function buildWindowsUpdateScript(): string {
  return [
    "@echo off",
    // %1 = exe atual, %2 = exe baixado, %3 = novo caminho versionado, %4 = launcher VBS a remover.
    `set "TRIES=90"`,
    "",
    ":retry",
    `if not exist "%~1" goto fail`,
    `if not exist "%~2" goto fail`,
    // O destino versionado pode ter sobrado de uma tentativa interrompida.
    `if /I not "%~1"=="%~3" if exist "%~3" del /F /Q "%~3" >NUL 2>&1`,
    // Uma sobra de uma tentativa anterior nao pode impedir a proxima troca.
    `if exist "%~1.old" del "%~1.old" >NUL 2>&1`,
    `if exist "%~1.old" goto wait`,
    // Esta operacao falha enquanto o processo antigo ainda mantem o exe aberto.
    `move /Y "%~1" "%~1.old" >NUL 2>&1`,
    "if errorlevel 1 goto wait",
    `move /Y "%~2" "%~3" >NUL 2>&1`,
    "if not errorlevel 1 goto installed",
    // Se o antivirus segurou o download, restaura o atalho antes de tentar de novo.
    `move /Y "%~1.old" "%~1" >NUL 2>&1`,
    ":wait",
    `set /a TRIES-=1`,
    `if %TRIES% leq 0 goto fail`,
    `ping 127.0.0.1 -n 2 >NUL`,
    "goto retry",
    "",
    ":installed",
    // O PowerShell devolve falha se nao conseguir abrir o exe ou se ele encerrar
    // durante a janela de inicializacao. Ate este ponto o .old continua intacto.
    `set "GOLIVE_NEW_EXE=%~3"`,
    `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $p=Start-Process -FilePath $env:GOLIVE_NEW_EXE -PassThru; Start-Sleep -Seconds 5; if ($null -eq $p -or $p.HasExited) { exit 1 }"`,
    `set "GOLIVE_NEW_EXE="`,
    "if errorlevel 1 goto fail",
    // So depois de a nova versao permanecer aberta o backup pode ser removido.
    `del "%~1.old" >NUL 2>&1`,
    "goto cleanup",
    "",
    ":fail",
    // Nunca deixa o usuario sem o exe antigo se a troca parcial falhar.
    `if not exist "%~1" if exist "%~1.old" move /Y "%~1.old" "%~1" >NUL 2>&1`,
    `if /I not "%~1"=="%~3" if exist "%~3" del /F /Q "%~3" >NUL 2>&1`,
    `if exist "%~1" del "%~1.old" >NUL 2>&1`,
    `if exist "%~2" del "%~2" >NUL 2>&1`,
    `if exist "%~1" start "" "%~1"`,
    "",
    ":cleanup",
    `if not "%~4"=="" if exist "%~4" del "%~4" >NUL 2>&1`,
    `del "%~f0" >NUL 2>&1`,
    "",
  ].join("\r\n");
}

// O .vbs existe para rodar o .bat sem janela de console (wscript e binario de
// subsistema GUI). Ele PRECISA conter o caminho do .bat, entao nao ha como tirar path
// do conteudo — em compensacao, o wscript respeita BOM: o arquivo vai em UTF-16LE e
// qualquer acento no caminho (C:\Users\Joao\...) sobrevive. Sem BOM, o wscript leria
// como ANSI e username acentuado quebraria o helper em silencio.
export function buildWindowsUpdateLauncher(
  batPath: string,
  exePath: string,
  downloadedPath: string,
  newExePath: string,
  vbsPath: string,
): string {
  const quoted = (p: string) => `Chr(34) & "${p}" & Chr(34)`;
  const command = [quoted(batPath), quoted(exePath), quoted(downloadedPath), quoted(newExePath), quoted(vbsPath)].join(
    ' & " " & ',
  );
  const body = [
    'Set WshShell = CreateObject("WScript.Shell")',
    `WshShell.Run ${command}, 0, False`,
    "",
  ].join("\r\n");
  return "\uFEFF" + body;
}

// Sobe o helper desacoplado e retorna se conseguiu agenda-lo. So falha com o tmp fora
// do ar (rarissimo); o chamador decide o fallback.
export function spawnWindowsUpdateHelper(exePath: string, downloadedPath: string, newExePath: string): boolean {
  let batPath = "";
  let vbsPath = "";
  try {
    const timestamp = Date.now();
    batPath = join(tmpdir(), `GoLiveBypass-update-${timestamp}.bat`);
    vbsPath = join(tmpdir(), `GoLiveBypass-update-${timestamp}.vbs`);
    writeFileSync(batPath, buildWindowsUpdateScript(), "utf8");
    writeFileSync(vbsPath, buildWindowsUpdateLauncher(batPath, exePath, downloadedPath, newExePath, vbsPath), "utf16le");
    // spawn() so emitiria o erro de comando ausente depois de retornar true. Nesse
    // intervalo o chamador ja teria encerrado o app e nao haveria fallback. O
    // wscript apenas agenda o .bat e termina, portanto a chamada sincronizada e
    // curta e permite confirmar que o helper realmente foi criado.
    const result = spawnSync("wscript.exe", ["//b", "//nologo", vbsPath], {
      stdio: "ignore",
      windowsHide: true,
    });
    if (result.error || result.status !== 0) {
      console.error("[updater] helper de relanco falhou:", result.error ?? `exit ${result.status}`);
      rmSync(batPath, { force: true });
      rmSync(vbsPath, { force: true });
      return false;
    }
    return true;
  } catch (error) {
    if (batPath) rmSync(batPath, { force: true });
    if (vbsPath) rmSync(vbsPath, { force: true });
    console.error("[updater] erro ao agendar o relanco do Windows:", error);
    return false;
  }
}
