'use strict';
(function () {
  const $ = (id) => document.getElementById(id);
  const api = window.api;

  const state = {
    meetings: [],
    cur: null,
    capture: null,
    timer: null,
    levelTimer: null,
    syncTimer: null,
    segStart: 0,
    base: 0,
    paused: false,
    pending: 0,
    last: null,
    levels: { you: 0, others: 0 },
    settings: null,
    transitioning: false,
    updates: null,
    view: 'dashboard',
    olVerify: null,
  };

  // ---------- helpers ----------
  function fmt(sec) {
    const s = Math.max(0, Math.round(sec || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    const p = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${p(m)}:${p(r)}` : `${p(m)}:${p(r)}`;
  }
  function elapsed() {
    return state.paused ? state.base : state.base + (Date.now() - state.segStart) / 1000;
  }
  let toastTimer = null;
  function toast(msg, isError, ms) {
    const el = $('statusbar');
    el.textContent = msg;
    el.className = 'statusbar' + (isError ? ' error' : '');
    el.hidden = false;
    clearTimeout(toastTimer);
    if (ms !== 0) toastTimer = setTimeout(() => { el.hidden = true; }, ms || 4500);
  }
  function hideToast() {
    clearTimeout(toastTimer);
    $('statusbar').hidden = true;
  }
  function errText(e) {
    return String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  }
  function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }
  const isLive = () => state.cur && state.cur.status === 'live';
  const dash = () => window.MNDash || null;

  // ---------- views ----------
  const VIEWS = { dashboard: 'viewDash', meetings: 'viewMeetings', tasks: 'viewTasks' };
  const TITLES = { dashboard: 'Dashboard', meetings: 'Meetings', tasks: 'Tasks' };
  function showView(name) {
    if (!VIEWS[name]) return;
    state.view = name;
    for (const [v, id] of Object.entries(VIEWS)) $(id).hidden = v !== name;
    document.querySelectorAll('.nav-btn[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
    $('viewTitle').textContent = TITLES[name];
    if (dash()) dash().onView(name);
  }

  function updateLiveChip() {
    const chip = $('liveChip');
    const live = isLive();
    chip.hidden = !live;
    if (!live) return;
    chip.classList.toggle('paused', state.paused);
    $('liveText').textContent = `${state.paused ? 'Paused' : 'Recording'} ${fmt(elapsed())}`;
  }

  function openNewDialog() {
    if (isLive() || state.transitioning) return toast('End the current meeting before creating another one.', true);
    $('newForm').reset();
    $('newDlg').showModal();
    $('nTitle').focus();
  }

  // ---------- floating widget sync ----------
  function pushMini() {
    if (isLive()) {
      api.miniUpdate({
        live: true,
        paused: state.paused,
        title: state.cur.title,
        elapsed: elapsed(),
        last: state.last,
      });
    } else {
      api.miniUpdate({ live: false });
    }
  }

  // ---------- sidebar ----------
  async function loadList() {
    state.meetings = await api.listMeetings();
    renderList();
    renderRecents();
    if (dash()) dash().dataChanged();
  }
  function renderRecents() {
    const ul = $('recents');
    ul.textContent = '';
    for (const m of state.meetings.slice(0, 3)) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = m.title;
      b.title = m.title;
      b.addEventListener('click', () => openMeeting(m.id));
      li.append(b);
      ul.append(li);
    }
  }
  function renderList() {
    const q = $('search').value.trim().toLowerCase();
    const ul = $('list');
    ul.textContent = '';
    for (const m of state.meetings) {
      if (q && !m.title.toLowerCase().includes(q)) continue;
      const li = document.createElement('li');
      if (state.cur && state.cur.id === m.id) li.className = 'sel';
      const t = document.createElement('div');
      t.className = 'li-title';
      t.textContent = m.title;
      const s = document.createElement('div');
      s.className = 'li-sub';
      const d = new Date(m.startedAt || m.createdAt);
      const label = m.status === 'live' ? 'Live' : m.status === 'ended' ? (m.hasSummary ? 'Summarized' : 'Ended') : 'Planned';
      s.textContent = `${label} · ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
      li.append(t, s);
      li.addEventListener('click', () => openMeeting(m.id));
      ul.append(li);
    }
  }

  // ---------- meeting view ----------
  async function openMeeting(id, opts) {
    if (state.transitioning) return toast('Please wait for recording to finish starting or stopping.', true);
    if (isLive() && state.cur.id !== id) {
      toast('End the current meeting before opening another one.', true);
      return;
    }
    let m = await api.getMeeting(id);
    // A meeting left "live" by a closed window or a crash has no recording running any more.
    if (m.status === 'live' && !state.capture) {
      const lastT = (m.transcript || []).reduce((mx, x) => Math.max(mx, x.t || 0), 0);
      const patch = { status: 'ended', endedAt: new Date().toISOString(), elapsedSec: Math.max(m.elapsedSec || 0, Math.round(lastT)) };
      m = await api.updateMeeting(id, patch);
      loadList();
    }
    state.cur = m;
    if (!isLive()) state.base = m.elapsedSec || 0;
    renderMeeting();
    renderList();
    showView('meetings');
    if (opts && opts.tab) showTab(opts.tab);
  }

  async function openMeetingFromEvent(eventId) {
    if (isLive() || state.transitioning) return toast('End the current meeting before starting notes for another one.', true);
    try {
      const r = await api.meetingFromEvent(eventId);
      await loadList();
      await openMeeting(r.id, { tab: 'meeting' });
      if (r.created) toast('Notes created from the calendar event. Press Start meeting when you are ready to record.');
    } catch (e) {
      toast(errText(e), true, 7000);
    }
  }

  function renderMeeting() {
    const m = state.cur;
    $('empty').hidden = Boolean(m);
    $('meeting').hidden = !m;
    if (!m) { updateLiveChip(); return; }
    $('mTitle').value = m.title;
    $('mAttendees').value = m.attendees || '';
    $('mAgenda').value = m.agendaPre || '';
    updateControls();
    renderTranscript();
    renderNotes();
    renderSummary();
    $('mTimer').textContent = fmt(isLive() ? elapsed() : m.elapsedSec || 0);
  }

  function updateControls() {
    const m = state.cur;
    const live = m.status === 'live';
    const pill = $('mStatus');
    pill.textContent = live ? (state.paused ? 'Paused' : 'Live') : m.status === 'ended' ? 'Ended' : 'Planned';
    pill.className = 'pill' + (live && !state.paused ? ' live' : '');
    $('startBtn').hidden = live;
    $('startBtn').textContent = m.status === 'ended' ? 'Resume meeting' : 'Start meeting';
    $('stopBtn').hidden = !live;
    $('pauseBtn').hidden = !live;
    $('pauseBtn').textContent = state.paused ? 'Resume recording' : 'Pause';
    $('pauseBtn').classList.toggle('resume', state.paused);
    $('cornerBtn').hidden = !live;
    $('deleteBtn').disabled = live;
    if (state.updates) renderUpdateState(state.updates);
    updateLiveChip();
    const banner = $('banner');
    if (live || m.status === 'planned') {
      banner.hidden = false;
      banner.className = 'banner';
      banner.textContent = 'Audio is not saved, only the recognized text is kept on this computer. Tell participants that you are recording notes. Some states require everyone’s consent to record.';
    } else if (!banner.classList.contains('warn')) {
      banner.hidden = true;
    }
  }

  function addTranscriptRow(item) {
    const box = $('transcript');
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    const p = document.createElement('p');
    p.className = 'tx ' + (item.source === 'you' ? 'you' : 'others');
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = fmt(item.t);
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = item.source === 'you' ? 'You' : 'Others';
    const text = document.createElement('span');
    text.textContent = item.text;
    p.append(t, who, text);
    box.append(p);
    if (nearBottom) box.scrollTop = box.scrollHeight;
  }
  function renderTranscript() {
    $('transcript').textContent = '';
    [...state.cur.transcript].sort((a, b) => a.t - b.t).forEach(addTranscriptRow);
    updatePending();
  }
  function updatePending() {
    const el = $('pending');
    el.hidden = state.pending === 0;
    const behind = state.pending > 4 ? ' Catching up. If this keeps growing, choose a faster speech model in Settings.' : '';
    el.textContent = state.pending ? `Transcribing ${state.pending} segment${state.pending === 1 ? '' : 's'}...${behind}` : '';
  }

  function renderNotes() {
    const ul = $('notes');
    ul.textContent = '';
    for (const n of state.cur.notes || []) {
      const li = document.createElement('li');
      const t = document.createElement('span');
      t.className = 't';
      t.textContent = n.t == null ? '--:--' : fmt(n.t);
      const x = document.createElement('span');
      x.textContent = n.text;
      li.append(t, x);
      ul.append(li);
    }
  }

  async function renderSummary() {
    const m = state.cur;
    const has = Boolean(m.summary);
    $('copyBtn').disabled = !has;
    $('mdBtn').disabled = !has;
    $('pdfBtn').disabled = !has;
    $('genBtn').textContent = has ? 'Regenerate summary and agenda' : 'Generate summary and agenda';
    const box = $('summary');
    if (!has) {
      box.innerHTML = '<p class="muted">Nothing generated yet. End the meeting, then generate the summary and after-meeting agenda.</p>';
      return;
    }
    box.innerHTML = await api.renderHtml(m.id); // HTML is escaped in the main process
  }

  // ---------- editing ----------
  // Save immediately against the meeting that received the edit. A shared debounce
  // loses edits to different fields and can write them to a newly selected meeting.
  async function saveField(patch) {
    const m = state.cur;
    if (!m) return;
    Object.assign(m, patch);
    try { await api.updateMeeting(m.id, patch); }
    catch (e) { return toast('Could not save: ' + errText(e), true); }
    if ('title' in patch) {
      loadList();
      if (isLive()) pushMini();
    }
  }

  async function addNote() {
    const input = $('noteInput');
    const text = input.value.trim();
    if (!text || !state.cur) return;
    const note = await api.addNote(state.cur.id, { t: isLive() ? elapsed() : null, text });
    if (note) {
      state.cur.notes.push(note);
      renderNotes();
    }
    input.value = '';
  }

  // ---------- meeting lifecycle ----------
  async function startMeeting() {
    const m = state.cur;
    if (!m || state.transitioning || isLive()) return;
    state.transitioning = true;
    $('startBtn').disabled = true;
    try {
      toast('Preparing the speech model...', false, 0);
      await api.ensureModel();
      hideToast();
      state.base = m.elapsedSec || 0;
      state.segStart = Date.now();
      state.paused = false;
      state.last = null;
      state.levels = { you: 0, others: 0 };
      state.capture = await window.startCapture({
        getElapsed: elapsed,
        onSegment: handleSegment,
        onLevel: (source, rms) => { state.levels[source] = rms; },
        onWarning: (msg) => {
          const b = $('banner');
          b.hidden = false;
          b.className = 'banner warn';
          b.textContent = msg;
        },
      });
      const patch = { status: 'live', startedAt: m.startedAt || new Date().toISOString(), endedAt: null };
      await api.updateMeeting(m.id, patch);
      Object.assign(m, patch);
      state.timer = setInterval(() => { $('mTimer').textContent = fmt(elapsed()); updateLiveChip(); }, 500);
      state.levelTimer = setInterval(() => api.miniLevels({ ...state.levels }), 120);
      state.syncTimer = setInterval(pushMini, 15000);
      updateControls();
      pushMini();
      loadList();
    } catch (e) {
      hideToast();
      toast('Could not start: ' + errText(e), true, 9000);
      if (state.capture) { try { await state.capture.stop(); } catch (_) { /* ignore */ } state.capture = null; }
    } finally {
      state.transitioning = false;
      $('startBtn').disabled = false;
    }
  }

  function pauseMeeting() {
    if (!isLive() || state.paused) return;
    state.base = elapsed();
    state.paused = true;
    if (state.capture) state.capture.setPaused(true);
    updateControls();
    pushMini();
  }

  function resumeMeeting() {
    if (!isLive() || !state.paused) return;
    state.segStart = Date.now();
    state.paused = false;
    if (state.capture) state.capture.setPaused(false);
    updateControls();
    pushMini();
  }

  async function handleSegment({ source, t, samples }) {
    const meetingId = state.cur.id;
    state.pending++;
    updatePending();
    try {
      const item = await api.transcribe({ meetingId, source, t, samples });
      if (item && state.cur && state.cur.id === meetingId) {
        state.cur.transcript.push(item);
        addTranscriptRow(item);
        state.last = { source: item.source, text: item.text };
        if (isLive()) pushMini();
      }
    } catch (e) {
      toast('Transcription problem: ' + errText(e), true, 7000);
    } finally {
      state.pending--;
      updatePending();
    }
  }

  async function stopMeeting() {
    const m = state.cur;
    if (!m || m.status !== 'live' || state.transitioning) return;
    state.transitioning = true;
    $('stopBtn').disabled = true;
    const total = elapsed();
    clearInterval(state.timer);
    clearInterval(state.levelTimer);
    clearInterval(state.syncTimer);
    try {
      if (state.capture) await state.capture.stop();
      state.capture = null;
      toast('Finishing transcription...', false, 0);
      while (state.pending > 0) await new Promise((r) => setTimeout(r, 300));
      hideToast();
      const patch = { status: 'ended', endedAt: new Date().toISOString(), elapsedSec: Math.round(total) };
      Object.assign(m, patch);
      state.paused = false;
      await api.updateMeeting(m.id, patch);
      pushMini(); // tells the widget the meeting is over
      // reload so the on-disk transcript order is what we show
      state.cur = await api.getMeeting(m.id);
      renderMeeting();
      showTab('summary');
      showView('meetings');
      toast('Meeting ended. Generate the summary and after-meeting agenda when ready.');
      loadList();
    } catch (e) {
      toast('Could not end cleanly: ' + errText(e), true, 9000);
    } finally {
      state.transitioning = false;
      $('stopBtn').disabled = false;
    }
  }

  async function generate() {
    const m = state.cur;
    if (!m || isLive() || state.transitioning) return toast('End the meeting before generating its summary.', true);
    $('genBtn').disabled = true;
    toast('Generating summary and agenda...', false, 0);
    try {
      const updated = await api.generate(m.id, $('genInstruction').value);
      if (state.cur && state.cur.id === m.id) { state.cur = updated; await renderSummary(); }
      hideToast();
      const added = updated.tasksAdded || 0;
      toast(added ? `Summary ready. ${added} action item${added === 1 ? '' : 's'} added to Tasks.` : 'Summary ready.');
      loadList();
      if (dash()) dash().tasksChanged();
    } catch (e) {
      hideToast();
      toast(errText(e), true, 9000);
    } finally {
      $('genBtn').disabled = false;
    }
  }

  async function runExport(fn, label) {
    try {
      const where = await fn(state.cur.id);
      if (where) toast(`${label} saved to ${where}`);
    } catch (e) {
      toast('Export failed: ' + errText(e), true, 8000);
    }
  }

  // ---------- window options ----------
  function setPinned(on) {
    const b = $('pinBtn');
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
    b.textContent = on ? 'Pinned on top' : 'Pin on top';
  }

  // ---------- tabs ----------
  function showTab(which) {
    const s = which === 'summary';
    $('paneMeeting').hidden = s;
    $('paneSummary').hidden = !s;
    $('tabMeeting').classList.toggle('active', !s);
    $('tabSummary').classList.toggle('active', s);
  }

  // ---------- app updates ----------
  function renderUpdateState(update) {
    state.updates = update;
    const labels = {
      idle: 'Check GitHub for a newer app version.',
      development: 'App updates are available in the installed Windows app. Use View releases for an installer.',
      checking: 'Checking for updates...',
      current: 'You have the latest version.',
      available: `Version ${update.version} is available.`,
      downloading: `Downloading version ${update.version}: ${update.percent}%`,
      downloaded: `Version ${update.version} is ready. Restart to install it.`,
      installing: 'Restarting to install the update...',
      error: `Update failed: ${update.message}. Check your connection and try again, or use View releases.`,
    };
    $('updateStatus').textContent = `MeetNotes ${update.currentVersion}. ${labels[update.status] || ''}`;
    const busy = isLive() || state.transitioning || ['checking', 'downloading', 'installing'].includes(update.status);
    $('updateCheck').disabled = busy || update.status === 'development';
    $('updateDownload').hidden = update.status !== 'available';
    $('updateDownload').disabled = busy;
    $('updateInstall').hidden = update.status !== 'downloaded';
    $('updateInstall').disabled = busy;
  }
  async function updateAction(action) {
    if (isLive() || state.transitioning) return toast('End the current meeting before updating the app.', true);
    try {
      const result = await action();
      if (result && typeof result === 'object') renderUpdateState(result);
    } catch (error) { toast(errText(error), true, 9000); }
  }

  // ---------- settings ----------
  function outlookStateText(s) {
    if (s.hasOutlook) return `Connected${s.outlookAccount ? ' as ' + s.outlookAccount : ''}. MeetNotes can only read your calendar.`;
    return s.hasIcs ? 'Not signed in. The calendar link below is being used.' : 'Not connected.';
  }
  function calendarStateText(s) {
    if (s.hasOutlook) return `Using the Microsoft sign-in${s.outlookAccount ? ' (' + s.outlookAccount + ')' : ''}.`;
    if (s.outlookDesktop) return 'Using Outlook on this computer.';
    if (s.hasIcs) return 'Using a published calendar link.';
    return 'Not connected.';
  }
  function showAiFields(provider) {
    $('aiAnthropic').hidden = provider !== 'anthropic';
    $('aiOpenai').hidden = provider !== 'openai';
    $('aiCli').hidden = provider !== 'claude-cli' && provider !== 'codex-cli';
  }
  function refreshCalendarSettings(s) {
    $('calState').textContent = calendarStateText(s);
    $('odConnect').textContent = s.outlookDesktop ? 'Check Outlook connection' : 'Use Outlook on this computer';
    $('odDisconnect').hidden = !s.outlookDesktop;
    $('olState').textContent = outlookStateText(s);
    $('olConnect').textContent = s.hasOutlook ? 'Reconnect Outlook' : 'Connect Outlook';
    $('olDisconnect').hidden = !s.hasOutlook;
    $('icsState').textContent = s.hasIcs ? 'A calendar link is saved on this computer.' : 'No calendar link saved.';
  }

  async function openSettings(section) {
    const s = await api.getSettings();
    state.settings = s;
    $('sName').value = s.myName || '';
    $('sAutoTasks').checked = s.autoTasks;
    $('sOlClient').value = s.outlookClientId || '';
    $('sOlTenant').value = s.outlookTenant || 'common';
    $('sIcs').value = '';
    refreshCalendarSettings(s);
    $('sKey').value = '';
    $('sModel').value = s.model;
    $('sWhisper').value = s.whisperModel;
    $('keyState').textContent = s.hasKey ? 'An API key is saved on this computer.' : 'No API key saved yet.';
    $('sAiProvider').value = s.aiProvider || 'anthropic';
    showAiFields($('sAiProvider').value);
    $('sOaKey').value = '';
    $('oaKeyState').textContent = s.hasOpenaiKey ? 'An API key is saved on this computer.' : 'No API key saved yet.';
    $('sOaBase').value = s.openaiBaseUrl || '';
    $('sOaModel').value = s.openaiModel || '';
    $('sCliPath').value = s.cliPath || '';
    $('sMiniAppearance').value = s.miniAppearance;
    $('sMiniOpacity').value = s.miniOpacity;
    $('sMiniOpacityVal').textContent = s.miniOpacity + '%';
    $('sMiniSize').value = s.miniSize;
    $('sMiniCorner').value = s.miniCorner;
    $('sAutoMini').checked = s.autoMini;
    renderUpdateState(await api.getUpdateState());
    $('settingsDlg').showModal();
    if (section === 'calendar') $('olSection').scrollIntoView();
  }
  async function saveSettings() {
    const patch = {
      model: $('sModel').value,
      whisperModel: $('sWhisper').value,
      miniAppearance: $('sMiniAppearance').value,
      miniOpacity: Number($('sMiniOpacity').value),
      miniSize: $('sMiniSize').value,
      miniCorner: $('sMiniCorner').value,
      autoMini: $('sAutoMini').checked,
      myName: $('sName').value,
      autoTasks: $('sAutoTasks').checked,
      outlookClientId: $('sOlClient').value,
      outlookTenant: $('sOlTenant').value,
      aiProvider: $('sAiProvider').value,
      openaiBaseUrl: $('sOaBase').value,
      openaiModel: $('sOaModel').value,
      cliPath: $('sCliPath').value,
    };
    const oaKey = $('sOaKey').value.trim();
    if (oaKey) patch.openaiKey = oaKey;
    const ics = $('sIcs').value.trim();
    if (ics) patch.icsUrl = ics;
    const key = $('sKey').value.trim();
    if (key) patch.apiKey = key;
    state.settings = await api.setSettings(patch);
    if (ics) $('sIcs').value = '';
    if (oaKey) { $('sOaKey').value = ''; $('oaKeyState').textContent = 'An API key is saved on this computer.'; }
    refreshCalendarSettings(state.settings);
    if (dash()) dash().refresh(true);
  }

  // ---------- wire up ----------
  $('newBtn').addEventListener('click', openNewDialog);
  $('topNewBtn').addEventListener('click', openNewDialog);
  document.querySelectorAll('.nav-btn[data-view]').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
  $('liveChip').addEventListener('click', () => showView('meetings'));
  $('calChip').addEventListener('click', () => openSettings('calendar'));
  $('nCancel').addEventListener('click', () => $('newDlg').close());
  $('newForm').addEventListener('submit', async () => {
    const m = await api.createMeeting({
      title: $('nTitle').value,
      attendees: $('nAttendees').value,
      agendaPre: $('nAgenda').value,
    });
    await loadList();
    await openMeeting(m.id);
    showTab('meeting');
  });

  $('search').addEventListener('input', renderList);
  $('startBtn').addEventListener('click', startMeeting);
  $('stopBtn').addEventListener('click', stopMeeting);
  $('pauseBtn').addEventListener('click', () => (state.paused ? resumeMeeting() : pauseMeeting()));
  $('cornerBtn').addEventListener('click', () => api.minimizeToCorner());
  $('pinBtn').addEventListener('click', async () => {
    const on = !$('pinBtn').classList.contains('on');
    setPinned(await api.setAlwaysOnTop(on));
  });
  $('deleteBtn').addEventListener('click', async () => {
    if (!state.cur || isLive() || state.transitioning) return;
    if (!confirm(`Delete "${state.cur.title}" and its transcript and notes? This cannot be undone.`)) return;
    await api.removeMeeting(state.cur.id);
    state.cur = null;
    renderMeeting();
    loadList();
  });

  $('mTitle').addEventListener('input', (e) => saveField({ title: e.target.value.trim() || 'Untitled meeting' }));
  $('mAttendees').addEventListener('input', (e) => saveField({ attendees: e.target.value }));
  $('mAgenda').addEventListener('input', (e) => saveField({ agendaPre: e.target.value }));
  $('noteBtn').addEventListener('click', addNote);
  $('noteInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') addNote(); });

  $('tabMeeting').addEventListener('click', () => showTab('meeting'));
  $('tabSummary').addEventListener('click', () => showTab('summary'));
  $('genBtn').addEventListener('click', generate);
  $('copyBtn').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(await api.renderMarkdown(state.cur.id));
      toast('Markdown copied');
    } catch (e) { toast('Copy failed: ' + errText(e), true); }
  });
  $('promptBtn').addEventListener('click', async () => {
    const m = state.cur;
    if (!m) return;
    if (isLive() || state.transitioning) return toast('End the meeting first.', true);
    try {
      await api.aiPrompt(m.id, $('genInstruction').value);
      toast('Prompt copied. Paste it into Copilot, ChatGPT, Claude.ai or another AI tool. When it answers, copy the whole reply and choose "Paste AI reply".', false, 12000);
    } catch (e) { toast(errText(e), true, 9000); }
  });
  $('pasteBtn').addEventListener('click', async () => {
    const m = state.cur;
    if (!m) return;
    if (isLive() || state.transitioning) return toast('End the meeting first.', true);
    try {
      const updated = await api.aiImport(m.id);
      if (state.cur && state.cur.id === m.id) { state.cur = updated; await renderSummary(); }
      const added = updated.tasksAdded || 0;
      toast(added ? `Summary imported. ${added} action item${added === 1 ? '' : 's'} added to Tasks.` : 'Summary imported.');
      loadList();
      if (dash()) dash().tasksChanged();
    } catch (e) { toast(errText(e), true, 9000); }
  });
  $('mdBtn').addEventListener('click', () => runExport(api.exportMarkdown, 'Markdown'));
  $('pdfBtn').addEventListener('click', () => runExport(api.exportPdf, 'PDF'));
  $('txBtn').addEventListener('click', () => runExport(api.exportTranscript, 'Transcript'));

  $('settingsBtn').addEventListener('click', () => openSettings());
  $('updateCheck').addEventListener('click', () => updateAction(api.checkUpdates));
  $('updateDownload').addEventListener('click', () => updateAction(api.downloadUpdate));
  $('updateInstall').addEventListener('click', () => {
    if (isLive() || state.transitioning) return toast('End the current meeting before updating the app.', true);
    if (confirm('Restart MeetNotes to install the downloaded update? Your saved meetings and settings will be kept.')) updateAction(api.installUpdate);
  });
  $('updateReleases').addEventListener('click', () => api.openReleases());
  api.onUpdateStatus(renderUpdateState);
  $('sCancel').addEventListener('click', () => $('settingsDlg').close());
  $('settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault(); // stay open if a value is rejected
    try {
      await saveSettings();
      $('settingsDlg').close();
      toast('Settings saved');
    } catch (err) { toast(errText(err), true, 9000); }
  });
  $('sMiniOpacity').addEventListener('input', (e) => { $('sMiniOpacityVal').textContent = e.target.value + '%'; });
  $('sPreview').addEventListener('click', async () => {
    try {
      await saveSettings(); // preview with the values on screen
      await api.miniPreview();
      toast('Previewing the widget for a few seconds.');
    } catch (e) { toast('Preview failed: ' + errText(e), true); }
  });
  $('sAiProvider').addEventListener('change', (e) => showAiFields(e.target.value));
  $('sTest').addEventListener('click', async () => {
    try {
      const hadKey = Boolean($('sKey').value.trim());
      await saveSettings();
      $('sKey').value = '';
      if (hadKey) $('keyState').textContent = 'An API key is saved on this computer.';
      toast('Testing the AI connection...', false, 0);
      await api.testKey();
      toast('The AI connection works.');
    } catch (e) { toast('AI connection test failed: ' + errText(e), true, 9000); }
  });
  // ---------- Outlook on this computer ----------
  $('odConnect').addEventListener('click', async () => {
    try {
      await saveSettings();
      $('odConnect').disabled = true;
      toast('Reading the calendar from Outlook on this computer...', false, 0);
      const r = await api.outlookDesktopConnect();
      const s = await api.getSettings();
      state.settings = s;
      refreshCalendarSettings(s);
      toast(`Outlook connected${r.account ? ' for ' + r.account : ''}. ${r.count} event${r.count === 1 ? '' : 's'} in the next two weeks.`);
      if (dash()) dash().refresh(true);
    } catch (e) {
      toast(errText(e), true, 12000);
    } finally {
      $('odConnect').disabled = false;
    }
  });
  $('odDisconnect').addEventListener('click', async () => {
    await api.outlookDesktopDisconnect();
    const s = await api.getSettings();
    state.settings = s;
    refreshCalendarSettings(s);
    toast('MeetNotes no longer reads Outlook on this computer.');
    if (dash()) dash().refresh(true);
  });
  // ---------- Outlook sign-in ----------
  function olReset() {
    $('olMsg').textContent = 'Contacting Microsoft...';
    $('olCode').hidden = true;
    $('olHint').hidden = true;
    $('olOpen').hidden = true;
    $('olCancel').textContent = 'Cancel';
  }
  api.onOutlookCode((info) => {
    state.olVerify = info.verificationUri;
    $('olMsg').textContent = 'Sign in with this code:';
    $('olCode').textContent = info.userCode;
    $('olCode').hidden = false;
    $('olHint').hidden = false;
    $('olOpen').hidden = false;
  });
  $('olConnect').addEventListener('click', async () => {
    try {
      await saveSettings(); // saves the client ID and tenant first
    } catch (e) { return toast(errText(e), true, 9000); }
    olReset();
    $('olDlg').showModal();
    try {
      const r = await api.outlookConnect();
      if ($('olDlg').open) $('olDlg').close();
      const s = await api.getSettings();
      state.settings = s;
      refreshCalendarSettings(s);
      toast(`Outlook connected${r && r.account ? ' as ' + r.account : ''}.`);
      if (dash()) dash().refresh(true);
    } catch (e) {
      if ($('olDlg').open) {
        $('olMsg').textContent = errText(e);
        $('olCode').hidden = true;
        $('olHint').hidden = true;
        $('olOpen').hidden = true;
        $('olCancel').textContent = 'Close';
      }
    }
  });
  $('olOpen').addEventListener('click', () => { if (state.olVerify) api.openExternal(state.olVerify); });
  $('olCancel').addEventListener('click', () => $('olDlg').close());
  $('olDlg').addEventListener('close', () => { api.outlookCancel(); });
  $('olDisconnect').addEventListener('click', async () => {
    await api.outlookDisconnect();
    const s = await api.getSettings();
    state.settings = s;
    refreshCalendarSettings(s);
    toast('Outlook disconnected.');
    if (dash()) dash().refresh(true);
  });
  $('icsTest').addEventListener('click', async () => {
    try {
      await saveSettings();
      toast('Testing the calendar link...', false, 0);
      const r = await api.testIcs();
      toast(`The calendar link works. ${r.count} event${r.count === 1 ? '' : 's'} in the next two weeks.`);
      if (dash()) dash().refresh(true);
    } catch (e) { toast('Calendar link test failed: ' + errText(e), true, 9000); }
  });

  $('sWipe').addEventListener('click', async () => {
    if (isLive() || state.transitioning) return toast('End the current meeting first.', true);
    if (await api.wipeAll()) {
      $('settingsDlg').close();
      state.cur = null;
      renderMeeting();
      loadList();
      toast('All meetings deleted');
    }
  });

  api.onModelStatus((msg) => {
    if (msg.state === 'loading') {
      const p = msg.progress || {};
      const pct = typeof p.progress === 'number' ? ` ${Math.round(p.progress)}%` : '';
      toast(`Loading speech model${p.file ? ' (' + p.file + ')' : ''}${pct}`, false, 0);
    } else if (msg.state === 'ready') {
      hideToast();
    } else if (msg.state === 'error') {
      toast('Speech model error: ' + msg.message, true, 12000);
    }
  });

  // Commands from the floating widget
  api.onMiniCommand((name) => {
    if (!isLive()) return;
    if (name === 'pause') pauseMeeting();
    else if (name === 'resume') resumeMeeting();
    else if (name === 'stop') stopMeeting();
  });

  window.MN = {
    toast, errText, openMeeting, openMeetingFromEvent, showView, openNewDialog, openSettings, isLive,
    meetingIdForEvent: (eventId) => { const m = state.meetings.find((x) => x.calendarEventId === eventId); return m ? m.id : null; },
    meetingTitle: (id) => { const m = state.meetings.find((x) => x.id === id); return m ? m.title : ''; },
  };

  api.getSettings().then((s) => { state.settings = s; setPinned(Boolean(s.mainAlwaysOnTop)); });
  loadList();
  if (dash()) dash().onView(state.view);
})();
