import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { compararVersoes, escolherRelease, type ReleaseCandidata } from "../electron/updater-channel";

// O canal beta e o opt-in dos testadores (regra §9): prereleases nunca viram
// "latest", o canal estavel nunca as ve, e NENHUM canal faz downgrade — pelo
// semver, 1.1.12 stable > 1.1.12-beta.7 no mesmo triplo.

function release(parcial: Partial<ReleaseCandidata>): ReleaseCandidata {
  return {
    tag: "v1.1.12",
    url: "https://github.com/bezumiya/GoLiveBypass/releases/download/x/GoLiveBypass-1.1.12.exe",
    digest: "sha256:abc",
    prerelease: false,
    ...parcial,
  };
}

function urlDa(tag: string): string {
  return "https://github.com/bezumiya/GoLiveBypass/releases/download/x/" + tag + ".exe";
}

describe("compararVersoes (semver minimo do projeto)", () => {
  it("triplos diferentes comparam numericamente", () => {
    expect(compararVersoes("1.1.9", "1.1.12")).toBeLessThan(0);
    expect(compararVersoes("1.2.0", "1.1.99")).toBeGreaterThan(0);
    expect(compararVersoes("v1.1.12", "1.1.12")).toBe(0); // prefixo v ignorado
  });

  it("release ganha da prerelease do MESMO triplo (1.1.12 > 1.1.12-beta.6)", () => {
    expect(compararVersoes("1.1.12", "1.1.12-beta.6")).toBeGreaterThan(0);
    expect(compararVersoes("1.1.12-beta.6", "1.1.12")).toBeLessThan(0);
  });

  it("prereleases do mesmo triplo crescem com o numero", () => {
    expect(compararVersoes("1.1.12-beta.7", "1.1.12-beta.6")).toBeGreaterThan(0);
    expect(compararVersoes("1.1.12-beta.10", "1.1.12-beta.9")).toBeGreaterThan(0); // numerico, nao lexicografico
  });

  it("ordena o novo formato beta-10 acima de beta-9 e mantém compatibilidade", () => {
    expect(compararVersoes("1.1.12-beta-10", "1.1.12-beta-9")).toBeGreaterThan(0);
    expect(compararVersoes("1.1.12-beta-8", "1.1.12-beta.7")).toBeGreaterThan(0);
  });

  it("prerelease de triplo maior ganha de stable de triplo menor", () => {
    expect(compararVersoes("1.1.13-beta.1", "1.1.12")).toBeGreaterThan(0);
  });
});

describe("escolherRelease (candidata de update por canal)", () => {
  const estavel112 = release({ tag: "v1.1.12" });
  const beta6 = release({ tag: "v1.1.12-beta.6", url: urlDa("v1.1.12-beta.6"), prerelease: true });
  const beta7 = release({ tag: "v1.1.12-beta.7", url: urlDa("v1.1.12-beta.7"), prerelease: true });
  const betaSemExe = release({ tag: "v1.1.12-beta.8", url: null, prerelease: true });
  const estavel113 = release({ tag: "v1.1.13" });

  it("canal beta escolhe a MAIOR versao entre stable e prereleases", () => {
    const escolhida = escolherRelease([beta6, estavel112, beta7], "1.1.11", "beta");
    expect(escolhida?.tag).toBe("v1.1.12"); // stable > beta.7 no mesmo triplo
  });

  it("canal beta ignora release sem exe anexado", () => {
    const escolhida = escolherRelease([beta7, betaSemExe], "1.1.12-beta.7", "beta");
    expect(escolhida).toBeNull(); // beta.8 existe mas nao tem exe: nada a instalar
  });

  it("nunca faz downgrade: candidata <= atual devolve null", () => {
    expect(escolherRelease([beta6, beta7], "1.1.12-beta.7", "beta")).toBeNull();
    expect(escolherRelease([estavel112, beta7], "1.1.12", "beta")).toBeNull();
  });

  it("canal stable filtra prereleases (o testador em beta.7 so recebe stable)", () => {
    const escolhida = escolherRelease([beta7, estavel112], "1.1.12-beta.7", "stable");
    expect(escolhida?.tag).toBe("v1.1.12"); // stable > beta.7: voltou ao canal estavel
    expect(escolherRelease([beta7, beta6], "1.1.11", "stable")).toBeNull(); // so ha beta: nada
  });

  it("canal stable oferece a stable nova para quem esta em beta do mesmo triplo", () => {
    expect(escolherRelease([estavel112, beta7], "1.1.12-beta.6", "stable")?.tag).toBe("v1.1.12");
  });

  it("prerelease de triplo maior vence no canal beta", () => {
    const releases = [estavel112, release({ tag: "v1.1.13-beta.1", url: urlDa("v1.1.13-beta.1"), prerelease: true })];
    expect(escolherRelease(releases, "1.1.12", "beta")?.tag).toBe("v1.1.13-beta.1");
    expect(escolherRelease(releases, "1.1.11", "stable")?.tag).toBe("v1.1.12"); // estavel filtra a beta
    expect(escolherRelease(releases, "1.1.12", "stable")).toBeNull(); // ja esta na estavel: nada
    expect(escolherRelease([estavel113, estavel112], "1.1.12", "stable")?.tag).toBe("v1.1.13");
  });
});

describe("wiring do canal no updater e no workflow", () => {
  it("o updater liga allowPrerelease no Linux e usa escolherRelease no Windows", () => {
    const updater = fs.readFileSync(path.resolve(process.cwd(), "electron/updater.ts"), "utf8");
    expect(updater).toContain('const REPO = "bezumiya/GoLiveBypass"');
    expect(updater).toContain('autoUpdater.allowPrerelease = canalAtual() === "beta"');
    expect(updater).toContain("autoUpdater.autoInstallOnAppQuit = false");
    expect(updater).toContain("escolherRelease(releases, app.getVersion(), canal)");
    expect(updater).toContain("CHECK_INTERVAL_MS = 60 * 60 * 1000");
    expect(updater).toContain("createUpdatePulseClient");
    expect(updater).toContain("UPDATE_STREAM_URL");
    expect(updater).toContain("pending-windows-update.json");
    expect(updater).toContain('const reason = canal === "beta" ? "beta-ativada"');
    expect(updater).toContain("await checkWindowsUpdate");
    expect(updater).toContain("await checkLinuxUpdate");
    expect(updater).not.toContain("attemptReplace(current, downloaded)");
    // a comparacao por string que faria downgrade foi embora
    expect(updater).not.toContain("const isNewer = latest !== current;");
  });

  it("o workflow publica prerelease no canal beta e pula mac/assets", () => {
    const workflow = fs.readFileSync(
      path.resolve(process.cwd(), "..", ".github", "workflows", "build-gui.yml"),
      "utf8",
    );
    expect(workflow).toContain("canal:");
    expect(workflow).toContain("--config.publish.channel=beta --config.publish.releaseType=prerelease");
    expect(workflow).toContain("beta-marcar");
    expect(workflow).toContain("--repo bezumiya/GoLiveBypass");
  });

  it("o updater nunca usa showMessageBoxSync (bloqueia o watchdog do Tor enquanto o dialogo espera resposta)", () => {
    // showMessageBoxSync bloqueia a thread JS do processo principal ate a pessoa clicar um
    // botao -- inclusive o setInterval do watchdog do Tor (main.ts, ver
    // docs/handoff-2026-09-02-tor-watchdog-gap.md), que fica sem checar o daemon por todo o
    // tempo que o aviso de atualizacao ficar aberto sem resposta. showMessageBox (assincrono)
    // nao tem esse problema; main.ts ja usa a versao async em outro lugar (linha ~1162).
    const updater = fs.readFileSync(path.resolve(process.cwd(), "electron/updater.ts"), "utf8");
    expect(updater).not.toContain("dialog.showMessageBoxSync(");
    // Confirma que os 4 usos anteriores viraram await showMessageBox(...) de verdade,
    // nao so que a string sumiu por outro motivo.
    const usos = updater.match(/await dialog\.showMessageBox\(/g) ?? [];
    expect(usos.length).toBeGreaterThanOrEqual(4);
  });

  it("nao consulta releases durante npm run dev", () => {
    const updater = fs.readFileSync(path.resolve(process.cwd(), "electron/updater.ts"), "utf8");
    expect(updater).toMatch(/const isDev = !app\.isPackaged;[\s\S]{0,300}if \(isDev\) \{[\s\S]{0,300}return(?: null)?;/);
    expect(updater).not.toContain("autoUpdater.forceDevUpdateConfig = true");
  });
});
