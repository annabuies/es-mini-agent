'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const { createUploadQueue } = require('../upload-queue');

// Camera files under 64 KiB are treated as failed recordings (no video), so fixtures are bigger.
const CAMERA_FILE_BYTES = Buffer.alloc(80 * 1024, 1);

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  if (server._testSockets) {
    for (const socket of server._testSockets) socket.destroy();
  }
  return new Promise((resolve) => server.close(resolve));
}

async function waitFor(check, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for agent output');
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function frame(payload) {
  const text = Buffer.from(JSON.stringify(payload));
  if (text.length < 126) return Buffer.concat([Buffer.from([0x81, text.length]), text]);
  if (text.length > 65535) throw new Error('test frame unexpectedly large');
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(text.length, 2);
  return Buffer.concat([header, text]);
}

function createFakeObs(requests, options = {}) {
  const sockets = new Set();
  let outputActive = !!options.outputActive;
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let handshake = false;
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!handshake) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        const header = buffer.subarray(0, end).toString('utf8');
        buffer = buffer.subarray(end + 4);
        const key = (header.match(/Sec-WebSocket-Key: (.+)\r\n/i) || [])[1];
        const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
        socket.write(frame({ op: 0, d: { rpcVersion: 1 } }));
        handshake = true;
      }
      while (buffer.length >= 2) {
        let size = buffer[1] & 0x7f;
        let cursor = 2;
        if (size === 126) {
          if (buffer.length < 4) return;
          size = buffer.readUInt16BE(2);
          cursor = 4;
        }
        if (size === 127) throw new Error('test client frame unexpectedly large');
        const offset = cursor + 4;
        if (buffer.length < offset + size) return;
        const mask = buffer.subarray(cursor, cursor + 4);
        const body = Buffer.from(buffer.subarray(offset, offset + size));
        for (let i = 0; i < body.length; i += 1) body[i] ^= mask[i % 4];
        buffer = buffer.subarray(offset + size);
        const packet = JSON.parse(body.toString('utf8'));
        if (packet.op === 1) {
          socket.write(frame({ op: 2, d: { negotiatedRpcVersion: 1 } }));
          continue;
        }
        if (packet.op !== 6) continue;
        requests.push({ type: packet.d.requestType, data: packet.d.requestData || {} });
        let reply = { result: true, responseData: {} };
        if (packet.d.requestType === 'CallVendorRequest') {
          reply.responseData = { responseData: { success: true } };
        } else if (packet.d.requestType === 'GetRecordStatus') {
          reply.responseData = { outputActive };
        } else if (packet.d.requestType === 'StartRecord' && options.startRecordFails) {
          reply = { result: false, comment: 'start_record_rejected', responseData: {} };
        } else if (packet.d.requestType === 'StartRecord') {
          outputActive = true;
        } else if (packet.d.requestType === 'StopRecord') {
          reply.responseData = { outputPath: options.masterOutputPath || '' };
          outputActive = false;
        }
        if (typeof options.onRequest === 'function') {
          reply = Object.assign(reply, options.onRequest({ type: packet.d.requestType, data: packet.d.requestData || {} }, reply) || {});
        }
        socket.write(frame({
          op: 7,
          d: {
            requestType: packet.d.requestType,
            requestId: packet.d.requestId,
            requestStatus: { result: reply.result !== false, code: reply.result === false ? 500 : 100, comment: reply.comment },
            responseData: reply.responseData || {},
          },
        }));
      }
    });
  });
  server._testSockets = sockets;
  return server;
}

function createFakeR2(requests) {
  const sizes = new Map();
  return http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const url = new URL(req.url, 'http://127.0.0.1');
    requests.push({ method: req.method, path: url.pathname, query: url.searchParams });
    if (req.method === 'POST' && url.searchParams.has('uploads')) {
      res.end('<InitiateMultipartUploadResult><UploadId>fake-upload</UploadId></InitiateMultipartUploadResult>');
      return;
    }
    if (req.method === 'PUT' && url.searchParams.has('partNumber')) {
      sizes.set(url.pathname, Buffer.concat(chunks).length);
      res.setHeader('etag', 'fake-etag');
      res.end();
      return;
    }
    if (req.method === 'POST' && url.searchParams.has('uploadId')) {
      res.end('<CompleteMultipartUploadResult/>');
      return;
    }
    if (req.method === 'HEAD') {
      res.setHeader('content-length', String(sizes.get(url.pathname) || 0));
      res.end();
      return;
    }
    res.statusCode = 400;
    res.end('unexpected fake R2 request');
  });
}

function createFakeWebhook(bodies) {
  return http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.statusCode = 204;
    res.end();
  });
}

async function postAgent(port, op) {
  const body = arguments.length > 2 ? arguments[2] : {};
  const response = await fetch(`http://127.0.0.1:${port}/record/${op}`, {
    method: 'POST',
    headers: { Authorization: 'Bearer fake-test-key', 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ building_id: 'bench-1' }, body)),
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function startAgent(t, options = {}) {
  const obsRequests = [];
  const relayRequests = [];
  const obsServer = createFakeObs(obsRequests, options.obs || {});
  const obsPort = await listen(obsServer);
  t.after(() => close(obsServer));

  const relayServer = http.createServer((req, res) => {
    relayRequests.push(new URL(req.url, 'http://127.0.0.1'));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(options.relayResponse || { command: null }));
  });
  const relayPort = await listen(relayServer);
  t.after(() => close(relayServer));

  const portProbe = http.createServer();
  const agentPort = await listen(portProbe);
  await close(portProbe);
  const recordDir = options.recordDir || fs.mkdtempSync(path.join(os.tmpdir(), 'es-mini-master-test-'));
  if (!options.recordDir) t.after(() => fs.rmSync(recordDir, { recursive: true, force: true }));
  const uploadStateDir = options.uploadStateDir || path.join(recordDir, '.upload-state');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      BUILDING_ID: 'bench-1', RECORD_CONTROL_KEY: 'fake-test-key', PORT: String(agentPort),
      RECORD_POLL_URL: `http://127.0.0.1:${relayPort}`,
      OBS_WS_URL: `ws://127.0.0.1:${obsPort}`, OBS_SOURCES: 'cam1,cam2,cam3',
      OBS_RECORD_DIR: recordDir, MASTER_RECORD: options.masterRecord === false ? '0' : '1',
      UPLOAD_STATE_DIR: uploadStateDir,
      // Tests read the take files after stop; the deletion test turns this back on.
      DELETE_AFTER_UPLOAD: '0',
      ...(options.env || {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdoutText = '';
  child.stdout.on('data', (chunk) => { stdoutText += chunk.toString('utf8'); });
  child.stderr.on('data', () => {});
  t.after(async () => {
    if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
    if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve));
  });
  await waitFor(async () => {
    try { return (await fetch(`http://127.0.0.1:${agentPort}/health`)).ok; } catch (_) { return false; }
  });
  return { agentPort, obsRequests, relayRequests, recordDir, stdout: () => stdoutText };
}

test('heartbeat is sent from cached state on the first poll only once per minute and old poll responses still work', { timeout: 8000 }, async (t) => {
  const agent = await startAgent(t);
  await waitFor(() => agent.relayRequests.filter((url) => !url.searchParams.has('want_sources')).length >= 2);
  const polls = agent.relayRequests.filter((url) => !url.searchParams.has('want_sources'));
  const [first, second] = polls;

  assert.equal(first.searchParams.get('hb'), '1');
  assert.equal(first.searchParams.get('v'), '2026.09.30-1');
  assert.equal(first.searchParams.get('c'), 'unknown');
  const heartbeatState = JSON.parse(Buffer.from(first.searchParams.get('state'), 'base64url').toString('utf8'));
  assert.deepEqual(heartbeatState, {
    recording: false, paused: false, feeds_writing: 0, uploads: 0, master_active: false,
    cameras_down: [], cameras_checked_at: null,
    disk_free_bytes: heartbeatState.disk_free_bytes,
    disk_total_bytes: heartbeatState.disk_total_bytes,
    disk_checked_at: heartbeatState.disk_checked_at,
    power: null,
  });
  assert.equal(typeof heartbeatState.disk_free_bytes, 'number');
  assert.equal(typeof heartbeatState.disk_total_bytes, 'number');
  assert.match(heartbeatState.disk_checked_at, /^2026-/);
  assert.ok(Buffer.byteLength(JSON.stringify(heartbeatState)) < 1024);
  assert.equal(second.searchParams.has('hb'), false);
});

test('heartbeat reports cached disk usage without filesystem I/O from the poll path', { timeout: 8000 }, async (t) => {
  const statfsLog = path.join(os.tmpdir(), `es-mini-statfs-${process.pid}-${Date.now()}.log`);
  t.after(() => fs.promises.rm(statfsLog, { force: true }));
  const agent = await startAgent(t, {
    env: {
      NODE_OPTIONS: `--require=${path.join(__dirname, 'statfs-count-hook.js')}`,
      STATFS_COUNT_LOG: statfsLog,
    },
  });
  await waitFor(() => agent.relayRequests.filter((url) => !url.searchParams.has('want_sources')).length >= 2);
  const first = agent.relayRequests.find((url) => !url.searchParams.has('want_sources'));
  const heartbeatState = JSON.parse(Buffer.from(first.searchParams.get('state'), 'base64url').toString('utf8'));

  assert.equal(typeof heartbeatState.disk_free_bytes, 'number');
  assert.equal(typeof heartbeatState.disk_total_bytes, 'number');
  assert.match(heartbeatState.disk_checked_at, /^2026-/);
  assert.ok(Buffer.byteLength(JSON.stringify(heartbeatState)) < 1024);
  assert.equal((await fs.promises.readFile(statfsLog, 'utf8')).trim().split('\n').length, 1);
});

test('heartbeat reports cached camera reachability without probing from the poll path', { timeout: 8000 }, async (t) => {
  const cameraRequests = [];
  const cameraServer = http.createServer((req, res) => {
    cameraRequests.push(req.url);
    res.statusCode = 503; // Any HTTP response still proves the camera is reachable.
    res.end();
  });
  const cameraPort = await listen(cameraServer);
  t.after(() => close(cameraServer));

  const closedServer = http.createServer();
  const closedPort = await listen(closedServer);
  await close(closedServer);
  const agent = await startAgent(t, {
    relayResponse: {
      command: null,
      cameras: [
        { name: 'cam1', host: `127.0.0.1:${cameraPort}` },
        { name: 'cam2', host: `127.0.0.1:${closedPort}` },
      ],
    },
  });
  await waitFor(() => cameraRequests.length === 1);
  await waitFor(() => agent.relayRequests.filter((url) => !url.searchParams.has('want_sources')).length >= 2);
  const first = agent.relayRequests.find((url) => !url.searchParams.has('want_sources'));
  const heartbeatState = JSON.parse(Buffer.from(first.searchParams.get('state'), 'base64url').toString('utf8'));

  assert.deepEqual(heartbeatState.cameras_down, ['cam2']);
  assert.match(heartbeatState.cameras_checked_at, /^2026-/);
  assert.ok(Buffer.byteLength(JSON.stringify(heartbeatState)) < 1024);
  assert.equal(cameraRequests.length, 1);
});

test('smoke: fake relay and OBS start the three camera recordings', { timeout: 8000 }, async (t) => {
  const obsRequests = [];
  const obsServer = createFakeObs(obsRequests);
  const obsPort = await listen(obsServer);
  t.after(() => close(obsServer));

  const relayServer = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ command: null }));
  });
  const relayPort = await listen(relayServer);
  t.after(() => close(relayServer));

  const portProbe = http.createServer();
  const agentPort = await listen(portProbe);
  await close(portProbe);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: require('node:path').join(__dirname, '..'),
    env: {
      ...process.env,
      BUILDING_ID: 'bench-1', RECORD_CONTROL_KEY: 'fake-test-key', PORT: String(agentPort),
      RECORD_POLL_URL: `http://127.0.0.1:${relayPort}`,
      OBS_WS_URL: `ws://127.0.0.1:${obsPort}`, OBS_SOURCES: 'cam1,cam2,cam3',
      OBS_RECORD_DIR: require('node:os').tmpdir(), MASTER_RECORD: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
    if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve));
  });

  await waitFor(async () => {
    try { return (await fetch(`http://127.0.0.1:${agentPort}/health`)).ok; } catch (_) { return false; }
  });
  assert.deepEqual(await postAgent(agentPort, 'start'), { ok: true, recording: true, feeds_writing: null, capture: { cam1: 'source_record', cam2: 'source_record', cam3: 'source_record' }, fallbacks: {} });
  await waitFor(() => obsRequests.length === 3);
  assert.deepEqual(obsRequests.map((request) => request.data.requestData), [
    { source: 'cam1' }, { source: 'cam2' }, { source: 'cam3' },
  ]);
});

test('master start follows three camera starts', { timeout: 8000 }, async (t) => {
  const agent = await startAgent(t);
  assert.deepEqual(await postAgent(agent.agentPort, 'start'), { ok: true, recording: true, feeds_writing: null, capture: { cam1: 'source_record', cam2: 'source_record', cam3: 'source_record' }, fallbacks: {} });
  await waitFor(() => agent.obsRequests.length === 5);
  assert.deepEqual(agent.obsRequests.map((request) => request.type), [
    'CallVendorRequest', 'CallVendorRequest', 'CallVendorRequest', 'GetRecordStatus', 'StartRecord',
  ]);
  assert.deepEqual(agent.obsRequests.slice(0, 3).map((request) => request.data.requestData), [
    { source: 'cam1' }, { source: 'cam2' }, { source: 'cam3' },
  ]);
  const status = await postAgent(agent.agentPort, 'status');
  assert.equal(status.master_enabled, true);
  assert.equal(status.master_active, true);
  const diag = await postAgent(agent.agentPort, 'diag');
  assert.equal(diag.master_enabled, true);
  assert.equal(diag.master_active, true);
});

test('master start failure stops every started camera', { timeout: 8000 }, async (t) => {
  const agent = await startAgent(t, { obs: { startRecordFails: true } });
  const result = await postAgent(agent.agentPort, 'start');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'obs_start_failed');
  assert.match(result.detail, /^master: start_record_rejected$/);
  await waitFor(() => agent.obsRequests.length === 8);
  assert.deepEqual(agent.obsRequests.map((request) => request.type), [
    'CallVendorRequest', 'CallVendorRequest', 'CallVendorRequest', 'GetRecordStatus', 'StartRecord',
    'CallVendorRequest', 'CallVendorRequest', 'CallVendorRequest',
  ]);
  assert.deepEqual(agent.obsRequests.slice(-3).map((request) => request.data.requestData), [
    { source: 'cam1' }, { source: 'cam2' }, { source: 'cam3' },
  ]);
  assert.deepEqual(agent.obsRequests.slice(-3).map((request) => request.data.requestType), [
    'record_stop', 'record_stop', 'record_stop',
  ]);
});

test('an already-active OBS master refuses a new camera session', { timeout: 8000 }, async (t) => {
  const agent = await startAgent(t, { obs: { outputActive: true } });
  const result = await postAgent(agent.agentPort, 'start');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'obs_start_failed');
  assert.match(result.detail, /^master: recording_already_active$/);
  await waitFor(() => agent.obsRequests.length === 7);
  assert.deepEqual(agent.obsRequests.map((request) => request.type), [
    'CallVendorRequest', 'CallVendorRequest', 'CallVendorRequest', 'GetRecordStatus',
    'CallVendorRequest', 'CallVendorRequest', 'CallVendorRequest',
  ]);
});

test('stop enqueues three camera files plus the returned master output path', { timeout: 30000 }, async (t) => {
  const recordDir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-mini-master-stop-'));
  const masterPath = path.join(recordDir, 'master', 'master.mp4');
  for (const source of ['cam1', 'cam2', 'cam3', 'master']) {
    fs.mkdirSync(path.join(recordDir, source), { recursive: true });
    fs.writeFileSync(path.join(recordDir, source, source === 'master' ? 'master.mp4' : source + '.mp4'), CAMERA_FILE_BYTES);
  }
  const uploads = [];
  const r2Server = createFakeR2(uploads);
  const r2Port = await listen(r2Server);
  t.after(() => close(r2Server));
  const agent = await startAgent(t, {
    recordDir,
    obs: { masterOutputPath: masterPath },
    env: {
      S3_ACCESS_KEY_ID: 'fake-access-key', S3_SECRET_ACCESS_KEY: 'fake-secret-key',
      S3_BUCKET: 'fake-bucket', S3_ENDPOINT: `http://127.0.0.1:${r2Port}`,
    },
  });
  t.after(() => fs.rmSync(recordDir, { recursive: true, force: true }));
  await postAgent(agent.agentPort, 'start');
  const result = await postAgent(agent.agentPort, 'stop');
  assert.deepEqual(result, {
    ok: true, saved: true, upload_queued: 4, files_ok: true,
    files: ['cam1', 'cam2', 'cam3'].map((source) => ({ source, capture: 'source_record', ok: true, bytes: CAMERA_FILE_BYTES.length })),
  });
  assert.deepEqual(agent.obsRequests.map((request) => request.type).slice(-4).sort(), [
    'CallVendorRequest', 'CallVendorRequest', 'CallVendorRequest', 'StopRecord',
  ].sort());
  assert.deepEqual(agent.obsRequests.filter((request) => request.type === 'CallVendorRequest').slice(-3)
    .map((request) => request.data.requestType), ['record_stop', 'record_stop', 'record_stop']);
  await waitFor(() => uploads.filter((request) => request.method === 'POST' && request.query.has('uploads')).length === 4, 28000);
  assert.deepEqual(uploads.filter((request) => request.method === 'POST' && request.query.has('uploads')).map((request) => request.path).sort(), [
    '/fake-bucket/recordings/bench-1/cam1/cam1.mp4',
    '/fake-bucket/recordings/bench-1/cam2/cam2.mp4',
    '/fake-bucket/recordings/bench-1/cam3/cam3.mp4',
    '/fake-bucket/recordings/bench-1/master/master.mp4',
  ]);
});

test('MASTER_RECORD=0 preserves the camera-only request sequence', { timeout: 8000 }, async (t) => {
  const agent = await startAgent(t, { masterRecord: false });
  assert.deepEqual(await postAgent(agent.agentPort, 'start'), { ok: true, recording: true, feeds_writing: null, capture: { cam1: 'source_record', cam2: 'source_record', cam3: 'source_record' }, fallbacks: {} });
  await waitFor(() => agent.obsRequests.length === 3);
  assert.deepEqual(agent.obsRequests.map((request) => request.type), [
    'CallVendorRequest', 'CallVendorRequest', 'CallVendorRequest',
  ]);
});

test('pause and resume also control the active master', { timeout: 8000 }, async (t) => {
  const agent = await startAgent(t);
  await postAgent(agent.agentPort, 'start');
  await postAgent(agent.agentPort, 'pause');
  await postAgent(agent.agentPort, 'resume');
  await waitFor(() => agent.obsRequests.length === 13);
  assert.deepEqual(agent.obsRequests.map((request) => request.type).slice(-8), [
    'CallVendorRequest', 'CallVendorRequest', 'CallVendorRequest', 'PauseRecord',
    'CallVendorRequest', 'CallVendorRequest', 'CallVendorRequest', 'ResumeRecord',
  ]);
});

test('master uploads retain their recording key and skip proxy generation', { timeout: 8000 }, async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-mini-master-upload-'));
  const filePath = path.join(tempDir, 'master.mp4');
  fs.writeFileSync(filePath, 'master');
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const uploads = [];
  const queue = createUploadQueue({
    stateDir: path.join(tempDir, 'state'),
    buildingId: 'bench-1',
    uploader: async (input) => {
      uploads.push(input);
      return { key: input.key, sizeBytes: input.sizeBytes, partsUploaded: 1 };
    },
  });
  assert.deepEqual(queue.enqueue({ filePath, source: 'master' }), {
    queued: true, key: 'recordings/bench-1/master/master.mp4',
  });
  await waitFor(() => uploads.length === 1, 5000);
  assert.equal(uploads[0].key, 'recordings/bench-1/master/master.mp4');
  assert.deepEqual(uploads[0].webhookExtra, { kind: 'recording', building_id: 'bench-1', source: 'master', session_ref: null });
});

test('session_ref is reported while recording and echoed to every stop upload', { timeout: 16000 }, async (t) => {
  const recordDir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-mini-session-ref-'));
  const masterPath = path.join(recordDir, 'master', 'master.mp4');
  for (const source of ['cam1', 'cam2', 'cam3', 'master']) {
    fs.mkdirSync(path.join(recordDir, source), { recursive: true });
    fs.writeFileSync(path.join(recordDir, source, source === 'master' ? 'master.mp4' : source + '.mp4'), CAMERA_FILE_BYTES);
  }
  const uploads = [];
  const r2Server = createFakeR2(uploads);
  const r2Port = await listen(r2Server);
  t.after(() => close(r2Server));
  const webhookBodies = [];
  const webhookServer = createFakeWebhook(webhookBodies);
  const webhookPort = await listen(webhookServer);
  t.after(() => close(webhookServer));
  const agent = await startAgent(t, {
    recordDir,
    obs: { masterOutputPath: masterPath },
    env: {
      AUDIO_SPLIT: '0', S3_ACCESS_KEY_ID: 'fake-access-key', S3_SECRET_ACCESS_KEY: 'fake-secret-key',
      S3_BUCKET: 'fake-bucket', S3_ENDPOINT: `http://127.0.0.1:${r2Port}`,
      UPLOAD_CONFIRMED_WEBHOOK_URL: `http://127.0.0.1:${webhookPort}`,
    },
  });
  t.after(() => fs.rmSync(recordDir, { recursive: true, force: true }));
  const started = await postAgent(agent.agentPort, 'start', { session_ref: 'session_123', client_code: 'client_123' });
  assert.equal(started.session_ref, 'session_123');
  assert.equal((await postAgent(agent.agentPort, 'status')).session_ref, 'session_123');
  assert.equal((await postAgent(agent.agentPort, 'status')).client_code, 'client_123');
  assert.equal((await postAgent(agent.agentPort, 'diag')).session_ref, 'session_123');
  await postAgent(agent.agentPort, 'stop');
  await waitFor(() => uploads.filter((request) => request.method === 'POST' && request.query.has('uploads')).length === 4, 12000);
  await waitFor(() => webhookBodies.length === 4, 4000);
  await waitFor(() => fs.readdirSync(path.join(recordDir, '.upload-state')).length === 0, 2000);
  assert.deepEqual(uploads.filter((request) => request.method === 'POST' && request.query.has('uploads'))
    .map((request) => request.path).sort(), [
      '/fake-bucket/recordings/bench-1/cam1/cam1.mp4',
      '/fake-bucket/recordings/bench-1/cam2/cam2.mp4',
      '/fake-bucket/recordings/bench-1/cam3/cam3.mp4',
      '/fake-bucket/recordings/bench-1/master/master.mp4',
    ]);
  assert.deepEqual(webhookBodies.map((body) => [body.source, body.session_ref]).sort(), [
    ['cam1', 'session_123'],
    ['cam2', 'session_123'],
    ['cam3', 'session_123'],
    ['master', 'session_123'],
  ]);
});

test('missing or invalid session_ref stays null and does not crash recording', { timeout: 12000 }, async (t) => {
  const agent = await startAgent(t, { masterRecord: false });
  const missing = await postAgent(agent.agentPort, 'start');
  assert.equal(missing.session_ref, undefined);
  assert.equal((await postAgent(agent.agentPort, 'status')).session_ref, null);
  await postAgent(agent.agentPort, 'stop');
  const invalid = await postAgent(agent.agentPort, 'start', { session_ref: 'bad session ref!' });
  assert.equal(invalid.session_ref, undefined);
  assert.equal((await postAgent(agent.agentPort, 'diag')).session_ref, null);
  await postAgent(agent.agentPort, 'cancel');
});

test('master confirmation splits four stream-copy mic files and echoes session_ref', { timeout: 22000 }, async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-mini-audio-split-'));
  const filePath = path.join(tempDir, 'master.mp4');
  const logPath = path.join(tempDir, 'ffmpeg.log');
  fs.writeFileSync(filePath, 'master');
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const uploads = [];
  const queue = createUploadQueue({
    stateDir: path.join(tempDir, 'state'), buildingId: 'bench-1', audioSplit: true, stabilityPollMs: 5,
    uploader: async (input) => { uploads.push(input); return { key: input.key, sizeBytes: input.sizeBytes, partsUploaded: 1 }; },
  });
  const previousFfmpeg = process.env.FFMPEG_BIN;
  const previousFfprobe = process.env.FFPROBE_BIN;
  const previousLog = process.env.FAKE_FFMPEG_LOG;
  const previousStreams = process.env.FAKE_AUDIO_STREAMS;
  process.env.FFMPEG_BIN = path.join(__dirname, 'fake-ffmpeg.js');
  process.env.FFPROBE_BIN = path.join(__dirname, 'fake-ffmpeg.js');
  process.env.FAKE_FFMPEG_LOG = logPath;
  process.env.FAKE_AUDIO_STREAMS = '4';
  t.after(() => {
    restoreEnv('FFMPEG_BIN', previousFfmpeg);
    restoreEnv('FFPROBE_BIN', previousFfprobe);
    restoreEnv('FAKE_FFMPEG_LOG', previousLog);
    restoreEnv('FAKE_AUDIO_STREAMS', previousStreams);
  });
  queue.enqueue({ filePath, source: 'master', sessionRef: 'session_123' });
  await waitFor(() => uploads.length === 5, 18000);
  await waitFor(() => queue.status().active === null && queue.status().queued === 0, 2000);
  assert.deepEqual(uploads.map((input) => input.key).sort(), [
    'recordings/bench-1/audio/master-mic1.m4a', 'recordings/bench-1/audio/master-mic2.m4a',
    'recordings/bench-1/audio/master-mic3.m4a', 'recordings/bench-1/audio/master-mic4.m4a',
    'recordings/bench-1/master/master.mp4',
  ]);
  assert.deepEqual(uploads.filter((input) => input.webhookExtra.kind === 'audio').map((input) => input.webhookExtra.session_ref), ['session_123', 'session_123', 'session_123', 'session_123']);
  const invocations = fs.readFileSync(logPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(invocations.filter((args) => args.includes('-show_streams')).length, 1);
  assert.equal(invocations.filter((args) => args.includes('-c') && args.includes('copy')).length, 4);
  for (let index = 1; index <= 4; index += 1) assert.equal(fs.existsSync(path.join(tempDir, `master-mic${index}.m4a`)), false);
});

test('AUDIO_SPLIT=0 uploads only the confirmed master', { timeout: 12000 }, async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-mini-audio-split-off-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const filePath = path.join(tempDir, 'master-disabled.mp4');
  fs.writeFileSync(filePath, 'master');
  const uploads = [];
  const queue = createUploadQueue({
    stateDir: path.join(tempDir, 'state-disabled'), buildingId: 'bench-1', audioSplit: false, stabilityPollMs: 5,
    uploader: async (input) => { uploads.push(input); return { key: input.key, sizeBytes: input.sizeBytes, partsUploaded: 1 }; },
  });
  queue.enqueue({ filePath, source: 'master' });
  await waitFor(() => uploads.length === 1 && queue.status().active === null && queue.status().queued === 0, 8000);
  assert.deepEqual(uploads.map((input) => input.key), ['recordings/bench-1/master/master-disabled.mp4']);
});

test('a two-stream master uploads two audio jobs and logs a warning', { timeout: 12000 }, async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-mini-audio-split-two-stream-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const filePath = path.join(tempDir, 'master-two-stream.mp4');
  fs.writeFileSync(filePath, 'master');
  const uploads = [];
  const queue = createUploadQueue({
    stateDir: path.join(tempDir, 'state'), buildingId: 'bench-1', audioSplit: true, stabilityPollMs: 5,
    uploader: async (input) => { uploads.push(input); return { key: input.key, sizeBytes: input.sizeBytes, partsUploaded: 1 }; },
  });
  const previousFfmpeg = process.env.FFMPEG_BIN;
  const previousFfprobe = process.env.FFPROBE_BIN;
  const previousStreams = process.env.FAKE_AUDIO_STREAMS;
  const previousWarn = console.warn;
  const warnings = [];
  process.env.FFMPEG_BIN = path.join(__dirname, 'fake-ffmpeg.js');
  process.env.FFPROBE_BIN = path.join(__dirname, 'fake-ffmpeg.js');
  process.env.FAKE_AUDIO_STREAMS = '2';
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  t.after(() => {
    restoreEnv('FFMPEG_BIN', previousFfmpeg);
    restoreEnv('FFPROBE_BIN', previousFfprobe);
    restoreEnv('FAKE_AUDIO_STREAMS', previousStreams);
    console.warn = previousWarn;
  });
  queue.enqueue({ filePath, source: 'master' });
  await waitFor(() => uploads.length === 3 && queue.status().active === null && queue.status().queued === 0, 8000);
  assert.deepEqual(uploads.map((input) => input.key).sort(), [
    'recordings/bench-1/audio/master-two-stream-mic1.m4a',
    'recordings/bench-1/audio/master-two-stream-mic2.m4a',
    'recordings/bench-1/master/master-two-stream.mp4',
  ]);
  assert.match(warnings.join('\n'), /master has 2 audio streams/);
});

const FAKE_RTSP_FFMPEG = path.join(__dirname, 'fake-ffmpeg-rtsp.js');
const TAKE = '2026-09-29 08-13-05';

async function startRtspAgent(t, extraEnv) {
  const recordDir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-mini-rtsp-agent-'));
  for (const source of ['cam1', 'cam2', 'cam3', 'master']) fs.mkdirSync(path.join(recordDir, source), { recursive: true });
  // What OBS would have written for the Source Record cameras and the master.
  for (const source of ['cam2', 'cam3', 'master']) fs.writeFileSync(path.join(recordDir, source, TAKE + '.mp4'), CAMERA_FILE_BYTES);
  const uploads = [];
  const r2Server = createFakeR2(uploads);
  const r2Port = await listen(r2Server);
  t.after(() => close(r2Server));
  const webhookBodies = [];
  const webhookServer = createFakeWebhook(webhookBodies);
  const webhookPort = await listen(webhookServer);
  t.after(() => close(webhookServer));
  const agent = await startAgent(t, {
    recordDir,
    obs: { masterOutputPath: path.join(recordDir, 'master', TAKE + '.mp4') },
    relayResponse: {
      command: null,
      cameras: [
        { name: 'cam1', host: '127.0.0.1', capture: 'rtsp' },
        { name: 'cam2', host: '127.0.0.2' },
        { name: 'cam3', host: '127.0.0.3' },
      ],
    },
    env: {
      FFMPEG_BIN: FAKE_RTSP_FFMPEG, AUDIO_SPLIT: '0',
      UPLOAD_CONFIRMED_WEBHOOK_URL: `http://127.0.0.1:${webhookPort}`,
      S3_ACCESS_KEY_ID: 'fake-access-key', S3_SECRET_ACCESS_KEY: 'fake-secret-key',
      S3_BUCKET: 'fake-bucket', S3_ENDPOINT: `http://127.0.0.1:${r2Port}`,
      ...(extraEnv || {}),
    },
  });
  // Registered after startAgent so it runs once the agent (and its proxy ffmpeg) has stopped.
  t.after(() => fs.rmSync(recordDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await waitFor(() => agent.relayRequests.some((url) => url.searchParams.has('want_sources')));
  await new Promise((resolve) => setTimeout(resolve, 200)); // camera config applied
  return Object.assign(agent, { uploads, recordDir, webhooks: () => webhookBodies });
}

const vendorCalls = (agent, requestType) => agent.obsRequests
  .filter((r) => r.type === 'CallVendorRequest' && r.data.requestType === requestType)
  .map((r) => r.data.requestData && r.data.requestData.source || r.data.requestData);

test('an RTSP camera skips Source Record and its file is named after the master and uploaded', { timeout: 30000 }, async (t) => {
  const agent = await startRtspAgent(t);
  assert.deepEqual(await postAgent(agent.agentPort, 'start'), { ok: true, recording: true, feeds_writing: null, capture: { cam1: 'rtsp', cam2: 'source_record', cam3: 'source_record' }, fallbacks: {} });
  assert.equal(vendorCalls(agent, 'record_start').length, 2, 'Source Record started for cam2 and cam3 only');
  await new Promise((resolve) => setTimeout(resolve, 300));
  const status = await postAgent(agent.agentPort, 'status');
  assert.equal(status.rtsp.cam1.writing, true);
  // The RTSP camera counts from its growing part, not the OBS sampler (which skips parts).
  assert.equal(status.feeds_writing, 3);
  assert.equal(status.fallbacks, undefined);
  const result = await postAgent(agent.agentPort, 'stop');
  assert.equal(result.saved, true);
  assert.equal(result.upload_queued, 4);
  assert.equal(result.files_ok, true);
  assert.deepEqual(result.files.map((f) => [f.source, f.capture, f.ok, f.problem]), [
    ['cam1', 'rtsp', true, undefined], ['cam2', 'source_record', true, undefined], ['cam3', 'source_record', true, undefined],
  ]);
  assert.equal(vendorCalls(agent, 'record_stop').length, 2);
  assert.deepEqual(fs.readdirSync(path.join(agent.recordDir, 'cam1')).filter((f) => f.endsWith('.mp4')), [TAKE + '.mp4']);
  await waitFor(() => agent.uploads.filter((r) => r.method === 'POST' && r.query.has('uploads') && r.path.includes('/recordings/')).length === 4, 28000);
  assert.deepEqual(agent.uploads.filter((r) => r.method === 'POST' && r.query.has('uploads') && r.path.includes('/recordings/')).map((r) => r.path).sort(), [
    `/fake-bucket/recordings/bench-1/cam1/${TAKE}.mp4`,
    `/fake-bucket/recordings/bench-1/cam2/${TAKE}.mp4`,
    `/fake-bucket/recordings/bench-1/cam3/${TAKE}.mp4`,
    `/fake-bucket/recordings/bench-1/master/${TAKE}.mp4`,
  ].map((p) => p.replace(/ /g, '%20')).sort());
});

test('an RTSP camera that cannot connect falls back to Source Record for that take', { timeout: 15000 }, async (t) => {
  const agent = await startRtspAgent(t, { FAKE_RTSP_FAIL: '1' });
  const started = await postAgent(agent.agentPort, 'start');
  assert.deepEqual(started.capture, { cam1: 'source_record', cam2: 'source_record', cam3: 'source_record' });
  assert.match(started.fallbacks.cam1, /^rtsp_start_failed/);
  assert.equal(vendorCalls(agent, 'record_start').length, 3, 'cam1 recorded by Source Record after RTSP failed');
  const status = await postAgent(agent.agentPort, 'status');
  assert.equal(status.rtsp, undefined);
  assert.match(status.fallbacks.cam1, /^rtsp_start_failed/);
  fs.writeFileSync(path.join(agent.recordDir, 'cam1', TAKE + '.mp4'), CAMERA_FILE_BYTES); // Source Record's file
  const stopped = await postAgent(agent.agentPort, 'stop');
  assert.equal(vendorCalls(agent, 'record_stop').length, 3);
  // Never silent: agent.log (stdout) says so, and the file carries the fallback to the webhook.
  assert.match(agent.stdout(), /\[rtsp\] FALLBACK cam1 -> Source Record for this take: rtsp_start_failed/);
  const cam1 = stopped.files.find((f) => f.source === 'cam1');
  assert.equal(cam1.capture, 'source_record');
  assert.match(cam1.fallback_reason, /^rtsp_start_failed/);
  assert.equal(cam1.problem, 'fallback');
  await waitFor(() => agent.webhooks().some((b) => b.source === 'cam1'), 12000);
  const hook = agent.webhooks().find((b) => b.source === 'cam1');
  assert.equal(hook.capture, 'source_record_fallback');
  assert.match(hook.fallback_reason, /^rtsp_start_failed/);
});

test('pause and resume on an RTSP take pause ffmpeg, not Source Record, for that camera', { timeout: 15000 }, async (t) => {
  const agent = await startRtspAgent(t);
  await postAgent(agent.agentPort, 'start');
  await new Promise((resolve) => setTimeout(resolve, 200));
  await postAgent(agent.agentPort, 'pause');
  assert.equal(vendorCalls(agent, 'record_pause').length, 2);
  assert.equal((await postAgent(agent.agentPort, 'status')).rtsp.cam1.paused, true);
  await postAgent(agent.agentPort, 'resume');
  assert.equal(vendorCalls(agent, 'record_unpause').length, 2);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const status = await postAgent(agent.agentPort, 'status');
  assert.equal(status.rtsp.cam1.paused, false);
  assert.equal(status.rtsp.cam1.segments, 2);
  await postAgent(agent.agentPort, 'stop');
  assert.deepEqual(fs.readdirSync(path.join(agent.recordDir, 'cam1')).filter((f) => f.endsWith('.mp4')), [TAKE + '.mp4']);
});

test('DELETE_AFTER_UPLOAD: camera and master originals leave the Mini only after a verified upload and their proxy / audio split', { timeout: 12000 }, async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-mini-delete-after-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const camPath = path.join(tempDir, 'cam1.mp4');
  const masterPath = path.join(tempDir, 'master.mp4');
  const keptPath = path.join(tempDir, 'cam2.mp4');
  fs.writeFileSync(camPath, CAMERA_FILE_BYTES);
  fs.writeFileSync(masterPath, CAMERA_FILE_BYTES);
  fs.writeFileSync(keptPath, CAMERA_FILE_BYTES);
  const uploads = [];
  let failNext = false;
  const make = (deleteAfterUpload) => createUploadQueue({
    stateDir: path.join(tempDir, 'state'),
    buildingId: 'bench-1',
    deleteAfterUpload,
    audioSplit: false,
    stabilityPollMs: 5,
    uploader: async (input) => {
      if (failNext) { failNext = false; throw new Error('HeadObject size mismatch'); }
      uploads.push(input);
      return { key: input.key, sizeBytes: input.sizeBytes, partsUploaded: 1 };
    },
  });
  const previousFfmpeg = process.env.FFMPEG_BIN;
  const previousFfprobe = process.env.FFPROBE_BIN;
  process.env.FFMPEG_BIN = path.join(__dirname, 'fake-ffmpeg.js');
  process.env.FFPROBE_BIN = path.join(__dirname, 'fake-ffmpeg.js');
  t.after(() => { restoreEnv('FFMPEG_BIN', previousFfmpeg); restoreEnv('FFPROBE_BIN', previousFfprobe); });
  const queue = make(true);
  queue.enqueue({ filePath: camPath, source: 'cam1', meta: { capture: 'source_record_fallback', fallback_reason: 'rtsp_start_failed: x', bogus: 'dropped' } });
  queue.enqueue({ filePath: masterPath, source: 'master' });
  await waitFor(() => !fs.existsSync(camPath) && !fs.existsSync(masterPath), 10000);
  const camUpload = uploads.find((u) => u.key === 'recordings/bench-1/cam1/cam1.mp4');
  assert.deepEqual(camUpload.webhookExtra, { kind: 'recording', building_id: 'bench-1', source: 'cam1', session_ref: null, capture: 'source_record_fallback', fallback_reason: 'rtsp_start_failed: x' });
  assert.ok(uploads.some((u) => u.key === 'proxies/bench-1/cam1/cam1.mp4'), 'proxy made from the original before it was removed');
  // A failed upload keeps the file.
  failNext = true;
  queue.enqueue({ filePath: keptPath, source: 'cam2' });
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.ok(fs.existsSync(keptPath));
});
