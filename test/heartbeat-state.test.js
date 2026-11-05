'use strict';

// The heartbeat last_state goes base64url in a query string, and the Worker
// (es-os-app api/record.js) drops it when its JSON is over 2048 bytes. Build 45
// added per-mic routes (A6); the worst case must still fit.

const assert = require('node:assert/strict');
const test = require('node:test');
const { HEARTBEAT_STATE_MAX_BYTES, buildHeartbeatState, compactAudio, heartbeatStateJson } = require('../heartbeat-state');

const ALL_CODES = ['evo_missing', 'mic_muted', 'mic_not_recorded', 'mic_silent', 'mics_frozen', 'mics_identical', 'meters_unavailable'];
const MIC_CODES = ['mic_muted', 'mic_not_recorded', 'mic_silent', 'mics_frozen', 'mics_identical'];

/** The largest state the agent can produce today (every field at its widest). */
function worstCaseInputs(extra) {
  const mics = {};
  for (const name of ['Mic 1', 'Mic 2', 'Mic 3', 'Mic 4']) {
    mics[name] = {
      muted: true, peak_db: -100.5, frozen: false, recorded: false, codes: MIC_CODES.slice(),
      missing: true, volume_db: -100.5, route: { tracks: [1, 2, 3, 4, 5, 6], rec_tracks: [1, 2, 3, 4, 5, 6] },
    };
  }
  return Object.assign({
    recording: true,
    paused: true,
    uploadsQueued: 99999,
    masterActive: true,
    cameraReachability: { checked_at: '2026-10-26T23:59:59.999Z', down: ['cam1', 'cam2', 'cam3', 'cam4'] },
    diskUsage: { free_bytes: 999999999999999, total_bytes: 999999999999999, checked_at: '2026-10-26T23:59:59.999Z' },
    // A8: undelivered upload_confirmed posts (the widest it can be).
    webhookPending: { count: 99999, oldest_age_s: 9999999, gave_up: 99999 },
    powerHealth: { ok: false, reason: 'auth_failed_or_some_long_reason_xx', lights_on: false, fail_count: 99999, checked_at: '2026-10-26T23:59:59.999Z' },
    audio: {
      level: 'fail', checked_at: '2026-10-26T23:59:59.999Z', evo_present: false, codes: ALL_CODES.slice(), mics,
      identical_pairs: [['Mic 1', 'Mic 2'], ['Mic 3', 'Mic 4']],
      error: 'audio_check_failed: ' + 'x'.repeat(200),
    },
  }, extra || {});
}

test('heartbeat: the worst-case last_state, mic routes and webhook_pending included, stays under the Worker\'s 2048-byte cap', () => {
  const state = buildHeartbeatState(worstCaseInputs());
  const bytes = Buffer.byteLength(JSON.stringify(state));
  console.log('worst-case heartbeat last_state bytes: ' + bytes);
  assert.ok(bytes < HEARTBEAT_STATE_MAX_BYTES, 'worst case is ' + bytes + ' bytes');
  assert.deepEqual(state.audio.mics['Mic 1'].route, { tracks: [1, 2, 3, 4, 5, 6], rec_tracks: [1, 2, 3, 4, 5, 6] });
  assert.deepEqual(state.webhook_pending, { count: 99999, oldest_age_s: 9999999, gave_up: 99999 });
  assert.equal(heartbeatStateJson(worstCaseInputs()), JSON.stringify(state), 'nothing trimmed when it fits');
});

test('heartbeat: a state that would overflow drops the mic routes first, then the per-mic detail', () => {
  const json = heartbeatStateJson(worstCaseInputs(), 1500);
  const state = JSON.parse(json);
  assert.ok(Buffer.byteLength(json) <= 1500);
  assert.equal(state.audio.mics['Mic 1'].route, undefined);
  assert.deepEqual(state.audio.mics['Mic 1'].codes, MIC_CODES);
  const tiny = JSON.parse(heartbeatStateJson(worstCaseInputs(), 800));
  assert.deepEqual(tiny.audio.mics, {});
  assert.equal(tiny.audio.level, 'fail');
});

test('compactAudio keeps the contract fields plus route, and nothing else', () => {
  const c = compactAudio(worstCaseInputs().audio);
  assert.deepEqual(Object.keys(c.mics['Mic 2']).sort(), ['codes', 'frozen', 'muted', 'peak_db', 'recorded', 'route']);
  assert.equal(c.error.length, 80);
  assert.equal(c.identical_pairs, undefined);
  assert.deepEqual(Object.keys(compactAudio(worstCaseInputs().audio, { route: false }).mics['Mic 2']).sort(), ['codes', 'frozen', 'muted', 'peak_db', 'recorded']);
});
