// Local Whisper (transformers.js). WebGPU when available, WASM otherwise. Model cached by the browser after first download.
let cache: { model: string; p: Promise<any> } | null = null;

export function loadAsr(model = 'onnx-community/whisper-small') {
  if (cache?.model === model) return cache.p;
  const p = (async () => {
    const { pipeline, env } = await import('@huggingface/transformers');
    env.allowLocalModels = false;
    const gpu = 'gpu' in navigator && (await (navigator as any).gpu.requestAdapter().catch(() => null));
    return gpu
      ? pipeline('automatic-speech-recognition', model, { device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' } as any })
      : pipeline('automatic-speech-recognition', model, { dtype: 'q8' });
  })();
  cache = { model, p };
  p.catch(() => { if (cache?.p === p) cache = null; });
  return p;
}

export async function toMono16k(blob: Blob) {
  const ctx = new AudioContext({ sampleRate: 16000 });
  try { return (await ctx.decodeAudioData(await blob.arrayBuffer())).getChannelData(0); } finally { ctx.close(); }
}

export async function transcribe(audio: Float32Array, model?: string, language = 'french') {
  if (audio.length < 16000 * 0.3) return ''; // < 300 ms: accidental press
  const asr = await loadAsr(model);
  const out = await asr(audio, { language, task: 'transcribe', chunk_length_s: 30, stride_length_s: 5 });
  return String(out.text ?? '').trim()
    // Whisper hallucinations on silence
    .replace(/^(\[.*?\]|\(.*?\)|Sous-titrage.*|Merci d'avoir regardé.*|Thanks for watching.*)$/i, '');
}

/** Record from the mic until stop() is called. */
export async function record() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
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
      rec.onstop = () => { stream.getTracks().forEach((t) => t.stop()); ctx.close(); ok(new Blob(chunks)); };
      rec.stop();
    }),
  };
}
