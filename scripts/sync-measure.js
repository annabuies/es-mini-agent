#!/usr/bin/env node
'use strict';

// Sync measurement for watch renditions (Build 42, B3). Bench and test tool only;
// not an agent runtime module. Decodes with the local ffmpeg.
//
//   node scripts/sync-measure.js flash <file.mp4>          synthetic: flash frame vs beep onset
//   node scripts/sync-measure.js onsets <file> [start] [dur] clap-like audio onsets (s)
//   node scripts/sync-measure.js motion <file> <start> <dur> per-frame motion energy around a moment
//
// Onsets use the same rule as the Take 1 grounding analysis: a 5 ms peak above
// -20 dBFS and at least 20 dB over the median 5 ms peak of the preceding 500 ms,
// refined to the first sample at half that peak.

const { spawn } = require('child_process');

const SR = 48000;

function decode(args, ffmpegBin) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegBin || process.env.FFMPEG_BIN || 'ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let stderr = '';
    child.stdout.on('data', (c) => chunks.push(c));
    child.stderr.on('data', (c) => { stderr = (stderr + c).slice(-2000); });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error('ffmpeg ' + code + ': ' + stderr))));
  });
}

function window(start, duration) {
  const out = [];
  if (Number.isFinite(start) && start > 0) out.push('-ss', String(start));
  if (Number.isFinite(duration) && duration > 0) out.push('-t', String(duration));
  return out;
}

/** Mono float samples of one audio stream (default the first). Output-side seek: sample exact. */
async function decodeAudio(file, options) {
  const o = options || {};
  const map = o.map || '0:a:0';
  const buf = await decode(['-nostdin', '-v', 'error', '-i', file, ...window(o.start, o.duration), '-map', map, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-acodec', 'pcm_f32le', '-'], o.ffmpegBin);
  const f = new Float32Array(buf.length / 4);
  new Uint8Array(f.buffer).set(buf.subarray(0, f.length * 4));
  return f;
}

function db(x) {
  return 20 * Math.log10(Math.max(x, 1e-12));
}

/** Clap-like onsets in seconds (relative to the decoded window). */
function onsets(samples, options) {
  const o = options || {};
  const win = Math.round(0.005 * SR);
  const n = Math.floor(samples.length / win);
  const pk = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    let m = 0;
    for (let j = i * win; j < (i + 1) * win; j += 1) { const a = Math.abs(samples[j]); if (a > m) m = a; }
    pk[i] = m;
  }
  const out = [];
  let last = -1e9;
  const minDb = Number.isFinite(o.minDb) ? o.minDb : -20;
  for (let i = 20; i < n; i += 1) {
    const lo = Math.max(0, i - 100);
    const prior = Array.from(pk.subarray(lo, i)).sort((a, b) => a - b);
    const base = prior[Math.floor(prior.length / 2)];
    const t = (i * win) / SR;
    if (db(pk[i]) > minDb && db(pk[i]) - db(base) >= 20 && t - last > 0.15) {
      let k = i * win;
      while (k < (i + 1) * win && Math.abs(samples[k]) < 0.5 * pk[i]) k += 1;
      out.push({ t: k / SR, peak_db: Math.round(db(pk[i]) * 10) / 10 });
      last = t;
    }
  }
  return out;
}

async function probeFps(file) {
  const buf = await new Promise((resolve, reject) => {
    const child = spawn(process.env.FFPROBE_BIN || 'ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate', '-of', 'csv=p=0', file], { stdio: ['ignore', 'pipe', 'ignore'] });
    let s = '';
    child.stdout.on('data', (c) => { s += c; });
    child.on('error', reject);
    child.on('close', () => resolve(s.trim()));
  });
  const [a, b] = buf.split('/').map(Number);
  return b ? a / b : a;
}

/** Gray frames (w x h) of the first video stream; frame k is at start + k / fps. */
async function decodeFrames(file, options) {
  const o = options || {};
  const w = o.width || 64;
  const h = o.height || 36;
  const fps = o.fps || await probeFps(file);
  const buf = await decode(['-nostdin', '-v', 'error', '-i', file, ...window(o.start, o.duration), '-map', '0:v:0', '-vf', 'scale=' + w + ':' + h + ':flags=area,format=gray', '-fps_mode', 'passthrough', '-f', 'rawvideo', '-'], o.ffmpegBin);
  const size = w * h;
  const frames = [];
  for (let k = 0; k * size + size <= buf.length; k += 1) frames.push(buf.subarray(k * size, (k + 1) * size));
  return { fps, frames, start: Number(o.start) || 0, width: w, height: h };
}

function meanLuma(frame) {
  let s = 0;
  for (let i = 0; i < frame.length; i += 1) s += frame[i];
  return s / frame.length;
}

/** Synthetic media: the brightest frame's time and the first beep onset; error in frames. */
async function measureFlash(file, options) {
  const v = await decodeFrames(file, options);
  let best = 0;
  let bestLuma = -1;
  v.frames.forEach((f, k) => { const l = meanLuma(f); if (l > bestLuma) { bestLuma = l; best = k; } });
  const audio = await decodeAudio(file, options);
  const first = onsets(audio, options)[0] || null;
  const videoT = v.start + best / v.fps;
  const audioT = first ? (Number(options && options.start) || 0) + first.t : null;
  return {
    flash_frame: best,
    flash_s: Math.round(videoT * 1000) / 1000,
    beep_s: audioT === null ? null : Math.round(audioT * 10000) / 10000,
    error_s: audioT === null ? null : Math.round((audioT - videoT) * 10000) / 10000,
    error_frames: audioT === null ? null : Math.round(((audioT - videoT) * v.fps) * 100) / 100,
    fps: v.fps,
  };
}

/** Per-frame motion energy (mean abs difference to the previous frame) around a moment. */
async function motionEnergy(file, options) {
  const v = await decodeFrames(file, Object.assign({ width: 160, height: 90 }, options));
  const energy = v.frames.map((f, k) => {
    if (k === 0) return 0;
    const p = v.frames[k - 1];
    let s = 0;
    for (let i = 0; i < f.length; i += 1) s += Math.abs(f[i] - p[i]);
    return s / f.length;
  });
  return { fps: v.fps, start: v.start, energy };
}

module.exports = { decodeAudio, decodeFrames, measureFlash, motionEnergy, onsets, SR };

if (require.main === module) {
  (async () => {
    const [cmd, file, a, b] = process.argv.slice(2);
    if (cmd === 'flash') console.log(JSON.stringify(await measureFlash(file)));
    else if (cmd === 'onsets') {
      const start = Number(a) || 0;
      const samples = await decodeAudio(file, { start, duration: Number(b) || undefined });
      console.log(JSON.stringify(onsets(samples).map((o) => ({ t: Math.round((o.t + start) * 10000) / 10000, peak_db: o.peak_db }))));
    } else if (cmd === 'motion') {
      const m = await motionEnergy(file, { start: Number(a), duration: Number(b) });
      console.log(JSON.stringify(m.energy.map((e, k) => [Math.round((m.start + k / m.fps) * 1000) / 1000, Math.round(e * 100) / 100])));
    } else {
      console.error('usage: sync-measure.js flash|onsets|motion <file> [start] [duration]');
      process.exit(2);
    }
  })().catch((e) => { console.error(e && (e.stack || e)); process.exit(1); });
}
