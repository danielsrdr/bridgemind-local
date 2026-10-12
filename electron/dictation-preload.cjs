const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dict', {
  on: (ev, fn) => ipcRenderer.on(`dict:${ev}`, (_e, arg) => fn(arg)),
  result: (text) => ipcRenderer.send('dict:result', text),
  error: (msg) => ipcRenderer.send('dict:error', msg),
});
