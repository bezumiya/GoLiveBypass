/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const TRUSTED_UPDATE_HOSTS = new Set([
  "api.github.com",
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "github-releases.githubusercontent.com",
]);
const OFFICIAL_UPDATE_REPOSITORY = "bezumiya/GoLiveBypass";
// These releases were published with the former fork in updater.id. Accept
// only the exact known versions so those installed copies can migrate to the
// canonical repository without trusting arbitrary fork builds.
const LEGACY_RELEASE_MANIFEST = {
  versions: {
    "2.0.5": true,
    "2.0.6-beta-7": true,
    "2.0.6-beta-9": true,
  } as Record<string, true>,
  repository: "pdl-clay/GoLiveBypass",
} as const;
const OFFICIAL_API_RELEASE_PATH = "/repos/bezumiya/GoLiveBypass/releases";
const OFFICIAL_RELEASE_PATH_PREFIX = "/bezumiya/GoLiveBypass/releases/download/";
const MAX_PATH_DECODING_PASSES = 8;

function normalizedHostname(value: string): string {
  return value.toLowerCase().replace(/\.$/, "");
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function rawPathPart(rawUrl: string): string {
  const value = rawUrl.trim();
  const schemeEnd = value.indexOf("://");
  const pathStart = schemeEnd >= 0
    ? value.indexOf("/", schemeEnd + 3)
    : value.startsWith("//") ? value.indexOf("/", 2) : 0;
  if (pathStart < 0) return "";
  const path = value.slice(pathStart);
  const queryOrFragment = path.search(/[?#]/);
  return queryOrFragment < 0 ? path : path.slice(0, queryOrFragment);
}

function hasUnsafePathSyntax(path: string): boolean {
  return path.includes("\\")
    || /[\u0000-\u001f\u007f]/.test(path)
    || /%(?:2e|2f|5c)/i.test(path)
    || path.split(/[\\/]/).some(segment => segment === "." || segment === "..");
}

function containsPathTraversal(rawUrl: string, parsed: URL): boolean {
  // WHATWG URL treats backslashes in an authority as forward slashes. Inspect
  // the raw input too, otherwise an ambiguous URL can be silently rewritten
  // into a different authority/path before the allowlist is evaluated.
  if (rawUrl.includes("\\")) return true;
  if (hasUnsafePathSyntax(rawPathPart(rawUrl))) return true;

  let decodedPath = parsed.pathname;
  for (let pass = 0; pass < MAX_PATH_DECODING_PASSES; pass += 1) {
    if (hasUnsafePathSyntax(decodedPath)) return true;
    let nextPath: string;
    try {
      nextPath = decodeURIComponent(decodedPath);
    } catch {
      return true;
    }
    if (nextPath === decodedPath) return false;
    decodedPath = nextPath;
  }

  // Reject paths that remain encoded after the bounded normalization. This
  // avoids relying on how a downstream CDN decodes deeply nested escapes.
  return true;
}

function hasOfficialUpdatePath(parsed: URL, hostname: string): boolean {
  if (hostname === "api.github.com") return parsed.pathname === OFFICIAL_API_RELEASE_PATH;
  if (hostname === "github.com") return parsed.pathname.startsWith(OFFICIAL_RELEASE_PATH_PREFIX);
  return TRUSTED_UPDATE_HOSTS.has(hostname);
}

export function securePluginUpdateUrl(rawUrl: string, baseUrl?: string): string {
  const parsed = new URL(rawUrl, baseUrl);
  if (parsed.protocol !== "https:") throw new Error("update recusou URL que não usa HTTPS");
  if (parsed.username || parsed.password || parsed.port) {
    throw new Error("update recusou URL com credenciais ou porta explícita");
  }
  const hostname = normalizedHostname(parsed.hostname);
  if (!TRUSTED_UPDATE_HOSTS.has(hostname)) {
    throw new Error("update recusou host fora do GitHub e seus CDNs oficiais");
  }
  if (containsPathTraversal(rawUrl, parsed)) throw new Error("update recusou caminho com traversal");
  if (!hasOfficialUpdatePath(parsed, hostname)) throw new Error("update recusou caminho fora da origem oficial");
  return parsed.toString();
}

export function isOfficialPluginManifest(value: unknown, assetName: string): boolean {
  if (!isJsonRecord(value) || typeof assetName !== "string" || !assetName) return false;
  const manifest = value;
  if (!hasOwn(manifest, "name") || !hasOwn(manifest, "updater")) return false;
  const { updater } = manifest;
  if (!isJsonRecord(updater)) return false;
  const metadata = updater;
  return hasOwn(metadata, "type")
    && hasOwn(metadata, "id")
    && hasOwn(metadata, "assetName")
    && manifest.name === "GoLiveBypass"
    && metadata.type === "github"
    && metadata.id === OFFICIAL_UPDATE_REPOSITORY
    && metadata.assetName === assetName;
}

export function isCompatiblePluginManifest(value: unknown, assetName: string): boolean {
  if (isOfficialPluginManifest(value, assetName)) return true;
  if (!isJsonRecord(value)
    || !hasOwn(value, "name")
    || !hasOwn(value, "version")
    || !hasOwn(value, "updater")
    || value.name !== "GoLiveBypass"
    || typeof value.version !== "string"
    || LEGACY_RELEASE_MANIFEST.versions[value.version] !== true) return false;
  const { updater } = value;
  if (!isJsonRecord(updater)
    || !hasOwn(updater, "type")
    || !hasOwn(updater, "id")
    || !hasOwn(updater, "assetName")) return false;
  return updater.type === "github"
    && updater.id === LEGACY_RELEASE_MANIFEST.repository
    && updater.assetName === assetName;
}

export function releaseAssetUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = new URL(value);
    if (normalizedHostname(parsed.hostname) !== "github.com") return null;
    if (!parsed.pathname.startsWith(OFFICIAL_RELEASE_PATH_PREFIX)) return null;
    if (containsPathTraversal(value, parsed)) return null;
    return securePluginUpdateUrl(parsed.toString());
  } catch {
    return null;
  }
}
