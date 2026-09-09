#!/usr/bin/env node

import assert from "node:assert/strict";
import {
    choosePluginRelease,
    comparePluginVersions,
    normalizePluginVersion,
} from "../goLiveBypass/update-channel.ts";

let passed = 0;

function test(name, fn) {
    fn();
    passed += 1;
    process.stdout.write(`ok ${passed} - ${name}\n`);
}

function release(version, prerelease = version.includes("-"), validUrls = true) {
    return {
        tag: `v${version}`,
        version,
        zipUrl: validUrls ? `https://example.test/${version}.zip` : "",
        shaUrl: validUrls ? `https://example.test/${version}.sha256` : "",
        prerelease,
    };
}

test("compara prereleases SemVer na ordem correta", () => {
    assert.equal(comparePluginVersions("2.0.0-alpha.1", "2.0.0-alpha.2"), -1);
    assert.equal(comparePluginVersions("2.0.0-alpha.2", "2.0.0-alpha.10"), -1);
    assert.equal(comparePluginVersions("2.0.0-alpha.1", "2.0.0-alpha-1"), -1);
    assert.equal(comparePluginVersions("2.0.0-rc.1", "2.0.0-rc-1"), -1);
    assert.equal(comparePluginVersions("2.0.0-beta.1", "2.0.0"), -1);
    assert.equal(comparePluginVersions("2.0.0", "2.0.0-beta.9"), 1);
});

test("ignora build metadata e normaliza o prefixo v", () => {
    assert.equal(comparePluginVersions("v2.0.0+build.1", "2.0.0+build.2"), 0);
    assert.equal(normalizePluginVersion("v2.0.0-beta.1+ci.9"), "2.0.0-beta-1");
    assert.equal(normalizePluginVersion("2.0.0-alpha.1"), "2.0.0-alpha.1");
    assert.equal(normalizePluginVersion("2.0.0.1"), null);
});

test("canal stable ignora prereleases e escolhe a maior versão estável", () => {
    const selected = choosePluginRelease([
        release("2.1.0-beta.2"),
        release("2.0.1"),
        release("2.2.0-beta.1"),
        release("2.1.0"),
    ], "2.0.0", "stable");
    assert.equal(selected?.version, "2.1.0");
});

test("canal beta aceita prerelease e escolhe a maior versão", () => {
    const selected = choosePluginRelease([
        release("2.1.0-beta.1"),
        release("2.1.0"),
        release("2.2.0-alpha.1"),
    ], "2.0.0-beta.2", "beta");
    assert.equal(selected?.version, "2.2.0-alpha.1");
});

test("não faz downgrade ao trocar ou permanecer no canal beta", () => {
    assert.equal(choosePluginRelease([release("2.0.0-beta.1"), release("1.9.9")], "2.0.0", "beta"), null);
    assert.equal(choosePluginRelease([release("2.0.0-beta.9")], "2.0.0-beta.10", "beta"), null);
});

test("stable pode avançar de beta para a release estável correspondente", () => {
    const selected = choosePluginRelease([release("2.0.0"), release("2.0.0-beta.9")], "2.0.0-beta.1", "stable");
    assert.equal(selected?.version, "2.0.0");
});

test("descarta candidatos sem os dois artefatos", () => {
    const selected = choosePluginRelease([
        release("2.3.0", false, false),
        release("2.2.0"),
    ], "2.0.0", "stable");
    assert.equal(selected?.version, "2.2.0");
});

process.stdout.write(`1..${passed}\n`);
