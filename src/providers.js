'use strict';
// AI connectors for the after-meeting summary. Each returns the model's raw text reply.
// - anthropic:  Anthropic API key (Claude)
// - openai:     OpenAI API key, or any OpenAI-compatible service (Azure OpenAI, company gateway, Ollama, LM Studio)
// - claude-cli: Claude Code installed on this computer, signed in with a Claude subscription. No API key.
// - codex-cli:  OpenAI Codex CLI installed on this computer, signed in with ChatGPT. No API key.
// The "copy prompt / paste reply" flow for any other AI tool lives in ai.js and needs no connector.
const os = require('os');
const path = require('path');
const fs = require('fs');

const PROVIDERS = ['anthropic', 'openai', 'claude-cli', 'codex-cli'];
const CLI_TIMEOUT_MS = 5 * 60 * 1000;

const LABELS = {
  anthropic: 'Claude (Anthropic API key)',
  openai: 'OpenAI or compatible API',
  'claude-cli': 'Claude Code on this computer',
  'codex-cli': 'Codex CLI on this computer',
};

function httpError(service, status, body) {
  const detail = (body && body.error && (body.error.message || body.error)) || '';
  if (status === 401 || status === 403) return new Error(`${service} rejected the API key. Check the key in Settings.`);
  if (status === 404) return new Error(`${service} did not find the model or address. Check the model name and API address in Settings.`);
  if (status === 429) return new Error(`${service} is rate limiting or the account is out of credit. Try again shortly.`);
  return new Error(`${service} returned an error (${status})${detail ? ': ' + String(detail).slice(0, 200) : ''}.`);
}

// ---------- Anthropic ----------
async function anthropic({ apiKey, model, system, user, maxTokens = 6000, fetchImpl, client }) {
  if (!apiKey && !client) throw new Error('Add your Anthropic API key in Settings first.');
  let c = client;
  if (!c) {
    const Anthropic = require('@anthropic-ai/sdk');
    const Ctor = Anthropic.default || Anthropic;
    c = new Ctor(fetchImpl ? { apiKey, fetch: fetchImpl } : { apiKey });
  }
  const req = { model, max_tokens: maxTokens, messages: [{ role: 'user', content: user }] };
  if (system) req.system = system;
  const resp = await c.messages.create(req);
  if (resp.stop_reason === 'max_tokens') {
    throw new Error('The AI response was cut off. Try again, or add an instruction asking for a shorter summary.');
  }
  return (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
}

// ---------- OpenAI and compatible ----------
function chatUrl(baseUrl) {
  const url = new URL(String(baseUrl || 'https://api.openai.com/v1').trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Enter an HTTP or HTTPS API address without embedded credentials.');
  const base = url.pathname.replace(/\/+$/, '');
  url.pathname = /\/chat\/completions$/.test(base) ? base : base + '/chat/completions';
  return url.href;
}

async function openai({ apiKey, baseUrl, model, system, user, fetchImpl = fetch }) {
  const url = chatUrl(baseUrl);
  const hostname = new URL(url).hostname;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
  if (!apiKey && !local) throw new Error('Add your OpenAI (or compatible service) API key in Settings first.');
  if (!model) throw new Error('Enter the model name for the OpenAI-compatible service in Settings.');
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
    if (hostname.endsWith('.openai.azure.com') || hostname.endsWith('.cognitiveservices.azure.com')) headers['api-key'] = apiKey;
  }
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: user });
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, messages }),
      signal: AbortSignal.timeout(5 * 60 * 1000),
    });
  } catch (err) {
    throw new Error(`Could not reach ${url}: ${err && err.message ? err.message : err}`);
  }
  const text = await res.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text.slice(0, 200) }; }
  if (!res.ok) throw httpError('The AI service', res.status, body);
  const choice = body.choices && body.choices[0];
  if (choice && choice.finish_reason === 'length') {
    throw new Error('The AI response was cut off. Try again, or add an instruction asking for a shorter summary.');
  }
  const content = choice && choice.message && choice.message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => p.text || '').join('');
  throw new Error('The AI service returned an empty reply.');
}

// ---------- local command-line tools ----------
function quote(s) {
  const v = String(s);
  return /[\s"&|<>^]/.test(v) ? `"${v.replace(/"/g, '\\"')}"` : v;
}

function runCli({ command, args, input, spawnImpl, timeoutMs = CLI_TIMEOUT_MS, name }) {
  const { spawn } = require('child_process');
  const run = spawnImpl || spawn;
  return new Promise((resolve, reject) => {
    // A shell finds .cmd and .exe launchers on the PATH on Windows.
    const child = run([quote(command), ...args.map(quote)].join(' '), {
      shell: true,
      windowsHide: true,
      cwd: os.tmpdir(), // never run inside a project folder
      env: process.env,
    });
    let out = '';
    let err = '';
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill(); } catch (_) { /* already gone */ }
      reject(new Error(`${name} did not answer within ${Math.round(timeoutMs / 60000)} minutes.`));
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(new Error(`Could not start ${name}: ${e.message}`));
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code === 0) return resolve(out);
      const msg = (err || out).trim().split(/\r?\n/).slice(-3).join(' ');
      if (code === 9009 || code === 127 || /not recognized|not found|ENOENT/i.test(msg)) {
        return reject(new Error(`${name} was not found. Install it, or enter its full path in Settings.`));
      }
      if (/log ?in|auth|sign ?in|unauthori[sz]ed|credential/i.test(msg)) {
        return reject(new Error(`${name} is not signed in. Open a terminal, run "${command}" once and sign in, then try again.`));
      }
      reject(new Error(`${name} stopped with an error${msg ? ': ' + msg.slice(0, 300) : ` (code ${code})`}.`));
    });
    child.stdin.on('error', () => { /* reported by close */ });
    child.stdin.end(input);
  });
}

function combined(system, user) {
  return system ? `${system}\n\n---\n\n${user}` : user;
}

async function claudeCli({ cliPath, system, user, spawnImpl }) {
  return runCli({
    name: 'Claude Code',
    command: cliPath || 'claude',
    args: ['-p', '--output-format', 'text'],
    input: combined(system, user),
    spawnImpl,
  });
}

async function codexCli({ cliPath, system, user, spawnImpl }) {
  const outFile = path.join(os.tmpdir(), `meetnotes-codex-${process.pid}-${Date.now()}.txt`);
  try {
    const stdout = await runCli({
      name: 'Codex CLI',
      command: cliPath || 'codex',
      args: ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--output-last-message', outFile, '-'],
      input: combined(system, user),
      spawnImpl,
    });
    try { return fs.readFileSync(outFile, 'utf8'); } catch { return stdout; }
  } finally {
    try { fs.unlinkSync(outFile); } catch (_) { /* not created */ }
  }
}

// Finds claude / codex on the PATH (Windows "where", otherwise "which"). Returns the full path or null.
function findCli(name, { spawnSyncImpl, platform = process.platform } = {}) {
  const run = spawnSyncImpl || require('child_process').spawnSync;
  try {
    const r = run(platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    if (r.status !== 0) return null;
    return String(r.stdout || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || null;
  } catch {
    return null;
  }
}

// Explains what to do when the selected connection is not set up, naming tools already installed.
function setupHint(cfg, opts) {
  const provider = cfg.provider || 'anthropic';
  if (provider === 'anthropic' && !cfg.anthropicKey) {
    const found = [findCli('claude', opts) && 'Claude Code', findCli('codex', opts) && 'Codex CLI'].filter(Boolean);
    const tip = found.length
      ? ` ${found.join(' and ')} ${found.length > 1 ? 'are' : 'is'} installed on this computer: choose "${found[0] === 'Claude Code' ? 'Claude Code on this computer' : 'Codex CLI on this computer'}" as the AI connection in Settings, then Save.`
      : ' Or choose another AI connection in Settings, or use "Copy prompt for any AI" on the Summary tab.';
    return 'The AI connection is set to "Claude with an Anthropic API key", but no key is saved.' + tip;
  }
  return null;
}

// One entry point. cfg: { provider, anthropicKey, model, openaiKey, openaiBaseUrl, openaiModel, cliPath }
async function complete(cfg, { system, user, maxTokens, fetchImpl, spawnImpl, client }) {
  if (!client) {
    const hint = setupHint(cfg);
    if (hint) throw new Error(hint);
  }
  switch (cfg.provider || 'anthropic') {
    case 'anthropic':
      return anthropic({ apiKey: cfg.anthropicKey, model: cfg.model, system, user, maxTokens, fetchImpl, client });
    case 'openai':
      return openai({ apiKey: cfg.openaiKey, baseUrl: cfg.openaiBaseUrl, model: cfg.openaiModel, system, user, fetchImpl });
    case 'claude-cli':
      return claudeCli({ cliPath: cfg.cliPath, system, user, spawnImpl });
    case 'codex-cli':
      return codexCli({ cliPath: cfg.cliPath, system, user, spawnImpl });
    default:
      throw new Error('Choose an AI connection in Settings.');
  }
}

module.exports = { PROVIDERS, LABELS, complete, findCli, setupHint, chatUrl, runCli, anthropic, openai, claudeCli, codexCli };
