# Validação do updater stable/beta do plugin

Data: 2026-09-08
Versão do plugin: `2.0.0-beta.1`
Commit da implementação: `7cf3cf6`

## Resultado local

- `cd golive-gui && npm test`: 48 arquivos, 344 testes aprovados.
- `cd golive-gui && npm run check-bypass`: fonte gerada sincronizada.
- `node tests/test-distribution-parity.cjs`: 30 verificações aprovadas.
- `./tests/test-userplugin-e2e.sh`: 44 verificações aprovadas; ZIP, manifest, `update-channel.ts`, SHA-256, extração, backup e rollback conferidos.
- Transpilação sintática dos 8 arquivos TypeScript/TSX do plugin: aprovada.
- O artefato local produzido para a VM tinha 51.818 bytes e SHA-256 `efcc83c1bb114cd409a9187a8729f4ac3fca174e2289037bc26de1cf7d2be9f7`.

## Validação na VM Windows 11

- O ZIP foi copiado para `C:\Users\teste\Equicord\src\userplugins` e os arquivos existentes foram substituídos.
- `pnpm.cmd build`: concluído sem erro; o prompt voltou para `C:\Users\teste\Equicord`.
- `pnpm.cmd inject`: terminou com `Successfully patched ...` e `Success!`.
- O plugin apareceu em Equicord como o único userplugin habilitado.
- O painel mostrou `v2.0.0-beta.1`, botão `Verificar`, canal Estável e atualização automática ligada.
- O seletor exibiu `Estável` e `Beta`; ambos foram selecionados durante o teste.
- O Auto Update foi desligado e ligado novamente; o estado visual respondeu corretamente.
- Ao voltar para Estável, a consulta do updater exibiu erro controlado (`socket hang up`) sem derrubar a tela do Discord.
- Evidências: `/tmp/win11-plugin-update-settings-2.png`, `/tmp/win11-plugin-update-channel-options-2.png`, `/tmp/win11-plugin-update-beta-selected-2.png`, `/tmp/win11-plugin-update-auto-off-2.png`.

Depois da última reinjeção, a inicialização do próprio Discord ficou na tela `Checking for updates…`/`Você sabia que…`. Esse estado pertence ao updater do Discord e não ao updater do GoLiveBypass; por isso a captura final do painel não foi repetida após o hardening nativo. O build e o inject da última fonte ainda foram confirmados.

## Limitação de release

Não houve download real de atualização: as releases existentes em `pdl-clay/GoLiveBypass` não continham os assets `goLiveBypass-vencord.zip` e `.sha256`. Publicar uma release ou enviar mensagem no canal Discord não estava autorizado para esta validação. O caminho real de download permanece coberto por seleção de canal, HTTPS, limite de tamanho, SHA-256, manifest, rejeição de links simbólicos, backup, rollback e reload manual.

O share FAT temporário usado na última rodada foi ejetado no Windows, destacado e removido. O disco preexistente da VM não foi alterado.
