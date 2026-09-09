# Plugin Runtime Hardening Design

**Data:** 2026-09-09
**Escopo:** plugin Vencord/Equicord WireGuard do GoLiveBypass
**Estado:** aprovado para implementação nesta rodada

## Contexto

O pacote atual já compila, injeta e abre o Discord oficial na VM Windows. O plugin também exibiu o painel de atualização e preparou uma atualização estável pendente sem aplicá-la automaticamente. A investigação dos três blocos encontrou riscos residuais de ciclo de vida, consistência do updater e interpretação de estado da rota. Esses riscos podem produzir UI presa, estado antigo apresentado como atual ou diagnóstico incorreto; não são autorização para trocar a arquitetura WireGuard por proxy/Tor nem para bloquear ativação com probes.

O sintoma do Discord oficial deve ser tratado em duas camadas:

1. inicialização e injeção do cliente oficial (launcher, build e carregamento do plugin);
2. transmissão/rota depois que o cliente está aberto.

Evidência de uma camada não prova a outra. A última execução confirmou a primeira, enquanto o A/B de transmissão mostrou correlação entre túnel ativo e vídeo, mas também incluiu o reinício que `enable()` faz. O próximo ciclo deve registrar essa limitação, não transformar a correlação em causalidade exclusiva.

## Objetivos

- Nunca deixar o onboarding obrigatório ou o painel de atualização preso por uma chamada IPC/native sem prazo.
- Não permitir que uma resposta antiga de polling, diagnóstico ou operação substitua o estado de uma geração mais nova.
- Expor claramente canal, versão e erro do updater, preservando evidência de uma atualização pendente quando a recuperação não for possível.
- Diferenciar estado WireSock confirmado, estado desconhecido e ausência confirmada.
- Evitar falsos positivos no alerta de transmissão quando a observação ficou desconhecida.
- Preservar isolamento por aplicativo, restauração de rede, modo de diagnóstico log-only e independência do plugin em relação à GUI/standalone.

## Fora de escopo

- Login Proton real, 2FA/CAPTCHA, seleção de gateway fresco ou prova geográfica de saída; esses fluxos continuam como validação E2E pendente.
- Alteração do `app.asar`, do proxy legado, do Tor, do standalone ou do estado compartilhado da GUI.
- Aplicação automática de atualização ou reinício silencioso do Discord.
- Criar um sinal de erro 2012 que não esteja disponível de forma confiável no estado observado pelo plugin.

## Abordagem escolhida

Será feita uma correção direcionada nos contratos já existentes, com pequenas funções auxiliares e testes de regressão. Uma refatoração ampla do runtime aumentaria o risco justamente nos caminhos de ativação, restauração e atualização que já foram exercitados na VM.

### UI e ciclo de vida

- Toda leitura de status do updater terá prazo limitado e será protegida por revisão/geração.
- Polling periódico e atualização manual usarão single-flight; uma nova leitura não criará uma fila de promessas concorrentes.
- A ação de verificar atualização atualizará o estado renderizado com o resultado obtido ou fará uma leitura limitada imediatamente após a operação.
- A validação de configuração WireGuard customizada terá deadline e cancelamento lógico. Se a native não puder interromper o processo subjacente, a UI invalidará a tentativa, liberará as ações e ignorará qualquer resposta tardia.
- O onboarding obrigatório sempre terá uma saída operacional (cancelar a validação, voltar ou fechar quando seguro), sem marcar onboarding como concluído.
- O cartão do updater indicará estado ocupado e mudanças por `role="status"`/`aria-live`; progresso sem total conhecido será indeterminado.

### Updater

- Um marcador pendente não será apagado apenas porque o backup necessário não foi encontrado. O erro ficará disponível para diagnóstico e o marcador permanecerá para uma tentativa explícita posterior.
- `lastCheckedAt` e `lastError` serão associados à política/canal vigente, ou invalidados de forma equivalente quando a política mudar; resultado de uma política anterior não será exibido como resultado atual.
- O status informará o canal da atualização pendente (`pendingChannel`) separadamente do canal atualmente selecionado.
- O digest do arquivo baixado não será tratado como prova suficiente da árvore instalada/preparada. A preparação/reconciliação verificará um digest de fonte/árvore ou marcará o estado legado sem essa prova como não confiável e exigindo nova preparação.
- Fonte instalada inválida será reportada como desconhecida/inválida para reconciliação; nunca será convertida silenciosamente no fallback de uma versão beta conhecida.
- Revalidações de política, canal, versão e revisão continuarão ocorrendo imediatamente antes de gravar, renomear ou trocar a árvore.

### Rota, WireSock e estabilidade

- `reliable=false` será um estado desconhecido, não evidência de processo externo bloqueando o plugin.
- Desaparecimento confirmado do WireSock fará o estado operacional deixar de ser `active` e emitirá mensagem coerente com a restauração, sem alegar prova geográfica.
- Observações desconhecidas quebrarão a continuidade temporal da reivindicação de estabilidade; uma nova sequência precisa atingir o limiar completo.
- Diagnósticos assíncronos só poderão gravar resultado se a geração ainda for a mesma e o runtime não tiver sido encerrado.
- O watcher usará apenas sinais confiáveis disponíveis. O alerta existente para 2001 continuará condicionado a evidência suficiente; nenhuma orientação específica para 2012 será inventada.

## Contratos de teste

- Testes estáticos continuarão verificando invariantes de autoridade, timeouts, `aria-*`, variantes válidas de `Card` (`normal`, `info`, `warning`, `success`) e ausência de auto-reload.
- Testes de unidade/regressão cobrirão: IPC pendente/hung, cancelamento lógico, resposta stale, troca de política durante check/update, backup ausente, marcador legado, source inválida, estado WireSock desconhecido/desaparecido, sequência true/unknown/true e diagnóstico após stop.
- A matriz local seguirá incluindo todos os testes `tests/test-plugin-*.mjs`, `go test ./...` do helper, testes GUI, TypeScript e `git diff --check`.
- A VM será usada para `testTsc`, `build`, `inject`, abertura do Discord oficial, carregamento do plugin, painel/overlay e limpeza da rede/share. Login Proton, 2FA/CAPTCHA, rota fresca, geo externa e uma transmissão longa serão reportados como concluídos somente se forem realmente executados.

## Critério de conclusão desta rodada

A rodada termina quando os três blocos estiverem revisados e integrados, a suíte local passar, o pacote novo passar pelo ciclo de build/injeção na VM e o Discord oficial abrir sem regressão observável. Isso não encerra a meta maior: a parte E2E dependente de credenciais, gateway e prova externa continua pendente.
