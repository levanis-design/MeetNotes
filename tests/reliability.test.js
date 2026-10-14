'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { writeAtomic, readJson } = require('../src/fsutil');
const { createStore } = require('../src/store');
const { createTaskStore } = require('../src/tasks');
const { Transcriber } = require('../src/transcriber');

const identity = { encrypt: (s) => 'enc:' + s, decrypt: (s) => s.replace(/^enc:/, '') };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'meetnotes-rel-'));

test('fsutil: a damaged file is recovered from the previous version', () => {
  const file = path.join(tmp(), 'x.json');
  writeAtomic(file, JSON.stringify({ v: 1 }));
  writeAtomic(file, JSON.stringify({ v: 2 }));
  fs.writeFileSync(file, '{"v": 3, trunc');
  assert.deepEqual(readJson(file), { v: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { v: 1 }, 'good copy is restored');
  assert.ok(fs.existsSync(file + '.damaged'), 'damaged copy is kept');
});

test('fsutil: an unreadable file with no backup still throws', () => {
  const file = path.join(tmp(), 'y.json');
  fs.writeFileSync(file, 'not json');
  assert.throws(() => readJson(file), SyntaxError);
  assert.throws(() => readJson(path.join(tmp(), 'missing.json')), /ENOENT/);
});

test('store: a damaged meeting file still opens and still lists', () => {
  const dir = tmp();
  const s = createStore(dir, identity);
  const m = s.create({ title: 'Budget' });
  s.appendTranscript(m.id, { t: 1, source: 'you', text: 'kept line' });
  s.appendTranscript(m.id, { t: 2, source: 'others', text: 'last line' });
  fs.writeFileSync(path.join(dir, 'meetings', m.id + '.json'), '');
  assert.deepEqual(s.get(m.id).transcript.map((x) => x.text), ['kept line']);
  assert.equal(s.list().length, 1);
  s.remove(m.id);
  assert.equal(fs.existsSync(path.join(dir, 'meetings', m.id + '.json.damaged')), false, 'deletion removes the damaged copy too');
  assert.equal(s.list().length, 0);
  assert.throws(() => s.get(m.id), /ENOENT/, 'a deleted meeting does not come back from its backup');
});

test('store: a damaged settings file does not lose the API key', () => {
  const dir = tmp();
  const s = createStore(dir, identity);
  s.setSettings({ apiKey: 'sk-keep' });
  s.setSettings({ myName: 'Levani' });
  fs.writeFileSync(path.join(dir, 'settings.json'), '{');
  assert.equal(s.getApiKey(), 'sk-keep');
  s.setSettings({ autoTasks: false });
  assert.equal(s.getApiKey(), 'sk-keep');
});

test('tasks: a damaged task file is recovered', () => {
  const dir = tmp();
  const t = createTaskStore(dir);
  t.add({ title: 'Send budget' });
  t.add({ title: 'Book room' });
  fs.writeFileSync(path.join(dir, 'tasks.json'), '[{"broken"');
  t.add({ title: 'Call vendor' });
  const titles = t.list().map((x) => x.title);
  assert.ok(titles.includes('Send budget'));
  assert.ok(titles.includes('Call vendor'));
});

test('tasks: changing or clearing an uncertain due date replaces its old label', () => {
  const t = createTaskStore(tmp());
  const task = t.add({ title: 'Send budget', due: 'Next Friday' });
  assert.equal(t.update(task.id, { due: 'After review' }).dueText, 'After review');
  const cleared = t.update(task.id, { due: '' });
  assert.equal(cleared.due, null);
  assert.equal(cleared.dueText, '');
});

function fakeTranscriber(stallMs) {
  const t = new Transcriber({ modelName: 'test', cacheDir: '', stallMs });
  const posted = [];
  let terminated = 0;
  t.worker = { postMessage: (m) => posted.push(m), terminate: () => { terminated++; } };
  return { t, posted, terminated: () => terminated };
}

test('transcriber: a stuck worker is stopped and its requests fail', async () => {
  const { t, terminated } = fakeTranscriber(60);
  const statuses = [];
  t.onStatus = (s) => statuses.push(s);
  await assert.rejects(t.transcribe(new Float32Array(1)), /stopped responding/);
  assert.equal(terminated(), 1);
  assert.equal(t.state, 'error');
  assert.equal(t.watchdog, null);
  assert.ok(statuses.some((s) => s.state === 'error'));
});

test('transcriber: steady results keep a slow worker alive', async () => {
  const { t, posted } = fakeTranscriber(80);
  const a = t.transcribe(new Float32Array(1));
  const b = t.transcribe(new Float32Array(1));
  await new Promise((r) => setTimeout(r, 50));
  t.handle({ type: 'result', id: posted[0].id, text: 'one' });
  await new Promise((r) => setTimeout(r, 50));
  t.handle({ type: 'result', id: posted[1].id, text: 'two' });
  assert.equal(await a, 'one');
  assert.equal(await b, 'two');
  assert.equal(t.watchdog, null, 'no timer once the queue is empty');
  t.dispose();
});
