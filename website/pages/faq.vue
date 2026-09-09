<script setup lang="ts">
useSeoMeta({
  title: 'Perguntas frequentes',
  description: 'Respostas sobre a GUI v2, WireGuard por aplicativo, releases estáveis e diagnósticos do GoLiveBypass.',
  ogTitle: 'FAQ — GoLiveBypass',
  ogDescription: 'Encontre respostas antes ou depois de instalar o GoLiveBypass.',
  ogUrl: 'https://golivebypass.dev/faq',
})
</script>

<template>
  <div class="page-wrap site-container">
    <PageIntro eyebrow="DÚVIDAS FREQUENTES" title="Respostas diretas para o que costuma travar." description="Se a resposta não estiver aqui, a comunidade pode ajudar com seu sistema, versão do Discord e registro da GUI." />

    <div class="faq-layout">
      <aside class="faq-index" aria-label="Índice da FAQ"><span class="footer-label">Nesta página</span><a href="#instalacao">Instalação</a><a href="#compatibilidade">Compatibilidade</a><a href="#scope">Escopo de rede</a><a href="#diagnostics">Diagnósticos</a><a href="#suporte">Suporte</a></aside>

      <div class="faq-groups">
        <section id="instalacao" class="faq-group" aria-labelledby="faq-install-title">
          <div class="faq-group__heading"><span class="eyebrow">01 · INSTALAÇÃO</span><h2 id="faq-install-title">Começar pela GUI v2</h2></div>
          <div class="faq-list">
            <FaqAccordion id="which-path" question="Qual opção devo instalar?"><p>Use a <NuxtLink to="/downloads">GUI v2</NuxtLink> da release estável mais recente. Ela funciona com Proton Otimizado ou com um arquivo .conf e concentra o caminho recomendado para desktop.</p></FaqAccordion>
            <FaqAccordion id="gui-status" question="O que significa “Ativo”?"><p>Significa que a GUI iniciou o túnel e o processo do Discord foi associado a ele. Isso não é uma prova geográfica da saída nem substitui a leitura dos diagnósticos.</p></FaqAccordion>
            <FaqAccordion id="linux-appimage" question="Como abro o AppImage no Linux?"><p>Depois de baixar, dê permissão de execução com <code>chmod +x GoLiveBypass-*.AppImage</code> e abra o arquivo. O helper Linux aplica o isolamento suportado pela instalação.</p></FaqAccordion>
            <FaqAccordion id="macos-permission" question="O macOS bloqueou o aplicativo. O que faço?"><p>Abra os ajustes de Privacidade e Segurança e autorize o aplicativo baixado da release, se o sistema pedir. DMG e ZIP são publicados como assets separados quando estão presentes na stable atual.</p></FaqAccordion>
          </div>
        </section>

        <section id="compatibilidade" class="faq-group" aria-labelledby="faq-compat-title">
          <div class="faq-group__heading"><span class="eyebrow">02 · COMPATIBILIDADE</span><h2 id="faq-compat-title">Escolher o caminho certo</h2></div>
          <div class="faq-list">
            <FaqAccordion id="requirements" question="Preciso instalar Node, pnpm ou Git?"><p>Não para a GUI distribuída na release. O plugin e o standalone são caminhos separados e podem ter requisitos próprios; consulte a documentação específica deles antes de instalar.</p></FaqAccordion>
            <FaqAccordion id="mod" question="Posso usar o plugin com a GUI?"><p>O plugin tem transporte e estado próprios, voltados para Windows x64. Ele não depende da GUI, não compartilha o estado dela e não deve assumir ou parar um WireSock externo.</p></FaqAccordion>
            <FaqAccordion id="update" question="O que acontece quando o Discord atualiza?"><p>A GUI trabalha com o processo detectado na abertura e mantém o app.asar vanilla. Se a atualização criar uma nova instalação, feche e abra a GUI novamente para ela localizar o processo atual.</p></FaqAccordion>
            <FaqAccordion id="beta" question="Onde encontro versões beta?"><p>O site distribui somente releases stable e nunca seleciona prereleases. O canal beta é opt-in dentro da GUI ou na página de releases do GitHub.</p></FaqAccordion>
          </div>
        </section>

        <section id="scope" class="faq-group" aria-labelledby="faq-scope-title">
          <div class="faq-group__heading"><span class="eyebrow">03 · ESCOPO DE REDE</span><h2 id="faq-scope-title">O que entra no túnel?</h2></div>
          <div class="faq-list">
            <FaqAccordion id="scope-discord" question="A GUI muda a rede inteira do computador?"><p>Não. A arquitetura é WireGuard por aplicativo: somente o Discord usa o túnel e os demais aplicativos permanecem na conexão normal.</p></FaqAccordion>
            <FaqAccordion id="route" question="Proton ou arquivo .conf: qual escolher?"><p>Proton Otimizado mede as rotas disponíveis e ajuda a escolher um servidor. Arquivo .conf é para quem já tem um perfil WireGuard próprio e quer importá-lo pela GUI.</p></FaqAccordion>
            <FaqAccordion id="vanilla" question="O projeto altera o Discord internamente?"><p>Não. O app.asar permanece vanilla. O transporte acontece no escopo do processo, com WireSock no Windows e helper no Linux.</p></FaqAccordion>
          </div>
        </section>

        <section id="diagnostics" class="faq-group" aria-labelledby="faq-diagnostics-title">
          <div class="faq-group__heading"><span class="eyebrow">04 · DIAGNÓSTICOS</span><h2 id="faq-diagnostics-title">Quando a Live não carrega</h2></div>
          <div class="faq-list">
            <FaqAccordion id="probe" question="Os probes podem impedir a ativação?"><p>Não. Probes de IP, HTTP e telemetria são diagnósticos nos logs. Uma falha neles não bloqueia a ativação nem derruba o Discord.</p></FaqAccordion>
            <FaqAccordion id="black-screen" question="O Go Live ficou com a tela preta. O que faço?"><p>Confira o status do túnel, reabra o Discord e compare o registro da GUI. Se o problema persistir, informe sistema operacional, versão da GUI e o trecho relevante do log, sem tokens ou senhas.</p></FaqAccordion>
            <FaqAccordion id="route-failure" question="A rota otimizada não melhorou a conexão."><p>Otimização é uma medição, não uma garantia de localização ou desempenho. Tente outra rota, use um arquivo .conf conhecido e registre o resultado para a comunidade.</p></FaqAccordion>
          </div>
        </section>

        <section id="suporte" class="faq-group" aria-labelledby="faq-support-title">
          <div class="faq-group__heading"><span class="eyebrow">05 · SUPORTE</span><h2 id="faq-support-title">Ainda ficou diferente?</h2></div>
          <div class="support-note"><div class="support-note__icon"><BaseIcon name="discord" :size="23" /></div><div><h3>Leve um diagnóstico útil para a comunidade.</h3><p>Informe o sistema operacional, a versão da GUI, o método de rota escolhido e o trecho relevante do log. Nunca envie tokens ou senhas.</p><a class="button button--discord button--small" href="https://discord.gg/7cWbtr82rG" target="_blank" rel="noopener noreferrer">Entrar no Discord <BaseIcon name="external" :size="15" /></a></div></div>
        </section>
      </div>
    </div>
  </div>
</template>
