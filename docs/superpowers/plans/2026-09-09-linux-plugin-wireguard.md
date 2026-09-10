# Plugin Linux WireGuard + instalador — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (\`- [ ]\`) syntax for tracking.

**Goal:** Portar o transporte VPN do GoLiveBypass para Linux x86_64 e fazer o instalador installer/golivebypass-installer.sh preparar automaticamente o ambiente necessário.

**Architecture:** O plugin usará um backend vpn-linux.ts e um helper POSIX interno para criar um namespace de rede WireGuard, relançar o Discord dentro dele e remover somente recursos próprios. O instalador oficial fará o preflight de pacotes, Node/pnpm, kernel e binários antes de compilar/injetar Equicord ou Vencord; GUI, standalone e estado Windows continuarão separados.

**Tech Stack:** TypeScript/Vencord userplugin, Node/Electron, POSIX sh, iproute2, wireguard-tools, pkexec/sudo, Go para proton-confgen, testes Node, shell e go test.

**Spec:** docs/superpowers/specs/2026-09-09-linux-plugin-wireguard-design.md

## Global Constraints

- Suporte funcional desta etapa: Linux x86_64 com Discord desktop nativo compilado por Equicord ou Vencord.
- O plugin não compartilha namespace, lock, perfil ou processo com GUI Electron ou standalone.
- Windows x64 continua usando WireSock e não pode perder seus testes/regressões atuais.
- A rota default do host nunca será alterada; a rota default do Discord ficará no namespace WireGuard.
- Falhas de IP, HTTP, gateway ou handshake depois de um túnel confirmado são diagnóstico log-only.
- Nenhuma chave, senha, token ou sessão Proton pode aparecer em argv, logs, mensagens ou artefatos de teste.
- O --uninstall não remove pacotes compartilhados do sistema.
- Toda alteração termina com o teste específico da tarefa e git diff --check.

---

### Task 1: Contratos de plataforma e testes de comportamento puro

**Files:**
- Modify: goLiveBypass/vpn-types.ts:12-190
- Create: tests/test-plugin-linux-contract.mjs
- Modify: tests/test-plugin-controller-recovery.mjs

**Interfaces:**
- Produces VpnPlatform = "windows" | "linux" | "unsupported".
- Produces vpnPlatformForRuntime(platform: string, arch: string): VpnPlatform and isSupportedVpnPlatform(platform: string, arch: string): boolean.
- Extends VpnOwnerRecord with optional platform, namespaceName, interfaceName, discordExecutable, discordUser and discordPid, mantendo leitura de owners Windows antigos.
- Preserves validateWireGuardConfig, safeDiagnosticDetail, mutex and generation contracts existentes.

- [ ] **Step 1: Escrever os testes de plataforma antes da implementação**

~~~js
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../goLiveBypass/vpn-types.ts", import.meta.url), "utf8");

test("Linux x64 e Windows x64 são plataformas suportadas", () => {
  assert.match(source, /isSupportedVpnPlatform/);
  assert.match(source, /vpnPlatformForRuntime/);
  assert.match(source, /platform === "linux"/);
  assert.match(source, /platform === "win32"/);
  assert.match(source, /arch !== "x64"/);
});

test("a plataforma não suportada continua fechando sem efeito", () => {
  assert.match(source, /VpnPlatform = "windows" \| "linux" \| "unsupported"/);
});
~~~

- [ ] **Step 2: Rodar o teste para confirmar a falha inicial**

Run: node --test tests/test-plugin-linux-contract.mjs
Expected: FAIL porque o contrato Linux ainda não existe.

- [ ] **Step 3: Implementar o contrato mínimo**

~~~ts
export type VpnPlatform = "windows" | "linux" | "unsupported";

export function vpnPlatformForRuntime(platform: string, arch: string): VpnPlatform {
    if (arch !== "x64") return "unsupported";
    if (platform === "win32") return "windows";
    if (platform === "linux") return "linux";
    return "unsupported";
}

export function isSupportedVpnPlatform(platform: string, arch: string): boolean {
    return vpnPlatformForRuntime(platform, arch) !== "unsupported";
}
~~~

Manter isSupportedWindowsArchitecture como wrapper compatível para os testes e consumidores Windows existentes. Acrescentar os campos opcionais ao owner sem tornar inválidos os arquivos antigos.

- [ ] **Step 4: Rodar contratos e regressão de controller**

Run: node --test tests/test-plugin-linux-contract.mjs tests/test-plugin-controller-recovery.mjs
Expected: todos os testes passam.

- [ ] **Step 5: Commitar**

~~~sh
git add goLiveBypass/vpn-types.ts tests/test-plugin-linux-contract.mjs tests/test-plugin-controller-recovery.mjs
git commit -m "feat(plugin): adicionar contrato de plataforma Linux"
~~~

### Task 2: Helper POSIX isolado para namespace e WireGuard

**Files:**
- Create: goLiveBypass/linux-helper.sh
- Create: tests/test-plugin-linux-helper.sh
- Modify: tests/test-posix.sh

**Interfaces:**
- Consumes: linux-helper.sh <action> --data-dir <dir> [--config <file>] [--descriptor <file>].
- Actions: preflight, status, start, launch, stop, cleanup.
- Produces JSON sem segredos em preflight/status; código zero somente quando a operação solicitada foi confirmada.
- Constants: namespace golivebypass-plugin, interface golivewg0, arquivo de runtime dentro de dataDir e resolução em /etc/netns/golivebypass-plugin/resolv.conf.

- [ ] **Step 1: Escrever o teste de sintaxe e contrato do helper**

~~~sh
#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
sh -n "$ROOT/goLiveBypass/linux-helper.sh"
grep -F 'golivebypass-plugin' "$ROOT/goLiveBypass/linux-helper.sh" >/dev/null
grep -F 'golivewg0' "$ROOT/goLiveBypass/linux-helper.sh" >/dev/null
grep -F 'case "$action"' "$ROOT/goLiveBypass/linux-helper.sh" >/dev/null
printf '%s\n' 'linux helper contract: ok'
~~~

- [ ] **Step 2: Rodar o teste para confirmar a falha inicial**

Run: sh tests/test-plugin-linux-helper.sh
Expected: FAIL porque o helper ainda não existe.

- [ ] **Step 3: Implementar preflight e validação de caminhos**

O helper deve aceitar somente ações conhecidas, exigir dataDir absoluto e pertencente ao usuário que iniciou o Discord, rejeitar config fora de dataDir e gravar estado com modo 0600. preflight verificará ip, wg, ip netns, kernel WireGuard e o provedor de elevação sem criar recursos.

- [ ] **Step 4: Implementar start sem alterar a rota do host**

~~~sh
ip netns add "$NETNS_NAME"
ip link add dev "$WG_IF" type wireguard
wg setconf "$WG_IF" "$SANITIZED_CONFIG"
ip link set "$WG_IF" netns "$NETNS_NAME"
ip -n "$NETNS_NAME" addr add "$ADDRESS" dev "$WG_IF"
ip -n "$NETNS_NAME" link set lo up
ip -n "$NETNS_NAME" link set "$WG_IF" up
ip -n "$NETNS_NAME" route add default dev "$WG_IF"
~~~

Remover Address/DNS somente da entrada passada ao wg setconf; aplicar os endereços do perfil separadamente; manter a resolução específica do namespace; confirmar interface, rota e wg show antes de responder sucesso. Se qualquer comando falhar, remover somente o namespace recém-criado.

- [ ] **Step 5: Implementar status, launch, stop e cleanup com ownership**

status comparará namespace/interface/processo com o marcador do plugin. launch lerá um descritor 0600 de executável, argumentos e ambiente gráfico allowlisted, validará o executável atual e iniciará o usuário dentro do namespace com setsid/runuser/setpriv. stop encerrará apenas o PID cujo /proc/<pid>/ns/net corresponde ao namespace e cujo executável corresponde ao descritor; cleanup só removerá namespace e /etc/netns quando o marcador for próprio.

- [ ] **Step 6: Testar com comandos falsos e validar POSIX**

Run: sh tests/test-plugin-linux-helper.sh && bash tests/test-plugin-linux-helper.sh && dash tests/test-plugin-linux-helper.sh
Expected: sintaxe e casos de ação inválida, caminho fora da raiz, rollback e ownership externo passam em todos os shells disponíveis.

- [ ] **Step 7: Commitar**

~~~sh
git add goLiveBypass/linux-helper.sh tests/test-plugin-linux-helper.sh tests/test-posix.sh
git commit -m "feat(plugin): adicionar helper Linux de namespace WireGuard"
~~~

### Task 3: Backend TypeScript vpn-linux.ts

**Files:**
- Create: goLiveBypass/vpn-linux.ts
- Create: tests/test-plugin-linux.mjs
- Modify: goLiveBypass/vpn-types.ts

**Interfaces:**
- inspectLinuxVpn(dataDir: string): LinuxVpnInspection.
- startLinuxVpn(dataDir: string, configPath: string, logger: LinuxLogger): Promise<LinuxVpnStartResult>.
- launchDiscordInLinuxVpn(options: LinuxLaunchOptions): Promise<{ pid: number }>.
- stopOwnedLinuxVpn(dataDir: string, owner: VpnOwnerRecord | null, logger: LinuxLogger): Promise<LinuxCleanupResult>.
- diagnoseLinuxVpn(dataDir: string, logger: LinuxLogger): Promise<LinuxDiagnostic>.
- LinuxVpnInspection inclui active, owned, reliable, namespaceName, interfaceName, processIds, discordPid, handshakeAgoS, rxBytes, txBytes e reason.

- [ ] **Step 1: Escrever testes com runner de comandos substituível**

~~~js
test("Linux não assume namespace externo", () => {
  assert.match(source, /reliable/);
  assert.match(source, /owned/);
  assert.match(source, /golivebypass-plugin/);
});

test("diagnóstico não vaza PrivateKey ou token", () => {
  assert.match(source, /safeDiagnosticDetail/);
  assert.match(source, /log-only|diagnostic/);
});
~~~

- [ ] **Step 2: Rodar teste para confirmar falha**

Run: node --test tests/test-plugin-linux.mjs
Expected: FAIL porque vpn-linux.ts não existe.

- [ ] **Step 3: Implementar runner e inspeção**

Usar execFile com argumentos separados, timeout finito e GOLIVE_PLUGIN_LINUX_HELPER somente como override de teste. Converter o JSON do helper em estado tipado; erro de leitura incompleta deve resultar em reliable:false, nunca em ausência confirmada.

- [ ] **Step 4: Implementar start/launch/stop**

Copiar/validar o perfil em dataDir, chamar o helper nas ações correspondentes, aguardar confirmação de estado e propagar erros sanitizados. A função de launch deve construir o descritor 0600 com process.execPath, argumentos seguros e variáveis gráficas allowlisted: HOME, DISPLAY, WAYLAND_DISPLAY, XDG_RUNTIME_DIR, DBus, áudio e PipeWire.

- [ ] **Step 5: Implementar diagnóstico log-only**

Ler handshake e RX/TX pelo helper, registrar wireguard, route ou network e nunca alterar estado por uma falha de probe depois de active confirmado.

- [ ] **Step 6: Rodar backend e regressões**

Run: node --test tests/test-plugin-linux.mjs tests/test-plugin-proton-edge.mjs tests/test-plugin-secret-transport.mjs
Expected: todos passam sem tocar no namespace real.

- [ ] **Step 7: Commitar**

~~~sh
git add goLiveBypass/vpn-linux.ts goLiveBypass/vpn-types.ts tests/test-plugin-linux.mjs
git commit -m "feat(plugin): implementar backend Linux WireGuard"
~~~

### Task 4: Integrar plataforma Linux no controller e no relaunch

**Files:**
- Modify: goLiveBypass/vpn-controller.ts:1-1390
- Modify: tests/test-plugin-controller-recovery.mjs
- Create: tests/test-plugin-linux-lifecycle.mjs

**Interfaces:**
- vpn-controller.ts seleciona windows para win32/x64, linux para linux/x64 e unsupported nos demais casos.
- Owners Linux persistem platform:"linux", namespace/interface, discordExecutable, discordUser, discordPid e geração.
- getStatus, initialize, enable, restoreNetwork, shutdown e restartDiscord preservam as assinaturas públicas atuais.

- [ ] **Step 1: Escrever testes de seleção e ciclo**

~~~js
test("controller não chama WireSock no caminho Linux", () => {
  assert.match(source, /process\.platform === "linux"/);
  assert.match(source, /vpnLinux|linux/);
  assert.doesNotMatch(linuxStartBlock, /startWireSockService/);
});

test("restore Linux exige ownership antes de cleanup", () => {
  assert.match(linuxStopBlock, /owned/);
  assert.match(linuxStopBlock, /recovery_required|blocked_external/);
});
~~~

- [ ] **Step 2: Implementar caminhos Linux mantendo Windows intacto**

Separar inspeção/start/stop/diagnóstico por backend em funções privadas do controller. hasCleanupWork e initialize não devem chamar APIs Windows em Linux. O caminho unsupported continua falhando fechado com mensagem específica.

- [ ] **Step 3: Implementar relaunch Linux**

Antes de app.exit(0), gravar owner restarting:true, chamar launchDiscordInLinuxVpn, aguardar o PID e só então sair. No boot seguinte, adotar apenas namespace/processo cujo owner e geração sejam compatíveis. Se launch falhar, limpar o namespace e reabrir o Discord fora dele somente após confirmar cleanup.

- [ ] **Step 4: Implementar restauração serializada**

Cancelar login/otimização como hoje, invalidar diagnósticos atrasados, parar apenas o processo próprio, remover namespace próprio, liberar owner e relançar fora do namespace quando solicitado. Uma leitura desconhecida não deve virar inactive nem autorizar remoção.

- [ ] **Step 5: Rodar lifecycle e todas as regressões do plugin**

Run: node --test tests/test-plugin-controller-recovery.mjs tests/test-plugin-linux-lifecycle.mjs tests/test-plugin-lifecycle.mjs tests/test-plugin-owner-concurrency.mjs tests/test-plugin-account-switch.mjs
Expected: todos passam; os testes Windows continuam exercitando WireSock.

- [ ] **Step 6: Commitar**

~~~sh
git add goLiveBypass/vpn-controller.ts tests/test-plugin-controller-recovery.mjs tests/test-plugin-linux-lifecycle.mjs
git commit -m "feat(plugin): integrar ciclo Linux no controller"
~~~

### Task 5: Proton, native bridge, UI e pacote do plugin

**Files:**
- Modify: goLiveBypass/vpn-proton.ts:150-200
- Modify: goLiveBypass/native.ts:55-75,250-460,1180-1210
- Modify: goLiveBypass/index.tsx:500-560,1350-1420,1940-1990
- Modify: goLiveBypass/manifest.json
- Modify: tests/test-plugin-update-audit.mjs
- Modify: tests/test-userplugin-e2e.sh

**Interfaces:**
- findProtonConfgenExe procura bin/linux-x64/proton-confgen no Linux e conserva bin/win32-x64/proton-confgen.exe no Windows.
- REQUIRED_PLUGIN_FILES é selecionado por plataforma: fontes comuns + linux-helper.sh + binário nativo correspondente.
- Status Linux é exibido como namespace WireGuard; erro de preflight é acionável e não afirma que a VPN está ativa.

- [ ] **Step 1: Adicionar testes de asset Linux**

~~~sh
grep -F 'vpn-linux.ts' tests/test-userplugin-e2e.sh >/dev/null
grep -F 'linux-helper.sh' tests/test-userplugin-e2e.sh >/dev/null
grep -F 'bin/linux-x64/proton-confgen' tests/test-userplugin-e2e.sh >/dev/null
~~~

- [ ] **Step 2: Implementar localização do helper e validação por arquitetura**

Adicionar os caminhos Linux, verificar executável POSIX sem symlink inseguro e não exigir o .exe no Linux. Atualizar a lista de arquivos permitidos no updater para o helper e os dois binários, sem aceitar arquivos fora de goLiveBypass/.

- [ ] **Step 3: Atualizar native/UI**

Expor o mesmo controller ao renderer, adaptar mensagens “Windows x64 necessário” para “Linux x64: prepare o ambiente pelo instalador” e mostrar estado active somente após confirmação do processo no namespace. Não executar gerenciador de pacotes silenciosamente a partir do plugin.

- [ ] **Step 4: Rodar testes de pacote e atualização**

Run: node --test tests/test-plugin-update-audit.mjs tests/test-plugin-update-channel.mjs tests/test-plugin-lifecycle.mjs && sh tests/test-userplugin-e2e.sh
Expected: arquivos Linux são incluídos e o asset continua compatível com rollback/hash.

- [ ] **Step 5: Commitar**

~~~sh
git add goLiveBypass/vpn-proton.ts goLiveBypass/native.ts goLiveBypass/index.tsx goLiveBypass/manifest.json tests/test-plugin-update-audit.mjs tests/test-userplugin-e2e.sh
git commit -m "feat(plugin): empacotar runtime Linux e exibir status"
~~~

### Task 6: Tornar o instalador .sh o bootstrap automático Linux

**Files:**
- Modify: installer/golivebypass-installer.sh:20-65,1197-1365,1430-1470,2414-2460
- Modify: tests/test-auto-update.sh
- Modify: tests/test-distribution-parity.cjs
- Modify: tests/test-standalone-status-warning.sh
- Create: tests/test-installer-linux-runtime.sh

**Interfaces:**
- ensure_linux_runtime() instala/verifica build e runtime antes de select_target/copy_plugin.
- package_manager() mantém suporte a pacman, apt, dnf, zypper e apk.
- --install --yes executa o caminho automático; sem --yes, mostra o comando e pede confirmação.
- --uninstall/--restore removem plugin/injeção/estado próprio, nunca pacotes compartilhados.

- [ ] **Step 1: Escrever teste que capture o bloqueio atual**

~~~sh
#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
if head -35 "$ROOT/installer/golivebypass-installer.sh" | grep -F 'temporariamente fora do ar' >/dev/null; then
  printf '%s\n' 'installer still has the early blocking exit' >&2
  exit 1
fi
grep -F 'ensure_linux_runtime' "$ROOT/installer/golivebypass-installer.sh" >/dev/null
grep -F 'wireguard-tools' "$ROOT/installer/golivebypass-installer.sh" >/dev/null
printf '%s\n' 'installer Linux runtime contract: ok'
~~~

- [ ] **Step 2: Rodar o teste para confirmar a falha**

Run: sh tests/test-installer-linux-runtime.sh
Expected: FAIL porque o instalador ainda encerra no aviso de portabilidade.

- [ ] **Step 3: Remover o exit precoce e implementar dependências**

Criar mapeamento explícito por gerenciador: iproute2, wireguard-tools, curl, unzip, git, nodejs, npm e go quando a compilação local do confgen for necessária. Mostrar PRETTY_NAME, comando e motivo antes da confirmação; executar uma única instalação idempotente; invalidar o hash de comandos e verificar cada ferramenta depois.

- [ ] **Step 4: Preparar Node 22+ sem substituir Node funcional**

Se o Node do sistema for menor que 22, instalar Node 22 LTS pelo nvm/fnm em diretório do usuário, exportar PATH somente para o processo do instalador e usar esse Node para pnpm install/build. Confirmar node_major >= 22; se o bootstrap não puder ser concluído, parar com instrução reproduzível antes de fechar o Discord.

- [ ] **Step 5: Copiar fontes e helper Linux completos**

Expandir PLUGIN_FILES para index.tsx, native.ts, stability.ts, update-channel.ts, update-security.ts, vpn-controller.ts, vpn-proton.ts, vpn-types.ts, vpn-windows.ts, vpn-linux.ts, linux-helper.sh, manifest.json e documentação necessária. Para instalação remota, baixar o goLiveBypass-vencord.zip e seu .sha256, verificar o hash antes de extrair/copiar; para --plugin-source, compilar tools/proton-confgen Linux x64 e instalar com modo 0700.

- [ ] **Step 6: Integrar preflight antes de mutações**

Executar ensure_linux_runtime antes de parar/injetar o Discord. Detectar instalações Flatpak/Snap/ARM e abortar com mensagem clara, sem patch parcial. Depois da cópia, validar presença dos arquivos e que pnpm build usa a árvore atual.

- [ ] **Step 7: Testar instalador em shells e com stubs**

Run: sh -n installer/golivebypass-installer.sh && sh tests/test-installer-linux-runtime.sh && sh tests/test-auto-update.sh && node --test tests/test-distribution-parity.cjs
Expected: sem exit precoce, preflight idempotente, nenhuma regressão nos modos update/uninstall/restore e nenhuma expectativa antiga de bloqueio do plugin.

- [ ] **Step 8: Commitar**

~~~sh
git add installer/golivebypass-installer.sh tests/test-installer-linux-runtime.sh tests/test-auto-update.sh tests/test-distribution-parity.cjs tests/test-standalone-status-warning.sh
git commit -m "feat(installer): preparar runtime Linux do plugin automaticamente"
~~~

### Task 7: Release asset e documentação pública

**Files:**
- Modify: .github/workflows/build-gui.yml:228-240
- Modify: README.md:163-318,473-520,598-620
- Modify: goLiveBypass/COMO-INSTALAR.md:1-110
- Modify: CHANGELOG.md

**Interfaces:**
- Release ZIP contém os fontes comuns, vpn-linux.ts, linux-helper.sh, bin/linux-x64/proton-confgen e bin/win32-x64/proton-confgen.exe.
- O instalador remoto valida o SHA-256 do ZIP completo antes de extrair o helper e os binários.
- Documentação chama installer/golivebypass-installer.sh de instalador oficial Linux e descreve a autorização sudo/pkexec.

- [ ] **Step 1: Alterar workflow para compilar os dois helpers**

~~~yaml
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -buildvcs=false -trimpath -ldflags='-s -w' \
  -o ../../goLiveBypass/bin/linux-x64/proton-confgen ./cmd/protonvpn-wg
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -buildvcs=false -trimpath -ldflags='-s -w' \
  -o ../../goLiveBypass/bin/win32-x64/proton-confgen.exe ./cmd/protonvpn-wg
~~~

Adicionar ambos ao ZIP e ao teste de conteúdo/hash; manter classificação beta/prerelease conforme as regras existentes.

- [ ] **Step 2: Atualizar README e manual do plugin**

Remover afirmações de “Windows x64 necessário” para a combinação Linux nativa suportada, explicar que o instalador instala dependências automaticamente, registrar limites Flatpak/Snap/ARM e deixar claro que credenciais/perfil WireGuard continuam sendo fornecidos pelo usuário.

- [ ] **Step 3: Registrar a mudança no changelog**

Adicionar a entrada da versão beta indicando Linux x86_64, namespace WireGuard, restauração e instalador automático; não prometer IP geográfico ou paridade de clientes fora do escopo.

- [ ] **Step 4: Validar documentação e workflow**

Run: git diff --check && sh -n installer/golivebypass-installer.sh && node --test tests/test-plugin-update-audit.mjs tests/test-distribution-parity.cjs
Expected: links/cópias coerentes, sem afirmações contraditórias e workflow com os dois artefatos.

- [ ] **Step 5: Commitar**

~~~sh
git add .github/workflows/build-gui.yml README.md goLiveBypass/COMO-INSTALAR.md CHANGELOG.md
git commit -m "docs(release): documentar plugin Linux e installer automático"
~~~

### Task 8: Validação real e loop de correção no Linux

**Files:**
- Test: tests/test-plugin-linux-helper.sh
- Test: tests/test-installer-linux-runtime.sh
- Test: tests/test-userplugin-e2e.sh
- Test: tests/test-plugin-linux-lifecycle.mjs
- Test: tests/run-linux-stability-loop.sh
- Modify: docs/testing/2026-09-09-linux-plugin-validation.md

**Interfaces:**
- Consumes: instalador e plugin compilados das tarefas anteriores, Discord oficial local e perfil Proton/custom fornecido pelo usuário.
- Produces: log sanitizado com rota host, namespace, PID Discord, handshake, RX/TX e restauração por ciclo.

- [ ] **Step 1: Rodar a matriz automatizada completa antes do Discord**

Run: node --test tests/test-plugin-*.mjs && sh tests/test-userplugin-e2e.sh && sh tests/test-installer-linux-runtime.sh && (cd tools/proton-confgen && go test ./...)
Expected: zero falhas; qualquer falha vira correção antes do teste real.

- [ ] **Step 2: Executar o instalador com fonte local sem expor segredo**

Run: ./installer/golivebypass-installer.sh --source /home/pdl/Equicord --plugin-source "$PWD/goLiveBypass" --install --mod equicord --yes
Confirmar no log do instalador o preflight, a cópia do helper Linux, o build e a injeção real; não imprimir sessão Proton nem conteúdo de .conf.

- [ ] **Step 3: Medir o estado inicial e ativar o plugin**

Registrar ip route show default, ip netns list, processos Discord e um probe HTTPS fora do namespace. Ativar pelo painel do plugin com uma sessão Proton ou .conf válida e confirmar status=active, processo Discord dentro de golivebypass-plugin, handshake recente e RX/TX positivos.

- [ ] **Step 4: Provar isolamento e restauração**

Executar o mesmo probe fora do namespace durante a sessão, confirmar que a rota default do host não mudou, testar gateway/uso do Discord, clicar em restaurar e confirmar ausência de namespace/interface/owner e Discord reaberto fora do túnel.

- [ ] **Step 5: Repetir o ciclo pelo menos três vezes**

~~~text
for ciclo in 1..3:
  ativar -> confirmar processo/no namespace -> confirmar handshake/RX/TX
  restaurar -> confirmar processo fora -> confirmar rota host original
~~~

Registrar cada falha com hipótese e evidência nova; não repetir duas vezes a mesma tentativa sem trocar instrumento ou hipótese.

- [ ] **Step 6: Corrigir, rerodar e registrar resultado**

Após cada falha, editar apenas a causa confirmada, executar a suíte específica, repetir o ciclo afetado e só então seguir. Salvar o relatório sanitizado em docs/testing/2026-09-09-linux-plugin-validation.md, informando limitações reais (credencial/configuração, Flatpak/Snap, kernel ou Discord).

- [ ] **Step 7: Validação final e status do worktree**

Run: git diff --check && git status --short && ip netns list
Expected: nenhum namespace/interface/processo do plugin pendente, Discord oficial preservado, testes finais verdes e mudanças rastreadas somente nos arquivos previstos.

- [ ] **Step 8: Commitar evidências**

~~~sh
git add docs/testing/2026-09-09-linux-plugin-validation.md
git commit -m "test: validar plugin Linux WireGuard em ciclos reais"
~~~
