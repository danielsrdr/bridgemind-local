// Agent profiles + launcher. Every Claude agent we start is wired to the hub via:
//   --mcp-config  -> bridge MCP (send/inbox/tasks/notes/spawn)   identity = ?agent=<name>
//   --settings    -> HTTP hooks (status + push delivery of messages, zero polling)
//   --append-system-prompt -> short team protocol
import { spawn as cpSpawn, execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { blobs, kvGet, DATA_DIR, run as dbRun, get } from './db.ts';
import { agents, messages, notes, emit, type Agent } from './bus.ts';
import { ptys } from './pty.ts';

export interface Profile {
  id: string; name: string; kind: 'claude' | 'shell';
  command?: string; args?: string[]; model?: string; env?: Record<string, string>;
  configDir?: string; permissionMode?: string; isDefault?: boolean;
  /** Load the user's other MCP servers too (costs tokens on every turn). Default false. */
  inheritMcp?: boolean;
  /** Load skills (default: on for panes, off for headless workers). */
  skills?: boolean;
  effort?: string;
}

export const PORT = Number(process.env.BRIDGE_PORT ?? 7777);
export const HUB = `http://127.0.0.1:${PORT}`;
const RUNTIME = join(DATA_DIR, 'runtime');
mkdirSync(RUNTIME, { recursive: true });

export const profiles = blobs('profiles');
const DEFAULTS: Profile[] = [
  { id: 'opus', name: 'Claude Opus', kind: 'claude', model: 'opus', isDefault: true },
  { id: 'sonnet', name: 'Claude Sonnet', kind: 'claude', model: 'sonnet' },
  { id: 'haiku', name: 'Claude Haiku', kind: 'claude', model: 'haiku' },
  { id: 'local', name: 'Local (Ollama)', kind: 'claude', model: 'qwen3-coder',
    env: { ANTHROPIC_BASE_URL: 'http://localhost:11434', ANTHROPIC_AUTH_TOKEN: 'ollama', ANTHROPIC_API_KEY: '' } },
  { id: 'shell', name: 'PowerShell', kind: 'shell', command: 'powershell.exe', args: ['-NoLogo'] },
];
if (!profiles.list().length) DEFAULTS.forEach((p) => profiles.put(p));
export const profileFor = (idOrModel?: string): Profile => {
  const all = profiles.list<Profile>();
  return all.find((p) => p.id === idOrModel) ?? all.find((p) => p.kind === 'claude' && p.model === idOrModel)
    ?? (idOrModel && /^(opus|sonnet|haiku|claude-)/.test(idOrModel) ? { ...all.find((p) => p.isDefault)!, id: idOrModel, model: idOrModel } : undefined)
    ?? all.find((p) => p.isDefault) ?? DEFAULTS[0];
};

// ---------- locate claude ----------
let claudeCache: string | null = null;
export function claudeBin(): string {
  const override = kvGet<string>('claudePath', '');
  if (override && existsSync(override)) return override;
  if (claudeCache && existsSync(claudeCache)) return claudeCache;
  const cands: string[] = [];
  try { cands.push(...execFileSync('where.exe', ['claude'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/).filter((l) => /\.(exe|cmd)$/i.test(l))); } catch {}
  cands.push(join(homedir(), '.local', 'bin', 'claude.exe'));
  // Claude desktop app ships its own CLI: %APPDATA%\Claude\claude-code\<ver>\<hash>\claude.exe
  // (MSIX install: outside the app that folder really lives in %LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming)
  const roots = [join(process.env.APPDATA ?? '', 'Claude', 'claude-code')];
  const pk = join(process.env.LOCALAPPDATA ?? '', 'Packages');
  if (existsSync(pk)) for (const d of readdirSync(pk)) if (d.startsWith('Claude_')) roots.push(join(pk, d, 'LocalCache', 'Roaming', 'Claude', 'claude-code'));
  for (const root of roots.filter(existsSync)) {
    const vers = readdirSync(root).filter((v) => /^\d+\.\d+\.\d+/.test(v))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const v of vers) for (const h of readdirSync(join(root, v))) cands.push(join(root, v, h, 'claude.exe'));
  }
  claudeCache = cands.find((c) => existsSync(c)) ?? 'claude';
  return claudeCache;
}

// ---------- protocol (kept short: it is paid on every turn) ----------
export function protocol(a: { name: string; role?: string | null; parent?: string | null }) {
  return [
    `You are agent "${a.name}"${a.role ? ` (role: ${a.role})` : ''} in a local multi-agent team (BridgeMind). Team tools: mcp__bridge__*.`,
    `- Incoming messages are injected automatically as "[sender→you #id] ...". Never poll the inbox in a loop; use inbox(wait) only when you are blocked waiting on a reply.`,
    `- Be terse with teammates: ≤3 lines per message. Share file paths, note keys or task ids instead of pasting content.`,
    `- Shared facts/specs/decisions go in notes (note_set); split work with tasks (task_add/task_claim/task_done; task_done notifies the creator).`,
    `- Delegate cheap/parallel subtasks with spawn (model "haiku", headless:true returns its result to you as a message).`,
    a.parent ? `- Your lead is "${a.parent}". When done, report the outcome with task_done or send(to:"${a.parent}").` : `- You are a lead: plan, delegate, integrate, verify.`,
  ].join('\n');
}

const hookSettings = (name: string) => {
  const h = (ev: string, matcher?: boolean) => [{ ...(matcher ? { matcher: '*' } : {}), hooks: [{ type: 'http', url: `${HUB}/hook/${ev}?agent=${encodeURIComponent(name)}`, timeout: 10 }] }];
  return { permissions: { allow: ['mcp__bridge'] }, voice: { enabled: true, mode: 'hold' }, hooks: {
    SessionStart: h('SessionStart'), UserPromptSubmit: h('UserPromptSubmit'), PreToolUse: h('PreToolUse', true),
    PostToolUse: h('PostToolUse', true), Notification: h('Notification'), Stop: h('Stop'), SessionEnd: h('SessionEnd'),
  } };
};
const mcpConfig = (name: string) => ({ mcpServers: { bridge: { type: 'http', url: `${HUB}/mcp?agent=${encodeURIComponent(name)}` } } });

function claudeArgs(a: { name: string; role?: string | null; parent?: string | null }, prof: Profile, model?: string, x: { headless?: boolean; effort?: string } = {}) {
  const dir = join(RUNTIME, a.name);
  mkdirSync(dir, { recursive: true });
  const mcp = join(dir, 'mcp.json'), set = join(dir, 'settings.json'), sys = join(dir, 'protocol.md');
  writeFileSync(mcp, JSON.stringify(mcpConfig(a.name)));
  writeFileSync(set, JSON.stringify(hookSettings(a.name)));
  writeFileSync(sys, protocol(a));
  const args = ['--mcp-config', mcp, ...(prof.inheritMcp ? [] : ['--strict-mcp-config']), '--settings', set, '--append-system-prompt-file', sys, '-n', a.name];
  const m = model || prof.model;
  if (m) args.push('--model', m);
  if (prof.permissionMode) args.push('--permission-mode', prof.permissionMode);
  // Skills listings cost tokens every turn: off for headless workers unless the profile opts in, on for panes unless it opts out.
  if (x.headless ? prof.skills !== true : prof.skills === false) args.push('--disable-slash-commands');
  const effort = x.effort ?? prof.effort;
  if (effort) args.push('--effort', effort);
  args.push(...(prof.args ?? []));
  // Wait for the (local, instant) bridge MCP before the first turn, else an initial prompt runs without team tools.
  const env: Record<string, string> = { MCP_CONNECTION_NONBLOCKING: 'false', ...(prof.env ?? {}), BRIDGE_AGENT: a.name, BRIDGE_HUB: HUB };
  if (prof.configDir) env.CLAUDE_CONFIG_DIR = prof.configDir;
  return { args, env };
}

/** Skip the CLI's first-run wizard and the trust prompt for folders the user picked, so agents start straight away. */
function ensureCliReady(cwd: string, prof: Profile) {
  const file = prof.configDir ? join(prof.configDir, '.claude.json') : join(homedir(), '.claude.json');
  let j: any = {};
  try { j = JSON.parse(readFileSync(file, 'utf8')); } catch { if (existsSync(file)) return; }
  const key = cwd.replace(/\\/g, '/');
  let dirty = false;
  if (!j.hasCompletedOnboarding) { j.hasCompletedOnboarding = true; dirty = true; }
  if (!j.theme) { j.theme = 'dark'; dirty = true; }
  j.projects ??= {};
  if (!j.projects[key]?.hasTrustDialogAccepted) { j.projects[key] = { ...(j.projects[key] ?? {}), hasTrustDialogAccepted: true }; dirty = true; }
  if (dirty) writeFileSync(file, JSON.stringify(j, null, 2));
}

export interface SpawnOpts {
  name?: string; role?: string; profile?: string; model?: string; cwd?: string; prompt?: string;
  parent?: string; headless?: boolean; workspace?: string; resume?: string; cols?: number; rows?: number; effort?: string;
}

/** Start an agent (interactive pane, or headless one-shot whose result is mailed to parent). */
export function startAgent(o: SpawnOpts) {
  const prof = profileFor(o.profile ?? o.model);
  const cwd = o.cwd && existsSync(o.cwd) ? o.cwd : homedir();
  if (prof.kind === 'shell') {
    const t = ptys.spawn({ cmd: prof.command ?? 'powershell.exe', args: prof.args, cwd, env: prof.env, title: o.name ?? prof.name, workspace: o.workspace, cols: o.cols, rows: o.rows });
    return { term: t, agent: null as Agent | null };
  }
  const name = agents.uniqueName(o.name ?? o.role ?? (o.headless ? 'worker' : 'agent'));
  const { args, env } = claudeArgs({ name, role: o.role, parent: o.parent }, prof, o.model, { headless: o.headless, effort: o.effort });
  if (!o.headless) ensureCliReady(cwd, prof);
  const agent = agents.upsert({ name, role: o.role ?? null, profile: prof.id, model: o.model || prof.model || null, cwd, parent: o.parent ?? null,
    kind: o.headless ? 'headless' : 'pane', status: 'starting', activity: null, session_id: null, transcript: null, workspace: o.workspace ?? null, created: Date.now() });

  if (o.resume) args.push('--resume', o.resume);
  if (o.headless) {
    runHeadless(name, args, env, cwd, o.prompt ?? '', o.parent, prof);
    return { term: null, agent };
  }
  if (o.prompt) args.push(o.prompt);
  const term = ptys.spawn({ cmd: claudeBin(), args, cwd, env, title: name, agent: name, workspace: o.workspace, cols: o.cols, rows: o.rows });
  return { term, agent };
}

function runHeadless(name: string, args: string[], env: Record<string, string>, cwd: string, prompt: string, parent: string | undefined, prof: Profile, routine?: string) {
  const full = ['-p', '--output-format', 'json', ...(prof.permissionMode ? [] : ['--permission-mode', 'acceptEdits']), ...args];
  const started = Date.now();
  const runId = Number(dbRun('INSERT INTO runs(routine,agent,started,status) VALUES(?,?,?,?)', routine ?? null, name, started, 'running').lastInsertRowid);
  emit('run', get('SELECT * FROM runs WHERE id=?', runId));
  const e = { ...process.env, ...env } as Record<string, string>;
  for (const [k, v] of Object.entries(e)) if (v === '') delete e[k];
  const cp = cpSpawn(claudeBin(), full, { cwd, env: e, windowsHide: true });
  cp.stdin.end(prompt);
  let out = '', err = '';
  cp.stdout.on('data', (d) => (out += d));
  cp.stderr.on('data', (d) => (err += d));
  agents.upsert({ name, status: 'working', activity: 'headless run' });
  cp.on('close', (code) => {
    let result = '', cost: number | null = null, tokens: number | null = null, ok = code === 0;
    try {
      const j = JSON.parse(out.trim().split('\n').at(-1)!);
      result = String(j.result ?? ''); cost = j.total_cost_usd ?? null; ok = ok && !j.is_error;
      const u = j.usage ?? {};
      tokens = (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
      if (j.session_id) agents.upsert({ name, session_id: j.session_id });
    } catch { result = (out || err).slice(-4000); ok = false; }
    dbRun('UPDATE runs SET ended=?, status=?, result=?, cost=?, tokens=? WHERE id=?', Date.now(), ok ? 'success' : 'error', result, cost, tokens, runId);
    emit('run', get('SELECT * FROM runs WHERE id=?', runId));
    agents.upsert({ name, status: 'offline', activity: ok ? 'done' : 'failed' });
    // task_done already notified the parent: don't pay for the same news twice.
    const reported = ok && parent && get(`SELECT 1 FROM tasks WHERE assignee=? AND creator=? AND status IN ('done','failed') AND updated>=?`, name, parent, started);
    if (parent && !reported) {
      // Long results go to a note so the parent pays for them only if it reads them.
      if (result.length > 1500) {
        notes.set(name, `result/${name}`, result);
        messages.send(name, parent, `${ok ? 'done' : 'FAILED'} (run #${runId}). Summary: ${result.slice(0, 400)}… Full: note_get("result/${name}")`);
      } else messages.send(name, parent, `${ok ? 'done' : 'FAILED'}: ${result || '(no output)'}`);
    }
  });
  return runId;
}

/** One-shot run used by scheduled routines. */
export function runRoutineOnce(r: { id: string; name: string; profile?: string; cwd?: string; prompt: string; notify?: string }) {
  const prof = profileFor(r.profile);
  const name = agents.uniqueName(`routine-${r.name}`);
  const { args, env } = claudeArgs({ name, role: 'routine', parent: r.notify ?? null }, prof, undefined, { headless: true });
  agents.upsert({ name, role: 'routine', profile: prof.id, model: prof.model ?? null, cwd: r.cwd ?? homedir(), parent: r.notify ?? null, kind: 'headless', status: 'starting', created: Date.now() });
  return runHeadless(name, args, env, r.cwd && existsSync(r.cwd) ? r.cwd : homedir(), r.prompt, r.notify, prof, r.id);
}

export function stopAgent(name: string) {
  const t = ptys.byAgent(name);
  if (t) ptys.kill(t.id);
  agents.upsert({ name, status: 'offline', activity: null });
}

/** Wake an idle pane agent that has unread mail by typing a short prompt; the UserPromptSubmit hook injects the mail. */
export function nudge(name: string) {
  const a = agents.get(name), t = ptys.byAgent(name);
  // 'starting' = TUI up but no prompt yet (SessionStart hook doesn't always fire for interactive sessions).
  if (!a || !t || !(a.status === 'idle' || (a.status === 'starting' && Date.now() - t.started > 4000))) return false;
  const n = messages.unread(name).length;
  if (!n) return false;
  return ptys.typeLine(t.id, `[bridge] ${n} new team message${n > 1 ? 's' : ''}`);
}

export const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };
