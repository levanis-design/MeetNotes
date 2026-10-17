'use strict';
// Saved meeting audio. While a meeting records, the app writes compressed audio (WebM/Opus from the
// browser's MediaRecorder) every 30 seconds, one file per recording run and speaker side, so a crash
// loses at most the last half minute. The audio lets a meeting be transcribed again (with another
// speech model, or to recover speech lost in a crash). Imported recordings are referenced in place.
//
// Layout: <base>/audio/<meeting id>/index.json plus the .webm files it lists.
const fs = require('fs');
const path = require('path');
const { writeAtomic, readJson } = require('./fsutil');

const ID_PATTERN = /^m_\d+$/;
const NAME = /^(you|others|mixed)-\d+-[a-z0-9]{4,12}\.webm$/;
const SOURCES = new Set(['you', 'others', 'mixed']);
const MAX_IMPORT_BYTES = 1024 * 1024 * 1024;

function createAudioStore(baseDir) {
  const root = path.join(baseDir, 'audio');

  function dirFor(id) {
    if (!ID_PATTERN.test(String(id))) throw new Error('Invalid meeting id');
    return path.join(root, id);
  }
  function indexFile(id) { return path.join(dirFor(id), 'index.json'); }
  function readIndex(id) {
    try {
      const idx = readJson(indexFile(id));
      return Array.isArray(idx.files) ? idx : { files: [] };
    } catch {
      return { files: [] };
    }
  }
  function writeIndex(id, idx) {
    fs.mkdirSync(dirFor(id), { recursive: true });
    writeAtomic(indexFile(id), JSON.stringify(idx, null, 2));
  }
  function entry(id, name) {
    const e = readIndex(id).files.find((f) => f.name === name);
    if (!e) throw new Error('That audio file is not part of this meeting.');
    return e;
  }

  // Starts a new audio file. t: meeting time in seconds where this audio begins.
  function begin(id, { source, t, mime } = {}) {
    if (!SOURCES.has(source)) throw new Error('Unknown audio source');
    const idx = readIndex(id);
    const name = `${source}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.webm`;
    idx.files.push({ name, source, t: Math.max(0, Number(t) || 0), mime: String(mime || 'audio/webm').slice(0, 60), createdAt: new Date().toISOString() });
    writeIndex(id, idx);
    return name;
  }

  function append(id, name, bytes) {
    if (!NAME.test(String(name))) throw new Error('Invalid audio file name');
    entry(id, name);
    fs.appendFileSync(path.join(dirFor(id), name), Buffer.from(bytes));
    return true;
  }

  // Records an imported file by its location, without copying it.
  function addExternal(id, file, { source = 'mixed', t = 0 } = {}) {
    const st = fs.statSync(file);
    if (!st.isFile()) throw new Error('Choose an audio or video file.');
    if (st.size > MAX_IMPORT_BYTES) throw new Error('This file is larger than 1 GB. Save the audio on its own (for example as MP3) and import that.');
    const idx = readIndex(id);
    idx.files.push({ name: `import-${idx.files.length + 1}`, source, t, external: path.resolve(file), createdAt: new Date().toISOString() });
    writeIndex(id, idx);
  }

  function fileSize(id, e) {
    try { return fs.statSync(e.external || path.join(dirFor(id), e.name)).size; } catch { return 0; }
  }

  // Files with their size in bytes. Missing or empty files are listed with bytes 0.
  function list(id) {
    return readIndex(id).files.map((e) => ({ name: e.name, source: e.source, t: e.t, external: Boolean(e.external), bytes: fileSize(id, e) }));
  }

  function read(id, name) {
    const e = entry(id, name);
    const file = e.external || path.join(dirFor(id), e.name);
    try {
      return fs.readFileSync(file);
    } catch (err) {
      if (e.external) throw new Error(`The imported file is no longer at ${e.external}.`);
      throw err;
    }
  }

  function summary(id) {
    const files = list(id).filter((f) => f.bytes > 0);
    return { files: files.length, bytes: files.filter((f) => !f.external).reduce((n, f) => n + f.bytes, 0), imported: files.some((f) => f.external) };
  }

  function remove(id) {
    fs.rmSync(dirFor(id), { recursive: true, force: true });
  }

  function wipe() {
    fs.rmSync(root, { recursive: true, force: true });
  }

  return { begin, append, addExternal, list, read, summary, remove, wipe };
}

module.exports = { createAudioStore, MAX_IMPORT_BYTES };
