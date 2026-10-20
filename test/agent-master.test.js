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

const SOURCE_RECORD_CAMERA = { capture_mode: 'source_record', fallback: false };
// Start result when no camera is configured for RTSP.
const SOURCE_RECORD_START = {
  ok: true, recording: true, feeds_writing: null, fallback_sources: [],
  cameras: { cam1: SOURCE_RECORD_CAMERA, cam2: SOURCE_RECORD_CAMERA, cam3: SOURCE_RECORD_CAMERA },
};

// Since 2026.10.20-1 start also carries the mic check (`audio`, warn only); the
// camera/session fields are compared without it, and audio is checked on its own.
function withoutAudio(result) {
  const out = Object.assign({}, result);
  assert.ok(out.audio && typeof out.audio.level === 'string', 'start carries the mic check');
  delete out.audio;
  return out;
}

// OBS writes a take's files during the take; the stop path ignores anything older.
function touchTakeFiles(recordDir) {
  const now = new Date();
  for (const dir of fs.readdirSync(recordDir)) {
    const full = path.join(recordDir, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const name of fs.readdirSync(full)) {
      if (name.endsWith('.mp4')) fs.utimesSync(path.join(full, name), now, now);
    }
  }
}

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

// The studio as OBS reports it to the mic check. options.audio (mutable, so a test
// can break and then fix it mid-run): meters: { 'Mic N': 'ok'|'zero'|'low'|'frozen'|
// 'absent'|'copy:Mic M' }, metersOff (no meter events at all), muted: { 'Mic N': true },
// trackOff: { 'Mic N': true } (its track N unticked), recTracks ('15' = tracks 1-4),
// evo (the EVO 8 in the device list), missing: ['Mic N'] (no such input).
const MICS = ['Mic 1', 'Mic 2', 'Mic 3', 'Mic 4'];
const METERS_BIT = 1 << 16;
const OUTPUTS_BIT = 1 << 6;
const EVO_DEVICE = 'AppleUSBAudioEngine:Audient:EVO8:2000000:1';

function healthyAudio() {
  return { meters: {}, metersOff: false, muted: {}, trackOff: {}, recTracks: '15', evo: true, missing: [] };
}

function meterInputs(audio, tick) {
  const levels = {};
  MICS.forEach((name, i) => {
    // Every mic moves on its own (distinct phase and depth): -60...-40 dBFS.
    const db = -50 + 10 * Math.sin(tick * (0.7 + i * 0.37) + i);
    const mag = Math.pow(10, db / 20);
    levels[name] = [[mag, mag * 1.8, mag * 1.8], [mag * 0.98, mag * 1.7, mag * 1.7]];
  });
  const out = [];
  for (const name of MICS) {
    const mode = (audio.meters && audio.meters[name]) || 'ok';
    if (mode === 'absent' || (audio.missing || []).includes(name)) continue;
    let channels = levels[name];
    if (mode === 'zero' || (audio.muted && audio.muted[name])) channels = [[0, 0, 0], [0, 0, 0]];
    else if (mode === 'low') channels = channels.map((ch) => ch.map((v) => v * 1e-3));
    else if (mode === 'frozen') channels = [[0.01, 0.02, 0.02], [0.01, 0.02, 0.02]];
    else if (mode.startsWith('copy:')) channels = levels[mode.slice(5)].map((ch) => ch.map((v) => v * 0.5));
    out.push({ inputName: name, inputLevelsMul: channels });
  }
  out.push({ inputName: 'Desktop Audio', inputLevelsMul: [[0, 0, 0], [0, 0, 0]] });
  return out;
}

function audioReply(type, data, audio) {
  const name = data && data.inputName;
  if (type === 'GetInputList') {
    return { inputs: MICS.filter((m) => !(audio.missing || []).includes(m)).map((inputName) => ({ inputName, inputKind: 'coreaudio_input_capture' })).concat([{ inputName: 'cam1', inputKind: 'ndi_source' }]) };
  }
  if (type === 'GetInputMute') return { inputMuted: !!(audio.muted && audio.muted[name]) };
  if (type === 'GetInputVolume') return { inputVolumeMul: 1, inputVolumeDb: 0 };
  if (type === 'GetInputAudioTracks') {
    const n = Number(String(name).slice(-1));
    const tracks = {};
    for (let i = 1; i <= 6; i += 1) tracks[String(i)] = i === n && !(audio.trackOff && audio.trackOff[name]);
    return { inputAudioTracks: tracks };
  }
  if (type === 'GetProfileParameter') {
    if (data.parameterCategory === 'Output' && data.parameterName === 'Mode') return { parameterValue: 'Advanced', defaultParameterValue: 'Simple' };
    if (data.parameterCategory === 'AdvOut' && data.parameterName === 'RecTracks') return { parameterValue: audio.recTracks, defaultParameterValue: '1' };
    return { parameterValue: null };
  }
  if (type === 'GetInputSettings') return { inputKind: 'coreaudio_input_capture', inputSettings: { device_id: audio.evo ? EVO_DEVICE : 'loopback-evo-1' } };
  if (type === 'GetInputPropertiesListPropertyItems') {
    const items = [{ itemName: 'Default', itemValue: 'default', itemEnabled: true }, { itemName: 'EVO Ch1', itemValue: 'loopback-evo-1', itemEnabled: true }];
    if (audio.evo) items.push({ itemName: 'EVO8', itemValue: EVO_DEVICE, itemEnabled: true });
    return { propertyItems: items };
  }
  return null;
}

function createFakeObs(requests, options = {}) {
  const sockets = new Set();
  let outputActive = !!options.outputActive;
  if (!options.audio) options.audio = healthyAudio();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let subs = 0;
    let meterTimer = null;
    let tick = 0;
    socket.on('close', () => { sockets.delete(socket); clearInterval(meterTimer); });
    socket.on('error', () => clearInterval(meterTimer));
    socket.esEvent = (eventType, eventData, bit) => {
      if ((subs & bit) && !socket.destroyed) socket.write(frame({ op: 5, d: { eventType, eventIntent: bit, eventData } }));
    };
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
        const opcode = buffer[0] & 0x0f;
        buffer = buffer.subarray(offset + size);
        // A client closing its socket (the mic check's short-lived client does) sends a close frame.
        if (opcode === 0x8) { clearInterval(meterTimer); socket.end(); return; }
        if (opcode !== 0x1) continue;
        const packet = JSON.parse(body.toString('utf8'));
        if (packet.op === 1) {
          subs = Number(packet.d && packet.d.eventSubscriptions) || 0;
          socket.write(frame({ op: 2, d: { negotiatedRpcVersion: 1 } }));
          if (subs & METERS_BIT) {
            meterTimer = setInterval(() => {
              tick += 1;
              if (!options.audio.metersOff) socket.esEvent('InputVolumeMeters', { inputs: meterInputs(options.audio, tick) }, METERS_BIT);
            }, 50);
          }
          continue;
        }
        if (packet.op !== 6) continue;
        // The mic check's own client (meter subscription) is logged apart, so the
        // shared client's request sequences stay exactly as before.
        const log = (subs & METERS_BIT) ? (options.audioRequests || []) : requests;
        log.push({ type: packet.d.requestType, data: packet.d.requestData || {} });
        let reply = { result: true, responseData: {} };
        const audioData = audioReply(packet.d.requestType, packet.d.requestData || {}, options.audio);
        if (audioData) reply.responseData = audioData;
        if (packet.d.requestType === 'CallVendorRequest') {
          reply.responseData = { responseData: { success: true } };
        } else if (packet.d.requestType === 'GetRecordStatus') {
          reply.responseData = { outputActive };
        } else if (packet.d.requestType === 'StartRecord' && options.startRecordFails) {
          reply = { result: false, comment: 'start_record_rejected', responseData: {} };
        } else if (packet.d.requestType === 'StartRecord') {
          outputActive = true;
          // Like OBS: the output STARTED event follows the request, to Outputs subscribers.
          setTimeout(() => { for (const s2 of sockets) s2.esEvent('RecordStateChanged', { outputActive: true, outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED', outputPath: null }, OUTPUTS_BIT); }, options.recordStartedDelayMs || 15);
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
  server.esOptions = options;
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
    const url = new URL(req.url, 'http://127.0.0.1');
    relayRequests.push(url);
    // options.relay(req, url) may answer instead: { status?, body }.
    const custom = typeof options.relay === 'function' ? options.relay(req, url) : null;
    res.statusCode = (custom && custom.status) || 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(custom ? custom.body : (options.relayResponse || { command: null })));
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
      FFPROBE_BIN: path.join(__dirname, 'fake-ffprobe.js'),
      // Tests read the take files after stop; the deletion test turns this back on.
      DELETE_AFTER_UPLOAD: '0',
      ...(options.env || {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  child.stdout.resume();
  t.after(async () => {
    if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
    if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve));
  });
  await waitFor(async () => {
    try { return (await fetch(`http://127.0.0.1:${agentPort}/health`)).ok; } catch (_) { return false; }
  }, 10000);
  return { agentPort, obsRequests, relayRequests, recordDir, stderr: () => stderr, obsOptions: obsServer.esOptions };
}

test('heartbeat is sent from cached state on the first poll only once per minute and old poll responses still work', { timeout: 8000 }, async (t) => {
  const agent = await startAgent(t);
  await waitFor(() => agent.relayRequests.filter((url) => !url.searchParams.has('want_sources')).length >= 2);
  const polls = agent.relayRequests.filter((url) => !url.searchParams.has('want_sources'));
  const [first, second] = polls;

  assert.equal(first.searchParams.get('hb'), '1');
  assert.equal(first.searchParams.get('v'), '2026.10.20-1');
  assert.equal(first.searchParams.get('c'), 'unknown');
  const heartbeatState = JSON.parse(Buffer.from(first.searchParams.get('state'), 'base64url').toString('utf8'));
  assert.deepEqual(heartbeatState, {
    recording: false, paused: false, feeds_writing: 0, uploads: 0, master_active: false,
    cameras_down: [], cameras_checked_at: null,
    disk_free_bytes: heartbeatState.disk_free_bytes,
    disk_total_bytes: heartbeatState.disk_total_bytes,
    disk_checked_at: heartbeatState.disk_checked_at,
    power: null,
    // The first mic check runs 2 s after boot, after this first heartbeat.
    audio: null,
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

// Kiosk taps wait for the next command poll (testers: Record/Stop took 3-5 s before 2026.10.03-1).
test('the relay is polled every 250 ms once a command came in and every 1 s when idle; the heartbeat stays once a minute', { timeout: 15000 }, async (t) => {
  const polls = [];
  let posted = 0;
  await startAgent(t, {
    relay(req, url) {
      if (req.method === 'POST') {
        posted += 1;
        return { body: { ok: true } };
      }
      if (url.searchParams.has('want_sources')) return null;
      polls.push({ at: Date.now(), url });
      // The third poll claims a status command, like a kiosk tap.
      if (polls.length === 3) return { body: { ok: true, command: { id: 'cmd-1', op: 'status' } } };
      return { body: { ok: true, command: null } };
    },
  });
  await waitFor(() => posted === 1, 6000);
  await waitFor(() => polls.length >= 8, 4000);
  const gaps = polls.slice(1).map((p, i) => p.at - polls[i].at);
  for (const gap of gaps.slice(0, 2)) assert.ok(gap >= 900 && gap < 1600, 'idle poll gap ' + gap + ' ms');
  for (const gap of gaps.slice(3, 7)) assert.ok(gap >= 150 && gap < 600, 'in-use poll gap ' + gap + ' ms');
  assert.deepEqual(polls.map((p) => p.url.searchParams.get('hb')).slice(0, 8), ['1', null, null, null, null, null, null, null]);
});

test('a failing relay is retried after 1 s then 2 s, never at the fast interval, and polls fast again once it answers', { timeout: 15000 }, async (t) => {
  const polls = [];
  const agent = await startAgent(t, {
    env: { POLL_INTERVAL_MS: '100', POLL_IDLE_INTERVAL_MS: '100' },
    relay(req, url) {
      if (req.method !== 'GET' || url.searchParams.has('want_sources')) return null;
      polls.push(Date.now());
      return polls.length <= 2 ? { status: 503, body: { ok: false } } : { body: { ok: true, command: null } };
    },
  });
  await waitFor(() => polls.length >= 7, 8000);
  const gaps = polls.slice(1).map((at, i) => at - polls[i]);
  assert.ok(gaps[0] >= 900 && gaps[0] < 1600, 'after the first failure: ' + gaps[0] + ' ms');
  assert.ok(gaps[1] >= 1900 && gaps[1] < 2600, 'after the second failure: ' + gaps[1] + ' ms');
  for (const gap of gaps.slice(2, 6)) assert.ok(gap < 500, 'recovered poll gap ' + gap + ' ms');
  assert.equal((agent.stderr().match(/relay: poll GET 503/g) || []).length, 2);
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
  const smokeRecordDir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-mini-smoke-'));
  t.after(() => fs.rmSync(smokeRecordDir, { recursive: true, force: true }));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: require('node:path').join(__dirname, '..'),
    env: {
      ...process.env,
      BUILDING_ID: 'bench-1', RECORD_CONTROL_KEY: 'fake-test-key', PORT: String(agentPort),
      RECORD_POLL_URL: `http://127.0.0.1:${relayPort}`,
      OBS_WS_URL: `ws://127.0.0.1:${obsPort}`, OBS_SOURCES: 'cam1,cam2,cam3',
      // Its own dir: the agent's boot cleanup kills RTSP captures under OBS_RECORD_DIR,
      // which for the whole tmpdir includes other test files' captures.
      OBS_RECORD_DIR: smokeRecordDir, MASTER_RECORD: '0',
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
  assert.deepEqual(withoutAudio(await postAgent(agentPort, 'start')), SOURCE_RECORD_START);
  await waitFor(() => obsRequests.length === 3);
  assert.deepEqual(obsRequests.map((request) => request.data.requestData), [
    { source: 'cam1' }, { source: 'cam2' }, { source: 'cam3' },
  ]);
});

test('master start follows three camera starts', { timeout: 8000 }, async (t) => {
  const agent = await startAgent(t);
  assert.deepEqual(withoutAudio(await postAgent(agent.agentPort, 'start')), SOURCE_RECORD_START);
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
  touchTakeFiles(recordDir);
  const result = await postAgent(agent.agentPort, 'stop');
  assert.equal(result.saved, true);
  assert.equal(result.health, 'ok');
  assert.equal(result.upload_queued, 4);
  assert.deepEqual(result.files, ['cam1', 'cam2', 'cam3'].map((source) => ({ source, size_bytes: CAMERA_FILE_BYTES.length, ok: true, health: 'ok' })));
  assert.deepEqual(result.failed_files, []);
  assert.deepEqual(result.fallback_sources, []);
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
  assert.deepEqual(withoutAudio(await postAgent(agent.agentPort, 'start')), SOURCE_RECORD_START);
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
  // Webhook kind is "video" for camera/master/watch files and "audio" for mic/mix (Build 42 contract; was "recording").
  assert.deepEqual(uploads[0].webhookExtra, { kind: 'video', building_id: 'bench-1', source: 'master', session_ref: null });
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
  touchTakeFiles(recordDir);
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
  await waitFor(() => uploads.length === 6, 18000);
  await waitFor(() => queue.status().active === null && queue.status().queued === 0, 2000);
  // Since 2026.10.20-1 the take's mix also uploads, under audio/<building>/ (Build 42 contract).
  assert.deepEqual(uploads.map((input) => input.key).sort(), [
    'audio/bench-1/master-mix.m4a',
    'recordings/bench-1/audio/master-mic1.m4a', 'recordings/bench-1/audio/master-mic2.m4a',
    'recordings/bench-1/audio/master-mic3.m4a', 'recordings/bench-1/audio/master-mic4.m4a',
    'recordings/bench-1/master/master.mp4',
  ]);
  assert.deepEqual(uploads.filter((input) => input.webhookExtra.kind === 'audio').map((input) => input.webhookExtra.session_ref), ['session_123', 'session_123', 'session_123', 'session_123', 'session_123']);
  assert.deepEqual(uploads.filter((input) => input.webhookExtra.kind === 'audio').map((input) => [input.webhookExtra.source, input.webhookExtra.rendition]).sort(),
    [['mic1', 'mic'], ['mic2', 'mic'], ['mic3', 'mic'], ['mic4', 'mic'], ['mix', 'mix']]);
  assert.equal(fs.existsSync(path.join(tempDir, 'master-mix.m4a')), false, 'the mix file leaves the Mini once uploaded');
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
  await waitFor(() => uploads.length === 4 && queue.status().active === null && queue.status().queued === 0, 8000);
  assert.deepEqual(uploads.map((input) => input.key).sort(), [
    'audio/bench-1/master-two-stream-mix.m4a',
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
      S3_ACCESS_KEY_ID: 'fake-access-key', S3_SECRET_ACCESS_KEY: 'fake-secret-key',
      S3_BUCKET: 'fake-bucket', S3_ENDPOINT: `http://127.0.0.1:${r2Port}`,
      ...(extraEnv || {}),
    },
  });
  // Registered after startAgent so it runs once the agent (and its proxy ffmpeg) has stopped.
  t.after(() => fs.rmSync(recordDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await waitFor(() => agent.relayRequests.some((url) => url.searchParams.has('want_sources')));
  await new Promise((resolve) => setTimeout(resolve, 200)); // camera config applied
  return Object.assign(agent, { uploads, recordDir });
}

const vendorCalls = (agent, requestType) => agent.obsRequests
  .filter((r) => r.type === 'CallVendorRequest' && r.data.requestType === requestType)
  .map((r) => r.data.requestData && r.data.requestData.source || r.data.requestData);

test('an RTSP camera skips Source Record and its file is named after the master and uploaded', { timeout: 30000 }, async (t) => {
  const agent = await startRtspAgent(t);
  const started = await postAgent(agent.agentPort, 'start');
  assert.deepEqual(started.cameras, { cam1: { capture_mode: 'rtsp', fallback: false }, cam2: SOURCE_RECORD_CAMERA, cam3: SOURCE_RECORD_CAMERA });
  assert.deepEqual(started.fallback_sources, []);
  assert.equal(vendorCalls(agent, 'record_start').length, 2, 'Source Record started for cam2 and cam3 only');
  touchTakeFiles(agent.recordDir);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const status = await postAgent(agent.agentPort, 'status');
  assert.equal(status.rtsp.cam1.writing, true);
  // The RTSP camera counts as writing (it used to be missed, so the kiosk showed "Camera failed").
  assert.equal(status.feeds_writing, 3);
  assert.equal(status.cameras.cam1.writing, true);
  assert.equal(status.cameras.cam1.capture_mode, 'rtsp');
  const result = await postAgent(agent.agentPort, 'stop');
  assert.equal(result.saved, true);
  assert.equal(result.health, 'ok');
  assert.equal(result.upload_queued, 4);
  assert.deepEqual(result.files.map((f) => [f.source, f.ok]), [['cam1', true], ['cam2', true], ['cam3', true]]);
  assert.ok(result.files[0].size_bytes > 64 * 1024);
  assert.deepEqual(result.failed_files, []);
  assert.equal(result.cameras.cam1.capture_mode, 'rtsp');
  assert.equal(result.cameras.cam1.reconnects, 0);
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

test('an RTSP camera that cannot connect falls back to Source Record loudly, in the log, start, status, stop and webhook', { timeout: 30000 }, async (t) => {
  const webhookBodies = [];
  const webhookServer = createFakeWebhook(webhookBodies);
  const webhookPort = await listen(webhookServer);
  t.after(() => close(webhookServer));
  const agent = await startRtspAgent(t, { FAKE_RTSP_FAIL: '1', UPLOAD_CONFIRMED_WEBHOOK_URL: `http://127.0.0.1:${webhookPort}` });
  const started = await postAgent(agent.agentPort, 'start', { session_ref: 'session_fb' });
  assert.equal(vendorCalls(agent, 'record_start').length, 3, 'cam1 recorded by Source Record after RTSP failed');
  assert.deepEqual(started.fallback_sources, ['cam1']);
  assert.deepEqual(started.cameras.cam1, { capture_mode: 'source_record', fallback: true, fallback_reason: 'rtsp_start_failed' });
  assert.match(agent.stderr(), /WARN FALLBACK cam1 is configured for RTSP but is recording with OBS Source Record this take: reason=rtsp_start_failed detail=ffmpeg exited code=1: .*Connection refused/);
  const status = await postAgent(agent.agentPort, 'status');
  assert.equal(status.rtsp, undefined);
  assert.deepEqual(status.fallback_sources, ['cam1']);
  assert.equal(status.cameras.cam1.fallback, true);
  // What Source Record writes for cam1 this take.
  fs.writeFileSync(path.join(agent.recordDir, 'cam1', TAKE + '.mp4'), CAMERA_FILE_BYTES);
  touchTakeFiles(agent.recordDir);
  const result = await postAgent(agent.agentPort, 'stop');
  assert.equal(vendorCalls(agent, 'record_stop').length, 3);
  // The footage is fine, so the kiosk says Saved; the fallback is still reported for the booking thread.
  assert.equal(result.saved, true);
  assert.deepEqual(result.fallback_sources, ['cam1']);
  assert.equal(result.cameras.cam1.fallback, true);
  assert.equal(result.cameras.cam1.fallback_reason, 'rtsp_start_failed');
  assert.match(agent.stderr(), /\[take\] WARN .* health=ok saved=true FALLBACK=cam1 \| cam1 ok source_record\(FALLBACK rtsp_start_failed\)/);
  await waitFor(() => webhookBodies.some((b) => b.source === 'cam1'), 20000);
  const cam1 = webhookBodies.find((b) => b.source === 'cam1');
  assert.equal(cam1.capture_mode, 'source_record');
  assert.equal(cam1.fallback, true);
  assert.equal(cam1.fallback_reason, 'rtsp_start_failed');
  assert.deepEqual(cam1.fallback_sources, ['cam1']);
  assert.equal(cam1.session_ref, 'session_fb');
});

test('stop reports files and failed_files from the file check: a zero-stream stub fails, a short camera is incomplete', { timeout: 30000 }, async (t) => {
  const webhookBodies = [];
  const webhookServer = createFakeWebhook(webhookBodies);
  const webhookPort = await listen(webhookServer);
  t.after(() => close(webhookServer));
  const agent = await startRtspAgent(t, { UPLOAD_CONFIRMED_WEBHOOK_URL: `http://127.0.0.1:${webhookPort}` });
  await postAgent(agent.agentPort, 'start');
  const dir = (source) => path.join(agent.recordDir, source, TAKE + '.mp4');
  fs.writeFileSync(dir('cam2'), Buffer.alloc(1737, 1)); // Source Record's silent stub (#10)
  fs.writeFileSync(dir('cam3') + '.probe.json', JSON.stringify({ streams: [{ codec_type: 'video', duration: '20.0' }], format: { duration: '20.0' } }));
  fs.writeFileSync(dir('master') + '.probe.json', JSON.stringify({ streams: [{ codec_type: 'video', duration: '30.0' }, { codec_type: 'audio' }], format: { duration: '30.0' } }));
  touchTakeFiles(agent.recordDir);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const result = await postAgent(agent.agentPort, 'stop');
  assert.equal(result.saved, false);
  assert.equal(result.health, 'failed');
  assert.deepEqual(result.failed_files, [{ source: 'cam2', size_bytes: 1737, reason: 'too_small' }]);
  assert.deepEqual(result.files.find((f) => f.source === 'cam2'), { source: 'cam2', size_bytes: 1737, ok: false, health: 'failed' });
  assert.equal(result.cameras.cam3.health, 'short');
  assert.equal(result.cameras.cam3.short_by_s, 10);
  assert.equal(result.files.find((f) => f.source === 'cam3').ok, true);
  assert.equal(result.master.duration_s, 30);
  // RTSP cam1 is ~0.3 s of fake video against a 30 s master: also short, but it has video.
  assert.equal(result.cameras.cam1.health, 'short');
  const idle = await postAgent(agent.agentPort, 'status');
  assert.equal(idle.last_take.health, 'failed');
  assert.deepEqual(idle.last_take.failed_files, result.failed_files);
  await waitFor(() => ['cam2', 'cam3'].every((source) => webhookBodies.some((b) => b.source === source)), 20000);
  assert.equal(webhookBodies.find((b) => b.source === 'cam2').sizeBytes, 0, 'the stub is reported as a failed recording');
  const cam3 = webhookBodies.find((b) => b.source === 'cam3');
  assert.equal(cam3.health, 'short');
  assert.equal(cam3.health_reason, 'shorter_than_master');
  assert.equal(cam3.take_health, 'failed');
  assert.deepEqual(cam3.failed_sources, ['cam2']);
});

test('a Source Record camera that wrote nothing this take is reported, not silently dropped', { timeout: 30000 }, async (t) => {
  const webhookBodies = [];
  const webhookServer = createFakeWebhook(webhookBodies);
  const webhookPort = await listen(webhookServer);
  t.after(() => close(webhookServer));
  const agent = await startRtspAgent(t, { UPLOAD_CONFIRMED_WEBHOOK_URL: `http://127.0.0.1:${webhookPort}` });
  await postAgent(agent.agentPort, 'start');
  // cam3's only file is the previous take's: older than this take's start.
  touchTakeFiles(agent.recordDir);
  const old = new Date(Date.now() - 120000);
  fs.utimesSync(path.join(agent.recordDir, 'cam3', TAKE + '.mp4'), old, old);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const result = await postAgent(agent.agentPort, 'stop');
  assert.equal(result.saved, false);
  assert.deepEqual(result.failed_files, [{ source: 'cam3', size_bytes: 0, reason: 'no_file' }]);
  assert.equal(result.files.some((f) => f.source === 'cam3'), false);
  await waitFor(() => webhookBodies.some((b) => b.source === 'cam3'), 10000);
  const cam3 = webhookBodies.find((b) => b.source === 'cam3');
  assert.equal(cam3.sizeBytes, 0);
  assert.equal(cam3.key, `recordings/bench-1/cam3/${TAKE}.mp4`);
  assert.equal(cam3.health, 'missing');
});

test('pause and resume on an RTSP take pause ffmpeg, not Source Record, for that camera', { timeout: 15000 }, async (t) => {
  const agent = await startRtspAgent(t);
  await postAgent(agent.agentPort, 'start');
  touchTakeFiles(agent.recordDir);
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

test('a normal pause on an RTSP take logs no WARN: resume latency is resume_wait_s, not lost_s', { timeout: 30000 }, async (t) => {
  const webhookBodies = [];
  const webhookServer = createFakeWebhook(webhookBodies);
  const webhookPort = await listen(webhookServer);
  t.after(() => close(webhookServer));
  const agent = await startRtspAgent(t, { FAKE_RTSP_VIDEO_DELAY_MS: '1100', UPLOAD_CONFIRMED_WEBHOOK_URL: `http://127.0.0.1:${webhookPort}` });
  await postAgent(agent.agentPort, 'start');
  touchTakeFiles(agent.recordDir);
  await new Promise((resolve) => setTimeout(resolve, 200));
  await postAgent(agent.agentPort, 'pause');
  await postAgent(agent.agentPort, 'resume');
  await new Promise((resolve) => setTimeout(resolve, 1600));
  const result = await postAgent(agent.agentPort, 'stop');
  assert.equal(result.health, 'ok');
  assert.equal(result.saved, true);
  assert.equal(result.cameras.cam1.lost_s, 0);
  assert.ok(result.cameras.cam1.resume_wait_s >= 1 && result.cameras.cam1.resume_wait_s < 2.5, 'resume wait reported: ' + result.cameras.cam1.resume_wait_s);
  assert.doesNotMatch(agent.stderr(), /WARN/);
  await waitFor(() => webhookBodies.some((b) => b.source === 'cam1'), 20000);
  const cam1 = webhookBodies.find((b) => b.source === 'cam1');
  assert.equal(cam1.lost_s, 0);
  assert.equal(cam1.resume_wait_s, result.cameras.cam1.resume_wait_s);
});

test('a forced RTSP outage mid-take still WARNs and is reported as lost_s', { timeout: 30000 }, async (t) => {
  const marker = path.join(os.tmpdir(), 'es-mini-agent-drop-' + process.pid + '-' + Date.now());
  t.after(() => fs.rmSync(marker, { force: true }));
  const agent = await startRtspAgent(t, { FAKE_RTSP_DROP_ONCE: marker });
  await postAgent(agent.agentPort, 'start');
  touchTakeFiles(agent.recordDir);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const result = await postAgent(agent.agentPort, 'stop');
  assert.equal(result.cameras.cam1.reconnects, 1);
  assert.ok(result.cameras.cam1.lost_s > 0, 'outage counted: ' + result.cameras.cam1.lost_s);
  assert.equal(result.cameras.cam1.resume_wait_s, 0);
  assert.match(agent.stderr(), /\[rtsp\] WARN cam1 ffmpeg exited mid-take/);
  assert.match(agent.stderr(), /\[rtsp\] WARN cam1 saved .* reconnects=1 lost=\d\.\d s/);
});

test('stop with only RTSP cameras and no master skips the OBS file settle wait', { timeout: 30000 }, async (t) => {
  const recordDir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-mini-rtsp-only-'));
  for (const source of ['cam1', 'cam2', 'cam3']) fs.mkdirSync(path.join(recordDir, source), { recursive: true });
  const agent = await startAgent(t, {
    recordDir,
    masterRecord: false,
    relayResponse: {
      command: null,
      cameras: ['cam1', 'cam2', 'cam3'].map((name, i) => ({ name, host: '127.0.0.' + (i + 1), capture: 'rtsp' })),
    },
    // Waiting would take at least 4 s, so a quick stop proves it was skipped.
    env: { FFMPEG_BIN: FAKE_RTSP_FFMPEG, STOP_SETTLE_MS: '4000' },
  });
  t.after(() => fs.rmSync(recordDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await waitFor(() => agent.relayRequests.some((url) => url.searchParams.has('want_sources')));
  await new Promise((resolve) => setTimeout(resolve, 200)); // camera config applied
  const started = await postAgent(agent.agentPort, 'start');
  assert.deepEqual(Object.values(started.cameras).map((c) => c.capture_mode), ['rtsp', 'rtsp', 'rtsp']);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const stopStarted = Date.now();
  const result = await postAgent(agent.agentPort, 'stop');
  const stopMs = Date.now() - stopStarted;
  assert.ok(stopMs < 3000, 'stop took ' + stopMs + ' ms');
  assert.equal(result.saved, true);
  assert.equal(result.health, 'ok');
  assert.equal(vendorCalls(agent, 'record_stop').length, 0);
  assert.equal(agent.obsRequests.filter((r) => r.type === 'StopRecord').length, 0);
});

test('stop still waits for OBS to finish writing when the master was recording', { timeout: 30000 }, async (t) => {
  const agent = await startRtspAgent(t, { STOP_SETTLE_MS: '1500' });
  await postAgent(agent.agentPort, 'start');
  touchTakeFiles(agent.recordDir);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const stopStarted = Date.now();
  const result = await postAgent(agent.agentPort, 'stop');
  const stopMs = Date.now() - stopStarted;
  assert.ok(stopMs >= 1500, 'stop took ' + stopMs + ' ms');
  assert.equal(result.saved, true);
});

test('DELETE_AFTER_UPLOAD: camera and master originals leave the Mini only after a verified upload and their proxy', { timeout: 12000 }, async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-mini-delete-after-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const camPath = path.join(tempDir, 'cam1.mp4');
  const masterPath = path.join(tempDir, 'master.mp4');
  const keptPath = path.join(tempDir, 'cam2.mp4');
  for (const p of [camPath, masterPath, keptPath]) fs.writeFileSync(p, CAMERA_FILE_BYTES);
  const uploads = [];
  let failNext = false;
  const previousFfmpeg = process.env.FFMPEG_BIN;
  const previousFfprobe = process.env.FFPROBE_BIN;
  process.env.FFMPEG_BIN = path.join(__dirname, 'fake-ffmpeg.js');
  process.env.FFPROBE_BIN = path.join(__dirname, 'fake-ffmpeg.js');
  t.after(() => { restoreEnv('FFMPEG_BIN', previousFfmpeg); restoreEnv('FFPROBE_BIN', previousFfprobe); });
  const queue = createUploadQueue({
    stateDir: path.join(tempDir, 'state'), buildingId: 'bench-1', deleteAfterUpload: true, audioSplit: false, stabilityPollMs: 5,
    uploader: async (input) => {
      if (failNext) { failNext = false; throw new Error('HeadObject size mismatch'); }
      uploads.push(input);
      return { key: input.key, sizeBytes: input.sizeBytes, partsUploaded: 1 };
    },
  });
  queue.enqueue({ filePath: camPath, source: 'cam1' });
  queue.enqueue({ filePath: masterPath, source: 'master' });
  await waitFor(() => !fs.existsSync(camPath) && !fs.existsSync(masterPath), 10000);
  assert.ok(uploads.some((u) => u.key === 'proxies/bench-1/cam1/cam1.mp4'), 'proxy made from the original before it was removed');
  failNext = true;
  queue.enqueue({ filePath: keptPath, source: 'cam2' });
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.ok(fs.existsSync(keptPath), 'a failed upload keeps the file');
});

// ---------- Build 42: mic check (A1), post-take audio health (A3), timing + watch copies (B1-B3) ----------

// 700 ms of meters (14 frames: enough to tell two mics carry one signal), in-take every 0.4 s.
const FAST_AUDIO = { AUDIO_METER_WINDOW_MS: '700', AUDIO_TAKE_EVAL_MS: '400' };

test('post-take audio: a pending Stop later becomes Mic 1 silent on status for the same take', { timeout: 20000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-mini-late-audio-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const master = path.join(dir, 'master', 'master.mp4');
  for (const source of ['cam1', 'cam2', 'cam3', 'master']) {
    fs.mkdirSync(path.join(dir, source), { recursive: true });
    fs.writeFileSync(path.join(dir, source, source === 'master' ? 'master.mp4' : source + '.mp4'), CAMERA_FILE_BYTES);
  }
  const gate = path.join(dir, 'finish-analysis');
  const probe = path.join(dir, 'ffprobe');
  const decoder = path.join(dir, 'ffmpeg');
  fs.writeFileSync(probe, '#!' + process.execPath + '\n' +
    `if(process.argv.includes('-select_streams')) process.stdout.write(JSON.stringify({streams:[{index:0}]})); else require(${JSON.stringify(path.join(__dirname, 'fake-ffprobe.js'))});\n`, { mode: 0o755 });
  // Complete only when the test releases it, so Stop is deterministically pending.
  fs.writeFileSync(decoder, '#!' + process.execPath + '\n' +
    `const fs=require('node:fs'); const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(gate)})){clearInterval(t);process.stdout.write(Buffer.alloc(48000*2*4));}},20);\n`, { mode: 0o755 });
  const agent = await startAgent(t, { recordDir: dir, obs: { masterOutputPath: master },
    env: { ...FAST_AUDIO, FFPROBE_BIN: probe, FFMPEG_BIN: decoder, AUDIO_HEALTH_WAIT_MS: '25', STOP_SETTLE_MS: '25' } });
  assert.equal((await postAgent(agent.agentPort, 'start')).recording, true);
  touchTakeFiles(dir);
  const stop = await postAgent(agent.agentPort, 'stop');
  assert.equal(stop.saved, true, 'the pending mic check never delays saving indefinitely');
  assert.equal(stop.audio_health.pending, true);
  const pending = await postAgent(agent.agentPort, 'status');
  assert.equal(pending.last_take.audio_health.pending, true);
  assert.equal(pending.last_take.recorded_at, stop.recorded_at);
  fs.writeFileSync(gate, 'done');
  await waitFor(async () => (await postAgent(agent.agentPort, 'status')).last_take.audio_health.level === 'fail', 5000);
  const finished = await postAgent(agent.agentPort, 'status');
  assert.equal(finished.last_take.recorded_at, stop.recorded_at);
  assert.equal(finished.last_take.saved, true);
  assert.equal(finished.last_take.audio_health.pending, undefined);
  assert.equal(finished.last_take.audio_health.tracks[0].label, 'Mic 1');
  assert.equal(finished.last_take.audio_health.tracks[0].silent, true);
  assert.deepEqual(finished.last_take.audio_health.tracks[0].codes, ['mic_silent']);
});

function md5File(file) {
  return crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
}

test('audio_check: every mic fault is reported, warn only, and each recovers once fixed', { timeout: 60000 }, async (t) => {
  const audioRequests = [];
  const agent = await startAgent(t, { obs: { audioRequests }, env: FAST_AUDIO });
  const audio = agent.obsOptions.audio;
  const check = async () => (await postAgent(agent.agentPort, 'audio_check')).audio;
  const healthy = await check();
  assert.equal(healthy.level, 'ok', JSON.stringify(healthy));
  assert.equal(healthy.evo_present, true);
  assert.deepEqual(Object.keys(healthy.mics), ['Mic 1', 'Mic 2', 'Mic 3', 'Mic 4']);
  assert.deepEqual(healthy.mics['Mic 1'], { muted: false, peak_db: healthy.mics['Mic 1'].peak_db, frozen: false, recorded: true, codes: [] });
  const faults = [
    ['EVO unplugged', () => { audio.evo = false; }, () => { audio.evo = true; }, 'fail', ['evo_missing'], null],
    ['Mic 2 muted', () => { audio.muted = { 'Mic 2': true }; }, () => { audio.muted = {}; }, 'fail', ['mic_muted'], 'Mic 2'],
    ['Mic 1 digital zero', () => { audio.meters = { 'Mic 1': 'zero' }; }, () => { audio.meters = {}; }, 'fail', ['mic_silent'], 'Mic 1'],
    ['Mic 1 near-dead', () => { audio.meters = { 'Mic 1': 'low' }; }, () => { audio.meters = {}; }, 'warn', ['mic_silent'], 'Mic 1'],
    ['Mic 3 frozen', () => { audio.meters = { 'Mic 3': 'frozen' }; }, () => { audio.meters = {}; }, 'fail', ['mics_frozen'], 'Mic 3'],
    ['Mic 4 no meter', () => { audio.meters = { 'Mic 4': 'absent' }; }, () => { audio.meters = {}; }, 'fail', ['mics_frozen'], 'Mic 4'],
    ['Mic 2 = Mic 1', () => { audio.meters = { 'Mic 2': 'copy:Mic 1' }; }, () => { audio.meters = {}; }, 'fail', ['mics_identical'], 'Mic 2'],
    ['Mic 3 off its track', () => { audio.trackOff = { 'Mic 3': true }; }, () => { audio.trackOff = {}; }, 'fail', ['mic_not_recorded'], 'Mic 3'],
    ['track 4 not recorded', () => { audio.recTracks = '7'; }, () => { audio.recTracks = '15'; }, 'fail', ['mic_not_recorded'], 'Mic 4'],
    ['Mic 4 deleted', () => { audio.missing = ['Mic 4']; }, () => { audio.missing = []; }, 'fail', ['mic_not_recorded'], 'Mic 4'],
    ['no meters at all', () => { audio.metersOff = true; }, () => { audio.metersOff = false; }, 'warn', ['meters_unavailable'], null],
  ];
  for (const [name, breakIt, fixIt, level, codes, mic] of faults) {
    breakIt();
    const bad = await check();
    assert.equal(bad.level, level, name + ': ' + JSON.stringify(bad));
    assert.deepEqual(bad.codes, codes, name);
    if (mic) assert.deepEqual(bad.mics[mic].codes.filter((c) => codes.includes(c)), codes, name + ' on ' + mic);
    fixIt();
    const fixed = await check();
    assert.equal(fixed.level, 'ok', name + ' recovers: ' + JSON.stringify(fixed));
  }
  // The check used its own client: none of it reached the shared client's request log.
  assert.equal(agent.obsRequests.filter((r) => /^Get(Input|Profile)/.test(r.type)).length, 0);
  assert.ok(audioRequests.some((r) => r.type === 'GetProfileParameter' && r.data.parameterName === 'RecTracks'));
  assert.ok(audioRequests.some((r) => r.type === 'GetInputPropertiesListPropertyItems'));
  assert.match(agent.stderr(), /\[audio\] WARN mic check \(op\) fail: evo_missing/);
});

test('a failing mic check never refuses a take: start records and carries the warning; status raises audio_alert, which clears when fixed', { timeout: 60000 }, async (t) => {
  const agent = await startAgent(t, { env: FAST_AUDIO });
  agent.obsOptions.audio.meters = { 'Mic 1': 'zero' };
  agent.obsOptions.audio.evo = false;
  assert.equal((await postAgent(agent.agentPort, 'audio_check')).audio.level, 'fail');
  const started = await postAgent(agent.agentPort, 'start', { session_ref: 'sess_a1' });
  assert.equal(started.ok, true, 'warn only: the take starts');
  assert.equal(started.recording, true);
  assert.equal(started.audio.level, 'fail');
  assert.deepEqual(started.audio.codes, ['evo_missing', 'mic_silent']);
  assert.match(agent.stderr(), /\[take\] WARN recording started with mic check fail: evo_missing,mic_silent \(warn only, take not refused\)/);
  await waitFor(async () => {
    const s = await postAgent(agent.agentPort, 'status');
    return s.recording && s.audio_alert && s.audio_alert.level === 'fail';
  }, 8000);
  const during = await postAgent(agent.agentPort, 'status');
  assert.deepEqual(during.audio_alert.mics['Mic 1'].codes, ['mic_silent']);
  // Robbie plugs the EVO back in and fixes Mic 1 mid-take.
  agent.obsOptions.audio.meters = {};
  agent.obsOptions.audio.evo = true;
  await waitFor(async () => (await postAgent(agent.agentPort, 'status')).audio_alert.level === 'ok', 8000);
  const stopped = await postAgent(agent.agentPort, 'stop');
  assert.equal(stopped.audio_alert.level, 'ok');
  // MASTER_RECORD=1 by default: the take's timing comes from OBS's own STARTED event.
  assert.equal(stopped.timing.obs_start_basis, 'record_started_event');
  assert.match(stopped.timing.obs_start_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.ok(Date.parse(stopped.timing.obs_start_at) >= Date.parse(stopped.timing.obs_start_requested_at));
  assert.deepEqual(Object.keys(stopped.timing.cameras), ['cam1', 'cam2', 'cam3']);
  for (const cam of Object.values(stopped.timing.cameras)) {
    assert.equal(cam.basis, 'record_start');
    assert.ok(cam.offset_s > -1 && cam.offset_s < 5, 'Source Record offset ' + cam.offset_s);
  }
  assert.equal(stopped.recorded_at, stopped.timing.obs_start_at);
  const idle = await postAgent(agent.agentPort, 'status');
  assert.equal(idle.audio_alert, undefined, 'audio_alert only while recording');
  assert.equal(idle.last_take.recorded_at, stopped.recorded_at);
});

test('heartbeat carries the cached mic check (the contract audio block), from no I/O on the poll path', { timeout: 20000 }, async (t) => {
  const agent = await startAgent(t, { env: Object.assign({ POLL_IDLE_INTERVAL_MS: '3000' }, FAST_AUDIO), obs: { audio: Object.assign(healthyAudio(), { meters: { 'Mic 3': 'zero' } }) } });
  await waitFor(() => agent.relayRequests.some((url) => url.searchParams.get('hb') === '1'), 10000);
  const first = agent.relayRequests.find((url) => url.searchParams.get('hb') === '1');
  const hb = JSON.parse(Buffer.from(first.searchParams.get('state'), 'base64url').toString('utf8'));
  assert.equal(hb.audio.level, 'fail');
  assert.deepEqual(hb.audio.codes, ['mic_silent']);
  assert.equal(hb.audio.evo_present, true);
  assert.match(hb.audio.checked_at, /^2026-|^20\d\d-/);
  assert.deepEqual(Object.keys(hb.audio.mics['Mic 3']).sort(), ['codes', 'frozen', 'muted', 'peak_db', 'recorded']);
  assert.deepEqual(hb.audio.mics['Mic 3'].codes, ['mic_silent']);
  assert.ok(Buffer.byteLength(JSON.stringify(hb)) < 1024, 'heartbeat stays under 1 KiB: ' + Buffer.byteLength(JSON.stringify(hb)));
});

test('an RTSP take: stop reports timing and offsets; the watch copy is made with that offset (sign checked), registered via the webhook, originals byte-identical', { timeout: 90000 }, async (t) => {
  const webhookBodies = [];
  const webhookServer = createFakeWebhook(webhookBodies);
  const webhookPort = await listen(webhookServer);
  t.after(() => close(webhookServer));
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-mini-watch-log-'));
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));
  const ffmpegLog = path.join(logDir, 'ffmpeg.log');
  const agent = await startRtspAgent(t, Object.assign({ FAKE_FFMPEG_LOG: ffmpegLog, UPLOAD_CONFIRMED_WEBHOOK_URL: `http://127.0.0.1:${webhookPort}` }, FAST_AUDIO));
  // The master as ffprobe sees it: video + the four mic tracks (no duration, so the
  // fake cameras are not judged short against it).
  const masterFile = path.join(agent.recordDir, 'master', TAKE + '.mp4');
  fs.writeFileSync(masterFile + '.probe.json', JSON.stringify({ streams: [{ codec_type: 'video', start_time: '0.000000' }].concat([0, 1, 2, 3].map(() => ({ codec_type: 'audio', start_time: '0.000000' }))), format: { start_time: '0.000000' } }));
  const cam1File = path.join(agent.recordDir, 'cam1', TAKE + '.mp4');
  fs.writeFileSync(cam1File + '.watch.mp4.probe.json', JSON.stringify({ streams: [{ codec_type: 'video', duration: '30.4' }, { codec_type: 'audio', duration: '30.4' }], format: { start_time: '0.000000', duration: '30.400000' } }));
  const started = await postAgent(agent.agentPort, 'start', { session_ref: 'sess_watch' });
  assert.equal(started.ok, true);
  touchTakeFiles(agent.recordDir);
  await new Promise((resolve) => setTimeout(resolve, 600));
  const before = { cam2: md5File(path.join(agent.recordDir, 'cam2', TAKE + '.mp4')), master: md5File(masterFile) };
  const result = await postAgent(agent.agentPort, 'stop');
  assert.equal(result.saved, true);
  const cam1 = result.timing.cameras.cam1;
  assert.equal(cam1.basis, 'rtsp_progress');
  // The RTSP camera is up before StartRecord is sent, so its file starts first: positive offset.
  assert.ok(cam1.offset_s > 0 && cam1.offset_s < 10, 'cam1 offset ' + cam1.offset_s);
  assert.equal(cam1.offset_s, Math.round((Date.parse(result.timing.obs_start_at) - Date.parse(cam1.first_packet_at)) / 1) / 1000);
  assert.equal(result.timing.cameras.cam2.basis, 'record_start');
  // No real audio in the fake master: the file check says so, it never fails the take.
  assert.equal(result.audio_health.level, 'unknown');
  assert.equal(result.audio_health.reason, 'no_audio_tracks');
  const cam1Original = await (async () => { await waitFor(() => webhookBodies.some((b) => b.source === 'cam1' && b.rendition === 'original'), 30000); return webhookBodies.find((b) => b.source === 'cam1' && b.rendition === 'original'); })();
  assert.deepEqual([cam1Original.kind, cam1Original.recorded_at], ['video', result.recorded_at]);
  assert.ok(Number.isFinite(cam1Original.duration_s));
  await waitFor(() => webhookBodies.some((b) => b.rendition === 'watch' && b.source === 'cam1'), 60000);
  const watch = webhookBodies.find((b) => b.rendition === 'watch' && b.source === 'cam1');
  assert.deepEqual(
    { key: watch.key, kind: watch.kind, recorded_at: watch.recorded_at, duration_s: watch.duration_s, offset_s: watch.offset_s, audio: watch.audio, session_ref: watch.session_ref, original_key: watch.original_key },
    { key: `stream/bench-1/cam1/${TAKE}.mp4`, kind: 'video', recorded_at: result.recorded_at, duration_s: 30.4, offset_s: cam1.offset_s, audio: 'mix', session_ref: 'sess_watch', original_key: `recordings/bench-1/cam1/${TAKE}.mp4` });
  const calls = fs.readFileSync(ffmpegLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const encode = calls.find((a) => a.includes('-force_key_frames') && a.includes(cam1File));
  assert.ok(encode, 'watch encode for cam1');
  assert.deepEqual(encode.filter((a, i) => encode[i - 1] === '-i'), [cam1File, masterFile], 'camera video + master mic tracks');
  const graph = encode[encode.indexOf('-filter_complex') + 1];
  const samples = Math.round(cam1.offset_s * 48000);
  assert.ok(graph.includes(`adelay=delays=${samples}S:all=1`), 'the mix is delayed by +offset_s: ' + graph);
  assert.ok(graph.includes('[1:a:0][1:a:1][1:a:2][1:a:3]amix=inputs=4'));
  assert.ok(agent.uploads.some((r) => r.method === 'POST' && r.query.has('uploads') && r.path === `/fake-bucket/stream/bench-1/cam1/${TAKE}.mp4`.replace(/ /g, '%20')));
  // B2: the originals are never rewritten.
  assert.equal(md5File(path.join(agent.recordDir, 'cam2', TAKE + '.mp4')), before.cam2);
  assert.equal(md5File(masterFile), before.master);
});
