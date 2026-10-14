'use strict';
// Outlook calendar read straight from the Outlook app on this computer (classic Outlook for Windows).
// No sign-in, no app registration and no administrator approval: Outlook is already signed in.
// Read-only: the script only lists appointments. Requires Windows and classic Outlook
// (the "new Outlook" app has no automation interface).
const { findMeetingLink } = require('./links');

const TIMEOUT_MS = 60 * 1000;

function script(from, to) {
  const iso = (d) => d.toISOString().replace(/'/g, '');
  return `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$styles = [System.Globalization.DateTimeStyles]::RoundtripKind
$from = [datetime]::Parse('${iso(from)}', $null, $styles).ToLocalTime()
$to = [datetime]::Parse('${iso(to)}', $null, $styles).ToLocalTime()
try { $ol = New-Object -ComObject Outlook.Application } catch { '{"error":"no-outlook"}'; exit 0 }
$ns = $ol.GetNamespace('MAPI')
$cal = $ns.GetDefaultFolder(9)
$items = $cal.Items
$items.Sort('[Start]')
$items.IncludeRecurrences = $true
$filter = "[Start] < '" + $to.ToString('g') + "' AND [End] > '" + $from.ToString('g') + "'"
$found = $items.Restrict($filter)
$list = New-Object System.Collections.Generic.List[object]
$i = $found.GetFirst()
while ($i -ne $null -and $list.Count -lt 1000) {
  if ($i.Start -ge $to) { break }
  if ($i.MeetingStatus -ne 5 -and $i.MeetingStatus -ne 7) {
    $body = ''; $req = ''; $opt = ''; $org = ''
    try { $b = [string]$i.Body; if ($b.Length -gt 4000) { $b = $b.Substring(0, 4000) }; $body = $b } catch {}
    try { $req = [string]$i.RequiredAttendees; $opt = [string]$i.OptionalAttendees; $org = [string]$i.Organizer } catch {}
    $list.Add([pscustomobject]@{
      id = [string]$i.GlobalAppointmentID
      subject = [string]$i.Subject
      start = $i.Start.ToUniversalTime().ToString('o')
      end = $i.End.ToUniversalTime().ToString('o')
      allDay = [bool]$i.AllDayEvent
      location = [string]$i.Location
      organizer = $org
      required = $req
      optional = $opt
      body = $body
    })
  }
  $i = $found.GetNext()
}
$account = ''
try { $account = [string]$ns.CurrentUser.Name } catch {}
@{ events = $list.ToArray(); account = $account } | ConvertTo-Json -Depth 4 -Compress
`;
}

function normalizeDesktopEvent(e) {
  if (!e) return null;
  const start = new Date(e.start);
  let end = new Date(e.end);
  if (isNaN(start) || isNaN(end)) return null;
  const allDay = Boolean(e.allDay);
  if (end <= start) end = new Date(start.getTime() + (allDay ? 24 * 3600 * 1000 : 30 * 60 * 1000));
  const attendees = [e.required, e.optional]
    .join(';')
    .split(';')
    .map((a) => a.trim())
    .filter(Boolean)
    .slice(0, 12);
  const location = String(e.location || '');
  return {
    id: `od|${e.id || e.subject}|${start.toISOString()}`,
    title: String(e.subject || '').trim() || '(No title)',
    start: start.toISOString(),
    end: end.toISOString(),
    allDay,
    location: location.slice(0, 200),
    organizer: String(e.organizer || ''),
    attendees,
    joinUrl: findMeetingLink(location, String(e.body || '')) || null,
    webLink: null,
    source: 'outlook-desktop',
  };
}

function parseOutput(stdout) {
  const text = String(stdout || '').replace(/^﻿/, '').trim();
  const s = text.indexOf('{');
  if (s < 0) throw new Error('Outlook returned no calendar data.');
  const body = JSON.parse(text.slice(s));
  if (body.error === 'no-outlook') {
    throw new Error('Classic Outlook for Windows was not found. If you use the new Outlook, switch back to classic Outlook (toggle at the top right of Outlook), or use the Microsoft sign-in or a calendar link instead.');
  }
  const raw = Array.isArray(body.events) ? body.events : body.events ? [body.events] : [];
  const seen = new Set();
  const events = raw
    .map(normalizeDesktopEvent)
    .filter((e) => e && (seen.has(e.id) ? false : seen.add(e.id)))
    .sort((a, b) => new Date(a.start) - new Date(b.start));
  return { events, account: String(body.account || '') };
}

function runPowerShell(code, { spawnImpl, timeoutMs = TIMEOUT_MS } = {}) {
  const { spawn } = require('child_process');
  const run = spawnImpl || spawn;
  const encoded = Buffer.from(code, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    const child = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) { /* gone */ }
      reject(new Error('Outlook did not answer in time. If Outlook shows a security prompt, allow access, then try again.'));
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`Could not start PowerShell: ${e.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve(out);
      const msg = err.trim().split(/\r?\n/)[0] || `code ${code}`;
      reject(new Error(`Reading the Outlook calendar failed: ${msg.slice(0, 300)}`));
    });
  });
}

function createOutlookDesktop({ isEnabled, spawnImpl, platform = process.platform }) {
  async function read(from, to) {
    if (platform !== 'win32') throw new Error('Reading Outlook on this computer works on Windows only.');
    return parseOutput(await runPowerShell(script(from, to), { spawnImpl }));
  }
  return {
    enabled: () => Boolean(isEnabled()),
    events: async (from, to) => (await read(from, to)).events,
    test: async () => {
      const from = new Date();
      const r = await read(from, new Date(from.getTime() + 14 * 24 * 3600 * 1000));
      return { count: r.events.length, account: r.account };
    },
  };
}

module.exports = { createOutlookDesktop, normalizeDesktopEvent, parseOutput, script };
