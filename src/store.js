'use strict';
// Local storage for meetings and settings. No Electron dependency, so it can be tested directly.
const fs = require('fs');
const path = require('path');
const { isCorner, isSize } = require('./mini-layout');
const { normalizeIcsUrl } = require('./links');

const ID_PATTERN = /^m_\d+$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TENANT = /^[A-Za-z0-9][A-Za-z0-9.-]{0,98}$/;
const TBC = /^data to be confirmed$/i;

function snippet(text, n) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
}
const UPDATABLE = ['title', 'attendees', 'agendaPre', 'status', 'startedAt', 'endedAt', 'elapsedSec', 'notes', 'calendarEventId'];

function writeAtomic(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function createStore(baseDir, cipher) {
  const meetingsDir = path.join(baseDir, 'meetings');
  const settingsFile = path.join(baseDir, 'settings.json');
  fs.mkdirSync(meetingsDir, { recursive: true });

  const defaults = {
    model: 'claude-sonnet-5-5',
    whisperModel: 'Xenova/whisper-base.en',
    apiKeyEnc: null,
    miniAppearance: 'solid', // 'solid' or 'transparent'
    miniOpacity: 55,         // idle opacity in percent, used when transparent
    miniCorner: 'top-right',
    miniSize: 'pill',        // 'card', 'pill' or 'dot'
    autoMini: true,
    mainAlwaysOnTop: false,
    myName: '',
    autoTasks: true,
    outlookClientId: '',
    outlookTenant: 'common',
    outlookTokenEnc: null,
    outlookAccount: '',
    icsUrlEnc: null,
  };

  function readSettings() {
    try {
      return { ...defaults, ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')) };
    } catch {
      return { ...defaults };
    }
  }

  // Remove obsolete publishing credentials on upgrade, keeping meetings and Claude settings.
  const initialSettings = readSettings();
  let removedLegacy = false;
  for (const key of ['githubTokenEnc', 'githubRepo', 'githubPrivate']) {
    if (key in initialSettings) { delete initialSettings[key]; removedLegacy = true; }
  }
  if (removedLegacy) writeAtomic(settingsFile, JSON.stringify(initialSettings, null, 2));

  function getSettings() {
    const s = readSettings();
    return {
      model: s.model,
      whisperModel: s.whisperModel,
      hasKey: Boolean(s.apiKeyEnc),
      miniAppearance: s.miniAppearance,
      miniOpacity: s.miniOpacity,
      miniCorner: s.miniCorner,
      miniSize: s.miniSize,
      autoMini: s.autoMini,
      mainAlwaysOnTop: s.mainAlwaysOnTop,
      myName: s.myName,
      autoTasks: s.autoTasks,
      outlookClientId: s.outlookClientId,
      outlookTenant: s.outlookTenant,
      hasOutlook: Boolean(s.outlookTokenEnc),
      outlookAccount: s.outlookAccount,
      hasIcs: Boolean(s.icsUrlEnc),
    };
  }

  function setSettings(patch) {
    const s = readSettings();
    // Validate calendar fields first so a bad value changes nothing.
    let icsEnc;
    if (typeof patch.icsUrl === 'string') {
      icsEnc = patch.icsUrl.trim() ? cipher.encrypt(normalizeIcsUrl(patch.icsUrl)) : null;
    }
    if (typeof patch.outlookClientId === 'string') {
      const v = patch.outlookClientId.trim();
      if (v && !GUID.test(v)) throw new Error('The Application (client) ID should look like 00000000-0000-0000-0000-000000000000.');
    }
    if (typeof patch.outlookTenant === 'string') {
      const v = patch.outlookTenant.trim() || 'common';
      if (!TENANT.test(v)) throw new Error('The Directory (tenant) value should be a tenant ID, a domain name, or "common".');
    }
    if (typeof patch.model === 'string' && patch.model.trim()) s.model = patch.model.trim();
    if (typeof patch.whisperModel === 'string' && patch.whisperModel.trim()) s.whisperModel = patch.whisperModel.trim();
    if (typeof patch.apiKey === 'string') {
      s.apiKeyEnc = patch.apiKey.trim() ? cipher.encrypt(patch.apiKey.trim()) : null;
    }
    if (patch.miniAppearance === 'solid' || patch.miniAppearance === 'transparent') s.miniAppearance = patch.miniAppearance;
    if (typeof patch.miniOpacity === 'number' && isFinite(patch.miniOpacity)) {
      s.miniOpacity = Math.min(100, Math.max(20, Math.round(patch.miniOpacity)));
    }
    if (isCorner(patch.miniCorner)) s.miniCorner = patch.miniCorner;
    if (isSize(patch.miniSize)) s.miniSize = patch.miniSize;
    if (typeof patch.autoMini === 'boolean') s.autoMini = patch.autoMini;
    if (typeof patch.mainAlwaysOnTop === 'boolean') s.mainAlwaysOnTop = patch.mainAlwaysOnTop;
    if (typeof patch.myName === 'string') s.myName = patch.myName.trim().slice(0, 80);
    if (typeof patch.autoTasks === 'boolean') s.autoTasks = patch.autoTasks;
    // Changing the app registration or directory makes the saved Outlook sign-in invalid.
    if (typeof patch.outlookClientId === 'string') {
      const v = patch.outlookClientId.trim();
      if (v !== s.outlookClientId) { s.outlookTokenEnc = null; s.outlookAccount = ''; }
      s.outlookClientId = v;
    }
    if (typeof patch.outlookTenant === 'string') {
      const v = patch.outlookTenant.trim() || 'common';
      if (v !== s.outlookTenant) { s.outlookTokenEnc = null; s.outlookAccount = ''; }
      s.outlookTenant = v;
    }
    if (icsEnc !== undefined) s.icsUrlEnc = icsEnc;
    writeAtomic(settingsFile, JSON.stringify(s, null, 2));
    return getSettings();
  }

  function getApiKey() {
    const s = readSettings();
    return s.apiKeyEnc ? cipher.decrypt(s.apiKeyEnc) : null;
  }

  function getOutlookRefresh() {
    const s = readSettings();
    return s.outlookTokenEnc ? cipher.decrypt(s.outlookTokenEnc) : null;
  }
  function setOutlookRefresh(token, account) {
    const s = readSettings();
    s.outlookTokenEnc = token ? cipher.encrypt(token) : null;
    if (!token) s.outlookAccount = '';
    else if (typeof account === 'string') s.outlookAccount = account.slice(0, 200);
    writeAtomic(settingsFile, JSON.stringify(s, null, 2));
  }
  function getIcsUrl() {
    const s = readSettings();
    return s.icsUrlEnc ? cipher.decrypt(s.icsUrlEnc) : null;
  }

  function fileFor(id) {
    if (!ID_PATTERN.test(String(id))) throw new Error('Invalid meeting id');
    return path.join(meetingsDir, id + '.json');
  }

  function get(id) {
    return JSON.parse(fs.readFileSync(fileFor(id), 'utf8'));
  }

  function write(meeting) {
    writeAtomic(fileFor(meeting.id), JSON.stringify(meeting, null, 2));
    return meeting;
  }

  function create({ title, attendees, agendaPre, calendarEventId } = {}) {
    let n = Date.now();
    while (fs.existsSync(path.join(meetingsDir, `m_${n}.json`))) n += 1;
    const meeting = {
      id: `m_${n}`,
      title: (title || '').trim() || 'Untitled meeting',
      attendees: (attendees || '').trim(),
      agendaPre: (agendaPre || '').trim(),
      status: 'planned',
      createdAt: new Date().toISOString(),
      startedAt: null,
      endedAt: null,
      elapsedSec: 0,
      transcript: [],
      notes: [],
      summary: null,
      generatedAt: null,
      calendarEventId: typeof calendarEventId === 'string' && calendarEventId ? calendarEventId : null,
    };
    return write(meeting);
  }

  function excerptFor(m) {
    const sum = m.summary && m.summary.executive_summary;
    if (sum && !TBC.test(sum)) return snippet(sum, 150);
    if ((m.notes || []).length) return snippet(m.notes[0].text, 150);
    const tx = (m.transcript || []).slice().sort((a, b) => a.t - b.t)[0];
    if (tx) return snippet(tx.text, 150);
    return snippet((m.agendaPre || '').split('\n')[0], 150);
  }

  function findByCalendarEvent(eventId) {
    return list().find((m) => m.calendarEventId === eventId) || null;
  }

  function list() {
    const out = [];
    for (const f of fs.readdirSync(meetingsDir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const m = JSON.parse(fs.readFileSync(path.join(meetingsDir, f), 'utf8'));
        out.push({
          id: m.id,
          title: m.title,
          status: m.status,
          createdAt: m.createdAt,
          startedAt: m.startedAt,
          endedAt: m.endedAt,
          hasSummary: Boolean(m.summary),
          generatedAt: m.generatedAt || null,
          calendarEventId: m.calendarEventId || null,
          decisions: m.summary ? (m.summary.decisions || []).length : 0,
          actions: m.summary ? (m.summary.action_items || []).length : 0,
          summaryText: m.summary && !TBC.test(m.summary.executive_summary || '') ? snippet(m.summary.executive_summary, 280) : '',
          excerpt: excerptFor(m),
        });
      } catch {
        // skip unreadable file
      }
    }
    return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  function update(id, patch) {
    const m = get(id);
    for (const k of UPDATABLE) {
      if (k in patch) m[k] = patch[k];
    }
    return write(m);
  }

  function appendTranscript(id, item) {
    const m = get(id);
    m.transcript.push(item);
    m.transcript.sort((a, b) => a.t - b.t);
    write(m);
    return item;
  }

  function addNote(id, note) {
    const m = get(id);
    const item = { t: typeof note.t === 'number' ? note.t : null, text: String(note.text || '').trim() };
    if (!item.text) return null;
    m.notes.push(item);
    write(m);
    return item;
  }

  function setSummary(id, summary) {
    const m = get(id);
    m.summary = summary;
    m.generatedAt = new Date().toISOString();
    return write(m);
  }

  function remove(id) {
    fs.rmSync(fileFor(id), { force: true });
  }

  function wipeAll() {
    fs.rmSync(meetingsDir, { recursive: true, force: true });
    fs.mkdirSync(meetingsDir, { recursive: true });
  }

  return {
    getSettings, setSettings, getApiKey, getOutlookRefresh, setOutlookRefresh, getIcsUrl, findByCalendarEvent,
    create, list, get, update, appendTranscript, addNote, setSummary, remove, wipeAll,
  };
}

module.exports = { createStore, ID_PATTERN };
