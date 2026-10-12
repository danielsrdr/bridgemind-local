// Thread mode: reads Claude Code's own JSONL transcripts (every session: CLI, desktop app, BridgeMind panes).
import { readdirSync, statSync, openSync, readSync, closeSync, readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { profiles, type Profile } from './agents.ts';

export interface ThreadMeta { id: string; path: string; project: string; cwd: string | null; title: string; mtime: number; size: number }
export interface Item { k: 'user' | 'text' | 'tool' | 'result' | 'thinking'; t: string; tool?: string; input?: any; err?: boolean; ts?: string }

const roots = () => {
  const r = new Set([join(homedir(), '.claude', 'projects')]);
  for (const p of profiles.list<Profile>()) if (p.configDir) r.add(join(p.configDir, 'projects'));
  return [...r].filter(existsSync);
};

function head(path: string, n = 96 * 1024) {
  const fd = openSync(path, 'r');
  try { const b = Buffer.alloc(n); const len = readSync(fd, b, 0, n, 0); return b.subarray(0, len).toString('utf8'); } finally { closeSync(fd); }
}

const contentText = (c: any): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b.type === 'text' ? b.text : b.type === 'tool_result' ? contentText(b.content) : '')).join('\n') : '';
const isNoise = (s: string) => !s.trim() || /^<(command-|local-command|system-reminder|bash-)/.test(s.trim()) || s.startsWith('Caveat:');

const metaCache = new Map<string, ThreadMeta>();
export function listThreads(limit = 150): ThreadMeta[] {
  const files: { path: string; project: string; mtime: number; size: number }[] = [];
  for (const root of roots()) for (const proj of readdirSync(root)) {
    const dir = join(root, proj);
    let ents: string[] = [];
    try { ents = readdirSync(dir); } catch { continue; }
    for (const f of ents) if (f.endsWith('.jsonl')) {
      const p = join(dir, f);
      try { const s = statSync(p); if (s.size > 0) files.push({ path: p, project: proj, mtime: s.mtimeMs, size: s.size }); } catch {}
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  return files.slice(0, limit).map((f) => {
    const c = metaCache.get(f.path);
    if (c && c.mtime === f.mtime) return c;
    let title = '', cwd: string | null = null, custom = '';
    for (const line of head(f.path).split('\n')) {
      if (!line.startsWith('{')) continue;
      try {
        const j = JSON.parse(line);
        cwd ??= j.cwd ?? null;
        if (j.type === 'custom-title' || j.type === 'ai-title') custom = j.customTitle ?? j.aiTitle ?? j.title ?? custom;
        if (j.type === 'summary' && j.summary && !custom) custom = j.summary;
        if (!title && j.type === 'user' && !j.isMeta && !j.isSidechain) { const t = contentText(j.message?.content); if (!isNoise(t)) title = t; }
      } catch {}
    }
    const m: ThreadMeta = { id: basename(f.path, '.jsonl'), path: f.path, project: f.project, cwd, title: (custom || title || '(empty)').replace(/\s+/g, ' ').slice(0, 120), mtime: f.mtime, size: f.size };
    metaCache.set(f.path, m);
    return m;
  });
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more chars)` : s);

export function readThread(id: string) {
  const meta = listThreads(1000).find((t) => t.id === id);
  if (!meta) return null;
  const items: Item[] = [];
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let model = '';
  for (const line of readFileSync(meta.path, 'utf8').split('\n')) {
    if (!line.startsWith('{')) continue;
    let j: any; try { j = JSON.parse(line); } catch { continue; }
    if (j.isSidechain || j.isMeta) continue;
    const c = j.message?.content, ts = j.timestamp;
    if (j.type === 'user') {
      if (typeof c === 'string') { if (!isNoise(c)) items.push({ k: 'user', t: c, ts }); continue; }
      for (const b of c ?? []) {
        if (b.type === 'text' && !isNoise(b.text)) items.push({ k: 'user', t: b.text, ts });
        if (b.type === 'tool_result') items.push({ k: 'result', t: clip(contentText(b.content), 3000), err: !!b.is_error, ts });
      }
    } else if (j.type === 'assistant') {
      const u = j.message?.usage;
      if (u) { usage.input += u.input_tokens ?? 0; usage.output += u.output_tokens ?? 0; usage.cacheRead += u.cache_read_input_tokens ?? 0; usage.cacheWrite += u.cache_creation_input_tokens ?? 0; }
      model = j.message?.model ?? model;
      for (const b of c ?? []) {
        if (b.type === 'text' && b.text.trim()) items.push({ k: 'text', t: b.text, ts });
        if (b.type === 'thinking' && b.thinking) items.push({ k: 'thinking', t: clip(b.thinking, 4000), ts });
        if (b.type === 'tool_use') items.push({ k: 'tool', t: '', tool: b.name, input: b.input, ts });
      }
    }
  }
  return { meta, items: items.slice(-1500), usage, model };
}
