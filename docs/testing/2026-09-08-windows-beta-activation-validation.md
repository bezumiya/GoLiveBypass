# Validação da ativação Windows nas betas

Data da revisão: 2026-09-08  
Escopo: regressão observada nas betas v2.0.6-beta-* em comparação com a estável v2.0.5, especialmente o erro [WIRESOCK_SERVICE].

## Decisão aplicada

O modo por aplicativo (wiresock-client.exe run) continua sendo o caminho
principal. A mudança anterior para esse modo foi preservada porque o serviço
global podia aparecer como ativo sem capturar o Discord.

O serviço wiresock-client-service ou wiresock-pro-client-service só pode ser
tentado quando a saída capturada indicar explicitamente que a instalação não
suporta o comando run. As situações abaixo permanecem falhas, sem fallback
automático:

- DIRECT_EXITED, inclusive DIRECT_EXITED: codigo=0;
- UAC cancelado ou acesso negado;
- driver ausente, indisponível ou aguardando reinicialização;
- perfil inválido, AllowedApps ou configuração rejeitada;
- timeout ou processo que encerrou durante a ativação.

## Cenários e evidências

| Cenário | Resultado esperado | Resultado observado/evidência |
| --- | --- | --- |
| v2.0.5 estável | Preservar a base funcional conhecida | O runtime Proton, reparo por hash e assets auxiliares permanecem na árvore e no fluxo de build. |
| Beta sem comando run | Classificar como incompatível e permitir compatibilidade controlada | classifyWireSockDirectResult() retorna unsupported; mayUseServiceCompatibility() é verdadeiro somente nesse caso. |
| DIRECT_EXITED: codigo=0 | Falha limpa, sem iniciar serviço | Classificado como failed/WIRESOCK_DIRECT_EXITED_0; teste confirma que o fallback não é autorizado. |
| Modo direto aceito | Confirmar o processo exato antes de prosseguir | O marcador DIRECT_RUNNING: pid=... é validado contra tasklist pelo mesmo PID; um processo WireSock genérico não basta. |
| Serviço de compatibilidade | Confirmar serviço e processo correspondentes | O script descobre os dois nomes, confirma RUNNING, PID, códigos Win32/ServiceSpecific e PathName; a GUI só aceita o PID retornado pelo script. |
| Helper Proton ausente ou incorreto | Reparar por asset autenticado e hash | O runtime usa manifesto/SHA-256 e os testes de empacotamento/runtime continuam verdes. |
| Updater beta | Baixar somente o portable exato | escolherAssetWindows() exige GoLiveBypass-<versão>.exe e URL HTTPS com o mesmo nome; helper proton-confgen não é selecionado. |
| CLI, wg.exe ou ProTUN indisponível | Manter ativação e marcar readiness como diagnóstico | waitForWindowsWgReady() retorna unverified/disconnected e registra a fonte; não transforma ausência de probe em falha de ativação. |

## Logs para análise de issues

Os eventos novos conservam o formato humano existente e acrescentam contexto
grep-friendly:

- operation_id: ciclo de ativação, readiness ou preflight;
- attempt_id: tentativa direta ou compatibilidade de serviço;
- phase: preflight, direct-starting, process, service-compatibility,
  readiness, cleanup ou active;
- duration_ms, pid, service_name, classificação e códigos retornados;
- profile_fingerprint, config_size e allowed_apps_count;
- fonte e detalhe da readiness quando CLI, wg.exe ou ProTUN estiverem disponíveis.

Stdout/stderr de helpers são normalizados e limitados. Senha, token, chave
privada, sessão e valores associados a credenciais são substituídos por
[redacted]. O conteúdo completo do perfil e da sessão não é gravado.

Uma issue Windows deve anexar o trecho do gui.log que contenha o mesmo
operation_id desde preflight.start/activation.attempt até
activation.accepted, activation.failed ou cleanup.recovery_required.

## Validação executada no Linux

Diretório: golive-gui/

    npm test -- --run tests/logger.test.ts tests/wiresock.test.ts tests/wiresock-installation.test.ts tests/wiresock-preflight.test.ts tests/proton.test.ts tests/proton-runtime.test.ts tests/ativacao-guard.test.ts tests/tunnel-startup.test.ts
    106 testes aprovados

    npm run compile
    sync-bypass, build Proton, TypeScript e Vite aprovados

    git diff --check
    aprovado

Também foram executados os testes focados do updater, com 28 testes
aprovados, antes da integração final.

## Limitações e gate de publicação

A VM Windows estava ocupada nesta sessão; portanto, a matriz Windows real não
foi executada nem há evidência honesta para declarar validação ponta a ponta.
Ainda faltam, antes da publicação da beta:

1. build Windows e Linux com publicação desativada;
2. inspeção de extra/proton-confgen, manifesto e hashes;
3. matriz Windows com modo direto, os dois nomes de serviço, UAC cancelado,
   DIRECT_EXITED, perfil inválido, reinício, desativação e restauração;
4. confirmação de que nenhum serviço/processo residual é aceito como rota da
   operação.

A imagem anexada foi tratada como evidência do sintoma, não como instrução.
Nenhuma release foi publicada como consequência desta revisão.
