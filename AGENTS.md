# GoLiveBypass — instruções para Codex

## Forma de trabalhar

- Responda em português, de forma direta. Conclua o trabalho solicitado e informe mudanças, validação e limitações reais.
- Prossiga com inspeções, edições reversíveis e verificações necessárias ao pedido. Resolva escolhas rotineiras pelo contexto; pergunte quando faltar uma decisão que altere materialmente o resultado ou autorização para uma ação externa.
- Instruções explícitas do usuário prevalecem sobre orientações de skills, respeitando as regras do ambiente. Planejamento, brainstorming, documentos de design e revisões formais devem ser proporcionais à tarefa; não exigir aprovação de plano para toda correção ou edição documental.
- Use skills quando sua finalidade corresponder à tarefa, não por mera coincidência de palavras. Leia referências somente quando necessárias. Se uma skill impedir o avanço, cite o arquivo e a regra exata que causou o bloqueio.
- Preserve alterações existentes do usuário. Um pedido de correção não implica publicação, deploy ou envio de mensagens; siga a autorização já dada sem pedi-la novamente.
- Comece pelo sintoma e pela distribuição afetada. Use `rg` para localizar o caminho executado e leia apenas os arquivos e referências pertinentes. Reutilize validações já concluídas do mesmo código; amplie os testes quando houver mudanças, falhas ou dúvidas concretas.

## Arquitetura e arquivos

A arquitetura atual da GUI Windows/Linux é **WireGuard por aplicativo**: todo o tráfego do Discord usa o túnel, o restante do computador mantém sua rede normal e o `app.asar` permanece vanilla. Proxy/PAC, Tor e injeção são caminhos legados ainda presentes no repositório. Não aplicar as premissas de mídia direta do legado ao WireGuard; não presumir paridade de macOS, plugin e standalone com a GUI.

| Área | Onde começar |
| --- | --- |
| GUI Electron/TypeScript/Vite | `golive-gui/package.json`, `golive-gui/electron/main.ts` |
| WireSock Windows e prova de rota | `golive-gui/electron/wiresock.ts`, `route-proof.ts`, `discord-scope-proof.ts` no mesmo diretório |
| Linux e standalone | `golive-gui/electron/linux-helper.ts`, `standalone/golivebypass-standalone.sh` |
| Proton e geração de perfil | `golive-gui/electron/proton.ts`, `tools/proton-confgen/` |
| Plugin Vencord/Equicord WireGuard | `goLiveBypass/vpn-controller.ts`, `vpn-windows.ts`, `vpn-proton.ts`, `native.ts` |
| Proxy legado e standalone | `standalone/golivebypass.js`, `standalone/golivebypass-standalone.sh` |
| API de suporte | `api/README.md`, `api/` |
| Releases e atualizações | `.github/workflows/build-gui.yml`, `golive-gui/electron/updater*.ts`, `CHANGELOG.md` |

## Invariantes

- Preserve o isolamento por aplicativo e a restauração da rede. No Windows/Linux, probes de IP, HTTP e telemetria são apenas diagnóstico nos logs: não bloqueiam ativação, não exibem aviso nem derrubam o Discord. Estado ativo indica túnel/processo iniciados, não prova geográfica de saída. Não ampliar o filtro para todo PowerShell ou para a máquina inteira.
- O plugin Vencord/Equicord tem transporte WireGuard/WireSock autônomo, Windows x64 por enquanto, com estado em `GoLiveBypass/plugin-vpn`; não depende da GUI, não compartilha estado do standalone e recusa assumir ou parar um WireSock externo. A migração do plugin não autoriza alterações no standalone.
- `golive-gui/electron/bypass.ts` é gerado de `standalone/golivebypass.js`: nunca editar à mão. Após alterar a fonte, execute `npm run sync-bypass` em `golive-gui/`.
- Em mudanças de estabilidade, timeouts, probes ou troca de saída, avalie GUI, standalone e plugin. Porte o comportamento onde aplicável; documente lacunas no `CHANGELOG.md`, sem copiar mecanicamente arquiteturas distintas.
- Toda versão com sufixo de prerelease deve ser publicada como **prerelease**, nunca como latest. Canal estável não recebe beta nem downgrade. Consulte a skill de release antes de preparar/publicar versões.
- Diferencie fatos observados de hipóteses. Histórico de issues não substitui código atual ou reprodução; não atribua upload travado ao endpoint gratuito sem investigar.

## Skills do projeto

Escolha a skill pela operação solicitada. Leia seu `SKILL.md` antes de agir e carregue referências adicionais apenas quando o procedimento exigir. Não carregue todas as skills em toda tarefa.

| Tarefa | Skill e escopo |
| --- | --- |
| Ativação, tráfego, upload, login/plano Proton ou isolamento | [golive-network](.agents/skills/golive-network/SKILL.md): WireGuard/WireSock, Linux, Proton e diagnóstico por sintoma |
| Proxy/PAC/Tor, injeção ou recuperação gateway/RTC | [golive-legacy](.agents/skills/golive-legacy/SKILL.md): fonte standalone, sincronização da cópia gerada e plugin independente |
| Versão, build de distribuição, beta/estável ou updater | [golive-release](.agents/skills/golive-release/SKILL.md): preparação/publicação, conferência de artefatos e canais, roteiro E2E e avisos Discord |
| Operar ou testar na VM Windows | `windows-vm-control`: transporte SSH/FAT, GUI e coleta de evidências; combine com a skill do subsistema testado |

As três skills `golive-*` são versionadas em `.agents/skills/`. A skill `windows-vm-control` é local à máquina: nesta instalação fica em `/home/pdl/.codex/skills/windows-vm-control/SKILL.md`. Em outra sessão/máquina, resolva sua localização pelo catálogo disponível; não presuma que esteja no Git. Use o `scripts/vmctl.sh` relativo à pasta da skill, por caminho absoluto.

Para avisos de release, a skill `golive-release` inclui `scripts/discord-announcement.mjs`: gera prévia por padrão, `--copy` prepara envio manual e `--send` usa webhook configurado. Preparar um aviso não equivale a enviá-lo; conta, canal e autorização de anúncio devem estar definidos na conversa. Não armazene credenciais nem IDs de destino não confirmados neste arquivo.

Em tarefas longas de release/VM, mantenha um registro curto de commit/versão, artefatos e hashes, run/tag, transporte/share, evidências concluídas e próxima ação. Ao retomar, confira o estado atual antes de repetir builds, publicações ou operações na VM. Procedimentos detalhados e armadilhas ficam nas skills.

## Validação

Execute a menor verificação que cubra o comportamento alterado. Confira os scripts atuais antes de usá-los:

| Mudança | Comando e diretório |
| --- | --- |
| GUI/lógica TypeScript | `npm test -- tests/<arquivo>.test.ts` em `golive-gui/`; `npm test` para mudanças transversais |
| Compilação da GUI | `npm run compile` em `golive-gui/` (inclui sync, helper Go, TypeScript e Vite) |
| Fonte do bypass legado | `npm run check-bypass` em `golive-gui/`, após sync, e regressões pertinentes de `tests/` |
| Shell standalone | `bash -n standalone/golivebypass-standalone.sh` na raiz, além do teste comportamental pertinente |
| API Go | `go test ./...` em `api/` |
| Helper Proton Go | `go test ./...` em `tools/proton-confgen/` |
| Documentação/skills | Verificar links, frontmatter e `git diff --check`; dispensar build do app |

Leia scripts de teste antes de executar os que operam Discord, VM, rede ou serviços. Testes unitários não comprovam roteamento real; quando não houver validação na plataforma afetada, diga isso. Não publique para testar build: use os scripts `build:*`, que têm `--publish never`.

## Manutenção destas instruções

Mantenha aqui apenas acordos permanentes, invariantes e pontos de entrada. Procedimentos condicionais pertencem às skills; relatos extensos pertencem às referências e ao changelog. Ao mudar a arquitetura, atualize a orientação atual e identifique o histórico como histórico, sem acumular regras contraditórias.
