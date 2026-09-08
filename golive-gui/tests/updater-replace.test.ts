import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  attemptReplace,
  buildWindowsUpdateLauncher,
  buildWindowsUpdateScript,
  cleanupOldExe,
  OLD_SUFFIX,
  versionedPortableExePath,
} from "../electron/updater-replace";

// O cenario do Windows (exe em uso bloqueado ate o processo sair) nao existe no Linux —
// aqui o que se testa e a coreografia pos-saida: rename-aside, troca, rollback e limpeza.
// Os builders do helper (.bat/.vbs) sao testados como conteudo: disparar o helper
// de verdade (spawnWindowsUpdateHelper) exigiria wscript/cmd e sujaria o %TEMP%
// real da maquina, entao ele nao roda em teste.
describe("updater-replace", () => {
  let dir: string;
  let target: string;
  let downloaded: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "golive-replace-test-"));
    target = path.join(dir, "GoLiveBypass-1.1.11.exe");
    downloaded = path.join(dir, "GoLiveBypass-1.1.12.exe");
    fs.writeFileSync(target, "exe em uso");
    fs.writeFileSync(downloaded, "exe novo");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("troca o exe no lugar e deixa a versao antiga como .old", () => {
    attemptReplace(target, downloaded);
    expect(fs.readFileSync(target, "utf8")).toBe("exe novo");
    expect(fs.readFileSync(target + OLD_SUFFIX, "utf8")).toBe("exe em uso");
    expect(fs.existsSync(downloaded)).toBe(false);
  });

  it("limpa sobra .old de um update anterior antes de trocar", () => {
    fs.writeFileSync(target + OLD_SUFFIX, "exe velho de ontem");
    attemptReplace(target, downloaded);
    expect(fs.readFileSync(target, "utf8")).toBe("exe novo");
    // O ".old" de agora e o exe que estava em uso; o de ontem foi embora.
    expect(fs.readFileSync(target + OLD_SUFFIX, "utf8")).toBe("exe em uso");
  });

  it("faz rollback quando o exe novo nao entra no lugar", () => {
    fs.rmSync(downloaded); // origem da troca some: o rename-in tem que falhar
    expect(() => attemptReplace(target, downloaded)).toThrow();
    expect(fs.readFileSync(target, "utf8")).toBe("exe em uso");
    expect(fs.existsSync(target + OLD_SUFFIX)).toBe(false);
  });

  it("cleanupOldExe apaga a sobra quando o exe velho ja nao roda", () => {
    fs.writeFileSync(target + OLD_SUFFIX, "sobra");
    cleanupOldExe(target);
    expect(fs.existsSync(target + OLD_SUFFIX)).toBe(false);
  });

  it("cleanupOldExe nao falha quando nao ha sobra", () => {
    expect(() => cleanupOldExe(target)).not.toThrow();
  });

  it("bat do helper e ASCII puro com caminhos como argumentos (imune ao codepage OEM)", () => {
    const script = buildWindowsUpdateScript();
    // cmd le .bat no codepage OEM: qualquer nao-ASCII no conteudo e lido errado.
    expect(script).toMatch(/^[\x20-\x7E\r\n]+$/);
    // Os caminhos NUNCA sao embutidos: chegam como %1 (exe atual), %2 (download),
    // %3 (exe novo versionado) e %4 (vbs a limpar).
    expect(script).toContain('move /Y "%~1" "%~1.old" >NUL 2>&1');
    expect(script).toContain('move /Y "%~2" "%~3" >NUL 2>&1');
    expect(script).toContain("Start-Process -FilePath $env:GOLIVE_NEW_EXE -PassThru");
    expect(script).toContain('del "%~1.old" >NUL 2>&1');
    expect(script).toContain('del "%~2" >NUL 2>&1');
    expect(script).toContain('del "%~4" >NUL 2>&1');
    // Depois de lancar, o bat apaga a si mesmo.
    expect(script).toContain('del "%~f0"');
    // Linhas CRLF: e um arquivo para o cmd do Windows (todo \n precedido de \r).
    expect(script).not.toMatch(/(^|[^\r])\n/);
    expect(script.split("\r\n").length).toBeGreaterThan(10);
    // Esgotou as tentativas e restaura/lanca a versao antiga.
    expect(script).toContain("goto fail");
    expect(script).toContain(":installed");
  });

  it("so apaga o exe antigo depois de confirmar que a nova versao continua aberta", () => {
    const script = buildWindowsUpdateScript();
    const installed = script.indexOf(":installed");
    const launched = script.indexOf("Start-Process -FilePath $env:GOLIVE_NEW_EXE -PassThru", installed);
    const verified = script.indexOf("Start-Sleep -Seconds 5", launched);
    const failed = script.indexOf("if errorlevel 1 goto fail", verified);
    const cleaned = script.indexOf('del "%~1.old" >NUL 2>&1', failed);

    expect(launched).toBeGreaterThan(installed);
    expect(verified).toBeGreaterThan(installed);
    expect(failed).toBeGreaterThan(verified);
    expect(cleaned).toBeGreaterThan(failed);
    expect(script).toContain("$ErrorActionPreference='Stop'");
    expect(script).toContain("if ($null -eq $p -or $p.HasExited) { exit 1 }");
  });

  it("vbs do helper comeca com BOM UTF-16LE e cita os cinco caminhos", () => {
    const bat = "C:\\Users\\João\\AppData\\Local\\Temp\\g-1.bat";
    const exe = "C:\\Users\\João\\Desktop\\GoLiveBypass-1.1.12.exe";
    const downloaded = "C:\\Users\\João\\AppData\\Local\\Temp\\GoLiveBypass-update.exe";
    const newExe = "C:\\Users\\João\\Desktop\\GoLiveBypass-1.1.13.exe";
    const vbs = "C:\\Users\\João\\AppData\\Local\\Temp\\g-1.vbs";
    const launcher = buildWindowsUpdateLauncher(bat, exe, downloaded, newExe, vbs);
    // Sem o BOM o wscript le o arquivo como ANSI e o acento corrompe o script.
    expect(launcher.charCodeAt(0)).toBe(0xfeff);
    // Conteudo do arquivo sera gravado em utf16le (o teste cobre o texto logico).
    expect(launcher).toContain(bat);
    expect(launcher).toContain(exe);
    expect(launcher).toContain(downloaded);
    expect(launcher).toContain(newExe);
    expect(launcher).toContain(vbs);
    // Cada caminho entre Chr(34): espaco e acento nao quebram a linha de comando.
    expect(launcher).toContain(`Chr(34) & "${exe}" & Chr(34)`);
    expect(launcher).toContain(", 0, False");
  });

  it("calcula o novo exe ao lado do atual usando a versao da release", () => {
    expect(versionedPortableExePath("C:\\Users\\João\\Desktop\\GoLiveBypass-2.0.5-beta.6.exe", "2.0.5-beta.7"))
      .toBe("C:\\Users\\João\\Desktop\\GoLiveBypass-2.0.5-beta.7.exe");
  });

  it("recusa versao que poderia escapar do nome versionado", () => {
    expect(() => versionedPortableExePath("/tmp/GoLiveBypass.exe", "../outro.exe")).toThrow();
  });
});
