// System-wide push-to-talk dictation: hold the hotkey anywhere in Windows, speak, release →
// local Whisper (in a hidden overlay renderer) transcribes → text is pasted into the focused app.
const { BrowserWindow, clipboard, screen, ipcMain } = require('electron');
const { uIOhook, UiohookKey: K } = require('uiohook-napi');
const { join } = require('node:path');

const HOTKEYS = {
  'ctrl+win': [[K.Ctrl, K.CtrlRight], [K.Meta, K.MetaRight]],
  'ctrl+alt': [[K.Ctrl, K.CtrlRight], [K.Alt]],
  'ctrl+shift': [[K.Ctrl, K.CtrlRight], [K.Shift, K.ShiftRight]],
  'right-ctrl': [[K.CtrlRight]],
};

let cfg = { enabled: true, hotkey: 'ctrl+win', model: 'onnx-community/whisper-small', language: 'french', autoEnter: false };
let overlay = null, hub = '', down = new Set(), state = 'idle', aborted = false, started = false;

function createOverlay() {
  const W = 260, H = 54, { workArea } = screen.getPrimaryDisplay();
  overlay = new BrowserWindow({
    width: W, height: H, x: Math.round(workArea.x + (workArea.width - W) / 2), y: workArea.y + workArea.height - H - 28,
    frame: false, transparent: true, resizable: false, movable: false, alwaysOnTop: true, skipTaskbar: true,
    focusable: false, show: false, hasShadow: false,
    webPreferences: { preload: join(__dirname, 'dictation-preload.cjs'), backgroundThrottling: false, contextIsolation: true },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setIgnoreMouseEvents(true);
  overlay.loadURL(`${hub}/dictation.html`);
  overlay.webContents.once('did-finish-load', () => overlay.webContents.send('dict:config', cfg));
}

const combo = () => HOTKEYS[cfg.hotkey] ?? HOTKEYS['ctrl+win'];
const comboHeld = () => combo().every((alts) => alts.some((k) => down.has(k)));
const isComboKey = (k) => combo().some((alts) => alts.includes(k));

function start() {
  if (state !== 'idle' || !overlay) return;
  state = 'rec'; aborted = false;
  overlay.showInactive(); // never steal focus from the app we will paste into
  overlay.webContents.send('dict:start');
}
function stop(cancel) {
  if (state !== 'rec') return;
  state = cancel ? 'idle' : 'busy';
  overlay.webContents.send(cancel ? 'dict:cancel' : 'dict:stop');
  if (cancel) overlay.hide();
}

async function paste(text) {
  const prev = clipboard.readText();
  clipboard.writeText(text);
  // Wait until the user has let go of every modifier, else Ctrl+V becomes Ctrl+Win+V etc.
  for (let i = 0; i < 40 && down.size; i++) await new Promise((r) => setTimeout(r, 25));
  uIOhook.keyTap(K.V, [K.Ctrl]);
  if (cfg.autoEnter) setTimeout(() => uIOhook.keyTap(K.Enter), 80);
  setTimeout(() => { if (clipboard.readText() === text) clipboard.writeText(prev); }, 600);
}

ipcMain.on('dict:result', (_e, text) => {
  state = 'idle';
  overlay?.hide();
  text = String(text || '').trim();
  if (text && !aborted) paste(text + ' ');
});
ipcMain.on('dict:error', () => { state = 'idle'; setTimeout(() => overlay?.hide(), 1500); });

function setConfig(c) {
  cfg = { ...cfg, ...c };
  overlay?.webContents.send('dict:config', cfg);
}

function init(hubUrl, initial) {
  hub = hubUrl;
  if (initial) cfg = { ...cfg, ...initial };
  createOverlay();
  uIOhook.on('keydown', (e) => {
    down.add(e.keycode);
    if (!cfg.enabled) return;
    if (state === 'rec' && !isComboKey(e.keycode)) { aborted = true; stop(true); return; } // it was a shortcut, not dictation
    if (state === 'idle' && comboHeld() && !started) {
      started = true;
      // small delay so quick shortcuts (Ctrl+Win+D…) don't flash the overlay
      setTimeout(() => { if (comboHeld() && state === 'idle') start(); }, 180);
    }
  });
  uIOhook.on('keyup', (e) => {
    down.delete(e.keycode);
    if (isComboKey(e.keycode)) { started = false; if (state === 'rec') stop(false); }
  });
  uIOhook.start();
}

function dispose() { try { uIOhook.stop(); } catch {} }

module.exports = { init, setConfig, dispose };
