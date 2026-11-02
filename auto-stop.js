'use strict';

// auto-stop — Build 46 booked-session overrun stop (Robbie 10-31, Anna 11-02).
//
// A booked take carries `auto_stop_at` in its Start payload (the booking's effective end
// + 10 min, set by the Worker at Start and never moved afterwards). The Mini owns the
// timing: it remembers {session_ref, auto_stop_at} in a small file, so an agent restart
// keeps the deadline, and checks it every second.
//
// At the deadline, if that same take is still recording (or paused), the Mini asks the
// Worker to queue a normal Stop tagged `auto_stop_for: <session_ref>`. The Stop then
// arrives through the usual relay poll and runs the usual stop path, so the take is saved
// and listed exactly like a tapped Stop (es-take-status/1: one Stop owner, the same
// listing writers). The Worker queues at most one such Stop per take, and only while the
// take is the room's latest Start with no Stop after it; the Mini refuses any tagged Stop
// whose session_ref is not the take it is recording (server.js), so a later take is
// never stopped.
//
// If the Worker cannot be reached for LOCAL_AFTER_MS after the deadline, the Mini stops
// the take itself (same stop path) and keeps reporting the real result until the Worker
// records it, so a cloud outage cannot leave a take recording for hours.

const fs = require('node:fs');
const path = require('node:path');

const REQUEST_RETRY_MS = 5000;
const LOCAL_AFTER_MS = 60 * 1000;
const MAX_AHEAD_MS = 12 * 60 * 60 * 1000;
const REF_RE = /^[A-Za-z0-9._:-]{1,120}$/;

function parseDeadline(value, nowMs) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return null;
  // A deadline more than 12 h out is not a booking end: ignore rather than trust it.
  if (at - nowMs > MAX_AHEAD_MS) return null;
  return at;
}

function createAutoStop(options) {
  const opts = options || {};
  const file = opts.file;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const fetchImpl = opts.fetchImpl || ((url, init) => fetch(url, init));
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const isTakeLive = typeof opts.isTakeLive === 'function' ? opts.isTakeLive : () => false;
  const localStop = typeof opts.localStop === 'function' ? opts.localStop : async () => ({ ok: false, reason: 'no_local_stop' });
  const retryMs = Number.isFinite(opts.requestRetryMs) ? opts.requestRetryMs : REQUEST_RETRY_MS;
  const localAfterMs = Number.isFinite(opts.localAfterMs) ? opts.localAfterMs : LOCAL_AFTER_MS;

  let entry = load();
  let busy = false;

  function load() {
    if (!file) return null;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw && REF_RE.test(String(raw.session_ref || '')) && Number.isFinite(raw.at)) return raw;
    } catch (_) { /* no file, or unreadable: nothing armed */ }
    return null;
  }

  function save() {
    if (!file) return;
    try {
      if (!entry) { fs.rmSync(file, { force: true }); return; }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(entry));
      fs.renameSync(tmp, file);
    } catch (e) {
      log('warn', 'auto-stop: state file write failed: ' + (e && (e.message || e)));
    }
  }

  async function post(body) {
    const response = await fetchImpl(opts.relayUrl + '/api/record', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + opts.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ auto_stop: true, building_id: opts.buildingId, ...body }),
    });
    if (!response || !response.ok) throw new Error('HTTP ' + (response && response.status));
    return response.json();
  }

  /** A Start succeeded: remember its deadline (or nothing, for a take without one). */
  function arm(sessionRef, autoStopAt) {
    const ref = String(sessionRef || '');
    const at = parseDeadline(autoStopAt, now());
    if (!REF_RE.test(ref) || at === null) {
      // A new take with no deadline replaces any older entry that is not waiting to report.
      if (entry && entry.phase !== 'local_stopped') { entry = null; save(); }
      return false;
    }
    entry = { session_ref: ref, at, phase: 'armed', first_attempt_at: null, last_attempt_at: null };
    save();
    log('info', `auto-stop: armed ${ref} at ${new Date(at).toISOString()}`);
    return true;
  }

  /** That take was stopped or cancelled by anything: nothing left to do for it. */
  function disarm(sessionRef) {
    if (!entry || entry.phase === 'local_stopped') return;
    if (sessionRef && entry.session_ref !== sessionRef) return;
    entry = null;
    save();
  }

  async function tick() {
    if (busy || !entry) return;
    busy = true;
    try {
      const t = now();
      const ref = entry.session_ref;
      if (entry.phase === 'local_stopped') {
        // Keep telling the Worker until it has the Stop on record.
        if (entry.last_attempt_at && t - entry.last_attempt_at < retryMs) return;
        entry.last_attempt_at = t;
        save();
        try {
          const out = await post({ mode: 'report', session_ref: ref, result: entry.report });
          if (out && (out.ok === true || out.reason === 'not_current_take' || out.reason === 'stop_already_sent')) {
            log('info', `auto-stop: local stop of ${ref} reported (${out.ok ? 'recorded' : out.reason})`);
            entry = null;
            save();
          }
        } catch (_) { /* still offline: next tick */ }
        return;
      }
      if (!isTakeLive(ref)) { entry = null; save(); return; }
      if (t < entry.at) return;
      if (entry.phase === 'requested') return; // the Stop is queued; it arrives through the poll
      if (entry.last_attempt_at && t - entry.last_attempt_at < retryMs) return;
      if (!entry.first_attempt_at) entry.first_attempt_at = t;
      entry.last_attempt_at = t;
      save();
      try {
        const out = await post({ mode: 'request', session_ref: ref });
        if (out && out.ok === true) {
          entry.phase = 'requested';
          save();
          log('info', `auto-stop: Stop queued for ${ref}${out.already ? ' (already queued)' : ''}`);
          return;
        }
        if (out && (out.reason === 'not_current_take' || out.reason === 'stop_already_sent')) {
          log('info', `auto-stop: nothing to do for ${ref} (${out.reason})`);
          entry = null;
          save();
          return;
        }
        // too_early (clock skew) or anything else: retry on the next interval.
      } catch (e) {
        if (t - entry.first_attempt_at >= localAfterMs && isTakeLive(ref)) {
          log('warn', `auto-stop: Worker unreachable ${Math.round((t - entry.first_attempt_at) / 1000)} s after the deadline; stopping ${ref} here`);
          const result = await localStop(ref);
          entry = { session_ref: ref, at: entry.at, phase: 'local_stopped', report: { ...(result || {}), stopped_at: new Date(now()).toISOString() }, last_attempt_at: null };
          save();
        }
      }
    } finally {
      busy = false;
    }
  }

  function status() {
    return entry ? { session_ref: entry.session_ref, auto_stop_at: new Date(entry.at).toISOString(), phase: entry.phase } : null;
  }

  return { arm, disarm, tick, status };
}

module.exports = { LOCAL_AFTER_MS, REQUEST_RETRY_MS, createAutoStop, parseDeadline };
