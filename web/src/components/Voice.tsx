// Hold-to-talk, fully local: Whisper runs in the window (transformers.js, WebGPU→WASM fallback).
// Model is downloaded once from Hugging Face then cached by the browser. No audio leaves the machine.
import { useEffect, useRef, useState } from 'react';
import { useS } from '../store';
import { typeInto } from './Terminal';

let asr: Promise<any> | null = null;
const loadAsr = () => (asr ??= (async () => {
  const { pipeline } = await import('@huggingface/transformers');
  const gpu = 'gpu' in navigator;
  return pipeline('automatic-speech-recognition', 'onnx-community/whisper-base', gpu ? { device: 'webgpu', dtype: 'fp32' } : { dtype: 'q8' });
})());

async function toMono16k(blob: Blob) {
  const ctx = new AudioContext({ sampleRate: 16000 });
  const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
  ctx.close();
  return buf.getChannelData(0);
}

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
  const [st, setSt] = useState<'idle' | 'rec' | 'busy' | 'loading'>('idle');
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);

  const start = async () => {
    if (rec.current) return;
    loadAsr(); // warm the model while the user talks
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const r = new MediaRecorder(stream);
    chunks.current = [];
    r.ondataavailable = (e) => chunks.current.push(e.data);
    r.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      rec.current = null;
      setSt('loading');
      try {
        const audio = await toMono16k(new Blob(chunks.current));
        const model = await loadAsr();
        setSt('busy');
        const out = await model(audio, { language: localStorage.getItem('bm.lang') ?? 'french', task: 'transcribe', chunk_length_s: 30 });
        const text = String(out.text ?? '').trim();
        if (text) insert(text);
      } catch (e) { console.error(e); }
      setSt('idle');
    };
    r.start();
    rec.current = r;
    setSt('rec');
  };
  const stop = () => rec.current?.state === 'recording' && rec.current.stop();

  // Hold Ctrl+Space anywhere (also inside terminals).
  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.ctrlKey && e.code === 'Space') { e.preventDefault(); e.stopPropagation(); if (!e.repeat) start(); } };
    const up = (e: KeyboardEvent) => { if (e.code === 'Space' || e.key === 'Control') { if (rec.current) { e.preventDefault(); stop(); } } };
    addEventListener('keydown', down, true); addEventListener('keyup', up, true);
    return () => { removeEventListener('keydown', down, true); removeEventListener('keyup', up, true); };
  }, []);

  const label = { idle: '🎙', rec: '● REC', loading: '…', busy: '✍' }[st];
  return (
    <button className={st === 'rec' ? 'btn-p !bg-bad !border-bad' : 'btn'} title="Maintenir Ctrl+Espace (ou ce bouton) pour dicter — Whisper local"
      onMouseDown={start} onMouseUp={stop} onMouseLeave={stop}>{label}</button>
  );
}
