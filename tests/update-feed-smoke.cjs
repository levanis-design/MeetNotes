'use strict';
// Run after publishing 1.2.0. Downloads into test data; never installs an update.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { SemVer } = createRequire(require.resolve('electron-updater'))('semver');
const { createUpdates } = require('../src/updates');
const dir = path.join(__dirname, '..', '.test-data', 'update-feed');
fs.mkdirSync(dir, { recursive: true });
app.setPath('userData', dir);
app.whenReady().then(async () => {
  const timeout = setTimeout(() => { console.error('Update feed test timed out'); app.exit(1); }, 180000);
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.forceDevUpdateConfig = true;
    autoUpdater.updateConfigPath = path.join(__dirname, '..', 'dist', 'win-unpacked', 'resources', 'app-update.yml');
    Object.defineProperty(autoUpdater.app, 'baseCachePath', { value: dir });
    autoUpdater.currentVersion = new SemVer('1.1.0');
    autoUpdater.disableDifferentialDownload = true;
    const service = createUpdates({ updater: autoUpdater, version: '1.1.0' });
    const result = await service.check();
    assert.equal(result.status, 'available');
    assert.equal(result.version, '1.2.0');
    const downloaded = await service.download();
    assert.equal(downloaded.status, 'downloaded');
    console.log('PASS: real public GitHub update metadata, installer download and checksum verification. No installation performed.');
    clearTimeout(timeout); app.exit(0);
  } catch (error) { console.error(error); clearTimeout(timeout); app.exit(1); }
});
