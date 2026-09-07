'use strict';

const { normalizeCameras } = require('./ptz');

const DEFAULT_TIMEOUT_MS = 2000;

function safeError(error) {
  return error && (error.message || String(error));
}

/**
 * Probe every configured camera in parallel. Any HTTP response proves that a
 * camera is reachable; connection failures and timeouts are reported as down.
 */
async function probeCameras(cameras, { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = globalThis.fetch } = {}) {
  const checkedAt = new Date().toISOString();
  const normalized = normalizeCameras(cameras) || [];
  const names = normalized.map((camera) => camera.name);
  const timeout = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? Math.floor(Number(timeoutMs))
    : DEFAULT_TIMEOUT_MS;

  if (typeof fetchImpl !== 'function') {
    return { checked_at: checkedAt, down: names, up: [], ms: {}, error: 'fetch implementation unavailable' };
  }

  try {
    const results = await Promise.all(normalized.map(async (camera) => {
      const startedAt = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        // Deliberately do not inspect status: an HTTP response, including 401,
        // proves the camera is on the local network and answering requests.
        await fetchImpl(`http://${camera.host}/`, { method: 'GET', signal: controller.signal });
        return { name: camera.name, up: true, ms: Date.now() - startedAt };
      } catch (_) {
        return { name: camera.name, up: false, ms: Date.now() - startedAt };
      } finally {
        clearTimeout(timer);
      }
    }));
    const up = results.filter((result) => result.up).map((result) => result.name);
    const down = results.filter((result) => !result.up).map((result) => result.name);
    return {
      checked_at: checkedAt,
      down,
      up,
      ms: Object.fromEntries(results.map((result) => [result.name, result.ms])),
    };
  } catch (error) {
    return { checked_at: checkedAt, down: names, up: [], ms: {}, error: safeError(error) || 'camera probe failed' };
  }
}

module.exports = { DEFAULT_TIMEOUT_MS, probeCameras };
