'use strict';
// Claude calls: after-meeting summary, action items and follow-up agenda.

const TBC = 'Data to be confirmed';
const MAX_TRANSCRIPT_CHARS = 600000;

const SYSTEM_PROMPT = `You write after-meeting records for a busy operations professional.

Rules
- Use only what appears in the transcript, the typed notes and the pre-meeting context. Do not invent owners, dates, amounts, names or decisions.
- Where a detail is missing, write "${TBC}".
- Speaker labels: "You" is the person running this app (microphone). "Others" is everyone else on the call (system audio). Individual speakers among "Others" cannot be told apart, so attribute to a person only when the transcript or notes name them.
- The transcript is automatic speech recognition and can contain errors in names, numbers and terminology. When a name, number or date looks uncertain, add it to missing_information instead of guessing.
- A decision is something explicitly agreed. Discussion without agreement belongs in risks_and_open_items.
- Write concise, direct, professional business English. No emojis. Write "and" instead of ampersands. Write words in full.
- Lead with the conclusion. Keep each item to one or two sentences.
- The follow_up_agenda is for the next meeting on this topic. Build it from open items, unresolved questions, and action items that need review. Propose a realistic time in minutes for each item. These times are proposals, not facts from the meeting.
- If a planned agenda was provided, report in agenda_coverage whether each planned item was covered. If none was provided, return an empty array.

Respond with one JSON object only, no markdown fences and no commentary, using exactly this shape:
{
  "executive_summary": "2 to 4 sentences, conclusion first",
  "decisions": [{"decision": "", "context": ""}],
  "action_items": [{"task": "", "owner": "", "due": "", "priority": ""}],
  "risks_and_open_items": [{"item": "", "why_it_matters": ""}],
  "agenda_coverage": [{"item": "", "status": "covered | partly covered | not covered", "comment": ""}],
  "follow_up_agenda": {"title": "", "objective": "", "items": [{"topic": "", "purpose": "", "owner": "", "minutes": 0}]},
  "missing_information": [""]
}
Use "${TBC}" for owner, due or priority when not stated or not clearly implied.
For "due", write a date as YYYY-MM-DD when a specific date is stated, or when a relative date such as "Friday" or "next Tuesday" can be resolved with certainty from the meeting start date given in the input. Otherwise write "${TBC}". For "priority", use high, med or low only when it is stated or clearly implied.`;

function mmss(sec) {
  if (typeof sec !== 'number' || !isFinite(sec)) return '--:--';
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(r)}` : `${pad(m)}:${pad(r)}`;
}

function transcriptText(meeting) {
  return [...meeting.transcript]
    .sort((a, b) => a.t - b.t)
    .map((x) => `[${mmss(x.t)}] ${x.source === 'you' ? 'You' : 'Others'}: ${x.text}`)
    .join('\n');
}

function buildUserMessage(meeting, instruction) {
  const parts = [];
  parts.push(`Meeting title: ${meeting.title}`);
  if (meeting.attendees) parts.push(`Attendees (as entered by the user): ${meeting.attendees}`);
  if (meeting.startedAt) parts.push(`Started: ${meeting.startedAt}`);
  parts.push(`Planned agenda or context:\n${meeting.agendaPre || '(none provided)'}`);
  const notes = (meeting.notes || []).map((n) => `[${mmss(n.t)}] ${n.text}`).join('\n');
  parts.push(`Typed notes:\n${notes || '(none)'}`);
  const tx = transcriptText(meeting);
  parts.push(`Transcript:\n${tx || '(none)'}`);
  if (instruction && instruction.trim()) parts.push(`Extra instruction from the user:\n${instruction.trim()}`);
  return parts.join('\n\n');
}

function extractJson(text) {
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s < 0 || e < s) throw new Error('The AI response did not contain a JSON object.');
  return JSON.parse(text.slice(s, e + 1));
}

const str = (v, d = '') => (typeof v === 'string' && v.trim() ? v.trim() : d);
const arr = (v) => (Array.isArray(v) ? v : []);

function normalize(raw) {
  const fu = raw.follow_up_agenda && typeof raw.follow_up_agenda === 'object' ? raw.follow_up_agenda : {};
  return {
    executive_summary: str(raw.executive_summary, TBC),
    decisions: arr(raw.decisions).map((d) => ({ decision: str(d.decision, TBC), context: str(d.context) })),
    action_items: arr(raw.action_items).map((a) => ({
      task: str(a.task, TBC),
      owner: str(a.owner, TBC),
      due: str(a.due, TBC),
      priority: str(a.priority, TBC),
    })),
    risks_and_open_items: arr(raw.risks_and_open_items).map((r) => ({
      item: str(r.item, TBC),
      why_it_matters: str(r.why_it_matters),
    })),
    agenda_coverage: arr(raw.agenda_coverage).map((c) => ({
      item: str(c.item, TBC),
      status: str(c.status, TBC),
      comment: str(c.comment),
    })),
    follow_up_agenda: {
      title: str(fu.title, TBC),
      objective: str(fu.objective, TBC),
      items: arr(fu.items).map((i) => ({
        topic: str(i.topic, TBC),
        purpose: str(i.purpose),
        owner: str(i.owner, TBC),
        minutes: Number.isFinite(Number(i.minutes)) && Number(i.minutes) > 0 ? Math.round(Number(i.minutes)) : null,
      })),
    },
    missing_information: arr(raw.missing_information).map((m) => str(m)).filter(Boolean),
  };
}

function responseText(resp) {
  return (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
}

function makeClient(apiKey) {
  const Anthropic = require('@anthropic-ai/sdk');
  const Ctor = Anthropic.default || Anthropic;
  return new Ctor({ apiKey });
}

async function generateSummary({ apiKey, model, meeting, instruction, client }) {
  const hasContent = (meeting.transcript || []).length || (meeting.notes || []).length;
  if (!hasContent) throw new Error('There is no transcript or notes to summarize yet.');
  const message = buildUserMessage(meeting, instruction);
  if (message.length > MAX_TRANSCRIPT_CHARS) {
    throw new Error('This meeting is too long to summarize in one request. Trim the transcript or split the meeting.');
  }
  const c = client || makeClient(apiKey);
  const resp = await c.messages.create({
    model,
    max_tokens: 6000,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: message }],
  });
  if (resp.stop_reason === 'max_tokens') {
    throw new Error('The AI response was cut off. Try again, or add an instruction asking for a shorter summary.');
  }
  return normalize(extractJson(responseText(resp)));
}

async function testKey({ apiKey, model, client }) {
  const c = client || makeClient(apiKey);
  const resp = await c.messages.create({
    model,
    max_tokens: 16,
    messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
  });
  return responseText(resp).trim().length > 0;
}

module.exports = {
  SYSTEM_PROMPT, TBC, mmss, transcriptText, buildUserMessage, extractJson, normalize,
  generateSummary, testKey,
};
