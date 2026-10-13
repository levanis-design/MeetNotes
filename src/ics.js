'use strict';
// Alternative to the Microsoft sign-in: a published calendar link (.ics) from Outlook.
// Recurring meetings, exceptions and Windows time zone names are handled by node-ical.
const { findMeetingLink, normalizeIcsUrl } = require('./links');

const MAX_BYTES = 15 * 1024 * 1024;

const text = (v) => (typeof v === 'string' ? v : v && typeof v.val === 'string' ? v.val : '');

function person(p) {
  if (!p) return '';
  const cn = p.params && p.params.CN;
  if (cn) return String(cn).replace(/^"|"$/g, '');
  return String(text(p)).replace(/^mailto:/i, '');
}

function toEvents(icsText, from, to) {
  const ical = require('node-ical');
  const data = ical.sync.parseICS(icsText);
  const out = [];
  for (const ev of Object.values(data)) {
    if (!ev || ev.type !== 'VEVENT') continue;
    if (String(ev.status || '').toUpperCase() === 'CANCELLED') continue;
    let occurrences;
    try {
      occurrences = ical.expandRecurringEvent(ev, { from, to, expandOngoing: true });
    } catch {
      continue; // one unreadable recurrence rule should not hide the rest of the calendar
    }
    for (const o of occurrences) {
      const start = o.start instanceof Date ? o.start : new Date(o.start);
      const end = o.end instanceof Date ? o.end : new Date(o.end);
      if (isNaN(start) || isNaN(end)) continue;
      const source = o.event || ev;
      const location = text(source.location);
      const attendeesRaw = [].concat(source.attendee || []);
      out.push({
        id: `${text(source.uid) || text(ev.uid)}|${start.toISOString()}`,
        title: text(o.summary || source.summary).trim() || '(No title)',
        start: start.toISOString(),
        end: end.toISOString(),
        allDay: Boolean(o.isFullDay),
        location: location.slice(0, 200),
        organizer: person(source.organizer),
        attendees: attendeesRaw.map(person).filter(Boolean).slice(0, 12),
        joinUrl: findMeetingLink(
          source['X-MICROSOFT-SKYPETEAMSMEETINGURL'] && text(source['X-MICROSOFT-SKYPETEAMSMEETINGURL']),
          location, text(source.description), text(source.url),
        ),
        webLink: null,
        source: 'ics',
      });
    }
  }
  return out.sort((a, b) => new Date(a.start) - new Date(b.start));
}

async function fetchEvents(url, from, to, fetchImpl = fetch) {
  const res = await fetchImpl(normalizeIcsUrl(url), {
    headers: { Accept: 'text/calendar, text/plain, */*' },
    signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(25000) : undefined,
  });
  if (!res.ok) {
    throw new Error(res.status === 404 || res.status === 410
      ? 'The calendar link no longer works. Publish the calendar again in Outlook and paste the new link.'
      : `The calendar link returned an error (${res.status}).`);
  }
  const body = await res.text();
  if (body.length > MAX_BYTES) throw new Error('The calendar file is too large.');
  if (!/BEGIN:VCALENDAR/i.test(body)) throw new Error('That link did not return a calendar (.ics) file.');
  return toEvents(body, from, to);
}

module.exports = { fetchEvents, toEvents };
