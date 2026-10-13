import { useEffect, useState } from 'react';
import { useS, api } from '../store';
import { ago, fmtTok, FolderPicker, Modal, shortPath } from './ui';
import type { Routine, Tier } from '../types';

const PRESETS = [
  ['Chaque matin (9h, lun-ven)', '0 9 * * 1-5'], ['Toutes les heures', '0 * * * *'], ['Tous les jours minuit', '0 0 * * *'], ['Toutes les 15 min', '*/15 * * * *'],
];

type TierKey = 'lead' | 'scan' | 'validate' | 'refactor';
const ROWS: [TierKey, string][] = [['lead', 'Lead · planifie & livre'], ['scan', 'Scan · balayage'], ['validate', 'Validation · filtre + schéma'], ['refactor', 'Refactor · worktree git']];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const DEFAULT_TIERS: Record<TierKey, Tier> = {
  lead: { profile: 'opus', effort: 'high' }, scan: { profile: 'haiku', effort: 'low' }, validate: { profile: 'haiku', effort: 'low' }, refactor: { profile: 'sonnet', effort: 'medium', worktree: true },
};
/** Server tiers win per key; missing keys fall back to the defaults. */
const tiersFrom = (t?: Record<string, Tier>): Record<TierKey, Tier> => ({
  lead: { ...DEFAULT_TIERS.lead, ...t?.lead }, scan: { ...DEFAULT_TIERS.scan, ...t?.scan }, validate: { ...DEFAULT_TIERS.validate, ...t?.validate }, refactor: { ...DEFAULT_TIERS.refactor, ...t?.refactor },
});

export function missionPrompt(goal: string, maxWorkers: number) {
  return `MISSION: ${goal}

You lead this mission: plan, decide, merge, ship. The hub routes spawn(role) to the right model and effort, so don't pass model.
1. Plan: inspect only what you need, write note "plan" (short, numbered), split into tasks (task_add, deps when ordered). For a sweep or refactor, put the candidate JSON Schema in note "schema/candidates".
2. Scan: spawn(role:"scan", headless:true), one per slice of files, in parallel. Each extracts candidates (file, symbol, change) with note_set("cand/<name>", json, schema:"schema/candidates"). No edits.
3. Validate: spawn(role:"validate", headless:true) drops false positives and malformed entries, then writes note "cand/ok" (schema-checked). Skip steps 2-3 when there is nothing to sweep.
4. Refactor: spawn(role:"refactor", headless:true), one per independent group of changes. Each works in its own git worktree and commits on its branch. Commit your own pending changes first, because worktrees start from HEAD.
5. Ship: validate(key:"cand/ok", schema:"schema/candidates") must pass before you merge a multi-file refactor. Merge the branches, run build/tests, fix gaps, then remove the worktrees.
At most ${maxWorkers} workers live at once. Every worker prompt names its task id, files, notes and acceptance criteria.
6. Finish with send(to:"human"): a 5-line summary of what changed, how you verified it, and open issues.`;
}

export function AgentMode() {
  return (
    <div className="h-full overflow-auto">
      <div className="max-w-5xl mx-auto p-6 space-y-8">
        <Mission />
        <Routines />
        <Runs />
      </div>
    </div>
  );
}

function Mission() {
  const { ws, workspaces, profiles, workflow } = useS();
  const w = workspaces.find((x) => x.id === ws);
  const claude = profiles.filter((p) => p.kind === 'claude');
  const [o, setO] = useState({ goal: '', max: 3, cwd: w?.folders[0] ?? '' });
  const [tiers, setTiers] = useState<Record<TierKey, Tier>>(() => tiersFrom(workflow?.tiers));
  const [pick, setPick] = useState(false);
  // The workflow may arrive after mount (snapshot or websocket event): adopt it.
  useEffect(() => { if (workflow) setTiers(tiersFrom(workflow.tiers)); }, [workflow]);
  const setTier = (k: TierKey, patch: Partial<Tier>) => setTiers({ ...tiers, [k]: { ...tiers[k], ...patch } });
  const go = async () => {
    const max = Math.min(8, Math.max(1, Math.round(o.max) || 1)); // empty/invalid number input gave 0 or NaN workers
    await api('workflow', 'POST', { tiers });
    const r = await api('agents', 'POST', { name: 'lead', role: 'lead', profile: tiers.lead.profile, effort: tiers.lead.effort, cwd: o.cwd || w?.folders[0], workspace: ws, prompt: missionPrompt(o.goal, max) });
    if (r?.term) useS.setState({ mode: 'code', focus: r.term.id, dock: 'team' });
  };
  return (
    <section>
      <h2 className="text-lg font-semibold mb-1">Mission multi-agent</h2>
      <p className="text-mute text-xs mb-3">Opus planifie et livre, Haiku balaie et filtre, Sonnet refactorise en worktree isolé. Tout passe par le bus local (messages, tâches, notes) — visible dans le panneau Équipe.</p>
      <div className="rounded-xl border border-line bg-panel p-4 grid gap-3">
        <textarea className="inp h-24 resize-y text-[13px]" placeholder="Objectif… ex: Ajoute l'auth JWT à l'API, avec tests, et documente-la." value={o.goal} onChange={(e) => setO({ ...o, goal: e.target.value })} />
        <div className="grid gap-1.5">
          <div className="grid grid-cols-[minmax(0,2fr)_1fr_1fr_auto] gap-2 lbl"><span>Rôle</span><span>Profil</span><span>Effort</span><span>Worktree</span></div>
          {ROWS.map(([k, label]) => (
            <div key={k} className="grid grid-cols-[minmax(0,2fr)_1fr_1fr_auto] gap-2 items-center text-xs">
              <span className="truncate">{label}</span>
              <select className="inp" value={tiers[k].profile} onChange={(e) => setTier(k, { profile: e.target.value })}>{claude.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
              <select className="inp" value={tiers[k].effort ?? ''} onChange={(e) => setTier(k, { effort: e.target.value || undefined })}><option value="">défaut</option>{EFFORTS.map((e) => <option key={e} value={e}>{e}</option>)}</select>
              {k === 'refactor' ? <label className="flex items-center gap-1.5 text-mute px-1"><input type="checkbox" checked={!!tiers.refactor.worktree} onChange={(e) => setTier('refactor', { worktree: e.target.checked })} />worktree</label> : <span className="w-4" />}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-[10rem_1fr] gap-2 items-end">
          <label><div className="lbl mb-1">Max workers</div><input type="number" min={1} max={8} className="inp" value={o.max} onChange={(e) => setO({ ...o, max: +e.target.value })} /></label>
          <button className="btn justify-center" onClick={() => setPick(!pick)} title={o.cwd}>📁 {shortPath(o.cwd) || 'dossier'}</button>
        </div>
        {pick && <FolderPicker value={o.cwd} onPick={(p) => { setO({ ...o, cwd: p }); setPick(false); }} />}
        <div className="flex justify-end"><button className="btn-p" disabled={!o.goal.trim() || !w} onClick={go}>🚀 Lancer la mission</button></div>
        {!w && <div className="text-warn text-xs">Crée d'abord un workspace.</div>}
      </div>
    </section>
  );
}

function Routines() {
  const routines = useS((s) => s.routines);
  const [edit, setEdit] = useState<Partial<Routine> | null>(null);
  const save = async (r: Partial<Routine>) => { await api('routines', 'POST', r); const s = await api('state'); useS.setState({ routines: s.routines }); setEdit(null); };
  return (
    <section>
      <div className="flex items-center mb-3"><h2 className="text-lg font-semibold">Routines</h2>
        <button className="btn-p ml-auto" onClick={() => setEdit({ name: '', prompt: '', schedule: PRESETS[0][1], profile: 'haiku', enabled: true, notify: 'human' })}>＋ Routine</button></div>
      <div className="grid gap-2">
        {routines.map((r) => (
          <div key={r.id} className="rounded-xl border border-line bg-panel p-3 flex gap-3 items-center">
            <input type="checkbox" checked={r.enabled} onChange={(e) => save({ ...r, enabled: e.target.checked })} />
            <div className="min-w-0 flex-1">
              <div className="flex gap-2 items-baseline"><b className="text-sm">{r.name}</b><code className="text-[11px] text-mute">{r.schedule}</code><span className="text-[11px] text-mute">{r.profile} · {shortPath(r.cwd)}</span></div>
              <div className="text-xs text-mute truncate">{r.prompt}</div>
            </div>
            <span className="text-[11px] text-mute">{r.next ? `prochain: ${new Date(r.next).toLocaleString()}` : '—'}</span>
            <button className="btn" onClick={() => api(`routines/${r.id}/run`, 'POST')}>▶ Maintenant</button>
            <button className="btn" onClick={() => setEdit(r)}>✎</button>
            <button className="btn" onClick={async () => { await api(`routines/${r.id}`, 'DELETE'); const s = await api('state'); useS.setState({ routines: s.routines }); }}>🗑</button>
          </div>
        ))}
        {!routines.length && <div className="text-mute text-xs">Ex : « Chaque matin, résume les commits d'hier et les TODO ouverts » — tourne en headless, résultat envoyé dans le fil d'équipe.</div>}
      </div>
      {edit && <RoutineEditor r={edit} onSave={save} onClose={() => setEdit(null)} />}
    </section>
  );
}

function RoutineEditor({ r, onSave, onClose }: { r: Partial<Routine>; onSave: (r: Partial<Routine>) => void; onClose: () => void }) {
  const profiles = useS((s) => s.profiles).filter((p) => p.kind === 'claude'); // filter outside: a fresh array from the selector loops forever (zustand 5)
  const [o, setO] = useState(r);
  const [pick, setPick] = useState(false);
  return (
    <Modal title={r.id ? 'Modifier la routine' : 'Nouvelle routine'} onClose={onClose}>
      <div className="grid gap-3">
        <label><div className="lbl mb-1">Nom</div><input className="inp" value={o.name} onChange={(e) => setO({ ...o, name: e.target.value })} /></label>
        <label><div className="lbl mb-1">Brief</div><textarea className="inp h-28" value={o.prompt} onChange={(e) => setO({ ...o, prompt: e.target.value })} /></label>
        <div><div className="lbl mb-1">Planification (cron)</div>
          <div className="flex gap-1 flex-wrap mb-1">{PRESETS.map(([l, c]) => <button key={c} className={o.schedule === c ? 'btn-p' : 'btn'} onClick={() => setO({ ...o, schedule: c })}>{l}</button>)}</div>
          <input className="inp font-mono" value={o.schedule} onChange={(e) => setO({ ...o, schedule: e.target.value })} /></div>
        <div className="grid grid-cols-2 gap-2">
          <label><div className="lbl mb-1">Agent</div><select className="inp" value={o.profile} onChange={(e) => setO({ ...o, profile: e.target.value })}>{profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          <label><div className="lbl mb-1">Notifier</div><input className="inp" value={o.notify ?? ''} onChange={(e) => setO({ ...o, notify: e.target.value })} /></label>
        </div>
        <div><div className="lbl mb-1">Dossier</div><button className="btn" onClick={() => setPick(!pick)}>📁 {o.cwd || 'choisir…'}</button>
          {pick && <div className="mt-2"><FolderPicker value={o.cwd} onPick={(p) => { setO({ ...o, cwd: p }); setPick(false); }} /></div>}</div>
        <div className="flex justify-end"><button className="btn-p" disabled={!o.name || !o.prompt || !o.schedule} onClick={() => onSave(o)}>Enregistrer</button></div>
      </div>
    </Modal>
  );
}

function Runs() {
  const runs = useS((s) => s.runs);
  const routines = useS((s) => s.routines);
  const [open, setOpen] = useState<number | null>(null);
  const cost = runs.reduce((a, r) => a + (r.cost ?? 0), 0);
  return (
    <section>
      <div className="flex items-baseline gap-3 mb-3"><h2 className="text-lg font-semibold">Historique des runs headless</h2><span className="text-mute text-xs">{runs.length} runs · coût API équivalent ≈ ${cost.toFixed(3)} (inclus dans ton abonnement)</span></div>
      <div className="rounded-xl border border-line bg-panel divide-y divide-line">
        {runs.map((r) => (
          <div key={r.id} className="px-3 py-2 text-xs cursor-pointer hover:bg-panel2" onClick={() => setOpen(open === r.id ? null : r.id)}>
            <div className="flex gap-3">
              <span className={r.status === 'success' ? 'text-ok' : r.status === 'running' ? 'text-accent' : 'text-bad'}>●</span>
              <b>{r.agent}</b><span className="text-mute">{routines.find((x) => x.id === r.routine)?.name ?? ''}</span>
              <span className="ml-auto text-mute">{r.tokens ? `${fmtTok(r.tokens)} tok · ` : ''}{r.ended ? `${((r.ended - r.started) / 1000).toFixed(0)}s · ` : ''}{ago(r.started)}</span>
            </div>
            {open === r.id ? <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px]">{r.result}</pre> : r.result && <div className="text-mute truncate">{r.result}</div>}
          </div>
        ))}
        {!runs.length && <div className="p-3 text-mute text-xs">Aucun run.</div>}
      </div>
    </section>
  );
}
