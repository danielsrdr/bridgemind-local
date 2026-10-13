import { useEffect, useRef, useState } from 'react';
import { useS, api } from '../store';
import { Dot, ago, shortPath } from './ui';
import type { Agent } from '../types';

type Tab = 'team' | 'tasks' | 'notes';

export function TeamDock() {
  const [tab, setTab] = useState<Tab>('team');
  const tasks = useS((s) => s.tasks.filter((t) => t.status === 'open' || t.status === 'claimed').length);
  return (
    <div className="h-full flex flex-col bg-panel border-l border-line min-w-0">
      <div className="flex h-10 items-center gap-1 px-2 border-b border-line shrink-0">
        {(['team', 'tasks', 'notes'] as Tab[]).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`px-2.5 py-1 rounded-md text-xs ${tab === t ? 'bg-panel2 text-text' : 'text-mute hover:text-text'}`}>
            {t === 'team' ? 'Équipe' : t === 'tasks' ? `Tâches${tasks ? ` ${tasks}` : ''}` : 'Notes'}
          </button>
        ))}
      </div>
      {tab === 'team' ? <Team /> : tab === 'tasks' ? <Tasks /> : <Notes />}
    </div>
  );
}

function AgentRow({ a }: { a: Agent }) {
  const term = useS((s) => s.terms.find((t) => t.agent === a.name && t.alive));
  const set = useS((s) => s.set);
  const open = () => { if (term) set({ mode: 'code', ws: term.workspace ?? useS.getState().ws, focus: term.id }); };
  return (
    <div className="group flex items-start gap-2 px-3 py-1.5 hover:bg-panel2 cursor-pointer" onClick={open}>
      <span className="mt-1"><Dot s={a.status} /></span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-xs">
          <b>{a.name}</b>
          {a.role && <span className="text-accent text-[10px]">@{a.role}</span>}
          <span className="text-mute text-[10px]">{a.model ?? a.kind}{a.parent ? ` ← ${a.parent}` : ''}</span>
          <span className="ml-auto text-mute text-[10px]">{ago(a.seen)}</span>
        </div>
        <div className="text-[11px] text-mute truncate" title={a.activity ?? ''}>{a.activity ?? shortPath(a.cwd)}</div>
      </div>
      <button className="opacity-0 group-hover:opacity-100 text-mute hover:text-bad text-xs" title={a.status === 'offline' ? 'Retirer' : 'Arrêter'}
        onClick={(e) => { e.stopPropagation(); api(`agents/${a.name}${a.status === 'offline' ? '' : '/stop'}`, a.status === 'offline' ? 'DELETE' : 'POST'); }}>{a.status === 'offline' ? '🗑' : '■'}</button>
    </div>
  );
}

function Team() {
  const agents = useS((s) => s.agents);
  const msgs = useS((s) => s.messages);
  const [showOff, setShowOff] = useState(false);
  const live = agents.filter((a) => a.status !== 'offline');
  const off = agents.filter((a) => a.status === 'offline');
  const [to, setTo] = useState('all');
  const [body, setBody] = useState('');
  const feed = useRef<HTMLDivElement>(null);
  // the feed is capped at 500 messages, so the length stops changing: follow the last id instead
  useEffect(() => { feed.current?.scrollTo({ top: 1e9 }); }, [msgs.at(-1)?.id]);
  // a selected agent that went offline is no longer an option: fall back to 'all' instead of sending to it silently
  const dest = to === 'all' || (to.startsWith('@') ? live.some((a) => a.role === to.slice(1)) : live.some((a) => a.name === to)) ? to : 'all';
  const send = () => { if (!body.trim()) return; api('messages', 'POST', { to: dest, body }); setBody(''); };
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="max-h-[45%] overflow-auto border-b border-line py-1 shrink-0">
        {!live.length && <div className="px-3 py-2 text-mute text-xs">Aucun agent actif.</div>}
        {live.map((a) => <AgentRow key={a.name} a={a} />)}
        {off.length > 0 && <button className="px-3 py-1 text-[11px] text-mute hover:text-text" onClick={() => setShowOff(!showOff)}>{showOff ? '▾' : '▸'} {off.length} hors ligne</button>}
        {showOff && off.map((a) => <AgentRow key={a.name} a={a} />)}
      </div>
      <div ref={feed} className="flex-1 overflow-auto px-3 py-2 space-y-1.5">
        {!msgs.length && <div className="text-mute text-xs">Les messages entre agents apparaîtront ici. Tu participes en tant que <b>human</b>.</div>}
        {msgs.map((m) => (
          <div key={m.id} className={`text-xs rounded-md px-2 py-1.5 ${m.rcpt === 'human' ? 'bg-accent/15 border border-accent/30' : m.frm === 'human' ? 'bg-panel2' : 'bg-bg'}`}>
            <div className="flex gap-1 text-[10px] text-mute"><b className="text-text">{m.frm}</b>→<b className="text-text">{m.rcpt}</b><span className="ml-auto">{m.read ? '✓' : '•'} {ago(m.ts)}</span></div>
            <div className="whitespace-pre-wrap break-words">{m.body}</div>
          </div>
        ))}
      </div>
      <div className="p-2 border-t border-line flex flex-col gap-1.5 shrink-0">
        <select className="inp" value={dest} onChange={(e) => setTo(e.target.value)}>
          <option value="all">→ tous les agents actifs</option>
          {[...new Set(live.map((a) => a.role).filter(Boolean))].map((r) => <option key={r} value={`@${r}`}>→ @{r}</option>)}
          {live.map((a) => <option key={a.name} value={a.name}>→ {a.name}</option>)}
        </select>
        <div className="flex gap-1">
          <textarea className="inp h-14 resize-none" placeholder="Message (Ctrl+Entrée)" value={body} onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } }} />
          <button className="btn-p self-stretch" onClick={send}>➤</button>
        </div>
      </div>
    </div>
  );
}

const depsOf = (s: string | null) => { try { return JSON.parse(s || '[]') as unknown[]; } catch { return []; } };

function Tasks() {
  const tasks = useS((s) => s.tasks);
  const agents = useS((s) => s.agents.filter((a) => a.status !== 'offline'));
  const [title, setTitle] = useState('');
  const [assignee, setAssignee] = useState('');
  const who = agents.some((a) => a.name === assignee) ? assignee : ''; // an assignee that went offline reverts to 'libre'
  const cols = [['open', 'À faire'], ['claimed', 'En cours'], ['done', 'Fait'], ['failed', 'Échec']] as const;
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="p-2 border-b border-line flex gap-1 shrink-0">
        <input className="inp" placeholder="Nouvelle tâche…" value={title} onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && title.trim()) { api('tasks', 'POST', { title, assignee: who }); setTitle(''); } }} />
        <select className="inp w-28" value={who} onChange={(e) => setAssignee(e.target.value)}>
          <option value="">libre</option>{agents.map((a) => <option key={a.name}>{a.name}</option>)}
        </select>
      </div>
      <div className="flex-1 overflow-auto p-2 space-y-3">
        {cols.map(([st, label]) => {
          const list = tasks.filter((t) => t.status === st);
          if (!list.length) return null;
          return (
            <div key={st}>
              <div className="lbl mb-1">{label} · {list.length}</div>
              <div className="space-y-1">{list.map((t) => (
                <div key={t.id} className="group rounded-md bg-bg border border-line px-2 py-1.5 text-xs">
                  <div className="flex gap-1.5 items-start">
                    <span className="text-mute">#{t.id}</span><span className="flex-1">{t.title}</span>
                    {st !== 'done' && <button className="opacity-0 group-hover:opacity-100 text-ok" title="Marquer fait" onClick={() => api(`tasks/${t.id}`, 'PATCH', { status: 'done', result: 'closed by human' })}>✓</button>}
                    <button className="opacity-0 group-hover:opacity-100 text-mute hover:text-bad" onClick={() => api(`tasks/${t.id}`, 'DELETE')}>✕</button>
                  </div>
                  <div className="text-[10px] text-mute">{t.creator}{t.assignee ? ` → ${t.assignee}` : ''} · {ago(t.updated)}{depsOf(t.deps).length ? ` · deps ${t.deps}` : ''}</div>
                  {t.detail && <div className="text-[11px] text-mute mt-0.5 whitespace-pre-wrap">{t.detail}</div>}
                  {t.result && <div className="text-[11px] mt-1 border-l-2 border-ok/50 pl-1.5 whitespace-pre-wrap">{t.result}</div>}
                </div>
              ))}</div>
            </div>
          );
        })}
        {!tasks.length && <div className="text-mute text-xs">Les agents créent et se répartissent les tâches ici (task_add / task_claim / task_done).</div>}
      </div>
    </div>
  );
}

function Notes() {
  const notes = useS((s) => s.notes);
  const [sel, setSel] = useState<string | null>(null);
  const [k, setK] = useState(''); const [v, setV] = useState('');
  const cur = notes.find((n) => n.k === sel);
  const dirty = useRef(false); // unsaved edits: a remote update of the same note must not overwrite them
  useEffect(() => { dirty.current = false; if (cur) { setK(cur.k); setV(cur.v); } }, [sel]);
  useEffect(() => { if (cur && !dirty.current) { setK(cur.k); setV(cur.v); } }, [cur?.ts]);
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="max-h-[40%] overflow-auto border-b border-line py-1 shrink-0">
        {notes.map((n) => (
          <div key={n.k} onClick={() => setSel(n.k)} className={`px-3 py-1 text-xs cursor-pointer flex gap-2 ${sel === n.k ? 'bg-panel2' : 'hover:bg-panel2'}`}>
            <b className="truncate">{n.k}</b><span className="ml-auto text-mute text-[10px] shrink-0">{n.author} · {n.v.length}c · {ago(n.ts)}</span>
          </div>
        ))}
        {!notes.length && <div className="px-3 py-2 text-mute text-xs">Tableau partagé : specs, décisions, résultats. Les agents y écrivent au lieu de se renvoyer de longs textes.</div>}
      </div>
      <div className="flex-1 flex flex-col gap-1.5 p-2 min-h-0">
        <input className="inp font-mono" placeholder="clé (ex: spec/api)" value={k} onChange={(e) => { dirty.current = true; setK(e.target.value); }} />
        <textarea className="inp flex-1 font-mono resize-none" value={v} onChange={(e) => { dirty.current = true; setV(e.target.value); }} />
        <div className="flex gap-1 justify-end">
          {sel && <button className="btn" onClick={() => { api('notes', 'POST', { k: sel, v: '' }); setSel(null); setK(''); setV(''); }}>Supprimer</button>}
          <button className="btn" onClick={() => { setSel(null); setK(''); setV(''); }}>Nouvelle</button>
          <button className="btn-p" disabled={!k} onClick={() => { dirty.current = false; api('notes', 'POST', { k, v }); setSel(k); }}>Enregistrer</button>
        </div>
      </div>
    </div>
  );
}
