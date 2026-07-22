'use strict';

const fsp = require('fs/promises');
const path = require('path');

const { runMultipartUpload, signR2Request } = require('./r2-upload');

const STABILITY_POLL_MS = 2000;
const STABILITY_WARN_MS = 60000;
const MAX_ERROR_LEN = 300;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toSafeFileName(value) {
  return String(value || '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+/, '')
    .slice(0, 180) || 'r2_upload';
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

function createUploadQueue(opts) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const r2Config = options.r2Config && typeof options.r2Config === 'object' ? options.r2Config : {};
  const stateDir = path.resolve(String(options.stateDir || path.join(process.cwd(), '.r2-uploads')));
  const isRecording = typeof options.isRecording === 'function' ? options.isRecording : (() => false);
  const webhookUrl = options.webhookUrl;
  const buildingId = String(options.buildingId || '').trim() || 'unknown';
  const uploader = typeof options.uploader === 'function' ? options.uploader : runMultipartUpload;

  const queue = [];
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
      kind: 'recording',
      filePath: job.filePath,
      key: job.key,
      source: job.source,
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
      const signed = signR2Request({
        method: 'DELETE',
        key: String(stateData.key),
        query: { uploadId: String(stateData.uploadId) },
        accessKeyId: r2Config.accessKeyId,
        secretAccessKey: r2Config.secretAccessKey,
        bucket: r2Config.bucket,
        endpoint: r2Config.endpoint,
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
      await sleep(STABILITY_POLL_MS);
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
        webhookUrl,
        webhookExtra: { kind: 'recording', building_id: buildingId, source: job.source },
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
      completedFilePaths.add(job.filePath);
      lastConfirmed = {
        key: summary && summary.key ? summary.key : job.key,
        sizeBytes: summary && Number(summary.sizeBytes) || stable.sizeBytes,
        finishedAt: new Date().toISOString(),
      };
      const partsUploaded = summary && Number(summary.partsUploaded) || activeSnapshot.partsCompleted || 0;
      console.log('[upload-queue] confirmed ' + job.key + ' (' + partsUploaded + ' parts)');
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

      const key = 'recordings/' + buildingId + '/' + source + '/' + path.basename(filePath);
      const stateFilePath = stateFilePathForKey(key);
      const job = {
        filePath,
        source,
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
            const out = enqueue({ filePath: sourceFilePath, source });
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

module.exports = { createUploadQueue };
