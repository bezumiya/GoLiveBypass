# Loop de estabilidade Linux

Este roteiro cobre a GUI AppImage e o shell WireGuard compartilhado. A CLI pública standalone continua fora da aceitação enquanto a portabilidade do WireGuard não for concluída. Cada rodada usa containers descartáveis e, quando disponíveis, VMs libvirt preparadas; nenhuma etapa troca a rota default do host.

## Matriz e etapas

O runner `tests/test-linux-matrix.sh` trabalha em x86_64 com:

- Ubuntu 24.04 e 22.04;
- Debian 13 e 12;
- Fedora 43 e 42;
- Arch atual e um repositório Arch fixado em 2025-09-01.

A rodada segue a mesma ordem em todas as imagens:

1. cria um home temporário com um `app.asar` fictício;
2. executa `--preflight --json` e confere a família, `wg`/`ip`/`curl`, namespace e comando de reparo;
3. em `--full`, atualiza somente metadados do gerenciador necessário e instala apenas os pacotes ausentes;
4. repete a instalação no mesmo guest e exige uma segunda chamada idempotente;
5. executa a auditoria de libc, libstdc++, GTK, NSS, libcurl, OpenSSL, libdrm e ferramentas gráficas disponíveis;
6. se um AppImage for fornecido, extrai o runtime sem FUSE e registra bibliotecas não encontradas;
7. substitui `wg`, `ip` e `curl` por binários que falham para garantir que a triagem não confunda um executável presente com uma dependência utilizável;
8. roda a prova de detecção/reutilização/limpeza de namespace em um user+network namespace descartável no host.

Distrobox não é o executor de aceitação: ele compartilha a rede e o kernel do host e poderia esconder exatamente os defeitos de namespace que esta matriz precisa revelar. Pode ser usado para uma reprodução manual depois de uma falha, mas o resultado deve ser marcado como auxiliar.

## Uso local

A verificação rápida não baixa pacotes:

```sh
./tests/test-linux-matrix.sh --quick
```

Para exercitar o reparo e a segunda chamada idempotente:

```sh
./tests/test-linux-matrix.sh --full
```

A imagem histórica do Arch exige acesso ao `archive.archlinux.org`. Se esse espelho estiver indisponível, o caso fica `SKIP` e o relatório não afirma cobertura histórica. Para tornar isso uma falha de infraestrutura, use `--require-arch-snapshot`. Para concentrar uma rodada em um caso durante a caça a bugs, use `MATRIX_CASES=debian-12,fedora-43`; `MATRIX_BUILD_ARCH_SNAPSHOT=0` desliga a construção do snapshot.

Para auditar um AppImage já compilado, passe o caminho local e, opcionalmente, preserve o relatório fora do repositório:

```sh
APPIMAGE_PATH=golive-gui/dist-app/GoLiveBypass-2.0.5-beta.1.AppImage \
MATRIX_REPORT_DIR=/tmp/golive-linux-reports \
./tests/test-linux-matrix.sh --quick
```

Os relatórios são texto sanitizado, sem sessão, token ou chave. O runner nunca recebe uma sessão Proton.

## VMs e sessão Premium

`tests/test-linux-vm.sh` é um executor separado para VMs libvirt já preparadas. Ele não baixa ISO, não inicia domínio desligado e não cria rede. Sem `VM_DOMAIN`, ele procura domínios `golive-*`; `--list` mostra o inventário. O preflight e o reparo são enviados por SSH, e a rota default do host é comparada antes/depois.

A prova de conexão Premium é um hook opt-in (`PROTON_VM_HOOK`). O hook recebe somente o nome do domínio e o destino SSH; ele deve obter a sessão por um mecanismo seguro do laboratório e remover perfis temporários. Uma execução sem hook é registrada como `SKIP`, nunca como túnel comprovado:

```sh
VM_DOMAIN=golive-ubuntu-24.04 VM_HOST=192.0.2.10 VM_USER=golive \
PROTON_VM_HOOK=./lab/proton-vm-hook ./tests/test-linux-vm.sh --full
```

A aceitação de rota continua exigindo túnel WireGuard criado, Discord no namespace `discord-vpn` e restauração após desativação/reinício. IP, HTTP, handshake e geolocalização são diagnóstico; uma amostra negativa não derruba uma sessão ativa.

## Loop de melhoria

Uma rodada é fechada somente com relatório por distribuição, incluindo falhas de pacote, biblioteca, namespace e ativação. Cada defeito reproduzido vira fixture ou teste antes da próxima rodada. O contador de estabilidade volta a zero quando há melhoria concreta (por exemplo, uma falha de instalação que deixa de ocorrer ou uma biblioteca antiga que passa a carregar). O loop termina após cinco rodadas completas consecutivas sem novo defeito nem melhoria, ou quando o responsável interromper a execução.

O CI executa a matriz rápida em `.github/workflows/linux-stability.yml` e nunca publica artefatos. A instalação real de pacotes, o AppImage com bibliotecas da distro e a sessão Premium permanecem tarefas de laboratório/VM.

## Evidência desta implementação

- A matriz rápida local executou Ubuntu 24.04/22.04, Debian 13/12, Fedora 43/42 e Arch atual: preflight e triagem de binários quebrados passaram em todos os casos; a prova isolada de namespace também passou.
- Uma rodada completa em Debian 12 instalou `wireguard-tools`, `iproute2` e `curl`, repetiu o reparo sem nova instalação e terminou com preflight sem dependências ausentes.
- O snapshot Arch e a auditoria de AppImage não foram declarados como executados quando o espelho histórico ou o artefato não estavam disponíveis.

Essas verificações cobrem o contrato de preparação e o isolamento sintético. Elas não substituem um ciclo de Discord real, áudio/RTC, reboot ou uma sessão Premium em cada distribuição.
