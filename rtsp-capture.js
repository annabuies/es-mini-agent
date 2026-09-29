'use strict';

// Opt-in camera ISO capture that bypasses OBS Source Record: one ffmpeg per
// camera pulls the camera's own RTSP stream and stream-copies it (-c copy) into
// the same <OBS_RECORD_DIR>/<source>/ folder, with the same OBS-style file name,
// so feeds_writing and the upload queue treat it like any other camera file.
// Nothing is encoded on the Mini: the camera has already encoded the stream.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const STDERR_TAIL_LEN = 600;
const DISABLED_TOKENS = new Set(['', '0', 'off', 'none', 'false', 'no']);

function envKeyForSource(source) {
  return 'RTSP_URL_' + String(source).toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Reads RTSP_* env. RTSP_CAPTURE_SOURCES unset/off => disabled (Source Record for every camera). */
function readRtspConfig(env) {
  const e = env || {};
  const raw = String(e.RTSP_CAPTURE_SOURCES || '').trim();
  const sources = DISABLED_TOKENS.has(raw.toLowerCase())
    ? []
    : raw.split(',').map((v) => v.trim()).filter(Boolean);
  const urls = {};
  for (const source of sources) {
    const url = String(e[envKeyForSource(source)] || '').trim();
    if (url) urls[source] = url;
  }
  const transport = String(e.RTSP_TRANSPORT || 'tcp').trim().toLowerCase() === 'udp' ? 'udp' : 'tcp';
  const audioRaw = String(e.RTSP_AUDIO || '').trim().toLowerCase();
  return {
    sources,
    urls,
    transport,
    audio: audioRaw === '1' || audioRaw === 'copy',
    videoTag: /^[a-z0-9]{4}$/i.test(String(e.RTSP_VIDEO_TAG || '').trim()) ? String(e.RTSP_VIDEO_TAG).trim() : '',
    startTimeoutMs: positiveInt(e.RTSP_START_TIMEOUT_MS, 10000),
    stopTimeoutMs: positiveInt(e.RTSP_STOP_TIMEOUT_MS, 5000),
    ioTimeoutUs: positiveInt(e.RTSP_IO_TIMEOUT_MS, 5000) * 1000,
    maxSeconds: positiveInt(e.RTSP_MAX_SECONDS, 4 * 60 * 60),
  };
}

/** Camera URLs carry the camera login; nothing derived from one may be logged or returned verbatim. */
function redactUrls(text, urls) {
  let out = String(text || '');
  for (const url of urls || []) {
    if (url) out = out.split(url).join('<rtsp-url>');
  }
  return out.replace(/(rtsps?:\/\/)[^/\s@]*@/gi, '$1***@');
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** OBS's default "%CCYY-%MM-%DD %hh-%mm-%ss" in local time, so cam and master files of one take share a name. */
function obsStyleBaseName(ms) {
  const d = new Date(ms);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
    + ' ' + pad2(d.getHours()) + '-' + pad2(d.getMinutes()) + '-' + pad2(d.getSeconds());
}

function uniqueOutputPath(dir, baseName) {
  let candidate = path.join(dir, baseName + '.mp4');
  for (let i = 2; fs.existsSync(candidate); i += 1) {
    candidate = path.join(dir, baseName + ' (' + i + ').mp4');
  }
  return candidate;
}

function buildFfmpegArgs(config, url, outPath) {
  const args = ['-hide_banner', '-nostats', '-loglevel', 'warning'];
  if (/^rtsps?:\/\//i.test(url)) {
    args.push('-rtsp_transport', config.transport, '-timeout', String(config.ioTimeoutUs));
  }
  args.push('-i', url, '-map', '0:v:0');
  if (config.audio) args.push('-map', '0:a:0?');
  args.push('-c', 'copy');
  if (!config.audio) args.push('-an');
  if (config.videoTag) args.push('-tag:v', config.videoTag);
  // Fragmented MP4: the file is playable up to the last fragment even if ffmpeg
  // is killed, and it grows every second so feeds_writing sees it writing.
  // -t bounds an ffmpeg orphaned by a killed agent; it is not a take-length limit in practice.
  args.push(
    '-t', String(config.maxSeconds),
    '-f', 'mp4',
    '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
    '-frag_duration', '1000000',
    '-n', outPath,
  );
  return args;
}

function fileSize(filePath) {
  try {
    const st = fs.statSync(filePath);
    return st.isFile() ? st.size : null;
  } catch (_) {
    return null;
  }
}

function createRtspCapture(opts) {
  const options = opts || {};
  const config = options.config || readRtspConfig(options.env || process.env);
  const recordDir = options.recordDir || '';
  const ffmpegBin = typeof options.ffmpegBin === 'function' ? options.ffmpegBin : () => options.ffmpegBin || 'ffmpeg';
  const spawnImpl = options.spawn || spawn;
  const now = options.now || Date.now;
  const log = options.log || console;
  const pollMs = positiveInt(options.pollMs, 100);
  const allUrls = Object.values(config.urls);

  const handled = new Set(config.sources);
  let captures = new Map();
  let pausedAt = null;

  function redact(text) {
    return redactUrls(text, allUrls);
  }

  function handles(source) {
    return handled.has(source);
  }

  /** null when every listed source can be captured, else a caller-facing reason. */
  function configProblem(sources) {
    if (!recordDir) return 'OBS_RECORD_DIR not set';
    const missing = sources.filter((s) => !config.urls[s]).map((s) => s + ': ' + envKeyForSource(s) + ' not set');
    return missing.length ? missing.join('; ') : null;
  }

  function waitForExit(capture, ms) {
    if (capture.exited) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      capture.exitWaiters.push(() => { clearTimeout(timer); resolve(true); });
    });
  }

  function startOne(source, startedAtMs) {
    let filePath;
    try {
      const dir = path.join(recordDir, source);
      fs.mkdirSync(dir, { recursive: true });
      filePath = uniqueOutputPath(dir, obsStyleBaseName(startedAtMs));
    } catch (e) {
      return Promise.resolve({ ok: false, source, error: 'output folder: ' + (e && (e.code || e.message || e)) });
    }
    const url = config.urls[source];
    const capture = {
      source,
      filePath,
      startedAt: now(),
      proc: null,
      exited: false,
      exitCode: null,
      exitSignal: null,
      stopping: false,
      diedDuringRecording: false,
      stderrTail: '',
      pauses: [],
      exitWaiters: [],
    };

    let proc;
    try {
      proc = spawnImpl(ffmpegBin(), buildFfmpegArgs(config, url, filePath), { stdio: ['pipe', 'ignore', 'pipe'] });
    } catch (e) {
      return Promise.resolve({ ok: false, source, error: 'spawn_failed: ' + redact(e && (e.message || e)) });
    }
    capture.proc = proc;
    if (proc.stdin) proc.stdin.on('error', () => {});
    proc.stderr.on('data', (chunk) => {
      capture.stderrTail = (capture.stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_LEN);
    });
    const onExit = (code, signal) => {
      if (capture.exited) return;
      capture.exited = true;
      capture.exitCode = code;
      capture.exitSignal = signal || null;
      if (!capture.stopping && captures.get(source) === capture) {
        capture.diedDuringRecording = true;
        const secs = ((now() - capture.startedAt) / 1000).toFixed(1);
        log.warn('[rtsp] WARN: ' + source + ' ffmpeg exited mid-take after ' + secs + 's code=' + code
          + (signal ? ' signal=' + signal : '') + ': ' + redact(capture.stderrTail.trim()).slice(-300));
      }
      for (const waiter of capture.exitWaiters.splice(0)) waiter();
    };
    proc.on('exit', onExit);
    proc.on('error', (e) => {
      capture.stderrTail += '\n' + (e && (e.message || e));
      onExit(null, null);
    });

    // Ready = ffmpeg reached the camera, parsed the stream and wrote the MP4 header.
    return new Promise((resolve) => {
      const deadline = now() + config.startTimeoutMs;
      const tick = () => {
        if (capture.exited) {
          resolve({ ok: false, source, error: 'ffmpeg exited before writing (code=' + capture.exitCode + '): '
            + redact(capture.stderrTail.trim()).slice(-200) });
          return;
        }
        if ((fileSize(filePath) || 0) > 0) {
          // Pause offsets are measured from here, the closest the agent gets to file t=0.
          capture.startedAt = now();
          resolve({ ok: true, source, filePath, capture });
          return;
        }
        if (now() >= deadline) {
          capture.stopping = true;
          try { proc.kill('SIGKILL'); } catch (_) {}
          resolve({ ok: false, source, error: 'no data from camera within ' + config.startTimeoutMs + 'ms: '
            + redact(capture.stderrTail.trim()).slice(-200) });
          return;
        }
        setTimeout(tick, pollMs);
      };
      tick();
    });
  }

  async function stopCapture(capture) {
    capture.stopping = true;
    if (!capture.exited) {
      // 'q' makes ffmpeg flush the last fragment and exit 0; signals are the fallback.
      try { capture.proc.stdin.end('q'); } catch (_) {}
      if (!(await waitForExit(capture, config.stopTimeoutMs))) {
        try { capture.proc.kill('SIGINT'); } catch (_) {}
        if (!(await waitForExit(capture, 2000))) {
          try { capture.proc.kill('SIGKILL'); } catch (_) {}
          await waitForExit(capture, 2000);
        }
      }
    }
    const sizeBytes = fileSize(capture.filePath);
    const error = capture.diedDuringRecording
      ? 'ffmpeg exited mid-take (code=' + capture.exitCode + ')'
      : (!sizeBytes ? 'no file written' : null);
    const result = {
      source: capture.source,
      filePath: sizeBytes === null ? null : capture.filePath,
      ok: !error,
      sizeBytes,
      error,
      paused_spans_s: capture.pauses.map(([a, b]) => [
        Math.round((a - capture.startedAt) / 100) / 10,
        b === null ? null : Math.round((b - capture.startedAt) / 100) / 10,
      ]),
    };
    log.log('[rtsp] ' + capture.source + ' stopped bytes=' + sizeBytes + ' exit=' + capture.exitCode
      + (result.paused_spans_s.length ? ' paused_s=' + JSON.stringify(result.paused_spans_s) : '')
      + (error ? ' error=' + error : ''));
    return result;
  }

  /** Starts every source or none: on any failure the ones already running are stopped. */
  async function start(sources, startedAtMs) {
    if (captures.size) return { ok: false, error: 'rtsp capture already running' };
    const list = sources.filter(handles);
    if (!list.length) return { ok: true, sources: [] };
    const problem = configProblem(list);
    if (problem) return { ok: false, error: problem };
    pausedAt = null;
    let results;
    try {
      results = await Promise.all(list.map((source) => startOne(source, startedAtMs)));
    } catch (e) {
      results = [{ ok: false, source: list[0], error: redact(e && (e.message || e)) }];
    }
    const failed = results.find((r) => !r.ok);
    const started = results.filter((r) => r.ok);
    if (failed) {
      await Promise.all(started.map((r) => stopCapture(r.capture)));
      log.warn('[rtsp] start failed ' + failed.source + ': ' + failed.error);
      return { ok: false, error: failed.source + ': ' + failed.error };
    }
    captures = new Map(started.map((r) => [r.source, r.capture]));
    for (const r of started) log.log('[rtsp] ' + r.source + ' recording (stream copy) -> ' + path.basename(r.filePath));
    return { ok: true, sources: started.map((r) => r.source) };
  }

  async function stop() {
    const list = Array.from(captures.values());
    if (pausedAt !== null) resume();
    const results = await Promise.all(list.map(stopCapture));
    captures = new Map();
    return results;
  }

  // Stream copy cannot pause: the camera keeps sending and ffmpeg keeps writing.
  // The paused spans are recorded (seconds from file start) so an editor can cut them.
  function pause() {
    if (!captures.size || pausedAt !== null) return;
    pausedAt = now();
    for (const c of captures.values()) c.pauses.push([pausedAt, null]);
    log.log('[rtsp] pause noted; RTSP files keep recording through the pause');
  }

  function resume() {
    if (pausedAt === null) return;
    const t = now();
    for (const c of captures.values()) {
      const last = c.pauses[c.pauses.length - 1];
      if (last && last[1] === null) last[1] = t;
    }
    pausedAt = null;
  }

  function activeSources() {
    return Array.from(captures.keys());
  }

  function status() {
    const out = {};
    for (const [source, c] of captures) {
      out[source] = { running: !c.exited, bytes: fileSize(c.filePath), died: c.diedDuringRecording };
    }
    return out;
  }

  function describe() {
    const cams = {};
    for (const source of config.sources) cams[source] = { url_configured: !!config.urls[source] };
    return {
      enabled: config.sources.length > 0,
      sources: config.sources.slice(),
      cameras: cams,
      transport: config.transport,
      audio: config.audio,
      video_tag: config.videoTag || null,
      active: status(),
    };
  }

  return { handles, configProblem, start, stop, pause, resume, activeSources, status, describe, config };
}

module.exports = { createRtspCapture, readRtspConfig, buildFfmpegArgs, redactUrls, obsStyleBaseName, envKeyForSource };
