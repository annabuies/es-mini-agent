'use strict';

// EVRYBDY Studios FLEET — Mini-side agent.
// Proves the app -> Vercel proxy -> Mini connection is real.
// Does NOT drive cameras / audio / OBS yet. State is in-memory only.

const http = require('http');

const PORT = parseInt(process.env.PORT || '8787', 10);
const RECORD_CONTROL_KEY = process.env.RECORD_CONTROL_KEY;
const BUILDING_ID = process.env.BUILDING_ID;

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

function handleOp(op, body) {
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

      const out = handleOp(op, body);
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

server.listen(PORT, () => {
  console.log(`[es-mini-agent] listening on :${PORT} building_id=${BUILDING_ID}`);
});

function shutdown(signal) {
  console.log(`[es-mini-agent] ${signal} received, closing server...`);
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
