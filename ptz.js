'use strict';

const http = require('http');

const DEFAULT_TIMEOUT_MS = 3000;
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
  DEFAULT_TIMEOUT_MS,
  executeLook,
  normalizeCameras,
  normalizeLooks,
  recall,
};
