'use strict';

// Post-take audio health (Build 42, A3/A4) on synthetic four-track masters made
// with the local ffmpeg, and on the real Take 1 master when it is on this machine.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const test = require('node:test');
const { analyzeMasterAudio, createTrackAnalyzer, describeAudioHealth, startMasterAudioAnalysis, summarizeTake, summarizeTrack } = require('../audio-health');

const HAVE_FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
const NEEDS_FFMPEG = { skip: !HAVE_FFMPEG && 'needs ffmpeg/ffprobe on PATH' };
const TAKE1_DIR = process.env.B42_MEDIA_DIR || '/private/tmp/claude-501/b42-media/s3';
const TAKE1 = path.join(TAKE1_DIR, 'master', '2026-10-19 15-30-22.mp4');
const REF = path.join(TAKE1_DIR, 'master-ref', '2026-09-26 15-04-24.mp4');
const NEEDS_TAKE1 = { skip: !(HAVE_FFMPEG && fs.existsSync(TAKE1) && fs.existsSync(REF)) && 'Take 1 media not on this machine' };

// Speech-like: a tone gated on and off over a -70 dBFS noise floor.
const voice = (hz, seed) => `0.0003*(2*random(${seed})-1)+0.1*sin(2*PI*${hz}*t)*gt(sin(2*PI*0.4*t+${seed}),0)`;

/** A master like OBS's: a small video track plus one stereo AAC track per expression. */
function makeMaster(dir, name, exprs, seconds) {
  const file = path.join(dir, name);
  const args = ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=gray:s=160x90:r=10:d=${seconds}`];
  for (const e of exprs) args.push('-f', 'lavfi', '-i', `aevalsrc='${e}|${e}':s=48000:d=${seconds}`);
  args.push('-map', '0:v');
  exprs.forEach((_, i) => args.push('-map', `${i + 1}:a`));
  args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-b:a', '160k', file);
  execFileSync('ffmpeg', args);
  return file;
}

function md5(file) {
  return crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
}

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-mini-audio-health-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('summarizeTrack: thresholds on raw stats (no ffmpeg)', () => {
  const base = { frames: 48000 * 60, durationS: 60, rms: 0.01, maxAbs: 0.5, clipped: 0, longestZeroFrames: 0, spans: [], fingerprint: 'a' };
  assert.equal(summarizeTrack(0, base).level, 'ok');
  const head = summarizeTrack(0, Object.assign({}, base, { spans: [[0, 20]] }));
  assert.deepEqual([head.level, head.codes, head.silent_ms, head.silent], ['fail', ['mic_silent_head'], 20000, false]);
  const shortHead = summarizeTrack(0, Object.assign({}, base, { spans: [[0, 5]] }));
  assert.deepEqual([shortHead.level, shortHead.codes], ['warn', ['mic_silent_head']]);
  const mid = summarizeTrack(1, Object.assign({}, base, { spans: [[30, 3]] }));
  assert.deepEqual([mid.level, mid.codes, mid.label], ['warn', ['mic_silent_span'], 'Mic 2']);
  const dead = summarizeTrack(0, Object.assign({}, base, { spans: [[0, 58]] }));
  assert.deepEqual([dead.level, dead.codes, dead.silent], ['fail', ['mic_silent'], true]);
  const zeros = summarizeTrack(0, Object.assign({}, base, { longestZeroFrames: 24000 }));
  assert.deepEqual([zeros.level, zeros.codes, zeros.longest_zero_ms], ['warn', ['mic_zero_run'], 500]);
  assert.equal(summarizeTrack(0, Object.assign({}, base, { longestZeroFrames: 48000 })).level, 'fail');
  const clip = summarizeTrack(0, Object.assign({}, base, { clipped: 22 }));
  assert.deepEqual(clip.codes, [], '22 clipped samples (Take 1) is not a clipping fault');
  assert.deepEqual(summarizeTrack(0, Object.assign({}, base, { clipped: 960 })).codes, ['mic_clipped']);
  const take = summarizeTake([summarizeTrack(0, base), summarizeTrack(1, Object.assign({}, base)), summarizeTrack(2, Object.assign({}, base, { fingerprint: 'b' }))]);
  assert.deepEqual(take.identical_pairs, [[0, 1]]);
  assert.equal(take.level, 'fail');
  assert.deepEqual(take.codes, ['mics_identical']);
  assert.equal(take.tracks[0]._fp, undefined, 'internal fingerprint not exposed');
});

test('analyzer: exact-zero runs and clipping counted on interleaved float PCM, across odd chunk boundaries', () => {
  const a = createTrackAnalyzer();
  const f = new Float32Array(48000 * 2 * 2); // 2 s stereo
  for (let i = 0; i < f.length; i += 2) { f[i] = 0.001; f[i + 1] = -0.001; }
  for (let i = 48000; i < 48000 + 2 * 24000; i += 1) f[i] = 0; // 0.5 s of zeros from 0.5 s
  for (let i = 3 * 48000; i < 3 * 48000 + 20; i += 1) f[i] = 1; // 20 clipped samples
  const buf = Buffer.from(f.buffer);
  for (let i = 0; i < buf.length; i += 7777) a.push(buf.subarray(i, Math.min(buf.length, i + 7777)));
  const st = a.finish();
  assert.equal(st.frames, 96000);
  assert.equal(st.longestZeroFrames, 24000);
  assert.equal(st.clipped, 20);
  assert.equal(st.maxAbs, 1);
});

test('a healthy synthetic master is ok on every track', NEEDS_FFMPEG, async (t) => {
  const dir = tmp(t);
  const file = makeMaster(dir, 'healthy.mp4', [voice(220, 0), voice(330, 1), voice(440, 2), voice(550, 3)], 12);
  const before = md5(file);
  const h = await analyzeMasterAudio(file, {});
  assert.equal(h.level, 'ok', describeAudioHealth(h));
  assert.equal(h.tracks.length, 4);
  assert.deepEqual(h.identical_pairs, []);
  for (const tr of h.tracks) {
    assert.deepEqual(tr.codes, []);
    assert.ok(tr.mean_db > -40 && tr.mean_db < -15, tr.label + ' mean ' + tr.mean_db);
    assert.equal(tr.longest_zero_ms < 250, true);
  }
  assert.equal(md5(file), before, 'the master is only read');
});

test('faults: a dead head bridged across a clap, a digital-zero track, a copied track, a zero dropout, clipping', NEEDS_FFMPEG, async (t) => {
  const dir = tmp(t);
  // Mic 1: -100 dBFS for 6 s with a full-scale clap at 3 s (bleed), then a voice: like Take 1.
  const deadHead = `if(lt(t,6),0.00001*(2*random(0)-1)+0.9*between(t,3,3.01),${voice(220, 0)})`;
  // Mic 2: a voice with 0.5 s of exact digital zero at 8 s.
  const dropout = `if(between(t,8,8.5),0,${voice(330, 1)})`;
  // Mic 3: nothing at all. Mic 4: the same signal as Mic 2 (one channel feeding two inputs).
  const file = makeMaster(dir, 'faults.mp4', [deadHead, dropout, '0', dropout], 20);
  const h = await analyzeMasterAudio(file, {});
  const byLabel = Object.fromEntries(h.tracks.map((tr) => [tr.label, tr]));
  assert.deepEqual(byLabel['Mic 1'].codes, ['mic_silent_head']);
  assert.ok(Math.abs(byLabel['Mic 1'].silent_ms - 6000) <= 150, 'one head span across the clap: ' + byLabel['Mic 1'].silent_ms);
  assert.deepEqual(byLabel['Mic 1'].silent_spans[0][0], 0);
  assert.equal(byLabel['Mic 1'].level, 'fail', '6 s of 20 s is over a quarter of the take');
  assert.ok(byLabel['Mic 2'].codes.includes('mic_zero_run'));
  assert.ok(byLabel['Mic 2'].longest_zero_ms >= 400 && byLabel['Mic 2'].longest_zero_ms <= 600, 'zero run ' + byLabel['Mic 2'].longest_zero_ms);
  assert.deepEqual([byLabel['Mic 3'].codes, byLabel['Mic 3'].silent, byLabel['Mic 3'].max_db], [['mic_silent'], true, null]);
  assert.ok(byLabel['Mic 4'].codes.includes('mics_identical'));
  assert.deepEqual(h.identical_pairs, [[1, 3]]);
  assert.equal(h.level, 'fail');
  assert.deepEqual(h.codes, ['mic_silent', 'mic_silent_head', 'mic_zero_run', 'mics_identical']);
  assert.match(describeAudioHealth(h), /^audio fail Mic1=mic_silent_head\(6\.\ds\)/);
});

test('a clipping mic is reported (warn), its level otherwise fine', NEEDS_FFMPEG, async (t) => {
  const dir = tmp(t);
  const clipped = `if(between(t,2,3),0.999*sgn(sin(2*PI*100*t))+0.5*sin(2*PI*100*t),${voice(220, 0)})`;
  const file = makeMaster(dir, 'clip.mp4', [clipped, voice(330, 1), voice(440, 2), voice(550, 3)], 6);
  const h = await analyzeMasterAudio(file, {});
  assert.deepEqual(h.tracks[0].codes, ['mic_clipped']);
  assert.ok(h.tracks[0].clipped_samples >= 480);
  assert.equal(h.level, 'warn');
});

test('no master, a master without audio, and a cancelled check are level unknown with a reason', NEEDS_FFMPEG, async (t) => {
  const dir = tmp(t);
  assert.deepEqual(await analyzeMasterAudio(path.join(dir, 'nope.mp4'), {}), { level: 'unknown', codes: [], tracks: [], identical_pairs: [], reason: 'no_master' });
  const silentVideo = path.join(dir, 'video.mp4');
  execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=gray:s=160x90:r=10:d=1', '-c:v', 'libx264', '-preset', 'ultrafast', silentVideo]);
  assert.equal((await analyzeMasterAudio(silentVideo, {})).reason, 'no_audio_tracks');
  const file = makeMaster(dir, 'long.mp4', [voice(220, 0), voice(330, 1)], 30);
  const job = startMasterAudioAnalysis(file, {});
  setTimeout(() => job.cancel(), 30);
  const res = await job.promise;
  assert.equal(res.level, 'unknown');
  assert.match(res.reason, /cancelled|decode_failed/);
});

test('Take 1 replay: Mic 1 is flagged for its dead first 14.7 s; the 09-26 master is ok', NEEDS_TAKE1, async () => {
  const take1 = await analyzeMasterAudio(TAKE1, {});
  assert.equal(take1.level, 'fail');
  const mic1 = take1.tracks[0];
  assert.equal(mic1.label, 'Mic 1');
  assert.deepEqual(mic1.codes, ['mic_silent_head']);
  assert.ok(Math.abs(mic1.silent_ms - 14700) <= 200, 'Mic 1 dead for ' + mic1.silent_ms + ' ms');
  assert.equal(mic1.silent, false);
  for (const tr of take1.tracks.slice(1)) assert.deepEqual(tr.codes, [], tr.label + ' is fine');
  assert.deepEqual(take1.identical_pairs, [], 'the four tracks are distinct');
  const ref = await analyzeMasterAudio(REF, {});
  assert.equal(ref.level, 'ok', describeAudioHealth(ref));
});
