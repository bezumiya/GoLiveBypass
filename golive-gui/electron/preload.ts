import { ipcRenderer } from 'electron';
import type { ProtonOptimizationProgress } from './proton';
(window as any).api = {
  platform: process.platform,
  activate: () => ipcRenderer.invoke('activate'),
  deactivate: () => ipcRenderer.invoke('deactivate'),
  restoreInternet: () => ipcRenderer.invoke('restore-internet'),
  getStatus: () => ipcRenderer.invoke('get-status'),
  getLinuxPreflight: () => ipcRenderer.invoke('get-linux-preflight'),
  getVersion: () => ipcRenderer.invoke('get-app-version'),
  getPlatform: () => ipcRenderer.invoke('get-platform'),
  getStartup: () => ipcRenderer.invoke('get-startup'),
  setStartup: (enabled: boolean) => ipcRenderer.invoke('set-startup', enabled),
  getAutoUpdate: () => ipcRenderer.invoke('get-auto-update'),
  setAutoUpdate: (enabled: boolean) => ipcRenderer.invoke('set-auto-update', enabled),
  getUpdateChannel: () => ipcRenderer.invoke('get-update-channel'),
  setUpdateChannel: (canal: string) => ipcRenderer.invoke('set-update-channel', canal),
  importWgConf: () => ipcRenderer.invoke('import-wg-conf'),
  importWgConfFile: (filePath: string) => ipcRenderer.invoke('import-wg-conf-file', filePath),
  getWgConfName: () => ipcRenderer.invoke('get-wg-conf-name'),
  testWgConf: () => ipcRenderer.invoke('test-wg-conf'),
  startLogWatch: () => ipcRenderer.invoke('start-log-watch'),
  stopLogWatch: () => ipcRenderer.invoke('stop-log-watch'),
  getDiagnostic: (payload: { status: string; note?: string }) =>
    ipcRenderer.invoke('get-diagnostic', payload),
  openBugReport: (payload: { status: string; note?: string; title?: string }) =>
    ipcRenderer.invoke('open-bug-report', payload),
  openLogFolder: () => ipcRenderer.invoke('open-log-folder'),
  setDevLogWindow: (open: boolean) => ipcRenderer.invoke('set-dev-log-window', open),
  onLogChunk: (callback: (chunk: string) => void) => {
    ipcRenderer.on('log-chunk', (_event, chunk: string) => callback(chunk));
  },
  onDevLogWindowClosed: (callback: () => void) => {
    ipcRenderer.on('dev-log-window-closed', () => callback());
  },
  onRefreshStartup: (callback: () => void) => ipcRenderer.on('refresh-startup', callback),
  onRefreshAutoUpdate: (callback: () => void) => ipcRenderer.on('refresh-auto-update', callback),
  onRefreshStatus: (callback: () => void) => ipcRenderer.on('refresh-status', callback),
  resizeWindow: (height: number) => ipcRenderer.send('resize-window', height),
  setTheme: (theme: string) => ipcRenderer.send('set-theme', theme),
  reportBug: (payload: { title: string; description: string; includeLogs: boolean }) => ipcRenderer.invoke('report-bug', payload),
  getVpnMode: () => ipcRenderer.invoke('get-vpn-mode'),
  setVpnMode: (mode: 'proton' | 'custom') => ipcRenderer.invoke('set-vpn-mode', mode),
  checkProtonSession: (username: string) => ipcRenderer.invoke('check-proton-session', username),
  loginProton: (payload: { username: string; password?: string; twoFactorCode?: string }) =>
    ipcRenderer.invoke('login-proton', payload),
  onProtonCaptchaStatus: (callback: (status: string) => void) =>
    ipcRenderer.on('proton-captcha-status', (_event, status: string) => callback(status)),
  logoutProton: () => ipcRenderer.invoke('logout-proton'),
  optimizeProtonRoute: (options?: { country?: string; freeOnly?: boolean; autoPing?: boolean; speedTest?: boolean; reuseMeasured?: boolean; refreshOnStartup?: boolean; requestId?: string }) =>
    ipcRenderer.invoke('optimize-proton-route', options),
  discoverProtonRoutes: (options?: { requestId?: string; measurePing?: boolean }) =>
    ipcRenderer.invoke('discover-proton-routes', options),
  cancelProtonRouteDiscovery: (requestId: string) =>
    ipcRenderer.invoke('cancel-proton-route-discovery', requestId),
  selectProtonRoute: (options: { measurementId: string; server: string }) =>
    ipcRenderer.invoke('select-proton-route', options),
  cancelProtonOptimization: (requestId: string) => ipcRenderer.invoke('cancel-proton-optimization', requestId),
  onProtonOptimizationProgress: (callback: (progress: ProtonOptimizationProgress & { requestId: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: ProtonOptimizationProgress & { requestId: string }) => callback(progress);
    ipcRenderer.on('proton-optimization-progress', listener);
    return () => ipcRenderer.removeListener('proton-optimization-progress', listener);
  },
  onProtonRouteDiscoveryProgress: (callback: (progress: ProtonOptimizationProgress & { requestId: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: ProtonOptimizationProgress & { requestId: string }) => callback(progress);
    ipcRenderer.on('proton-route-discovery-progress', listener);
    return () => ipcRenderer.removeListener('proton-route-discovery-progress', listener);
  },
  getProtonSettings: () => ipcRenderer.invoke('get-proton-settings'),
  getProtonPlan: (options?: { force?: boolean }) => ipcRenderer.invoke('get-proton-plan', options),
  setProtonSettings: (settings: any) => ipcRenderer.invoke('set-proton-settings', settings),
  onProtonFailoverNotice: (callback: (notice: { message: string }) => void) =>
    ipcRenderer.on('proton-failover-notice', (_event, notice: { message: string }) => callback(notice)),
};
