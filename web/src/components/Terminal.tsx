import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { onPty, wsSend } from '../store';

const theme = {
  background: '#0b0c10', foreground: '#e6e8ee', cursor: '#7c5cff', selectionBackground: '#7c5cff55',
  black: '#1b1e27', brightBlack: '#5b6175', red: '#f2555a', green: '#3ecf8e', yellow: '#f5b84a', blue: '#5b9cff', magenta: '#b48cff', cyan: '#4fd1d9', white: '#d9dce5',
};

export function Terminal({ id, focused, onFocus }: { id: string; focused: boolean; onFocus: () => void }) {
  const el = useRef<HTMLDivElement>(null);
  const term = useRef<XTerm | null>(null);

  useEffect(() => {
    const t = new XTerm({ fontFamily: "'Cascadia Code', 'Cascadia Mono', Consolas, monospace", fontSize: 13, lineHeight: 1.15, theme,
      scrollback: 8000, allowProposedApi: true, cursorBlink: true, macOptionIsMeta: true });
    const fit = new FitAddon();
    t.loadAddon(fit);
    t.open(el.current!);
    try { const gl = new WebglAddon(); gl.onContextLoss(() => gl.dispose()); t.loadAddon(gl); } catch {}
    term.current = t;
    // Ctrl+C copies when there is a selection, Ctrl+V pastes (Windows-terminal behaviour).
    t.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      // preventDefault stops the browser's copy/paste event, which xterm would otherwise handle a second time (double paste).
      if (e.ctrlKey && e.key === 'c' && t.hasSelection()) { e.preventDefault(); navigator.clipboard.writeText(t.getSelection()).catch(() => {}); t.clearSelection(); return false; }
      if (e.ctrlKey && e.key === 'v') { e.preventDefault(); navigator.clipboard.readText().then((s) => t.paste(s)).catch(() => {}); return false; }
      return true;
    });
    const off = onPty(id, (d, init) => { if (init) t.reset(); t.write(d); });
    const sub = t.onData((d) => wsSend({ t: 'in', id, d }));
    let raf = 0;
    const doFit = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => {
      if (!el.current?.offsetWidth) return;
      try { fit.fit(); wsSend({ t: 'resize', id, cols: t.cols, rows: t.rows }); } catch {}
    }); };
    const ro = new ResizeObserver(doFit);
    ro.observe(el.current!);
    doFit();
    return () => { cancelAnimationFrame(raf); ro.disconnect(); off(); sub.dispose(); t.dispose(); };
  }, [id]);

  useEffect(() => { if (focused) term.current?.focus(); }, [focused]);
  return <div ref={el} className="h-full w-full min-h-0" onMouseDown={onFocus} />;
}

/** Imperative helper: type into a pane (used by voice + quick prompts). */
export const typeInto = (id: string, text: string, enter = false) => {
  wsSend({ t: 'in', id, d: text });
  if (enter) setTimeout(() => wsSend({ t: 'in', id, d: '\r' }), 120);
};
