'use strict';
// Cuts a continuous 16 kHz audio stream into speech segments at natural pauses.
// Works in the browser (global Segmenter) and in Node (module.exports) so it can be tested.
(function (root) {
  class Segmenter {
    constructor(opts = {}) {
      this.sampleRate = opts.sampleRate || 16000;
      this.minSec = opts.minSec ?? 6;          // do not cut before this much audio, unless forced
      this.maxSec = opts.maxSec ?? 25;         // always cut at this length
      this.silenceSec = opts.silenceSec ?? 0.7; // pause length that ends a segment
      this.silenceRms = opts.silenceRms ?? 0.01;
      this.minVoicedSec = opts.minVoicedSec ?? 0.4; // discard segments with less speech than this
      this.reset();
    }

    reset() {
      this.frames = [];
      this.length = 0;
      this.silentRun = 0;
      this.voiced = 0;
      this.startT = 0;
    }

    static rms(frame) {
      let sum = 0;
      for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
      return Math.sqrt(sum / (frame.length || 1));
    }

    // frame: Float32Array. tNow: meeting time in seconds at the start of this frame.
    // Returns an array of finished segments: { samples: Float32Array, t: number }.
    push(frame, tNow) {
      const out = [];
      const loud = Segmenter.rms(frame) >= this.silenceRms;
      if (this.length === 0) {
        if (!loud) return out; // skip leading silence
        this.startT = tNow;
      }
      this.frames.push(frame);
      this.length += frame.length;
      if (loud) {
        this.voiced += frame.length;
        this.silentRun = 0;
      } else {
        this.silentRun += frame.length;
      }
      const sr = this.sampleRate;
      const naturalEnd = this.length >= this.minSec * sr && this.silentRun >= this.silenceSec * sr;
      const forcedEnd = this.length >= this.maxSec * sr;
      if (naturalEnd || forcedEnd) {
        const seg = this.flush();
        if (seg) out.push(seg);
      }
      return out;
    }

    flush() {
      if (this.length === 0) return null;
      const keep = this.voiced >= this.minVoicedSec * this.sampleRate;
      const samples = new Float32Array(this.length);
      let o = 0;
      for (const f of this.frames) {
        samples.set(f, o);
        o += f.length;
      }
      const t = this.startT;
      this.reset();
      return keep ? { samples, t } : null;
    }
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { Segmenter };
  else root.Segmenter = Segmenter;
})(typeof self !== 'undefined' ? self : globalThis);
