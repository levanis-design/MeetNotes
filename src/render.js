'use strict';
// Turns a meeting record into Markdown, HTML (for the app and PDF) and plain-text transcript.
const { mmss, transcriptText } = require('./ai');

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function cell(s) {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

function durationText(m) {
  const sec = Number(m.elapsedSec) || 0;
  if (!sec) return '';
  const min = Math.round(sec / 60);
  return min < 1 ? 'under 1 minute' : `${min} minute${min === 1 ? '' : 's'}`;
}

function headerLines(m) {
  const lines = [];
  const when = fmtDate(m.startedAt || m.createdAt);
  if (when) lines.push(['Date', when]);
  const dur = durationText(m);
  if (dur) lines.push(['Duration', dur]);
  if (m.attendees) lines.push(['Attendees', m.attendees]);
  return lines;
}

function totalMinutes(items) {
  return items.reduce((n, i) => n + (i.minutes || 0), 0);
}

function renderMarkdown(m, { withTranscript = false } = {}) {
  const s = m.summary;
  const out = [];
  out.push(`# ${m.title}`, '');
  for (const [k, v] of headerLines(m)) out.push(`- ${k}: ${v}`);
  out.push('');

  if (!s) {
    out.push('Summary not generated yet.', '');
  } else {
    out.push('## Executive summary', '', s.executive_summary, '');

    for (const sec of s.template_sections || []) {
      out.push(`## ${sec.title}`, '');
      if (sec.items.length) for (const x of sec.items) out.push(`- ${x}`);
      else out.push('- Nothing recorded');
      out.push('');
    }

    out.push('## Decisions', '');
    if (s.decisions.length) {
      for (const d of s.decisions) out.push(`- ${d.decision}${d.context ? ` (${d.context})` : ''}`);
    } else out.push('- No explicit decisions recorded');
    out.push('');

    out.push('## Action items', '');
    if (s.action_items.length) {
      out.push('| Task | Owner | Due | Priority |', '| --- | --- | --- | --- |');
      for (const a of s.action_items) out.push(`| ${cell(a.task)} | ${cell(a.owner)} | ${cell(a.due)} | ${cell(a.priority)} |`);
    } else out.push('- No action items recorded');
    out.push('');

    out.push('## Risks and open items', '');
    if (s.risks_and_open_items.length) {
      for (const r of s.risks_and_open_items) out.push(`- ${r.item}${r.why_it_matters ? `: ${r.why_it_matters}` : ''}`);
    } else out.push('- None recorded');
    out.push('');

    if (s.agenda_coverage.length) {
      out.push('## Planned agenda coverage', '');
      for (const c of s.agenda_coverage) out.push(`- ${c.item}: ${c.status}${c.comment ? ` (${c.comment})` : ''}`);
      out.push('');
    }

    const fu = s.follow_up_agenda;
    out.push(`## After-meeting agenda: ${fu.title}`, '', `Objective: ${fu.objective}`, '');
    if (fu.items.length) {
      out.push('| # | Topic | Purpose | Owner | Minutes |', '| --- | --- | --- | --- | --- |');
      fu.items.forEach((i, n) => out.push(`| ${n + 1} | ${cell(i.topic)} | ${cell(i.purpose)} | ${cell(i.owner)} | ${i.minutes ?? ''} |`));
      const total = totalMinutes(fu.items);
      if (total) out.push('', `Proposed total: ${total} minutes`);
    } else out.push('- No items proposed');
    out.push('');

    if (s.missing_information.length) {
      out.push('## Missing information', '');
      for (const x of s.missing_information) out.push(`- ${x}`);
      out.push('');
    }
  }

  if ((m.notes || []).length) {
    out.push('## Typed notes', '');
    for (const n of m.notes) out.push(`- [${mmss(n.t)}] ${n.text}`);
    out.push('');
  }

  if (withTranscript) {
    out.push('## Transcript', '', '```', transcriptText(m), '```', '');
  }
  return out.join('\n');
}

function renderHtml(m, { standalone = false } = {}) {
  const s = m.summary;
  const h = [];
  h.push(`<h1>${esc(m.title)}</h1>`);
  const hl = headerLines(m);
  if (hl.length) h.push('<ul class="meta">' + hl.map(([k, v]) => `<li><strong>${esc(k)}:</strong> ${esc(v)}</li>`).join('') + '</ul>');

  if (!s) {
    h.push('<p>Summary not generated yet.</p>');
  } else {
    h.push('<h2>Executive summary</h2>', `<p>${esc(s.executive_summary)}</p>`);

    for (const sec of s.template_sections || []) {
      h.push(`<h2>${esc(sec.title)}</h2>`);
      h.push(sec.items.length
        ? '<ul>' + sec.items.map((x) => `<li>${esc(x)}</li>`).join('') + '</ul>'
        : '<p class="muted">Nothing recorded</p>');
    }

    h.push('<h2>Decisions</h2>');
    h.push(s.decisions.length
      ? '<ul>' + s.decisions.map((d) => `<li>${esc(d.decision)}${d.context ? ` <span class="muted">(${esc(d.context)})</span>` : ''}</li>`).join('') + '</ul>'
      : '<p class="muted">No explicit decisions recorded</p>');

    h.push('<h2>Action items</h2>');
    h.push(s.action_items.length
      ? '<table><thead><tr><th>Task</th><th>Owner</th><th>Due</th><th>Priority</th></tr></thead><tbody>' +
        s.action_items.map((a) => `<tr><td>${esc(a.task)}</td><td>${esc(a.owner)}</td><td>${esc(a.due)}</td><td>${esc(a.priority)}</td></tr>`).join('') +
        '</tbody></table>'
      : '<p class="muted">No action items recorded</p>');

    h.push('<h2>Risks and open items</h2>');
    h.push(s.risks_and_open_items.length
      ? '<ul>' + s.risks_and_open_items.map((r) => `<li>${esc(r.item)}${r.why_it_matters ? `: ${esc(r.why_it_matters)}` : ''}</li>`).join('') + '</ul>'
      : '<p class="muted">None recorded</p>');

    if (s.agenda_coverage.length) {
      h.push('<h2>Planned agenda coverage</h2>', '<ul>' +
        s.agenda_coverage.map((c) => `<li>${esc(c.item)}: <strong>${esc(c.status)}</strong>${c.comment ? ` <span class="muted">(${esc(c.comment)})</span>` : ''}</li>`).join('') + '</ul>');
    }

    const fu = s.follow_up_agenda;
    h.push(`<h2>After-meeting agenda: ${esc(fu.title)}</h2>`, `<p><strong>Objective:</strong> ${esc(fu.objective)}</p>`);
    if (fu.items.length) {
      h.push('<table><thead><tr><th>#</th><th>Topic</th><th>Purpose</th><th>Owner</th><th>Minutes</th></tr></thead><tbody>' +
        fu.items.map((i, n) => `<tr><td>${n + 1}</td><td>${esc(i.topic)}</td><td>${esc(i.purpose)}</td><td>${esc(i.owner)}</td><td>${i.minutes ?? ''}</td></tr>`).join('') +
        '</tbody></table>');
      const total = totalMinutes(fu.items);
      if (total) h.push(`<p class="muted">Proposed total: ${total} minutes</p>`);
    } else h.push('<p class="muted">No items proposed</p>');

    if (s.missing_information.length) {
      h.push('<h2>Missing information</h2>', '<ul>' + s.missing_information.map((x) => `<li>${esc(x)}</li>`).join('') + '</ul>');
    }
  }

  if ((m.notes || []).length) {
    h.push('<h2>Typed notes</h2>', '<ul>' + m.notes.map((n) => `<li><span class="muted">[${mmss(n.t)}]</span> ${esc(n.text)}</li>`).join('') + '</ul>');
  }

  const body = h.join('\n');
  if (!standalone) return body;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(m.title)}</title><style>
    body{font-family:"Segoe UI",Arial,sans-serif;color:#1a1a1a;margin:32px;font-size:12pt;line-height:1.45}
    h1{font-size:20pt;margin:0 0 6px}h2{font-size:13pt;margin:20px 0 6px;border-bottom:1px solid #ddd;padding-bottom:3px}
    ul{margin:4px 0 4px 18px;padding:0}.meta{list-style:none;margin:0 0 8px;color:#444}
    table{border-collapse:collapse;width:100%;margin:6px 0;font-size:11pt}th,td{border:1px solid #ccc;padding:5px 7px;text-align:left;vertical-align:top}
    th{background:#f2f2f2}.muted{color:#666}
  </style></head><body>${body}</body></html>`;
}

function renderTranscriptText(m) {
  const head = `${m.title}\n${fmtDate(m.startedAt || m.createdAt)}\n\n`;
  return head + (transcriptText(m) || '(no transcript)') + '\n';
}

module.exports = { renderMarkdown, renderHtml, renderTranscriptText, esc };
