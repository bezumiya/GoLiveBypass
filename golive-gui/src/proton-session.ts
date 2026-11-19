/**
 * Decisao de sessao Proton do painel da GUI.
 *
 * Uma falha de *verificacao* (rede, timeout, helper ausente) nao e um logout: o
 * usuario segue autenticado, o perfil WireGuard ja gerado continua valido e a
 * proxima verificacao decide. Sem essa distincao, qualquer oscilacao de rede no
 * `-check-session` marcava `valid: false`, escondia a conta conectada e deixava o
 * botao "Ativar Bypass" desabilitado mesmo apos escolher a rota — o relato de tres
 * usuarios em 18/09 (#312, #316, #317).
 */
export type ProtonSessionVerdict = 'authenticated' | 'unverified' | 'logged-out';

export interface ProtonSessionCheckLike {
  valid?: boolean;
  /** Falha que pode passar sozinha: rede, timeout, helper ausente, persistencia. */
  retryable?: boolean;
  /** Codigo do `-check-session`; APP_VERSION_UNSUPPORTED tem aviso proprio. */
  code?: string;
}

export function decideProtonSession(check: ProtonSessionCheckLike | null | undefined): ProtonSessionVerdict {
  if (check?.valid === true) return 'authenticated';
  // A Proton recusar a versao do app nao diz nada sobre a sessao salva.
  if (check?.retryable === true || check?.code === 'APP_VERSION_UNSUPPORTED') return 'unverified';
  return 'logged-out';
}

/** Aviso do painel quando a sessao fica 'unverified'. */
export function protonSessionUnverifiedMessage(check: ProtonSessionCheckLike | null | undefined): string {
  if (check?.code === 'APP_VERSION_UNSUPPORTED') {
    return 'A Proton deixou de aceitar esta versão do GoLiveBypass. A ativação com a rota já preparada continua disponível; para entrar ou trocar de rota, atualize o GoLiveBypass.';
  }
  return 'Não consegui confirmar sua sessão Proton agora. A ativação com a rota já preparada continua disponível.';
}
