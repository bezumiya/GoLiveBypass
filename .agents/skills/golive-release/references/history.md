# Histórico dos canais de release

Referência migrada do AGENTS.md. Preserve o invariante beta = prerelease, mas confira o workflow atual: as proteções descritas dependem do canal informado e não tornam um disparo incorreto impossível. Exemplos 1.1.x são históricos.

## 9. Releases: canal beta = PRERELEASE, nunca "latest" (regra permanente)
Versões com sufixo, como `1.1.12-beta.7`, devem ser publicadas como prerelease. Em 30/08/2026, uma beta foi publicada como release normal e oferecida à base estável. As proteções abaixo reduzem o risco, mas dependem de inputs coerentes e conferência pós-publicação; não tornam um disparo incorreto impossível:

1. **Publicação:** tag (ex.: `v1.1.12-beta.7`) + `workflow_dispatch` do `build-gui.yml` com `canal=beta`. O workflow publica com `-c.publish.releaseType=prerelease` (windows e linux) e o job `beta-marcar` reforça `gh release edit --prerelease` e escreve a linha "**Canal: beta**" na nota da release (é a linha que o testador lê). No canal beta os jobs de macos e release-assets pulam (mac não tem updater; plugin/CLI não estão no ciclo de teste da GUI — e um `goLiveBypass-vencord.zip` beta numa prerelease poderia ser pego pelo updater do plugin).
2. **Consumo (opt-in):** toggle "Participar dos testes (canal beta)" nas configurações da GUI (settings `updateChannel`, default `stable`). **Windows** (updater próprio): `githubReleases()` varre `/releases?per_page=20` e `escolherRelease` (updater-channel.ts, semver com prerelease) escolhe a candidata de MAIOR versão com exe anexado — leitura VIVA a cada checagem de 4h, diálogo marca "(beta)". **Linux** (electron-updater): `autoUpdater.allowPrerelease = canal === "beta"` liga o canal `beta.yml` que o electron-builder publica sozinho para versão com prerelease (`detectUpdateChannel`) — lido no boot (o electron-updater checa uma vez por sessão). **macOS**: fora (updater desabilitado por falta de assinatura).
3. **Nunca downgrade:** desligar o toggle devolve ao estável na próxima release — `1.1.12` stable > `1.1.12-beta.7` pelo semver (a comparação antiga por string `latest !== current` ofereceria downgrade e foi removida).

Release estável: tag sem sufixo + `workflow_dispatch` com `canal=stable` (padrão). Testadores entram no ciclo recebendo a beta.7 na mão uma última vez; das próximas em diante o próprio app atualiza quem optou.
