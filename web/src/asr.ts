// Local Whisper (transformers.js). WebGPU when available, WASM otherwise. Model cached by the browser after first download.
let cache: { model: string; p: Promise<any> } | null = null;

export class AsrTimeout extends Error {}
const LOAD_MS = 5 * 60e3; // first download of large-v3 can take a while

function withTimeout<T>(p: Promise<T>, ms: number, what: string) {
  let t: ReturnType<typeof setTimeout>;
  return Promise.race([p, new Promise<never>((_, ko) => { t = setTimeout(() => ko(new AsrTimeout(`${what}: délai dépassé (${Math.round(ms / 1000)} s)`)), ms); })])
    .finally(() => clearTimeout(t));
}

export function loadAsr(model = 'onnx-community/whisper-small') {
  if (cache?.model === model) return cache.p;
  const p = withTimeout((async () => {
    const { pipeline, env } = await import('@huggingface/transformers');
    env.allowLocalModels = false;
    const gpu = 'gpu' in navigator && (await withTimeout((navigator as any).gpu.requestAdapter(), 5000, 'WebGPU').catch(() => null));
    // WebGPU failure (driver, out of GPU memory) falls back to WASM: much slower, bounded by the timeouts below.
    const cpu = () => pipeline('automatic-speech-recognition', model, { dtype: 'q8' });
    // fp16 encoder halves GPU memory (integrated GPUs share it with the whole system).
    const enc = (gpu as any)?.features?.has('shader-f16') ? 'fp16' : 'fp32';
    return gpu
      ? pipeline('automatic-speech-recognition', model, { device: 'webgpu', dtype: { encoder_model: enc, decoder_model_merged: 'q4' } as any }).catch(cpu)
      : cpu();
  })(), LOAD_MS, 'Chargement du modèle');
  cache = { model, p };
  p.catch(() => { if (cache?.p === p) cache = null; });
  return p;
}

export async function toMono16k(blob: Blob) {
  if (!blob.size) return new Float32Array(0); // empty recording: decodeAudioData would throw
  const ctx = new AudioContext({ sampleRate: 16000 });
  try { return (await withTimeout(ctx.decodeAudioData(await blob.arrayBuffer()), 15e3, 'Décodage audio')).getChannelData(0); } finally { ctx.close().catch(() => {}); }
}

// One inference at a time: two concurrent runs on the same WebGPU session (warm-up + real dictation) can hang forever.
let queue: Promise<unknown> = Promise.resolve();

export function transcribe(audio: Float32Array, model?: string, language = 'french'): Promise<string> {
  if (audio.length < 16000 * 0.3) return Promise.resolve(''); // < 300 ms: accidental press
  const run = queue.then(async () => {
    const asr = await loadAsr(model);
    // Whisper runs well under real time; a run far beyond that is stuck, not slow.
    const ms = Math.min(180e3, 30e3 + 3 * (audio.length / 16));
    try {
      // max_new_tokens: a 30 s chunk is ~100 words; caps Whisper's repetition loops on noise
      const out = await withTimeout(asr(audio, { language, task: 'transcribe', chunk_length_s: 30, stride_length_s: 5, max_new_tokens: 200 }), ms, 'Transcription') as any;
      return String(out.text ?? '').trim()
        // Whisper hallucinations on silence
        .replace(/^(\[.*?\]|\(.*?\)|Sous-titrage.*|Merci d'avoir regardé.*|Thanks for watching.*)$/i, '');
    } catch (e) {
      // A stuck session stays stuck: free it (GPU memory) so the next dictation starts clean.
      if (e instanceof AsrTimeout && cache) { cache = null; Promise.resolve(asr.dispose?.()).catch(() => {}); }
      throw e;
    }
  });
  queue = run.catch(() => {});
  return run;
}

/** Record from the mic until stop() is called. */
export async function record() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  try {
    const rec = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    rec.start();
    const ctx = new AudioContext();
    const an = ctx.createAnalyser();
    an.fftSize = 256;
    ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Uint8Array(an.frequencyBinCount);
    return {
      level: () => { an.getByteTimeDomainData(buf); let m = 0; for (const v of buf) m = Math.max(m, Math.abs(v - 128)); return m / 128; },
      stop: () => new Promise<Blob>((ok) => {
        // onerror also resolves: a failed recorder never fires stop() on its own, so the promise would hang.
        let done = false;
        const fin = () => { if (done) return; done = true; stream.getTracks().forEach((t) => t.stop()); ctx.close().catch(() => {}); ok(new Blob(chunks)); };
        if (rec.state === 'inactive') return fin();
        rec.onstop = fin; rec.onerror = fin;
        setTimeout(fin, 3000); // recorder that never fires onstop
        rec.stop();
      }),
    };
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop()); // don't keep the mic open when setup fails
    throw e;
  }
}
