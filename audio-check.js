'use strict';

// Mic check (Build 42, A1). Robbie's Take 1 on 2026-10-19 recorded Mic 1 near-dead
// (-96 dBFS) for its first 14.7 s and nothing on the Mini noticed. This module
// looks at what OBS is actually hearing and recording, and says so loudly. It is
// WARN ONLY (Anna, 2026-10-20): a failed check never refuses a take.
//
// What one check reads, over its own short-lived obs-websocket client (the shared
// client keeps eventSubscriptions 0, so its request sequences are unchanged):
//   - ~1.5 s of InputVolumeMeters events (subscription bit 1<<16, ~20 a second)
//   - per mic: GetInputMute, GetInputVolume, GetInputAudioTracks
//   - the recording's tracks: GetProfileParameter Output/Mode, then
//     AdvOut/RecTracks (SimpleOutput/RecTracks in Simple mode), a bitmask string
//   - EVO 8 presence: Mic N's CoreAudio device list (evo-audio readMicInput). The
//     "AppleUSBAudioEngine:Audient:EVO8..." entry only exists while the EVO is
//     plugged in; the Loopback "EVO Ch1-4" devices persist without it.
//
// Verdict codes (the `audio` block contract): evo_missing, mic_muted, mic_silent
// (digital zero; or peak below -90 dBFS = warn), mics_frozen (no meter updates,
// or values that never change), mics_identical (two mics carrying one signal),
// mic_not_recorded (input missing, its track N off, or track N not recorded),
// meters_unavailable (no meter events at all).

const { ObsClient, EVENT_SUB_INPUT_VOLUME_METERS, EVENT_SUB_OUTPUTS } = require('./obs-control');
const { readMicInput } = require('./evo-audio');

const DEFAULT_MICS = ['Mic 1', 'Mic 2', 'Mic 3', 'Mic 4'];
const METER_WINDOW_MS = 1500;
const TAKE_WINDOW_MS = 3000;
const TAKE_EVAL_MS = 10000;
const REQUEST_TIMEOUT_MS = 2500;
// Healthy noise floors on bench-1 masters are -75...-84 dBFS; Take 1's dead Mic 1
// sat at -96. A 1.5 s peak under -90 dBFS is a mic that is not picking anything up.
const LOW_PEAK_DB = -90;
// Two mics are "identical" when their level ratio is constant to within this,
// frame by frame, while the signal itself moves (08-18: Mic 1/2/3 on one channel).
const IDENTICAL_TOLERANCE_DB = 0.05;
const IDENTICAL_MIN_FRAMES = 10;
const IDENTICAL_MIN_RANGE_DB = 0.5;
const EVO_DEVICE_RE = /AppleUSBAudioEngine:Audient:EVO/i;
const FAIL_CODES = ['evo_missing', 'mic_muted', 'mic_not_recorded', 'mics_frozen', 'mics_identical'];
const CODE_ORDER = ['evo_missing', 'mic_muted', 'mic_not_recorded', 'mic_silent', 'mics_frozen', 'mics_identical', 'meters_unavailable'];

function ok(response) {
  return !!(response && response.requestStatus && response.requestStatus.result);
}

function data(response) {
  return (response && response.responseData && typeof response.responseData === 'object') ? response.responseData : {};
}

function toDb(mul) {
  return Number.isFinite(mul) && mul > 0 ? Math.round(20 * Math.log10(mul) * 10) / 10 : null;
}

function micNumber(name) {
  const m = String(name).match(/(\d+)\s*$/);
  return m ? Number(m[1]) : null;
}

/** inputLevelsMul for one input: [[magnitude, peak, inputPeak], ...] per channel. */
function cleanLevels(value) {
  if (!Array.isArray(value)) return null;
  return value.filter((ch) => Array.isArray(ch)).map((ch) => ch.map((v) => (Number.isFinite(Number(v)) ? Number(v) : 0)));
}

/** One InputVolumeMeters event -> { at, levels: { [inputName]: channels } }. */
function meterFrame(eventData, at) {
  const levels = {};
  const inputs = eventData && Array.isArray(eventData.inputs) ? eventData.inputs : [];
  for (const input of inputs) {
    if (!input || typeof input.inputName !== 'string') continue;
    const channels = cleanLevels(input.inputLevelsMul);
    if (channels) levels[input.inputName] = channels;
  }
  return { at, levels };
}

function seriesFor(frames, mic) {
  return frames.map((f) => f.levels[mic]).filter(Boolean);
}

function constantRatio(a, b) {
  const diffs = [];
  const levelsA = [];
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] && a[i][0] && a[i][0][0];
    const y = b[i] && b[i][0] && b[i][0][0];
    if (!(x > 0) || !(y > 0)) continue;
    diffs.push(20 * Math.log10(x) - 20 * Math.log10(y));
    levelsA.push(20 * Math.log10(x));
  }
  if (diffs.length < IDENTICAL_MIN_FRAMES) return false;
  const sorted = diffs.slice().sort((p, q) => p - q);
  const median = sorted[Math.floor(sorted.length / 2)];
  const spread = Math.max(...diffs.map((d) => Math.abs(d - median)));
  const range = Math.max(...levelsA) - Math.min(...levelsA);
  return spread <= IDENTICAL_TOLERANCE_DB && range >= IDENTICAL_MIN_RANGE_DB;
}

/**
 * Pure. frames: [{ at, levels: { name: [[mag, peak, inputPeak], ...] } }].
 * Per mic: frames seen, peak_db (null = nothing), zero (digital zero), frozen.
 */
function analyzeMeters(frames, micNames) {
  const list = Array.isArray(frames) ? frames : [];
  const out = { available: list.length > 0, frames: list.length, mics: {}, identical_pairs: [] };
  for (const mic of micNames) {
    const series = seriesFor(list, mic);
    if (!series.length) {
      // Meters arrive for other inputs but never for this one: no updates.
      out.mics[mic] = { frames: 0, peak_db: null, zero: null, frozen: out.available ? true : null };
      continue;
    }
    const flat = series.flat(2);
    const zero = flat.every((v) => v === 0);
    let peak = 0;
    for (const channels of series) for (const ch of channels) peak = Math.max(peak, Number(ch[1]) || 0, Number(ch[0]) || 0);
    const first = JSON.stringify(series[0]);
    const unchanged = series.length >= 2 && series.every((s) => JSON.stringify(s) === first);
    // Fewer than half the frames: the meter for this input stalls or drops out.
    const sparse = series.length * 2 < list.length;
    out.mics[mic] = { frames: series.length, peak_db: toDb(peak), zero, frozen: !zero && (unchanged || sparse) };
  }
  const usable = micNames.filter((m) => out.mics[m].frames > 0 && !out.mics[m].zero && !out.mics[m].frozen);
  for (let i = 0; i < usable.length; i += 1) {
    for (let j = i + 1; j < usable.length; j += 1) {
      const a = list.map((f) => f.levels[usable[i]]);
      const b = list.map((f) => f.levels[usable[j]]);
      if (constantRatio(a, b)) out.identical_pairs.push([usable[i], usable[j]]);
    }
  }
  return out;
}

function trackOn(tracks, n) {
  if (!tracks || typeof tracks !== 'object' || !n) return null;
  const v = tracks[String(n)];
  return typeof v === 'boolean' ? v : null;
}

function recTrackOn(recTracks, n) {
  if (!Number.isInteger(recTracks) || !n) return null;
  return (recTracks & (1 << (n - 1))) !== 0;
}

/**
 * Pure. Builds the contract `audio` block from meters + OBS settings.
 * info: { mics: { name: { exists, muted, volume_mul, volume_db, tracks } }, recTracks, evoPresent, error }
 */
function evaluateAudio(meters, info, checkedAt, micNames) {
  const names = micNames || DEFAULT_MICS;
  const facts = info || {};
  const codes = new Set();
  const mics = {};
  let warnOnly = true;
  const identical = new Set();
  for (const [a, b] of (meters && meters.identical_pairs) || []) { identical.add(a); identical.add(b); }
  for (const name of names) {
    const mi = (facts.mics && facts.mics[name]) || {};
    const mm = (meters && meters.mics && meters.mics[name]) || { frames: 0, peak_db: null, zero: null, frozen: null };
    const micCodes = [];
    const n = micNumber(name);
    const muted = mi.muted === true || mi.volume_mul === 0;
    let recorded = null;
    if (mi.exists === false) recorded = false;
    else {
      const onTrack = trackOn(mi.tracks, n);
      const recOn = recTrackOn(facts.recTracks, n);
      if (onTrack === false || recOn === false) recorded = false;
      else if (onTrack === true && recOn === true) recorded = true;
    }
    if (muted) micCodes.push('mic_muted');
    if (recorded === false) micCodes.push('mic_not_recorded');
    // A muted or deleted mic explains its own meter; only the cause is reported.
    const explained = muted || mi.exists === false;
    if (!explained && mm.zero === true) micCodes.push('mic_silent');
    else if (!explained && mm.peak_db !== null && mm.peak_db < LOW_PEAK_DB) micCodes.push('mic_silent');
    if (!explained && mm.frozen === true) micCodes.push('mics_frozen');
    if (identical.has(name)) micCodes.push('mics_identical');
    for (const c of micCodes) {
      codes.add(c);
      if (FAIL_CODES.includes(c) || (c === 'mic_silent' && mm.zero === true)) warnOnly = false;
    }
    const entry = { muted, peak_db: mm.peak_db, frozen: mm.frozen, recorded, codes: micCodes };
    if (mi.exists === false) entry.missing = true;
    if (Number.isFinite(mi.volume_db)) entry.volume_db = Math.round(mi.volume_db * 10) / 10;
    mics[name] = entry;
  }
  if (meters && !meters.available) codes.add('meters_unavailable');
  if (facts.evoPresent === false) { codes.add('evo_missing'); warnOnly = false; }
  const ordered = CODE_ORDER.filter((c) => codes.has(c));
  const level = ordered.length === 0 ? 'ok' : (warnOnly ? 'warn' : 'fail');
  const block = {
    level,
    checked_at: checkedAt || new Date().toISOString(),
    evo_present: typeof facts.evoPresent === 'boolean' ? facts.evoPresent : null,
    codes: ordered,
    mics,
  };
  if (meters && meters.identical_pairs && meters.identical_pairs.length) block.identical_pairs = meters.identical_pairs;
  return block;
}

/** The block when the check could not run at all (OBS down, check disabled). */
function unknownAudio(error, checkedAt) {
  return { level: 'unknown', checked_at: checkedAt || new Date().toISOString(), evo_present: null, codes: [], mics: {}, error: String(error || 'unknown') };
}

async function safeRequest(client, type, payload) {
  try { return await client.request(type, payload); } catch (_) { return null; }
}

/** Mute, volume, tracks per mic; the recording's track mask; EVO presence. Never throws. */
async function readAudioSettings(client, micNames, options) {
  const opts = options || {};
  const out = { mics: {}, recTracks: null, evoPresent: null };
  const listRes = await safeRequest(client, 'GetInputList');
  const inputs = ok(listRes) && Array.isArray(data(listRes).inputs)
    ? new Set(data(listRes).inputs.map((i) => i && i.inputName).filter((n) => typeof n === 'string'))
    : null;
  for (const name of micNames) {
    if (inputs && !inputs.has(name)) { out.mics[name] = { exists: false }; continue; }
    const [mute, volume, tracks] = await Promise.all([
      safeRequest(client, 'GetInputMute', { inputName: name }),
      safeRequest(client, 'GetInputVolume', { inputName: name }),
      safeRequest(client, 'GetInputAudioTracks', { inputName: name }),
    ]);
    const entry = { exists: inputs ? true : null };
    if (ok(mute) && typeof data(mute).inputMuted === 'boolean') entry.muted = data(mute).inputMuted;
    if (ok(volume)) {
      const v = data(volume);
      if (Number.isFinite(v.inputVolumeMul)) entry.volume_mul = v.inputVolumeMul;
      if (Number.isFinite(v.inputVolumeDb)) entry.volume_db = v.inputVolumeDb;
    }
    if (ok(tracks) && data(tracks).inputAudioTracks && typeof data(tracks).inputAudioTracks === 'object') entry.tracks = data(tracks).inputAudioTracks;
    out.mics[name] = entry;
  }
  const modeRes = await safeRequest(client, 'GetProfileParameter', { parameterCategory: 'Output', parameterName: 'Mode' });
  const mode = ok(modeRes) ? data(modeRes).parameterValue : null;
  const category = mode === 'Simple' ? 'SimpleOutput' : 'AdvOut';
  const recRes = await safeRequest(client, 'GetProfileParameter', { parameterCategory: category, parameterName: 'RecTracks' });
  const recValue = ok(recRes) ? Number(data(recRes).parameterValue) : NaN;
  out.recTracks = Number.isInteger(recValue) && recValue > 0 ? recValue : null;
  if (opts.evo !== false) {
    const firstMic = micNames.find((n) => !out.mics[n] || out.mics[n].exists !== false);
    if (firstMic) {
      try {
        const mic = await readMicInput(client, firstMic);
        if (Array.isArray(mic.devices)) out.evoPresent = mic.devices.some((d) => EVO_DEVICE_RE.test(String(d.value || '')) || EVO_DEVICE_RE.test(String(d.name || '')));
      } catch (_) { /* unknown */ }
    }
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => { const t = setTimeout(resolve, ms); if (t.unref) t.unref(); });
}

/**
 * The agent's mic monitor: idle checks on a short-lived client, and one client
 * kept open for the length of a take (meters + the RecordStateChanged event the
 * take timing uses). Every method resolves; nothing here can fail a take.
 */
function createAudioMonitor(options) {
  const opts = options || {};
  const micNames = Array.isArray(opts.micNames) && opts.micNames.length ? opts.micNames : DEFAULT_MICS;
  const windowMs = Number.isFinite(opts.windowMs) ? opts.windowMs : METER_WINDOW_MS;
  const takeWindowMs = Number.isFinite(opts.takeWindowMs) ? opts.takeWindowMs : TAKE_WINDOW_MS;
  const takeEvalMs = Number.isFinite(opts.takeEvalMs) ? opts.takeEvalMs : TAKE_EVAL_MS;
  const log = opts.log || ((m) => console.log('[es-mini-agent] [audio] ' + m));
  const warn = opts.warn || ((m) => console.warn('[es-mini-agent] [audio] WARN ' + m));
  const makeClient = opts.createClient || ((onEvent, subs) => new ObsClient({
    url: opts.url, password: opts.password, requestTimeoutMs: REQUEST_TIMEOUT_MS, eventSubscriptions: subs, onEvent,
  }));

  let last = null;
  let inFlight = null;
  let take = null;
  let lastLogged = '';

  function remember(block, context) {
    last = block;
    const sig = block.level + ':' + block.codes.join(',');
    if (sig !== lastLogged) {
      lastLogged = sig;
      const detail = Object.entries(block.mics || {}).filter(([, m]) => m.codes && m.codes.length).map(([n, m]) => n + '=' + m.codes.join('+')).join(' ');
      const line = 'mic check (' + context + ') ' + block.level + (block.codes.length ? ': ' + block.codes.join(',') : '') + (detail ? ' | ' + detail : '') + (block.error ? ' | ' + block.error : '');
      if (block.level === 'ok') log(line); else warn(line);
    }
    return block;
  }

  async function shortCheck() {
    const frames = [];
    let client;
    try {
      client = makeClient((type, payload) => { if (type === 'InputVolumeMeters') frames.push(meterFrame(payload, Date.now())); }, EVENT_SUB_INPUT_VOLUME_METERS);
      await client.ensureConnected();
    } catch (e) {
      try { if (client) client.close(); } catch (_) {}
      return unknownAudio('obs_unreachable');
    }
    try {
      const [settings] = await Promise.all([readAudioSettings(client, micNames, opts), sleep(windowMs)]);
      return evaluateAudio(analyzeMeters(frames, micNames), settings, new Date().toISOString(), micNames);
    } catch (e) {
      return unknownAudio('audio_check_failed: ' + (e && (e.message || e)));
    } finally {
      try { client.close(); } catch (_) {}
    }
  }

  async function evaluateTake(t) {
    const since = Date.now() - takeWindowMs;
    const frames = t.frames.filter((f) => f.at >= since);
    if (!t.client) return unknownAudio('obs_unreachable');
    const settings = await readAudioSettings(t.client, micNames, opts);
    return evaluateAudio(analyzeMeters(frames, micNames), settings, new Date().toISOString(), micNames);
  }

  /** A fresh check (idle: own client; during a take: the take's client). */
  function check(context) {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const block = take ? await evaluateTake(take) : await shortCheck();
        if (take) take.alert = block;
        return remember(block, context || 'check');
      } catch (e) {
        return remember(unknownAudio('audio_check_failed: ' + (e && (e.message || e))), context || 'check');
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  /**
   * Opens the take's client before StartRecord: meters for the pre-start verdict
   * (ready after windowMs) and the in-take alert, and the moment OBS reports its
   * recording output STARTED (the master's t=0 for the take timing).
   */
  function beginTake() {
    if (take) return take;
    const t = { frames: [], client: null, timer: null, alert: null, recordStartedAt: null, recordStartedAtMs: null, connected: null, preStart: null };
    take = t;
    const onEvent = (type, payload) => {
      const now = Date.now();
      if (type === 'InputVolumeMeters') {
        t.frames.push(meterFrame(payload, now));
        const keep = now - Math.max(takeWindowMs, windowMs) - 1000;
        while (t.frames.length && t.frames[0].at < keep) t.frames.shift();
      } else if (type === 'RecordStateChanged' && payload && payload.outputState === 'OBS_WEBSOCKET_OUTPUT_STARTED' && t.recordStartedAtMs === null) {
        t.recordStartedAtMs = now;
        t.recordStartedAt = new Date(now).toISOString();
      }
    };
    t.connected = (async () => {
      try {
        const client = makeClient(onEvent, EVENT_SUB_INPUT_VOLUME_METERS | EVENT_SUB_OUTPUTS);
        await client.ensureConnected();
        if (take !== t) { client.close(); return false; }
        t.client = client;
        return true;
      } catch (e) {
        warn('take mic watch could not connect to OBS: ' + (e && (e.message || e)));
        return false;
      }
    })();
    t.preStart = t.connected.then(async (connected) => {
      if (!connected) return remember(unknownAudio('obs_unreachable'), 'pre-start');
      await sleep(windowMs);
      if (take !== t) return last || unknownAudio('take_ended');
      return check('pre-start');
    });
    t.timer = setInterval(() => { if (take === t && t.client) check('take').catch(() => {}); }, takeEvalMs);
    if (t.timer.unref) t.timer.unref();
    return t;
  }

  /** Closes the take's client. Resolves { alert, recordStartedAt }. */
  async function endTake() {
    const t = take;
    if (!t) return { alert: null, recordStartedAt: null };
    take = null;
    clearInterval(t.timer);
    await t.connected.catch(() => false);
    try { if (t.client) t.client.close(); } catch (_) {}
    return { alert: t.alert, recordStartedAt: t.recordStartedAt, recordStartedAtMs: t.recordStartedAtMs };
  }

  return {
    check,
    beginTake,
    endTake,
    latest: () => last,
    takeAlert: () => (take ? take.alert : null),
    takeActive: () => !!take,
    recordStartedAt: () => (take ? { iso: take.recordStartedAt, ms: take.recordStartedAtMs } : null),
  };
}

module.exports = {
  DEFAULT_MICS,
  LOW_PEAK_DB,
  analyzeMeters,
  createAudioMonitor,
  evaluateAudio,
  meterFrame,
  readAudioSettings,
  unknownAudio,
};
