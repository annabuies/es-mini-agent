'use strict';

// Build 46 / S3 04-2, 04-3 through the real server.js (demo mode, no OBS): a Start that
// carries auto_stop_at arms the deadline; at the deadline the agent asks the relay to queue
// a tagged Stop; a tagged Stop runs only on that exact take and is refused for any other.

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}
const close = (server) => new Promise((resolve) => server.close(resolve));
async function freePort() { const p = http.createServer(); const port = await listen(p); await close(p); return port; }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function startAgent(t, onAutoStop) {
  const posts = [];
  const relay = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'POST') {
        const body = JSON.parse(raw || '{}');
        if (body.auto_stop) { posts.push(body); res.end(JSON.stringify(onAutoStop(body))); return; }
      }
      res.end(JSON.stringify({ ok: true, command: null }));
    });
  });
  const relayPort = await listen(relay);
  t.after(() => close(relay));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-auto-stop-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const port = await freePort();
  const env = { ...process.env };
  for (const key of ['POWER_STRIP_URL', 'POWER_STRIP_USER', 'POWER_STRIP_PASS']) delete env[key];
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...env, BUILDING_ID: 'bench-1', RECORD_CONTROL_KEY: 'fake-test-key',
      RECORD_POLL_URL: `http://127.0.0.1:${relayPort}`, PORT: String(port), OBS_SOURCES: '',
      UPLOAD_STATE_DIR: dir, AUTO_STOP_STATE_FILE: path.join(dir, 'auto-stop.json'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = { text: '' };
  child.stdout.on('data', (c) => { output.text += c; });
  child.stderr.on('data', (c) => { output.text += c; });
  t.after(async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise((r) => child.once('exit', r)); } });
  const deadline = Date.now() + 5000;
  for (;;) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch (_) { /* starting */ }
    if (Date.now() > deadline) throw new Error('agent did not start:\n' + output.text);
    await sleep(25);
  }
  const op = async (name, body) => {
    const r = await fetch(`http://127.0.0.1:${port}/record/${name}`, {
      method: 'POST', headers: { Authorization: 'Bearer fake-test-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ building_id: 'bench-1', ...(body || {}) }),
    });
    return r.json();
  };
  return { op, posts, output, file: path.join(dir, 'auto-stop.json') };
}

test('agent: at the deadline it asks for exactly one tagged Stop for the take it is recording; the tagged Stop saves it', { timeout: 20000 }, async (t) => {
  const agent = await startAgent(t, () => ({ ok: true, queued: true }));
  const at = new Date(Date.now() + 1500).toISOString();
  const started = await agent.op('start', { session_ref: 'take-overrun-1', client_code: 'member-1', auto_stop_at: at });
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.equal(JSON.parse(fs.readFileSync(agent.file, 'utf8')).session_ref, 'take-overrun-1', 'deadline persisted');
  const st = await agent.op('status');
  assert.equal(st.auto_stop.session_ref, 'take-overrun-1');
  for (let i = 0; i < 60 && agent.posts.length === 0; i++) await sleep(100);
  await sleep(2500); // a few more ticks: still one request
  assert.deepEqual(agent.posts, [{ auto_stop: true, building_id: 'bench-1', mode: 'request', session_ref: 'take-overrun-1' }]);
  // The relay now delivers the queued, tagged Stop.
  const stopped = await agent.op('stop', { auto_stop_for: 'take-overrun-1' });
  assert.equal(stopped.ok, true);
  assert.equal(stopped.saved, true);
  assert.equal(stopped.auto_stop_for, 'take-overrun-1');
  assert.equal((await agent.op('status')).recording, false);
  assert.equal(fs.existsSync(agent.file), false, 'disarmed');
});

test('agent: a tagged Stop for another take is refused and the current take keeps recording', { timeout: 15000 }, async (t) => {
  const agent = await startAgent(t, () => ({ ok: true, queued: true }));
  await agent.op('start', { session_ref: 'take-new-2', client_code: 'member-1' }); // no deadline (e.g. on demand)
  const refused = await agent.op('stop', { auto_stop_for: 'take-old-1' });
  assert.deepEqual(refused, { ok: false, reason: 'stale_auto_stop', recording: true });
  const st = await agent.op('status');
  assert.equal(st.recording, true);
  assert.equal(st.session_ref, 'take-new-2');
  assert.equal(st.auto_stop, undefined);
  // A tagged Stop with nothing recording is refused too (the take already ended).
  assert.equal((await agent.op('stop')).ok, true);
  assert.equal((await agent.op('stop', { auto_stop_for: 'take-new-2' })).reason, 'stale_auto_stop');
});

test('agent: a manual Stop before the deadline clears it; no request is ever sent', { timeout: 15000 }, async (t) => {
  const agent = await startAgent(t, () => ({ ok: true, queued: true }));
  await agent.op('start', { session_ref: 'take-manual-3', auto_stop_at: new Date(Date.now() + 1500).toISOString() });
  assert.equal((await agent.op('stop')).ok, true);
  await sleep(2500);
  assert.equal(agent.posts.length, 0);
  assert.equal(fs.existsSync(agent.file), false);
});
