'use strict';

// Watch rendition (Build 42, B1/B3). For each camera angle the Mini makes a
// quick-start 1080p copy with the four mic tracks mixed in, aligned by the take's
// logged capture timing; the 4K original is only read, never rewritten.
//
// THE SIGN (read this before touching any offset):
//   offset_s = seconds to DELAY the master's audio so it lines up with that
//   camera's file. offset_s = (wall-clock of master t=0) - (wall-clock of the
//   camera file's t=0). Positive = the camera file started first, so an event
//   happens LATER in the camera file than in the master: camera_t = master_t +
//   offset_s. Take 1 (2026-10-19 15-30-22): cameras = master audio + 1.08 s, so
//   offset_s = +1.08 and its claps at master 3.604 s / 29.464 s are at camera
//   4.684 s / 30.544 s. Negative = the camera started after the master; the
//   first -offset_s seconds of the mix are dropped.
//
// ffmpeg (without -copyts) starts each input at its own first timestamp, so a
// camera file whose first frame is not at pts 0 (start_time s0) shifts by that:
//   delay = offset_s + master_start_s - camera_start_s.
// Delay is applied in whole samples (adelay ...S, or atrim start_sample), so the
// only rounding is 1/48000 s; the encode adds none (the AAC priming is in the
// MP4 edit list, which every decoder honours).

const fs = require('fs');
const { spawn } = require('child_process');

const SAMPLE_RATE = 48000;
const WATCH_HEIGHT = 1080;
const WATCH_VIDEO_KBPS = 4000;
const WATCH_MAXRATE_KBPS = 4500;
const WATCH_BUFSIZE_KBPS = 8000;
const WATCH_GOP_S = 2;
const WATCH_AUDIO_KBPS = 160;
const MIX_AUDIO_KBPS = 192;
const MAX_MIX_TRACKS = 4;

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

/** Seconds of delay for the master audio in this camera's rendition (see the sign note above). */
function computeDelayS(input) {
  const offset = Number(input && input.offsetS) || 0;
  const masterStart = Number(input && input.masterStartS) || 0;
  const cameraStart = Number(input && input.cameraStartS) || 0;
  return Math.round((offset + masterStart - cameraStart) * 1e6) / 1e6;
}

/** offset_s from wall-clock anchors (ms): positive = camera first. adjustMs corrects a measured constant bias. */
function offsetFromTiming(input) {
  const raw = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
  const master = raw(input && input.masterStartMs);
  const camera = raw(input && input.cameraStartMs);
  if (!Number.isFinite(master) || !Number.isFinite(camera)) return null;
  const adjust = Number(input && input.adjustMs) || 0;
  return round3((master - camera + adjust) / 1000);
}

/** The audio-shift filter for a delay in seconds: pad (positive) or trim (negative), in whole samples. */
function audioShiftFilter(delayS, sampleRate) {
  const rate = sampleRate || SAMPLE_RATE;
  const samples = Math.round((Number(delayS) || 0) * rate);
  if (samples > 0) return 'adelay=delays=' + samples + 'S:all=1';
  if (samples < 0) return 'atrim=start_sample=' + (-samples) + ',asetpts=PTS-STARTPTS';
  return 'anull';
}

/** Filter chain mixing the master's first N audio tracks (input index `input`) into one stereo stream. */
function mixChain(input, tracks) {
  const n = Math.max(0, Math.min(MAX_MIX_TRACKS, Number(tracks) || 0));
  if (n === 0) return null;
  const labels = Array.from({ length: n }, (_, i) => '[' + input + ':a:' + i + ']').join('');
  // Resample first so every input is 48 kHz stereo; normalize=0 keeps each mic at
  // its own level (amix would otherwise divide by 4, -12 dB); the limiter only
  // catches a sum over full scale, with its lookahead compensated (latency=1).
  const head = n === 1
    ? labels + 'aresample=' + SAMPLE_RATE + ',aformat=channel_layouts=stereo'
    : labels + 'amix=inputs=' + n + ':duration=longest:normalize=0,aresample=' + SAMPLE_RATE + ',aformat=channel_layouts=stereo';
  return head + ',alimiter=limit=0.95:level=0:latency=1';
}

/**
 * ffmpeg args for one camera's watch copy: 1080p H.264 ~4 Mbps, a keyframe every
 * 2 s, faststart; AAC stereo = the mic mix delayed by delayS. masterTracks 0 (no
 * master on disk) makes a video-only copy.
 */
function watchArgs(input) {
  const opts = input || {};
  const tracks = opts.masterPath ? Math.min(MAX_MIX_TRACKS, Number(opts.masterTracks) || 0) : 0;
  const filters = ['[0:v:0]scale=-2:' + WATCH_HEIGHT + ':flags=bicubic,format=yuv420p[vout]'];
  const maps = ['-map', '[vout]'];
  const args = ['-y', '-hide_banner', '-loglevel', 'warning', '-nostdin', '-i', opts.cameraPath];
  if (tracks > 0) {
    args.push('-i', opts.masterPath);
    filters.push(mixChain(1, tracks) + ',' + audioShiftFilter(opts.delayS) + ',apad[aout]');
    maps.push('-map', '[aout]');
  }
  args.push('-filter_complex', filters.join(';'), ...maps,
    '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high',
    '-b:v', WATCH_VIDEO_KBPS + 'k', '-maxrate', WATCH_MAXRATE_KBPS + 'k', '-bufsize', WATCH_BUFSIZE_KBPS + 'k',
    // A keyframe every 2 s whatever the camera's frame rate, none extra at scene cuts.
    '-force_key_frames', 'expr:gte(t,n_forced*' + WATCH_GOP_S + ')', '-sc_threshold', '0');
  if (tracks > 0) {
    // apad + -shortest: the copy is exactly as long as the camera's video.
    args.push('-c:a', 'aac', '-b:a', WATCH_AUDIO_KBPS + 'k', '-ar', String(SAMPLE_RATE), '-ac', '2', '-shortest');
  }
  args.push('-movflags', '+faststart', '-f', 'mp4', opts.outPath);
  return args;
}

/** ffmpeg args for the take's mix (master timeline, no offset): AAC stereo .m4a. */
function mixArgs(input) {
  const opts = input || {};
  return ['-y', '-hide_banner', '-loglevel', 'warning', '-nostdin', '-i', opts.masterPath,
    '-filter_complex', mixChain(0, opts.masterTracks) + '[aout]', '-map', '[aout]',
    '-c:a', 'aac', '-b:a', MIX_AUDIO_KBPS + 'k', '-ar', String(SAMPLE_RATE), '-ac', '2',
    '-movflags', '+faststart', '-f', 'mp4', opts.outPath];
}

function runTool(bin, args, options) {
  const opts = options || {};
  return new Promise((resolve) => {
    let child;
    try {
      child = (opts.spawnImpl || spawn)(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: e && (e.message || String(e)) });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
    child.stderr.on('data', (c) => { stderr = (stderr + c.toString('utf8')).slice(-2000); });
    child.on('error', (e) => resolve({ code: -1, stdout, stderr: String(e && (e.message || e)) }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * ffprobe a file: { ok, audioTracks, startS, videoStartS, durationS }. startS is the
 * input's first timestamp (what ffmpeg subtracts), durationS the format duration.
 */
async function probeMedia(filePath, options) {
  const opts = options || {};
  const bin = (typeof opts.ffprobeBin === 'function' ? opts.ffprobeBin() : opts.ffprobeBin) || 'ffprobe';
  const res = await runTool(bin, ['-v', 'error', '-show_entries', 'stream=codec_type,start_time,duration:format=start_time,duration', '-of', 'json', filePath], opts);
  if (res.code !== 0) return { ok: false, error: (res.stderr || '').trim().slice(-300) || 'ffprobe_failed' };
  try {
    const parsed = JSON.parse(res.stdout || '{}');
    const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
    const video = streams.find((s) => s && s.codec_type === 'video');
    const starts = streams.map((s) => num(s && s.start_time)).filter((v) => v !== null);
    return {
      ok: true,
      audioTracks: streams.filter((s) => s && s.codec_type === 'audio').length,
      videoStreams: streams.filter((s) => s && s.codec_type === 'video').length,
      startS: num(parsed.format && parsed.format.start_time) ?? (starts.length ? Math.min(...starts) : 0),
      videoStartS: video ? num(video.start_time) : null,
      durationS: num(parsed.format && parsed.format.duration) ?? (video ? num(video.duration) : null),
    };
  } catch (_) {
    return { ok: false, error: 'ffprobe_bad_output' };
  }
}

/** Everything a rendition needs from the two files, plus the resolved delay. */
async function planWatch(input, options) {
  const opts = input || {};
  const camera = await probeMedia(opts.cameraPath, options);
  const master = opts.masterPath && fs.existsSync(opts.masterPath) ? await probeMedia(opts.masterPath, options) : null;
  const masterTracks = master && master.ok ? Math.min(MAX_MIX_TRACKS, master.audioTracks) : 0;
  const offsetS = Number.isFinite(Number(opts.offsetS)) && opts.offsetS !== null ? Number(opts.offsetS) : null;
  const delayS = offsetS === null ? null : computeDelayS({
    offsetS,
    masterStartS: master && master.ok ? master.startS || 0 : 0,
    cameraStartS: camera.ok ? camera.startS || 0 : 0,
  });
  return {
    camera,
    master,
    masterTracks: delayS === null ? 0 : masterTracks,
    offsetS,
    delayS: delayS === null ? null : Math.round(delayS * SAMPLE_RATE) / SAMPLE_RATE,
    // No timing means no honest alignment: the copy is made without the mix.
    audio: delayS !== null && masterTracks > 0 ? 'mix' : 'none',
  };
}

module.exports = {
  MAX_MIX_TRACKS,
  SAMPLE_RATE,
  WATCH_GOP_S,
  WATCH_VIDEO_KBPS,
  audioShiftFilter,
  computeDelayS,
  mixArgs,
  mixChain,
  offsetFromTiming,
  planWatch,
  probeMedia,
  runTool,
  watchArgs,
};
