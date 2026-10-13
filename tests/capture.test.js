'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { Transcriber } = require('../src/transcriber');
function captureEnvironment({ failWorklet = false, failMic = false } = {}) {
  const stats = { closed: 0, resumed: 0, stopped: 0 };
  const track = { stop() { stats.stopped++; } };
  const stream = { getTracks: () => [track] };
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
      getUserMedia: async () => { if (failMic) throw new Error('mic denied'); return stream; },
      getDisplayMedia: async () => { throw new Error('loopback unavailable'); },
    } },
  };
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
test('transcriber: disposal rejects outstanding model readiness and transcription', async () => {
  const t = new Transcriber({ modelName: 'test', cacheDir: '' });
  t.worker = { terminate() {}, postMessage() {} };
  const ready = t.ensureReady();
  const text = t.transcribe(new Float32Array(1));
  t.dispose();
  await assert.rejects(ready, /Transcriber stopped/);
  await assert.rejects(text, /Transcriber stopped/);
});
