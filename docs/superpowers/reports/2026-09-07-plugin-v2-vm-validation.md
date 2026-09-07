# Validação do plugin v2 — 2026-09-07

## Resultado

O plugin foi migrado para a linha `2.0.0-beta.1`, compilado e injetado no Equicord da
VM Windows x64. A transmissão de tela foi iniciada no canal de teste e permaneceu ativa
por mais de dois minutos em `720p · 60FPS`, sem o erro 2012 na interface.

## Alterações validadas

- watchdog do WireSock com confirmação em múltiplas amostras;
- watchdog estritamente diagnóstico para leitura inativa transitória;
- estado do serviço priorizando CIM, com fallback para `sc.exe`;
- atribuição de processo WireSock pelo PID do serviço próprio quando a linha de comando
  não é exposta;
- registro do estado nativo da transmissão sem serializar o objeto inteiro do Discord;
- registro de serviço legado parado permitido, mas serviço externo ativo continua sendo
  recusado para preservar o túnel de outra aplicação;
- versão alinhada entre `manifest.json`, renderer e processo nativo.

## Verificações no host

- `npm test`: 43 arquivos, 321 testes aprovados;
- `npm test -- --run tests/plugin-v2-regression.test.ts tests/stream-diagnostics.test.ts tests/plugin-v2-version.test.ts`: 13 testes aprovados;
- `npm run check-bypass`: bypass sincronizado;
- `git diff --check`: sem erros.

## Verificações na VM

- build do checkout Equicord concluído;
- patch/inject do Discord concluído com sucesso;
- reconexão ao canal de voz concluída;
- transmissão local visível como `Tela 1 · 720p · 60FPS` e `AO VIVO`;
- preview remoto continuou renderizando a tela após aproximadamente 130 segundos;
- probes de rede sucessivas com `ok=true`, `discordOk=true` e `mode=log-only`;
- no trecho da última inicialização não houve `[error]` nem transição de watchdog para
  `recovery_required`.

Evidências temporárias usadas na sessão:

- `/tmp/win11-v2-diagnostic-only-final-stream.png`;
- `/tmp/win11-v2-diagnostic-only-stream-130s.png`;
- `/tmp/golive-v2-diagnostic-only-final.log`;
- pacote testado: SHA-256 `4bd3bbc8bba3315d6b6348224e8e344750f776eb3bd4ed12bc5d9fd72dfa30e9`.

## Limitações reais

Esta validação cobre Windows x64 e o fluxo de tela no checkout do Equicord da VM. Não
publica release, não envia mensagens ao Discord e não altera o standalone nem a GUI.
As probes confirmam a rota observada e servem para diagnóstico; não são garantia de
geolocalização. O ID de canal fornecido na conversa não foi usado porque o teste foi
feito no canal já aberto na VM.
