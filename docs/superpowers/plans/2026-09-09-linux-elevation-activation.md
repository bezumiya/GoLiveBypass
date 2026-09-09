# Elevação Linux e ativação segura do Discord Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fazer a GUI Linux comprovar a autorização sudo/pkexec antes de fechar o Discord e registrar, sem segredos, se o prompt foi aberto, recebeu entrada e foi aceito ou recusado.

**Architecture:** O standalone continuará sendo o único dono da elevação Linux. Uma transação efêmera de elevação registra provedor e resultado no stderr que a GUI já encaminha aos logs, valida a autorização com `sudo -S -k -v` ou `pkexec`, e só depois libera o fluxo que encerra o Discord e cria o namespace WireGuard. Probes de status/saúde permanecem em `elevate_readonly` e não recebem nenhuma capacidade interativa.

**Tech Stack:** Shell POSIX (`standalone/golivebypass-standalone.sh`), Electron/TypeScript existente, Vitest, `bash -n` e Vite.

**Spec:** `docs/superpowers/specs/2026-09-09-linux-elevation-activation-design.md`

## Global Constraints

- Nunca registrar senha, comprimento da senha, conteúdo do stderr do prompt ou token de sessão.
- A autenticação interativa só pode ocorrer no caminho explícito de ativação; `--status`, watchdogs e probes usam `NONINTERACTIVE=1`.
- O preflight continua somente leitura e não abre prompt.
- A autorização precisa terminar antes de `stop_discord`, remoção de Singleton ou alteração do namespace.
- O namespace `discord-vpn` continua isolando somente o Discord; não alterar a rota padrão do host.
- Esta correção altera somente `standalone/golivebypass-standalone.sh`, que é o motor Linux da GUI; não alterar `golive-gui/electron/bypass.ts`. Executar `npm run sync-bypass` somente quando `standalone/golivebypass.js` também for alterado.
- Preservar todas as alterações não relacionadas já existentes na árvore de trabalho e enviar commits somente com arquivos do plano.

### Task 1: Fixar o contrato observável da elevação nos testes

**Files:**
- Modify: `golive-gui/tests/linux-elevation.test.ts`
- Test: `golive-gui/tests/linux-elevation.test.ts`

**Interfaces:**
- Consumes: o trecho de funções do standalone entre `have()` e o marcador de leitura existente.
- Produces: um harness que devolve `{ stdout: string; stderr: string; status: number | null }` e consegue simular autorização em cache, prompt aceito, prompt cancelado, senha recusada, `pkexec` e modo não interativo.

- [ ] **Step 1: Expandir o harness para capturar stderr e a entrada sem conteúdo secreto**

  No `runElevation`, substituir o retorno somente do log dos comandos por um objeto com stdout, stderr e status. O fake `sudo` deve registrar apenas `sudo_validate:nonempty` quando recebe texto pelo stdin e decidir o código da validação por uma opção `sudoValidation: "accepted" | "rejected"`; nunca escrever o conteúdo lido. O fake `zenity` deve registrar `prompt:zenity` e permitir os resultados `accepted`, `empty` e `cancel`; o fake `kdialog` deve usar a mesma convenção.

  O trecho de execução deve capturar o stderr em arquivo temporário e retorná-lo antes de remover o diretório:

  ```ts
  const result = spawnSync("/bin/sh", ["-c", script], {
    env: { ...process.env, PATH: bin, LOG: path.join(dir, "log") },
    encoding: "utf8",
  });
  const log = fs.existsSync(path.join(dir, "log"))
    ? fs.readFileSync(path.join(dir, "log"), "utf8")
    : "";
  const stderr = result.stderr || "";
  const status = result.status;
  fs.rmSync(dir, { recursive: true, force: true });
  return { log, stderr, status };
  ```

- [ ] **Step 2: Adicionar testes que falhem com a implementação atual**

  Adicionar casos com nomes e expectativas explícitos:

  ```ts
  it("registra que o prompt zenity foi solicitado e aceito", () => {
    const result = runElevation({ prompt: "zenity-accepted", sudoValidation: "accepted" });
    expect(result.log).toContain("prompt:zenity");
    expect(result.stderr).toContain("prompt.requested provider=zenity");
    expect(result.stderr).toContain("prompt.finished provider=zenity input=nonempty");
    expect(result.stderr).toContain("sudo.validation result=accepted");
    expect(result.log).toContain("sudo_validate:nonempty");
    expect(result.stderr).not.toMatch(/test|password|senha=/i);
  });

  it("distingue prompt cancelado de senha recusada", () => {
    const cancelled = runElevation({ prompt: "zenity-cancel", sudoValidation: "accepted" });
    expect(cancelled.stderr).toContain("result=cancelled");
    expect(cancelled.stderr).not.toContain("sudo.validation result=accepted");

    const rejected = runElevation({ prompt: "zenity-accepted", sudoValidation: "rejected" });
    expect(rejected.stderr).toContain("prompt.finished provider=zenity input=nonempty");
    expect(rejected.stderr).toContain("sudo.validation result=rejected");
  });

  it("mantém modo readonly sem prompt e informa provedor pkexec", () => {
    const readonly = runElevation({ pkexec: true, readonly: true });
    expect(readonly.log).not.toContain("prompt:");
    const pkexec = runElevation({ pkexec: true, noPrompt: true });
    expect(pkexec.log).toContain("pkexec:");
    expect(pkexec.stderr).toContain("provider=pkexec");
  });
  ```

  Declarar no início do arquivo as opções usadas pelos fakes: `cached?: boolean`, `prompt?: "zenity-accepted" | "zenity-empty" | "zenity-cancel" | "kdialog-accepted"`, `sudoValidation?: "accepted" | "rejected"`, `pkexec?: boolean`, `noPrompt?: boolean`, `readonly?: boolean` e `readonlyElevate?: boolean`.

- [ ] **Step 3: Executar somente a suíte nova para confirmar as falhas**

  Run: `npm test -- tests/linux-elevation.test.ts`

  Expected: os novos casos falham porque não existem eventos `prompt.requested`, `prompt.finished` e `sudo.validation` no stderr atual.

- [ ] **Step 4: Commitar apenas o contrato de teste**

  ```bash
  git add golive-gui/tests/linux-elevation.test.ts
  git commit -m "test(linux): especificar rastreio da elevacao"
  ```

### Task 2: Instrumentar a coleta e a validação da credencial

**Files:**
- Modify: `standalone/golivebypass-standalone.sh:705-818`
- Test: `golive-gui/tests/linux-elevation.test.ts`

**Interfaces:**
- Consumes: `GOLIVE_GUI`, `NONINTERACTIVE`, `sudo`, `zenity`, `kdialog` e `pkexec` disponíveis no ambiente do usuário.
- Produces: variáveis efêmeras `ELEVATION_PROVIDER` e `ELEVATION_RESULT`, mais eventos stderr no formato `elevation.<phase> key=value`.

- [ ] **Step 1: Criar um emissor de eventos sanitizados**

  Inserir antes de `sudo_pass_get`:

  ```sh
  ELEVATION_PROVIDER="none"
  ELEVATION_RESULT="not_attempted"

  elevation_event() {
      printf '[elevation] %s provider=%s result=%s%s\n' \
          "$1" "${ELEVATION_PROVIDER:-none}" "${ELEVATION_RESULT:-unknown}" \
          "${2:+ $2}" >&2
  }
  ```

  Os chamadores só poderão passar valores fixos (`requested`, `finished`, `accepted`, `rejected`, `cancelled`, `unavailable`, `failed`, `cached`); não passar saída de comando, senha ou argumento arbitrário.

- [ ] **Step 2: Tornar a escolha de provedor explícita**

  Criar `sudo_prompt_provider()` retornando `zenity`, `kdialog` ou vazio, nessa ordem. Fazer `sudo_pass_get` definir `ELEVATION_PROVIDER` antes de executar o diálogo; quando nenhum provedor existir, definir `ELEVATION_RESULT=prompt_unavailable`, emitir `elevation.prompt.finished provider=none result=unavailable` e retornar falha.

- [ ] **Step 3: Registrar início e fim do prompt sem vazar stderr**

  Reescrever a chamada de `zenity`/`kdialog` para capturar código de saída sem deixar `set -e` encerrar o shell prematuramente. Redirecionar stderr do provedor para um arquivo temporário `mktemp`, usar somente `[ -s "$prompt_error" ]` como indicador e removê-lo imediatamente.

  A sequência observável deve ser implementada com captura explícita do código de saída:

  ```sh
  elevation_event "prompt.requested" "phase=dialog"
  prompt_error="$(mktemp)"
  if pass="$(zenity --password --title='GoLiveBypass - senha do sudo' 2>"$prompt_error")"; then
      prompt_exit=0
  else
      prompt_exit=$?
  fi
  prompt_error_present=false
  [ -s "$prompt_error" ] && prompt_error_present=true
  rm -f "$prompt_error"
  elevation_event "prompt.finished" "input=nonempty"
  ```

  Para `prompt_exit != 0` e stderr vazio, registrar `input=empty result=cancelled`; para stderr presente, registrar `input=empty result=failed`; para código 0 com resposta vazia, registrar `input=empty result=empty`. Só executar `sudo -S -k -v` quando `pass` não estiver vazio. Aplicar a mesma sequência à chamada `kdialog`.

- [ ] **Step 4: Registrar validação aceita/recusada e manter o segredo efêmero**

  Em `sudo_authenticate_once`, registrar o resultado de `sudo -n true` como `sudo.cached`, registrar `sudo.validation result=accepted` após `sudo -S -k -v` bem-sucedido e `sudo.validation result=rejected` após falha. Manter `SUDO_PASS_FILE`, `chmod 600`, `cleanup_sudo_pass` e o `trap` existentes; não adicionar senha em ambiente, argumento, log ou arquivo persistente.

- [ ] **Step 5: Instrumentar o fallback pkexec sem alterar probes**

  No ramo GUI que usa `pkexec`, emitir `elevation.prompt.requested provider=pkexec`, executar o comando, emitir `result=accepted` ou `result=failed` e retornar o mesmo código. O ramo só poderá ser alcançado quando `NONINTERACTIVE != 1`; `elevate_readonly` deve continuar sem esses eventos.

- [ ] **Step 6: Executar os testes do contrato especificado**

  Run: `npm test -- tests/linux-elevation.test.ts`

  Expected: PASS para prompt aceito, cancelado, vazio, senha recusada, cache sudo, fallback pkexec e modo readonly sem prompt.

- [ ] **Step 7: Commitar a instrumentação**

  ```bash
  git add standalone/golivebypass-standalone.sh golive-gui/tests/linux-elevation.test.ts
  git commit -m "fix(linux): registrar resultado da elevacao"
  ```

### Task 3: Bloquear o encerramento prematuro do Discord

**Files:**
- Modify: `standalone/golivebypass-standalone.sh` no fluxo `MODE=install`, imediatamente antes de `stop_discord`
- Modify: `golive-gui/tests/linux-preflight.test.ts`
- Test: `golive-gui/tests/linux-elevation.test.ts`

**Interfaces:**
- Consumes: `elevate true`, `ELEVATION_RESULT` e `ELEVATION_PROVIDER` da Task 2.
- Produces: `authorize_install_elevation`, uma barreira usada somente na ativação explícita da GUI.

- [ ] **Step 1: Adicionar teste de ordenação antes de implementar a barreira**

  No teste de ativação Linux, extrair o bloco do fluxo entre `FOUND="$(escolher_alvos patchear)"` e o primeiro `stop_discord`. Exigir que a chamada a `authorize_install_elevation` apareça antes de `stop_discord` e que os fluxos `--status`, `--preflight` e `--ensure-dependencies` não contenham a chamada.

  ```ts
  const install = source.slice(source.indexOf('FOUND="$(escolher_alvos patchear)"'));
  expect(install.indexOf("authorize_install_elevation")).toBeGreaterThanOrEqual(0);
  expect(install.indexOf("authorize_install_elevation")).toBeLessThan(install.indexOf("stop_discord"));
  ```

- [ ] **Step 2: Executar o teste de ordenação para confirmar a falha**

  Run: `npm test -- tests/linux-preflight.test.ts`

  Expected: FAIL porque o fluxo atual chama `stop_discord` sem uma barreira de autorização.

- [ ] **Step 3: Implementar a barreira de autorização**

  Criar uma função POSIX com a seguinte responsabilidade:

  ```sh
  authorize_install_elevation() {
      if [ "$(id -u)" -eq 0 ]; then
          ELEVATION_PROVIDER="root"
          ELEVATION_RESULT="accepted"
          elevation_event "authorization" "phase=pre_activation"
          return 0
      fi
      elevation_event "authorization.requested" "phase=pre_activation"
      if elevate true; then
          ELEVATION_RESULT="accepted"
          elevation_event "authorization" "phase=pre_activation"
          return 0
      fi
      elevation_event "authorization" "phase=pre_activation"
      return 1
  }
  ```

  O fluxo de instalação deve chamar `authorize_install_elevation || fail "Não foi possível autorizar a ativação Linux: ${ELEVATION_RESULT}. O Discord não foi encerrado."` imediatamente antes de `stop_discord`. Não usar `--yes` para suprimir o prompt: `--yes` apenas pula confirmação de alvo e não pode pular autenticação.

- [ ] **Step 4: Adicionar regressões para preservação do cliente**

  Criar um harness de ordem com este contrato: `authorize_install_elevation` escreve `authorize` e retorna `1` no caso recusado ou escreve `authorize` e retorna `0` no caso aceito; `stop_discord` escreve `stop`. No cenário recusado, exigir saída `authorize` sem `stop` e a mensagem `Discord não foi encerrado`. No cenário aceito, exigir a sequência `authorize\nstop` e uma única chamada a `stop_discord`.

- [ ] **Step 5: Executar os testes Linux focados**

  Run: `npm test -- tests/linux-elevation.test.ts tests/linux-preflight.test.ts`

  Expected: PASS, incluindo a prova de que cancelamento/ausência de prompt acontece antes de qualquer encerramento do Discord.

- [ ] **Step 6: Commitar a barreira de ativação**

  ```bash
  git add standalone/golivebypass-standalone.sh golive-gui/tests/linux-elevation.test.ts golive-gui/tests/linux-preflight.test.ts
  git commit -m "fix(linux): autenticar antes de fechar o Discord"
  ```

### Task 4: Registrar a correção no changelog e preservar os invariantes

**Files:**
- Modify: `CHANGELOG.md` na seção `Unreleased`
- Test: `golive-gui/tests/linux-sudo.test.ts`

**Interfaces:**
- Consumes: o standalone corrigido e os eventos stderr já encaminhados por `runScript`/`linuxActivate`.
- Produces: changelog explicando a causa sem atribuir o problema ao Equicord e uma verificação explícita de que probes não ganharam interatividade.

- [ ] **Step 1: Confirmar que a cópia gerada não participa deste caminho**

  Run: `rg -n 'runScript\(\["--(status|preflight|ensure-dependencies)|runScript\(\["--yes"' golive-gui/electron/main.ts && rg -n 'findStandaloneScript|golivebypass-standalone.sh' golive-gui/electron/linux-helper.ts`.

  Expected: `linux-helper.ts` aponta para `standalone/golivebypass-standalone.sh`, enquanto `bypass.ts` não é incluído no caminho Linux. Não modificar `bypass.ts`.

- [ ] **Step 2: Verificar que os probes continuam não interativos**

  Run: `npm test -- tests/linux-sudo.test.ts` em `golive-gui/`.

  Expected: PASS comprovando `sudo -n`, `elevate_readonly` e `NONINTERACTIVE=1` sem abrir prompt.

- [ ] **Step 3: Documentar a correção no changelog**

  Adicionar em `CHANGELOG.md` uma entrada sob `Unreleased` com estes pontos: o preflight não afirma que um prompt existe; a ativação registra provedor/início/fim/validação sem senha; a autorização ocorre antes de fechar o Discord; probes automáticos continuam sem prompt. Indicar que a correção é específica da GUI Linux e que Equicord/Vencord continua apenas coexistindo dentro do processo.

- [ ] **Step 4: Executar a integração de preflight**

  Run: `npm test -- tests/linux-preflight.test.ts tests/gui-preflight-integration.test.ts`

  Expected: PASS, confirmando que o preflight continua antes de qualquer ativação e não pede credenciais.

- [ ] **Step 5: Commitar a documentação**

  ```bash
  git add CHANGELOG.md
  git commit -m "docs(gui): registrar correcao de elevacao Linux"
  ```

### Task 5: Validar compilação e higiene do patch

**Files:**
- Create: `docs/testing/2026-09-09-linux-elevation-validation.md`
- Test: `golive-gui/tests/linux-elevation.test.ts`
- Test: `golive-gui/tests/linux-preflight.test.ts`
- Test: `golive-gui/tests/linux-sudo.test.ts`

**Interfaces:**
- Consumes: os commits de implementação/documentação anteriores.
- Produces: evidência local reproduzível da correção; nenhuma publicação externa.

- [ ] **Step 1: Validar sintaxe shell**

  Run: `bash -n standalone/golivebypass-standalone.sh`

  Expected: saída vazia e código 0.

- [ ] **Step 2: Executar todas as suítes focadas**

  Run: `npm test -- tests/linux-elevation.test.ts tests/linux-preflight.test.ts tests/linux-sudo.test.ts tests/gui-preflight-integration.test.ts`

  Expected: todos os testes desses arquivos passam.

- [ ] **Step 3: Compilar a GUI**

  Run: `npm run compile` em `golive-gui/`.

  Expected: helper Proton, TypeScript e Vite terminam com código 0; como o standalone JavaScript não foi alterado, a cópia gerada `golive-gui/electron/bypass.ts` permanece sem mudanças funcionais.

- [ ] **Step 4: Conferir diff e estado da árvore**

  Run: `git diff --check && git status --short --branch && git log -5 --oneline --decorate`

  Expected: nenhum erro de whitespace; os commits novos listam somente os arquivos do plano; alterações pré-existentes fora do plano permanecem não staged.

- [ ] **Step 5: Escrever o relatório de validação**

  Criar `docs/testing/2026-09-09-linux-elevation-validation.md` com a causa da #258, os comandos executados, o resultado de cada suíte, a sequência de eventos observada no harness e a limitação da plataforma. Registrar explicitamente que, sem uma sessão Linux do usuário com prompt gráfico, o diálogo Wayland real não foi visualmente reproduzido e que os testes sintéticos não provam o roteamento de um Discord real.

- [ ] **Step 6: Commitar o relatório de validação**

  ```bash
  git add docs/testing/2026-09-09-linux-elevation-validation.md
  git commit -m "docs(test): registrar validacao da elevacao Linux"
  ```

## Resultado esperado

Ao clicar em ativar na GUI Linux, os logs mostrarão uma sequência sanitizada semelhante a:

```text
[elevation] prompt.requested provider=zenity result=not_attempted phase=dialog
[elevation] prompt.finished provider=zenity result=accepted input=nonempty
[elevation] sudo.validation provider=zenity result=accepted
[elevation] authorization provider=zenity result=accepted phase=pre_activation
```

Se o diálogo não abrir ou for cancelado, a sequência terminará com `prompt_unavailable`,
`cancelled` ou `failed`, e a mensagem informará que o Discord não foi encerrado. Se a senha
for preenchida mas incorreta, o log registrará `input=nonempty` seguido de
`sudo.validation result=rejected`; o segredo nunca aparecerá. Os probes automáticos continuarão
sem eventos interativos e sem alteração da sessão.
