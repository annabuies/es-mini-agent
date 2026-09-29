'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

const { runMultipartUpload, signS3Request } = require('./storage-upload');

const STABILITY_POLL_MS = 2000;
const STABILITY_WARN_MS = 60000;
const MAX_ERROR_LEN = 300;
const MASTER_SOURCE = 'master';
const AUDIO_KIND = 'audio';
// Below this a recording is only trusted if ffprobe finds a stream in it. The
// Source Record zero-stream stub is 1,737 bytes; one second of any camera is MBs.
const DEFAULT_MIN_RECORDING_BYTES = 64 * 1024;
const QUARANTINE_DIR = 'quarantine';
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
  const stabilityPollMs = Number.isFinite(options.stabilityPollMs) && options.stabilityPollMs >= 0
    ? options.stabilityPollMs
    : STABILITY_POLL_MS;
  const minRecordingBytes = Number.isFinite(options.minRecordingBytes) && options.minRecordingBytes >= 0
    ? options.minRecordingBytes
    : DEFAULT_MIN_RECORDING_BYTES;
  const probeGate = options.probeGate !== false;

  const queue = [];
  const pendingProxyJobs = [];
  const queuedFilePaths = new Set();
  const completedFilePaths = new Set();
  let activeJob = null;
  let activeSnapshot = null;
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
    return new Promise((resolve, reject) => {
      let proc;
      try {
        const ffmpegBin = resolveFfmpegBin().bin;
        proc = spawn(ffmpegBin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
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

  function runFfprobe(args) {
    return new Promise((resolve, reject) => {
      const configured = String(process.env.FFPROBE_BIN || '').trim();
      const ffprobeBin = configured || path.join(path.dirname(resolveFfmpegBin().bin), 'ffprobe');
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

  async function splitMasterAudio(job) {
    if (!audioSplit) {
      console.log('[upload-queue] audio split disabled key=' + job.key);
      return;
    }
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
        const out = enqueue({ filePath, source: mic, kind: AUDIO_KIND, sessionRef: job.sessionRef, removeAfterConfirm: true });
        if (!out.queued) {
          await removeFileIfExists(filePath);
          console.warn('[upload-queue] audio enqueue skipped source=' + mic + ' key=' + job.key + ' reason=' + out.reason);
        }
      }
    } catch (e) {
      console.warn('[upload-queue] audio split failed key=' + job.key + ' error=' + truncateError(e && (e.message || e.stack || e)));
    }
  }

  // A 0-byte file has nothing to upload (S3 multipart needs at least one byte, so
  // it used to fail forever with "runMultipartUpload requires sizeBytes"). A camera
  // file is reported through the normal upload_confirmed webhook with sizeBytes 0,
  // which the cloud posts as "Camera N recording failed" (es-honeybook #18) and
  // never links. Audio/master files are only logged. The entry is then dropped.
  // A zero-stream stub takes the same path: sizeBytes 0 is the only failure signal
  // the cloud understands today, and nothing is uploaded, so nothing gets linked.
  async function reportEmptyFile(job, invalid) {
    if (!invalid) console.warn('[upload-queue] empty file, nothing to upload key=' + job.key + ' file=' + job.filePath);
    const camera = job.source !== MASTER_SOURCE && job.kind !== AUDIO_KIND && /^cam(?:era)?[-_ ]?\d+$/i.test(String(job.source || ''));
    const url = typeof webhookUrl === 'function' ? webhookUrl() : webhookUrl;
    if (camera && url) {
      try {
        const res = await fetch(String(url), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(Object.assign({
            event: 'upload_confirmed',
            key: job.key,
            sizeBytes: 0,
            confirmedAt: new Date().toISOString(),
            kind: job.kind,
            building_id: buildingId,
            source: job.source,
            session_ref: job.sessionRef,
          }, invalid ? { invalid: invalid.reason, file_size_bytes: invalid.sizeBytes, streams: invalid.streams } : {})),
        });
        if (!res.ok) console.warn('[upload-queue] empty file webhook failed status=' + res.status + ' key=' + job.key);
      } catch (e) {
        console.warn('[upload-queue] empty file webhook error key=' + job.key + ':', e && (e.message || e));
      }
    }
    await removeFileIfExists(job.stateFilePath);
    completedFilePaths.add(job.filePath);
  }

  /**
   * null when the recording is worth uploading, else { reason, sizeBytes, streams }.
   * ffprobe is authoritative; the size floor only decides when ffprobe cannot answer.
   */
  async function checkRecordingPlayable(job, sizeBytes) {
    if (!probeGate || job.kind === AUDIO_KIND) return null;
    let streams = null;
    let probeError = null;
    try {
      const output = await runFfprobe(['-v', 'error', '-show_entries', 'stream=index,codec_type', '-of', 'json', job.filePath]);
      const parsed = JSON.parse(output || '{}');
      streams = Array.isArray(parsed.streams) ? parsed.streams.length : 0;
    } catch (e) {
      probeError = truncateError(e && (e.message || e));
    }
    if (streams === 0) return { reason: 'zero_streams', sizeBytes, streams: 0 };
    if (streams === null && sizeBytes < minRecordingBytes) {
      return { reason: 'unprobeable_below_' + minRecordingBytes + '_bytes', sizeBytes, streams: null, probeError };
    }
    if (streams === null) {
      console.warn('[upload-queue] WARN: ffprobe failed, uploading anyway (above size floor) key=' + job.key + ' error=' + probeError);
    }
    return null;
  }

  // Kept (not deleted) for forensics, in a subfolder the stop-time "newest file" scan never looks into.
  async function quarantineRecording(job) {
    const dir = path.join(path.dirname(job.filePath), QUARANTINE_DIR);
    const target = path.join(dir, path.basename(job.filePath));
    try {
      await fsp.mkdir(dir, { recursive: true });
      await fsp.rename(job.filePath, target);
      return target;
    } catch (e) {
      console.warn('[upload-queue] quarantine move failed key=' + job.key + ':', e && (e.message || e));
      return null;
    }
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
      return;
    }

    if (stable.sizeBytes === 0) {
      await reportEmptyFile(job);
      return;
    }

    const invalid = await checkRecordingPlayable(job, stable.sizeBytes);
    if (invalid) {
      const movedTo = await quarantineRecording(job);
      console.warn('[upload-queue] WARN: unplayable recording NOT uploaded key=' + job.key
        + ' reason=' + invalid.reason + ' sizeBytes=' + invalid.sizeBytes
        + (invalid.probeError ? ' probe_error=' + invalid.probeError : '')
        + ' quarantined=' + (movedTo || 'no'));
      await reportEmptyFile(job, invalid);
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
        webhookExtra: { kind: job.kind, building_id: buildingId, source: job.source, session_ref: job.sessionRef },
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
    } finally {
      activeSnapshot = null;
    }
  }

  async function maybeMakeProxy(job) {
    if (isRecording()) {
      pendingProxyJobs.push(job);
      console.warn('[upload-queue] proxy deferred (recording active) key=' + job.key);
      return;
    }

    const proxyBase = path.basename(job.filePath, path.extname(job.filePath));
    const proxyKey = 'proxies/' + buildingId + '/' + job.source + '/' + proxyBase + '.mp4';
    // Never inside the camera folder: stop picks the newest file there, and a proxy
    // still transcoding from the previous take is newer than the take just recorded.
    const tmpProxyPath = path.join(stateDir + '-proxy-tmp', toSafeFileName(job.source + '-' + proxyBase) + '.proxy.mp4');

    try {
      await fsp.mkdir(path.dirname(tmpProxyPath), { recursive: true });
      let st;
      try {
        st = await fsp.stat(job.filePath);
      } catch (e) {
        console.warn('[upload-queue] proxy skipped, master file gone key=' + job.key);
        return;
      }
      if (!st.isFile()) return;

      await runFfmpeg([
        '-y',
        '-i', job.filePath,
        '-vf', 'scale=1920:1080',
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '21',
        '-c:a', 'aac',
        '-movflags', '+faststart',
        tmpProxyPath,
      ]);

      const proxyStat = await fsp.stat(tmpProxyPath);
      const proxyStateFilePath = stateFilePathForKey(proxyKey);
      await uploader({
        r2Config,
        key: proxyKey,
        filePath: tmpProxyPath,
        sizeBytes: proxyStat.size,
        stateFilePath: proxyStateFilePath,
        isRecording,
        shouldAbort: () => false,
        webhookUrl: undefined,
        webhookExtra: { kind: 'proxy', building_id: buildingId, source: job.source, session_ref: job.sessionRef },
        abortOnFailure: false,
        deleteObjectAfterVerify: false,
      });
      await removeFileIfExists(proxyStateFilePath);
      console.log('[upload-queue] proxy confirmed ' + proxyKey);
    } catch (e) {
      console.warn('[upload-queue] proxy failed key=' + job.key + ' error=' + truncateError(e && (e.message || e.stack || e)));
    } finally {
      await removeFileIfExists(tmpProxyPath);
    }
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
      const key = 'recordings/' + buildingId + '/' + keyFolder + '/' + path.basename(filePath);
      const stateFilePath = stateFilePathForKey(key);
      const job = {
        filePath,
        source,
        kind,
        sessionRef,
        removeAfterConfirm: !!(input && input.removeAfterConfirm),
        key,
        stateFilePath,
        enqueuedAt: new Date().toISOString(),
      };

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
            const out = enqueue({ filePath: sourceFilePath, source, kind: stateData.kind, sessionRef: stateData.sessionRef, removeAfterConfirm: stateData.removeAfterConfirm });
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

      if (pendingProxyJobs.length > 0 && !isRecording()) {
        const jobsToRetry = pendingProxyJobs.splice(0, pendingProxyJobs.length);
        for (const job of jobsToRetry) {
          maybeMakeProxy(job).catch((e) => {
            console.warn('[upload-queue] deferred proxy retry error:', e && (e.stack || e.message || e));
          });
        }
      }
    } catch (e) {
      console.warn('[upload-queue] sweep error:', e && (e.stack || e.message || e));
    }
  }

  function status() {
    try {
      return {
        queued: queue.length,
        active: activeSnapshot ? Object.assign({}, activeSnapshot) : null,
        last_confirmed: lastConfirmed ? Object.assign({}, lastConfirmed) : null,
      };
    } catch (e) {
      console.warn('[upload-queue] status error:', e && (e.stack || e.message || e));
      return { queued: 0, active: null, last_confirmed: null };
    }
  }

  return { enqueue, sweep, status };
}

module.exports = { createUploadQueue, resolveFfmpegBin };
