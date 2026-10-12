// Agent bus: identity, messages, tasks, shared notes. Single source of truth for UI + MCP + hooks.
import { EventEmitter } from 'node:events';
import { all, get, run } from './db.ts';

export const events = new EventEmitter();
events.setMaxListeners(0);
/** Broadcast a state change to UI websockets. */
export const emit = (type: string, data: unknown) => events.emit('ui', { type, data });

export type Status = 'offline' | 'starting' | 'idle' | 'working' | 'waiting';
export interface Agent {
  name: string; role: string | null; profile: string | null; model: string | null; cwd: string | null;
  parent: string | null; kind: 'pane' | 'headless' | 'external'; status: Status; activity: string | null;
  session_id: string | null; transcript: string | null; workspace: string | null; created: number; seen: number;
}
export interface Message { id: number; frm: string; rcpt: string; body: string; ts: number; read: number }
export interface Task {
  id: number; title: string; detail: string | null; status: 'open' | 'claimed' | 'done' | 'failed';
  assignee: string | null; creator: string | null; deps: string; result: string | null; ts: number; updated: number;
}

const now = () => Date.now();

// ---------- agents ----------
export const agents = {
  list: () => all<Agent>('SELECT * FROM agents ORDER BY created'),
  get: (name: string) => get<Agent>('SELECT * FROM agents WHERE name=?', name),
  bySession: (sid: string) => get<Agent>('SELECT * FROM agents WHERE session_id=?', sid),
  upsert(a: Partial<Agent> & { name: string }) {
    const cur = agents.get(a.name);
    const m = { ...(cur ?? { role: null, profile: null, model: null, cwd: null, parent: null, kind: 'external', status: 'idle',
      activity: null, session_id: null, transcript: null, workspace: null, created: now() }), ...a, seen: now() } as Agent;
    run(`INSERT INTO agents(name,role,profile,model,cwd,parent,kind,status,activity,session_id,transcript,workspace,created,seen)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET role=excluded.role,profile=excluded.profile,model=excluded.model,
         cwd=excluded.cwd,parent=excluded.parent,kind=excluded.kind,status=excluded.status,activity=excluded.activity,session_id=excluded.session_id,
         transcript=excluded.transcript,workspace=excluded.workspace,seen=excluded.seen`,
      m.name, m.role, m.profile, m.model, m.cwd, m.parent, m.kind, m.status, m.activity, m.session_id, m.transcript, m.workspace, m.created, m.seen);
    emit('agent', m);
    if (!cur || cur.status !== m.status) events.emit('status', m);
    return m;
  },
  remove(name: string) {
    run('DELETE FROM agents WHERE name=?', name);
    emit('agent:remove', name);
  },
  /** Unique name: "worker" -> "worker-2" if taken by a live agent. */
  uniqueName(base: string) {
    base = base.replace(/[^\w.-]/g, '-').slice(0, 32) || 'agent';
    let n = base, i = 2;
    while (agents.get(n) && agents.get(n)!.status !== 'offline') n = `${base}-${i++}`;
    return n;
  },
};

// ---------- messages ----------
/** Resolve a recipient spec: name | "all" | "@role" | "#parent" (handled by caller). */
function recipients(from: string, to: string): string[] {
  const live = agents.list().filter((a) => a.status !== 'offline' && a.name !== from);
  if (to === 'all' || to === '*') return live.map((a) => a.name);
  if (to.startsWith('@')) return live.filter((a) => a.role === to.slice(1)).map((a) => a.name);
  return to.split(',').map((s) => s.trim()).filter(Boolean);
}

export const messages = {
  send(from: string, to: string, body: string) {
    const rc = recipients(from, to);
    const ids: number[] = [];
    for (const r of rc) {
      const id = Number(run('INSERT INTO messages(frm,rcpt,body,ts) VALUES(?,?,?,?)', from, r, body, now()).lastInsertRowid);
      ids.push(id);
      const m = get<Message>('SELECT * FROM messages WHERE id=?', id)!;
      emit('message', m);
      events.emit('inbox', r, m);
    }
    return { delivered: rc, ids };
  },
  unread: (name: string) => all<Message>('SELECT * FROM messages WHERE rcpt=? AND read=0 ORDER BY id', name),
  /** Atomically fetch + mark read. */
  take(name: string) {
    const ms = messages.unread(name);
    if (ms.length) run(`UPDATE messages SET read=1 WHERE rcpt=? AND id<=?`, name, ms.at(-1)!.id);
    if (ms.length) emit('read', { name, upto: ms.at(-1)!.id });
    return ms;
  },
  recent: (limit = 200) => all<Message>('SELECT * FROM messages ORDER BY id DESC LIMIT ?', limit).reverse(),
  /** Resolve when name has unread mail, or after timeout. */
  wait(name: string, ms: number, signal?: AbortSignal): Promise<Message[]> {
    const have = messages.take(name);
    if (have.length || ms <= 0) return Promise.resolve(have);
    return new Promise((res) => {
      const done = () => { clearTimeout(t); events.off('inbox', on); signal?.removeEventListener('abort', done); res(messages.take(name)); };
      const on = (r: string) => { if (r === name) setTimeout(done, 150); }; // small debounce to batch bursts
      const t = setTimeout(done, ms);
      events.on('inbox', on);
      signal?.addEventListener('abort', done);
    });
  },
  /** Compact rendering used everywhere an agent reads mail (token-lean). */
  fmt: (ms: Message[]) => ms.map((m) => `[${m.frm}→${m.rcpt === m.frm ? 'self' : 'you'} #${m.id}] ${m.body}`).join('\n'),
};

// ---------- tasks ----------
const depsDone = (t: Task) => {
  const d: number[] = JSON.parse(t.deps);
  return d.every((id) => get<{ status: string }>('SELECT status FROM tasks WHERE id=?', id)?.status === 'done');
};
export const tasks = {
  list: (status?: string) =>
    status ? all<Task>('SELECT * FROM tasks WHERE status=? ORDER BY id', status) : all<Task>('SELECT * FROM tasks ORDER BY id'),
  get: (id: number) => get<Task>('SELECT * FROM tasks WHERE id=?', id),
  add(creator: string, title: string, detail?: string, assignee?: string, deps: number[] = []) {
    const id = Number(run('INSERT INTO tasks(title,detail,assignee,creator,deps,ts,updated,status) VALUES(?,?,?,?,?,?,?,?)',
      title, detail ?? null, assignee ?? null, creator, JSON.stringify(deps), now(), now(), assignee ? 'claimed' : 'open').lastInsertRowid);
    const t = tasks.get(id)!;
    emit('task', t);
    if (assignee) messages.send(creator, assignee, `task #${id} assigned: ${title}${detail ? ` — ${detail}` : ''}`);
    return t;
  },
  /** Claim a specific task, or the oldest open one whose deps are done. */
  claim(name: string, id?: number) {
    const cand = id ? [tasks.get(id)].filter(Boolean) as Task[] : tasks.list('open').filter(depsDone);
    const t = cand.find((x) => x.status === 'open' || (x.status === 'claimed' && x.assignee === name));
    if (!t) return undefined;
    run(`UPDATE tasks SET status='claimed', assignee=?, updated=? WHERE id=?`, name, now(), t.id);
    const u = tasks.get(t.id)!;
    emit('task', u);
    return u;
  },
  finish(name: string, id: number, result: string, ok = true) {
    const t = tasks.get(id);
    if (!t) return undefined;
    run('UPDATE tasks SET status=?, result=?, assignee=COALESCE(assignee,?), updated=? WHERE id=?', ok ? 'done' : 'failed', result, name, now(), id);
    const u = tasks.get(id)!;
    emit('task', u);
    if (t.creator && t.creator !== name) messages.send(name, t.creator, `task #${id} ${ok ? 'done' : 'FAILED'}: ${result}`);
    return u;
  },
  remove(id: number) { run('DELETE FROM tasks WHERE id=?', id); emit('task:remove', id); },
  fmt: (ts: Task[]) => ts.map((t) => `#${t.id} [${t.status}${t.assignee ? `:${t.assignee}` : ''}] ${t.title}${JSON.parse(t.deps).length ? ` deps=${t.deps}` : ''}${t.result ? ` → ${t.result.slice(0, 200)}` : ''}`).join('\n') || '(none)',
};

// ---------- notes (shared blackboard) ----------
export const notes = {
  list: () => all<{ k: string; v: string; author: string; ts: number }>('SELECT * FROM notes ORDER BY k'),
  get: (k: string) => get<{ v: string }>('SELECT v FROM notes WHERE k=?', k)?.v,
  set(author: string, k: string, v: string) {
    if (v === '') { run('DELETE FROM notes WHERE k=?', k); emit('note:remove', k); return; }
    run('INSERT INTO notes(k,v,author,ts) VALUES(?,?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v,author=excluded.author,ts=excluded.ts', k, v, author, now());
    emit('note', { k, v, author, ts: now() });
  },
};
