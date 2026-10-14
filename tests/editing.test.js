'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createStore } = require('../src/store');
const { buildDashboard, weekRange } = require('../src/dashboard');
const render = require('../src/render');

const identity = { encrypt: (s) => 'enc:' + s, decrypt: (s) => s.replace(/^enc:/, '') };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'meetnotes-edit-'));

function meetingWithLines(s) {
  const m = s.create({ title: 'Roof project', attendees: 'Ana, Ben' });
  s.appendTranscript(m.id, { t: 5, source: 'you', text: 'The budget is twelve thousand' });
  s.appendTranscript(m.id, { t: 20, source: 'others', text: 'We will ask Jon for the permit' });
  return m;
}

test('transcript: a line can be corrected and is marked edited', () => {
  const s = createStore(tmp(), identity);
  const m = meetingWithLines(s);
  const r = s.editTranscript(m.id, { t: 20, source: 'others', text: 'We will ask Jon for the permit', newText: '  We will ask John   for the permit ' });
  assert.equal(r.text, 'We will ask John for the permit');
  assert.equal(r.edited, true);
  const tx = s.get(m.id).transcript;
  assert.deepEqual(tx.map((x) => x.text), ['The budget is twelve thousand', 'We will ask John for the permit']);
  assert.equal(tx[1].t, 20);
  assert.equal(tx[1].source, 'others');
});

test('transcript: clearing a line removes it', () => {
  const s = createStore(tmp(), identity);
  const m = meetingWithLines(s);
  assert.equal(s.editTranscript(m.id, { t: 5, source: 'you', text: 'The budget is twelve thousand', newText: '  ' }), null);
  assert.deepEqual(s.get(m.id).transcript.map((x) => x.t), [20]);
});

test('transcript: a line that changed meanwhile is not overwritten', () => {
  const s = createStore(tmp(), identity);
  const m = meetingWithLines(s);
  assert.throws(() => s.editTranscript(m.id, { t: 5, source: 'you', text: 'old text', newText: 'x' }), /has changed/);
  assert.equal(s.get(m.id).transcript[0].text, 'The budget is twelve thousand');
});

test('search: finds words in transcripts, notes and summaries across meetings', () => {
  const s = createStore(tmp(), identity);
  const a = meetingWithLines(s);
  const b = s.create({ title: 'Weekly ops' });
  s.addNote(b.id, { t: 60, text: 'Order scaffolding before Friday' });
  const c = s.create({ title: 'Vendor call' });
  s.setSummary(c.id, { executive_summary: 'Data to be confirmed', decisions: [{ decision: 'Switch to the new permit vendor', context: '' }], action_items: [] });

  const permit = s.search('permit');
  assert.deepEqual(permit.map((r) => r.id).sort(), [a.id, c.id].sort());
  const fromTx = permit.find((r) => r.id === a.id);
  assert.equal(fromTx.where, 'Others');
  assert.equal(fromTx.t, 20);
  assert.match(fromTx.snippet, /permit/);
  assert.equal(permit.find((r) => r.id === c.id).where, 'Summary');

  const note = s.search('SCAFFOLDING');
  assert.equal(note.length, 1);
  assert.equal(note[0].where, 'Note');

  assert.equal(s.search('budget jon').length, 1, 'all words must appear in the meeting');
  assert.equal(s.search('budget scaffolding').length, 0);
  assert.deepEqual(s.search('   '), []);
  assert.equal(s.search('data to be confirmed').length, 0, 'placeholder text is not searchable');
});

test('search: a long match is trimmed around the word', () => {
  const s = createStore(tmp(), identity);
  const m = s.create({ title: 'Long' });
  s.appendTranscript(m.id, { t: 1, source: 'you', text: 'a '.repeat(200) + 'needle ' + 'b '.repeat(200) });
  const [r] = s.search('needle');
  assert.ok(r.snippet.length <= 142);
  assert.match(r.snippet, /^….*needle.*…$/);
});

test('settings: weeks start on Monday by default and can be set to Sunday', () => {
  const s = createStore(tmp(), identity);
  assert.equal(s.getSettings().weekStart, 'monday');
  s.setSettings({ weekStart: 'sunday' });
  assert.equal(s.getSettings().weekStart, 'sunday');
  s.setSettings({ weekStart: 'friday' });
  assert.equal(s.getSettings().weekStart, 'sunday', 'invalid values are ignored');
});

test('dashboard: a Monday week runs Monday to Sunday', () => {
  const sunday = new Date(2026, 9, 18, 10); // Sunday 18 October 2026
  assert.deepEqual(weekRange(sunday, 1), { start: '2026-10-12', end: '2026-10-18' });
  assert.deepEqual(weekRange(sunday, 0), { start: '2026-10-18', end: '2026-10-24' });
  const monday = new Date(2026, 9, 19, 10);
  assert.deepEqual(weekRange(monday, 1), { start: '2026-10-19', end: '2026-10-25' });
  const d = buildDashboard({ now: sunday, weekStartsOn: 1 });
  assert.equal(d.week.start, '2026-10-12');
  assert.equal(d.weekStartsOn, 1);
});

test('export: summary and transcript go in one document', () => {
  const s = createStore(tmp(), identity);
  const m = meetingWithLines(s);
  s.setSummary(m.id, {
    executive_summary: 'Budget agreed.', decisions: [], action_items: [], risks_and_open_items: [], agenda_coverage: [],
    follow_up_agenda: { title: 'Next', objective: 'Review', items: [] }, missing_information: [],
  });
  const md = render.renderMarkdown(s.get(m.id), { withTranscript: true });
  assert.match(md, /## Executive summary[\s\S]*Budget agreed\./);
  assert.match(md, /## Transcript[\s\S]*\[00:05\] You: The budget is twelve thousand[\s\S]*\[00:20\] Others: We will ask Jon/);
  assert.doesNotMatch(render.renderMarkdown(s.get(m.id)), /## Transcript/);
});
