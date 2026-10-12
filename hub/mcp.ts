// Minimal MCP server (Streamable HTTP, JSON responses). One endpoint shared by every agent;
// identity comes from ?agent=<name> (hub-spawned agents) or join() (external sessions).
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { agents, messages, tasks, notes } from './bus.ts';
import { startAgent, stopAgent } from './agents.ts';

const sessions = new Map<string, string>(); // mcp-session-id -> agent name

const S = (props: Record<string, any>, required: string[] = []) => ({ type: 'object', properties: props, required });
const str = (description?: string) => ({ type: 'string', ...(description ? { description } : {}) });
const TOOLS = [
  { name: 'send', description: 'Message teammate(s). to: name | "all" | "@role" | "a,b".', inputSchema: S({ to: str(), body: str() }, ['to', 'body']) },
  { name: 'inbox', description: 'Read unread messages. wait>0 blocks up to N s until mail arrives (only when blocked on a reply).', inputSchema: S({ wait: { type: 'number' } }) },
  { name: 'agents', description: 'List team members and their live status.', inputSchema: S({}) },
  { name: 'task_add', description: 'Create a task. assignee optional (else claimable). deps = task ids that must be done first.', inputSchema: S({ title: str(), detail: str(), assignee: str(), deps: { type: 'array', items: { type: 'number' } } }, ['title']) },
  { name: 'task_claim', description: 'Claim task by id, or the next open task whose deps are done.', inputSchema: S({ id: { type: 'number' } }) },
  { name: 'task_done', description: 'Finish a task with a short result (notifies its creator). failed:true marks failure.', inputSchema: S({ id: { type: 'number' }, result: str(), failed: { type: 'boolean' } }, ['id', 'result']) },
  { name: 'tasks', description: 'List tasks. status: open|claimed|done|failed.', inputSchema: S({ status: str() }) },
  { name: 'note_set', description: 'Write shared note (spec, decision, findings). Empty value deletes.', inputSchema: S({ key: str(), value: str() }, ['key', 'value']) },
  { name: 'note_get', description: 'Read a shared note; no key lists keys.', inputSchema: S({ key: str() }) },
  { name: 'spawn', description: 'Start a teammate. model: haiku|sonnet|opus|<profile id>. headless:true = one-shot, result mailed back to you (cheapest). Otherwise opens an interactive pane.', inputSchema: S({ prompt: str(), name: str(), role: str(), model: str(), cwd: str('default: your cwd'), headless: { type: 'boolean' }, effort: str('low|medium|high') }, ['prompt']) },
  { name: 'stop', description: 'Stop a teammate.', inputSchema: S({ name: str() }, ['name']) },
  { name: 'join', description: 'Set your team identity (only needed for sessions not started by BridgeMind).', inputSchema: S({ name: str(), role: str() }, ['name']) },
];

const text = (t: string, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}) });

async function call(me: string | undefined, sid: string | undefined, tool: string, a: any, signal: AbortSignal) {
  if (tool === 'join') {
    const name = agents.uniqueName(a.name);
    agents.upsert({ name, role: a.role ?? null, kind: 'external', status: 'working' });
    if (sid) sessions.set(sid, name);
    return text(`joined as ${name}`);
  }
  if (!me) return text('Not identified: call join(name) first.', true);
  agents.upsert({ name: me }); // touch "seen"
  switch (tool) {
    case 'send': {
      const r = messages.send(me, a.to, a.body);
      return text(r.delivered.length ? `sent to ${r.delivered.join(',')}` : `no live recipient for "${a.to}"`, !r.delivered.length);
    }
    case 'inbox': {
      const ms = await messages.wait(me, Math.min(Math.max(0, Number(a.wait ?? 0)), 300) * 1000, signal);
      return text(ms.length ? messages.fmt(ms) : '(no messages)');
    }
    case 'agents':
      return text(agents.list().filter((x) => x.status !== 'offline' || x.name === me)
        .map((x) => `${x.name}${x.name === me ? ' (you)' : ''}${x.role ? ` @${x.role}` : ''} [${x.status}${x.model ? ` ${x.model}` : ''}]${x.activity ? ` ${x.activity}` : ''}`).join('\n'));
    case 'task_add': {
      const t = tasks.add(me, a.title, a.detail, a.assignee, a.deps ?? []);
      return text(`task #${t.id} ${t.status}`);
    }
    case 'task_claim': {
      const t = tasks.claim(me, a.id);
      return text(t ? `claimed #${t.id}: ${t.title}${t.detail ? `\n${t.detail}` : ''}` : 'nothing claimable');
    }
    case 'task_done': {
      const t = tasks.finish(me, a.id, a.result, !a.failed);
      return text(t ? `#${t.id} ${t.status}` : 'no such task', !t);
    }
    case 'tasks':
      return text(tasks.fmt(tasks.list(a.status)));
    case 'note_set':
      notes.set(me, a.key, a.value);
      return text('ok');
    case 'note_get': {
      if (!a.key) return text(notes.list().map((n) => `${n.k} (${n.author}, ${n.v.length}c)`).join('\n') || '(no notes)');
      return text(notes.get(a.key) ?? '(missing)');
    }
    case 'spawn': {
      const parent = agents.get(me);
      const r = startAgent({ prompt: a.prompt, name: a.name, role: a.role, model: a.model ?? 'haiku', cwd: a.cwd ?? parent?.cwd ?? undefined,
        headless: !!a.headless, effort: a.effort, parent: me, workspace: parent?.workspace ?? undefined });
      return text(r.agent ? `spawned ${r.agent.name}${a.headless ? ' (headless; result will be mailed to you)' : ' (pane)'}` : 'spawned shell');
    }
    case 'stop':
      stopAgent(a.name);
      return text(`stopped ${a.name}`);
  }
  return text(`unknown tool ${tool}`, true);
}

async function rpc(msg: any, me: string | undefined, sid: string | undefined, signal: AbortSignal): Promise<any> {
  const { id, method, params } = msg;
  if (id === undefined) return undefined; // notification
  const ok = (result: any) => ({ jsonrpc: '2.0', id, result });
  switch (method) {
    case 'initialize':
      return ok({ protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} },
        serverInfo: { name: 'bridgemind', version: '0.1.0' },
        instructions: 'Team bus: messages arrive automatically; keep messages short; use notes/tasks for shared state.' });
    case 'ping': return ok({});
    case 'tools/list': return ok({ tools: TOOLS });
    case 'tools/call':
      try { return ok(await call(me, sid, params.name, params.arguments ?? {}, signal)); }
      catch (e: any) { return ok(text(`error: ${e.message}`, true)); }
    default: return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } };
  }
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse, url: URL, body: string) {
  if (req.method === 'DELETE') { sessions.delete(String(req.headers['mcp-session-id'])); res.writeHead(200).end(); return; }
  if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }).end(); return; }
  let msg: any;
  try { msg = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
  let sid = req.headers['mcp-session-id'] as string | undefined;
  const isInit = (Array.isArray(msg) ? msg : [msg]).some((m) => m.method === 'initialize');
  if (isInit) sid = randomUUID();
  const qAgent = url.searchParams.get('agent') ?? undefined;
  if (sid && qAgent) sessions.set(sid, qAgent);
  const me = qAgent ?? (sid ? sessions.get(sid) : undefined);
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  const out = Array.isArray(msg)
    ? (await Promise.all(msg.map((m) => rpc(m, me, sid, ac.signal)))).filter(Boolean)
    : await rpc(msg, me, sid, ac.signal);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (sid) headers['Mcp-Session-Id'] = sid;
  if (out === undefined || (Array.isArray(out) && !out.length)) { res.writeHead(202, headers).end(); return; }
  res.writeHead(200, headers).end(JSON.stringify(out));
}
