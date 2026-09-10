/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

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
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const NUMERIC_IDENTIFIER = /^\d+$/;
const VALID_NUMERIC_VERSION_PART = /^(?:0|[1-9]\d*)$/;
const LEGACY_PRERELEASE_LABEL = /^[0-9A-Za-z]+$/;
const LEGACY_PRERELEASE_IDENTIFIER = /^([0-9A-Za-z]+)-([0-9]+)$/;

function legacyPrereleaseIdentifiers(prerelease: readonly string[]): string[] {
  if (
    prerelease.length === 2 &&
    prerelease[0] === "beta" &&
    LEGACY_PRERELEASE_LABEL.test(prerelease[0]) &&
    NUMERIC_IDENTIFIER.test(prerelease[1]) &&
    VALID_NUMERIC_VERSION_PART.test(prerelease[1])
  ) {
    return [prerelease[0], prerelease[1]];
  }

  if (prerelease.length === 1) {
    const match = LEGACY_PRERELEASE_IDENTIFIER.exec(prerelease[0]);
    if (match && match[1] === "beta" && VALID_NUMERIC_VERSION_PART.test(match[2])) {
      return [match[1], match[2]];
    }
  }

  return [...prerelease];
}

function normalizePrerelease(prerelease: readonly string[]): string {
  if (
    prerelease.length === 2 &&
    prerelease[0] === "beta" &&
    LEGACY_PRERELEASE_LABEL.test(prerelease[0]) &&
    NUMERIC_IDENTIFIER.test(prerelease[1]) &&
    VALID_NUMERIC_VERSION_PART.test(prerelease[1])
  ) {
    // beta.1 and beta-1 are legacy spellings used by the plugin releases.
    // Keep this narrow: arbitrary hyphens and additional dot identifiers must
    // remain distinguishable under SemVer.
    return `${prerelease[0]}-${prerelease[1]}`;
  }

  return prerelease.join(".");
}

function parsePluginVersion(value: unknown): ParsedPluginVersion | null {
  if (typeof value !== "string") return null;

  const match = VERSION_PATTERN.exec(value);
  if (!match || !VALID_NUMERIC_VERSION_PART.test(match[1]) || !VALID_NUMERIC_VERSION_PART.test(match[2]) || !VALID_NUMERIC_VERSION_PART.test(match[3])) {
    return null;
  }

  const prerelease = match[4]?.split(".") ?? [];
  if (prerelease.some(identifier => NUMERIC_IDENTIFIER.test(identifier) && !VALID_NUMERIC_VERSION_PART.test(identifier))) {
    return null;
  }

  const normalizedCore = `${match[1]}.${match[2]}.${match[3]}`;
  return {
    major: BigInt(match[1]),
    minor: BigInt(match[2]),
    patch: BigInt(match[3]),
    prerelease,
    normalized: prerelease.length > 0 ? `${normalizedCore}-${normalizePrerelease(prerelease)}` : normalizedCore,
  };
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

  const leftPrerelease = legacyPrereleaseIdentifiers(left.prerelease);
  const rightPrerelease = legacyPrereleaseIdentifiers(right.prerelease);

  if (leftPrerelease.length === 0 || rightPrerelease.length === 0) {
    if (leftPrerelease.length === rightPrerelease.length) return 0;
    return leftPrerelease.length === 0 ? 1 : -1;
  }

  const identifierCount = Math.max(leftPrerelease.length, rightPrerelease.length);
  for (let index = 0; index < identifierCount; index += 1) {
    const leftIdentifier = leftPrerelease[index];
    const rightIdentifier = rightPrerelease[index];
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
