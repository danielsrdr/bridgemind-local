// Agent profiles + launcher. Every Claude agent we start is wired to the hub via:
//   --mcp-config  -> bridge MCP (send/inbox/tasks/notes/spawn)   identity = ?agent=<name>
//   --settings    -> HTTP hooks (status + push delivery of messages, zero polling)
//   --append-system-prompt -> short team protocol
import { spawn as cpSpawn, execFile, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync, renameSync, mkdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { blobs, kvGet, kvSet, DATA_DIR, run as dbRun, get } from './db.ts';
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
    ?? (idOrModel && /^(opus|sonnet|haiku|claude-)/.test(idOrModel) ? { ...(all.find((p) => p.isDefault && p.kind === 'claude') ?? DEFAULTS[0]), id: idOrModel, model: idOrModel } : undefined)
    ?? all.find((p) => p.isDefault) ?? DEFAULTS[0];
};

// ---------- workflow: which model does which job (plain code routing, no tokens spent deciding) ----------
export interface Tier { profile: string; effort?: string; worktree?: boolean }
export interface Workflow { tiers: Record<string, Tier>; warnAt: number; staggerMs: number }
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const WORKFLOW: Workflow = {
  tiers: {
    lead: { profile: 'opus', effort: 'high' },                         // plans, decides, merges, ships
    scan: { profile: 'haiku', effort: 'low' },                         // parallel sweeps, candidate extraction
    validate: { profile: 'haiku', effort: 'low' },                     // drops false positives, schema checks
    refactor: { profile: 'sonnet', effort: 'medium', worktree: true }, // precise edits in an isolated git worktree
  },
  warnAt: 6, // live workers per lead before spawn warns (lead + human)
  staggerMs: 2000, // gap between headless starts of one model, so the first cache write serves the others
};
export function workflow(): Workflow {
  const s = kvGet<Partial<Workflow>>('workflow', {});
  return { ...WORKFLOW, ...s, tiers: { ...WORKFLOW.tiers, ...(s.tiers ?? {}) } };
}
export const tierFor = (role?: string | null) => { const t = workflow().tiers; return role && Object.hasOwn(t, role) ? t[role] : undefined; };
export function setWorkflow(p: Partial<Workflow>) {
  const cur = workflow(), tiers = { ...cur.tiers };
  for (const [k, t] of Object.entries(p.tiers ?? {}))
    if (/^[a-z][\w-]{0,31}$/i.test(k) && t && typeof t.profile === 'string' && t.profile) tiers[k] = { profile: t.profile, ...(EFFORTS.includes(t.effort!) ? { effort: t.effort } : {}), ...(t.worktree ? { worktree: true } : {}) };
  const num = (v: unknown, def: number, lo: number, hi: number) => (v == null || !Number.isFinite(Number(v)) ? def : Math.min(hi, Math.max(lo, Number(v))));
  const w: Workflow = { tiers, warnAt: num(p.warnAt, cur.warnAt, 1, 100), staggerMs: num(p.staggerMs, cur.staggerMs, 0, 30e3) };
  kvSet('workflow', w);
  emit('workflow', w);
  return w;
}

/** Isolated checkout for one agent: new branch bm/<name> from HEAD, outside the repo. null when cwd is not in a git repo. */
const git = (cwd: string, ...a: string[]) => new Promise<string>((ok, no) =>
  execFile('git', ['-C', cwd, ...a], { encoding: 'utf8', windowsHide: true }, (e, out) => (e ? no(e) : ok(String(out).trim()))));
async function makeWorktree(cwd: string, name: string) {
  const root = await git(cwd, 'rev-parse', '--show-toplevel').catch(() => '');
  if (!root) return null;
  let branch = `bm/${name}`, path = join(DATA_DIR, 'worktrees', `${basename(root)}-${name}`);
  if (existsSync(path) || await git(root, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`).then(() => true, () => false)) {
    const t = Date.now().toString(36);
    branch += `-${t}`; path += `-${t}`;
  }
  await git(root, 'worktree', 'add', '-b', branch, path, 'HEAD');
  // Uncommitted work in the main tree is not in the worktree: the lead must know.
  const dirty = !!(await git(root, 'status', '--porcelain').catch(() => ''));
  return { path, branch, dirty };
}

// ---------- locate claude ----------
// Not cached: a Claude Code update moves claude.exe to a new versioned folder, and discovery is cheap.
// Short TTL: called on every /api/state, and where.exe costs ~50ms; still picks up Claude Code updates within a minute.
let claudeCache: { path: string; at: number } | null = null;
export function claudeBin(): string {
  const override = kvGet<string>('claudePath', '');
  if (override && existsSync(override)) return override;
  if (claudeCache && Date.now() - claudeCache.at < 60e3 && existsSync(claudeCache.path)) return claudeCache.path;
  const found = findClaude();
  claudeCache = { path: found, at: Date.now() };
  return found;
}
function findClaude(): string {
  const cands: string[] = [];
  // Only .exe: spawning a .cmd shim without a shell fails on Windows (EINVAL).
  try { cands.push(...execFileSync('where.exe', ['claude'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/).filter((l) => /\.exe$/i.test(l.trim())).map((l) => l.trim())); } catch {}
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
  return cands.find((c) => existsSync(c)) ?? 'claude';
}

// ---------- protocol (kept short: it is paid on every turn) ----------
interface Who { name: string; role?: string | null; parent?: string | null; branch?: string }
/** Per-agent part. Headless workers get it in their first message, so parallel workers share one cached system prompt. */
export const identity = (a: Who) => [
  `You are agent "${a.name}"${a.role ? ` (role: ${a.role})` : ''} in a local multi-agent team (BridgeMind).`,
  a.parent ? `Your lead is "${a.parent}". When done, report the outcome with task_done or send(to:"${a.parent}").` : `You are a lead: plan, delegate, integrate, verify.`,
  ...(a.branch ? [`You work in an isolated git worktree on branch "${a.branch}": commit your changes there before reporting; your lead merges it.`] : []),
].join(' ');
export function protocol(a: Who | null) {
  return [
    `${a ? identity(a) : 'You are a worker in a local multi-agent team (BridgeMind); your identity is in your first message.'} Team tools: mcp__bridge__*.`,
    `- Incoming messages are injected automatically as "[sender→you #id] ...". Never poll the inbox in a loop; use inbox(wait) only when you are blocked waiting on a reply.`,
    `- Be terse with teammates: ≤3 lines per message. Share file paths, note keys or task ids instead of pasting content.`,
    `- Shared facts/specs/decisions go in notes (note_set); split work with tasks (task_add/task_claim/task_done; task_done notifies the creator).`,
    `- Delegate by role, the hub picks model+effort: spawn(role:"scan"|"validate") = Haiku sweeps/filters, role:"refactor" = Sonnet in a git worktree. headless:true mails the result back.`,
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

/** intro: identity to prepend to a headless worker's prompt (its system prompt stays identical across workers). */
function claudeArgs(a: Who, prof: Profile, model?: string, x: { headless?: boolean; effort?: string } = {}) {
  // 'agent-' prefix: no Windows reserved names (CON, NUL...); '.' escaped: a name of '..' must not climb out of RUNTIME.
  const dir = join(RUNTIME, 'agent-' + a.name.replace(/\./g, '%2E'));
  mkdirSync(dir, { recursive: true });
  const mcp = join(dir, 'mcp.json'), set = join(dir, 'settings.json'), sys = join(dir, 'protocol.md');
  writeFileSync(mcp, JSON.stringify(mcpConfig(a.name)));
  writeFileSync(set, JSON.stringify(hookSettings(a.name)));
  writeFileSync(sys, protocol(x.headless ? null : a));
  const args = ['--mcp-config', mcp, ...(prof.inheritMcp ? [] : ['--strict-mcp-config']), '--settings', set, '--append-system-prompt-file', sys, '-n', a.name];
  // cwd/env/git status move to the first message: workers in different worktrees (or after edits) still share the cached prefix.
  if (x.headless) args.push('--exclude-dynamic-system-prompt-sections');
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
  return { args, env, intro: x.headless ? `[${identity(a)}]\n\n` : '' };
}

/** Skip the CLI's first-run wizard and the trust prompt for folders the user picked, so agents start straight away. */
function ensureCliReady(cwd: string, prof: Profile) {
  const file = prof.configDir ? join(prof.configDir, '.claude.json') : join(homedir(), '.claude.json');
  try {
    let j: any = {};
    // Unreadable or unparsable (e.g. a running claude is mid-write): leave it alone, never overwrite with {}.
    try { j = JSON.parse(readFileSync(file, 'utf8')); } catch { if (existsSync(file)) return; }
    if (!j || typeof j !== 'object') return;
    const key = cwd.replace(/\\/g, '/');
    let dirty = false;
    if (!j.hasCompletedOnboarding) { j.hasCompletedOnboarding = true; dirty = true; }
    if (!j.theme) { j.theme = 'dark'; dirty = true; }
    j.projects ??= {};
    if (!j.projects[key]?.hasTrustDialogAccepted) { j.projects[key] = { ...(j.projects[key] ?? {}), hasTrustDialogAccepted: true }; dirty = true; }
    // Atomic replace so a crash or a concurrent reader never sees a half-written file. Locked file (EBUSY/EPERM): skip.
    if (dirty) { const tmp = `${file}.bridge-tmp`; writeFileSync(tmp, JSON.stringify(j, null, 2)); renameSync(tmp, file); }
  } catch {}
}

export interface SpawnOpts {
  name?: string; role?: string; profile?: string; model?: string; cwd?: string; prompt?: string;
  parent?: string; headless?: boolean; workspace?: string; resume?: string; cols?: number; rows?: number; effort?: string; worktree?: boolean;
}

/** Start an agent (interactive pane, or headless one-shot whose result is mailed to parent).
 *  A role matching a workflow tier picks profile, effort and worktree unless the caller set them. */
export async function startAgent(o: SpawnOpts) {
  const tier = tierFor(o.role);
  const prof = profileFor(o.profile ?? o.model ?? tier?.profile);
  let cwd = o.cwd && existsSync(o.cwd) ? o.cwd : homedir();
  if (prof.kind === 'shell') {
    const t = ptys.spawn({ cmd: prof.command ?? 'powershell.exe', args: prof.args, cwd, env: prof.env, title: o.name ?? prof.name, workspace: o.workspace, cols: o.cols, rows: o.rows });
    return { term: t, agent: null as Agent | null };
  }
  const effort = [o.effort, tier?.effort, prof.effort].find((e) => e && EFFORTS.includes(e));
  const name = agents.uniqueName(o.name ?? o.role ?? (o.headless ? 'worker' : 'agent'));
  // Row first: it reserves the name while the worktree is being created.
  let agent = agents.upsert({ name, role: o.role ?? null, profile: prof.id, model: o.model || prof.model || null, cwd, parent: o.parent ?? null,
    kind: o.headless ? 'headless' : 'pane', status: 'starting', activity: null, session_id: null, transcript: null, workspace: o.workspace ?? null, created: Date.now() });
  let worktree: Awaited<ReturnType<typeof makeWorktree>> = null, warn = '';
  if (o.worktree ?? tier?.worktree) {
    try { worktree = await makeWorktree(cwd, name); if (!worktree) warn = 'not a git repo: no worktree, shared folder'; }
    catch (x: any) { warn = `worktree failed (${String(x?.message ?? x).split('\n')[0]}): shared folder`; }
    if (worktree) agent = agents.upsert({ name, cwd: cwd = worktree.path });
  }
  const { args, env, intro } = claudeArgs({ name, role: o.role, parent: o.parent, branch: worktree?.branch }, prof, o.model, { headless: o.headless, effort });
  if (!o.headless) ensureCliReady(cwd, prof);

  if (o.resume) args.push('--resume', o.resume);
  if (o.headless) {
    runHeadless(name, args, env, cwd, intro + (o.prompt ?? ''), o.parent, prof);
    return { term: null, agent, effort, worktree, warn };
  }
  if (o.prompt) args.push(o.prompt);
  try {
    const term = ptys.spawn({ cmd: claudeBin(), args, cwd, env, title: name, agent: name, workspace: o.workspace, cols: o.cols, rows: o.rows });
    return { term, agent, effort, worktree, warn };
  } catch (x: any) {
    // Pty could not start (claude missing, bad cwd): don't leave a 'starting' ghost behind.
    agents.upsert({ name, status: 'offline', activity: `failed to start: ${x?.message ?? x}` });
    throw x;
  }
}

/** Live headless children by agent name, so stopAgent can kill them. */
const headless = new Map<string, ChildProcessWithoutNullStreams>();
/** Staggered headless runs not started yet: name -> cancel. */
const queued = new Map<string, () => void>();
const nextStart = new Map<string, number>(); // per model: workers of one model share a cache prefix

/** `claude -p --output-format json` prints one JSON object; tolerate stray lines before/after it. */
function parseJsonOut(s: string): any {
  const t = s.trim();
  const starts = [...t.matchAll(/^\{/gm)].map((m) => m.index!).reverse();
  for (const i of starts) { try { return JSON.parse(t.slice(i)); } catch {} }
  for (const line of t.split('\n').reverse()) { try { return JSON.parse(line); } catch {} }
  throw new Error('no JSON in claude output');
}

function runHeadless(name: string, args: string[], env: Record<string, string>, cwd: string, prompt: string, parent: string | undefined, prof: Profile, routine?: string) {
  const full = ['-p', '--output-format', 'json', ...(prof.permissionMode ? [] : ['--permission-mode', 'acceptEdits']), ...args];
  const started = Date.now();
  const runId = Number(dbRun('INSERT INTO runs(routine,agent,started,status) VALUES(?,?,?,?)', routine ?? null, name, started, 'running').lastInsertRowid);
  emit('run', get('SELECT * FROM runs WHERE id=?', runId));
  const e = { ...process.env, ...env } as Record<string, string>;
  for (const [k, v] of Object.entries(e)) if (v === '') delete e[k];
  let out = '', err = '', done = false, cp: ChildProcessWithoutNullStreams | undefined;
  // Single exit point (close and error can both fire). A run whose agent was stopped (or reused by a newer run) must not touch the agent row.
  const settle = (code: number | null) => {
    if (done) return; done = true;
    const current = !cp || headless.get(name) === cp;
    if (current) headless.delete(name);
    let result = '', cost: number | null = null, tokens: number | null = null, ok = code === 0;
    try {
      const j = parseJsonOut(out);
      result = String(j.result ?? ''); cost = j.total_cost_usd ?? null; ok = ok && !j.is_error;
      const u = j.usage ?? {};
      tokens = (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
      if (j.session_id) agents.upsert({ name, session_id: j.session_id });
    } catch { result = (out || err).slice(-4000); ok = false; }
    dbRun('UPDATE runs SET ended=?, status=?, result=?, cost=?, tokens=? WHERE id=?', Date.now(), ok ? 'success' : 'error', result, cost, tokens, runId);
    emit('run', get('SELECT * FROM runs WHERE id=?', runId));
    if (!current) return;
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
  };
  const start = () => {
    try { cp = cpSpawn(claudeBin(), full, { cwd, env: e, windowsHide: true }); } catch (x: any) { err = String(x?.message ?? x); }
    if (!cp) { settle(null); return; } // e.g. claude not found: the run fails, the hub keeps running
    const child = cp;
    headless.set(name, child);
    // Without this listener a missing claude.exe (ENOENT) would crash the hub.
    child.on('error', (x) => { err += String(x.message); settle(null); });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    // EPIPE if claude exits before reading the prompt: must not become an unhandled error.
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    agents.upsert({ name, status: 'working', activity: 'headless run' });
    child.on('close', (code) => settle(code));
  };
  // Prompt-prefix stagger: same-model workers spawned together would all pay the cache write; spaced out, the first one's serves the rest.
  const i = args.indexOf('--model'), key = i >= 0 ? args[i + 1] : '';
  const at = Math.max(started, nextStart.get(key) ?? 0);
  nextStart.set(key, at + workflow().staggerMs);
  if (at <= started) start();
  else {
    agents.upsert({ name, activity: `queued ${Math.ceil((at - started) / 1000)}s (cache stagger)` });
    const t = setTimeout(() => { queued.delete(name); start(); }, at - started);
    queued.set(name, () => {
      clearTimeout(t); queued.delete(name); done = true;
      dbRun('UPDATE runs SET ended=?, status=?, result=? WHERE id=?', Date.now(), 'error', 'stopped before start', runId);
      emit('run', get('SELECT * FROM runs WHERE id=?', runId));
    });
  }
  return runId;
}

/** One-shot run used by scheduled routines. Never throws: it runs inside the cron callback. */
export function runRoutineOnce(r: { id: string; name: string; profile?: string; cwd?: string; prompt: string; notify?: string }) {
  try {
    const prof = profileFor(r.profile);
    const name = agents.uniqueName(`routine-${r.name ?? r.id ?? 'run'}`);
    const { args, env, intro } = claudeArgs({ name, role: 'routine', parent: r.notify ?? null }, prof, undefined, { headless: true });
    agents.upsert({ name, role: 'routine', profile: prof.id, model: prof.model ?? null, cwd: r.cwd ?? homedir(), parent: r.notify ?? null, kind: 'headless', status: 'starting', created: Date.now() });
    return runHeadless(name, args, env, r.cwd && existsSync(r.cwd) ? r.cwd : homedir(), intro + (r.prompt ?? ''), r.notify, prof, r.id);
  } catch (x: any) {
    emit('error', `routine ${r?.name ?? r?.id}: ${x?.message ?? x}`);
    return null;
  }
}

export function stopAgent(name: string) {
  queued.get(name)?.();
  const t = ptys.byAgent(name);
  if (t) ptys.kill(t.id);
  const hp = headless.get(name);
  if (hp) {
    headless.delete(name);
    // Whole tree on Windows (claude spawns MCP children), as in ptys.kill.
    if (process.platform === 'win32') execFile('taskkill', ['/PID', String(hp.pid), '/T', '/F'], () => {});
    try { hp.kill(); } catch {}
  }
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
