const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  onHubExit: (fn) => { const l = (_e, code) => fn(code); ipcRenderer.on('hub-exit', l); return () => ipcRenderer.removeListener('hub-exit', l); },
  setTitleBar: (t) => ipcRenderer.invoke('titlebar-theme', t),
  setDictation: (c) => ipcRenderer.invoke('dictation-config', c),
  // In-app dictation reuses the overlay's Whisper: one model in GPU memory instead of two.
  transcribe: (audio) => ipcRenderer.invoke('dictation-transcribe', audio),
});
