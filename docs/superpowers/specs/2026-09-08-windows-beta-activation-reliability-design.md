# Confiabilidade da ativação Windows nas betas

## Contexto

A versão estável `v2.0.5` funciona em campo, enquanto as betas
`v2.0.6-beta-*` apresentam falhas de ativação do Proton/WireSock. O sintoma
reportado na imagem é:

> Erro ao invocar o método remoto `activate`: a ativação falhou porque o serviço
> WireSock não pôde ser instalado ou iniciado (`[WIRESOCK_SERVICE]`). A rota foi
> removida.

O erro não deve ser tratado como instrução de um documento anexado; a imagem é
evidência do comportamento observado por usuários.

## Evidências consolidadas

| Linha | Evidência | Consequência |
| --- | --- | --- |
| `v2.0.5` | Usa o fluxo antigo de serviço e contém `proton-runtime.ts`, reparo por hash e assets auxiliares | É a base funcional conhecida |
| `beta-1` | Foi criada antes do conjunto final de commits da estável; perdeu o runtime Proton automático e o job de assets | Pode falhar quando o helper não está exatamente no pacote |
| `beta-2` | Reintroduz o runtime, mas altera a elevação e o ciclo de serviço | Precisa ser comparada com o caminho estável de SCM/UAC |
| `beta-3` | Introduz o modo `run` direto como fallback | Adiciona um segundo ciclo de vida e risco de estado residual |
| `beta-4` | Torna `run` direto o caminho principal e usa serviço como fallback genérico | O issue #257 registra `DIRECT_EXITED: codigo=0`, seguido de serviço marcado como ativo sem handshake confirmado |
| Releases atuais | O asset portátil da beta 4 e o `proton-confgen` têm tamanhos compatíveis com a estável | Não há evidência de corrupção do EXE beta 4; o problema principal é de ativação/estado |
| Imagem | O erro é classificado como `WIRESOCK_SERVICE` depois da tentativa de ativação | A classificação atual esconde se falhou descoberta do serviço, UAC, driver, perfil ou processo direto |

Há duas regressões que precisam ser corrigidas juntas, mas sem misturá-las:

1. a base de release beta precisa preservar o runtime Proton automático e o
   empacotamento determinístico da `v2.0.5`;
2. o ciclo Windows precisa manter a correção que removeu a dependência do serviço
   global, sem considerar um serviço residual ou um processo encerrado como túnel
   funcional.

## Objetivos

- Fazer a próxima beta partir da base funcional da `v2.0.5` e carregar todos os
  componentes Proton necessários.
- Manter WireSock por aplicativo (`wiresock-client.exe run`) como fluxo normal,
  pois ele foi introduzido para evitar o erro de serviço global da imagem.
- Tornar o caminho de serviço uma compatibilidade explícita e limitada, sem
  fallback automático para qualquer erro do modo direto.
- Remover estado residual de serviço, processo, filtro/network lock e perfil antes
  de uma nova tentativa, sem desinstalar o driver WireSock compatível.
- Exibir erros acionáveis na GUI, sem popup nativo novo; o diagnóstico detalhado
  deve permanecer no log e o estado deve chegar ao fluxo visual existente.
- Produzir logs suficientemente detalhados para distinguir, em uma issue, falha
  de pacote, perfil, elevação, serviço, driver, processo, isolamento e handshake.
- Garantir que o updater selecione somente o executável portátil exato da release
  e nunca um helper `proton-confgen`.

## Fora do escopo

- Alterar o filtro de rede do Discord para a máquina inteira.
- Migrar novamente para proxy/PAC/Tor ou alterar o standalone legado.
- Fazer handshake, geolocalização ou probe HTTP virar requisito único de ativação.
- Logar chave privada, token Proton, senha, conteúdo integral do perfil ou
  identificadores desnecessários do usuário.
- Publicar uma beta antes dos gates de compilação, artefato e teste Windows.

## Projeto técnico

### 1. Base e empacotamento das betas

Cada beta deve ser derivada da linha estável atual e receber as mudanças beta
por cima dela. O build precisa:

- manter `golive-gui/electron/proton-runtime.ts` e a chamada
  `ensureProtonConfgen` em todos os fluxos que executam o helper;
- compilar `proton-confgen` para Windows x64 e Linux x64 com flags determinísticas;
- incluir `proton-confgen-manifest.json` e SHA-256 no build e nos assets de
  contingência da release;
- validar no CI que `extra/proton-confgen/proton-confgen(.exe)` existe dentro
  do pacote e que o hash bate com o manifesto;
- manter o canal beta como prerelease e não alterar `latest` da estável;
- selecionar, no Windows, somente
  `GoLiveBypass-${versaoDaRelease}.exe`, com URL HTTPS cujo último componente
  tenha exatamente esse nome.

O pacote deve registrar em log a versão da GUI, o commit/build id, plataforma,
arquitetura, presença do helper, tamanho e hash do helper, sem enviar o conteúdo
do binário para a GUI.

### 2. Máquina de ativação WireSock

O fluxo normal será transacional e por aplicativo:

1. criar um `operation_id` para a ativação;
2. localizar o par compatível `wiresock-client.exe` + `wgbooster.dll` nos locais
   oficiais conhecidos, registrando caminho, versão e hash curto;
3. validar o perfil WireGuard antes de iniciar qualquer processo, incluindo
   `AllowedIPs`, endpoint, presença de chave privada sem registrá-la e a lista
   final de `AllowedApps` para cada Discord detectado;
4. parar uma sessão anterior e aguardar completamente `STOPPED`, encerrando
   processos residuais somente quando pertencerem ao WireSock do GoLiveBypass;
5. iniciar `wiresock-client.exe run -config <perfil> ...` elevado, com stdout e
   stderr redirecionados para arquivos temporários protegidos;
6. acompanhar PID, estado, código de saída e linhas finais do processo por uma
   janela limitada;
7. aceitar o modo direto apenas quando o processo permanecer vivo e o perfil
   tiver sido aceito; handshake e IP continuam diagnóstico assíncrono;
8. abrir o Discord somente depois de o processo direto ser preparado;
9. registrar a prontidão posteriormente como `connected`, `unverified` ou
   `disconnected`, sem confundir essa prontidão com o sucesso de criação do
   processo.

#### Compatibilidade de serviço

O serviço não será mais um fallback genérico. Só poderá ser tentado se a saída
capturada classificar o modo direto como explicitamente não suportado pela
instalação. Um `DIRECT_EXITED` com código zero, uma falha de perfil, UAC,
permissão, driver ou processo não autoriza iniciar o serviço automaticamente;
esses casos devem limpar a tentativa e retornar a causa original.

Quando a compatibilidade for necessária, o script deve:

- reconhecer os nomes oficiais já suportados pelo código:
  `wiresock-client-service` e `wiresock-pro-client-service`;
- consultar o SCM e o `Win32_Service` depois de cada operação, sem assumir que a
  instalação terminou apenas porque o comando retornou;
- instalar somente se nenhum dos nomes existir;
- configurar o `PathName` para o perfil selecionado e conferir o valor efetivo;
- aguardar `STOPPED` antes de reconfigurar e `RUNNING` depois de iniciar;
- registrar `Win32ExitCode`, `ServiceSpecificExitCode`, estado, nome do serviço,
  caminho efetivo e código de saída;
- só devolver sucesso quando o serviço correto estiver ativo e o processo
  correspondente permanecer vivo;
- em qualquer falha, parar o que foi iniciado, limpar WFP/network lock e
  devolver um código estável, sem mostrar a mensagem genérica de reinstalação
  quando a causa real for UAC, driver, perfil ou timeout.

### 3. Estado e recuperação

O processo principal terá estados distintos:

- `preparing`: descoberta, validação e limpeza;
- `direct-starting`: execução do modo por aplicativo;
- `service-compatibility`: caminho excepcional de serviço;
- `active`: processo aceito e Discord protegido iniciado;
- `diagnostic-unverified`: ativo, mas sem fonte de handshake/contadores;
- `failed`: nenhum caminho aceito;
- `recovery-required`: há resíduo que não pôde ser removido com segurança.

`isWireSockActive()` não poderá ser a única prova usada para aceitar uma nova
ativação quando ele só observa SCM ou `tasklist`. A função deve distinguir
“processo encontrado” de “operação atual possui o PID/serviço esperado”.

O rollback será idempotente: fechar Discord, parar somente recursos criados pela
operação, resetar network lock quando necessário, remover perfil temporário e
validar que a rede normal voltou. O driver instalado permanece disponível para a
próxima ativação; a operação não o desinstala. Se a limpeza não puder ser
comprovada, a GUI deve pedir **Restaurar internet** e não iniciar uma segunda
tentativa por cima.

### 4. Observabilidade detalhada

O logger manterá a saída humana atual para compatibilidade, mas cada evento novo
de ativação terá campos estruturados e correlacionados:

- `app_session_id`: uma sessão da GUI;
- `operation_id`: ativação, desativação, troca de rota ou rollback;
- `attempt_id`: tentativa direta ou de compatibilidade;
- `phase`: preflight, profile, elevate, process, service, driver, discord,
  readiness ou cleanup;
- `event`: início, comando preparado, saída, mudança de estado, timeout,
  conclusão ou erro;
- `duration_ms`, `pid`, `service_name`, `exit_code`, `win32_code`,
  `service_specific_code`, `profile_fingerprint`, `config_size`,
  `allowed_apps_count`, `adapter`, `source` e `classification` quando
  aplicável.

Comandos e saídas devem ser registrados com redaction: caminhos podem ser
normalizados, mas argumentos que contenham senha, token, chave privada ou
segredo de sessão devem ser substituídos por `[redacted]`. Stdout/stderr de
helpers serão limitados por tamanho, anexados ao log persistente e vinculados ao
`attempt_id`. O log deve registrar explicitamente quando não foi possível obter
uma fonte de diagnóstico, em vez de omitir o dado.

### 5. Testes e critérios de aceite

A implementação deverá adicionar testes unitários para:

- classificação separada de `DIRECT_EXITED`, UAC, driver, perfil, serviço
  ausente, serviço alternativo e timeout;
- descoberta e seleção dos dois nomes de serviço;
- montagem segura de argumentos com espaços e caracteres especiais;
- não usar o serviço após uma falha direta que não seja “não suportado”;
- impedir sucesso quando o processo/PID encerra imediatamente;
- rollback idempotente e estado `recovery-required`;
- redaction de segredo, correlação de eventos e limites de stdout/stderr;
- localização, hash e manifesto do helper Proton;
- seleção exata do asset portátil no updater.

Validações obrigatórias antes de publicar:

- `npm test` e `npm run compile` em `golive-gui`;
- `go test ./...` em `tools/proton-confgen` quando o helper for tocado;
- build local Windows/Linux com `--publish never`;
- inspeção dos artefatos para confirmar helper, manifesto, nomes e hashes;
- teste Windows real com instalação existente, instalação ausente, serviço com
  cada nome suportado, modo direto, reinício, desativação e restauração;
- teste de atualização da versão estável e de beta sem downgrade e sem baixar
  um helper Proton como executável principal.

O lançamento só será considerado aprovado quando a imagem reproduzida deixar de
gerar o popup `[WIRESOCK_SERVICE]`, ou quando o log e a mensagem da GUI
mostrarem a causa real e o rollback comprovadamente restaurar a rede.

## Implementação registrada em 2026-09-08

Foram implementadas as primitivas de log correlacionado em
golive-gui/electron/logger.ts, a seleção exata do portable no updater, a
classificação WireSockDirectResult, a descoberta dos dois nomes de serviço e a
captura limitada de stdout/stderr do modo direto. A readiness Windows agora
registra início e conclusão como diagnóstico assíncrono.

Os testes unitários cobrem o caso DIRECT_EXITED: codigo=0, incompatibilidade
explícita, PID próprio, redaction, preflight, runtime Proton e asset do
updater. A compilação Linux foi validada; a matriz Windows permanece um gate
separado porque a VM estava ocupada durante esta sessão.

## Decisão registrada

A recomendação anterior de voltar ao serviço como caminho principal foi revisada
com a evidência da imagem. O modo por aplicativo continua sendo o caminho
principal; o serviço é apenas compatibilidade controlada. A próxima etapa é
implementar esta especificação sem tocar no standalone legado ou nas alterações
não relacionadas já presentes no worktree.
