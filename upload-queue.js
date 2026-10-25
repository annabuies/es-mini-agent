'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

const { runMultipartUpload, signS3Request } = require('./storage-upload');
const { mixArgs, planWatch, probeMedia, watchArgs } = require('./watch-rendition');

const STABILITY_POLL_MS = 2000;
const STABILITY_WARN_MS = 60000;
const MAX_ERROR_LEN = 300;
const MASTER_SOURCE = 'master';
const AUDIO_KIND = 'audio';
const EMPTY_CAMERA_FILE_BYTES = 64 * 1024;
// The proxy is a software encode of a 4K file and takes every core. It must never
// run during a take: on 2026-09-30 the takes started within a minute of the last
// one (proxies of that take still encoding) were the ones where the cameras' RTSP
// streams failed to start or dropped mid-take (es-mini-agent #10).
const PROXY_POLL_MS = 2000;
const PROXY_HOLD_MS = 30000;
const NICE_BIN = '/usr/bin/nice';

function isCameraRecording(job) {
  return !!job && job.source !== MASTER_SOURCE && job.kind !== AUDIO_KIND && /^cam(?:era)?[-_ ]?\d+$/i.test(String(job.source || ''));
}
let ffmpegBinMemo = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toSafeFileName(value) {
  return String(value || '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+/, '')
    .slice(0, 180) || 'upload';
}

function truncateError(value) {
  const s = typeof value === 'string' ? value : String(value || '');
  return s.length > MAX_ERROR_LEN ? s.slice(0, MAX_ERROR_LEN) : s;
}

async function readJsonFile(filePath) {
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw e;
  }
}

async function writeJsonFileAtomic(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = filePath + '.tmp';
  await fsp.writeFile(tmpPath, JSON.stringify(value, null, 2), 'utf8');
  await fsp.rename(tmpPath, filePath);
}

async function removeFileIfExists(filePath) {
  try {
    await fsp.unlink(filePath);
  } catch (e) {
    if (!e || e.code !== 'ENOENT') throw e;
  }
}

async function readResponseTextSafe(res) {
  try {
    return await res.text();
  } catch (_) {
    return '';
  }
}

// Capture/health fields the stop path attaches to a take's files. They ride on
// the upload_confirmed webhook so the cloud can mark the booking thread.
// Since 2026.10.20-1 (Build 42): rendition (original|watch|mic|mix|proxy),
// recorded_at (the take's OBS start), duration_s on every file, offset_s and
// audio (mix|none) on watch copies, original_key, and the take's audio verdict.
const META_KEYS = ['capture_mode', 'fallback', 'fallback_reason', 'health', 'health_reason', 'duration_s', 'master_duration_s', 'short_by_s', 'reconnects', 'lost_s', 'resume_wait_s', 'take_health', 'fallback_sources', 'failed_sources',
  'rendition', 'recorded_at', 'offset_s', 'audio', 'original_key', 'audio_level', 'audio_codes'];
// Small structured blocks (the stop result's audio_health / timing), passed as JSON.
const OBJECT_META_KEYS = ['audio_health', 'timing'];
const MAX_OBJECT_META_BYTES = 8 * 1024;
const RENDITIONS = ['original', 'watch', 'mic', 'mix', 'proxy'];

function cleanMeta(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  for (const key of META_KEYS) {
    const v = value[key];
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' || typeof v === 'boolean' || Number.isFinite(v)) out[key] = v;
    else if (Array.isArray(v)) out[key] = v.filter((x) => typeof x === 'string');
  }
  if (out.rendition !== undefined && !RENDITIONS.includes(out.rendition)) delete out.rendition;
  for (const key of OBJECT_META_KEYS) {
    const v = value[key];
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    try {
      const json = JSON.stringify(v);
      if (Buffer.byteLength(json) <= MAX_OBJECT_META_BYTES) out[key] = JSON.parse(json);
    } catch (_) { /* not JSON-safe: dropped */ }
  }
  return Object.keys(out).length ? out : null;
}

/** The webhook's kind: "audio" for mic/mix files, "video" for camera, master and watch files. */
function webhookKind(kind) {
  return kind === AUDIO_KIND ? 'audio' : 'video';
}

// Object keys the agent may write besides recordings/<building>/...: the watch copy
// and the take's mix (Build 42 contract).
const KEY_RE = /^(?:recordings|stream|audio|proxies)\/[A-Za-z0-9._ -]+(?:\/[A-Za-z0-9._ -]+)+$/;

function resolveFfprobeBin() {
  const configured = String(process.env.FFPROBE_BIN || '').trim();
  return configured || path.join(path.dirname(resolveFfmpegBin().bin), 'ffprobe');
}

function resolveFfmpegBin() {
  if (ffmpegBinMemo) return ffmpegBinMemo;

  const envBin = String(process.env.FFMPEG_BIN || '').trim();
  if (envBin && fs.existsSync(envBin)) {
    ffmpegBinMemo = { bin: envBin, source: 'env' };
    return ffmpegBinMemo;
  }

  const candidates = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      ffmpegBinMemo = { bin: candidate, source: 'probe' };
      return ffmpegBinMemo;
    }
  }

  ffmpegBinMemo = { bin: 'ffmpeg', source: 'path' };
  return ffmpegBinMemo;
}

function createUploadQueue(opts) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const r2Config = options.r2Config && typeof options.r2Config === 'object' ? options.r2Config : {};
  const stateDir = path.resolve(String(options.stateDir || path.join(process.cwd(), '.r2-uploads')));
  const isRecording = typeof options.isRecording === 'function' ? options.isRecording : (() => false);
  const webhookUrl = options.webhookUrl;
  const buildingId = String(options.buildingId || '').trim() || 'unknown';
  const uploader = typeof options.uploader === 'function' ? options.uploader : runMultipartUpload;
  const audioSplit = !!options.audioSplit;
  // The take's four mics mixed into one stereo .m4a (audio/<building>/<base>-mix.m4a).
  // Defaults on with the split; AUDIO_MIX=0 rolls back only the mix.
  const audioMix = options.audioMix === undefined ? audioSplit : !!options.audioMix;
  // The watch copy is also uploaded under the old proxies/ key (no webhook), so
  // the Slack footage link, ClickUp sync and retention that read proxies/ keep
  // working until they move to stream/. PROXY_COPY=0 drops the second upload.
  const proxyCopy = options.proxyCopy !== false;
  // Delete a camera/master original from the Mini once S3 holds a verified copy
  // (the uploader checks size with HeadObject) and the proxy / audio split that
  // read it are done. ~43 GB per recorded hour vs ~100 GB free (Robbie, Sep 29).
  const deleteAfterUpload = !!options.deleteAfterUpload;
  const stabilityPollMs = Number.isFinite(options.stabilityPollMs) && options.stabilityPollMs >= 0
    ? options.stabilityPollMs
    : STABILITY_POLL_MS;

  const proxyPollMs = Number.isFinite(options.proxyPollMs) && options.proxyPollMs >= 0 ? options.proxyPollMs : PROXY_POLL_MS;

  const queue = [];
  const pendingProxyJobs = [];
  let proxyWorkerRunning = false;
  let activeProxy = null; // { proc, closed } while a proxy encode runs
  let proxyHoldUntil = 0;
  const queuedFilePaths = new Set();
  const completedFilePaths = new Set();
  let activeJob = null;
  let activeSnapshot = null;
  // A local original is deleted (deleteAfterUpload) once its upload is verified AND
  // nothing still needs it: a camera file waits for its own watch copy, the master
  // for every camera's watch copy of that take (they read its mic tracks).
  const holds = new Map(); // filePath -> Set of tokens
  const removable = new Map(); // filePath -> key, upload verified, waiting for holds
  let lastConfirmed = null;
  let workerRunning = false;

  function stateFilePathForKey(key) {
    return path.join(stateDir, toSafeFileName(key) + '.state.json');
  }

  function buildBaseState(job, status) {
    return {
      version: 1,
      kind: job.kind,
      filePath: job.filePath,
      key: job.key,
      source: job.source,
      sessionRef: job.sessionRef,
      removeAfterConfirm: job.removeAfterConfirm,
      meta: job.meta,
      watch: job.watch || null,
      keyOverride: job.keyOverride || null,
      sizeBytes: null,
      status,
      enqueuedAt: job.enqueuedAt,
      finishedAt: null,
      error: null,
    };
  }

  async function writeState(stateFilePath, value) {
    try {
      const existing = await readJsonFile(stateFilePath);
      const base = existing && typeof existing === 'object' ? existing : {};
      const next = Object.assign({}, base, value);
      await writeJsonFileAtomic(stateFilePath, next);
    } catch (e) {
      console.warn('[upload-queue] state write failed:', e && (e.stack || e.message || e));
    }
  }

  async function updateStateFields(stateFilePath, fields) {
    try {
      const existing = await readJsonFile(stateFilePath);
      const base = existing && typeof existing === 'object' ? existing : {};
      const next = Object.assign({}, base, fields);
      await writeJsonFileAtomic(stateFilePath, next);
    } catch (e) {
      console.warn('[upload-queue] state update failed:', e && (e.stack || e.message || e));
    }
  }

  async function abortRemoteMultipartIfPresent(stateData) {
    if (!stateData || !stateData.uploadId || !stateData.key) return;
    try {
      let sessionToken = null;
      let accessKeyId = r2Config.accessKeyId;
      let secretAccessKey = r2Config.secretAccessKey;
      if (typeof r2Config.getCredentials === 'function') {
        const creds = await r2Config.getCredentials();
        if (creds && typeof creds === 'object') {
          accessKeyId = creds.accessKeyId;
          secretAccessKey = creds.secretAccessKey;
          sessionToken = creds.sessionToken || null;
        }
      }
      const signed = signS3Request({
        method: 'DELETE',
        key: String(stateData.key),
        query: { uploadId: String(stateData.uploadId) },
        accessKeyId,
        secretAccessKey,
        sessionToken,
        bucket: r2Config.bucket,
        endpoint: r2Config.endpoint,
        region: r2Config.region,
      });
      const res = await fetch(signed.url, {
        method: 'DELETE',
        headers: signed.headers,
      });
      if (!res.ok) {
        const detail = truncateError(await readResponseTextSafe(res));
        console.warn('[upload-queue] AbortMultipartUpload failed key=' + stateData.key + ' status=' + res.status + ' detail=' + detail);
      }
    } catch (e) {
      console.warn('[upload-queue] AbortMultipartUpload error key=' + stateData.key + ':', e && (e.stack || e.message || e));
    }
  }

  async function waitForStableSize(filePath, key) {
    let previousSize = null;
    let warnAt = Date.now() + STABILITY_WARN_MS;
    while (true) {
      let st;
      try {
        st = await fsp.stat(filePath);
      } catch (e) {
        if (e && e.code === 'ENOENT') {
          return { ok: false, reason: 'file_missing' };
        }
        throw e;
      }
      if (!st.isFile()) {
        return { ok: false, reason: 'file_missing' };
      }
      const size = st.size;
      if (previousSize !== null && previousSize === size) {
        return { ok: true, sizeBytes: size };
      }
      previousSize = size;
      if (Date.now() >= warnAt) {
        console.warn('[upload-queue] still waiting for stable file size key=' + key + ' file=' + filePath);
        warnAt = Date.now() + STABILITY_WARN_MS;
      }
      await sleep(stabilityPollMs);
    }
  }

  function runFfmpeg(args) {
    return runFfmpegWith(resolveFfmpegBin().bin, args);
  }

  function runFfmpegWith(bin, args) {
    return new Promise((resolve, reject) => {
      let proc;
      try {
        proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      } catch (e) {
        reject(e);
        return;
      }
      let stderrTail = '';
      proc.stderr.on('data', (chunk) => {
        stderrTail = (stderrTail + chunk.toString('utf8')).slice(-MAX_ERROR_LEN);
      });
      proc.on('error', (e) => reject(e));
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error('ffmpeg exited with code ' + code + (stderrTail ? ': ' + stderrTail : '')));
      });
    });
  }

  function proxiesBlocked() {
    return isRecording() || Date.now() < proxyHoldUntil;
  }

  /** The proxy encode: one at a time, low priority, killed the moment a take starts. */
  function runProxyFfmpeg(args) {
    return new Promise((resolve, reject) => {
      let proc;
      try {
        const ffmpegBin = resolveFfmpegBin().bin;
        proc = fs.existsSync(NICE_BIN)
          ? spawn(NICE_BIN, ['-n', '15', ffmpegBin].concat(args), { stdio: ['ignore', 'ignore', 'pipe'] })
          : spawn(ffmpegBin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      } catch (e) {
        reject(e);
        return;
      }
      const run = { proc, preempted: false, closed: null };
      const preempt = () => {
        if (run.preempted) return;
        run.preempted = true;
        try { proc.kill('SIGKILL'); } catch (_) {}
      };
      run.preempt = preempt;
      // holdProxies() is the fast path; this also catches a take that started without it.
      const watch = setInterval(() => { if (proxiesBlocked()) preempt(); }, 500);
      if (watch.unref) watch.unref();
      let stderrTail = '';
      proc.stderr.on('data', (chunk) => {
        stderrTail = (stderrTail + chunk.toString('utf8')).slice(-MAX_ERROR_LEN);
      });
      run.closed = new Promise((done) => {
        const finish = (err) => {
          clearInterval(watch);
          if (activeProxy === run) activeProxy = null;
          done();
          if (run.preempted) {
            const e = new Error('proxy stopped for a take');
            e.preempted = true;
            reject(e);
          } else if (err) reject(err);
          else resolve();
        };
        proc.on('error', (e) => finish(e));
        proc.on('close', (code) => finish(code === 0 ? null : new Error('ffmpeg exited with code ' + code + (stderrTail ? ': ' + stderrTail : ''))));
      });
      activeProxy = run;
    });
  }

  /**
   * Called at the start of a take, before any camera capture starts: stops a
   * running proxy encode (it is redone after the take) and keeps new ones from
   * starting until the take is recording. Resolves once the encoder is gone.
   */
  async function holdProxies(ms) {
    proxyHoldUntil = Date.now() + (Number.isFinite(ms) && ms >= 0 ? ms : PROXY_HOLD_MS);
    const run = activeProxy;
    if (!run) return { stopped: false };
    run.preempt();
    await run.closed;
    return { stopped: true };
  }

  function runFfprobe(args) {
    return new Promise((resolve, reject) => {
      const ffprobeBin = resolveFfprobeBin();
      let proc;
      try {
        proc = spawn(ffprobeBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        reject(e);
        return;
      }
      let stdout = '';
      let stderrTail = '';
      proc.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
      proc.stderr.on('data', (chunk) => { stderrTail = (stderrTail + chunk.toString('utf8')).slice(-MAX_ERROR_LEN); });
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code === 0) resolve(stdout);
        else reject(new Error('ffprobe exited with code ' + code + (stderrTail ? ': ' + stderrTail : '')));
      });
    });
  }

  /** Low-priority one-shot ffmpeg (the mix encode). */
  function runNiceFfmpeg(args) {
    const bin = resolveFfmpegBin().bin;
    return fs.existsSync(NICE_BIN) ? runFfmpegWith(NICE_BIN, ['-n', '15', bin].concat(args)) : runFfmpegWith(bin, args);
  }

  async function splitMasterAudio(job) {
    if (!audioSplit) {
      console.log('[upload-queue] audio split disabled key=' + job.key);
      return;
    }
    const meta = job.meta || {};
    const health = meta.audio_health && Array.isArray(meta.audio_health.tracks) ? meta.audio_health : null;
    // Every mic and mix file carries the take's start and length (rendition fields).
    const takeFields = {};
    if (meta.recorded_at) takeFields.recorded_at = meta.recorded_at;
    if (Number.isFinite(meta.duration_s)) takeFields.duration_s = meta.duration_s;
    try {
      const output = await runFfprobe(['-v', 'error', '-select_streams', 'a', '-show_streams', '-of', 'json', job.filePath]);
      const parsed = JSON.parse(output);
      const streamCount = Array.isArray(parsed.streams) ? parsed.streams.length : 0;
      if (streamCount < 4) console.warn('[upload-queue] WARN: master has ' + streamCount + ' audio streams; splitting available tracks key=' + job.key);
      const splitCount = Math.min(streamCount, 4);
      const base = path.basename(job.filePath, path.extname(job.filePath));
      for (let index = 0; index < splitCount; index += 1) {
        const mic = 'mic' + (index + 1);
        const filePath = path.join(path.dirname(job.filePath), base + '-' + mic + '.m4a');
        // Stream-copy invariant: ffmpeg -c copy; mic tracks are never re-encoded.
        await runFfmpeg(['-y', '-i', job.filePath, '-map', '0:a:' + index, '-c', 'copy', filePath]);
        const micMeta = Object.assign({ rendition: 'mic' }, takeFields);
        const track = health && health.tracks.find((t) => t && t.index === index);
        if (track) Object.assign(micMeta, { audio_health: track, audio_level: track.level, audio_codes: track.codes });
        const out = enqueue({ filePath, source: mic, kind: AUDIO_KIND, sessionRef: job.sessionRef, removeAfterConfirm: true, meta: micMeta });
        if (!out.queued) {
          await removeFileIfExists(filePath);
          console.warn('[upload-queue] audio enqueue skipped source=' + mic + ' key=' + job.key + ' reason=' + out.reason);
        }
      }
      if (audioMix && splitCount > 0) await makeMix(job, base, splitCount, takeFields, health);
    } catch (e) {
      console.warn('[upload-queue] audio split failed key=' + job.key + ' error=' + truncateError(e && (e.message || e.stack || e)));
    }
  }

  /** The take's four mics as one stereo file on the master's timeline: audio/<building>/<base>-mix.m4a. */
  async function makeMix(job, base, tracks, takeFields, health) {
    const filePath = path.join(path.dirname(job.filePath), base + '-mix.m4a');
    try {
      await runNiceFfmpeg(mixArgs({ masterPath: job.filePath, masterTracks: tracks, outPath: filePath }));
      const mixMeta = Object.assign({ rendition: 'mix' }, takeFields);
      if (health) Object.assign(mixMeta, { audio_level: health.level, audio_codes: health.codes });
      const out = enqueue({ filePath, source: 'mix', kind: AUDIO_KIND, sessionRef: job.sessionRef, removeAfterConfirm: true, key: 'audio/' + buildingId + '/' + base + '-mix.m4a', meta: mixMeta });
      if (!out.queued) {
        await removeFileIfExists(filePath);
        console.warn('[upload-queue] mix enqueue skipped key=' + job.key + ' reason=' + out.reason);
      }
    } catch (e) {
      await removeFileIfExists(filePath).catch(() => {});
      console.warn('[upload-queue] mix failed key=' + job.key + ' error=' + truncateError(e && (e.message || e.stack || e)));
    }
  }

  // A 0-byte file has nothing to upload (S3 multipart needs at least one byte, so
  // it used to fail forever with "runMultipartUpload requires sizeBytes"). A camera
  // file is reported through the normal upload_confirmed webhook with sizeBytes 0,
  // which the cloud posts as "Camera N recording failed" (es-honeybook #18) and
  // never links. Audio/master files are only logged. The entry is then dropped.
  async function postFailedCamera(key, source, sessionRef, meta) {
    const url = typeof webhookUrl === 'function' ? webhookUrl() : webhookUrl;
    if (!url) return;
    try {
      const res = await fetch(String(url), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(Object.assign({}, meta || {}, {
          event: 'upload_confirmed',
          key,
          sizeBytes: 0,
          confirmedAt: new Date().toISOString(),
          kind: 'video',
          rendition: 'original',
          building_id: buildingId,
          source,
          session_ref: sessionRef,
        })),
      });
      if (!res.ok) console.warn('[upload-queue] failed-camera webhook failed status=' + res.status + ' key=' + key);
    } catch (e) {
      console.warn('[upload-queue] failed-camera webhook error key=' + key + ':', e && (e.message || e));
    }
  }

  async function reportEmptyFile(job, sizeBytes, why) {
    console.warn('[upload-queue] ' + (why || 'empty file') + ', nothing to upload key=' + job.key + ' bytes=' + (sizeBytes || 0) + ' file=' + job.filePath);
    if (isCameraRecording(job)) await postFailedCamera(job.key, job.source, job.sessionRef, job.meta);
    await removeFileIfExists(job.stateFilePath);
    completedFilePaths.add(job.filePath);
    releaseWatchHold(job);
  }

  /**
   * A camera that wrote no file this take never reaches the queue, so the
   * booking thread would just lack it. Report it the way an empty file is
   * reported (sizeBytes 0 = "Camera N recording failed").
   */
  function reportMissingCamera(input) {
    const source = input && input.source ? String(input.source) : '';
    if (!isCameraRecording({ source, kind: 'recording' })) return Promise.resolve();
    const fileName = path.basename(String(input.fileName || 'missing.mp4'));
    const key = 'recordings/' + buildingId + '/' + source + '/' + fileName;
    console.warn('[upload-queue] camera wrote no file this take, reporting as failed key=' + key);
    return postFailedCamera(key, source, input.sessionRef || null, cleanMeta(input.meta));
  }

  async function runJob(job) {
    const stable = await waitForStableSize(job.filePath, job.key);
    if (!stable.ok) {
      await updateStateFields(job.stateFilePath, {
        status: 'error',
        finishedAt: new Date().toISOString(),
        error: stable.reason,
      });
      console.warn('[upload-queue] file missing before upload key=' + job.key + ' file=' + job.filePath);
      releaseWatchHold(job);
      return;
    }

    // A camera "recording" under 64 KiB has no video in it: Source Record's silent
    // cam1 failure leaves a 1,737-byte file with zero streams (es-mini-agent #10),
    // which used to be uploaded and confirmed as a real take. One second of any
    // camera here is megabytes. Report it as failed, like a 0-byte file.
    if (stable.sizeBytes === 0 || (isCameraRecording(job) && stable.sizeBytes < EMPTY_CAMERA_FILE_BYTES)) {
      await reportEmptyFile(job, stable.sizeBytes);
      return;
    }
    // The stop path's file check found no usable video (e.g. no video stream).
    if (isCameraRecording(job) && job.meta && job.meta.health === 'failed') {
      await reportEmptyFile(job, stable.sizeBytes, 'no usable video (' + (job.meta.health_reason || 'failed') + ')');
      return;
    }

    await updateStateFields(job.stateFilePath, {
      status: 'uploading',
      sizeBytes: stable.sizeBytes,
      error: null,
      finishedAt: null,
    });

    activeSnapshot = {
      key: job.key,
      partsCompleted: 0,
      totalParts: Math.ceil(stable.sizeBytes / (25 * 1024 * 1024)),
      bytesUploaded: 0,
    };

    try {
      const summary = await uploader({
        r2Config,
        key: job.key,
        filePath: job.filePath,
        sizeBytes: stable.sizeBytes,
        stateFilePath: job.stateFilePath,
        isRecording,
        shouldAbort: () => false,
        webhookUrl: typeof webhookUrl === 'function' ? webhookUrl() : webhookUrl,
        webhookExtra: Object.assign({}, job.meta || {}, { kind: webhookKind(job.kind), building_id: buildingId, source: job.source, session_ref: job.sessionRef }),
        abortOnFailure: false,
        deleteObjectAfterVerify: false,
        onProgress: (partial) => {
          activeSnapshot = {
            key: job.key,
            partsCompleted: Number(partial && partial.partsCompleted) || 0,
            totalParts: Number(partial && partial.totalParts) || activeSnapshot.totalParts || 0,
            bytesUploaded: Number(partial && partial.bytesUploaded) || 0,
          };
        },
      });

      await removeFileIfExists(job.stateFilePath);
      if (job.removeAfterConfirm) await removeFileIfExists(job.filePath);
      completedFilePaths.add(job.filePath);
      lastConfirmed = {
        key: summary && summary.key ? summary.key : job.key,
        sizeBytes: summary && Number(summary.sizeBytes) || stable.sizeBytes,
        finishedAt: new Date().toISOString(),
      };
      const partsUploaded = summary && Number(summary.partsUploaded) || activeSnapshot.partsCompleted || 0;
      console.log('[upload-queue] confirmed ' + job.key + ' (' + partsUploaded + ' parts)');
      if (job.source === MASTER_SOURCE) {
        console.log('[upload-queue] proxy skipped for master key=' + job.key);
        await splitMasterAudio(job);
        await removeUploadedOriginal(job);
      } else if (job.kind === AUDIO_KIND) {
        console.log('[upload-queue] proxy skipped for audio key=' + job.key);
      } else {
        try {
          maybeMakeProxy(job).catch((e) => {
            console.warn('[upload-queue] proxy step failed key=' + job.key + ':', e && (e.stack || e.message || e));
          });
        } catch (e) {
          console.warn('[upload-queue] proxy step threw synchronously key=' + job.key + ':', e && (e.stack || e.message || e));
        }
      }
    } catch (e) {
      const detail = truncateError(e && (e.message || e.stack || e));
      await updateStateFields(job.stateFilePath, {
        status: 'error',
        finishedAt: new Date().toISOString(),
        error: detail || 'upload_failed',
      });
      console.warn('[upload-queue] upload failed key=' + job.key + ' error=' + (detail || 'upload_failed'));
      // A failed upload is not retried (see sweep), so it will never get a watch copy.
      releaseWatchHold(job);
    } finally {
      activeSnapshot = null;
    }
  }

  function hold(filePath, token) {
    if (!filePath) return;
    if (!holds.has(filePath)) holds.set(filePath, new Set());
    holds.get(filePath).add(token);
  }

  function release(filePath, token) {
    const set = holds.get(filePath);
    if (!set) return;
    set.delete(token);
    if (set.size === 0) holds.delete(filePath);
    maybeRemoveOriginal(filePath).catch(() => {});
  }

  /** A camera job whose watch copy will never be made no longer needs the take's master. */
  function releaseWatchHold(job) {
    if (job && job.watch && job.watch.masterPath) release(job.watch.masterPath, 'watch:' + job.filePath);
  }

  async function maybeRemoveOriginal(filePath) {
    if (!removable.has(filePath) || holds.has(filePath)) return;
    const key = removable.get(filePath);
    removable.delete(filePath);
    try {
      await removeFileIfExists(filePath);
      console.log('[upload-queue] removed local original after verified upload key=' + key);
    } catch (e) {
      console.warn('[upload-queue] could not remove local original key=' + key + ':', e && (e.message || e));
    }
  }

  async function removeUploadedOriginal(job) {
    if (!deleteAfterUpload || job.kind === AUDIO_KIND || job.removeAfterConfirm) return;
    removable.set(job.filePath, job.key);
    if (holds.has(job.filePath)) console.log('[upload-queue] keeping local original until the take\'s watch copies are made key=' + job.key);
    await maybeRemoveOriginal(job.filePath);
  }

  function maybeMakeProxy(job) {
    pendingProxyJobs.push(job);
    if (proxiesBlocked()) console.warn('[upload-queue] watch copy deferred (recording active) key=' + job.key);
    ensureProxyWorker().catch((e) => {
      console.warn('[upload-queue] proxy worker error:', e && (e.stack || e.message || e));
    });
    return Promise.resolve();
  }

  async function ensureProxyWorker() {
    if (proxyWorkerRunning) return;
    proxyWorkerRunning = true;
    try {
      while (pendingProxyJobs.length > 0) {
        if (proxiesBlocked()) {
          await new Promise((resolve) => { const t = setTimeout(resolve, proxyPollMs); if (t.unref) t.unref(); });
          continue;
        }
        // A copy stopped for a take stays at the head of the line and is redone.
        if (await makeProxy(pendingProxyJobs[0])) pendingProxyJobs.shift();
      }
    } finally {
      proxyWorkerRunning = false;
    }
  }

  async function uploadRendition(job, filePath, key, url, extra) {
    const st = await fsp.stat(filePath);
    const stateFilePath = stateFilePathForKey(key);
    await uploader({
      r2Config,
      key,
      filePath,
      sizeBytes: st.size,
      stateFilePath,
      isRecording,
      shouldAbort: () => false,
      webhookUrl: url,
      webhookExtra: extra,
      abortOnFailure: false,
      deleteObjectAfterVerify: false,
    });
    await removeFileIfExists(stateFilePath);
  }

  /**
   * The camera's watch copy (Build 42; this step made the silent "proxy" before):
   * 1080p H.264 ~4 Mbps, a keyframe every 2 s, faststart, with the take's mic mix
   * delayed by the camera's offset_s (watch-rendition.js). Uploaded as
   * stream/<building>/<camN>/<base>.mp4 WITH the upload_confirmed webhook
   * (rendition "watch"), and, unless PROXY_COPY=0, again as the old proxies/ key
   * without one. The 4K original is only read.
   * Resolves true when the job is finished (made, failed or skipped), false if a take stopped it.
   */
  async function makeProxy(job) {
    const base = path.basename(job.filePath, path.extname(job.filePath));
    const streamKey = 'stream/' + buildingId + '/' + job.source + '/' + base + '.mp4';
    const proxyKey = 'proxies/' + buildingId + '/' + job.source + '/' + base + '.mp4';
    const tmpPath = job.filePath + '.watch.mp4';
    const watch = job.watch || {};
    let preempted = false;

    try {
      let st;
      try {
        st = await fsp.stat(job.filePath);
      } catch (e) {
        console.warn('[upload-queue] watch copy skipped, original file gone key=' + job.key);
        return true;
      }
      if (!st.isFile()) return true;

      const plan = await planWatch({ cameraPath: job.filePath, masterPath: watch.masterPath || null, offsetS: Number.isFinite(watch.offsetS) ? watch.offsetS : null }, { ffprobeBin: resolveFfprobeBin });
      if (plan.audio !== 'mix') console.warn('[upload-queue] WARN watch copy without audio key=' + job.key + ' reason=' + (!watch.masterPath ? 'no_master' : (plan.offsetS === null ? 'no_timing' : 'master_unreadable')));
      await runProxyFfmpeg(watchArgs({ cameraPath: job.filePath, masterPath: watch.masterPath, masterTracks: plan.masterTracks, delayS: plan.delayS, outPath: tmpPath }));

      const out = await probeMedia(tmpPath, { ffprobeBin: resolveFfprobeBin });
      const extra = Object.assign({}, job.meta || {}, {
        rendition: 'watch',
        audio: plan.audio,
        original_key: job.key,
        kind: 'video', building_id: buildingId, source: job.source, session_ref: job.sessionRef,
      });
      delete extra.duration_s;
      if (out.ok && Number.isFinite(out.durationS)) extra.duration_s = Math.round(out.durationS * 1000) / 1000;
      if (watch.recordedAt) extra.recorded_at = watch.recordedAt;
      if (plan.offsetS !== null) extra.offset_s = plan.offsetS;
      await uploadRendition(job, tmpPath, streamKey, typeof webhookUrl === 'function' ? webhookUrl() : webhookUrl, extra);
      console.log('[upload-queue] watch copy confirmed ' + streamKey + ' audio=' + plan.audio + (plan.delayS !== null ? ' delay=' + plan.delayS.toFixed(3) + 's' : ''));
      if (proxyCopy) {
        await uploadRendition(job, tmpPath, proxyKey, undefined, { kind: 'proxy', rendition: 'proxy', building_id: buildingId, source: job.source, session_ref: job.sessionRef });
        console.log('[upload-queue] proxy confirmed ' + proxyKey);
      }
    } catch (e) {
      preempted = !!(e && e.preempted);
      if (preempted) console.warn('[upload-queue] watch copy stopped for a take, will redo after it key=' + job.key);
      else console.warn('[upload-queue] watch copy failed key=' + job.key + ' error=' + truncateError(e && (e.message || e.stack || e)));
    } finally {
      await removeFileIfExists(tmpPath).catch(() => {});
      // The original is already verified in S3; a failed copy is not a reason to keep it.
      // A copy stopped for a take still needs the original (and the master).
      if (!preempted) {
        releaseWatchHold(job);
        await removeUploadedOriginal(job);
      }
    }
    return !preempted;
  }

  async function ensureWorker() {
    if (workerRunning) return;
    workerRunning = true;
    try {
      while (queue.length > 0) {
        const job = queue.shift();
        if (!job) continue;
        queuedFilePaths.delete(job.filePath);
        activeJob = job;
        try {
          await runJob(job);
        } catch (e) {
          console.warn('[upload-queue] worker job error:', e && (e.stack || e.message || e));
        } finally {
          activeJob = null;
        }
      }
    } finally {
      workerRunning = false;
    }
  }

  function enqueue(input) {
    try {
      const filePathRaw = input && input.filePath ? String(input.filePath) : '';
      const source = input && input.source ? String(input.source) : '';
      const kind = input && input.kind === AUDIO_KIND ? AUDIO_KIND : 'recording';
      const sessionRef = input && typeof input.sessionRef === 'string' ? input.sessionRef : null;
      if (!filePathRaw || !source) {
        return { queued: false, reason: 'invalid_input' };
      }
      const filePath = path.resolve(filePathRaw);
      if (completedFilePaths.has(filePath)) {
        return { queued: false, reason: 'duplicate' };
      }
      if (queuedFilePaths.has(filePath)) {
        return { queued: false, reason: 'duplicate' };
      }
      if (activeJob && activeJob.filePath === filePath) {
        return { queued: false, reason: 'duplicate' };
      }

      const keyFolder = kind === AUDIO_KIND ? 'audio' : source;
      // A caller-given key (the take's mix: audio/<building>/<base>-mix.m4a) must stay
      // under this agent's own prefixes.
      const keyOverride = input && typeof input.key === 'string' && KEY_RE.test(input.key) && !input.key.includes('..') ? input.key : null;
      const key = keyOverride || ('recordings/' + buildingId + '/' + keyFolder + '/' + path.basename(filePath));
      const stateFilePath = stateFilePathForKey(key);
      // What the camera's watch copy needs from its take (see makeProxy).
      const watchIn = input && input.watch && typeof input.watch === 'object' ? input.watch : null;
      const watch = watchIn ? {
        masterPath: typeof watchIn.masterPath === 'string' && watchIn.masterPath ? path.resolve(watchIn.masterPath) : null,
        offsetS: Number.isFinite(watchIn.offsetS) ? watchIn.offsetS : null,
        recordedAt: typeof watchIn.recordedAt === 'string' ? watchIn.recordedAt : null,
      } : null;
      const job = {
        filePath,
        source,
        kind,
        sessionRef,
        removeAfterConfirm: !!(input && input.removeAfterConfirm),
        meta: cleanMeta(input && input.meta),
        watch,
        keyOverride,
        key,
        stateFilePath,
        enqueuedAt: new Date().toISOString(),
      };
      if (watch && watch.masterPath && isCameraRecording(job)) hold(watch.masterPath, 'watch:' + filePath);

      queuedFilePaths.add(filePath);
      queue.push(job);
      writeState(stateFilePath, buildBaseState(job, 'queued'));
      ensureWorker().catch((e) => {
        console.warn('[upload-queue] worker start failed:', e && (e.stack || e.message || e));
      });
      return { queued: true, key };
    } catch (e) {
      console.warn('[upload-queue] enqueue error:', e && (e.stack || e.message || e));
      return { queued: false, reason: 'enqueue_failed' };
    }
  }

  async function sweep() {
    try {
      let files;
      try {
        files = await fsp.readdir(stateDir);
      } catch (e) {
        if (e && e.code === 'ENOENT') return;
        throw e;
      }

      for (const name of files) {
        if (!name.endsWith('.state.json')) continue;
        const stateFilePath = path.join(stateDir, name);
        let stateData;
        try {
          stateData = await readJsonFile(stateFilePath);
        } catch (e) {
          console.warn('[upload-queue] failed reading state file ' + stateFilePath + ':', e && (e.stack || e.message || e));
          continue;
        }
        if (!stateData || typeof stateData !== 'object') {
          continue;
        }

        const status = String(stateData.status || '');
        if (status === 'done') {
          try {
            await removeFileIfExists(stateFilePath);
          } catch (e) {
            console.warn('[upload-queue] failed deleting done state ' + stateFilePath + ':', e && (e.stack || e.message || e));
          }
          continue;
        }

        if (status === 'error' && /requires sizeBytes/.test(String(stateData.error || ''))) {
          // Left behind by 0-byte files before reportEmptyFile existed: nothing to upload, ever.
          console.warn('[upload-queue] dropping empty-file upload state key=' + String(stateData.key || '?'));
          await removeFileIfExists(stateFilePath);
          continue;
        }

        if (status === 'error') {
          console.warn('[upload-queue] stale error upload state key=' + String(stateData.key || '?') + ' error=' + String(stateData.error || 'unknown'));
          continue;
        }

        if (status === 'queued' || status === 'uploading') {
          const sourceFilePath = stateData.filePath ? path.resolve(String(stateData.filePath)) : '';
          let sourceExists = false;
          if (sourceFilePath) {
            try {
              const st = await fsp.stat(sourceFilePath);
              sourceExists = st.isFile();
            } catch (e) {
              sourceExists = false;
            }
          }

          if (sourceExists) {
            const source = stateData.source ? String(stateData.source) : '';
            const out = enqueue({ filePath: sourceFilePath, source, kind: stateData.kind, sessionRef: stateData.sessionRef, removeAfterConfirm: stateData.removeAfterConfirm, meta: stateData.meta, watch: stateData.watch, key: stateData.keyOverride || undefined });
            if (!out.queued) {
              console.warn('[upload-queue] sweep enqueue skipped key=' + String(stateData.key || '?') + ' reason=' + String(out.reason || 'unknown'));
            }
            continue;
          }

          if (stateData.uploadId) {
            await abortRemoteMultipartIfPresent(stateData);
          }
          try {
            await removeFileIfExists(stateFilePath);
          } catch (e) {
            console.warn('[upload-queue] failed deleting stale state ' + stateFilePath + ':', e && (e.stack || e.message || e));
          }
          console.warn('[upload-queue] removed stale state for missing source file key=' + String(stateData.key || '?'));
        }
      }

      if (pendingProxyJobs.length > 0) {
        ensureProxyWorker().catch((e) => {
          console.warn('[upload-queue] deferred proxy retry error:', e && (e.stack || e.message || e));
        });
      }
    } catch (e) {
      console.warn('[upload-queue] sweep error:', e && (e.stack || e.message || e));
    }
  }

  function status() {
    try {
      return {
        queued: queue.length,
        // Watch copies still to make (the step that made proxies; name kept for the kiosk/diag readers).
        proxies_pending: pendingProxyJobs.length,
        active: activeSnapshot ? Object.assign({}, activeSnapshot) : null,
        last_confirmed: lastConfirmed ? Object.assign({}, lastConfirmed) : null,
      };
    } catch (e) {
      console.warn('[upload-queue] status error:', e && (e.stack || e.message || e));
      return { queued: 0, active: null, last_confirmed: null };
    }
  }

  /**
   * Adds meta to a job that has not uploaded yet (the take's audio_health when the
   * file check finished after stop returned). Returns true if a job took it.
   */
  function annotate(filePath, metaPatch) {
    const target = path.resolve(String(filePath || ''));
    const job = queue.find((j) => j.filePath === target) || (activeJob && activeJob.filePath === target && !activeSnapshot ? activeJob : null);
    if (!job) return false;
    job.meta = cleanMeta(Object.assign({}, job.meta || {}, metaPatch || {}));
    updateStateFields(job.stateFilePath, { meta: job.meta }).catch(() => {});
    return true;
  }

  return { enqueue, sweep, status, reportMissingCamera, holdProxies, annotate };
}

module.exports = { createUploadQueue, resolveFfmpegBin, resolveFfprobeBin, cleanMeta };
