# Correção da regressão do updater e ativação Windows

Objetivo: impedir que o helper Proton substitua a GUI, inclusive recuperando
updates pendentes de versões anteriores, e investigar o erro WIRESOCK_SERVICE.

## Plano de execução

- [x] Conferir fonte/tag e assets publicados: beta 5 tem portable de 101703170
  bytes e confgen Windows de 14661120 bytes. Ambos são EXEs válidos; um hash
  correto do helper não comprova identidade de GUI.
- [x] Reforçar seleção, download, recuperação e aplicação; testar rejeição do
  helper mesmo com hash correto. Não depender apenas da extensão ou tamanho.
- [x] Revisar processo direto e compatibilidade WireSock, preservando isolamento
  por aplicativo e classificação de falhas reais.
- [x] Executar regressões e build local sem publicação.
- [x] Validar pacote/update e ativação na VM; registrar evidência e limitações.

Escopo: updater Windows e ativação WireSock da GUI. Sem mudança de rede global,
sem publicação em produção e sem mensagens em canais Discord. Alterações já
existentes no plugin/API/Proton devem ser preservadas e distinguidas do patch.

Checkpoint inicial: HEAD b65d82e, GUI 2.0.6-beta-5; VM win11 ligada.
Transporte offline: /tmp/golive-vm-share.gvV2vd.img, dispositivo sdc.
Artefatos/evidências locais: /tmp/golive-update-audit.58lLNT.

Atualização: 101 testes focados passaram. Na VM, identidade de GUI/confgen,
Unicode e contratos de processo passaram. Corrigidos também código de saída
perdido, espera do worker e fallback para comando diferente de `run`.
Revisão final do updater feita pelo modelo Luna, conforme preferência do usuário.
Concluídos: troca pelo helper real com hash correto, boot, ativação direta em
4559 ms (PID700), desativação e ausência de WireSock residual. Sem publicação.
Share temporário desmontado; evidências preservadas no diretório de auditoria.
