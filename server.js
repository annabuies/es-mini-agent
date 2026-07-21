'use strict';

// EVRYBDY Studios FLEET — Mini-side agent.
// Proves the app -> Vercel proxy -> Mini connection is real.
// Optional OBS Source Record control; in-memory demo mode remains the fallback.

const http = require('http');
const { ObsClient, callVendor, sampleFeedsWriting } = require('./obs-control');
const crypto = require('crypto');
const path = require('path');
const { runMultipartUploadTest } = require('./r2-upload');

const PORT = parseInt(process.env.PORT || '8787', 10);
const RECORD_CONTROL_KEY = process.env.RECORD_CONTROL_KEY;
const BUILDING_ID = process.env.BUILDING_ID;
// Optional: outbound poll target. Defaults to the app's stable public URL so
// Robbie's existing install command (which only sets BUILDING_ID and
// RECORD_CONTROL_KEY) keeps working unchanged after this update.
const RECORD_POLL_URL = process.env.RECORD_POLL_URL || 'https://es-os-app.vercel.app';
const POLL_INTERVAL_MS = 1000;
const OBS_WS_URL = process.env.OBS_WS_URL || 'ws://127.0.0.1:4455';
const OBS_WS_PASSWORD = process.env.OBS_WS_PASSWORD || '';
const OBS_SOURCES_RAW = process.env.OBS_SOURCES || '';
const OBS_SOURCES = OBS_SOURCES_RAW.split(',').map((v) => v.trim()).filter(Boolean);
const OBS_RECORD_DIR = process.env.OBS_RECORD_DIR || '';
const OBS_ENABLED = !!(OBS_SOURCES_RAW && OBS_SOURCES_RAW.trim());
const OBS_MODE_ACTIVE = OBS_ENABLED && OBS_SOURCES.length > 0;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || '';
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || '';
const R2_BUCKET = process.env.R2_BUCKET || '';
const R2_ENDPOINT = process.env.R2_ENDPOINT || '';
const UPLOAD_CONFIRMED_WEBHOOK_URL = process.env.UPLOAD_CONFIRMED_WEBHOOK_URL || '';
const R2_PART_SIZE_BYTES = 25 * 1024 * 1024;
const R2_DEFAULT_TEST_SIZE_BYTES = 300 * 1024 * 1024;
const R2_TEST_TMP_DIR = path.join(__dirname, '.r2-test-tmp');
// Node >=22 is required (global WebSocket client is stable as of Node 22.4.0).

if (!RECORD_CONTROL_KEY) {
  console.error('[es-mini-agent] FATAL: RECORD_CONTROL_KEY env var is required. Refusing to start.');
  process.exit(1);
}
if (!BUILDING_ID) {
  console.error('[es-mini-agent] FATAL: BUILDING_ID env var is required (e.g. "bench-1"). Refusing to start.');
  process.exit(1);
}

const START_TIME = Date.now();
const state = { recording: false, paused: false };
const r2Tests = new Map();
let obsClient = null;
let feedsPrevSamples = new Map();

function log(method, path, status, note) {
  const ts = new Date().toISOString();
  const tag = status < 400 ? 'ok' : 'fail';
  const suffix = note ? ' ' + note : '';
  console.log(`${ts} ${method} ${path} -> ${status} ${tag}${suffix}`);
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    const MAX = 64 * 1024; // hard cap; this endpoint takes tiny JSON only
    let aborted = false;
    req.on('data', (c) => {
      if (aborted) return;
      total += c.length;
      if (total > MAX) {
        aborted = true;
        resolve('');
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) return;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', () => resolve(''));
  });
}

function parseJsonSafe(raw) {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : {};
  } catch (_) {
    return {};
  }
}

function authOk(req) {
  const h = req.headers['authorization'] || '';
  const expected = 'Bearer ' + RECORD_CONTROL_KEY;
  return h === expected;
}

function truncateDetail(value) {
  const s = typeof value === 'string' ? value : String(value || '');
  return s.length > 200 ? s.slice(0, 200) : s;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isR2Configured() {
  return !!(R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET && R2_ENDPOINT);
}

function parseSizeBytesOrDefault(value) {
  if (value == null || value === '') return R2_DEFAULT_TEST_SIZE_BYTES;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

function sanitizeForFileName(value) {
  return String(value || '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+/, '')
    .slice(0, 180) || 'r2_test_upload';
}

function stateFilePathForKey(key) {
  return path.join(R2_TEST_TMP_DIR, sanitizeForFileName(key) + '.state.json');
}

function publicR2TestState(entry) {
  if (!entry) return null;
  return {
    status: entry.status,
    partsCompleted: entry.partsCompleted,
    totalParts: entry.totalParts,
    bytesUploaded: entry.bytesUploaded,
    sizeBytes: entry.sizeBytes,
    startedAt: entry.startedAt,
    finishedAt: entry.finishedAt,
    error: entry.error,
    key: entry.key,
    pausedForRecordingMs: entry.pausedForRecordingMs,
    elapsedMs: entry.elapsedMs,
  };
}

async function getObsClient() {
  if (!obsClient) {
    obsClient = new ObsClient({
      url: OBS_WS_URL,
      password: OBS_WS_PASSWORD,
    });
  }
  await obsClient.ensureConnected();
  return obsClient;
}

function didSourceFileStabilize(beforeSamples, afterSamples, source) {
  const before = beforeSamples.get(source);
  const after = afterSamples.get(source);
  if (!before && !after) return true;
  if (!before || !after) return false;
  return before.size === after.size;
}

async function handleOp(op, body) {
  if (!OBS_MODE_ACTIVE) {
    if (op === 'start') {
      state.recording = true;
      state.paused = false;
      return { ok: true, recording: true, feeds_writing: null };
    }
    if (op === 'stop') {
      state.recording = false;
      state.paused = false;
      return { ok: true, saved: true };
    }
    if (op === 'status') {
      return { ok: true, recording: state.recording, feeds_writing: null };
    }
    if (op === 'pause') {
      if (!state.recording) {
        console.warn(`[es-mini-agent] WARN: pause called while not recording (demo-safe: returning ok).`);
      }
      state.paused = true;
      return { ok: true, paused: true };
    }
    if (op === 'resume') {
      state.paused = false;
      state.recording = true;
      return { ok: true, recording: true, feeds_writing: null };
    }
    return null;
  }

  if (op === 'start') {
    if (!OBS_RECORD_DIR) {
      return { ok: false, reason: 'obs_misconfigured' };
    }

    let client;
    try {
      client = await getObsClient();
    } catch (e) {
      return { ok: false, reason: 'obs_start_failed', detail: truncateDetail(e && (e.message || e)) };
    }

    const startResults = await Promise.all(OBS_SOURCES.map(async (source) => {
      const vendor = await callVendor(client, 'record_start', source);
      return { source, vendor };
    }));
    const failed = startResults.find((entry) => !entry.vendor.success);
    if (failed) {
      const detail = failed.source + ': ' + (failed.vendor.error || 'unknown_error');
      return { ok: false, reason: 'obs_start_failed', detail: truncateDetail(detail) };
    }

    feedsPrevSamples = new Map();
    state.recording = true;
    state.paused = false;
    return { ok: true, recording: true, feeds_writing: null };
  }
  if (op === 'stop') {
    let stopResults;
    try {
      const client = await getObsClient();
      stopResults = await Promise.all(OBS_SOURCES.map(async (source) => {
        const vendor = await callVendor(client, 'record_stop', source);
        return { source, vendor };
      }));
    } catch (e) {
      stopResults = OBS_SOURCES.map((source) => ({
        source,
        vendor: { success: false, error: e && (e.message || String(e)) || 'obs_stop_error' },
      }));
    }

    let filesStable = false;
    if (OBS_RECORD_DIR) {
      let prevSample = sampleFeedsWriting(OBS_SOURCES, OBS_RECORD_DIR, new Map()).samples;
      for (let i = 0; i < 4; i += 1) {
        await sleep(900);
        const newSample = sampleFeedsWriting(OBS_SOURCES, OBS_RECORD_DIR, prevSample).samples;
        if (OBS_SOURCES.every((source) => didSourceFileStabilize(prevSample, newSample, source))) {
          filesStable = true;
          prevSample = newSample;
          break;
        }
        prevSample = newSample;
      }
      feedsPrevSamples = prevSample;
    } else {
      await sleep(1200);
    }

    const allStopsSucceeded = stopResults.every((entry) => entry.vendor.success);
    const saved = allStopsSucceeded && filesStable;

    state.recording = false;
    state.paused = false;
    return { ok: true, saved };
  }
  if (op === 'status') {
    if (!state.recording) {
      return { ok: true, recording: false, feeds_writing: 0 };
    }
    const sampled = sampleFeedsWriting(OBS_SOURCES, OBS_RECORD_DIR, feedsPrevSamples);
    feedsPrevSamples = sampled.samples;
    return { ok: true, recording: true, feeds_writing: sampled.count };
  }
  if (op === 'pause') {
    if (!state.recording) {
      console.warn(`[es-mini-agent] WARN: pause called while not recording (demo-safe: returning ok).`);
    }

    try {
      const client = await getObsClient();
      const pauseResults = await Promise.all(OBS_SOURCES.map((source) => callVendor(client, 'record_pause', source)));
      const failed = pauseResults.find((result) => !result.success);
      if (failed) {
        console.warn('[es-mini-agent] WARN: OBS pause vendor call failed:', failed.error || 'vendor_error');
      }
    } catch (e) {
      console.warn('[es-mini-agent] WARN: OBS pause connect/request failed:', e && (e.message || e));
    }

    state.paused = true;
    return { ok: true, paused: true };
  }
  if (op === 'resume') {
    try {
      const client = await getObsClient();
      const resumeResults = await Promise.all(OBS_SOURCES.map((source) => callVendor(client, 'record_unpause', source)));
      const failed = resumeResults.find((result) => !result.success);
      if (failed) {
        console.warn('[es-mini-agent] WARN: OBS resume vendor call failed:', failed.error || 'vendor_error');
      }
    } catch (e) {
      console.warn('[es-mini-agent] WARN: OBS resume connect/request failed:', e && (e.message || e));
    }

    state.paused = false;
    state.recording = true;
    return { ok: true, recording: true, feeds_writing: null };
  }
  return null;
}

const VALID_OPS = new Set(['start', 'stop', 'status', 'pause', 'resume']);

const server = http.createServer(async (req, res) => {
  try {
    const url = req.url || '/';
    const method = req.method || 'GET';

    if (method === 'GET' && url === '/health') {
      const payload = {
        ok: true,
        building_id: BUILDING_ID,
        uptime_s: Math.round((Date.now() - START_TIME) / 1000),
        state: { recording: state.recording, paused: state.paused },
      };
      sendJson(res, 200, payload);
      log(method, url, 200);
      return;
    }

    if (method === 'POST' && url === '/r2test/start') {
      if (!authOk(req)) {
        sendJson(res, 401, { ok: false, reason: 'unauthorized' });
        log(method, url, 401, 'unauthorized');
        return;
      }

      if (!isR2Configured()) {
        sendJson(res, 200, { ok: false, reason: 'r2_unconfigured' });
        log(method, url, 200, 'r2_unconfigured');
        return;
      }

      const raw = await readBody(req);
      const body = parseJsonSafe(raw);
      const sizeBytes = parseSizeBytesOrDefault(body.sizeBytes);
      if (!sizeBytes) {
        sendJson(res, 200, { ok: false, reason: 'bad_size_bytes' });
        log(method, url, 200, 'bad_size_bytes');
        return;
      }

      const resume = !!body.resume;
      const explicitKey = typeof body.key === 'string' ? body.key.trim() : '';
      if (resume && !explicitKey) {
        sendJson(res, 200, { ok: false, reason: 'resume_requires_key' });
        log(method, url, 200, 'resume_requires_key');
        return;
      }

      // To prove real resume-after-restart behavior, call start with resume:true and
      // the same explicit key used by the original run.
      const key = resume
        ? explicitKey
        : `bench-r2-test/${BUILDING_ID}_${Date.now()}.bin`;
      const testId = crypto.randomUUID();
      const totalParts = Math.ceil(sizeBytes / R2_PART_SIZE_BYTES);
      const startedAt = new Date().toISOString();
      r2Tests.set(testId, {
        status: 'running',
        partsCompleted: 0,
        totalParts,
        bytesUploaded: 0,
        sizeBytes,
        startedAt,
        finishedAt: null,
        error: null,
        key,
        pausedForRecordingMs: 0,
        elapsedMs: null,
        shouldAbort: false,
      });

      runMultipartUploadTest({
        r2Config: {
          accessKeyId: R2_ACCESS_KEY_ID,
          secretAccessKey: R2_SECRET_ACCESS_KEY,
          bucket: R2_BUCKET,
          endpoint: R2_ENDPOINT,
        },
        testId,
        sizeBytes,
        key,
        isRecording: () => state.recording,
        shouldAbort: () => {
          const current = r2Tests.get(testId);
          return !!(current && current.shouldAbort);
        },
        stateFilePath: stateFilePathForKey(key),
        webhookUrl: UPLOAD_CONFIRMED_WEBHOOK_URL,
        onProgress: (partial) => {
          const current = r2Tests.get(testId);
          if (!current) return;
          const next = Object.assign({}, current, {
            partsCompleted: Number(partial && partial.partsCompleted) || current.partsCompleted,
            totalParts: Number(partial && partial.totalParts) || current.totalParts,
            bytesUploaded: Number(partial && partial.bytesUploaded) || current.bytesUploaded,
          });
          r2Tests.set(testId, next);
        },
      }).then((summary) => {
        const current = r2Tests.get(testId);
        if (!current) return;
        const finishedAt = new Date().toISOString();
        const wasAborted = current.status === 'aborted';
        const next = Object.assign({}, current, {
          status: wasAborted ? 'aborted' : 'done',
          partsCompleted: summary && Number(summary.partsUploaded) || current.partsCompleted,
          totalParts: summary && Number(summary.partsUploaded) || current.totalParts,
          bytesUploaded: summary && Number(summary.sizeBytes) || current.bytesUploaded,
          sizeBytes: summary && Number(summary.sizeBytes) || current.sizeBytes,
          key: summary && summary.key || current.key,
          pausedForRecordingMs: summary && Number(summary.pausedForRecordingMs) || current.pausedForRecordingMs,
          elapsedMs: summary && Number(summary.elapsedMs) || current.elapsedMs,
          finishedAt,
          error: wasAborted ? (current.error || 'aborted_by_request') : null,
        });
        r2Tests.set(testId, next);
      }).catch((err) => {
        const current = r2Tests.get(testId);
        if (!current) return;
        const detail = truncateDetail(err && (err.message || err.stack || err));
        const aborted = current.status === 'aborted' || (err && err.code === 'aborted');
        const next = Object.assign({}, current, {
          status: aborted ? 'aborted' : 'error',
          finishedAt: new Date().toISOString(),
          error: detail || (aborted ? 'aborted_by_request' : 'upload_failed'),
        });
        r2Tests.set(testId, next);
      });

      sendJson(res, 200, { ok: true, testId, key });
      log(method, url, 200, 'r2test_start');
      return;
    }

    const r2StatusMatch = url.match(/^\/r2test\/status(?:\?(.*))?$/);
    if (method === 'GET' && r2StatusMatch) {
      if (!authOk(req)) {
        sendJson(res, 401, { ok: false, reason: 'unauthorized' });
        log(method, url, 401, 'unauthorized');
        return;
      }
      const qs = new URLSearchParams(r2StatusMatch[1] || '');
      const testId = (qs.get('testId') || '').trim();
      if (!testId) {
        sendJson(res, 200, { ok: false, reason: 'bad_test_id' });
        log(method, url, 200, 'bad_test_id');
        return;
      }
      const entry = r2Tests.get(testId);
      if (!entry) {
        sendJson(res, 200, { ok: false, reason: 'not_found' });
        log(method, url, 200, 'r2test_not_found');
        return;
      }
      sendJson(res, 200, Object.assign({ ok: true, testId }, publicR2TestState(entry)));
      log(method, url, 200, 'r2test_status');
      return;
    }

    if (method === 'POST' && url === '/r2test/abort') {
      if (!authOk(req)) {
        sendJson(res, 401, { ok: false, reason: 'unauthorized' });
        log(method, url, 401, 'unauthorized');
        return;
      }
      const raw = await readBody(req);
      const body = parseJsonSafe(raw);
      const testId = typeof body.testId === 'string' ? body.testId.trim() : '';
      if (!testId) {
        sendJson(res, 200, { ok: false, reason: 'bad_test_id' });
        log(method, url, 200, 'bad_test_id');
        return;
      }
      const entry = r2Tests.get(testId);
      if (!entry) {
        sendJson(res, 200, { ok: false, reason: 'not_found' });
        log(method, url, 200, 'r2test_not_found');
        return;
      }
      const next = Object.assign({}, entry, {
        status: 'aborted',
        shouldAbort: true,
        finishedAt: entry.finishedAt || new Date().toISOString(),
        error: entry.error || 'aborted_by_request',
      });
      r2Tests.set(testId, next);
      sendJson(res, 200, { ok: true, testId });
      log(method, url, 200, 'r2test_abort');
      return;
    }

    const m = url.match(/^\/record\/([a-z]+)\/?$/);
    if (m && method === 'POST') {
      const op = m[1];

      if (!VALID_OPS.has(op)) {
        sendJson(res, 404, { ok: false, reason: 'not_found' });
        log(method, url, 404, 'bad_op');
        return;
      }

      if (!authOk(req)) {
        sendJson(res, 401, { ok: false, reason: 'unauthorized' });
        log(method, url, 401, 'unauthorized');
        return;
      }

      const raw = await readBody(req);
      const body = parseJsonSafe(raw);

      if (body.building_id && body.building_id !== BUILDING_ID) {
        sendJson(res, 200, { ok: false, reason: 'building_mismatch' });
        log(method, url, 200, `building_mismatch got=${body.building_id} want=${BUILDING_ID}`);
        return;
      }

      const out = await handleOp(op, body);
      if (out == null) {
        sendJson(res, 404, { ok: false, reason: 'not_found' });
        log(method, url, 404, 'bad_op');
        return;
      }
      sendJson(res, 200, out);
      log(method, url, 200, op);
      return;
    }

    sendJson(res, 404, { ok: false, reason: 'not_found' });
    log(method, url, 404);
  } catch (e) {
    // Absolute belt-and-suspenders: no request may ever crash the process.
    try {
      sendJson(res, 500, { ok: false, reason: 'internal_error' });
    } catch (_) { /* response may already be sent */ }
    console.error('[es-mini-agent] request handler error:', e && e.stack || e);
  }
});

server.on('clientError', (err, socket) => {
  try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch (_) {}
});

// ---------- outbound poll loop ----------
// Reach OUT to the Vercel app every POLL_INTERVAL_MS to claim any pending
// command, run it locally via handleOp(), and POST the result back. This
// replaces the old inbound cloudflared quick-tunnel path — no inbound port
// exposure needed from this Mac. The inbound handler above is left intact
// (harmless without a tunnel) so nothing that used to work is broken.
let polling = false;
let pollTimer = null;

async function pollOnce() {
  if (polling) return; // network calls are async — belt-and-suspenders reentry guard
  polling = true;
  try {
    const url = `${RECORD_POLL_URL}/api/record?building_id=${encodeURIComponent(BUILDING_ID)}`;
    const getRes = await fetch(url, {
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + RECORD_CONTROL_KEY },
    });
    if (!getRes.ok) {
      // 401/5xx from Vercel — log once per tick and move on. Do not crash.
      console.warn(`[es-mini-agent] relay: poll GET ${getRes.status} from ${RECORD_POLL_URL}`);
      return;
    }
    const data = await getRes.json().catch(() => ({}));
    const cmd = data && data.command;
    if (!cmd || !cmd.id || !cmd.op) return; // nothing to do — stay quiet to keep agent.log readable

    const result = await handleOp(cmd.op, {});
    if (result == null) {
      console.warn(`[es-mini-agent] relay: unknown op '${cmd.op}' (id=${cmd.id}) — skipping result post`);
      return;
    }

    const postRes = await fetch(`${RECORD_POLL_URL}/api/record`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + RECORD_CONTROL_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ mini_result: true, id: cmd.id, ok: !!result.ok, result }),
    });
    if (!postRes.ok) {
      console.warn(`[es-mini-agent] relay: result POST ${postRes.status} for ${cmd.op} (${cmd.id})`);
      return;
    }
    console.log(`[es-mini-agent] relay: claimed ${cmd.op} (${cmd.id}) -> posted result`);
  } catch (e) {
    // Network hiccup, DNS blip, JSON parse — never crash the process.
    console.error('[es-mini-agent] relay: poll error:', e && (e.stack || e.message || e));
  } finally {
    polling = false;
  }
}

server.listen(PORT, () => {
  console.log(`[es-mini-agent] listening on :${PORT} building_id=${BUILDING_ID}`);
  console.log(`[es-mini-agent] relay: polling ${RECORD_POLL_URL}/api/record every ${POLL_INTERVAL_MS}ms`);
  pollTimer = setInterval(pollOnce, POLL_INTERVAL_MS);
});

function shutdown(signal) {
  console.log(`[es-mini-agent] ${signal} received, closing server...`);
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  server.close(() => {
    console.log('[es-mini-agent] server closed. bye.');
    process.exit(0);
  });
  // Failsafe: if close hangs, exit after 5s.
  setTimeout(() => {
    console.warn('[es-mini-agent] force-exit after shutdown timeout.');
    process.exit(0);
  }, 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', (e) => {
  console.error('[es-mini-agent] uncaughtException:', e && e.stack || e);
});
process.on('unhandledRejection', (e) => {
  console.error('[es-mini-agent] unhandledRejection:', e && (e.stack || e));
});
