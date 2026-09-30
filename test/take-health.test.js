'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { checkTake, classifyCamera, slug } = require('../take-health');

const video = (durationS) => ({ ok: true, videoStreams: 1, streams: 1, durationS });

test('a camera verdict comes from the file: missing, stub, no video, short, ok', () => {
  assert.deepEqual(classifyCamera({ filePath: null, sizeBytes: null, captureError: 'rtsp_no_data' }), { health: 'missing', reason: 'rtsp_no_data', size_bytes: 0 });
  assert.deepEqual(classifyCamera({ filePath: null, sizeBytes: null }), { health: 'missing', reason: 'no_file', size_bytes: 0 });
  assert.equal(classifyCamera({ filePath: '/x', sizeBytes: 1737, probe: null }).reason, 'too_small');
  assert.equal(classifyCamera({ filePath: '/x', sizeBytes: 0, probe: null }).reason, 'empty_file');
  assert.equal(classifyCamera({ filePath: '/x', sizeBytes: 5e6, probe: { ok: true, videoStreams: 0 } }).reason, 'no_video_stream');
  assert.equal(classifyCamera({ filePath: '/x', sizeBytes: 5e6, probe: { ok: true, unreadable: true, videoStreams: 0 } }).reason, 'unreadable_file');
  // Sep 29 take 6: cam1 41.14 s against a 49.24 s master.
  assert.deepEqual(classifyCamera({ filePath: '/x', sizeBytes: 5e6, probe: video(41.14), masterDurationS: 49.24 }),
    { size_bytes: 5e6, duration_s: 41.1, master_duration_s: 49.2, health: 'short', reason: 'shorter_than_master', short_by_s: 8.1 });
  // Clean RTSP runs a little longer than the master, and a 1.6 s shortfall is within tolerance.
  assert.equal(classifyCamera({ filePath: '/x', sizeBytes: 5e6, probe: video(36.3), masterDurationS: 34.7 }).health, 'ok');
  assert.equal(classifyCamera({ filePath: '/x', sizeBytes: 5e6, probe: video(47.65), masterDurationS: 49.24 }).health, 'ok');
  assert.equal(classifyCamera({ filePath: '/x', sizeBytes: 5e6, probe: video(30), gapS: 4.2 }).reason, 'footage_gap');
  assert.equal(classifyCamera({ filePath: '/x', sizeBytes: 5e6, probe: { ok: false, error: 'ffprobe_unavailable' } }).health, 'unverified');
  assert.equal(slug('RTSP Concat-Failed!'), 'rtsp_concat_failed');
});

test('checkTake probes real files with ffprobe when it is installed', { skip: (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return false; } catch (_) { return 'ffmpeg not installed'; } })() }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-mini-health-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const make = (name, seconds) => {
    const file = path.join(dir, name);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-t', String(seconds), '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '2M', file]);
    return file;
  };
  const master = make('master.mp4', 10);
  const good = make('cam1.mp4', 10.5);
  const short = make('cam2.mp4', 6);
  const stub = path.join(dir, 'cam3.mp4');
  fs.writeFileSync(stub, Buffer.alloc(100 * 1024, 1)); // big enough to probe, no video in it
  const result = await checkTake({
    masterPath: master,
    cameras: [{ source: 'cam1', filePath: good }, { source: 'cam2', filePath: short }, { source: 'cam3', filePath: stub }, { source: 'cam4', filePath: null }],
  }, { ffprobeBin: 'ffprobe' });
  assert.equal(result.master.health, 'ok');
  assert.equal(result.cameras.cam1.health, 'ok');
  assert.equal(result.cameras.cam2.health, 'short');
  assert.equal(result.cameras.cam3.health, 'failed');
  assert.equal(result.cameras.cam4.health, 'missing');
  assert.equal(result.health, 'failed');
});
