'use strict';
// Summary templates. Every template keeps the standard summary (decisions, action items, follow-up agenda),
// so tasks, the dashboard and exports work the same. A template adds a focus for the AI and, optionally,
// extra sections written for that kind of meeting.
//
// Your own templates: put .json files in the "templates" folder inside the MeetNotes data folder
// (Settings has a button that opens it). Shape:
// { "id": "site-visit", "name": "Site visit", "focus": "...", "sections": [{ "title": "...", "instruction": "..." }] }
const fs = require('fs');
const path = require('path');
const { readJson } = require('./fsutil');

const ID = /^[a-z0-9][a-z0-9-]{0,60}$/;

const BUILT_IN = [
  {
    id: 'standard',
    name: 'Standard meeting',
    focus: '',
    sections: [],
  },
  {
    id: 'standup',
    name: 'Daily standup',
    focus: 'This is a short daily status meeting. Keep everything brief. Blockers matter most.',
    sections: [
      { title: 'Progress since last standup', instruction: 'One bullet per person who gave an update, naming the person only when the transcript or notes name them.' },
      { title: 'Plans until the next standup', instruction: 'One bullet per person who said what they will work on next.' },
      { title: 'Blockers', instruction: 'Every blocker or dependency raised, with who can unblock it when that was said.' },
    ],
  },
  {
    id: 'project-sync',
    name: 'Project status',
    focus: 'This is a project status meeting. Pay close attention to schedule, budget, scope and dependencies.',
    sections: [
      { title: 'Status by workstream', instruction: 'One bullet per workstream or area discussed, with its status as stated (on track, at risk, late) and why.' },
      { title: 'Schedule and budget', instruction: 'Dates, milestones, costs and amounts mentioned, exactly as stated. Do not calculate or estimate.' },
      { title: 'Dependencies', instruction: 'What this project is waiting on from others, and what others are waiting on from it.' },
    ],
  },
  {
    id: 'client-call',
    name: 'Client or vendor call',
    focus: 'This is a call with an external client or vendor. Separate what they asked for from what we committed to.',
    sections: [
      { title: 'Their needs and concerns', instruction: 'What the client or vendor asked for, complained about or cares about, in their terms.' },
      { title: 'Our commitments', instruction: 'Everything our side promised to deliver or check, with dates only when stated.' },
      { title: 'Their commitments', instruction: 'Everything the client or vendor promised to send or do.' },
    ],
  },
  {
    id: 'one-on-one',
    name: 'One-to-one',
    focus: 'This is a one-to-one conversation between two people. Keep a neutral, factual tone.',
    sections: [
      { title: 'Topics discussed', instruction: 'Each topic raised, with the main point in one sentence.' },
      { title: 'Feedback', instruction: 'Feedback given in either direction, stated factually.' },
    ],
  },
  {
    id: 'retrospective',
    name: 'Retrospective',
    focus: 'This is a retrospective looking back on a piece of work.',
    sections: [
      { title: 'What went well', instruction: 'Points the group said worked well.' },
      { title: 'What did not go well', instruction: 'Problems and frustrations raised.' },
      { title: 'Improvements agreed', instruction: 'Changes the group agreed to try next time. Only include what was agreed, not every suggestion.' },
    ],
  },
];

function clean(raw, fallbackId) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || fallbackId || '').toLowerCase();
  const name = String(raw.name || '').trim().slice(0, 80);
  if (!ID.test(id) || !name) return null;
  const sections = (Array.isArray(raw.sections) ? raw.sections : [])
    .map((x) => ({ title: String((x && x.title) || '').trim().slice(0, 80), instruction: String((x && x.instruction) || '').trim().slice(0, 600) }))
    .filter((x) => x.title)
    .slice(0, 8);
  return { id, name, focus: String(raw.focus || '').trim().slice(0, 1500), sections, custom: true };
}

// Built-in templates first, then valid files from dir. A custom file with a built-in id replaces it.
function listTemplates(dir) {
  const byId = new Map(BUILT_IN.map((t) => [t.id, t]));
  if (dir) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.json')); } catch { /* no folder yet */ }
    for (const f of files.sort()) {
      try {
        const t = clean(readJson(path.join(dir, f)), path.basename(f, '.json'));
        if (t) byId.set(t.id, t);
      } catch { /* skip files that are not valid JSON */ }
    }
  }
  return [...byId.values()];
}

function getTemplate(id, dir) {
  const all = listTemplates(dir);
  return all.find((t) => t.id === id) || all.find((t) => t.id === 'standard');
}

// Text added to the summary prompt for this template. Empty for the standard template.
function promptFor(template) {
  if (!template || (!template.focus && !template.sections.length)) return '';
  const lines = [`Meeting type: ${template.name}.`];
  if (template.focus) lines.push(template.focus);
  if (template.sections.length) {
    lines.push('In addition to the standard fields, fill "template_sections" with exactly these sections, in this order:');
    template.sections.forEach((s, i) => lines.push(`${i + 1}. "${s.title}": ${s.instruction || 'Summarize what was said about this.'}`));
    lines.push(`Each section is {"title": "", "items": [""]}. When nothing was said about a section, give it an empty items array.`);
  }
  return lines.join('\n');
}

module.exports = { BUILT_IN, listTemplates, getTemplate, promptFor, clean };
