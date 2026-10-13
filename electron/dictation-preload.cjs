const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dict', {
  on: (ev, fn) => { const l = (_e, arg) => fn(arg); ipcRenderer.on(`dict:${ev}`, l); return () => ipcRenderer.removeListener(`dict:${ev}`, l); },
  result: (text) => ipcRenderer.send('dict:result', text),
  error: (msg) => ipcRenderer.send('dict:error', msg),
});
