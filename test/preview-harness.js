'use strict';

// Shared fixtures for the preview tests (Nov 5 post-TF48 lane): a controllable fake OBS
// (scenes and scene items tracked, the stream output can be dropped, the recorder calls
// counted), a fake relay/Worker that serves queued commands and records what the agent
// posts, and a spawner for the real server.js. Not a test file (no .test.js suffix).

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

function frame(payload) {
  const text = Buffer.from(JSON.stringify(payload));
  if (text.length < 126) return Buffer.concat([Buffer.from([0x81, text.length]), text]);
  const header = Buffer.alloc(4);
  header[0] = 0x81; header[1] = 126; header.writeUInt16BE(text.length, 2);
  return Buffer.concat([header, text]);
}

/**
 * control: { streaming, failStatus (count of GetStreamStatus calls to refuse), reconnecting,
 *            recording flags are counted in requests }.
 * Everything else answers ok with empty data, like the existing preview tests' fake OBS.
 */
function createFakeObs(requests, control) {
  let nextItem = 10;
  const scenes = new Set();
  const itemEnabled = new Map(); // sceneItemId -> boolean
  const itemSource = new Map(); // sceneItemId -> sourceName
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
        const requestData = packet.d.requestData || {};
        requests.push({ type, data: requestData, at: Date.now() });
        let data = {};
        let result = true;
        if (type === 'GetStreamStatus') {
          if (control.failStatus > 0) { control.failStatus -= 1; result = false; }
          else data = { outputActive: !!control.streaming, outputReconnecting: !!control.reconnecting };
        } else if (type === 'GetStreamServiceSettings') data = { streamServiceType: 'whip_custom', streamServiceSettings: { server: control.lastServer || '' } };
        else if (type === 'SetStreamServiceSettings') control.lastServer = requestData.streamServiceSettings && requestData.streamServiceSettings.server;
        else if (type === 'GetCurrentProgramScene') data = { currentProgramSceneName: 'Studio' };
        else if (type === 'GetVideoSettings') data = { baseWidth: 1920, baseHeight: 1080 };
        else if (type === 'GetSceneList') data = { scenes: [...scenes].map((sceneName) => ({ sceneName })) };
        else if (type === 'CreateScene') scenes.add(requestData.sceneName);
        else if (type === 'RemoveScene') scenes.delete(requestData.sceneName);
        else if (type === 'CreateSceneItem') {
          const id = nextItem++;
          data = { sceneItemId: id };
          if (requestData.sourceName && !/^__ES_CF_PREVIEW_/.test(String(requestData.sourceName))) {
            itemEnabled.set(id, requestData.sceneItemEnabled !== false);
            itemSource.set(id, requestData.sourceName);
          }
        } else if (type === 'SetSceneItemEnabled') itemEnabled.set(requestData.sceneItemId, !!requestData.sceneItemEnabled);
        else if (type === 'StartStream') { if (control.rejectStart) result = false; else control.streaming = !control.refuseStart; }
        else if (type === 'StopStream') control.streaming = false;
        else if (type === 'CallVendorRequest') data = { responseData: { success: true } };
        socket.write(frame({ op: 7, d: { requestType: type, requestId: packet.d.requestId, requestStatus: { result, code: result ? 100 : 600 }, responseData: data } }));
      }
    });
  });
  server._testSockets = sockets;
  // Which camera sources are enabled in the preview overlay right now.
  server.enabledSources = () => [...itemEnabled].filter(([, on]) => on).map(([id]) => itemSource.get(id)).sort();
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
async function waitFor(check, timeoutMs = 8000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await check()) return; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error('timed out waiting for ' + label);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The relay/Worker the agent polls. enqueue(op, payload) queues a command the agent
 * claims on its next poll; `results` collects its mini_result posts, `cleanups` the
 * Cloudflare input cleanups it asked for, `heartbeats` the decoded heartbeat state.
 */
function createFakeWorker(config) {
  const queue = [];
  const results = [];
  const cleanups = [];
  const heartbeats = [];
  let nextId = 1;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET') {
      if (url.searchParams.get('want_sources') === '1') { res.end(JSON.stringify(config || { sources: [] })); return; }
      const encoded = url.searchParams.get('state');
      if (encoded) { try { heartbeats.push(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))); } catch (_) { /* ignore */ } }
      const next = queue.shift();
      res.end(JSON.stringify({ ok: true, command: next || null }));
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { /* ignore */ }
    if (body.mini_result) results.push({ ...body, receivedAt: Date.now() });
    else if (body.stream_cleanup) cleanups.push(body.input_uid);
    res.end(JSON.stringify({ ok: true }));
  });
  return {
    server,
    results,
    cleanups,
    heartbeats,
    enqueue(op, payload) { const id = 'cmd-' + (nextId++); queue.push({ id, op, payload: payload || {} }); return id; },
    resultFor(id) { return results.find((r) => r.id === id); },
  };
}

/**
 * Spawns the real server.js against a fake OBS and a fake Worker.
 * options: { env, obs (control seed), obsSources, worker (config), workerPort }.
 */
async function startAgent(t, options = {}) {
  const obsRequests = [];
  const obsControl = Object.assign({ streaming: false, failStatus: 0 }, options.obs || {});
  const obs = createFakeObs(obsRequests, obsControl);
  const obsPort = await listen(obs);
  t.after(() => close(obs));
  const worker = createFakeWorker(options.worker || { sources: [] });
  const workerPort = await listen(worker.server);
  t.after(() => close(worker.server));
  const probe = http.createServer();
  const agentPort = await listen(probe);
  await close(probe);
  const recordDir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-preview-test-'));
  t.after(() => fs.rmSync(recordDir, { recursive: true, force: true }));
  let output = '';
  const child = spawn(process.execPath, ['server.js'], {
    cwd: options.cwd || path.join(__dirname, '..'),
    env: {
      ...process.env,
      BUILDING_ID: 'bench-1', RECORD_CONTROL_KEY: 'fake-test-key', PORT: String(agentPort),
      RECORD_POLL_URL: `http://127.0.0.1:${workerPort}`, POLL_IDLE_INTERVAL_MS: '150', POLL_INTERVAL_MS: '100',
      OBS_WS_URL: `ws://127.0.0.1:${obsPort}`, OBS_SOURCES: options.obsSources || 'cam1,cam2,cam3', MASTER_RECORD: '0',
      OBS_RECORD_DIR: recordDir, AUDIO_CHECK: '0', UPLOAD_STATE_DIR: path.join(recordDir, 'state'),
      ...(options.env || {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (c) => { output += c.toString('utf8'); });
  child.stderr.on('data', (c) => { output += c.toString('utf8'); });
  t.after(async () => {
    if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
    if (child.exitCode === null) await new Promise((r) => child.once('exit', r));
  });
  await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${agentPort}/health`)).ok; } catch (_) { return false; } }, 10000, 'agent health');
  const op = async (name, body = {}) => {
    const response = await fetch(`http://127.0.0.1:${agentPort}/record/${name}`, {
      method: 'POST', headers: { Authorization: 'Bearer fake-test-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ building_id: 'bench-1', ...body }),
    });
    return response.json();
  };
  // Runs an op the way the room does: queued at the Worker, claimed by the agent's poll
  // (the HTTP route cannot carry preview_cam1..3: its path pattern has no digits).
  const poll = async (name, body = {}, timeoutMs = 10000) => {
    const cmdId = worker.enqueue(name, body);
    await waitFor(() => worker.resultFor(cmdId), timeoutMs, 'result of ' + name);
    return worker.resultFor(cmdId).result;
  };
  const health = async () => (await fetch(`http://127.0.0.1:${agentPort}/health`)).json();
  return { op, poll, health, obs, obsRequests, obsControl, worker, output: () => output, recordDir };
}

const count = (requests, type) => requests.filter((r) => (typeof r === 'string' ? r : r.type) === type).length;

const KEY = 'a'.repeat(32);
const CF = {
  inputUid: KEY,
  publishUrl: 'https://customer-test.cloudflarestream.com/' + KEY + 'SECRETKEY/webRTC/publish',
  playbackUrl: 'https://customer-test.cloudflarestream.com/' + KEY + '/webRTC/play',
};
const KEY2 = 'b'.repeat(32);
const CF2 = {
  inputUid: KEY2,
  publishUrl: 'https://customer-test.cloudflarestream.com/' + KEY2 + 'OTHERSECRET/webRTC/publish',
  playbackUrl: 'https://customer-test.cloudflarestream.com/' + KEY2 + '/webRTC/play',
};
const VIEWER_KIOSK = '0123456789abcdef';
const VIEWER_PHONE = 'fedcba9876543210';
const VIEWER_WEB = '00112233445566ff';

module.exports = { CF, CF2, KEY, KEY2, VIEWER_KIOSK, VIEWER_PHONE, VIEWER_WEB, close, count, createFakeObs, createFakeWorker, listen, sleep, startAgent, waitFor };
