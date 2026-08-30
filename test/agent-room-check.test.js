'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const dgram = require('node:dgram');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');

function listenHttp(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function closeHttp(server) {
  return new Promise((resolve) => server.close(resolve));
}

function listenUdp(socket) {
  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(0, '127.0.0.1', () => resolve(socket.address().port));
  });
}

function closeUdp(socket) {
  return new Promise((resolve) => socket.close(resolve));
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
  throw new Error('timed out waiting for agent room-check output');
}

function viscaReply(message, positionCount) {
  const key = Buffer.from(message).toString('hex');
  if (key === '81090612ff') {
    const moved = positionCount > 0;
    return Buffer.from(moved
      ? [0x90, 0x50, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0xff]
      : [0x90, 0x50, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff]);
  }
  const replies = {
    '81090447ff': [0x90, 0x50, 0x00, 0x08, 0x00, 0x00, 0xff],
    '81090435ff': [0x90, 0x50, 0x05, 0xff],
    '81090443ff': [0x90, 0x50, 0x00, 0x00, 0x08, 0x00, 0xff],
    '81090444ff': [0x90, 0x50, 0x00, 0x00, 0x06, 0x00, 0xff],
    '81090420ff': [0x90, 0x50, 0x02, 0x08, 0xff],
    '81090439ff': [0x90, 0x50, 0x00, 0xff],
    '8109044aff': [0x90, 0x50, 0x00, 0x00, 0x00, 0x05, 0xff],
    '8109044bff': [0x90, 0x50, 0x00, 0x00, 0x00, 0x06, 0xff],
    '8109044dff': [0x90, 0x50, 0x00, 0x00, 0x00, 0x07, 0xff],
    '810904a1ff': [0x90, 0x50, 0x00, 0x00, 0x00, 0x07, 0xff],
    '810904a2ff': [0x90, 0x50, 0x00, 0x00, 0x00, 0x08, 0xff],
    '810904a4ff': [0x90, 0x50, 0x00, 0xff],
    '8109044fff': [0x90, 0x50, 0x07, 0xff],
  };
  return Buffer.from(replies[key] || [0x90, 0x51, 0xff]);
}

async function runScenario(t, { uptimeS, upcoming, probeStatuses, sourcesRefreshMs }) {
  const cgiRequests = [];
  let probeCount = 0;
  const cameraServer = http.createServer((req, res) => {
    cgiRequests.push(req.url);
    if (req.url === '/cgi-bin/param.cgi?get_device_conf' && Array.isArray(probeStatuses)) {
      const status = probeStatuses[Math.min(probeCount, probeStatuses.length - 1)];
      probeCount += 1;
      res.writeHead(status);
      res.end();
      return;
    }
    if (req.url === '/snapshot.jpg') {
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      res.end(Buffer.from('fake-jpeg'));
      return;
    }
    res.writeHead(204);
    res.end();
  });
  const cameraPort = await listenHttp(cameraServer);
  t.after(() => closeHttp(cameraServer));

  let positionCount = 0;
  const viscaServer = dgram.createSocket('udp4');
  viscaServer.on('message', (message, rinfo) => {
    const response = viscaReply(message, positionCount);
    if (Buffer.from(message).toString('hex') === '81090612ff') positionCount += 1;
    viscaServer.send(response, rinfo.port, rinfo.address);
  });
  const viscaPort = await listenUdp(viscaServer);
  t.after(() => closeUdp(viscaServer));

  const writes = [];
  let configPulls = 0;
  const relayServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && url.searchParams.get('want_sources') === '1') {
      configPulls += 1;
      res.end(JSON.stringify({
        ok: true,
        sources: [],
        cameras: [{ name: 'cam1', host: `127.0.0.1:${cameraPort}` }],
        looks: { '2': { cam1: 1 } },
        default_look: null,
        check_look: '2',
        camera_profiles: {},
        reference_frames: {},
        upcoming: upcoming || null,
      }));
      return;
    }
    if (req.method === 'GET') {
      res.end(JSON.stringify({ ok: true, command: null }));
      return;
    }
    if (req.method === 'POST') {
      const body = await readJson(req);
      if (body.mini_room_check === true) writes.push(body);
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.statusCode = 405;
    res.end(JSON.stringify({ ok: false }));
  });
  const relayPort = await listenHttp(relayServer);
  t.after(() => closeHttp(relayServer));

  const portProbe = http.createServer();
  const agentPort = await listenHttp(portProbe);
  await closeHttp(portProbe);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      BUILDING_ID: 'bench-1',
      RECORD_CONTROL_KEY: 'fake-test-key',
      RECORD_POLL_URL: `http://127.0.0.1:${relayPort}`,
      PORT: String(agentPort),
      OBS_SOURCES: '',
      BOOT_CALIBRATE_UPTIME_OVERRIDE_S: String(uptimeS),
      PTZ_VISCA_PORT: String(viscaPort),
      PTZ_RESET_SETTLE_MS: '0',
      PTZ_RESET_SETTLE_CAP_MS: '10',
      PTZ_RESET_POLL_MS: '1',
      PTZ_RECALL_SETTLE_MS: '0',
      SOURCES_REFRESH_MS: String(sourcesRefreshMs || 60000),
      S3_ACCESS_KEY_ID: '',
      S3_SECRET_ACCESS_KEY: '',
      S3_BUCKET: '',
      S3_ENDPOINT: '',
      R2_ACCESS_KEY_ID: '',
      R2_SECRET_ACCESS_KEY: '',
      R2_BUCKET: '',
      R2_ENDPOINT: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { output += chunk.toString('utf8'); });
  t.after(() => { if (!child.killed) child.kill('SIGTERM'); });
  return { child, writes, cgiRequests, get configPulls() { return configPulls; }, get output() { return output; } };
}

test('spawned agent with injected uptime 30 calibrates exactly once and posts the write-back shape', { timeout: 10000 }, async (t) => {
  const scenario = await runScenario(t, { uptimeS: 30 });
  await waitFor(() => scenario.writes.length === 1, 8000);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(scenario.writes.length, 1);
  assert.equal(scenario.writes[0].mini_room_check, true);
  assert.equal(scenario.writes[0].kind, 'calibrate');
  assert.equal(scenario.writes[0].trigger, 'boot');
  assert.equal(scenario.writes[0].result.ok, true);
  assert.equal(scenario.cgiRequests.includes('/cgi-bin/param.cgi?pan_tiltdrive_reset'), true);
  assert.equal(scenario.cgiRequests.includes('/cgi-bin/ptzctrl.cgi?ptzcmd&poscall&1'), true);
  assert.match(scenario.output, /room-check start kind=calibrate trigger=boot/);
  scenario.child.kill('SIGTERM');
  await new Promise((resolve) => scenario.child.once('exit', resolve));
});

test('spawned agent with injected uptime 90000 never moves a camera on agent restart', { timeout: 5000 }, async (t) => {
  const scenario = await runScenario(t, { uptimeS: 90000 });
  await waitFor(() => scenario.configPulls === 1, 2000);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(scenario.writes.length, 0);
  assert.equal(scenario.cgiRequests.includes('/cgi-bin/param.cgi?pan_tiltdrive_reset'), false);
  assert.equal(scenario.cgiRequests.some((url) => url && url.includes('poscall')), false);
  scenario.child.kill('SIGTERM');
  await new Promise((resolve) => scenario.child.once('exit', resolve));
});

test('two failed probes followed by recovery calibrate only the rebooted camera', { timeout: 8000 }, async (t) => {
  const scenario = await runScenario(t, {
    uptimeS: 90000,
    probeStatuses: [500, 500, 204, 204, 204],
    sourcesRefreshMs: 50,
  });
  await waitFor(() => scenario.writes.length === 1, 6000);
  assert.equal(scenario.writes[0].kind, 'calibrate');
  assert.equal(scenario.writes[0].trigger, 'reboot');
  assert.deepEqual(Object.keys(scenario.writes[0].result.cameras), ['cam1']);
  assert.equal(scenario.cgiRequests.includes('/cgi-bin/param.cgi?pan_tiltdrive_reset'), true);
  scenario.child.kill('SIGTERM');
  await new Promise((resolve) => scenario.child.once('exit', resolve));
});

test('a fake T-19 booking runs one scheduled room_check and posts one write-back', { timeout: 8000 }, async (t) => {
  const now = Date.now();
  const starts = now + 19 * 60 * 1000;
  const scenario = await runScenario(t, {
    uptimeS: 90000,
    upcoming: {
      id: 'booking-t19',
      starts_at: new Date(starts).toISOString(),
      ends_at: new Date(starts + 60 * 60 * 1000).toISOString(),
      access_from: new Date(starts - 15 * 60 * 1000).toISOString(),
      access_until: new Date(starts + 70 * 60 * 1000).toISOString(),
    },
  });
  await waitFor(() => scenario.writes.length === 1, 6000);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(scenario.writes.length, 1);
  assert.equal(scenario.writes[0].kind, 'room_check');
  assert.equal(scenario.writes[0].trigger, 'schedule');
  assert.equal(scenario.writes[0].booking_id, 'booking-t19');
  assert.equal(scenario.writes[0].result.booking_id, 'booking-t19');
  assert.match(scenario.output, /room-check start kind=room_check trigger=schedule/);
  scenario.child.kill('SIGTERM');
  await new Promise((resolve) => scenario.child.once('exit', resolve));
});
