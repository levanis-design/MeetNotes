'use strict';
// Runs local Whisper speech recognition in a worker thread so the app stays responsive.
const { parentPort, workerData } = require('worker_threads');

let asr = null;

const NOISE_ONLY = /^\s*(thank you\.?|thanks for watching\.?|you\.?|bye\.?|\.+)\s*$/i;

function clean(text) {
  return String(text || '')
    .replace(/\[(?:BLANK_AUDIO|MUSIC|NOISE|SILENCE|Music|Silence)\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function init() {
  const { pipeline, env } = await import('@huggingface/transformers');
  env.cacheDir = workerData.cacheDir;
  const progress_callback = (p) => parentPort.postMessage({ type: 'status', state: 'loading', progress: p });
  try {
    // Quantized weights are smaller and faster on CPU.
    asr = await pipeline('automatic-speech-recognition', workerData.modelName, { dtype: 'q8', progress_callback });
  } catch (err) {
    // Fall back to the model's default weights if no quantized variant exists.
    parentPort.postMessage({ type: 'status', state: 'loading', message: 'Quantized model not available, using default weights' });
    asr = await pipeline('automatic-speech-recognition', workerData.modelName, { progress_callback });
  }
  parentPort.postMessage({ type: 'status', state: 'ready' });
}

let initError = null;
const ready = init().catch((err) => {
  initError = err;
  parentPort.postMessage({ type: 'status', state: 'error', message: String(err && err.message ? err.message : err) });
});

let queue = Promise.resolve();
parentPort.on('message', (msg) => {
  if (msg.type !== 'transcribe') return;
  // Microphone and loopback segments share one inference session.
  queue = queue.then(async () => {
  try {
    await ready;
    if (initError) throw initError;
    const out = await asr(msg.samples, { chunk_length_s: 30 });
    let text = clean(out && out.text);
    if (NOISE_ONLY.test(text)) text = '';
    parentPort.postMessage({ type: 'result', id: msg.id, text });
  } catch (err) {
    parentPort.postMessage({ type: 'error', id: msg.id, message: String(err && err.message ? err.message : err) });
  }
  });
});
