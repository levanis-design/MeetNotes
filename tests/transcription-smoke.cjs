'use strict';
// Downloads the configured model and runs CPU inference on synthetic silence.
const path = require('path');
const { Transcriber } = require('../src/transcriber');
const t = new Transcriber({
  modelName: 'Xenova/whisper-base.en',
  cacheDir: path.join(__dirname, '..', '.test-data', 'models'),
  onStatus: (s) => { if (s.state !== 'loading' || !s.progress) console.log(s.state, s.message || ''); },
});
const timeout = setTimeout(() => { console.error('Model inference timed out'); t.dispose(); process.exitCode = 1; }, 240000);
(async () => {
  try {
    await t.ensureReady();
    const text = await t.transcribe(new Float32Array(16000));
    if (typeof text !== 'string') throw new Error('Expected recognized text');
    console.log('PASS: real Whisper model download and CPU inference. Silence output:', JSON.stringify(text));
  } catch (err) { console.error(err); process.exitCode = 1; }
  finally { clearTimeout(timeout); t.dispose(); }
})();
