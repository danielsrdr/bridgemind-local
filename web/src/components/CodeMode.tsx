import { Fragment, useEffect, useMemo, useState } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { useS, api } from '../store';
import { Terminal } from './Terminal';
import { Dot, Modal, FolderPicker, shortPath } from './ui';
import type { Term, Workspace } from '../types';

/** Balanced grid: n panes -> ceil(sqrt(n)) columns. */
const tidy = (ids: string[]) => {
  const cols = Math.ceil(Math.sqrt(ids.length)) || 1, rows: string[][] = [];
  for (let i = 0; i < ids.length; i += cols) rows.push(ids.slice(i, i + cols));
  return rows;
};
/** Keep saved layout but drop dead ids and append new ones. */
const normalize = (saved: string[][] | undefined, ids: string[]) => {
  const set = new Set(ids);
  const rows = (saved ?? []).map((r) => r.filter((id) => set.has(id))).filter((r) => r.length);
  const placed = new Set(rows.flat());
  for (const id of ids) if (!placed.has(id)) {
    const cols = Math.ceil(Math.sqrt(ids.length));
    const last = rows.at(-1);
    if (last && last.length < cols) last.push(id); else rows.push([id]);
  }
  return rows;
};

export function saveLayout(w: Workspace, rows: string[][]) {
  useS.setState({ workspaces: useS.getState().workspaces.map((x) => (x.id === w.id ? { ...x, layout: { ...x.layout, rows } } : x)) });
  api('workspaces', 'POST', { ...w, layout: { ...w.layout, rows } });
}

export function CodeMode() {
  const { terms, ws, workspaces, focus, set } = useS();
  const w = workspaces.find((x) => x.id === ws);
  const mine = useMemo(() => terms.filter((t) => t.workspace === ws), [terms, ws]);
  const ids = mine.map((t) => t.id);
  const rows = useMemo(() => normalize(w?.layout.rows, ids), [w?.layout.rows, ids.join()]);
  const [max, setMax] = useState<string | null>(null);
  const [launch, setLaunch] = useState(false);

  useEffect(() => { if (w && JSON.stringify(rows) !== JSON.stringify(w.layout.rows ?? [])) saveLayout(w, rows); }, [rows]);
  // Keyboard: Ctrl+Shift+T new pane, Ctrl+Shift+M maximize, Ctrl+Alt+Arrows move focus.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      // Leave typing in form fields alone (terminals are fine: their helper textarea lives in .xterm).
      const tg = e.target as HTMLElement | null;
      if (tg && /^(INPUT|TEXTAREA|SELECT)$/.test(tg.tagName) && !tg.closest('.xterm')) return;
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 't') { e.preventDefault(); setLaunch(true); }
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'm' && focus && (max || rows.flat().includes(focus))) { e.preventDefault(); setMax((m) => (m ? null : focus)); }
      if (e.ctrlKey && e.altKey && e.key.startsWith('Arrow')) {
        const flat = rows.flat(), i = flat.indexOf(focus ?? '');
        const n = flat[(i + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1) + flat.length) % flat.length];
        if (n) { e.preventDefault(); set({ focus: n }); }
      }
    };
    addEventListener('keydown', k, true);
    return () => removeEventListener('keydown', k, true);
  }, [rows, focus, max]);

  if (!w) return <Empty />;
  const shown = max && ids.includes(max) ? [[max]] : rows;
  return (
    <div className="flex flex-col h-full min-w-0">
      <div className="flex items-center gap-2 px-3 h-10 border-b border-line bg-panel shrink-0">
        <b className="text-sm truncate">{w.name}</b>
        <span className="text-mute text-xs truncate">{w.folders.map(shortPath).join(' · ')}</span>
        <div className="ml-auto flex gap-1.5">
          <QuickLaunch w={w} />
          <button className="btn" onClick={() => setLaunch(true)} title="Ctrl+Shift+T">＋ Pane…</button>
          <button className="btn" onClick={() => { setMax(null); saveLayout(w, tidy(ids)); }} title="Réarranger en grille">▦ Tidy</button>
        </div>
      </div>
      <div className="flex-1 min-h-0 p-1.5">
        {!ids.length ? <NoPanes onLaunch={() => setLaunch(true)} /> : (
          // Stable keys + panel ids: adding/closing a pane must not remount the other terminals (that reset their TUIs).
          <Group orientation="vertical">
            {shown.map((r, ri) => (
              <Fragment key={ri}>
                {ri > 0 && <Separator className="h-1.5 hover:bg-accent/40 transition-colors rounded" />}
                <Panel id={`row-${ri}`} minSize={80}>
                  <Group orientation="horizontal">
                    {r.map((id, ci) => {
                      const t = mine.find((x) => x.id === id)!;
                      return (
                        <Fragment key={id}>
                          {ci > 0 && <Separator className="w-1.5 hover:bg-accent/40 transition-colors rounded" />}
                          <Panel id={id} minSize={160}><Pane t={t} focused={focus === id} max={max === id} onMax={() => setMax(max ? null : id)} /></Panel>
                        </Fragment>
                      );
                    })}
                  </Group>
                </Panel>
              </Fragment>
            ))}
          </Group>
        )}
      </div>
      {launch && <LaunchDialog w={w} onClose={() => setLaunch(false)} />}
    </div>
  );
}

function Pane({ t, focused, max, onMax }: { t: Term; focused: boolean; max: boolean; onMax: () => void }) {
  const a = useS((s) => s.agents.find((x) => x.name === t.agent));
  const unread = useS((s) => (t.agent ? s.messages.filter((m) => m.rcpt === t.agent && !m.read).length : 0));
  const set = useS((s) => s.set);
  return (
    <div className={`h-full flex flex-col rounded-lg border overflow-hidden bg-bg ${focused ? 'border-accent/70' : 'border-line'}`}>
      <div className="flex items-center gap-2 px-2 h-7 bg-panel border-b border-line text-xs shrink-0" onDoubleClick={onMax}>
        {a ? <Dot s={a.status} /> : <span className={`dot ${t.alive ? 'bg-ok/60' : 'bg-mute/40'}`} />}
        <b className="truncate max-w-[30%]">{t.title}</b>
        {a?.model && <span className="text-[10px] px-1.5 rounded bg-panel2 text-mute">{a.model}</span>}
        {a?.role && <span className="text-[10px] text-accent">@{a.role}</span>}
        <span className="text-mute truncate flex-1" title={a?.activity ?? t.cwd}>{a?.activity ?? shortPath(t.cwd)}</span>
        {unread > 0 && <span className="text-[10px] px-1.5 rounded-full bg-accent text-white">{unread}✉</span>}
        <button className="text-mute hover:text-text" title="Agrandir (Ctrl+Shift+M)" onClick={onMax}>{max ? '⤡' : '⤢'}</button>
        <button className="text-mute hover:text-bad" title="Fermer" onClick={() => api(`terms/${t.id}`, 'DELETE')}>✕</button>
      </div>
      <div className="flex-1 min-h-0"><Terminal id={t.id} focused={focused} onFocus={() => set({ focus: t.id })} /></div>
    </div>
  );
}

function QuickLaunch({ w }: { w: Workspace }) {
  const profiles = useS((s) => s.profiles);
  const go = async (profile: string) => {
    const t = await api('terms', 'POST', { profile, cwd: w.folders[0], workspace: w.id, ...(profile !== 'shell' ? { name: profile } : {}) });
    if (t?.id) useS.setState({ focus: t.id });
  };
  return <div className="flex gap-1">{profiles.map((p) => <button key={p.id} className="btn" onClick={() => go(p.id)} title={`Lancer ${p.name}`}>{p.kind === 'shell' ? '›_' : '✦'} {p.name.replace(/^Claude /, '')}</button>)}</div>;
}

export function LaunchDialog({ w, onClose }: { w: Workspace; onClose: () => void }) {
  const profiles = useS((s) => s.profiles);
  // Profile resolved at render time, so profiles that load after the dialog opened are still picked up.
  const [o, setO] = useState({ profile: '', cwd: w.folders[0] ?? '', name: '', role: '', prompt: '', headless: false });
  const [pick, setPick] = useState(false);
  const pid = o.profile || profiles.find((p) => p.isDefault)?.id || profiles[0]?.id || 'opus';
  const isShell = profiles.find((p) => p.id === pid)?.kind === 'shell';
  const go = async () => {
    const r = await api(isShell ? 'terms' : 'agents', 'POST', { ...o, profile: pid, workspace: w.id, name: o.name || undefined, role: o.role || undefined, prompt: o.prompt || undefined });
    const id = isShell ? r?.id : r?.term?.id;
    if (id) useS.setState({ focus: id });
    onClose();
  };
  return (
    <Modal title="Nouveau pane" onClose={onClose}>
      <div className="grid gap-3">
        <div><div className="lbl mb-1">Agent</div>
          <div className="flex flex-wrap gap-1">{profiles.map((p) => <button key={p.id} className={pid === p.id ? 'btn-p' : 'btn'} onClick={() => setO({ ...o, profile: p.id })}>{p.name}</button>)}</div></div>
        <div><div className="lbl mb-1">Dossier</div>
          <div className="flex gap-1"><select className="inp" value={o.cwd} onChange={(e) => setO({ ...o, cwd: e.target.value })}>
            {[...new Set([...w.folders, o.cwd])].filter(Boolean).map((f) => <option key={f} value={f}>{f}</option>)}</select>
            <button className="btn" onClick={() => setPick(!pick)}>…</button></div>
          {pick && <div className="mt-2"><FolderPicker value={o.cwd} onPick={(p) => { setO({ ...o, cwd: p }); setPick(false); }} /></div>}</div>
        {!isShell && <>
          <div className="grid grid-cols-2 gap-2">
            <div><div className="lbl mb-1">Nom</div><input className="inp" placeholder="lead, front, tests…" value={o.name} onChange={(e) => setO({ ...o, name: e.target.value })} /></div>
            <div><div className="lbl mb-1">Rôle (pour @role)</div><input className="inp" placeholder="backend, reviewer…" value={o.role} onChange={(e) => setO({ ...o, role: e.target.value })} /></div>
          </div>
          <div><div className="lbl mb-1">Prompt initial (optionnel)</div><textarea className="inp h-24 resize-y" value={o.prompt} onChange={(e) => setO({ ...o, prompt: e.target.value })} /></div>
          <label className="flex gap-2 items-center text-xs"><input type="checkbox" checked={o.headless} onChange={(e) => setO({ ...o, headless: e.target.checked })} />Headless (one-shot, résultat envoyé dans le fil d'équipe — le moins cher)</label>
        </>}
        <div className="flex justify-end"><button className="btn-p" onClick={go} disabled={!isShell && o.headless && !o.prompt}>Lancer</button></div>
      </div>
    </Modal>
  );
}

function NoPanes({ onLaunch }: { onLaunch: () => void }) {
  return (
    <div className="h-full grid place-items-center text-center text-mute">
      <div className="max-w-sm">
        <div className="text-4xl mb-3">✦</div>
        <p className="mb-3">Aucun pane. Lance un agent Claude ou un shell dans ce workspace.<br />Les agents lancés ici partagent automatiquement le bus d'équipe (messages, tâches, notes).</p>
        <button className="btn-p" onClick={onLaunch}>＋ Nouveau pane</button>
      </div>
    </div>
  );
}
function Empty() {
  return <div className="h-full grid place-items-center text-mute">Crée un workspace dans la barre latérale (＋) pour commencer.</div>;
}
