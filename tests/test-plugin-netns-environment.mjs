import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

test("helper aplica nome/valor separados sem privilégios nem namespace", () => {
    const root = mkdtempSync(join(tmpdir(), "golive-netns-environment-"));
    try {
        const source = fileURLToPath(new URL("../goLiveBypass/tools/netns-launcher.c", import.meta.url));
        const harness = `#define main launcher_main
#include ${JSON.stringify(source)}
#undef main
int main(void) {
    char *args[] = {"--env=DISPLAY=:0", "--env=XAUTHORITY=/tmp/test-cookie", "--env=TEST_VALUE=a=b", "--env=EMPTY="};
    if (!set_explicit_environment(4, args, 0, 4)) return 1;
    if (strcmp(getenv("DISPLAY"), ":0") || strcmp(getenv("XAUTHORITY"), "/tmp/test-cookie")) return 2;
    if (strcmp(getenv("TEST_VALUE"), "a=b") || strcmp(getenv("EMPTY"), "")) return 3;
    char *bad[] = {"--env=BAD-NAME=value"};
    if (set_explicit_environment(1, bad, 0, 1)) return 4;
    char *missing[] = {"--env=NO_VALUE"};
    if (set_explicit_environment(1, missing, 0, 1)) return 5;
    return 0;
}
`;
        writeFileSync(join(root, "test.c"), harness);
        execFileSync(process.env.CC || "cc", ["-Wall", "-Wextra", "-Werror", join(root, "test.c"), "-o", join(root, "test")]);
        execFileSync(join(root, "test"));
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test("relaunch preserva XAUTHORITY e mantém a filtragem do ambiente", () => {
    const source = readFileSync(new URL("../goLiveBypass/native.ts", import.meta.url), "utf8");
    const start = source.indexOf("const safeEnvKeys = [");
    const end = source.indexOf("const setenvArgs:", start);
    assert.ok(start >= 0 && end > start);
    const context = createContext({
        process: { env: { XAUTHORITY: "/run/user/1000/xauth", DISPLAY: ":0", SECRET: "excluded", LANG: "bad\nvalue" } },
        namespace: null,
    });
    runInContext(stripTypeScriptTypes(source.slice(start, end)) + "\nglobalThis.result = safeEnv;", context);
    assert.equal(context.result.XAUTHORITY, "/run/user/1000/xauth");
    assert.equal(context.result.DISPLAY, ":0");
    assert.equal(context.result.SECRET, undefined);
    assert.equal(context.result.LANG, undefined);
});

test("helper embutido é ELF x64 com SHA-256 válido", () => {
    const source = readFileSync(new URL("../goLiveBypass/vpn-proton.ts", import.meta.url), "utf8");
    const start = source.indexOf('"netns-launcher": {');
    const end = source.indexOf("\n    },", start);
    assert.ok(start >= 0 && end > start);
    const block = source.slice(start, end);
    const hash = block.match(/sha256: "([a-f0-9]{64})"/)[1];
    const array = block.split("gzipBase64: [")[1].split("].join")[0];
    const encoded = [...array.matchAll(/"([^"]+)"/g)].map(match => match[1]).join("");
    const binary = gunzipSync(Buffer.from(encoded, "base64"));
    assert.equal(createHash("sha256").update(binary).digest("hex"), hash);
    assert.equal(binary.subarray(0, 4).toString("hex"), "7f454c46");
    assert.equal(binary[4], 2); // ELF64
    assert.equal(binary[5], 1); // little-endian
    assert.equal(binary.readUInt16LE(18), 62); // x86-64
});
