'use strict';
// Dashboard, task and calendar logic behind the window's requests. No Electron here, so it is testable.
const { isMine } = require('./tasks');
const { buildDashboard } = require('./dashboard');
const icsCal = require('./ics');

const CAL_TTL_MS = 5 * 60 * 1000;

function createServices({ store, tasks, outlook, outlookDesktop = null, fetchIcs = icsCal.fetchEvents, now = () => new Date() }) {
  const eventCache = new Map();  // range key -> { at, events }
  const eventsById = new Map();  // id -> event, so the window can refer to an event by id only
  let generation = 0;

  function calendarSource() {
    if (outlook && outlook.connected()) return 'outlook';
    if (outlookDesktop && outlookDesktop.enabled()) return 'outlook-desktop';
    if (store.getIcsUrl()) return 'ics';
    return null;
  }

  function clearCalendarCache() {
    generation++;
    eventCache.clear();
    eventsById.clear();
  }

  async function getEvents(from, to, force) {
    const requestGeneration = generation;
    const source = calendarSource();
    if (!source) return { events: [], source: null };
    const key = `${source}|${from.toISOString()}|${to.toISOString()}`;
    const hit = eventCache.get(key);
    if (hit && !force && now().getTime() - hit.at < CAL_TTL_MS) return { events: hit.events, source };
    try {
      const events = source === 'outlook'
        ? await outlook.events(from, to)
        : source === 'outlook-desktop'
          ? await outlookDesktop.events(from, to)
          : await fetchIcs(store.getIcsUrl(), from, to);
      if (requestGeneration !== generation) return { events: [], source: calendarSource() };
      eventCache.set(key, { at: now().getTime(), events });
      for (const e of events) eventsById.set(e.id, e);
      return { events, source };
    } catch (e) {
      if (requestGeneration !== generation) return { events: [], source: calendarSource() };
      return { events: hit ? hit.events : [], source, error: String((e && e.message) || e) };
    }
  }

  function parseRange(range) {
    const from = new Date(range && range.from);
    const to = new Date(range && range.to);
    if (isNaN(from) || isNaN(to) || to <= from || to - from > 120 * 24 * 3600 * 1000) throw new Error('Invalid date range.');
    return { from, to };
  }

  function listTasks() {
    const myName = store.getSettings().myName;
    return tasks.list().map((t) => ({ ...t, mine: isMine(t, myName) }));
  }

  async function dashboard(opts) {
    const n = now();
    const settings = store.getSettings();
    const weekStartsOn = settings.weekStart === 'sunday' ? 0 : 1;
    const back = (n.getDay() - weekStartsOn + 7) % 7;
    const weekStart = new Date(n.getFullYear(), n.getMonth(), n.getDate() - back);
    const to = new Date(n.getFullYear(), n.getMonth(), n.getDate() + 14);
    const cal = await getEvents(weekStart, to, Boolean(opts && opts.force));
    const data = buildDashboard({ meetings: store.list(), tasks: tasks.list(), events: cal.events, now: n, myName: settings.myName, weekStartsOn });
    data.calendar = { source: cal.source, error: cal.error || null, account: settings.outlookAccount || '' };
    return data;
  }

  async function calendarEvents(range) {
    const { from, to } = parseRange(range);
    const r = await getEvents(from, to, Boolean(range && range.force));
    return { events: r.events, source: r.source, error: r.error || null };
  }

  function meetingFromEvent(eventId) {
    const existing = store.findByCalendarEvent(String(eventId));
    if (existing) return { id: existing.id, created: false };
    const ev = eventsById.get(String(eventId));
    if (!ev) throw new Error('That calendar event is no longer available. Refresh the calendar and try again.');
    const m = store.create({ title: ev.title, attendees: (ev.attendees || []).join(', '), agendaPre: '', calendarEventId: ev.id });
    return { id: m.id, created: true };
  }

  return { calendarSource, clearCalendarCache, listTasks, dashboard, calendarEvents, meetingFromEvent };
}

module.exports = { createServices };
