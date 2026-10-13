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

  getUpdateState: () => invoke('updates:get'),
  checkUpdates: () => invoke('updates:check'),
  downloadUpdate: () => invoke('updates:download'),
  installUpdate: () => invoke('updates:install'),
  openReleases: () => invoke('updates:openReleases'),
  onUpdateStatus: (cb) => ipcRenderer.on('updates:status', (e, state) => cb(state)),

  // Floating widget and window options
  miniUpdate: (state) => ipcRenderer.send('mini:update', state),
  miniLevels: (levels) => ipcRenderer.send('mini:levels', levels),
  miniToggle: () => invoke('mini:toggle'),
  miniPreview: () => invoke('mini:preview'),
  onMiniCommand: (cb) => ipcRenderer.on('mini:command', (e, name) => cb(name)),
  minimizeToCorner: () => invoke('window:minimizeToCorner'),
  setAlwaysOnTop: (value) => invoke('window:setOnTop', value),
});
