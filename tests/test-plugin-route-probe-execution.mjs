import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../goLiveBypass/vpn-windows.ts", import.meta.url), "utf8");
const execution = source.slice(source.indexOf("export function runRouteProbe"), source.indexOf("export function isWireSockPacketFilterDriverInstalled"));

test("probe só é executado depois de validar arquivo regular e caminho gerenciado", () => {
    assert.match(execution, /fs\.lstatSync\(executable\)/);
    assert.match(execution, /!stat\.isFile\(\)/);
    assert.match(execution, /stat\.isSymbolicLink\(\)/);
    assert.match(execution, /isManagedRouteProbePath\(path\.dirname\(executable\), executable\)/);
    assert.match(execution, /return Promise\.resolve\(null\)/);
});

console.log("plugin route-probe execution tests: 1/1");
