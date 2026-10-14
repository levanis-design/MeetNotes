'use strict';
// Dashboard, calendar and task views. Everything shown from calendar invites is set with textContent
// (never as HTML), because invites are written by other people.
(function () {
  const $ = (id) => document.getElementById(id);
  const api = window.api;
  const MN = () => window.MN;

  const S = {
    data: null,
    tab: 'todo',
    month: firstOfMonth(new Date()),
    selected: null,          // 'YYYY-MM-DD' of a clicked calendar day, or null
    monthEvents: [],
    monthError: null,
    tasks: [],
    filter: 'open',
    view: null,
    loadTimer: null,
    lastLoad: 0,
    monthRequest: 0,
    dashboardRequest: 0,
  };

  // ---------- small helpers ----------
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  function firstOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  const err = (e) => (MN() ? MN().errText(e) : String(e));
  const toast = (m, bad, ms) => MN() && MN().toast(m, bad, ms);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + 's'}`;
  const fmtTime = (iso) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const PRI_LABEL = { high: 'High', med: 'Med', low: 'Low' };
  const PRI_ORDER = { high: 0, med: 1, low: 2 };

  function dueInfo(t) {
    if (!t.due) return { text: t.dueText ? `Due ${t.dueText}` : '', over: false };
    const now = new Date();
    const today = ymd(now);
    const tomorrow = ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
    const d = new Date(t.due + 'T00:00:00');
    const short = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    if (t.due === today) return { text: 'Due today', over: false };
    if (t.due === tomorrow) return { text: 'Due tomorrow', over: false };
    if (t.due < today) return { text: `Overdue · ${short}`, over: true };
    return { text: `Due ${short}`, over: false };
  }

  const PALETTE = ['#0f8078', '#3b5bdb', '#9c4a1a', '#7a3e9d', '#a3265c', '#4b6a1c'];
  function avatar(name) {
    const initials = String(name).replace(/@.*$/, '').split(/[\s.]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
    let h = 0;
    for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    const a = el('span', 'av', initials);
    a.style.background = PALETTE[h % PALETTE.length];
    a.title = name;
    return a;
  }

  // ---------- tasks (shared by dashboard and tasks page) ----------
  async function setDone(task, done) {
    try {
      await api.updateTask(task.id, { done });
      tasksChanged();
    } catch (e) { toast(err(e), true); }
  }

  function dashTaskRow(t, showSource) {
    const li = el('li', 'task' + (t.done ? ' done' : ''));
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = Boolean(t.done);
    cb.setAttribute('aria-label', (t.done ? 'Mark not done: ' : 'Mark done: ') + t.title);
    cb.addEventListener('change', () => setDone(t, cb.checked));
    const mid = el('div', 't-title');
    mid.append(document.createTextNode(t.title));
    mid.title = t.title;
    if (showSource) {
      const from = t.meetingId && MN() ? MN().meetingTitle(t.meetingId) : '';
      if (from) mid.append(el('span', 't-sub', 'From ' + from));
    }
    const side = el('div', 't-side');
    if (!t.done) {
      side.append(el('span', 'chip ' + t.priority, PRI_LABEL[t.priority] || 'Med'));
      const di = dueInfo(t);
      if (di.text) side.append(el('span', 'due' + (di.over ? ' over' : ''), di.text));
    }
    li.append(cb, mid, side);
    return li;
  }

  // ---------- dashboard ----------
  function renderGreeting(d) {
    const g = d.greeting;
    $('greet').textContent = `Good ${g.part}${g.name ? ', ' + g.name : ''}`;
    const parts = [];
    if (d.calendar && d.calendar.source) parts.push(`${plural(d.todayLeft, 'meeting')} left today`);
    parts.push(d.tasks.openCount ? plural(d.tasks.openCount, 'open task') : 'No open tasks');
    if (d.progress.overdue) parts.push(`${d.progress.overdue} overdue`);
    $('greetSub').textContent = parts.join(' · ');
  }

  function renderRecent(d) {
    const ul = $('recentNotes');
    ul.textContent = '';
    $('recentEmpty').hidden = d.recent.length > 0;
    for (const m of d.recent) {
      const when = new Date(m.date);
      const li = el('li');
      const db = el('div', 'datebox');
      db.append(document.createTextNode(isNaN(when) ? '' : when.toLocaleDateString('en-US', { month: 'short' })));
      db.append(el('b', null, isNaN(when) ? '' : String(when.getDate())));
      const body = el('div');
      body.style.minWidth = '0';
      body.append(el('div', 'rn-title', m.title));
      body.append(el('div', 'rn-text' + (m.excerpt ? '' : ' none'), m.excerpt || 'No notes yet'));
      const tag = el('span', 'rn-tag' + (m.status === 'live' ? ' live' : ''),
        m.status === 'live' ? 'Recording now' : m.hasSummary ? 'Summarized' : m.status === 'ended' ? 'Ended' : 'Planned');
      body.append(tag);
      const btn = el('button', null, 'View note');
      btn.type = 'button';
      btn.addEventListener('click', () => MN().openMeeting(m.id, { tab: m.hasSummary ? 'summary' : 'meeting' }));
      li.append(db, body, btn);
      ul.append(li);
    }
  }

  function renderDashTasks(d) {
    const done = S.tab === 'done';
    const list = done ? d.tasks.done : d.tasks.open;
    $('tdTodo').classList.toggle('active', !done);
    $('tdDone').classList.toggle('active', done);
    $('tdTodo').setAttribute('aria-selected', String(!done));
    $('tdDone').setAttribute('aria-selected', String(done));
    $('tdHeading').textContent = done ? `Recently completed (${d.tasks.doneCount})` : `Open tasks (${d.tasks.openCount})`;
    const ul = $('dashTasks');
    ul.textContent = '';
    list.forEach((t) => ul.append(dashTaskRow(t, true)));
    const empty = $('dashTasksEmpty');
    empty.hidden = list.length > 0;
    empty.textContent = done ? 'Nothing completed yet.' : 'Nothing open. Add a task below.';
    if (!done && d.tasks.openCount > list.length) {
      const more = el('li');
      more.style.padding = '8px 0';
      const b = el('button', 'link', `Show ${d.tasks.openCount - list.length} more`);
      b.type = 'button';
      b.addEventListener('click', () => MN().showView('tasks'));
      more.append(b);
      ul.append(more);
    }
  }

  function renderProgress(d) {
    const p = d.progress;
    $('progFill').style.width = (p.pct == null ? 0 : p.pct) + '%';
    $('progBar').setAttribute('aria-valuenow', String(p.pct == null ? 0 : p.pct));
    $('progPct').textContent = p.pct == null ? '0%' : p.pct + '%';
    $('progLabel').textContent = p.pct == null
      ? 'No tasks are due this week yet.'
      : `${p.done} of ${plural(p.total, 'task')} due this week ${p.done === 1 ? 'is' : 'are'} complete.`;
    const rows = [['Meetings recorded this week', p.recorded], ['Summaries generated this week', p.summaries]];
    if (d.calendar && d.calendar.source) rows.push(['Calendar meetings this week', p.calendarMeetings]);
    rows.push(['Overdue tasks', p.overdue, p.overdue > 0], ['Open tasks without a due date', d.undatedCount]);
    const ul = $('progStats');
    ul.textContent = '';
    for (const [label, value, bad] of rows) {
      const li = el('li');
      li.append(el('span', null, label), el('b', bad ? 'bad' : null, String(value)));
      ul.append(li);
    }
    const ls = d.latestSummary;
    $('latestSummary').hidden = !ls;
    if (ls) {
      $('latestTitle').textContent = ls.title;
      $('latestText').textContent = ls.text || 'Summary generated. Open it to read the details.';
      $('latestMeta').textContent = `${plural(ls.decisions, 'decision')} · ${plural(ls.actions, 'action item')}`;
      $('latestOpen').onclick = () => MN().openMeeting(ls.id, { tab: 'summary' });
    }
  }

  function renderWeek(d) {
    const ul = $('weekItems');
    ul.textContent = '';
    d.actionItems.forEach((t) => ul.append(dashTaskRow(t, true)));
    const empty = $('weekEmpty');
    empty.hidden = d.actionItems.length > 0;
    empty.textContent = d.tasks.openCount
      ? 'Nothing is due this week. Set due dates in Tasks to see them here.'
      : 'No action items yet. They appear here when a summary is generated or you add a task.';
    if (d.actionItemCount > d.actionItems.length) {
      const li = el('li');
      li.style.padding = '8px 0';
      li.append(el('span', 'muted', `${d.actionItemCount - d.actionItems.length} more in Tasks`));
      ul.append(li);
    }
  }

  function renderCalChip(d) {
    const chip = $('calChip');
    const c = d.calendar || {};
    chip.className = 'cal-chip';
    if (c.error) {
      chip.classList.add('warn');
      chip.textContent = 'Calendar problem';
      chip.title = c.error;
    } else if (c.source === 'outlook') {
      chip.classList.add('ok');
      chip.textContent = c.account ? `Outlook · ${c.account}` : 'Outlook connected';
      chip.title = 'Outlook calendar (read-only)';
    } else if (c.source === 'outlook-desktop') {
      chip.classList.add('ok');
      chip.textContent = 'Outlook on this computer';
      chip.title = 'Calendar read from Outlook on this computer (read-only)';
    } else if (c.source === 'ics') {
      chip.classList.add('ok');
      chip.textContent = 'Calendar link';
      chip.title = 'Using a published calendar link';
    } else {
      chip.textContent = 'Calendar not connected';
      chip.title = 'Set up the calendar in Settings';
    }
  }

  function renderBadge(d) {
    const total = d.progress.overdue + d.tasks.open.filter((t) => t.due === d.today).length;
    const b = $('taskBadge');
    b.hidden = total === 0;
    b.textContent = String(total);
    b.title = `${plural(total, 'task')} overdue or due today`;
  }

  function render() {
    const d = S.data;
    if (!d) return;
    renderGreeting(d);
    renderRecent(d);
    renderDashTasks(d);
    renderProgress(d);
    renderWeek(d);
    renderCalChip(d);
    renderBadge(d);
    renderUpcoming();
  }

  // ---------- calendar ----------
  const DOW = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  function weekStartsOn() {
    return S.data && S.data.weekStartsOn === 0 ? 0 : 1;
  }
  function renderWeekdays() {
    const row = $('calWeek');
    if (!row) return;
    const ws = weekStartsOn();
    row.textContent = '';
    for (let i = 0; i < 7; i++) row.append(el('span', '', DOW[(ws + i) % 7]));
  }

  function gridRange() {
    const first = S.month;
    const lead = (first.getDay() - weekStartsOn() + 7) % 7;
    const start = new Date(first.getFullYear(), first.getMonth(), 1 - lead);
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 42);
    return { start, end };
  }

  function eventDays(ev) {
    // Every local day an event touches (all-day events end at midnight, exclusive).
    const out = [];
    const s = new Date(ev.start);
    const e = new Date(ev.end);
    const last = new Date(e.getTime() - 1);
    for (let d = new Date(s.getFullYear(), s.getMonth(), s.getDate()); d <= last && out.length < 62; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
      out.push(ymd(d));
    }
    return out.length ? out : [ymd(s)];
  }

  function renderCalendar() {
    renderWeekdays();
    $('calLabel').textContent = S.month.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    const has = new Set();
    for (const ev of S.monthEvents) eventDays(ev).forEach((k) => has.add(k));
    const { start } = gridRange();
    const todayKey = ymd(new Date());
    const week = S.data && S.data.week;
    const grid = $('calGrid');
    grid.textContent = '';
    for (let i = 0; i < 42; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      const key = ymd(d);
      const b = el('button', 'cal-day');
      b.type = 'button';
      b.setAttribute('role', 'gridcell');
      if (d.getMonth() !== S.month.getMonth()) b.classList.add('other');
      if (week && key >= week.start && key <= week.end) {
        b.classList.add('inweek');
        if (key === week.start) b.classList.add('wk-first');
        if (key === week.end) b.classList.add('wk-last');
      }
      if (key === todayKey) b.classList.add('today');
      if (key === S.selected) b.classList.add('selected');
      if (has.has(key)) b.classList.add('has');
      b.append(el('span', 'n', String(d.getDate())));
      b.setAttribute('aria-label', d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) + (has.has(key) ? ', has events' : ''));
      b.addEventListener('click', () => {
        S.selected = S.selected === key ? null : key;
        renderCalendar();
        renderUpcoming();
      });
      grid.append(b);
    }
  }

  async function loadMonth(force) {
    const request = ++S.monthRequest;
    const { start, end } = gridRange();
    try {
      const r = await api.calendarEvents({ from: start.toISOString(), to: end.toISOString(), force: Boolean(force) });
      if (request !== S.monthRequest) return;
      S.monthEvents = r.events || [];
      S.monthError = r.error || null;
    } catch (e) {
      if (request !== S.monthRequest) return;
      S.monthEvents = [];
      S.monthError = err(e);
    }
    renderCalendar();
    renderUpcoming();
  }

  function eventRow(ev) {
    const now = Date.now();
    const past = new Date(ev.end).getTime() <= now;
    const li = el('li', 'up' + (past ? ' past' : ''));
    li.append(el('div', 'up-bar'));
    const body = el('div');
    body.style.minWidth = '0';
    const sameDayLabel = (() => {
      if (ev.allDay) return 'All day';
      const day = new Date(ev.start);
      const today = ymd(new Date());
      const k = ymd(day);
      const tomorrow = ymd(new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() + 1));
      const prefix = k === today ? '' : k === tomorrow ? 'Tomorrow, ' : day.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) + ', ';
      return `${prefix}${fmtTime(ev.start)} – ${fmtTime(ev.end)}`;
    })();
    body.append(el('div', 'up-time', sameDayLabel));
    body.append(el('div', 'up-title', ev.title));
    if (ev.location && !/^https?:\/\//i.test(ev.location)) body.append(el('div', 'up-loc', ev.location));
    const row = el('div', 'up-row');
    const av = el('div', 'avatars');
    (ev.attendees || []).slice(0, 3).forEach((n) => av.append(avatar(n)));
    if ((ev.attendees || []).length > 3) {
      const more = el('span', 'av', '+' + (ev.attendees.length - 3));
      more.style.background = '#667085';
      av.append(more);
    }
    const actions = el('div', 'up-actions');
    if (ev.joinUrl && !past) {
      const j = el('button', 'btn-join', 'Join');
      j.type = 'button';
      j.title = 'Open the meeting link';
      j.addEventListener('click', async () => {
        const ok = await api.openExternal(ev.joinUrl);
        if (!ok) toast('That link was not opened because it is not a known meeting service.', true);
      });
      actions.append(j);
    }
    const linkedId = ev.meetingId || (MN() && MN().meetingIdForEvent(ev.id));
    const n = el('button', null, linkedId ? 'Open notes' : 'Take notes');
    n.type = 'button';
    n.title = 'Create meeting notes from this event';
    n.addEventListener('click', () => MN().openMeetingFromEvent(ev.id));
    actions.append(n);
    row.append(av, actions);
    body.append(row);
    li.append(body);
    return li;
  }

  function renderUpcoming() {
    const d = S.data;
    const ul = $('upList');
    ul.textContent = '';
    const connectBox = $('calConnect');
    const empty = $('upEmpty');
    const source = d && d.calendar && d.calendar.source;
    connectBox.hidden = Boolean(source);
    $('upBack').hidden = !S.selected;
    if (!source) {
      empty.hidden = true;
      $('upTitle').textContent = 'Upcoming meetings';
      return;
    }
    let events;
    if (S.selected) {
      const day = new Date(S.selected + 'T00:00:00');
      $('upTitle').textContent = day.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
      events = S.monthEvents.filter((ev) => eventDays(ev).includes(S.selected)).sort((a, b) => new Date(a.start) - new Date(b.start));
    } else {
      $('upTitle').textContent = 'Upcoming meetings';
      events = d.upcoming || [];
    }
    events.forEach((ev) => ul.append(eventRow(ev)));
    const problem = (d.calendar && d.calendar.error) || S.monthError;
    empty.hidden = events.length > 0 && !problem;
    if (problem) {
      empty.hidden = false;
      empty.className = 'err-note';
      empty.textContent = problem;
    } else {
      empty.className = 'empty-note';
      empty.textContent = S.selected ? 'No events on this day.' : 'No upcoming meetings in the next two weeks.';
    }
  }

  // ---------- loading ----------
  async function load(force) {
    const request = ++S.dashboardRequest;
    try {
      const data = await api.dashboard({ force: Boolean(force) });
      if (request !== S.dashboardRequest) return;
      S.data = data;
      S.lastLoad = Date.now();
      render();
      renderCalendar();
    } catch (e) {
      if (request !== S.dashboardRequest) return;
      toast('Could not load the dashboard: ' + err(e), true, 7000);
    }
  }

  function refresh(force) {
    clearTimeout(S.loadTimer);
    S.loadTimer = setTimeout(async () => {
      await load(force);
      if (S.view === 'dashboard') loadMonth(force);
    }, 150);
  }

  function dataChanged() {
    refresh(false);
    if (S.view === 'tasks') loadTasks();
  }

  function tasksChanged() {
    refresh(false);
    loadTasks();
  }

  // ---------- tasks page ----------
  function cmpTasks(a, b) {
    if (a.due && b.due && a.due !== b.due) return a.due < b.due ? -1 : 1;
    if (a.due && !b.due) return -1;
    if (!a.due && b.due) return 1;
    if (PRI_ORDER[a.priority] !== PRI_ORDER[b.priority]) return PRI_ORDER[a.priority] - PRI_ORDER[b.priority];
    return a.createdAt < b.createdAt ? -1 : 1;
  }

  async function loadTasks() {
    try {
      S.tasks = await api.listTasks();
      renderTasks();
    } catch (e) { toast('Could not load tasks: ' + err(e), true); }
  }

  function renderTasks() {
    const f = S.filter;
    let list = S.tasks.slice();
    if (f === 'open') list = list.filter((t) => t.mine && !t.done).sort(cmpTasks);
    else if (f === 'delegated') list = list.filter((t) => !t.mine && !t.done).sort(cmpTasks);
    else if (f === 'done') list = list.filter((t) => t.done).sort((a, b) => ((a.doneAt || '') < (b.doneAt || '') ? 1 : -1));
    else list.sort((a, b) => (a.done - b.done) || cmpTasks(a, b));
    document.querySelectorAll('.task-filters button').forEach((b) => b.classList.toggle('active', b.dataset.filter === f));
    const ul = $('taskList');
    ul.textContent = '';
    list.forEach((t) => ul.append(fullTaskRow(t)));
    ul.hidden = list.length === 0;
    const empty = $('taskEmpty');
    empty.hidden = list.length > 0;
    empty.textContent = f === 'open' ? 'No open tasks. Add one above, or generate a meeting summary to import its action items.'
      : f === 'delegated' ? 'No open tasks assigned to other people.'
        : f === 'done' ? 'Nothing completed yet.' : 'No tasks yet.';
  }

  function fullTaskRow(t) {
    const li = el('li', 'task' + (t.done ? ' done' : ''));
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = t.done;
    cb.setAttribute('aria-label', (t.done ? 'Mark not done: ' : 'Mark done: ') + t.title);
    cb.addEventListener('change', () => setDone(t, cb.checked));

    const mid = el('div', 't-title');
    const title = el('input');
    title.value = t.title;
    title.maxLength = 300;
    title.setAttribute('aria-label', 'Task title');
    title.addEventListener('change', async () => {
      const v = title.value.trim();
      if (!v) { title.value = t.title; return; }
      try { await api.updateTask(t.id, { title: v }); t.title = v; refresh(false); } catch (e) { toast(err(e), true); }
    });
    mid.append(title);
    const sub = el('span', 't-sub');
    const bits = [];
    if (t.owner) bits.push('Owner: ' + t.owner);
    if (t.dueText && !t.due) bits.push('Mentioned: ' + t.dueText);
    const from = t.meetingId && MN() ? MN().meetingTitle(t.meetingId) : '';
    if (bits.length) sub.append(document.createTextNode(bits.join(' · ') + (from ? ' · ' : '')));
    if (from) {
      const b = el('button', 'link', 'From ' + from);
      b.type = 'button';
      b.addEventListener('click', () => MN().openMeeting(t.meetingId, { tab: 'summary' }));
      sub.append(b);
    }
    if (bits.length || from) mid.append(sub);

    const pri = el('select');
    pri.setAttribute('aria-label', 'Priority');
    for (const [v, l] of [['high', 'High'], ['med', 'Medium'], ['low', 'Low']]) {
      const o = el('option', null, l);
      o.value = v;
      pri.append(o);
    }
    pri.value = t.priority;
    pri.addEventListener('change', async () => {
      try { await api.updateTask(t.id, { priority: pri.value }); refresh(false); } catch (e) { toast(err(e), true); }
    });

    const due = el('input');
    due.type = 'date';
    due.value = t.due || '';
    due.setAttribute('aria-label', 'Due date');
    due.addEventListener('change', async () => {
      try { await api.updateTask(t.id, { due: due.value }); await loadTasks(); refresh(false); } catch (e) { toast(err(e), true); }
    });
    if (!t.done && t.due && t.due < ymd(new Date())) due.style.color = 'var(--danger)';

    const del = el('button', 'del-btn', '×');
    del.type = 'button';
    del.title = 'Delete task';
    del.setAttribute('aria-label', 'Delete task: ' + t.title);
    del.addEventListener('click', async () => {
      if (!confirm(`Delete the task "${t.title}"?`)) return;
      try { await api.removeTask(t.id); tasksChanged(); } catch (e) { toast(err(e), true); }
    });
    li.append(cb, mid, pri, due, del);
    return li;
  }

  // ---------- view switching ----------
  function onView(name) {
    S.view = name;
    if (name === 'dashboard') {
      const stale = !S.data || Date.now() - S.lastLoad > 60 * 1000;
      if (stale) refresh(false); else { render(); }
      loadMonth(false);
    } else if (name === 'tasks') {
      loadTasks();
    }
  }

  // ---------- wiring ----------
  $('qcMeeting').addEventListener('click', () => MN().openNewDialog());
  $('qcTask').addEventListener('click', () => { MN().showView('tasks'); $('tTitle').focus(); });
  $('allMeetBtn').addEventListener('click', () => MN().showView('meetings'));
  $('allTasksBtn').addEventListener('click', () => MN().showView('tasks'));
  $('tdTodo').addEventListener('click', () => { S.tab = 'todo'; if (S.data) renderDashTasks(S.data); });
  $('tdDone').addEventListener('click', () => { S.tab = 'done'; if (S.data) renderDashTasks(S.data); });
  $('quickTask').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('quickTaskInput');
    const title = input.value.trim();
    if (!title) return;
    try {
      await api.addTask({ title });
      input.value = '';
      S.tab = 'todo';
      tasksChanged();
    } catch (er) { toast(err(er), true); }
  });
  $('taskForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = $('tTitle').value.trim();
    if (!title) return;
    try {
      await api.addTask({ title, priority: $('tPriority').value, due: $('tDue').value });
      $('tTitle').value = '';
      $('tDue').value = '';
      $('tPriority').value = 'med';
      tasksChanged();
    } catch (er) { toast(err(er), true); }
  });
  document.querySelectorAll('.task-filters button').forEach((b) => b.addEventListener('click', () => { S.filter = b.dataset.filter; renderTasks(); }));

  $('calPrev').addEventListener('click', () => { S.month = new Date(S.month.getFullYear(), S.month.getMonth() - 1, 1); S.selected = null; renderCalendar(); renderUpcoming(); loadMonth(false); });
  $('calNext').addEventListener('click', () => { S.month = new Date(S.month.getFullYear(), S.month.getMonth() + 1, 1); S.selected = null; renderCalendar(); renderUpcoming(); loadMonth(false); });
  $('calToday').addEventListener('click', () => { S.month = firstOfMonth(new Date()); S.selected = null; renderCalendar(); renderUpcoming(); loadMonth(false); });
  $('calRefresh').addEventListener('click', async () => { await load(true); await loadMonth(true); toast('Calendar refreshed.'); });
  $('upBack').addEventListener('click', () => { S.selected = null; renderCalendar(); renderUpcoming(); });
  $('calConnectBtn').addEventListener('click', () => MN().openSettings('calendar'));

  // Keep the dashboard current without a manual refresh.
  setInterval(() => { if (S.view === 'dashboard' && !document.hidden) { load(false); loadMonth(false); } }, 5 * 60 * 1000);
  window.addEventListener('focus', () => { if (S.view === 'dashboard' && Date.now() - S.lastLoad > 60 * 1000) { load(false); loadMonth(false); } });

  window.MNDash = { onView, dataChanged, tasksChanged, refresh };

  renderCalendar();
  onView('dashboard');
})();
