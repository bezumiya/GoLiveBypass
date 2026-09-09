# Regressão do updater portable — investigação de 2026-09-09

## Causa e evidência

A beta 5 publicada contém a GUI correta: `GoLiveBypass-2.0.6-beta-5.exe`,
101703170 bytes, SHA-256
`9d7fb5849986153338e2d2a34edf99396206bfd44b340178e6780a6dcbf4961c`.
Download e extração NSIS/7z concluíram sem erro; `app.asar` declara beta 5 e
inclui o seletor de nome exato. Não é correto afirmar que esse seletor sumiu
do pacote beta 5.

O log coletado na VM mostra a origem real de um download errado:

```text
[21:38:17] updater verificando versao 2.0.6-beta-3 no canal beta
[21:38:18] candidata 2.0.6-beta-4 encontrada
[21:38:21] download concluido: 14661120 bytes
```

O tamanho coincide com o asset confgen Windows. O seletor histórico aceitava
o primeiro `GoLiveBypass-*.exe`; o helper também ocupava esse namespace.
Corrigir somente o cliente novo não protege a atualização iniciada pelo antigo.

## Proteções implementadas

1. Helpers futuros usam `proton-confgen-<versão>-win-x64.exe`; manifesto e
   workflow geram o mesmo nome. Teste usa o seletor antigo em ambas as ordens.
2. Identidade do portable liga nome, repositório, tag, URL, tamanho e digest.
3. Bytes devem conter PE GUI e header NSIS no overlay; hash correto de helper
   renomeado continua sendo rejeitado. Tamanho sozinho não decide identidade.
4. Download, recuperação de pending e aplicação reconferem os requisitos.
   Pendências antigas sem identidade são invalidadas. O `.old` só é limpo
   no boot da GUI nova, não antes de lançá-la.
5. Comparação normaliza `beta-N` para contador numérico, incluindo 9 → 10.

Estas mudanças não corrigem retroativamente um EXE já substituído por helper
na máquina do usuário: nesse caso é necessário baixar manualmente a GUI.
Nenhum asset remoto antigo foi renomeado/removido durante esta investigação.

## WireSock

Identificado UTF-8 sem BOM nos scripts `-File` das betas. O Windows PowerShell
5.1 interpretou incorretamente o controle com caminho Unicode na VM; com BOM,
preservou o texto. Corrigidos também escape `\\s+` e preservação de códigos SCM.
A imagem é evidência do erro genérico, mas não identifica a causa naquela
máquina. Não atribuir todos os erros WIRESOCK_SERVICE a caminhos Unicode.

O teste Windows revelou ainda `DIRECT_EXITED: codigo=` vazio, que não apareceu
nos mocks Linux. Preservar o handle permitiu obter os códigos 0 e 7 reais.
Também reproduziu espera pelo fim do processo ao capturar stdout/stderr. O
wrapper agora aguarda um resultado próprio, publicado atomicamente, enquanto
o worker mantém a captura. O classificador só autoriza compatibilidade para
`run` explicitamente desconhecido: erro genérico em outra opção/comando não
autoriza iniciar o serviço.

## Checkpoint de validação

- 101 testes focados passaram após os ajustes de handle, worker e fallback.
- Na VM, runner com a validação real aceitou GUI publicada de 101703170 bytes e
  recusou confgen de 14661120 bytes, inclusive com hash correto (exit 0).
- Controle Unicode sem BOM falhou; com BOM passou. Contratos de exit 0, exit 7,
  processo persistente/PID e classificação passaram no Windows com exit 0.
  Não equivalem a teste de driver ou tráfego real.
- VM win11; transporte FAT temporário `/tmp/golive-vm-share.gvV2vd.img` (sdc).
- Evidências privadas em `/tmp/golive-update-audit.58lLNT`; não publicar logs
  brutos ou perfis. Build local mantém versão beta 5 apenas para laboratório.
- Sem publicação nova em produção. Não foi disparado SSE/release externo.

Troca local na VM: o helper de substituição de produção foi executado contra
o portable de teste que estava aberto. Após encerrar somente aquela instância
(sem túnel ativo), o helper instalou os bytes corrigidos e abriu a GUI. A
comparação do hash no destino retornou `ReplacementHashMatches=True`; os
contratos Windows foram repetidos com o código final e retornaram `Exit=0`.
Isso valida troca/reabertura local, não uma nova publicação/SSE em produção.

Ativação real da GUI corrigida: em 03:13:40, `process.result` registrou
`mode=direct result=running pid=700 duration_ms=4559`, seguido de
`activation.accepted`, operação `wiresock-activation-fb0c4f01-8498-41fa-8972-4422a46c4209`.
A coleta de processos confirmou WireSock PID 700 e serviço global `Stopped`.
A GUI exibiu **Desativar Bypass**, sem WIRESOCK_SERVICE e sem card de atualização
(nenhuma versão posterior oferecida). O hash do portable instalado corresponde
ao pacote corrigido, e `.old` já havia sido limpo após o boot. Screenshot:
`/tmp/win11-active-gui.png`. Esta evidência comprova ativação/processo; não prova
geolocalização, upload em canal Discord ou todos os ambientes dos usuários.

Desativação solicitada pela GUI: operação de 03:16:15 a 03:16:45. Coleta às
06:17:43 UTC confirmou **nenhum processo wiresock-client**, serviço global
parado e o mesmo hash corrigido. A VM ficou sem túnel de teste ativo. A imagem
do usuário não foi reproduzida literalmente; foram reproduzidos e corrigidos
defeitos do caminho de ativação e validado o ciclo real neste ambiente.

Pacote local corrigido para o laboratório: 101114036 bytes; SHA-256
`45aca5809be0454e07fba33745a9a5aceb63917db211260d8ac8104ba76a6c82`.
Foi compilado da árvore de trabalho (inclui alterações anteriores preservadas),
não representa uma release publicada ou um commit limpo. O helper local tem
15036416 bytes; é diferente do helper publicado de 14661120 bytes.

## Repetir as regressões sem publicar

Em `golive-gui/`:

```sh
npm test -- tests/updater-identity.test.ts tests/updater-channel.test.ts tests/updater-replace.test.ts tests/proton-packaging.test.ts tests/proton-runtime.test.ts tests/wiresock.test.ts tests/wiresock-preflight.test.ts tests/wiresock-installation.test.ts
./node_modules/.bin/esbuild tests/windows-wiresock-contract.cjs --bundle --platform=node --format=cjs --outfile=/tmp/wiresock-contract.cjs
./node_modules/.bin/esbuild tests/updater-portable-cjs.ts --bundle --platform=node --format=cjs --outfile=/tmp/updater-contract.cjs
```

Transfira os bundles para a VM conforme a skill. Em PowerShell administrativo,
execute `node wiresock-contract.cjs` (fake executable, sem tocar serviços reais)
e `node updater-contract.cjs GUI.exe proton-confgen.exe` (somente leitura).
O primeiro cria um diretório temporário próprio, compila um executável inofensivo
e preserva o relatório; nunca forneça um executável WireSock real como fake.
O segundo usa arquivos reais para testar identidade, PE/NSIS, truncamento e hash.

O workflow Windows agora executa as regressões do updater/empacotamento antes
de publicar, para impedir a reintrodução silenciosa de nomes conflitantes.
