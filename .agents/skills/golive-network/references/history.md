# Migração WireGuard e relato de upload (setembro de 2026)

Desde a revisão de 2026-09-05 solicitada pelo usuário, a prova funcional é somente diagnóstica: não bloqueia ativação nem derruba sessões.

Registro histórico migrado do AGENTS.md. Consulte primeiro o código e o CHANGELOG atuais: filtros Windows, Proton e prova de rota evoluíram desde este relato.

**Limite da evidência:** o upload travado foi relatado como reproduzido; saturação do endpoint compartilhado é uma hipótese, não uma causa comprovada. Um curl isolado de 5 MB não exclui MTU, diferenças de rota, IPv6 ou problemas específicos do Discord. As afirmações causais abaixo são conclusões da época, não premissas para novos diagnósticos. Não implementar mitigação de produto apenas porque foi sugerida aqui.

## 10. Envelopamento WireGuard (Per-App VPN) vs Sistema de Proxy Legado
A arquitetura anterior injetava scripts (`golivebypass.js`) no `app.asar` e manipulava proxies PAC para interceptar `*.discord.gg`. Devido a mudanças recentes no cliente Discord (quadros binários ETF, checagens de integridade e divergência de IP entre gateway e WebRTC), o mecanismo legado de proxy tornou-se ineficaz.

A solução atual envelopa **todo o processo do Discord** dentro de um túnel WireGuard dedicado, enquanto o restante do computador do usuário permanece 100% na rede normal (IP brasileiro direto):
- **Linux (`golivebypass-standalone.sh` / GUI)**: Utiliza **Network Namespaces** do kernel Linux (`ip netns add discord-vpn`). A interface `wg-discord` é criada no namespace raiz, configurada via `wg setconf` e movida para `discord-vpn`. O Discord é lançado dentro do namespace via `ip netns exec discord-vpn setsid -f sudo -u "$USER" ...` repassando as variáveis de ambiente gráficas (`DISPLAY`, `WAYLAND_DISPLAY`, `XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS`, `PULSE_SERVER`). O `app.asar` do Discord permanece 100% vanilla (sem injeção).
- **Windows (`GoLiveBypass-Standalone.ps1` / GUI)**: Utiliza o driver de kernel WFP via **WireSock Secure Connect CLI** (`wiresock-client.exe` / `wiresock-client-service`). A configuração define `AllowedApps = Discord, Discord.exe, Update.exe` e `AllowedIPs = 0.0.0.0/0, ::/0`. Apenas os pacotes gerados pelos executáveis do Discord são direcionados ao túnel; todo o tráfego dos demais navegadores e jogos continua saindo direto pela interface normal. O `app.asar` do Discord também permanece vanilla.
- **Configuração WireGuard**: Ambos os sistemas vêm com perfil padrão gratuito integrado (EUA/México) gravado no diretório compartilhado (`wireguard.conf`), e permitem a importação de configurações personalizadas `.conf` pelo usuário.

## 10.1. Problema conhecido, não corrigido: upload de imagem trava e some com o perfil gratuito embutido
**Sintoma relatado:** com o bypass ativo, enviar uma imagem no chat de texto do Discord chega a carregar (a barra de progresso aparece) mas trava e a mensagem inteira some do canal — nunca chega a completar nem a dar erro visível.

**Reproduzido ao vivo em 2026-09-03** (VM Windows, WireSock, servidor de teste real "Confident", canal de mídia): o upload de uma imagem gerada localmente ficou preso na barra de progresso por dezenas de segundos e a mensagem desapareceu completamente do canal. `Get-NetTCPConnection` durante o travamento mostrou só **uma** conexão TCP estabelecida do Discord (porta 443, IP da Cloudflare) — nenhuma segunda conexão para o endpoint de armazenamento de anexos chegou a abrir, sugerindo que o pedido de upload nem saiu do processo do Discord, ou ficou preso multiplexado na mesma conexão HTTP/2 do resto do app.

**Hipótese levantada na época:** saturação do perfil gratuito compartilhado MX-FREE. Um upload isolado de 5 MB por curl completou em aproximadamente 4 s. Isso confirma apenas aquele fluxo; não descarta MTU, fragmentação, IPv6, seleção de rota ou comportamento específico do Discord. Um relato de melhora com proxy privado também não isola a causa. O endpoint e os perfis integrados mudam: consulte o código/configuração da versão investigada.

**Explicação proposta, não demonstrada:** carga e perda poderiam afetar anexos mais que texto. Não houve evidência suficiente para atribuir os fluxos à mesma conexão ou comprovar saturação.

**Causa raiz não determinada neste relato.** As propostas abaixo foram discutidas historicamente, não aprovadas nem recomendadas para implementação automática. Avisos e troca de saída por probes contradizem os invariantes atuais do projeto:
- Aviso na GUI quando o `wgstats.ts` (ver mais abaixo) detectar degradação do túnel (handshake velho ou queda de throughput) durante uma tentativa de envio, sugerindo trocar de saída ou importar config privada.
- Pool de múltiplos perfis gratuitos embutidos com troca automática ao detectar degradação (mais parecido com o antigo pool de proxies gratuitas do sistema legado).
- Documentação mais explícita na tela de importação de WireGuard avisando que o perfil padrão é compartilhado/limitado, recomendando config privada para quem usa anexos/imagens com frequência.
