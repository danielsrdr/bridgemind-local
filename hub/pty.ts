// PTY sessions with bounded scrollback, multiplexed to UI over the websocket.
import pty from '@lydell/node-pty';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { emit, events } from './bus.ts';

export interface Term {
  id: string; title: string; cwd: string; agent: string | null; workspace: string | null;
  cmd: string; args: string[]; pid: number; alive: boolean; started: number;
}
interface Live extends Term { p: pty.IPty; buf: string[]; bufLen: number }

const MAX_BUF = 256 * 1024;
const terms = new Map<string, Live>();
const pub = (t: Live): Term => ({ id: t.id, title: t.title, cwd: t.cwd, agent: t.agent, workspace: t.workspace, cmd: t.cmd, args: t.args, pid: t.pid, alive: t.alive, started: t.started });

export const ptys = {
  list: () => [...terms.values()].map(pub),
  get: (id: string) => terms.get(id),
  byAgent: (agent: string) => [...terms.values()].find((t) => t.agent === agent && t.alive),
  spawn(o: { cmd: string; args?: string[]; cwd: string; env?: Record<string, string>; title?: string; agent?: string; workspace?: string; cols?: number; rows?: number }) {
    const id = randomUUID().slice(0, 8);
    const env = { ...process.env, ...o.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', FORCE_COLOR: '1' } as Record<string, string>;
    for (const [k, v] of Object.entries(env)) if (v === '') delete env[k]; // '' in profile env = unset
    const p = pty.spawn(o.cmd, o.args ?? [], { name: 'xterm-256color', cols: o.cols ?? 120, rows: o.rows ?? 32, cwd: o.cwd, env, useConpty: true });
    const t: Live = { id, title: o.title ?? o.cmd, cwd: o.cwd, agent: o.agent ?? null, workspace: o.workspace ?? null, cmd: o.cmd, args: o.args ?? [],
      pid: p.pid, alive: true, started: Date.now(), p, buf: [], bufLen: 0 };
    terms.set(id, t);
    // Coalesce output into ~16ms frames: far fewer WS messages under heavy agent output.
    let pending = '', timer: NodeJS.Timeout | null = null;
    p.onData((d) => {
      t.buf.push(d); t.bufLen += d.length;
      while (t.bufLen > MAX_BUF && t.buf.length > 1) t.bufLen -= t.buf.shift()!.length;
      pending += d;
      timer ??= setTimeout(() => { events.emit('pty', id, pending); pending = ''; timer = null; }, 16);
    });
    p.onExit(({ exitCode }) => {
      t.alive = false;
      // Closed by the user: kill() already removed it — re-emitting 'term' would resurrect an empty black pane.
      if (terms.get(id) !== t) return;
      if (timer) { clearTimeout(timer); events.emit('pty', id, pending); }
      events.emit('pty', id, `\r\n\x1b[90m[process exited ${exitCode}]\x1b[0m\r\n`);
      emit('term', pub(t));
      events.emit('term:exit', pub(t));
    });
    emit('term', pub(t));
    return pub(t);
  },
  write: (id: string, data: string) => { const t = terms.get(id); if (t?.alive) t.p.write(data); },
  /** Type a line into a TUI as a user would: text first, then Enter (avoids paste-detection eating the CR). */
  typeLine(id: string, text: string) {
    const t = terms.get(id);
    if (!t?.alive) return false;
    t.p.write(text);
    setTimeout(() => t.alive && t.p.write('\r'), 120);
    return true;
  },
  resize: (id: string, cols: number, rows: number) => { const t = terms.get(id); if (t?.alive && cols > 0 && rows > 0) try { t.p.resize(cols, rows); } catch {} },
  scrollback: (id: string) => terms.get(id)?.buf.join('') ?? '',
  kill(id: string) {
    const t = terms.get(id);
    if (!t) return;
    if (t.alive) {
      // Whole tree: claude.exe spawns shells/MCP children that ConPTY alone would orphan.
      if (process.platform === 'win32') execFile('taskkill', ['/PID', String(t.pid), '/T', '/F'], () => {});
      try { t.p.kill(); } catch {}
    }
    terms.delete(id);
    emit('term:remove', id);
  },
  killAll() { for (const id of terms.keys()) ptys.kill(id); },
};
