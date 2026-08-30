'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function readJson(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (_) { resolve({}); }
    });
  });
}

async function waitFor(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for agent output');
}

async function postAgent(port, op, body) {
  const response = await fetch(`http://127.0.0.1:${port}/record/${op}`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer fake-test-key',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ building_id: 'bench-1', ...(body || {}) }),
  });
  assert.equal(response.status, 200);
  return await response.json();
}

test('demo-mode agent pulls PTZ config and executes a queued look', { timeout: 8000 }, async (t) => {
  const fixturePath = path.join(__dirname, 'fixtures', 'bench-1-ptz.json');
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const cameraRequests = [];
  const cameraServer = http.createServer((req, res) => {
    cameraRequests.push(req.url);
    res.writeHead(204);
    res.end();
  });
  const cameraPort = await listen(cameraServer);
  t.after(() => close(cameraServer));
  fixture.cameras = fixture.cameras.map((camera) => ({
    name: camera.name,
    host: `127.0.0.1:${cameraPort}`,
  }));

  let configServed = false;
  let commandServed = false;
  let finishResult;
  const resultPromise = new Promise((resolve) => { finishResult = resolve; });
  const relayServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && url.searchParams.get('want_sources') === '1') {
      configServed = true;
      res.end(JSON.stringify({
        sources: [],
        cameras: fixture.cameras,
        looks: fixture.looks,
        default_look: fixture.default_look,
      }));
      return;
    }
    if (req.method === 'GET') {
      if (configServed && !commandServed) {
        commandServed = true;
        res.end(JSON.stringify({ command: { id: 'fake-look-1', op: 'look', payload: { look: '2' } } }));
      } else {
        res.end(JSON.stringify({ command: null }));
      }
      return;
    }
    if (req.method === 'POST') {
      const body = await readJson(req);
      finishResult(body);
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.statusCode = 405;
    res.end(JSON.stringify({ ok: false }));
  });
  const relayPort = await listen(relayServer);
  t.after(() => close(relayServer));

  const agentPortServer = http.createServer();
  const agentPort = await listen(agentPortServer);
  await close(agentPortServer);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      BUILDING_ID: 'bench-1',
      RECORD_CONTROL_KEY: 'fake-test-key',
      RECORD_POLL_URL: `http://127.0.0.1:${relayPort}`,
      PORT: String(agentPort),
      OBS_SOURCES: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let childOutput = '';
  child.stdout.on('data', (chunk) => { childOutput += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { childOutput += chunk.toString('utf8'); });
  t.after(() => { if (!child.killed) child.kill('SIGTERM'); });

  const result = await resultPromise;
  assert.deepEqual(result, {
    mini_result: true,
    id: 'fake-look-1',
    ok: true,
    result: {
      ok: true,
      look: '2',
      cameras: { cam1: 'ok', cam2: 'ok', cam3: 'ok' },
    },
  });
  assert.equal(cameraRequests.length, 3);
  assert.equal(cameraRequests.every((url) => url.endsWith('?ptzcmd&poscall&1')), true);

  assert.deepEqual(await postAgent(agentPort, 'start'), { ok: true, recording: true, feeds_writing: null });
  assert.deepEqual(await postAgent(agentPort, 'look', { look: '2' }), {
    ok: false, look: '2', reason: 'busy_recording',
  });
  assert.deepEqual(await postAgent(agentPort, 'pause'), { ok: true, paused: true });
  assert.deepEqual(await postAgent(agentPort, 'look', { look: '2' }), {
    ok: false, look: '2', reason: 'busy_recording',
  });
  assert.deepEqual(await postAgent(agentPort, 'resume'), { ok: true, recording: true, feeds_writing: null });
  assert.deepEqual(await postAgent(agentPort, 'stop'), { ok: true, saved: true });
  assert.deepEqual(await postAgent(agentPort, 'status'), {
    ok: true, recording: false, feeds_writing: null, preview: false,
  });
  assert.equal(cameraRequests.length, 3);

  await waitFor(() => /relay: claimed look/.test(childOutput), 1000);
  assert.match(childOutput, /relay: claimed look/);

  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
});
