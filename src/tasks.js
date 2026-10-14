'use strict';
// Personal task list. Tasks are added by hand or imported from a meeting's action items.
const fs = require('fs');
const path = require('path');
const { writeAtomic, readJson } = require('./fsutil');

const TBC = /^data to be confirmed$/i;

function pad(n) { return String(n).padStart(2, '0'); }
function ymd(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

function isIsoDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00');
  return !isNaN(d) && ymd(d) === s;
}

function normPriority(p) {
  const s = String(p || '').toLowerCase().trim();
  if (s.startsWith('h') || s === 'urgent' || s === 'critical') return 'high';
  if (s.startsWith('l')) return 'low';
  return 'med';
}

function cleanOwner(o) {
  const s = String(o || '').trim();
  return !s || TBC.test(s) ? '' : s.slice(0, 120);
}

function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// A task is "mine" when it has no owner, says me/you, or names the user.
function isMine(task, myName) {
  const owner = String(task.owner || '').trim();
  if (!owner) return true;
  if (/^(me|myself|i|you|unassigned|none|n\/a|tbc)$/i.test(owner)) return true;
  const tokens = String(myName || '').toLowerCase().split(/\s+/).filter((t) => t.length >= 2);
  const o = owner.toLowerCase();
  return tokens.some((t) => new RegExp('\\b' + esc(t) + '\\b').test(o));
}


const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

function createTaskStore(baseDir) {
  const file = path.join(baseDir, 'tasks.json');
  fs.mkdirSync(baseDir, { recursive: true });

  function read() {
    try {
      const a = readJson(file);
      return Array.isArray(a) ? a : [];
    } catch {
      return [];
    }
  }
  function write(list) { writeAtomic(file, JSON.stringify(list, null, 2)); }
  function newId(list) {
    let n = Date.now();
    const ids = new Set(list.map((t) => t.id));
    while (ids.has(`t_${n}`)) n += 1;
    return `t_${n}`;
  }

  function build(list, input) {
    const title = String(input.title || '').trim().slice(0, 300);
    if (!title) throw new Error('A task needs a title.');
    const rawDue = String(input.due || '').trim();
    return {
      id: newId(list),
      title,
      priority: normPriority(input.priority),
      due: isIsoDate(rawDue) ? rawDue : null,
      dueText: !isIsoDate(rawDue) && rawDue && !TBC.test(rawDue) ? rawDue.slice(0, 80) : '',
      owner: cleanOwner(input.owner),
      note: String(input.note || '').trim().slice(0, 1000),
      done: false,
      doneAt: null,
      createdAt: new Date().toISOString(),
      source: input.source === 'summary' ? 'summary' : 'manual',
      meetingId: typeof input.meetingId === 'string' ? input.meetingId : null,
      edited: false,
    };
  }

  function add(input) {
    const list = read();
    const task = build(list, input || {});
    list.push(task);
    write(list);
    return task;
  }

  function update(id, patch) {
    const list = read();
    const t = list.find((x) => x.id === id);
    if (!t) throw new Error('Task not found.');
    let edited = false;
    if (typeof patch.title === 'string' && patch.title.trim()) { t.title = patch.title.trim().slice(0, 300); edited = true; }
    if ('priority' in patch) { t.priority = normPriority(patch.priority); edited = true; }
    if ('due' in patch) {
      const v = String(patch.due || '').trim();
      t.due = isIsoDate(v) ? v : null;
      t.dueText = !t.due && v && !TBC.test(v) ? v.slice(0, 80) : '';
      edited = true;
    }
    if ('owner' in patch) { t.owner = cleanOwner(patch.owner); edited = true; }
    if ('note' in patch) { t.note = String(patch.note || '').trim().slice(0, 1000); edited = true; }
    if (edited) t.edited = true;
    if (typeof patch.done === 'boolean' && patch.done !== t.done) {
      t.done = patch.done;
      t.doneAt = patch.done ? new Date().toISOString() : null;
    }
    write(list);
    return t;
  }

  function remove(id) {
    write(read().filter((t) => t.id !== id));
  }

  // Imports a meeting's action items. Items previously imported from the same meeting that the user
  // has not touched are replaced, so regenerating a summary does not leave reworded duplicates.
  function importFromSummary(meeting) {
    const items = (meeting && meeting.summary && meeting.summary.action_items) || [];
    let list = read();
    list = list.filter((t) => !(t.source === 'summary' && t.meetingId === meeting.id && !t.done && !t.edited));
    const keep = new Set(list.filter((t) => t.meetingId === meeting.id).map((t) => norm(t.title)));
    let added = 0;
    for (const a of items) {
      const title = String(a.task || '').trim();
      if (!title || TBC.test(title) || keep.has(norm(title))) continue;
      list.push(build(list, {
        title, owner: a.owner, priority: a.priority, due: a.due,
        source: 'summary', meetingId: meeting.id,
      }));
      keep.add(norm(title));
      added += 1;
    }
    write(list);
    return { added, total: items.length };
  }

  return { list: read, add, update, remove, importFromSummary };
}

module.exports = { createTaskStore, isMine, isIsoDate, normPriority, ymd };
