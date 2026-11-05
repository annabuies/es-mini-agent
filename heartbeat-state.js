'use strict';

// The heartbeat's `last_state` (Build 45). The agent sends it base64url in the
// command poll's query string (&state=...), and the Worker (es-os-app
// api/record.js) DROPS it when its JSON is over 2048 bytes. Everything here is
// pure: the poll path must never do I/O to build it.

const HEARTBEAT_STATE_MAX_BYTES = 2048;

function sortedTrackList(value) {
  if (!Array.isArray(value)) return null;
  return value.filter((t) => Number.isInteger(t) && t >= 1 && t <= 6).sort((a, b) => a - b);
}

/**
 * The contract `audio` block, compact (status, start, audio_check, heartbeat):
 * no extra fields beyond the contract's. `route` (A6) is each mic's enabled OBS
 * tracks and the recording's RecTracks, kept unless options.route === false.
 */
function compactAudio(block, options) {
  if (!block) return null;
  const withRoute = !(options && options.route === false);
  const mics = {};
  for (const [name, m] of Object.entries(block.mics || {})) {
    mics[name] = { muted: !!m.muted, peak_db: Number.isFinite(m.peak_db) ? m.peak_db : null, frozen: typeof m.frozen === 'boolean' ? m.frozen : null, recorded: typeof m.recorded === 'boolean' ? m.recorded : null, codes: Array.isArray(m.codes) ? m.codes : [] };
    if (withRoute && m.route && typeof m.route === 'object') {
      mics[name].route = { tracks: sortedTrackList(m.route.tracks), rec_tracks: sortedTrackList(m.route.rec_tracks) };
    }
  }
  const out = { level: block.level, checked_at: block.checked_at || null, evo_present: typeof block.evo_present === 'boolean' ? block.evo_present : null, codes: Array.isArray(block.codes) ? block.codes : [], mics };
  if (block.error) out.error = String(block.error).slice(0, 80);
  return out;
}

/**
 * The heartbeat state object from the agent's cached samples (never I/O).
 * inputs: { recording, paused, uploadsQueued, masterActive, cameraReachability,
 *           diskUsage, powerHealth, audio (full or compact block), webhookPending,
 *           previewCamera }
 * webhook_pending (A8) is omitted when nothing is pending (the cloud alerts on
 * count > 0 only); else { count, oldest_age_s } plus gave_up when any gave up.
 */
function buildHeartbeatState(inputs, options) {
  const i = inputs || {};
  const cameraReachability = i.cameraReachability;
  const diskUsage = i.diskUsage;
  const powerHealth = i.powerHealth;
  const out = {
    recording: !!i.recording,
    paused: !!i.paused,
    // A poll must never do I/O to sample file growth. The next status/diag
    // remains the authoritative detailed value while this bounded signal
    // conveys whether a recording is in progress.
    feeds_writing: i.recording ? null : 0,
    uploads: Number.isFinite(i.uploadsQueued) ? i.uploadsQueued : 0,
    master_active: !!i.masterActive,
    // Camera reachability is sampled on its own timer: never add I/O here.
    cameras_down: Array.isArray(cameraReachability && cameraReachability.down)
      ? cameraReachability.down : [],
    cameras_checked_at: typeof (cameraReachability && cameraReachability.checked_at) === 'string'
      ? cameraReachability.checked_at : null,
    // Disk usage is sampled on its own timer: never add I/O here.
    disk_free_bytes: Number.isFinite(diskUsage && diskUsage.free_bytes)
      ? diskUsage.free_bytes : null,
    disk_total_bytes: Number.isFinite(diskUsage && diskUsage.total_bytes)
      ? diskUsage.total_bytes : null,
    disk_checked_at: typeof (diskUsage && diskUsage.checked_at) === 'string'
      ? diskUsage.checked_at : null,
    // Power strip health is sampled on its own timer: never add I/O here. Null when unconfigured.
    power: powerHealth ? { ...powerHealth } : null,
    // Mic check (cached; idle checks and the take's own watch fill it): never add I/O here.
    audio: compactAudio(i.audio, options),
    // The angle in the room's one shared preview stream (contract C1): 1-3, or null
    // when no preview overlay is active. Pure: the agent hands in its cached value.
    preview_camera: Number.isInteger(i.previewCamera) && i.previewCamera >= 1 && i.previewCamera <= 3 ? i.previewCamera : null,
  };
  const wp = i.webhookPending;
  if (wp && Number.isFinite(wp.count) && wp.count > 0) {
    out.webhook_pending = { count: wp.count, oldest_age_s: Number.isFinite(wp.oldest_age_s) ? wp.oldest_age_s : null };
    if (Number.isFinite(wp.gave_up) && wp.gave_up > 0) out.webhook_pending.gave_up = wp.gave_up;
  }
  return out;
}

/**
 * The JSON the Worker will see, kept under its 2048-byte cap: if a state ever
 * outgrows it, the mic routes go first (status keeps them), then the per-mic
 * detail (the audio level and codes stay).
 */
function heartbeatStateJson(inputs, maxBytes) {
  const cap = Number.isFinite(maxBytes) ? maxBytes : HEARTBEAT_STATE_MAX_BYTES;
  let json = JSON.stringify(buildHeartbeatState(inputs));
  if (Buffer.byteLength(json) <= cap) return json;
  const noRoute = buildHeartbeatState(inputs, { route: false });
  json = JSON.stringify(noRoute);
  if (Buffer.byteLength(json) <= cap) return json;
  if (noRoute.audio) noRoute.audio.mics = {};
  return JSON.stringify(noRoute);
}

module.exports = {
  HEARTBEAT_STATE_MAX_BYTES,
  buildHeartbeatState,
  compactAudio,
  heartbeatStateJson,
};
