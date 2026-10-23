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
  assert.equal(queue.status().proxies_pending, 0);
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
  assert.equal(queue.status().proxies_pending, 0);
});
