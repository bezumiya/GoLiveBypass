import { describe, expect, it } from "vitest";

import {
  choosePluginRelease,
  comparePluginVersions,
  normalizePluginVersion,
  type PluginReleaseCandidate,
} from "../../goLiveBypass/update-channel";

describe("canal de atualização do plugin", () => {
  it("normaliza versões v-prefixed e beta com ponto ou hífen", () => {
    expect(normalizePluginVersion("v2.0.0-beta.1")).toBe("2.0.0-beta-1");
    expect(normalizePluginVersion("2.0.0-beta-1")).toBe("2.0.0-beta-1");
    expect(normalizePluginVersion("2.0")).toBeNull();
  });

  it("ordena stable acima de beta do mesmo triplo", () => {
    expect(comparePluginVersions("2.0.0-beta.9", "2.0.0")).toBeLessThan(0);
  });

  it("trata beta.1 e beta-1 como a mesma prerelease", () => {
    expect(comparePluginVersions("v2.0.0-beta.1", "2.0.0-beta-1")).toBe(0);
    expect(comparePluginVersions("2.0.0-beta-10", "2.0.0-beta-9")).toBeGreaterThan(0);
  });

  it("filtra stable e escolhe a maior candidata no beta", () => {
    const releases: PluginReleaseCandidate[] = [
      { tag: "v2.0.1-beta-2", version: "2.0.1-beta-2", zipUrl: "zip-beta", shaUrl: "sha-beta", prerelease: true },
      { tag: "v2.0.0", version: "2.0.0", zipUrl: "zip-stable", shaUrl: "sha-stable", prerelease: false },
      { tag: "v2.0.1", version: "2.0.1", zipUrl: "zip-new", shaUrl: "sha-new", prerelease: false },
    ];

    expect(choosePluginRelease(releases, "2.0.0-beta.1", "stable")?.version).toBe("2.0.1");
    expect(choosePluginRelease(releases, "2.0.0-beta.1", "beta")?.version).toBe("2.0.1");
  });

  it("não oferece downgrade nem candidata sem asset ou checksum", () => {
    const releases: PluginReleaseCandidate[] = [
      { tag: "v2.1.0", version: "2.1.0", zipUrl: "", shaUrl: "sha", prerelease: false },
      { tag: "v2.1.1", version: "2.1.1", zipUrl: "zip", shaUrl: "", prerelease: false },
      { tag: "v1.9.9", version: "1.9.9", zipUrl: "zip", shaUrl: "sha", prerelease: false },
    ];

    expect(choosePluginRelease(releases, "2.0.0", "beta")).toBeNull();
  });

  it("não oferece prerelease no canal stable", () => {
    const releases: PluginReleaseCandidate[] = [
      { tag: "v2.1.0-beta-1", version: "2.1.0-beta-1", zipUrl: "zip-beta", shaUrl: "sha-beta", prerelease: true },
    ];

    expect(choosePluginRelease(releases, "2.0.0", "stable")).toBeNull();
    expect(choosePluginRelease(releases, "2.0.0", "beta")?.version).toBe("2.1.0-beta-1");
  });
});
