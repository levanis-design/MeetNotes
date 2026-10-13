'use strict';
// Local storage for meetings and settings. No Electron dependency, so it can be tested directly.
const fs = require('fs');
const path = require('path');
const { isCorner, isSize } = require('./mini-layout');

const ID_PATTERN = /^m_\d+$/;
const UPDATABLE = ['title', 'attendees', 'agendaPre', 'status', 'startedAt', 'endedAt', 'elapsedSec', 'notes', 'github'];

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
    githubTokenEnc: null,
    githubRepo: 'meeting-notes',
    githubPrivate: true,
    miniAppearance: 'solid', // 'solid' or 'transparent'
    miniOpacity: 55,         // idle opacity in percent, used when transparent
    miniCorner: 'top-right',
    miniSize: 'pill',        // 'card', 'pill' or 'dot'
    autoMini: true,
    mainAlwaysOnTop: false,
  };

  function readSettings() {
    try {
      return { ...defaults, ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')) };
    } catch {
      return { ...defaults };
    }
  }

  function getSettings() {
    const s = readSettings();
    return {
      model: s.model,
      whisperModel: s.whisperModel,
      hasKey: Boolean(s.apiKeyEnc),
      hasGithubToken: Boolean(s.githubTokenEnc),
      githubRepo: s.githubRepo,
      githubPrivate: s.githubPrivate,
      miniAppearance: s.miniAppearance,
      miniOpacity: s.miniOpacity,
      miniCorner: s.miniCorner,
      miniSize: s.miniSize,
      autoMini: s.autoMini,
      mainAlwaysOnTop: s.mainAlwaysOnTop,
    };
  }

  function setSettings(patch) {
    const s = readSettings();
    if (typeof patch.model === 'string' && patch.model.trim()) s.model = patch.model.trim();
    if (typeof patch.whisperModel === 'string' && patch.whisperModel.trim()) s.whisperModel = patch.whisperModel.trim();
    if (typeof patch.apiKey === 'string') {
      s.apiKeyEnc = patch.apiKey.trim() ? cipher.encrypt(patch.apiKey.trim()) : null;
    }
    if (typeof patch.githubToken === 'string') {
      s.githubTokenEnc = patch.githubToken.trim() ? cipher.encrypt(patch.githubToken.trim()) : null;
    }
    if (typeof patch.githubRepo === 'string' && patch.githubRepo.trim()) s.githubRepo = patch.githubRepo.trim().slice(0, 200);
    if (typeof patch.githubPrivate === 'boolean') s.githubPrivate = patch.githubPrivate;
    if (patch.miniAppearance === 'solid' || patch.miniAppearance === 'transparent') s.miniAppearance = patch.miniAppearance;
    if (typeof patch.miniOpacity === 'number' && isFinite(patch.miniOpacity)) {
      s.miniOpacity = Math.min(100, Math.max(20, Math.round(patch.miniOpacity)));
    }
    if (isCorner(patch.miniCorner)) s.miniCorner = patch.miniCorner;
    if (isSize(patch.miniSize)) s.miniSize = patch.miniSize;
    if (typeof patch.autoMini === 'boolean') s.autoMini = patch.autoMini;
    if (typeof patch.mainAlwaysOnTop === 'boolean') s.mainAlwaysOnTop = patch.mainAlwaysOnTop;
    writeAtomic(settingsFile, JSON.stringify(s, null, 2));
    return getSettings();
  }

  function getApiKey() {
    const s = readSettings();
    return s.apiKeyEnc ? cipher.decrypt(s.apiKeyEnc) : null;
  }

  function getGithubToken() {
    const s = readSettings();
    return s.githubTokenEnc ? cipher.decrypt(s.githubTokenEnc) : null;
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

  function create({ title, attendees, agendaPre } = {}) {
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
      github: null,
    };
    return write(meeting);
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
          published: Boolean(m.github),
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
    getSettings, setSettings, getApiKey, getGithubToken,
    create, list, get, update, appendTranscript, addNote, setSummary, remove, wipeAll,
  };
}

module.exports = { createStore, ID_PATTERN };
