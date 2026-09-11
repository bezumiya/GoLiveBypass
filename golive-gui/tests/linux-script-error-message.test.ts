import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// stripAnsiCodes/tailErroScript vivem no main.ts; a extracao segue o mesmo padrao
// do gui-preflight-integration.test.ts. O que se prova aqui e o que a UI mostra
// quando o script Linux falha, porque e essa string que vai para o usuario e para
// o relato de bug.

const mainSource = fs.readFileSync(path.resolve(process.cwd(), "electron/main.ts"), "utf8");

function extractFunction(name: string): string {
  const file = ts.createSourceFile("main.ts", mainSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const matches = file.statements.filter(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  if (matches.length !== 1) throw new Error(`esperava exatamente uma funcao ${name}, achei ${matches.length}`);
  return matches[0].getText(file);
}

const javascript = ts.transpileModule(`${extractFunction("stripAnsiCodes")}\n${extractFunction("tailErroScript")}`, {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None },
}).outputText;

const { stripAnsiCodes, tailErroScript } = new Function(`${javascript}; return { stripAnsiCodes, tailErroScript };`)() as {
  stripAnsiCodes: (value: string) => string;
  tailErroScript: (stderr: string, linhas: number) => string;
};

describe("mensagem de erro do script Linux", () => {
  it("nao come os prefixos literais [*], [OK] e [!] do script", () => {
    // O standalone colore com ANSI e o ESC as vezes chega como U+FFFD; o filtro
    // precisa remover so a sequencia real, sem engolir o texto entre colchetes.
    expect(stripAnsiCodes("  [*] Removendo namespace de rede")).toBe("  [*] Removendo namespace de rede");
    expect(stripAnsiCodes("  [OK] Tunel WireGuard encerrado.")).toBe("  [OK] Tunel WireGuard encerrado.");
    expect(stripAnsiCodes("  [!] sem privilegio")).toBe("  [!] sem privilegio");
    expect(stripAnsiCodes("\u001b[36m  [OK] ok\u001b[0m")).toBe("  [OK] ok");
    expect(stripAnsiCodes("\uFFFD[36m  [X] falhou")).toBe("  [X] falhou");
  });

  it("mostra a causa real em vez dos passos informativos do teardown", () => {
    const stderr = [
      "\u001b[2m  [*]\u001b[0m Removendo namespace de rede 'discord-vpn' e interface WireGuard",
      "\u001b[32m  [OK]\u001b[0m Tunel WireGuard encerrado.",
      "\u001b[31m  [X]\u001b[0m Discord nao iniciou dentro do namespace WireGuard. Verifique o log em /home/u/.local/share/GoLiveBypass/logs.",
    ].join("\n");
    expect(tailErroScript(stderr, 3)).toBe(
      "[X] Discord nao iniciou dentro do namespace WireGuard. Verifique o log em /home/u/.local/share/GoLiveBypass/logs.",
    );
  });
});
