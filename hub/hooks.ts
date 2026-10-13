// Claude Code HTTP hooks -> live agent status + push delivery of team messages.
// Delivery paths (no polling, no wasted turns):
//   working agent -> PostToolUse additionalContext
//   finishing agent -> Stop {decision:block} with the mail
//   idle pane agent -> hub types a 1-line nudge; UserPromptSubmit injects the mail
import { agents, messages, events, type Agent } from './bus.ts';
import { nudge } from './agents.ts';

const brief = (v: unknown, n = 80) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? '');
  return s.length > n ? s.slice(0, n) + '…' : s;
};
function toolActivity(tool: string, input: any) {
  const arg = input?.command ?? input?.file_path ?? input?.pattern ?? input?.url ?? input?.description ?? input?.prompt ?? '';
  return `${tool.replace(/^mcp__bridge__/, '⇄ ')} ${brief(arg, 70)}`.trim();
}
const inject = (event: string, name: string) => {
  const ms = messages.take(name);
  return ms.length ? { hookSpecificOutput: { hookEventName: event, additionalContext: `Team messages:\n${messages.fmt(ms)}` } } : {};
};

export function handleHook(event: string, agentParam: string | null, body: any): object {
  const sid: string | undefined = body?.session_id;
  let a: Agent | undefined = agentParam ? agents.get(agentParam) : sid ? agents.bySession(sid) : undefined;
  if (!a) {
    if (!agentParam) return {}; // unknown external session (global hooks) that never joined
    a = agents.upsert({ name: agentParam, kind: 'external', status: 'idle' });
  }
  // Global hooks also fire for hub-spawned sessions; their own ?agent= hook already handles them (avoids double takes and status flapping).
  if (!agentParam && a.kind !== 'external') return {};
  const name = a.name;
  const base = { session_id: sid ?? a.session_id, transcript: body?.transcript_path ?? a.transcript, ...(body?.cwd ? { cwd: body.cwd } : {}) };
  switch (event) {
    case 'SessionStart':
      // 'compact' fires mid-turn: keep 'working' so a nudge never types into a busy TUI.
      agents.upsert({ name, ...base, status: body?.source === 'compact' && a.status === 'working' ? 'working' : 'idle', activity: null });
      return inject('SessionStart', name);
    case 'UserPromptSubmit':
      agents.upsert({ name, ...base, status: 'working', activity: `› ${brief(body?.prompt, 90)}` });
      return inject('UserPromptSubmit', name);
    case 'PreToolUse':
      agents.upsert({ name, ...base, status: 'working', activity: toolActivity(String(body?.tool_name ?? '?'), body?.tool_input) });
      return {};
    case 'PostToolUse':
      if (a.status !== 'working') agents.upsert({ name, ...base, status: 'working' });
      // Fired inside an in-process subagent (Agent tool): keep the mail for the main agent, the subagent would swallow it.
      return body?.agent_id ? {} : inject('PostToolUse', name);
    case 'Notification':
      if (body?.notification_type === 'auth_success') return {}; // not a human-attention prompt
      // idle_prompt = merely sitting at the prompt; only permission/elicitation prompts need the human.
      if (body?.notification_type === 'idle_prompt' || /waiting for your input/i.test(body?.message ?? '')) { agents.upsert({ name, ...base, status: 'idle' }); return {}; }
      agents.upsert({ name, ...base, status: 'waiting', activity: brief(body?.message ?? 'needs attention', 90) });
      return {};
    case 'Stop': {
      const ms = messages.take(name);
      if (ms.length) {
        agents.upsert({ name, ...base, status: 'working', activity: `reading ${ms.length} message(s)` });
        return { decision: 'block', reason: `New team messages:\n${messages.fmt(ms)}` };
      }
      agents.upsert({ name, ...base, status: 'idle', activity: brief(body?.last_assistant_message ?? '', 90) || null });
      return {};
    }
    case 'SessionEnd':
      // Stale end of a replaced session (/clear, resume) must not mark the live one offline.
      if (sid && a.session_id && sid !== a.session_id) return {};
      agents.upsert({ name, ...base, status: 'offline', activity: null });
      return {};
  }
  return {};
}

// Cooldown: a burst of mail must not stack several "[bridge]" lines + Enter in the TUI before its UserPromptSubmit lands.
const lastNudge = new Map<string, number>();
const cooling = (name: string) => Date.now() - (lastNudge.get(name) ?? 0) < 3000;
/** True when the nudge was typed. Never throws: this runs inside timers, an exception there would crash the hub. */
function tryNudge(name: string): boolean {
  try {
    if (cooling(name)) return false;
    const ok = nudge(name);
    if (ok) lastNudge.set(name, Date.now());
    return ok;
  } catch (e) { console.error('nudge failed', name, e); return false; }
}
/** Retry while the agent is still booting its TUI, or while a cooldown hides pending mail. */
function nudgeSoon(name: string, tries = 6) {
  if (tryNudge(name) || tries <= 0) return;
  if (cooling(name)) setTimeout(() => nudgeSoon(name, tries - 1), 3000);
  else if (agents.get(name)?.status === 'starting') setTimeout(() => nudgeSoon(name, tries - 1), 2500);
}

// Mail for an idle pane agent: wake it up (debounced so bursts become one nudge).
const pending = new Map<string, NodeJS.Timeout>();
events.on('inbox', (rcpt: string) => {
  if (pending.has(rcpt)) return;
  pending.set(rcpt, setTimeout(() => { pending.delete(rcpt); nudgeSoon(rcpt); }, 400));
});
// An agent that just went idle with mail queued (raced the Stop hook) also gets nudged.
events.on('status', (a: Agent) => { if (a.status === 'idle') setTimeout(() => nudgeSoon(a.name), 300); });
