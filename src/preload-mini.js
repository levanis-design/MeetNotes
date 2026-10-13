'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('miniApi', {
  onState: (cb) => ipcRenderer.on('mini:state', (e, s) => cb(s)),
  onLevels: (cb) => ipcRenderer.on('mini:levels', (e, l) => cb(l)),
  onSettings: (cb) => ipcRenderer.on('mini:settings', (e, s) => cb(s)),
  ready: () => ipcRenderer.send('mini:ready'),
  command: (name) => ipcRenderer.send('mini:command', name),
  setSize: (size) => ipcRenderer.send('mini:setSize', size),
  moveBy: (dx, dy) => ipcRenderer.send('mini:moveBy', dx, dy),
  dragEnd: () => ipcRenderer.send('mini:dragEnd'),
  hide: () => ipcRenderer.send('mini:hide'),
});
