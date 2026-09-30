'use strict';

// RTSP stream-copy camera capture (Robbie's Sep 24 test, go-ahead Sep 29).
//
// OBS Source Record intermittently writes a 1,737-byte, zero-stream file for
// cam1 (es-mini-agent #10: 3 of 7 takes on Sep 29, silent in the OBS log). For a
// camera whose relay config says `"capture": "rtsp"`, the agent records the
// camera's own H.264 RTSP stream with ffmpeg instead, so the failing recorder
// is not in the path. The video is copied bit-for-bit (no encode, ~13% CPU for
// three 4K cameras in the Sep 24 test). Camera audio is left out by default:
// the bench-1 cameras send an empty AAC track, and an audio stream with no
// packets makes ffmpeg hold every video packet in memory until stop (tested
// with ffmpeg 8.1, 2026-09-29). `"rtsp_audio": true` on a camera copies its
// audio once it carries sound. OBS keeps the master mix, the preview and the mics.
//
// One take = one or more segments: a pause ends the current segment and resume
// starts the next; a dropped camera connection is retried as a new segment.
// Segments are fragmented MP4 (playable even if ffmpeg is killed) written next to
// the final file, and stop() joins them into `<finalBase>.mp4` in the camera's
// folder: a single segment is renamed, several are concatenated (stream copy).

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const DEFAULT_RTSP_PORT = 554;
const DEFAULT_RTSP_PATH = '/1';
// Start counts as up once video is on disk. With 0.5 s fragments (FRAGMENT_US)
// that is ~0.2 s after the camera's first keyframe, so a healthy camera passes in
// about a second; the window only runs out for a camera that sends nothing.
// 4 s was too tight while fragments were cut only at keyframes (es-mini-agent #10,
// Sep 29 takes 3-5 fell back to Source Record).
const START_PROBE_MS = 8000;
const STOP_QUIT_MS = 6000;
const STOP_TERM_MS = 3000;
// First reconnect goes straight away (every second of delay is lost footage);
// later ones wait, so a camera that is down does not spin ffmpeg.
const FIRST_RESTART_DELAY_MS = 250;
const RESTART_DELAY_MS = 2000;
// A camera whose part has not grown for this long is not writing (status op).
const WRITING_STALE_MS = 5000;
const MAX_RESTARTS = 20;
const STDERR_TAIL_LINES = 12;
// A part with only the MP4 header (~1 KB, camera never sent a frame) is not footage.
const MIN_PART_BYTES = 16 * 1024;
// Start counts as up once video is on disk, not just a header: a stalled mux
// writes a 28-byte ftyp and then nothing. One second of a camera here is ~4 MB.
const START_MIN_BYTES = 4 * 1024;
const SAFE_HOST_RE = /^[A-Za-z0-9.-]+$/;
// Fragment length. Fragments cut only at keyframes (frag_keyframe) put nothing on
// disk until the camera's SECOND keyframe after connect, 2-5 s on these cameras,
// and a crash lost up to a whole keyframe interval. 0.5 s fragments fix both.
const FRAGMENT_US = 500000;

function isRtspCamera(camera) {
  return !!camera && typeof camera === 'object' && String(camera.capture || '').toLowerCase() === 'rtsp';
}

/** rtsp://<host>:554/1 unless the camera config gives rtsp_url, rtsp_port or rtsp_path. */
function rtspUrlForCamera(camera) {
  if (!camera || typeof camera !== 'object') return null;
  if (typeof camera.rtsp_url === 'string' && /^rtsps?:\/\//i.test(camera.rtsp_url.trim())) return camera.rtsp_url.trim();
  const host = typeof camera.host === 'string' ? camera.host.trim().replace(/:\d+$/, '') : '';
  if (!host || !SAFE_HOST_RE.test(host)) return null;
  const port = Number.isInteger(camera.rtsp_port) && camera.rtsp_port > 0 && camera.rtsp_port < 65536 ? camera.rtsp_port : DEFAULT_RTSP_PORT;
  let rtspPath = typeof camera.rtsp_path === 'string' && camera.rtsp_path.trim() ? camera.rtsp_path.trim() : DEFAULT_RTSP_PATH;
  if (!rtspPath.startsWith('/')) rtspPath = '/' + rtspPath;
  return 'rtsp://' + host + ':' + port + rtspPath;
}

/** Never log a password embedded in an rtsp_url. */
function redactUrl(url) {
  return String(url || '').replace(/(rtsps?:\/\/)[^@/]*@/i, '$1***@');
}

/** Same shape as OBS's default file name: "2026-09-29 08-13-05". */
function takeStamp(date) {
  const d = date instanceof Date ? date : new Date(date || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + '-' + p(d.getMinutes()) + '-' + p(d.getSeconds());
}

function recordArgs(url, outPath, options) {
  const audio = !!(options && options.audio);
  const input = /^rtsps?:\/\//i.test(url)
    // TCP: no UDP packet loss on a busy LAN. -timeout (µs) makes a dead camera
    // end the process instead of hanging it, which triggers a new segment.
    ? ['-rtsp_transport', 'tcp', '-timeout', '5000000', '-i', url]
    : ['-re', '-i', url]; // local file input: tests and bench checks only
  return [
    '-hide_banner', '-loglevel', 'warning', '-y',
    ...input,
    '-map', '0:v:0',
    ...(audio ? ['-map', '0:a:0?', '-c:a', 'copy'] : ['-an']),
    '-c:v', 'copy',
    '-f', 'mp4', '-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-frag_duration', String(FRAGMENT_US),
    outPath,
  ];
}

function concatArgs(listPath, outPath) {
  return ['-hide_banner', '-loglevel', 'warning', '-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-map', '0', '-c', 'copy', '-movflags', '+faststart', outPath];
}

function fileSize(filePath) {
  try { return fs.statSync(filePath).size; } catch (_) { return 0; }
}

function createRtspCapture(options) {
  const opts = options || {};
  const ffmpegBin = () => (typeof opts.ffmpegBin === 'function' ? opts.ffmpegBin() : opts.ffmpegBin) || 'ffmpeg';
  const spawnImpl = opts.spawnImpl || spawn;
  const logPrefix = '[es-mini-agent] [rtsp] ';
  const log = (msg) => console.log(logPrefix + msg);
  // agent.log is the log people read; stderr goes to agent.error.log. On Sep 29
  // every RTSP warning (fallbacks, reconnects) landed only in agent.error.log, so
  // the fallback looked silent (es-mini-agent #10). Warnings now go to both.
  const warn = (msg) => { console.log(logPrefix + 'WARN ' + msg); console.warn(logPrefix + msg); };
  const startProbeMs = Number.isFinite(opts.startProbeMs) ? opts.startProbeMs : START_PROBE_MS;
  const restartDelayMs = Number.isFinite(opts.restartDelayMs) ? opts.restartDelayMs : RESTART_DELAY_MS;
  const writingStaleMs = Number.isFinite(opts.writingStaleMs) ? opts.writingStaleMs : WRITING_STALE_MS;
  const firstRestartDelayMs = Number.isFinite(opts.firstRestartDelayMs) ? opts.firstRestartDelayMs : Math.min(FIRST_RESTART_DELAY_MS, restartDelayMs);
  const stopQuitMs = Number.isFinite(opts.stopQuitMs) ? opts.stopQuitMs : STOP_QUIT_MS;

  const takes = new Map(); // source -> take

  function spawnSegment(take) {
    take.segmentIndex += 1;
    const partPath = path.join(take.dir, take.stamp + ' rtsp-part' + take.segmentIndex + '.mp4');
    const args = recordArgs(take.url, partPath, { audio: take.audio });
    let child;
    try {
      child = spawnImpl(ffmpegBin(), args, { stdio: ['pipe', 'ignore', 'pipe'] });
    } catch (e) {
      return { ok: false, error: e && (e.message || String(e)) };
    }
    const seg = { child, partPath, exited: false, code: null, signal: null, stderr: [], startedAt: Date.now(), exitedAt: null };
    seg.done = new Promise((resolve) => {
      child.on('error', (e) => {
        seg.stderr.push(String(e && (e.message || e)));
        if (!seg.exited) { seg.exited = true; seg.code = -1; resolve(); }
      });
      child.on('exit', (code, signal) => {
        seg.exited = true; seg.code = code; seg.signal = signal; seg.exitedAt = Date.now();
        resolve();
      });
    });
    if (child.stderr) {
      let pending = '';
      child.stderr.on('data', (chunk) => {
        pending += chunk.toString('utf8');
        const lines = pending.split(/\r?\n/);
        pending = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          seg.stderr.push(line);
          if (seg.stderr.length > STDERR_TAIL_LINES) seg.stderr.shift();
        }
      });
    }
    if (child.stdin) child.stdin.on('error', () => {});
    take.segments.push(seg);
    seg.done.then(() => onSegmentExit(take, seg));
    return { ok: true, seg };
  }

  function onSegmentExit(take, seg) {
    if (take.starting || take.stopping || take.paused || seg.quitRequested || take.segments[take.segments.length - 1] !== seg) return;
    // The camera dropped mid-take (network, reboot, AutoPing power cycle).
    const tail = redactUrl(seg.stderr.slice(-3).join(' | '));
    warn(take.source + ' ffmpeg exited mid-take code=' + seg.code + (seg.signal ? ' signal=' + seg.signal : '') + ' bytes=' + fileSize(seg.partPath) + (tail ? ' stderr=' + tail : ''));
    if (take.restarts >= MAX_RESTARTS) {
      warn(take.source + ' giving up after ' + take.restarts + ' reconnects this take');
      return;
    }
    take.restarts += 1;
    const lostFrom = seg.exitedAt || Date.now();
    take.restartTimer = setTimeout(() => {
      take.restartTimer = null;
      if (take.stopping || take.paused) return;
      const out = spawnSegment(take);
      if (out.ok) {
        warn(take.source + ' reconnect #' + take.restarts + ' -> segment ' + take.segmentIndex);
        watchGap(take, out.seg, lostFrom);
      } else {
        warn(take.source + ' reconnect failed: ' + out.error);
      }
    }, take.restarts === 1 ? firstRestartDelayMs : restartDelayMs);
    if (take.restartTimer.unref) take.restartTimer.unref();
  }

  /** Adds the footage missing between a dropped segment and the next one's first video to take.lostMs. */
  function watchGap(take, seg, lostFrom) {
    const settle = (ms) => {
      take.lostMs += Math.max(0, ms);
      warn(take.source + ' back after a ' + (Math.max(0, ms) / 1000).toFixed(1) + ' s gap (' + (take.lostMs / 1000).toFixed(1) + ' s lost this take)');
    };
    const tick = () => {
      if (fileSize(seg.partPath) >= START_MIN_BYTES) { settle(Date.now() - lostFrom); return; }
      if (seg.exited || take.stopping || take.paused) { settle((seg.exitedAt || Date.now()) - lostFrom); return; }
      const t = setTimeout(tick, 100);
      if (t.unref) t.unref();
    };
    tick();
  }

  async function probeStart(seg) {
    const deadline = Date.now() + startProbeMs;
    while (Date.now() < deadline) {
      if (seg.exited) return false;
      if (fileSize(seg.partPath) >= START_MIN_BYTES) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // Alive but silent (a camera that accepts the connection and sends nothing)
    // counts as a failed start, so the caller falls back to Source Record.
    return !seg.exited && fileSize(seg.partPath) >= START_MIN_BYTES;
  }

  async function quitSegment(seg, force) {
    if (!seg || seg.exited) return;
    seg.quitRequested = true;
    if (force) {
      // Nothing worth finalizing, and 'q' is ignored while ffmpeg is still connecting.
      try { seg.child.kill('SIGKILL'); } catch (_) {}
      await seg.done;
      return;
    }
    try { seg.child.stdin.write('q'); seg.child.stdin.end(); } catch (_) {}
    const waitFor = (ms) => Promise.race([seg.done, new Promise((resolve) => { const t = setTimeout(resolve, ms); if (t.unref) t.unref(); })]);
    await waitFor(stopQuitMs);
    if (seg.exited) return;
    try { seg.child.kill('SIGTERM'); } catch (_) {}
    await waitFor(STOP_TERM_MS);
    if (seg.exited) return;
    try { seg.child.kill('SIGKILL'); } catch (_) {}
    await seg.done;
  }

  /**
   * Starts recording one camera. Resolves { ok:true } once ffmpeg is up, or
   * { ok:false, reason, detail } if it could not connect (the caller then falls
   * back to Source Record for that camera, so the take still gets a file).
   */
  async function start(input) {
    const source = String(input && input.source || '');
    const url = input && input.url;
    const dir = input && input.dir;
    if (!source || !url || !dir) return { ok: false, reason: 'rtsp_misconfigured' };
    if (takes.has(source)) return { ok: false, reason: 'rtsp_already_recording' };
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    const take = {
      source, url, dir, audio: !!(input && input.audio),
      stamp: takeStamp(input.startedAt || Date.now()),
      segments: [], segmentIndex: 0, restarts: 0, lostMs: 0, lastBytes: 0, lastGrowAt: 0,
      paused: false, stopping: false, starting: true, restartTimer: null,
    };
    takes.set(source, take);
    const out = spawnSegment(take);
    if (!out.ok) {
      takes.delete(source);
      return { ok: false, reason: 'rtsp_spawn_failed', detail: out.error };
    }
    const alive = await probeStart(out.seg);
    take.starting = false;
    if (!alive || out.seg.exited) {
      take.stopping = true;
      takes.delete(source);
      await quitSegment(out.seg, true);
      const detail = redactUrl(out.seg.stderr.slice(-3).join(' | ')) || (out.seg.code === null || out.seg.signal ? 'no video from the camera within ' + (startProbeMs / 1000) + ' s' : 'ffmpeg exit ' + out.seg.code);
      await fsp.rm(out.seg.partPath, { force: true }).catch(() => {});
      warn(source + ' could not start ' + redactUrl(url) + ': ' + detail);
      return { ok: false, reason: 'rtsp_start_failed', detail };
    }
    log(source + ' recording ' + redactUrl(url) + ' -> ' + path.basename(out.seg.partPath));
    return { ok: true };
  }

  async function pause(source) {
    const take = takes.get(source);
    if (!take || take.paused) return { ok: !!take };
    take.paused = true;
    if (take.restartTimer) { clearTimeout(take.restartTimer); take.restartTimer = null; }
    await quitSegment(take.segments[take.segments.length - 1]);
    return { ok: true };
  }

  async function resume(source) {
    const take = takes.get(source);
    if (!take) return { ok: false, reason: 'rtsp_not_recording' };
    if (!take.paused) return { ok: true };
    take.paused = false;
    const out = spawnSegment(take);
    if (!out.ok) {
      warn(source + ' resume failed: ' + out.error);
      return { ok: false, reason: 'rtsp_spawn_failed', detail: out.error };
    }
    return { ok: true };
  }

  async function joinSegments(take, finalPath) {
    const parts = take.segments.map((s) => s.partPath).filter((p) => fileSize(p) >= MIN_PART_BYTES);
    if (parts.length === 0) return { ok: false, reason: 'rtsp_no_data' };
    if (parts.length === 1) {
      await fsp.rename(parts[0], finalPath);
      return { ok: true };
    }
    const listPath = path.join(take.dir, take.stamp + ' rtsp-parts.txt');
    const quote = (p) => "'" + p.replace(/'/g, "'\\''") + "'";
    await fsp.writeFile(listPath, parts.map((p) => 'file ' + quote(p)).join('\n') + '\n');
    const result = await new Promise((resolve) => {
      let child;
      try {
        child = spawnImpl(ffmpegBin(), concatArgs(listPath, finalPath), { stdio: ['ignore', 'ignore', 'pipe'] });
      } catch (e) {
        resolve({ code: -1, stderr: e && (e.message || String(e)) });
        return;
      }
      let stderr = '';
      if (child.stderr) child.stderr.on('data', (c) => { stderr = (stderr + c.toString('utf8')).slice(-2000); });
      child.on('error', (e) => resolve({ code: -1, stderr: String(e && (e.message || e)) }));
      child.on('exit', (code) => resolve({ code, stderr }));
    });
    // ffmpeg's concat stops at a part whose last fragment was cut off (a SIGKILLed
    // ffmpeg) and still exits 0, dropping every part after it (tested with ffmpeg
    // 8.1, 2026-09-30). A join well short of its parts is a failed join.
    const partBytes = parts.reduce((sum, p) => sum + fileSize(p), 0);
    const short = fileSize(finalPath) < partBytes * 0.95;
    if (result.code !== 0 || fileSize(finalPath) === 0 || short) {
      if (short && result.code === 0) result.stderr = 'joined ' + fileSize(finalPath) + ' of ' + partBytes + ' bytes';
      // Keep the parts: they are the footage. The caller uploads every one.
      warn(take.source + ' concat failed code=' + result.code + ' ' + String(result.stderr || '').trim().slice(-300) + '; keeping ' + parts.length + ' parts');
      await fsp.rm(finalPath, { force: true }).catch(() => {});
      return { ok: false, reason: 'rtsp_concat_failed', keptParts: parts };
    }
    await fsp.rm(listPath, { force: true }).catch(() => {});
    for (const p of parts) await fsp.rm(p, { force: true }).catch(() => {});
    return { ok: true };
  }

  /**
   * Stops a camera and joins its segments into <dir>/<finalBase>.mp4.
   * Resolves { ok, filePath, sizeBytes, segments, restarts, reason? }.
   */
  async function stop(source, stopOpts) {
    const take = takes.get(source);
    if (!take) return { ok: false, reason: 'rtsp_not_recording' };
    take.stopping = true;
    if (take.restartTimer) { clearTimeout(take.restartTimer); take.restartTimer = null; }
    await Promise.all(take.segments.map((seg) => quitSegment(seg)));
    takes.delete(source);
    const base = String((stopOpts && stopOpts.finalBase) || take.stamp).replace(/[\/\\]/g, '_');
    let finalPath = path.join(take.dir, base + '.mp4');
    if (fs.existsSync(finalPath)) finalPath = path.join(take.dir, base + ' rtsp.mp4');
    let joined;
    try {
      joined = await joinSegments(take, finalPath);
    } catch (e) {
      joined = { ok: false, reason: 'rtsp_join_failed', detail: e && (e.message || String(e)) };
    }
    const summary = { segments: take.segments.length, restarts: take.restarts, lostMs: take.lostMs };
    if (!joined.ok) {
      const kept = joined.keptParts && joined.keptParts[0];
      warn(source + ' stop: ' + joined.reason + (joined.detail ? ' ' + joined.detail : ''));
      return Object.assign({ ok: false, reason: joined.reason, filePath: kept || null, keptParts: joined.keptParts || [], sizeBytes: (joined.keptParts || []).reduce((sum, p) => sum + fileSize(p), 0) }, summary);
    }
    const sizeBytes = fileSize(finalPath);
    const line = source + ' saved ' + path.basename(finalPath) + ' bytes=' + sizeBytes + ' segments=' + summary.segments + ' reconnects=' + summary.restarts + (summary.restarts ? ' lost=' + (summary.lostMs / 1000).toFixed(1) + 's' : '');
    if (summary.restarts) warn(line); else log(line);
    return Object.assign({ ok: true, filePath: finalPath, sizeBytes }, summary);
  }

  function active(source) {
    return takes.has(source);
  }

  /**
   * Per camera: `writing` is true only while the current part is growing, the same
   * test the status op applies to OBS files. Parts are skipped by the OBS sampler
   * (getNewestFileSample), which then measured the previous take's finished file,
   * so a clean RTSP take read as "camera failed" on the kiosk (Sep 29 take 2).
   */
  function describe() {
    const out = {};
    const now = Date.now();
    for (const [source, take] of takes) {
      const seg = take.segments[take.segments.length - 1];
      const bytes = seg ? fileSize(seg.partPath) : 0;
      if (bytes !== take.lastBytes) { take.lastBytes = bytes; take.lastGrowAt = now; }
      const growing = !!seg && !seg.exited && bytes > 0 && now - take.lastGrowAt <= writingStaleMs;
      out[source] = { paused: take.paused, segments: take.segments.length, restarts: take.restarts, lost_ms: take.lostMs, writing: growing, bytes };
    }
    return out;
  }

  /** Sync, for process 'exit': ffmpeg ignores stdin EOF and would record on as an orphan. */
  function killAll() {
    for (const take of takes.values()) {
      take.stopping = true;
      if (take.restartTimer) clearTimeout(take.restartTimer);
      for (const seg of take.segments) {
        if (!seg.exited) { try { seg.child.kill('SIGTERM'); } catch (_) {} }
      }
    }
  }

  return { start, pause, resume, stop, active, describe, killAll };
}

/**
 * At boot: ends ffmpeg captures left running by a previous agent process that died
 * without its exit hook (crash, SIGKILL). Matches only commands writing an RTSP part
 * under this Mini's record dir. Returns true if any were found.
 */
function killOrphanedCaptures(recordDir, execImpl) {
  if (!recordDir) return false;
  const escaped = path.resolve(recordDir).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    (execImpl || execFileSync)('pkill', ['-f', escaped + '/.* rtsp-part[0-9]+\\.mp4$'], { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false; // pkill exits 1 when nothing matched
  }
}

module.exports = { createRtspCapture, killOrphanedCaptures, isRtspCamera, rtspUrlForCamera, redactUrl, takeStamp, recordArgs, concatArgs };
