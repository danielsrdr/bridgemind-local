// BridgeMind desktop shell (Electron). The hub runs as a child process (Electron's own Node),
// so agents keep running when the window is closed to the tray, and a hub crash never takes the UI down.
const { app, BrowserWindow, Tray, Menu, nativeImage, shell, session, ipcMain, screen } = require('electron');
const { spawn, execFileSync } = require('node:child_process');
const { join } = require('node:path');
const { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } = require('node:fs');
const http = require('node:http');
const os = require('node:os');
// Dictation is optional: a failing native module (uiohook-napi) must not take the whole app down.
let dictation = { init() {}, setConfig() {}, dispose() {}, transcribe: async () => null };
try { dictation = require('./dictation.cjs'); } catch (e) { console.error('dictation unavailable:', e); }

const PORT = Number(process.env.BRIDGE_PORT || 7777);
const HUB = `http://127.0.0.1:${PORT}`;
const ROOT = join(__dirname, '..');
const DATA = process.env.BRIDGE_DATA || join(os.homedir(), '.bridgemind');
const ICON = join(ROOT, 'electron', 'icon.ico');
const DEV_URL = process.env.BRIDGE_DEV_URL; // e.g. http://localhost:5173 for HMR
const ORIGIN = new URL(DEV_URL || HUB).origin;
mkdirSync(DATA, { recursive: true });

app.setAppUserModelId('local.bridgemind');
// app.quit() is async: without a hard exit the rest of this file (tray, hub, dictation) would still run in the 2nd instance.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.exit(0);

let win = null, tray = null, hub = null, quitting = false, booted = false, starting = null;

const ping = () => new Promise((ok) => {
  const r = http.get(`${HUB}/api/settings`, { timeout: 800 }, (res) => { res.resume(); ok(true); });
  r.on('error', () => ok(false)); r.on('timeout', () => { r.destroy(); ok(false); });
});

let crashes = 0, lastCrash = 0;
async function spawnHub() {
  if (!hub && !(await ping())) { // not ours and not running: spawn; otherwise just wait for it below
    const entry = [join(ROOT, 'build', 'hub.mjs'), join(ROOT, 'hub', 'index.ts')].find(existsSync);
    const log = openSync(join(DATA, 'hub.log'), 'a');
    const h = hub = spawn(process.execPath, [entry], { cwd: ROOT, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', log, log], windowsHide: true });
    h.on('error', (e) => { console.error('hub spawn failed:', e); if (hub === h) { hub = null; if (!quitting && win) win.webContents.send('hub-exit', -1); } });
    // Only report crashes of the current child: a stopped/replaced child must not clobber `hub` or alarm the UI.
    h.on('exit', (code) => {
      if (hub !== h) return;
      hub = null;
      if (quitting) return;
      if (win) win.webContents.send('hub-exit', code);
      // Crash: bring it back (the UI websocket reconnects by itself). Back off if it keeps dying.
      crashes = Date.now() - lastCrash < 30e3 ? crashes + 1 : 1; lastCrash = Date.now();
      if (crashes <= 3) setTimeout(() => { if (!quitting) startHub(); }, 1000 * crashes);
    });
  }
  for (let i = 0; i < 60 && !quitting && !(await ping()); i++) await new Promise((r) => setTimeout(r, 150));
}
// Serialised: a tray "restart" during boot must not spawn a second hub (its port clash would orphan the first).
const startHub = () => (starting ||= spawnHub().finally(() => { starting = null; }));

function stopHub() {
  if (!hub) return;
  const pid = hub.pid; hub = null;
  // /T: also kills agent PTYs (claude.exe, shells) spawned by the hub. Sync: the app may exit right after this.
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
}

// ---- window state ----
const stateFile = join(DATA, 'window.json');
// Saved position may point at a monitor that is no longer connected: keep it only if it is still on a display.
const onScreen = (s) => Number.isFinite(s.x) && Number.isFinite(s.y) && screen.getAllDisplays().some(({ workArea: w }) =>
  s.x < w.x + w.width && s.x + s.width > w.x && s.y < w.y + w.height && s.y + s.height > w.y);
const loadState = () => {
  try { const s = JSON.parse(readFileSync(stateFile, 'utf8')); return onScreen(s) ? s : { width: s.width || 1500, height: s.height || 920, max: s.max }; }
  catch { return { width: 1500, height: 920 }; }
};
const saveState = () => {
  if (!win) return;
  const b = win.getNormalBounds();
  try { writeFileSync(stateFile, JSON.stringify({ ...b, max: win.isMaximized() })); } catch {}
};

function createWindow() {
  if (win) return;
  const st = loadState();
  win = new BrowserWindow({
    ...st, minWidth: 900, minHeight: 560, show: false, icon: ICON, backgroundColor: '#0b0c10', title: 'BridgeMind',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#111318', symbolColor: '#e6e8ee', height: 44 },
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, spellcheck: false, backgroundThrottling: false },
  });
  if (st.max) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.loadURL(DEV_URL || HUB).catch((e) => console.error('UI load failed:', e));
  // External links open in the real browser (http/https only); localhost previews stay in-app (browser dock iframe).
  const external = (url) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); };
  win.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { // the window itself must never leave the hub origin
    if (url === ORIGIN || url.startsWith(ORIGIN + '/')) return;
    e.preventDefault(); external(url);
  });
  win.on('close', (e) => { saveState(); if (!quitting) { e.preventDefault(); win.hide(); } });
  win.on('closed', () => { win = null; });
}

function show() { if (!win) { if (booted) createWindow(); } else { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } }

function quit() { quitting = true; stopHub(); app.quit(); }

function createTray() {
  tray = new Tray(nativeImage.createFromPath(ICON));
  tray.setToolTip('BridgeMind');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Ouvrir BridgeMind', click: show },
    { label: 'Dossier de données', click: () => shell.openPath(DATA) },
    { label: 'Redémarrer le hub', click: async () => { stopHub(); await new Promise((r) => setTimeout(r, 600)); await startHub(); win?.reload(); } },
    { type: 'separator' },
    { label: 'Quitter (arrête tous les agents)', click: quit },
  ]));
  tray.on('click', show);
}

const getJson = (path) => new Promise((ok) => http.get(HUB + path, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { try { ok(JSON.parse(b)); } catch { ok(null); } }); }).on('error', () => ok(null)));
ipcMain.handle('dictation-config', (_e, c) => dictation.setConfig(c));
ipcMain.handle('dictation-transcribe', (_e, audio) => dictation.transcribe(audio));

ipcMain.handle('titlebar-theme', (_e, t) => { try { win?.setTitleBarOverlay(t); } catch {} });

app.on('second-instance', show);
app.whenReady().then(async () => {
  if (!gotLock) return;
  // Local Whisper dictation needs the microphone only (no camera); nothing else is granted.
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb, d) => cb(perm === 'media' ? !d?.mediaTypes?.includes('video') : perm === 'clipboard-read' || perm === 'clipboard-sanitized-write'));
  Menu.setApplicationMenu(null);
  createTray();
  await startHub();
  if (quitting) return; // quit was requested while the hub was booting
  booted = true;
  createWindow();
  try { dictation.init(HUB, await getJson('/api/dictation')); } catch (e) { console.error('dictation disabled:', e); }
});
app.on('window-all-closed', () => {}); // stay in tray
app.on('before-quit', () => { quitting = true; dictation.dispose(); stopHub(); });
