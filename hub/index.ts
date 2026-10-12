// BridgeMind Local hub: one process = HTTP API + WebSocket + MCP + hooks + PTYs + scheduler.
import './env.ts';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { join, extname, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { all, run, kvGet, kvSet, DATA_DIR } from './db.ts';
import { agents, messages, tasks, notes, events } from './bus.ts';
import { ptys } from './pty.ts';
import { PORT, HUB, profiles, startAgent, stopAgent, claudeBin, isDir, runRoutineOnce, type Profile } from './agents.ts';
import { handleHook } from './hooks.ts';
import { handleMcp } from './mcp.ts';
import { listThreads, readThread } from './transcripts.ts';
import { routines, schedule, routinesView, recentRuns, startScheduler, stopRoutine, type Routine } from './scheduler.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const HUMAN = 'human';

// Agents marked live from a previous hub run are stale (their PTYs died with it).
for (const a of agents.list()) if (a.status !== 'offline' && a.kind !== 'external') agents.upsert({ name: a.name, status: 'offline', activity: null });

const workspaces = {
  list: () => all('SELECT * FROM workspaces ORDER BY updated DESC').map((w: any) => ({ ...w, folders: JSON.parse(w.folders), layout: JSON.parse(w.layout) })),
  put(w: any) {
    const id = w.id ?? randomUUID().slice(0, 8), t = Date.now();
    run(`INSERT INTO workspaces(id,name,folders,layout,created,updated) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,
      folders=excluded.folders,layout=excluded.layout,updated=excluded.updated`, id, w.name ?? 'Workspace', JSON.stringify(w.folders ?? []), JSON.stringify(w.layout ?? {}), t, t);
    return workspaces.list().find((x: any) => x.id === id);
  },
};

const state = () => ({
  agents: agents.list(), terms: ptys.list(), tasks: tasks.list(), messages: messages.recent(300), notes: notes.list(),
  profiles: profiles.list(), workspaces: workspaces.list(), routines: routinesView(), runs: recentRuns(),
  settings: { claudePath: claudeBin(), hub: HUB, dataDir: DATA_DIR, lastWorkspace: kvGet('lastWorkspace', null), integrated: kvGet('integrated', false), dictation: dictationCfg() },
});

const dictationCfg = () => ({ enabled: true, hotkey: 'ctrl+win', model: 'onnx-community/whisper-small', language: 'french', autoEnter: false, ...kvGet('dictation', {}) });

// ---------- global integration (opt-in): makes ANY Claude Code session (desktop app included) a team member ----------
function integrate(on: boolean) {
  const p = join(homedir(), '.claude', 'settings.json');
  const s = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
  s.hooks ??= {};
  const mine = (h: any) => JSON.stringify(h).includes(`${HUB}/hook/`);
  for (const ev of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SessionEnd']) {
    s.hooks[ev] = (s.hooks[ev] ?? []).filter((h: any) => !mine(h));
    if (on) s.hooks[ev].push({ ...(/Tool/.test(ev) ? { matcher: '*' } : {}), hooks: [{ type: 'http', url: `${HUB}/hook/${ev}`, timeout: 5 }] });
    if (!s.hooks[ev].length) delete s.hooks[ev];
  }
  writeFileSync(p, JSON.stringify(s, null, 2));
  try { execFileSync(claudeBin(), ['mcp', 'remove', '-s', 'user', 'bridge'], { stdio: 'ignore' }); } catch {}
  if (on) execFileSync(claudeBin(), ['mcp', 'add', '-s', 'user', '--transport', 'http', 'bridge', `${HUB}/mcp`], { stdio: 'ignore' });
  kvSet('integrated', on);
}

// ---------- http ----------
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.json': 'application/json', '.wasm': 'application/wasm', '.mjs': 'text/javascript' };
const json = (res: ServerResponse, data: unknown, code = 200) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(data ?? null));
const readBody = (req: IncomingMessage) => new Promise<string>((ok) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => ok(b)); });

async function api(req: IncomingMessage, res: ServerResponse, url: URL, body: any) {
  const seg = url.pathname.split('/').slice(2).map(decodeURIComponent); // after /api
  const m = req.method!;
  const [a, b, c] = seg;
  switch (a) {
    case 'state': return json(res, state());
    case 'workspaces':
      if (m === 'POST') { const w = workspaces.put(body); kvSet('lastWorkspace', w.id); return json(res, w); }
      if (m === 'DELETE') { run('DELETE FROM workspaces WHERE id=?', b); return json(res, true); }
      break;
    case 'last': kvSet('lastWorkspace', body.id); return json(res, true);
    case 'profiles':
      if (m === 'POST') { const p: Profile = { ...body, id: body.id || randomUUID().slice(0, 8) };
        if (p.isDefault) for (const o of profiles.list<Profile>()) if (o.isDefault && o.id !== p.id) profiles.put({ ...o, isDefault: false });
        profiles.put(p); return json(res, p); }
      if (m === 'DELETE') { profiles.del(b); return json(res, true); }
      break;
    case 'agents':
      if (m === 'POST' && !b) return json(res, startAgent(body));
      if (m === 'POST' && c === 'stop') { stopAgent(b); return json(res, true); }
      if (m === 'DELETE') { stopAgent(b); agents.remove(b); return json(res, true); }
      break;
    case 'messages':
      if (m === 'POST') return json(res, messages.send(body.from ?? HUMAN, body.to, body.body));
      break;
    case 'tasks':
      if (m === 'POST') return json(res, tasks.add(HUMAN, body.title, body.detail, body.assignee || undefined, body.deps ?? []));
      if (m === 'PATCH') {
        if (body.status === 'done' || body.status === 'failed') return json(res, tasks.finish(HUMAN, Number(b), body.result ?? '', body.status === 'done'));
        run('UPDATE tasks SET status=COALESCE(?,status), assignee=?, title=COALESCE(?,title), updated=? WHERE id=?', body.status ?? null, body.assignee ?? null, body.title ?? null, Date.now(), Number(b));
        events.emit('ui', { type: 'task', data: tasks.get(Number(b)) });
        return json(res, tasks.get(Number(b)));
      }
      if (m === 'DELETE') { tasks.remove(Number(b)); return json(res, true); }
      break;
    case 'notes':
      if (m === 'POST') { notes.set(HUMAN, body.k, body.v); return json(res, true); }
      break;
    case 'terms':
      if (m === 'POST') return json(res, startAgent({ ...body, profile: body.profile ?? 'shell' }).term);
      if (m === 'DELETE') { const t = ptys.get(b); if (t?.agent) stopAgent(t.agent); ptys.kill(b); return json(res, true); }
      break;
    case 'routines':
      if (m === 'POST' && c === 'run') return json(res, runRoutineOnce(routines.get<Routine>(b)!));
      if (m === 'POST') { const r: Routine = { enabled: true, ...body, id: body.id || randomUUID().slice(0, 8) }; routines.put(r); schedule(r); return json(res, r); }
      if (m === 'DELETE') { stopRoutine(b); routines.del(b); return json(res, true); }
      break;
    case 'runs': return json(res, recentRuns());
    case 'threads':
      if (!b) return json(res, listThreads());
      return json(res, readThread(b));
    case 'fs': {
      const p = url.searchParams.get('path') || homedir();
      if (!isDir(p)) return json(res, { path: p, parent: null, dirs: [], error: 'not a directory' });
      let dirs: string[] = [];
      try { dirs = readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('$')).map((d) => d.name).sort((x, y) => x.localeCompare(y)); } catch {}
      const par = dirname(p);
      return json(res, { path: p, parent: par === p ? null : par, dirs, drives: process.platform === 'win32' ? 'CDEFGH'.split('').map((d) => `${d}:\\`).filter(isDir) : ['/'] });
    }
    case 'settings':
      if (m === 'POST') { if ('claudePath' in body) kvSet('claudePath', body.claudePath); return json(res, state().settings); }
      break;
    case 'dictation':
      if (m === 'POST') { kvSet('dictation', { ...kvGet('dictation', {}), ...body }); events.emit('ui', { type: 'settings', data: state().settings }); }
      return json(res, dictationCfg());
    case 'shutdown':
      json(res, true);
      setTimeout(() => { ptys.killAll(); process.exit(0); }, 200);
      return;
    case 'integrate':
      try { integrate(!!body.on); return json(res, { ok: true }); } catch (e: any) { return json(res, { ok: false, error: e.message }, 500); }
  }
  json(res, { error: 'not found' }, 404);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url!, HUB);
  const raw = req.method === 'GET' ? '' : await readBody(req);
  try {
    if (url.pathname === '/mcp') return await handleMcp(req, res, url, raw);
    if (url.pathname.startsWith('/hook/')) {
      return json(res, handleHook(url.pathname.slice(6), url.searchParams.get('agent'), raw ? JSON.parse(raw) : {}));
    }
    if (url.pathname.startsWith('/api/')) return await api(req, res, url, raw ? JSON.parse(raw) : {});
    // static UI
    let f = join(DIST, url.pathname === '/' ? 'index.html' : url.pathname);
    if (!f.startsWith(DIST) || !existsSync(f) || statSync(f).isDirectory()) f = join(DIST, 'index.html');
    if (!existsSync(f)) return res.writeHead(200, { 'Content-Type': 'text/plain' }).end('UI not built: run `npm run build` (or `npm run dev`).');
    res.writeHead(200, { 'Content-Type': MIME[extname(f)] ?? 'application/octet-stream', 'Cache-Control': f.includes('assets') ? 'max-age=31536000, immutable' : 'no-cache' }).end(readFileSync(f));
  } catch (e: any) {
    console.error(e);
    if (!res.headersSent) json(res, { error: e.message }, 500);
  }
});

// ---------- websocket ----------
const wss = new WebSocketServer({ server, path: '/ws' });
const clients = new Set<WebSocket>();
const bcast = (o: unknown) => { const s = JSON.stringify(o); for (const c of clients) if (c.readyState === 1) c.send(s); };
events.on('ui', bcast);
events.on('pty', (id: string, d: string) => bcast({ type: 'pty', id, d }));
wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  ws.on('message', (raw) => {
    let m: any; try { m = JSON.parse(String(raw)); } catch { return; }
    if (m.t === 'in') ptys.write(m.id, m.d);
    else if (m.t === 'resize') ptys.resize(m.id, m.cols, m.rows);
    else if (m.t === 'sub') ws.send(JSON.stringify({ type: 'pty:init', id: m.id, d: ptys.scrollback(m.id) }));
  });
});

// ---------- boot ----------
function openWindow() {
  const edge = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
  const url = process.env.BRIDGE_UI ?? HUB;
  if (edge) spawn(edge, [`--app=${url}`, `--user-data-dir=${join(DATA_DIR, 'window')}`, '--window-size=1500,920', '--no-first-run'], { detached: true, stdio: 'ignore' }).unref();
  else spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
}

server.on('error', (e: any) => {
  if (e.code === 'EADDRINUSE') { console.log(`hub already running on ${HUB}`); if (process.argv.includes('--open')) openWindow(); process.exit(0); }
  throw e;
});
server.listen(PORT, '127.0.0.1', () => {
  startScheduler();
  console.log(`BridgeMind hub on ${HUB}  (claude: ${claudeBin()}, data: ${DATA_DIR})`);
  if (process.argv.includes('--open')) openWindow();
});
const bye = () => { ptys.killAll(); process.exit(0); };
process.on('SIGINT', bye);
process.on('SIGTERM', bye);

