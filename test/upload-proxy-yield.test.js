'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createUploadQueue } = require('../upload-queue');

const CAMERA_FILE_BYTES = Buffer.alloc(128 * 1024, 1);

async function waitFor(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out');
}

function setup(t, delayMs) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-mini-proxy-yield-'));
  const logPath = path.join(tempDir, 'ffmpeg.log');
  const previous = { FFMPEG_BIN: process.env.FFMPEG_BIN, FAKE_FFMPEG_LOG: process.env.FAKE_FFMPEG_LOG, FAKE_FFMPEG_DELAY_MS: process.env.FAKE_FFMPEG_DELAY_MS };
  process.env.FFMPEG_BIN = path.join(__dirname, 'fake-ffmpeg-slow.js');
  process.env.FAKE_FFMPEG_LOG = logPath;
  process.env.FAKE_FFMPEG_DELAY_MS = String(delayMs);
  t.after(() => {
    for (const [k, v] of Object.entries(previous)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  const lines = () => (fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean) : []);
  const file = (name) => { const p = path.join(tempDir, name); fs.writeFileSync(p, CAMERA_FILE_BYTES); return p; };
  return { tempDir, lines, file };
}

test('proxies are encoded one at a time', { timeout: 15000 }, async (t) => {
  const { tempDir, lines, file } = setup(t, 300);
  const uploads = [];
  const queue = createUploadQueue({
    stateDir: path.join(tempDir, 'state'), buildingId: 'bench-1', deleteAfterUpload: true, stabilityPollMs: 5, proxyPollMs: 20,
    uploader: async (input) => { uploads.push(input.key); return { key: input.key, sizeBytes: input.sizeBytes, partsUploaded: 1 }; },
  });
  const cams = ['cam1', 'cam2', 'cam3'].map((source) => { const p = file(source + '.mp4'); queue.enqueue({ filePath: p, source }); return p; });
  await waitFor(() => uploads.filter((k) => k.startsWith('proxies/')).length === 3, 12000);
  const order = lines().map((l) => l.split(' ')[0]);
  assert.deepEqual(order, ['start', 'end', 'start', 'end', 'start', 'end'], 'no two encodes overlap');
  await waitFor(() => cams.every((p) => !fs.existsSync(p)), 3000);
});

test('a take start stops a running proxy, which is redone after the take', { timeout: 15000 }, async (t) => {
  const { tempDir, lines, file } = setup(t, 1500);
  const uploads = [];
  let recording = false;
  const queue = createUploadQueue({
    stateDir: path.join(tempDir, 'state'), buildingId: 'bench-1', deleteAfterUpload: true, stabilityPollMs: 5, proxyPollMs: 20,
    isRecording: () => recording,
    uploader: async (input) => { uploads.push(input.key); return { key: input.key, sizeBytes: input.sizeBytes, partsUploaded: 1 }; },
  });
  const camPath = file('cam1.mp4');
  queue.enqueue({ filePath: camPath, source: 'cam1' });
  await waitFor(() => lines().length === 1, 5000);

  const held = await queue.holdProxies(200);
  recording = true;
  assert.equal(held.stopped, true);
  assert.ok(!fs.existsSync(camPath + '.proxy.mp4'), 'the half-made proxy is gone');
  assert.ok(fs.existsSync(camPath), 'the original is kept for the redo');
  assert.equal(queue.status().proxies_pending, 1);

  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(lines().length, 1, 'no encode starts while the take records');
  assert.ok(!uploads.includes('proxies/bench-1/cam1/cam1.mp4'));

  recording = false;
  await waitFor(() => uploads.includes('proxies/bench-1/cam1/cam1.mp4'), 8000);
  await waitFor(() => !fs.existsSync(camPath), 3000);
  assert.deepEqual(lines().map((l) => l.split(' ')[0]), ['start', 'start', 'end']);
  assert.equal(queue.status().proxies_pending, 0);
});

test('a take that starts without the hold still stops the proxy', { timeout: 15000 }, async (t) => {
  const { tempDir, lines, file } = setup(t, 3000);
  let recording = false;
  const queue = createUploadQueue({
    stateDir: path.join(tempDir, 'state'), buildingId: 'bench-1', stabilityPollMs: 5, proxyPollMs: 20,
    isRecording: () => recording,
    uploader: async (input) => ({ key: input.key, sizeBytes: input.sizeBytes, partsUploaded: 1 }),
  });
  const camPath = file('cam2.mp4');
  queue.enqueue({ filePath: camPath, source: 'cam2' });
  await waitFor(() => lines().length === 1, 5000);
  recording = true;
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.ok(!fs.existsSync(camPath + '.proxy.mp4'), 'encode was killed within about a second');
  assert.equal(queue.status().proxies_pending, 1);
  recording = false;
  await waitFor(() => queue.status().proxies_pending === 0, 8000);
});
