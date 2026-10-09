export interface RouterHandlers {
  importConfig(payload: { rawText: string }): Promise<unknown>;
  activate(): Promise<unknown>;
  deactivate(): Promise<unknown>;
  status(): Promise<unknown>;
  fetchProton(payload: { username: string; password?: string }): Promise<unknown>;
  exitInfo(): Promise<unknown>;
  vencordPermission(): Promise<unknown>;
  vencordOpenSettings(): Promise<unknown>;
  vencordRetry(): Promise<unknown>;
  vencordGetOptIn(): Promise<unknown>;
  vencordSetOptIn(payload: { enabled: boolean }): Promise<unknown>;
  protonAccount(): Promise<unknown>;
  protonLogout(): Promise<unknown>;
  checkUpdate(): Promise<unknown>;
  downloadUpdate(payload: { version?: string }): Promise<unknown>;
}

export function makeRouter(h: RouterHandlers) {
  return async (channel: string, payload: any): Promise<unknown> => {
    switch (channel) {
      case 'config:import':       return h.importConfig(payload);
      case 'tunnel:activate':     return h.activate();
      case 'tunnel:deactivate':   return h.deactivate();
      case 'tunnel:status':       return h.status();
      case 'proton:fetch':        return h.fetchProton(payload);
      case 'tunnel:exit':         return h.exitInfo();
      case 'vencord:permission':  return h.vencordPermission();
      case 'vencord:openSettings': return h.vencordOpenSettings();
      case 'vencord:retry':       return h.vencordRetry();
      case 'vencord:getOptIn':    return h.vencordGetOptIn();
      case 'vencord:setOptIn':    return h.vencordSetOptIn({ enabled: payload?.enabled === true });
      case 'proton:account':      return h.protonAccount();
      case 'proton:logout':       return h.protonLogout();
      case 'app:checkUpdate':     return h.checkUpdate();
      case 'app:downloadUpdate':  return h.downloadUpdate({ version: typeof payload?.version === 'string' ? payload.version : undefined });
      default: throw new Error(`Canal IPC desconhecido: ${channel}`);
    }
  };
}
