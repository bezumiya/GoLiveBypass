---
name: golive-release
description: Preparar ou publicar releases do GoLiveBypass e corrigir empacotamento, atualização e canais stable/beta. Use para versões, artefatos e workflows de release; não para toda alteração de código ou documentação.
---

# Releases e canais

Determine se o pedido é preparar, publicar ou diagnosticar uma release. Inspecione versão, diff, tag/ref pretendida, `golive-gui/package.json`, `CHANGELOG.md` e `.github/workflows/build-gui.yml` a partir da raiz. Não presuma que a branch atual corresponde à tag.

## Repositórios de destino

- Produção (padrão): [bezumiya/GoLiveBypass](https://github.com/bezumiya/GoLiveBypass). Pedidos de release beta ou estável usam este repositório, salvo indicação explícita de teste ou outro destino.
- Testes de release e update: [pdl-clay/GoLiveBypass](https://github.com/pdl-clay/GoLiveBypass). Use quando o pedido for testar publicação, distribuição ou atualização, inclusive ciclos E2E.
- Destino e canal são escolhas independentes: uma beta de produção vai para `bezumiya/GoLiveBypass`; um teste do canal estável vai para `pdl-clay/GoLiveBypass`.
- Antes de publicar, confira remote Git, destino explícito de `gh --repo`, publishers e origem consultada pelos updaters. Todos devem corresponder ao ambiente escolhido; não deduza produção pelo nome `origin` nem reutilize configuração de teste em artefatos de produção. O destino padrão não autoriza publicação por si só.

## Preparar

### Padrão de versão

- Estável: `2.x.x`, por exemplo `2.0.6`; tag `v2.0.6`, `canal=stable`, sem prerelease.
- Beta: `2.x.x-beta-x`, por exemplo `2.0.6-beta-1`; tag `v2.0.6-beta-1`, `canal=beta`, sempre prerelease e nunca latest. Use hífen antes do contador, não ponto (`beta.1`).
- Os `x` representam números inteiros sem zeros à esquerda; o contador beta começa em 1 e aumenta a cada beta da mesma versão base. Confira as versões existentes para não reutilizar números. Ao lançar a estável correspondente, remova o sufixo: `2.0.6-beta-2` → `2.0.6`.
- Use a mesma versão em package.json, package-lock.json, notas, nomes dos artefatos e avisos; a tag Git acrescenta apenas o prefixo `v`. Exemplos históricos com outro formato não são modelo para novas releases; preserve tags já publicadas.
- Antes da primeira publicação nesse formato, confira a detecção do canal e a ordenação nos updaters/builders: SemVer trata `beta-10` como um identificador textual e o ordena abaixo de `beta-9`. Valide a transição entre formatos e o contador com dois dígitos; não suponha que a comparação atual ou a geração de `beta.yml` já atendam ao padrão.

Leia só a referência do modo necessário: preparação simples usa este arquivo; publicação/aviso usa o procedimento operacional; incidentes antigos usam o histórico. Registre repo, commit, versão, canal e plataformas antes do build. Reutilize artefatos verificados desse mesmo código/versão; mudança de versão exige novo build. Alteração só documental não exige repetir build/testes de app.

- Mantenha tag, versão e notas consistentes. Qualquer sufixo de prerelease exige `canal=beta` e publicação como prerelease; versão estável usa `canal=stable`. Recuse combinações inconsistentes antes do disparo. As condições atuais do workflow dependem do input: não há garantia automática de que uma tag beta receba o canal certo.
- Confira o script de build antes de executá-lo. `npm run compile` na GUI gera o bypass embutido e compila o helper Go; exige os toolchains correspondentes. Use `build:*` com `--publish never` para produzir artefatos locais. `publish:*` publica de verdade e não é verificação local.
- Preserve no canal beta a exclusão dos jobs macOS e release-assets conforme o workflow, evitando oferecer assets beta ao updater do plugin.
- Para mudanças no updater, valide seleção semver, opt-in beta e ausência de downgrade. Windows usa updater portable próprio; Linux usa electron-updater; confira o suporte atual de macOS antes de prometer atualização automática.
- Compatibilidade com clientes antigos: somente a GUI pode usar `GoLiveBypass-*.exe` nos assets. Helpers Windows usam `proton-confgen-<versão>-win-x64.exe`, conforme o manifesto. Teste a seleção antiga por prefixo/extensão com o helper antes da GUI; validar apenas o seletor novo não protege a migração. Não aceite pendências antigas apenas pelo hash: confira identidade e estrutura portable antes de aplicar, e preserve `.old` até o boot da nova GUI.
- Execute testes afetados, confira sincronização com `npm run check-bypass` e registre limitações de plataforma. Não transforme toda preparação em um teste completo com VM: dimensione a validação às mudanças e ao pedido.

## Publicar quando autorizado

Prepare primeiro versão, notas e evidência para revisão. Se a autorização de publicação já estiver na conversa, prossiga sem nova confirmação; se o pedido cobrir só preparação, entregue os artefatos/diff e a ação que falta autorizar.

Use a tag exata no `workflow_dispatch` de `build-gui.yml` com o canal correspondente. Para conferir todos os artefatos antes de publicar, use `rascunho=true`; depois dos jobs e da conferência, publique o draft quando já autorizado. Após a execução, confira os resultados dos jobs, assets esperados, estado draft/prerelease e a resposta de `/releases/latest`. Para beta, verifique que latest continua estável. Em falha parcial, inspecione o estado remoto antes de repetir; não promova beta nem sobrescreva outra versão para contornar erro.

Entregue versão/canal, validação realizada e, se publicada, link e resultado dos artefatos. Distinga build local de publicação confirmada.

Em trabalhos longos, registre commit, hashes/caminhos dos artefatos, tag, run ID, fases concluídas e próxima ação. Ao retomar, confira o estado remoto antes de repetir uma mutação. Encerre quando artefatos, metadados/canais e testes pedidos estiverem conferidos; não publique novas versões só para repetir um teste aprovado.

Consulte [o histórico dos canais](references/history.md) apenas para entender os incidentes antigos e decisões de compatibilidade.

## Procedimento reutilizável beta/estável e avisos

Para lançar versões e preparar avisos, leia [o procedimento operacional](references/publish-and-announce.md). Ele registra o fork usado nos testes, comandos de publicação e a validação Windows do helper pós-saída.

Use `scripts/discord-announcement.mjs` desta skill para gerar o aviso de uma release publicada. Por padrão só imprime texto; `--copy` copia para envio manual pela conta local. `--send` envia por webhook e exige autorização de anúncio na conversa. Publicar uma release não implica anunciar no Discord. Nunca derive o canal de um ID de conta: confirme os identificadores separadamente.
