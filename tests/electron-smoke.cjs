'use strict';
// Run with Electron; all data and exports go into a disposable test directory.
const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const dataDir = path.join(__dirname, '..', '.test-data', `smoke-${Date.now()}`);
fs.mkdirSync(dataDir, { recursive: true });
app.setPath('userData', dataDir);
app.on('browser-window-created', (_, win) => win.hide());
dialog.showSaveDialog = async (_, options) => ({ filePath: path.join(dataDir, options.defaultPath) });
const errors = [];
app.on('web-contents-created', (_, contents) => contents.on('console-message', (event) => {
  if (event.level === 'error') errors.push(event.message);
}));
require(process.argv.includes('--packaged') ? '../dist/win-unpacked/resources/app.asar/src/main' : '../src/main');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deadline = setTimeout(() => { console.error('Smoke test timed out'); app.exit(1); }, 90000);
app.whenReady().then(async () => {
  try {
    await delay(500);
    const win = BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'MeetNotes');
    assert.ok(win, 'main window exists');
    while (win.webContents.isLoading()) await delay(100);
    const run = (code) => win.webContents.executeJavaScript(code);
    assert.equal(await run('typeof window.api.createMeeting'), 'function');
    assert.equal(await run('typeof window.api.publishGithub'), 'undefined');
    assert.equal(await run('typeof window.api.testGithub'), 'undefined');
    assert.equal(await run("document.getElementById('ghBtn')"), null);
    assert.equal(await run("document.getElementById('sGhToken')"), null);
    await run("document.getElementById('settingsBtn').click()");
    await delay(200);
    assert.ok(await run("document.getElementById('updateStatus').textContent.includes('installed Windows app')"));
    assert.equal(await run("document.getElementById('updateCheck').disabled"), true);
    win.webContents.send('updates:status', { status: 'available', currentVersion: '1.2.0', version: '1.3.0', percent: 0 });
    await delay(100);
    assert.equal(await run("document.getElementById('updateDownload').hidden"), false);
    win.webContents.send('updates:status', { status: 'downloaded', currentVersion: '1.2.0', version: '1.3.0', percent: 100 });
    await delay(100);
    assert.equal(await run("document.getElementById('updateInstall').hidden"), false);
    await run("document.getElementById('sCancel').click()");
    const result = await run(`(async () => {
      const a = await api.createMeeting({ title: 'Smoke A', agendaPre: 'Budget' });
      const b = await api.createMeeting({ title: 'Smoke B' });
      await api.addNote(a.id, { text: 'Decision: approve the budget' });
      document.getElementById('newBtn').click();
      document.getElementById('nTitle').value = 'UI meeting';
      document.getElementById('newForm').requestSubmit();
      await new Promise(r => setTimeout(r, 200));
      for (const [id, value] of [['mTitle', 'Edited UI title'], ['mAttendees', 'Alice'], ['mAgenda', 'Review costs']]) {
        const input = document.getElementById(id); input.value = value; input.dispatchEvent(new Event('input'));
      }
      document.getElementById('noteInput').value = 'UI note';
      document.getElementById('noteBtn').click();
      await new Promise(r => setTimeout(r, 200));
      const ui = (await api.listMeetings()).find(m => m.title === 'Edited UI title');
      const stored = await api.getMeeting(ui.id);
      const html = await api.renderHtml(a.id);
      const md = await api.renderMarkdown(a.id);
      await api.exportMarkdown(a.id); await api.exportTranscript(a.id); await api.exportPdf(a.id);
      await api.setSettings({ miniSize: 'card', miniOpacity: 45 });
      await api.miniPreview();
      return { a, b, stored, html, md };
    })()`);
    assert.equal(result.stored.attendees, 'Alice');
    assert.equal(result.stored.agendaPre, 'Review costs');
    assert.equal(result.stored.notes[0].text, 'UI note');
    assert.ok(result.html.includes('Smoke A'));
    assert.ok(result.md.includes('Smoke A'));
    assert.ok(fs.readFileSync(path.join(dataDir, 'Smoke A.pdf')).subarray(0, 4).equals(Buffer.from('%PDF')));
    await delay(300);
    const mini = BrowserWindow.getAllWindows().find(w => w.getTitle() === 'MeetNotes recording');
    assert.ok(mini && mini.isAlwaysOnTop(), 'floating widget is on top');
    assert.equal(await mini.webContents.executeJavaScript("document.body.innerText.includes('Weekly operations review')"), true);
    // Exercise the renderer recording lifecycle with deterministic fake capture and speech.
    ipcMain.removeHandler('model:ensure');
    ipcMain.handle('model:ensure', async () => { await delay(200); return true; });
    await run(`window.startCapture = async () => ({ setPaused() {}, async stop() {} }); document.getElementById('startBtn').click(); document.getElementById('newBtn').click();`);
    await delay(500);
    assert.equal(await run("document.getElementById('mStatus').textContent"), 'Live');
    assert.equal(await run("document.getElementById('updateInstall').disabled"), true);
    assert.equal(await run("document.getElementById('newDlg').open"), false);
    await run("document.getElementById('pauseBtn').click()");
    assert.equal(await run("document.getElementById('mStatus').textContent"), 'Paused');
    await run("document.getElementById('pauseBtn').click(); document.getElementById('stopBtn').click()");
    await delay(500);
    assert.equal(await run("document.getElementById('mStatus').textContent"), 'Ended');
    assert.deepEqual(errors, [], 'no renderer errors');
    console.log('PASS: Electron preload, removed publishing UI/API, app-update settings, meeting edits/notes, PDF exports, widget, and recording lifecycle (fake capture).');
    clearTimeout(deadline);
    app.exit(0);
  } catch (error) {
    console.error(error);
    clearTimeout(deadline);
    app.exit(1);
  }
});
