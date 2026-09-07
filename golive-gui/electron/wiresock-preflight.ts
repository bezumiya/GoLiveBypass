import fs from "fs";
import path from "path";
import { execFile } from "child_process";

export const MIN_WIRESOCK_SDK = Object.freeze({ major: 3, minor: 4, patch: 8, build: 1 });
export type WireSockVersion = { major: number; minor: number; patch: number; build: number };
export type WireSockCandidate = { executable: string; booster: string; executableVersion: WireSockVersion; boosterVersion: WireSockVersion };

export function parseWireSockVersion(raw: string): WireSockVersion | null {
  const m = raw.trim().match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), build: Number(m[4]) };
}

export function compareWireSockVersion(left: WireSockVersion, right: WireSockVersion): number {
  for (const key of ["major", "minor", "patch", "build"] as const) {
    if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1;
  }
  return 0;
}

export function isSupportedWireSockVersion(version: WireSockVersion): boolean {
  return compareWireSockVersion(version, MIN_WIRESOCK_SDK) >= 0;
}

export function selectSupportedWireSock(candidates: WireSockCandidate[]): WireSockCandidate {
  const valid = candidates.filter((candidate) =>
    isSupportedWireSockVersion(candidate.executableVersion) &&
    isSupportedWireSockVersion(candidate.boosterVersion),
  ).filter((candidate) => compareWireSockVersion(candidate.executableVersion, candidate.boosterVersion) === 0
  ).sort((a, b) => compareWireSockVersion(b.executableVersion, a.executableVersion));
  if (!valid[0]) throw new Error("Nenhuma instalação WireSock SDK compatível foi encontrada (mínimo 3.4.8.1 com wiresock-client.exe e wgbooster.dll).");
  return valid[0];
}

/**
 * Enumerates the bounded set of known package roots and reads all PE versions
 * in one PowerShell child.  Activation is asynchronous and therefore does not
 * block Electron once the candidate paths have been found.
 */
export async function enumerateWireSockCandidatesAsync(roots: string[]): Promise<WireSockCandidate[]> {
  if (process.platform !== "win32") return [];
  const pairs: Array<{ executable: string; booster: string }> = [];
  const seen = new Set<string>();
  const addPair = (executable: string, booster: string) => {
    if (fs.existsSync(executable) && fs.existsSync(booster) && !seen.has(executable.toLowerCase())) {
      seen.add(executable.toLowerCase()); pairs.push({ executable, booster });
    }
  };
  for (const root of [...new Set(roots)]) {
    for (const dir of [root, path.join(root, "sdk")]) {
      addPair(path.join(dir, "wiresock-client.exe"), path.join(dir, "wgbooster.dll"));
    }
    if (/[/\\]Packages$/i.test(root)) {
      let packages: fs.Dirent[] = [];
      try { packages = await fs.promises.readdir(root, { withFileTypes: true }); } catch {}
      for (const packageDir of packages) {
        if (!packageDir.isDirectory() || !/wiresock|ntkernel\.wiresock/i.test(packageDir.name)) continue;
        const packageRoot = path.join(root, packageDir.name);
        for (const layout of [packageRoot, path.join(packageRoot, "x64"), path.join(packageRoot, "x86"), path.join(packageRoot, "arm64")]) {
          addPair(path.join(layout, "wiresock-client.exe"), path.join(layout, "wgbooster.dll"));
          addPair(path.join(layout, "sdk", "wiresock-client.exe"), path.join(layout, "sdk", "wgbooster.dll"));
        }
      }
    }
  }
  if (!pairs.length) return [];
  const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
  const exes = pairs.map((pair) => quote(pair.executable)).join(",");
  const boosters = pairs.map((pair) => quote(pair.booster)).join(",");
  const script = `$e=@(${exes});$b=@(${boosters});$o=@();for($i=0;$i -lt $e.Count;$i++){ $ev=(Get-Item -LiteralPath $e[$i]).VersionInfo.FileVersion; $bv=(Get-Item -LiteralPath $b[$i]).VersionInfo.FileVersion; $o += [PSCustomObject]@{e=$e[$i];b=$b[$i];ev=$ev;bv=$bv} }; ConvertTo-Json -Compress $o`;
  const output = await new Promise<string>((resolve, reject) => execFile(
    "powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", windowsHide: true, timeout: 5000 },
    (error, stdout) => error ? reject(error) : resolve(stdout),
  ));
  const raw = JSON.parse(output) as Array<{ e?: string; b?: string; ev?: string; bv?: string }> | { e?: string; b?: string; ev?: string; bv?: string };
  const rows = Array.isArray(raw) ? raw : [raw];
  return rows.flatMap((row) => {
    const executableVersion = parseWireSockVersion(row.ev ?? "");
    const boosterVersion = parseWireSockVersion(row.bv ?? "");
    if (!row.e || !row.b || !executableVersion || !boosterVersion) return [];
    return [{ executable: row.e, booster: row.b, executableVersion, boosterVersion }];
  });
}
