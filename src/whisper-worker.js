'use strict';
// Runs local Whisper speech recognition in a worker thread so the app stays responsive.
const { parentPort, workerData } = require('worker_threads');

let asr = null;

// Model downloads go through the main process, which uses Electron's network stack.
// That stack trusts the Windows certificate store and honors the system proxy,
// so downloads work behind corporate SSL inspection.
const pendingFetch = new Map();
let nextFetchId = 1;
const NULL_BODY = new Set([101, 204, 205, 304]);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Retries network failures (not HTTP errors) so a brief Wi-Fi or VPN drop does not break the download.
async function bridgeFetch(url, opts = {}) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await bridgeFetchOnce(url, opts);
    } catch (err) {
      lastErr = err;
      await sleep(1000 * (attempt + 1));
    }
  }
  throw lastErr;
}

function bridgeFetchOnce(url, opts = {}) {
  const u = String(url && url.url ? url.url : url);
  if (!/^https?:/i.test(u)) return fetch(url, opts);
  const headers = {};
  if (opts.headers) new Headers(opts.headers).forEach((v, k) => { headers[k] = v; });
  const method = (opts.method || 'GET').toUpperCase();
  return new Promise((resolve, reject) => {
    const id = nextFetchId++;
    pendingFetch.set(id, { resolve, reject, method });
    parentPort.postMessage({ type: 'fetch', id, url: u, method, headers });
  });
}

function settleFetch(msg) {
  const p = pendingFetch.get(msg.id);
  if (!p) return;
  pendingFetch.delete(msg.id);
  if (!msg.ok) {
    p.reject(new Error(`Download failed: ${msg.message}`));
    return;
  }
  const body = p.method === 'HEAD' || NULL_BODY.has(msg.status) ? null : msg.body;
  p.resolve(new Response(body, { status: msg.status, statusText: msg.statusText, headers: msg.headers }));
}

function describe(err) {
  if (!err) return 'Unknown error';
  const cause = err.cause ? ` (${err.cause.code || err.cause.message || err.cause})` : '';
  return `${err.message || err}${cause}`;
}

const NOISE_ONLY = /^\s*(thank you( (so|very) much)?( for watching)?[.!]?|thanks for watching[.!]?|you[.!]?|bye[.!]?|okay[.!]?|subtitles? by .*|transcribed by .*|please subscribe.*|[.\s\u2026-]+)\s*$/i;

// Whisper sometimes loops on a word or phrase ("the the the the").
// Collapse any phrase of 1-6 words repeated more than twice in a row.
function collapseRepeats(text) {
  let out = text;
  for (let n = 6; n >= 1; n--) {
    const re = new RegExp(`\\b((?:\\S+\\s+){${n - 1}}\\S+?)([,.]?\\s+\\1\\b){2,}`, 'gi');
    out = out.replace(re, '$1');
  }
  return out;
}

function clean(text) {
  const t = String(text || '')
    .replace(/\[[^\]]*\]|\([^)]*(?:music|noise|silence|applause|laughter|inaudible)[^)]*\)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return collapseRepeats(t);
}

// Boosts quiet audio (soft speakers, low call volume) toward a consistent level.
// Gain is capped so background noise is not blown up.
function normalize(samples) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }
  if (peak === 0 || peak >= 0.5) return samples;
  const gain = Math.min(0.9 / peak, 8);
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] * gain;
  return out;
}

async function init() {
  const { pipeline, env } = await import('@huggingface/transformers');
  env.cacheDir = workerData.cacheDir;
  env.fetch = bridgeFetch;
  const progress_callback = (p) => parentPort.postMessage({ type: 'status', state: 'loading', progress: p });
  // Quantizing Whisper's encoder costs noticeable accuracy, while a quantized decoder is
  // nearly lossless and much faster. Try that mix first, then fall back.
  const attempts = [
    { encoder_model: 'fp32', decoder_model_merged: 'q8' },
    'q8',
    undefined,
  ];
  let lastErr;
  for (const dtype of attempts) {
    try {
      const opts = { progress_callback };
      if (dtype) opts.dtype = dtype;
      asr = await pipeline('automatic-speech-recognition', workerData.modelName, opts);
      break;
    } catch (err) {
      lastErr = err;
      // A download failure will not be fixed by a different weight file.
      if (/Download failed/.test(String(err && err.message))) throw err;
      parentPort.postMessage({ type: 'status', state: 'loading', message: 'Trying alternative model weights' });
    }
  }
  if (!asr) throw lastErr;
  // Warm up once so the first real segment is not slowed by initialization.
  try { await asr(new Float32Array(16000), { chunk_length_s: 30 }); } catch (_) { /* warm-up is optional */ }
  parentPort.postMessage({ type: 'status', state: 'ready' });
}

let initError = null;
const ready = init().catch((err) => {
  initError = err;
  parentPort.postMessage({ type: 'status', state: 'error', message: describe(err) });
});

let queue = Promise.resolve();
parentPort.on('message', (msg) => {
  if (msg.type === 'fetch-result') { settleFetch(msg); return; }
  if (msg.type !== 'transcribe') return;
  // Microphone and loopback segments share one inference session.
  queue = queue.then(async () => {
  try {
    await ready;
    if (initError) throw initError;
    const out = await asr(normalize(msg.samples), { chunk_length_s: 30 });
    let text = clean(out && out.text);
    if (NOISE_ONLY.test(text)) text = '';
    parentPort.postMessage({ type: 'result', id: msg.id, text });
  } catch (err) {
    parentPort.postMessage({ type: 'error', id: msg.id, message: String(err && err.message ? err.message : err) });
  }
  });
});
