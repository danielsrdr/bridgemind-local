// Client state: snapshot from /api/state, then kept live by websocket events.
import { create } from 'zustand';
import type { Agent, Message, Task, Note, Profile, Workspace, Term, Routine, Run, Settings } from './types';

export type Mode = 'agent' | 'code' | 'thread';

interface S {
  ready: boolean; connected: boolean; mode: Mode;
  agents: Agent[]; terms: Term[]; tasks: Task[]; messages: Message[]; notes: Note[];
  profiles: Profile[]; workspaces: Workspace[]; routines: Routine[]; runs: Run[]; settings: Settings;
  ws: string | null; // active workspace id
  focus: string | null; // focused term id
  dock: 'team' | 'browser' | null;
  browserUrl: string;
  settingsOpen: boolean;
  set: (p: Partial<S>) => void;
}

const ls = (k: string, d: any) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } };
export const useS = create<S>((set) => ({
  ready: false, connected: false, mode: ls('bm.mode', 'code'),
  agents: [], terms: [], tasks: [], messages: [], notes: [], profiles: [], workspaces: [], routines: [], runs: [], settings: {} as Settings,
  ws: null, focus: null, dock: ls('bm.dock', 'team'), browserUrl: ls('bm.url', 'http://localhost:3000'), settingsOpen: false,
  set: (p) => set(p),
}));
useS.subscribe((s) => { try { localStorage.setItem('bm.mode', JSON.stringify(s.mode)); localStorage.setItem('bm.dock', JSON.stringify(s.dock)); localStorage.setItem('bm.url', JSON.stringify(s.browserUrl)); } catch {} });

export const api = async <T = any>(path: string, method = 'GET', body?: unknown): Promise<T> => {
  const r = await fetch(`/api/${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return r.json();
};

export async function refresh() {
  const s = await api('state');
  const st = useS.getState();
  const ws = st.ws ?? s.settings.lastWorkspace ?? s.workspaces[0]?.id ?? null;
  useS.setState({ ...s, ws, ready: true });
}

// ---------- websocket ----------
type PtyListener = (d: string, init?: boolean) => void;
const ptyListeners = new Map<string, PtyListener>();
let sock: WebSocket | null = null;
const queue: string[] = [];
export const wsSend = (o: unknown) => { const s = JSON.stringify(o); sock?.readyState === 1 ? sock.send(s) : queue.push(s); };
export function onPty(id: string, fn: PtyListener) { ptyListeners.set(id, fn); wsSend({ t: 'sub', id }); return () => { if (ptyListeners.get(id) === fn) ptyListeners.delete(id); }; }

const upsert = <T,>(arr: T[], item: T, key: keyof T) => {
  const i = arr.findIndex((x) => x[key] === item[key]);
  if (i < 0) return [...arr, item];
  const c = arr.slice(); c[i] = item; return c;
};

export function connect() {
  sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  sock.onopen = () => { useS.setState({ connected: true }); while (queue.length) sock!.send(queue.shift()!); refresh(); for (const id of ptyListeners.keys()) wsSend({ t: 'sub', id }); };
  sock.onclose = () => { useS.setState({ connected: false }); setTimeout(connect, 1000); };
  sock.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === 'pty') return ptyListeners.get(m.id)?.(m.d);
    if (m.type === 'pty:init') return ptyListeners.get(m.id)?.(m.d, true);
    const s = useS.getState(), d = m.data;
    switch (m.type) {
      case 'agent': return useS.setState({ agents: upsert(s.agents, d, 'name') });
      case 'agent:remove': return useS.setState({ agents: s.agents.filter((a) => a.name !== d) });
      case 'term': return useS.setState({ terms: upsert(s.terms, d, 'id') });
      case 'term:remove': return useS.setState({ terms: s.terms.filter((t) => t.id !== d), focus: s.focus === d ? null : s.focus });
      case 'message': return useS.setState({ messages: [...s.messages, d].slice(-500) });
      case 'read': return useS.setState({ messages: s.messages.map((x) => (x.rcpt === d.name && x.id <= d.upto ? { ...x, read: 1 } : x)) });
      case 'task': return useS.setState({ tasks: upsert(s.tasks, d, 'id') });
      case 'task:remove': return useS.setState({ tasks: s.tasks.filter((t) => t.id !== d) });
      case 'note': return useS.setState({ notes: upsert(s.notes, d, 'k') });
      case 'note:remove': return useS.setState({ notes: s.notes.filter((n) => n.k !== d) });
      case 'run': return useS.setState({ runs: upsert(s.runs, d, 'id').sort((a, b) => b.id - a.id) });
    }
  };
}
