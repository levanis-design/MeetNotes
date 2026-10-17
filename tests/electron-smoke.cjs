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
// UI checks mock recognition below. Real model loading/inference has its own smoke tests;
// do not leave an unrelated native model worker loading while this process exits.
process.env.MEETNOTES_SKIP_MODEL_PRELOAD = '1';
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
    const sourceRoot = process.argv.includes('--packaged') ? '../dist/win-unpacked/resources/app.asar/src/' : '../src/';
    if (process.argv.includes('--packaged')) {
      for (const file of ['src/vad.js', 'src/audio-store.js', 'src/ai.js', 'renderer/audio-job.js', 'renderer/capture.js', 'renderer/app.js']) {
        assert.deepEqual(fs.readFileSync(path.join(__dirname, '..', 'dist/win-unpacked/resources/app.asar', file)),
          fs.readFileSync(path.join(__dirname, '..', file)), `packaged ${file} matches reviewed source`);
      }
    }
    const calendar = require(sourceRoot + 'ics');
    const outlook = require(sourceRoot + 'outlook');
    const from = new Date('2026-10-13T00:00:00Z');
    const to = new Date('2026-10-16T00:00:00Z');
    const events = calendar.toEvents('BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:smoke-cal\nSUMMARY:Calendar smoke\nDTSTART:20261014T170000Z\nDTEND:20261014T180000Z\nEND:VEVENT\nEND:VCALENDAR', from, to);
    assert.equal(events.length, 1);
    assert.equal(events[0].title, 'Calendar smoke');
    const allDay = outlook.normalizeGraphEvent({ id: 'all-day-smoke', isAllDay: true, originalStartTimeZone: 'Eastern Standard Time', start: { dateTime: '2026-10-14T04:00:00', timeZone: 'UTC' }, end: { dateTime: '2026-10-15T04:00:00', timeZone: 'UTC' } });
    assert.equal(new Date(allDay.start).getDate(), 14);
    assert.equal(await run("document.getElementById('viewDash').hidden"), false);
    const taskResult = await run(`(async () => {
      document.getElementById('quickTaskInput').value = 'Dashboard smoke task';
      document.getElementById('quickTask').requestSubmit();
      await new Promise(r => setTimeout(r, 250));
      const quick = (await api.listTasks()).find(t => t.title === 'Dashboard smoke task');
      if (!quick) throw new Error('Quick task was not saved');
      await api.updateTask(quick.id, { done: true });
      window.MN.showView('tasks');
      document.getElementById('tTitle').value = 'Task form smoke';
      document.getElementById('tPriority').value = 'high';
      document.getElementById('tDue').value = '2026-10-16';
      document.getElementById('taskForm').requestSubmit();
      await new Promise(r => setTimeout(r, 250));
      const tasks = await api.listTasks();
      window.MN.showView('dashboard');
      return tasks;
    })()`);
    assert.equal(taskResult.find(t => t.title === 'Dashboard smoke task').done, true);
    assert.equal(taskResult.find(t => t.title === 'Task form smoke').priority, 'high');
    assert.equal(taskResult.find(t => t.title === 'Task form smoke').due, '2026-10-16');
    await delay(250);
    fs.writeFileSync(path.join(dataDir, 'dashboard.png'), (await win.webContents.capturePage()).toPNG());
    assert.equal(await run('typeof window.api.createMeeting'), 'function');
    assert.equal(await run('typeof window.api.publishGithub'), 'undefined');
    assert.equal(await run('typeof window.api.testGithub'), 'undefined');
    assert.equal(await run("document.getElementById('ghBtn')"), null);
    assert.equal(await run("document.getElementById('sGhToken')"), null);
    await run("document.getElementById('settingsBtn').click()");
    await delay(200);
    assert.ok(await run("document.getElementById('updateStatus').textContent.includes('installed Windows app')"));
    assert.equal(await run("document.getElementById('updateCheck').disabled"), true);
    await run("document.getElementById('olConnect').click()");
    await delay(250);
    assert.equal(await run("document.getElementById('olDlg').open"), true);
    assert.ok(await run("document.getElementById('olMsg').textContent.includes('Application (client) ID')"));
    await run("document.getElementById('olCancel').click()");
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
    // A delayed response for meeting A must not appear in meeting B.
    const { createStore } = require(sourceRoot + 'store');
    const testStore = createStore(dataDir, {});
    ipcMain.removeHandler('meetings:addNote');
    ipcMain.handle('meetings:addNote', async (_, id, note) => { await delay(300); return testStore.addNote(id, note); });
    await run(`(async () => {
      await MN.openMeeting(${JSON.stringify(result.a.id)});
      document.getElementById('noteInput').value = 'Delayed note belongs to A';
      document.getElementById('noteBtn').click();
      await MN.openMeeting(${JSON.stringify(result.b.id)});
    })()`);
    await delay(400);
    assert.equal(await run("document.getElementById('notes').textContent.includes('Delayed note belongs to A')"), false);
    assert.ok(testStore.get(result.a.id).notes.some(n => n.text === 'Delayed note belongs to A'));
    testStore.setSummary(result.a.id, { executive_summary: 'Summary A' });
    ipcMain.removeHandler('render:html');
    ipcMain.handle('render:html', async () => { await delay(300); return '<p>Delayed summary belongs to A</p>'; });
    await run(`(async () => { await MN.openMeeting(${JSON.stringify(result.a.id)}); await MN.openMeeting(${JSON.stringify(result.b.id)}); })()`);
    await delay(400);
    assert.equal(await run("document.getElementById('summary').textContent.includes('Delayed summary belongs to A')"), false);
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
    // Save and decode real browser-recorded audio without using a microphone or speaker.
    const savedAudio = await run(`(async () => {
      const id = ${JSON.stringify(result.b.id)};
      const ctx = new AudioContext();
      const tone = ctx.createOscillator();
      const dest = ctx.createMediaStreamDestination();
      const mute = ctx.createGain(); mute.gain.value = 0;
      tone.connect(mute); mute.connect(ctx.destination);
      tone.connect(dest); tone.start(); await ctx.resume();
      const warnings = [];
      const recorder = createRecorder(dest.stream, 'you', 0, {
        begin: (source, t, mime) => api.audioBegin(id, { source, t, mime }),
        append: (name, bytes) => api.audioAppend(id, name, bytes)
      }, msg => warnings.push(msg));
      if (!recorder) throw new Error('Browser recording is unavailable');
      await new Promise(r => setTimeout(r, 1200));
      await recorder.stop(); tone.stop(); await ctx.close();
      const files = (await api.audioList(id)).filter(f => f.bytes > 0);
      if (!files.length) throw new Error('MediaRecorder produced no saved audio');
      const pcm = await MNAudio.decode(await api.audioRead(id, files[0].name));
      return { bytes: files[0].bytes, samples: pcm.length, warnings };
    })()`);
    assert.ok(savedAudio.bytes > 0 && savedAudio.samples > 0, 'recorded WebM can be decoded after saving');
    assert.deepEqual(savedAudio.warnings, []);
    let releaseReady;
    ipcMain.removeHandler('model:ensure');
    ipcMain.handle('model:ensure', () => new Promise(resolve => { releaseReady = resolve; }));
    let wipes = 0;
    ipcMain.removeHandler('data:wipe');
    ipcMain.handle('data:wipe', () => { wipes++; return false; });
    await run(`(async () => { await MN.openMeeting(${JSON.stringify(result.b.id)}); })()`);
    await delay(100);
    await run("document.getElementById('retxBtn').click()");
    for (let i = 0; !releaseReady && i < 30; i++) await delay(100);
    assert.ok(releaseReady, 'saved audio job has started');
    await run("document.getElementById('newBtn').click()");
    assert.equal(await run("document.getElementById('newDlg').open"), false, 'new meeting is blocked during transcription');
    await run("document.getElementById('settingsBtn').click()");
    await delay(150);
    await run("document.getElementById('sWipe').click()");
    assert.equal(wipes, 0, 'deleting all data is blocked during transcription');
    await run("document.getElementById('sCancel').click(); document.getElementById('audioCancelBtn').click()");
    releaseReady(true);
    await delay(300);
    assert.equal(await run("document.getElementById('startBtn').disabled"), false, 'cancelling releases the job controls');
    assert.deepEqual(errors, [], 'no renderer errors');
    console.log('PASS: dashboard/task creation and completion, removed publishing UI/API, updater settings, meeting edits/notes, PDF exports, widget, and recording lifecycle (fake capture).');
    clearTimeout(deadline);
    app.exit(0);
  } catch (error) {
    console.error(error);
    clearTimeout(deadline);
    app.exit(1);
  }
});
