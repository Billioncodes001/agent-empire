const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('connection',{connect:url=>ipcRenderer.invoke('connect',url),savedHost:()=>ipcRenderer.invoke('saved-host')});
