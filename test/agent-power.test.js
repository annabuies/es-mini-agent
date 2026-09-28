'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const { createFakeDli } = require('./fake-dli');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function freePort() {
  const probe = http.createServer();
  const port = await listen(probe);
  await close(probe);
  return port;
}

async function postAgent(port, op, body) {
  const response = await fetch(`http://127.0.0.1:${port}/record/${op}`, {
    method: 'POST',
    headers: { Authorization: 'Bearer fake-test-key', 'Content-Type': 'application/json' },
    body: JSON.stringify({ building_id: 'bench-1', ...(body || {}) }),
  });
  assert.equal(response.status, 200);
  return await response.json();
}

async function startAgent(t, extraEnv) {
  const relay = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ command: null }));
  });
  const relayPort = await listen(relay);
  t.after(() => close(relay));
  const port = await freePort();
  const env = { ...process.env };
  for (const key of ['POWER_STRIP_URL', 'POWER_STRIP_USER', 'POWER_STRIP_PASS', 'POWER_OUTLETS_SWITCHABLE']) delete env[key];
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...env,
      BUILDING_ID: 'bench-1',
      RECORD_CONTROL_KEY: 'fake-test-key',
      RECORD_POLL_URL: `http://127.0.0.1:${relayPort}`,
      PORT: String(port),
      OBS_SOURCES: '',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = { text: '' };
  child.stdout.on('data', (chunk) => { output.text += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { output.text += chunk.toString('utf8'); });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
  });
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break;
    } catch (_) { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`agent did not start:\n${output.text}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return { port, output };
}

test('agent without POWER_STRIP_URL answers power_unconfigured and still starts', { timeout: 10000 }, async (t) => {
  const { port } = await startAgent(t, {});
  assert.deepEqual(await postAgent(port, 'power', { action: 'status' }), { ok: false, action: 'status', reason: 'power_unconfigured' });
  assert.deepEqual(await postAgent(port, 'power', { action: 'on', outlets: ['lights'] }), { ok: false, action: 'on', reason: 'power_unconfigured' });
  assert.deepEqual((await postAgent(port, 'diag')).power, {
    configured: false, auth: 'none',
    outlets: { router: 1, poe: 2, mini: 3, lights: 4, evo: null, nas: null },
    switchable: ['lights'], rejected: [], health: null,
  });
});

test('agent samples strip health read-only and reports it in diag and the heartbeat', { timeout: 10000 }, async (t) => {
  const dli = createFakeDli();
  const dliPort = await listen(dli.server);
  t.after(() => close(dli.server));
  const { port } = await startAgent(t, {
    POWER_STRIP_URL: `http://127.0.0.1:${dliPort}`,
    POWER_STRIP_USER: dli.username,
    POWER_STRIP_PASS: dli.password,
  });
  let health = null;
  const deadline = Date.now() + 5000;
  while (!health && Date.now() < deadline) {
    health = (await postAgent(port, 'diag')).power.health;
    if (!health) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.deepEqual({ ...health, checked_at: typeof health.checked_at }, { ok: true, reason: null, lights_on: true, fail_count: 0, checked_at: 'string' });
  assert.deepEqual(dli.strip.writes, []);
  assert.ok(dli.strip.requests.every((r) => r.method === 'GET'));
});

test('strip health counts consecutive failures when the strip is unreachable', { timeout: 10000 }, async (t) => {
  const port0 = await freePort();
  const { port } = await startAgent(t, { POWER_STRIP_URL: `http://127.0.0.1:${port0}`, POWER_STRIP_USER: 'u', POWER_STRIP_PASS: 'p' });
  let health = null;
  const deadline = Date.now() + 5000;
  while (!health && Date.now() < deadline) {
    health = (await postAgent(port, 'diag')).power.health;
    if (!health) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(health.ok, false);
  assert.equal(health.fail_count, 1);
  assert.equal(health.lights_on, null);
});

test('agent power op: lights only, mini refused even when listed, no off while recording', { timeout: 10000 }, async (t) => {
  const dli = createFakeDli();
  const dliPort = await listen(dli.server);
  t.after(() => close(dli.server));
  const { port, output } = await startAgent(t, {
    POWER_STRIP_URL: `http://127.0.0.1:${dliPort}`,
    POWER_STRIP_USER: dli.username,
    POWER_STRIP_PASS: dli.password,
    POWER_OUTLETS_SWITCHABLE: 'lights,mini,router',
  });

  const diag = await postAgent(port, 'diag');
  assert.deepEqual(diag.power.switchable, ['lights']);
  assert.deepEqual(diag.power.rejected, ['mini', 'router']);
  assert.equal(diag.power.configured, true);
  assert.equal(JSON.stringify(diag).includes(dli.password), false);

  assert.deepEqual(await postAgent(port, 'power', { action: 'off', outlets: ['mini'] }), { ok: false, action: 'off', reason: 'outlet_denied', outlet: 'mini' });
  assert.deepEqual(await postAgent(port, 'power', { action: 'off', outlets: ['router'] }), { ok: false, action: 'off', reason: 'outlet_denied', outlet: 'router' });

  assert.deepEqual(await postAgent(port, 'start'), { ok: true, recording: true, feeds_writing: null });
  assert.deepEqual(await postAgent(port, 'power', { action: 'off', outlets: ['lights'] }), { ok: false, action: 'off', reason: 'busy_recording' });
  assert.deepEqual(await postAgent(port, 'pause'), { ok: true, paused: true });
  assert.deepEqual(await postAgent(port, 'power', { action: 'off', outlets: 'all' }), { ok: false, action: 'off', reason: 'busy_recording' });
  assert.deepEqual(await postAgent(port, 'stop'), { ok: true, saved: true });
  assert.deepEqual(dli.strip.writes, []);

  assert.deepEqual(await postAgent(port, 'power', { action: 'off', outlets: ['lights'] }), {
    ok: true, action: 'off', outlets: { lights: { outlet: 4, result: 'ok', on: false } },
  });
  assert.deepEqual(await postAgent(port, 'power', {}), {
    ok: true, action: 'status', outlets: { lights: { outlet: 4, on: false, label: 'Lights' } },
  });
  assert.deepEqual(dli.strip.writes, [{ index: 3, value: false }]);
  assert.deepEqual(dli.strip.states.slice(0, 3), [true, true, true]);
  assert.match(output.text, /power: POWER_OUTLETS_SWITCHABLE ignored mini,router/);
  assert.match(output.text, /power: off lights\(4\) -> ok physical=off/);
  assert.doesNotMatch(output.text, new RegExp(dli.password));
});
