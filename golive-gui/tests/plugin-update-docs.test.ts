import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const root = path.resolve(process.cwd(), "..");
const installGuide = fs.readFileSync(path.join(root, "goLiveBypass", "COMO-INSTALAR.md"), "utf8");
const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");

describe("documentação das atualizações do plugin", () => {
  it("documenta stable padrão e beta opt-in", () => {
    expect(installGuide).toContain("**Estável** é o canal padrão");
    expect(installGuide).toContain("**Beta** é opcional");
    expect(installGuide).toContain("selecione o canal **Beta**");
    expect(installGuide).toMatch(/nunca instala uma\s+prerelease/);
  });

  it("documenta atualização automática, integridade e reload manual", () => {
    expect(installGuide).toContain("**Atualização automática** vem ligada por padrão");
    expect(installGuide).toContain("goLiveBypass-vencord.zip");
    expect(installGuide).toContain("goLiveBypass-vencord.zip.sha256");
    expect(installGuide).toContain("**SHA-256**");
    expect(installGuide).toContain("nunca reinicia o Discord silenciosamente");
    expect(installGuide).toMatch(/\*\*reload\/recarregar manualmente o\s+Discord\*\*/);
  });

  it("mantém explícita a separação entre plugin, GUI e standalone", () => {
    expect(installGuide).toContain("updater próprio, separado do updater da GUI e do standalone");
    expect(installGuide).toMatch(/não são\s+compartilhadas com a GUI Electron ou com o standalone/);
    expect(installGuide).toContain("não altera o `app.asar`");
  });

  it("registra a capacidade na seção mais recente do changelog", () => {
    // [Unreleased] enquanto não sai release; depois do corte, o conteúdo passa
    // para a seção da versão publicada. A seção que importa é a primeira com
    // conteúdo, não um título fixo.
    const newest = changelog
      .split(/\n(?=## \[)/)
      .filter(section => section.startsWith("## ["))
      .find(section => section.replace(/^## \[[^\]]+\][^\n]*\n/, "").trim().length > 0) ?? "";
    expect(newest).toContain("### Atualizações do plugin Vencord/Equicord");
    expect(newest).toContain("canal estável padrão");
    expect(newest).toContain("beta opt-in");
    expect(newest).toContain("validação SHA-256");
    expect(newest).toContain("reload manual");
    expect(newest).toMatch(/separada da GUI e\s+do standalone/);
  });
});
