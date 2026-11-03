'use strict';

// S5 L0 (Build 46, ships dark): with `local` in preview_start (the Worker's
// LOCAL_PREVIEW_ROOMS), OBS publishes the preview to the room's relay (MediaMTX) and
// the relay forwards it to Cloudflare. Without `local` nothing changes. Any relay
// failure falls back to publishing straight to Cloudflare. Recording is not touched.

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

// OBS for the preview path. options.relayNeverActive: a publish to the relay never
// becomes an active output (the relay refused it).
function createFakeObs(requests, options = {}) {
  let streaming = false;
  let server = '';
  let nextItem = 10;
  const sockets = new Set();
  const obs = net.createServer((socket) => {
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
        const data = packet.d.requestData || {};
        requests.push({ type, data });
        let reply = {};
        if (type === 'GetStreamStatus') reply = { outputActive: streaming };
        else if (type === 'GetCurrentProgramScene') reply = { currentProgramSceneName: 'Studio' };
        else if (type === 'GetVideoSettings') reply = { baseWidth: 1920, baseHeight: 1080 };
        else if (type === 'CreateSceneItem') reply = { sceneItemId: nextItem++ };
        else if (type === 'GetSceneList') reply = { scenes: [] };
        else if (type === 'SetStreamServiceSettings') server = String((data.streamServiceSettings || {}).server || '');
        else if (type === 'StartStream') streaming = !(options.relayNeverActive && server.includes('preview-bench1'));
        else if (type === 'StopStream') streaming = false;
        socket.write(frame({ op: 7, d: { requestType: type, requestId: packet.d.requestId, requestStatus: { result: true, code: 100 }, responseData: reply } }));
      }
    });
  });
  obs._testSockets = sockets;
  return obs;
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

const KEY = 'a'.repeat(32);
const CF = {
  inputUid: KEY,
  publishUrl: 'https://customer-test.cloudflarestream.com/' + KEY + 'SECRETKEY/webRTC/publish',
  playbackUrl: 'https://customer-test.cloudflarestream.com/' + KEY + '/webRTC/play',
};
const LOCAL = { whipUrl: 'https://preview-bench1.evrybdystudios.com:8889/bench-1/whip', publishToken: 'pv1.publish.bench-1.9999999999.' + 'f'.repeat(64) };

async function startAgent(t, { obs: obsOptions = {}, relayStatus = 200, relayDown = false } = {}) {
  const obsRequests = [];
  const obs = createFakeObs(obsRequests, obsOptions);
  const obsPort = await listen(obs);
  t.after(() => close(obs));
  const relayCalls = [];
  const relayApi = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    relayCalls.push({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString('utf8') });
    res.statusCode = relayStatus;
    res.end('{}');
  });
  const relayPort = await listen(relayApi);
  t.after(() => close(relayApi));
  if (relayDown) await close(relayApi);
  const relay = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, command: null })); });
  const pollPort = await listen(relay);
  t.after(() => close(relay));
  const probe = http.createServer();
  const agentPort = await listen(probe);
  await close(probe);
  let output = '';
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      BUILDING_ID: 'bench-1', RECORD_CONTROL_KEY: 'fake-test-key', PORT: String(agentPort),
      RECORD_POLL_URL: `http://127.0.0.1:${pollPort}`, POLL_IDLE_INTERVAL_MS: '60000',
      OBS_WS_URL: `ws://127.0.0.1:${obsPort}`, OBS_SOURCES: 'cam1,cam2,cam3', MASTER_RECORD: '0',
      PREVIEW_RELAY_API: `http://127.0.0.1:${relayPort}`, PREVIEW_RELAY_START_CHECK_MS: '600',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (c) => { output += c.toString('utf8'); });
  child.stderr.on('data', (c) => { output += c.toString('utf8'); });
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
  return { op, obsRequests, relayCalls, output: () => output };
}
const serverSettings = (requests) => requests.filter((r) => r.type === 'SetStreamServiceSettings').map((r) => r.data.streamServiceSettings);
const types = (requests) => requests.map((r) => r.type);
const RECORDER_CALLS = ['StartRecord', 'StopRecord', 'PauseRecord', 'ResumeRecord', 'CallVendorRequest'];

test('flag off (no local): publishes straight to Cloudflare, never calls the relay, result unchanged', { timeout: 30000 }, async (t) => {
  const agent = await startAgent(t);
  const out = await agent.op('preview_start', { viewer: '0123456789abcdef', cloudflare: CF });
  assert.equal(out.ok, true);
  assert.equal(out.stream_mode, 'cloudflare');
  assert.equal('local_relay' in out, false);
  assert.equal('local_error' in out, false);
  assert.deepEqual(serverSettings(agent.obsRequests), [{ server: CF.publishUrl, bearer_token: '' }]);
  assert.equal(agent.relayCalls.length, 0);
  await agent.op('preview_stop', { viewer: '0123456789abcdef' });
  assert.equal(agent.relayCalls.length, 0);
  assert.equal(types(agent.obsRequests).some((x) => RECORDER_CALLS.includes(x)), false);
});

test('flag on, relay up: the relay forwards to Cloudflare, OBS publishes to the relay, stop clears the forward', { timeout: 30000 }, async (t) => {
  const agent = await startAgent(t);
  const out = await agent.op('preview_start', { viewer: '0123456789abcdef', cloudflare: CF, local: LOCAL });
  assert.equal(out.ok, true);
  assert.equal(out.local_relay, true);
  assert.equal(out.stream.playbackUrl, CF.playbackUrl, 'phones keep the Cloudflare playback URL');
  assert.deepEqual(agent.relayCalls[0], {
    method: 'PATCH', url: '/v3/config/paths/patch/bench-1',
    body: JSON.stringify({ forward: [{ dest: 'whips://customer-test.cloudflarestream.com:443/' + KEY + 'SECRETKEY/webRTC/publish' }] }),
  });
  assert.deepEqual(serverSettings(agent.obsRequests), [{ server: LOCAL.whipUrl, bearer_token: LOCAL.publishToken }]);
  // A keepalive reuses the running stream and still reports the relay.
  const again = await agent.op('preview_start', { viewer: '0123456789abcdef', cloudflare: { ...CF, reuse: true }, local: LOCAL });
  assert.equal(again.local_relay, true);
  assert.equal(types(agent.obsRequests).filter((x) => x === 'StartStream').length, 1);
  const stopped = await agent.op('preview_stop', { viewer: '0123456789abcdef' });
  assert.equal(stopped.preview, false);
  assert.deepEqual(agent.relayCalls.slice(-1)[0], { method: 'PATCH', url: '/v3/config/paths/patch/bench-1', body: JSON.stringify({ forward: [] }) });
  assert.equal(types(agent.obsRequests).some((x) => RECORDER_CALLS.includes(x)), false, 'no recorder call');
  assert.equal(agent.output().includes('SECRETKEY'), false, 'the Cloudflare publish secret is never logged');
  assert.equal(agent.output().includes(LOCAL.publishToken), false, 'the publish pass is never logged');
});

test('flag on, relay unreachable: falls back to Cloudflare directly and says why', { timeout: 30000 }, async (t) => {
  const agent = await startAgent(t, { relayDown: true });
  const out = await agent.op('preview_start', { viewer: '0123456789abcdef', cloudflare: CF, local: LOCAL });
  assert.equal(out.ok, true);
  assert.equal(out.local_relay, false);
  assert.equal(out.local_error, 'relay_unreachable');
  assert.deepEqual(serverSettings(agent.obsRequests), [{ server: CF.publishUrl, bearer_token: '' }]);
});

test('flag on, relay API refuses: falls back to Cloudflare directly', { timeout: 30000 }, async (t) => {
  const agent = await startAgent(t, { relayStatus: 500 });
  const out = await agent.op('preview_start', { viewer: '0123456789abcdef', cloudflare: CF, local: LOCAL });
  assert.equal(out.local_relay, false);
  assert.equal(out.local_error, 'relay_unreachable');
  assert.deepEqual(serverSettings(agent.obsRequests), [{ server: CF.publishUrl, bearer_token: '' }]);
});

test('flag on, the relay never accepts the publish: OBS is stopped, the forward cleared, Cloudflare used directly', { timeout: 30000 }, async (t) => {
  const agent = await startAgent(t, { obs: { relayNeverActive: true } });
  const out = await agent.op('preview_start', { viewer: '0123456789abcdef', cloudflare: CF, local: LOCAL });
  assert.equal(out.ok, true);
  assert.equal(out.local_relay, false);
  assert.equal(out.local_error, 'relay_publish_failed');
  assert.deepEqual(serverSettings(agent.obsRequests), [
    { server: LOCAL.whipUrl, bearer_token: LOCAL.publishToken },
    { server: CF.publishUrl, bearer_token: '' },
  ]);
  assert.ok(types(agent.obsRequests).includes('StopStream'));
  assert.deepEqual(agent.relayCalls.map((c) => JSON.parse(c.body).forward.length), [1, 0]);
});

test('an invalid relay offer is ignored: Cloudflare directly, relay never called', { timeout: 30000 }, async (t) => {
  const agent = await startAgent(t);
  const out = await agent.op('preview_start', { viewer: '0123456789abcdef', cloudflare: CF, local: { whipUrl: 'http://10.0.0.5:8889/bench-1/whip', publishToken: 'x' } });
  assert.equal(out.local_relay, false);
  assert.equal(out.local_error, 'relay_config_invalid');
  assert.equal(agent.relayCalls.length, 0);
  assert.deepEqual(serverSettings(agent.obsRequests), [{ server: CF.publishUrl, bearer_token: '' }]);
});
