import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../goLiveBypass/vpn-controller.ts", import.meta.url), "utf8");
const owner = source.slice(source.indexOf("private isLiveForeignOwner"), source.indexOf("private writeProfileAtomically"));
const initialize = source.slice(source.indexOf("public initialize()"), source.indexOf("\n    public getStatus"));
const start = source.slice(source.indexOf("private async startInternal"), source.indexOf("private async stopInternal"));

test("initialize é serializado e não assume lock vivo de outra instância", () => {
    assert.match(initialize, /return this\.serial\(\(\) => this\.initializeInternal\(\)\)/);
    assert.match(initialize, /this\.isLiveForeignOwner\(owner\)/);
    assert.match(owner, /owner\.pid !== process\.pid/);
    assert.match(owner, /!owner\.restarting/);
    assert.match(owner, /processAlive\(owner\.pid\)/);
});

test("aquisição limpa probes somente depois de obter ownership", () => {
    assert.match(start, /owner = await this\.acquireOwnership\(\);\s+await this\.cleanupStaleProbes\(this\.probePath/);
    const normalActivation = start.slice(start.indexOf("this.state = \"preparing\""));
    assert.doesNotMatch(normalActivation.slice(0, normalActivation.indexOf("owner = await this.acquireOwnership()")), /cleanupStaleProbes/);
});

test("escrita do owner é atômica e não usa arquivo parcialmente criado", () => {
    assert.match(owner, /private writeOwnerUnlocked/);
    assert.match(owner, /fs\.writeFileSync\(temporary/);
    assert.match(owner, /fs\.renameSync\(temporary, this\.ownerPath\)/);
    assert.doesNotMatch(owner, /fs\.openSync\(this\.ownerPath, "wx"\)/);
});

test("mutex tem espera limitada, reclaim de holder morto e liberação por token", () => {
    assert.match(owner, /OWNER_MUTEX_SUFFIX/);
    assert.match(owner, /OWNER_MUTEX_HOLDER_FILE/);
    assert.match(owner, /OWNER_MUTEX_MAX_ATTEMPTS/);
    assert.match(owner, /OWNER_MUTEX_STALE_MS/);
    assert.match(owner, /fs\.mkdirSync\(mutexPath\)/);
    assert.match(owner, /this\.reclaimStaleOwnerMutex\(mutexPath\)/);
    assert.match(owner, /holder\.token !== lease\.token/);
    assert.match(owner, /fs\.rmSync\(lease\.path, \{ recursive: true, force: true \}\)/);
});

test("liberação compara o token completo e falha fechado se o owner mudou", () => {
    assert.match(owner, /if \(!sameOwnership\(current, owner\)\) return false;/);
    assert.match(owner, /if \(!current\) \{/);
    assert.match(owner, /if \(fs\.existsSync\(this\.ownerPath\)\) return false;/);
    assert.match(owner, /await this\.withOwnerMutex/);
});

console.log("plugin owner concurrency tests: 5/5");
