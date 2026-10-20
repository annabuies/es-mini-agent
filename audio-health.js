'use strict';

// Post-take audio health (Build 42, A3). After stop, each of the master's mic
// tracks (a:0..a:3 = Mic 1..4) is decoded once and checked: level, digital-zero
// runs, silent spans (Take 1's Mic 1 sat at -96 dBFS for its first 14.7 s),
// clipped samples, and whether two tracks are the same signal. Read-only: the
// master is only decoded, never written.
//
// Identical tracks: an MD5 over each track's sequence of 50 ms window energies
// (sum of squares of the decoded float PCM, both channels). Bit-identical PCM gives
// the same fingerprint; any real difference changes it. It also catches a
// polarity-flipped copy, and costs nothing extra: an MD5 over the raw PCM took as
// long as the whole analysis (~3 s per track-hour on an M2).
//
// Speed: each track is decoded by its own ffmpeg and analysed on its own worker
// thread, ~3.5 s per recorded hour for four tracks on an M2. The stop path waits
// a bounded time for it (see server.js AUDIO_HEALTH_WAIT_MS).
//
// Thresholds (healthy bench-1 noise floors are -75...-84 dBFS):
//   silent       = 50 ms windows under -90 dBFS RMS, in runs of at least 1 s,
//                  runs under 1 s apart joined (a dead mic still passes a clap)
//   mic_silent        the track is silent for >= 90% of its length   -> fail
//   mic_silent_head   a silent run of >= 2 s from the start            -> warn, fail if >= 25% of the take
//   mic_silent_span   any other silent run of >= 2 s                  -> warn, fail if >= 25% of the take
//   mic_zero_run      >= 250 ms of exact digital zero                  -> warn, fail at >= 1 s
//   mic_clipped       >= 480 samples (10 ms) at or over 0.999 FS       -> warn
//   mics_identical    two tracks decode to the same PCM (not all-zero) -> fail

const crypto = require('crypto');
const fs = require('fs');
const { spawn } = require('child_process');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

const SR = 48000;
const CHANNELS = 2;
const WINDOW_S = 0.05;
const SILENT_DB = -90;
const SILENT_MIN_MS = 1000;
const MERGE_GAP_MS = 1000;
const SPAN_CODE_MS = 2000;
const SILENT_TRACK_FRACTION = 0.9;
const FAIL_FRACTION = 0.25;
const ZERO_WARN_MS = 250;
const ZERO_FAIL_MS = 1000;
const CLIP_LEVEL = 0.999;
const CLIP_WARN_SAMPLES = 480;
const MAX_TRACKS = 4;
const MAX_SPANS_REPORTED = 5;
const NICE_BIN = '/usr/bin/nice';
const CODE_ORDER = ['mic_silent', 'mic_silent_head', 'mic_silent_span', 'mic_zero_run', 'mic_clipped', 'mics_identical'];

function round1(n) {
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
}

function toDb(x) {
  return x > 0 ? round1(20 * Math.log10(x)) : null;
}

/** Streaming stats for one interleaved stereo float track. */
function createTrackAnalyzer() {
  const win = Math.round(WINDOW_S * SR);
  const st = {
    frames: 0, sumSq: 0, maxAbs: 0, clipped: 0,
    zeroRun: 0, longestZero: 0,
    winFrames: 0, winSumSq: 0, windows: [],
    pending: null,
  };
  function push(chunk) {
    let buf = chunk;
    if (st.pending) { buf = Buffer.concat([st.pending, chunk]); st.pending = null; }
    const frameBytes = 4 * CHANNELS;
    const usable = buf.length - (buf.length % frameBytes);
    if (usable < buf.length) st.pending = Buffer.from(buf.subarray(usable));
    // Copy into an aligned Float32Array (pipe buffers can sit at any byte offset).
    const f = new Float32Array(usable / 4);
    new Uint8Array(f.buffer).set(buf.subarray(0, usable));
    let { maxAbs, clipped, zeroRun, longestZero, winFrames, winSumSq } = st;
    for (let i = 0; i < f.length; i += CHANNELS) {
      const l = f[i];
      const r = f[i + 1];
      const al = l < 0 ? -l : l;
      const ar = r < 0 ? -r : r;
      const m = al > ar ? al : ar;
      if (m > maxAbs) maxAbs = m;
      if (m >= CLIP_LEVEL) clipped += (al >= CLIP_LEVEL ? 1 : 0) + (ar >= CLIP_LEVEL ? 1 : 0);
      winSumSq += l * l + r * r;
      if (m === 0) {
        zeroRun += 1;
        if (zeroRun > longestZero) longestZero = zeroRun;
      } else zeroRun = 0;
      winFrames += 1;
      if (winFrames === win) {
        st.windows.push(winSumSq);
        st.sumSq += winSumSq;
        winFrames = 0;
        winSumSq = 0;
      }
    }
    st.frames += f.length / CHANNELS;
    Object.assign(st, { maxAbs, clipped, zeroRun, longestZero, winFrames, winSumSq });
  }
  function finish() {
    const counts = st.windows.map(() => win);
    if (st.winFrames) {
      st.windows.push(st.winSumSq);
      st.sumSq += st.winSumSq;
      counts.push(st.winFrames);
    }
    const fingerprint = crypto.createHash('md5').update(Buffer.from(new Float64Array(st.windows).buffer)).digest('hex');
    // Silent windows, joined into runs; a run of >= 1 s is a silent span. A dead mic
    // still passes loud bleed (Take 1's Mic 1 caught both claps at full scale while
    // its floor sat at -96 dBFS), so spans less than MERGE_GAP_MS apart are one span.
    const silentSq = Math.pow(10, SILENT_DB / 10);
    const minWindows = Math.ceil(SILENT_MIN_MS / (WINDOW_S * 1000));
    const runs = [];
    let runStart = -1;
    for (let i = 0; i <= st.windows.length; i += 1) {
      const silent = i < st.windows.length && st.windows[i] / (counts[i] * CHANNELS) < silentSq;
      if (silent && runStart < 0) runStart = i;
      if (!silent && runStart >= 0) {
        runs.push([runStart, i]);
        runStart = -1;
      }
    }
    const merged = [];
    const gapWindows = Math.round(MERGE_GAP_MS / (WINDOW_S * 1000));
    for (const run of runs.filter(([a, b]) => b - a >= minWindows)) {
      const prev = merged[merged.length - 1];
      if (prev && run[0] - prev[1] <= gapWindows) prev[1] = run[1];
      else merged.push(run.slice());
    }
    return {
      frames: st.frames,
      durationS: st.frames / SR,
      rms: st.frames ? Math.sqrt(st.sumSq / (st.frames * CHANNELS)) : 0,
      maxAbs: st.maxAbs,
      clipped: st.clipped,
      longestZeroFrames: st.longestZero,
      spans: merged.map(([a, b]) => [a * WINDOW_S, (b - a) * WINDOW_S]),
      fingerprint,
    };
  }
  return { push, finish };
}

/** Pure: raw stats for one track -> the contract track entry (before identical pairing). */
function summarizeTrack(index, stats) {
  const durationMs = stats.durationS * 1000;
  const silentMs = Math.round(stats.spans.reduce((s, [, d]) => s + d, 0) * 1000);
  const longestZeroMs = Math.round((stats.longestZeroFrames / SR) * 1000);
  const allZero = stats.frames > 0 && stats.maxAbs === 0;
  const silent = allZero || stats.frames === 0 || (durationMs > 0 && silentMs >= SILENT_TRACK_FRACTION * durationMs);
  const codes = [];
  let fail = false;
  if (silent) {
    codes.push('mic_silent');
    fail = true;
  } else {
    const head = stats.spans.find(([start, dur]) => start <= 0.1 && dur * 1000 >= SPAN_CODE_MS);
    const others = stats.spans.filter((s) => s !== head && s[1] * 1000 >= SPAN_CODE_MS);
    if (head) codes.push('mic_silent_head');
    if (others.length) codes.push('mic_silent_span');
    if ((head || others.length) && silentMs >= FAIL_FRACTION * durationMs) fail = true;
    if (longestZeroMs >= ZERO_WARN_MS) {
      codes.push('mic_zero_run');
      if (longestZeroMs >= ZERO_FAIL_MS) fail = true;
    }
  }
  if (stats.clipped >= CLIP_WARN_SAMPLES) codes.push('mic_clipped');
  return {
    index,
    label: 'Mic ' + (index + 1),
    duration_s: round1(stats.durationS),
    mean_db: toDb(stats.rms),
    max_db: toDb(stats.maxAbs),
    longest_zero_ms: longestZeroMs,
    silent_ms: silentMs,
    silent,
    clipped_samples: stats.clipped,
    silent_spans: stats.spans.slice(0, MAX_SPANS_REPORTED).map(([s, d]) => [round1(s), round1(d)]),
    codes,
    level: codes.length === 0 ? 'ok' : (fail ? 'fail' : 'warn'),
    _fp: allZero ? null : stats.fingerprint,
  };
}

/** Pure: track entries -> the contract audio_health block. */
function summarizeTake(tracks) {
  const identicalPairs = [];
  for (let i = 0; i < tracks.length; i += 1) {
    for (let j = i + 1; j < tracks.length; j += 1) {
      if (tracks[i]._fp && tracks[i]._fp === tracks[j]._fp) identicalPairs.push([tracks[i].index, tracks[j].index]);
    }
  }
  for (const [a, b] of identicalPairs) {
    for (const t of [tracks[a], tracks[b]]) {
      if (!t.codes.includes('mics_identical')) t.codes.push('mics_identical');
      t.level = 'fail';
    }
  }
  const codes = CODE_ORDER.filter((c) => tracks.some((t) => t.codes.includes(c)));
  const level = tracks.some((t) => t.level === 'fail') ? 'fail' : (tracks.some((t) => t.level === 'warn') ? 'warn' : 'ok');
  return {
    level,
    codes,
    tracks: tracks.map((t) => { const out = Object.assign({}, t); delete out._fp; return out; }),
    identical_pairs: identicalPairs,
  };
}

function binOf(value, fallback) {
  return (typeof value === 'function' ? value() : value) || fallback;
}

function countAudioTracks(filePath, ffprobeBin) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(ffprobeBin, ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'json', filePath], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (_) {
      resolve(null);
      return;
    }
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      if (code !== 0) { resolve(null); return; }
      try { const p = JSON.parse(out || '{}'); resolve(Array.isArray(p.streams) ? p.streams.length : 0); } catch (_) { resolve(null); }
    });
  });
}

/** Decodes one track with ffmpeg and analyses it in this thread. register(child) gets the ffmpeg process. */
function analyzeTrackHere(filePath, index, ffmpegBin, register) {
  return new Promise((resolve, reject) => {
    const args = ['-nostdin', '-v', 'error', '-i', filePath, '-map', '0:a:' + index, '-ac', String(CHANNELS), '-ar', String(SR), '-f', 'f32le', '-acodec', 'pcm_f32le', '-'];
    let child;
    try {
      // Low priority, like the proxy encodes.
      child = fs.existsSync(NICE_BIN)
        ? spawn(NICE_BIN, ['-n', '15', ffmpegBin, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
        : spawn(ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      reject(e);
      return;
    }
    if (register) register(child);
    const analyzer = createTrackAnalyzer();
    let stderr = '';
    child.stdout.on('data', (c) => analyzer.push(c));
    child.stderr.on('data', (c) => { stderr = (stderr + c).slice(-300); });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code !== 0) reject(new Error('ffmpeg exited ' + (signal || code) + (stderr ? ': ' + stderr.trim() : '')));
      else resolve(analyzer.finish());
    });
  });
}

/** One track on its own worker thread (falls back to this thread). Returns { promise, cancel }. */
function analyzeTrack(filePath, index, ffmpegBin, useWorkers) {
  if (useWorkers !== false) {
    let worker;
    try {
      worker = new Worker(__filename, { workerData: { esAudioHealthTrack: { filePath, index, ffmpegBin } } });
    } catch (_) { worker = null; }
    if (worker) {
      const promise = new Promise((resolve, reject) => {
        worker.once('message', (msg) => (msg && msg.ok ? resolve(msg.stats) : reject(new Error((msg && msg.error) || 'worker_failed'))));
        worker.once('error', reject);
        worker.once('exit', (code) => reject(new Error('analysis worker exited ' + code)));
      });
      return { promise, cancel: () => { try { worker.postMessage('cancel'); } catch (_) {} setTimeout(() => worker.terminate().catch(() => {}), 200).unref(); } };
    }
  }
  const children = [];
  const promise = analyzeTrackHere(filePath, index, ffmpegBin, (c) => children.push(c));
  return { promise, cancel: () => { for (const c of children) { try { c.kill('SIGKILL'); } catch (_) {} } } };
}

/**
 * Checks the master's mic tracks. Returns { promise, cancel }; the promise resolves
 * the contract block and never rejects. cancel() (a new take is starting) stops
 * the decoders; the promise then resolves level 'unknown', reason 'cancelled'.
 * options: { ffmpegBin, ffprobeBin, maxTracks, workers } (bins may be functions).
 */
function startMasterAudioAnalysis(masterPath, options) {
  const opts = options || {};
  const started = Date.now();
  const unknown = (reason) => ({ level: 'unknown', codes: [], tracks: [], identical_pairs: [], reason });
  const jobs = [];
  let cancelled = false;
  const promise = (async () => {
    if (!masterPath || !fs.existsSync(masterPath)) return unknown('no_master');
    const count = await countAudioTracks(masterPath, binOf(opts.ffprobeBin, 'ffprobe'));
    if (cancelled) return unknown('cancelled');
    if (count === null) return unknown('ffprobe_failed');
    if (count === 0) return unknown('no_audio_tracks');
    const n = Math.min(count, Number(opts.maxTracks) || MAX_TRACKS);
    const ffmpeg = binOf(opts.ffmpegBin, 'ffmpeg');
    for (let i = 0; i < n; i += 1) jobs.push(analyzeTrack(masterPath, i, ffmpeg, opts.workers));
    try {
      const stats = await Promise.all(jobs.map((j) => j.promise));
      const block = summarizeTake(stats.map((st, i) => summarizeTrack(i, st)));
      block.analyzed_ms = Date.now() - started;
      return block;
    } catch (e) {
      for (const j of jobs) j.cancel();
      return unknown(cancelled ? 'cancelled' : 'decode_failed: ' + String(e && (e.message || e)).slice(0, 200));
    }
  })();
  return { promise, cancel: () => { cancelled = true; for (const j of jobs) j.cancel(); } };
}

function analyzeMasterAudio(masterPath, options) {
  return startMasterAudioAnalysis(masterPath, options).promise;
}

/** Compact one-line summary for agent.log. */
function describeAudioHealth(block) {
  if (!block) return 'audio unverified';
  if (block.level === 'unknown') return 'audio unknown (' + (block.reason || '?') + ')';
  const bad = (block.tracks || []).filter((t) => t.codes.length).map((t) => t.label.replace(' ', '') + '=' + t.codes.join('+') + (t.silent_ms ? '(' + (t.silent_ms / 1000).toFixed(1) + 's)' : ''));
  return 'audio ' + block.level + (bad.length ? ' ' + bad.join(' ') : '');
}

module.exports = {
  SILENT_DB,
  analyzeMasterAudio,
  startMasterAudioAnalysis,
  createTrackAnalyzer,
  describeAudioHealth,
  summarizeTake,
  summarizeTrack,
};

// Worker-thread entry: one track per worker (see analyzeTrack).
if (!isMainThread && workerData && workerData.esAudioHealthTrack) {
  const job = workerData.esAudioHealthTrack;
  const children = [];
  parentPort.on('message', (msg) => {
    if (msg === 'cancel') for (const c of children) { try { c.kill('SIGKILL'); } catch (_) {} }
  });
  analyzeTrackHere(job.filePath, job.index, job.ffmpegBin, (c) => children.push(c))
    .then((stats) => parentPort.postMessage({ ok: true, stats }))
    .catch((e) => parentPort.postMessage({ ok: false, error: String(e && (e.message || e)) }))
    .finally(() => parentPort.close());
}
