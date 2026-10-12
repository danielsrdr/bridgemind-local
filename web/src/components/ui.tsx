import { useEffect, useState, type ReactNode } from 'react';
import type { Status } from '../types';
import { api } from '../store';

export const statusColor: Record<Status, string> = {
  offline: 'bg-mute/40', starting: 'bg-accent animate-pulse', idle: 'bg-ok', working: 'bg-accent animate-pulse', waiting: 'bg-warn animate-pulse',
};
export const Dot = ({ s, title }: { s: Status; title?: string }) => <span title={title ?? s} className={`dot ${statusColor[s]}`} />;

export const ago = (t: number) => {
  const s = Math.max(0, (Date.now() - t) / 1000);
  return s < 60 ? `${s | 0}s` : s < 3600 ? `${(s / 60) | 0}m` : s < 86400 ? `${(s / 3600) | 0}h` : `${(s / 86400) | 0}d`;
};
export const fmtTok = (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(1)}M` : n > 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); addEventListener('keydown', k); return () => removeEventListener('keydown', k); }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 bg-black/60 grid place-items-center p-6" onMouseDown={onClose}>
      <div className={`bg-panel border border-line rounded-xl shadow-2xl w-full ${wide ? 'max-w-4xl' : 'max-w-lg'} max-h-[88vh] flex flex-col`} onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center px-4 py-3 border-b border-line"><b className="text-sm">{title}</b><button className="ml-auto text-mute hover:text-text" onClick={onClose}>✕</button></div>
        <div className="p-4 overflow-auto">{children}</div>
      </div>
    </div>
  );
}

/** Minimal directory browser backed by /api/fs. */
export function FolderPicker({ value, onPick }: { value?: string; onPick: (p: string) => void }) {
  const [d, setD] = useState<{ path: string; parent: string | null; dirs: string[]; drives: string[] } | null>(null);
  const [typed, setTyped] = useState(value ?? '');
  const go = (p?: string) => api(`fs${p ? `?path=${encodeURIComponent(p)}` : ''}`).then((r) => { setD(r); setTyped(r.path); });
  useEffect(() => { go(value); }, []);
  if (!d) return null;
  const sep = d.path.includes('\\') ? '\\' : '/';
  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-1">
        <input className="inp font-mono" value={typed} onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go(typed)} />
        {d.drives.map((x) => <button key={x} className="btn" onClick={() => go(x)}>{x.slice(0, 2)}</button>)}
      </div>
      <div className="h-56 overflow-auto rounded-md border border-line bg-bg font-mono text-xs">
        {d.parent && <div className="px-2 py-1 hover:bg-panel2 cursor-pointer text-mute" onClick={() => go(d.parent!)}>..</div>}
        {d.dirs.map((x) => <div key={x} className="px-2 py-1 hover:bg-panel2 cursor-pointer" onDoubleClick={() => go(d.path.replace(/[\\/]$/, '') + sep + x)} onClick={() => setTyped(d.path.replace(/[\\/]$/, '') + sep + x)}>📁 {x}</div>)}
      </div>
      <div className="flex justify-between items-center"><span className="text-mute text-[11px]">Double-clic pour entrer</span><button className="btn-p" onClick={() => onPick(typed)}>Choisir ce dossier</button></div>
    </div>
  );
}

export const shortPath = (p?: string | null) => (p ? p.split(/[\\/]/).filter(Boolean).slice(-2).join('/') : '');
