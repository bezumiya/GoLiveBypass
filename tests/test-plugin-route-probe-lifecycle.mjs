import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../goLiveBypass/vpn-controller.ts", import.meta.url), "utf8");
const startInternal = source.slice(source.indexOf("    private async startInternal"), source.indexOf("    private async stopInternal"));
const stopInternal = source.slice(source.indexOf("    private async stopInternal"), source.indexOf("    private async restartInternal"));
const removeProbe = source.slice(source.indexOf("    private async removeProbe"), source.indexOf("    private startDiagnostics"));
const ownerRelease = source.slice(source.indexOf("    private async releaseOwnership"), source.indexOf("    private writeProfileAtomically"));

test("probe criado fica registrado imediatamente", () => {
    assert.match(source, /this\.probePath = target;/);
});

test("cleanup aguarda diagnósticos e varre somente a raiz do plugin", () => {
    assert.match(removeProbe, /private async removeProbe/);
    assert.match(removeProbe, /await this\.waitForRouteProbes\(\)/);
    assert.match(removeProbe, /windows\.cleanupRouteProbes\(this\.dataDir/);
    assert.match(source, /windows\.isManagedRouteProbePath\(this\.dataDir/);
});

test("erro de ativação e parada limpam antes de liberar ownership", () => {
    // O slice de startInternal terminava em stopInternal, mas englobava TAMBEM o
    // startLinuxInternal (que vem antes), entao lastIndexOf("        } catch (error)") achava
    // o catch da versao Linux e o teste olhava a funcao errada. Isola no catch do caminho
    // Windows, que e' o que este teste afirma cobrir.
    const janelaWindows = startInternal.slice(0, startInternal.indexOf("private async startLinuxInternal"));
    const failureBlock = janelaWindows.slice(janelaWindows.lastIndexOf("        } catch (error)"));
    assert.match(failureBlock, /await this\.removeProbe\(/);
    assert.ok(failureBlock.indexOf("await this.removeProbe(") < failureBlock.indexOf("this.releaseOwnership(owner)"));
    assert.match(stopInternal, /await this\.removeProbe\(/);
});

test("liberação tardia não remove lock de outra geração", () => {
    assert.match(ownerRelease, /if \(!sameOwnership\(current, owner\)\) return false;/);
    assert.match(source, /a\.pid === b\.pid/);
    assert.match(source, /a\.generation === b\.generation/);
    assert.match(source, /a\.createdAt === b\.createdAt/);
});

test("cleanup não atravessa o ownership de uma instância sucessora", () => {
    assert.match(source, /private ownershipToken: OwnershipToken \| null/);
    assert.match(removeProbe, /sameOwnership\(localToken, current\)/);
    assert.match(removeProbe, /const canSweep = options\.sweep &&/);
    assert.match(removeProbe, /if \(canSweep\)/);
});

console.log("plugin route-probe lifecycle tests: 5/5");
