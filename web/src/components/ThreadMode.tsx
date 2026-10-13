import { useEffect, useMemo, useRef, useState } from 'react';
import { useS, api } from '../store';
import { ago, fmtTok, shortPath } from './ui';
import type { Item, ThreadMeta } from '../types';

export function ThreadMode() {
  const [list, setList] = useState<ThreadMeta[]>([]);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const load = () => api<ThreadMeta[]>('threads').then(setList);
  useEffect(() => { load(); const t = setInterval(load, 10000); return () => clearInterval(t); }, []);
  const shown = useMemo(() => list.filter((t) => !q || (t.title + t.cwd).toLowerCase().includes(q.toLowerCase())), [list, q]);
  return (
    <div className="flex h-full min-w-0">
      <div className="w-80 shrink-0 border-r border-line bg-panel flex flex-col">
        <div className="p-2 border-b border-line"><input className="inp" placeholder="Rechercher une session…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <div className="flex-1 overflow-auto">
          {shown.map((t) => (
            <div key={t.id} onClick={() => setSel(t.id)} className={`px-3 py-2 border-b border-line/50 cursor-pointer ${sel === t.id ? 'bg-panel2' : 'hover:bg-panel2/60'}`}>
              <div className="text-xs line-clamp-2">{t.title}</div>
              <div className="text-[10px] text-mute flex gap-2 mt-0.5"><span className="truncate">{shortPath(t.cwd) || t.project}</span><span className="ml-auto shrink-0">{ago(t.mtime)} · {(t.size / 1024) | 0}k</span></div>
            </div>
          ))}
        </div>
      </div>
      <div className="flex-1 min-w-0">{sel ? <ThreadView id={sel} key={sel} /> : <div className="h-full grid place-items-center text-mute text-sm">Toutes tes sessions Claude Code (CLI, appli, panes) sont ici.</div>}</div>
    </div>
  );
}

type T = { meta: ThreadMeta; items: Item[]; usage: { input: number; output: number; cacheRead: number; cacheWrite: number }; model: string };

function ThreadView({ id }: { id: string }) {
  const [t, setT] = useState<T | null>(null);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null), box = useRef<HTMLDivElement>(null), atEnd = useRef(true);
  const load = () => api<T>(`threads/${id}`).then(setT);
  useEffect(() => { load(); const i = setInterval(load, 4000); return () => clearInterval(i); }, [id]);
  // follow new items only while the user is at the bottom; don't yank them while they read older turns
  useEffect(() => { if (atEnd.current) end.current?.scrollIntoView(); }, [t?.items.length]);
  if (!t) return null;
  const ws = useS.getState().ws;
  const resume = async () => {
    const r = await api('agents', 'POST', { resume: id, cwd: t.meta.cwd, workspace: ws, name: 'resume', prompt: prompt || undefined });
    if (r?.term) useS.setState({ mode: 'code', focus: r.term.id });
  };
  const headless = async () => {
    setBusy(true);
    try { await api('agents', 'POST', { headless: true, resume: id, cwd: t.meta.cwd, prompt, name: 'thread', parent: 'human' }); setPrompt(''); }
    catch (e) { console.error(e); } finally { setBusy(false); }
  };
  const u = t.usage;
  return (
    <div className="h-full flex flex-col">
      <div className="px-4 h-10 flex items-center gap-3 border-b border-line bg-panel shrink-0">
        <b className="truncate text-sm">{t.meta.title}</b>
        <span className="text-mute text-[11px] shrink-0">{t.model} · in {fmtTok(u.input)} · out {fmtTok(u.output)} · cache {fmtTok(u.cacheRead)}</span>
        <button className="btn ml-auto" onClick={resume}>↻ Reprendre dans un pane</button>
      </div>
      <div ref={box} onScroll={() => { const b = box.current!; atEnd.current = b.scrollHeight - b.scrollTop - b.clientHeight < 80; }} className="flex-1 overflow-auto px-6 py-4 space-y-2 max-w-5xl w-full mx-auto">
        {t.items.map((it, i) => <Entry key={i} it={it} />)}
        <div ref={end} />
      </div>
      <div className="p-3 border-t border-line flex gap-2 max-w-5xl w-full mx-auto">
        <textarea className="inp h-16 resize-none" placeholder="Continuer cette session… (Ctrl+Entrée = headless, résultat dans le fil d'équipe)" value={prompt} onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && e.ctrlKey && prompt.trim()) headless(); }} />
        <div className="flex flex-col gap-1"><button className="btn-p" disabled={!prompt.trim() || busy} onClick={headless}>Envoyer</button><button className="btn" onClick={resume}>Pane</button></div>
      </div>
    </div>
  );
}

function Entry({ it }: { it: Item }) {
  const [open, setOpen] = useState(false);
  if (it.k === 'user') return <div className="ml-auto max-w-[80%] w-fit rounded-xl bg-accent/20 border border-accent/30 px-3 py-2 text-[13px] whitespace-pre-wrap">{it.t}</div>;
  if (it.k === 'text') return <div className="text-[13px] whitespace-pre-wrap leading-relaxed">{it.t}</div>;
  if (it.k === 'thinking') return <details className="text-xs text-mute"><summary className="cursor-pointer">💭 réflexion</summary><div className="whitespace-pre-wrap mt-1">{it.t}</div></details>;
  if (it.k === 'result') return open
    ? <pre onClick={() => setOpen(false)} className={`text-[11px] font-mono whitespace-pre-wrap rounded-md bg-bg border px-2 py-1.5 max-h-80 overflow-auto ${it.err ? 'border-bad/50' : 'border-line'}`}>{String(it.t ?? '')}</pre>
    : <div onClick={() => setOpen(true)} className={`text-[11px] font-mono cursor-pointer truncate pl-4 ${it.err ? 'text-bad' : 'text-mute'}`}>↳ {String(it.t ?? '').split('\n')[0].slice(0, 160) || '(vide)'}</div>;
  // tool use: inputs are arbitrary JSON, so only render strings (objects as React children crash the thread view)
  const inp = it.input && typeof it.input === 'object' ? it.input : {};
  if ((it.tool === 'Edit' || it.tool === 'MultiEdit') && (inp.old_string !== undefined || Array.isArray(inp.edits))) {
    const edits: any[] = Array.isArray(inp.edits) ? inp.edits : [{ old_string: inp.old_string, new_string: inp.new_string }];
    return (
      <div className="rounded-md border border-line overflow-hidden text-[11px] font-mono">
        <div className="px-2 py-1 bg-panel2 text-mute">✎ {String(inp.file_path ?? '')}</div>
        {edits.map((e: any, i: number) => (
          <div key={i} className="max-h-72 overflow-auto">
            {String(e?.old_string ?? '').split('\n').map((l, j) => <div key={'o' + j} className="bg-bad/10 text-bad/90 px-2 whitespace-pre">- {l}</div>)}
            {String(e?.new_string ?? '').split('\n').map((l, j) => <div key={'n' + j} className="bg-ok/10 text-ok/90 px-2 whitespace-pre">+ {l}</div>)}
          </div>
        ))}
      </div>
    );
  }
  const arg = inp.command ?? inp.file_path ?? inp.pattern ?? inp.url ?? inp.description ?? inp.prompt ?? JSON.stringify(inp);
  return (
    <div className="text-[11px] font-mono rounded-md bg-panel border border-line px-2 py-1 cursor-pointer" onClick={() => setOpen(!open)}>
      <span className="text-accent">{(it.tool ?? '').replace(/^mcp__bridge__/, '⇄ ')}</span> <span className="text-mute">{String(arg).slice(0, open ? 1e5 : 200)}</span>
      {open && inp.content != null && <pre className="whitespace-pre-wrap mt-1 max-h-72 overflow-auto">{String(inp.content)}</pre>}
    </div>
  );
}
