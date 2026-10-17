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

// If requests are waiting and the worker reports nothing for this long, it is treated as stuck and restarted.
const STALL_MS = 120000;

class Transcriber {
  constructor({ modelName, cacheDir, onStatus, fetchImpl, stallMs }) {
    this.modelName = modelName;
    this.fetchImpl = fetchImpl || ((url, init) => fetch(url, init));
    this.cacheDir = cacheDir;
    this.onStatus = onStatus || (() => {});
    this.worker = null;
    this.pending = new Map();
    this.nextId = 1;
    this.state = 'idle';
    this.readyWaiters = [];
    this.stallMs = stallMs || STALL_MS;
    this.lastProgress = 0;
    this.watchdog = null;
  }

  progress() {
    this.lastProgress = Date.now();
  }

  // Runs only while requests are outstanding, so an idle app has no timer.
  armWatchdog() {
    if (this.watchdog || !this.pending.size) return;
    this.watchdog = setInterval(() => {
      if (!this.pending.size) return this.disarmWatchdog();
      if (Date.now() - this.lastProgress > this.stallMs) {
        this.fail(new Error('Speech recognition stopped responding and was restarted'));
      }
    }, Math.min(5000, this.stallMs));
  }

  disarmWatchdog() {
    clearInterval(this.watchdog);
    this.watchdog = null;
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

  async proxyFetch(msg) {
    const worker = this.worker;
    try {
      const res = await this.fetchImpl(msg.url, { method: msg.method, headers: msg.headers });
      const headers = {};
      res.headers.forEach((v, k) => {
        // The body arrives already decompressed, so drop encoding headers.
        if (k !== 'content-encoding' && k !== 'content-length') headers[k] = v;
      });
      const body = msg.method === 'HEAD' ? null : await res.arrayBuffer();
      if (worker && this.worker === worker) {
        worker.postMessage(
          { type: 'fetch-result', id: msg.id, ok: true, status: res.status, statusText: res.statusText, headers, body },
          body ? [body] : []
        );
      }
    } catch (err) {
      const cause = err && err.cause ? ` (${err.cause.code || err.cause.message || err.cause})` : '';
      if (worker && this.worker === worker) {
        worker.postMessage({ type: 'fetch-result', id: msg.id, ok: false, message: `${msg.url}: ${err && err.message ? err.message : err}${cause}` });
      }
    }
  }

  handle(msg) {
    this.progress();
    if (msg.type === 'fetch') {
      this.proxyFetch(msg);
      return;
    }
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
      if (!this.pending.size) this.disarmWatchdog();
      if (msg.type === 'result') p.resolve(p.full ? { text: msg.text, offsetSec: msg.offsetSec || 0 } : msg.text);
      else p.reject(new Error(msg.message));
    }
  }

  fail(err) {
    this.disarmWatchdog();
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

  // Resolves with the text. With { full: true } it resolves with { text, offsetSec }, where offsetSec is
  // how far into the segment the speech started (the silence filter trims what comes before it).
  transcribe(samples, { vad = true, full = false } = {}) {
    this.start();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (!this.pending.size) this.progress();
      this.pending.set(id, { resolve, reject, full });
      this.armWatchdog();
      this.worker.postMessage({ type: 'transcribe', id, samples: toFloat32(samples), vad });
    });
  }

  dispose() {
    this.disarmWatchdog();
    this.state = 'disposed';
    if (this.worker) this.worker.terminate();
    this.worker = null;
    this.readyWaiters.splice(0).forEach((w) => w.reject(new Error('Transcriber stopped')));
    for (const p of this.pending.values()) p.reject(new Error('Transcriber stopped'));
    this.pending.clear();
  }
}

module.exports = { Transcriber, toFloat32 };
