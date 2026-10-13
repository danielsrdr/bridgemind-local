const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  onHubExit: (fn) => { const l = (_e, code) => fn(code); ipcRenderer.on('hub-exit', l); return () => ipcRenderer.removeListener('hub-exit', l); },
  setTitleBar: (t) => ipcRenderer.invoke('titlebar-theme', t),
  setDictation: (c) => ipcRenderer.invoke('dictation-config', c),
});
