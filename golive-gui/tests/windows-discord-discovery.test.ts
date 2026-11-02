import { describe, expect, it } from "vitest";
import path from "path";
import {
  buildWindowsDiscoveryPowerShell,
  collectWindowsDiscoveryPowerShell,
  WindowsDiscoveryCollectionError,
  collectWindowsDiscoveryPowerShellAsync,
  collectWindowsDiscoverySnapshot,
  createWindowsDiscoveryCache,
  flavourFromExecutableName,
  handleProcessRows,
  handleRegistryRows,
  handleRootPaths,
  handleShortcutRoots,
  makeWindowsDiscoveryCandidate,
  mergeWindowsDiscoveryCandidates,
  normalizeWindowsDiscoveryPath,
  parseWindowsDiscoveryCommand,
  parseWindowsDiscoveryJson,
  rootsForEnvironment,
  shortcutRootsForEnvironment,
  summarizeWindowsDiscoveryCollection,
  toPublicWindowsDiscoveryInstall,
  validateWindowsExecutable,
  validateWindowsProcessExecutable,
  windowsSquirrelUpdaterPath,
  type WindowsDiscoveryCandidate,
  type WindowsDiscoveryEnvironment,
  type WindowsDiscoveryFileSystem,
  type WindowsDiscoveryRaw,
  type WindowsDiscoveryRegistryHandlerDeps,
  type WindowsDiscoverySnapshot,
  type WindowsDiscoverySnapshotCollectors,
} from "../electron/windows-discord-discovery";
import type { WindowsDiscordInstall } from "../electron/windows-discord-install";

function winKey(value: string): string {
  return path.win32.normalize(value).toLowerCase();
}

function fakeFs(files: string[], existing: string[] = []): WindowsDiscoveryFileSystem {
  const fileSet = new Set(files.map(winKey));
  const existingSet = new Set([...files, ...existing].map(winKey));
  return {
    exists: (target) => existingSet.has(winKey(target)),
    isFile: (target) => fileSet.has(winKey(target)),
  };
}

function candidate(
  source: WindowsDiscoveryCandidate["source"],
  flavour: "Discord" | "DiscordPTB",
  exePath: string,
  fs: WindowsDiscoveryFileSystem,
  processOnly = false,
): WindowsDiscoveryCandidate {
  const result = makeWindowsDiscoveryCandidate(source, flavour, exePath, fs, processOnly);
  if (!result) throw new Error(`fixture inválido: ${exePath}`);
  return result;
}

function emptySnapshot(capturedAtMs = 0, collectionFailed = false, sourceFailure?: string): WindowsDiscoverySnapshot {
  return { installs: [], capturedAtMs, collectionFailed, sourceFailure };
}
function registryDeps(
  fs: WindowsDiscoveryFileSystem,
  found: WindowsDiscordInstall[] = [],
): WindowsDiscoveryRegistryHandlerDeps {
  return {
    ...fs,
    listDirectory: () => [],
    findInstall: (root, flavour) =>
      found.find((install) =>
        winKey(install.appDir).startsWith(winKey(root)) &&
        install.exePath.toLowerCase().endsWith(`\\${flavour.toLowerCase()}.exe`),
      ) ?? null,
  };
}
function shortcutDeps(
  directories: Map<string, string[]>,
  shortcuts: Map<string, { target: string; args: string }>,
  fs: WindowsDiscoveryFileSystem,
  found: WindowsDiscordInstall[] = [],
): WindowsDiscoverySnapshotCollectors {
  const base = registryDeps(fs, found);
  const normalizedDirectories = new Map(
    [...directories.entries()].map(([key, names]) => [winKey(key), names] as const),
  );
  const normalizedShortcuts = new Map(
    [...shortcuts.entries()].map(([key, value]) => [winKey(key), value] as const),
  );
  return {
    ...base,
    collectPowerShell: () => ({
      schema: 1,
      process: { status: "empty", rows: [], truncated: false },
      registry: { status: "empty", rows: [], truncated: false },
    }),
    isDirectory: (target) => normalizedDirectories.has(winKey(target)),
    isSymbolicLink: () => false,
    listDirectory: (root) => normalizedDirectories.get(winKey(root)) ?? [],
    readShortcut: (file) => {
      const shortcut = normalizedShortcuts.get(winKey(file));
      if (!shortcut) throw new Error("shortcut inválido");
      return shortcut;
    },
  };
}

describe("discovery Windows puro", () => {
  it("preserva timeout do runner com codigo estavel e detalhe sanitizado", async () => {
    const erro = Object.assign(
      new Error("Command failed: C:\\Users\\segredo\\AppData\\Local\\Temp\\runner.js"),
      { code: "ETIMEDOUT", killed: true },
    );

    let capturado: unknown;
    try {
      await collectWindowsDiscoveryPowerShellAsync(async () => {
        throw erro;
      });
    } catch (error) {
      capturado = error;
    }

    expect(capturado).toBeInstanceOf(WindowsDiscoveryCollectionError);
    expect((capturado as WindowsDiscoveryCollectionError).errorCode).toBe("POWERSHELL_TIMEOUT");
    const detalhe = (capturado as WindowsDiscoveryCollectionError).errorDetail;
    expect(detalhe).toBeTruthy();
    expect(detalhe.length).toBeLessThanOrEqual(96);
    expect(detalhe).not.toContain("C:\\Users\\segredo");
    expect(detalhe).not.toContain("runner.js");
    expect(detalhe).not.toContain(" at ");
  });
  it("classifica saída não-zero como exit sem vazar caminho", async () => {
    const erro = Object.assign(new Error("Command failed C:\\Users\\segredo\\powershell.ps1"), { code: 7 });

    await expect(collectWindowsDiscoveryPowerShellAsync(async () => {
      throw erro;
    })).rejects.toMatchObject({
      errorCode: "POWERSHELL_EXIT",
      errorDetail: "Command failed [path]",
    });
  });


  it("preserva candidatos de filesystem quando PowerShell sai com codigo nao-zero", () => {
    const root = "C:\\Program Files";
    const executable = `${root}\\Discord\\app-1.0.10\\Discord.exe`;
    const fs = fakeFs([executable]);
    const install: WindowsDiscordInstall = {
      appDir: path.win32.dirname(executable),
      resources: path.win32.join(path.win32.dirname(executable), "resources"),
      exePath: executable,
    };
    const snapshot = collectWindowsDiscoverySnapshot({ ProgramFiles: root }, {
      ...registryDeps(fs, [install]),
      collectPowerShell: () => {
        throw Object.assign(new Error("PowerShell exit 1"), { code: 1 });
      },
    }, 123);

    expect(snapshot.installs).toHaveLength(1);
    expect(snapshot.installs[0]).toMatchObject({ source: "root", flavour: "Discord", exePath: executable });
    expect(snapshot.sourceFailure).toContain("POWERSHELL_EXIT");
  });

  it("gera roots Windows determinísticos, deduplica envs e não bloqueia sem LOCALAPPDATA", () => {
    const env: WindowsDiscoveryEnvironment = {
      LOCALAPPDATA: "C:\\Users\\A\\AppData\\Local",
      ProgramFiles: "C:\\Program Files",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      ProgramW6432: "c:\\program files",
    };
    expect(rootsForEnvironment(env)).toEqual([
      "C:\\Users\\A\\AppData\\Local",
      "C:\\Users\\A\\AppData\\Local\\Programs",
      "C:\\Program Files",
      "C:\\Program Files\\Programs",
      "C:\\Program Files (x86)",
      "C:\\Program Files (x86)\\Programs",
    ]);
    expect(rootsForEnvironment({ ProgramFiles: "D:\\Apps" })).toEqual([
      "D:\\Apps",
      "D:\\Apps\\Programs",
    ]);
  });
  it("usa finder bounded para roots de flavour e transforma em source=root", () => {
    const root = "C:\\Program Files";
    const executable = `${root}\\Discord\\app-1.0.10\\Discord.exe`;
    const fs = fakeFs([executable]);
    const candidates = handleRootPaths([root], registryDeps(fs, [{
      appDir: path.win32.dirname(executable),
      resources: path.win32.join(path.win32.dirname(executable), "resources"),
      exePath: executable,
    }]), ["Discord"]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ source: "root", flavour: "Discord", exePath: executable });
  });

  it("descobre atalhos diretos/vendor/Update sem executar args nem recursar", () => {
    const env: WindowsDiscoveryEnvironment = {
      APPDATA: "C:\\Users\\A\\AppData\\Roaming",
      ProgramData: "C:\\ProgramData",
      USERPROFILE: "C:\\Users\\A",
      PUBLIC: "C:\\Users\\Public",
    };
    const [startRoot] = shortcutRootsForEnvironment(env);
    const vendor = path.win32.join(startRoot, "Vendor");
    const deep = path.win32.join(vendor, "Nested");
    const direct = "D:\\Apps\\Discord.exe";
    const updater = "D:\\Discord\\Update.exe";
    const installed = "D:\\Discord\\app-1.0.10\\Discord.exe";
    const directories = new Map([
      [startRoot, ["Discord.lnk", "Vendor"]],
      [vendor, ["Canary.lnk", "Nested", "Broken.lnk"]],
      [deep, ["ShouldNotRead.lnk"]],
    ]);
    const shortcuts = new Map([
      [winKey(path.win32.join(startRoot, "Discord.lnk")), { target: direct, args: "--url %1" }],
      [winKey(path.win32.join(vendor, "Canary.lnk")), { target: "D:\\Apps\\DiscordCanary.exe", args: "" }],
      [winKey(path.win32.join(vendor, "Broken.lnk")), { target: updater, args: "--processStart Discord.exe --extra" }],
    ]);
    const fs = fakeFs([direct, "D:\\Apps\\DiscordCanary.exe", updater, installed]);
    const candidates = handleShortcutRoots(env, shortcutDeps(directories, shortcuts, fs, [{
      appDir: path.win32.dirname(installed),
      resources: path.win32.join(path.win32.dirname(installed), "resources"),
      exePath: installed,
    }]));

    expect(candidates.map((candidate) => candidate.exePath)).toEqual([
      direct,
      "D:\\Apps\\DiscordCanary.exe",
    ]);
  });

  it("limita 64 links diretos e 64 por vendor sem atravessar segundo nível", () => {
    const env: WindowsDiscoveryEnvironment = { APPDATA: "C:\\Roaming" };
    const [startRoot] = shortcutRootsForEnvironment(env);
    const vendor = path.win32.join(startRoot, "Vendor");
    const deep = path.win32.join(vendor, "Nested");
    const target = "D:\\Apps\\Discord.exe";
    const directNames = Array.from({ length: 65 }, (_, index) => `direct-${index}.lnk`);
    const vendorNames = Array.from({ length: 65 }, (_, index) => `vendor-${index}.lnk`);
    const directories = new Map([
      [startRoot, [...directNames, "Vendor"]],
      [vendor, [...vendorNames, "Nested"]],
      [deep, ["deep.lnk"]],
    ]);
    const shortcuts = new Map<string, { target: string; args: string }>();
    for (const name of [...directNames, ...vendorNames]) {
      const parent = directNames.includes(name) ? startRoot : vendor;
      shortcuts.set(winKey(path.win32.join(parent, name)), { target, args: "" });
    }
    const candidates = handleShortcutRoots(env, shortcutDeps(directories, shortcuts, fakeFs([target])));
    expect(candidates).toHaveLength(128);
  });
  it("mantém Desktop direct-only quando as raízes Start Menu estão ausentes", () => {
    const env: WindowsDiscoveryEnvironment = { USERPROFILE: "C:\\Users\\A", PUBLIC: "C:\\Users\\Public" };
    const [desktop] = shortcutRootsForEnvironment(env);
    const vendor = path.win32.join(desktop, "Vendor");
    const direct = "D:\\Apps\\Discord.exe";
    const nested = "D:\\Apps\\Vesktop.exe";
    const directories = new Map([
      [desktop, ["Discord.lnk", "Vendor"]],
      [vendor, ["Vesktop.lnk"]],
    ]);
    const shortcuts = new Map([
      [path.win32.join(desktop, "Discord.lnk"), { target: direct, args: "" }],
      [path.win32.join(vendor, "Vesktop.lnk"), { target: nested, args: "" }],
    ]);
    const candidates = handleShortcutRoots(env, shortcutDeps(
      directories,
      shortcuts,
      fakeFs([direct, nested]),
    ));
    expect(candidates.map((candidate) => candidate.exePath)).toEqual([direct]);
  });

  it("combina roots, handlers PowerShell e atalhos em snapshot com health", () => {
    const root = "C:\\Program Files";
    const processExe = "D:\\MyDiscord\\app-1.0.10\\Discord.exe";
    const rootExe = `${root}\\Discord\\app-1.0.10\\Discord.exe`;
    const fs = fakeFs([processExe, rootExe]);
    const rootInstall: WindowsDiscordInstall = {
      appDir: path.win32.dirname(rootExe),
      resources: path.win32.join(path.win32.dirname(rootExe), "resources"),
      exePath: rootExe,
    };
    const base = shortcutDeps(new Map(), new Map(), fs, [rootInstall]);
    const raw: WindowsDiscoveryRaw = {
      schema: 1,
      process: {
        status: "ok",
        rows: [{ name: "Discord.exe", pid: 1, path: processExe }],
        truncated: false,
      },
      registry: {
        status: "partial",
        rows: [],
        truncated: true,
        errorCode: "UNINSTALL_LIMIT",
      },
    };
    const snapshot = collectWindowsDiscoverySnapshot({ ProgramFiles: root }, {
      ...base,
      collectPowerShell: () => raw,
    }, 123);

    expect(snapshot.installs.map((install) => install.exePath)).toEqual([rootExe, processExe]);
    expect(snapshot.collectionFailed).toBe(false);
    expect(snapshot.sourceFailure).toContain("registry:UNINSTALL_LIMIT");
  });
  it("aceita schema=1 e normaliza row único do PowerShell 5.1", () => {
    const parsed = parseWindowsDiscoveryJson(JSON.stringify({
      schema: 1,
      process: {
        status: "ok",
        rows: { name: "Discord.exe", pid: 42, path: "C:\\Discord\\Discord.exe" },
        truncated: false,
      },
      registry: {
        status: "empty",
        rows: [],
        truncated: false,
      },
    }));

    expect(parsed.schema).toBe(1);
    expect(parsed.process.rows).toEqual([
      { name: "Discord.exe", pid: 42, path: "C:\\Discord\\Discord.exe" },
    ]);
    expect(parsed.registry.rows).toEqual([]);
  });

  it("rejeita schema desconhecido, descarta rows inválidos e campos fora do kind", () => {
    expect(() => parseWindowsDiscoveryJson(JSON.stringify({
      schema: 2,
      process: { status: "ok", rows: [], truncated: false },
      registry: { status: "empty", rows: [], truncated: false },
    }))).toThrow("Schema");

    const parsed = parseWindowsDiscoveryJson(JSON.stringify({
      schema: 1,
      process: {
        status: "partial",
        rows: [
          { name: "Discord.exe", pid: "42", path: "C:\\Discord\\Discord.exe" },
          { name: "Discord.exe", pid: 42, path: null },
        ],
        truncated: true,
        errorCode: "PROCESS_LIMIT",
      },
      registry: {
        status: "empty",
        rows: [
          { hive: "hkcu", kind: "app-paths", value: "C:\\Discord\\Discord.exe", displayIcon: "C:\\Discord\\Discord.exe" },
          { hive: "hkcu", kind: "uninstall", value: "", displayIcon: "C:\\Discord\\Update.exe,0", installLocation: "C:\\Discord" },
        ],
        truncated: false,
      },
    }));

    expect(parsed.process.rows).toEqual([{ name: "Discord.exe", pid: 42, path: null }]);
    expect(parsed.process).toMatchObject({ status: "partial", truncated: true, errorCode: "PROCESS_LIMIT" });
    expect(parsed.registry.rows).toEqual([{
      hive: "hkcu",
      kind: "uninstall",
      value: "",
      displayIcon: "C:\\Discord\\Update.exe,0",
      installLocation: "C:\\Discord",
    }]);
  });

  it("aplica ,0 somente ao token de displayIcon", () => {
    const executable = "C:\\Program Files\\Discord\\Discord.exe";
    expect(normalizeWindowsDiscoveryPath(`${executable},0`, "value")).toBeNull();
    expect(normalizeWindowsDiscoveryPath(`"${executable}",0`, "value")).toBeNull();
    expect(normalizeWindowsDiscoveryPath(`${executable},0`, "displayIcon")).toBe(executable);
    expect(normalizeWindowsDiscoveryPath(`"${executable}",0`, "displayIcon")).toBe(executable);
    expect(normalizeWindowsDiscoveryPath(`"${executable}"`, "value")).toBe(executable);
    const x86Executable = "C:\\Program Files (x86)\\Discord\\app-1.0.10\\Discord.exe";
    expect(normalizeWindowsDiscoveryPath(x86Executable, "process")).toBe(x86Executable);
    expect(normalizeWindowsDiscoveryPath(`${x86Executable},0`, "displayIcon")).toBe(x86Executable);
    expect(normalizeWindowsDiscoveryPath(executable, "process")).toBe(executable);
  });
  it("coleta JSON schema=1 com runner PowerShell injetável e script constante", () => {
    let invocation: { file: string; args: readonly string[] } | undefined;
    const raw = JSON.stringify({
      schema: 1,
      process: { status: "empty", rows: [], truncated: false },
      registry: { status: "partial", rows: [], truncated: true, errorCode: "UNINSTALL_LIMIT" },
    });
    const parsed = collectWindowsDiscoveryPowerShell((file, args) => {
      invocation = { file, args };
      return raw;
    });

    expect(parsed.registry).toMatchObject({ status: "partial", truncated: true, errorCode: "UNINSTALL_LIMIT" });
    expect(invocation?.file).toBe("powershell.exe");
    expect(invocation?.args).toEqual(expect.arrayContaining(["-NoProfile", "-NonInteractive", "-EncodedCommand"]));
    expect(invocation?.args).not.toContain("-ExecutionPolicy");
    expect(invocation?.args).not.toContain("-Command");
    const encoded = invocation?.args[3] ?? "";
    expect(Buffer.from(encoded, "base64").toString("utf16le")).toBe(buildWindowsDiscoveryPowerShell());
    expect(buildWindowsDiscoveryPowerShell()).toContain("FROM Win32_Process WHERE Name = 'Discord.exe'");
    expect(buildWindowsDiscoveryPowerShell()).toContain("Select-Object -First 65");
    expect(buildWindowsDiscoveryPowerShell()).toContain("$processStatus = 'partial'");
    expect(buildWindowsDiscoveryPowerShell()).toContain("Select-Object -First 129");
    expect(buildWindowsDiscoveryPowerShell()).toContain("$wow + 'Classes'");
    // O registro vai por RegistryKey (.NET): o provider do PowerShell levava ~35s nesta varredura.
    expect(buildWindowsDiscoveryPowerShell()).toContain("[Microsoft.Win32.Registry]::LocalMachine");
    expect(buildWindowsDiscoveryPowerShell()).not.toMatch(/Get-ItemProperty|Get-ChildItem|Get-CimInstance|Test-Path/);
  });

  it("coleta o mesmo JSON pelo runner assincrono, com os mesmos erros mapeados", async () => {
    let invocation: { file: string; args: readonly string[] } | undefined;
    const raw = JSON.stringify({
      schema: 1,
      process: { status: "empty", rows: [], truncated: false },
      registry: { status: "partial", rows: [], truncated: true, errorCode: "UNINSTALL_LIMIT" },
    });
    const parsed = await collectWindowsDiscoveryPowerShellAsync(async (file, args) => {
      invocation = { file, args };
      return raw;
    });

    expect(parsed.registry).toMatchObject({ status: "partial", truncated: true, errorCode: "UNINSTALL_LIMIT" });
    expect(invocation?.file).toBe("powershell.exe");
    const encoded = invocation?.args[3] ?? "";
    expect(Buffer.from(encoded, "base64").toString("utf16le")).toBe(buildWindowsDiscoveryPowerShell());

    await expect(collectWindowsDiscoveryPowerShellAsync(async () => {
      throw new Error("caminho privado");
    })).rejects.toThrow("POWERSHELL_EXIT");
    await expect(collectWindowsDiscoveryPowerShellAsync(async () => "{}")).rejects.toThrow("JSON_INVALID");
  });

  it("mapeia falha catastrófica e JSON inválido para erros sem expor exceção", () => {
    expect(() => collectWindowsDiscoveryPowerShell(() => {
      throw new Error("caminho privado");
    })).toThrow("POWERSHELL_EXIT");
    expect(() => collectWindowsDiscoveryPowerShell(() => "{}")).toThrow("JSON_INVALID");
  });
  it("resume partial/error dos blocos como coleta degradada sem apagar rows", () => {
    const raw = parseWindowsDiscoveryJson(JSON.stringify({
      schema: 1,
      process: {
        status: "partial",
        rows: [{ name: "Discord.exe", pid: 10, path: null }],
        truncated: true,
        errorCode: "PROCESS_LIMIT",
      },
      registry: {
        status: "error",
        rows: [],
        truncated: false,
        errorCode: "REGISTRY_UNAVAILABLE",
      },
    }));
    const health = summarizeWindowsDiscoveryCollection(raw);
    expect(health).toEqual({
      collectionFailed: true,
      sourceFailure: "process:PROCESS_LIMIT,registry:REGISTRY_UNAVAILABLE",
    });
    expect(raw.process.rows).toHaveLength(1);
  });
  it("truncamento bounded é aviso sem collectionFailed, enquanto erro parcial degrada", () => {
    const truncated = parseWindowsDiscoveryJson(JSON.stringify({
      schema: 1,
      process: { status: "partial", rows: [], truncated: true, errorCode: "PROCESS_LIMIT" },
      registry: { status: "partial", rows: [], truncated: true, errorCode: "UNINSTALL_LIMIT" },
    }));
    expect(summarizeWindowsDiscoveryCollection(truncated)).toEqual({
      collectionFailed: false,
      sourceFailure: "process:PROCESS_LIMIT,registry:UNINSTALL_LIMIT",
    });

    const partialError = parseWindowsDiscoveryJson(JSON.stringify({
      schema: 1,
      process: { status: "partial", rows: [], truncated: true, errorCode: "PROCESS_LIMIT" },
      registry: { status: "partial", rows: [], truncated: true, errorCode: "REGISTRY_PARTIAL" },
    }));
    expect(summarizeWindowsDiscoveryCollection(partialError)).toEqual({
      collectionFailed: true,
      sourceFailure: "process:PROCESS_LIMIT,registry:REGISTRY_PARTIAL",
    });
  });
  it("cacheia resultado truncado normal como fresco em vez de usar stale", () => {
    let nowMs = 0;
    let calls = 0;
    const cache = createWindowsDiscoveryCache({
      platform: () => "win32",
      nowMs: () => nowMs,
      readEnv: () => ({}),
      rootsForEnv: () => [],
      collectFresh: () => {
        calls += 1;
        return calls === 1
          ? emptySnapshot()
          : emptySnapshot(nowMs, false, "registry:UNINSTALL_LIMIT");
      },
    });

    cache.read();
    nowMs = 4_001;
    const freshWarning = cache.read({ allowStale: true });
    expect(freshWarning).toMatchObject({
      stale: false,
      collectionFailed: false,
      sourceFailure: "registry:UNINSTALL_LIMIT",
    });
    expect(calls).toBe(2);
  });

  it("trata processos pelos seis nomes e caminhos exatos", () => {
    const discord = "D:\\MyDiscord\\app-1.0.10\\Discord.exe";
    const fs = fakeFs([discord]);
    const candidates = handleProcessRows([
      { name: "Discord.exe", pid: 10, path: discord },
      { name: "Update.exe", pid: 11, path: "D:\\MyDiscord\\Update.exe" },
      { name: "Discord.exe", pid: 12, path: null },
    ], fs);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ source: "process", flavour: "Discord", exePath: discord });
  });

  it("usa App Paths, URL handler e fallback Uninstall sem executar command strings", () => {
    const direct = "C:\\Program Files\\Discord\\Discord.exe";
    const updater = "C:\\Discord\\Update.exe";
    const installed = "C:\\Discord\\app-1.0.10\\Discord.exe";
    const x86Root = "C:\\Program Files (x86)\\Discord";
    const x86Installed = `${x86Root}\\app-1.0.10\\Discord.exe`;
    const fs = fakeFs([direct, updater, installed, x86Installed]);
    const found: WindowsDiscordInstall[] = [
      {
        appDir: path.win32.dirname(installed),
        resources: path.win32.join(path.win32.dirname(installed), "resources"),
        exePath: installed,
      },
      {
        appDir: path.win32.dirname(x86Installed),
        resources: path.win32.join(path.win32.dirname(x86Installed), "resources"),
        exePath: x86Installed,
      },
    ];
    const candidates = handleRegistryRows([
      { hive: "hkcu", kind: "app-paths", value: `"${direct}"`, flavourHint: "Discord" },
      { hive: "hkcu", kind: "url-handler", value: `"${direct}" --url "%1"`, flavourHint: "Discord" },
      { hive: "hkcu", kind: "url-handler", value: `"${updater}" --processStart Discord.exe`, flavourHint: "Discord" },
      { hive: "hkcu", kind: "url-handler", value: `"${updater}" --processStart Discord.exe --extra`, flavourHint: "Discord" },
      { hive: "hkcu", kind: "uninstall", value: "", flavourHint: "Discord", displayIcon: `${direct},0`, installLocation: "C:\\Program Files\\Discord" },
      { hive: "hkcu", kind: "uninstall", value: "", flavourHint: "Discord", installLocation: x86Root },
    ], registryDeps(fs, found));

    expect(candidates.some((candidate) => candidate.exePath === direct)).toBe(true);
    expect(candidates.some((candidate) => candidate.exePath === installed)).toBe(true);
    expect(candidates.some((candidate) => candidate.exePath === x86Installed)).toBe(true);
    expect(candidates).toHaveLength(5);
  });
  it("aceita InstallLocation x86 não quoted e acha app-* via finder bounded", () => {
    const root = "C:\\Program Files (x86)\\Discord";
    const executable = `${root}\\app-1.0.10\\Discord.exe`;
    const fs = fakeFs([executable]);
    const candidates = handleRegistryRows([
      { hive: "hklm", kind: "uninstall", value: "", flavourHint: "Discord", installLocation: root },
    ], registryDeps(fs, [{
      appDir: path.win32.dirname(executable),
      resources: path.win32.join(path.win32.dirname(executable), "resources"),
      exePath: executable,
    }]));
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ source: "registry", flavour: "Discord", exePath: executable });
  });
  it("aceita InstallLocation x86 quoted como token único", () => {
    const root = "C:\\Program Files (x86)\\Discord";
    const executable = `${root}\\app-1.0.10\\Discord.exe`;
    const fs = fakeFs([executable]);
    const candidates = handleRegistryRows([
      { hive: "hklm", kind: "uninstall", value: "", flavourHint: "Discord", installLocation: `"${root}"` },
    ], registryDeps(fs, [{
      appDir: path.win32.dirname(executable),
      resources: path.win32.join(path.win32.dirname(executable), "resources"),
      exePath: executable,
    }]));
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ source: "registry", flavour: "Discord", exePath: executable });
  });

  it("tokeniza command string Windows, preserva args em memória e rejeita quoting malformado", () => {
    expect(parseWindowsDiscoveryCommand(
      '"C:\\Program Files\\Discord\\Update.exe" --processStart Discord.exe',
    )).toEqual({
      executable: "C:\\Program Files\\Discord\\Update.exe",
      args: ["--processStart", "Discord.exe"],
    });
    expect(parseWindowsDiscoveryCommand("C:\\Discord\\Discord.exe --flag")).toEqual({
      executable: "C:\\Discord\\Discord.exe",
      args: ["--flag"],
    });
    expect(parseWindowsDiscoveryCommand('"C:\\Discord\\Update.exe --processStart Discord.exe')).toBeNull();
    expect(parseWindowsDiscoveryCommand('"" --processStart Discord.exe')).toBeNull();
    expect(normalizeWindowsDiscoveryPath('"C:\\Program Files\\Discord\\Discord.exe" --flag', "value")).toBeNull();
  });

  it("deriva flavour somente do nome exato do executável", () => {
    expect(flavourFromExecutableName("Discord.exe")).toBe("Discord");
    expect(flavourFromExecutableName("discordptb.EXE")).toBe("DiscordPTB");
    expect(flavourFromExecutableName("DiscordHelper.exe")).toBeNull();
    expect(flavourFromExecutableName("Update.exe")).toBeNull();
  });

  it("valida caminho customizado app-* sem exigir ancestral com nome flavour", () => {
    const exe = "D:\\MyDiscord\\app-1.0.10\\Discord.exe";
    const fs = fakeFs([exe]);
    expect(validateWindowsExecutable(exe, "Discord", fs)).toBe(exe);
    expect(validateWindowsProcessExecutable(exe, "Discord", fs)).toBe(exe);
  });

  it("aceita executável direto somente com resources ao lado", () => {
    const exe = "D:\\Custom\\Discord.exe";
    const resources = path.win32.join(path.win32.dirname(exe), "resources");
    const fs = fakeFs([exe], [resources]);
    expect(validateWindowsProcessExecutable(exe, "Discord", fs)).toBe(exe);
  });

  it("aceita Serein plano sem resources; Electron continua exigindo a marca", () => {
    const serein = "C:\\Users\\a\\AppData\\Local\\Programs\\Serein\\serein.exe";
    expect(flavourFromExecutableName("Serein.exe")).toBe("Serein");
    expect(validateWindowsProcessExecutable(serein, "Serein", fakeFs([serein]))).toBe(serein);
    // mesma ausencia de resources continua rejeitando o Electron (Vesktop sem app-*/resources)
    const vesktop = "C:\\Apps\\Vesktop\\Vesktop.exe";
    expect(validateWindowsProcessExecutable(vesktop, "Vesktop", fakeFs([vesktop]))).toBeNull();
  });

  it("handleProcessRows reconhece sessão do Serein sem pasta resources", () => {
    const exe = "C:\\Users\\a\\AppData\\Local\\Programs\\Serein\\serein.exe";
    const fs = fakeFs([exe]);
    const candidates = handleProcessRows([{ name: "serein.exe", pid: 42, path: exe }], fs);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ flavour: "Serein", source: "process", exePath: exe });
  });

  it("rejeita args sem aspas mesmo quando o último argumento termina em .exe", () => {
    const command = "C:\\Discord\\Update.exe --processStart Discord.exe";
    expect(parseWindowsDiscoveryCommand(command)).toEqual({
      executable: "C:\\Discord\\Update.exe",
      args: ["--processStart", "Discord.exe"],
    });
    expect(normalizeWindowsDiscoveryPath(command, "process")).toBeNull();
    expect(normalizeWindowsDiscoveryPath(command, "value")).toBeNull();
    expect(normalizeWindowsDiscoveryPath(`${command},0`, "displayIcon")).toBeNull();
  });

  it("rejeita caminho relativo, UNC, ADS, argumentos, flavour falso e arquivo não regular", () => {
    const fs = fakeFs(["C:\\Discord\\Discord.exe"]);
    expect(normalizeWindowsDiscoveryPath("Discord.exe", "process")).toBeNull();
    expect(normalizeWindowsDiscoveryPath("\\\\server\\share\\Discord.exe", "process")).toBeNull();
    expect(normalizeWindowsDiscoveryPath("C:\\Discord\\payload:stream.exe", "process")).toBeNull();
    expect(normalizeWindowsDiscoveryPath("C:\\Discord\\Discord.exe --flag", "process")).toBeNull();
    expect(validateWindowsExecutable("C:\\Discord\\Discord.exe", "DiscordPTB", fs)).toBeNull();
    expect(validateWindowsExecutable("C:\\Discord\\Discord.exe", "Discord", fakeFs([]))).toBeNull();
    expect(validateWindowsProcessExecutable("C:\\Custom\\Discord.exe", "Discord", fs)).toBeNull();
  });
  it("deduplica somente exePath, respeita precedência e preserva roots do mesmo flavour", () => {
    const stable = "C:\\One\\Discord.exe";
    const other = "D:\\Two\\Discord.exe";
    const fs = fakeFs([stable, other]);
    const merged = mergeWindowsDiscoveryCandidates([
      candidate("shortcut", "Discord", stable, fs),
      candidate("registry", "Discord", stable, fs),
      candidate("process", "Discord", stable, fs),
      candidate("root", "Discord", other, fs),
    ]);

    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ exePath: stable, source: "process", detectedBy: "process" });
    expect(merged[1]).toMatchObject({ exePath: other, source: "root" });
    expect(toPublicWindowsDiscoveryInstall(merged[0])).toEqual({
      flavour: "Discord",
      resources: "C:\\One\\resources",
      exePath: stable,
    });
    expect(toPublicWindowsDiscoveryInstall(merged[0])).not.toHaveProperty("detectedBy");
  });

  it("mantém cache puro sem Electron, com TTL, stale e forceRefresh controlados por nowMs", () => {
    let nowMs = 0;
    let calls = 0;
    let env: WindowsDiscoveryEnvironment = { ProgramFiles: "C:\\Program Files" };
    let platform = "win32";
    const cache = createWindowsDiscoveryCache({
      platform: () => platform,
      nowMs: () => nowMs,
      readEnv: () => env,
      rootsForEnv: (current) => current.ProgramFiles ? [`${current.ProgramFiles}\\Discord`] : [],
      collectFresh: (_current, _roots) => { calls += 1; return emptySnapshot(); },
    });

    expect(cache.read()).toMatchObject({ stale: false });
    expect(calls).toBe(1);
    nowMs = 3_999;
    cache.read();
    expect(calls).toBe(1);
    nowMs = 4_000;
    cache.read();
    expect(calls).toBe(2);
    cache.read({ forceRefresh: true });
    expect(calls).toBe(3);

    env = { ProgramFiles: "D:\\Program Files" };
    cache.read();
    expect(calls).toBe(4);
    platform = "darwin";
    cache.read();
    expect(calls).toBe(5);
  });

  it("usa stale por no máximo 8s somente quando permitido e falha sem stale", () => {
    let nowMs = 0;
    let calls = 0;
    const cache = createWindowsDiscoveryCache({
      platform: () => "win32",
      nowMs: () => nowMs,
      readEnv: () => ({}),
      rootsForEnv: () => [],
      collectFresh: () => {
        calls += 1;
        if (calls > 1) throw new Error("fonte indisponível");
        return emptySnapshot();
      },
    });

    cache.read();
    nowMs = 4_001;
    const stale = cache.read({ allowStale: true });
    expect(stale.stale).toBe(true);
    expect(calls).toBe(2);
    expect(() => cache.read()).toThrow("fonte indisponível");
    nowMs = 8_000;
    expect(() => cache.read({ allowStale: true })).toThrow("fonte indisponível");
  });
  it("reutiliza snapshot saudável quando coleta nova retorna degradada e permite resultado degradado sem stale", () => {
    let nowMs = 0;
    let calls = 0;
    const cache = createWindowsDiscoveryCache({
      platform: () => "win32",
      nowMs: () => nowMs,
      readEnv: () => ({}),
      rootsForEnv: () => [],
      collectFresh: () => {
        calls += 1;
        return calls === 1
          ? emptySnapshot()
          : emptySnapshot(nowMs, true, "REGISTRY_UNAVAILABLE");
      },
    });

    cache.read();
    nowMs = 4_001;
    const stale = cache.read({ allowStale: true });
    expect(stale).toMatchObject({ stale: true, collectionFailed: false });
    expect(calls).toBe(2);

    const degraded = cache.read();
    expect(degraded).toMatchObject({
      stale: false,
      collectionFailed: true,
      sourceFailure: "REGISTRY_UNAVAILABLE",
    });
    expect(calls).toBe(3);
  });

  it("aceita ambiente sem LOCALAPPDATA quando roots dependentes ficam vazias", () => {
    let collectCalls = 0;
    let seenEnv: WindowsDiscoveryEnvironment | undefined;
    const cache = createWindowsDiscoveryCache({
      platform: () => "win32",
      nowMs: () => 0,
      readEnv: () => ({ ProgramFiles: "C:\\Program Files" }),
      rootsForEnv: (env) => {
        seenEnv = env;
        return env.LOCALAPPDATA ? [`${env.LOCALAPPDATA}\\Discord`] : [];
      },
      collectFresh: () => { collectCalls += 1; return emptySnapshot(); },
    });

    cache.read({ forceRefresh: true });
    expect(collectCalls).toBe(1);
    expect(seenEnv).not.toHaveProperty("LOCALAPPDATA");
  });

  it("readAsync entrega o snapshot sem chamar a coleta sincrona e respeita o TTL", async () => {
    let nowMs = 0;
    let syncCalls = 0;
    let asyncCalls = 0;
    const cache = createWindowsDiscoveryCache({
      platform: () => "win32",
      nowMs: () => nowMs,
      readEnv: () => ({}),
      rootsForEnv: () => [],
      collectFresh: () => {
        syncCalls += 1;
        throw new Error("a variante sincrona nao pode rodar no caminho assincrono");
      },
      collectFreshAsync: async () => {
        asyncCalls += 1;
        return emptySnapshot(nowMs);
      },
    });

    await expect(cache.readAsync()).resolves.toMatchObject({ stale: false });
    expect(asyncCalls).toBe(1);
    expect(syncCalls).toBe(0);

    nowMs = 3_999;
    await cache.readAsync();
    expect(asyncCalls).toBe(1);

    nowMs = 4_000;
    await cache.readAsync();
    expect(asyncCalls).toBe(2);
    expect(syncCalls).toBe(0);
  });

  it("readAsync compartilha uma unica coleta entre chamadas concorrentes", async () => {
    let nowMs = 0;
    let calls = 0;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const cache = createWindowsDiscoveryCache({
      platform: () => "win32",
      nowMs: () => nowMs,
      readEnv: () => ({}),
      rootsForEnv: () => [],
      collectFresh: () => emptySnapshot(),
      collectFreshAsync: async () => {
        calls += 1;
        await pending;
        return emptySnapshot(nowMs);
      },
    });

    const first = cache.readAsync();
    const second = cache.readAsync();
    release();
    await expect(first).resolves.toMatchObject({ stale: false });
    await expect(second).resolves.toMatchObject({ stale: false });
    expect(calls).toBe(1);

    // Depois do settle, uma nova leitura fora do TTL volta a coletar.
    nowMs = 4_001;
    await cache.readAsync();
    expect(calls).toBe(2);
  });

  it("readAsync mantem o contrato antigo quando nao ha coletor assincrono injetado", async () => {
    let calls = 0;
    const cache = createWindowsDiscoveryCache({
      platform: () => "win32",
      nowMs: () => 0,
      readEnv: () => ({}),
      rootsForEnv: () => [],
      collectFresh: () => { calls += 1; return emptySnapshot(); },
    });

    await expect(cache.readAsync({ forceRefresh: true })).resolves.toMatchObject({ stale: false });
    expect(calls).toBe(1);
  });

  it("readAsync propaga falha sem stale e usa snapshot anterior dentro da janela stale", async () => {
    let nowMs = 0;
    let calls = 0;
    let fail = false;
    const cache = createWindowsDiscoveryCache({
      platform: () => "win32",
      nowMs: () => nowMs,
      readEnv: () => ({}),
      rootsForEnv: () => [],
      collectFresh: () => emptySnapshot(),
      collectFreshAsync: async () => {
        calls += 1;
        if (fail) throw new Error("fonte indisponivel");
        return emptySnapshot(nowMs);
      },
    });

    await cache.readAsync();
    expect(calls).toBe(1);

    fail = true;
    nowMs = 4_001;
    await expect(cache.readAsync({ allowStale: true })).resolves.toMatchObject({ stale: true });

    fail = false;
    nowMs = 8_000;
    await expect(cache.readAsync({ allowStale: true })).resolves.toMatchObject({ stale: false });
  });
});

describe("windowsSquirrelUpdaterPath", () => {
  it("acha o Update.exe na raiz da instalacao, acima de app-<versao> ou ao lado do iniciador", () => {
    const raiz = "C:\\Users\\x\\AppData\\Local\\Discord";
    expect(windowsSquirrelUpdaterPath(`${raiz}\\app-1.0.9265\\Discord.exe`)).toBe(`${raiz}\\Update.exe`);
    // Iniciador de primeiro nivel (Local\Discord\Discord.exe): o "avo" seria Local, e
    // Local\Update.exe nao e do Discord.
    expect(windowsSquirrelUpdaterPath(`${raiz}\\Discord.exe`)).toBe(`${raiz}\\Update.exe`);
    expect(windowsSquirrelUpdaterPath(`${raiz}\\APP-1.0.1\\Discord.exe`)).toBe(`${raiz}\\Update.exe`);
  });
});
