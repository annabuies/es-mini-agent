'use strict';

// Watch copies (Build 42, B1/B2/B3): the offset sign, the ffmpeg arguments, sync
// within a frame on synthetic media of known offset (real ffmpeg), the 4K
// originals byte-identical, and the upload queue's stream/ + mix uploads.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const test = require('node:test');
const { audioShiftFilter, computeDelayS, mixArgs, offsetFromTiming, planWatch, watchArgs } = require('../watch-rendition');
const { measureFlash } = require('../scripts/sync-measure');
const { createUploadQueue } = require('../upload-queue');

const HAVE_FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
const NEEDS_FFMPEG = { skip: !HAVE_FFMPEG && 'needs ffmpeg/ffprobe on PATH' };
const FLASH_FRAME = 150; // t = 5.000 s at 30 fps

function md5(file) {
  return crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
}

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-mini-watch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function waitFor(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out');
}

/**
 * A camera file (black, one white frame, frame 150) and a four-track master whose
 * beep is the same moment. offset_s is measured from the camera file's pts 0 (the
 * logged first_packet_at), so with the camera's first frame at pts cameraStartS
 * the flash is at pts 5 + cameraStartS, and the beep at 5 + cameraStartS - offsetS
 * in the master.
 */
function makeTake(dir, offsetS, cameraStartS) {
  const cam = path.join(dir, 'cam1.mp4');
  const master = path.join(dir, 'master.mp4');
  // Grain keeps the file over the upload queue's 64 KiB camera floor; the white frame is still the brightest.
  const camArgs = ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x202020:s=640x360:r=30:d=10',
    '-vf', `noise=alls=20:allf=t,drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='eq(n\\,${FLASH_FRAME})'`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '30', '-pix_fmt', 'yuv420p'];
  if (cameraStartS) camArgs.push('-output_ts_offset', String(cameraStartS));
  execFileSync('ffmpeg', camArgs.concat([cam]));
  const beep = 5 + (cameraStartS || 0) - offsetS;
  const noise = (seed) => `0.0001*(2*random(${seed})-1)`;
  const tracks = [`${noise(0)}+if(between(t\\,${beep}\\,${beep}+0.05)\\,0.5*sin(2*PI*1000*t)\\,0)`, noise(1), noise(2), noise(3)];
  const args = ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=gray:s=160x90:r=30:d=10'];
  for (const e of tracks) args.push('-f', 'lavfi', '-i', `aevalsrc='${e}|${e}':s=48000:d=10`);
  args.push('-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:a', '-map', '4:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-b:a', '160k', master);
  execFileSync('ffmpeg', args);
  return { cam, master };
}

test('offset sign: offset_s = master t=0 minus camera t=0 (camera first = positive = delay the mix)', () => {
  // Take 1: the cameras started 1.08 s before the master's audio.
  assert.equal(offsetFromTiming({ masterStartMs: 10_001_080, cameraStartMs: 10_000_000 }), 1.08);
  assert.equal(offsetFromTiming({ masterStartMs: 10_000_000, cameraStartMs: 10_000_500 }), -0.5);
  assert.equal(offsetFromTiming({ masterStartMs: 10_001_000, cameraStartMs: 10_000_000, adjustMs: 80 }), 1.08, 'a measured bias is added');
  assert.equal(offsetFromTiming({ masterStartMs: null, cameraStartMs: 1 }), null);
  assert.equal(computeDelayS({ offsetS: 1.08 }), 1.08);
  assert.equal(computeDelayS({ offsetS: 1.08, cameraStartS: 0.5 }), 0.58, 'ffmpeg starts the camera at its first frame');
  assert.equal(computeDelayS({ offsetS: 1.08, masterStartS: 0.02 }), 1.1);
});

test('the audio shift is whole samples: pad for a positive delay, trim for a negative one', () => {
  assert.equal(audioShiftFilter(1.08), 'adelay=delays=51840S:all=1');
  assert.equal(audioShiftFilter(-0.5), 'atrim=start_sample=24000,asetpts=PTS-STARTPTS');
  assert.equal(audioShiftFilter(0), 'anull');
  assert.equal(audioShiftFilter(0.00001), 'anull', 'under half a sample is no shift');
});

test('watch args: 1080p H.264 ~4 Mbps, 2 s keyframes, faststart, four mics mixed then delayed', () => {
  const args = watchArgs({ cameraPath: '/r/cam1/a.mp4', masterPath: '/r/master/a.mp4', masterTracks: 4, delayS: 1.08, outPath: '/r/cam1/a.mp4.watch.mp4' });
  const at = (flag) => args[args.indexOf(flag) + 1];
  assert.deepEqual(args.filter((a, i) => args[i - 1] === '-i'), ['/r/cam1/a.mp4', '/r/master/a.mp4']);
  assert.match(at('-filter_complex'), /^\[0:v:0\]scale=-2:1080:flags=bicubic,format=yuv420p\[vout\];\[1:a:0\]\[1:a:1\]\[1:a:2\]\[1:a:3\]amix=inputs=4:duration=longest:normalize=0,.*,adelay=delays=51840S:all=1,apad\[aout\]$/);
  assert.equal(at('-c:v'), 'libx264');
  assert.equal(at('-b:v'), '4000k');
  assert.equal(at('-force_key_frames'), 'expr:gte(t,n_forced*2)');
  assert.equal(at('-sc_threshold'), '0');
  assert.equal(at('-c:a'), 'aac');
  assert.equal(at('-ac'), '2');
  assert.ok(args.includes('-shortest'));
  assert.equal(at('-movflags'), '+faststart');
  assert.equal(args[args.length - 1], '/r/cam1/a.mp4.watch.mp4');
  const videoOnly = watchArgs({ cameraPath: '/c.mp4', masterPath: null, masterTracks: 4, delayS: 1, outPath: '/o.mp4' });
  assert.equal(videoOnly.filter((a) => a === '-i').length, 1);
  assert.ok(!videoOnly.includes('-c:a'));
  const mix = mixArgs({ masterPath: '/m.mp4', masterTracks: 4, outPath: '/m-mix.m4a' });
  assert.match(mix[mix.indexOf('-filter_complex') + 1], /amix=inputs=4:duration=longest:normalize=0/);
  assert.doesNotMatch(mix.join(' '), /adelay|atrim/, 'the mix stays on the master timeline');
});

for (const [label, offsetS, cameraStartS] of [['+1.08 s (Take 1)', 1.08, 0], ['-0.50 s (camera after master)', -0.5, 0], ['+0.80 s, camera first pts 0.5 s', 0.8, 0.5], ['+3.25 s', 3.25, 0]]) {
  test('sync on synthetic media, offset ' + label + ': flash frame and beep within one frame; originals untouched', NEEDS_FFMPEG, async (t) => {
    const dir = tmp(t);
    const { cam, master } = makeTake(dir, offsetS, cameraStartS);
    const before = [md5(cam), md5(master)];
    const plan = await planWatch({ cameraPath: cam, masterPath: master, offsetS }, { ffprobeBin: 'ffprobe' });
    assert.equal(plan.audio, 'mix');
    assert.equal(plan.masterTracks, 4);
    const out = path.join(dir, 'watch.mp4');
    execFileSync('ffmpeg', watchArgs({ cameraPath: cam, masterPath: master, masterTracks: plan.masterTracks, delayS: plan.delayS, outPath: out }));
    const m = await measureFlash(out);
    assert.equal(m.flash_frame, FLASH_FRAME, 'the video timeline is the camera\'s');
    assert.ok(Math.abs(m.error_frames) <= 1, 'beep vs flash ' + m.error_frames + ' frames (' + m.error_s + ' s)');
    assert.deepEqual([md5(cam), md5(master)], before, '4K original and master byte-identical');
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,height,channels:format=duration', '-of', 'json', out]).toString());
    assert.deepEqual(probe.streams.map((s) => [s.codec_type, s.codec_name]), [['video', 'h264'], ['audio', 'aac']]);
    assert.equal(probe.streams[0].height, 1080);
    assert.equal(probe.streams[1].channels, 2);
    assert.ok(Math.abs(Number(probe.format.duration) - 10) < 0.1, 'as long as the camera: ' + probe.format.duration);
    // faststart: the moov box comes before mdat.
    const head = fs.readFileSync(out).subarray(0, 4096).toString('latin1');
    assert.ok(head.indexOf('moov') > 0 && (head.indexOf('mdat') < 0 || head.indexOf('moov') < head.indexOf('mdat')), 'moov first');
  });
}

test('upload queue: a camera upload makes its watch copy (stream/ with webhook, proxies/ without), the mix uploads, originals stay byte-identical, the master waits for every angle', NEEDS_FFMPEG, async (t) => {
  const dir = tmp(t);
  const { cam, master } = makeTake(dir, 1.08, 0);
  const cam2 = path.join(dir, 'cam2.mp4');
  fs.copyFileSync(cam, cam2);
  const before = { cam: md5(cam), cam2: md5(cam2), master: md5(master) };
  const uploads = [];
  const contents = new Map();
  let releaseCam2 = null;
  const cam2Gate = new Promise((resolve) => { releaseCam2 = resolve; });
  const queue = createUploadQueue({
    stateDir: path.join(dir, 'state'), buildingId: 'bench-1', stabilityPollMs: 5, proxyPollMs: 20,
    audioSplit: true, deleteAfterUpload: true, webhookUrl: 'https://hook.example/upload',
    uploader: async (input) => {
      // Hold cam2's original upload so the master is confirmed while a watch copy is still due.
      if (input.key === 'recordings/bench-1/cam2/cam2.mp4') await cam2Gate;
      uploads.push(input);
      contents.set(input.key, md5(input.filePath));
      if (input.key === 'stream/bench-1/cam1/cam1.mp4') fs.copyFileSync(input.filePath, path.join(dir, 'kept-watch.mp4'));
      return { key: input.key, sizeBytes: input.sizeBytes, partsUploaded: 1 };
    },
  });
  const recordedAt = '2026-10-19T19:30:22.000Z';
  const camMeta = { rendition: 'original', recorded_at: recordedAt, duration_s: 10, take_health: 'ok', capture_mode: 'rtsp' };
  // The stop path enqueues every camera before the master; cam2 here is queued after it so
  // its upload can be held while the master is confirmed and split.
  queue.enqueue({ filePath: cam, source: 'cam1', sessionRef: 'sess_1', meta: camMeta, watch: { masterPath: master, offsetS: 1.08, recordedAt } });
  queue.enqueue({ filePath: master, source: 'master', sessionRef: 'sess_1', meta: { rendition: 'original', recorded_at: recordedAt, duration_s: 10, audio_health: { level: 'ok', codes: [], tracks: [{ index: 0, label: 'Mic 1', level: 'ok', codes: [] }], identical_pairs: [] } } });
  queue.enqueue({ filePath: cam2, source: 'cam2', sessionRef: 'sess_1', meta: camMeta, watch: { masterPath: master, offsetS: 1.08, recordedAt } });
  await waitFor(() => uploads.some((u) => u.key === 'stream/bench-1/cam1/cam1.mp4'), 120000);
  await waitFor(() => uploads.some((u) => u.key === 'recordings/bench-1/master/master.mp4') && fs.existsSync(path.join(dir, 'master-mix.m4a')), 60000);
  await waitFor(() => !fs.existsSync(cam), 10000);
  // cam2's angle is still due: the master stays on the Mini though uploaded and split.
  assert.ok(fs.existsSync(master), 'master kept until every angle\'s watch copy is made');
  releaseCam2();
  await waitFor(() => uploads.some((u) => u.key === 'stream/bench-1/cam2/cam2.mp4') && uploads.some((u) => u.key === 'audio/bench-1/master-mix.m4a'), 120000);
  await waitFor(() => !fs.existsSync(master) && !fs.existsSync(cam2), 10000);

  const byKey = Object.fromEntries(uploads.map((u) => [u.key, u]));
  // Originals were uploaded byte-identical to what was recorded.
  assert.equal(contents.get('recordings/bench-1/cam1/cam1.mp4'), before.cam);
  assert.equal(contents.get('recordings/bench-1/cam2/cam2.mp4'), before.cam2);
  assert.equal(contents.get('recordings/bench-1/master/master.mp4'), before.master);
  const watch = byKey['stream/bench-1/cam1/cam1.mp4'];
  assert.equal(watch.webhookUrl, 'https://hook.example/upload');
  assert.deepEqual(
    { kind: watch.webhookExtra.kind, source: watch.webhookExtra.source, rendition: watch.webhookExtra.rendition, recorded_at: watch.webhookExtra.recorded_at, offset_s: watch.webhookExtra.offset_s, audio: watch.webhookExtra.audio, original_key: watch.webhookExtra.original_key, session_ref: watch.webhookExtra.session_ref, building_id: watch.webhookExtra.building_id },
    { kind: 'video', source: 'cam1', rendition: 'watch', recorded_at: recordedAt, offset_s: 1.08, audio: 'mix', original_key: 'recordings/bench-1/cam1/cam1.mp4', session_ref: 'sess_1', building_id: 'bench-1' });
  assert.ok(Math.abs(watch.webhookExtra.duration_s - 10) < 0.1, 'duration_s of the watch copy: ' + watch.webhookExtra.duration_s);
  const proxy = byKey['proxies/bench-1/cam1/cam1.mp4'];
  assert.equal(proxy.webhookUrl, undefined, 'the proxies/ copy is not registered');
  assert.equal(contents.get('proxies/bench-1/cam1/cam1.mp4'), contents.get('stream/bench-1/cam1/cam1.mp4'), 'same bytes as the watch copy');
  const original = byKey['recordings/bench-1/cam1/cam1.mp4'].webhookExtra;
  assert.deepEqual([original.kind, original.rendition, original.recorded_at, original.duration_s], ['video', 'original', recordedAt, 10]);
  const mix = byKey['audio/bench-1/master-mix.m4a'].webhookExtra;
  assert.deepEqual([mix.kind, mix.source, mix.rendition, mix.recorded_at, mix.duration_s, mix.audio_level], ['audio', 'mix', 'mix', recordedAt, 10, 'ok']);
  const mic1 = byKey['recordings/bench-1/audio/master-mic1.m4a'].webhookExtra;
  assert.deepEqual([mic1.kind, mic1.source, mic1.rendition, mic1.recorded_at, mic1.duration_s, mic1.audio_level], ['audio', 'mic1', 'mic', recordedAt, 10, 'ok']);
  assert.deepEqual(mic1.audio_health, { index: 0, label: 'Mic 1', level: 'ok', codes: [] });
  // The uploaded watch copy itself is in sync.
  const m = await measureFlash(path.join(dir, 'kept-watch.mp4'));
  assert.ok(Math.abs(m.error_frames) <= 1, 'uploaded watch copy: ' + m.error_frames + ' frames');
  assert.equal(queue.status().proxies_pending, 0);
});
