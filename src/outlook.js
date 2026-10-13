'use strict';
// Outlook calendar through Microsoft Graph, signed in with the device code flow.
// The user registers their own app in Microsoft Entra (no client secret: it is a public client),
// so no secret ever ships with this app. Only the read-only Calendars.Read permission is requested.
const { findMeetingLink } = require('./links');

const AUTH = 'https://login.microsoftonline.com';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const SCOPE = 'offline_access Calendars.Read User.Read';
const SELECT = 'id,subject,start,end,originalStartTimeZone,originalEndTimeZone,isAllDay,isCancelled,location,organizer,attendees,onlineMeeting,bodyPreview,webLink,showAs';

class OutlookError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'OutlookError';
    this.code = code || 'error';
  }
}

const formBody = (o) => new URLSearchParams(o).toString();

async function readJson(res) {
  const text = await res.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { raw: text.slice(0, 300) }; }
}

function authMessage(body) {
  const desc = String((body && body.error_description) || '');
  const code = (desc.match(/AADSTS(\d+)/) || [])[1];
  const first = desc.split(/\r?\n/)[0].replace(/\s*Trace ID.*$/i, '').trim();
  switch (code) {
    case '700016': return 'Microsoft does not recognise this Application (client) ID in that directory. Check the ID and the Directory (tenant) value in Settings.';
    case '7000218': return 'The app registration does not allow public client flows. In Microsoft Entra, open the app, go to Authentication and set "Allow public client flows" to Yes.';
    case '65001': return 'Consent for calendar access has not been granted. Sign in again and accept the request, or ask your administrator to approve the Calendars.Read permission.';
    case '50020': case '50034': return 'This account is not in the Directory (tenant) set in Settings. Use your organisation\'s tenant ID or domain, or "common" for personal accounts if the app allows them.';
    case '53003': return 'A conditional access policy at your organisation blocked this sign-in.';
    case '70011': return 'Microsoft rejected the requested permissions. Check that Calendars.Read and User.Read are added to the app.';
    default: break;
  }
  return first || (body && body.error) || 'Microsoft sign-in failed.';
}

async function startDeviceFlow({ clientId, tenant = 'common', fetchImpl = fetch, signal }) {
  const res = await fetchImpl(`${AUTH}/${encodeURIComponent(tenant)}/oauth2/v2.0/devicecode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formBody({ client_id: clientId, scope: SCOPE }),
    signal,
  });
  const body = await readJson(res);
  if (!res.ok || !body.device_code) throw new OutlookError(authMessage(body), 'auth');
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri: body.verification_uri || 'https://microsoft.com/devicelogin',
    expiresIn: Number(body.expires_in) || 900,
    interval: Number(body.interval) || 5,
  };
}

const defaultSleep = (ms, signal) => new Promise((resolve) => {
  const finish = () => { clearTimeout(t); if (signal) signal.removeEventListener('abort', finish); resolve(); };
  const t = setTimeout(finish, ms);
  if (signal) {
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  }
});

async function pollForToken({ clientId, tenant = 'common', flow, fetchImpl = fetch, sleep = defaultSleep, now = Date.now, signal }) {
  const deadline = now() + flow.expiresIn * 1000;
  let interval = flow.interval;
  for (;;) {
    if (signal && signal.aborted) throw new OutlookError('Sign-in cancelled.', 'cancelled');
    await sleep(interval * 1000, signal);
    if (signal && signal.aborted) throw new OutlookError('Sign-in cancelled.', 'cancelled');
    if (now() > deadline) throw new OutlookError('The sign-in code expired. Start again.', 'expired');
    const res = await fetchImpl(`${AUTH}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: clientId,
        device_code: flow.deviceCode,
      }),
      signal,
    });
    const body = await readJson(res);
    if (signal && signal.aborted) throw new OutlookError('Sign-in cancelled.', 'cancelled');
    if (res.ok && body.access_token) return body;
    switch (body.error) {
      case 'authorization_pending': break;
      case 'slow_down': interval += 5; break;
      case 'authorization_declined': throw new OutlookError('Sign-in was declined.', 'declined');
      case 'expired_token': throw new OutlookError('The sign-in code expired. Start again.', 'expired');
      case 'bad_verification_code': throw new OutlookError('Microsoft did not accept the sign-in code. Start again.', 'auth');
      default: throw new OutlookError(authMessage(body), 'auth');
    }
  }
}

async function refreshTokens({ clientId, tenant = 'common', refreshToken, fetchImpl = fetch }) {
  const res = await fetchImpl(`${AUTH}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formBody({ grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken, scope: SCOPE }),
    signal: AbortSignal.timeout(25000),
  });
  const body = await readJson(res);
  if (res.ok && body.access_token) return body;
  if (body.error === 'invalid_grant' || body.error === 'interaction_required') {
    throw new OutlookError('The Outlook sign-in has expired. Connect again in Settings.', 'expired');
  }
  throw new OutlookError(authMessage(body), 'auth');
}

// ---------- event conversion ----------
function graphDate(dt) {
  const raw = String((dt && dt.dateTime) || '').replace(/(\.\d{3})\d*$/, '$1');
  const utc = !dt || !dt.timeZone || /^(utc|etc\/utc)$/i.test(dt.timeZone);
  return new Date(utc && !/(Z|[+-]\d{2}:\d{2})$/i.test(raw) ? raw + 'Z' : raw);
}

// Recover the original calendar date before displaying an all-day event locally.
let windowsZones;
function allDayLocalMidnight(d, originalZone) {
  if (originalZone) {
    let zone = originalZone;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: zone });
    } catch {
      const path = require('path');
      windowsZones ||= require(path.join(path.dirname(require.resolve('node-ical')), 'windowsZones.json'));
      zone = windowsZones[zone] && windowsZones[zone].iana[0];
    }
    if (zone) {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(d);
      const values = Object.fromEntries(parts.map(p => [p.type, p.value]));
      return new Date(Number(values.year), Number(values.month) - 1, Number(values.day));
    }
  }
  // Compatibility fallback for older responses without original time-zone fields.
  const s = new Date(d.getTime() + 12 * 3600 * 1000);
  return new Date(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate());
}

function normalizeGraphEvent(e) {
  if (!e || e.isCancelled) return null;
  let start = graphDate(e.start);
  let end = graphDate(e.end);
  if (isNaN(start) || isNaN(end)) return null;
  const allDay = Boolean(e.isAllDay);
  if (allDay) {
    start = allDayLocalMidnight(start, e.originalStartTimeZone);
    end = allDayLocalMidnight(end, e.originalEndTimeZone || e.originalStartTimeZone);
    if (end <= start) end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
  }
  const location = (e.location && e.location.displayName) || '';
  const attendees = (e.attendees || [])
    .map((a) => a && a.emailAddress && (a.emailAddress.name || a.emailAddress.address))
    .filter(Boolean)
    .slice(0, 12);
  const joinUrl = (e.onlineMeeting && e.onlineMeeting.joinUrl && findMeetingLink(e.onlineMeeting.joinUrl))
    || findMeetingLink(location, e.bodyPreview);
  return {
    id: String(e.id),
    title: String(e.subject || '').trim() || '(No title)',
    start: start.toISOString(),
    end: end.toISOString(),
    allDay,
    location: String(location).slice(0, 200),
    organizer: (e.organizer && e.organizer.emailAddress && e.organizer.emailAddress.name) || '',
    attendees,
    joinUrl: joinUrl || null,
    webLink: typeof e.webLink === 'string' ? e.webLink : null,
    source: 'outlook',
  };
}

// ---------- connection ----------
function createOutlook({ getConfig, loadRefresh, saveRefresh, fetchImpl = fetch, now = Date.now, sleep = defaultSleep }) {
  let access = null; // { token, exp }
  let refreshing = null;
  let flowAbort = null;

  function config() {
    const c = getConfig();
    if (!c.clientId) throw new OutlookError('Add the Application (client) ID from your Microsoft Entra app registration in Settings.', 'config');
    return { clientId: c.clientId, tenant: c.tenant || 'common' };
  }

  async function accessToken() {
    if (access && access.exp - 60000 > now()) return access.token;
    if (!refreshing) {
      refreshing = (async () => {
        const rt = loadRefresh();
        if (!rt) throw new OutlookError('Outlook is not connected. Connect it in Settings.', 'expired');
        const { clientId, tenant } = config();
        const tok = await refreshTokens({ clientId, tenant, refreshToken: rt, fetchImpl });
        if (tok.refresh_token) saveRefresh(tok.refresh_token);
        access = { token: tok.access_token, exp: now() + (Number(tok.expires_in) || 3600) * 1000 };
        return access.token;
      })().finally(() => { refreshing = null; });
    }
    return refreshing;
  }

  async function graphGet(urlOrPath, retried = false) {
    const url = urlOrPath.startsWith('https://') ? urlOrPath : GRAPH + urlOrPath;
    if (!url.startsWith('https://graph.microsoft.com/')) throw new OutlookError('Unexpected address returned by Outlook.', 'error');
    const token = await accessToken();
    const res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.timezone="UTC"', Accept: 'application/json' },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 401 && !retried) {
      access = null;
      return graphGet(url, true);
    }
    const body = await readJson(res);
    if (res.ok) return body;
    if (res.status === 401) throw new OutlookError('The Outlook sign-in has expired. Connect again in Settings.', 'expired');
    if (res.status === 403) throw new OutlookError('Outlook refused access to the calendar. The Calendars.Read permission may need administrator approval.', 'denied');
    if (res.status === 429) throw new OutlookError('Outlook is busy. Try again in a minute.', 'throttled');
    throw new OutlookError((body.error && body.error.message) || `Outlook returned an error (${res.status}).`, 'error');
  }

  async function connect({ onCode, signal } = {}) {
    const { clientId, tenant } = config();
    flowAbort = signal ? null : new AbortController();
    const sig = signal || flowAbort.signal;
    try {
      if (sig.aborted) throw new OutlookError('Sign-in cancelled.', 'cancelled');
      const flow = await startDeviceFlow({ clientId, tenant, fetchImpl, signal: sig });
      if (sig.aborted) throw new OutlookError('Sign-in cancelled.', 'cancelled');
      if (onCode) onCode({ userCode: flow.userCode, verificationUri: flow.verificationUri, expiresIn: flow.expiresIn });
      const tok = await pollForToken({ clientId, tenant, flow, fetchImpl, sleep, now, signal: sig });
      if (sig.aborted) throw new OutlookError('Sign-in cancelled.', 'cancelled');
      access = { token: tok.access_token, exp: now() + (Number(tok.expires_in) || 3600) * 1000 };
      if (tok.refresh_token) saveRefresh(tok.refresh_token);
      const me = await graphGet('/me?$select=displayName,mail,userPrincipalName');
      return { account: me.mail || me.userPrincipalName || me.displayName || 'your account' };
    } catch (error) {
      if (sig.aborted) throw new OutlookError('Sign-in cancelled.', 'cancelled');
      throw error;
    } finally {
      flowAbort = null;
    }
  }

  function cancel() { if (flowAbort) flowAbort.abort(); }
  function disconnect() { access = null; saveRefresh(null); }
  function connected() { return Boolean(loadRefresh()); }

  async function events(from, to) {
    const params = new URLSearchParams({
      startDateTime: from.toISOString(),
      endDateTime: to.toISOString(),
      $select: SELECT,
      $top: '100',
    });
    let page = await graphGet(`/me/calendarView?${params}`);
    const out = [];
    for (let i = 0; i < 10; i++) {
      for (const e of page.value || []) {
        const n = normalizeGraphEvent(e);
        if (n) out.push(n);
      }
      if (!page['@odata.nextLink'] || out.length >= 1000) break;
      page = await graphGet(page['@odata.nextLink']);
    }
    const seen = new Set();
    return out
      .filter((e) => (seen.has(e.id) ? false : seen.add(e.id)))
      .sort((a, b) => new Date(a.start) - new Date(b.start));
  }

  return { connect, cancel, disconnect, connected, events };
}

module.exports = {
  OutlookError, createOutlook, startDeviceFlow, pollForToken, refreshTokens, normalizeGraphEvent, authMessage, SCOPE,
};
