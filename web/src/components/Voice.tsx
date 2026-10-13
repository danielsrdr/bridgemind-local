// In-app hold-to-talk (Ctrl+Space / 🎙 button). System-wide dictation lives in the desktop shell (Ctrl+Win anywhere).
import { useEffect, useRef, useState } from 'react';
import { useS } from '../store';
import { typeInto } from './Terminal';
import { AsrTimeout, record, toMono16k, transcribe } from '../asr';

type Target = { el: HTMLTextAreaElement | HTMLInputElement } | { term: string } | null;
const MAX_REC_MS = 5 * 60e3;

/** Where the text will go, captured when dictation starts (focus can move while Whisper runs). */
function target(): Target {
  const el = document.activeElement as HTMLElement | null;
  // xterm's hidden textarea: the pane that owns it, not the textarea itself
  const pane = el?.closest<HTMLElement>('[data-term]')?.dataset.term;
  if (pane) return { term: pane };
  if (el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && el.type === 'text')) return { el };
  const f = useS.getState().focus;
  return f ? { term: f } : null;
}

function insert(t: Target, text: string) {
  if (!t) return;
  if ('term' in t) return typeInto(t.term, text);
  const el = t.el;
  if (!el.isConnected) return;
  const s = el.selectionStart ?? el.value.length;
  const v = el.value.slice(0, s) + text + el.value.slice(el.selectionEnd ?? s);
  // native setter + input event, so React's onChange sees it
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.focus();
  el.setSelectionRange?.(s + text.length, s + text.length);
}

export function VoiceButton() {
  const [st, setSt] = useState<'idle' | 'rec' | 'busy' | 'err'>('idle');
  const [err, setErr] = useState('');
  const cur = useRef<Awaited<ReturnType<typeof record>> | null>(null);
  const dest = useRef<Target>(null);
  const cap = useRef<ReturnType<typeof setTimeout>>(undefined);
  const held = useRef(false); // key/button still down: covers the await on getUserMedia
  const dictation = useS((s) => s.settings.dictation);

  const start = async () => {
    if (held.current) return;
    held.current = true;
    dest.current = target();
    try {
      const r = await record();
      // released while the mic was opening: discard instead of recording forever
      if (!held.current) { await r.stop(); return; }
      cur.current = r; setSt('rec');
      cap.current = setTimeout(stop, MAX_REC_MS);
    } catch (e) { held.current = false; console.error(e); fail('Micro indisponible'); }
  };
  const stop = async () => {
    held.current = false;
    clearTimeout(cap.current);
    const r = cur.current;
    if (!r) return;
    cur.current = null;
    setSt('busy');
    try {
      const audio = await toMono16k(await r.stop());
      // Desktop app: the overlay already holds the model in GPU memory, a second copy would exhaust it.
      const remote = await (window as any).desktop?.transcribe?.(audio) as { text?: string; error?: string; timeout?: boolean } | null | undefined;
      if (remote?.error) throw remote.timeout ? new AsrTimeout(remote.error) : new Error(remote.error);
      const text = remote ? remote.text ?? '' : await transcribe(audio, dictation?.model, dictation?.language);
      if (text) insert(dest.current, text + ' ');
      setSt('idle');
    } catch (e) { console.error(e); fail(e instanceof AsrTimeout ? 'Délai dépassé' : 'Erreur de transcription'); }
  };
  const fail = (m: string) => { setErr(m); setSt('err'); setTimeout(() => setSt((s) => (s === 'err' ? 'idle' : s)), 2500); };

  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.ctrlKey && e.code === 'Space') { e.preventDefault(); e.stopPropagation(); if (!e.repeat) start(); } };
    const up = (e: KeyboardEvent) => { if ((e.code === 'Space' || e.key === 'Control') && held.current) { e.preventDefault(); stop(); } };
    addEventListener('keydown', down, true); addEventListener('keyup', up, true);
    return () => { removeEventListener('keydown', down, true); removeEventListener('keyup', up, true); };
  }, [dictation?.model, dictation?.language]);

  const label = { idle: '🎙', rec: '● REC', busy: '✍', err: '⚠' }[st];
  return (
    <button className={st === 'rec' ? 'btn-p !bg-bad !border-bad' : 'btn'}
      title={st === 'err' ? err : `Maintenir Ctrl+Espace (ou ce bouton) pour dicter ici — Whisper local.${(window as any).desktop ? ' Partout dans Windows : maintenir ' + (dictation?.hotkey ?? 'ctrl+win').replace('win', 'Win').replace('ctrl', 'Ctrl') : ''}`}
      // preventDefault: keep the focus (and caret) in the chat box / terminal the text is meant for
      onMouseDown={(e) => { e.preventDefault(); start(); }} onMouseUp={stop} onMouseLeave={(e) => { if (e.buttons & 1) stop(); }}>{label}</button>
  );
}
