'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createRtspCapture, killOrphanedCaptures, rtspUrlForCamera, isRtspCamera, redactUrl, takeStamp } = require('../rtsp-capture');
const { getNewestFileSample } = require('../obs-control');

const FAKE = path.join(__dirname, 'fake-ffmpeg-rtsp.js');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-mini-rtsp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function withEnv(t, vars) {
  const before = {};
  for (const [k, v] of Object.entries(vars)) {
    before[k] = process.env[k];
    process.env[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

function capture(extra) {
  return createRtspCapture(Object.assign({ ffmpegBin: FAKE, restartDelayMs: 50, stopQuitMs: 2000 }, extra || {}));
}

test('camera config: RTSP only when capture is "rtsp"; URL defaults to :554/1 and honours overrides', () => {
  assert.equal(isRtspCamera({ name: 'cam1', host: '10.0.0.5' }), false);
  assert.equal(isRtspCamera({ name: 'cam1', host: '10.0.0.5', capture: 'RTSP' }), true);
  assert.equal(rtspUrlForCamera({ host: '10.0.0.5' }), 'rtsp://10.0.0.5:554/1');
  assert.equal(rtspUrlForCamera({ host: '10.0.0.5:80' }), 'rtsp://10.0.0.5:554/1');
  assert.equal(rtspUrlForCamera({ host: '10.0.0.5', rtsp_path: '2', rtsp_port: 8554 }), 'rtsp://10.0.0.5:8554/2');
  assert.equal(rtspUrlForCamera({ host: '10.0.0.5', rtsp_url: 'rtsp://u:p@10.0.0.5/live' }), 'rtsp://u:p@10.0.0.5/live');
  assert.equal(rtspUrlForCamera({ host: 'bad host;rm' }), null);
  assert.equal(redactUrl('rtsp://u:p@10.0.0.5/live'), 'rtsp://***@10.0.0.5/live');
  assert.equal(takeStamp(new Date(2026, 8, 29, 8, 13, 5)), '2026-09-29 08-13-05');
});

test('one uninterrupted take becomes <finalBase>.mp4, with no parts left behind', { timeout: 10000 }, async (t) => {
  const dir = tempDir(t);
  const cap = capture();
  assert.deepEqual(await cap.start({ source: 'cam1', url: 'rtsp://10.0.0.5:554/1', dir }), { ok: true });
  assert.equal(cap.active('cam1'), true);
  await sleep(300);
  const out = await cap.stop('cam1', { finalBase: '2026-09-29 08-13-05' });
  assert.equal(out.ok, true);
  assert.equal(out.filePath, path.join(dir, '2026-09-29 08-13-05.mp4'));
  assert.ok(out.sizeBytes > 64 * 1024, 'real footage size');
  assert.equal(out.segments, 1);
  assert.deepEqual(fs.readdirSync(dir), ['2026-09-29 08-13-05.mp4']);
  assert.equal(cap.active('cam1'), false);
});

test('pause ends a segment, resume starts the next, stop joins them into one file', { timeout: 10000 }, async (t) => {
  const dir = tempDir(t);
  const log = path.join(dir, 'ffmpeg.log');
  withEnv(t, { FAKE_FFMPEG_LOG: log });
  const cap = capture();
  await cap.start({ source: 'cam2', url: 'rtsp://10.0.0.6:554/1', dir });
  await sleep(250);
  await cap.pause('cam2');
  assert.equal(cap.describe().cam2.paused, true);
  assert.equal(cap.describe().cam2.writing, false);
  await sleep(150);
  await cap.resume('cam2');
  await sleep(250);
  const out = await cap.stop('cam2', { finalBase: 'take' });
  assert.equal(out.ok, true);
  assert.equal(out.segments, 2);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.mp4')), ['take.mp4']);
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(calls.filter((a) => a.includes('concat')).length, 1);
  const record = calls.find((a) => a.includes('rtsp://10.0.0.6:554/1'));
  assert.deepEqual(record.slice(record.indexOf('-rtsp_transport'), record.indexOf('-rtsp_transport') + 2), ['-rtsp_transport', 'tcp']);
  assert.ok(record.includes('-c:v') && record[record.indexOf('-c:v') + 1] === 'copy', 'video is stream-copied');
});

test('a camera that refuses the connection fails the start cleanly and is never retried', { timeout: 10000 }, async (t) => {
  const dir = tempDir(t);
  const log = path.join(dir, 'ffmpeg.log');
  withEnv(t, { FAKE_RTSP_FAIL: '1', FAKE_FFMPEG_LOG: log });
  const cap = capture();
  const out = await cap.start({ source: 'cam1', url: 'rtsp://10.0.0.5:554/1', dir });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'rtsp_start_failed');
  assert.match(out.detail, /Connection refused/);
  await sleep(300); // longer than restartDelayMs
  assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 1, 'no reconnect after a failed start');
  assert.equal(cap.active('cam1'), false);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.mp4')), []);
});

test('a dropped camera reconnects as a new segment and the take keeps both halves', { timeout: 10000 }, async (t) => {
  const dir = tempDir(t);
  withEnv(t, { FAKE_RTSP_DROP_ONCE: path.join(dir, 'dropped.marker') });
  const cap = capture();
  await cap.start({ source: 'cam3', url: 'rtsp://10.0.0.7:554/1', dir });
  await sleep(700);
  const out = await cap.stop('cam3', { finalBase: 'take' });
  assert.equal(out.ok, true);
  assert.equal(out.restarts, 1);
  assert.equal(out.segments, 2);
  assert.ok(fs.existsSync(path.join(dir, 'take.mp4')));
});

test('a camera that never sends a frame gives no file, not a stub', { timeout: 10000 }, async (t) => {
  const dir = tempDir(t);
  withEnv(t, { FAKE_RTSP_NO_FRAMES: '1' });
  const cap = capture();
  assert.equal((await cap.start({ source: 'cam1', url: 'rtsp://10.0.0.5:554/1', dir })).ok, true);
  await sleep(200);
  const out = await cap.stop('cam1', { finalBase: 'take' });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'rtsp_no_data');
  assert.equal(out.filePath, null);
});

test('newest-file lookup skips proxy temps and RTSP parts', (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, '2026-09-29 07-53-36.mp4'), 'take2');
  const later = Date.now() / 1000 + 5;
  for (const name of ['2026-09-29 07-52-40.mp4.proxy.mp4', '2026-09-29 07-53-36 rtsp-part1.mp4']) {
    fs.writeFileSync(path.join(dir, name), 'x');
    fs.utimesSync(path.join(dir, name), later, later);
  }
  assert.equal(getNewestFileSample(dir).name, '2026-09-29 07-53-36.mp4');
});

test('killAll ends live captures (the agent exit hook), so ffmpeg is never orphaned', { timeout: 10000 }, async (t) => {
  const dir = tempDir(t);
  const cap = capture();
  await cap.start({ source: 'cam1', url: 'rtsp://10.0.0.5:554/1', dir });
  const part = fs.readdirSync(dir).find((f) => / rtsp-part1\.mp4$/.test(f));
  cap.killAll();
  await sleep(300);
  const size = fs.statSync(path.join(dir, part)).size;
  await sleep(300);
  assert.equal(fs.statSync(path.join(dir, part)).size, size, 'nothing is writing any more');
});

test('boot cleanup kills a capture left by a dead agent under this record dir only', { timeout: 10000 }, async (t) => {
  const mine = tempDir(t);
  const other = tempDir(t);
  const launch = (dir) => {
    fs.mkdirSync(path.join(dir, 'cam1'), { recursive: true });
    const child = spawn(FAKE, ['-i', 'rtsp://10.0.0.5:554/1', path.join(dir, 'cam1', '2026-09-29 08-13-05 rtsp-part1.mp4')], { stdio: ['pipe', 'ignore', 'ignore'] });
    t.after(() => { try { child.kill('SIGKILL'); } catch (_) {} });
    return child;
  };
  const orphan = launch(mine);
  const bystander = launch(other);
  await sleep(200);
  const exited = new Promise((resolve) => orphan.once('exit', resolve));
  assert.equal(killOrphanedCaptures(mine), true);
  await exited;
  assert.equal(bystander.exitCode, null, 'a capture under another record dir is left alone');
  assert.equal(killOrphanedCaptures(mine), false, 'nothing left to kill');
});

test('a camera that connects but sends nothing fails the start within the probe window, and ffmpeg is killed', { timeout: 10000 }, async (t) => {
  const dir = tempDir(t);
  withEnv(t, { FAKE_RTSP_SILENT: '1' });
  const cap = capture({ startProbeMs: 400 });
  const began = Date.now();
  const out = await cap.start({ source: 'cam1', url: 'rtsp://10.0.0.5:554/1', dir });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'rtsp_start_failed');
  assert.match(out.detail, /no data from the camera/);
  assert.ok(Date.now() - began < 2000, 'no 6 s wait on a q that is never read');
  assert.equal(cap.active('cam1'), false);
});
