import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    buildLinuxPrivilegedScript,
    failedPrivilegedStep,
    findSystemBinary,
    hostEnvironmentFromFlatpak,
    linuxCleanupCommands,
    relaunchEnvironment,
    parseFlatpakHostBinaryLookup,
    parseHostNetnsListing,
    readLinuxNetnsTable,
    resetFlatpakHostBinaryCache,
    resetFlatpakNetnsCache,
} from "../../goLiveBypass/vpn-linux";

const nativeSource = () => fs.readFileSync(path.resolve(process.cwd(), "../goLiveBypass/native.ts"), "utf8");
const linuxSource = () => fs.readFileSync(path.resolve(process.cwd(), "../goLiveBypass/vpn-linux.ts"), "utf8");

afterEach(() => {
    resetFlatpakHostBinaryCache();
    resetFlatpakNetnsCache();
});

describe("plugin Linux: ambiente do cliente relançado", () => {
    // NixOS: o wrapper do Vesktop exporta isto antes do Electron "unwrapped"; sem elas o
    // relaunch morria com SIGILL (coredump de usuário) e o mesmo binário abria com o ambiente.
    it("leva o ambiente que o lançador montou, inclusive o do wrapper do Nix", () => {
        const env = relaunchEnvironment({
            CHROME_DEVEL_SANDBOX: "/nix/store/x-electron/libexec/electron/chrome-sandbox",
            GIO_EXTRA_MODULES: "/nix/store/x-dconf/lib/gio/modules",
            GDK_PIXBUF_MODULE_FILE: "/nix/store/x/loaders.cache",
            LD_LIBRARY_PATH: "/nix/store/x-pipewire-jack/lib",
            NIXOS_OZONE_WL: "1",
            XAUTHORITY: "/run/user/1000/xauth",
            DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
            XDG_SESSION_TYPE: "wayland",
            PATH: "/run/current-system/sw/bin",
        });
        expect(env).toMatchObject({
            CHROME_DEVEL_SANDBOX: "/nix/store/x-electron/libexec/electron/chrome-sandbox",
            GIO_EXTRA_MODULES: "/nix/store/x-dconf/lib/gio/modules",
            GDK_PIXBUF_MODULE_FILE: "/nix/store/x/loaders.cache",
            LD_LIBRARY_PATH: "/nix/store/x-pipewire-jack/lib",
            NIXOS_OZONE_WL: "1",
            XAUTHORITY: "/run/user/1000/xauth",
            DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
            XDG_SESSION_TYPE: "wayland",
        });
    });

    it("deixa de fora segredos, marcas internas e valores inválidos", () => {
        const env = relaunchEnvironment({
            GITHUB_TOKEN: "ghp_x", NPM_TOKEN: "x", OPENAI_API_KEY: "sk", AWS_SECRET_ACCESS_KEY: "x",
            AWS_ACCESS_KEY_ID: "x", DB_PASSWORD: "x", GPG_PASSPHRASE: "x", SOME_CREDENTIALS: "x",
            SESSION_COOKIE: "x", SSH_AUTH_SOCK: "/run/ssh", SSH_PRIVATE_KEY: "x", HTTP_BEARER: "x",
            GOLIVE_PLUGIN_LINUX_NAMESPACE: "glb-velho", ELECTRON_RUN_AS_NODE: "1", _: "/usr/bin/env",
            LANG: "pt_BR\nX=1", "NOME-INVALIDO": "x", VAZIA: "", ENORME: "x".repeat(40 * 1024),
            DISPLAY: ":0",
        });
        expect(env).toEqual({ DISPLAY: ":0" });
    });
});

describe("plugin Linux: restaurar a rede pede uma autorização só", () => {
    it("toda a limpeza vai numa única sequência elevada", () => {
        const source = linuxSource();
        const stop = source.slice(source.indexOf("export async function stopLinuxNetwork("));
        expect(stop).toContain("const commands = linuxCleanupCommands({ namespace, interfaceName, ipPath, rmPath, shellPath });");
        expect(stop).toContain("await execPrivilegedSequence(commands, { timeoutMs, signal });");
        // Nenhum pkexec por comando sobrou no arquivo (eram cinco pedidos de senha).
        expect(source).not.toContain("async function execPrivileged(");
        const commands = linuxCleanupCommands({ namespace: "glb-x", interfaceName: "glbwgx", ipPath: "/usr/sbin/ip", rmPath: "/usr/bin/rm", shellPath: "/bin/sh" });
        expect(commands).toHaveLength(4);
        expect(linuxCleanupCommands({ namespace: null, interfaceName: null, ipPath: "/usr/sbin/ip", rmPath: "/usr/bin/rm", shellPath: "/bin/sh" })).toEqual([]);
    });

    // Executa /bin/sh do Linux com ip/rm falsos: mostra o que é tolerado e o que falha.
    it.skipIf(process.platform !== "linux")("tolera o que já sumiu e falha só se o namespace ficar", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "golive-cleanup-"));
        try {
            const log = path.join(root, "chamadas");
            const netnsDir = path.join(root, "netns");
            fs.mkdirSync(netnsDir);
            fs.writeFileSync(path.join(root, "ip"),
                `#!/bin/sh\nprintf 'ip %s\\n' "$*" >> '${log}'\necho "Cannot find device" >&2\nexit 1\n`, { mode: 0o755 });
            fs.writeFileSync(path.join(root, "rm"), `#!/bin/sh\nprintf 'rm %s\\n' "$*" >> '${log}'\n`, { mode: 0o755 });
            const run = () => spawnSync("/bin/sh", ["-c", buildLinuxPrivilegedScript(linuxCleanupCommands({
                namespace: "glb-x", interfaceName: "glbwgx", ipPath: path.join(root, "ip"), rmPath: path.join(root, "rm"), shellPath: "/bin/sh", netnsDir,
            }))], { encoding: "utf8" });

            const sumiu = run();
            expect(sumiu.status).toBe(0);
            expect(fs.readFileSync(log, "utf8").trim().split("\n")).toEqual([
                `rm -rf -- /etc/netns/glb-x`,
                "ip -n glb-x link del glbwgx",
                "ip link del glbwgx",
                "ip netns del glb-x",
            ]);

            // O namespace continua lá e o `ip netns del` falhou: a sequência falha no último passo.
            fs.writeFileSync(path.join(netnsDir, "glb-x"), "");
            const ficou = run();
            expect(ficou.status).not.toBe(0);
            expect(failedPrivilegedStep(ficou.stderr, 4)).toBe(3);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});

describe("plugin Linux no Flatpak: namespaces do host", () => {
    it("lê a listagem 'inode nome' do host e ignora lixo", () => {
        const entries = parseHostNetnsListing("4026532202 glb-abc123\n4026532300 discord-vpn\nlixo\n12 nome com espaço\n");
        expect([...entries]).toEqual([["glb-abc123", 4026532202], ["discord-vpn", 4026532300]]);
    });

    it("fora do Flatpak lê a pasta como antes (nomes e inode)", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "golive-netns-"));
        try {
            fs.writeFileSync(path.join(root, "glb-teste"), "");
            const table = readLinuxNetnsTable({ PATH: "" }, root);
            expect(table.reliable).toBe(true);
            expect([...table.entries.keys()]).toEqual(["glb-teste"]);
            expect(table.entries.get("glb-teste")).toBeGreaterThan(0);
            expect(readLinuxNetnsTable({ PATH: "" }, path.join(root, "nao-existe")).entries.size).toBe(0);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    // O /run/netns não existe no sandbox: a tabela vem do host pelo flatpak-spawn.
    it.skipIf(process.platform !== "linux")("no Flatpak pergunta ao host, guarda em cache e invalida", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "golive-netns-fp-"));
        try {
            const chamadas = path.join(root, "chamadas");
            fs.writeFileSync(path.join(root, "flatpak-spawn"),
                `#!/bin/sh\nprintf 'x\\n' >> '${chamadas}'\n[ "$1" = --host ] || exit 9\nprintf '4026532202 glb-fp\\n'\n`, { mode: 0o755 });
            const env = { FLATPAK_ID: "dev.vencord.Vesktop", PATH: root };
            const semPasta = path.join(root, "sem-run-netns");
            const table = readLinuxNetnsTable(env, semPasta);
            expect(table.reliable).toBe(true);
            expect(table.entries.get("glb-fp")).toBe(4026532202);
            readLinuxNetnsTable(env, semPasta);
            expect(fs.readFileSync(chamadas, "utf8").trim().split("\n")).toHaveLength(1);
            resetFlatpakNetnsCache();
            readLinuxNetnsTable(env, semPasta);
            expect(fs.readFileSync(chamadas, "utf8").trim().split("\n")).toHaveLength(2);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it.skipIf(process.platform !== "linux")("no Flatpak sem resposta do host mantém a leitura antiga (vazia)", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "golive-netns-fp-"));
        try {
            fs.writeFileSync(path.join(root, "flatpak-spawn"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
            const table = readLinuxNetnsTable({ FLATPAK_ID: "dev.vencord.Vesktop", PATH: root }, path.join(root, "sem"));
            expect(table).toEqual({ reliable: true, entries: new Map() });
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it("comandos root invalidam a tabela em cache (criam/apagam namespace)", () => {
        const source = linuxSource();
        expect(source).toContain("await runPrivilegedCommand(spec, options).finally(resetFlatpakNetnsCache)");
        // A inspeção e o isProcessInNamespace usam a mesma tabela.
        expect(source).toContain("const netnsTable = readLinuxNetnsTable();");
        expect(source).toContain("readLinuxNetnsTable(env).entries.get(targetNamespace)");
    });
});

describe("plugin Linux: DNS do namespace e relaunch (E2E no Vesktop)", () => {
    it("grava o resolv.conf do namespace legível pelo cliente (644)", () => {
        // Com 600 (root) o Discord relançado, que roda como usuário, não lia o próprio DNS e
        // todo nome falhava com ERR_NAME_NOT_RESOLVED embora a rota pelo túnel funcionasse.
        const source = linuxSource();
        expect(source).toContain('[installPath, ["-m", "644", tempResolvFile, path.join(netnsDir, "resolv.conf")]]');
        expect(source).not.toContain('"-m", "600", tempResolvFile');
    });

    it("sai do namespace pelo systemd-run mesmo depois de o namespace ter sido apagado", () => {
        // "Restaurar rede" apaga o namespace antes do relaunch; sem o sinal do ambiente o
        // cliente novo herdava o namespace morto (só lo, nenhuma rota).
        const source = nativeSource();
        expect(source).toContain("const launchedIntoNamespace = Boolean(process.env[GOLIVE_PLUGIN_LINUX_NAMESPACE]?.trim());");
        expect(source).toContain("if (!namespace && (currentlyInNamespace || launchedIntoNamespace)) {");
        // Relançar direto só quando já está NESTE namespace.
        expect(source).toContain("const directNativeLaunch = isProcessInNamespace(namespace) && !inFlatpak;");
    });

    it("não repassa ao flatpak do host o ambiente do sandbox", () => {
        expect(nativeSource()).toContain("const sourceEnv = inFlatpak ? hostEnvironmentFromFlatpak(process.env) : process.env;");
        const host = hostEnvironmentFromFlatpak({
            PATH: "/app/bin:/usr/bin",
            HOME: "/home/u",
            DISPLAY: ":0",
            XDG_RUNTIME_DIR: "/run/user/1000",
            XDG_DATA_HOME: "/home/u/.var/app/dev.vencord.Vesktop/data",
            XDG_CONFIG_HOME: "/home/u/.var/app/dev.vencord.Vesktop/config",
            XDG_CACHE_HOME: "/home/u/.var/app/dev.vencord.Vesktop/cache",
            XDG_STATE_HOME: "/home/u/.var/app/dev.vencord.Vesktop/.local/state",
            XDG_DATA_DIRS: "/app/share:/usr/share",
            XDG_CONFIG_DIRS: "/app/etc/xdg:/etc/xdg",
        });
        for (const key of ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_DATA_DIRS", "XDG_CONFIG_DIRS"]) {
            expect(host[key]).toBeUndefined();
        }
        expect(host.PATH).not.toContain("/app/bin");
        expect(host.PATH).toContain("/usr/sbin");
        expect(host).toMatchObject({ HOME: "/home/u", DISPLAY: ":0", XDG_RUNTIME_DIR: "/run/user/1000" });
    });

    it("troca os sockets do sandbox (/run/flatpak) pelos do host", () => {
        // Valores reais vistos dentro do Vesktop Flatpak no E2E.
        const host = hostEnvironmentFromFlatpak({
            XDG_RUNTIME_DIR: "/run/user/1000",
            DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/flatpak/bus",
            PULSE_SERVER: "unix:/run/flatpak/pulse/native",
            XAUTHORITY: "/run/flatpak/Xauthority",
            WAYLAND_DISPLAY: "wayland-0",
            LANG: "C.UTF-8",
        });
        expect(host.DBUS_SESSION_BUS_ADDRESS).toBe("unix:path=/run/user/1000/bus");
        expect(host.PULSE_SERVER).toBeUndefined();
        expect(host.XAUTHORITY).toBeUndefined();
        expect(host).toMatchObject({ WAYLAND_DISPLAY: "wayland-0", LANG: "C.UTF-8" });
        // Endereço do host (fora do sandbox) passa intacto.
        expect(hostEnvironmentFromFlatpak({ DBUS_SESSION_BUS_ADDRESS: "unix:abstract=/tmp/dbus-x" }).DBUS_SESSION_BUS_ADDRESS)
            .toBe("unix:abstract=/tmp/dbus-x");
        expect(hostEnvironmentFromFlatpak({ DBUS_SESSION_BUS_ADDRESS: "'unix:path=/run/flatpak/bus'" }).DBUS_SESSION_BUS_ADDRESS)
            .toBeUndefined();
    });
});

describe("plugin Linux no Flatpak: binários do host", () => {
    it("procura o pkexec no host (antes ficava sempre em dependency_missing)", () => {
        const env = { FLATPAK_ID: "dev.vencord.Vesktop", PATH: "" };
        const pkexec = findSystemBinary("pkexec", env);
        expect(pkexec).not.toBeNull();
        expect(pkexec!.endsWith("/pkexec")).toBe(true);
        // Fora do Flatpak continua sem inventar caminho.
        expect(findSystemBinary("binario-que-nao-existe-golive", { PATH: "" })).toBeNull();
    });

    it("aceita só um caminho absoluto na resposta do host", () => {
        expect(parseFlatpakHostBinaryLookup("/usr/sbin/modprobe\n")).toBe("/usr/sbin/modprobe");
        expect(parseFlatpakHostBinaryLookup("")).toBeNull();
        expect(parseFlatpakHostBinaryLookup("modprobe")).toBeNull();
        expect(parseFlatpakHostBinaryLookup("true\n")).toBeNull();
    });

    // Um binário da lista do host que NÃO exista nesta máquina: senão a busca local o acha antes
    // de chegar ao caminho do Flatpak e o teste não testaria nada.
    const ausente = ["konsole", "alacritty", "kitty", "foot"].find(name => findSystemBinary(name, { PATH: "" }) === null);

    // Executa /bin/sh do Linux: o flatpak-spawn falso responde onde o binário está no host.
    it.skipIf(process.platform !== "linux" || !ausente)("usa o caminho real do host (ex.: /usr/sbin) e guarda em cache", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "golive-flatpak-host-"));
        try {
            const chamadas = path.join(root, "chamadas");
            // argv: --host /bin/sh -c <script> sh <nome>
            fs.writeFileSync(path.join(root, "flatpak-spawn"),
                `#!/bin/sh\nprintf 'x\\n' >> '${chamadas}'\n[ "$1" = --host ] || exit 9\nprintf '/usr/sbin/%s\\n' "$6"\n`, { mode: 0o755 });
            const env = { FLATPAK_ID: "dev.vencord.Vesktop", PATH: root };
            expect(findSystemBinary(ausente!, env)).toBe(`/usr/sbin/${ausente}`);
            expect(findSystemBinary(ausente!, env)).toBe(`/usr/sbin/${ausente}`);
            expect(fs.readFileSync(chamadas, "utf8").trim().split("\n")).toHaveLength(1);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it.skipIf(process.platform !== "linux" || !ausente)("sem resposta do host cai no palpite antigo sem guardar", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "golive-flatpak-host-"));
        try {
            fs.writeFileSync(path.join(root, "flatpak-spawn"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
            const env = { FLATPAK_ID: "dev.vencord.Vesktop", PATH: root };
            expect(findSystemBinary(ausente!, env)).toBe(`/usr/bin/${ausente}`);
            fs.writeFileSync(path.join(root, "flatpak-spawn"), `#!/bin/sh\nprintf '/usr/sbin/%s\\n' "$6"\n`, { mode: 0o755 });
            expect(findSystemBinary(ausente!, env)).toBe(`/usr/sbin/${ausente}`);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});

describe("plugin Linux no Flatpak: cópia do launcher para o host", () => {
    const script = () => {
        const match = /const FLATPAK_LAUNCHER_WRITE_SCRIPT = '([^']+)';/.exec(nativeSource());
        expect(match).not.toBeNull();
        return match![1];
    };

    it("não lê mais o launcher por /dev/stdin", () => {
        const source = nativeSource();
        expect(source).not.toContain('"/dev/stdin"');
        expect(source).toContain('["--host", pkexec, "/bin/sh", "-c", FLATPAK_LAUNCHER_WRITE_SCRIPT, "sh", destination]');
        // native.ts exporta handlers IPC: a constante não pode virar export.
        expect(source).not.toContain("export const FLATPAK_LAUNCHER_WRITE_SCRIPT");
    });

    // O stdin do filho é um socket (libuv usa socketpair), como no flatpak-spawn real.
    async function gravarPorSocket(command: string, args: string[], payload: Buffer) {
        const child = spawn(command, args, { stdio: ["pipe", "ignore", "pipe"] });
        let stderr = "";
        child.stderr.on("data", chunk => { stderr += chunk; });
        child.stdin.end(payload);
        const code = await new Promise<number | null>(resolve => child.once("close", resolve));
        return { code, stderr };
    }

    it.skipIf(process.platform !== "linux")("grava o launcher a partir de stdin em socket, com modo 700", async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "golive-launcher-copy-"));
        try {
            const payload = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2, 3, 255]);
            const antigo = path.join(root, "antigo");
            const velho = await gravarPorSocket("install", ["-m", "700", "/dev/stdin", antigo], payload);
            // Prova de que o caminho antigo falhava neste mesmo cenário.
            expect(velho.code).not.toBe(0);

            const destino = path.join(root, "launcher");
            fs.writeFileSync(destino, "lixo anterior");
            const novo = await gravarPorSocket("/bin/sh", ["-c", script(), "sh", destino], payload);
            expect(novo).toEqual({ code: 0, stderr: "" });
            expect(fs.readFileSync(destino).equals(payload)).toBe(true);
            expect(fs.statSync(destino).mode & 0o777).toBe(0o700);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it.skipIf(process.platform !== "linux")("o script de cópia é POSIX (dash)", () => {
        const dash = spawnSync("dash", ["-n", "-c", script()]);
        if (dash.error) return; // sem dash na máquina
        expect(dash.status).toBe(0);
    });
});
