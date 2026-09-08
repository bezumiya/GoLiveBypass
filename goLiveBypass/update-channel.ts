export type PluginUpdateChannel = "stable" | "beta";

export interface PluginReleaseCandidate {
  tag: string;
  version: string;
  zipUrl: string;
  shaUrl: string;
  prerelease: boolean;
}

interface ParsedPluginVersion {
  major: bigint;
  minor: bigint;
  patch: bigint;
  prerelease: string[];
  normalized: string;
}

const VERSION_PATTERN =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:[.-][0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const NUMERIC_IDENTIFIER = /^\d+$/;
const VALID_NUMERIC_VERSION_PART = /^(?:0|[1-9]\d*)$/;

function parsePluginVersion(value: string): ParsedPluginVersion | null {
  const match = VERSION_PATTERN.exec(value.trim());
  if (!match || !VALID_NUMERIC_VERSION_PART.test(match[1]) || !VALID_NUMERIC_VERSION_PART.test(match[2]) || !VALID_NUMERIC_VERSION_PART.test(match[3])) {
    return null;
  }

  const prerelease = match[4]?.split(/[.-]/) ?? [];
  if (prerelease.length === 0 || prerelease.every((identifier) => identifier.length > 0)) {
    if (prerelease.some((identifier) => NUMERIC_IDENTIFIER.test(identifier) && !VALID_NUMERIC_VERSION_PART.test(identifier))) {
      return null;
    }

    const normalizedCore = `${match[1]}.${match[2]}.${match[3]}`;
    return {
      major: BigInt(match[1]),
      minor: BigInt(match[2]),
      patch: BigInt(match[3]),
      prerelease,
      normalized: prerelease.length > 0 ? `${normalizedCore}-${prerelease.join("-")}` : normalizedCore,
    };
  }

  return null;
}

export function normalizePluginVersion(value: string): string | null {
  return parsePluginVersion(value)?.normalized ?? null;
}

function comparePrereleaseIdentifiers(left: string, right: string): number {
  const leftNumeric = NUMERIC_IDENTIFIER.test(left);
  const rightNumeric = NUMERIC_IDENTIFIER.test(right);

  if (leftNumeric && rightNumeric) {
    const leftNumber = BigInt(left);
    const rightNumber = BigInt(right);
    return leftNumber < rightNumber ? -1 : leftNumber > rightNumber ? 1 : 0;
  }

  if (leftNumeric !== rightNumeric) {
    return leftNumeric ? -1 : 1;
  }

  return left < right ? -1 : left > right ? 1 : 0;
}

function compareParsedPluginVersions(left: ParsedPluginVersion, right: ParsedPluginVersion): number {
  for (const [leftPart, rightPart] of [
    [left.major, right.major],
    [left.minor, right.minor],
    [left.patch, right.patch],
  ] as const) {
    if (leftPart !== rightPart) {
      return leftPart < rightPart ? -1 : 1;
    }
  }

  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length === 0 ? 1 : -1;
  }

  const identifierCount = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < identifierCount; index += 1) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];
    if (leftIdentifier === undefined || rightIdentifier === undefined) {
      return leftIdentifier === undefined ? -1 : 1;
    }

    const comparison = comparePrereleaseIdentifiers(leftIdentifier, rightIdentifier);
    if (comparison !== 0) return comparison;
  }

  return 0;
}

export function comparePluginVersions(a: string, b: string): number {
  const left = parsePluginVersion(a);
  const right = parsePluginVersion(b);
  if (!left || !right) return 0;
  return compareParsedPluginVersions(left, right);
}

export function choosePluginRelease(
  releases: readonly PluginReleaseCandidate[],
  current: string,
  channel: PluginUpdateChannel,
): PluginReleaseCandidate | null {
  const currentVersion = parsePluginVersion(current);
  if (!currentVersion) return null;

  let selected: { release: PluginReleaseCandidate; version: ParsedPluginVersion } | null = null;

  for (const release of releases) {
    if (!release || typeof release.version !== "string" || !release.zipUrl?.trim() || !release.shaUrl?.trim()) {
      continue;
    }

    const version = parsePluginVersion(release.version);
    if (!version) continue;

    const isPrerelease = release.prerelease || version.prerelease.length > 0;
    if (channel === "stable" && isPrerelease) continue;
    if (compareParsedPluginVersions(version, currentVersion) <= 0) continue;
    if (selected && compareParsedPluginVersions(version, selected.version) <= 0) continue;

    selected = { release, version };
  }

  if (!selected) return null;
  return { ...selected.release, version: selected.version.normalized };
}
