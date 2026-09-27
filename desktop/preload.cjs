const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('connection',{
  connect:url=>ipcRenderer.invoke('connect',url),
  launcherState:()=>ipcRenderer.invoke('launcher-state'),
  openLocal:choose=>ipcRenderer.invoke('open-local',choose),
  saveCredentials:value=>ipcRenderer.invoke('save-credentials',value),
});
