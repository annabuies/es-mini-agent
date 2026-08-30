'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const {
  executeLook,
  applyCgiProfile,
  normalizeCameras,
  normalizeLooks,
  panTiltReset,
  probe,
  recall,
  setImageValue,
  snapshot,
} = require('../ptz');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test('recall classifies ok, timeout, HTTP errors, auth, and network errors', async (t) => {
  const server = http.createServer((req, res) => {
    const preset = Number((req.url.match(/&([0-9]+)$/) || [])[1]);
    if (preset === 1) { res.writeHead(204); res.end(); return; }
    if (preset === 2) { res.writeHead(500); res.end(); return; }
    if (preset === 3) { res.writeHead(404); res.end(); return; }
    if (preset === 4) { res.writeHead(401); res.end(); return; }
    if (preset === 5) {
      setTimeout(() => { if (!res.destroyed) res.end(); }, 200).unref();
      return;
    }
    res.writeHead(418); res.end();
  });
  const port = await listen(server);
  t.after(() => close(server));
  const host = `127.0.0.1:${port}`;

  assert.equal(await recall(host, 1, { timeoutMs: 40 }), 'ok');
  assert.equal(await recall(host, 2, { timeoutMs: 40 }), 'http_500');
  assert.equal(await recall(host, 3, { timeoutMs: 40 }), 'http_404');
  assert.equal(await recall(host, 4, { timeoutMs: 40 }), 'auth_required');
  assert.equal(await recall(host, 5, { timeoutMs: 40 }), 'timeout');

  const closedServer = http.createServer();
  const closedPort = await listen(closedServer);
  await close(closedServer);
  assert.equal(await recall(`127.0.0.1:${closedPort}`, 1, { timeoutMs: 40 }), 'error');
});

test('executeLook recalls only mapped cameras in parallel and reports each result', async (t) => {
  const requests = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    res.once('close', () => { inFlight -= 1; });
    const preset = Number((req.url.match(/&([0-9]+)$/) || [])[1]);
    if (preset === 1) { setTimeout(() => { res.writeHead(200); res.end(); }, 15); return; }
    if (preset === 2) { setTimeout(() => { res.writeHead(500); res.end(); }, 15); return; }
    if (preset === 3) { setTimeout(() => { res.writeHead(401); res.end(); }, 15); return; }
    setTimeout(() => { if (!res.destroyed) res.end(); }, 200).unref();
  });
  const port = await listen(server);
  t.after(() => close(server));
  const host = `127.0.0.1:${port}`;
  const result = await executeLook({
    recording: false,
    paused: false,
    cameras: [
      { name: 'cam1', host },
      { name: 'cam2', host },
      { name: 'cam3', host },
      { name: 'cam4', host },
      { name: 'omitted', host },
    ],
    looks: { mixed: { cam1: 1, cam2: 2, cam3: 3, cam4: 4 } },
  }, 'mixed', { timeoutMs: 40 });

  assert.deepEqual(result, {
    ok: false,
    look: 'mixed',
    cameras: {
      cam1: 'ok',
      cam2: 'http_500',
      cam3: 'auth_required',
      cam4: 'timeout',
    },
  });
  assert.equal(requests.length, 4);
  assert.equal(maxInFlight, 4);
  assert.equal(requests.some((url) => url.includes('omitted')), false);
});

test('executeLook returns honest busy, no-camera, and unknown-look reasons', async () => {
  const camera = { name: 'cam1', host: '127.0.0.1:1' };
  const looks = { '2': { cam1: 1 } };
  assert.deepEqual(await executeLook({ recording: true, paused: false, cameras: [camera], looks }, '2'), {
    ok: false, look: '2', reason: 'busy_recording',
  });
  assert.deepEqual(await executeLook({ recording: false, paused: true, cameras: [camera], looks }, '2'), {
    ok: false, look: '2', reason: 'busy_recording',
  });
  assert.deepEqual(await executeLook({ recording: false, paused: false, cameras: [], looks }, '2'), {
    ok: false, look: '2', reason: 'no_cameras',
  });
  assert.deepEqual(await executeLook({ recording: false, paused: false, cameras: [camera], looks }, '9'), {
    ok: false, look: '9', reason: 'unknown_look',
  });
});

test('remote PTZ config normalization is all-or-nothing', () => {
  assert.deepEqual(normalizeCameras([{ name: ' cam1 ', host: ' 172.16.1.133 ' }]), [
    { name: 'cam1', host: '172.16.1.133' },
  ]);
  assert.equal(normalizeCameras([{ name: 'cam1', host: '' }]), null);
  assert.equal(normalizeCameras([{ name: 'cam1', host: 'a' }, { name: 'cam1', host: 'b' }]), null);
  assert.deepEqual(normalizeLooks({ '1': { cam1: 0 }, '2': { cam1: 1 } }), {
    '1': { cam1: 0 }, '2': { cam1: 1 },
  });
  assert.equal(normalizeLooks({ '1': { cam1: -1 } }), null);
});

test('room-check CGI helpers use the safe endpoints and ordered profile writes', async (t) => {
  const requests = [];
  const jpeg = Buffer.from('fake-jpeg-fixture');
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    if (req.url === '/snapshot.jpg') {
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      res.end(jpeg);
      return;
    }
    if (req.url && req.url.endsWith('&hue&7')) {
      res.writeHead(500);
      res.end();
      return;
    }
    res.writeHead(204);
    res.end();
  });
  const port = await listen(server);
  t.after(() => close(server));
  const host = `127.0.0.1:${port}`;

  assert.equal(await probe(host), 'ok');
  assert.equal(await panTiltReset(host), 'ok');
  assert.equal(await setImageValue(host, 'bright', 99), 'error');
  const profile = await applyCgiProfile(host, {
    hue: 7,
    sharpness: 7,
    contrast: 7,
    saturation: 7,
    bright: 7,
    mirror: 0,
    flip: 0,
    wbmode: 'manual',
    aemode: 'auto',
  });
  assert.equal(profile.status, 'partial');
  assert.deepEqual(profile.failures, ['hue']);
  assert.deepEqual(await snapshot(host), jpeg);

  assert.deepEqual(requests, [
    '/cgi-bin/param.cgi?get_device_conf',
    '/cgi-bin/param.cgi?pan_tiltdrive_reset',
    '/cgi-bin/param.cgi?post_image_value&aemode&auto',
    '/cgi-bin/param.cgi?post_image_value&wbmode&manual',
    '/cgi-bin/param.cgi?post_image_value&flip&0',
    '/cgi-bin/param.cgi?post_image_value&mirror&0',
    '/cgi-bin/param.cgi?post_image_value&bright&7',
    '/cgi-bin/param.cgi?post_image_value&saturation&7',
    '/cgi-bin/param.cgi?post_image_value&contrast&7',
    '/cgi-bin/param.cgi?post_image_value&sharpness&7',
    '/cgi-bin/param.cgi?post_image_value&hue&7',
    '/snapshot.jpg',
  ]);
});
