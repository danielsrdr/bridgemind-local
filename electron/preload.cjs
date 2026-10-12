const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  onHubExit: (fn) => ipcRenderer.on('hub-exit', (_e, code) => fn(code)),
  setTitleBar: (t) => ipcRenderer.invoke('titlebar-theme', t),
  setDictation: (c) => ipcRenderer.invoke('dictation-config', c),
});
