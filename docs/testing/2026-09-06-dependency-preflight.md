# Investigação de preflight e dependências — 2026-09-06

Este relatório registra a rodada de preparação automática da GUI Windows/Linux. O escopo é a GUI e o shell compartilhado quando executado com `GOLIVE_GUI=1`; a CLI pública standalone não recebeu esse novo contrato. Nenhuma issue foi fechada, release foi publicado ou causa de rota foi declarada resolvida.

## Windows / WireSock

O preflight de compatibilidade agora distingue a versão legada Yuumi `1.4.7.1` da SDK mínima `3.4.8.1`. A evidência confirma que o caminho anterior não verificava compatibilidade; a seleção exige o par executável + `wgbooster.dll`, versões compatíveis e o formato de configuração `#@ws:AllowedApps`. A referência oficial para parâmetros avançados está em [WireSock — Advanced Parameters](https://wiresock.net/learn/wiresock-client/advanced-parameters); ela documenta a extensão `#@ws:AllowedApps` a partir da SDK `2.4.9.1`.

A ausência de verificação de compatibilidade foi confirmada no código. A comparação controlada abaixo sustenta que o formato do filtro é incompatível com 1.4.7.1 e interfere no tráfego externo ao Discord. A mudança para IP estrangeiro relatada pela usuária ainda não foi reproduzida. A suspeita de que o Tailscale tenha instalado a versão antiga não foi comprovada.

A ativação da GUI faz o preflight dentro da fila de lifecycle antes de encerrar o Discord. A geração da operação é capturada antes da espera e revalidada depois; uma desativação concorrente invalida a ativação pendente. O executável Windows empacotado também foi aberto na VM e executou esse caminho, com o resultado descrito abaixo.

## Linux

Dependências ausentes (`wg`, `ip`, `curl`) são um problema separado da arquitetura do namespace e do diagnóstico de rota. Quando o preflight encontra somente comandos conhecidos, Discord instalado, elevação disponível e namespace utilizável (ou `ip` ausente, que pode ser reparado), a GUI chama `--ensure-dependencies` no shell compartilhado e executa o preflight novamente antes de limpar legado ou iniciar o túnel. Discord ausente, elevação indisponível, namespace indisponível sem `ip` ausente ou dependência desconhecida continuam falhas não reparáveis e não acionam o gerenciador de pacotes.

O teste de instalação com `apt` foi isolado anteriormente e não é uma validação da GUI. O contrato efetivo da GUI é o caminho `GOLIVE_GUI=1`, com progresso encaminhado durante a preparação e rechecagem posterior. A CLI pública não deve ganhar esse comportamento por inferência.

## Contratos e evidências

- `ensureWireSockInstalled(onProgress?)` retorna `Promise<string>`, compartilha uma instalação em andamento e só libera a ativação após localizar uma SDK compatível.
- O shell GUI usa `--ensure-dependencies`; a execução é seguida de novo preflight antes de alterar Discord, app ou namespace.
- O IPC expõe `repairable` no preflight Linux para que UI e main usem a mesma decisão sobre habilitar “Preparar e ativar”.
- O teste de integração local cobre falta reparável → preparação → rechecagem → início, falha não reparável sem instalação e invalidação por operação concorrente.
- Testes automatizados atuais cobrem a rejeição de `1.4.7.1`, exigência do par EXE/DLL, formato `#@ws:AllowedApps`, preflight Linux, isolamento do modo de reparo e o fluxo de ativação. Os testes não substituem a VM.

## Limites da validação

A instalação Windows usa diretamente o instalador oficial da SDK 3.4.8.1, com hash fixado, `RunAs`, `/quiet` e `/norestart` quando a instalação compatível está ausente ou incompatível. A VM teve backup consistente e foi desbloqueada. O EXE e a DLL antigos foram confirmados na versão 1.4.7.1; a reprodução, o controle e a instalação automática pela GUI estão registrados abaixo.

O Linux teve um teste de produto real em Debian rootless após a extração planejada: primeira execução RC=0 com duas chamadas apt (update e install); repetição RC=0 sem nova chamada apt; offline RC=1. O SHA-256 `052acf92262640ebb5e071570a6ea64e76b8c760e4e6a20f91dd25723e3cd288` é do script usado no teste. Esse arquivo externo é evidência de laboratório e não deve ser requisito do CI. Diagnósticos de handshake, IP e HTTP continuam informativos e não bloqueiam uma sessão já iniciada.

Esta investigação não altera o estado da correção CAPTCHA: o fluxo local permanece validado com providers sintéticos, enquanto o relato original com desafio oficial Proton continua sem prova.

## Correção final de elevação Linux

O standalone preserva sudo quando a autorização já está cacheada. Na GUI, se sudo não tem autorização reutilizável e não há zenity/kdialog para exibir seu prompt, pkexec é usado como prompt gráfico. Cancelamento, recusa ou senha incorreta no prompt sudo não fazem fallback; o caminho `--probe --non-interactive` também não abre prompt.

A suíte completa, executada novamente após o ajuste de elevação, teve 243 testes aprovados em 29 arquivos. Os testes incluem 6 novos casos comportamentais de elevação. O reviewer independente marcou PASS. O último teste do pacote Linux antes deste delta de elevação foi executado em rootless e não exercitou a UI gráfica; isso permanece uma limitação. O build local posterior foi `npm run build:linux` com `--publish never` implícito pelo script.

Evidência do pacote local: o shell em `dist-app/linux-unpacked/resources/extra/standalone/golivebypass-standalone.sh` tem SHA-256 `cceb39a152cee9dc905d411b8d0372b170fc43d6b6977b0643b8af5efeedc1f0`, igual ao source, e tamanho 108225 bytes. O AppImage `GoLiveBypass-2.0.4.AppImage` tem SHA-256 `7e04803133e62396b3278406b26d64e97210ff3b5900201ac0a223ab9bbc9ea8`, tamanho 152414224 bytes e mtime `2026-09-06 04:47:05 -0300`. O build Windows terminou com exit 0 sem publicação; o artefato teve SHA-256 `f57f629f0d145a880e206692b0bc269ce85550d48714ee3169190e320e93caf3`. A VM Windows foi desbloqueada; após coletar o baseline SDK 3.4.8.1, o runtime foi substituído por 1.4.7.1 para a comparação controlada e a GUI depois reinstalou a SDK compatível. O log completo do build Linux está em `/tmp/golive-preflight-final-linux-build.log`.

## Reprodução controlada no Windows

A VM executou o cliente e a DLL 1.4.7.1 com o perfil real gerado pela GUI. Em três ciclos, uma requisição HTTPS do curl do sistema, fora do escopo Discord, falhou durante a execução do cliente (TLS, timeout e conexão reiniciada). Antes e depois de parar o processo, a requisição retornou o IP nativo. O primeiro harness interrompia cada ciclo na primeira falha nativa do curl; portanto esses resultados representam três falhas, não nove amostras.

No controle, somente a diretiva `#@ws:AllowedApps` foi convertida para `AllowedApps` numa cópia privada do mesmo perfil. Com o mesmo EXE/DLL antigos, três ciclos de três requisições retornaram o IP nativo (9/9), com restauração confirmada após cada ciclo. Isso sustenta a incompatibilidade do formato como causa da interferência fora do Discord. O IP estrangeiro específico do relato ainda não foi observado, e esse controle não comprova tráfego do Discord pelo túnel. Nenhuma chave do perfil foi incluída no relatório.

Evidências locais: `/tmp/astra-old-results.json` (primeira reprodução), `/tmp/astra-old-legacy-filter.json` (controle) e os `measure-*.json` do laboratório. Os arquivos contêm IPs de laboratório e não são artefatos públicos.

## GUI Windows empacotada — ciclos reais

O executável local de SHA-256 `f57f629f0d145a880e206692b0bc269ce85550d48714ee3169190e320e93caf3` foi aberto na VM com a instalação antiga presente e o runtime SDK moderno ausente. A ativação pela GUI criou novamente o runtime moderno e iniciou o serviço pelo caminho `WireSock Secure Connect\\sdk\\wiresock-client.exe`, sem instalação manual nessa etapa. A inspeção pós-instalação confirmou os pares EXE/DLL 3.4.8.1 e 1.4.7.1 lado a lado; somente o par 3.4.8.1 foi usado pela GUI.

Foram executados três ciclos de ativação/desativação pela GUI. Em cada ciclo concluído, curl fora do escopo manteve o IP nativo e uma cópia temporária do curl dentro da pasta de aplicação Discord apresentou o IP do túnel. Esse teste comprova a regra aplicada a um processo naquele diretório, não equivale a uma chamada HTTP originada pelo JavaScript do Discord. O Discord real abriu e carregou a tela de amigos nos ciclos; não foram enviados mensagens/anexos nem iniciadas chamadas. O app.asar não foi modificado.

Após cada uma das três desativações, ambos os probes retornaram o IP nativo, o serviço estava parado e não havia processo WireSock. No terceiro ciclo, uma amostra durante a inicialização ainda mostrou IP nativo no escopo filtrado; a amostra posterior à conclusão da GUI mostrou o túnel. Esse estado transitório foi mantido na evidência, e não contado como prova de isolamento concluído.

Limitações: três ciclos não comprovam estabilidade prolongada; ainda não foram exercitados cancelamento real de UAC, reinicialização requerida pelo instalador, falha no meio do MSI, chamadas/streams RTC ou todas as distribuições Linux. Falhas de hash, código de instalador, concorrência e cancelamento possuem cobertura automatizada; o Linux também teve instalação real e tentativa offline no laboratório rootless.
