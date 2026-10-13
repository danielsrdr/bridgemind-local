// System-wide push-to-talk dictation: hold the hotkey anywhere in Windows, speak, release →
// local Whisper (in a hidden overlay renderer) transcribes → text is pasted into the focused app.
const { BrowserWindow, clipboard, powerMonitor, screen, ipcMain } = require('electron');
const { uIOhook, UiohookKey: K } = require('uiohook-napi');
const { join } = require('node:path');

const HOTKEYS = {
  'ctrl+win': [[K.Ctrl, K.CtrlRight], [K.Meta, K.MetaRight]],
  'ctrl+alt': [[K.Ctrl, K.CtrlRight], [K.Alt]],
  'ctrl+shift': [[K.Ctrl, K.CtrlRight], [K.Shift, K.ShiftRight]],
  'right-ctrl': [[K.CtrlRight]],
};
const MODS = [[K.Ctrl, K.CtrlRight], [K.Alt, K.AltRight], [K.Shift, K.ShiftRight], [K.Meta, K.MetaRight]];
const MOD_KEYS = new Set(MODS.flat());
const W = 260, H = 54;

let cfg = { enabled: true, hotkey: 'ctrl+win', model: 'onnx-community/whisper-small', language: 'french', autoEnter: false };
let overlay = null, hub = '', down = new Set(), state = 'idle', aborted = false, started = false, inited = false;

const alive = () => !!overlay && !overlay.isDestroyed();
// Overlay follows the cursor's display (not always the primary one).
function place() {
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  overlay.setBounds({ x: Math.round(workArea.x + (workArea.width - W) / 2), y: workArea.y + workArea.height - H - 28, width: W, height: H });
}

function createOverlay() {
  overlay = new BrowserWindow({
    width: W, height: H,
    frame: false, transparent: true, resizable: false, movable: false, alwaysOnTop: true, skipTaskbar: true,
    focusable: false, show: false, hasShadow: false,
    webPreferences: { preload: join(__dirname, 'dictation-preload.cjs'), backgroundThrottling: false, contextIsolation: true },
  });
  place();
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setIgnoreMouseEvents(true);
  overlay.loadURL(`${hub}/dictation.html`).catch((e) => console.error('overlay load failed:', e));
  overlay.webContents.once('did-finish-load', () => overlay.webContents.send('dict:config', cfg));
  // Renderer crashed mid-session: drop the stuck state and rebuild the overlay.
  overlay.webContents.on('render-process-gone', () => {
    const o = overlay; overlay = null; state = 'idle';
    setTimeout(() => { try { o.destroy(); } catch {} createOverlay(); }, 1000);
  });
}

const combo = () => HOTKEYS[cfg.hotkey] ?? HOTKEYS['ctrl+win'];
const comboHeld = () => combo().every((alts) => alts.some((k) => down.has(k)));
const isComboKey = (k) => combo().some((alts) => alts.includes(k));
// A missed keyup (Win+L, lock screen, focus stolen) would leave a modifier in `down` forever: drop any the OS reports as up.
function prune(e) {
  const up = [e.ctrlKey, e.altKey, e.shiftKey, e.metaKey];
  MODS.forEach(([a, b], i) => { if (!up[i]) { down.delete(a); down.delete(b); } });
}
function reset() { down.clear(); started = false; if (state === 'rec') { aborted = true; stop(true); } }

function start() {
  if (state !== 'idle' || !alive()) return;
  state = 'rec'; aborted = false;
  place();
  overlay.showInactive(); // never steal focus from the app we will paste into
  overlay.webContents.send('dict:start');
}
function stop(cancel) {
  if (state !== 'rec' || !alive()) return;
  state = cancel ? 'idle' : 'busy';
  overlay.webContents.send(cancel ? 'dict:cancel' : 'dict:stop');
  if (cancel) overlay.hide();
}

async function paste(text) {
  try {
    // Snapshot every text/html/rtf/image format so a copied picture or formatted text survives the paste.
    const prev = { text: clipboard.readText(), html: clipboard.readHTML(), rtf: clipboard.readRTF(), image: clipboard.readImage() };
    clipboard.writeText(text);
    // Wait until the user has let go of every modifier, else Ctrl+V becomes Ctrl+Win+V etc.
    for (let i = 0; i < 40 && down.size; i++) await new Promise((r) => setTimeout(r, 25));
    uIOhook.keyTap(K.V, [K.Ctrl]);
    if (cfg.autoEnter) setTimeout(() => uIOhook.keyTap(K.Enter), 120);
    setTimeout(() => {
      try {
        if (clipboard.readText() !== text) return; // user copied something else meanwhile
        const data = {};
        if (prev.text) data.text = prev.text;
        if (prev.html) data.html = prev.html;
        if (prev.rtf) data.rtf = prev.rtf;
        if (!prev.image.isEmpty()) data.image = prev.image;
        clipboard.clear();
        if (Object.keys(data).length) clipboard.write(data);
      } catch (e) { console.error('clipboard restore failed:', e); }
    }, 1000);
  } catch (e) { console.error('paste failed:', e); }
}

ipcMain.on('dict:result', (_e, text) => {
  state = 'idle';
  if (alive()) overlay.hide();
  text = String(text || '').trim();
  if (text && !aborted) paste(text + ' ');
});
ipcMain.on('dict:error', () => { state = 'idle'; setTimeout(() => { if (alive()) overlay.hide(); }, 1500); });

function setConfig(c) {
  cfg = { ...cfg, ...c };
  if (!cfg.enabled && state === 'rec') { aborted = true; stop(true); }
  if (alive()) overlay.webContents.send('dict:config', cfg);
}

function init(hubUrl, initial) {
  if (inited) return; inited = true; // IPC/hook listeners must not be registered twice
  hub = hubUrl;
  if (initial) cfg = { ...cfg, ...initial };
  createOverlay();
  uIOhook.on('keydown', (e) => {
    if (!MOD_KEYS.has(e.keycode)) prune(e);
    down.add(e.keycode);
    if (!comboHeld()) started = false;
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
  powerMonitor.on('lock-screen', reset); // Win+L: the keyups are swallowed
  powerMonitor.on('suspend', reset);
  uIOhook.start();
}

function dispose() { try { uIOhook.stop(); } catch {} }

module.exports = { init, setConfig, dispose };
