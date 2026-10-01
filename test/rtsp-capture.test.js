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
  const started = await cap.start({ source: 'cam1', url: 'rtsp://10.0.0.5:554/1', dir });
  assert.equal(started.ok, true);
  assert.ok(started.video_after_ms >= 0 && started.video_after_ms < 2000, 'reports how long video took');
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

test('a camera that writes only a header (stalled mux, no video) fails the start', { timeout: 10000 }, async (t) => {
  const dir = tempDir(t);
  withEnv(t, { FAKE_RTSP_NO_FRAMES: '1' });
  const cap = capture({ startProbeMs: 400 });
  const out = await cap.start({ source: 'cam1', url: 'rtsp://10.0.0.5:554/1', dir });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'rtsp_start_failed');
  assert.equal(cap.active('cam1'), false);
});

test('camera audio is left out unless the camera opts in, and is then copied, never encoded', () => {
  const { recordArgs } = require('../rtsp-capture');
  const off = recordArgs('rtsp://10.0.0.5:554/1', '/x/out.mp4');
  assert.ok(off.includes('-an'));
  assert.ok(!off.includes('0:a:0?'));
  const on = recordArgs('rtsp://10.0.0.5:554/1', '/x/out.mp4', { audio: true });
  assert.deepEqual(on.slice(on.indexOf('0:a:0?') - 1, on.indexOf('0:a:0?') + 3), ['-map', '0:a:0?', '-c:a', 'copy']);
  assert.ok(!on.includes('aac'));
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
  assert.match(out.detail, /no video from the camera/);
  assert.ok(Date.now() - began < 2000, 'no 6 s wait on a q that is never read');
  assert.equal(cap.active('cam1'), false);
});

test('start is up once video is muxed, before a fragment reaches the disk (a long GOP no longer falls back)', { timeout: 10000 }, async (t) => {
  const dir = tempDir(t);
  withEnv(t, { FAKE_RTSP_PROGRESS_ONLY: '1' });
  const cap = capture({ startProbeMs: 1500 });
  const out = await cap.start({ source: 'cam1', url: 'rtsp://10.0.0.5:554/1', dir });
  assert.equal(out.ok, true);
  assert.ok(out.video_after_ms < 1000);
  assert.equal(cap.describe().cam1.writing, true, 'muxed video counts as writing until the first fragment is due');
  await cap.stop('cam1', { finalBase: 'take' });
});

test('a start failure says whether the camera connected, and never logs a password', { timeout: 10000 }, async (t) => {
  const dir = tempDir(t);
  withEnv(t, { FAKE_RTSP_NO_FRAMES: '1' });
  const warnings = [];
  const previousWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  t.after(() => { console.warn = previousWarn; });
  const cap = capture({ startProbeMs: 400 });
  const out = await cap.start({ source: 'cam1', url: 'rtsp://admin:hunter2@10.0.0.5:554/1', dir });
  assert.equal(out.ok, false);
  assert.match(out.detail, /connected \(stream header written\) but no video packets within 0\.4 s/);
  assert.doesNotMatch(warnings.join('\n') + out.detail, /hunter2/);
  assert.match(warnings.join('\n'), /rtsp:\/\/\*\*\*@10\.0\.0\.5/);
  assert.equal(redactUrl('a rtsp://u:p@h/1 b rtsp://x:y@h/2'), 'a rtsp://***@h/1 b rtsp://***@h/2');
});

test('a reconnect reports the footage it lost, in the stop result and the log', { timeout: 10000 }, async (t) => {
  const dir = tempDir(t);
  withEnv(t, { FAKE_RTSP_DROP_ONCE: path.join(dir, 'dropped.marker') });
  const warnings = [];
  const previousWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  t.after(() => { console.warn = previousWarn; });
  const cap = capture({ restartDelayMs: 300 });
  await cap.start({ source: 'cam3', url: 'rtsp://10.0.0.7:554/1', dir });
  await sleep(1200);
  const out = await cap.stop('cam3', { finalBase: 'take' });
  assert.equal(out.restarts, 1, warnings.join('\n'));
  assert.ok(out.gap_ms >= 300 && out.gap_ms < 1500, 'gap covers the restart delay and reconnect: ' + out.gap_ms);
  assert.match(warnings.join('\n'), /cam3 video back after \d\.\d s \(segment 2, reconnect\)/);
  assert.match(warnings.join('\n'), /cam3 saved take\.mp4 .* reconnects=1 lost=\d\.\d s/);
});

test('a resume reports how long video took to come back, without counting the pause itself', { timeout: 10000 }, async (t) => {
  const dir = tempDir(t);
  const cap = capture();
  await cap.start({ source: 'cam2', url: 'rtsp://10.0.0.6:554/1', dir });
  await sleep(200);
  await cap.pause('cam2');
  await sleep(600);
  await cap.resume('cam2');
  await sleep(300);
  const out = await cap.stop('cam2', { finalBase: 'take' });
  assert.equal(out.segments, 2);
  assert.ok(out.gap_ms < 500, 'only the reconnect wait, not the 600 ms pause: ' + out.gap_ms);
});

function captureLogs(t) {
  const logs = { info: [], warn: [] };
  const previousLog = console.log;
  const previousWarn = console.warn;
  console.log = (...args) => { logs.info.push(args.join(' ')); };
  console.warn = (...args) => { logs.warn.push(args.join(' ')); };
  t.after(() => { console.log = previousLog; console.warn = previousWarn; });
  return logs;
}

test('a normal pause (video back ~1.1 s after resume) is info, not lost footage and not a WARN', { timeout: 10000 }, async (t) => {
  const dir = tempDir(t);
  withEnv(t, { FAKE_RTSP_VIDEO_DELAY_MS: '1100' });
  const logs = captureLogs(t);
  const cap = capture();
  assert.equal((await cap.start({ source: 'cam2', url: 'rtsp://10.0.0.6:554/1', dir })).ok, true);
  await sleep(200);
  await cap.pause('cam2');
  await sleep(300);
  await cap.resume('cam2');
  await sleep(600);
  assert.equal(cap.describe().cam2.gap_ms, 0, 'waiting for video after a resume is not lost footage');
  await sleep(1000);
  const out = await cap.stop('cam2', { finalBase: 'take' });
  assert.equal(out.ok, true);
  assert.equal(out.gap_ms, 0);
  assert.ok(out.resume_wait_ms >= 1000 && out.resume_wait_ms < 2500, 'resume wait measured: ' + out.resume_wait_ms);
  assert.deepEqual(logs.warn, []);
  assert.match(logs.info.join('\n'), /cam2 video back after 1\.\d s \(segment 2, resume\)/);
  assert.match(logs.info.join('\n'), /cam2 saved take\.mp4 .* reconnects=0 lost=0\.0 s resume_wait=1\.\d s stalls=0/);
});

test('a resume slower than the grace window is lost footage and WARNs', { timeout: 10000 }, async (t) => {
  const dir = tempDir(t);
  const logs = captureLogs(t);
  const cap = capture({ resumeGraceMs: 300 });
  await cap.start({ source: 'cam2', url: 'rtsp://10.0.0.6:554/1', dir });
  await sleep(200);
  await cap.pause('cam2');
  withEnv(t, { FAKE_RTSP_VIDEO_DELAY_MS: '1200' });
  await cap.resume('cam2');
  await sleep(1700);
  const out = await cap.stop('cam2', { finalBase: 'take' });
  assert.ok(out.gap_ms >= 1200, 'slow resume counted as lost: ' + out.gap_ms);
  assert.equal(out.resume_wait_ms, 0);
  const warnings = logs.warn.join('\n');
  assert.match(warnings, /cam2 video back after 1\.\d s \(segment 2, resume\); a resume is expected within 0\.3 s, counted as lost/);
  assert.match(warnings, /WARN cam2 saved take\.mp4 .* lost=1\.\d s resume_wait=0\.0 s/);
});

test('a resume that drops before any video is an outage counted from the resume, and WARNs', { timeout: 10000 }, async (t) => {
  const dir = tempDir(t);
  const logs = captureLogs(t);
  const cap = capture();
  await cap.start({ source: 'cam2', url: 'rtsp://10.0.0.6:554/1', dir });
  await sleep(200);
  await cap.pause('cam2');
  withEnv(t, { FAKE_RTSP_DROP_ONCE: path.join(dir, 'dropped.marker'), FAKE_RTSP_DROP_AFTER_MS: '600', FAKE_RTSP_VIDEO_DELAY_MS: '1000' });
  await cap.resume('cam2');
  await sleep(2300);
  const out = await cap.stop('cam2', { finalBase: 'take' });
  assert.equal(out.restarts, 1, logs.warn.join('\n'));
  // Resume -> drop at 0.6 s -> reconnect -> video 1 s later: all of it is missing.
  assert.ok(out.gap_ms >= 1600, 'outage counted from the resume, not from the drop: ' + out.gap_ms);
  assert.equal(out.resume_wait_ms, 0);
  const warnings = logs.warn.join('\n');
  assert.match(warnings, /cam2 ffmpeg exited mid-take/);
  assert.match(warnings, /cam2 video back after 1\.\d s \(segment 3, reconnect\)/);
  assert.match(warnings, /WARN cam2 saved take\.mp4 .* reconnects=1 lost=1\.\d s/);
});

test('ffmpeg running with no new video on disk is reported as a stall', { timeout: 10000 }, async (t) => {
  const dir = tempDir(t);
  withEnv(t, { FAKE_RTSP_PROGRESS_ONLY: '1' });
  const warnings = [];
  const previousWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  t.after(() => { console.warn = previousWarn; });
  const cap = capture({ stallWarnMs: 300 });
  await cap.start({ source: 'cam1', url: 'rtsp://10.0.0.5:554/1', dir });
  await sleep(1600);
  assert.equal(cap.describe().cam1.stalled, true);
  const out = await cap.stop('cam1', { finalBase: 'take' });
  assert.equal(out.stalls, 1);
  assert.match(warnings.join('\n'), /cam1 STALLED: no new video on disk/);
});

test('fragments are cut every 0.5 s as well as at keyframes', () => {
  const { recordArgs } = require('../rtsp-capture');
  const args = recordArgs('rtsp://10.0.0.5:554/1', '/tmp/x.mp4');
  assert.equal(args[args.indexOf('-frag_duration') + 1], '500000');
  assert.match(args[args.indexOf('-movflags') + 1], /frag_keyframe/);
  assert.equal(args[args.length - 1], '/tmp/x.mp4');
});

test('a join that exits 0 but comes out short keeps every part instead of losing the later ones', { timeout: 10000 }, async (t) => {
  const dir = tempDir(t);
  withEnv(t, { FAKE_RTSP_DROP_ONCE: path.join(dir, 'dropped.marker'), FAKE_CONCAT_SHORT: '1' });
  const cap = capture();
  await cap.start({ source: 'cam2', url: 'rtsp://10.0.0.6:554/1', dir });
  await sleep(700);
  const out = await cap.stop('cam2', { finalBase: 'take' });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'rtsp_concat_failed');
  assert.equal(out.keptParts.length, 2);
  for (const p of out.keptParts) assert.ok(fs.existsSync(p));
  assert.equal(fs.existsSync(path.join(dir, 'take.mp4')), false);
});
