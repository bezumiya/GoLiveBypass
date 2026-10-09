export type TunnelState = 'active' | 'inactive' | 'unknown';

export interface WgConfig {
  interfaceLines: string[];
  peerLines: string[];
}

export interface ActivateResult {
  state: TunnelState;
  publicIp: string | null;
}

export type PrivilegedError =
  | 'user_cancelled'
  | 'handshake_timeout'
  | 'binary_missing'
  | 'wg_failed';

export interface AppSettings {
  lastTunnelState?: TunnelState;
  protonUser?: string;
  /** Opt-in explícito: instalar o Vencord e ligar o FakeNitro ao ativar. */
  vencordOptIn?: boolean;
}

export interface UpdateInfo {
  available: boolean;
  latestVersion?: string;
  downloadUrl?: string;
  currentVersion: string;
}

export interface ProtonFetchProgress {
  message: string;
}
