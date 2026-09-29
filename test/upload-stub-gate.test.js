'use strict';

// Issue #10 defects 2 and 3: a zero-stream Source Record stub must never be
// uploaded and confirmed as a recording, and a proxy still being transcoded
// must never be mistaken for the take that was just recorded.

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createUploadQueue } = require('../upload-queue');
const { getNewestFileSample, isRecordingFileName } = require('../obs-control');

const FAKE = path.join(__dirname, 'fake-ffmpeg.js');
// resolveFfmpegBin() memoizes on first use, so pin the fake before any proxy runs.
process.env.FFMPEG_BIN = FAKE;
const recordingUploads = (uploads) => uploads.filter((u) => u.key.startsWith('recordings/'));

async function waitFor(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out');
}

function withEnv(t, vars) {
  const previous = {};
  for (const [k, v] of Object.entries(vars)) {
    previous[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

function webhookServer(t) {
  const posts = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => { posts.push(JSON.parse(raw)); res.end('{}'); });
  });
  t.after(() => server.close());
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ posts, url: `http://127.0.0.1:${server.address().port}/hook` })));
}

function setup(t, { source = 'cam1', bytes = 1737, name = '2026-09-29 08-03-48.mp4', queueOptions = {} } = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-mini-stub-gate-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const camDir = path.join(tempDir, source);
  fs.mkdirSync(camDir);
  const filePath = path.join(camDir, name);
  fs.writeFileSync(filePath, Buffer.alloc(bytes, 7));
  const stateDir = path.join(tempDir, 'state');
  const uploads = [];
  return {
    tempDir, camDir, filePath, stateDir, uploads,
    queue: (hookUrl) => createUploadQueue({
      stateDir, buildingId: 'bench-1', stabilityPollMs: 5, webhookUrl: hookUrl,
      uploader: async (input) => { uploads.push(input); return { key: input.key, sizeBytes: input.sizeBytes, partsUploaded: 1 }; },
      ...queueOptions,
    }),
    stateFiles: () => (fs.existsSync(stateDir) ? fs.readdirSync(stateDir).filter((f) => f.endsWith('.state.json')) : []),
  };
}

test('a zero-stream camera stub is not uploaded, is quarantined, and is reported as failed (sizeBytes 0)', { timeout: 8000 }, async (t) => {
  withEnv(t, { FFPROBE_BIN: FAKE, FAKE_PROBE_STREAMS: '0' });
  const hook = await webhookServer(t);
  const s = setup(t);
  const queue = s.queue(hook.url);
  queue.enqueue({ filePath: s.filePath, source: 'cam1', sessionRef: 'sess-5' });
  await waitFor(() => hook.posts.length === 1 && queue.status().active === null && queue.status().queued === 0 && s.stateFiles().length === 0, 6000);
  assert.equal(recordingUploads(s.uploads).length, 0);
  const post = hook.posts[0];
  assert.deepEqual(
    { event: post.event, sizeBytes: post.sizeBytes, source: post.source, invalid: post.invalid, file_size_bytes: post.file_size_bytes, streams: post.streams, session_ref: post.session_ref },
    { event: 'upload_confirmed', sizeBytes: 0, source: 'cam1', invalid: 'zero_streams', file_size_bytes: 1737, streams: 0, session_ref: 'sess-5' },
  );
  assert.equal(fs.existsSync(s.filePath), false);
  assert.equal(fs.statSync(path.join(s.camDir, 'quarantine', '2026-09-29 08-03-48.mp4')).size, 1737);
  assert.equal(getNewestFileSample(s.camDir), null, 'the quarantined stub is never picked up again');
  assert.equal(queue.status().last_confirmed, null);
});

test('a tiny file ffprobe cannot read is quarantined; a large one is still uploaded', { timeout: 8000 }, async (t) => {
  withEnv(t, { FFPROBE_BIN: FAKE, FAKE_PROBE_STREAMS: 'fail' });
  const hook = await webhookServer(t);
  const tiny = setup(t, { bytes: 1737 });
  const q1 = tiny.queue(hook.url);
  q1.enqueue({ filePath: tiny.filePath, source: 'cam1' });
  await waitFor(() => hook.posts.length === 1 && q1.status().queued === 0 && q1.status().active === null, 6000);
  assert.equal(tiny.uploads.length, 0);
  assert.equal(hook.posts[0].invalid, 'unprobeable_below_65536_bytes');

  const big = setup(t, { bytes: 70 * 1024, source: 'cam2' });
  const q2 = big.queue(hook.url);
  q2.enqueue({ filePath: big.filePath, source: 'cam2' });
  await waitFor(() => recordingUploads(big.uploads).length === 1, 6000);
  assert.equal(recordingUploads(big.uploads)[0].key, 'recordings/bench-1/cam2/2026-09-29 08-03-48.mp4');
});

test('ffprobe finding streams wins over the size floor', { timeout: 8000 }, async (t) => {
  withEnv(t, { FFPROBE_BIN: FAKE, FAKE_PROBE_STREAMS: '2' });
  const s = setup(t, { bytes: 900, source: 'cam2' });
  const queue = s.queue(undefined);
  queue.enqueue({ filePath: s.filePath, source: 'cam2' });
  await waitFor(() => recordingUploads(s.uploads).length === 1, 6000);
});

test('a zero-stream master is quarantined without a webhook', { timeout: 8000 }, async (t) => {
  withEnv(t, { FFPROBE_BIN: FAKE, FAKE_PROBE_STREAMS: '0' });
  const hook = await webhookServer(t);
  const s = setup(t, { source: 'master' });
  const queue = s.queue(hook.url);
  queue.enqueue({ filePath: s.filePath, source: 'master' });
  await waitFor(() => queue.status().active === null && queue.status().queued === 0 && s.stateFiles().length === 0, 6000);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(s.uploads.length, 0);
  assert.equal(hook.posts.length, 0);
  assert.ok(fs.existsSync(path.join(s.camDir, 'quarantine', '2026-09-29 08-03-48.mp4')));
});

test('probeGate:false (RECORDING_PROBE_GATE=0) restores the old upload-everything behaviour', { timeout: 8000 }, async (t) => {
  withEnv(t, { FFPROBE_BIN: FAKE, FAKE_PROBE_STREAMS: '0' });
  const s = setup(t, { queueOptions: { probeGate: false } });
  const queue = s.queue(undefined);
  queue.enqueue({ filePath: s.filePath, source: 'cam1' });
  await waitFor(() => recordingUploads(s.uploads).length === 1, 6000);
});

function mp4Box(type, payload = Buffer.alloc(0)) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + payload.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, payload]);
}

let realFfprobe = null;
try {
  execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
  realFfprobe = 'ffprobe';
} catch (_) { /* skipped below */ }

test('real ffprobe: both Source Record stub shapes are rejected', { timeout: 10000, skip: !realFfprobe && 'ffprobe not installed' }, async (t) => {
  withEnv(t, { FFPROBE_BIN: realFfprobe, FAKE_PROBE_STREAMS: undefined });
  const hook = await webhookServer(t);
  const ftyp = mp4Box('ftyp', Buffer.from('isom\x00\x00\x02\x00isomiso2mp41', 'latin1'));
  // "Full moov size: 0 KiB": no moov at all, 1,737 bytes like the bench-1 stub.
  const noMoov = Buffer.concat([ftyp, mp4Box('free'), mp4Box('mdat', Buffer.alloc(1737 - ftyp.length - 16))]);
  // A moov that parses but holds no track.
  const emptyMoov = Buffer.concat([ftyp, mp4Box('moov', mp4Box('mvhd', Buffer.alloc(100))), mp4Box('mdat', Buffer.alloc(1500))]);
  const a = setup(t, { name: 'a.mp4' });
  fs.writeFileSync(a.filePath, noMoov);
  const b = setup(t, { name: 'b.mp4', source: 'cam3' });
  fs.writeFileSync(b.filePath, emptyMoov);
  const qa = a.queue(hook.url);
  const qb = b.queue(hook.url);
  qa.enqueue({ filePath: a.filePath, source: 'cam1' });
  qb.enqueue({ filePath: b.filePath, source: 'cam3' });
  await waitFor(() => hook.posts.length === 2, 8000);
  assert.equal(a.uploads.length + b.uploads.length, 0);
  assert.deepEqual(hook.posts.map((p) => [p.source, p.sizeBytes, p.invalid]).sort(), [
    ['cam1', 0, 'unprobeable_below_65536_bytes'],
    ['cam3', 0, 'zero_streams'],
  ]);
});

test('the stop-time newest-file scan ignores proxies, dotfiles and non-recordings', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-mini-newest-'));
  try {
    const take = path.join(dir, '2026-09-29 07-53-36.mp4');
    fs.writeFileSync(take, 'take2');
    const later = (name) => {
      const p = path.join(dir, name);
      fs.writeFileSync(p, 'x');
      fs.utimesSync(p, new Date(Date.now() + 60000), new Date(Date.now() + 60000));
    };
    later('2026-09-29 07-52-40.mp4.proxy.mp4');
    later('.DS_Store');
    later('notes.json');
    assert.equal(getNewestFileSample(dir).absPath, take);
    assert.equal(isRecordingFileName('2026-09-29 07-53-36.mkv'), true);
    assert.equal(isRecordingFileName('x.mp4.proxy.mp4'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('proxies are transcoded outside the camera folder', { timeout: 10000 }, async (t) => {
  const s = setup(t, { bytes: 2048, source: 'cam2', name: '2026-09-29 07-52-40.mp4' });
  const logPath = path.join(s.tempDir, 'ffmpeg.log');
  withEnv(t, { FFPROBE_BIN: FAKE, FAKE_PROBE_STREAMS: '2', FFMPEG_BIN: FAKE, FAKE_FFMPEG_LOG: logPath });
  const queue = s.queue(undefined);
  queue.enqueue({ filePath: s.filePath, source: 'cam2' });
  await waitFor(() => s.uploads.some((u) => u.key.startsWith('proxies/')), 8000);
  const proxyRun = fs.readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((args) => args.includes('libx264'));
  const out = proxyRun[proxyRun.length - 1];
  assert.equal(path.dirname(out), s.stateDir + '-proxy-tmp');
  assert.deepEqual(fs.readdirSync(s.camDir), ['2026-09-29 07-52-40.mp4']);
});
