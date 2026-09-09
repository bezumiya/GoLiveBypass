import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const protonSource = readFileSync(new URL("../goLiveBypass/vpn-proton.ts", import.meta.url), "utf8");
const helperFlags = readFileSync(new URL("../tools/proton-confgen/internal/config/flags.go", import.meta.url), "utf8");

assert.match(protonSource, /-stdin-secrets/);
assert.match(protonSource, /stdin, timeoutMs: 25_000/);
assert.doesNotMatch(protonSource, /args\.push\("-password"/);
assert.doesNotMatch(protonSource, /args\.push\("-2fa"/);
assert.doesNotMatch(protonSource, /args\.push\("-hv-token"/);
assert.match(protonSource, /-session-username/);
assert.match(protonSource, /execFileSync/);
assert.doesNotMatch(protonSource, /readFileSync\([^\n]*protonSessionFile/);
assert.match(helperFlags, /stdin-secrets/);
assert.match(helperFlags, /ReadStdinSecrets/);
assert.match(helperFlags, /session-username/);
assert.match(protonSource, /function sessionCheckFailure[\s\S]*temporar/);

console.log("plugin secret transport source tests: 10/10");
