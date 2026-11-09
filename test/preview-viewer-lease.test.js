'use strict';

// S5 (Robbie 10-31, kiosk preview black for several seconds): one OBS stream serves
// every viewer, and one viewer's preview_stop (a phone leaving its Studio screen)
// stopped it for the kiosk too. Each viewer now holds a lease; the stream stops when
// the last one is released. A stop without a viewer id keeps the old behaviour.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

function frame(payload) {
  const text = Buffer.from(JSON.stringify(payload));
  if (text.length < 126) return Buffer.concat([Buffer.from([0x81, text.length]), text]);
  const header = Buffer.alloc(4);
  header[0] = 0x81; header[1] = 126; header.writeUInt16BE(text.length, 2);
  return Buffer.concat([header, text]);
}

// Just enough OBS for the Cloudflare preview path: scenes, items, stream on/off.
function createFakeObs(requests) {
  let streaming = false;
  let nextItem = 10;
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
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
        if (size === 126) { if (buffer.length < 4) return; size = buffer.readUInt16BE(2); cursor = 4; }
        const offset = cursor + 4;
        if (buffer.length < offset + size) return;
        const mask = buffer.subarray(cursor, cursor + 4);
        const body = Buffer.from(buffer.subarray(offset, offset + size));
        for (let i = 0; i < body.length; i += 1) body[i] ^= mask[i % 4];
        const opcode = buffer[0] & 0x0f;
        buffer = buffer.subarray(offset + size);
        if (opcode === 0x8) { socket.end(); return; }
        if (opcode !== 0x1) continue;
        const packet = JSON.parse(body.toString('utf8'));
        if (packet.op === 1) { socket.write(frame({ op: 2, d: { negotiatedRpcVersion: 1 } })); continue; }
        if (packet.op !== 6) continue;
        const type = packet.d.requestType;
        requests.push(type);
        let data = {};
        if (type === 'GetStreamStatus') data = { outputActive: streaming };
        else if (type === 'GetCurrentProgramScene') data = { currentProgramSceneName: 'Studio' };
        else if (type === 'GetVideoSettings') data = { baseWidth: 1920, baseHeight: 1080 };
        else if (type === 'CreateSceneItem') data = { sceneItemId: nextItem++ };
        else if (type === 'GetSceneList') data = { scenes: [] };
        else if (type === 'StartStream') streaming = true;
        else if (type === 'StopStream') streaming = false;
        socket.write(frame({ op: 7, d: { requestType: type, requestId: packet.d.requestId, requestStatus: { result: true, code: 100 }, responseData: data } }));
      }
    });
  });
  server._testSockets = sockets;
  return server;
}

function listen(server) {
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); });
}
function close(server) {
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  if (server._testSockets) for (const socket of server._testSockets) socket.destroy();
  return new Promise((resolve) => server.close(resolve));
}
async function waitFor(check, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await check()) return; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error('timed out');
}

const CF = {
  inputUid: 'a'.repeat(32),
  publishUrl: 'https://customer-test.cloudflarestream.com/' + 'a'.repeat(32) + '/webRTC/publish',
  playbackUrl: 'https://customer-test.cloudflarestream.com/' + 'a'.repeat(32) + '/webRTC/play',
};
const VIEWER_KIOSK = '0123456789abcdef';
const VIEWER_PHONE = 'fedcba9876543210';

async function startAgent(t) {
  const obsRequests = [];
  const obs = createFakeObs(obsRequests);
  const obsPort = await listen(obs);
  t.after(() => close(obs));
  const relayCalls = [];
  const relay = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    relayCalls.push({ url: req.url, body: Buffer.concat(chunks).toString('utf8') });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, command: null }));
  });
  const relayPort = await listen(relay);
  t.after(() => close(relay));
  const probe = http.createServer();
  const agentPort = await listen(probe);
  await close(probe);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      BUILDING_ID: 'bench-1', RECORD_CONTROL_KEY: 'fake-test-key', PORT: String(agentPort),
      RECORD_POLL_URL: `http://127.0.0.1:${relayPort}`, POLL_IDLE_INTERVAL_MS: '60000',
      OBS_WS_URL: `ws://127.0.0.1:${obsPort}`, OBS_SOURCES: 'cam1,cam2,cam3', MASTER_RECORD: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.resume(); child.stderr.resume();
  t.after(async () => {
    if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
    if (child.exitCode === null) await new Promise((r) => child.once('exit', r));
  });
  await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${agentPort}/health`)).ok; } catch (_) { return false; } }, 10000);
  const op = async (name, body = {}) => {
    const response = await fetch(`http://127.0.0.1:${agentPort}/record/${name}`, {
      method: 'POST', headers: { Authorization: 'Bearer fake-test-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ building_id: 'bench-1', ...body }),
    });
    return response.json();
  };
  return { op, obsRequests, relayCalls };
}
const count = (list, type) => list.filter((t) => t === type).length;

test('a viewer leaving keeps the stream for the others; the last viewer leaving stops it', { timeout: 30000 }, async (t) => {
  const agent = await startAgent(t);
  const kiosk = await agent.op('preview_start', { viewer: VIEWER_KIOSK, cloudflare: CF });
  assert.equal(kiosk.ok, true);
  assert.equal(kiosk.stream_mode, 'cloudflare');
  assert.equal(count(agent.obsRequests, 'StartStream'), 1);
  const phone = await agent.op('preview_start', { viewer: VIEWER_PHONE, cloudflare: { ...CF, reuse: true } });
  assert.equal(phone.ok, true);
  assert.equal(count(agent.obsRequests, 'StartStream'), 1, 'the second viewer shares the running stream');

  const phoneLeaves = await agent.op('preview_stop', { viewer: VIEWER_PHONE });
  assert.deepEqual(phoneLeaves, { ok: true, preview: true, viewers: 1, camera: 1 });
  assert.equal(count(agent.obsRequests, 'StopStream'), 0, 'the kiosk keeps its picture');

  const kioskLeaves = await agent.op('preview_stop', { viewer: VIEWER_KIOSK });
  assert.equal(kioskLeaves.preview, false);
  assert.equal(count(agent.obsRequests, 'StopStream'), 1, 'no viewer left: the stream stops');
  assert.ok(agent.obsRequests.includes('RemoveScene'), 'the preview overlay is removed');
});

test('a stop with no viewer id (an older Worker) still stops the shared stream at once', { timeout: 30000 }, async (t) => {
  const agent = await startAgent(t);
  await agent.op('preview_start', { cloudflare: CF });
  await agent.op('preview_start', { viewer: VIEWER_PHONE, cloudflare: { ...CF, reuse: true } });
  const stopped = await agent.op('preview_stop', {});
  assert.equal(stopped.preview, false);
  assert.equal(count(agent.obsRequests, 'StopStream'), 1);
  // A malformed viewer id is the shared viewer too.
  await agent.op('preview_start', { viewer: 'not-hex', cloudflare: CF });
  const stoppedAgain = await agent.op('preview_stop', { viewer: 'NOT-HEX' });
  assert.equal(stoppedAgain.preview, false);
  assert.equal(count(agent.obsRequests, 'StopStream'), 2);
});

test('a stop for a viewer that never started does not keep a stream nobody watches', { timeout: 30000 }, async (t) => {
  const agent = await startAgent(t);
  await agent.op('preview_start', { viewer: VIEWER_KIOSK, cloudflare: CF });
  const stray = await agent.op('preview_stop', { viewer: VIEWER_PHONE });
  assert.deepEqual(stray, { ok: true, preview: true, viewers: 1, camera: 1 }, 'the kiosk lease is untouched');
  const last = await agent.op('preview_stop', { viewer: VIEWER_KIOSK });
  assert.equal(last.preview, false);
  assert.equal(count(agent.obsRequests, 'StopStream'), 1);
});
