// Substituicao do exe portable no Windows (target "portable" do electron-builder) e o
// relanço desacoplado depois da troca. Mora num modulo proprio, sem import do Electron,
// para o vitest exercitar a logica real de troca de arquivo (issue #135).
//
// A pegadinha do Windows: um exe em execucao nao pode ser APAGADO — a imagem dele
// esta mapeada na memoria, entao rmSync/unlink falha com EPERM sempre, nao e questao
// de esperar e tentar de novo. Mas RENOMEAR o exe em uso o Windows permite (mesmo
// volume, so muda a entrada de diretorio). A troca em tres passos: renomeia o exe em
// uso para ".old", renomeia o baixado para o lugar, e a sobra ".old" vira a sonda do
// helper de relanço (e o boot seguinte a apaga se o helper nao conseguir).

import { spawnSync } from "child_process";
import { existsSync, rmSync, renameSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

export const OLD_SUFFIX = ".old";

// Uma unica tentativa; joga o erro se falhou (o chamador decide a retentativa).
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

// O .bat e disparado por um helper externo para reabrir o app depois que o processo
// velho morrer. O CONTEUDO do arquivo e 100% ASCII e os caminhos chegam como %1..%3:
// o cmd le o .bat no codepage OEM, entao path embutido no conteudo (username "Joao",
// pasta "Configuracoes") embaralharia na leitura — como argumento, porem, o caminho
// viaja em Unicode pelo CreateProcessW e sobrevive intacto.
//
// A sonda de espera e o proprio delete do ".old": enquanto o exe velho estiver rodando,
// o Windows recusa apagar a imagem; no primeiro del que passa, o processo morreu e o
// lock de instancia unica esta livre — sem corrida entre o spawn e o quit. Se as
// tentativas esgotarem, lanca mesmo assim: melhor arriscar o lock do que deixar o
// usuario sem app. Depois limpa o .vbs (em %3) e a si mesmo.
export function buildWindowsUpdateScript(): string {
  return [
    "@echo off",
    `set "TRIES=30"`,
    "",
    ":loop",
    `if not exist "%~2" goto launch`,
    `del "%~2" >NUL 2>&1`,
    "if not errorlevel 1 goto launch",
    `set /a TRIES-=1`,
    `if %TRIES% leq 0 goto launch`,
    `ping 127.0.0.1 -n 2 >NUL`,
    "goto loop",
    "",
    ":launch",
    `start "" "%~1"`,
    `if not "%~3"=="" if exist "%~3" del "%~3" >NUL 2>&1`,
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
  oldPath: string,
  vbsPath: string,
): string {
  const quoted = (p: string) => `Chr(34) & "${p}" & Chr(34)`;
  const command = [quoted(batPath), quoted(exePath), quoted(oldPath), quoted(vbsPath)].join(
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
export function spawnWindowsUpdateHelper(exePath: string, oldPath: string): boolean {
  try {
    const timestamp = Date.now();
    const batPath = join(tmpdir(), `GoLiveBypass-update-${timestamp}.bat`);
    const vbsPath = join(tmpdir(), `GoLiveBypass-update-${timestamp}.vbs`);
    writeFileSync(batPath, buildWindowsUpdateScript(), "utf8");
    writeFileSync(vbsPath, buildWindowsUpdateLauncher(batPath, exePath, oldPath, vbsPath), "utf16le");
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
      return false;
    }
    return true;
  } catch (error) {
    console.error("[updater] erro ao agendar o relanco do Windows:", error);
    return false;
  }
}
