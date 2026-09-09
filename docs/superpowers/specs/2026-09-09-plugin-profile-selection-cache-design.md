# Marcador de seleção do perfil Proton

Data: 2026-09-09

## Objetivo

Evitar que uma ativação Proton reutilize uma configuração WireGuard gerada com
preferências de seleção diferentes das atuais. O cache deve continuar privado,
sem armazenar credenciais ou tokens.

## Contrato

O arquivo privado `wireguard-profile-account.json` continuará sendo o marcador
do perfil gerado pelo Proton. Além de `schema` e `username`, ele conterá:

- `country`: lista normalizada de códigos de país, ou string vazia;
- `freeOnly`: se a seleção ficou restrita a servidores gratuitos;
- `autoPing`: se a seleção priorizou latência.

Na ativação, o controller só reutiliza `wireguard.conf` quando o marcador é
válido, pertence à mesma conta e coincide com os três valores normalizados da
configuração atual. Ausência, corrupção, schema diferente ou divergência força
uma nova geração. O `speedTest` continua fora do marcador porque não é uma
preferência persistente: é apenas o método usado durante uma otimização.

Otimização bem-sucedida grava o mesmo conjunto de valores efetivamente usado.
Importação customizada, troca de conta e logout continuam removendo o marcador.
WireSock externo, GUI, standalone e armazenamento de segredos não participam
desse fluxo.

## Verificação

O teste de fonte exigirá os campos no marcador, a comparação das preferências e
a passagem dos valores efetivos na geração. A suíte do plugin, o helper Proton,
o E2E do userplugin, `git diff --check` e o build/testTsc do checkout Windows
serão executados. A ativação Proton real permanece não validada quando a call
autorizada estiver ativa.
