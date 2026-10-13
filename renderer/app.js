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
  async function openMeeting(id) {
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
  }

  function renderMeeting() {
    const m = state.cur;
    $('empty').hidden = Boolean(m);
    $('meeting').hidden = !m;
    if (!m) return;
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
    el.textContent = state.pending ? `Transcribing ${state.pending} segment${state.pending === 1 ? '' : 's'}...` : '';
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
      state.timer = setInterval(() => { $('mTimer').textContent = fmt(elapsed()); }, 500);
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
      if (state.cur && state.cur.id === m.id) {
        state.cur = updated;
        await renderSummary();
      }
      hideToast();
      loadList();
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
  async function openSettings() {
    const s = await api.getSettings();
    state.settings = s;
    $('sKey').value = '';
    $('sModel').value = s.model;
    $('sWhisper').value = s.whisperModel;
    $('keyState').textContent = s.hasKey ? 'An API key is saved on this computer.' : 'No API key saved yet.';
    $('sMiniAppearance').value = s.miniAppearance;
    $('sMiniOpacity').value = s.miniOpacity;
    $('sMiniOpacityVal').textContent = s.miniOpacity + '%';
    $('sMiniSize').value = s.miniSize;
    $('sMiniCorner').value = s.miniCorner;
    $('sAutoMini').checked = s.autoMini;
    renderUpdateState(await api.getUpdateState());
    $('settingsDlg').showModal();
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
    };
    const key = $('sKey').value.trim();
    if (key) patch.apiKey = key;
    state.settings = await api.setSettings(patch);
  }

  // ---------- wire up ----------
  $('newBtn').addEventListener('click', () => {
    if (isLive() || state.transitioning) return toast('End the current meeting before creating another one.', true);
    $('newForm').reset();
    $('newDlg').showModal();
    $('nTitle').focus();
  });
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
  $('mdBtn').addEventListener('click', () => runExport(api.exportMarkdown, 'Markdown'));
  $('pdfBtn').addEventListener('click', () => runExport(api.exportPdf, 'PDF'));
  $('txBtn').addEventListener('click', () => runExport(api.exportTranscript, 'Transcript'));

  $('settingsBtn').addEventListener('click', openSettings);
  $('updateCheck').addEventListener('click', () => updateAction(api.checkUpdates));
  $('updateDownload').addEventListener('click', () => updateAction(api.downloadUpdate));
  $('updateInstall').addEventListener('click', () => {
    if (isLive() || state.transitioning) return toast('End the current meeting before updating the app.', true);
    if (confirm('Restart MeetNotes to install the downloaded update? Your saved meetings and settings will be kept.')) updateAction(api.installUpdate);
  });
  $('updateReleases').addEventListener('click', () => api.openReleases());
  api.onUpdateStatus(renderUpdateState);
  $('sCancel').addEventListener('click', () => $('settingsDlg').close());
  $('settingsForm').addEventListener('submit', async () => { await saveSettings(); toast('Settings saved'); });
  $('sMiniOpacity').addEventListener('input', (e) => { $('sMiniOpacityVal').textContent = e.target.value + '%'; });
  $('sPreview').addEventListener('click', async () => {
    try {
      await saveSettings(); // preview with the values on screen
      await api.miniPreview();
      toast('Previewing the widget for a few seconds.');
    } catch (e) { toast('Preview failed: ' + errText(e), true); }
  });
  $('sTest').addEventListener('click', async () => {
    try {
      await saveSettings();
      $('sKey').value = '';
      toast('Testing the key...', false, 0);
      await api.testKey();
      $('keyState').textContent = 'An API key is saved on this computer.';
      toast('The API key works.');
    } catch (e) { toast('Key test failed: ' + errText(e), true, 8000); }
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

  api.getSettings().then((s) => { state.settings = s; setPinned(Boolean(s.mainAlwaysOnTop)); });
  loadList();
})();
