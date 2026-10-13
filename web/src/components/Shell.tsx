import { useState } from 'react';
import { useS, api, refresh, type Mode } from '../store';
import { Dot, FolderPicker, Modal, shortPath } from './ui';
import type { Profile, Workspace } from '../types';
import { VoiceButton } from './Voice';

export function TitleBar() {
  const { mode, set, dock, connected, agents } = useS();
  const live = agents.filter((a) => a.status !== 'offline');
  const busy = live.filter((a) => a.status === 'working').length, waiting = live.filter((a) => a.status === 'waiting').length;
  const modes: [Mode, string, string][] = [['agent', 'Agent', 'Ctrl+1'], ['code', 'Code', 'Ctrl+2'], ['board', 'Board', 'Ctrl+4'], ['thread', 'Thread', 'Ctrl+3']];
  return (
    <div className={`drag h-11 flex items-center gap-3 pl-3 border-b border-line bg-panel shrink-0 ${(window as any).desktop ? "pr-[150px]" : "pr-3"}`}>
      <div className="flex items-center gap-2 w-52">
        <div className="size-6 rounded-md bg-accent grid place-items-center text-white text-xs font-bold">B</div>
        <b className="text-sm tracking-tight">BridgeMind <span className="text-mute font-normal">local</span></b>
      </div>
      <div className="flex bg-bg rounded-lg p-0.5 border border-line">
        {modes.map(([m, l, k]) => <button key={m} title={k} onClick={() => set({ mode: m })} className={`px-4 py-1 rounded-md text-xs font-medium ${mode === m ? 'bg-accent text-white' : 'text-mute hover:text-text'}`}>{l}</button>)}
      </div>
      <div className="ml-auto flex items-center gap-3 text-xs">
        <span className="text-mute flex items-center gap-1.5">{live.length} agents{busy > 0 && <><Dot s="working" />{busy}</>}{waiting > 0 && <><Dot s="waiting" title="en attente de permission" />{waiting}</>}</span>
        <VoiceButton />
        <button className={dock === 'team' ? 'btn-p' : 'btn'} onClick={() => set({ dock: dock === 'team' ? null : 'team' })} title="Ctrl+B">⇄ Équipe</button>
        <button className={dock === 'browser' ? 'btn-p' : 'btn'} onClick={() => set({ dock: dock === 'browser' ? null : 'browser' })}>◫ Navigateur</button>
        <button className="btn" onClick={() => set({ settingsOpen: true })}>⚙</button>
        <span className={`dot ${connected ? 'bg-ok' : 'bg-bad animate-pulse'}`} title={connected ? 'hub connecté' : 'hub déconnecté'} />
      </div>
    </div>
  );
}

export function Sidebar() {
  const { workspaces, ws, terms, agents, set } = useS();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Workspace | null>(null);
  const pick = (id: string) => { set({ ws: id, mode: useS.getState().mode === 'agent' ? 'code' : useS.getState().mode }); api('last', 'POST', { id }); };
  return (
    <div className="w-56 shrink-0 border-r border-line bg-panel flex flex-col">
      <div className="flex items-center px-3 h-9"><span className="lbl">Workspaces</span><button className="ml-auto text-mute hover:text-text text-base" title="Nouveau workspace" onClick={() => setAdding(true)}>＋</button></div>
      <div className="flex-1 overflow-auto pb-2">
        {workspaces.map((w) => {
          const mine = terms.filter((t) => t.workspace === w.id);
          return (
            <div key={w.id} className="mb-1">
              <div onClick={() => pick(w.id)} onDoubleClick={() => setEditing(w)} className={`group mx-1.5 px-2 py-1.5 rounded-md cursor-pointer flex items-center gap-2 ${ws === w.id ? 'bg-panel2' : 'hover:bg-panel2/60'}`}>
                <span className="text-mute">{ws === w.id ? '▾' : '▸'}</span><b className="text-xs truncate flex-1">{w.name}</b>
                <span className="text-[10px] text-mute">{mine.length || ''}</span>
                <button className="opacity-0 group-hover:opacity-100 text-mute hover:text-text text-[11px]" onClick={(e) => { e.stopPropagation(); setEditing(w); }}>✎</button>
              </div>
              {ws === w.id && mine.map((t) => {
                const a = agents.find((x) => x.name === t.agent);
                return (
                  <div key={t.id} onClick={() => set({ focus: t.id, mode: 'code' })} className="ml-6 mr-1.5 px-2 py-1 rounded cursor-pointer hover:bg-panel2/60 flex items-center gap-2 text-xs">
                    {a ? <Dot s={a.status} /> : <span className={`dot ${t.alive ? 'bg-ok/50' : 'bg-mute/40'}`} />}
                    <span className="truncate">{t.title}</span>
                    <span className="ml-auto text-[10px] text-mute truncate max-w-16">{a?.model ?? ''}</span>
                  </div>
                );
              })}
            </div>
          );
        })}
        {!workspaces.length && <div className="px-3 text-xs text-mute">Un workspace = un ou plusieurs dossiers + leurs panes. Clique ＋.</div>}
      </div>
      {(adding || editing) && <WorkspaceDialog w={editing} onClose={() => { setAdding(false); setEditing(null); }} />}
    </div>
  );
}

function WorkspaceDialog({ w, onClose }: { w: Workspace | null; onClose: () => void }) {
  const [name, setName] = useState(w?.name ?? '');
  const [folders, setFolders] = useState<string[]>(w?.folders ?? []);
  const [pick, setPick] = useState(!w);
  const save = async () => {
    const r = await api('workspaces', 'POST', { ...(w ?? {}), name: name || shortPath(folders[0]) || 'Workspace', folders });
    await refresh(); useS.setState({ ws: r.id }); onClose();
  };
  return (
    <Modal title={w ? 'Workspace' : 'Nouveau workspace'} onClose={onClose}>
      <div className="grid gap-3">
        <label><div className="lbl mb-1">Nom</div><input className="inp" value={name} onChange={(e) => setName(e.target.value)} placeholder="mon-projet" /></label>
        <div><div className="lbl mb-1">Dossiers</div>
          {folders.map((f) => <div key={f} className="flex items-center gap-2 text-xs font-mono py-0.5"><span className="flex-1 truncate">{f}</span><button className="text-mute hover:text-bad" onClick={() => setFolders(folders.filter((x) => x !== f))}>✕</button></div>)}
          {pick ? <FolderPicker onPick={(p) => { setFolders([...new Set([...folders, p])]); if (!name) setName(p.split(/[\\/]/).filter(Boolean).pop() ?? ''); setPick(false); }} />
            : <button className="btn mt-1" onClick={() => setPick(true)}>＋ Ajouter un dossier</button>}
        </div>
        <div className="flex justify-between">
          {w ? <button className="btn" onClick={async () => { if (confirm(`Supprimer « ${w.name} » ? (les dossiers ne sont pas touchés)`)) { await api(`workspaces/${w.id}`, 'DELETE'); useS.setState({ ws: null }); await refresh(); onClose(); } }}>Supprimer</button> : <span />}
          <button className="btn-p" disabled={!folders.length} onClick={save}>Enregistrer</button>
        </div>
      </div>
    </Modal>
  );
}

export function BrowserDock() {
  const { browserUrl, set } = useS();
  const [u, setU] = useState(browserUrl);
  const [k, setK] = useState(0);
  return (
    <div className="h-full flex flex-col border-l border-line bg-panel">
      <div className="flex gap-1 p-1.5 border-b border-line">
        <button className="btn" onClick={() => setK(k + 1)}>↻</button>
        <input className="inp font-mono" value={u} onChange={(e) => setU(e.target.value)} onKeyDown={(e) => { const t = u.trim(); if (e.key === 'Enter' && t) { const v = /^https?:/i.test(t) ? t : `http://${t}`; setU(v); set({ browserUrl: v }); setK(k + 1); } }} />
        <button className="btn" onClick={() => window.open(browserUrl)}>↗</button>
      </div>
      <iframe key={k} src={browserUrl} className="flex-1 bg-white" />
    </div>
  );
}

export function Settings() {
  const { profiles, settings, set } = useS();
  const [edit, setEdit] = useState<Profile | null>(null);
  const [path, setPath] = useState(settings.claudePath);
  const [msg, setMsg] = useState('');
  const integrate = async (on: boolean) => {
    const r = await api('integrate', 'POST', { on });
    setMsg(r.ok ? (on ? 'Intégré : toute session Claude Code (appli incluse) voit le bus « bridge ».' : 'Intégration retirée.') : `Erreur : ${r.error}`);
    refresh();
  };
  return (
    <Modal title="Réglages" wide onClose={() => set({ settingsOpen: false })}>
      <div className="grid gap-6">
        <section>
          <div className="lbl mb-2">Profils d'agents</div>
          <div className="grid gap-1">
            {profiles.map((p) => (
              <div key={p.id} className="flex items-center gap-3 rounded-md border border-line px-3 py-2 text-xs">
                <b className="w-36">{p.name}</b><code className="text-mute">{p.kind === 'shell' ? p.command : `claude --model ${p.model ?? 'default'}`}</code>
                {p.env?.ANTHROPIC_BASE_URL && <span className="text-accent">→ {p.env.ANTHROPIC_BASE_URL}</span>}
                {p.configDir && <span className="text-warn">compte: {shortPath(p.configDir)}</span>}
                {p.isDefault && <span className="text-ok">défaut</span>}
                <button className="btn ml-auto" onClick={() => setEdit(p)}>✎</button>
                <button className="btn" onClick={async () => { await api(`profiles/${p.id}`, 'DELETE'); refresh(); }}>🗑</button>
              </div>
            ))}
            <button className="btn w-fit mt-1" onClick={() => setEdit({ id: '', name: '', kind: 'claude', model: 'sonnet' })}>＋ Profil</button>
          </div>
          <p className="text-[11px] text-mute mt-2">Multi-comptes : mets un « dossier de config » différent par compte (CLAUDE_CONFIG_DIR) puis lance <code>/login</code> une fois dans un pane de ce profil. IA locale : profil « Local » → Ollama (≥ 0.14, API compatible Anthropic) sur localhost:11434.</p>
        </section>
        <DictationSettings />
        <section className="grid gap-2">
          <div className="lbl">Claude Code</div>
          <div className="flex gap-2"><input className="inp font-mono" value={path} onChange={(e) => setPath(e.target.value)} /><button className="btn" onClick={() => api('settings', 'POST', { claudePath: path }).then(refresh)}>OK</button></div>
          <div className="flex items-center gap-2 text-xs">
            <span>Intégration globale (MCP « bridge » + hooks dans ~/.claude) :</span>
            <b className={settings.integrated ? 'text-ok' : 'text-mute'}>{settings.integrated ? 'active' : 'inactive'}</b>
            <button className="btn" onClick={() => integrate(!settings.integrated)}>{settings.integrated ? 'Retirer' : 'Activer'}</button>
          </div>
          <p className="text-[11px] text-mute">Optionnel. Les agents lancés depuis BridgeMind sont déjà câblés. L'intégration permet aux sessions de l'appli Claude Code de rejoindre l'équipe (outil <code>join</code>).</p>
          {msg && <div className="text-xs text-accent">{msg}</div>}
          <div className="flex items-center gap-2 text-[11px] text-mute">Hub : {settings.hub} · données : {settings.dataDir}
            <button className="btn ml-auto" onClick={() => { if (confirm('Arrêter le hub ? Tous les agents et terminaux seront fermés.')) api('shutdown', 'POST'); }}>⏻ Arrêter le hub</button></div>
        </section>
      </div>
      {edit && <ProfileEditor p={edit} onClose={() => setEdit(null)} />}
    </Modal>
  );
}

function ProfileEditor({ p, onClose }: { p: Profile; onClose: () => void }) {
  const [o, setO] = useState<Profile>(p);
  const [env, setEnv] = useState(Object.entries(p.env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n'));
  const save = async () => {
    // "KEY = val" must not keep a space in the key; a line without a key ("=x") is dropped
    const e = Object.fromEntries(env.split('\n').map((l) => l.trim()).filter((l) => l.indexOf('=') > 0).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
    await api('profiles', 'POST', { ...o, env: e, args: o.args?.filter(Boolean) });
    await refresh(); onClose();
  };
  return (
    <Modal title="Profil" onClose={onClose}>
      <div className="grid gap-3 text-xs">
        <div className="grid grid-cols-2 gap-2">
          <label><div className="lbl mb-1">Nom</div><input className="inp" value={o.name} onChange={(e) => setO({ ...o, name: e.target.value })} /></label>
          <label><div className="lbl mb-1">Type</div><select className="inp" value={o.kind} onChange={(e) => setO({ ...o, kind: e.target.value as any })}><option value="claude">Claude Code</option><option value="shell">Shell / autre CLI</option></select></label>
        </div>
        {o.kind === 'claude' ? <>
          <div className="grid grid-cols-2 gap-2">
            <label><div className="lbl mb-1">Modèle</div><input className="inp" value={o.model ?? ''} onChange={(e) => setO({ ...o, model: e.target.value })} placeholder="opus | sonnet | haiku | qwen3-coder…" /></label>
            <label><div className="lbl mb-1">Permission mode</div><select className="inp" value={o.permissionMode ?? ''} onChange={(e) => setO({ ...o, permissionMode: e.target.value || undefined })}>
              <option value="">default (demande)</option><option>acceptEdits</option><option>plan</option><option>auto</option><option>bypassPermissions</option></select></label>
          </div>
          <label><div className="lbl mb-1">Dossier de config (compte isolé)</div><input className="inp font-mono" value={o.configDir ?? ''} onChange={(e) => setO({ ...o, configDir: e.target.value || undefined })} placeholder="C:\Users\moi\.claude-perso" /></label>
          <label className="flex gap-2 items-center"><input type="checkbox" checked={!!o.inheritMcp} onChange={(e) => setO({ ...o, inheritMcp: e.target.checked })} />Charger aussi mes autres serveurs MCP (coûte des tokens à chaque tour)</label>
        </> : <label><div className="lbl mb-1">Commande</div><input className="inp font-mono" value={o.command ?? ''} onChange={(e) => setO({ ...o, command: e.target.value })} placeholder="powershell.exe | aider | ollama run qwen3" /></label>}
        <label><div className="lbl mb-1">Arguments (un par ligne)</div><textarea className="inp h-14 font-mono" value={(o.args ?? []).join('\n')} onChange={(e) => setO({ ...o, args: e.target.value.split('\n') })} /></label>
        <label><div className="lbl mb-1">Variables d'env (KEY=val, vide = retirer)</div><textarea className="inp h-20 font-mono" value={env} onChange={(e) => setEnv(e.target.value)} /></label>
        <label className="flex gap-2 items-center"><input type="checkbox" checked={!!o.isDefault} onChange={(e) => setO({ ...o, isDefault: e.target.checked })} />Profil par défaut</label>
        <div className="flex justify-end"><button className="btn-p" disabled={!o.name} onClick={save}>Enregistrer</button></div>
      </div>
    </Modal>
  );
}

const MODELS = [
  ['onnx-community/whisper-base', 'Base — rapide (~80 Mo)'],
  ['onnx-community/whisper-small', 'Small — recommandé (~250 Mo)'],
  ['onnx-community/whisper-large-v3-turbo', 'Large v3 turbo — le plus précis (~800 Mo, GPU)'],
];

function DictationSettings() {
  const d = useS((s) => s.settings.dictation);
  if (!d) return null;
  const desktop = (window as any).desktop;
  const save = async (p: Partial<typeof d>) => {
    const c = await api('dictation', 'POST', p);
    desktop?.setDictation(c);
  };
  return (
    <section className="grid gap-2 text-xs">
      <div className="lbl">Dictée vocale (100 % locale)</div>
      {desktop ? (
        <>
          <label className="flex gap-2 items-center"><input type="checkbox" checked={d.enabled} onChange={(e) => save({ enabled: e.target.checked })} />
            Dictée partout dans Windows : maintiens le raccourci, parle, relâche → le texte est collé dans la fenêtre active (terminal, Claude, navigateur…)</label>
          <div className="grid grid-cols-3 gap-2">
            <label><div className="lbl mb-1">Raccourci (maintenir)</div><select className="inp" value={d.hotkey} onChange={(e) => save({ hotkey: e.target.value })}>
              <option value="ctrl+win">Ctrl + Win</option><option value="ctrl+alt">Ctrl + Alt</option><option value="ctrl+shift">Ctrl + Maj</option><option value="right-ctrl">Ctrl droit</option></select></label>
            <label><div className="lbl mb-1">Modèle Whisper</div><select className="inp" value={d.model} onChange={(e) => save({ model: e.target.value })}>
              {MODELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
            <label><div className="lbl mb-1">Langue</div><select className="inp" value={d.language} onChange={(e) => save({ language: e.target.value })}>
              <option value="french">Français</option><option value="english">English</option></select></label>
          </div>
          <label className="flex gap-2 items-center"><input type="checkbox" checked={d.autoEnter} onChange={(e) => save({ autoEnter: e.target.checked })} />Appuyer sur Entrée après la dictée (envoi direct du prompt)</label>
        </>
      ) : <p className="text-mute">La dictée globale (partout dans Windows) n'est disponible que dans l'appli de bureau.</p>}
      <p className="text-[11px] text-mute">Dans BridgeMind : Ctrl+Espace ou 🎙. Dans le CLI Claude (panes et ton terminal) : la dictée intégrée de Claude Code est activée → maintiens <b>Espace</b> sur un prompt vide.</p>
    </section>
  );
}
