# Proteção do pulso SSE e seleção segura do updater Windows

## Contexto

A API de updates em produção usa webhook e polling do GitHub. O broker guarda
um único evento para replay em novas conexões. Como os dois caminhos podem
chegar fora de ordem, um webhook atrasado de uma release antiga pode substituir
o pulso mais novo. No cliente Windows, cada release também carrega o executável
portable e um helper Proton com cerca de 14 MB; selecionar por prefixo pode
baixar o helper como se fosse a GUI.

## Objetivos

- Impedir que o broker SSE publique ou faça replay de uma tag inferior à mais
  recente aceita, independentemente da ordem webhook/polling.
- Fazer o poller escolher a maior versão SemVer válida, e não somente a data de
  publicação retornada pelo GitHub.
- Selecionar no Windows exclusivamente o asset cujo nome seja exatamente
  `GoLiveBypass-<tag sem v>.exe`.
- Manter a verificação SHA-256 antes de persistir uma atualização pendente.
- Cobrir as duas falhas com testes automatizados e validar o endpoint real e o
  artefato publicado.

## Desenho

O pacote `api/internal/updates` terá um comparador SemVer pequeno, alinhado ao
formato aceito pelo parser de tags: versão base numérica e identificadores de
pré-release, com `beta-9` normalizado para a mesma sequência de `beta.9`.
`Broker.Publish` registra o delivery, rejeita duplicatas e rejeita eventos cuja
tag seja menor ou igual à tag atual; somente uma tag maior substitui `latest` e
é enviada aos clientes. Assim, um evento atrasado não pode rebaixar o replay.

O `ReleasePoller` continuará fazendo baseline silenciosa no primeiro poll, mas
selecionará a maior tag válida entre as releases públicas não-draft. O webhook
continua sendo caminho imediato, e o broker mantém a proteção caso os caminhos
discordem.

No updater, a função pura de seleção compara o nome completo do asset com a tag
normalizada. O download continua validando o digest SHA-256 fornecido pelo
GitHub antes de criar o marcador pendente; o helper Proton não satisfaz o nome
exato e portanto não entra no fluxo.

## Erros e compatibilidade

Eventos duplicados, atrasados ou de mesma versão serão ignorados sem erro HTTP
para o GitHub. O SSE mantém o contrato atual e continua público; o cliente
segue consultando a release diretamente para obter URL, asset e digest. A
correção não altera o canal stable/beta nem o isolamento do updater.

## Validação e rollout

- `go test ./...` no diretório `api`.
- Testes do seletor e do marcador do updater.
- `npm run compile` e `npm run check-bypass` no `golive-gui`.
- `curl` no SSE de produção, confirmando `v2.0.5-beta-12` e ausência de
  downgrade para beta-9.
- Conferência do asset Windows publicado: hash do GitHub e teste estrutural do
  instalador, além de separar o helper de 14 MB.

A publicação de uma nova beta não faz parte desta implementação; fica para
uma ordem explícita após os testes.
