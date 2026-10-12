// Overlay renderer for system-wide dictation (driven by electron/dictation.cjs over IPC).
import { loadAsr, record, toMono16k, transcribe } from './asr';

declare const dict: { on(ev: string, fn: (a?: any) => void): void; result(t: string): void; error(m: string): void };

const pill = document.getElementById('pill')!, txt = document.getElementById('txt')!, bars = document.getElementById('bars')!;
for (let i = 0; i < 7; i++) bars.appendChild(document.createElement('i'));
let cfg = { model: 'onnx-community/whisper-small', language: 'french' };
let cur: Awaited<ReturnType<typeof record>> | null = null, raf = 0, warmed = false;

const ui = (cls: '' | 'busy' | 'err', t: string) => { pill.className = cls; txt.textContent = t; bars.style.display = cls ? 'none' : 'flex'; };

function meter() {
  const l = cur?.level() ?? 0;
  [...bars.children].forEach((b, i) => ((b as HTMLElement).style.height = `${4 + Math.min(18, l * 40 * (0.5 + Math.abs(Math.sin(Date.now() / 120 + i))))}px`));
  raf = requestAnimationFrame(meter);
}

dict.on('config', (c) => {
  cfg = { ...cfg, ...c };
  // Load the model in the background once, so the first dictation is instant.
  // One silent pass also compiles the GPU shaders.
  if (!warmed) { warmed = true; setTimeout(() => loadAsr(cfg.model).then(() => transcribe(new Float32Array(16000), cfg.model, cfg.language)).catch(() => (warmed = false)), 4000); }
});
dict.on('start', async () => {
  ui('', 'Écoute…');
  try { cur = await record(); meter(); } catch (e: any) { ui('err', 'Micro indisponible'); dict.error(String(e)); }
});
dict.on('cancel', async () => { cancelAnimationFrame(raf); await cur?.stop(); cur = null; });
dict.on('stop', async () => {
  cancelAnimationFrame(raf);
  if (!cur) return dict.result('');
  const blob = await cur.stop();
  cur = null;
  try {
    ui('busy', warmed ? 'Transcription…' : 'Chargement du modèle…');
    const text = await transcribe(await toMono16k(blob), cfg.model, cfg.language);
    dict.result(text);
  } catch (e: any) { ui('err', 'Erreur de transcription'); dict.error(String(e)); }
});
