'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const links = require('../src/links');
const { createTaskStore, isMine, ymd } = require('../src/tasks');
const { buildDashboard, weekRange, dayPart } = require('../src/dashboard');
const outlook = require('../src/outlook');
const ics = require('../src/ics');
const { createStore } = require('../src/store');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mn-cal-'));
const cipher = { encrypt: (t) => Buffer.from('enc:' + t).toString('base64'), decrypt: (b) => Buffer.from(b, 'base64').toString().replace(/^enc:/, '') };

// ---------- links ----------
test('links: only known meeting and sign-in hosts are opened', () => {
  for (const ok of ['https://teams.microsoft.com/l/meetup-join/abc', 'https://us02web.zoom.us/j/123', 'https://meet.google.com/abc-defg-hij', 'https://github.com/me/repo', 'https://login.microsoftonline.com/common/oauth2/deviceauth', 'https://microsoft.com/devicelogin']) {
    assert.ok(links.isAllowedExternal(ok), ok);
  }
  for (const bad of ['http://zoom.us/j/1', 'https://zoom.us.evil.com/j/1', 'https://evilzoom.us/j/1', 'https://zoom.us@evil.com/j/1', 'https://user:pw@zoom.us/j/1', 'file:///C:/Windows/System32/calc.exe', 'javascript:alert(1)', 'https://example.com', '', null, 42]) {
    assert.strictEqual(links.isAllowedExternal(bad), false, String(bad));
  }
});

test('links: join links must be meeting services; sign-in hosts are not join links', () => {
  assert.strictEqual(links.isMeetingLink('https://login.microsoftonline.com/x'), false);
  assert.strictEqual(links.isMeetingLink('https://github.com/x'), false);
  const found = links.findMeetingLink('Room 4', 'See https://example.com/x then https://zoom.us/j/99?pwd=a.');
  assert.strictEqual(found, 'https://zoom.us/j/99?pwd=a');
  assert.strictEqual(links.findMeetingLink('https://evil.example/join', null), null);
});

test('links: calendar links accept webcal and refuse anything not https', () => {
  assert.strictEqual(links.normalizeIcsUrl('webcal://outlook.office365.com/owa/calendar/x/y/reachcalendar.ics'), 'https://outlook.office365.com/owa/calendar/x/y/reachcalendar.ics');
  assert.throws(() => links.normalizeIcsUrl('http://example.com/a.ics'));
  assert.throws(() => links.normalizeIcsUrl('not a link'));
});

// ---------- tasks ----------
test('tasks: add, update, complete and remove', () => {
  const ts = createTaskStore(tmp());
  assert.throws(() => ts.add({ title: '   ' }), /title/);
  const t = ts.add({ title: 'Send scaffold permit', priority: 'HIGH', due: '2026-10-16' });
  assert.strictEqual(t.priority, 'high');
  assert.strictEqual(t.due, '2026-10-16');
  const bad = ts.add({ title: 'Call vendor', due: 'next Friday', priority: 'whatever' });
  assert.strictEqual(bad.due, null);
  assert.strictEqual(bad.dueText, 'next Friday');
  assert.strictEqual(bad.priority, 'med');
  assert.strictEqual(ts.add({ title: 'x', due: '2026-02-31' }).due, null, 'impossible dates are not accepted');
  const done = ts.update(t.id, { done: true });
  assert.ok(done.done && done.doneAt);
  assert.strictEqual(ts.update(t.id, { done: false }).doneAt, null);
  ts.remove(t.id);
  assert.ok(!ts.list().some((x) => x.id === t.id));
  assert.throws(() => ts.update('t_missing', { done: true }), /not found/);
});

test('tasks: importing action items skips placeholders and keeps the structure', () => {
  const ts = createTaskStore(tmp());
  const meeting = { id: 'm_1', summary: { action_items: [
    { task: 'Confirm roof inspection date', owner: 'Levani Sidiani', due: '2026-10-15', priority: 'high' },
    { task: 'Send scaffold permit', owner: 'Data to be confirmed', due: 'Friday', priority: 'Data to be confirmed' },
    { task: 'Data to be confirmed', owner: '', due: '', priority: '' },
    { task: 'Order railings', owner: 'Maria', due: 'Data to be confirmed', priority: 'low' },
  ] } };
  const r = ts.importFromSummary(meeting);
  assert.deepStrictEqual(r, { added: 3, total: 4 });
  const list = ts.list();
  assert.strictEqual(list[0].due, '2026-10-15');
  assert.strictEqual(list[1].owner, '');
  assert.strictEqual(list[1].dueText, 'Friday');
  assert.strictEqual(list[1].priority, 'med');
  assert.strictEqual(list[2].owner, 'Maria');
  assert.ok(list.every((t) => t.source === 'summary' && t.meetingId === 'm_1'));
});

test('tasks: regenerating a summary replaces untouched imports but keeps edited and finished ones', () => {
  const ts = createTaskStore(tmp());
  const first = { id: 'm_2', summary: { action_items: [{ task: 'Alpha item', owner: '', due: '', priority: '' }, { task: 'Beta item', owner: '', due: '', priority: '' }, { task: 'Gamma item', owner: '', due: '', priority: '' }] } };
  ts.importFromSummary(first);
  const [a, b] = ts.list();
  ts.update(a.id, { done: true });
  ts.update(b.id, { title: 'Beta item (renamed)' });
  const second = { id: 'm_2', summary: { action_items: [{ task: 'Alpha item', owner: '', due: '', priority: '' }, { task: 'Gamma item reworded', owner: '', due: '', priority: '' }] } };
  ts.importFromSummary(second);
  const titles = ts.list().map((t) => t.title).sort();
  assert.deepStrictEqual(titles, ['Alpha item', 'Beta item (renamed)', 'Gamma item reworded']);
  ts.importFromSummary(second); // idempotent
  assert.strictEqual(ts.list().length, 3);
});

test('tasks: ownership matches the user by whole name words only', () => {
  assert.ok(isMine({ owner: '' }, 'Levani Sidiani'));
  assert.ok(isMine({ owner: 'me' }, ''));
  assert.ok(isMine({ owner: 'Levani' }, 'Levani Sidiani'));
  assert.ok(isMine({ owner: 'Sidiani, Levani' }, 'Levani Sidiani'));
  assert.ok(!isMine({ owner: 'Levan Kapanadze' }, 'Levani Sidiani'));
  assert.ok(!isMine({ owner: 'Maria' }, 'Levani Sidiani'));
  assert.ok(!isMine({ owner: 'Maria' }, ''));
});

// ---------- dashboard ----------
const NOW = new Date(2026, 9, 13, 9, 30); // Tuesday 13 October 2026, 9:30 local

test('dashboard: week runs Sunday to Saturday and the greeting follows the hour', () => {
  assert.deepStrictEqual(weekRange(NOW), { start: '2026-10-11', end: '2026-10-17' });
  assert.deepStrictEqual(weekRange(new Date(2026, 9, 11, 0, 5)), { start: '2026-10-11', end: '2026-10-17' });
  assert.deepStrictEqual(weekRange(new Date(2026, 9, 17, 23, 55)), { start: '2026-10-11', end: '2026-10-17' });
  assert.deepStrictEqual([dayPart(new Date(2026, 9, 13, 8)), dayPart(new Date(2026, 9, 13, 12)), dayPart(new Date(2026, 9, 13, 19))], ['morning', 'afternoon', 'evening']);
});

function task(over) {
  return { id: 't_' + Math.random(), title: 'T', priority: 'med', due: null, owner: '', done: false, doneAt: null, createdAt: '2026-10-01T00:00:00Z', source: 'manual', meetingId: null, ...over };
}

test('dashboard: tasks, progress, overdue and this-week action items', () => {
  const tasks = [
    task({ title: 'overdue', due: '2026-10-09', priority: 'high' }),
    task({ title: 'due today', due: '2026-10-13' }),
    task({ title: 'due friday', due: '2026-10-16', priority: 'low' }),
    task({ title: 'done friday', due: '2026-10-16', done: true, doneAt: '2026-10-12T10:00:00Z' }),
    task({ title: 'next week', due: '2026-10-20' }),
    task({ title: 'no date' }),
    task({ title: 'maria task', owner: 'Maria', due: '2026-10-14' }),
  ];
  const d = buildDashboard({ tasks, now: NOW, myName: 'Levani Sidiani' });
  assert.deepStrictEqual(d.tasks.open.map((t) => t.title), ['overdue', 'due today', 'due friday', 'next week', 'no date']);
  assert.deepStrictEqual(d.tasks.done.map((t) => t.title), ['done friday']);
  assert.deepStrictEqual(d.actionItems.map((t) => t.title), ['overdue', 'due today', 'due friday']);
  assert.strictEqual(d.undatedCount, 1);
  assert.strictEqual(d.progress.total, 3, 'due today, due friday and done friday are due this week');
  assert.strictEqual(d.progress.done, 1);
  assert.strictEqual(d.progress.pct, 33);
  assert.strictEqual(d.progress.overdue, 1);
  assert.ok(!d.tasks.open.some((t) => t.title === 'maria task'), "other people's tasks are not in my list");
  assert.strictEqual(buildDashboard({ now: NOW }).progress.pct, null, 'no tasks means no percentage, not 0%');
});

test('dashboard: upcoming meetings skip all-day and finished events and link to notes', () => {
  const at = (h, m = 0, day = 13) => new Date(2026, 9, day, h, m).toISOString();
  const events = [
    { id: 'e1', title: 'Earlier', start: at(8), end: at(9), allDay: false },
    { id: 'e2', title: 'Client sync', start: at(13), end: at(14), allDay: false },
    { id: 'e3', title: 'Site visit', start: new Date(2026, 9, 14).toISOString(), end: new Date(2026, 9, 15).toISOString(), allDay: true },
    { id: 'e4', title: 'UX review', start: at(15, 30), end: at(16, 30), allDay: false },
    { id: 'e5', title: 'All hands', start: at(9, 0, 14), end: at(10, 0, 14), allDay: false },
  ];
  const meetings = [{ id: 'm_9', title: 'Client sync', status: 'planned', createdAt: '2026-10-13T08:00:00Z', calendarEventId: 'e2' }];
  const d = buildDashboard({ events, meetings, now: NOW });
  assert.deepStrictEqual(d.upcoming.map((e) => e.id), ['e2', 'e4', 'e5']);
  assert.strictEqual(d.upcoming[0].meetingId, 'm_9');
  assert.strictEqual(d.upcoming[1].meetingId, null);
  assert.strictEqual(d.todayLeft, 2);
});

test('dashboard: recent meetings and latest summary', () => {
  const meetings = [
    { id: 'm_1', title: 'Old', status: 'ended', createdAt: '2026-10-01T10:00:00Z', startedAt: '2026-10-01T10:00:00Z', hasSummary: true, generatedAt: '2026-10-01T11:00:00Z', summaryText: 'Old summary', decisions: 1, actions: 2 },
    { id: 'm_2', title: 'Newest', status: 'ended', createdAt: '2026-10-12T10:00:00Z', startedAt: '2026-10-12T10:00:00Z', hasSummary: true, generatedAt: '2026-10-12T11:00:00Z', summaryText: 'New summary', decisions: 3, actions: 4, excerpt: 'New summary' },
    { id: 'm_3', title: 'Planned', status: 'planned', createdAt: '2026-10-13T07:00:00Z', hasSummary: false },
    { id: 'm_4', title: 'Mid', status: 'ended', createdAt: '2026-10-08T10:00:00Z', startedAt: '2026-10-08T10:00:00Z', hasSummary: false },
  ];
  const d = buildDashboard({ meetings, now: NOW });
  assert.deepStrictEqual(d.recent.map((m) => m.id), ['m_3', 'm_2', 'm_4']);
  assert.strictEqual(d.latestSummary.id, 'm_2');
  assert.strictEqual(d.latestSummary.decisions, 3);
  assert.strictEqual(d.progress.recorded, 1, 'only the meeting started this week');
  assert.strictEqual(d.progress.summaries, 1);
  assert.strictEqual(buildDashboard({ now: NOW }).latestSummary, null);
});

// ---------- Outlook through Microsoft Graph (simulated) ----------
function res(status, data, headers = {}) {
  return { ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] || null }, text: async () => (data === undefined ? '' : JSON.stringify(data)) };
}

function fakeMicrosoft({ pending = 2, slowDown = false, tokenError = null, grants = [] } = {}) {
  const calls = [];
  let polls = 0;
  let refreshN = 0;
  const pages = {
    one: { value: [
      { id: 'A1', subject: 'Client Sync', start: { dateTime: '2026-10-13T17:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-10-13T18:00:00.0000000', timeZone: 'UTC' }, isAllDay: false, isCancelled: false, location: { displayName: 'Room 4' }, organizer: { emailAddress: { name: 'Alex Rivera', address: 'alex@example.com' } }, attendees: [{ emailAddress: { name: 'Maria Lopez', address: 'm@example.com' } }, { emailAddress: { address: 'bob@example.com' } }], onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/abc' }, webLink: 'https://outlook.office.com/calendar/item/A1' },
      { id: 'A2', subject: 'Cancelled thing', start: { dateTime: '2026-10-13T19:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-10-13T20:00:00.0000000', timeZone: 'UTC' }, isCancelled: true },
      { id: 'A3', subject: 'Site visit day', start: { dateTime: '2026-10-14T04:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-10-15T04:00:00.0000000', timeZone: 'UTC' }, isAllDay: true, location: { displayName: '' } },
    ], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/calendarView?%24skiptoken=p2' },
    two: { value: [
      { id: 'B1', subject: '', start: { dateTime: '2026-10-14T14:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-10-14T14:30:00.0000000', timeZone: 'UTC' }, location: { displayName: 'https://zoom.us/j/555' }, onlineMeeting: null, bodyPreview: 'agenda' },
      { id: 'B2', subject: 'Phishy invite', start: { dateTime: '2026-10-14T15:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-10-14T16:00:00.0000000', timeZone: 'UTC' }, location: { displayName: '' }, onlineMeeting: { joinUrl: 'https://evil.example/teams/join' }, bodyPreview: 'Join at https://evil.example/zoom' },
    ] },
  };
  async function fetchImpl(url, opts = {}) {
    const u = new URL(url);
    const body = opts.body ? Object.fromEntries(new URLSearchParams(opts.body)) : {};
    calls.push({ url, method: opts.method || 'GET', body, headers: opts.headers || {} });
    if (u.host === 'login.microsoftonline.com') {
      if (u.pathname.endsWith('/devicecode')) {
        if (body.client_id === '11111111-1111-1111-1111-111111111111') return res(400, { error: 'invalid_request', error_description: 'AADSTS700016: Application with identifier was not found in the directory. Trace ID: abc' });
        return res(200, { device_code: 'DEVCODE', user_code: 'ABCD-EFGH', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900, interval: 5 });
      }
      if (u.pathname.endsWith('/token')) {
        if (body.grant_type === 'urn:ietf:params:oauth:grant-type:device_code') {
          polls += 1;
          if (tokenError) return res(400, { error: tokenError, error_description: 'x' });
          if (polls <= pending) return res(400, { error: 'authorization_pending' });
          if (slowDown && polls === pending + 1) return res(400, { error: 'slow_down' });
          return res(200, { access_token: 'ACCESS1', refresh_token: 'REFRESH1', expires_in: 3600 });
        }
        grants.push(body.refresh_token);
        if (body.refresh_token === 'REVOKED') return res(400, { error: 'invalid_grant', error_description: 'AADSTS70000: expired' });
        refreshN += 1;
        return res(200, { access_token: 'ACCESS' + (refreshN + 1), refresh_token: 'REFRESH' + (refreshN + 1), expires_in: 3600 });
      }
    }
    if (u.host === 'graph.microsoft.com') {
      const auth = (opts.headers || {}).Authorization;
      if (auth === 'Bearer EXPIRED') return res(401, { error: { message: 'token expired' } });
      if (auth === 'Bearer DENIED') return res(403, { error: { message: 'no' } });
      if (u.pathname === '/v1.0/me') return res(200, { displayName: 'Levani S', mail: 'levani@example.com' });
      if (u.pathname === '/v1.0/me/calendarView') return res(200, u.searchParams.get('$skiptoken') === 'p2' ? pages.two : pages.one);
    }
    return res(404, { error: { message: 'unexpected ' + url } });
  }
  return { fetchImpl, calls };
}

function makeOutlook(ms, extra = {}) {
  let refresh = extra.refresh || null;
  let clock = 1_000_000;
  const saved = [];
  const o = outlook.createOutlook({
    getConfig: () => ({ clientId: 'clientId' in extra ? extra.clientId : '22222222-2222-2222-2222-222222222222', tenant: 'common' }),
    loadRefresh: () => refresh,
    saveRefresh: (t) => { refresh = t; saved.push(t); },
    fetchImpl: ms.fetchImpl,
    now: () => clock,
    sleep: async (msec) => { clock += msec; },
  });
  return { o, saved, advance: (ms2) => { clock += ms2; }, get refresh() { return refresh; } };
}

test('outlook: device code sign-in waits through pending and slow_down, then stores only the refresh token', async () => {
  const ms = fakeMicrosoft({ pending: 2, slowDown: true });
  const h = makeOutlook(ms);
  let shown = null;
  const r = await h.o.connect({ onCode: (c) => { shown = c; } });
  assert.deepStrictEqual(shown, { userCode: 'ABCD-EFGH', verificationUri: 'https://microsoft.com/devicelogin', expiresIn: 900 });
  assert.strictEqual(r.account, 'levani@example.com');
  assert.strictEqual(h.refresh, 'REFRESH1');
  const polls = ms.calls.filter((c) => c.body.grant_type && c.body.grant_type.includes('device_code'));
  assert.strictEqual(polls.length, 4);
  assert.ok(polls.every((c) => c.body.device_code === 'DEVCODE' && !('client_secret' in c.body)), 'public client: no secret is sent');
  const dc = ms.calls.find((c) => c.url.endsWith('/devicecode'));
  assert.match(dc.body.scope, /Calendars\.Read/);
  assert.ok(!/ReadWrite/.test(dc.body.scope), 'read-only calendar access');
  assert.strictEqual(h.o.connected(), true);
});

test('outlook: sign-in problems come back as plain guidance', async () => {
  const bad = makeOutlook(fakeMicrosoft(), { clientId: '11111111-1111-1111-1111-111111111111' });
  await assert.rejects(() => bad.o.connect(), /does not recognise this Application \(client\) ID/);
  await assert.rejects(() => makeOutlook(fakeMicrosoft({ tokenError: 'authorization_declined' })).o.connect(), /declined/);
  await assert.rejects(() => makeOutlook(fakeMicrosoft({ tokenError: 'expired_token' })).o.connect(), /expired/);
  const none = makeOutlook(fakeMicrosoft(), { clientId: '' });
  await assert.rejects(() => none.o.connect(), /Application \(client\) ID/);
  assert.match(outlook.authMessage({ error_description: 'AADSTS7000218: The request body must contain client_assertion' }), /public client flows/);
  assert.match(outlook.authMessage({ error_description: 'AADSTS65001: not consented' }), /administrator/);
});

test('outlook: cancelling stops the wait', async () => {
  const ms = fakeMicrosoft({ pending: 1000 });
  const ctl = new AbortController();
  let n = 0;
  const o = outlook.createOutlook({
    getConfig: () => ({ clientId: '22222222-2222-2222-2222-222222222222', tenant: 'common' }),
    loadRefresh: () => null, saveRefresh: () => {}, fetchImpl: ms.fetchImpl, now: () => 0,
    sleep: async () => { n += 1; if (n === 3) ctl.abort(); },
  });
  await assert.rejects(() => o.connect({ signal: ctl.signal }), /cancelled/);
});

test('outlook: cancellation during the initial network request prevents showing a code or saving a token', async () => {
  const ctl = new AbortController();
  let shown = false;
  let saved = false;
  const o = outlook.createOutlook({
    getConfig: () => ({ clientId: '22222222-2222-2222-2222-222222222222' }),
    loadRefresh: () => null, saveRefresh: () => { saved = true; },
    fetchImpl: async (url, opts) => {
      assert.equal(opts.signal, ctl.signal);
      ctl.abort();
      return res(200, { device_code: 'D', user_code: 'U' });
    },
  });
  await assert.rejects(o.connect({ signal: ctl.signal, onCode: () => { shown = true; } }), /cancelled/);
  assert.equal(shown, false);
  assert.equal(saved, false);
});

test('outlook: all-day events retain their original date across extreme time zones and Windows names', () => {
  for (const [zone, start] of [['Pacific/Kiritimati', '2026-10-13T10:00:00'], ['Pacific/Pago_Pago', '2026-10-14T11:00:00'], ['Eastern Standard Time', '2026-10-14T04:00:00']]) {
    const event = outlook.normalizeGraphEvent({ id: zone, isAllDay: true, originalStartTimeZone: zone, start: { dateTime: start, timeZone: 'UTC' }, end: { dateTime: new Date(new Date(start + 'Z').getTime() + 86400000).toISOString(), timeZone: 'UTC' } });
    assert.equal(ymd(new Date(event.start)), '2026-10-14');
    assert.equal(ymd(new Date(event.end)), '2026-10-15');
  }
});

test('services: linked notes are reused, and disconnected calendars cannot repopulate stale events', async () => {
  const { createServices } = require('../src/services');
  const store = createStore(tmp(), cipher);
  const tasks = createTaskStore(tmp());
  const start = new Date('2026-10-13T17:00:00Z');
  const end = new Date('2026-10-13T18:00:00Z');
  let connected = true;
  let finish;
  const event = { id: 'E', title: 'Calendar notes', start: start.toISOString(), end: end.toISOString(), attendees: ['Alice'] };
  const service = createServices({ store, tasks, outlook: { connected: () => connected, events: () => Promise.resolve([event]) } });
  await service.calendarEvents({ from: start, to: end });
  const first = service.meetingFromEvent('E');
  const second = service.meetingFromEvent('E');
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.id, second.id);
  assert.equal(store.get(first.id).attendees, 'Alice');
  const stale = createServices({ store, tasks, outlook: { connected: () => connected, events: () => new Promise(r => { finish = r; }) } });
  const loading = stale.calendarEvents({ from: start, to: end });
  connected = false; stale.clearCalendarCache(); finish([{ ...event, id: 'STALE' }]);
  assert.deepEqual((await loading).events, []);
  assert.throws(() => stale.meetingFromEvent('STALE'), /no longer available/);
});

test('outlook: events are read-only, paged, converted and cleaned', async () => {
  const ms = fakeMicrosoft();
  const h = makeOutlook(ms, { refresh: 'REFRESH0' });
  const events = await h.o.events(new Date('2026-10-12T04:00:00Z'), new Date('2026-10-26T04:00:00Z'));
  assert.deepStrictEqual(events.map((e) => e.id), ['A1', 'A3', 'B1', 'B2'], 'cancelled event dropped, both pages read, sorted by start');
  const a1 = events[0];
  assert.strictEqual(a1.start, '2026-10-13T17:00:00.000Z');
  assert.strictEqual(a1.joinUrl, 'https://teams.microsoft.com/l/meetup-join/abc');
  assert.deepStrictEqual(a1.attendees, ['Maria Lopez', 'bob@example.com']);
  assert.strictEqual(a1.organizer, 'Alex Rivera');
  const a3 = events[1];
  assert.strictEqual(a3.allDay, true);
  assert.strictEqual(ymd(new Date(a3.start)), '2026-10-14');
  assert.strictEqual(ymd(new Date(a3.end)), '2026-10-15');
  assert.strictEqual(events[2].title, '(No title)');
  assert.strictEqual(events[2].joinUrl, 'https://zoom.us/j/555', 'a Zoom link in the location is found');
  assert.strictEqual(events[3].joinUrl, null, 'a join link to an unknown site is dropped');
  const req = ms.calls.find((c) => c.url.includes('calendarView'));
  assert.strictEqual(req.headers.Prefer, 'outlook.timezone="UTC"');
  assert.match(req.headers.Authorization, /^Bearer ACCESS2$/);
  assert.strictEqual(h.refresh, 'REFRESH2', 'the rotated refresh token is saved');
  assert.ok(ms.calls.every((c) => c.method === 'GET' || new URL(c.url).host === 'login.microsoftonline.com'), 'no writes to the calendar');
});

test('outlook: an expired access token is refreshed once; a revoked sign-in asks to reconnect', async () => {
  const ms = fakeMicrosoft();
  const h = makeOutlook(ms, { refresh: 'REFRESH0' });
  await h.o.events(new Date('2026-10-12T04:00:00Z'), new Date('2026-10-26T04:00:00Z'));
  await h.o.events(new Date('2026-10-12T04:00:00Z'), new Date('2026-10-26T04:00:00Z'));
  assert.strictEqual(ms.calls.filter((c) => c.body.grant_type === 'refresh_token').length, 1, 'access token reused while valid');
  h.advance(2 * 3600 * 1000);
  await h.o.events(new Date('2026-10-12T04:00:00Z'), new Date('2026-10-26T04:00:00Z'));
  assert.strictEqual(ms.calls.filter((c) => c.body.grant_type === 'refresh_token').length, 2);
  const revoked = makeOutlook(fakeMicrosoft(), { refresh: 'REVOKED' });
  await assert.rejects(() => revoked.o.events(new Date(), new Date(Date.now() + 1e6)), /Connect again in Settings/);
});

test('outlook: a next-page link that points anywhere but Graph is refused, and the token is never sent there', async () => {
  const seen = [];
  const fetchImpl = async (url, opts = {}) => {
    seen.push({ url, auth: (opts.headers || {}).Authorization });
    if (url.includes('login.microsoftonline.com')) return res(200, { access_token: 'SECRET-ACCESS', refresh_token: 'R', expires_in: 3600 });
    return res(200, { value: [], '@odata.nextLink': 'https://evil.example/steal' });
  };
  const o = outlook.createOutlook({ getConfig: () => ({ clientId: '22222222-2222-2222-2222-222222222222', tenant: 'common' }), loadRefresh: () => 'R', saveRefresh: () => {}, fetchImpl });
  await assert.rejects(() => o.events(new Date(), new Date(Date.now() + 1e6)), /Unexpected address/);
  assert.ok(!seen.some((s) => s.url.includes('evil.example')));
});

test('outlook: permission and throttling errors are explained', async () => {
  const mk = (status) => outlook.createOutlook({
    getConfig: () => ({ clientId: '22222222-2222-2222-2222-222222222222', tenant: 'common' }), loadRefresh: () => 'R', saveRefresh: () => {},
    fetchImpl: async (url) => (url.includes('login.microsoftonline.com') ? res(200, { access_token: 'T', expires_in: 3600 }) : res(status, { error: { message: 'x' } })),
  });
  await assert.rejects(() => mk(403).events(new Date(), new Date(Date.now() + 1e6)), /administrator approval/);
  await assert.rejects(() => mk(429).events(new Date(), new Date(Date.now() + 1e6)), /busy/);
});

// ---------- calendar link (.ics) ----------
const SAMPLE_ICS = `BEGIN:VCALENDAR
PRODID:-//Microsoft Corporation//Outlook 16.0 MIMEDIR//EN
VERSION:2.0
METHOD:PUBLISH
BEGIN:VTIMEZONE
TZID:Eastern Standard Time
BEGIN:STANDARD
DTSTART:16010101T020000
TZOFFSETFROM:-0400
TZOFFSETTO:-0500
RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=1SU;BYMONTH=11
END:STANDARD
BEGIN:DAYLIGHT
DTSTART:16010101T020000
TZOFFSETFROM:-0500
TZOFFSETTO:-0400
RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=2SU;BYMONTH=3
END:DAYLIGHT
END:VTIMEZONE
BEGIN:VEVENT
UID:weekly-ops
SUMMARY:Weekly operations review
DTSTART;TZID=Eastern Standard Time:20261005T100000
DTEND;TZID=Eastern Standard Time:20261005T110000
RRULE:FREQ=WEEKLY;BYDAY=MO
EXDATE;TZID=Eastern Standard Time:20261019T100000
LOCATION:https://zoom.us/j/123456789
END:VEVENT
BEGIN:VEVENT
UID:allday
SUMMARY:Site visit day
DTSTART;VALUE=DATE:20261014
DTEND;VALUE=DATE:20261015
END:VEVENT
BEGIN:VEVENT
UID:cancelled
SUMMARY:Cancelled
STATUS:CANCELLED
DTSTART:20261013T200000Z
DTEND:20261013T203000Z
END:VEVENT
BEGIN:VEVENT
UID:oneoff
SUMMARY:Vendor call
DTSTART:20261013T180000Z
DTEND:20261013T183000Z
ORGANIZER;CN="Alex Rivera":mailto:alex@example.com
ATTENDEE;CN="Maria Lopez":mailto:maria@example.com
DESCRIPTION:Join https://teams.microsoft.com/l/meetup-join/xyz
END:VEVENT
END:VCALENDAR
`;

test('ics: recurring meetings, exceptions, time zones, all-day and cancelled events', () => {
  const from = new Date('2026-10-12T04:00:00Z');
  const to = new Date('2026-11-03T12:00:00Z');
  const events = ics.toEvents(SAMPLE_ICS, from, to);
  const weekly = events.filter((e) => e.title === 'Weekly operations review').map((e) => e.start);
  assert.deepStrictEqual(weekly, ['2026-10-12T14:00:00.000Z', '2026-10-26T14:00:00.000Z', '2026-11-02T15:00:00.000Z'], 'Oct 19 is excluded; the clocks change on Nov 1');
  assert.strictEqual(events.find((e) => e.title === 'Weekly operations review').joinUrl, 'https://zoom.us/j/123456789');
  const allDay = events.find((e) => e.title === 'Site visit day');
  assert.strictEqual(allDay.allDay, true);
  assert.strictEqual(ymd(new Date(allDay.start)), '2026-10-14');
  assert.ok(!events.some((e) => e.title === 'Cancelled'));
  const vendor = events.find((e) => e.title === 'Vendor call');
  assert.strictEqual(vendor.organizer, 'Alex Rivera');
  assert.deepStrictEqual(vendor.attendees, ['Maria Lopez']);
  assert.strictEqual(vendor.joinUrl, 'https://teams.microsoft.com/l/meetup-join/xyz');
  assert.strictEqual(new Set(events.map((e) => e.id)).size, events.length, 'every occurrence has its own id');
});

test('ics: fetching explains broken links', async () => {
  const ok = async () => ({ ok: true, status: 200, text: async () => SAMPLE_ICS });
  const events = await ics.fetchEvents('webcal://example.com/cal.ics', new Date('2026-10-12T04:00:00Z'), new Date('2026-10-20T04:00:00Z'), ok);
  assert.ok(events.length >= 3);
  await assert.rejects(() => ics.fetchEvents('https://example.com/c.ics', new Date(), new Date(), async () => ({ ok: false, status: 404, text: async () => '' })), /no longer works/);
  await assert.rejects(() => ics.fetchEvents('https://example.com/c.ics', new Date(), new Date(), async () => ({ ok: true, status: 200, text: async () => '<html>login</html>' })), /did not return a calendar/);
  await assert.rejects(() => ics.fetchEvents('http://example.com/c.ics', new Date(), new Date(), ok), /https/);
});

// ---------- settings and meeting records ----------
test('store: calendar settings are validated, encrypted and never returned', () => {
  const dir = tmp();
  const s = createStore(dir, cipher);
  assert.throws(() => s.setSettings({ outlookClientId: 'abc' }), /Application \(client\) ID/);
  assert.throws(() => s.setSettings({ outlookTenant: 'bad tenant!' }), /tenant/);
  assert.throws(() => s.setSettings({ icsUrl: 'http://x.example/a.ics' }), /https/);
  const out = s.setSettings({ outlookClientId: '22222222-2222-2222-2222-222222222222', outlookTenant: 'contoso.com', icsUrl: 'webcal://outlook.office365.com/owa/calendar/KEY123/reachcalendar.ics', myName: 'Levani Sidiani', autoTasks: false });
  assert.strictEqual(out.outlookTenant, 'contoso.com');
  assert.strictEqual(out.hasIcs, true);
  assert.strictEqual(out.autoTasks, false);
  assert.ok(!JSON.stringify(out).includes('KEY123'), 'the private calendar key is not returned to the window');
  assert.strictEqual(s.getIcsUrl(), 'https://outlook.office365.com/owa/calendar/KEY123/reachcalendar.ics');
  assert.ok(!fs.readFileSync(path.join(dir, 'settings.json'), 'utf8').includes('KEY123'), 'stored encrypted');
});

test('store: the saved Outlook sign-in is dropped when the app registration or tenant changes', () => {
  const dir = tmp();
  const s = createStore(dir, cipher);
  s.setSettings({ outlookClientId: '22222222-2222-2222-2222-222222222222', outlookTenant: 'common' });
  s.setOutlookRefresh('REFRESH-SECRET', 'me@example.com');
  assert.strictEqual(s.getSettings().hasOutlook, true);
  assert.strictEqual(s.getSettings().outlookAccount, 'me@example.com');
  assert.ok(!fs.readFileSync(path.join(dir, 'settings.json'), 'utf8').includes('REFRESH-SECRET'), 'stored encrypted');
  s.setSettings({ outlookClientId: '22222222-2222-2222-2222-222222222222', outlookTenant: 'common', myName: 'X' });
  assert.strictEqual(s.getSettings().hasOutlook, true, 'saving unchanged values keeps the sign-in');
  s.setSettings({ outlookTenant: 'contoso.com' });
  assert.strictEqual(s.getSettings().hasOutlook, false);
  assert.strictEqual(s.getSettings().outlookAccount, '');
  s.setOutlookRefresh('R2', 'me@example.com');
  s.setOutlookRefresh(null);
  assert.strictEqual(s.getOutlookRefresh(), null);
});

test('store: meetings created from a calendar event can be found again, and the list carries dashboard fields', () => {
  const s = createStore(tmp(), cipher);
  const m = s.create({ title: 'Client Sync', attendees: 'Maria', calendarEventId: 'AAMk=' });
  assert.strictEqual(s.findByCalendarEvent('AAMk=').id, m.id);
  assert.strictEqual(s.findByCalendarEvent('other'), null);
  s.addNote(m.id, { t: 5, text: 'Roof inspection moved to Thursday' });
  let row = s.list()[0];
  assert.strictEqual(row.excerpt, 'Roof inspection moved to Thursday');
  assert.strictEqual(row.calendarEventId, 'AAMk=');
  s.setSummary(m.id, { executive_summary: 'Inspection moves to Thursday. Permit still open.', decisions: [{}, {}], action_items: [{}, {}, {}] });
  row = s.list()[0];
  assert.strictEqual(row.excerpt, 'Inspection moves to Thursday. Permit still open.');
  assert.deepStrictEqual([row.decisions, row.actions, row.hasSummary], [2, 3, true]);
  s.setSummary(m.id, { executive_summary: 'Data to be confirmed', decisions: [], action_items: [] });
  assert.strictEqual(s.list()[0].summaryText, '', 'a placeholder summary is not shown as text');
});
