# Design: overlay de falha automática do updater do plugin

## Problema

O processo principal já expõe `lastError` no status do updater. Porém, o plugin só
mostra esse dado no card de configurações; a checagem automática de inicialização
não abre o card e só notifica atualizações pendentes. Uma falha pode, portanto,
ficar silenciosa para quem está usando o Discord normalmente.

## Decisão

Adicionar um toast customizado de falha no rodapé do Discord, acionado somente por
um `lastError` real retornado pelo status do updater. O card exibirá versão atual,
canal e uma mensagem sanitizada/truncada. O toast terá ação de dispensa, não abrirá
janela, não reiniciará o Discord, não chamará o backend privilegiado e não roubará
foco.

As notificações serão deduplicadas por canal, versão atual e texto do erro. O
deduplicador será limpo quando uma consulta posterior não tiver erro, permitindo
avisar novamente se a mesma falha ocorrer depois de uma recuperação.

## Fluxo e limites

- `refreshStatus()` notifica o erro quando o card consulta o status.
- O polling de inicialização notifica o mesmo estado quando não há card montado.
- A ação `Depois` apenas fecha o toast; tentar novamente continua sendo feito pelo
  card de configurações ou pela ação manual existente.
- Falhas do botão manual continuam usando o feedback já existente, evitando dois
  toasts para a mesma exceção local.
- `lastError` permanece diagnóstico do updater; não altera ativação da VPN, rota,
  sessão Proton, chamada ou transmissão.

## Aceitação

- O teste-fonte verifica contexto, deduplicação e uso pelos dois pontos de polling.
- O toast não contém `restartDiscord`, `Native.enable`, `Native.shutdown` ou
  encerramento automático.
- A suíte do plugin, o helper Proton, o E2E do userplugin e o build Windows passam.
- O comportamento será validado na VM com `testTsc` e `build`, sem reiniciar uma
  call/transmissão ativa.
