'use strict';

// Post-stop file check for one take (es-mini-agent #10). The kiosk banner and the
// booking thread must reflect what is on disk, not whether a capture process ran:
// on Sep 29 a clean RTSP take showed "Camera failed" and fully fallen-back takes
// showed "Saved". Each camera file is probed with ffprobe (video stream present,
// duration) and compared with the master's duration.

const fs = require('fs');
const { spawn } = require('child_process');

// Same floor as the upload queue: one second of any camera here is megabytes,
// and Source Record's zero-stream stub is 1,737 bytes.
const MIN_CAMERA_BYTES = 64 * 1024;
// Clean RTSP files run ~1.1-1.6 s longer than the master (start/stop skew,
// Sep 29); a camera this much shorter than the master is missing footage.
const SHORT_TOLERANCE_S = 2;
const PROBE_TIMEOUT_MS = 8000;
const SLUG_RE = /^[a-z0-9_]+$/;

function slug(value, fallback) {
  const s = String(value || '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return SLUG_RE.test(s) ? s : fallback;
}

function round1(n) {
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
}

function fileSize(filePath) {
  try { return fs.statSync(filePath).size; } catch (_) { return null; }
}

/** Resolves { ok, videoStreams, durationS } or { ok:false, error }. Never rejects. */
function probeFile(filePath, options) {
  const opts = options || {};
  const bin = (typeof opts.ffprobeBin === 'function' ? opts.ffprobeBin() : opts.ffprobeBin) || 'ffprobe';
  const spawnImpl = opts.spawnImpl || spawn;
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : PROBE_TIMEOUT_MS;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(bin, ['-v', 'error', '-show_entries', 'stream=codec_type,duration:format=duration', '-of', 'json', filePath], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ ok: false, error: 'ffprobe_unavailable', detail: e && (e.message || String(e)) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      finish({ ok: false, error: 'ffprobe_timeout' });
    }, timeoutMs);
    if (timer.unref) timer.unref();
    child.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
    child.stderr.on('data', (c) => { stderr = (stderr + c.toString('utf8')).slice(-300); });
    child.on('error', (e) => finish({ ok: false, error: e && e.code === 'ENOENT' ? 'ffprobe_unavailable' : 'ffprobe_error', detail: e && (e.message || String(e)) }));
    child.on('close', (code) => {
      if (code !== 0) {
        // A file ffprobe cannot open (no moov, truncated) is a broken file, not a missing tool.
        finish({ ok: true, videoStreams: 0, durationS: null, unreadable: true, detail: stderr.trim() });
        return;
      }
      try {
        const parsed = JSON.parse(stdout || '{}');
        const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
        const video = streams.filter((s) => s && s.codec_type === 'video');
        const videoDuration = video.map((s) => Number(s.duration)).find((d) => Number.isFinite(d) && d > 0);
        const formatDuration = Number(parsed.format && parsed.format.duration);
        finish({ ok: true, videoStreams: video.length, streams: streams.length, durationS: videoDuration || (Number.isFinite(formatDuration) ? formatDuration : null) });
      } catch (e) {
        finish({ ok: false, error: 'ffprobe_bad_output' });
      }
    });
  });
}

/**
 * One camera's verdict. health: ok | short | failed | missing | unverified.
 * reason is a lowercase slug whenever health is not ok.
 */
function classifyCamera(input) {
  const { filePath, sizeBytes, probe, masterDurationS, captureError, gapS, resumeWaitS } = input;
  if (!filePath || sizeBytes === null || sizeBytes === undefined) {
    return { health: 'missing', reason: slug(captureError, 'no_file'), size_bytes: 0 };
  }
  const out = { size_bytes: sizeBytes };
  if (sizeBytes < MIN_CAMERA_BYTES) return Object.assign(out, { health: 'failed', reason: sizeBytes === 0 ? 'empty_file' : 'too_small' });
  if (!probe || !probe.ok) return Object.assign(out, { health: 'unverified', reason: slug(probe && probe.error, 'ffprobe_error') });
  if (probe.unreadable) return Object.assign(out, { health: 'failed', reason: 'unreadable_file' });
  if (!probe.videoStreams) return Object.assign(out, { health: 'failed', reason: 'no_video_stream' });
  out.duration_s = round1(probe.durationS);
  if (Number.isFinite(masterDurationS)) {
    out.master_duration_s = round1(masterDurationS);
    // The master resumes at once and an RTSP camera only after reconnecting, so
    // the camera is expected to be short by its measured resume waits.
    const tolerance = SHORT_TOLERANCE_S + (Number.isFinite(resumeWaitS) && resumeWaitS > 0 ? resumeWaitS : 0);
    if (Number.isFinite(probe.durationS) && masterDurationS - probe.durationS > tolerance) {
      return Object.assign(out, { health: 'short', reason: 'shorter_than_master', short_by_s: round1(masterDurationS - probe.durationS) });
    }
  }
  if (Number.isFinite(gapS) && gapS > SHORT_TOLERANCE_S) {
    return Object.assign(out, { health: 'short', reason: 'footage_gap', short_by_s: round1(gapS) });
  }
  if (captureError) return Object.assign(out, { health: 'ok', reason: slug(captureError, null) });
  return Object.assign(out, { health: 'ok' });
}

/**
 * cameras: [{ source, filePath, captureError?, gapS?, resumeWaitS? }]; masterPath optional.
 * Resolves { health: ok|degraded|failed, cameras: { [source]: verdict }, master }.
 */
async function checkTake(input, options) {
  const cameras = Array.isArray(input && input.cameras) ? input.cameras : [];
  const masterPath = input && input.masterPath;
  const probeOpts = options || {};
  const [masterProbe, cameraProbes] = await Promise.all([
    masterPath && fileSize(masterPath) ? probeFile(masterPath, probeOpts) : Promise.resolve(null),
    Promise.all(cameras.map((c) => {
      const size = c.filePath ? fileSize(c.filePath) : null;
      return size !== null && size >= MIN_CAMERA_BYTES ? probeFile(c.filePath, probeOpts) : Promise.resolve(null);
    })),
  ]);
  let master = null;
  if (masterPath) {
    const size = fileSize(masterPath);
    if (!size) master = { health: 'missing', reason: 'no_file', size_bytes: 0 };
    else if (!masterProbe || !masterProbe.ok) master = { health: 'unverified', reason: slug(masterProbe && masterProbe.error, 'ffprobe_error'), size_bytes: size };
    else if (masterProbe.unreadable || !masterProbe.streams) master = { health: 'failed', reason: 'unreadable_file', size_bytes: size };
    else master = { health: 'ok', size_bytes: size, duration_s: round1(masterProbe.durationS) };
  }
  const masterDurationS = master && master.health === 'ok' && masterProbe ? masterProbe.durationS : null;
  const verdicts = {};
  cameras.forEach((c, i) => {
    verdicts[c.source] = classifyCamera({
      filePath: c.filePath,
      sizeBytes: c.filePath ? fileSize(c.filePath) : null,
      probe: cameraProbes[i],
      masterDurationS,
      captureError: c.captureError,
      gapS: c.gapS,
      resumeWaitS: c.resumeWaitS,
    });
  });
  const all = Object.values(verdicts).concat(master ? [master] : []);
  const health = all.some((v) => v.health === 'failed' || v.health === 'missing') ? 'failed'
    : all.some((v) => v.health === 'short') ? 'degraded' : 'ok';
  return { health, cameras: verdicts, master };
}

module.exports = { checkTake, classifyCamera, probeFile, slug, MIN_CAMERA_BYTES, SHORT_TOLERANCE_S };
