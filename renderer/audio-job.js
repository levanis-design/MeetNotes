'use strict';
// Turns saved or imported audio into speech segments for transcribing again.
// Works in the browser (global MNAudio) and in Node (module.exports) so the pure parts can be tested.
(function (root) {
  const RATE = 16000;
  const FRAME = 1600; // 100 ms, the same block size the live capture uses

  function toMono(buffer) {
    const n = buffer.numberOfChannels;
    if (n === 1) return buffer.getChannelData(0);
    const out = new Float32Array(buffer.length);
    for (let c = 0; c < n; c++) {
      const ch = buffer.getChannelData(c);
      for (let i = 0; i < ch.length; i++) out[i] += ch[i] / n;
    }
    return out;
  }

  // Decodes any format Chromium can play (WebM, MP3, WAV, M4A, MP4 and others) to 16 kHz mono.
  async function decode(bytes) {
    const ctx = new OfflineAudioContext(1, 1, RATE);
    let buffer;
    try {
      buffer = await ctx.decodeAudioData(bytes);
    } catch (_) {
      throw new Error('This audio could not be read. Try converting it to MP3 or WAV first.');
    }
    return toMono(buffer);
  }

  // Cuts samples into segments with the same Segmenter the live capture uses.
  // t: meeting time in seconds where the samples begin.
  function segments(samples, t, SegmenterClass) {
    const Seg = SegmenterClass || root.Segmenter;
    const seg = new Seg();
    const out = [];
    for (let i = 0; i < samples.length; i += FRAME) {
      const frame = samples.slice(i, Math.min(i + FRAME, samples.length));
      for (const s of seg.push(frame, t + i / RATE)) out.push(s);
    }
    const last = seg.flush();
    if (last) out.push(last);
    return out;
  }

  // True when the transcript already has a line of this speaker inside the segment's time span.
  // Used to recover only the speech that was lost (for example in a crash) without duplicating lines.
  function covered(lines, source, seg) {
    const start = seg.t - 1;
    const end = seg.t + seg.samples.length / RATE + 1;
    return lines.some((x) => x.source === source && x.t >= start && x.t <= end);
  }

  const api = { RATE, toMono, decode, segments, covered };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MNAudio = api;
})(typeof self !== 'undefined' ? self : globalThis);
