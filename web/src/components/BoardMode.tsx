// Board: live map of every agent — clusters per workspace around you, delegation links, and messages
// flying between agents as they are sent. Pan (drag), zoom (wheel), click a card for details.
import { useEffect, useMemo, useRef, useState } from 'react';
import { forceSimulation, forceLink, forceManyBody, forceCollide, forceX, forceY, type Simulation, type SimulationNodeDatum } from 'd3-force';
import { useS, api } from '../store';
import { ago, shortPath } from './ui';
import type { Agent, Message, Term } from '../types';

const HUMAN = 'human';
const W = 210, H = 76; // card size
const MODEL_HUE: Record<string, string> = { opus: '#a78bfa', sonnet: '#fb923c', haiku: '#2dd4bf', local: '#4ade80', shell: '#94a3b8' };
const hue = (a?: Agent | null, t?: Term | null) => {
  if (!a) return MODEL_HUE.shell;
  const m = (a.model ?? a.profile ?? '').toLowerCase();
  return Object.entries(MODEL_HUE).find(([k]) => m.includes(k))?.[1] ?? (a.profile === 'local' ? MODEL_HUE.local : '#a78bfa');
};
const STATUS: Record<string, { c: string; l: string }> = {
  working: { c: '#7c5cff', l: 'travaille' }, idle: { c: '#3ecf8e', l: 'inactif' }, waiting: { c: '#f5b84a', l: 'attend ta permission' },
  starting: { c: '#5b9cff', l: 'démarre' }, offline: { c: '#4b5163', l: 'hors ligne' },
};

interface N extends SimulationNodeDatum { id: string; kind: 'human' | 'agent' | 'shell'; ws: string; name: string }
interface Particle { id: number; from: string; to: string; t0: number; body: string }

export function BoardMode() {
  const { agents, terms, messages, tasks, workspaces, set } = useS();
  const [showOff, setShowOff] = useState(false);
  const [showShells, setShowShells] = useState(true);
  const [wsFilter, setWsFilter] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 0.85 });
  const viewRef = useRef(view); viewRef.current = view; // read by the window mouse listeners, which are registered once
  const [, setFrame] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const nodes = useRef(new Map<string, N>());
  const sim = useRef<Simulation<N, any> | null>(null);
  const particles = useRef<Particle[]>([]);
  const lastMsg = useRef(messages.at(-1)?.id ?? 0);

  // ---------- graph model ----------
  const wsOf = (a: Agent) => a.workspace ?? terms.find((t) => t.agent === a.name)?.workspace ?? agents.find((p) => p.name === a.parent)?.workspace ?? '_';
  const visAgents = agents.filter((a) => (showOff || a.status !== 'offline') && (!wsFilter || wsOf(a) === wsFilter));
  const shells = showShells ? terms.filter((t) => !t.agent && (!wsFilter || t.workspace === wsFilter)) : [];
  const graph = useMemo(() => {
    const ns: N[] = [{ id: HUMAN, kind: 'human', ws: '', name: 'toi' }];
    for (const a of visAgents) ns.push({ id: a.name, kind: 'agent', ws: wsOf(a), name: a.name });
    for (const t of shells) ns.push({ id: `term:${t.id}`, kind: 'shell', ws: t.workspace ?? '_', name: t.title });
    const ids = new Set(ns.map((n) => n.id));
    const links: { source: string; target: string; kind: 'parent' }[] = [];
    for (const a of visAgents) {
      const p = a.parent && ids.has(a.parent) ? a.parent : !a.parent ? HUMAN : null;
      if (p) links.push({ source: p, target: a.name, kind: 'parent' });
    }
    return { ns, links, key: ns.map((n) => n.id + n.ws).join() + '|' + links.map((l) => l.source + l.target).join() };
  }, [visAgents.map((a) => a.name + a.parent + a.status + wsOf(a)).join(), shells.map((t) => t.id + t.workspace).join(), wsFilter]);

  // workspace cluster centers on a ring around you
  const clusters = useMemo(() => {
    const keys = [...new Set(graph.ns.filter((n) => n.kind !== 'human').map((n) => n.ws))];
    // ring radius grows with the number of clusters and the size of the biggest one, so clusters never overlap
    const biggest = Math.max(1, ...keys.map((k) => graph.ns.filter((n) => n.ws === k).length));
    const R = Math.max(470, 120 + (keys.length * (180 + 95 * Math.sqrt(biggest))) / Math.PI);
    return new Map(keys.map((k, i) => {
      const ang = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(keys.length, 1);
      return [k, { x: keys.length === 1 ? 0 : Math.cos(ang) * R, y: keys.length === 1 ? 320 : Math.sin(ang) * R, name: workspaces.find((w) => w.id === k)?.name ?? 'hors workspace' }];
    }));
  }, [graph.key, workspaces]);

  // ---------- simulation ----------
  useEffect(() => {
    const map = nodes.current, keep = new Set(graph.ns.map((n) => n.id));
    for (const id of map.keys()) if (!keep.has(id)) map.delete(id);
    for (const n of graph.ns) {
      const cur = map.get(n.id);
      if (cur) { cur.ws = n.ws; cur.name = n.name; continue; }
      const c = clusters.get(n.ws) ?? { x: 0, y: 0 };
      const parent = graph.links.find((l) => l.target === n.id)?.source;
      const p = parent ? map.get(parent) : undefined;
      map.set(n.id, { ...n, x: (p?.x ?? c.x) + (Math.random() - 0.5) * 120, y: (p?.y ?? c.y) + 60 + (Math.random() - 0.5) * 60, ...(n.kind === 'human' ? { fx: 0, fy: 0 } : {}) });
    }
    const arr = [...map.values()];
    const links = graph.links.map((l) => ({ ...l }));
    sim.current?.stop();
    const s = forceSimulation<N>(arr)
      // links to you are long and soft (clusters stay put); delegation links are short and firm
      .force('link', forceLink<N, any>(links).id((d) => d.id).distance((l: any) => (l.source.id === HUMAN ? 320 : 170)).strength((l: any) => (l.source.id === HUMAN ? 0.015 : 0.3)))
      .force('charge', forceManyBody<N>().strength(-650).distanceMax(520))
      .force('collide', forceCollide<N>().radius((d) => (d.kind === 'shell' ? 80 : 125)).strength(0.9))
      .force('x', forceX<N>((d) => clusters.get(d.ws)?.x ?? 0).strength((d) => (d.kind === 'human' ? 0 : 0.16)))
      .force('y', forceY<N>((d) => clusters.get(d.ws)?.y ?? 0).strength((d) => (d.kind === 'human' ? 0 : 0.16)))
      .alpha(sim.current ? 0.45 : 1).alphaDecay(0.035);
    let raf = 0;
    s.on('tick', () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; setFrame((f) => f + 1); }); });
    sim.current = s;
    return () => { s.stop(); cancelAnimationFrame(raf); };
  }, [graph.key, clusters]);

  // ---------- messages → particles ----------
  useEffect(() => {
    const fresh = messages.filter((m) => m.id > lastMsg.current);
    if (!fresh.length) return;
    lastMsg.current = fresh.at(-1)!.id;
    const now = performance.now();
    fresh.forEach((m, i) => particles.current.push({ id: m.id, from: m.frm, to: m.rcpt, t0: now + i * 120, body: m.body }));
    let raf = 0;
    const loop = () => {
      const t = performance.now();
      particles.current = particles.current.filter((p) => t - p.t0 < 4200);
      setFrame((f) => f + 1);
      if (particles.current.length) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [messages.at(-1)?.id]);

  // ---------- view: pan / zoom / fit ----------
  const fit = () => {
    const el = box.current, ns = [...nodes.current.values()];
    if (!el || !ns.length || !el.clientWidth || !el.clientHeight) return;
    const xs = ns.map((n) => n.x ?? 0).filter(Number.isFinite), ys = ns.map((n) => n.y ?? 0).filter(Number.isFinite);
    if (!xs.length) return;
    const [x0, x1, y0, y1] = [Math.min(...xs) - W, Math.max(...xs) + W, Math.min(...ys) - H * 1.5, Math.max(...ys) + H * 1.5];
    const k = Math.max(0.2, Math.min(1.2, el.clientWidth / (x1 - x0), el.clientHeight / (y1 - y0)));
    setView({ k, x: el.clientWidth / 2 - ((x0 + x1) / 2) * k, y: el.clientHeight / 2 - ((y0 + y1) / 2) * k });
  };
  useEffect(() => { const t = setTimeout(fit, 900); return () => clearTimeout(t); }, [graph.ns.length]);
  useEffect(() => { const ro = new ResizeObserver(() => fit()); if (box.current) ro.observe(box.current); return () => ro.disconnect(); }, []);
  const onWheel = (e: React.WheelEvent) => {
    const r = box.current!.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top, dy = e.deltaY;
    setView((v) => { const k = Math.min(2.5, Math.max(0.15, v.k * Math.exp(-dy * 0.0015))); return { k, x: mx - ((mx - v.x) / v.k) * k, y: my - ((my - v.y) / v.k) * k }; });
  };
  const drag = useRef<{ kind: 'pan' | 'node'; id?: string; sx: number; sy: number; vx: number; vy: number; moved: boolean } | null>(null);
  const onDown = (e: React.MouseEvent, id?: string) => {
    e.stopPropagation();
    drag.current = { kind: id ? 'node' : 'pan', id, sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false };
  };
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = drag.current;
      if (!d) return;
      const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
      if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
      if (d.kind === 'pan') setView((v) => ({ ...v, x: d.vx + dx, y: d.vy + dy }));
      else {
        const n = nodes.current.get(d.id!);
        const r = box.current!.getBoundingClientRect();
        const v = viewRef.current;
        if (n) { n.fx = (e.clientX - r.left - v.x) / v.k; n.fy = (e.clientY - r.top - v.y) / v.k; sim.current?.alpha(0.2).restart(); }
      }
    };
    const up = () => {
      const d = drag.current;
      if (d?.kind === 'node' && !d.moved) setSel(d.id!);
      if (d?.kind === 'node' && d.id !== HUMAN) { const n = nodes.current.get(d.id!); if (n) { n.fx = undefined; n.fy = undefined; } }
      if (d?.kind === 'pan' && !d.moved) setSel(null);
      drag.current = null;
    };
    addEventListener('mousemove', move); addEventListener('mouseup', up);
    return () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); };
  }, []);
  useEffect(() => {
    if (sel && sel !== HUMAN && !agents.some((a) => a.name === sel) && !terms.some((t) => `term:${t.id}` === sel)) setSel(null);
  }, [sel, agents, terms]);

  // ---------- derived ----------
  const pos = (id: string) => nodes.current.get(id); // undefined when the agent is not on the board: no particle or link to a fallback node
  const now = Date.now();
  const recent = messages.filter((m) => now - m.ts < 10 * 60e3);
  const chatter = new Map<string, number>();
  for (const m of recent) { const k = [m.frm, m.rcpt].sort().join('↔'); chatter.set(k, (chatter.get(k) ?? 0) + 1); }
  const live = agents.filter((a) => a.status !== 'offline');
  const count = (s: string) => live.filter((a) => a.status === s).length;
  const clusterBoxes = [...clusters.entries()].map(([k, c]) => {
    const ms = graph.ns.filter((n) => n.ws === k).map((n) => nodes.current.get(n.id)).filter(Boolean) as N[];
    if (!ms.length) return null;
    const xs = ms.map((n) => n.x!), ys = ms.map((n) => n.y!);
    return { k, name: c.name, x0: Math.min(...xs) - W / 2 - 30, y0: Math.min(...ys) - H / 2 - 44, x1: Math.max(...xs) + W / 2 + 30, y1: Math.max(...ys) + H / 2 + 30, n: ms.length };
  }).filter(Boolean) as { k: string; name: string; x0: number; y0: number; x1: number; y1: number; n: number }[];

  const curve = (a: N, b: N) => {
    const mx = (a.x! + b.x!) / 2, my = (a.y! + b.y!) / 2, dx = b.x! - a.x!, dy = b.y! - a.y!;
    return { d: `M${a.x},${a.y} Q${mx - dy * 0.15},${my + dx * 0.15} ${b.x},${b.y}`, cx: mx - dy * 0.15, cy: my + dx * 0.15 };
  };
  const along = (a: N, b: N, t: number) => {
    const { cx, cy } = curve(a, b), u = 1 - t;
    return { x: u * u * a.x! + 2 * u * t * cx + t * t * b.x!, y: u * u * a.y! + 2 * u * t * cy + t * t * b.y! };
  };

  return (
    <div className="h-full flex min-w-0">
      <div ref={box} className="relative flex-1 overflow-hidden select-none cursor-grab active:cursor-grabbing"
        style={{ background: 'radial-gradient(circle at 50% 40%, #151827 0%, #0b0c10 70%)', backgroundColor: '#0b0c10' }}
        onWheel={onWheel} onMouseDown={(e) => onDown(e)}>
        <div className="absolute inset-0 opacity-40 pointer-events-none" style={{ backgroundImage: 'radial-gradient(#2a2f3d 1px, transparent 1px)', backgroundSize: `${24 * view.k}px ${24 * view.k}px`, backgroundPosition: `${view.x}px ${view.y}px` }} />
        <div className="absolute left-0 top-0 origin-top-left" style={{ transform: `translate(${view.x}px,${view.y}px) scale(${view.k})` }}>
          {/* clusters */}
          {clusterBoxes.map((c) => (
            <div key={c.k} className="absolute rounded-[28px] border border-white/[0.06] bg-white/[0.015] pointer-events-none" style={{ left: c.x0, top: c.y0, width: c.x1 - c.x0, height: c.y1 - c.y0 }}>
              <div className="absolute -top-3 left-6 px-2.5 py-0.5 rounded-full bg-[#171a21] border border-white/10 text-[11px] text-mute font-semibold tracking-wide">▣ {c.name} <span className="opacity-60">· {c.n}</span></div>
            </div>
          ))}
          <svg className="absolute overflow-visible pointer-events-none" style={{ left: 0, top: 0 }} width="1" height="1">
            <defs>
              <linearGradient id="msgGrad"><stop offset="0" stopColor="#7c5cff" stopOpacity="0.1" /><stop offset="1" stopColor="#7c5cff" stopOpacity="0.9" /></linearGradient>
              <filter id="glow"><feGaussianBlur stdDeviation="4" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
            </defs>
            {graph.links.map((l) => {
              const a = pos(l.source), b = pos(l.target);
              if (!a || !b) return null;
              const ag = agents.find((x) => x.name === l.target);
              return <path key={l.source + l.target} d={curve(a, b).d} fill="none" stroke={ag?.status === 'working' ? '#7c5cff' : '#3a4050'} strokeWidth={1.5} strokeDasharray="6 6" opacity={0.7}
                className={ag?.status === 'working' ? 'board-flow' : ''} />;
            })}
            {[...chatter.entries()].map(([k, n]) => {
              const [x, y] = k.split('↔'), a = pos(x), b = pos(y);
              if (!a || !b || a === b) return null;
              return <path key={k} d={curve(a, b).d} fill="none" stroke="#7c5cff" strokeWidth={Math.min(1 + n, 6)} opacity={0.25} strokeLinecap="round" />;
            })}
            {particles.current.map((p) => {
              const a = pos(p.from), b = pos(p.to), t = (performance.now() - p.t0) / 1100;
              if (!a || !b || t < 0 || a === b) return null;
              const q = along(a, b, Math.min(1, t));
              const trail = [0.06, 0.12, 0.18].map((d) => along(a, b, Math.max(0, Math.min(1, t) - d)));
              return (
                <g key={p.id} opacity={t > 1 ? Math.max(0, 1 - (t - 1) / 2.8) : 1}>
                  {t <= 1 && trail.map((r, i) => <circle key={i} cx={r.x} cy={r.y} r={5 - i * 1.3} fill="#a78bfa" opacity={0.5 - i * 0.15} />)}
                  {t <= 1 && <circle cx={q.x} cy={q.y} r={7} fill="#c4b5fd" filter="url(#glow)" />}
                  {t > 1 && <circle cx={b.x} cy={b.y} r={20 + (t - 1) * 30} fill="none" stroke="#a78bfa" strokeWidth={2} opacity={Math.max(0, 1 - (t - 1))} />}
                </g>
              );
            })}
          </svg>
          {/* message bubbles near the receiver */}
          {particles.current.filter((p) => (performance.now() - p.t0) / 1100 > 0.9).map((p) => {
            const b = pos(p.to);
            if (!b) return null;
            return <div key={'b' + p.id} className="absolute w-max max-w-[260px] px-2.5 py-1.5 rounded-xl rounded-bl-sm bg-[#2a2150]/95 border border-accent/40 text-[11px] text-white shadow-xl pointer-events-none"
              style={{ left: b.x! + W / 2 - 10, top: b.y! - H / 2 - 34 }}><b className="text-accent">{p.from}</b> {p.body.slice(0, 110)}{p.body.length > 110 ? '…' : ''}</div>;
          })}
          {/* nodes */}
          {graph.ns.map((n) => {
            const p = nodes.current.get(n.id);
            if (!p) return null;
            if (n.kind === 'human') return <HumanNode key={n.id} x={p.x!} y={p.y!} unread={messages.filter((m) => m.rcpt === HUMAN && !m.read).length} onDown={(e) => onDown(e, n.id)} />;
            if (n.kind === 'shell') { const t = terms.find((x) => `term:${x.id}` === n.id); return t ? <ShellNode key={n.id} t={t} x={p.x!} y={p.y!} sel={sel === n.id} onDown={(e) => onDown(e, n.id)} /> : null; }
            const a = agents.find((x) => x.name === n.id);
            if (!a) return null;
            return <AgentNode key={n.id} a={a} x={p.x!} y={p.y!} sel={sel === n.id} onDown={(e) => onDown(e, n.id)}
              unread={messages.filter((m) => m.rcpt === a.name && !m.read).length}
              task={tasks.find((t) => t.assignee === a.name && t.status === 'claimed')?.title} />;
          })}
        </div>

        {/* HUD */}
        <div className="absolute left-3 top-3 flex flex-col gap-2" onMouseDown={(e) => e.stopPropagation()}>
          <div className="flex gap-1.5">
            <Stat n={live.length} l="actifs" c="#e6e8ee" /><Stat n={count('working')} l="travaillent" c="#7c5cff" />
            <Stat n={count('waiting')} l="attendent" c="#f5b84a" /><Stat n={recent.length} l="msg / 10 min" c="#a78bfa" />
            <Stat n={tasks.filter((t) => t.status === 'open' || t.status === 'claimed').length} l="tâches" c="#3ecf8e" />
          </div>
          <div className="flex gap-1.5 items-center bg-panel/90 border border-line rounded-lg px-2 py-1.5 text-xs w-fit">
            <select className="inp !w-40 !py-0.5" value={wsFilter} onChange={(e) => setWsFilter(e.target.value)}>
              <option value="">Tous les workspaces</option>{workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
            <label className="flex items-center gap-1"><input type="checkbox" checked={showShells} onChange={(e) => setShowShells(e.target.checked)} />shells</label>
            <label className="flex items-center gap-1"><input type="checkbox" checked={showOff} onChange={(e) => setShowOff(e.target.checked)} />hors ligne</label>
            <button className="btn !py-0.5" onClick={fit}>⌖ Recentrer</button>
          </div>
        </div>
        <div className="absolute left-3 bottom-3 flex gap-3 text-[10px] text-mute bg-panel/80 border border-line rounded-lg px-2.5 py-1.5" onMouseDown={(e) => e.stopPropagation()}>
          {Object.entries(STATUS).filter(([k]) => k !== 'starting').map(([k, v]) => <span key={k} className="flex items-center gap-1"><span className="dot" style={{ background: v.c }} />{v.l}</span>)}
          <span className="flex items-center gap-1"><span className="inline-block w-5 border-t border-dashed border-mute" />délégation</span>
          <span className="flex items-center gap-1"><span className="inline-block w-5 border-t-2 border-accent/60" />échanges</span>
        </div>
        {!live.length && !shells.length && (
          <div className="absolute inset-0 grid place-items-center pointer-events-none text-mute text-sm text-center">
            <div><div className="text-5xl mb-3 opacity-60">◎</div>Aucun agent actif.<br />Lance une mission (mode Agent) ou des panes (mode Code) — ils apparaîtront ici en direct.</div>
          </div>
        )}
      </div>
      {sel && <Inspector id={sel} onClose={() => setSel(null)} goPane={(termId, ws) => set({ mode: 'code', focus: termId, ws: ws ?? useS.getState().ws })} />}
    </div>
  );
}

function Stat({ n, l, c }: { n: number; l: string; c: string }) {
  return <div className="bg-panel/90 border border-line rounded-lg px-2.5 py-1 min-w-16"><div className="text-lg font-bold leading-tight" style={{ color: c }}>{n}</div><div className="text-[10px] text-mute">{l}</div></div>;
}

function HumanNode({ x, y, unread, onDown }: { x: number; y: number; unread: number; onDown: (e: React.MouseEvent) => void }) {
  return (
    <div className="absolute grid place-items-center cursor-pointer" style={{ left: x - 46, top: y - 46, width: 92, height: 92 }} onMouseDown={onDown}>
      <div className="absolute inset-0 rounded-full bg-accent/10 border border-accent/40 board-breathe" />
      <div className="relative size-16 rounded-full bg-gradient-to-br from-[#8b6dff] to-[#4f35d8] grid place-items-center shadow-[0_0_40px_#7c5cff66] text-white font-bold">TOI</div>
      {unread > 0 && <span className="absolute -top-1 -right-1 px-1.5 rounded-full bg-bad text-white text-[10px] font-bold">{unread}✉</span>}
    </div>
  );
}

function AgentNode({ a, x, y, sel, unread, task, onDown }: { a: Agent; x: number; y: number; sel: boolean; unread: number; task?: string; onDown: (e: React.MouseEvent) => void }) {
  const st = STATUS[a.status] ?? STATUS.offline, h = hue(a);
  return (
    <div className={`absolute rounded-2xl cursor-pointer transition-[box-shadow,opacity] ${a.status === 'offline' ? 'opacity-45' : ''}`} onMouseDown={onDown}
      style={{ left: x - W / 2, top: y - H / 2, width: W, height: H, background: 'linear-gradient(160deg, #1a1d27 0%, #12141b 100%)',
        border: `1px solid ${sel ? h : a.status === 'waiting' ? '#f5b84a' : '#2a2f3d'}`,
        boxShadow: a.status === 'working' ? `0 0 0 1px ${h}55, 0 0 28px ${h}40` : a.status === 'waiting' ? '0 0 22px #f5b84a55' : '0 8px 24px #0006' }}>
      <div className="absolute left-0 top-3 bottom-3 w-[3px] rounded-r" style={{ background: h }} />
      <div className="flex items-center gap-2 px-3 pt-2">
        <div className="relative size-7 rounded-lg grid place-items-center text-[11px] font-bold text-[#0b0c10] shrink-0" style={{ background: h }}>
          {a.name.slice(0, 2).toUpperCase()}
          <span className={`absolute -right-1 -bottom-1 size-3 rounded-full border-2 border-[#12141b] ${a.status === 'working' || a.status === 'waiting' ? 'animate-pulse' : ''}`} style={{ background: st.c }} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5"><b className="text-[13px] truncate">{a.name}</b>{a.role && <span className="text-[10px] truncate" style={{ color: h }}>@{a.role}</span>}</div>
          <div className="text-[10px] text-mute truncate">{a.model ?? a.kind}{a.kind === 'headless' ? ' · headless' : ''} · {st.l}</div>
        </div>
        {unread > 0 && <span className="px-1.5 rounded-full bg-accent text-white text-[10px] font-bold shrink-0">{unread}✉</span>}
      </div>
      <div className="px-3 pt-1 text-[11px] truncate" style={{ color: a.status === 'working' ? '#cfd3e0' : '#7d8396' }} title={a.activity ?? ''}>
        {task ? <span className="text-ok">▸ {task}</span> : a.activity ?? shortPath(a.cwd)}
      </div>
      {a.status === 'working' && <div className="absolute left-3 right-3 bottom-1.5 h-[2px] rounded overflow-hidden bg-white/5"><div className="h-full w-1/3 board-scan" style={{ background: h }} /></div>}
    </div>
  );
}

function ShellNode({ t, x, y, sel, onDown }: { t: Term; x: number; y: number; sel: boolean; onDown: (e: React.MouseEvent) => void }) {
  return (
    <div className={`absolute rounded-xl px-2.5 py-1.5 cursor-pointer bg-[#14161d] border text-xs flex items-center gap-2 ${sel ? 'border-slate-400' : 'border-[#2a2f3d]'} ${t.alive ? '' : 'opacity-40'}`}
      style={{ left: x - 70, top: y - 18, width: 140 }} onMouseDown={onDown}>
      <span className="font-mono text-slate-400">›_</span><span className="truncate">{t.title}</span>
      <span className={`dot ml-auto ${t.alive ? 'bg-ok/70' : 'bg-mute/40'}`} />
    </div>
  );
}

function Inspector({ id, onClose, goPane }: { id: string; onClose: () => void; goPane: (termId: string, ws: string | null) => void }) {
  const { agents, terms, messages, tasks } = useS();
  const [body, setBody] = useState('');
  const isTerm = id.startsWith('term:');
  const a = agents.find((x) => x.name === id);
  const t = isTerm ? terms.find((x) => `term:${x.id}` === id) : terms.find((x) => x.agent === id && x.alive);
  const name = isTerm ? t?.title : id;
  const msgs: Message[] = messages.filter((m) => m.frm === id || m.rcpt === id).slice(-30);
  const kids = agents.filter((x) => x.parent === id);
  return (
    <div className="w-80 shrink-0 border-l border-line bg-panel flex flex-col">
      <div className="h-10 flex items-center gap-2 px-3 border-b border-line">
        {a && <span className="dot" style={{ background: STATUS[a.status]?.c }} />}<b className="truncate">{id === HUMAN ? 'Toi (human)' : name}</b>
        <button className="ml-auto text-mute hover:text-text" onClick={onClose}>✕</button>
      </div>
      <div className="flex-1 overflow-auto p-3 space-y-3 text-xs">
        {a && (
          <div className="grid grid-cols-[70px_1fr] gap-y-1">
            <span className="text-mute">Statut</span><span>{STATUS[a.status]?.l}</span>
            <span className="text-mute">Modèle</span><span>{a.model ?? '—'} ({a.kind})</span>
            {a.role && <><span className="text-mute">Rôle</span><span>@{a.role}</span></>}
            <span className="text-mute">Lead</span><span>{a.parent ?? '—'}</span>
            <span className="text-mute">Dossier</span><span className="truncate" title={a.cwd ?? ''}>{shortPath(a.cwd)}</span>
            <span className="text-mute">Activité</span><span className="break-words">{a.activity ?? '—'}</span>
            <span className="text-mute">Vu</span><span>il y a {ago(a.seen)}</span>
          </div>
        )}
        {isTerm && t && <div className="text-mute">Shell · {t.cwd}</div>}
        {kids.length > 0 && <div><div className="lbl mb-1">Délègue à</div><div className="flex flex-wrap gap-1">{kids.map((k) => <span key={k.name} className="px-1.5 py-0.5 rounded bg-panel2"><span className="dot mr-1" style={{ background: STATUS[k.status]?.c }} />{k.name}</span>)}</div></div>}
        {a && tasks.some((x) => x.assignee === id) && (
          <div><div className="lbl mb-1">Tâches</div>{tasks.filter((x) => x.assignee === id).slice(-8).map((x) => <div key={x.id} className="truncate"><span className="text-mute">#{x.id} [{x.status}]</span> {x.title}</div>)}</div>
        )}
        {!isTerm && (
          <div><div className="lbl mb-1">Messages</div>
            <div className="space-y-1">{msgs.map((m) => (
              <div key={m.id} className={`rounded-md px-2 py-1 ${m.frm === id ? 'bg-panel2' : 'bg-accent/10'}`}>
                <div className="text-[10px] text-mute">{m.frm} → {m.rcpt} · {ago(m.ts)}</div><div className="whitespace-pre-wrap break-words">{m.body}</div>
              </div>
            ))}{!msgs.length && <div className="text-mute">Aucun message.</div>}</div>
          </div>
        )}
      </div>
      <div className="p-2 border-t border-line flex flex-col gap-1.5">
        {a && id !== HUMAN && a.status !== 'offline' && (
          <div className="flex gap-1">
            <input className="inp" placeholder={`Message à ${id}…`} value={body} onChange={(e) => setBody(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && body.trim()) { api('messages', 'POST', { to: id, body }); setBody(''); } }} />
            <button className="btn-p" onClick={() => { if (body.trim()) { api('messages', 'POST', { to: id, body }); setBody(''); } }}>➤</button>
          </div>
        )}
        <div className="flex gap-1">
          {t && <button className="btn flex-1 justify-center" onClick={() => goPane(t.id, t.workspace)}>↗ Ouvrir le terminal</button>}
          {a && a.status !== 'offline' && <button className="btn" onClick={() => api(`agents/${id}/stop`, 'POST')}>■ Arrêter</button>}
          {isTerm && t && <button className="btn" onClick={() => { api(`terms/${t.id}`, 'DELETE'); onClose(); }}>✕ Fermer</button>}
        </div>
      </div>
    </div>
  );
}
