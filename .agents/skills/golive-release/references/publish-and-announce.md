# Publicação e aviso de release

## Contexto e seleção de destino

Siga os [repositórios de destino da skill](../SKILL.md#repositórios-de-destino): `bezumiya/GoLiveBypass` é produção e o padrão para releases beta/estável; `pdl-clay/GoLiveBypass` é destinado aos testes do sistema de release e update. O canal beta não implica usar o repositório de testes.

Confira `git remote -v`, autenticação `gh`, publisher do package.json e `REPO` do updater antes de publicar, alinhando tudo ao destino selecionado. Os comandos abaixo exemplificam produção; para testar, substitua `bezumiya/GoLiveBypass` por `pdl-clay/GoLiveBypass` em todos os comandos e confira também a configuração dos artefatos de teste.

O E2E histórico de setembro de 2026 usou o repositório de testes, branch `release/update-e2e-2.0.5`. Não restaure nem promova branches automaticamente. Preserve mudanças locais; prepare um checkout isolado quando necessário.

O ID `1539096128375619644` foi informado pelo usuário ao pedir avisos pela conta local. Seu tipo e o canal de avisos ainda precisam de confirmação. Não use esse número como canal sem evidência. O script não lê tokens do cliente Discord.

## Preparação

1. Defina repositório, plataformas, versão e commit. Siga o [padrão de versão da skill](../SKILL.md#padrão-de-versão): estável `2.x.x` (ex.: `2.0.6`), beta `2.x.x-beta-x` (ex.: `2.0.6-beta-1`). Tags acrescentam `v`. Confira releases existentes antes de escolher o contador beta; não sobrescreva tags/assets publicados.
2. Atualize package.json e package-lock.json coerentemente, notas e changelog. Confira diff e execute testes pertinentes. Build local usa `npm run build:win` ou `build:linux`, com publicação desabilitada. Leia scripts atuais antes de executar.
3. Confira que o executável/metadata corresponde à versão e commit desejados. Para releases multiplataforma, gere todos os artefatos solicitados; um exe isolado valida apenas Windows.
4. Prepare a tag exata apontando ao commit revisado e envie para o repositório autorizado. Não inclua alterações alheias só para limpar a árvore.

## Publicação

O workflow precisa existir na branch selecionada e seus publishers devem apontar ao mesmo repo. Confira a implementação atual: o input `canal` historicamente controla a classificação sem inferi-la da tag.

```bash
gh workflow run build-gui.yml --repo bezumiya/GoLiveBypass --ref BRANCH -f tag=v2.0.6-beta-1 -f canal=beta -F rascunho=true
gh run list --repo bezumiya/GoLiveBypass --workflow build-gui.yml --limit 5
gh run view RUN_ID --repo bezumiya/GoLiveBypass
```

Para estável use tag `v2.x.x` sem sufixo (ex.: `v2.0.6`) e `canal=stable`. Acompanhe o run correto até terminar; em falha parcial confira draft/assets antes de retentar. Confira o draft e publique quando autorizado. Beta exige `--prerelease --latest=false`; estável exige `--prerelease=false`, e `--latest` somente se for a versão estável mais recente pretendida.

Publicação manual é apropriada quando o pedido cobre apenas artefatos locais específicos. Crie primeiro draft com `gh release create TAG --repo bezumiya/GoLiveBypass --verify-tag --draft --notes-file NOTES ARTEFATOS`, acrescentando `--prerelease` para beta. Confira os assets e finalize com `gh release edit`. Não use `--clobber` como retentativa automática.

Após publicar, consulte `gh api repos/bezumiya/GoLiveBypass/releases/tags/TAG` e `gh api repos/bezumiya/GoLiveBypass/releases/latest`. Verifique tag, draft=false, prerelease, nomes/tamanhos/digests dos assets e downloads. Latest deve continuar estável ao publicar beta. Nunca anuncie sucesso só porque o upload iniciou.

## Teste do update Windows

Execute testes do sistema de release/update em `pdl-clay/GoLiveBypass`, com os artefatos consultando esse mesmo repositório. Quando pedido ou quando o updater mudou, use a skill `windows-vm-control`. Rode um portable anterior no canal adequado, publique candidato, clique em “Atualizar agora” e confirme no log download, digest, helper e nova inicialização. Teste também seleção estável/opt-in beta e ausência de downgrade. Não confunda o nome do arquivo portable, preservado na troca, com a versão exibida pelo app.

O E2E histórico, anterior ao padrão `beta-x`, validou beta.4 → beta.5 → 2.0.5, com canal stable na segunda etapa. A falha anterior era `EBUSY` ao renomear o próprio exe em execução. O helper deve trocar após o encerramento; não reintroduza troca antecipada. Um E2E feliz não comprova rollback sob antivírus, Unicode, falta de espaço ou update durante túnel ativo; reporte essas lacunas quando relevantes.

## Avisos no Discord

Gere texto a partir de uma release publicada (Node.js 18+ e `gh`):

```bash
node .agents/skills/golive-release/scripts/discord-announcement.mjs --repo bezumiya/GoLiveBypass --tag v2.0.5
node .agents/skills/golive-release/scripts/discord-announcement.mjs --repo bezumiya/GoLiveBypass --tag v2.0.5 --copy
```

`--copy` usa wl-copy ou xclip no Linux. Cole o texto no canal de avisos com a conta local desejada, depois de conferir conta, servidor e canal. O script não envia pela sessão local nem autentica uma conta com apenas seu ID. `--notes-file ARQUIVO` inclui um resumo revisado das mudanças; não copie changelogs extensos nem prometa plataformas sem assets.

Envio automático opcional: configure `DISCORD_WEBHOOK_URL` no ambiente local sem gravar segredos no repositório e informe o canal confirmado via `--channel ID --send`. O script confere o canal associado ao webhook antes do POST, desabilita menções e usa `wait=true`. A mensagem será de um webhook, não da conta pessoal. Não faz crosspost/publicação para servidores seguidores.

Depois do POST, guarde o ID retornado na entrega. Se houver timeout/erro ambíguo, confira o canal antes de retentar para evitar duplicata. Criar o script ou gerar uma prévia não autoriza enviar um anúncio real.

API consultada: https://docs.discord.com/developers/resources/webhook (Execute Webhook, wait e allowed_mentions).
