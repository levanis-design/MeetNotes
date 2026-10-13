'use strict';
// Which web addresses the app is willing to open in the default browser.
// Calendar invites are written by other people, so a join link is only opened when it
// points at a known meeting service.

const MEETING_HOSTS = [
  'teams.microsoft.com', 'teams.live.com', 'zoom.us', 'zoom.com',
  'meet.google.com', 'webex.com', 'gotomeeting.com', 'goto.com',
];
const OTHER_HOSTS = [
  'github.com',
  'microsoft.com', 'microsoftonline.com', 'office.com', 'outlook.com', 'live.com', // sign-in and Outlook on the web
];

function parseUrl(url) {
  try { return new URL(String(url)); } catch { return null; }
}

function hostMatches(host, list) {
  return list.some((d) => host === d || host.endsWith('.' + d));
}

function isPlainHttps(u) {
  return Boolean(u) && u.protocol === 'https:' && !u.username && !u.password;
}

function isMeetingLink(url) {
  const u = parseUrl(url);
  return isPlainHttps(u) && hostMatches(u.hostname.toLowerCase(), MEETING_HOSTS);
}

function isAllowedExternal(url) {
  const u = parseUrl(url);
  if (!isPlainHttps(u)) return false;
  const h = u.hostname.toLowerCase();
  return hostMatches(h, MEETING_HOSTS) || hostMatches(h, OTHER_HOSTS);
}

// First meeting-service link found in the given texts (location, description, and so on).
function findMeetingLink(...texts) {
  for (const t of texts) {
    if (!t) continue;
    const found = String(t).match(/https:\/\/[^\s<>"')\]]+/gi) || [];
    for (const raw of found) {
      const url = raw.replace(/[.,;:!?]+$/, '');
      if (isMeetingLink(url)) return url;
    }
  }
  return null;
}

// A published calendar link contains a private key, so it is validated here and stored encrypted.
function normalizeIcsUrl(input) {
  let s = String(input || '').trim();
  if (/^webcals?:\/\//i.test(s)) s = s.replace(/^webcals?:\/\//i, 'https://');
  const u = parseUrl(s);
  if (!u || u.protocol !== 'https:') {
    throw new Error('The calendar link must start with https:// or webcal://');
  }
  return u.toString();
}

module.exports = { isAllowedExternal, isMeetingLink, findMeetingLink, normalizeIcsUrl, MEETING_HOSTS };
