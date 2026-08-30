'use strict';

const http = require('http');

const DEFAULT_TIMEOUT_MS = 3000;
const SNAPSHOT_TIMEOUT_MS = 5000;
const SAFE_HOST_RE = /^[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/;
const CGI_PROFILE_ORDER = [
  'aemode',
  'wbmode',
  'flip',
  'mirror',
  'bright',
  'saturation',
  'contrast',
  'sharpness',
  'hue',
];
const AE_MODES = new Set(['auto', 'manual', 'shutter', 'iris', 'bright']);
const WB_MODES = new Set(['auto', 'indoor', 'outdoor', 'onepush', 'manual', 'var', 'trigger']);
const SLIDER_MODES = new Set(['bright', 'saturation', 'contrast', 'sharpness', 'hue']);

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
    cameras.push({ name, host });
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

function classifyStatus(statusCode) {
  if (statusCode === 401) return 'auth_required';
  if (Number.isInteger(statusCode) && statusCode >= 200 && statusCode < 300) return 'ok';
  return Number.isInteger(statusCode) ? `http_${statusCode}` : 'error';
}

function getBuffer(host, pathname, options) {
  const rawHost = typeof host === 'string' ? host.trim() : '';
  if (!rawHost || !SAFE_HOST_RE.test(rawHost) || typeof pathname !== 'string' || !pathname.startsWith('/')) {
    return Promise.resolve({ status: 'error', buffer: null });
  }

  const timeoutValue = options && Number(options.timeoutMs);
  const timeoutMs = Number.isFinite(timeoutValue) && timeoutValue > 0
    ? Math.floor(timeoutValue)
    : DEFAULT_TIMEOUT_MS;
  const url = `http://${rawHost}${pathname}`;
  console.log(`[es-mini-agent] ptz: GET ${url}`);

  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    const finish = (status, buffer) => {
      if (settled) return;
      settled = true;
      resolve({ status, buffer: Buffer.isBuffer(buffer) ? buffer : null });
    };

    let request;
    try {
      request = http.get(url, (response) => {
        const status = classifyStatus(response.statusCode);
        if (status !== 'ok') {
          response.resume();
          finish(status, null);
          return;
        }
        const chunks = [];
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.on('end', () => finish('ok', Buffer.concat(chunks)));
        response.on('error', () => finish('error', null));
      });
    } catch (_) {
      finish('error', null);
      return;
    }

    request.setTimeout(timeoutMs, () => {
      timedOut = true;
      request.destroy();
    });
    request.on('error', () => finish(timedOut ? 'timeout' : 'error', null));
  });
}

async function probe(host, options) {
  const result = await getBuffer(host, '/cgi-bin/param.cgi?get_device_conf', options);
  return result.status;
}

async function panTiltReset(host, options) {
  const result = await getBuffer(host, '/cgi-bin/param.cgi?pan_tiltdrive_reset', options);
  return result.status;
}

function validImageValue(mode, level) {
  if (mode === 'aemode') return typeof level === 'string' && AE_MODES.has(level);
  if (mode === 'wbmode') return typeof level === 'string' && WB_MODES.has(level);
  if (mode === 'flip' || mode === 'mirror') return level === 0 || level === 1;
  if (SLIDER_MODES.has(mode)) return Number.isInteger(level) && level >= 0 && level <= 14;
  return false;
}

async function setImageValue(host, mode, level, options) {
  const key = typeof mode === 'string' ? mode.trim() : '';
  if (!validImageValue(key, level)) return 'error';
  const result = await getBuffer(host, `/cgi-bin/param.cgi?post_image_value&${key}&${level}`, options);
  return result.status;
}

async function snapshot(host, options) {
  const timeoutMs = options && options.timeoutMs ? options.timeoutMs : SNAPSHOT_TIMEOUT_MS;
  const result = await getBuffer(host, '/snapshot.jpg', { timeoutMs });
  if (result.status !== 'ok' || !result.buffer || result.buffer.length === 0) return null;
  return result.buffer;
}

async function applyCgiProfile(host, profile, options) {
  if (profile == null) return { status: 'skipped', failures: [], results: {} };
  if (!isPlainObject(profile)) return { status: 'error', failures: ['profile'], results: {} };

  const keys = CGI_PROFILE_ORDER.filter((key) => Object.prototype.hasOwnProperty.call(profile, key));
  if (keys.length === 0) return { status: 'skipped', failures: [], results: {} };

  const results = {};
  const failures = [];
  for (const key of keys) {
    const status = await setImageValue(host, key, profile[key], options);
    results[key] = status;
    if (status !== 'ok') failures.push(key);
  }
  return {
    status: failures.length === 0 ? 'ok' : (failures.length === keys.length ? 'error' : 'partial'),
    failures,
    results,
  };
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

  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    const finish = (status) => {
      if (settled) return;
      settled = true;
      resolve(status);
    };

    let request;
    try {
      request = http.get(url, (response) => {
        response.resume();
        if (response.statusCode === 401) {
          finish('auth_required');
          return;
        }
        if (response.statusCode >= 200 && response.statusCode < 300) {
          finish('ok');
          return;
        }
        finish(Number.isInteger(response.statusCode) ? `http_${response.statusCode}` : 'error');
      });
    } catch (_) {
      finish('error');
      return;
    }

    request.setTimeout(timeoutMs, () => {
      timedOut = true;
      request.destroy();
    });
    request.on('error', () => finish(timedOut ? 'timeout' : 'error'));
  });
}

async function executeLook(config, look, options) {
  const lookKey = (typeof look === 'string' || typeof look === 'number')
    ? String(look).trim()
    : '';
  const current = config && typeof config === 'object' ? config : {};
  if (current.recording || current.paused) {
    return { ok: false, look: lookKey, reason: 'busy_recording' };
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
  const entries = await Promise.all(Object.entries(looks[lookKey]).map(async ([cameraName, preset]) => {
    const camera = byName.get(cameraName);
    if (!camera) return [cameraName, 'error'];
    try {
      return [cameraName, await recallFn(camera.host, preset, { timeoutMs: timeoutMs || DEFAULT_TIMEOUT_MS })];
    } catch (_) {
      return [cameraName, 'error'];
    }
  }));
  const results = Object.fromEntries(entries);

  return {
    ok: entries.every((entry) => entry[1] === 'ok'),
    look: lookKey,
    cameras: results,
  };
}

module.exports = {
  CGI_PROFILE_ORDER,
  DEFAULT_TIMEOUT_MS,
  SNAPSHOT_TIMEOUT_MS,
  applyCgiProfile,
  executeLook,
  normalizeCameras,
  normalizeLooks,
  panTiltReset,
  probe,
  recall,
  setImageValue,
  snapshot,
};
