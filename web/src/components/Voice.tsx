// In-app hold-to-talk (Ctrl+Space / 🎙 button). System-wide dictation lives in the desktop shell (Ctrl+Win anywhere).
import { useEffect, useRef, useState } from 'react';
import { useS } from '../store';
import { typeInto } from './Terminal';
import { record, toMono16k, transcribe } from '../asr';

/** Insert text where the user is: focused textarea/input, else the focused terminal pane. */
function insert(text: string) {
  const el = document.activeElement as HTMLTextAreaElement | HTMLInputElement | null;
  if (el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && el.type === 'text')) && !el.closest('.xterm')) {
    const s = el.selectionStart ?? el.value.length;
    const v = el.value.slice(0, s) + text + el.value.slice(el.selectionEnd ?? s);
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }
  const f = useS.getState().focus;
  if (f) typeInto(f, text);
}

export function VoiceButton() {
  const [st, setSt] = useState<'idle' | 'rec' | 'busy'>('idle');
  const cur = useRef<Awaited<ReturnType<typeof record>> | null>(null);
  const held = useRef(false); // key/button still down: covers the await on getUserMedia
  const dictation = useS((s) => s.settings.dictation);

  const start = async () => {
    if (held.current) return;
    held.current = true;
    try {
      const r = await record();
      // released while the mic was opening: discard instead of recording forever
      if (!held.current) { await r.stop(); return; }
      cur.current = r; setSt('rec');
    } catch (e) { held.current = false; console.error(e); }
  };
  const stop = async () => {
    held.current = false;
    const r = cur.current;
    if (!r) return;
    cur.current = null;
    setSt('busy');
    try {
      const text = await transcribe(await toMono16k(await r.stop()), dictation?.model, dictation?.language);
      if (text) insert(text + ' ');
    } catch (e) { console.error(e); }
    setSt('idle');
  };

  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.ctrlKey && e.code === 'Space') { e.preventDefault(); e.stopPropagation(); if (!e.repeat) start(); } };
    const up = (e: KeyboardEvent) => { if ((e.code === 'Space' || e.key === 'Control') && held.current) { e.preventDefault(); stop(); } };
    addEventListener('keydown', down, true); addEventListener('keyup', up, true);
    return () => { removeEventListener('keydown', down, true); removeEventListener('keyup', up, true); };
  }, [dictation?.model, dictation?.language]);

  const label = { idle: '🎙', rec: '● REC', busy: '✍' }[st];
  return (
    <button className={st === 'rec' ? 'btn-p !bg-bad !border-bad' : 'btn'}
      title={`Maintenir Ctrl+Espace (ou ce bouton) pour dicter ici — Whisper local.${(window as any).desktop ? ' Partout dans Windows : maintenir ' + (dictation?.hotkey ?? 'ctrl+win').replace('win', 'Win').replace('ctrl', 'Ctrl') : ''}`}
      onMouseDown={start} onMouseUp={stop} onMouseLeave={(e) => { if (e.buttons & 1) stop(); }}>{label}</button>
  );
}
