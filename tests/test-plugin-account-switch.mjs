import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../goLiveBypass/vpn-controller.ts", import.meta.url), "utf8");
const login = source.slice(source.indexOf("public loginProton"), source.indexOf("public checkProtonSession"));
const customImport = source.slice(source.indexOf("public async importCustomConfig"), source.indexOf("public testConfig"));
const activation = source.slice(source.indexOf("private async startInternal"), source.indexOf("private async stopInternal"));

test("login Proton é serializado com ativação e otimização", () => {
    assert.match(login, /return this\.serial\(async \(\) =>/);
    assert.match(login, /proton\.loginProton\(/);
    assert.match(login, /this\.protonLogin/);
    assert.match(login, /operation\.controller\.signal/);
    assert.match(login, /solveCaptcha\(result\.captchaUrl, operation\.controller\.signal\)/);
    assert.match(source, /public cancelProtonLogin\(requestId\?: string\)/);
    assert.doesNotMatch(login, /stopInternal\(/);
});

test("troca de conta é recusada enquanto a VPN própria está ativa", () => {
    assert.match(login, /switchingAccount/);
    assert.match(login, /currentStatus\?\.active/);
    assert.match(login, /this\.state === "active"/);
    assert.match(login, /Restaure a rede antes de trocar a conta Proton/);
});

test("ativação Proton não reutiliza perfil de outra conta", () => {
    assert.match(source, /PROFILE_ACCOUNT_FILE/);
    assert.match(source, /protonProfileMatches/);
    assert.match(source, /writeProtonProfileAccount/);
    assert.match(source, /protonProfileSelection/);
    assert.match(activation, /const selection = this\.protonProfileSelection\(settings\)/);
    assert.match(activation, /!this\.protonProfileMatches\(settings\.protonUsername, selection\)/);
    assert.match(activation, /country: selection\.country/);
    assert.match(activation, /freeOnly: selection\.freeOnly/);
    assert.match(activation, /autoPing: selection\.autoPing/);
    assert.match(activation, /this\.writeProtonProfileAccount\(settings\.protonUsername, selection\)/);
    assert.match(source, /value\.country === selection\.country/);
    assert.match(source, /value\.freeOnly === selection\.freeOnly/);
    assert.match(source, /value\.autoPing === selection\.autoPing/);
});

test("importação customizada invalida o marcador Proton", () => {
    assert.match(customImport, /clearProtonProfileAccount/);
});

test("logout serializado recusa deixar a VPN ativa e limpa artefatos Proton", () => {
    const logout = source.slice(source.indexOf("public logoutProton"), source.indexOf("public async optimizeProton"));
    assert.match(logout, /return this\.serial\(async \(\) =>/);
    assert.match(logout, /if \(inspection\.active \|\| owner \|\| this\.state !== "inactive"\)/);
    assert.match(logout, /proton\.removeProtonSession/);
    assert.match(logout, /clearProtonArtifacts/);
    assert.match(source, /private clearProtonProfileAccount/);
    assert.match(source, /for \(const target of \[this\.profilePath, this\.serviceConfigPath, this\.profileAccountPath\]\)/);
});

test("a proteção de ownership externo continua explícita", () => {
    assert.match(source, /if \(inspection\.reliable && inspection\.active && !inspection\.owned\)/);
    assert.match(source, /this\.blockExternal/);
    assert.doesNotMatch(login, /taskkill|process\.kill/);
});

test("o status também expõe WireSock externo antes de uma tentativa de ativação", () => {
    const status = source.slice(source.indexOf("public getStatus"), source.indexOf("\n    public enable"));
    assert.match(status, /if \(inspection\.reliable && inspection\.active && !inspection\.owned\)/);
    assert.match(status, /if \(this\.state !== "blocked_external" \|\| this\.externalReason !== reason\) this\.blockExternal\(reason\)/);
});

test("comparação do perfil Proton usa o mesmo identificador canônico do helper", () => {
    assert.match(source, /function normalizeUsername\(value: string\): string \{\s*return normalizeProtonUsername\(value\)/);
    assert.match(source, /protonUsernamesMatch\(value\.username, username\)/);
});

console.log("plugin account switch tests: 8/8");
