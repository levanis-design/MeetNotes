'use strict';
const { app } = require('electron');
const path = require('path');
const { Transcriber } = require('../dist/win-unpacked/resources/app.asar/src/transcriber');
app.whenReady().then(async () => {
  const t = new Transcriber({ modelName: 'Xenova/whisper-base.en', cacheDir: path.join(__dirname, '..', '.test-data', 'models') });
  const timeout = setTimeout(() => { console.error('Packaged worker timed out'); t.dispose(); app.exit(1); }, 90000);
  try {
    await t.ensureReady();
    await t.transcribe(new Float32Array(16000));
    console.log('PASS: packaged Whisper worker loads dependencies and runs CPU inference.');
    clearTimeout(timeout); t.dispose(); app.exit(0);
  } catch (err) { console.error(err); clearTimeout(timeout); t.dispose(); app.exit(1); }
});
