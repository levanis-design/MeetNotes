'use strict';
// AI connectors (API, local command-line tools, copy/paste) and the Outlook-on-this-computer calendar.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const providers = require('../src/providers');
const ai = require('../src/ai');
const { createStore } = require('../src/store');
const desktop = require('../src/outlook-desktop');
const { createServices } = require('../src/services');
const { createTaskStore } = require('../src/tasks');

const identity = { encrypt: (s) => 'enc:' + s, decrypt: (s) => s.replace(/^enc:/, '') };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'meetnotes-'));

const SUMMARY = {
  executive_summary: 'Roof inspection moves to Thursday.',
  decisions: [{ decision: 'Move the inspection', context: '' }],
  action_items: [{ task: 'Call the roofer', owner: 'You', due: '2026-10-15', priority: 'high' }],
  risks_and_open_items: [], agenda_coverage: [],
  follow_up_agenda: { title: 'Roof follow-up', objective: 'Confirm repair', items: [{ topic: 'Quote', purpose: '', owner: 'You', minutes: 10 }] },
  missing_information: [],
};
const meeting = () => ({
  title: 'Weekly operations', attendees: '', agendaPre: '', startedAt: '2026-10-13T14:00:00Z', notes: [],
  transcript: [{ t: 5, source: 'others', text: 'We agreed to move the roof inspection to Thursday.' }],
});

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

test('API addresses preserve query parameters and require an exact loopback hostname for keyless requests', async () => {
  assert.equal(providers.chatUrl('https://x.openai.azure.com/openai/deployments/model/chat/completions?api-version=2024-10-21'),
    'https://x.openai.azure.com/openai/deployments/model/chat/completions?api-version=2024-10-21');
  assert.equal(providers.chatUrl('https://gateway.example/v1/?route=summary'), 'https://gateway.example/v1/chat/completions?route=summary');
  let contacted = false;
  await assert.rejects(providers.openai({ baseUrl: 'http://localhost.example/v1', model: 'm', user: 'private notes', fetchImpl: async () => { contacted = true; } }), /API key/);
  assert.equal(contacted, false);
});

// Fake child process for the command-line connectors.
function fakeSpawn({ stdout = '', stderr = '', code = 0, onRun }) {
  const calls = [];
  const spawnImpl = (command, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let input = '';
    child.stdin = { on() {}, end(data) { input = data; setImmediate(finish); } };
    child.kill = () => {};
    const call = { command, opts };
    calls.push(call);
    function finish() {
      call.input = input;
      if (onRun) onRun(call);
      if (stdout) child.stdout.emit('data', stdout);
      if (stderr) child.stderr.emit('data', stderr);
      child.emit('close', code);
    }
    return child;
  };
  return { spawnImpl, calls };
}

test('openai connector: sends system and user messages and returns the reply', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init, body: JSON.parse(init.body) };
    return jsonResponse(200, { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(SUMMARY) } }] });
  };
  const cfg = { provider: 'openai', openaiKey: 'sk-1', openaiBaseUrl: 'https://api.openai.com/v1/', openaiModel: 'gpt-5' };
  const out = await ai.generateSummary({ cfg, meeting: meeting(), instruction: '', fetchImpl });
  assert.equal(out.executive_summary, 'Roof inspection moves to Thursday.');
  assert.equal(seen.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(seen.init.headers.Authorization, 'Bearer sk-1');
  assert.equal(seen.body.model, 'gpt-5');
  assert.equal(seen.body.messages[0].role, 'system');
  assert.match(seen.body.messages[1].content, /roof inspection/);
});

test('openai connector: clear errors, Azure key header and keyless local models', async () => {
  const cfg = { provider: 'openai', openaiKey: 'bad', openaiModel: 'gpt-5' };
  await assert.rejects(providers.complete(cfg, { user: 'hi', fetchImpl: async () => jsonResponse(401, { error: { message: 'no' } }) }), /rejected the API key/);
  await assert.rejects(providers.complete({ ...cfg, openaiKey: '' }, { user: 'hi', fetchImpl: async () => jsonResponse(200, {}) }), /API key in Settings/);
  let headers;
  await providers.complete({ ...cfg, openaiKey: 'az', openaiBaseUrl: 'https://x.openai.azure.com/openai/v1' }, {
    user: 'hi', fetchImpl: async (u, i) => { headers = i.headers; return jsonResponse(200, { choices: [{ message: { content: 'ok' } }] }); },
  });
  assert.equal(headers['api-key'], 'az');
  const local = await providers.complete({ provider: 'openai', openaiKey: '', openaiBaseUrl: 'http://localhost:11434/v1', openaiModel: 'llama3' }, {
    user: 'hi', fetchImpl: async (u, i) => { headers = i.headers; return jsonResponse(200, { choices: [{ message: { content: 'ok' } }] }); },
  });
  assert.equal(local, 'ok');
  assert.equal(headers.Authorization, undefined);
});

test('anthropic connector: still works through the SDK client', async () => {
  let req;
  const client = { messages: { create: async (r) => { req = r; return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(SUMMARY) }] }; } } };
  const out = await ai.generateSummary({ cfg: { provider: 'anthropic', anthropicKey: 'k', model: 'claude-sonnet-5-5' }, meeting: meeting(), client });
  assert.equal(out.action_items[0].owner, 'You');
  assert.equal(req.model, 'claude-sonnet-5-5');
  await assert.rejects(providers.complete({ provider: 'anthropic', model: 'm' }, { user: 'x' }), /no key is saved/);
  const found = (name) => ({ status: name === 'claude' ? 0 : 1, stdout: 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd\r\n' });
  const hint = providers.setupHint({ provider: 'anthropic' }, { spawnSyncImpl: (cmd, [name]) => found(name), platform: 'win32' });
  assert.match(hint, /Claude Code is installed on this computer: choose "Claude Code on this computer"/);
  const none = providers.setupHint({ provider: 'anthropic' }, { spawnSyncImpl: () => ({ status: 1 }), platform: 'win32' });
  assert.match(none, /Copy prompt for any AI/);
  assert.equal(providers.setupHint({ provider: 'anthropic', anthropicKey: 'k' }), null);
});

test('claude-cli connector: pipes the prompt to "claude -p" outside any project folder', async () => {
  const { spawnImpl, calls } = fakeSpawn({ stdout: 'Here you go:\n' + JSON.stringify(SUMMARY) });
  const out = await ai.generateSummary({ cfg: { provider: 'claude-cli', cliPath: '' }, meeting: meeting(), spawnImpl });
  assert.equal(out.follow_up_agenda.title, 'Roof follow-up');
  assert.match(calls[0].command, /^claude -p --output-format text$/);
  assert.equal(calls[0].opts.shell, true);
  assert.equal(calls[0].opts.cwd, os.tmpdir());
  assert.match(calls[0].input, /You write after-meeting records/);
  assert.match(calls[0].input, /roof inspection/);
});

test('cli connectors: a custom path with spaces is quoted, and missing or signed-out tools explain themselves', async () => {
  const ok = fakeSpawn({ stdout: 'ok' });
  await providers.complete({ provider: 'claude-cli', cliPath: 'C:\\Program Files\\Claude\\claude.exe' }, { user: 'hi', spawnImpl: ok.spawnImpl });
  assert.match(ok.calls[0].command, /^"C:\\Program Files\\Claude\\claude.exe" -p/);
  const missing = fakeSpawn({ stderr: "'claude' is not recognized as an internal or external command", code: 1 });
  await assert.rejects(providers.complete({ provider: 'claude-cli' }, { user: 'hi', spawnImpl: missing.spawnImpl }), /was not found/);
  const auth = fakeSpawn({ stderr: 'Invalid API key. Please run /login', code: 1 });
  await assert.rejects(providers.complete({ provider: 'claude-cli' }, { user: 'hi', spawnImpl: auth.spawnImpl }), /not signed in/);
});

test('codex-cli connector: reads the final message file written by "codex exec"', async () => {
  const { spawnImpl, calls } = fakeSpawn({
    stdout: 'progress log...',
    onRun: (call) => {
      const file = call.command.match(/--output-last-message (\S+)/)[1].replace(/^"|"$/g, '');
      fs.writeFileSync(file, JSON.stringify(SUMMARY));
    },
  });
  const out = await ai.generateSummary({ cfg: { provider: 'codex-cli' }, meeting: meeting(), spawnImpl });
  assert.equal(out.decisions[0].decision, 'Move the inspection');
  assert.match(calls[0].command, /^codex exec --skip-git-repo-check --sandbox read-only --output-last-message .+ -$/);
});

test('any AI tool: prompt can be copied, and a pasted reply with extra text is imported', () => {
  const prompt = ai.manualPrompt(meeting(), 'focus on budget');
  assert.match(prompt, /Respond with one JSON object only/);
  assert.match(prompt, /roof inspection/);
  assert.match(prompt, /focus on budget/);
  const reply = 'Sure! Here is the summary:\n```json\n' + JSON.stringify(SUMMARY, null, 2) + '\n```\nLet me know.';
  assert.equal(ai.importSummary(reply).follow_up_agenda.items[0].minutes, 10);
  assert.throws(() => ai.importSummary('just some words'), /expected format/);
  assert.throws(() => ai.importSummary('  '), /clipboard is empty/);
  assert.throws(() => ai.manualPrompt({ ...meeting(), transcript: [] }), /no transcript or notes/);
});

test('store: AI connection settings are validated and keys are encrypted', () => {
  const dir = tmp();
  const s = createStore(dir, identity);
  assert.equal(s.getSettings().aiProvider, 'anthropic');
  s.setSettings({ aiProvider: 'openai', openaiKey: 'sk-9', openaiModel: 'gpt-5-mini', openaiBaseUrl: 'http://localhost:1234/v1' });
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.equal(raw.openaiKeyEnc, 'enc:sk-9');
  assert.ok(!JSON.stringify(s.getSettings()).includes('sk-9'), 'keys are never sent to the window');
  assert.equal(s.getSettings().hasOpenaiKey, true);
  const cfg = s.getAiConfig();
  assert.equal(cfg.provider, 'openai');
  assert.equal(cfg.openaiKey, 'sk-9');
  assert.throws(() => s.setSettings({ aiProvider: 'skynet' }), /Unknown AI connection/);
  assert.throws(() => s.setSettings({ openaiBaseUrl: 'ftp://x' }), /should start with https/);
  assert.throws(() => s.setSettings({ cliPath: 'claude & del *' }), /not allowed/);
  s.setSettings({ cliPath: 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd' });
  assert.equal(s.getAiConfig().cliPath, 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd');
});

test('outlook desktop: events are converted, cancelled-free, deduplicated, with Teams links', () => {
  const out = JSON.stringify({
    account: 'Levani',
    events: [
      { id: 'G1', subject: 'Ops review', start: '2026-10-14T14:00:00.0000000Z', end: '2026-10-14T15:00:00.0000000Z', allDay: false,
        location: 'Microsoft Teams Meeting', organizer: 'Ebony', required: 'Ebony; Levani', optional: 'Matthew',
        body: 'Join: https://teams.microsoft.com/l/meetup-join/abc123 ' },
      { id: 'G1', subject: 'Ops review', start: '2026-10-14T14:00:00Z', end: '2026-10-14T15:00:00Z' },
      { id: 'G2', subject: '', start: '2026-10-13T04:00:00Z', end: '2026-10-14T04:00:00Z', allDay: true },
    ],
  });
  const r = desktop.parseOutput('\uFEFF' + out);
  assert.equal(r.account, 'Levani');
  assert.equal(r.events.length, 2);
  const ops = r.events.find((e) => e.title === 'Ops review');
  assert.deepEqual(ops.attendees, ['Ebony', 'Levani', 'Matthew']);
  assert.match(ops.joinUrl, /^https:\/\/teams\.microsoft\.com\//);
  assert.equal(ops.source, 'outlook-desktop');
  assert.equal(r.events[0].title, '(No title)');
  // PowerShell returns a single object instead of an array when there is one event
  assert.equal(desktop.parseOutput(JSON.stringify({ events: { id: 'X', subject: 'One', start: '2026-10-14T14:00:00Z', end: '2026-10-14T14:30:00Z' } })).events.length, 1);
  assert.throws(() => desktop.parseOutput('{"error":"no-outlook"}'), /Classic Outlook for Windows was not found/);
});

test('outlook desktop: runs a read-only PowerShell script on Windows only', async () => {
  const code = desktop.script(new Date('2026-10-13T00:00:00Z'), new Date('2026-10-27T00:00:00Z'));
  assert.match(code, /GetDefaultFolder\(9\)/);
  assert.match(code, /2026-10-13T00:00:00.000Z/);
  assert.doesNotMatch(code, /\.(Save|Delete|Send)\(/, 'never changes the calendar');
  let ran;
  const spawnImpl = (cmd, args) => {
    ran = { cmd, args };
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => { child.stdout.emit('data', JSON.stringify({ account: 'Me', events: [] })); child.emit('close', 0); });
    return child;
  };
  const od = desktop.createOutlookDesktop({ isEnabled: () => true, spawnImpl, platform: 'win32' });
  assert.deepEqual(await od.test(), { count: 0, account: 'Me' });
  assert.equal(ran.cmd, 'powershell.exe');
  assert.ok(ran.args.includes('-EncodedCommand'));
  const mac = desktop.createOutlookDesktop({ isEnabled: () => true, platform: 'darwin' });
  await assert.rejects(mac.events(new Date(), new Date()), /Windows only/);
});

test('services: Outlook on this computer is used when enabled, before a calendar link', async () => {
  const store = createStore(tmp(), identity);
  store.setSettings({ icsUrl: 'https://outlook.office365.com/owa/calendar/x/reachcalendar.ics' });
  let enabled = false;
  const ev = { id: 'od|1', title: 'Desk', start: '2026-10-14T14:00:00Z', end: '2026-10-14T15:00:00Z', attendees: [] };
  const service = createServices({
    store, tasks: createTaskStore(tmp()),
    outlook: { connected: () => false },
    outlookDesktop: { enabled: () => enabled, events: async () => [ev] },
    fetchIcs: async () => [],
  });
  assert.equal(service.calendarSource(), 'ics');
  enabled = true;
  service.clearCalendarCache();
  assert.equal(service.calendarSource(), 'outlook-desktop');
  const r = await service.calendarEvents({ from: '2026-10-13T00:00:00Z', to: '2026-10-20T00:00:00Z' });
  assert.equal(r.source, 'outlook-desktop');
  assert.equal(r.events[0].title, 'Desk');
});
