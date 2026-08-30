'use strict';

const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const defaultPtz = require('./ptz');
const defaultVisca = require('./visca');

const DEFAULT_RESET_SETTLE_MS = 30000;
const DEFAULT_RESET_SETTLE_CAP_MS = 60000;
const DEFAULT_RESET_POLL_MS = 1000;
const DEFAULT_RECALL_SETTLE_MS = 2000;
const DEFAULT_SSIM_MIN = 0.80;
const DEFAULT_BOOT_UPTIME_S = 600;
const DEFAULT_ROOM_CHECK_LEAD_MIN = 20;

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function sleepDefault(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowDate(ctx) {
  const value = ctx && typeof ctx.now === 'function' ? ctx.now() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function stateValue(ctx, key, fallback) {
  if (ctx && Object.prototype.hasOwnProperty.call(ctx, key)) return ctx[key];
  if (ctx && ctx.state && Object.prototype.hasOwnProperty.call(ctx.state, key)) return ctx.state[key];
  return fallback;
}

function selectedCameras(ctx, opts) {
  const cameras = Array.isArray(stateValue(ctx, 'cameras', [])) ? stateValue(ctx, 'cameras', []) : [];
  const requested = opts && Array.isArray(opts.cameras)
    ? new Set(opts.cameras.map((value) => String(value || '').trim()).filter(Boolean))
    : null;
  return requested ? cameras.filter((camera) => requested.has(camera.name)) : cameras.slice();
}

function resolveLook(ctx, opts) {
  if (opts && (typeof opts.look === 'string' || typeof opts.look === 'number')) return String(opts.look).trim();
  const checkLook = stateValue(ctx, 'check_look', null);
  return typeof checkLook === 'string' ? checkLook.trim() : '';
}

function bookingIsActive(ctx, at) {
  const upcoming = stateValue(ctx, 'upcoming', null);
  if (!upcoming || !upcoming.access_from || !upcoming.access_until) return false;
  const nowMs = at instanceof Date ? at.getTime() : new Date(at).getTime();
  const fromMs = new Date(upcoming.access_from).getTime();
  const untilMs = new Date(upcoming.access_until).getTime();
  if ([nowMs, fromMs, untilMs].some((value) => Number.isNaN(value))) return false;
  return nowMs >= fromMs && nowMs < untilMs;
}

function operationGate(ctx, opts) {
  const force = !!(opts && opts.force === true);
  const state = ctx && ctx.state ? ctx.state : ctx || {};
  if (!force && (state.recording || state.paused)) return 'busy_recording';
  if (!force && bookingIsActive(ctx, nowDate(ctx))) return 'booking_active';
  if (selectedCameras(ctx, opts).length === 0) return 'no_cameras';
  const look = resolveLook(ctx, opts);
  if (!look) return 'no_check_look';
  const looks = stateValue(ctx, 'looks', {});
  if (!isPlainObject(looks) || !Object.prototype.hasOwnProperty.call(looks, look)) return 'unknown_look';
  return null;
}

function equalPosition(left, right) {
  return !!left && !!right && typeof left === 'object' && typeof right === 'object'
    && left.pan === right.pan && left.tilt === right.tilt;
}

async function settleAfterReset(ctx, host, initialPosition) {
  const visca = ctx.visca || defaultVisca;
  const wait = typeof ctx.sleep === 'function' ? ctx.sleep : sleepDefault;
  const fixedMs = Number(ctx.resetSettleMs) >= 0 ? Number(ctx.resetSettleMs) : DEFAULT_RESET_SETTLE_MS;
  const capMs = Number(ctx.resetSettleCapMs) > 0 ? Number(ctx.resetSettleCapMs) : DEFAULT_RESET_SETTLE_CAP_MS;
  const pollMs = Number(ctx.resetPollMs) > 0 ? Number(ctx.resetPollMs) : DEFAULT_RESET_POLL_MS;
  if (!visca || typeof visca.getPanTilt !== 'function' || !initialPosition || typeof initialPosition !== 'object') {
    await wait(fixedMs);
    return fixedMs;
  }

  let elapsed = 0;
  let changed = false;
  let previous = null;
  const maxPolls = Math.max(1, Math.ceil(capMs / pollMs));
  for (let attempt = 0; attempt < maxPolls; attempt += 1) {
    await wait(pollMs);
    elapsed += pollMs;
    const current = await visca.getPanTilt(host, ctx.viscaOptions);
    if (!current || typeof current !== 'object') {
      const remaining = Math.max(0, fixedMs - elapsed);
      if (remaining) await wait(remaining);
      return elapsed + remaining;
    }
    if (!equalPosition(current, initialPosition)) changed = true;
    if (changed && equalPosition(current, previous)) return elapsed;
    previous = current;
  }
  return elapsed;
}

function combineProfileResults(cgi, visca) {
  const parts = [cgi, visca].filter(Boolean);
  const attempted = parts.filter((part) => part.status !== 'skipped');
  const failures = [];
  if (cgi && Array.isArray(cgi.failures)) failures.push(...cgi.failures.map((key) => `cgi.${key}`));
  if (visca && Array.isArray(visca.failures)) failures.push(...visca.failures.map((key) => `visca.${key}`));
  let status = 'skipped';
  if (attempted.length && failures.length === 0) status = 'ok';
  else if (failures.length && attempted.some((part) => part.status === 'ok' || part.status === 'partial')) status = 'partial';
  else if (failures.length) status = 'error';
  return { status, failures };
}

async function calibrateCamera(ctx, camera, look, lookMap) {
  const ptz = ctx.ptz || defaultPtz;
  const visca = ctx.visca || defaultVisca;
  const profiles = stateValue(ctx, 'camera_profiles', {});
  const profile = isPlainObject(profiles) && isPlainObject(profiles[camera.name]) ? profiles[camera.name] : {};
  const result = {
    reachable: await ptz.probe(camera.host, { timeoutMs: ctx.probeTimeoutMs || 3000 }),
    reset: 'skipped',
    settle_ms: 0,
    profile: 'skipped',
    recall: 'skipped',
    readback: 'unavailable',
    ok: false,
  };
  if (result.reachable !== 'ok') return result;

  let initialPosition = 'unavailable';
  if (visca && typeof visca.getPanTilt === 'function') {
    initialPosition = await visca.getPanTilt(camera.host, ctx.viscaOptions);
  }
  result.reset = await ptz.panTiltReset(camera.host, { timeoutMs: ctx.probeTimeoutMs || 3000 });
  if (result.reset !== 'ok') return result;
  result.settle_ms = await settleAfterReset(ctx, camera.host, initialPosition);

  const cgiResult = await ptz.applyCgiProfile(camera.host, profile.cgi, { timeoutMs: ctx.probeTimeoutMs || 3000 });
  const viscaResult = visca && typeof visca.applyProfile === 'function'
    ? await visca.applyProfile(camera.host, profile.visca, ctx.viscaOptions)
    : { status: 'skipped', failures: [], results: {} };
  const profileResult = combineProfileResults(cgiResult, viscaResult);
  result.profile = profileResult.status;
  if (profileResult.failures.length) result.profile_failures = profileResult.failures;

  if (Object.prototype.hasOwnProperty.call(lookMap, camera.name)) {
    result.recall = await ptz.recall(camera.host, lookMap[camera.name], { timeoutMs: ctx.probeTimeoutMs || 3000 });
  }
  if (visca && typeof visca.readState === 'function') {
    result.readback = await visca.readState(camera.host, ctx.viscaOptions);
  }
  result.ok = result.reachable === 'ok'
    && result.reset === 'ok'
    && (result.profile === 'ok' || result.profile === 'skipped')
    && (result.recall === 'ok' || result.recall === 'skipped');
  return result;
}

async function calibrate(ctx, opts) {
  const options = opts || {};
  const look = resolveLook(ctx, options);
  const reason = operationGate(ctx, options);
  if (reason) return { ok: false, kind: 'calibrate', reason };
  const started = nowDate(ctx);
  const cameras = selectedCameras(ctx, options);
  const looks = stateValue(ctx, 'looks', {});
  const lookMap = looks[look];
  const entries = await Promise.all(cameras.map(async (camera) => [
    camera.name,
    await calibrateCamera(ctx, camera, look, lookMap),
  ]));
  const cameraResults = Object.fromEntries(entries);
  return {
    ok: entries.every((entry) => entry[1].ok),
    kind: 'calibrate',
    trigger: options.trigger || 'queued',
    look,
    started_at: started.toISOString(),
    duration_ms: Math.max(0, nowDate(ctx).getTime() - started.getTime()),
    cameras: cameraResults,
  };
}

function compareFrames(ffmpegBin, refPath, nowPath) {
  if (!ffmpegBin || !refPath || !nowPath) return Promise.resolve(null);
  return new Promise((resolve) => {
    const args = [
      '-hide_banner',
      '-i', refPath,
      '-i', nowPath,
      '-filter_complex', '[0:v]scale=320:180,format=gray[a];[1:v]scale=320:180,format=gray[b];[a][b]ssim',
      '-f', 'null',
      '-',
    ];
    let stderr = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let child;
    try {
      child = spawn(ffmpegBin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (_) {
      finish(null);
      return;
    }
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.once('error', () => finish(null));
    child.once('exit', (code) => {
      if (code !== 0) { finish(null); return; }
      const matches = [...stderr.matchAll(/All:([0-9]+(?:\.[0-9]+)?)/g)];
      const score = matches.length ? Number(matches[matches.length - 1][1]) : NaN;
      finish(Number.isFinite(score) ? score : null);
    });
  });
}

async function compareFrameBuffers(ctx, reference, current) {
  const tempRoot = await fsp.mkdtemp(path.join(ctx.tempDir || os.tmpdir(), 'es-room-check-'));
  const refPath = path.join(tempRoot, 'reference.jpg');
  const nowPath = path.join(tempRoot, 'current.jpg');
  try {
    await Promise.all([fsp.writeFile(refPath, reference), fsp.writeFile(nowPath, current)]);
    const compare = typeof ctx.compareFrames === 'function' ? ctx.compareFrames : compareFrames;
    return await compare(ctx.ffmpegBin, refPath, nowPath);
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function obsFeedResults(ctx, cameras) {
  const sources = Array.isArray(stateValue(ctx, 'obs_sources', [])) ? stateValue(ctx, 'obs_sources', []) : [];
  const byCamera = {};
  const bySource = {};
  if (sources.length === 0) {
    for (const camera of cameras) byCamera[camera.name] = 'no_source';
    return { byCamera, bySource, allOk: false };
  }
  if (typeof ctx.getObsClient !== 'function' || typeof ctx.getSourceScreenshot !== 'function') {
    for (const source of sources) bySource[source] = 'obs_unreachable';
    cameras.forEach((camera, index) => {
      byCamera[camera.name] = sources[index] ? 'obs_unreachable' : 'no_source';
    });
    return { byCamera, bySource, allOk: false };
  }
  let client;
  try {
    client = await ctx.getObsClient();
  } catch (_) {
    for (const source of sources) bySource[source] = 'obs_unreachable';
    cameras.forEach((camera, index) => {
      byCamera[camera.name] = sources[index] ? 'obs_unreachable' : 'no_source';
    });
    return { byCamera, bySource, allOk: false };
  }
  await Promise.all(sources.map(async (source) => {
    const frame = await ctx.getSourceScreenshot(client, source, 320, 50);
    bySource[source] = frame ? 'ok' : 'no_frame';
  }));
  cameras.forEach((camera, index) => {
    const source = sources[index];
    byCamera[camera.name] = source ? bySource[source] : 'no_source';
  });
  return { byCamera, bySource, allOk: sources.every((source) => bySource[source] === 'ok') };
}

function compareReadback(profile, readback) {
  const expected = profile && isPlainObject(profile.visca) ? profile.visca : {};
  const keys = Object.keys(expected).filter((key) => typeof expected[key] === 'number');
  if (!keys.length) return { match: null, diffs: {}, warning: 'no_readback_profile' };
  if (!readback || typeof readback !== 'object') return { match: null, diffs: {}, warning: 'readback_unavailable' };
  const diffs = {};
  for (const key of keys) {
    if (readback[key] !== expected[key]) diffs[key] = { expected: expected[key], actual: readback[key] ?? null };
  }
  return { match: Object.keys(diffs).length === 0, diffs };
}

async function roomCheckCamera(ctx, camera, look, lookMap, obsStatus) {
  const ptz = ctx.ptz || defaultPtz;
  const visca = ctx.visca || defaultVisca;
  const profiles = stateValue(ctx, 'camera_profiles', {});
  const references = stateValue(ctx, 'reference_frames', {});
  const profile = isPlainObject(profiles) && isPlainObject(profiles[camera.name]) ? profiles[camera.name] : {};
  const reference = isPlainObject(references) && isPlainObject(references[camera.name])
    && isPlainObject(references[camera.name][look]) ? references[camera.name][look] : null;
  const warnings = [];
  const result = {
    reachable: await ptz.probe(camera.host, { timeoutMs: ctx.probeTimeoutMs || 3000 }),
    recall: 'skipped',
    snapshot: 'skipped',
    ssim: null,
    ssim_min: Number(ctx.ssimMin) >= 0 ? Number(ctx.ssimMin) : DEFAULT_SSIM_MIN,
    frame_ok: null,
    readback_match: null,
    diffs: {},
    obs_feed: obsStatus,
    ok: false,
  };
  if (result.reachable !== 'ok') return result;
  if (Object.prototype.hasOwnProperty.call(lookMap, camera.name)) {
    result.recall = await ptz.recall(camera.host, lookMap[camera.name], { timeoutMs: ctx.probeTimeoutMs || 3000 });
  }
  if (result.recall !== 'ok' && result.recall !== 'skipped') return result;
  const wait = typeof ctx.sleep === 'function' ? ctx.sleep : sleepDefault;
  const recallSettleMs = Number(ctx.recallSettleMs) >= 0 ? Number(ctx.recallSettleMs) : DEFAULT_RECALL_SETTLE_MS;
  if (result.recall === 'ok' && recallSettleMs) await wait(recallSettleMs);

  const frame = await ptz.snapshot(camera.host, { timeoutMs: ctx.snapshotTimeoutMs || 5000 });
  if (!Buffer.isBuffer(frame) || frame.length === 0) {
    result.snapshot = 'error';
    return result;
  }
  result.snapshot = 'ok';
  const key = `roomcheck/${ctx.buildingId}/${camera.name}/${look}.jpg`;
  try {
    await ctx.storage.upload(key, frame);
    result.upload = 'ok';
  } catch (_) {
    result.upload = 'error';
  }

  if (!reference || typeof reference.key !== 'string' || !reference.key) {
    warnings.push('no_reference');
  } else {
    try {
      const referenceFrame = await ctx.storage.download(reference.key);
      result.ssim = await compareFrameBuffers(ctx, referenceFrame, frame);
      result.frame_ok = typeof result.ssim === 'number' ? result.ssim >= result.ssim_min : false;
      if (result.ssim === null) warnings.push('ssim_unavailable');
    } catch (_) {
      result.frame_ok = false;
      warnings.push('reference_unavailable');
    }
  }

  const readback = visca && typeof visca.readState === 'function'
    ? await visca.readState(camera.host, ctx.viscaOptions) : 'unavailable';
  const compared = compareReadback(profile, readback);
  result.readback_match = compared.match;
  result.diffs = compared.diffs;
  if (compared.warning) warnings.push(compared.warning);
  if (warnings.length) result.warnings = warnings;
  result.ok = result.reachable === 'ok'
    && (result.recall === 'ok' || result.recall === 'skipped')
    && result.snapshot === 'ok'
    && result.upload === 'ok'
    && result.frame_ok !== false
    && result.readback_match !== false
    && result.obs_feed === 'ok';
  return result;
}

async function roomCheck(ctx, opts) {
  const options = opts || {};
  if (options.calibrate === true) {
    const calibration = await calibrate(ctx, options);
    if (!calibration.ok) {
      return { ok: false, kind: 'room_check', reason: calibration.reason || 'calibration_failed', calibration };
    }
    options.calibration = calibration;
  }
  const look = resolveLook(ctx, options);
  const reason = operationGate(ctx, options);
  if (reason) return { ok: false, kind: 'room_check', reason };
  const cameras = selectedCameras(ctx, options);
  const looks = stateValue(ctx, 'looks', {});
  const obs = await obsFeedResults(ctx, cameras);
  const entries = await Promise.all(cameras.map(async (camera) => [
    camera.name,
    await roomCheckCamera(ctx, camera, look, looks[look], obs.byCamera[camera.name]),
  ]));
  const cameraResults = Object.fromEntries(entries);
  const warnings = [];
  for (const [camera, result] of entries) {
    for (const warning of result.warnings || []) warnings.push(`${camera}:${warning}`);
  }
  const out = {
    ok: entries.every((entry) => entry[1].ok) && obs.allOk,
    kind: 'room_check',
    trigger: options.trigger || 'queued',
    look,
    cameras: cameraResults,
    obs_sources: obs.bySource,
    warnings,
  };
  if (options.booking_id) out.booking_id = options.booking_id;
  if (options.calibration) out.calibration = options.calibration;
  return out;
}

function imageReadback(readback) {
  if (!readback || typeof readback !== 'object') return {};
  const out = {};
  for (const [key, value] of Object.entries(readback)) {
    if (key !== 'pan' && key !== 'tilt' && key !== 'zoom' && typeof value === 'number') out[key] = value;
  }
  return out;
}

async function captureReference(ctx, opts) {
  const options = opts || {};
  const force = !!options.force;
  const state = ctx && ctx.state ? ctx.state : ctx || {};
  if (!force && (state.recording || state.paused)) return { ok: false, kind: 'capture_reference', reason: 'busy_recording' };
  if (!force && bookingIsActive(ctx, nowDate(ctx))) return { ok: false, kind: 'capture_reference', reason: 'booking_active' };
  const cameras = selectedCameras(ctx, options);
  if (!cameras.length) return { ok: false, kind: 'capture_reference', reason: 'no_cameras' };
  const looks = stateValue(ctx, 'looks', {});
  const requestedLook = options.look == null ? '' : String(options.look).trim();
  const lookKeys = requestedLook ? [requestedLook] : Object.keys(isPlainObject(looks) ? looks : {});
  if (!lookKeys.length) return { ok: false, kind: 'capture_reference', reason: 'no_check_look' };
  if (lookKeys.some((look) => !Object.prototype.hasOwnProperty.call(looks, look))) {
    return { ok: false, kind: 'capture_reference', reason: 'unknown_look' };
  }

  const ptz = ctx.ptz || defaultPtz;
  const visca = ctx.visca || defaultVisca;
  const wait = typeof ctx.sleep === 'function' ? ctx.sleep : sleepDefault;
  const recallSettleMs = Number(ctx.recallSettleMs) >= 0 ? Number(ctx.recallSettleMs) : DEFAULT_RECALL_SETTLE_MS;
  const existingProfiles = stateValue(ctx, 'camera_profiles', {});
  const referenceFrames = {};
  const cameraProfiles = {};
  const results = {};
  let overall = true;

  for (const look of lookKeys) {
    const lookMap = looks[look];
    const recalls = await Promise.all(cameras.map(async (camera) => {
      if (!Object.prototype.hasOwnProperty.call(lookMap, camera.name)) return [camera.name, 'skipped'];
      return [camera.name, await ptz.recall(camera.host, lookMap[camera.name], { timeoutMs: ctx.probeTimeoutMs || 3000 })];
    }));
    if (recallSettleMs && recalls.some((entry) => entry[1] === 'ok')) await wait(recallSettleMs);

    const lookResults = await Promise.all(cameras.map(async (camera) => {
      const recall = (recalls.find((entry) => entry[0] === camera.name) || [null, 'skipped'])[1];
      const reachable = await ptz.probe(camera.host, { timeoutMs: ctx.probeTimeoutMs || 3000 });
      const result = { reachable, recall, snapshot: 'skipped', upload: 'skipped', readback: 'unavailable', ok: false };
      if (reachable !== 'ok' || (recall !== 'ok' && recall !== 'skipped')) return [camera.name, result];
      const frame = await ptz.snapshot(camera.host, { timeoutMs: ctx.snapshotTimeoutMs || 5000 });
      if (!Buffer.isBuffer(frame) || !frame.length) { result.snapshot = 'error'; return [camera.name, result]; }
      result.snapshot = 'ok';
      const key = `reference/${ctx.buildingId}/${camera.name}/${look}.jpg`;
      try {
        await ctx.storage.upload(key, frame);
        result.upload = 'ok';
      } catch (_) {
        result.upload = 'error';
      }
      result.readback = visca && typeof visca.readState === 'function'
        ? await visca.readState(camera.host, ctx.viscaOptions) : 'unavailable';
      const capturedAt = nowDate(ctx).toISOString();
      if (!referenceFrames[camera.name]) referenceFrames[camera.name] = {};
      const metadata = { key, captured_at: capturedAt };
      if (result.readback && typeof result.readback === 'object') {
        if (typeof result.readback.pan === 'number') metadata.pan = result.readback.pan;
        if (typeof result.readback.tilt === 'number') metadata.tilt = result.readback.tilt;
        if (typeof result.readback.zoom === 'number') metadata.zoom = result.readback.zoom;
      }
      referenceFrames[camera.name][look] = metadata;
      if (!cameraProfiles[camera.name]) {
        const existing = isPlainObject(existingProfiles) && isPlainObject(existingProfiles[camera.name])
          ? existingProfiles[camera.name] : {};
        cameraProfiles[camera.name] = {
          ...(isPlainObject(existing.cgi) ? { cgi: existing.cgi } : {}),
          visca: imageReadback(result.readback),
          captured_at: capturedAt,
          source: 'capture_reference',
        };
      }
      result.ok = result.snapshot === 'ok' && result.upload === 'ok';
      return [camera.name, result];
    }));
    results[look] = Object.fromEntries(lookResults);
    if (!lookResults.every((entry) => entry[1].ok)) overall = false;
  }

  return {
    ok: overall,
    kind: 'capture_reference',
    trigger: options.trigger || 'queued',
    looks: lookKeys,
    results,
    reference_frames: referenceFrames,
    camera_profiles: cameraProfiles,
  };
}

function shouldBootCalibrate({ uptimeS, thresholdS = DEFAULT_BOOT_UPTIME_S, done = false } = {}) {
  const uptime = Number(uptimeS);
  const threshold = Number(thresholdS);
  return !done && Number.isFinite(uptime) && uptime >= 0 && Number.isFinite(threshold) && uptime < threshold;
}

function scheduleDecision({ now, upcoming, done, leadMin = DEFAULT_ROOM_CHECK_LEAD_MIN } = {}) {
  if (!upcoming || !upcoming.id || !upcoming.starts_at || !upcoming.access_from) return { action: 'none' };
  if (done && typeof done.has === 'function' && done.has(upcoming.id)) return { action: 'done', booking_id: upcoming.id };
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  const startsMs = new Date(upcoming.starts_at).getTime();
  const accessFromMs = new Date(upcoming.access_from).getTime();
  const accessUntilMs = upcoming.access_until ? new Date(upcoming.access_until).getTime() : Infinity;
  if ([nowMs, startsMs, accessFromMs].some((value) => Number.isNaN(value))) return { action: 'none' };
  if (nowMs >= accessFromMs && nowMs < accessUntilMs) return { action: 'skip_inside_access', booking_id: upcoming.id };
  if (nowMs >= accessUntilMs) return { action: 'expired', booking_id: upcoming.id };
  if (nowMs >= startsMs - Number(leadMin) * 60 * 1000 && nowMs < accessFromMs) {
    return { action: 'run', booking_id: upcoming.id };
  }
  return { action: 'wait', booking_id: upcoming.id };
}

function updateCameraHealth(previous, status, now) {
  const at = now instanceof Date ? now.toISOString() : new Date(now || Date.now()).toISOString();
  const prior = previous && typeof previous === 'object' ? previous : null;
  if (status === 'ok') {
    const recovered = !!(prior && prior.status !== 'ok' && Number(prior.failures) >= 2);
    return {
      health: { status: 'ok', since: prior && prior.status === 'ok' ? prior.since : at, failures: 0 },
      recovered,
    };
  }
  const continuing = prior && prior.status !== 'ok';
  return {
    health: {
      status: String(status || 'error'),
      since: continuing ? prior.since : at,
      failures: continuing ? Number(prior.failures || 0) + 1 : 1,
    },
    recovered: false,
  };
}

module.exports = {
  DEFAULT_BOOT_UPTIME_S,
  DEFAULT_RECALL_SETTLE_MS,
  DEFAULT_RESET_SETTLE_MS,
  DEFAULT_ROOM_CHECK_LEAD_MIN,
  DEFAULT_SSIM_MIN,
  calibrate,
  captureReference,
  compareFrames,
  roomCheck,
  scheduleDecision,
  shouldBootCalibrate,
  updateCameraHealth,
};
