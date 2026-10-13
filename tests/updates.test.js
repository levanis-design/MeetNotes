'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createUpdates } = require('../src/updates');
const { createStore } = require('../src/store');
function setup({ busy = () => false } = {}) {
  const updater = new EventEmitter();
  updater.setFeedURL = feed => { updater.feed = feed; };
  updater.checkForUpdates = async () => { updater.emit('update-available', { version: '1.3.0' }); };
  updater.downloadUpdate = async () => {
    updater.emit('download-progress', { percent: 42.3 });
    updater.emit('update-downloaded', { version: '1.3.0' });
  };
  updater.quitAndInstall = (...args) => { updater.installArgs = args; };
  const events = [];
  const service = createUpdates({ updater, version: '1.2.0', isBusy: busy, onChange: state => events.push(state) });
  return { updater, service, events };
}
test('updates: public release feed, manual download and explicit restart', async () => {
  const { updater, service, events } = setup();
  assert.deepEqual(updater.feed, { provider: 'github', owner: 'levanis-design', repo: 'MeetNotes', private: false });
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updater.allowPrerelease, false);
  assert.equal(updater.allowDowngrade, false);
  assert.throws(() => service.install(), /Download/);
  assert.equal((await service.check()).status, 'available');
  assert.equal((await service.download()).status, 'downloaded');
  assert.ok(events.some(e => e.status === 'downloading' && e.percent === 42));
  service.install();
  assert.deepEqual(updater.installArgs, [false, true]);
});
test('updates: recording blocks checking, downloading and installing', async () => {
  let busy = false;
  const { service } = setup({ busy: () => busy });
  await service.check();
  busy = true;
  await assert.rejects(service.check(), /End the current meeting/);
  await assert.rejects(service.download(), /End the current meeting/);
  busy = false;
  await service.download();
  busy = true;
  assert.throws(() => service.install(), /End the current meeting/);
});
test('updates: development mode does not contact GitHub', async () => {
  const service = createUpdates({ updater: null, version: '1.2.0' });
  assert.equal(service.getState().status, 'development');
  await assert.rejects(service.check(), /Windows installer/);
});
test('updates: network failure is recoverable and duplicate operations are blocked', async () => {
  const { updater, service } = setup();
  let resolve;
  updater.checkForUpdates = () => new Promise(r => { resolve = r; });
  const checking = service.check();
  await assert.rejects(service.check(), /already in progress/);
  resolve(); await checking;
  updater.checkForUpdates = async () => { throw new Error('offline'); };
  await assert.rejects(service.check(), /offline/);
  assert.equal(service.getState().status, 'error');
  updater.checkForUpdates = async () => updater.emit('update-not-available');
  assert.equal((await service.check()).status, 'current');
});
test('store: upgrade removes obsolete GitHub credentials and ignores publishing settings', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meetnotes-migrate-'));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ apiKeyEnc: 'saved-key', model: 'saved-model', githubTokenEnc: 'old-token', githubRepo: 'old-repo', githubPrivate: true }));
  const store = createStore(dir, { decrypt: s => s, encrypt: s => s });
  assert.equal(store.getApiKey(), 'saved-key');
  assert.equal(store.getSettings().model, 'saved-model');
  store.setSettings({ githubToken: 'new-token', githubRepo: 'new-repo' });
  const settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json')));
  assert.ok(!Object.keys(settings).some(key => key.startsWith('github')));
  assert.equal(store.getGithubToken, undefined);
  const meeting = store.create({ title: 'Keep local' });
  store.update(meeting.id, { github: { repo: 'test' } });
  assert.equal(store.get(meeting.id).github, undefined);
});
