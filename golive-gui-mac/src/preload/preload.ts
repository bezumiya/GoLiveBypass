import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('golive', {
  pickConf:       () => ipcRenderer.invoke('golive:pick-conf'),
  importConfig:   (rawText: string) => ipcRenderer.invoke('golive', 'config:import', { rawText }),
  activate:       () => ipcRenderer.invoke('golive', 'tunnel:activate'),
  deactivate:     () => ipcRenderer.invoke('golive', 'tunnel:deactivate'),
  status:         () => ipcRenderer.invoke('golive', 'tunnel:status'),
  fetchProton:    (username: string, password?: string) =>
                    ipcRenderer.invoke('golive', 'proton:fetch', { username, password }),
  exitInfo:       () => ipcRenderer.invoke('golive', 'tunnel:exit'),
  vencordPermission:   () => ipcRenderer.invoke('golive', 'vencord:permission'),
  vencordOpenSettings: () => ipcRenderer.invoke('golive', 'vencord:openSettings'),
  vencordRetry:        () => ipcRenderer.invoke('golive', 'vencord:retry'),
  vencordGetOptIn:     () => ipcRenderer.invoke('golive', 'vencord:getOptIn'),
  vencordSetOptIn:     (enabled: boolean) => ipcRenderer.invoke('golive', 'vencord:setOptIn', { enabled }),
  protonAccount:  () => ipcRenderer.invoke('golive', 'proton:account'),
  protonLogout:   () => ipcRenderer.invoke('golive', 'proton:logout'),
  checkUpdate:    () => ipcRenderer.invoke('golive', 'app:checkUpdate'),
  downloadUpdate: (version: string) => ipcRenderer.invoke('golive', 'app:downloadUpdate', { version }),

  onVencordPermission: (cb: (p: { granted: boolean }) => void) => ipcRenderer.on('vencord:permission', (_e, p) => cb(p)),
  onTunnelState: (cb: (p: { state: string }) => void) => ipcRenderer.on('tunnel:state', (_e, p) => cb(p)),
  onLog:             (cb: (m: string) => void) => ipcRenderer.on('log', (_e, m) => cb(m)),
  onProtonProgress:  (cb: (m: string) => void) => ipcRenderer.on('proton:progress', (_e, m) => cb(m)),
  onUpdateAvailable: (cb: (info: any) => void) => ipcRenderer.on('update:available', (_e, i) => cb(i)),
  onUpdateProgress:  (cb: (m: string) => void) => ipcRenderer.on('update:progress', (_e, m) => cb(m)),
});
