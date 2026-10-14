'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createStore } = require('../src/store');
const ai = require('../src/ai');
const render = require('../src/render');
const { toFloat32 } = require('../src/transcriber');
const { Segmenter } = require('../renderer/segmenter');

const identity = { encrypt: (s) => 'enc:' + s, decrypt: (s) => s.replace(/^enc:/, '') };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'meetnotes-'));

test('store: create, update, transcript order, notes, summary, remove', () => {
  const s = createStore(tmp(), identity);
  const m = s.create({ title: ' Weekly review ', attendees: 'A, B', agendaPre: 'Budget\nSchedule' });
  assert.strictEqual(m.title, 'Weekly review');
  s.appendTranscript(m.id, { t: 30, source: 'others', text: 'second' });
  s.appendTranscript(m.id, { t: 5, source: 'you', text: 'first' });
  assert.deepStrictEqual(s.get(m.id).transcript.map((x) => x.text), ['first', 'second']);
  assert.strictEqual(s.addNote(m.id, { t: 12, text: '  note  ' }).text, 'note');
  assert.strictEqual(s.addNote(m.id, { text: '   ' }), null);
  s.update(m.id, { status: 'ended', elapsedSec: 90, id: 'm_hacked', transcript: [] });
  const after = s.get(m.id);
  assert.strictEqual(after.status, 'ended');
  assert.strictEqual(after.id, m.id, 'id must not be updatable');
  assert.strictEqual(after.transcript.length, 2, 'transcript must not be overwritten by update');
  assert.strictEqual(s.list().length, 1);
  s.remove(m.id);
  assert.strictEqual(s.list().length, 0);
});

test('store: rejects path traversal ids', () => {
  const s = createStore(tmp(), identity);
  assert.throws(() => s.get('../settings'), /Invalid meeting id/);
  assert.throws(() => s.remove('m_1/../../x'), /Invalid meeting id/);
});

test('store: api key is encrypted at rest and never returned', () => {
  const dir = tmp();
  const b64 = {
    encrypt: (s) => Buffer.from(s).toString('base64'),
    decrypt: (s) => Buffer.from(s, 'base64').toString('utf8'),
  };
  const s = createStore(dir, b64);
  s.setSettings({ apiKey: 'sk-test-123', model: 'claude-sonnet-5-5' });
  assert.strictEqual(s.getApiKey(), 'sk-test-123');
  assert.strictEqual(s.getSettings().hasKey, true);
  assert.ok(!('apiKey' in s.getSettings()));
  assert.ok(!fs.readFileSync(path.join(dir, 'settings.json'), 'utf8').includes('sk-test-123'));
  s.setSettings({ apiKey: '' });
  assert.strictEqual(s.getApiKey(), null);
});

test('store: wipeAll removes meetings but keeps settings', () => {
  const s = createStore(tmp(), identity);
  s.setSettings({ apiKey: 'k' });
  s.create({ title: 'x' });
  s.wipeAll();
  assert.strictEqual(s.list().length, 0);
  assert.strictEqual(s.getApiKey(), 'k');
});

const sampleMeeting = () => ({
  id: 'm_1', title: 'Ops review <b>', attendees: 'A, B', agendaPre: 'Budget\nSchedule',
  startedAt: '2026-10-12T14:00:00Z', createdAt: '2026-10-12T13:00:00Z', elapsedSec: 1800,
  transcript: [
    { t: 65, source: 'others', text: 'We agree to replace the roof in spring.' },
    { t: 10, source: 'you', text: 'Can we confirm the budget?' },
  ],
  notes: [{ t: 20, text: 'Ask about permits' }],
  summary: null,
});

test('ai: user message contains ordered transcript, notes and agenda', () => {
  const msg = ai.buildUserMessage(sampleMeeting(), 'focus on budget');
  assert.ok(msg.indexOf('[00:10] You: Can we confirm') < msg.indexOf('[01:05] Others: We agree'));
  assert.ok(msg.includes('[00:20] Ask about permits'));
  assert.ok(msg.includes('Budget\nSchedule'));
  assert.ok(msg.includes('focus on budget'));
});

test('ai: extractJson tolerates fences and commentary', () => {
  assert.deepStrictEqual(ai.extractJson('Here:\n```json\n{"a":1}\n```'), { a: 1 });
  assert.throws(() => ai.extractJson('no json here'));
});

test('ai: normalize fills gaps with the not-confirmed marker and never invents values', () => {
  const n = ai.normalize({
    executive_summary: 'Roof replacement agreed.',
    action_items: [{ task: 'Get permit quote' }],
    follow_up_agenda: { items: [{ topic: 'Permits', minutes: '10' }, { topic: 'Budget', minutes: 'abc' }] },
  });
  assert.strictEqual(n.action_items[0].owner, ai.TBC);
  assert.strictEqual(n.action_items[0].due, ai.TBC);
  assert.strictEqual(n.follow_up_agenda.items[0].minutes, 10);
  assert.strictEqual(n.follow_up_agenda.items[1].minutes, null);
  assert.deepStrictEqual(n.decisions, []);
});

test('ai: generateSummary uses the client, system prompt and model', async () => {
  let seen;
  const client = {
    messages: {
      create: async (req) => {
        seen = req;
        return {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: JSON.stringify({
            executive_summary: 'Agreed to replace the roof in spring.',
            decisions: [{ decision: 'Replace roof in spring', context: 'budget pending' }],
            action_items: [{ task: 'Confirm budget', owner: 'You', due: 'Friday', priority: 'high' }],
            follow_up_agenda: { title: 'Roof follow-up', objective: 'Confirm budget', items: [{ topic: 'Budget', purpose: 'Approve', owner: 'You', minutes: 15 }] },
          }) }],
        };
      },
    },
  };
  const out = await ai.generateSummary({ model: 'claude-sonnet-5-5', meeting: sampleMeeting(), instruction: '', client });
  assert.strictEqual(seen.model, 'claude-sonnet-5-5');
  assert.ok(seen.system.includes('Data to be confirmed'));
  assert.strictEqual(out.follow_up_agenda.items[0].minutes, 15);
});

test('ai: refuses empty meetings and truncated responses', async () => {
  const empty = { ...sampleMeeting(), transcript: [], notes: [] };
  await assert.rejects(ai.generateSummary({ model: 'm', meeting: empty, client: {} }), /no transcript or notes/);
  const client = { messages: { create: async () => ({ stop_reason: 'max_tokens', content: [] }) } };
  await assert.rejects(ai.generateSummary({ model: 'm', meeting: sampleMeeting(), client }), /cut off/);
});

test('render: markdown has all sections and escapes table pipes; html escapes markup', () => {
  const m = sampleMeeting();
  m.summary = ai.normalize({
    executive_summary: 'Roof agreed.',
    decisions: [{ decision: 'Replace roof', context: 'spring' }],
    action_items: [{ task: 'Budget | quote', owner: 'A', due: 'Fri', priority: 'high' }],
    agenda_coverage: [{ item: 'Budget', status: 'covered' }],
    follow_up_agenda: { title: 'Follow-up', objective: 'Close budget', items: [{ topic: 'Budget', minutes: 20 }, { topic: 'Permits', minutes: 10 }] },
    missing_information: ['Permit cost'],
  });
  const md = render.renderMarkdown(m);
  for (const h of ['## Executive summary', '## Decisions', '## Action items', '## Risks and open items', '## Planned agenda coverage', '## After-meeting agenda: Follow-up', '## Missing information', '## Typed notes']) {
    assert.ok(md.includes(h), 'missing ' + h);
  }
  assert.ok(md.includes('Budget \\| quote'));
  assert.ok(md.includes('Proposed total: 30 minutes'));
  assert.ok(!md.includes('## Transcript'));
  assert.ok(render.renderMarkdown(m, { withTranscript: true }).includes('## Transcript'));
  const html = render.renderHtml(m);
  assert.ok(html.includes('Ops review &lt;b&gt;'));
  assert.ok(!html.includes('<b>'));
});

test('render: summary-less meeting still renders', () => {
  assert.ok(render.renderMarkdown(sampleMeeting()).includes('Summary not generated yet.'));
  assert.ok(render.renderTranscriptText(sampleMeeting()).includes('[00:10] You: Can we confirm'));
});

test('transcriber: toFloat32 handles ArrayBuffer, typed views and Float32Array', () => {
  const f = new Float32Array([0.5, -0.5]);
  assert.strictEqual(toFloat32(f), f);
  assert.deepStrictEqual(Array.from(toFloat32(f.buffer)), [0.5, -0.5]);
  const view = new Uint8Array(f.buffer);
  assert.deepStrictEqual(Array.from(toFloat32(view)), [0.5, -0.5]);
  assert.throws(() => toFloat32('x'));
});

test('segmenter: skips silence, cuts at pauses and at max length, drops noise-only chunks', () => {
  const sr = 16000;
  const block = (v) => new Float32Array(1600).fill(v); // 100 ms
  const seg = new Segmenter({ sampleRate: sr });
  let out = [];
  for (let i = 0; i < 20; i++) out.push(...seg.push(block(0), i * 0.1)); // 2 s of silence
  assert.strictEqual(out.length, 0);
  for (let i = 0; i < 70; i++) out.push(...seg.push(block(0.1), 2 + i * 0.1)); // 7 s of speech
  assert.strictEqual(out.length, 0, 'no cut while speaking below max length');
  for (let i = 0; i < 8; i++) out.push(...seg.push(block(0), 9 + i * 0.1)); // 0.8 s pause
  assert.strictEqual(out.length, 1);
  assert.ok(Math.abs(out[0].t - 1.7) < 1e-9, 'segment starts 0.3 s before speech (pre-roll)');
  assert.ok(out[0].samples.length >= 7 * sr);

  const long = new Segmenter({ sampleRate: sr });
  let forced = [];
  for (let i = 0; i < 260; i++) forced.push(...long.push(block(0.1), i * 0.1)); // 26 s continuous
  assert.strictEqual(forced.length, 1, 'forced cut at max length');

  const noise = new Segmenter({ sampleRate: sr });
  noise.push(block(0.1), 0); // 0.1 s of speech only
  for (let i = 0; i < 80; i++) noise.push(block(0), 0.1 + i * 0.1);
  assert.strictEqual(noise.flush(), null, 'too little speech is discarded');
});

test('segmenter: forced cut lands on the quietest point and keeps the remainder', () => {
  const sr = 16000;
  const block = (v) => new Float32Array(1600).fill(v);
  const seg = new Segmenter({ sampleRate: sr });
  const out = [];
  for (let i = 0; i < 250; i++) {
    const v = i === 240 ? 0.02 : 0.1; // a softer dip 1 s before the max length
    out.push(...seg.push(block(v), i * 0.1));
  }
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].samples.length, 241 * 1600, 'cut right after the dip');
  assert.strictEqual(seg.length, 9 * 1600, 'remaining audio carried into the next segment');
  assert.ok(Math.abs(seg.startT - 24.1) < 1e-9);
});

test('segmenter: adapts to background noise so quiet speech is still detected', () => {
  const sr = 16000;
  const block = (v) => new Float32Array(1600).fill(v);
  const quiet = new Segmenter({ sampleRate: sr });
  const out = [];
  for (let i = 0; i < 20; i++) out.push(...quiet.push(block(0.001), i * 0.1)); // low noise floor
  for (let i = 0; i < 70; i++) out.push(...quiet.push(block(0.006), 2 + i * 0.1)); // soft voice
  for (let i = 0; i < 8; i++) out.push(...quiet.push(block(0.001), 9 + i * 0.1));
  assert.strictEqual(out.length, 1, 'soft speech below the old fixed 0.01 threshold is kept');

  const noisy = new Segmenter({ sampleRate: sr });
  for (let i = 0; i < 100; i++) noisy.push(block(0.006), i * 0.1); // constant hum
  assert.ok(noisy.threshold() > 0.006, 'steady hum raises the threshold above itself');
});
