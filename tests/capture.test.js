'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { Transcriber } = require('../src/transcriber');
function captureEnvironment({ failWorklet = false, failMic = false } = {}) {
  const stats = { closed: 0, resumed: 0, stopped: 0, micRequests: 0, tracks: [] };
  const makeStream = () => {
    const track = { stop() { stats.stopped++; }, onended: null };
    stats.tracks.push(track);
    return { getTracks: () => [track], getAudioTracks: () => [track] };
  };
  const node = () => ({ connect() {}, disconnect() {}, gain: {}, port: {} });
  class AudioContext {
    constructor() {
      this.state = 'running';
      this.audioWorklet = { addModule: async () => { if (failWorklet) throw new Error('worklet failed'); } };
    }
    async resume() { stats.resumed++; }
    async close() { stats.closed++; this.state = 'closed'; }
    createMediaStreamSource() { return node(); }
    createGain() { return node(); }
  }
  const context = { window: {}, AudioContext, AudioWorkletNode: function () { return node(); },
    Segmenter: class { flush() { return null; } },
    navigator: { mediaDevices: {
      getUserMedia: async () => { stats.micRequests++; if (failMic) throw new Error('mic denied'); return makeStream(); },
      getDisplayMedia: async () => { throw new Error('loopback unavailable'); },
    } },
  };
  context.setTimeout = (fn) => setTimeout(fn, 0);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/capture.js'), 'utf8'), context);
  return { stats, start: context.window.startCapture };
}
test('capture: failed worklet or denied microphone closes audio context', async () => {
  for (const options of [{ failWorklet: true }, { failMic: true }]) {
    const { start, stats } = captureEnvironment(options);
    await assert.rejects(start({ getElapsed() {}, onSegment() {}, onWarning() {} }));
    assert.equal(stats.closed, 1);
  }
});
test('capture: unavailable loopback warns, microphone stops and context closes', async () => {
  const { start, stats } = captureEnvironment();
  const warnings = [];
  const capture = await start({ getElapsed() {}, onSegment() {}, onWarning: message => warnings.push(message) });
  assert.equal(capture.systemOk, false);
  assert.equal(warnings.length, 1);
  assert.equal(stats.resumed, 1);
  await capture.stop();
  assert.equal(stats.stopped, 1);
  assert.equal(stats.closed, 1);
});
test('capture: an unplugged microphone is reconnected to the current default device', async () => {
  const { start, stats } = captureEnvironment();
  const warnings = [];
  const capture = await start({ getElapsed() { return 0; }, onSegment() {}, onWarning: message => warnings.push(message) });
  assert.equal(stats.micRequests, 1);
  stats.tracks[0].onended();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(stats.micRequests, 2, 'microphone requested again');
  assert.match(warnings[warnings.length - 1], /Microphone changed/);
  await capture.stop();
  assert.equal(stats.stopped, 2, 'both microphone streams are released on stop');
});
test('transcriber: disposal rejects outstanding model readiness and transcription', async () => {
  const t = new Transcriber({ modelName: 'test', cacheDir: '' });
  t.worker = { terminate() {}, postMessage() {} };
  const ready = t.ensureReady();
  const text = t.transcribe(new Float32Array(1));
  t.dispose();
  await assert.rejects(ready, /Transcriber stopped/);
  await assert.rejects(text, /Transcriber stopped/);
});

test('saved audio: failed initialization warns; a failed chunk stops subsequent writes', async () => {
  for (const failBegin of [true, false]) {
    let recorder;
    class MediaRecorder {
      static isTypeSupported() { return true; }
      constructor() { recorder = this; this.state = 'inactive'; }
      start() { this.state = 'recording'; }
      stop() { this.state = 'inactive'; this.onstop(); }
    }
    const context = { window: {}, MediaRecorder, MediaStream: class {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/capture.js'), 'utf8'), context);
    const warnings = [];
    let appends = 0;
    const saved = context.createRecorder({ getAudioTracks: () => [] }, 'you', 0, {
      async begin() { if (failBegin) throw new Error('disk full'); return 'file.webm'; },
      async append() { appends++; throw new Error('disk full'); },
    }, (message) => warnings.push(message));
    for (let i = 0; i < 2; i++) recorder.ondataavailable({ data: { size: 1, async arrayBuffer() { return new ArrayBuffer(1); } } });
    await saved.stop();
    assert.equal(warnings.length, 1);
    assert.equal(appends, failBegin ? 0 : 1);
  }
});
