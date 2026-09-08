# Atualizações stable/beta no plugin — Design

## Objetivo

Levar para o plugin Vencord/Equicord o comportamento de atualização da GUI, com seleção explícita entre canal estável e beta, opt-in para prereleases e preparação automática de updates sem reiniciar o Discord durante uma chamada ou enquanto a VPN do plugin estiver ativa.

## Escopo e invariantes

- O plugin continua autônomo: não lê nem grava as preferências da GUI e não depende do processo Electron da GUI.
- O escopo de plataforma permanece Windows x64, que é a plataforma em que o plugin executa WireSock e recompila o checkout do Equicord/Vencord.
- A origem das releases permanece pdl-clay/GoLiveBypass, alinhada ao updater atual da GUI e ao manifest.json do plugin.
- O asset do plugin tem nome fixo goLiveBypass-vencord.zip; o checksum acompanha o asset como goLiveBypass-vencord.zip.sha256.
- Stable nunca recebe prerelease. Beta é opt-in e pode receber tanto stable quanto prerelease.
- Nenhum caminho de atualização pode fazer downgrade, substituir o código sem validar o manifest ou deixar uma troca parcial no checkout.
- Verificações, downloads e falhas de update são diagnósticos; uma falha não desativa o plugin nem interrompe a VPN ou a chamada.

## Experiência do usuário

As configurações do plugin terão duas preferências próprias:

- updateChannel: seletor com Estável como padrão e Beta — participar dos testes como opção de opt-in.
- autoUpdate: booleano ligado por padrão. Quando desligado, não há consulta periódica nem download automático, mas o botão de verificação/atualização manual continua disponível.

O painel de atualização exibirá a versão em execução, o canal atual, o estado da última verificação e, quando aplicável, a versão preparada. A pessoa poderá verificar agora e atualizar agora. A atualização automática baixa e prepara o pacote em segundo plano; depois mostra um aviso pedindo reload/reinício do Discord. O reinício é sempre uma decisão da pessoa, portanto não interrompe uma chamada nem a VPN ativa.

Ao trocar de canal, uma verificação imediata é disparada. Se houver um pacote beta preparado e a pessoa voltar para stable, esse pacote é descartado antes de qualquer reload. Um pacote já preparado não será baixado de novo a cada ciclo enquanto o Discord ainda estiver executando a versão antiga.

## Arquitetura

### Seleção de release

Será criado um módulo puro no diretório do plugin com os tipos e regras de canal, sem importar arquivos da GUI. Ele receberá as releases retornadas pela API do GitHub e devolverá a candidata de maior versão que:

1. não seja draft;
2. tenha o asset e o checksum exigidos;
3. seja stable quando o canal for stable;
4. possa ser stable ou prerelease quando o canal for beta;
5. seja estritamente mais nova que a versão em execução.

A comparação seguirá SemVer para versões v2.0.0 e v2.0.0-beta-1, incluindo a regra de que uma stable do mesmo triplo é maior que qualquer prerelease correspondente. O parser aceitará também o formato legado v2.0.0-beta.1 usado pelo plugin atual, normalizando ambos os formatos antes de comparar.

### Serviço nativo do updater

O native.ts manterá o acesso à rede, download, validação, backup, rollback e build. O serviço fará consultas diretas à API pública de releases, inicialmente após o start e depois uma vez por hora. Uma mudança de preferência cancela o estado incompatível e dispara uma consulta imediata; chamadas concorrentes serão serializadas.

O fluxo será:

preferência ligada/start
  -> listar releases -> escolher candidata por canal -> comparar com versão corrente
  -> baixar zip + checksum -> validar HTTPS, tamanho e SHA-256
  -> validar manifest -> mover fonte atual para backup -> instalar nova fonte
  -> recompilar checkout
  -> sucesso: marcar reload pendente
  -> falha: restaurar backup e recompilar versão anterior

O marcador persistente de update pendente ficará na pasta privada %LOCALAPPDATA%\\GoLiveBypass\\plugin-vpn. Ele conterá somente versão, canal, digest e um identificador do checkout, além do estado necessário para evitar repetição. No próximo carregamento, se a versão instalada coincidir com o marcador, ele será limpo; se a fonte já estiver nova mas o processo ainda estiver antigo, a UI mostrará que o reload é necessário.

O updater não usará o estado da VPN como autorização para sobrescrever arquivos. Ele pode preparar um update enquanto a VPN está ativa, mas não chamará relaunch, quit ou shutdown automaticamente.

### Interface plugin/native

Serão adicionados handlers nativos para:

- configurar o ciclo automático com { enabled, channel };
- consultar estado local e versão/canal da última checagem;
- verificar manualmente;
- preparar manualmente a atualização.

Os retornos serão sanitizados e não incluirão senha Proton, token, caminho arbitrário fornecido pelo usuário ou conteúdo completo das releases. Logs incluirão canal, versão, ação e motivo resumido.

### Workflow de release

O job de assets do plugin deixará de ser omitido em releases beta. Stable e beta publicarão o mesmo asset fixo e seu checksum; a release beta continuará marcada como prerelease e nunca será promovida a latest. O workflow continuará separando os assets da GUI dos assets do plugin.

## Tratamento de falhas

- GitHub indisponível, timeout ou JSON inválido: manter a versão atual e registrar warning; a próxima consulta poderá tentar novamente.
- Release sem asset/checksum: ignorar a candidata, sem preparar update.
- SHA inválido ou divergente: apagar o download e manter a fonte atual.
- Manifest com nome, versão ou estrutura incompatível: rejeitar antes de substituir.
- Build falhou: restaurar backup, tentar recompilar a versão anterior e manter o plugin funcionando com a versão anterior.
- Canal stable selecionado após download beta: apagar o pacote beta pendente.
- Troca de preferência durante download: o resultado é revalidado contra o canal atual antes de ser marcado como pendente.
- Erro do updater nunca chama Native.enable, Native.shutdown, app.quit ou qualquer rotina de restauração de rede.

## Testes e aceite

Testes unitários cobrirão:

- ordenação SemVer com stable, beta de um e dois dígitos e versões base diferentes;
- filtros stable/beta, ausência de downgrade e asset ausente;
- defaults e mudança das preferências do plugin;
- validação de checksum e manifest;
- backup/rollback após falha do build;
- idempotência do marcador pendente e ausência de downloads repetidos;
- serialização de consultas e ausência de relaunch automático.

Validação de integração cobrirá o build/inject do checkout Equicord na VM Windows x64, uma verificação stable, uma verificação beta com prerelease disponível, preparação do zip, reload manual e permanência da chamada/VPN durante o preparo. Não haverá publicação de release como parte dos testes locais.

## Fora do escopo

- Atualização automática do plugin em macOS/Linux.
- Compartilhamento de preferências ou estado com a GUI.
- Reinício silencioso do Discord.
- Atualização do standalone, do app.asar vanilla ou dos caminhos legados de proxy/Tor.
