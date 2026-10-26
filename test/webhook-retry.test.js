'use strict';

// Build 45 A8: upload_confirmed is retried from a durable outbox. On Sunday
// 10-25 a single failed POST lost the ledger for 12 uploaded files: the webhook
// was posted once and a failure only logged. Clocks and timers are injected; no
// test waits for real backoff.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createUploadQueue } = require('../upload-queue');
const { runMultipartUpload } = require('../storage-upload');

const SECRET = 'SECRET-TOKEN-a8';

function loadOutbox() {
  try { return require('../webhook-outbox'); } catch (_) { return null; }
}

function tempDir(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-mini-' + name + '-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

/** A webhook that answers each POST with the next status in `statuses` (then 200); echoes its URL in error bodies. */
async function webhook(t, statuses) {
  const posts = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const status = statuses.length ? statuses.shift() : 200;
      posts.push({ url: req.url, raw, status });
      res.writeHead(status, { 'content-type': 'text/plain' });
      res.end(status >= 300 ? 'bad gateway for ' + req.url : '{}');
    });
  });
  const port = await listen(server);
  t.after(() => server.close());
  return { posts, port, url: 'http://127.0.0.1:' + port + '/hook?key=' + SECRET, delivered: () => posts.filter((p) => p.status < 300) };
}

/** Just enough S3 for runMultipartUpload: create, one part, complete, head. */
async function fakeS3(t) {
  const sizes = new Map();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      if (req.method === 'POST' && u.searchParams.has('uploads')) { res.end('<InitiateMultipartUploadResult><UploadId>u-1</UploadId></InitiateMultipartUploadResult>'); return; }
      if (req.method === 'PUT') { sizes.set(u.pathname, Buffer.concat(chunks).length); res.writeHead(200, { etag: '"e1"' }); res.end(); return; }
      if (req.method === 'POST' && u.searchParams.has('uploadId')) { res.end('<CompleteMultipartUploadResult/>'); return; }
      if (req.method === 'HEAD') { res.writeHead(200, { 'content-length': String(sizes.get(u.pathname) || 0) }); res.end(); return; }
      res.writeHead(400); res.end();
    });
  });
  const port = await listen(server);
  t.after(() => server.close());
  return { accessKeyId: 'AKIDTEST', secretAccessKey: 'fake-secret', bucket: 'b', endpoint: 'http://127.0.0.1:' + port, region: 'auto' };
}

/** Injected clock + timers: fireDue runs (and awaits) every timer whose time has come. */
function fakeClock(start) {
  let t = start;
  const timers = [];
  return {
    timers,
    now: () => t,
    advance(ms) { t += ms; },
    setTimer(fn, ms) { const h = { fn, at: t + ms, ms }; timers.push(h); return h; },
    clearTimer(h) { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); },
    async fireDue() {
      for (const h of timers.filter((x) => x.at <= t)) {
        const i = timers.indexOf(h);
        if (i < 0) continue;
        timers.splice(i, 1);
        await h.fn();
      }
    },
  };
}

async function waitFor(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

function captureConsole(t) {
  const lines = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(saved)) console[k] = (...args) => { lines.push(args.map((a) => (a && a.stack) || String(a)).join(' ')); };
  t.after(() => Object.assign(console, saved));
  return lines;
}

function outboxFile(stateDir) {
  return path.join(stateDir, 'webhook-outbox.json');
}

test('A8 retry: upload_confirmed answered 502 is retried after 1 min and delivered exactly once; the outbox empties', { timeout: 15000 }, async (t) => {
  const dir = tempDir(t, 'a8-502');
  const stateDir = path.join(dir, 'state');
  const hook = await webhook(t, [502]);
  const r2Config = await fakeS3(t);
  const clock = fakeClock(Date.parse('2026-10-25T15:00:00.000Z'));
  const filePath = path.join(dir, 'take-mic1.m4a');
  fs.writeFileSync(filePath, Buffer.alloc(4096, 1));
  const queue = createUploadQueue({
    stateDir, buildingId: 'bench-1', stabilityPollMs: 5, webhookUrl: () => hook.url, r2Config,
    outboxOptions: { now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer },
  });
  queue.enqueue({ filePath, source: 'mic1', kind: 'audio', sessionRef: 'sess-a8' });
  await waitFor(() => hook.posts.length === 1 && queue.status().active === null && queue.status().queued === 0, 6000);
  assert.equal(hook.posts.length, 1, 'first POST made');
  assert.equal(hook.posts[0].status, 502);
  clock.advance(60 * 1000);
  await clock.fireDue();
  await waitFor(() => hook.posts.length >= 2, 500);
  assert.equal(hook.delivered().length, 1, 'delivered exactly once');
  assert.equal(hook.posts.length, 2);
  assert.equal(hook.posts[1].raw, hook.posts[0].raw, 'the retry re-sends the payload byte for byte');
  assert.equal(JSON.parse(hook.posts[1].raw).sizeBytes, 4096);
  assert.equal(fs.existsSync(outboxFile(stateDir)), false, 'outbox file removed once empty');
  assert.equal(queue.webhookPending(), null);
  clock.advance(10 * 3600 * 1000);
  await clock.fireDue();
  assert.equal(hook.posts.length, 2, 'nothing posted again');
});

test('A8 retry: a failed-camera post lands in the outbox and is delivered by a restarted agent', { timeout: 15000 }, async (t) => {
  const dir = tempDir(t, 'a8-restart');
  const stateDir = path.join(dir, 'state');
  const hook = await webhook(t, [503]);
  const clock = fakeClock(Date.parse('2026-10-25T15:00:00.000Z'));
  const first = createUploadQueue({ stateDir, buildingId: 'bench-1', webhookUrl: hook.url, outboxOptions: { now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer } });
  await first.reportMissingCamera({ source: 'cam2', fileName: 'take.mp4', sessionRef: 'sess-r' });
  assert.equal(hook.posts.length, 1);
  assert.ok(fs.existsSync(outboxFile(stateDir)), 'the failed post is on disk');
  const saved = JSON.parse(fs.readFileSync(outboxFile(stateDir), 'utf8'));
  assert.equal(saved.entries.length, 1);
  assert.equal(JSON.stringify(saved).includes(SECRET), false, 'the webhook URL (and its key) is never written to disk');
  if (typeof first.stop === 'function') first.stop();

  // The agent restarts 2 minutes later: a new queue (and outbox) on the same state dir.
  clock.advance(2 * 60 * 1000);
  const clock2 = fakeClock(clock.now());
  const second = createUploadQueue({ stateDir, buildingId: 'bench-1', webhookUrl: hook.url, outboxOptions: { now: clock2.now, setTimer: clock2.setTimer, clearTimer: clock2.clearTimer } });
  assert.deepEqual(second.webhookPending ? second.webhookPending() : null, { count: 1, oldest_age_s: 120 });
  assert.equal(clock2.timers.length, 1, 'the overdue retry is scheduled on load');
  assert.equal(clock2.timers[0].ms, 0);
  await clock2.fireDue();
  assert.equal(hook.delivered().length, 1);
  assert.equal(hook.posts[1].raw, hook.posts[0].raw);
  const body = JSON.parse(hook.posts[1].raw);
  assert.deepEqual({ event: body.event, key: body.key, sizeBytes: body.sizeBytes, source: body.source }, { event: 'upload_confirmed', key: 'recordings/bench-1/cam2/take.mp4', sizeBytes: 0, source: 'cam2' });
  assert.equal(fs.existsSync(outboxFile(stateDir)), false);
  assert.equal(second.webhookPending(), null);
});

test('A8 backoff: 1, 5, 15, 60 minutes, then hourly', () => {
  const mod = loadOutbox();
  assert.ok(mod, 'webhook-outbox.js exists');
  assert.deepEqual([1, 2, 3, 4, 5, 6, 30].map((n) => mod.backoffMs(n) / 60000), [1, 5, 15, 60, 60, 60, 60]);
  assert.equal(mod.GIVE_UP_MS, 48 * 3600 * 1000);
});

test('A8 give-up: retries follow the schedule until 48 h, then one WARN, and the entry stays counted as gave_up', async (t) => {
  const mod = loadOutbox();
  assert.ok(mod, 'webhook-outbox.js exists');
  const dir = tempDir(t, 'a8-giveup');
  const clock = fakeClock(Date.parse('2026-10-25T15:00:00.000Z'));
  const start = clock.now();
  const sent = [];
  const logs = [];
  const outbox = mod.createWebhookOutbox({
    stateDir: dir, webhookUrl: 'https://hooks.example.test/upload?key=' + SECRET,
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    fetchImpl: async (url, init) => { sent.push(init.body); return { ok: false, status: 502, text: async () => '' }; },
    log: (m) => logs.push('LOG ' + m), warn: (m) => logs.push('WARN ' + m),
  });
  const payload = { event: 'upload_confirmed', key: 'recordings/bench-1/master/take.mp4', sizeBytes: 123, confirmedAt: '2026-10-25T15:00:00.000Z' };
  assert.deepEqual(await outbox.post(payload), { delivered: false, queued: true });
  const gaps = [];
  let last = start;
  while (clock.timers.length) {
    const next = clock.timers[0].at;
    gaps.push(Math.round((next - last) / 60000));
    last = next;
    clock.advance(next - clock.now());
    await clock.fireDue();
  }
  // 1, 5, 15, 60 min, then hourly; the last try lands exactly at 48 h.
  assert.deepEqual(gaps.slice(0, 6), [1, 5, 15, 60, 60, 60]);
  assert.equal(last - start, 48 * 3600 * 1000);
  assert.equal(gaps.reduce((a, b) => a + b, 0), 48 * 60);
  assert.equal(sent.length, 1 + gaps.length);
  assert.ok(sent.every((b) => b === sent[0]), 'every try sends the same bytes');
  const gaveUp = logs.filter((l) => l.startsWith('WARN') && /gave up/.test(l));
  assert.equal(gaveUp.length, 1, logs.join('\n'));
  assert.equal(logs.some((l) => l.includes(SECRET) || l.includes('hooks.example.test')), false);
  assert.deepEqual(outbox.pending(), { count: 1, oldest_age_s: 48 * 3600, gave_up: 1 });
  assert.equal(outbox.entries()[0].gave_up, true);
  // No more tries, and no second WARN, however long it sits.
  clock.advance(24 * 3600 * 1000);
  await outbox.flush();
  assert.equal(sent.length, 1 + gaps.length);
  assert.equal(logs.filter((l) => /gave up/.test(l)).length, 1);
  // Restarted, it is still counted and still not retried.
  const again = mod.createWebhookOutbox({ stateDir: dir, webhookUrl: 'https://hooks.example.test/upload?key=' + SECRET, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, fetchImpl: async () => { throw new Error('must not retry'); }, log: () => {}, warn: () => {} });
  assert.equal(again.pending().count, 1);
  assert.equal(again.pending().gave_up, 1);
  await again.flush();
});

test('A8 dedupe: the same upload_confirmed (event + key + sizeBytes) enqueued twice is one entry, sent as first queued', async (t) => {
  const mod = loadOutbox();
  assert.ok(mod, 'webhook-outbox.js exists');
  const dir = tempDir(t, 'a8-dedupe');
  const clock = fakeClock(Date.parse('2026-10-25T15:00:00.000Z'));
  const sent = [];
  let status = 500;
  const outbox = mod.createWebhookOutbox({
    stateDir: dir, webhookUrl: 'https://hooks.example.test/upload?key=' + SECRET,
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    fetchImpl: async (url, init) => { sent.push(init.body); return { ok: status < 300, status, text: async () => '' }; },
    log: () => {}, warn: () => {},
  });
  const a = { event: 'upload_confirmed', key: 'recordings/bench-1/cam1/take.mp4', sizeBytes: 9, confirmedAt: '2026-10-25T15:00:00.000Z' };
  const b = Object.assign({}, a, { confirmedAt: '2026-10-25T15:00:05.000Z' });
  await outbox.post(a);
  await outbox.post(b);
  await outbox.post(Object.assign({}, a, { sizeBytes: 10 }));
  assert.equal(outbox.entries().length, 2, 'a different sizeBytes is a different upload');
  assert.equal(sent.length, 2, 'a duplicate of a pending entry is not posted again');
  status = 200;
  clock.advance(60 * 1000);
  await clock.fireDue();
  assert.equal(outbox.entries().length, 0);
  assert.ok(sent.includes(JSON.stringify(a)));
  assert.equal(sent.includes(JSON.stringify(b)), false, 'the first queued bytes are the ones re-sent');
});

test('A8 no secrets: a failing then retried upload_confirmed never logs the webhook URL, host or key=', { timeout: 15000 }, async (t) => {
  const dir = tempDir(t, 'a8-secret');
  const hook = await webhook(t, [502]);
  const r2Config = await fakeS3(t);
  const mod = loadOutbox();
  const clock = fakeClock(Date.parse('2026-10-25T15:00:00.000Z'));
  const lines = captureConsole(t);
  const outbox = mod ? mod.createWebhookOutbox({ stateDir: path.join(dir, 'state'), webhookUrl: hook.url, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer }) : null;
  const filePath = path.join(dir, 'take.mp4');
  fs.writeFileSync(filePath, Buffer.alloc(2048, 2));
  await runMultipartUpload({
    r2Config, key: 'recordings/bench-1/master/take.mp4', filePath, sizeBytes: 2048,
    stateFilePath: path.join(dir, 'state', 'take.state.json'),
    webhookUrl: hook.url, webhookOutbox: outbox, abortOnFailure: false,
  });
  clock.advance(60 * 1000);
  await clock.fireDue();
  // A network error on a later try (the webhook host gone) is logged without it either.
  if (outbox) {
    await outbox.post({ event: 'upload_confirmed', key: 'recordings/bench-1/cam1/x.mp4', sizeBytes: 1 }, { url: 'http://127.0.0.1:1/hook?key=' + SECRET });
  }
  const out = lines.join('\n');
  assert.ok(hook.posts.length >= 1);
  assert.equal(out.includes(SECRET), false, out);
  assert.equal(/key=/.test(out), false, out);
  assert.equal(out.includes('127.0.0.1:' + hook.port), false, out);
  assert.equal(out.includes('127.0.0.1:1/'), false, out);
  assert.equal(out.includes('/hook'), false, out);
  assert.equal(hook.delivered().length, 1, 'delivered by the retry');
});

test('A8 heartbeat: webhook_pending is omitted when nothing is pending and { count, oldest_age_s } otherwise', () => {
  const { buildHeartbeatState } = require('../heartbeat-state');
  assert.equal('webhook_pending' in buildHeartbeatState({ webhookPending: null }), false);
  assert.equal('webhook_pending' in buildHeartbeatState({ webhookPending: { count: 0, oldest_age_s: 0 } }), false);
  assert.deepEqual(buildHeartbeatState({ webhookPending: { count: 3, oldest_age_s: 4000 } }).webhook_pending, { count: 3, oldest_age_s: 4000 });
  assert.deepEqual(buildHeartbeatState({ webhookPending: { count: 2, oldest_age_s: 172800, gave_up: 1 } }).webhook_pending, { count: 2, oldest_age_s: 172800, gave_up: 1 });
});
