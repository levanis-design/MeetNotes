'use strict';
// Crash-safe JSON files. Each write keeps the previous good version as <file>.bak, and reads fall back
// to it when the main file is damaged (for example after a power cut). Windows antivirus and search
// indexing can briefly lock a file, so renames are retried before giving up.
const fs = require('fs');

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RETRIES = 6;

function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withRetry(fn) {
  for (let i = 0; ; i++) {
    try {
      return fn();
    } catch (err) {
      if (!RETRY_CODES.has(err.code) || i >= RETRIES) throw err;
      pause(25 * 2 ** i);
    }
  }
}

function writeAtomic(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, data);
  if (fs.existsSync(file)) {
    try { withRetry(() => fs.copyFileSync(file, file + '.bak')); } catch { /* the new write still goes ahead */ }
  }
  withRetry(() => fs.renameSync(tmp, file));
}

// Returns the parsed file, or its backup if the file is damaged. Throws when neither is readable.
function readJson(file) {
  let firstErr;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    firstErr = err;
  }
  try {
    const data = JSON.parse(fs.readFileSync(file + '.bak', 'utf8'));
    if (firstErr.code !== 'ENOENT') {
      // Keep the damaged file for inspection, then put the good copy back.
      try { fs.copyFileSync(file, file + '.damaged'); } catch { /* ignore */ }
      try { withRetry(() => fs.copyFileSync(file + '.bak', file)); } catch { /* still readable from the backup */ }
    }
    return data;
  } catch {
    throw firstErr;
  }
}

function removeWithBackup(file) {
  for (const f of [file, file + '.bak', file + '.tmp']) withRetry(() => fs.rmSync(f, { force: true }));
}

module.exports = { writeAtomic, readJson, removeWithBackup };
