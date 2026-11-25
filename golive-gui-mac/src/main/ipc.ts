export interface RouterHandlers {
  importConfig(payload: { rawText: string }): Promise<unknown>;
  activate(): Promise<unknown>;
  deactivate(payload: { now?: boolean }): Promise<unknown>;
  restart(): Promise<unknown>;
  restoreNetwork(): Promise<unknown>;
  status(): Promise<unknown>;
  fetchProton(payload: { username: string; password?: string; mode?: 'auto' | 'manual' | 'speed' | 'catalog'; server?: string }): Promise<unknown>;
  protonRoutes(): Promise<unknown>;
  protonPlan(payload: { force?: boolean }): Promise<unknown>;
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
  appInfo(): Promise<unknown>;
  reportBug(payload: { title: string; description: string; includeLogs: boolean }): Promise<unknown>;
  getSettings(): Promise<unknown>;
  phoneStatus(): Promise<unknown>;
  phoneGenerate(payload: { delivery?: 'qr' | 'file' }): Promise<unknown>;
  phoneSave(): Promise<unknown>;
  phoneDeleteSaved(): Promise<unknown>;
  phoneClear(): Promise<unknown>;
  setSettings(payload: { openAtLogin?: boolean; devMode?: boolean; theme?: 'system' | 'light' | 'dark'; routePreference?: 'auto' | 'manual'; autoFailover?: boolean; routePromptAnswered?: boolean }): Promise<unknown>;
}

const optBool = (v: unknown) => (typeof v === 'boolean' ? v : undefined);
const optStr = (v: unknown, max = 200) => (typeof v === 'string' && v.length <= max ? v : undefined);
const FETCH_MODES = ['auto', 'manual', 'speed', 'catalog'] as const;
const fetchMode = (v: unknown) => FETCH_MODES.find(m => m === v);
const routePref = (v: unknown) => (v === 'auto' || v === 'manual' ? v : undefined);
const delivery = (v: unknown) => (v === 'qr' || v === 'file' ? v : undefined);
const theme = (v: unknown) => (v === 'system' || v === 'light' || v === 'dark' ? v : undefined);

export function makeRouter(h: RouterHandlers) {
  return async (channel: string, payload: any): Promise<unknown> => {
    switch (channel) {
      case 'config:import':       return h.importConfig(payload);
      case 'tunnel:activate':     return h.activate();
      case 'tunnel:deactivate':   return h.deactivate({ now: payload?.now === true });
      case 'tunnel:restart':      return h.restart();
      case 'tunnel:restoreNetwork': return h.restoreNetwork();
      case 'tunnel:status':       return h.status();
      case 'proton:fetch':        return h.fetchProton({
        username: String(payload?.username ?? ''),
        password: optStr(payload?.password, 1024),
        mode: fetchMode(payload?.mode),
        server: optStr(payload?.server, 40),
      });
      case 'proton:routes':       return h.protonRoutes();
      case 'proton:plan':         return h.protonPlan({ force: payload?.force === true });
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
      case 'app:info':            return h.appInfo();
      case 'report:send':         return h.reportBug({
        title: String(payload?.title ?? '').slice(0, 200),
        description: String(payload?.description ?? '').slice(0, 8192),
        includeLogs: payload?.includeLogs !== false,
      });
      case 'settings:get':        return h.getSettings();
      case 'settings:set':        return h.setSettings({
        openAtLogin: optBool(payload?.openAtLogin),
        devMode: optBool(payload?.devMode),
        theme: theme(payload?.theme),
        routePreference: routePref(payload?.routePreference),
        autoFailover: optBool(payload?.autoFailover),
        routePromptAnswered: payload?.routePromptAnswered === true,
      });
      case 'phone:status':        return h.phoneStatus();
      case 'phone:generate':      return h.phoneGenerate({ delivery: delivery(payload?.delivery) });
      // O destino sai do diálogo do main: a janela não escolhe onde gravar a chave
      case 'phone:save':          return h.phoneSave();
      case 'phone:deleteSaved':   return h.phoneDeleteSaved();
      case 'phone:clear':         return h.phoneClear();
      default: throw new Error(`Canal IPC desconhecido: ${channel}`);
    }
  };
}
