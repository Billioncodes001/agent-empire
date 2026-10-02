/** GitHub code window: the three buttons, nothing else. main.cjs checks the sender on each call. */
const { contextBridge, ipcRenderer } = require('electron');
if (location.protocol === 'file:' && location.pathname.endsWith('/device.html'))
  contextBridge.exposeInMainWorld('deviceCode', {
    info: () => ipcRenderer.invoke('device:info'),
    copy: () => ipcRenderer.invoke('device:copy'),
    open: () => ipcRenderer.invoke('device:open'),
    cancel: () => ipcRenderer.invoke('device:cancel'),
  });
