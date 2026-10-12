// BridgeMind desktop shell (Electron). The hub runs as a child process (Electron's own Node),
// so agents keep running when the window is closed to the tray, and a hub crash never takes the UI down.
const { app, BrowserWindow, Tray, Menu, nativeImage, shell, session, ipcMain } = require('electron');
const { spawn, execFile } = require('node:child_process');
const { join } = require('node:path');
const { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const dictation = require('./dictation.cjs');

const PORT = Number(process.env.BRIDGE_PORT || 7777);
const HUB = `http://127.0.0.1:${PORT}`;
const ROOT = join(__dirname, '..');
const DATA = process.env.BRIDGE_DATA || join(os.homedir(), '.bridgemind');
const ICON = join(ROOT, 'electron', 'icon.ico');
const DEV_URL = process.env.BRIDGE_DEV_URL; // e.g. http://localhost:5173 for HMR
mkdirSync(DATA, { recursive: true });

app.setAppUserModelId('local.bridgemind');
if (!app.requestSingleInstanceLock()) app.quit();

let win = null, tray = null, hub = null, quitting = false;

const ping = () => new Promise((ok) => {
  const r = http.get(`${HUB}/api/settings`, { timeout: 800 }, (res) => { res.resume(); ok(true); });
  r.on('error', () => ok(false)); r.on('timeout', () => { r.destroy(); ok(false); });
});

async function startHub() {
  if (await ping()) return; // already running (e.g. started by `npm run hub`) — just attach
  const entry = [join(ROOT, 'build', 'hub.mjs'), join(ROOT, 'hub', 'index.ts')].find(existsSync);
  const log = openSync(join(DATA, 'hub.log'), 'a');
  hub = spawn(process.execPath, [entry], { cwd: ROOT, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', log, log], windowsHide: true });
  hub.on('exit', (code) => { hub = null; if (!quitting && win) win.webContents.send('hub-exit', code); });
  for (let i = 0; i < 60 && !(await ping()); i++) await new Promise((r) => setTimeout(r, 150));
}

function stopHub() {
  if (!hub) return;
  // /T: also kills agent PTYs (claude.exe, shells) spawned by the hub
  try { execFile('taskkill', ['/PID', String(hub.pid), '/T', '/F']); } catch {}
  hub = null;
}

// ---- window state ----
const stateFile = join(DATA, 'window.json');
const loadState = () => { try { return JSON.parse(readFileSync(stateFile, 'utf8')); } catch { return { width: 1500, height: 920 }; } };
const saveState = () => {
  if (!win) return;
  const b = win.getNormalBounds();
  try { writeFileSync(stateFile, JSON.stringify({ ...b, max: win.isMaximized() })); } catch {}
};

function createWindow() {
  const st = loadState();
  win = new BrowserWindow({
    ...st, minWidth: 900, minHeight: 560, show: false, icon: ICON, backgroundColor: '#0b0c10', title: 'BridgeMind',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#111318', symbolColor: '#e6e8ee', height: 44 },
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, spellcheck: false, backgroundThrottling: false },
  });
  if (st.max) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.loadURL(DEV_URL || HUB);
  // External links open in the real browser; localhost previews stay in-app (browser dock iframe).
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.on('close', (e) => { saveState(); if (!quitting) { e.preventDefault(); win.hide(); } });
  win.on('closed', () => { win = null; });
}

function show() { if (!win) createWindow(); else { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } }

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

ipcMain.handle('titlebar-theme', (_e, t) => { try { win?.setTitleBarOverlay(t); } catch {} });

app.on('second-instance', show);
app.whenReady().then(async () => {
  // Local Whisper dictation needs the microphone; nothing else is granted.
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'media' || perm === 'clipboard-read' || perm === 'clipboard-sanitized-write'));
  Menu.setApplicationMenu(null);
  createTray();
  await startHub();
  createWindow();
  try { dictation.init(HUB, await getJson('/api/dictation')); } catch (e) { console.error('dictation disabled:', e); }
});
app.on('window-all-closed', () => {}); // stay in tray
app.on('before-quit', () => { quitting = true; dictation.dispose(); stopHub(); });
