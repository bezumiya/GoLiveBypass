import { describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { findWindowsDiscordInstall } from "../electron/windows-discord-install";

function makeInstall(root: string, version: string, options: { exe?: boolean; asar?: boolean; originalAsar?: boolean } = {}) {
  const app = path.join(root, `app-${version}`);
  const resources = path.join(app, "resources");
  fs.mkdirSync(resources, { recursive: true });
  if (options.exe !== false) fs.writeFileSync(path.join(app, "Discord.exe"), "");
  if (options.asar) fs.writeFileSync(path.join(resources, "app.asar"), "");
  if (options.originalAsar) fs.writeFileSync(path.join(resources, "_app.asar"), "");
}

describe("descoberta do Discord Windows", () => {
  it("detecta a instalação direta dos clientes paralelos atuais", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parallel-install-"));
    try {
      fs.mkdirSync(path.join(root, "resources"));
      fs.writeFileSync(path.join(root, "equibop.exe"), "");
      expect(findWindowsDiscordInstall(root, "Equibop")).toEqual({
        appDir: root,
        resources: path.join(root, "resources"),
        exePath: path.join(root, "equibop.exe"),
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("seleciona o executavel mais novo e ignora pasta Squirrel sem executavel", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "discord-install-"));
    try {
      makeInstall(root, "1.0.9");
      makeInstall(root, "1.0.10", { exe: false });
      expect(findWindowsDiscordInstall(root, "Discord")?.appDir).toBe("app-1.0.9");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("detecta Discord somente pelo executavel, mesmo sem resources", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "discord-install-"));
    try {
      const app = path.join(root, "app-1.0.10");
      fs.mkdirSync(app);
      fs.writeFileSync(path.join(app, "Discord.exe"), "");
      const install = findWindowsDiscordInstall(root, "Discord");
      expect(install?.appDir).toBe("app-1.0.10");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("nao diferencia o carregador BetterDiscord do Discord oficial", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "discord-install-"));
    try {
      makeInstall(root, "1.0.10");
      const loader = path.join(root, "app-1.0.10", "resources", "app");
      fs.mkdirSync(loader);
      fs.writeFileSync(path.join(loader, "package.json"), '{"main":"./index.js"}');
      expect(findWindowsDiscordInstall(root, "Discord")?.exePath).toBe(path.join(root, "app-1.0.10", "Discord.exe"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("nao considera pasta sem executavel uma instalacao", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "discord-install-"));
    try {
      makeInstall(root, "1.0.10", { exe: false, asar: true });
      expect(findWindowsDiscordInstall(root, "Discord")).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

});
