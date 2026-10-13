'use strict';
// Manages the Whisper worker thread and queues transcription requests.
const path = require('path');
const { Worker } = require('worker_threads');

function toFloat32(input) {
  if (input instanceof Float32Array) return input;
  if (input instanceof ArrayBuffer) return new Float32Array(input);
  if (ArrayBuffer.isView(input)) {
    const copy = input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
    return new Float32Array(copy);
  }
  throw new Error('Unsupported audio data');
}

class Transcriber {
  constructor({ modelName, cacheDir, onStatus }) {
    this.modelName = modelName;
    this.cacheDir = cacheDir;
    this.onStatus = onStatus || (() => {});
    this.worker = null;
    this.pending = new Map();
    this.nextId = 1;
    this.state = 'idle';
    this.readyWaiters = [];
  }

  start() {
    if (this.worker) return;
    this.state = 'loading';
    let file = path.join(__dirname, 'whisper-worker.js');
    // Workers cannot run from inside an asar archive; the packaged build unpacks this file.
    file = file.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
    this.worker = new Worker(file, { workerData: { modelName: this.modelName, cacheDir: this.cacheDir } });
    this.worker.on('message', (msg) => this.handle(msg));
    this.worker.on('error', (err) => this.fail(err));
    const worker = this.worker;
    this.worker.on('exit', (code) => {
      if (this.worker === worker && this.state !== 'disposed') this.fail(new Error(`Speech worker stopped (code ${code})`));
    });
  }

  handle(msg) {
    if (msg.type === 'status') {
      if (msg.state === 'ready') {
        this.state = 'ready';
        this.readyWaiters.splice(0).forEach((w) => w.resolve());
      } else if (msg.state === 'error') {
        this.fail(new Error(msg.message));
        return;
      }
      this.onStatus(msg);
    } else if (msg.type === 'result' || msg.type === 'error') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.type === 'result') p.resolve(msg.text);
      else p.reject(new Error(msg.message));
    }
  }

  fail(err) {
    const worker = this.worker;
    this.worker = null;
    if (worker) worker.terminate();
    this.state = 'error';
    this.onStatus({ type: 'status', state: 'error', message: err.message });
    this.readyWaiters.splice(0).forEach((w) => w.reject(err));
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    this.worker = null;
  }

  ensureReady() {
    this.start();
    if (this.state === 'ready') return Promise.resolve();
    return new Promise((resolve, reject) => this.readyWaiters.push({ resolve, reject }));
  }

  transcribe(samples) {
    this.start();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'transcribe', id, samples: toFloat32(samples) });
    });
  }

  dispose() {
    this.state = 'disposed';
    if (this.worker) this.worker.terminate();
    this.worker = null;
    this.readyWaiters.splice(0).forEach((w) => w.reject(new Error('Transcriber stopped')));
    for (const p of this.pending.values()) p.reject(new Error('Transcriber stopped'));
    this.pending.clear();
  }
}

module.exports = { Transcriber, toFloat32 };
