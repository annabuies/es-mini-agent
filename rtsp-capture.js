'use strict';

// RTSP stream-copy camera capture (Robbie's Sep 24 test, go-ahead Sep 29).
//
// OBS Source Record intermittently writes a 1,737-byte, zero-stream file for
// cam1 (es-mini-agent #10: 3 of 7 takes on Sep 29, silent in the OBS log). For a
// camera whose relay config says `"capture": "rtsp"`, the agent records the
// camera's own H.264 RTSP stream with ffmpeg instead, so the failing recorder
// is not in the path. The video is copied bit-for-bit (no encode, ~13% CPU for
// three 4K cameras in the Sep 24 test); only camera audio, if any, is re-encoded
// to AAC so any camera audio codec fits in MP4. OBS keeps the master mix, the
// live preview and the mic tracks.
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
const START_PROBE_MS = 2500;
const STOP_QUIT_MS = 6000;
const STOP_TERM_MS = 3000;
const RESTART_DELAY_MS = 2000;
const MAX_RESTARTS = 20;
const STDERR_TAIL_LINES = 12;
// A part with only the MP4 header (~1 KB, camera never sent a frame) is not footage.
const MIN_PART_BYTES = 16 * 1024;
const SAFE_HOST_RE = /^[A-Za-z0-9.-]+$/;

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

function recordArgs(url, outPath) {
  const input = /^rtsps?:\/\//i.test(url)
    // TCP: no UDP packet loss on a busy LAN. -timeout (µs) makes a dead camera
    // end the process instead of hanging it, which triggers a new segment.
    ? ['-rtsp_transport', 'tcp', '-timeout', '5000000', '-i', url]
    : ['-re', '-i', url]; // local file input: tests and bench checks only
  return [
    '-hide_banner', '-loglevel', 'warning', '-y',
    ...input,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
    '-f', 'mp4', '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
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
  const warn = (msg) => console.warn(logPrefix + msg);
  const startProbeMs = Number.isFinite(opts.startProbeMs) ? opts.startProbeMs : START_PROBE_MS;
  const restartDelayMs = Number.isFinite(opts.restartDelayMs) ? opts.restartDelayMs : RESTART_DELAY_MS;
  const stopQuitMs = Number.isFinite(opts.stopQuitMs) ? opts.stopQuitMs : STOP_QUIT_MS;

  const takes = new Map(); // source -> take

  function spawnSegment(take) {
    take.segmentIndex += 1;
    const partPath = path.join(take.dir, take.stamp + ' rtsp-part' + take.segmentIndex + '.mp4');
    const args = recordArgs(take.url, partPath);
    let child;
    try {
      child = spawnImpl(ffmpegBin(), args, { stdio: ['pipe', 'ignore', 'pipe'] });
    } catch (e) {
      return { ok: false, error: e && (e.message || String(e)) };
    }
    const seg = { child, partPath, exited: false, code: null, signal: null, stderr: [], startedAt: Date.now() };
    seg.done = new Promise((resolve) => {
      child.on('error', (e) => {
        seg.stderr.push(String(e && (e.message || e)));
        if (!seg.exited) { seg.exited = true; seg.code = -1; resolve(); }
      });
      child.on('exit', (code, signal) => {
        seg.exited = true; seg.code = code; seg.signal = signal;
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
    take.restartTimer = setTimeout(() => {
      take.restartTimer = null;
      if (take.stopping || take.paused) return;
      const out = spawnSegment(take);
      if (out.ok) log(take.source + ' reconnect #' + take.restarts + ' -> segment ' + take.segmentIndex);
      else warn(take.source + ' reconnect failed: ' + out.error);
    }, restartDelayMs);
    if (take.restartTimer.unref) take.restartTimer.unref();
  }

  async function probeStart(seg) {
    const deadline = Date.now() + startProbeMs;
    while (Date.now() < deadline) {
      if (seg.exited) return false;
      if (fileSize(seg.partPath) > 0) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return !seg.exited; // still connecting (waiting for a keyframe) is fine
  }

  async function quitSegment(seg) {
    if (!seg || seg.exited) return;
    seg.quitRequested = true;
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
      source, url, dir,
      stamp: takeStamp(input.startedAt || Date.now()),
      segments: [], segmentIndex: 0, restarts: 0,
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
      await quitSegment(out.seg);
      const detail = redactUrl(out.seg.stderr.slice(-3).join(' | ')) || ('ffmpeg exit ' + out.seg.code);
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
    if (result.code !== 0 || fileSize(finalPath) === 0) {
      // Keep the parts: they are the footage. Report the first one as the file.
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
    const summary = { segments: take.segments.length, restarts: take.restarts };
    if (!joined.ok) {
      const kept = joined.keptParts && joined.keptParts[0];
      warn(source + ' stop: ' + joined.reason + (joined.detail ? ' ' + joined.detail : ''));
      return Object.assign({ ok: false, reason: joined.reason, filePath: kept || null, sizeBytes: kept ? fileSize(kept) : 0 }, summary);
    }
    const sizeBytes = fileSize(finalPath);
    log(source + ' saved ' + path.basename(finalPath) + ' bytes=' + sizeBytes + ' segments=' + summary.segments + ' reconnects=' + summary.restarts);
    return Object.assign({ ok: true, filePath: finalPath, sizeBytes }, summary);
  }

  function active(source) {
    return takes.has(source);
  }

  function describe() {
    const out = {};
    for (const [source, take] of takes) {
      const seg = take.segments[take.segments.length - 1];
      out[source] = { paused: take.paused, segments: take.segments.length, restarts: take.restarts, writing: !!seg && !seg.exited, bytes: seg ? fileSize(seg.partPath) : 0 };
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
