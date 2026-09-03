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

async function postAgent(port, op) {
  const response = await fetch(`http://127.0.0.1:${port}/record/${op}`, {
    method: 'POST',
    headers: { Authorization: 'Bearer fake-test-key', 'Content-Type': 'application/json' },
    body: JSON.stringify({ building_id: 'bench-1' }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function startAgent(t, options = {}) {
  const obsRequests = [];
  const obsServer = createFakeObs(obsRequests, options.obs || {});
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
  const recordDir = options.recordDir || fs.mkdtempSync(path.join(os.tmpdir(), 'es-mini-master-test-'));
  if (!options.recordDir) t.after(() => fs.rmSync(recordDir, { recursive: true, force: true }));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      BUILDING_ID: 'bench-1', RECORD_CONTROL_KEY: 'fake-test-key', PORT: String(agentPort),
      RECORD_POLL_URL: `http://127.0.0.1:${relayPort}`,
      OBS_WS_URL: `ws://127.0.0.1:${obsPort}`, OBS_SOURCES: 'cam1,cam2,cam3',
      OBS_RECORD_DIR: recordDir, MASTER_RECORD: options.masterRecord === false ? '0' : '1',
      ...(options.env || {}),
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
  return { agentPort, obsRequests, recordDir };
}

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
  assert.deepEqual(await postAgent(agentPort, 'start'), { ok: true, recording: true, feeds_writing: null });
  await waitFor(() => obsRequests.length === 3);
  assert.deepEqual(obsRequests.map((request) => request.data.requestData), [
    { source: 'cam1' }, { source: 'cam2' }, { source: 'cam3' },
  ]);
});

test('master start follows three camera starts', { timeout: 8000 }, async (t) => {
  const agent = await startAgent(t);
  assert.deepEqual(await postAgent(agent.agentPort, 'start'), { ok: true, recording: true, feeds_writing: null });
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

test('stop includes the returned master output path with the camera files', { timeout: 12000 }, async (t) => {
  const recordDir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-mini-master-stop-'));
  const masterPath = path.join(recordDir, 'master', 'master.mp4');
  for (const source of ['cam1', 'cam2', 'cam3', 'master']) {
    fs.mkdirSync(path.join(recordDir, source), { recursive: true });
    fs.writeFileSync(path.join(recordDir, source, source === 'master' ? 'master.mp4' : source + '.mp4'), 'recording');
  }
  const agent = await startAgent(t, { recordDir, obs: { masterOutputPath: masterPath } });
  t.after(() => fs.rmSync(recordDir, { recursive: true, force: true }));
  await postAgent(agent.agentPort, 'start');
  const result = await postAgent(agent.agentPort, 'stop');
  assert.deepEqual(result, { ok: true, saved: true });
  assert.deepEqual(agent.obsRequests.map((request) => request.type).slice(-4).sort(), [
    'CallVendorRequest', 'CallVendorRequest', 'CallVendorRequest', 'StopRecord',
  ].sort());
  assert.deepEqual(agent.obsRequests.filter((request) => request.type === 'CallVendorRequest').slice(-3)
    .map((request) => request.data.requestType), ['record_stop', 'record_stop', 'record_stop']);
});

test('MASTER_RECORD=0 preserves the camera-only request sequence', { timeout: 8000 }, async (t) => {
  const agent = await startAgent(t, { masterRecord: false });
  assert.deepEqual(await postAgent(agent.agentPort, 'start'), { ok: true, recording: true, feeds_writing: null });
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
  assert.deepEqual(uploads[0].webhookExtra, { kind: 'recording', building_id: 'bench-1', source: 'master' });
});
