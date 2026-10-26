'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const {
  executeLook,
  lookSettleMs,
  normalizeCameras,
  normalizeLooks,
  recall,
} = require('../ptz');
const { buildAuthorization, parseChallenge } = require('../digest-auth');

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

test('recall distinguishes no configured login from a rejected configured login', async (t) => {
  const challenge = 'Digest realm="fake-camera", nonce="nonce", qop="auth", algorithm=MD5';
  const server = http.createServer((req, res) => {
    const cnonce = req.headers.authorization && /cnonce="([^"]+)"/.exec(req.headers.authorization)?.[1];
    const expected = cnonce && buildAuthorization({
      method: 'GET', uri: req.url, username: 'fake-user', password: 'fake-password',
      challenge: parseChallenge(challenge), nc: '00000001', cnonce,
    });
    if (req.headers.authorization && req.headers.authorization === expected) {
      res.writeHead(204, { Connection: 'close' });
      res.end();
      return;
    }
    res.writeHead(401, { 'WWW-Authenticate': challenge, Connection: 'close' });
    res.end();
  });
  const port = await listen(server);
  t.after(() => close(server));
  const host = `127.0.0.1:${port}`;
  assert.equal(await recall(host, 1, { timeoutMs: 200 }), 'auth_required');
  assert.equal(await recall(host, 1, { timeoutMs: 200, credentials: { username: 'fake-user', password: 'fake-password' } }), 'ok');
  assert.equal(await recall(host, 1, { timeoutMs: 200, credentials: { username: 'fake-user', password: 'wrong-fake-password' } }), 'auth_failed');
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

test('executeLook logs each camera outcome and elapsed milliseconds without changing its result', async () => {
  const lines = [];
  const previousLog = console.log;
  const times = [1000, 1000, 1000, 1212, 1198, 4000];
  console.log = (...args) => { lines.push(args.join(' ')); };

  try {
    const result = await executeLook({
      recording: false,
      paused: false,
      cameras: [
        { name: 'cam1', host: 'camera-1' },
        { name: 'cam2', host: 'camera-2' },
        { name: 'cam3', host: 'camera-3' },
      ],
      looks: { '2': { cam1: 1, cam2: 2, cam3: 3 } },
    }, '2', {
      now: () => times.shift(),
      recallFn: async (host) => ({
        'camera-1': 'ok',
        'camera-2': 'ok',
        'camera-3': 'timeout',
      })[host],
    });

    assert.deepEqual(result, {
      ok: false,
      look: '2',
      cameras: { cam1: 'ok', cam2: 'ok', cam3: 'timeout' },
    });
    assert.deepEqual(lines, [
      '[es-mini-agent] ptz: look 2 -> cam1 ok 212ms, cam2 ok 198ms, cam3 timeout 3000ms',
    ]);
  } finally {
    console.log = previousLog;
  }
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
  assert.deepEqual(await executeLook({ recording: false, paused: false, uploading: true, cameras: [camera], looks }, '2'), {
    ok: false, look: '2', reason: 'busy_uploading',
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

// Build 45 A5: a look's settle time. The PTZ HTTP recall answers in under a
// second, before the camera stops moving. The agent does NOT wait (one command
// at a time, and the Worker skips a look after 6.5 s); it reports when the move
// should be done: settled_at = the moment every recall returned + settle_ms.

const LOOK_CONFIG = {
  recording: false,
  paused: false,
  cameras: [{ name: 'cam1', host: 'camera-1' }, { name: 'cam2', host: 'camera-2' }],
  looks: { '2': { cam1: 1, cam2: 2 }, '3': { cam1: 3, cam2: 4 } },
};

test('A5 look settle: every recall ok -> settle_ms, settled_at (all recalls back + settle) and per-camera elapsed_ms', async () => {
  const times = [10000, 10000, 10250, 10400];
  const result = await executeLook(LOOK_CONFIG, '2', {
    now: () => times.shift(),
    settleMs: 4000,
    recallFn: async () => 'ok',
  });
  assert.deepEqual(result, {
    ok: true,
    look: '2',
    cameras: { cam1: 'ok', cam2: 'ok' },
    elapsed_ms: { cam1: 250, cam2: 400 },
    settle_ms: 4000,
    settled_at: new Date(10400 + 4000).toISOString(),
  });
});

test('A5 look settle: LOOK_SETTLE_MS defaults to 4000 and is clamped to 0..15000', async () => {
  assert.equal(lookSettleMs(undefined), 4000);
  assert.equal(lookSettleMs(''), 4000);
  assert.equal(lookSettleMs('abc'), 4000);
  assert.equal(lookSettleMs('99999'), 15000);
  assert.equal(lookSettleMs('-5'), 0);
  assert.equal(lookSettleMs('2500'), 2500);
  assert.equal(lookSettleMs('2500.7'), 2500);
  const prior = process.env.LOOK_SETTLE_MS;
  process.env.LOOK_SETTLE_MS = '99999';
  try {
    const r = await executeLook(LOOK_CONFIG, '2', { recallFn: async () => 'ok' });
    assert.equal(r.settle_ms, 15000);
  } finally {
    if (prior === undefined) delete process.env.LOOK_SETTLE_MS; else process.env.LOOK_SETTLE_MS = prior;
  }
});

test('A5 look settle: a camera error is ok:false with no settled_at or settle_ms', async () => {
  const result = await executeLook(LOOK_CONFIG, '2', {
    settleMs: 4000,
    recallFn: async (host) => (host === 'camera-2' ? 'timeout' : 'ok'),
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.cameras, { cam1: 'ok', cam2: 'timeout' });
  assert.equal(result.settled_at, undefined);
  assert.equal(result.settle_ms, undefined);
});

test('A5 look settle: back-to-back looks both return at once (no settle wait), the second settles later', async () => {
  const opts = { settleMs: 4000, recallFn: async () => { await new Promise((r) => setTimeout(r, 20)); return 'ok'; } };
  const t0 = Date.now();
  const first = await executeLook(LOOK_CONFIG, '2', opts);
  const second = await executeLook(LOOK_CONFIG, '3', opts);
  const took = Date.now() - t0;
  assert.ok(took < 1000, 'two looks took ' + took + ' ms (a settle wait would be >= 8000)');
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.ok(Date.parse(first.settled_at) >= t0 + 4000, 'settled_at is in the future');
  assert.ok(Date.parse(second.settled_at) > Date.parse(first.settled_at), 'the second look settles later');
});

test('A5 look settle: a look mapping no cameras still answers (settled_at from now)', async () => {
  const r = await executeLook({ ...LOOK_CONFIG, looks: { empty: {} } }, 'empty', { settleMs: 0, now: () => 5000 });
  assert.deepEqual(r, { ok: true, look: 'empty', cameras: {}, elapsed_ms: {}, settle_ms: 0, settled_at: new Date(5000).toISOString() });
});
