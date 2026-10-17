'use strict';
// Voice activity detection with the Silero VAD model, so only speech reaches Whisper.
// Whisper tends to invent text ("Thank you for watching") when it is given silence or steady noise.
// The model runs in the speech worker; the decisions below are plain functions so they can be tested.

const SAMPLE_RATE = 16000;
const WINDOW = 512;   // Silero processes 32 ms windows at 16 kHz
const CONTEXT = 64;   // and expects the last 64 samples of the previous window in front of each one

const DEFAULTS = {
  threshold: 0.5,      // speech probability that counts as speech
  minSpeechMs: 250,    // a segment with less speech than this is dropped
  padMs: 300,          // audio kept around each stretch of speech, so word edges are not clipped
  mergeGapMs: 1000,    // stretches closer than this are joined
};

// probs: speech probability for each WINDOW-sized step. Returns sample ranges [start, end) to keep,
// or an empty array when the segment has too little speech to be worth transcribing.
function speechRegions(probs, length, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const toSamples = (ms) => Math.round((ms / 1000) * SAMPLE_RATE);
  let voiced = 0;
  const raw = [];
  let start = -1;
  probs.forEach((p, i) => {
    if (p >= o.threshold) {
      voiced += WINDOW;
      if (start < 0) start = i * WINDOW;
    } else if (start >= 0) {
      raw.push([start, i * WINDOW]);
      start = -1;
    }
  });
  if (start >= 0) raw.push([start, probs.length * WINDOW]);
  if (voiced < toSamples(o.minSpeechMs)) return [];

  const pad = toSamples(o.padMs);
  const gap = toSamples(o.mergeGapMs);
  const out = [];
  for (const [s, e] of raw) {
    const a = Math.max(0, s - pad);
    const b = Math.min(length, e + pad);
    const last = out[out.length - 1];
    if (last && a - last[1] <= gap) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

// Joins the kept ranges into one buffer. offsetSec is where the first kept sample sits in the original,
// so the transcript line can carry the time the speech actually started.
function keepRegions(samples, regions) {
  if (!regions.length) return null;
  const total = regions.reduce((n, [a, b]) => n + (b - a), 0);
  const out = new Float32Array(total);
  let o = 0;
  for (const [a, b] of regions) {
    out.set(samples.subarray(a, b), o);
    o += b - a;
  }
  return { samples: out, offsetSec: regions[0][0] / SAMPLE_RATE };
}

// Wraps a loaded Silero model. run(input, state) returns { prob, state } for one window.
// Kept separate from the model loading so tests can pass a fake model.
function createDetector(run) {
  return async function detect(samples) {
    let state = null;
    let context = new Float32Array(CONTEXT);
    const probs = [];
    for (let i = 0; i < samples.length; i += WINDOW) {
      const win = new Float32Array(CONTEXT + WINDOW);
      win.set(context, 0);
      win.set(samples.subarray(i, Math.min(i + WINDOW, samples.length)), CONTEXT);
      const r = await run(win, state);
      state = r.state;
      probs.push(r.prob);
      context = win.slice(WINDOW);
    }
    return probs;
  };
}

// Returns { samples, offsetSec } with only the speech, or null when there is no speech.
async function filterSpeech(detect, samples, opts) {
  const probs = await detect(samples);
  return keepRegions(samples, speechRegions(probs, samples.length, opts));
}

// Loads Silero through transformers.js, which downloads and caches it like the Whisper model.
async function loadSilero(transformers) {
  const { AutoModel, Tensor } = transformers;
  const model = await AutoModel.from_pretrained('onnx-community/silero-vad', {
    config: { model_type: 'custom' },
    dtype: 'fp32',
  });
  const sr = new Tensor('int64', [SAMPLE_RATE], []);
  const fresh = () => new Tensor('float32', new Float32Array(2 * 128), [2, 1, 128]);
  return createDetector(async (win, state) => {
    const out = await model({ input: new Tensor('float32', win, [1, win.length]), sr, state: state || fresh() });
    return { prob: out.output.data[0], state: out.stateN };
  });
}

module.exports = { SAMPLE_RATE, WINDOW, DEFAULTS, speechRegions, keepRegions, createDetector, filterSpeech, loadSilero };
