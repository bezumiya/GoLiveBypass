import { ipcRenderer } from 'electron';

(window as any).api = {
  platform: process.platform,
  activate: (proxy?: string) => ipcRenderer.invoke('activate', proxy),
  deactivate: () => ipcRenderer.invoke('deactivate'),
  getStatus: () => ipcRenderer.invoke('get-status'),
  getProxy: () => ipcRenderer.invoke('get-proxy'),
  getPlatform: () => ipcRenderer.invoke('get-platform'),
  getStartup: () => ipcRenderer.invoke('get-startup'),
  setStartup: (enabled: boolean) => ipcRenderer.invoke('set-startup', enabled),
  getNetMode: () => ipcRenderer.invoke('get-net-mode'),
  setNetMode: (mode: string) => ipcRenderer.invoke('set-net-mode', mode),
  getTorStatus: () => ipcRenderer.invoke('get-tor-status'),
  installTor: () => ipcRenderer.invoke('install-tor'),
  testProxy: (proxy: string) => ipcRenderer.invoke('test-proxy', proxy),
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
  onRefreshStatus: (callback: () => void) => ipcRenderer.on('refresh-status', callback),
  // O watchdog do Tor ressuscitou o daemon no meio da sessao: a janela reabre o aviso do
  // Ctrl+R (a reconexao do gateway pode travar o video ate um reload).
  onTorWatchdogRecuperado: (callback: () => void) => ipcRenderer.on('tor-watchdog-recuperado', callback),
  resizeWindow: (height: number) => ipcRenderer.send('resize-window', height),
  setTheme: (theme: string) => ipcRenderer.send('set-theme', theme),
  reportBug: (payload: { title: string; description: string; includeLogs: boolean }) => ipcRenderer.invoke('report-bug', payload),
};
