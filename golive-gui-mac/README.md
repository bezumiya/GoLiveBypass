# GoLiveBypass — macOS

Reativa o **Go Live** do Discord no macOS com um túnel WireGuard (ProtonVPN gratuito)
só para o tráfego do Discord. DMG **universal**: Apple Silicon e Intel.

## Requisitos

- macOS 13 Ventura ou superior
- Discord instalado em `/Applications/Discord.app`

## Instalação

1. Baixe o `GoLiveBypass-macos-<versão>-universal.dmg` nas
   [releases `macos-v*`](https://github.com/bezumiya/GoLiveBypass/releases?q=macos-v&expanded=true)
   e confira o `.sha256` publicado ao lado.
2. Abra o DMG e arraste **GoLiveBypass.app** para `/Applications`.
3. O app não é notarizado. Se o macOS bloquear com "desenvolvedor desconhecido":
   ```bash
   xattr -dr com.apple.quarantine /Applications/GoLiveBypass.app
   ```
4. Abra o app. Na primeira ativação ele pede a senha de administrador para instalar o
   helper privilegiado (uma única vez por versão do helper).

## Uso

- **Conta Proton:** usuário e senha de uma conta ProtonVPN gratuita e **Buscar melhor
  servidor** (mede o ping dos servidores MX e US). A sessão fica salva, a senha não.
  Também dá para **Importar .conf** de um WireGuard próprio.
- **Ativar:** o botão central liga o túnel e reinicia o Discord por ele.
- **Extras (opcional):** **Instalar o Vencord com o plugin FakeNitro ao ativar** vem
  desligado. Ligado, o app injeta o Vencord no Discord (pede a permissão de
  **Gerenciamento de Apps**) e liga o FakeNitro só se você nunca o configurou; se você
  desligar o FakeNitro no Vencord, o app não liga de novo.
- O app fica na barra de menu: fechar a janela não desliga o bypass. Para sair, **Sair**
  no ícone da barra de menu ou Cmd+Q.

## Build

```bash
npm ci
npm run build:mac   # proton-confgen da fonte + TypeScript + DMG universal em dist-build/
```

- Precisa de Go (versão do `tools/proton-confgen/go.mod` ou mais nova) e das Xcode
  Command Line Tools (`lipo`, `codesign`, `swift`).
- `npm run build:proton` compila `tools/proton-confgen` para darwin x64/arm64, junta em
  universal e grava `resources/extra/proton-confgen/proton-confgen-manifest.json`. O app
  só executa o binário se o SHA-256 bater com esse manifesto.
- `npm run build:icons` regenera `build/icon.icns` e `resources/tray/` (já commitados).
- Os binários WireGuard de `resources/bin/` estão fixados por `resources/bin/SHA256SUMS`.

O build sai assinado ad-hoc. Depois de um build local, use o `xattr` acima.

## Release

Releases macOS **só** pelo workflow `release-macos.yml` (Actions › release-macos ›
versão do `package.json`). Fluxo recomendado: `acao=rascunho` (build e draft para
conferir) e depois `acao=publicar-rascunho`. **Não publique o draft pelo botão do
GitHub:** ele marca "Set as the latest release" por padrão. O workflow chama
`npm run release:mac`, que:

- cria a tag `macos-v<versão>` com `make_latest: false` e os assets
  `GoLiveBypass-macos-<versão>-universal.dmg` + `.sha256`;
- antes de publicar, confere no DMG a versão, o repositório de atualização e o
  `proton-confgen` contra o manifesto;
- depois de publicar, confere os assets, o digest e que `/releases/latest` não mudou.
  Se algo falhar, a release volta para draft, a latest anterior é devolvida e o job falha;
- recusa criar a release se já existir uma com a mesma tag, draft incluído.

As notas vêm da seção `## [macos-<versão>]` do `CHANGELOG.md` da raiz.

## Arquitetura

- **Split tunnel por IP:** só os ranges Cloudflare do Discord (`162.159.0.0/16` e
  `104.16.0.0/12`) passam pela VPN; os ranges IPv6 da Cloudflare são rejeitados com o
  túnel ativo para o Discord cair no IPv4 tunelado. Outros apps continuam na conexão
  direta.
- **Helper privilegiado:** script em `/Library/PrivilegedHelperTools/GoLiveBypass/helper`,
  executado via `sudo -n` com sudoers limitado a `up`/`down`; sanitiza o conf (descarta
  DNS e hooks e força os `AllowedIPs`).
- **Atualizações:** o app consulta as releases `macos-v*`, escolhe a maior versão com
  DMG e SHA-256 publicado e confere o hash antes de abrir o DMG.
