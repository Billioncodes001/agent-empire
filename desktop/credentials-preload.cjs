/** Provider keys window (local mode only). main.cjs checks the sender on each call. */
const { contextBridge, ipcRenderer } = require('electron');
if (location.protocol === 'file:' && location.pathname.endsWith('/credentials.html'))
  contextBridge.exposeInMainWorld('providerKeys', {
    state: () => ipcRenderer.invoke('keys:state'),
    save: (value) => ipcRenderer.invoke('keys:save', value),
  });
