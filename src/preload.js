'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('api', {
  getSettings: () => invoke('settings:get'),
  setSettings: (patch) => invoke('settings:set', patch),
  testKey: () => invoke('settings:testKey'),

  listMeetings: () => invoke('meetings:list'),
  createMeeting: (data) => invoke('meetings:create', data),
  getMeeting: (id) => invoke('meetings:get', id),
  updateMeeting: (id, patch) => invoke('meetings:update', id, patch),
  addNote: (id, note) => invoke('meetings:addNote', id, note),
  removeMeeting: (id) => invoke('meetings:remove', id),
  wipeAll: () => invoke('data:wipe'),

  ensureModel: () => invoke('model:ensure'),
  transcribe: (payload) => invoke('audio:transcribe', payload),
  onModelStatus: (cb) => ipcRenderer.on('model:status', (e, msg) => cb(msg)),

  generate: (id, instruction) => invoke('ai:generate', { id, instruction }),
  renderHtml: (id) => invoke('render:html', id),
  renderMarkdown: (id) => invoke('render:markdown', id),
  exportMarkdown: (id) => invoke('export:markdown', id),
  exportPdf: (id) => invoke('export:pdf', id),
  exportTranscript: (id) => invoke('export:transcript', id),

  openExternal: (url) => invoke('shell:open', url),

  getUpdateState: () => invoke('updates:get'),
  checkUpdates: () => invoke('updates:check'),
  downloadUpdate: () => invoke('updates:download'),
  installUpdate: () => invoke('updates:install'),
  openReleases: () => invoke('updates:openReleases'),
  onUpdateStatus: (cb) => ipcRenderer.on('updates:status', (e, state) => cb(state)),

  // Tasks, dashboard and calendar
  listTasks: () => invoke('tasks:list'),
  addTask: (input) => invoke('tasks:add', input),
  updateTask: (id, patch) => invoke('tasks:update', id, patch),
  removeTask: (id) => invoke('tasks:remove', id),
  dashboard: (opts) => invoke('dashboard:get', opts),
  calendarEvents: (range) => invoke('calendar:events', range),
  meetingFromEvent: (eventId) => invoke('meetings:fromEvent', eventId),
  outlookConnect: () => invoke('outlook:connect'),
  outlookCancel: () => invoke('outlook:cancel'),
  outlookDisconnect: () => invoke('outlook:disconnect'),
  onOutlookCode: (cb) => ipcRenderer.on('outlook:code', (e, info) => cb(info)),
  testIcs: () => invoke('ics:test'),

  // Floating widget and window options
  miniUpdate: (state) => ipcRenderer.send('mini:update', state),
  miniLevels: (levels) => ipcRenderer.send('mini:levels', levels),
  miniToggle: () => invoke('mini:toggle'),
  miniPreview: () => invoke('mini:preview'),
  onMiniCommand: (cb) => ipcRenderer.on('mini:command', (e, name) => cb(name)),
  minimizeToCorner: () => invoke('window:minimizeToCorner'),
  setAlwaysOnTop: (value) => invoke('window:setOnTop', value),
});
