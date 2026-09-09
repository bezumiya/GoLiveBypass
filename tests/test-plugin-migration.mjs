import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../goLiveBypass/vpn-controller.ts", import.meta.url), "utf8");
const migration = source.slice(source.indexOf("private async migrateGuiState"), source.indexOf("\n    }\n}\n\nexport function defaultPluginVpnDataDir"));

test("migração pode tentar novamente mesmo com marcador existente", () => {
    assert.doesNotMatch(migration, /if \(fs\.existsSync\(markerPath\)\) return/);
    assert.match(migration, /if \(\!fs\.existsSync\(markerPath\) \|\| imported\.length > 0\)/);
});

test("migração valida e renomeia cada arquivo temporário atomicamente", () => {
    assert.match(migration, /fs\.copyFileSync\(source, temporary, fs\.constants\.COPYFILE_EXCL\)/);
    assert.match(migration, /windows\.validateWireGuardProfile\(raw\)/);
    assert.match(migration, /JSON\.parse\(raw\)/);
    assert.match(migration, /fs\.renameSync\(temporary, target\)/);
    assert.match(migration, /fs\.rmSync\(temporary, \{ force: true \}\)/);
});

test("migração não encerra GUI nem assume WireSock externo", () => {
    assert.doesNotMatch(migration, /taskkill|GoLiveBypass\.exe|process\.kill/);
    assert.match(source, /existing\.active && !existing\.owned/);
    assert.match(source, /this\.blockExternal/);
});

console.log("plugin migration source tests: 3/3");
