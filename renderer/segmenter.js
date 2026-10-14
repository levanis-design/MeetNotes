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
      this.minVoicedSec = opts.minVoicedSec ?? 0.4; // discard segments with less speech than this
      this.preRollSec = opts.preRollSec ?? 0.3; // audio kept before speech starts, so first syllables are not clipped
      this.searchSec = opts.searchSec ?? 2;     // on a forced cut, look this far back for the quietest point
      // Speech threshold adapts to the background noise level of each source.
      // A fixed silenceRms disables adaptation (used by tests and for compatibility).
      this.fixedRms = opts.silenceRms ?? null;
      this.minRms = opts.minRms ?? 0.004;
      this.maxRms = opts.maxRms ?? 0.02;
      this.noise = null;
      this.history = []; // recent silent frames for pre-roll
      this.reset();
    }

    reset() {
      this.frames = [];
      this.levels = [];
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

    threshold() {
      if (this.fixedRms !== null) return this.fixedRms;
      const base = this.noise === null ? this.minRms : this.noise * 3;
      return Math.min(this.maxRms, Math.max(this.minRms, base));
    }

    trackNoise(level, loud) {
      // Start no higher than the minimum, so a meeting that opens mid-sentence is not treated as noise.
      if (this.noise === null) { this.noise = Math.min(level, this.minRms); return; }
      // Follow the floor down quickly and up slowly, so speech does not raise it.
      if (level < this.noise) this.noise = this.noise * 0.8 + level * 0.2;
      else if (!loud) this.noise = this.noise * 0.98 + level * 0.02;
      else this.noise = this.noise * 0.999 + level * 0.001;
    }

    // frame: Float32Array. tNow: meeting time in seconds at the start of this frame.
    // Returns an array of finished segments: { samples: Float32Array, t: number }.
    push(frame, tNow) {
      const out = [];
      const level = Segmenter.rms(frame);
      const loud = level >= this.threshold();
      this.trackNoise(level, loud);
      const sr = this.sampleRate;

      if (this.length === 0) {
        if (!loud) {
          // Keep a short history so the segment can start just before the speech.
          this.history.push({ frame, t: tNow, level });
          let kept = this.history.reduce((n, h) => n + h.frame.length, 0);
          while (this.history.length && kept - this.history[0].frame.length >= this.preRollSec * sr) {
            kept -= this.history.shift().frame.length;
          }
          return out;
        }
        if (this.history.length) {
          this.startT = this.history[0].t;
          for (const h of this.history) {
            this.frames.push(h.frame);
            this.levels.push(h.level);
            this.length += h.frame.length;
          }
          this.history = [];
        } else {
          this.startT = tNow;
        }
      }
      this.frames.push(frame);
      this.levels.push(level);
      this.length += frame.length;
      if (loud) {
        this.voiced += frame.length;
        this.silentRun = 0;
      } else {
        this.silentRun += frame.length;
      }
      const naturalEnd = this.length >= this.minSec * sr && this.silentRun >= this.silenceSec * sr;
      const forcedEnd = this.length >= this.maxSec * sr;
      if (naturalEnd) {
        const seg = this.flush();
        if (seg) out.push(seg);
      } else if (forcedEnd) {
        const seg = this.cutAtQuietest(tNow + frame.length / sr);
        if (seg) out.push(seg);
      }
      return out;
    }

    // Splits at the quietest frame in the last few seconds instead of mid-word,
    // and carries the rest over into the next segment.
    cutAtQuietest(tEnd) {
      const sr = this.sampleRate;
      let back = 0;
      let best = this.frames.length - 1;
      for (let i = this.frames.length - 1; i > 0 && back < this.searchSec * sr; i--) {
        if (this.levels[i] < this.levels[best]) best = i;
        back += this.frames[i].length;
      }
      const restFrames = this.frames.slice(best + 1);
      const restLevels = this.levels.slice(best + 1);
      this.frames = this.frames.slice(0, best + 1);
      this.levels = this.levels.slice(0, best + 1);
      this.length = this.frames.reduce((n, f) => n + f.length, 0);
      const seg = this.flush();
      if (restFrames.length) {
        const restLen = restFrames.reduce((n, f) => n + f.length, 0);
        this.frames = restFrames;
        this.levels = restLevels;
        this.length = restLen;
        this.startT = tEnd - restLen / sr;
        const thr = this.threshold();
        this.voiced = restFrames.reduce((n, f, i) => n + (restLevels[i] >= thr ? f.length : 0), 0);
      }
      return seg;
    }

    flush() {
      this.history = [];
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
