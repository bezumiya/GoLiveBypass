package bugreport

import (
	"strings"

	"github.com/bezumiya/GoLiveBypass/api/internal/updates"
)

// Desde 19/11/2026 a Proton recusa com o código 5003 o helper que se anuncia como
// linux-vpn@4.17.2, e o login falha. Estas são as primeiras versões que mandam a
// identificação nova (linux-vpn-gui@6.1.2).
const (
	// GUI Windows/Linux e plugin, que seguem a mesma numeração: a correção (8ff01e3 no
	// proton-confgen, 586cb71 no helper embutido do plugin) entrou na tag v2.0.17. A
	// 2.0.17-beta-4 e as anteriores ainda mandam a versão recusada.
	versaoCorrigida = "2.0.17"
	// A linha 1.x da GUI era o proxy legado, sem login Proton: o aviso não vale para ela.
	primeiraVersaoComProton = "2.0.0"
)

// O cliente macOS fica de fora: a 0.8.0 e a 0.8.1 não têm relato, que só chega na 0.9.0,
// já com o helper novo. Nenhum relato do macOS vem de uma versão recusada.

const tituloDoAviso = "**Esta versão do GoLiveBypass não consegue mais entrar na conta Proton (código 5003).**\n"

// No Windows, da 2.0.10 à 2.0.18, um update baixado nunca é aplicado sozinho: a cada
// abertura o log diz "update pendente recuperado" e o Checar updates não faz nada enquanto
// ele estiver pendente. A saída é o item da bandeja, que existe da 2.0.5 à 2.0.19 e só
// aparece com update pendente. Sem pendente, o Checar updates (2.0.10 em diante) baixa a
// mais nova e pergunta se reinicia. Um pendente anterior à 2.0.17 ainda leva ao 5003, por
// isso a segunda volta.
const avisoGUIWindows = tituloDoAviso + `Desde 19/11 a Proton recusa as versões anteriores à 2.0.17. Para voltar a entrar, atualize:

1. Clique com o botão direito no ícone do GoLiveBypass na bandeja, ao lado do relógio (no Windows 11 ele pode estar escondido na setinha "^"), e clique em **Reiniciar para atualizar**.
2. Se esse item não aparecer, ou se ao reabrir ele ainda não estiver na versão mais nova, clique em **Checar updates** (ícone de setas no alto da janela) e aceite a atualização. Quem tinha baixado uma versão anterior à 2.0.17 precisa dessa segunda volta.
3. Se nada disso funcionar, feche o GoLiveBypass pelo menu do ícone (**Sair**), baixe a versão nova em https://github.com/bezumiya/GoLiveBypass/releases/latest e abra o arquivo baixado.`

// No Linux o updater é o do AppImage (electron-updater): com "Avisar sobre atualizações"
// ligado, ele baixa a versão nova a cada abertura e pergunta se reinicia. Quem escolhe
// "Depois" ganha o item da bandeja. Não há Checar updates no Linux.
const avisoGUILinux = tituloDoAviso + `Desde 19/11 a Proton recusa as versões anteriores à 2.0.17. Para voltar a entrar, atualize:

1. Deixe **Avisar sobre atualizações** marcado (no menu do ícone na bandeja ou nas configurações) e reabra o GoLiveBypass. Quando ele avisar que baixou a versão nova, clique em **Reiniciar agora**; se escolheu **Depois**, use **Reiniciar para atualizar** no menu do ícone.
2. Se o aviso não aparecer, feche o GoLiveBypass (**Sair**), baixe o AppImage novo em https://github.com/bezumiya/GoLiveBypass/releases/latest e use-o no lugar do antigo.`

// O plugin se atualiza pelo cartão "Atualizações do GoLiveBypass" das configurações
// (presente desde a 2.0.6-beta-15, a primeira com relato) e pede para reiniciar o Discord.
const avisoPlugin = tituloDoAviso + `Desde 19/11 a Proton recusa as versões do plugin anteriores à 2.0.17. Para voltar a entrar, atualize:

1. Nas configurações do plugin GoLiveBypass, em **Atualizações do GoLiveBypass**, clique em **Verificar** e depois em **Atualizar**. Quando terminar, feche o Discord pela bandeja e abra de novo.
2. Se não der certo, rode de novo o [instalador do plugin](https://github.com/bezumiya/GoLiveBypass#instalação-do-plugin-recomendado-para-equicord-vencord-e-vesktop).`

// OutdatedClientNotice devolve o aviso que vai no topo da issue quando o relato vem de
// uma versão que não entra mais na conta Proton, ou "" quando não há o que avisar. Os
// clientes antigos só mostram o link da issue depois do envio, então o corpo dela é o
// único lugar onde quem ficou preso lê como sair. Versão ausente ou fora do formato do
// updater (o standalone manda "standalone") conta como corrigida: na dúvida, sem aviso.
func OutdatedClientNotice(meta map[string]string) string {
	versao := meta["versao"]
	// A GUI (Windows/Linux) e o cliente macOS não mandam "app"; o plugin manda
	// "golive-plugin". Qualquer outro app é um cliente que este aviso não conhece.
	// O macOS (plataforma darwin-*) não cai em nenhum caso abaixo.
	if app, ok := meta["app"]; ok {
		if strings.TrimSpace(app) == "golive-plugin" && semCorrecao(versao, primeiraVersaoComProton, versaoCorrigida) {
			return avisoPlugin
		}
		return ""
	}
	plataforma := strings.TrimSpace(meta["plataforma"])
	switch {
	case strings.HasPrefix(plataforma, "win32-") && semCorrecao(versao, primeiraVersaoComProton, versaoCorrigida):
		return avisoGUIWindows
	case strings.HasPrefix(plataforma, "linux-") && semCorrecao(versao, primeiraVersaoComProton, versaoCorrigida):
		return avisoGUILinux
	}
	return ""
}

// semCorrecao informa se versao está em [desde, ate), na ordem SemVer do updater
// (a 2.0.17-beta-4 vem antes da 2.0.17).
func semCorrecao(versao, desde, ate string) bool {
	if cmp, ok := updates.CompareReleaseTags(versao, desde); !ok || cmp < 0 {
		return false
	}
	cmp, ok := updates.CompareReleaseTags(versao, ate)
	return ok && cmp < 0
}
