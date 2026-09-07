# Instalação automática do runtime da GUI — Design

## Objetivo

Fazer com que a GUI prepare automaticamente os componentes necessários para a conexão WireGuard por aplicativo no Windows e no Linux, eliminando a dependência de instalação manual do `proton-confgen`, WireSock ou pacotes mínimos do sistema.

## Sintoma e escopo

O erro observado na GUI informa que o componente de conexão ProtonVPN não foi encontrado. O código já compila o `proton-confgen` e o coloca em `extraResources`, mas a resolução de caminhos é frágil e o erro final orienta reinstalação manual. O Windows já possui download autenticado por SHA-256 do WireSock; o Linux já tem um modo GUI `--ensure-dependencies`, porém ele só é acionado após um preflight específico.

O escopo desta mudança é:

- tornar a localização e a validação do `proton-confgen` robustas em desenvolvimento e pacote instalado;
- copiar o helper validado para um cache versionado do usuário e baixá-lo da release correspondente somente se o recurso empacotado estiver ausente ou corrompido;
- publicar os helpers Linux/Windows como assets auxiliares com hashes para o reparo automático;
- manter a instalação automática existente do WireSock via UAC;
- manter a instalação Linux limitada a `wireguard-tools`, `iproute2`/`iproute` e `curl`, usando `pkexec`/`sudo` e sem upgrade global;
- exibir progresso e erro acionável sem expor credenciais;
- não instalar o aplicativo ProtonVPN desktop, não alterar a rota global do host e não bloquear a ativação por probes geográficos.

## Arquitetura escolhida

Um módulo pequeno `proton-runtime.ts` concentrará resolução, validação, cópia atômica e download HTTPS dos helpers. `proton.ts` continuará sendo a API de domínio e chamará o runtime antes de login, consulta de sessão/plano, geração de perfil e medição. O recurso empacotado é a fonte primária; o download da mesma tag do GitHub é apenas fallback para reparar uma instalação incompleta.

O `build-proton.mjs` compilará os dois binários com flags determinísticas e gerará `proton-confgen-manifest.json` com versão, nomes dos assets e SHA-256. O workflow publicará os dois helpers auxiliares depois dos builds Windows/Linux. Assim, a GUI consegue verificar o conteúdo antes de executar qualquer binário baixado.

No Windows, o fluxo de ativação continua chamando `ensureWireSockInstalled`, que baixa o instalador oficial fixado, verifica o hash e abre UAC. No Linux, `linuxActivate` mantém o preflight somente leitura e chama `--ensure-dependencies` apenas quando a lista é conhecida e há elevação disponível. A instalação é limitada ao conjunto ausente e seguida de novo preflight.

## Fluxo de dados

1. Uma operação Proton solicita `ensureProtonConfgen(settingsDir)`.
2. O runtime procura o binário e o manifesto em `resources/extra`, ao lado do executável e nos caminhos de desenvolvimento.
3. Se o arquivo existir, verifica tamanho/hash quando houver manifesto, copia atomicamente para `GoLiveBypass/runtime/<versão>/` e retorna o caminho cacheado.
4. Se o recurso não existir ou falhar no hash, lê o manifesto empacotado e baixa o asset da tag `v<versão>` em `bezumiya/GoLiveBypass`, aceitando somente HTTPS e hosts oficiais de download do GitHub.
5. O download é gravado em arquivo temporário, validado por SHA-256, renomeado atomicamente e executado somente após a validação.
6. Falha de rede, asset ausente, cancelamento ou hash inválido retorna erro de runtime; a GUI não tenta executar um arquivo não validado.

## Segurança e permissões

- O helper baixado é limitado à release/versão em execução, ao nome previsto no manifesto e ao SHA-256 empacotado.
- Redirecionamentos ficam limitados a hosts GitHub permitidos e no máximo três saltos.
- Arquivos temporários e cache recebem permissões restritas no Linux; nenhuma senha Proton é escrita pelo runtime.
- UAC e `pkexec`/`sudo` só são acionados durante uma operação iniciada pelo usuário, nunca por watchdog ou probe diagnóstico.
- O instalador Linux não usa `-Sy`, não atualiza o sistema inteiro e recusa ambientes OSTree conforme o comportamento existente.

## Interface e erros

O login e as ações Proton mantêm o contrato atual. O usuário verá a operação em andamento pelos logs/progresso existentes; se o reparo não puder ser concluído, a mensagem explicará que o componente não pôde ser preparado automaticamente e pedirá nova tentativa com internet/elevação, em vez de recomendar uma reinstalação genérica.

## Testes e aceitação

- Testes unitários do runtime cobrem candidatos, manifesto, hash, versão, caminho de cache e rejeição de versão/path inválidos.
- Testes da GUI cobrem que todas as operações Proton garantem o runtime antes de executar o helper.
- Testes do standalone cobrem instalação idempotente, somente pacotes ausentes, famílias Debian/Fedora/Arch/openSUSE e proteção contra execução sem `GOLIVE_GUI=1`.
- `npm test`, `npm run check-bypass`, `npm run compile`, `go test ./...` em `tools/proton-confgen` e `bash -n standalone/golivebypass-standalone.sh` devem passar.
- A release será publicada em produção como beta `2.0.5-beta-8`, sempre prerelease e sem alterar `releases/latest`.
- A validação real de UAC e de reinício do executável exige Windows; a validação Linux real exige uma distribuição com o gerenciador suportado. Testes estáticos/mocks não substituem essas provas de plataforma.
