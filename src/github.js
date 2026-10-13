'use strict';
// Publishes a meeting record to a GitHub repository through the REST API.
// fetch is injectable so the logic can be tested without network access.

const API = 'https://api.github.com';
const PART = /^[A-Za-z0-9._-]{1,100}$/;

class GithubError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'GithubError';
    this.status = status;
  }
}

function parseRepoInput(input, login) {
  const raw = String(input || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  if (!raw) throw new GithubError('Enter a repository name.');
  const parts = raw.split('/');
  if (parts.length > 2) throw new GithubError('Use the form "repository" or "owner/repository".');
  const [owner, name] = parts.length === 2 ? parts : [login, parts[0]];
  for (const p of [owner, name]) {
    if (!PART.test(p) || p === '.' || p === '..') throw new GithubError(`"${p}" is not a valid GitHub name.`);
  }
  return { owner, name };
}

function slugify(text) {
  const s = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/g, '');
  return s || 'meeting';
}

function dateStamp(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return 'undated';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function encodePath(p) {
  return p.split('/').map(encodeURIComponent).join('/');
}

function createClient({ token, fetchImpl }) {
  const doFetch = fetchImpl || fetch;
  if (!token) throw new GithubError('No GitHub token saved. Add one in Settings.');

  function describe(res, data) {
    const base = (data && data.message) || res.statusText || 'request failed';
    if (res.status === 401) return 'GitHub rejected the token. It may be expired or mistyped.';
    if (res.status === 403) {
      const needs = res.headers && res.headers.get ? res.headers.get('x-accepted-github-permissions') : null;
      return `GitHub refused the request (${base}).${needs ? ` Permissions this call accepts: ${needs}.` : ''} Check the token's permissions and repository access.`;
    }
    if (res.status === 404) return 'GitHub could not find that item, or the token cannot see it.';
    if (res.status === 422) {
      const detail = data && Array.isArray(data.errors) ? data.errors.map((e) => e.message || e.code).filter(Boolean).join('; ') : '';
      return `GitHub could not process the request: ${base}${detail ? ` (${detail})` : ''}`;
    }
    return `GitHub error ${res.status}: ${base}`;
  }

  async function request(method, path, body, { allow404 = false } = {}) {
    const res = await doFetch(API + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'MeetNotes',
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (res.status === 404 && allow404) return null;
    if (!res.ok) throw new GithubError(describe(res, data), res.status);
    return data;
  }

  return {
    getUser: () => request('GET', '/user'),
    getRepo: (owner, name) => request('GET', `/repos/${owner}/${name}`, null, { allow404: true }),
    createRepo: ({ owner, login, name, isPrivate, description }) =>
      request('POST', owner === login ? '/user/repos' : `/orgs/${owner}/repos`, {
        name, private: Boolean(isPrivate), description, auto_init: true,
      }),
    getFile: (owner, name, path) =>
      request('GET', `/repos/${owner}/${name}/contents/${encodePath(path)}`, null, { allow404: true }),
    putFile: ({ owner, name, path, content, message, sha }) =>
      request('PUT', `/repos/${owner}/${name}/contents/${encodePath(path)}`, {
        message,
        content: Buffer.from(content, 'utf8').toString('base64'),
        ...(sha ? { sha } : {}),
      }),
  };
}

async function ensureRepo(client, { owner, name, login, isPrivate }) {
  const existing = await client.getRepo(owner, name);
  if (existing) return { owner, name, private: Boolean(existing.private), created: false };
  const made = await client.createRepo({
    owner, login, name, isPrivate, description: 'Meeting notes published from MeetNotes',
  });
  return { owner, name, private: Boolean(made && made.private), created: true };
}

async function putOrUpdate(client, { owner, name, path, content, message }) {
  const existing = await client.getFile(owner, name, path);
  const res = await client.putFile({
    owner, name, path, content,
    message: existing ? message.replace(/^Add /, 'Update ') : message,
    sha: existing && existing.sha,
  });
  return res && res.content && res.content.html_url;
}

// Returns { repo, folder, url, created, files }.
async function publishMeeting({ client, repoInput, isPrivate, allowPublic, meeting, renderMarkdown, renderTranscript, includeTranscript }) {
  const user = await client.getUser();
  const { owner, name } = parseRepoInput(repoInput, user.login);
  const repo = await ensureRepo(client, { owner, name, login: user.login, isPrivate });

  // Never publish into a public repository unless the user explicitly chose public.
  if (!repo.private && !allowPublic) {
    throw new GithubError(`${owner}/${name} is a public repository. Choose Public visibility to publish there, or use a private repository.`);
  }

  const repoFull = `${owner}/${name}`;
  let folder;
  if (meeting.github && meeting.github.repo === repoFull && meeting.github.folder) {
    folder = meeting.github.folder;
  } else {
    folder = `meetings/${dateStamp(meeting.startedAt || meeting.createdAt)}-${slugify(meeting.title)}`;
    const clash = await client.getFile(owner, name, `${folder}/summary.md`);
    if (clash) folder += `-${String(meeting.id).replace(/\D/g, '').slice(-4)}`;
  }

  const message = `Add meeting notes: ${meeting.title}`;
  const files = ['summary.md'];
  const url = await putOrUpdate(client, { owner, name, path: `${folder}/summary.md`, content: renderMarkdown(meeting), message });
  if (includeTranscript) {
    await putOrUpdate(client, { owner, name, path: `${folder}/transcript.txt`, content: renderTranscript(meeting), message });
    files.push('transcript.txt');
  }
  return { repo: repoFull, folder, url, created: repo.created, files };
}

module.exports = { GithubError, parseRepoInput, slugify, dateStamp, createClient, ensureRepo, publishMeeting };
