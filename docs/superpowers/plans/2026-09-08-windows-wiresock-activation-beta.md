# Plano: robustez da ativação WireSock no Windows

**Spec:** Relato do usuário e captura de tela do erro de ativação WireSock no Windows.

## Objetivo

Investigar o caminho real de ativação da GUI Windows, corrigir falhas recorrentes de serviço, elevação, configuração e inicialização do WireSock, melhorar o diagnóstico exibido ao usuário e preparar uma nova versão beta após validação automatizada e na VM Windows.

## Escopo e restrições

- Manter o isolamento por aplicativo via WireGuard/WireSock e a restauração da rede.
- Não converter probes de IP/HTTP/telemetria em bloqueios de ativação.
- Não alterar o caminho legado, o plugin independente ou o app.asar.
- Não armazenar credenciais nem ocultar falhas reais de permissão/UAC.
- Publicar a versão com sufixo beta como prerelease no repositório de produção, sem substituir a release estável.

## Etapas

### 1. Mapear e reproduzir

- Ler a implementação de `wiresock.ts`, `wiresock-service.ts` e o chamador em `main.ts`.
- Identificar todos os pontos que podem produzir a mensagem genérica: UAC cancelado, serviço preso em transição, caminho do serviço divergente, driver indisponível, perfil inválido e timeout de inicialização.
- Conferir os testes existentes e observar o estado do serviço e dos drivers na VM Windows sem modificar a rede do host.

### 2. Corrigir o ciclo de serviço

- Tornar a execução elevada e a configuração do serviço idempotentes.
- Fazer o script elevado aguardar estados reais do serviço, capturar códigos de saída e distinguir falha de instalação, inicialização, timeout e permissão.
- Aplicar somente uma recuperação limitada e segura para serviço WireSock pertencente à GUI, mantendo rollback quando a ativação não concluir.
- Preservar a serialização do ciclo de vida e a lista de aplicativos permitidos.

### 3. Corrigir diagnóstico e regressões

- Propagar uma mensagem segura e acionável para a interface e logs, sem vazar comandos ou credenciais.
- Adicionar testes unitários para classificação/propagação de erros, idempotência do serviço e manutenção do rollback.
- Executar os testes direcionados, a suíte da GUI e a compilação completa.

### 4. Validar na plataforma afetada

- Construir uma versão beta local sem publicar.
- Instalar/executar a build na VM Windows, ativar com os clientes instalados e repetir o ciclo após reiniciar/parar o serviço para confirmar recuperação.
- Coletar logs e verificar que a ativação bem-sucedida mantém o escopo por aplicativo e que uma falha não deixa a rede em estado parcial.

### 5. Preparar e publicar a beta

- Incrementar a versão para o próximo `2.0.6-beta-*` disponível e registrar o caso no changelog.
- Conferir workflow, repositório de produção, artefatos e hashes.
- Criar tag e executar o workflow de build como prerelease rascunho; publicar somente após os checks concluírem.
- Confirmar que `v2.0.5` continua sendo a release Latest e que a nova beta é a candidata do canal beta.

## Critérios de aceite

- A ativação Windows deixa de falhar silenciosamente com a mensagem genérica quando o problema é diagnosticável.
- Serviço e configuração podem ser reaplicados sem acumular processos/estados obsoletos.
- Falhas não deixam WireSock ou a rota parcialmente ativos.
- Testes e build passam; a VM confirma ativação e recuperação.
- A beta é publicada como prerelease no repositório de produção, sem alterar o Latest estável.
