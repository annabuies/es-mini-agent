'use strict';

// Field fix 2026-10-23: a watch copy that fails is tried again (WATCH_COPY_ATTEMPTS),
// keeping the original for it; after the last try the cloud is told (an upload_confirmed
// for the stream/ key with no bytes, rendition "watch") so the app can say the copy could
// not be made, and only then is the original released.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createUploadQueue } = require('../upload-queue');

async function waitFor(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out');
}

function setup(t, fails) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-mini-watch-retry-'));
  const countPath = path.join(tempDir, 'runs');
  const previous = { FFMPEG_BIN: process.env.FFMPEG_BIN, FAKE_FFMPEG_COUNT: process.env.FAKE_FFMPEG_COUNT, FAKE_FFMPEG_FAILS: process.env.FAKE_FFMPEG_FAILS };
  process.env.FFMPEG_BIN = path.join(__dirname, 'fake-ffmpeg-flaky.js');
  process.env.FAKE_FFMPEG_COUNT = countPath;
  process.env.FAKE_FFMPEG_FAILS = String(fails);
  const posts = [];
  const priorFetch = global.fetch;
  global.fetch = async (url, init = {}) => { posts.push({ url: String(url), body: JSON.parse(init.body || '{}') }); return { ok: true, status: 200 }; };
  t.after(() => {
    global.fetch = priorFetch;
    for (const [k, v] of Object.entries(previous)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  const uploads = [];
  const queue = createUploadQueue({
    stateDir: path.join(tempDir, 'state'), buildingId: 'bench-1', deleteAfterUpload: true, stabilityPollMs: 5, proxyPollMs: 20, watchRetryMs: 50,
    webhookUrl: 'https://hooks.test/upload',
    uploader: async (input) => { uploads.push(input.key); return { key: input.key, sizeBytes: input.sizeBytes, partsUploaded: 1 }; },
  });
  const camPath = path.join(tempDir, '2026-10-22 12-01-40.mp4');
  fs.writeFileSync(camPath, Buffer.alloc(128 * 1024, 1));
  const runs = () => (fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, 'utf8')) : 0);
  return { queue, uploads, posts, camPath, runs };
}

test('a watch copy that fails twice is made on the third try; the original waits for it; nothing reports a failure', { timeout: 15000 }, async (t) => {
  const { queue, uploads, posts, camPath, runs } = setup(t, 2);
  queue.enqueue({ filePath: camPath, source: 'cam1', sessionRef: 'take-a' });
  await waitFor(() => runs() >= 1, 5000);
  assert.ok(fs.existsSync(camPath), 'kept after the first failure, for the next try');
  await waitFor(() => uploads.includes('stream/bench-1/cam1/2026-10-22 12-01-40.mp4'), 8000);
  assert.equal(runs(), 3);
  await waitFor(() => !fs.existsSync(camPath), 3000);
  assert.equal(posts.filter((p) => p.body.rendition === 'watch').length, 0, 'the made copy is announced by the uploader, not as a failure');
  // The legacy proxies/ copy may still be queued when the original is released.
  await waitFor(() => queue.status().proxies_pending === 0, 3000);
});

test('a watch copy that fails every try is reported once as failed (stream key, no bytes, rendition watch), then the original is released', { timeout: 15000 }, async (t) => {
  const { queue, uploads, posts, camPath, runs } = setup(t, 99);
  queue.enqueue({ filePath: camPath, source: 'cam2', sessionRef: 'take-a' });
  await waitFor(() => posts.some((p) => p.body.rendition === 'watch'), 8000);
  assert.equal(runs(), 3, 'three tries');
  const failed = posts.filter((p) => p.body.rendition === 'watch');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].url, 'https://hooks.test/upload');
  assert.deepEqual({ ...failed[0].body, confirmedAt: undefined }, {
    event: 'upload_confirmed', key: 'stream/bench-1/cam2/2026-10-22 12-01-40.mp4', sizeBytes: 0, confirmedAt: undefined,
    kind: 'video', rendition: 'watch', original_key: 'recordings/bench-1/cam2/2026-10-22 12-01-40.mp4',
    watch_error: 'encode_or_upload_failed', building_id: 'bench-1', source: 'cam2', session_ref: 'take-a',
  });
  assert.equal(uploads.some((k) => k.startsWith('stream/')), false, 'nothing uploaded as a watch copy');
  await waitFor(() => !fs.existsSync(camPath), 3000);
  await waitFor(() => queue.status().proxies_pending === 0, 3000);
});

test('the second camera Watch is uploaded before the first camera legacy proxy copy', { timeout: 15000 }, async (t) => {
  const { queue, uploads, camPath } = setup(t, 0);
  const secondPath = path.join(path.dirname(camPath), 'cam2-take.mp4');
  fs.writeFileSync(secondPath, Buffer.alloc(128 * 1024, 2));
  queue.enqueue({ filePath: camPath, source: 'cam1', sessionRef: 'take-b' });
  queue.enqueue({ filePath: secondPath, source: 'cam2', sessionRef: 'take-b' });

  const stream2 = 'stream/bench-1/cam2/cam2-take.mp4';
  const legacy1 = 'proxies/bench-1/cam1/2026-10-22 12-01-40.mp4';
  const legacy2 = 'proxies/bench-1/cam2/cam2-take.mp4';
  await waitFor(() => uploads.includes(stream2) && uploads.includes(legacy1) && uploads.includes(legacy2), 10000);
  assert.ok(uploads.indexOf(stream2) < uploads.indexOf(legacy1), 'another angle is watchable before the duplicate upload starts');
  await waitFor(() => queue.status().proxies_pending === 0, 3000);
  assert.equal(fs.existsSync(camPath + '.watch.mp4'), false, 'legacy copy temp is cleaned after upload');
  assert.equal(fs.existsSync(secondPath + '.watch.mp4'), false);
});

test('a legacy proxy copy still waiting at a restart is uploaded by the next sweep, then cleaned', { timeout: 15000 }, async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-mini-legacy-restart-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const stateDir = path.join(tempDir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const watchPath = path.join(tempDir, 'cam1-take.mp4.watch.mp4');
  fs.writeFileSync(watchPath, Buffer.alloc(64 * 1024, 3));
  const key = 'proxies/bench-1/cam1/cam1-take.mp4';
  const marker = path.join(stateDir, key.replace(/[^A-Za-z0-9._-]+/g, '_') + '.legacy.json');
  fs.writeFileSync(marker, JSON.stringify({ version: 1, filePath: watchPath, key, source: 'cam1', sessionRef: 'take-r' }));
  // A marker whose temp file is already gone is dropped, not retried.
  const goneMarker = path.join(stateDir, 'gone.legacy.json');
  fs.writeFileSync(goneMarker, JSON.stringify({ version: 1, filePath: path.join(tempDir, 'gone.watch.mp4'), key: 'proxies/bench-1/cam2/gone.mp4', source: 'cam2' }));

  const uploads = [];
  const queue = createUploadQueue({
    stateDir, buildingId: 'bench-1', deleteAfterUpload: true, stabilityPollMs: 5, proxyPollMs: 20, watchRetryMs: 50,
    webhookUrl: 'https://hooks.test/upload',
    uploader: async (input) => { uploads.push(input.key); return { key: input.key, sizeBytes: input.sizeBytes, partsUploaded: 1 }; },
  });
  const legacyMarkers = () => fs.readdirSync(stateDir).filter((n) => n.endsWith('.legacy.json'));
  await queue.sweep();
  await waitFor(() => uploads.includes(key) && queue.status().proxies_pending === 0, 5000);
  await waitFor(() => legacyMarkers().length === 0, 3000);
  assert.deepEqual(uploads, [key], 'only the surviving copy uploads');
  assert.equal(fs.existsSync(watchPath), false, 'the temp copy is removed after its upload');
});

test('a legacy proxy retry count survives a restart: the resumed upload keeps the limit', { timeout: 15000 }, async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-mini-legacy-attempts-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const stateDir = path.join(tempDir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const watchPath = path.join(tempDir, 'cam3-take.mp4.watch.mp4');
  fs.writeFileSync(watchPath, Buffer.alloc(64 * 1024, 5));
  const key = 'proxies/bench-1/cam3/cam3-take.mp4';
  const marker = path.join(stateDir, key.replace(/[^A-Za-z0-9._-]+/g, '_') + '.legacy.json');
  const make = (failing, retryMs) => {
    const tries = [];
    const queue = createUploadQueue({
      stateDir, buildingId: 'bench-1', deleteAfterUpload: true, stabilityPollMs: 5, proxyPollMs: 20, watchRetryMs: retryMs,
      webhookUrl: 'https://hooks.test/upload',
      uploader: async (input) => { tries.push(input.key); if (failing) throw new Error('bucket unreachable'); return { key: input.key, sizeBytes: input.sizeBytes, partsUploaded: 1 }; },
    });
    return { queue, tries };
  };
  // Before the restart: two failed tries were recorded with the marker.
  fs.writeFileSync(marker, JSON.stringify({ version: 1, filePath: watchPath, key, source: 'cam3', sessionRef: 'take-n', attempts: 1 }));
  const first = make(true, 60000); // its own retry would come long after the test
  await first.queue.sweep();
  await waitFor(() => first.tries.length >= 1 && JSON.parse(fs.readFileSync(marker, 'utf8')).attempts === 2, 5000);
  // "Restart": a new queue reads the marker; one more failure is the last of three.
  const second = make(true, 50);
  const firstTries = first.tries.length;
  await second.queue.sweep();
  await waitFor(() => !fs.existsSync(marker) && second.queue.status().proxies_pending === 0, 5000);
  assert.equal(firstTries, 1);
  assert.equal(second.tries.length, 1, 'the restart resumed at attempt 3 of 3, not 1 of 3');
  assert.equal(fs.existsSync(watchPath), false, 'the temp copy is released at give-up');
});

test('a failed hardware encode is redone in software at once; two in a row turn hardware off', { timeout: 20000 }, async (t) => {
  const { queue, uploads, posts, camPath } = setup(t, 0);
  const dir = path.dirname(camPath);
  const logPath = path.join(dir, 'encoders.log');
  const previous = { FFPROBE_BIN: process.env.FFPROBE_BIN, FAKE_FFMPEG_HW_FAIL: process.env.FAKE_FFMPEG_HW_FAIL, FAKE_FFMPEG_LOG: process.env.FAKE_FFMPEG_LOG };
  process.env.FFPROBE_BIN = path.join(__dirname, 'fake-ffprobe-h264.js');
  process.env.FAKE_FFMPEG_HW_FAIL = '1';
  process.env.FAKE_FFMPEG_LOG = logPath;
  t.after(() => { for (const [k, v] of Object.entries(previous)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

  const cams = [camPath];
  for (const name of ['cam2-take.mp4', 'cam3-take.mp4']) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, Buffer.alloc(128 * 1024, 2));
    cams.push(p);
  }
  assert.equal(queue.status().watch_hw, true);
  cams.forEach((filePath, i) => queue.enqueue({ filePath, source: 'cam' + (i + 1), sessionRef: 'take-hw' }));
  const streams = ['stream/bench-1/cam1/2026-10-22 12-01-40.mp4', 'stream/bench-1/cam2/cam2-take.mp4', 'stream/bench-1/cam3/cam3-take.mp4'];
  await waitFor(() => streams.every((k) => uploads.includes(k)) && queue.status().proxies_pending === 0, 15000);
  assert.deepEqual(fs.readFileSync(logPath, 'utf8').trim().split('\n'), ['hw', 'sw', 'hw', 'sw', 'sw'],
    'cam1 and cam2 fall back; after two failures cam3 goes straight to software');
  assert.equal(posts.filter((p) => p.body && p.body.rendition === 'watch' && p.body.sizeBytes === 0).length, 0, 'no Watch copy reported failed');
  assert.equal(queue.status().watch_hw, false, 'status shows hardware is off');
});
