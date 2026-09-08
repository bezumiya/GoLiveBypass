# Incidente: paridade do helper Proton na beta 2.0.5-beta-10

## Resumo

A release `v2.0.5-beta-10` não estava corrompida. O AppImage e o instalador Windows tinham hashes iguais aos digests registrados no GitHub, e os containers internos passaram no teste estrutural. Porém, o manifesto incluído na GUI esperava um hash diferente para o helper Proton Windows publicado separadamente.

## Sintoma observado

- Manifesto embutido em `resources/extra/proton-confgen/proton-confgen-manifest.json`:
  - Linux: `dbc58a2ad88ec978f28dbd0097a1e07fe02bf2602e150c128fea703944b42aff`
  - Windows: `d9bbe0cb90e99d19f537410699593ff29aba0fe472224fc0a992a31f093decd4`
- Helper Windows publicado em `v2.0.5-beta-10`:
  - `1df3fbaa051fdd9ae021bd0fdbe6dbc1b5f7bbb064e9332441f988352383d2f7`

O hash oficial do asset publicado e o arquivo `.sha256` conferiam entre si. Portanto, o problema era de paridade de build, não de download ou corrupção do instalador.

## Causa raiz

O job `proton-runtime-assets` criava o helper Linux dentro do checkout e depois compilava o Windows. O arquivo Linux recém-criado deixava o checkout com mudanças não rastreadas. O Go gravava essa diferença no metadado VCS do segundo binário como `vcs.modified=true`; o helper Windows embutido na GUI tinha sido compilado antes, com `vcs.modified=false`.

Os bytes dos binários ficaram diferentes mesmo com o mesmo código, flags e versão. O manifesto foi calculado a partir da cópia limpa embutida na GUI, enquanto o asset de reparo publicado veio da cópia marcada como modificada.

## Correção permanente

1. `golive-gui/scripts/build-proton.mjs` compila ambos os targets com `-buildvcs=false`, além de `-trimpath` e `-ldflags=-s -w -buildid=`.
2. O job `proton-runtime-assets` reutiliza as saídas desse script, em vez de manter uma segunda receita de compilação.
3. Antes do upload, o job compara a versão e os SHA-256 dos assets versionados com `proton-confgen-manifest.json`; qualquer divergência interrompe o job.
4. O teste `proton-packaging.test.ts` verifica a presença da flag determinística e do contrato de validação no workflow.

## Critério para releases futuras

Uma beta só pode ser publicada depois de:

- o build local gerar manifesto com os dois targets;
- o workflow concluir a comparação manifesto/asset;
- os assets GUI e helpers terem nomes da mesma versão/tag;
- os testes de empacotamento passarem;
- o asset Windows e o AppImage baixados da release passarem por hash e teste estrutural.

A `v2.0.5-beta-10` permanece registrada como beta com esse incidente histórico; a correção deve entrar em uma nova tag, sem sobrescrever a release existente.
