'use strict';

const { requestWithDigest } = require('./digest-auth');

const DEFAULT_TIMEOUT_MS = 3000;
// A look's settle time (Build 45 A5): the recall answers before the camera stops
// moving. The agent never waits for it (one command at a time; the Worker skips a
// look after 6.5 s); it reports settled_at so the app knows when the shot is set.
const DEFAULT_LOOK_SETTLE_MS = 4000;
const MAX_LOOK_SETTLE_MS = 15000;
const SAFE_HOST_RE = /^[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/;

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeCameras(value) {
  if (!Array.isArray(value)) return null;
  const names = new Set();
  const cameras = [];
  for (const item of value) {
    if (!isPlainObject(item)) return null;
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    const host = typeof item.host === 'string' ? item.host.trim() : '';
    if (!name || !host || names.has(name)) return null;
    names.add(name);
    const camera = { name, host };
    // Optional capture fields (rtsp-capture.js). Absent => Source Record, as before.
    if (typeof item.capture === 'string' && item.capture.trim()) camera.capture = item.capture.trim().toLowerCase();
    if (typeof item.rtsp_url === 'string' && item.rtsp_url.trim()) camera.rtsp_url = item.rtsp_url.trim();
    if (typeof item.rtsp_path === 'string' && item.rtsp_path.trim()) camera.rtsp_path = item.rtsp_path.trim();
    if (Number.isInteger(item.rtsp_port)) camera.rtsp_port = item.rtsp_port;
    if (item.rtsp_audio === true) camera.rtsp_audio = true;
    cameras.push(camera);
  }
  return cameras;
}

function normalizeLooks(value) {
  if (!isPlainObject(value)) return null;
  const looks = {};
  for (const [lookKey, map] of Object.entries(value)) {
    if (!lookKey.trim() || !isPlainObject(map)) return null;
    const normalizedMap = {};
    for (const [cameraName, preset] of Object.entries(map)) {
      if (!cameraName.trim() || !Number.isInteger(preset) || preset < 0) return null;
      normalizedMap[cameraName] = preset;
    }
    looks[lookKey] = normalizedMap;
  }
  return looks;
}

function recall(host, preset, options) {
  const rawHost = typeof host === 'string' ? host.trim() : '';
  if (!rawHost || !SAFE_HOST_RE.test(rawHost) || !Number.isInteger(preset) || preset < 0) {
    return Promise.resolve('error');
  }

  const timeoutValue = options && Number(options.timeoutMs);
  const timeoutMs = Number.isFinite(timeoutValue) && timeoutValue > 0
    ? Math.floor(timeoutValue)
    : DEFAULT_TIMEOUT_MS;
  const url = `http://${rawHost}/cgi-bin/ptzctrl.cgi?ptzcmd&poscall&${preset}`;
  console.log(`[es-mini-agent] ptz: GET ${url}`);

  const credentials = options && options.credentials;
  return requestWithDigest({
    url,
    username: credentials && credentials.username,
    password: credentials && credentials.password,
    timeoutMs,
  }).then((result) => {
    if (result.timedOut) return 'timeout';
    if (result.statusCode >= 200 && result.statusCode < 300) return 'ok';
    if (result.statusCode === 401) return result.attempted ? 'auth_failed' : 'auth_required';
    return Number.isInteger(result.statusCode) ? `http_${result.statusCode}` : 'error';
  }).catch(() => 'error');
}

/** LOOK_SETTLE_MS -> ms: default 4000, clamped to 0..15000, non-numeric -> default. */
function lookSettleMs(value) {
  if (value === undefined || value === null || String(value).trim() === '') return DEFAULT_LOOK_SETTLE_MS;
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_LOOK_SETTLE_MS;
  return Math.min(MAX_LOOK_SETTLE_MS, Math.max(0, Math.floor(n)));
}

async function executeLook(config, look, options) {
  const lookKey = (typeof look === 'string' || typeof look === 'number')
    ? String(look).trim()
    : '';
  const current = config && typeof config === 'object' ? config : {};
  if (current.recording || current.paused) {
    return { ok: false, look: lookKey, reason: 'busy_recording' };
  }
  if (current.uploading) {
    return { ok: false, look: lookKey, reason: 'busy_uploading' };
  }

  const cameras = Array.isArray(current.cameras) ? current.cameras : [];
  if (cameras.length === 0) {
    return { ok: false, look: lookKey, reason: 'no_cameras' };
  }

  const looks = isPlainObject(current.looks) ? current.looks : {};
  if (!Object.prototype.hasOwnProperty.call(looks, lookKey) || !isPlainObject(looks[lookKey])) {
    return { ok: false, look: lookKey, reason: 'unknown_look' };
  }

  const byName = new Map(cameras.map((camera) => [camera.name, camera]));
  const recallFn = options && typeof options.recallFn === 'function' ? options.recallFn : recall;
  const timeoutMs = options && options.timeoutMs;
  const now = options && typeof options.now === 'function' ? options.now : Date.now;
  const entries = await Promise.all(Object.entries(looks[lookKey]).map(async ([cameraName, preset]) => {
    const startedAt = now();
    const camera = byName.get(cameraName);
    if (!camera) return [cameraName, 'error', 0, startedAt];
    let outcome;
    try {
      outcome = await recallFn(camera.host, preset, {
        timeoutMs: timeoutMs || DEFAULT_TIMEOUT_MS,
        credentials: options && options.credentials,
      });
    } catch (_) {
      outcome = 'error';
    }
    const finishedAt = now();
    return [cameraName, outcome, Math.max(0, finishedAt - startedAt), finishedAt];
  }));
  const results = Object.fromEntries(entries.map(([cameraName, outcome]) => [cameraName, outcome]));

  console.log(`[es-mini-agent] ptz: look ${lookKey} -> ${entries
    .map(([cameraName, outcome, elapsedMs]) => `${cameraName} ${outcome} ${elapsedMs}ms`)
    .join(', ')}`);

  const ok = entries.every((entry) => entry[1] === 'ok');
  const result = { ok, look: lookKey, cameras: results };
  if (ok) {
    // settled_at: when every recall had returned, plus the settle time. A later
    // look simply reports its own later settled_at; nothing here waits or stacks.
    const settleMs = options && options.settleMs !== undefined ? lookSettleMs(options.settleMs) : lookSettleMs(process.env.LOOK_SETTLE_MS);
    const allBackAt = entries.length ? Math.max(...entries.map((entry) => entry[3])) : now();
    result.elapsed_ms = Object.fromEntries(entries.map(([cameraName, , elapsedMs]) => [cameraName, elapsedMs]));
    result.settle_ms = settleMs;
    result.settled_at = new Date(allBackAt + settleMs).toISOString();
  }
  return result;
}

module.exports = {
  DEFAULT_LOOK_SETTLE_MS,
  DEFAULT_TIMEOUT_MS,
  executeLook,
  lookSettleMs,
  normalizeCameras,
  normalizeLooks,
  recall,
};
