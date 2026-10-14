'use strict';
// Builds everything the dashboard shows from meetings, tasks and calendar events.
// Pure function: no Electron, no disk, no network, so it can be tested directly.
const { isMine, ymd } = require('./tasks');

// weekStartsOn: 0 for Sunday to Saturday, 1 for Monday to Sunday (Settings > Week starts on).
function weekRange(now, weekStartsOn = 0) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const back = (d.getDay() - weekStartsOn + 7) % 7;
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - back);
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
  return { start: ymd(start), end: ymd(end) };
}

function dayPart(now) {
  const h = now.getHours();
  return h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening';
}

const PRI = { high: 0, med: 1, low: 2 };
function byDue(a, b) {
  if (a.due && b.due && a.due !== b.due) return a.due < b.due ? -1 : 1;
  if (a.due && !b.due) return -1;
  if (!a.due && b.due) return 1;
  if (PRI[a.priority] !== PRI[b.priority]) return PRI[a.priority] - PRI[b.priority];
  return a.createdAt < b.createdAt ? -1 : 1;
}

function meetingDate(m) { return m.startedAt || m.createdAt || ''; }

function buildDashboard({ meetings = [], tasks = [], events = [], now = new Date(), myName = '', weekStartsOn = 0 } = {}) {
  const today = ymd(now);
  const week = weekRange(now, weekStartsOn);
  const inWeek = (iso) => {
    if (!iso) return false;
    const d = ymd(new Date(iso));
    return d >= week.start && d <= week.end;
  };

  const mine = tasks.filter((t) => isMine(t, myName));
  const open = mine.filter((t) => !t.done).sort(byDue);
  const done = mine.filter((t) => t.done).sort((a, b) => (a.doneAt || '') < (b.doneAt || '') ? 1 : -1);
  const dueThisWeek = mine.filter((t) => t.due && t.due >= week.start && t.due <= week.end);
  const weekDone = dueThisWeek.filter((t) => t.done).length;
  const overdue = open.filter((t) => t.due && t.due < today);
  const actionItems = open.filter((t) => t.due && t.due <= week.end);

  const sortedMeetings = [...meetings].sort((a, b) => (meetingDate(a) < meetingDate(b) ? 1 : -1));
  const linked = new Map();
  for (const m of meetings) if (m.calendarEventId) linked.set(m.calendarEventId, m.id);

  const withSummary = meetings.filter((m) => m.hasSummary && m.generatedAt).sort((a, b) => (a.generatedAt < b.generatedAt ? 1 : -1));
  const latest = withSummary[0] || null;

  const nowMs = now.getTime();
  const timed = events.filter((e) => !e.allDay);
  const upcoming = timed
    .filter((e) => new Date(e.end).getTime() > nowMs)
    .sort((a, b) => new Date(a.start) - new Date(b.start))
    .slice(0, 5)
    .map((e) => ({ ...e, meetingId: linked.get(e.id) || null }));
  const todayLeft = timed.filter((e) => ymd(new Date(e.start)) === today && new Date(e.end).getTime() > nowMs).length;
  const weekEvents = timed.filter((e) => inWeek(e.start)).length;

  return {
    greeting: { part: dayPart(now), name: String(myName || '').trim().split(/\s+/)[0] || '' },
    week,
    weekStartsOn,
    today,
    recent: sortedMeetings.slice(0, 3).map((m) => ({
      id: m.id, title: m.title, date: meetingDate(m), status: m.status,
      hasSummary: m.hasSummary, excerpt: m.excerpt || '', decisions: m.decisions || 0, actions: m.actions || 0,
    })),
    tasks: { open: open.slice(0, 8), done: done.slice(0, 8), openCount: open.length, doneCount: done.length },
    actionItems: actionItems.slice(0, 8),
    actionItemCount: actionItems.length,
    undatedCount: open.filter((t) => !t.due).length,
    progress: {
      total: dueThisWeek.length,
      done: weekDone,
      pct: dueThisWeek.length ? Math.round((weekDone / dueThisWeek.length) * 100) : null,
      overdue: overdue.length,
      recorded: meetings.filter((m) => m.startedAt && inWeek(m.startedAt)).length,
      summaries: meetings.filter((m) => m.hasSummary && inWeek(m.generatedAt)).length,
      calendarMeetings: weekEvents,
    },
    latestSummary: latest && {
      id: latest.id, title: latest.title, when: latest.generatedAt,
      text: latest.summaryText || '', decisions: latest.decisions || 0, actions: latest.actions || 0,
    },
    upcoming,
    todayLeft,
  };
}

module.exports = { buildDashboard, weekRange, dayPart };
