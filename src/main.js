'use strict';
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, session, desktopCapturer, dialog, safeStorage, screen, shell, net, clipboard } = require('electron');
const { createStore } = require('./store');
const { Transcriber, toFloat32 } = require('./transcriber');
const ai = require('./ai');
const render = require('./render');
const { createUpdates } = require('./updates');
const layout = require('./mini-layout');
const links = require('./links');
const { createTaskStore } = require('./tasks');
const { createOutlook } = require('./outlook');
const icsCal = require('./ics');
const { createServices } = require('./services');
const { createOutlookDesktop } = require('./outlook-desktop');

let win = null;
let mini = null;
let store = null;
let tasks = null;
let outlook = null;
let services = null;
let outlookDesktop = null;
let transcriber = null;
let updates = null;

// Two processes must not write the same local JSON files or capture a meeting twice.
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
else app.on('second-instance', () => showMain());

let live = false;            // a meeting is being recorded
let miniState = null;        // last state sent by the main window
let miniDismissed = false;   // user closed the widget during this meeting
let previewing = false;
let previewTimer = null;

const PREVIEW_STATE = {
  live: true,
  paused: false,
  title: 'Weekly operations review',
  elapsed: 754,
  last: { source: 'others', text: 'We agreed to move the roof inspection to Thursday.' },
  preview: true,
};

const cipher = {
  encrypt(text) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure storage is not available on this computer.');
    return safeStorage.encryptString(text).toString('base64');
  },
  decrypt(b64) {
    return safeStorage.decryptString(Buffer.from(b64, 'base64'));
  },
};

function sendStatus(msg) {
  if (win && !win.isDestroyed()) win.webContents.send('model:status', msg);
}

function getTranscriber() {
  const wanted = store.getSettings().whisperModel;
  if (transcriber && transcriber.modelName !== wanted) {
    transcriber.dispose();
    transcriber = null;
  }
  if (!transcriber || transcriber.state === 'error' || transcriber.state === 'disposed') {
    transcriber = new Transcriber({
      modelName: wanted,
      cacheDir: path.join(app.getPath('userData'), 'models'),
      onStatus: sendStatus,
      // Chromium's network stack: Windows certificate store + system proxy.
      fetchImpl: (url, init) => net.fetch(url, init),
    });
  }
  return transcriber;
}

// ---------- main window ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    title: 'MeetNotes',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false, // keep capturing when the window is minimized or hidden
    },
  });
  win.setMenuBarVisibility(false);
  if (store.getSettings().mainAlwaysOnTop) win.setAlwaysOnTop(true);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('close', (e) => {
    if (!live) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['Keep recording', 'Close anyway'],
      defaultId: 0,
      cancelId: 0,
      message: 'A meeting is being recorded.',
      detail: 'Closing now stops the recording. Text transcribed so far is already saved.',
    });
    if (choice === 0) e.preventDefault();
  });
  win.on('closed', () => {
    win = null;
    destroyMini();
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

function showMain() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// ---------- floating widget ----------
function currentMiniState() {
  return previewing ? PREVIEW_STATE : miniState;
}

function sendMini(channel, payload) {
  if (mini && !mini.isDestroyed()) mini.webContents.send(channel, payload);
}

function miniSettings() {
  const s = store.getSettings();
  return { appearance: s.miniAppearance, opacity: s.miniOpacity, size: s.miniSize, corner: s.miniCorner };
}

function displayForMini() {
  if (mini && !mini.isDestroyed()) return screen.getDisplayMatching(mini.getBounds());
  if (win && !win.isDestroyed()) return screen.getDisplayMatching(win.getBounds());
  return screen.getPrimaryDisplay();
}

function applyMiniBounds() {
  if (!mini || mini.isDestroyed()) return;
  const s = store.getSettings();
  const size = layout.SIZES[s.miniSize];
  const pos = layout.cornerPosition(s.miniCorner, size, displayForMini().workArea);
  mini.setBounds({ x: pos.x, y: pos.y, width: size.width, height: size.height });
}

function createMini() {
  if (mini && !mini.isDestroyed()) return mini;
  const s = store.getSettings();
  const size = layout.SIZES[s.miniSize];
  const pos = layout.cornerPosition(s.miniCorner, size, displayForMini().workArea);
  mini = new BrowserWindow({
    x: pos.x,
    y: pos.y,
    width: size.width,
    height: size.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    title: 'MeetNotes recording',
    webPreferences: {
      preload: path.join(__dirname, 'preload-mini.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  mini.setAlwaysOnTop(true, 'screen-saver'); // stays above other windows, including full-screen apps
  try { mini.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (e) { /* not supported here */ }
  mini.setMenuBarVisibility(false);
  mini.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mini.webContents.on('will-navigate', (e) => e.preventDefault());
  mini.on('closed', () => { mini = null; });
  mini.loadFile(path.join(__dirname, '..', 'renderer', 'mini.html'));
  return mini;
}

function showMini() {
  const m = createMini();
  applyMiniBounds();
  if (!m.isVisible()) m.showInactive(); // do not steal focus from the meeting app
}

function hideMini() {
  if (mini && !mini.isDestroyed()) mini.hide();
}

function destroyMini() {
  clearTimeout(previewTimer);
  previewing = false;
  if (mini && !mini.isDestroyed()) mini.destroy();
  mini = null;
}

function registerMiniIpc() {
  // From the main window
  ipcMain.on('mini:update', (e, state) => {
    const wasLive = live;
    live = Boolean(state && state.live);
    miniState = state || null;
    if (live && !wasLive) miniDismissed = false;
    if (live && !miniDismissed && store.getSettings().autoMini) showMini();
    else if (!live && !previewing) hideMini();
    sendMini('mini:state', currentMiniState());
  });
  ipcMain.on('mini:levels', (e, levels) => {
    if (mini && !mini.isDestroyed() && mini.isVisible() && !previewing) sendMini('mini:levels', levels);
  });
  ipcMain.handle('mini:toggle', () => {
    if (!live) return false;
    if (mini && !mini.isDestroyed() && mini.isVisible()) {
      miniDismissed = true;
      hideMini();
      return false;
    }
    miniDismissed = false;
    showMini();
    return true;
  });
  ipcMain.handle('mini:preview', () => {
    clearTimeout(previewTimer);
    previewing = true;
    showMini();
    sendMini('mini:state', PREVIEW_STATE);
    previewTimer = setTimeout(() => {
      previewing = false;
      if (live && !miniDismissed) sendMini('mini:state', miniState);
      else hideMini();
    }, 8000);
    return true;
  });
  ipcMain.handle('window:minimizeToCorner', () => {
    if (!win || win.isDestroyed()) return false;
    miniDismissed = false;
    if (live) showMini();
    win.minimize();
    return true;
  });
  ipcMain.handle('window:setOnTop', (e, value) => {
    const on = Boolean(value);
    store.setSettings({ mainAlwaysOnTop: on });
    if (win && !win.isDestroyed()) win.setAlwaysOnTop(on);
    return on;
  });

  // From the widget
  ipcMain.on('mini:ready', () => {
    sendMini('mini:settings', miniSettings());
    sendMini('mini:state', currentMiniState());
  });
  ipcMain.on('mini:command', (e, name) => {
    if (name === 'open') return showMain();
    if (['pause', 'resume', 'stop'].includes(name) && win && !win.isDestroyed()) {
      win.webContents.send('mini:command', name);
      if (name === 'stop') showMain(); // bring the summary into view
    }
  });
  ipcMain.on('mini:setSize', (e, size) => {
    if (!layout.isSize(size)) return;
    store.setSettings({ miniSize: size });
    applyMiniBounds();
    sendMini('mini:settings', miniSettings());
  });
  ipcMain.on('mini:moveBy', (e, dx, dy) => {
    if (!mini || mini.isDestroyed() || !isFinite(dx) || !isFinite(dy)) return;
    const b = mini.getBounds();
    const size = layout.SIZES[store.getSettings().miniSize];
    mini.setBounds({ x: Math.round(b.x + dx), y: Math.round(b.y + dy), width: size.width, height: size.height });
  });
  ipcMain.on('mini:dragEnd', () => {
    if (!mini || mini.isDestroyed()) return;
    const corner = layout.nearestCorner(mini.getBounds(), displayForMini().workArea);
    store.setSettings({ miniCorner: corner });
    applyMiniBounds(); // snap to the nearest corner
    sendMini('mini:settings', miniSettings());
  });
  ipcMain.on('mini:hide', () => {
    miniDismissed = true;
    hideMini();
  });
}

// ---------- media access ----------
function setupMediaAccess() {
  const ses = session.defaultSession;
  // System audio (what the other participants say) is captured with Windows loopback audio.
  ses.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer
      .getSources({ types: ['screen'] })
      .then((sources) => callback({ video: sources[0], audio: 'loopback' }))
      .catch(() => callback({}));
  });
  ses.setPermissionRequestHandler((wc, permission, cb) => cb(permission === 'media' || permission === 'display-capture'));
  ses.setPermissionCheckHandler((wc, permission) => permission === 'media' || permission === 'display-capture');
}

function safeName(s) {
  return String(s || 'meeting').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'meeting';
}

async function saveWithDialog(defaultName, filters, writer) {
  const r = await dialog.showSaveDialog(win, { defaultPath: defaultName, filters });
  if (r.canceled || !r.filePath) return null;
  await writer(r.filePath);
  return r.filePath;
}

// ---------- IPC ----------
function registerIpc() {
  // Settings
  ipcMain.handle('settings:get', () => store.getSettings());
  ipcMain.handle('settings:set', (e, patch) => {
    const result = store.setSettings(patch || {});
    if (patch && ('icsUrl' in patch || 'outlookClientId' in patch || 'outlookTenant' in patch || 'outlookDesktop' in patch)) services.clearCalendarCache();
    sendMini('mini:settings', miniSettings());
    if (mini && !mini.isDestroyed()) applyMiniBounds();
    return result;
  });
  ipcMain.handle('settings:testKey', async () => {
    // Electron's network stack uses the Windows certificate store and proxy (works behind SSL inspection).
    await ai.testConnection({ cfg: store.getAiConfig(), fetchImpl: (url, init) => net.fetch(url, init) });
    return true;
  });

  // Meetings
  ipcMain.handle('meetings:list', () => store.list());
  ipcMain.handle('meetings:create', (e, data) => store.create(data));
  ipcMain.handle('meetings:get', (e, id) => store.get(id));
  ipcMain.handle('meetings:update', (e, id, patch) => store.update(id, patch || {}));
  ipcMain.handle('meetings:addNote', (e, id, note) => store.addNote(id, note || {}));
  ipcMain.handle('meetings:editTranscript', (e, id, change) => store.editTranscript(id, change || {}));
  ipcMain.handle('meetings:search', (e, query) => store.search(query));
  ipcMain.handle('meetings:remove', (e, id) => store.remove(id));
  ipcMain.handle('data:wipe', async () => {
    const r = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Cancel', 'Delete all meetings'],
      defaultId: 0,
      cancelId: 0,
      message: 'Delete all meetings, transcripts and notes?',
      detail: 'This cannot be undone. Your settings, tasks and API key are kept.',
    });
    if (r.response !== 1) return false;
    store.wipeAll();
    return true;
  });

  // Speech
  ipcMain.handle('model:ensure', async () => {
    await getTranscriber().ensureReady();
    return true;
  });
  ipcMain.handle('audio:transcribe', async (e, { meetingId, source, t, samples }) => {
    const audio = toFloat32(samples);
    let text;
    try {
      text = await getTranscriber().transcribe(audio);
    } catch (err) {
      // If the speech worker crashed, getTranscriber() starts a fresh one. Retry once so the segment is not lost.
      if (transcriber && transcriber.state === 'disposed') throw err;
      text = await getTranscriber().transcribe(audio.slice(0));
    }
    if (!text) return null;
    const item = { t: Math.max(0, Number(t) || 0), source: source === 'you' ? 'you' : 'others', text };
    store.appendTranscript(meetingId, item);
    return item;
  });

  // AI
  function saveSummary(id, summary) {
    const saved = store.setSummary(id, summary);
    let tasksAdded = 0;
    if (store.getSettings().autoTasks) {
      try { tasksAdded = tasks.importFromSummary(saved).added; } catch (e) { /* the summary is saved either way */ }
    }
    return { ...saved, tasksAdded };
  }
  ipcMain.handle('ai:generate', async (e, { id, instruction }) => {
    const meeting = store.get(id);
    const summary = await ai.generateSummary({
      cfg: store.getAiConfig(),
      meeting,
      instruction,
      fetchImpl: (url, init) => net.fetch(url, init),
    });
    return saveSummary(id, summary);
  });
  // Any other AI tool (Copilot, ChatGPT, Claude.ai, Gemini): copy the prompt, paste the reply back.
  ipcMain.handle('ai:prompt', (e, { id, instruction }) => {
    const text = ai.manualPrompt(store.get(id), instruction);
    clipboard.writeText(text);
    return { chars: text.length };
  });
  ipcMain.handle('ai:import', (e, { id }) => saveSummary(id, ai.importSummary(clipboard.readText())));

  ipcMain.handle('shell:open', (e, url) => {
    if (links.isAllowedExternal(url)) return shell.openExternal(url).then(() => true);
    return false;
  });

  // Rendering and export
  ipcMain.handle('render:html', (e, id) => render.renderHtml(store.get(id)));
  ipcMain.handle('render:markdown', (e, id) => render.renderMarkdown(store.get(id)));
  ipcMain.handle('export:markdown', async (e, id) => {
    const m = store.get(id);
    return saveWithDialog(`${safeName(m.title)}.md`, [{ name: 'Markdown', extensions: ['md'] }], (f) =>
      fs.promises.writeFile(f, render.renderMarkdown(m), 'utf8'));
  });
  ipcMain.handle('export:full', async (e, id) => {
    const m = store.get(id);
    return saveWithDialog(`${safeName(m.title)} summary and transcript.md`,
      [{ name: 'Markdown', extensions: ['md'] }, { name: 'Text', extensions: ['txt'] }],
      (f) => fs.promises.writeFile(f, render.renderMarkdown(m, { withTranscript: true }), 'utf8'));
  });
  ipcMain.handle('export:transcript', async (e, id) => {
    const m = store.get(id);
    return saveWithDialog(`${safeName(m.title)} transcript.txt`, [{ name: 'Text', extensions: ['txt'] }], (f) =>
      fs.promises.writeFile(f, render.renderTranscriptText(m), 'utf8'));
  });
  ipcMain.handle('export:pdf', async (e, id) => {
    const m = store.get(id);
    return saveWithDialog(`${safeName(m.title)}.pdf`, [{ name: 'PDF', extensions: ['pdf'] }], async (f) => {
      const hidden = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
      try {
        const html = render.renderHtml(m, { standalone: true });
        await hidden.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
        const pdf = await hidden.webContents.printToPDF({ printBackground: true, pageSize: 'Letter' });
        await fs.promises.writeFile(f, pdf);
      } finally {
        hidden.destroy();
      }
    });
  });

  ipcMain.handle('updates:get', () => updates.getState());
  ipcMain.handle('updates:check', () => updates.check());
  ipcMain.handle('updates:download', () => updates.download());
  ipcMain.handle('updates:install', () => updates.install());
  ipcMain.handle('updates:openReleases', () => shell.openExternal('https://github.com/levanis-design/MeetNotes/releases'));

  registerCalendarIpc();
  registerMiniIpc();
}

// ---------- calendar, tasks and dashboard ----------
let connecting = false;

function registerCalendarIpc() {
  // Tasks
  ipcMain.handle('tasks:list', () => services.listTasks());
  ipcMain.handle('tasks:add', (e, input) => tasks.add(input || {}));
  ipcMain.handle('tasks:update', (e, id, patch) => tasks.update(String(id), patch || {}));
  ipcMain.handle('tasks:remove', (e, id) => { tasks.remove(String(id)); return true; });

  // Dashboard and calendar
  ipcMain.handle('dashboard:get', (e, opts) => services.dashboard(opts));
  ipcMain.handle('calendar:events', (e, range) => services.calendarEvents(range));
  ipcMain.handle('meetings:fromEvent', (e, eventId) => services.meetingFromEvent(eventId));

  // Outlook sign-in (device code flow) and the alternative calendar link
  ipcMain.handle('outlook:connect', async () => {
    if (connecting) throw new Error('A sign-in is already in progress.');
    connecting = true;
    try {
      const r = await outlook.connect({
        onCode: (info) => { if (win && !win.isDestroyed()) win.webContents.send('outlook:code', info); },
      });
      store.setOutlookRefresh(store.getOutlookRefresh(), r.account);
      services.clearCalendarCache();
      return r;
    } finally {
      connecting = false;
    }
  });
  ipcMain.handle('outlookDesktop:connect', async () => {
    const r = await outlookDesktop.test(); // fails with a clear message before anything is saved
    store.setSettings({ outlookDesktop: true });
    services.clearCalendarCache();
    return r;
  });
  ipcMain.handle('outlookDesktop:disconnect', () => {
    store.setSettings({ outlookDesktop: false });
    services.clearCalendarCache();
    return true;
  });
  ipcMain.handle('outlook:cancel', () => { outlook.cancel(); return true; });
  ipcMain.handle('outlook:disconnect', () => { outlook.disconnect(); services.clearCalendarCache(); return true; });
  ipcMain.handle('ics:test', async () => {
    const url = store.getIcsUrl();
    if (!url) throw new Error('No calendar link saved.');
    const from = new Date();
    const to = new Date(Date.now() + 14 * 24 * 3600 * 1000);
    const events = await icsCal.fetchEvents(url, from, to);
    services.clearCalendarCache();
    return { count: events.length };
  });

}

app.whenReady().then(() => {
  if (!primaryInstance) return;
  store = createStore(app.getPath('userData'), cipher);
  tasks = createTaskStore(app.getPath('userData'));
  outlook = createOutlook({
    getConfig: () => {
      const s = store.getSettings();
      return { clientId: s.outlookClientId, tenant: s.outlookTenant };
    },
    loadRefresh: () => store.getOutlookRefresh(),
    saveRefresh: (t) => store.setOutlookRefresh(t),
  });
  outlookDesktop = createOutlookDesktop({ isEnabled: () => store.getSettings().outlookDesktop });
  services = createServices({ store, tasks, outlook, outlookDesktop });
  updates = createUpdates({
    updater: app.isPackaged ? require('electron-updater').autoUpdater : null,
    version: app.getVersion(),
    isBusy: () => live,
    onChange: (state) => { if (win && !win.isDestroyed()) win.webContents.send('updates:status', state); },
  });
  setupMediaAccess();
  registerIpc();
  createWindow();
  // Load the speech model in the background, so Start is instant when a meeting begins.
  setTimeout(() => {
    if (!transcriber || transcriber.state !== 'ready') getTranscriber().ensureReady().catch(() => { /* reported via model:status; retried on Start */ });
  }, 3000);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (transcriber) transcriber.dispose();
  if (process.platform !== 'darwin') app.quit();
});
