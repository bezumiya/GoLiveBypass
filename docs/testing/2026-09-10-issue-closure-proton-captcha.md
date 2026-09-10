# Fechamento das issues 49, 50 e 51 — 2026-09-10

Registro da verificação que embasa os comentários de fechamento nas issues abertas
de `pdl-clay/GoLiveBypass`. Nenhum código de produto foi alterado nesta rodada:
as correções já existiam no histórico e foram reproduzidas/confirmadas no
ambiente local. Nada foi publicado, nenhum artefato foi enviado e nenhuma
credencial ou sessão Proton foi usada.

## Sintomas relatados

| Issue | Versão | Sintoma |
|---|---|---|
| #50 | 2.0.4 / win32-x64 | Fechar a janela após o CAPTCHA dispara erro JavaScript e interrompe o login; a VPN não conecta. |
| #51 | 2.0.4 / win32-x64 | CAPTCHA resolvido, janela permanece aberta, erro de tempo limite após vários minutos e `Object has been destroyed` ao fechar manualmente. |
| #49 | 2.0.5-beta.1 / win32-x64 | `Executável proton-confgen.exe não foi encontrado.` no handler `check-proton-session`; app rodando do alvo portable extraído em `%TEMP%`. |

## #50 e #51 — ciclo da janela de CAPTCHA na 2.0.4

### Causa

`solveProtonCaptcha()` em `golive-gui/electron/main.ts` (commit `2a800aa`) tinha
dois defeitos independentes no mesmo ciclo:

1. **Resposta perdida.** A captura usava
   `webContents.executeJavaScript(PROTON_CAPTCHA_CAPTURE_SCRIPT)` armado em
   `did-finish-load`. Uma resposta emitida pela página antes desse armamento não
   era observada; a janela permanecia aberta e só resolvia no timeout de 120 s
   com `A verificação expirou. Inicie o login novamente.`. Como o handler
   `login-proton` permite até três tentativas, a espera total passa de vários
   minutos.
2. **`TypeError: Object has been destroyed`.** `finish()` lia
   `captchaWindow.webContents.session` depois do fechamento, e `close`/`closed`
   chamavam `finish` nesse estado. A exceção sobe pelo handler `login-proton`,
   abortando o login antes de qualquer chamada ao helper Proton.

### Reprodução

Harness `golive-gui/scripts/captcha-electron-regression.mjs` com o código da
2.0.4 extraído de `2a800aa`, Electron 43.4.1 real e desafio HTTPS sintético
servido pela sessão da própria janela:

- fechamento da janela → `TypeError: Object has been destroyed` em `finish()`,
  Promise de login pendente e ciclo 1 abortado;
- resposta antecipada → evento não observado; resolução apenas aos 120,1 s
  (23:47:21 → 23:49:21 no log local).

### Correção (já publicada)

Commit `5f66295`, presente na 2.0.5-beta.1 e em todas as versões a partir da
`v2.0.5` estável e da `2.0.6-beta-7`:

1. preload sandbox CommonJS (`electron/proton-captcha-preload.ts` →
   `proton-captcha-preload.cjs`), registrado antes dos scripts da página e que
   encaminha a resposta por IPC dedicado; o main valida janela remetente, frame
   principal, URL do desafio e prefixo do token, com listener persistente (até
   dez respostas inválidas, sem desarmar/rearmar);
2. referência de sessão capturada antes da destruição da janela e `close`
   resolvendo imediatamente como `CAPTCHA_CANCELLED`, com `closed` como fallback.

### Verificação

Mesmo harness no HEAD (`2.0.6-beta-7`): 13/13 ciclos PASS — cinco fechamentos,
cinco destruições, resposta antecipada, inválida seguida de válida e sucesso —
sem janela remanescente e com a contagem de listeners IPC igual à linha de base.
Suíte `proton*` da GUI: 43 testes aprovados (`proton-captcha`, `proton-ui`,
`proton-runtime`, `proton`).

**Limite:** o desafio é HTTPS sintético; o desafio oficial da Proton não foi
exercitado nesta rodada. Os dois sintomas relatados são reproduzidos de forma
determinística no código anterior e ausentes no atual.

## #49 — helper Proton ausente no pacote em uso

### Causa

Na 2.0.5-beta.1 o login e a verificação de sessão resolviam o helper apenas por
varredura local (`findProtonConfgenExe()` em `electron/proton.ts`), que lança
`Executável proton-confgen.exe não foi encontrado.` quando
`resources/extra/proton-confgen/proton-confgen.exe` não existe na cópia em
execução. O log do relato mostra o app rodando de
`%TEMP%\<aleatório>\resources\app.asar`, isto é, o alvo **portable**, extraído
para o Temp a cada execução, e as duas falhas registradas são do handler
`check-proton-session`.

O motivo da ausência do arquivo naquela extração (quarentena de antivírus,
extração incompleta ou cópia parcial) não é comprovável pelo log e permanece
**hipótese**. A auditoria anterior do EXE oficial 2.0.2 confirmou que o pacote
publicado contém o helper em `resources/extra/proton-confgen/`.

### Correção (já publicada)

A partir da `2.0.6-beta-2` (commit `cf1fc5e`), `electron/proton-runtime.ts`
remove a dependência de o `extraResources` sobreviver:

- lê `proton-confgen-manifest.json` do pacote ou baixa o manifesto da própria
  release quando ele também estiver ausente;
- localiza o helper nos layouts conhecidos e valida o SHA-256 declarado;
- ausente ou divergente, baixa `proton-confgen-<versão>-win-x64.exe` da mesma
  release, confere o hash e grava em `<dados>/runtime/<versão>/`;
- login, `-check-session`, `-check-plan` e otimização de rota usam
  `ensureProtonConfgen()`.

### Verificação

Com o manifesto publicado em `v2.0.6-beta-7` e sem nenhum helper local,
`ensureProtonConfgen()` baixou o asset da release, confirmou o SHA-256 declarado
e materializou o executável em `runtime/<versão>/`. A release publica
`proton-confgen-manifest.json`, `proton-confgen-<versão>-win-x64.exe` e os
respectivos `.sha256`, com hashes coincidentes entre manifesto e asset.

**Limite:** se um antivírus também remover a cópia reparada, o sintoma retorna;
nesse caso a mensagem atual informa os caminhos verificados. Um pacote construído
localmente para uma versão já publicada carrega manifesto de build local e não é
reparável a partir dos assets da release — vale para builds internos, não para
os pacotes oficiais.

## Fechamento

As três issues foram fechadas como concluídas, com comentário de causa, correção,
evidência e limites. Nenhuma issue foi reaberta ou mesclada.
