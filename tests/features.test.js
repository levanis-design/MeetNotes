'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const gh = require('../src/github');
const layout = require('../src/mini-layout');
const { createStore } = require('../src/store');
const render = require('../src/render');

// ---------- a tiny in-memory GitHub ----------
function fakeGithub({ login = 'levani', repos = {} } = {}) {
  const db = new Map(Object.entries(repos).map(([k, v]) => [k, { private: v.private, files: new Map(Object.entries(v.files || {})) }]));
  const calls = [];
  let shaN = 0;
  const reply = (status, data, headers = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: { get: (k) => headers[k.toLowerCase()] || null },
    text: async () => (data === undefined ? '' : JSON.stringify(data)),
  });
  async function fetchImpl(url, opts) {
    const u = new URL(url);
    const method = opts.method;
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ method, path: u.pathname, body, auth: opts.headers.Authorization });
    if (!opts.headers.Authorization || !opts.headers.Authorization.startsWith('Bearer ')) return reply(401, { message: 'Bad credentials' });
    if (opts.headers.Authorization === 'Bearer bad') return reply(401, { message: 'Bad credentials' });
    if (opts.headers.Authorization === 'Bearer limited') return reply(403, { message: 'Resource not accessible' }, { 'x-accepted-github-permissions': 'contents=write' });
    let m;
    if (method === 'GET' && u.pathname === '/user') return reply(200, { login });
    if ((m = u.pathname.match(/^\/repos\/([^/]+)\/([^/]+)$/)) && method === 'GET') {
      const r = db.get(`${m[1]}/${m[2]}`);
      return r ? reply(200, { private: r.private }) : reply(404, { message: 'Not Found' });
    }
    if (method === 'POST' && (m = u.pathname.match(/^\/(?:user|orgs\/([^/]+))\/repos$/))) {
      const owner = m[1] || login;
      const key = `${owner}/${body.name}`;
      if (db.has(key)) return reply(422, { message: 'Repository creation failed.', errors: [{ message: 'name already exists on this account' }] });
      db.set(key, { private: body.private, files: new Map() });
      return reply(201, { private: body.private });
    }
    if ((m = u.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/))) {
      const r = db.get(`${m[1]}/${m[2]}`);
      const filePath = decodeURIComponent(m[3]);
      if (!r) return reply(404, { message: 'Not Found' });
      if (method === 'GET') {
        const f = r.files.get(filePath);
        return f ? reply(200, { sha: f.sha }) : reply(404, { message: 'Not Found' });
      }
      if (method === 'PUT') {
        const existing = r.files.get(filePath);
        if (existing && body.sha !== existing.sha) return reply(422, { message: 'sha wasn\'t supplied' });
        r.files.set(filePath, { sha: 'sha' + ++shaN, content: Buffer.from(body.content, 'base64').toString('utf8'), message: body.message });
        return reply(200, { content: { html_url: `https://github.com/${m[1]}/${m[2]}/blob/main/${filePath}` } });
      }
    }
    return reply(404, { message: 'Not Found' });
  }
  return { fetchImpl, db, calls };
}

const meeting = (over = {}) => ({
  id: 'm_1760000000001',
  title: 'Ops Review: Roof & Façade',
  startedAt: '2026-10-12T16:00:00Z',
  createdAt: '2026-10-12T15:00:00Z',
  elapsedSec: 600,
  attendees: 'A, B',
  agendaPre: '',
  transcript: [{ t: 5, source: 'you', text: 'Hello everyone' }],
  notes: [],
  summary: {
    executive_summary: 'Roof agreed.', decisions: [], action_items: [], risks_and_open_items: [],
    agenda_coverage: [], follow_up_agenda: { title: 'Follow-up', objective: 'Close', items: [] }, missing_information: [],
  },
  github: null,
  ...over,
});

const publish = (client, m, opts = {}) => gh.publishMeeting({
  client,
  repoInput: 'meeting-notes',
  isPrivate: true,
  allowPublic: false,
  meeting: m,
  renderMarkdown: (x) => render.renderMarkdown(x),
  renderTranscript: (x) => render.renderTranscriptText(x),
  includeTranscript: false,
  ...opts,
});

// ---------- github ----------
test('github: parseRepoInput accepts name, owner/name and URLs, rejects unsafe input', () => {
  assert.deepStrictEqual(gh.parseRepoInput('meeting-notes', 'levani'), { owner: 'levani', name: 'meeting-notes' });
  assert.deepStrictEqual(gh.parseRepoInput('acme/notes', 'levani'), { owner: 'acme', name: 'notes' });
  assert.deepStrictEqual(gh.parseRepoInput('https://github.com/acme/notes.git', 'levani'), { owner: 'acme', name: 'notes' });
  for (const bad of ['', 'a/b/c', '../x', 'bad name', 'x?y', '..']) {
    assert.throws(() => gh.parseRepoInput(bad, 'levani'), gh.GithubError, `should reject "${bad}"`);
  }
});

test('github: slugify makes safe folder names', () => {
  assert.strictEqual(gh.slugify('Ops Review: Roof & Façade'), 'ops-review-roof-fa-ade');
  assert.strictEqual(gh.slugify('   '), 'meeting');
  assert.ok(gh.slugify('x'.repeat(200)).length <= 50);
});

test('github: creates a private repo and writes the summary only by default', async () => {
  const f = fakeGithub();
  const client = gh.createClient({ token: 'tok', fetchImpl: f.fetchImpl });
  const r = await publish(client, meeting());
  assert.strictEqual(r.repo, 'levani/meeting-notes');
  assert.strictEqual(r.created, true);
  assert.match(r.folder, /^meetings\/\d{4}-\d{2}-\d{2}-ops-review-roof-fa-ade$/);
  assert.strictEqual(f.db.get('levani/meeting-notes').private, true);
  const files = [...f.db.get('levani/meeting-notes').files.keys()];
  assert.deepStrictEqual(files, [`${r.folder}/summary.md`]);
  assert.ok(f.db.get('levani/meeting-notes').files.get(`${r.folder}/summary.md`).content.includes('## Executive summary'));
  assert.ok(r.url.startsWith('https://github.com/levani/meeting-notes/blob/'));
});

test('github: uploads the transcript only when requested', async () => {
  const f = fakeGithub();
  const client = gh.createClient({ token: 'tok', fetchImpl: f.fetchImpl });
  const r = await publish(client, meeting(), { includeTranscript: true });
  const files = [...f.db.get('levani/meeting-notes').files.keys()].sort();
  assert.deepStrictEqual(files, [`${r.folder}/summary.md`, `${r.folder}/transcript.txt`]);
  assert.ok(f.db.get('levani/meeting-notes').files.get(`${r.folder}/transcript.txt`).content.includes('Hello everyone'));
});

test('github: publishing again updates the same files instead of duplicating', async () => {
  const f = fakeGithub();
  const client = gh.createClient({ token: 'tok', fetchImpl: f.fetchImpl });
  const first = await publish(client, meeting());
  const m2 = meeting({ github: { repo: first.repo, folder: first.folder } });
  const second = await publish(client, m2);
  assert.strictEqual(second.folder, first.folder);
  assert.strictEqual(f.db.get('levani/meeting-notes').files.size, 1);
  assert.match(f.db.get('levani/meeting-notes').files.get(`${first.folder}/summary.md`).message, /^Update meeting notes/);
});

test('github: a different meeting with the same title and date gets its own folder', async () => {
  const f = fakeGithub();
  const client = gh.createClient({ token: 'tok', fetchImpl: f.fetchImpl });
  const a = await publish(client, meeting());
  const b = await publish(client, meeting({ id: 'm_1760000009999' }));
  assert.notStrictEqual(a.folder, b.folder);
  assert.ok(b.folder.endsWith('-9999'));
  assert.strictEqual(f.db.get('levani/meeting-notes').files.size, 2);
});

test('github: refuses an existing public repository unless public was chosen', async () => {
  const f = fakeGithub({ repos: { 'levani/meeting-notes': { private: false } } });
  const client = gh.createClient({ token: 'tok', fetchImpl: f.fetchImpl });
  await assert.rejects(publish(client, meeting()), /public repository/);
  assert.strictEqual(f.db.get('levani/meeting-notes').files.size, 0, 'nothing may be written');
  await publish(client, meeting(), { allowPublic: true, isPrivate: false });
  assert.strictEqual(f.db.get('levani/meeting-notes').files.size, 1);
});

test('github: creates repos under an organization with the orgs endpoint', async () => {
  const f = fakeGithub();
  const client = gh.createClient({ token: 'tok', fetchImpl: f.fetchImpl });
  await publish(client, meeting(), { repoInput: 'acme/notes' });
  assert.ok(f.calls.some((c) => c.method === 'POST' && c.path === '/orgs/acme/repos'));
  assert.ok(f.db.has('acme/notes'));
});

test('github: friendly errors, and the token never leaks into results or messages', async () => {
  const f = fakeGithub();
  await assert.rejects(publish(gh.createClient({ token: 'bad', fetchImpl: f.fetchImpl }), meeting()), /rejected the token/);
  await assert.rejects(publish(gh.createClient({ token: 'limited', fetchImpl: f.fetchImpl }), meeting()), /contents=write/);
  assert.throws(() => gh.createClient({ token: '', fetchImpl: f.fetchImpl }), /No GitHub token/);
  const secret = 'ghp_SECRET123';
  const client = gh.createClient({ token: secret, fetchImpl: f.fetchImpl });
  const r = await publish(client, meeting());
  assert.ok(!JSON.stringify(r).includes(secret));
  assert.ok(f.calls.every((c) => !JSON.stringify(c.body || {}).includes(secret)), 'token only travels in the header');
});

// ---------- widget layout ----------
test('layout: widget sits in each corner with a margin and nearest corner is detected', () => {
  const wa = { x: 0, y: 0, width: 1920, height: 1040 };
  const size = layout.SIZES.pill;
  assert.deepStrictEqual(layout.cornerPosition('top-right', size, wa), { x: 1920 - size.width - layout.MARGIN, y: layout.MARGIN });
  assert.deepStrictEqual(layout.cornerPosition('top-left', size, wa), { x: layout.MARGIN, y: layout.MARGIN });
  assert.deepStrictEqual(layout.cornerPosition('bottom-right', size, wa), { x: 1920 - size.width - layout.MARGIN, y: 1040 - size.height - layout.MARGIN });
  assert.deepStrictEqual(layout.cornerPosition('bottom-left', size, wa), { x: layout.MARGIN, y: 1040 - size.height - layout.MARGIN });
  const at = (x, y) => ({ x, y, width: size.width, height: size.height });
  assert.strictEqual(layout.nearestCorner(at(1400, 20), wa), 'top-right');
  assert.strictEqual(layout.nearestCorner(at(40, 30), wa), 'top-left');
  assert.strictEqual(layout.nearestCorner(at(1500, 900), wa), 'bottom-right');
  assert.strictEqual(layout.nearestCorner(at(100, 950), wa), 'bottom-left');
});

test('layout: respects a work area that does not start at the origin (second monitor, taskbar)', () => {
  const wa = { x: 1920, y: 40, width: 1280, height: 960 };
  const p = layout.cornerPosition('bottom-left', layout.SIZES.dot, wa);
  assert.strictEqual(p.x, 1920 + layout.MARGIN);
  assert.strictEqual(p.y, 40 + 960 - layout.SIZES.dot.height - layout.MARGIN);
  assert.ok(layout.isCorner('top-left') && !layout.isCorner('middle'));
  assert.ok(layout.isSize('dot') && !layout.isSize('huge') && !layout.isSize('__proto__'));
});

// ---------- settings ----------
const b64 = {
  encrypt: (s) => Buffer.from(s).toString('base64'),
  decrypt: (s) => Buffer.from(s, 'base64').toString('utf8'),
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'meetnotes-'));

test('settings: widget and GitHub defaults', () => {
  const s = createStore(tmp(), b64).getSettings();
  assert.strictEqual(s.miniAppearance, 'solid');
  assert.strictEqual(s.miniCorner, 'top-right');
  assert.strictEqual(s.miniSize, 'pill');
  assert.strictEqual(s.autoMini, true);
  assert.strictEqual(s.mainAlwaysOnTop, false);
  assert.strictEqual(s.githubPrivate, true);
  assert.strictEqual(s.hasGithubToken, false);
});

test('settings: values are validated and clamped', () => {
  const st = createStore(tmp(), b64);
  st.setSettings({ miniOpacity: 5, miniCorner: 'middle', miniSize: 'huge', miniAppearance: 'neon', githubPrivate: 'no', autoMini: 'yes' });
  let s = st.getSettings();
  assert.strictEqual(s.miniOpacity, 20, 'clamped to minimum');
  assert.strictEqual(s.miniCorner, 'top-right');
  assert.strictEqual(s.miniSize, 'pill');
  assert.strictEqual(s.miniAppearance, 'solid');
  assert.strictEqual(s.githubPrivate, true, 'only real booleans are accepted');
  assert.strictEqual(s.autoMini, true);
  st.setSettings({ miniOpacity: 400, miniCorner: 'bottom-left', miniSize: 'card', miniAppearance: 'transparent', githubPrivate: false, autoMini: false, mainAlwaysOnTop: true });
  s = st.getSettings();
  assert.deepStrictEqual(
    [s.miniOpacity, s.miniCorner, s.miniSize, s.miniAppearance, s.githubPrivate, s.autoMini, s.mainAlwaysOnTop],
    [100, 'bottom-left', 'card', 'transparent', false, false, true],
  );
});

test('settings: GitHub token is encrypted at rest and never returned', () => {
  const dir = tmp();
  const st = createStore(dir, b64);
  st.setSettings({ githubToken: 'ghp_abc123', githubRepo: ' notes ' });
  assert.strictEqual(st.getGithubToken(), 'ghp_abc123');
  assert.strictEqual(st.getSettings().hasGithubToken, true);
  assert.strictEqual(st.getSettings().githubRepo, 'notes');
  assert.ok(!JSON.stringify(st.getSettings()).includes('ghp_abc123'));
  assert.ok(!fs.readFileSync(path.join(dir, 'settings.json'), 'utf8').includes('ghp_abc123'));
  st.setSettings({ githubToken: '' });
  assert.strictEqual(st.getGithubToken(), null);
});

test('meetings: github record is stored through update and shown in the list', () => {
  const st = createStore(tmp(), b64);
  const m = st.create({ title: 'x' });
  assert.strictEqual(m.github, null);
  st.update(m.id, { github: { repo: 'levani/notes', folder: 'meetings/a', url: 'https://github.com/levani/notes' } });
  assert.strictEqual(st.get(m.id).github.repo, 'levani/notes');
  assert.strictEqual(st.list()[0].published, true);
});
