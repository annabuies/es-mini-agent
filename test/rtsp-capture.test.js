'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createRtspCapture, readRtspConfig, buildFfmpegArgs, redactUrls, obsStyleBaseName } = require('../rtsp-capture');

const FAKE = path.join(__dirname, 'fake-rtsp-ffmpeg.js');
const LOGIN_URL = (mode) => `rtsp://admin:hunter2@cam.invalid:554/${mode}`;

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-mini-rtsp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function quietLog() {
  const lines = [];
  return { lines, log: (...a) => lines.push(a.join(' ')), warn: (...a) => lines.push(a.join(' ')) };
}

function capture(t, env, extra = {}) {
  const recordDir = tempDir(t);
  const logger = quietLog();
  const cap = createRtspCapture({ env, recordDir, ffmpegBin: FAKE, log: logger, pollMs: 10, ...extra });
  t.after(() => cap.stop());
  return { cap, recordDir, logger };
}

test('RTSP capture is off unless RTSP_CAPTURE_SOURCES names cameras', () => {
  assert.deepEqual(readRtspConfig({}).sources, []);
  for (const off of ['off', 'none', '0', 'OFF', ' ']) assert.deepEqual(readRtspConfig({ RTSP_CAPTURE_SOURCES: off }).sources, []);
  const config = readRtspConfig({ RTSP_CAPTURE_SOURCES: 'cam1, cam3', RTSP_URL_CAM1: 'rtsp://a/1', RTSP_URL_CAM2: 'rtsp://b/1' });
  assert.deepEqual(config.sources, ['cam1', 'cam3']);
  assert.deepEqual(config.urls, { cam1: 'rtsp://a/1' });
  assert.equal(config.transport, 'tcp');
  assert.equal(config.audio, false);
  const cap = createRtspCapture({ config, recordDir: '/tmp/x', ffmpegBin: FAKE });
  assert.equal(cap.handles('cam1'), true);
  assert.equal(cap.handles('cam2'), false);
  assert.equal(cap.configProblem(['cam1', 'cam3']), 'cam3: RTSP_URL_CAM3 not set');
});

test('ffmpeg args stream-copy the camera video with no encoder and never overwrite', () => {
  const config = readRtspConfig({ RTSP_CAPTURE_SOURCES: 'cam1' });
  const args = buildFfmpegArgs(config, 'rtsp://cam/1', '/rec/cam1/x.mp4');
  const at = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(at('-c'), 'copy');
  assert.ok(!args.some((a) => /^-(c|codec):v$/.test(a)), 'no video encoder may be selected');
  assert.equal(at('-rtsp_transport'), 'tcp');
  assert.equal(at('-i'), 'rtsp://cam/1');
  assert.equal(at('-map'), '0:v:0');
  assert.ok(args.includes('-an'));
  assert.match(at('-movflags'), /frag_keyframe/);
  assert.equal(args[args.length - 2], '-n');
  assert.equal(args[args.length - 1], '/rec/cam1/x.mp4');

  const withAudio = buildFfmpegArgs(readRtspConfig({ RTSP_AUDIO: 'copy', RTSP_VIDEO_TAG: 'hvc1', RTSP_TRANSPORT: 'udp' }), 'rtsp://cam/1', '/o.mp4');
  assert.ok(withAudio.includes('0:a:0?'));
  assert.ok(!withAudio.includes('-an'));
  assert.equal(withAudio[withAudio.indexOf('-tag:v') + 1], 'hvc1');
  assert.equal(withAudio[withAudio.indexOf('-rtsp_transport') + 1], 'udp');
});

test('camera logins are redacted from anything the capture reports', () => {
  const url = LOGIN_URL('ok');
  assert.equal(redactUrls(`${url}: refused`, [url]), '<rtsp-url>: refused');
  assert.equal(redactUrls('open rtsp://u:p@10.0.0.9/2 failed', []), 'open rtsp://***@10.0.0.9/2 failed');
});

test('start writes into <recordDir>/<cam>/ with the OBS file name; stop sends q and returns the file', async (t) => {
  const { cap, recordDir } = capture(t, { RTSP_CAPTURE_SOURCES: 'cam1', RTSP_URL_CAM1: LOGIN_URL('ok') });
  const startedAt = new Date(2026, 8, 29, 8, 13, 5).getTime();
  const started = await cap.start(['cam1', 'cam2', 'cam3'], startedAt);
  assert.deepEqual(started, { ok: true, sources: ['cam1'] });
  assert.deepEqual(cap.activeSources(), ['cam1']);
  const expected = path.join(recordDir, 'cam1', '2026-09-29 08-13-05.mp4');
  assert.equal(obsStyleBaseName(startedAt), '2026-09-29 08-13-05');
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(cap.status().cam1.running, true);
  assert.ok(cap.status().cam1.bytes > 1024);

  const [result] = await cap.stop();
  assert.equal(result.ok, true);
  assert.equal(result.filePath, expected);
  assert.equal(result.error, null);
  assert.match(fs.readFileSync(expected, 'utf8'), /mfra-trailer$/, "ffmpeg got 'q' and finished the file");
  assert.deepEqual(cap.activeSources(), []);
});

test('a second take in the same second does not overwrite the first file', async (t) => {
  const { cap, recordDir } = capture(t, { RTSP_CAPTURE_SOURCES: 'cam1', RTSP_URL_CAM1: LOGIN_URL('ok') });
  const at = Date.now();
  await cap.start(['cam1'], at);
  const [first] = await cap.stop();
  await cap.start(['cam1'], at);
  const [second] = await cap.stop();
  assert.notEqual(first.filePath, second.filePath);
  assert.equal(fs.readdirSync(path.join(recordDir, 'cam1')).length, 2);
});

test('pause cannot stop a stream copy: the span is recorded instead', async (t) => {
  let clock = 1000;
  const { cap } = capture(t, { RTSP_CAPTURE_SOURCES: 'cam1', RTSP_URL_CAM1: LOGIN_URL('ok') }, { now: () => clock });
  await cap.start(['cam1'], Date.now());
  clock += 12000;
  cap.pause();
  clock += 5500;
  cap.resume();
  clock += 3000;
  const [result] = await cap.stop();
  assert.deepEqual(result.paused_spans_s, [[12, 17.5]]);
});

test('a refused camera fails the start, stops the cameras that did start, and leaks no login', async (t) => {
  const { cap, logger } = capture(t, {
    RTSP_CAPTURE_SOURCES: 'cam1,cam2',
    RTSP_URL_CAM1: LOGIN_URL('ok'),
    RTSP_URL_CAM2: LOGIN_URL('refuse'),
  });
  const result = await cap.start(['cam1', 'cam2'], Date.now());
  assert.equal(result.ok, false);
  assert.match(result.error, /^cam2: ffmpeg exited before writing \(code=1\)/);
  assert.match(result.error, /401 Unauthorized/);
  assert.doesNotMatch(result.error + logger.lines.join('\n'), /hunter2/);
  assert.deepEqual(cap.activeSources(), []);
});

test('a camera that never sends data times out the start and its ffmpeg is killed', async (t) => {
  const { cap } = capture(t, { RTSP_CAPTURE_SOURCES: 'cam1', RTSP_URL_CAM1: LOGIN_URL('silent'), RTSP_START_TIMEOUT_MS: '300' });
  const result = await cap.start(['cam1'], Date.now());
  assert.equal(result.ok, false);
  assert.match(result.error, /no data from camera within 300ms/);
  assert.deepEqual(cap.activeSources(), []);
});

test('a camera dropping mid-take is reported loudly and its partial file is still returned', async (t) => {
  const { cap, logger } = capture(t, { RTSP_CAPTURE_SOURCES: 'cam1', RTSP_URL_CAM1: LOGIN_URL('drop') });
  await cap.start(['cam1'], Date.now());
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(cap.status().cam1.died, true);
  assert.match(logger.lines.join('\n'), /cam1 ffmpeg exited mid-take/);
  const [result] = await cap.stop();
  assert.equal(result.ok, false);
  assert.match(result.error, /exited mid-take/);
  assert.ok(result.sizeBytes > 0);
  assert.ok(result.filePath);
});

test('an ffmpeg that ignores q and SIGINT is killed so stop always returns', async (t) => {
  const { cap } = capture(t, { RTSP_CAPTURE_SOURCES: 'cam1', RTSP_URL_CAM1: LOGIN_URL('ignore-q'), RTSP_STOP_TIMEOUT_MS: '200' });
  await cap.start(['cam1'], Date.now());
  const t0 = Date.now();
  const [result] = await cap.stop();
  assert.ok(Date.now() - t0 < 5000);
  assert.ok(result.sizeBytes > 0);
  assert.deepEqual(cap.activeSources(), []);
});

test('describe() reports configuration without any URL', () => {
  const cap = createRtspCapture({ env: { RTSP_CAPTURE_SOURCES: 'cam1,cam2', RTSP_URL_CAM1: LOGIN_URL('ok') }, recordDir: '/tmp/x', ffmpegBin: FAKE });
  const desc = cap.describe();
  assert.deepEqual(desc.cameras, { cam1: { url_configured: true }, cam2: { url_configured: false } });
  assert.equal(desc.enabled, true);
  assert.doesNotMatch(JSON.stringify(desc), /rtsp:|hunter2/);
});
