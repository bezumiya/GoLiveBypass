import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import https from "node:https";

const RUNTIME_REPO = "bezumiya/GoLiveBypass";
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 3;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const HASH_RE = /^[a-f0-9]{64}$/i;

export type ProtonRuntimePlatform = "win32" | "linux" | string;

export type ProtonRuntimeContext = {
  resourcesPath?: string;
  appPath?: string;
  execPath?: string;
  cwd?: string;
  moduleDir?: string;
  platform?: ProtonRuntimePlatform;
  arch?: string;
};

export type ProtonRuntimeManifestEntry = {
  asset: string;
  sha256: string;
};

export type ProtonRuntimeManifest = {
  version: string;
  assets: {
    "win32-x64": ProtonRuntimeManifestEntry;
    "linux-x64": ProtonRuntimeManifestEntry;
  };
};

export type EnsureProtonConfgenOptions = {
  context: ProtonRuntimeContext;
  installDir: string;
  version: string;
};

export type StageValidatedProtonConfgenOptions = {
  sourcePath: string;
  installDir: string;
  version: string;
  expectedSha256?: string;
  assetName?: string;
};

function pushUnique(values: string[], value: string | undefined): void {
  if (!value) return;
  const normalized = path.normalize(value);
  if (!values.includes(normalized)) values.push(normalized);
}

function helperName(platform: ProtonRuntimePlatform): string {
  return platform === "win32" ? "proton-confgen.exe" : "proton-confgen";
}

function runtimeKey(context: ProtonRuntimeContext): "win32-x64" | "linux-x64" | null {
  if (context.platform === "win32" && context.arch === "x64") return "win32-x64";
  if (context.platform === "linux" && context.arch === "x64") return "linux-x64";
  return null;
}

function validatedVersion(version: string): string {
  if (!VERSION_RE.test(version)) throw new Error("Versão do runtime Proton inválida.");
  return version;
}

function validatedAssetName(asset: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(asset) || asset.includes("..")) {
    throw new Error("Nome do asset Proton inválido.");
  }
  return asset;
}

function validatedHash(hash: string): string {
  if (!HASH_RE.test(hash)) throw new Error("SHA-256 do runtime Proton inválido.");
  return hash.toLowerCase();
}

export function protonConfgenCandidates(context: ProtonRuntimeContext): string[] {
  const exe = helperName(context.platform ?? process.platform);
  const candidates: string[] = [];
  const resources = context.resourcesPath;
  const executableDir = context.execPath ? path.dirname(context.execPath) : undefined;

  for (const directory of [
    resources && path.join(resources, "extra", "proton-confgen"),
    resources && path.join(resources, "extra"),
    executableDir && path.join(executableDir, "extra", "proton-confgen"),
    executableDir && path.join(executableDir, "extra"),
    context.appPath && path.join(context.appPath, "..", "tools", "proton-confgen", "build"),
    context.cwd && path.resolve(context.cwd, "..", "tools", "proton-confgen", "build"),
    context.moduleDir && path.resolve(context.moduleDir, "..", "..", "tools", "proton-confgen", "build"),
    context.cwd && path.resolve(context.cwd, "tools", "proton-confgen", "build"),
  ]) {
    if (!directory) continue;
    pushUnique(candidates, path.join(directory, exe));
  }

  if (context.execPath) {
    pushUnique(candidates, path.join(path.dirname(context.execPath), exe));
  }
  return candidates;
}

export function protonRuntimeManifestCandidates(context: ProtonRuntimeContext): string[] {
  const candidates: string[] = [];
  const resources = context.resourcesPath;
  const executableDir = context.execPath ? path.dirname(context.execPath) : undefined;
  for (const directory of [
    resources && path.join(resources, "extra", "proton-confgen"),
    resources && path.join(resources, "extra"),
    executableDir && path.join(executableDir, "extra", "proton-confgen"),
    executableDir && path.join(executableDir, "extra"),
    context.appPath && path.join(context.appPath, "..", "tools", "proton-confgen", "build"),
    context.cwd && path.resolve(context.cwd, "..", "tools", "proton-confgen", "build"),
    context.moduleDir && path.resolve(context.moduleDir, "..", "..", "tools", "proton-confgen", "build"),
    context.cwd && path.resolve(context.cwd, "tools", "proton-confgen", "build"),
  ]) {
    if (!directory) continue;
    pushUnique(candidates, path.join(directory, "proton-confgen-manifest.json"));
  }
  return candidates;
}

export function findProtonConfgenPath(context: ProtonRuntimeContext): string | undefined {
  return protonConfgenCandidates(context).find((candidate) => {
    try { return fs.statSync(candidate).isFile() && fs.statSync(candidate).size > 0; } catch { return false; }
  });
}

export function readProtonRuntimeManifest(paths: readonly string[]): ProtonRuntimeManifest | undefined {
  for (const manifestPath of paths) {
    try {
      const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Partial<ProtonRuntimeManifest>;
      const normalized = normalizeProtonRuntimeManifest(parsed);
      if (normalized) return normalized;
    } catch {
      // O próximo layout pode conter o manifesto válido; não vazar conteúdo do arquivo para a UI.
    }
  }
  return undefined;
}

function normalizeProtonRuntimeManifest(value: unknown): ProtonRuntimeManifest | undefined {
  if (!value || typeof value !== "object") return undefined;
  const parsed = value as Partial<ProtonRuntimeManifest>;
  const win = parsed.assets?.["win32-x64"];
  const linux = parsed.assets?.["linux-x64"];
  if (!parsed.version || !VERSION_RE.test(parsed.version) || !win || !linux) return undefined;
  const entries = [win, linux];
  if (entries.some((entry) => typeof entry.asset !== "string" || typeof entry.sha256 !== "string" ||
    !HASH_RE.test(entry.sha256) || !/^[A-Za-z0-9._-]+$/.test(entry.asset) || entry.asset.includes(".."))) return undefined;
  return {
    version: parsed.version,
    assets: {
      "win32-x64": { asset: win.asset, sha256: win.sha256.toLowerCase() },
      "linux-x64": { asset: linux.asset, sha256: linux.sha256.toLowerCase() },
    },
  };
}

export function protonRuntimeAssetUrl(version: string, asset: string): string {
  const safeVersion = validatedVersion(version);
  const safeAsset = validatedAssetName(asset);
  return `https://github.com/${RUNTIME_REPO}/releases/download/v${safeVersion}/${safeAsset}`;
}

export async function sha256File(filePath: string): Promise<string> {
  const digest = crypto.createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const input = fs.createReadStream(filePath);
    input.on("data", (chunk: Buffer) => digest.update(chunk));
    input.on("error", reject);
    input.on("end", resolve);
  });
  return digest.digest("hex");
}

function allowedDownloadHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "github.com" || host === "objects.githubusercontent.com" ||
    host === "release-assets.githubusercontent.com" || host.endsWith(".githubusercontent.com");
}

async function downloadVerified(url: string, target: string, expectedSha256: string, redirects = 0): Promise<void> {
  if (redirects > MAX_REDIRECTS) throw new Error("Muitos redirecionamentos no reparo do runtime Proton.");
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || !allowedDownloadHost(parsed.hostname)) {
    throw new Error("O download do runtime Proton foi redirecionado para um host não autorizado.");
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let output: fs.WriteStream | undefined;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      output?.destroy();
      reject(error);
    };
    const request = https.get(parsed, {
      headers: { "User-Agent": "GoLiveBypass-ProtonRuntime", Accept: "application/octet-stream" },
    }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        void downloadVerified(new URL(response.headers.location, parsed).toString(), target, expectedSha256, redirects + 1)
          .then(() => { if (!settled) { settled = true; resolve(); } }, fail);
        return;
      }
      if (status !== 200) {
        response.resume();
        fail(new Error(`Download do runtime Proton retornou HTTP ${status || "desconhecido"}.`));
        return;
      }

      const digest = crypto.createHash("sha256");
      let total = 0;
      output = fs.createWriteStream(target, { flags: "wx" });
      response.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_DOWNLOAD_BYTES) fail(new Error("O runtime Proton excede o limite de tamanho permitido."));
        else digest.update(chunk);
      });
      response.on("error", fail);
      output.on("error", fail);
      response.pipe(output);
      output.on("finish", () => output?.close((error) => {
        if (error) { fail(error); return; }
        if (settled) return;
        const actual = digest.digest("hex");
        if (actual !== expectedSha256) {
          fail(new Error("SHA-256 do runtime Proton não corresponde ao manifesto."));
          return;
        }
        settled = true;
        resolve();
      }));
    });
    request.setTimeout(120_000, () => request.destroy(new Error("Tempo limite ao baixar o runtime Proton.")));
    request.on("error", fail);
  });
}

async function fetchReleaseManifest(versionOrUrl: string, redirects = 0): Promise<ProtonRuntimeManifest | undefined> {
  if (redirects > MAX_REDIRECTS) return undefined;
  const url = /^https:\/\//i.test(versionOrUrl)
    ? versionOrUrl
    : protonRuntimeAssetUrl(versionOrUrl, "proton-confgen-manifest.json");
  const parsed = new URL(url);
  return new Promise((resolve) => {
    if (parsed.protocol !== "https:" || !allowedDownloadHost(parsed.hostname)) { resolve(undefined); return; }
    const request = https.get(parsed, {
      headers: { "User-Agent": "GoLiveBypass-ProtonRuntime", Accept: "application/json" },
    }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        void fetchReleaseManifest(new URL(response.headers.location, parsed).toString(), redirects + 1).then(resolve);
        return;
      }
      if (status !== 200) { response.resume(); resolve(undefined); return; }
      let body = "";
      let tooLarge = false;
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
        if (body.length > MAX_MANIFEST_BYTES) tooLarge = true;
      });
      response.on("error", () => resolve(undefined));
      response.on("end", () => {
        if (tooLarge) { resolve(undefined); return; }
        try { resolve(normalizeProtonRuntimeManifest(JSON.parse(body))); } catch { resolve(undefined); }
      });
    });
    request.setTimeout(15_000, () => request.destroy());
    request.on("error", () => resolve(undefined));
  });
}

export async function stageValidatedProtonConfgen(options: StageValidatedProtonConfgenOptions): Promise<string> {
  const version = validatedVersion(options.version);
  const expected = options.expectedSha256 ? validatedHash(options.expectedSha256) : undefined;
  const asset = validatedAssetName(options.assetName || path.basename(options.sourcePath));
  let sourceStat: fs.Stats;
  try { sourceStat = await fs.promises.stat(options.sourcePath); } catch { throw new Error("O executável Proton não foi encontrado."); }
  if (!sourceStat.isFile() || sourceStat.size <= 0) throw new Error("O executável Proton está vazio ou inválido.");
  if (expected && (await sha256File(options.sourcePath)) !== expected) {
    throw new Error("SHA-256 do runtime Proton não corresponde ao manifesto.");
  }

  const targetDir = path.join(options.installDir, "runtime", version);
  await fs.promises.mkdir(targetDir, { recursive: true });
  const target = path.join(targetDir, asset);
  if (fs.existsSync(target) && (!expected || (await sha256File(target)) === expected)) {
    if (process.platform !== "win32") await fs.promises.chmod(target, 0o700).catch(() => {});
    return target;
  }

  const temp = path.join(targetDir, `.${asset}.${crypto.randomUUID()}.tmp`);
  try {
    await fs.promises.copyFile(options.sourcePath, temp, fs.constants.COPYFILE_EXCL);
    if (expected && (await sha256File(temp)) !== expected) throw new Error("SHA-256 do runtime Proton não corresponde ao manifesto.");
    if (process.platform !== "win32") await fs.promises.chmod(temp, 0o700);
    await fs.promises.rm(target, { force: true });
    await fs.promises.rename(temp, target);
    return target;
  } finally {
    await fs.promises.rm(temp, { force: true }).catch(() => {});
  }
}

async function ensureProtonConfgenOnce(options: EnsureProtonConfgenOptions): Promise<string> {
  const version = validatedVersion(options.version);
  const key = runtimeKey(options.context);
  if (!key) throw new Error(`Arquitetura ${options.context.platform ?? process.platform}/${options.context.arch ?? process.arch} não suportada pelo runtime Proton.`);
  const localManifest = readProtonRuntimeManifest(protonRuntimeManifestCandidates(options.context));
  // A release asset is the repair path for installations where an antivirus,
  // an incomplete extraction or a bad portable copy removed extraResources.
  // It is only trusted after the strict schema validation above.
  const manifest = localManifest || await fetchReleaseManifest(version);
  const entry = manifest?.assets[key];
  if (manifest && manifest.version !== version) {
    throw new Error("O manifesto do runtime Proton pertence a outra versão da GUI.");
  }

  const local = findProtonConfgenPath(options.context);
  if (local && (!entry || (await sha256File(local)) === entry.sha256)) {
    return stageValidatedProtonConfgen({
      sourcePath: local,
      installDir: options.installDir,
      version,
      expectedSha256: entry?.sha256,
      assetName: entry?.asset || path.basename(local),
    });
  }

  if (!entry) {
    throw new Error("O componente Proton não foi encontrado nesta instalação e não há um asset de reparo para esta versão.");
  }
  const asset = validatedAssetName(entry.asset);
  const targetDir = path.join(options.installDir, "runtime", version);
  await fs.promises.mkdir(targetDir, { recursive: true });
  const target = path.join(targetDir, asset);
  if (!fs.existsSync(target) || (await sha256File(target)) !== entry.sha256) {
    const temp = path.join(targetDir, `.${asset}.${crypto.randomUUID()}.download`);
    try {
      await downloadVerified(protonRuntimeAssetUrl(version, asset), temp, entry.sha256);
      if (options.context.platform !== "win32") await fs.promises.chmod(temp, 0o700);
      await fs.promises.rm(target, { force: true });
      await fs.promises.rename(temp, target);
    } finally {
      await fs.promises.rm(temp, { force: true }).catch(() => {});
    }
  }
  return target;
}

const inFlight = new Map<string, Promise<string>>();

export function ensureProtonConfgen(options: EnsureProtonConfgenOptions): Promise<string> {
  const key = `${options.installDir}\0${options.version}\0${options.context.platform}\0${options.context.arch}`;
  const running = inFlight.get(key);
  if (running) return running;
  const operation = ensureProtonConfgenOnce(options).finally(() => { inFlight.delete(key); });
  inFlight.set(key, operation);
  return operation;
}
