'use strict';

// Durable retry of upload_confirmed (Build 45 A8). On Sunday 10-25 the webhook
// was POSTed once per file and a failure only logged: the cloud never ledgered
// 12 uploaded files. Now a POST that fails (non-2xx or network error) goes into
// an outbox file in the upload state dir and is retried 1, 5, 15, 60 min after,
// then hourly, until 48 h after the first failure. Then it is given up: ONE WARN,
// and it stays counted (gave_up) in the heartbeat's webhook_pending so the cloud
// can alert. It survives restarts (next_attempt_at is on disk).
//
// - The body is stored as the exact string first sent and re-sent byte for byte:
//   the cloud's shim derives its idempotency key from key + sizeBytes, so a retry
//   of a POST that did land is harmless.
// - The webhook URL is NOT stored: it carries ?key=. A retry uses the agent's
//   current webhook URL (it can change remotely). It never appears in a log line.
// - Dedupe: one entry per event + key + sizeBytes; a duplicate of a pending entry
//   is not posted again (the entry will be).
// - Retries are plain HTTP POSTs and run any time (recording or not), like the
//   first post always has.

const fs = require('fs');
const path = require('path');

const OUTBOX_FILE = 'webhook-outbox.json';
const BACKOFF_MS = [60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000, 60 * 60 * 1000];
const HOURLY_MS = 60 * 60 * 1000;
const GIVE_UP_MS = 48 * 60 * 60 * 1000;
// A given-up entry is counted for a week (the cloud alerts on it), then dropped.
const GAVE_UP_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const POST_TIMEOUT_MS = 15000;
const MAX_ENTRIES = 1000;
const LOG_PREFIX = '[webhook-outbox] ';

/** Delay before the next try after `failures` failed tries (1 -> 1 min, 2 -> 5, 3 -> 15, 4+ -> 60). */
function backoffMs(failures) {
  const n = Math.max(1, Math.floor(Number(failures) || 1));
  return n <= BACKOFF_MS.length ? BACKOFF_MS[n - 1] : HOURLY_MS;
}

/** Text safe to log: no URL (scheme://host...), no query string, no key=. */
function redact(text) {
  return String(text == null ? '' : text)
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]*/gi, '[url]')
    .replace(/\?[^\s"'<>]*/g, '?[redacted]')
    .replace(/key=[^\s&"'<>]*/gi, '[redacted]')
    .slice(0, 160);
}

function dedupeKey(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  return String(p.event || '') + '|' + String(p.key || '') + '|' + String(p.sizeBytes);
}

function describeFailure(result) {
  if (result.status) return 'status=' + result.status;
  return 'error=' + redact(result.error || 'unknown');
}

/** The network error's code (ECONNREFUSED, ...) or its name, never its message (it can carry the URL). */
function errorCode(e) {
  const cause = e && e.cause;
  if (cause && typeof cause.code === 'string') return cause.code;
  if (e && typeof e.code === 'string') return e.code;
  if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) return 'timeout';
  return (e && e.name) || 'network_error';
}

function createWebhookOutbox(opts) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const stateDir = path.resolve(String(options.stateDir || path.join(process.cwd(), '.r2-uploads')));
  const filePath = path.join(stateDir, OUTBOX_FILE);
  const getUrl = typeof options.webhookUrl === 'function' ? options.webhookUrl : () => options.webhookUrl;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const setTimer = typeof options.setTimer === 'function' ? options.setTimer : (fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t; };
  const clearTimer = typeof options.clearTimer === 'function' ? options.clearTimer : (t) => clearTimeout(t);
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : (...args) => fetch(...args);
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : POST_TIMEOUT_MS;
  const log = options.log || ((m) => console.log(LOG_PREFIX + m));
  const warn = options.warn || ((m) => console.warn(LOG_PREFIX + 'WARN ' + m));

  let entries = [];
  let timer = null;
  let flushing = null;
  let stopped = false;

  function load() {
    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
      if (!e || e.code !== 'ENOENT') warn('could not read the outbox: ' + redact(e && e.code));
      return;
    }
    try {
      const data = JSON.parse(raw);
      const list = data && Array.isArray(data.entries) ? data.entries : [];
      entries = list.filter((e) => e && typeof e.body === 'string' && typeof e.dedupe === 'string'
        && Number.isFinite(e.first_failed_at) && Number.isFinite(e.next_attempt_at));
      if (entries.length) log('loaded ' + entries.length + ' undelivered upload webhook(s)');
    } catch (e) {
      warn('outbox file unreadable, starting empty');
      entries = [];
    }
  }

  /** Atomic (tmp + rename), like the upload state files; removed when empty. */
  function persist() {
    try {
      if (!entries.length) {
        try { fs.unlinkSync(filePath); } catch (e) { if (!e || e.code !== 'ENOENT') throw e; }
        return;
      }
      fs.mkdirSync(stateDir, { recursive: true });
      const tmpPath = filePath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify({ version: 1, entries }, null, 2), 'utf8');
      fs.renameSync(tmpPath, filePath);
    } catch (e) {
      warn('could not save the outbox: ' + redact(e && (e.code || e.name)));
    }
  }

  function schedule() {
    if (timer) { clearTimer(timer); timer = null; }
    if (stopped) return;
    const due = entries.filter((e) => !e.gave_up).map((e) => e.next_attempt_at);
    // Given-up notices remain visible to the cloud for a week, then expire even
    // when no new upload arrives. Without a timer, only a restart or new post
    // would ever run flush(), leaving webhook_pending stuck forever.
    const prune = entries.filter((e) => e.gave_up && Number.isFinite(e.gave_up_at))
      .map((e) => e.gave_up_at + GAVE_UP_KEEP_MS + 1);
    due.push(...prune);
    if (!due.length) return;
    const delay = Math.max(0, Math.min(Math.min(...due) - now(), HOURLY_MS));
    timer = setTimer(() => { timer = null; return flush(); }, delay);
  }

  async function send(url, body) {
    if (!url) return { ok: false, error: 'no_webhook_url' };
    try {
      const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body };
      if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') init.signal = AbortSignal.timeout(timeoutMs);
      const res = await fetchImpl(String(url), init);
      if (res && res.ok) return { ok: true, status: res.status };
      // Drain without logging: an error body can echo the request URL (and its key).
      try { if (res && typeof res.text === 'function') await res.text(); } catch (_) {}
      return { ok: false, status: (res && res.status) || 0 };
    } catch (e) {
      return { ok: false, error: errorCode(e) };
    }
  }

  function label(entry) {
    return entry.event + ' for ' + entry.key + ' (' + entry.size_bytes + ' bytes)';
  }

  function trim() {
    if (entries.length <= MAX_ENTRIES) return;
    // Over the cap: drop given-up entries first, then the oldest.
    entries.sort((a, b) => (Number(!!b.gave_up) - Number(!!a.gave_up)) || (a.first_failed_at - b.first_failed_at));
    const dropped = entries.splice(0, entries.length - MAX_ENTRIES);
    warn('outbox full, dropped ' + dropped.length + ' oldest undelivered upload webhook(s)');
  }

  function enqueue(payload, body, failure) {
    const t = now();
    const entry = {
      dedupe: dedupeKey(payload),
      event: String(payload.event || ''),
      key: String(payload.key || ''),
      size_bytes: payload.sizeBytes,
      body,
      first_failed_at: t,
      attempts: 1,
      next_attempt_at: t + backoffMs(1),
      last_error: describeFailure(failure),
      gave_up: false,
    };
    entries.push(entry);
    trim();
    persist();
    warn(label(entry) + ' not delivered (' + entry.last_error + '), will retry in ' + Math.round(backoffMs(1) / 1000) + ' s; ' + pendingCount() + ' undelivered');
    schedule();
  }

  function pendingCount() {
    return entries.length;
  }

  /**
   * POST now; on failure keep it for retry. Resolves { delivered, queued }.
   * opts.url: the URL to use for this first try (else the current webhook URL).
   */
  async function post(payload, postOptions) {
    const p = payload && typeof payload === 'object' ? payload : {};
    const dedupe = dedupeKey(p);
    if (entries.some((e) => e.dedupe === dedupe)) {
      log(p.event + ' for ' + p.key + ' already waiting in the outbox, not posted twice');
      return { delivered: false, queued: true };
    }
    const body = JSON.stringify(p);
    const url = (postOptions && postOptions.url) || getUrl();
    const result = await send(url, body);
    if (result.ok) return { delivered: true, queued: false };
    // Another post of the same upload may have been queued while this one was in flight.
    if (!entries.some((e) => e.dedupe === dedupe)) enqueue(p, body, result);
    return { delivered: false, queued: true };
  }

  async function attempt(entry) {
    const result = await send(getUrl(), entry.body);
    const t = now();
    if (result.ok) {
      entries = entries.filter((e) => e !== entry);
      log(label(entry) + ' delivered on try ' + (entry.attempts + 1) + '; ' + pendingCount() + ' undelivered');
      return;
    }
    entry.attempts += 1;
    entry.last_error = describeFailure(result);
    const deadline = entry.first_failed_at + GIVE_UP_MS;
    if (t >= deadline) {
      entry.gave_up = true;
      entry.gave_up_at = t;
      warn(label(entry) + ' gave up after ' + entry.attempts + ' tries over 48 h (' + entry.last_error + '); counted in webhook_pending');
      return;
    }
    entry.next_attempt_at = Math.min(t + backoffMs(entry.attempts), deadline);
    log(label(entry) + ' try ' + entry.attempts + ' failed (' + entry.last_error + '), next in ' + Math.round((entry.next_attempt_at - t) / 1000) + ' s');
  }

  /** Tries every due entry once, in order. Resolves when done. */
  function flush() {
    if (flushing) return flushing;
    const task = (async () => {
      const t = now();
      const before = entries.length;
      entries = entries.filter((e) => !(e.gave_up && Number.isFinite(e.gave_up_at) && t - e.gave_up_at > GAVE_UP_KEEP_MS));
      let changed = entries.length !== before;
      for (const entry of entries.slice()) {
        if (stopped) break;
        if (entry.gave_up || entry.next_attempt_at > now()) continue;
        await attempt(entry);
        changed = true;
        persist();
      }
      if (changed) persist();
    })();
    // A flush with no due entries can finish synchronously. Attach cleanup to
    // its promise after assigning `flushing`, or it stays set to a resolved
    // promise and no later retry/prune runs in this process.
    flushing = task.finally(() => { flushing = null; schedule(); });
    return flushing;
  }

  /** Heartbeat webhook_pending: null when nothing is pending, else { count, oldest_age_s[, gave_up] }. */
  function pending() {
    if (!entries.length) return null;
    const oldest = Math.min(...entries.map((e) => e.first_failed_at));
    const out = { count: entries.length, oldest_age_s: Math.max(0, Math.floor((now() - oldest) / 1000)) };
    const gaveUp = entries.filter((e) => e.gave_up).length;
    if (gaveUp) out.gave_up = gaveUp;
    return out;
  }

  function stop() {
    stopped = true;
    if (timer) { clearTimer(timer); timer = null; }
  }

  load();
  schedule();

  return {
    post,
    flush,
    pending,
    stop,
    entries: () => entries.map((e) => ({ ...e })),
  };
}

module.exports = {
  BACKOFF_MS,
  GIVE_UP_MS,
  OUTBOX_FILE,
  backoffMs,
  createWebhookOutbox,
  redact,
};
