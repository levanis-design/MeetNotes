'use strict';
// Only app binaries and release metadata are exchanged with GitHub.
function createUpdates({ updater, version, isBusy = () => false, onChange = () => {} }) {
  let state = { status: updater ? 'idle' : 'development', currentVersion: version, version: null, percent: 0, message: '' };
  let operation = null;
  if (updater) {
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.setFeedURL({ provider: 'github', owner: 'levanis-design', repo: 'MeetNotes', private: false });
    updater.on('checking-for-update', () => set({ status: 'checking', message: '' }));
    updater.on('update-available', (info) => set({ status: 'available', version: info.version, percent: 0, message: '' }));
    updater.on('update-not-available', () => set({ status: 'current', version: null, message: '' }));
    updater.on('download-progress', (progress) => set({ status: 'downloading', percent: Math.round(progress.percent) }));
    updater.on('update-downloaded', (info) => set({ status: 'downloaded', version: info.version, percent: 100, message: '' }));
    updater.on('error', (error) => set({ status: 'error', message: String(error.message || error) }));
  }
  function set(patch) { state = { ...state, ...patch }; onChange({ ...state }); }
  function available() {
    if (!updater) throw new Error('Install MeetNotes using the Windows installer to enable app updates.');
    if (isBusy()) throw new Error('End the current meeting before updating the app.');
    if (operation) throw new Error('An update operation is already in progress.');
  }
  async function run(status, task) {
    available();
    set({ status, message: '' });
    // Set the lock before invoking the task; events can fire synchronously.
    operation = Promise.resolve().then(task);
    try { await operation; return { ...state }; }
    catch (error) { set({ status: 'error', message: String(error.message || error) }); throw error; }
    finally { operation = null; }
  }
  return {
    getState: () => ({ ...state }),
    check() {
      if (state.status === 'downloaded') return Promise.resolve({ ...state });
      return run('checking', () => updater.checkForUpdates());
    },
    download() {
      if (state.status !== 'available') throw new Error('Check for an available update first.');
      return run('downloading', () => updater.downloadUpdate());
    },
    install() {
      available();
      if (state.status !== 'downloaded') throw new Error('Download the update before installing it.');
      set({ status: 'installing' });
      updater.quitAndInstall(false, true);
      return true;
    },
  };
}
module.exports = { createUpdates };
