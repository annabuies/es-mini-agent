'use strict';

const { installConsoleTimestamps } = require('./log-timestamps');
installConsoleTimestamps({ teeWarnings: true }); // warnings reach agent.log too (#10)

// EVRYBDY Studios FLEET — Mini-side agent.
// Proves the app -> Cloudflare Worker (api.evrybdystudios.com) -> Mini connection is real.
// Optional OBS Source Record control; in-memory demo mode remains the fallback.

const http = require('http');
const fs = require('fs');
const { ObsClient, callVendor, getNewestFileSample, getSourceScreenshot, sampleFeedsWriting } = require('./obs-control');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { createUploadQueue, resolveFfmpegBin, resolveFfprobeBin } = require('./upload-queue');
const { runMultipartUploadTest, signS3Request } = require('./storage-upload');
const { createCredentialsProvider } = require('./aws-creds');
const { runSelfUpdate, getVersionBlock } = require('./self-update');
const { fetchDocs } = require('./fetch-docs');
const { runAudioEvo } = require('./evo-audio');
const { executeLook, normalizeCameras, normalizeLooks } = require('./ptz');
const { probeCameras } = require('./cam-reach');
const { createAutoStop } = require('./auto-stop');
const { readGolden, restoreCameras, snapshotCameras, writeGolden } = require('./cam-settings');
const { sampleDiskUsage } = require('./disk-usage');
const { describePower, readPowerConfig, runPower } = require('./power');
const { createRtspCapture, isRtspCamera, killOrphanedCaptures, rtspUrlForCamera } = require('./rtsp-capture');
const { checkTake } = require('./take-health');
const { createAudioMonitor, unknownAudio } = require('./audio-check');
const { describeAudioHealth, startMasterAudioAnalysis } = require('./audio-health');
const { offsetFromTiming } = require('./watch-rendition');
const { compactAudio, createHeartbeatSlot, heartbeatStateJson } = require('./heartbeat-state');

// Bumped by hand per release. This is the fastest way to tell what a remote
// machine is actually running -- it comes back in `diag` even when OBS is
// unreachable and even on a machine that has never self-updated.
const AGENT_VERSION = '2026.11.09-1';
// Where self-update pulls new code from. Overridable for testing; the default is
// the public repo, fetched with no credentials on purpose (see modules.txt).
const REPO_RAW_BASE = process.env.REPO_RAW_BASE || 'https://raw.githubusercontent.com/annabuies/es-mini-agent/main';

const PORT = parseInt(process.env.PORT || '8787', 10);
const RECORD_CONTROL_KEY = process.env.RECORD_CONTROL_KEY;
const BUILDING_ID = process.env.BUILDING_ID;
const PTZ_HTTP_USER = process.env.PTZ_HTTP_USER || '';
const PTZ_HTTP_PASS = process.env.PTZ_HTTP_PASS || '';
const PTZ_CREDENTIALS = PTZ_HTTP_USER ? { username: PTZ_HTTP_USER, password: PTZ_HTTP_PASS } : null;
// Studio power strip (POWER_STRIP_URL/USER/PASS, POWER_OUTLETS_SWITCHABLE).
// Unset URL => the power op answers power_unconfigured.
const POWER_CONFIG = readPowerConfig(process.env);
// Optional: outbound poll target. Defaults to the Cloudflare Worker so
// Robbie's existing install command (which only sets BUILDING_ID and
// RECORD_CONTROL_KEY) keeps polling api.evrybdystudios.com after this update.
const RECORD_POLL_URL = process.env.RECORD_POLL_URL || 'https://api.evrybdystudios.com';
// Every kiosk tap (Record, Stop, Pause...) waits for the next command poll, so the
// poll interval is added straight onto how long a tap takes to react (testers saw
// Record/Stop take 3-5 s before 2026.10.03-1). Fast while the room is in use: a take
// is running, or a command came in during the last 2 minutes (the kiosk sends
// preview_start every 25 s while it shows the studio). Otherwise the old 1 s, so an
// idle studio costs the Worker and Supabase no more than before. Each poll is one
// Worker GET plus one Supabase select; the Worker only rate-limits POSTs.
const POLL_INTERVAL_MS = Math.max(100, Number(process.env.POLL_INTERVAL_MS) || 250);
const POLL_IDLE_INTERVAL_MS = Math.max(POLL_INTERVAL_MS, Number(process.env.POLL_IDLE_INTERVAL_MS) || 1000);
const POLL_ACTIVE_WINDOW_MS = 2 * 60 * 1000;
// A failing relay (Worker or Supabase down) is retried after 1 s, then every 2 s,
// never at the fast interval. That also keeps poll errors in agent.log to at most
// one line a second, as before.
const POLL_ERROR_BACKOFF_MS = [1000, 2000];
// Stop and cancel check that OBS has finished writing over this interval (up to 4
// times). Overridable so tests can tell a skipped wait from a short one.
const STOP_SETTLE_MS = Math.max(0, Number(process.env.STOP_SETTLE_MS) || 900);
const SOURCES_REFRESH_MS = 60000;
const CAM_REACH_MS = 60000;
const DISK_USAGE_MS = 5 * 60 * 1000;
// Power strip health: one read-only GET of the relay states, only when POWER_STRIP_URL is set.
const POWER_CHECK_MS = 5 * 60 * 1000;
const PREVIEW_INTERVAL_MS = 500;
// A viewer's lease lasts this long past its last preview_start (the app sends one every
// 25 s). Overridable (floor 500 ms) so tests can watch a lease lapse.
const PREVIEW_TTL_MS = Math.max(500, Number(process.env.PREVIEW_TTL_MS) || 60000);
// The preview watchdog: every tick it drops lapsed leases, stops a stream nobody holds a
// lease for, and re-publishes an output that died while a viewer is still watching.
const PREVIEW_SWEEP_MS = Math.max(50, Number(process.env.PREVIEW_SWEEP_MS) || 5000);
// At most one automatic re-publish per this long, and three failures in a row end the
// attempts (the next keepalive starts the preview from scratch).
const PREVIEW_RESTART_MIN_MS = Number.isFinite(Number(process.env.PREVIEW_RESTART_MIN_MS)) && process.env.PREVIEW_RESTART_MIN_MS !== ''
  ? Math.max(0, Number(process.env.PREVIEW_RESTART_MIN_MS)) : 10000;
const PREVIEW_RESTART_MAX_FAILURES = 3;
const PREVIEW_WIDTH = 640;
const PREVIEW_JPEG_QUALITY = 60;
// S5 L0 (ships dark): the room's local preview relay (MediaMTX) control API. Only
// used when the Worker sends `local` with preview_start (LOCAL_PREVIEW_ROOMS).
const PREVIEW_RELAY_API = (process.env.PREVIEW_RELAY_API || 'http://127.0.0.1:9997').replace(/\/$/, '');
const PREVIEW_RELAY_TIMEOUT_MS = 2000;
const PREVIEW_RELAY_START_CHECK_MS = Number(process.env.PREVIEW_RELAY_START_CHECK_MS || 3000);
// bench-1 field tests 2026-11-09 (x2): OBS's output goes active ~1-2 s before its WHIP
// session reaches the relay, the kiosk asked in that gap, got "no stream is available"
// and fell back to cloud for 10 minutes. So the room path is only reported once the
// relay itself says the room's stream is available. The Worker waits 6.5 s for this op,
// so this budget counts from the publish request (OBS going active is inside it).
const PREVIEW_RELAY_READY_MS = Number(process.env.PREVIEW_RELAY_READY_MS || 3500);
const PREVIEW_RELAY_PROBE_TIMEOUT_MS = 1000;
const OBS_WS_URL = process.env.OBS_WS_URL || 'ws://127.0.0.1:4455';
const OBS_WS_PASSWORD = process.env.OBS_WS_PASSWORD || '';
const OBS_SOURCES_RAW = process.env.OBS_SOURCES || '';
let activeSources = OBS_SOURCES_RAW.split(',').map((v) => v.trim()).filter(Boolean);
const OBS_RECORD_DIR = process.env.OBS_RECORD_DIR || '';
const OBS_ENABLED = !!(OBS_SOURCES_RAW && OBS_SOURCES_RAW.trim());
const OBS_MODE_ACTIVE = OBS_ENABLED && activeSources.length > 0;
const MASTER_SOURCE = 'master';
// Master recording is on by default for a real OBS installation. Setting this
// to 0 is an immediate rollback to the camera-only behavior.
const MASTER_RECORD = OBS_MODE_ACTIVE && process.env.MASTER_RECORD !== '0';
// Audio split is an additive master post-processing step. It defaults on only
// when the master itself is enabled, and can be rolled back independently.
const AUDIO_SPLIT = MASTER_RECORD && process.env.AUDIO_SPLIT !== '0';
const STORAGE_ACCESS_KEY_ID = process.env.S3_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY_ID || '';
const STORAGE_SECRET_ACCESS_KEY = process.env.S3_SECRET_ACCESS_KEY || process.env.R2_SECRET_ACCESS_KEY || '';
const STORAGE_BUCKET = process.env.S3_BUCKET || process.env.R2_BUCKET || '';
const STORAGE_ENDPOINT = process.env.S3_ENDPOINT || process.env.R2_ENDPOINT || '';
const EXPLICIT_STORAGE_REGION = process.env.S3_REGION || '';
const AWS_ROLE_ARN = process.env.AWS_ROLE_ARN || '';
const STORAGE_REGION = resolveRegion(EXPLICIT_STORAGE_REGION, STORAGE_ENDPOINT);
// Boot-time default. A remote value from the relay can override this at runtime
// (see applyWebhookUrl / refreshSources) so rotating the secret never needs a
// visit to the studio Mac. Remote can only ever REPLACE it, never blank it.
let activeWebhookUrl = process.env.UPLOAD_CONFIRMED_WEBHOOK_URL || '';
const R2_PART_SIZE_BYTES = 25 * 1024 * 1024;
const R2_DEFAULT_TEST_SIZE_BYTES = 300 * 1024 * 1024;
const R2_TEST_TMP_DIR = path.join(__dirname, '.r2-test-tmp');
const UPLOAD_STATE_DIR = process.env.UPLOAD_STATE_DIR || path.join(__dirname, '.r2-uploads');
// RTSP stream-copy capture for any camera whose relay config (studios.fleet_buildings
// .cameras) says "capture": "rtsp"; the others keep Source Record. Switching a camera
// is a data change, no install. RTSP_CAPTURE=0 in the plist turns it off on this Mini.
const RTSP_CAPTURE_ENABLED = process.env.RTSP_CAPTURE !== '0';
// Camera + master originals are deleted from the Mini once their upload is verified
// in S3 (Robbie, Sep 29: ~43 GB per recorded hour, 103 GB free). DELETE_AFTER_UPLOAD=0
// in the LaunchAgent keeps them.
const DELETE_AFTER_UPLOAD = process.env.DELETE_AFTER_UPLOAD !== '0';
// Mic check (Build 42, A1): warn only, never refuses a take. AUDIO_CHECK=0 turns
// it off. Idle checks every AUDIO_CHECK_MS, plus on preview_start (kiosk showing
// the studio) when the last one is older than AUDIO_PREVIEW_MIN_MS.
const AUDIO_CHECK_ENABLED = process.env.AUDIO_CHECK !== '0';
const AUDIO_CHECK_MS = Math.max(5000, Number(process.env.AUDIO_CHECK_MS) || 60000);
const AUDIO_PREVIEW_MIN_MS = 20000;
const AUDIO_METER_WINDOW_MS = Math.max(200, Number(process.env.AUDIO_METER_WINDOW_MS) || 1500);
const AUDIO_TAKE_EVAL_MS = Math.max(500, Number(process.env.AUDIO_TAKE_EVAL_MS) || 10000);
// Post-take audio health (A3): stop waits at most this long for the file check of
// the master's mic tracks; a longer take gets it in last_take and on its webhooks.
const AUDIO_HEALTH_WAIT_MS = Math.max(0, Number.isFinite(Number(process.env.AUDIO_HEALTH_WAIT_MS)) && process.env.AUDIO_HEALTH_WAIT_MS !== '' ? Number(process.env.AUDIO_HEALTH_WAIT_MS) : 3000);
// A constant correction (ms) added to every camera's logged offset_s, for a bias
// measured on site with a clap (camera encode/network latency). Default 0.
const WATCH_AV_ADJUST_MS = Number(process.env.WATCH_AV_ADJUST_MS) || 0;
const rtspCapture = createRtspCapture({ ffmpegBin: () => resolveFfmpegBin().bin });
const audioMonitor = OBS_MODE_ACTIVE && AUDIO_CHECK_ENABLED
  ? createAudioMonitor({ url: OBS_WS_URL, password: OBS_WS_PASSWORD, windowMs: AUDIO_METER_WINDOW_MS, takeEvalMs: AUDIO_TAKE_EVAL_MS })
  : null;
// The last take's post-stop audio file check, while it may still be running.
let audioAnalysis = null;
process.once('exit', () => rtspCapture.killAll());
if (killOrphanedCaptures(OBS_RECORD_DIR)) {
  console.warn('[es-mini-agent] [rtsp] ended ffmpeg captures left running by the previous agent; their parts stay in the camera folders');
}
// Node >=22 is required (global WebSocket client is stable as of Node 22.4.0).

if (!RECORD_CONTROL_KEY) {
  console.error('[es-mini-agent] FATAL: RECORD_CONTROL_KEY env var is required. Refusing to start.');
  process.exit(1);
}
if (!BUILDING_ID) {
  console.error('[es-mini-agent] FATAL: BUILDING_ID env var is required (e.g. "bench-1"). Refusing to start.');
  process.exit(1);
}

const START_TIME = Date.now();
const state = {
  recording: false,
  paused: false,
  recordingStartedAt: null,
  sources: null,
  masterActive: false,
  rtspSources: [],
  // Per camera for the current take: how it is recorded and whether RTSP fell back.
  capture: {},
  takeStartedAt: null,
  lastTake: null,
  sessionRef: null,
  clientCode: null,
  cameras: [],
  looks: {},
  default_look: null,
  // This take's capture timing (wall-clock ms): master StartRecord and each camera's start.
  timing: null,
};
const r2Tests = new Map();
let obsClient = null;
let feedsPrevSamples = new Map();
let previewUntil = 0;
let previewTimer = null;
let previewBusy = false;
let previewLastOkAt = 0;
let lastPreviewWarnAt = 0;
let cloudflarePreviewOwnsStream = false;
let cloudflarePreviewTimer = null;
let cloudflarePreviewInputUid = null;
let cloudflarePreviewPlaybackUrl = null;
let cloudflarePreviewCameraIndex = 0;
let cloudflarePreviewOverlay = null;
let cloudflarePreviewRelayPath = null; // set while OBS publishes through the local relay
// What the running output publishes to, kept IN MEMORY ONLY (the publish URL embeds a
// secret and is never logged), so a dropped output can be re-published to the same
// Cloudflare input without waiting for the Worker to hand out another one.
let cloudflarePreviewPublish = null; // { inputUid, publishUrl, relay, localOffered }
let cloudflarePreviewStartedAt = 0;
let previewRestartAttemptAt = 0;
let previewRestartFailures = 0;
let startInFlight = null;
let pendingSources = null;

function log(method, path, status, note, refused) {
  // A 200 whose body says ok:false (refusal, busy, unconfigured) is logged as
  // `refused` so the log never reads "ok" for something that did not happen.
  const tag = status >= 400 ? 'fail' : (refused ? 'refused' : 'ok');
  const suffix = note ? ' ' + note : '';
  console.log(`${method} ${path} -> ${status} ${tag}${suffix}`);
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

function truncateDetail(value) {
  const s = typeof value === 'string' ? value : String(value || '');
  return s.length > 200 ? s.slice(0, 200) : s;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function endpointHostnameOnly(endpoint) {
  const raw = String(endpoint || '').trim();
  if (!raw) return '';
  const normalized = /^https?:\/\//i.test(raw) ? raw : ('https://' + raw);
  try {
    return new URL(normalized).hostname || '';
  } catch (_) {
    return '';
  }
}

function resolveRegion(explicitRegion, endpoint) {
  const explicit = String(explicitRegion || '').trim();
  if (explicit) return explicit;
  const host = endpointHostnameOnly(endpoint).toLowerCase();
  if (host.endsWith('amazonaws.com')) return 'us-east-1';
  return 'auto';
}

function isStorageConfigured() {
  return !!(STORAGE_ACCESS_KEY_ID && STORAGE_SECRET_ACCESS_KEY && STORAGE_BUCKET && STORAGE_ENDPOINT);
}

const storageCredentialsProvider = createCredentialsProvider({
  accessKeyId: STORAGE_ACCESS_KEY_ID,
  secretAccessKey: STORAGE_SECRET_ACCESS_KEY,
  roleArn: AWS_ROLE_ARN,
  region: STORAGE_REGION,
  sessionName: 'es-mini-agent-' + BUILDING_ID,
});

const storageR2Config = {
  accessKeyId: STORAGE_ACCESS_KEY_ID,
  secretAccessKey: STORAGE_SECRET_ACCESS_KEY,
  bucket: STORAGE_BUCKET,
  endpoint: STORAGE_ENDPOINT,
  region: STORAGE_REGION,
  getCredentials: () => storageCredentialsProvider.getCredentials(),
};

const uploadQueue = isStorageConfigured()
  ? createUploadQueue({
    r2Config: storageR2Config,
    stateDir: UPLOAD_STATE_DIR,
    isRecording: () => state.recording,
    webhookUrl: () => activeWebhookUrl,
    buildingId: BUILDING_ID,
    audioSplit: AUDIO_SPLIT,
    deleteAfterUpload: DELETE_AFTER_UPLOAD,
  })
  : null;

function parseSizeBytesOrDefault(value) {
  if (value == null || value === '') return R2_DEFAULT_TEST_SIZE_BYTES;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

function sanitizeForFileName(value) {
  return String(value || '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+/, '')
    .slice(0, 180) || 'r2_test_upload';
}

function stateFilePathForKey(key) {
  return path.join(R2_TEST_TMP_DIR, sanitizeForFileName(key) + '.state.json');
}

function publicR2TestState(entry) {
  if (!entry) return null;
  return {
    status: entry.status,
    partsCompleted: entry.partsCompleted,
    totalParts: entry.totalParts,
    bytesUploaded: entry.bytesUploaded,
    sizeBytes: entry.sizeBytes,
    startedAt: entry.startedAt,
    finishedAt: entry.finishedAt,
    error: entry.error,
    key: entry.key,
    pausedForRecordingMs: entry.pausedForRecordingMs,
    elapsedMs: entry.elapsedMs,
  };
}

async function getObsClient() {
  if (!obsClient) {
    obsClient = new ObsClient({
      url: OBS_WS_URL,
      password: OBS_WS_PASSWORD,
    });
  }
  await obsClient.ensureConnected();
  return obsClient;
}

function previewActive() {
  return !!((previewTimer || cloudflarePreviewOwnsStream) && Date.now() <= previewUntil);
}

// S5 (Robbie 10-31, black kiosk preview): one OBS stream serves every viewer (kiosk,
// phones, desktop), and any viewer's preview_stop used to stop it for all of them.
// Each viewer now holds a lease (the Worker derives its id from the signed-in
// principal); the stream stops when the last lease is released or expires. A command
// with no viewer id (an older Worker) is one shared lease: the old behaviour.
const PREVIEW_SHARED_VIEWER = 'shared';
const previewLeases = new Map();
function previewViewerId(body) {
  const viewer = body && typeof body.viewer === 'string' ? body.viewer : '';
  return /^[0-9a-f]{16}$/.test(viewer) ? viewer : PREVIEW_SHARED_VIEWER;
}
function refreshPreviewUntil(now = Date.now()) {
  let until = 0;
  for (const [viewer, expires] of previewLeases) {
    if (expires <= now) {
      previewLeases.delete(viewer);
      previewLog('lease_expired', { viewer, viewers: previewLeases.size });
    } else if (expires > until) until = expires;
  }
  previewUntil = until;
  return until;
}

// Structured preview log (Nov 5): one line per lifecycle event, key=value, so the field
// comparison can count blackouts and measure recovery from agent.log. Only short scalar
// values: anything that looks like a URL or a token is dropped, never printed.
function previewLog(event, fields) {
  const parts = ['[es-mini-agent] [preview] ev=' + event];
  for (const [key, value] of Object.entries(fields || {})) {
    if (value === undefined || value === null || value === '') continue;
    const text = String(value).replace(/\s+/g, '_').slice(0, 60);
    if (/:\/\/|pv1\.|token|bearer/i.test(text)) continue;
    parts.push(key + '=' + text);
  }
  console.log(parts.join(' '));
}

/** The angle in the shared preview stream (1-3), or null with no overlay active. Contract C1. */
function previewCameraNumber() {
  if (!cloudflarePreviewOverlay) return null;
  const camera = cloudflarePreviewCameraIndex + 1;
  return camera >= 1 && camera <= 3 ? camera : null;
}

/** 'local' (OBS publishes through the room relay), 'cloudflare' (straight to Cloudflare) or null. */
function previewRoute() {
  if (!cloudflarePreviewOwnsStream) return null;
  return cloudflarePreviewRelayPath ? 'local' : 'cloudflare';
}

// One preview operation at a time on the shared OBS stream: the poll loop's start/stop/
// camera ops and the watchdog timer must not interleave their OBS requests.
let previewLockTail = Promise.resolve();
function withPreviewLock(fn) {
  const run = previewLockTail.then(fn, fn);
  previewLockTail = run.then(() => {}, () => {});
  return run;
}

function maybeWarnPreview(detail) {
  const now = Date.now();
  if (now - lastPreviewWarnAt < 30000) return;
  lastPreviewWarnAt = now;
  console.warn('[es-mini-agent] [preview] WARN:', truncateDetail(detail));
}

async function pushPreviewFrames() {
  if (previewBusy) return;

  if (Date.now() > previewUntil) {
    if (previewTimer) {
      clearInterval(previewTimer);
      previewTimer = null;
      console.log('[es-mini-agent] [preview] stopped (ttl)');
      previewLog('jpeg_stop', { reason: 'ttl_expired' });
    }
    return;
  }

  previewBusy = true;
  try {
    let client;
    try {
      client = await getObsClient();
    } catch (e) {
      maybeWarnPreview('obs preview connect failed: ' + (e && (e.message || e)));
      return;
    }

    for (const source of activeSources) {
      if (Date.now() > previewUntil) break;
      const frame = await getSourceScreenshot(client, source, PREVIEW_WIDTH, PREVIEW_JPEG_QUALITY);
      if (!frame) {
        maybeWarnPreview('obs preview screenshot unavailable source=' + source);
        continue;
      }

      try {
        const key = `preview/${BUILDING_ID}/${source}.jpg`;
        const creds = await storageCredentialsProvider.getCredentials();
        const signed = signS3Request({
          method: 'PUT',
          key,
          query: {},
          accessKeyId: creds.accessKeyId,
          secretAccessKey: creds.secretAccessKey,
          sessionToken: creds.sessionToken,
          bucket: STORAGE_BUCKET,
          endpoint: STORAGE_ENDPOINT,
          region: STORAGE_REGION,
        });
        const putRes = await fetch(signed.url, {
          method: 'PUT',
          headers: Object.assign({}, signed.headers, {
            'content-type': 'image/jpeg',
          }),
          body: frame,
        });
        if (!putRes.ok) {
          maybeWarnPreview('preview put failed source=' + source + ' status=' + putRes.status);
          continue;
        }
        previewLastOkAt = Date.now();
      } catch (e) {
        maybeWarnPreview('preview upload failed source=' + source + ': ' + (e && (e.message || e)));
      }
    }

    if (Date.now() > previewUntil && previewTimer) {
      clearInterval(previewTimer);
      previewTimer = null;
      console.log('[es-mini-agent] [preview] stopped (ttl)');
      previewLog('jpeg_stop', { reason: 'ttl_expired' });
    }
  } catch (e) {
    maybeWarnPreview('preview tick failed: ' + (e && (e.message || e)));
  } finally {
    previewBusy = false;
  }
}

function obsRequestSucceeded(response) {
  return !!(response && response.requestStatus && response.requestStatus.result === true);
}

function obsResponseData(response) {
  return (response && response.responseData && typeof response.responseData === 'object')
    ? response.responseData
    : {};
}

function cameraIndexForPreviewOp(op) {
  const match = typeof op === 'string' ? op.match(/^preview_cam([1-3])$/) : null;
  return match ? Number(match[1]) - 1 : null;
}

async function removeCloudflarePreviewOverlay(client) {
  const overlay = cloudflarePreviewOverlay;
  cloudflarePreviewOverlay = null;
  if (!overlay) return;

  if (Number.isInteger(overlay.programSceneItemId)) {
    try {
      const removedItem = await client.request('RemoveSceneItem', {
        sceneName: overlay.programSceneName,
        sceneItemId: overlay.programSceneItemId,
      });
      if (!obsRequestSucceeded(removedItem)) {
        maybeWarnPreview('OBS rejected preview overlay scene-item removal');
      }
    } catch (e) {
      maybeWarnPreview('preview overlay item cleanup failed: ' + (e && (e.message || e)));
    }
  }

  try {
    const removedScene = await client.request('RemoveScene', { sceneName: overlay.sceneName });
    if (!obsRequestSucceeded(removedScene)) {
      maybeWarnPreview('OBS rejected preview overlay scene removal');
    }
  } catch (e) {
    maybeWarnPreview('preview overlay scene cleanup failed: ' + (e && (e.message || e)));
  }
}

async function createCloudflarePreviewOverlay(client) {
  if (cloudflarePreviewOverlay) return cloudflarePreviewOverlay;
  if (activeSources.length < 1) throw new Error('no_preview_cameras');

  const currentRes = await client.request('GetCurrentProgramScene');
  if (!obsRequestSucceeded(currentRes)) throw new Error('obs_program_scene_rejected');
  const programSceneName = obsResponseData(currentRes).currentProgramSceneName;
  if (!programSceneName) throw new Error('obs_program_scene_missing');

  const videoRes = await client.request('GetVideoSettings');
  if (!obsRequestSucceeded(videoRes)) throw new Error('obs_video_settings_rejected');
  const video = obsResponseData(videoRes);
  const width = Number(video.baseWidth) || 1920;
  const height = Number(video.baseHeight) || 1080;
  const sceneName = `__ES_CF_PREVIEW_${Date.now()}`;

  const createdScene = await client.request('CreateScene', { sceneName });
  if (!obsRequestSucceeded(createdScene)) throw new Error('obs_preview_scene_create_rejected');

  const cameraItems = [];
  let programSceneItemId = null;
  try {
    for (let i = 0; i < activeSources.length; i += 1) {
      const sourceName = activeSources[i];
      const itemRes = await client.request('CreateSceneItem', {
        sceneName,
        sourceName,
        sceneItemEnabled: i === cloudflarePreviewCameraIndex,
      });
      if (!obsRequestSucceeded(itemRes)) throw new Error('obs_preview_camera_add_rejected:' + sourceName);
      const sceneItemId = Number(obsResponseData(itemRes).sceneItemId);
      if (!Number.isInteger(sceneItemId)) throw new Error('obs_preview_camera_item_missing:' + sourceName);
      cameraItems.push({ sourceName, sceneItemId });

      const transformRes = await client.request('SetSceneItemTransform', {
        sceneName,
        sceneItemId,
        sceneItemTransform: {
          alignment: 5,
          positionX: 0,
          positionY: 0,
          boundsAlignment: 0,
          boundsType: 'OBS_BOUNDS_STRETCH',
          boundsWidth: width,
          boundsHeight: height,
        },
      });
      if (!obsRequestSucceeded(transformRes)) throw new Error('obs_preview_camera_transform_rejected:' + sourceName);
    }

    const overlayRes = await client.request('CreateSceneItem', {
      sceneName: programSceneName,
      sourceName: sceneName,
      sceneItemEnabled: true,
    });
    if (!obsRequestSucceeded(overlayRes)) throw new Error('obs_preview_overlay_add_rejected');
    programSceneItemId = Number(obsResponseData(overlayRes).sceneItemId);
    if (!Number.isInteger(programSceneItemId)) throw new Error('obs_preview_overlay_item_missing');

    cloudflarePreviewOverlay = { sceneName, programSceneName, programSceneItemId, cameraItems };
    console.log('[es-mini-agent] [preview] camera overlay ready source=' + activeSources[cloudflarePreviewCameraIndex]);
    return cloudflarePreviewOverlay;
  } catch (e) {
    // Remove the partial overlay before propagating the start failure. This does
    // not touch any of the studio's own scenes or Source Record filters.
    cloudflarePreviewOverlay = { sceneName, programSceneName, programSceneItemId, cameraItems };
    await removeCloudflarePreviewOverlay(client);
    throw e;
  }
}

async function removeStaleCloudflarePreviewScenes(client) {
  try {
    const listRes = await client.request('GetSceneList');
    if (!obsRequestSucceeded(listRes)) return;
    const scenes = obsResponseData(listRes).scenes;
    if (!Array.isArray(scenes)) return;
    for (const scene of scenes) {
      const sceneName = scene && scene.sceneName;
      if (typeof sceneName !== 'string' || !sceneName.startsWith('__ES_CF_PREVIEW_')) continue;
      try { await client.request('RemoveScene', { sceneName }); } catch (_) {}
    }
  } catch (_) { /* stale overlay cleanup is best-effort */ }
}

async function selectCloudflarePreviewCamera(index) {
  // Every answer carries `camera`: the angle actually in the stream (contract C1).
  if (!Number.isInteger(index) || index < 0 || index >= activeSources.length) {
    return { ok: false, reason: 'camera_unavailable', camera: previewCameraNumber() };
  }
  if (!cloudflarePreviewOwnsStream || !cloudflarePreviewOverlay) {
    return { ok: false, reason: 'preview_not_active', camera: previewCameraNumber() };
  }

  const startedAt = Date.now();
  const previous = previewCameraNumber();
  try {
    const client = await getObsClient();
    const overlay = cloudflarePreviewOverlay;
    for (let i = 0; i < overlay.cameraItems.length; i += 1) {
      const item = overlay.cameraItems[i];
      const enabled = i === index;
      const result = await client.request('SetSceneItemEnabled', {
        sceneName: overlay.sceneName,
        sceneItemId: item.sceneItemId,
        sceneItemEnabled: enabled,
      });
      if (!obsRequestSucceeded(result)) throw new Error('obs_preview_camera_toggle_rejected:' + item.sourceName);
    }
    cloudflarePreviewCameraIndex = index;
    console.log('[es-mini-agent] [preview] camera selected source=' + activeSources[index]);
    previewLog('camera', { from: previous, camera: index + 1, ms: Date.now() - startedAt, route: previewRoute() });
    return { ok: true, preview: true, source: activeSources[index], camera: index + 1 };
  } catch (e) {
    previewLog('camera_failed', { camera: previewCameraNumber(), wanted: index + 1, ms: Date.now() - startedAt });
    return { ok: false, reason: 'camera_switch_failed', detail: truncateDetail(e && (e.message || e)), camera: previewCameraNumber() };
  }
}

// Cam1 stopgap, agent side (Robbie 2026-09-26/27): with the live-preview overlay on
// Camera 1 at Start, cam1's Source Record writes a header-only file (~1.7 KB) while
// cam2/cam3 record fine; NDI keep-alive did not help. Starting with the overlay on
// another camera, then switching back, records cam1 normally (hardware-tested by hand).
// Doing it here covers every start path (phone, kiosk, and any client of this agent).
const CAM1_PARK_SETTLE_MS = Number(process.env.CAM1_PARK_SETTLE_MS || 500);
const CAM1_PARK_RESTORE_MS = Number(process.env.CAM1_PARK_RESTORE_MS || 1500);

function cam1PreviewIndex() {
  const i = activeSources.indexOf('cam1');
  return i >= 0 ? i : null;
}

/** Moves the preview overlay off Camera 1. Returns { restore, parkedTo }, or null if nothing moved. */
async function parkPreviewOffCam1() {
  const cam1 = cam1PreviewIndex();
  if (cam1 === null || !cloudflarePreviewOverlay || cloudflarePreviewCameraIndex !== cam1) return null;
  const other = activeSources.findIndex((_, i) => i !== cam1);
  if (other < 0) return null;
  const moved = await selectCloudflarePreviewCamera(other);
  if (!moved.ok) {
    console.warn('[es-mini-agent] [preview] cam1 park failed before start: ' + (moved.reason || 'unknown'));
    return null;
  }
  console.log('[es-mini-agent] [preview] cam1 park: preview moved to ' + activeSources[other] + ' for start');
  const overlay = cloudflarePreviewOverlay;
  await new Promise((resolve) => setTimeout(resolve, CAM1_PARK_SETTLE_MS));
  return { restore: cam1, parkedTo: other, overlay };
}

function restorePreviewAfterPark(parked, delayMs) {
  if (!parked) return;
  const index = parked.restore;
  const timer = setTimeout(() => {
    // Only undo our own move: if someone picked another camera or restarted the
    // preview since the park, leave their choice alone.
    if (cloudflarePreviewCameraIndex !== parked.parkedTo || cloudflarePreviewOverlay !== parked.overlay) return;
    selectCloudflarePreviewCamera(index)
      .then((r) => console.log('[es-mini-agent] [preview] cam1 park: preview restored to ' + activeSources[index] + (r && r.ok ? '' : ' (failed: ' + (r && r.reason) + ')')))
      .catch(() => {});
  }, delayMs);
  if (timer.unref) timer.unref();
}

function validCloudflareInputUid(value) {
  return typeof value === 'string' && /^[a-f0-9]{32}$/i.test(value);
}

function validCloudflareWebRtcUrl(value, suffix) {
  if (typeof value !== 'string' || !value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.hostname.endsWith('.cloudflarestream.com')
      && url.pathname.endsWith(suffix);
  } catch (_) {
    return false;
  }
}

async function requestCloudflareCleanup(inputUid) {
  if (!validCloudflareInputUid(inputUid)) return;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    const response = await fetch(`${RECORD_POLL_URL}/api/record`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + RECORD_CONTROL_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ stream_cleanup: true, input_uid: inputUid }),
      signal: ctrl.signal,
    });
    if (!response.ok) maybeWarnPreview('Cloudflare preview cleanup HTTP ' + response.status);
  } catch (e) {
    maybeWarnPreview('Cloudflare preview cleanup failed: ' + (e && (e.message || e)));
  } finally {
    clearTimeout(timer);
  }
}

// { whipUrl: https://<relay>/<room>/whip, publishToken } from the Worker, or null.
function validLocalRelay(local) {
  if (!local || typeof local.whipUrl !== 'string' || typeof local.publishToken !== 'string') return null;
  if (!/^pv1\.publish\./.test(local.publishToken) || local.publishToken.length > 256) return null;
  try {
    const url = new URL(local.whipUrl);
    const match = url.pathname.match(/^\/([A-Za-z0-9_-]{1,64})\/whip$/);
    if (url.protocol !== 'https:' || !match || url.search || url.username) return null;
    return { whipUrl: url.toString(), publishToken: local.publishToken, path: match[1] };
  } catch (_) {
    return null;
  }
}

// The Cloudflare WHIP URL as a MediaMTX forward target (whips:// = WHIP over HTTPS).
function relayForwardDest(publishUrl) {
  const url = new URL(publishUrl);
  return 'whips://' + url.hostname + ':' + (url.port || '443') + url.pathname;
}

// Sets (or clears) where the relay forwards the room's stream. Never logs the URL:
// the Cloudflare publish URL embeds its secret.
async function setRelayForward(path, dest) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PREVIEW_RELAY_TIMEOUT_MS);
  try {
    const response = await fetch(`${PREVIEW_RELAY_API}/v3/config/paths/patch/${encodeURIComponent(path)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ forward: dest ? [{ dest }] : [] }),
      signal: ctrl.signal,
    });
    if (!response.ok) throw new Error('relay_api_' + response.status);
  } finally {
    clearTimeout(timer);
  }
}

// True when the relay has the room's stream (a publisher is in and its tracks are up).
// MediaMTX v1.21.3 (the pinned relay): `available`; `ready` is its deprecated alias for
// the same thing (api/openapi.yaml). Re-check this if the pinned version changes.
// Any error = not yet.
async function relayStreamAvailable(path, timeoutMs = PREVIEW_RELAY_PROBE_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(50, Math.min(timeoutMs, PREVIEW_RELAY_PROBE_TIMEOUT_MS)));
  try {
    const response = await fetch(`${PREVIEW_RELAY_API}/v3/paths/get/${encodeURIComponent(path)}`, { signal: ctrl.signal });
    if (!response.ok) return false;
    const data = await response.json();
    return !!(data && (data.available === true || data.ready === true));
  } catch (_) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Never runs past its budget: each probe is capped to the time left.
async function waitForRelayStream(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) return false;
    if (await relayStreamAvailable(path, left)) return true;
    if (deadline - Date.now() <= 150) return false;
    await sleep(150);
  }
}

async function waitForStreamOutput(client, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await client.request('GetStreamStatus');
    if (obsRequestSucceeded(status) && status.responseData && status.responseData.outputActive) return true;
    if (Date.now() >= deadline) return false;
    await sleep(250);
  }
}

async function stopCloudflarePreview(reason) {
  if (cloudflarePreviewTimer) {
    clearInterval(cloudflarePreviewTimer);
    cloudflarePreviewTimer = null;
  }
  const inputUid = cloudflarePreviewInputUid;
  const owned = cloudflarePreviewOwnsStream;
  const stoppedFrom = { route: previewRoute(), camera: previewCameraNumber(), startedAt: cloudflarePreviewStartedAt };
  cloudflarePreviewOwnsStream = false;
  cloudflarePreviewInputUid = null;
  cloudflarePreviewPlaybackUrl = null;
  cloudflarePreviewPublish = null;
  cloudflarePreviewStartedAt = 0;
  previewRestartFailures = 0;
  if (owned) {
    let client = null;
    try {
      client = await getObsClient();
      const stopped = await client.request('StopStream');
      if (!obsRequestSucceeded(stopped)) {
        maybeWarnPreview('OBS rejected Cloudflare preview StopStream');
      } else {
        console.log('[es-mini-agent] [preview] Cloudflare WebRTC stream stopped');
      }
    } catch (e) {
      maybeWarnPreview('Cloudflare preview stop failed: ' + (e && (e.message || e)));
    }
    if (client) await removeCloudflarePreviewOverlay(client);
    if (cloudflarePreviewRelayPath) {
      const path = cloudflarePreviewRelayPath;
      cloudflarePreviewRelayPath = null;
      try { await setRelayForward(path, null); } catch (_) { maybeWarnPreview('preview relay forward clear failed'); }
    }
    const now = Date.now();
    previewLog('stream_stop', {
      reason: reason || 'unknown',
      route: stoppedFrom.route,
      camera: stoppedFrom.camera,
      viewers: previewLeases.size,
      up_ms: stoppedFrom.startedAt ? now - stoppedFrom.startedAt : null,
      stopped_at: new Date(now).toISOString(),
    });
  } else if (cloudflarePreviewOverlay) {
    try {
      const client = await getObsClient();
      await removeCloudflarePreviewOverlay(client);
    } catch (e) {
      maybeWarnPreview('preview overlay cleanup failed: ' + (e && (e.message || e)));
    }
  }
  if (inputUid) await requestCloudflareCleanup(inputUid);
  return inputUid;
}

// Publishes the preview output. With a local relay offered: through the room relay, and
// any relay failure falls back to publishing straight to Cloudflare. Returns which one.
async function publishPreviewOutput(client, publishUrl, relay, localOffered) {
  const publish = async (settings) => {
    const configured = await client.request('SetStreamServiceSettings', {
      streamServiceType: 'whip_custom',
      streamServiceSettings: settings,
    });
    if (!obsRequestSucceeded(configured)) throw new Error('obs_whip_config_rejected');
    const started = await client.request('StartStream');
    if (!obsRequestSucceeded(started)) throw new Error('obs_stream_start_rejected');
  };
  // S5 L0: with a local relay offered, OBS publishes to the relay and the relay
  // forwards the same stream to Cloudflare for phones. Any relay failure falls back
  // to publishing straight to Cloudflare (the path below, unchanged).
  let localRelay = false;
  let localError = null;
  let relayReady = false;
  if (relay) {
    try {
      await setRelayForward(relay.path, relayForwardDest(publishUrl));
      const publishedAt = Date.now();
      await publish({ server: relay.whipUrl, bearer_token: relay.publishToken });
      if (!(await waitForStreamOutput(client, PREVIEW_RELAY_START_CHECK_MS))) {
        try { await client.request('StopStream'); } catch (_) {}
        throw new Error('relay_publish_not_active');
      }
      localRelay = true;
      // OBS keeps publishing to the relay either way (phones get the forward). The room
      // path is offered to the kiosk only once the relay has the stream; until then the
      // kiosk stays on cloud and a later keepalive offers the room path.
      const readyBudget = Math.max(500, PREVIEW_RELAY_READY_MS - (Date.now() - publishedAt));
      relayReady = await waitForRelayStream(relay.path, readyBudget);
      if (!relayReady) localError = 'relay_not_ready';
    } catch (e) {
      localError = /^relay_publish|^obs_/.test(String(e && e.message)) ? 'relay_publish_failed' : 'relay_unreachable';
      maybeWarnPreview('preview relay unavailable (' + localError + '); publishing to Cloudflare directly');
      try { await setRelayForward(relay.path, null); } catch (_) {}
    }
  } else if (localOffered) {
    localError = 'relay_config_invalid';
  }
  if (!localRelay) {
    await publish({
      server: publishUrl,
      // Cloudflare authenticates with the secret embedded in the WHIP URL.
      // Clear any bearer left by a previous IVS configuration.
      bearer_token: '',
    });
  }
  return { localRelay, localError, relayReady };
}

// The overlay scene must still be in OBS (an OBS restart loses it); rebuild it if not.
async function ensurePreviewOverlay(client) {
  if (cloudflarePreviewOverlay) {
    const list = await client.request('GetSceneList');
    const scenes = obsRequestSucceeded(list) && Array.isArray(obsResponseData(list).scenes) ? obsResponseData(list).scenes : null;
    const present = !!(scenes && scenes.some((scene) => scene && scene.sceneName === cloudflarePreviewOverlay.sceneName));
    if (present) return cloudflarePreviewOverlay;
    cloudflarePreviewOverlay = null;
    await removeStaleCloudflarePreviewScenes(client);
  }
  return createCloudflarePreviewOverlay(client);
}

// The output stopped while a viewer still holds a lease (Cloudflare or the network
// dropped it). Publish to the SAME Cloudflare input again from the saved settings: the
// viewers' playback URL does not change and no new input is needed. Recording is not
// touched: this only talks to OBS's stream output and the preview overlay scene.
async function restorePreviewOutput(client, reason) {
  const saved = cloudflarePreviewPublish;
  if (!saved || !cloudflarePreviewOwnsStream) return false;
  const startedAt = Date.now();
  const lostAfterMs = cloudflarePreviewStartedAt ? startedAt - cloudflarePreviewStartedAt : null;
  previewLog('stream_lost', { reason, route: previewRoute(), camera: previewCameraNumber(), viewers: previewLeases.size, up_ms: lostAfterMs });
  try {
    await ensurePreviewOverlay(client);
    const published = await publishPreviewOutput(client, saved.publishUrl, saved.relay, saved.localOffered);
    cloudflarePreviewRelayPath = published.localRelay && saved.relay ? saved.relay.path : null;
    cloudflarePreviewStartedAt = Date.now();
    previewLog('stream_restart', {
      ok: true, reason, route: previewRoute(), camera: previewCameraNumber(), viewers: previewLeases.size,
      ms: Date.now() - startedAt, started_at: new Date(cloudflarePreviewStartedAt).toISOString(),
      local_error: published.localError,
    });
    return true;
  } catch (e) {
    previewLog('stream_restart', {
      ok: false, reason, route: previewRoute(), camera: previewCameraNumber(), viewers: previewLeases.size,
      ms: Date.now() - startedAt, error: /^[a-z_]+/.test(String(e && e.message)) ? String(e.message).match(/^[a-z_]+/)[0] : 'error',
      failures: previewRestartFailures,
    });
    return false;
  }
}

// Runs every PREVIEW_SWEEP_MS while this agent owns the stream. Drops lapsed leases,
// stops the stream when no lease is left, and re-publishes an output that died while a
// viewer is still watching (so recovery needs no viewer to reopen anything).
async function previewTick() {
  refreshPreviewUntil();
  if (Date.now() > previewUntil) {
    await withPreviewLock(async () => {
      // A keepalive may have renewed a lease while this waited for the lock.
      refreshPreviewUntil();
      if (Date.now() > previewUntil) await stopCloudflarePreview('ttl_expired');
    });
    return;
  }
  if (!cloudflarePreviewOwnsStream) return;
  await withPreviewLock(async () => {
    if (!cloudflarePreviewOwnsStream || Date.now() > previewUntil) return;
    let status;
    let client;
    try {
      client = await getObsClient();
      status = await client.request('GetStreamStatus');
    } catch (_) { return; } // OBS did not answer: not the same as the output being down
    if (!obsRequestSucceeded(status)) return;
    const data = obsResponseData(status);
    if (data.outputActive || data.outputReconnecting) {
      previewRestartFailures = 0; // a restart only counts as good once the output is seen up
      return;
    }
    if (previewRestartFailures >= PREVIEW_RESTART_MAX_FAILURES) {
      // Every re-publish came back down: give the input up. The next keepalive hands out a
      // fresh one and starts over.
      previewLog('stream_gave_up', { reason: 'restart_failed', viewers: previewLeases.size });
      await stopCloudflarePreview('restart_failed');
      return;
    }
    if (Date.now() - previewRestartAttemptAt < PREVIEW_RESTART_MIN_MS) return;
    previewRestartAttemptAt = Date.now();
    previewRestartFailures += 1;
    await restorePreviewOutput(client, 'watchdog');
  });
}

async function startCloudflarePreview(config, localConfig) {
  const inputUid = config && typeof config.inputUid === 'string' ? config.inputUid.trim() : '';
  const publishUrl = config && typeof config.publishUrl === 'string' ? config.publishUrl.trim() : '';
  const playbackUrl = config && typeof config.playbackUrl === 'string' ? config.playbackUrl.trim() : '';
  const reuse = !!(config && config.reuse === true);
  const validIdentity = validCloudflareInputUid(inputUid)
    && validCloudflareWebRtcUrl(playbackUrl, '/webRTC/play');

  if (cloudflarePreviewOwnsStream) {
    // Keepalives offer the room path only while the relay actually has the stream.
    const relayLive = cloudflarePreviewRelayPath ? await relayStreamAvailable(cloudflarePreviewRelayPath) : false;
    const keepCurrent = (extra) => Object.assign({
      stream: { inputUid: cloudflarePreviewInputUid, playbackUrl: cloudflarePreviewPlaybackUrl },
      // A keepalive can race with creation of a replacement input. Keep the
      // stream we own and ask the relay to delete the unused candidate.
      cleanupInputUid: validIdentity && inputUid !== cloudflarePreviewInputUid ? inputUid : null,
      localRelay: relayLive,
    }, extra || {});
    let client = null;
    let data = null;
    try {
      client = await getObsClient();
      const current = await client.request('GetStreamStatus');
      if (obsRequestSucceeded(current)) data = obsResponseData(current);
    } catch (_) { /* data stays null */ }
    if (!data) {
      // OBS did not answer. That is not "the output stopped": the old code cleared its
      // state here and deleted the live Cloudflare input while OBS kept publishing to it,
      // which orphaned the stream and cost a 7-8 s stale-output recovery on the next
      // keepalive. Keep what we own; the watchdog and the next keepalive check again.
      previewLog('status_unavailable', { route: previewRoute(), camera: previewCameraNumber() });
      return keepCurrent();
    }
    if (data.outputActive || data.outputReconnecting) {
      previewRestartFailures = 0;
      return keepCurrent();
    }
    // The output died while we still owned it. Re-publish to the same input first.
    if (client && await restorePreviewOutput(client, 'keepalive')) return keepCurrent({ restarted: true });
    const staleInputUid = cloudflarePreviewInputUid;
    cloudflarePreviewOwnsStream = false;
    cloudflarePreviewInputUid = null;
    cloudflarePreviewPlaybackUrl = null;
    cloudflarePreviewRelayPath = null;
    cloudflarePreviewPublish = null;
    cloudflarePreviewStartedAt = 0;
    previewRestartFailures = 0;
    if (staleInputUid) await requestCloudflareCleanup(staleInputUid);
  }
  const relay = validLocalRelay(localConfig);

  if (!validIdentity || reuse || !validCloudflareWebRtcUrl(publishUrl, '/webRTC/publish')) {
    // reuse: the Worker points at an input this agent no longer publishes to (it
    // restarted, or the stream was stopped) and cannot publish to it without the secret
    // publish URL. Say so; the next keepalive gets a fresh input.
    return { stream: null, cleanupInputUid: !reuse && validIdentity ? inputUid : null, reuseUnavailable: reuse && validIdentity };
  }

  let startReason = 'new_input';
  try {
    const client = await getObsClient();
    const status = await client.request('GetStreamStatus');
    if (!obsRequestSucceeded(status)) throw new Error('obs_stream_status_rejected');
    if (status.responseData && status.responseData.outputActive) {
      // A Mini self-update can restart the agent while OBS itself keeps the old
      // preview output alive. Reclaim only an unmistakable Cloudflare WHIP
      // service; never stop RTMP, IVS, or an operator-configured destination.
      const serviceRes = await client.request('GetStreamServiceSettings');
      const service = obsResponseData(serviceRes);
      const server = service.streamServiceSettings && service.streamServiceSettings.server;
      const staleCloudflareWhip = obsRequestSucceeded(serviceRes)
        && service.streamServiceType === 'whip_custom'
        && (validCloudflareWebRtcUrl(server, '/webRTC/publish') || !!(relay && server === relay.whipUrl));
      if (!staleCloudflareWhip) throw new Error('obs_stream_already_active');

      const stopped = await client.request('StopStream');
      if (!obsRequestSucceeded(stopped)) throw new Error('obs_stale_preview_stop_rejected');
      let stillActive = true;
      for (let i = 0; i < 20; i += 1) {
        await sleep(250);
        const next = await client.request('GetStreamStatus');
        stillActive = !!(obsRequestSucceeded(next) && next.responseData && next.responseData.outputActive);
        if (!stillActive) break;
      }
      if (stillActive) throw new Error('obs_stale_preview_stop_timeout');
      console.log('[es-mini-agent] [preview] recovered stale Cloudflare WebRTC output');
      startReason = 'stale_output_reclaimed';
    }

    await removeStaleCloudflarePreviewScenes(client);
    cloudflarePreviewCameraIndex = Math.min(cloudflarePreviewCameraIndex, activeSources.length - 1);
    await createCloudflarePreviewOverlay(client);

    const { localRelay, localError, relayReady } = await publishPreviewOutput(client, publishUrl, relay, !!localConfig);
    cloudflarePreviewOwnsStream = true;
    cloudflarePreviewInputUid = inputUid;
    cloudflarePreviewPlaybackUrl = playbackUrl;
    cloudflarePreviewRelayPath = localRelay ? relay.path : null;
    cloudflarePreviewPublish = { inputUid, publishUrl, relay, localOffered: !!localConfig };
    cloudflarePreviewStartedAt = Date.now();
    previewRestartFailures = 0;
    console.log('[es-mini-agent] [preview] Cloudflare WebRTC stream started' + (localRelay ? ' (through the room relay)' : ''));
    previewLog('stream_start', {
      reason: startReason, route: previewRoute(), camera: previewCameraNumber(), viewers: previewLeases.size,
      input: inputUid.slice(-6), started_at: new Date(cloudflarePreviewStartedAt).toISOString(), local_error: localError,
    });
    if (!cloudflarePreviewTimer) {
      cloudflarePreviewTimer = setInterval(() => { void previewTick().catch(() => {}); }, PREVIEW_SWEEP_MS);
    }
    return { stream: { inputUid, playbackUrl }, cleanupInputUid: null, localRelay: relayReady, localError };
  } catch (e) {
    const error = truncateDetail(e && (e.message || e));
    if (cloudflarePreviewOverlay) {
      try {
        const client = await getObsClient();
        await removeCloudflarePreviewOverlay(client);
      } catch (_) {}
    }
    if (relay) { try { await setRelayForward(relay.path, null); } catch (_) {} }
    maybeWarnPreview('Cloudflare preview start failed: ' + error);
    previewLog('stream_start_failed', { reason: startReason, error: /^[A-Za-z0-9_:.-]+/.test(error) ? error.match(/^[A-Za-z0-9_:.-]+/)[0] : 'error' });
    return { stream: null, cleanupInputUid: inputUid, error };
  }
}

function didSourceFileStabilize(beforeSamples, afterSamples, source) {
  const before = beforeSamples.get(source);
  const after = afterSamples.get(source);
  if (!before && !after) return true;
  if (!before || !after) return false;
  return before.size === after.size;
}

function getFileSample(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() ? { size: stat.size, mtimeMs: stat.mtimeMs } : null;
  } catch (_) {
    return null;
  }
}

function didFileStabilize(before, after) {
  return !!(before && after && before.size === after.size);
}

// After stop/cancel: waits until OBS has finished writing the take's Source Record
// files and master (same size across one STOP_SETTLE_MS interval, up to 4 tries).
// Resolves whether they settled. An RTSP camera is already finished here (its
// ffmpeg has exited and its parts are joined), so a take with no Source Record
// camera and no master has nothing to wait for; that used to add 0.9 s to every
// such stop.
async function waitForObsFiles(obsSources, masterWasActive, masterOutputPath) {
  if (!OBS_RECORD_DIR) {
    await sleep(1200);
    return false;
  }
  if (obsSources.length === 0 && !masterWasActive) {
    feedsPrevSamples = new Map();
    return true;
  }
  let filesStable = false;
  let prevSample = sampleFeedsWriting(obsSources, OBS_RECORD_DIR, new Map()).samples;
  let prevMasterSample = masterWasActive ? getFileSample(masterOutputPath) : null;
  for (let i = 0; i < 4; i += 1) {
    await sleep(STOP_SETTLE_MS);
    const newSample = sampleFeedsWriting(obsSources, OBS_RECORD_DIR, prevSample).samples;
    const newMasterSample = masterWasActive ? getFileSample(masterOutputPath) : null;
    const camerasStable = obsSources.every((source) => didSourceFileStabilize(prevSample, newSample, source));
    const masterStable = !masterWasActive || didFileStabilize(prevMasterSample, newMasterSample);
    prevSample = newSample;
    if (camerasStable && masterStable) {
      filesStable = true;
      break;
    }
    prevMasterSample = newMasterSample;
  }
  feedsPrevSamples = prevSample;
  return filesStable;
}

async function stopStartedSources(client, sources) {
  await Promise.all(sources.map(async (source) => {
    try {
      await callVendor(client, 'record_stop', source);
    } catch (_) {
      // The original master-start error is the useful caller-facing detail.
    }
  }));
}

function masterResponseError(response, fallback) {
  if (obsRequestSucceeded(response)) return null;
  const data = obsResponseData(response);
  const comment = response && response.requestStatus && response.requestStatus.comment;
  return String(comment || data.error || fallback || 'obs_request_rejected');
}

async function getMasterRecordStatus(client) {
  const response = await client.request('GetRecordStatus');
  const error = masterResponseError(response, 'get_record_status_failed');
  if (error) throw new Error(error);
  return obsResponseData(response);
}

async function getMasterActiveSafe() {
  if (!MASTER_RECORD) return false;
  try {
    const client = await getObsClient();
    return !!(await getMasterRecordStatus(client)).outputActive;
  } catch (e) {
    console.warn('[es-mini-agent] WARN: OBS master status failed:', e && (e.message || e));
    return false;
  }
}

function sameSources(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function applySources(next) {
  if (state.recording) {
    if (sameSources(next, activeSources)) {
      if (pendingSources) console.log('[es-mini-agent] deferred sources update cancelled (reverted to current list)');
      pendingSources = null;
      return;
    }
    if (pendingSources && sameSources(pendingSources, next)) return;
    pendingSources = next;
    console.log('[es-mini-agent] sources update deferred until current recording ends');
    return;
  }
  const previous = activeSources.slice();
  activeSources = next;
  pendingSources = null;
  console.log('[es-mini-agent] sources updated: ' + previous.join(',') + ' -> ' + activeSources.join(','));
}

function applyWebhookUrl(next) {
  if (next === activeWebhookUrl) return;
  activeWebhookUrl = next;
  console.log('[es-mini-agent] upload webhook updated (remote)');
}

function applyPtzConfig(data) {
  if (!data || typeof data !== 'object') return;

  if (Object.prototype.hasOwnProperty.call(data, 'cameras')) {
    const cameras = normalizeCameras(data.cameras);
    if (cameras === null) {
      console.warn('[es-mini-agent] relay: ignoring invalid cameras config');
    } else {
      state.cameras = cameras;
      refreshCameraReachability().catch((e) => {
        console.warn('[es-mini-agent] camera reachability refresh failed:', e && (e.message || e));
      });
    }
  }

  if (Object.prototype.hasOwnProperty.call(data, 'looks')) {
    const looks = normalizeLooks(data.looks);
    if (looks === null) {
      console.warn('[es-mini-agent] relay: ignoring invalid looks config');
    } else {
      state.looks = looks;
    }
  }

  if (Object.prototype.hasOwnProperty.call(data, 'default_look')) {
    if (data.default_look === null) {
      state.default_look = null;
    } else if (typeof data.default_look === 'string' && data.default_look.trim()) {
      state.default_look = data.default_look.trim();
    } else {
      console.warn('[es-mini-agent] relay: ignoring invalid default_look config');
    }
  }
}

function sessionSources() {
  return (state.recording && Array.isArray(state.sources) && state.sources.length) ? state.sources : activeSources;
}

/** The camera's RTSP URL when it should record over RTSP, else null (Source Record). */
function rtspUrlForSource(source) {
  if (!RTSP_CAPTURE_ENABLED) return null;
  const camera = (state.cameras || []).find((c) => c.name === source);
  return isRtspCamera(camera) ? rtspUrlForCamera(camera) : null;
}

function isRtspSession(source) {
  return Array.isArray(state.rtspSources) && state.rtspSources.includes(source);
}

/** Stops RTSP takes, naming each file after the master's so a take's files match. Never throws. */
async function stopRtspTakes(sources, masterOutputPath) {
  const finalBase = masterOutputPath ? path.basename(String(masterOutputPath), path.extname(String(masterOutputPath))) : null;
  return Promise.all(sources.map(async (source) => {
    try {
      return { source, rtsp: await rtspCapture.stop(source, { finalBase }) };
    } catch (e) {
      return { source, rtsp: { ok: false, reason: 'rtsp_stop_error', detail: e && (e.message || String(e)) } };
    }
  }));
}

function captureConfigured(source) {
  const camera = (state.cameras || []).find((c) => c.name === source);
  return RTSP_CAPTURE_ENABLED && isRtspCamera(camera) ? 'rtsp' : 'source_record';
}

function fallbackSources(capture) {
  return Object.keys(capture || {}).filter((source) => capture[source].fallback);
}

/** Per-camera capture block for start/status: { capture_mode, fallback, fallback_reason? }. */
function captureBlock(capture) {
  const out = {};
  for (const [source, c] of Object.entries(capture || {})) {
    out[source] = { capture_mode: c.capture_mode, fallback: !!c.fallback };
    if (c.fallback) out[source].fallback_reason = c.fallback_reason;
  }
  return out;
}

/** The newest mic verdict: the in-take alert while recording, else the last check. Null if none yet. */
function currentAudio() {
  if (!audioMonitor) return null;
  return audioMonitor.takeAlert() || audioMonitor.latest() || null;
}

/** A mic check on the kiosk's cadence: only when idle and the last one is old. Never awaited. */
function maybeAudioCheck(context, minAgeMs) {
  if (!audioMonitor || state.recording || startInFlight || audioMonitor.takeActive()) return;
  const last = audioMonitor.latest();
  const age = last && last.checked_at ? Date.now() - Date.parse(last.checked_at) : Infinity;
  if (age < minAgeMs) return;
  audioMonitor.check(context).catch(() => {});
}

/**
 * The take's timing block (stop result). Every offset_s is seconds to delay the
 * master's audio so it lines up with that camera's file (watch-rendition.js
 * explains the sign): master t=0 minus camera t=0, plus WATCH_AV_ADJUST_MS.
 */
function buildTiming(timing, rtspBySource, recordStarted) {
  if (!timing) return null;
  const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
  const eventMs = recordStarted && Number.isFinite(recordStarted.recordStartedAtMs) ? recordStarted.recordStartedAtMs : null;
  const masterMs = eventMs !== null ? eventMs : timing.obs_start_responded_ms;
  const out = {
    obs_start_at: iso(masterMs),
    obs_start_basis: eventMs !== null ? 'record_started_event' : (Number.isFinite(timing.obs_start_responded_ms) ? 'start_record_response' : null),
    obs_start_requested_at: iso(timing.obs_start_requested_ms),
    obs_start_responded_at: iso(timing.obs_start_responded_ms),
    cameras: {},
  };
  if (WATCH_AV_ADJUST_MS) out.adjust_ms = WATCH_AV_ADJUST_MS;
  for (const [source, cam] of Object.entries(timing.cameras || {})) {
    const rtsp = rtspBySource && rtspBySource.get(source);
    let firstMs = cam.started_ms;
    let basis = cam.basis;
    if (rtsp && Number.isFinite(rtsp.first_packet_ms)) {
      firstMs = rtsp.first_packet_ms;
      basis = rtsp.first_packet_basis === 'progress' ? 'rtsp_progress' : 'rtsp_first_video';
    }
    const entry = { first_packet_at: iso(firstMs), basis: basis || null, offset_s: Number.isFinite(masterMs) ? offsetFromTiming({ masterStartMs: masterMs, cameraStartMs: firstMs, adjustMs: WATCH_AV_ADJUST_MS }) : null };
    if (rtsp && Number.isFinite(rtsp.segments) && rtsp.segments > 1) {
      // Pauses and reconnects join segments without their gaps: the offset holds for the first one.
      entry.segments = rtsp.segments;
      entry.sync = 'first_segment';
    }
    out.cameras[source] = entry;
  }
  return out;
}

/** This take's Source Record file: the newest in the camera folder, written since the take began. */
function sourceRecordFile(source, takeStartedAt) {
  let newest = null;
  try {
    newest = getNewestFileSample(path.join(OBS_RECORD_DIR, source));
  } catch (_) {
    return null; // no camera folder: nothing written
  }
  // The stub Source Record leaves is finalized ~130 ms after its output opens, a
  // moment before the take's start is recorded; anything older is a previous take.
  if (!newest || !newest.absPath || newest.mtimeMs < takeStartedAt - 2000) return null;
  return newest.absPath;
}

function cameraSummary(source, capture, verdict, rtsp) {
  const c = capture[source] || { capture_mode: 'source_record', fallback: false };
  const bits = [verdict.health, c.capture_mode + (c.fallback ? '(FALLBACK ' + c.fallback_reason + ')' : '')];
  if (Number.isFinite(verdict.duration_s)) bits.push(verdict.duration_s + 's');
  if (verdict.short_by_s) bits.push('-' + verdict.short_by_s + 's');
  if (verdict.reason && verdict.health !== 'ok') bits.push(verdict.reason);
  if (rtsp && rtsp.restarts) bits.push('reconnects=' + rtsp.restarts);
  return source + ' ' + bits.join(' ');
}

// The `update` op. Defined once and called from BOTH the demo and the real block
// of handleOp -- the demo block returns early, so an op handled only in the real
// block is invisible on a demo machine, and a demo machine is exactly the kind we
// most need to be able to fix remotely. There is nothing OBS-specific about
// updating.
async function performUpdate() {
  const busyReason = () => {
    if (state.recording) return 'recording';
    // uploadQueue is null in demo mode / when storage is unconfigured.
    const q = uploadQueue ? uploadQueue.status() : null;
    if (q && (q.queued > 0 || q.active)) return 'uploading';
    return null;
  };

  const result = await runSelfUpdate({ projectDir: __dirname, repoRawBase: REPO_RAW_BASE, busyReason });

  if (result.ok && result.updated) {
    // Exit AFTER the reply has gone out. The delay gives the poll loop's result
    // POST (and the local HTTP response) time to complete before the process
    // dies; KeepAlive in the launchd plist is what brings it back up on the new
    // code. Nothing here rebuilds the plist, so every env var on the machine
    // survives the restart untouched.
    setTimeout(() => {
      console.log('[es-mini-agent] self-update: exiting so launchd restarts on the new code');
      process.exit(0);
    }, 2500);
  }

  return result;
}

function sessionValue(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^[A-Za-z0-9_-]{1,64}$/.test(trimmed) ? trimmed : null;
}

function activeSessionResponse() {
  return state.recording ? { session_ref: state.sessionRef, client_code: state.clientCode } : {};
}

function startSessionResponse() {
  return state.sessionRef === null ? {} : { session_ref: state.sessionRef };
}

// Build 46 booked-session auto-stop (auto-stop.js). Created at listen time.
let autoStop = null;

// Every op goes through here (relay poll and HTTP route alike):
//   - a Stop tagged auto_stop_for runs only on that exact take; anything else is refused
//     without touching the recording (never stop a later take);
//   - a successful Start arms the take's deadline, a Stop or Cancel clears it.
async function handleOp(op, body) {
  const ref = state.sessionRef;
  const tagged = op === 'stop' && body && typeof body.auto_stop_for === 'string' ? body.auto_stop_for : null;
  if (tagged !== null && (!(state.recording || state.paused) || ref !== tagged)) {
    console.warn(`[es-mini-agent] auto-stop: refused a Stop for ${tagged} (recording ${state.sessionRef || 'nothing'})`);
    return { ok: false, reason: 'stale_auto_stop', recording: !!(state.recording || state.paused) };
  }
  const result = await handleOpCore(op, body);
  if (autoStop && result && result.ok === true) {
    if (op === 'start') autoStop.arm(state.sessionRef, body && body.auto_stop_at);
    else if (op === 'stop' || op === 'cancel') autoStop.disarm(ref);
  }
  // Only when armed, so a status with no deadline is unchanged for older readers.
  const armed = autoStop && op === 'status' && result && result.ok === true ? autoStop.status() : null;
  if (armed) result.auto_stop = armed;
  if (tagged !== null && result) result.auto_stop_for = tagged;
  return result;
}

async function handleOpCore(op, body) {
  if (op === 'cam_snapshot') {
    if (!state.cameras.length) return { ok: false, reason: 'no_cameras' };
    if (!PTZ_CREDENTIALS) return { ok: false, reason: 'auth_required' };
    const only = Array.isArray(body && body.only) ? body.only : null;
    const cameras = only ? state.cameras.filter((camera) => only.includes(camera.name)) : state.cameras;
    const snapshot = await snapshotCameras(cameras, { credentials: PTZ_CREDENTIALS, timeoutMs: 15000 });
    const golden = writeGolden(__dirname, snapshot);
    return { ok: Object.values(snapshot.cameras).every((camera) => camera.ok), bytes: golden.bytes, ...snapshot };
  }
  if (op === 'cam_restore') {
    if (state.recording || state.paused) return { ok: false, reason: 'busy_recording' };
    if (!state.cameras.length) return { ok: false, reason: 'no_cameras' };
    if (!PTZ_CREDENTIALS) return { ok: false, reason: 'auth_required' };
    const golden = readGolden(__dirname);
    if (!golden) return { ok: false, reason: 'no_golden' };
    return await restoreCameras(state.cameras, golden, { credentials: PTZ_CREDENTIALS, timeoutMs: 60000,
      only: body && body.only, keys: body && body.keys });
  }
  if (op === 'look') {
    const queueStatus = uploadQueue ? uploadQueue.status() : null;
    const uploading = !!(queueStatus && (queueStatus.queued > 0 || queueStatus.active));
    return await executeLook({ ...state, uploading }, body && body.look, { timeoutMs: 3000, credentials: PTZ_CREDENTIALS });
  }
  if (op === 'power') {
    const queueStatus = uploadQueue ? uploadQueue.status() : null;
    const uploading = !!(queueStatus && (queueStatus.queued > 0 || queueStatus.active));
    return await runPower(POWER_CONFIG, body, { recording: state.recording || state.paused, uploading });
  }

  if (!OBS_MODE_ACTIVE) {
    if (op === 'start') {
      state.recording = true;
      state.paused = false;
      state.sessionRef = sessionValue(body && body.session_ref);
      state.clientCode = sessionValue(body && body.client_code);
      return Object.assign({ ok: true, recording: true, feeds_writing: null }, startSessionResponse());
    }
    if (op === 'stop') {
      state.recording = false;
      state.paused = false;
      state.sessionRef = null;
      state.clientCode = null;
      return { ok: true, saved: true };
    }
    if (op === 'cancel') {
      state.recording = false;
      state.paused = false;
      state.sessionRef = null;
      state.clientCode = null;
      return { ok: true, cancelled: true, saved: false };
    }
    if (op === 'status') {
      return Object.assign({ ok: true, recording: state.recording, feeds_writing: null, preview: false, preview_camera: null, master_active: false, master_enabled: false }, activeSessionResponse());
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
    if (op === 'preview_start' || op === 'preview_stop' || cameraIndexForPreviewOp(op) !== null) {
      return { ok: true, preview: false, camera: null };
    }
    if (op === 'diag') {
      return Object.assign({
        ok: true,
        demo: true,
        recording: state.recording,
        stats: null,
        filters: null,
        master_active: false,
        master_enabled: false,
        ptz_auth: PTZ_CREDENTIALS ? 'configured' : 'none',
        cam_golden: (() => { const golden = readGolden(__dirname); return golden ? { taken_at: golden.taken_at, cameras: Object.keys(golden.cameras || {}) } : null; })(),
        power: { ...describePower(POWER_CONFIG), health: powerHealth },
        version: getVersionBlock({ projectDir: __dirname, agentVersion: AGENT_VERSION }),
      }, activeSessionResponse());
    }
    if (op === 'audio_bind' || op === 'audio_lavalier') {
      return { ok: false, disabled: true, reason: 'disabled_would_revert_evo_routing', use: 'audio_evo' };
    }
    if (op === 'audio_evo' || op === 'audio_check' || op === 'mic_check') {
      return { ok: false, demo: true, reason: 'demo_mode' };
    }
    if (op === 'update') {
      return await performUpdate();
    }
    if (op === 'fetch_docs') {
      // Like `update`: nothing OBS-specific, must work on a demo machine too.
      return await fetchDocs();
    }
    return null;
  }

  if (op === 'start') {
    if (state.recording) {
      return { ok: true, recording: true, feeds_writing: null, already: true };
    }
    // The HTTP route and the relay poll can both deliver a start; the cam1 park adds a
    // settle delay, so refuse an overlapping start instead of racing it.
    if (startInFlight) {
      return await startInFlight; // a second delivery of the same start gets the same result
    }
    startInFlight = (async () => {
    if (!OBS_RECORD_DIR) {
      return { ok: false, reason: 'obs_misconfigured' };
    }
    const startingSources = activeSources.slice();

    let client;
    try {
      client = await getObsClient();
    } catch (e) {
      return { ok: false, reason: 'obs_start_failed', detail: truncateDetail(e && (e.message || e)) };
    }

    // A proxy encode of the last take takes every core; stop it before the cameras start.
    if (uploadQueue) {
      const held = await uploadQueue.holdProxies().catch(() => null);
      if (held && held.stopped) console.warn('[es-mini-agent] [take] WARN stopped a running proxy encode to start this take; it is redone after the take');
    }
    // So is the last take's audio file check if it is still going (a very long take).
    if (audioAnalysis) {
      audioAnalysis.cancel();
      audioAnalysis = null;
      console.warn('[es-mini-agent] [take] WARN stopped the last take\'s audio file check to start this take');
    }
    // The take's own mic watch (its own OBS client): pre-start verdict, in-take
    // alert, and the moment OBS says the master started. Warn only: never awaited
    // on the way to StartRecord, never a reason to refuse.
    const takeAudio = audioMonitor ? audioMonitor.beginTake() : null;
    const endTakeAudio = () => (audioMonitor ? audioMonitor.endTake().catch(() => null) : Promise.resolve(null));

    // The cam1 park only works around Source Record; RTSP capture does not need it.
    const parkedPreview = rtspUrlForSource('cam1') ? null : await parkPreviewOffCam1();
    const startedAt = Date.now();
    const rtspStarted = [];
    const capture = {};
    // Wall-clock start of each camera's file: refined at stop from the RTSP progress (see buildTiming).
    const timing = { obs_start_requested_ms: null, obs_start_responded_ms: null, cameras: {} };
    const startResults = await Promise.all(startingSources.map(async (source) => {
      const configured = captureConfigured(source);
      capture[source] = { capture_mode: 'source_record', configured, fallback: false };
      if (configured === 'rtsp') {
        const url = rtspUrlForSource(source);
        const camera = (state.cameras || []).find((c) => c.name === source);
        const rtsp = url
          ? await rtspCapture.start({ source, url, dir: path.join(OBS_RECORD_DIR, source), startedAt, audio: !!(camera && camera.rtsp_audio) })
          : { ok: false, reason: 'rtsp_misconfigured', detail: 'no usable host or rtsp_url in the camera config' };
        if (rtsp.ok) {
          rtspStarted.push(source);
          capture[source] = { capture_mode: 'rtsp', configured, fallback: false, video_after_ms: rtsp.video_after_ms };
          const firstVideoMs = Date.parse(rtsp.first_video_at || '');
          timing.cameras[source] = { basis: 'rtsp_first_video', started_ms: Number.isFinite(firstVideoMs) ? firstVideoMs : Date.now() };
          return { source, vendor: { success: true } };
        }
        // Never lose the camera: record it the old way for this take, and never quietly.
        capture[source] = { capture_mode: 'source_record', configured, fallback: true, fallback_reason: rtsp.reason || 'rtsp_start_failed', fallback_detail: rtsp.detail || null };
        console.warn('[es-mini-agent] [rtsp] WARN FALLBACK ' + source + ' is configured for RTSP but is recording with OBS Source Record this take:'
          + ' reason=' + capture[source].fallback_reason + (rtsp.detail ? ' detail=' + rtsp.detail : ''));
      }
      const vendor = await callVendor(client, 'record_start', source);
      // Source Record: only approximate, the moment its start was acknowledged.
      if (vendor.success) timing.cameras[source] = { basis: 'record_start', started_ms: Date.now() };
      return { source, vendor };
    }));
    const obsStarted = startingSources.filter((source) => !rtspStarted.includes(source));
    const failed = startResults.find((entry) => !entry.vendor.success);
    if (failed) {
      await stopRtspTakes(rtspStarted, null);
      restorePreviewAfterPark(parkedPreview, 0);
      await endTakeAudio();
      const detail = failed.source + ': ' + (failed.vendor.error || 'unknown_error');
      return { ok: false, reason: 'obs_start_failed', detail: truncateDetail(detail) };
    }

    if (MASTER_RECORD) {
      try {
        const recordStatus = await getMasterRecordStatus(client);
        if (recordStatus.outputActive) {
          throw new Error('recording_already_active');
        }
        timing.obs_start_requested_ms = Date.now();
        const started = await client.request('StartRecord');
        timing.obs_start_responded_ms = Date.now();
        const startError = masterResponseError(started, 'start_record_failed');
        if (startError) throw new Error(startError);
      } catch (e) {
        await stopStartedSources(client, obsStarted);
        await stopRtspTakes(rtspStarted, null);
        restorePreviewAfterPark(parkedPreview, 0);
        await endTakeAudio();
        const detail = 'master: ' + (e && (e.message || e) || 'start_record_failed');
        return { ok: false, reason: 'obs_start_failed', detail: truncateDetail(detail) };
      }
    }

    feedsPrevSamples = new Map();
    state.recording = true;
    state.paused = false;
    state.recordingStartedAt = Date.now();
    state.sources = startingSources;
    state.rtspSources = rtspStarted.slice();
    state.capture = capture;
    state.takeStartedAt = startedAt;
    state.lastTake = null;
    state.masterActive = MASTER_RECORD;
    state.sessionRef = sessionValue(body && body.session_ref);
    state.clientCode = sessionValue(body && body.client_code);
    state.timing = timing;
    restorePreviewAfterPark(parkedPreview, CAM1_PARK_RESTORE_MS);
    const fellBack = fallbackSources(capture);
    if (fellBack.length) console.warn('[es-mini-agent] [take] WARN take started with Source Record FALLBACK for ' + fellBack.join(',') + ' (configured for RTSP)');
    const out = Object.assign({ ok: true, recording: true, feeds_writing: null }, startSessionResponse(), { cameras: captureBlock(capture), fallback_sources: fellBack });
    if (audioMonitor) {
      // The pre-start mic check if it is in already (it needs ~1.5 s of meters, an
      // RTSP start takes longer), else the last one; status carries audio_alert next.
      const preStart = takeAudio ? await Promise.race([takeAudio.preStart, Promise.resolve(null)]) : null;
      out.audio = compactAudio(preStart || audioMonitor.latest() || unknownAudio('check_pending'));
      if (out.audio.level === 'fail' || out.audio.level === 'warn') console.warn('[es-mini-agent] [take] WARN recording started with mic check ' + out.audio.level + ': ' + out.audio.codes.join(',') + ' (warn only, take not refused)');
    }
    return out;
    })();
    try {
      return await startInFlight;
    } finally {
      startInFlight = null;
    }
  }
  if (op === 'stop') {
    const sources = sessionSources();
    const masterWasActive = state.masterActive;
    const rtspList = sources.filter(isRtspSession);
    const obsSources = sources.filter((source) => !rtspList.includes(source));
    let response = { ok: true, saved: false };
    try {
      let stopResults;
      let masterStop = { success: !masterWasActive, outputPath: null };
      let rtspStops = null;
      try {
        const client = await getObsClient();
        const cameraStops = obsSources.map(async (source) => {
          const vendor = await callVendor(client, 'record_stop', source);
          return { source, vendor };
        });
        const masterStopCall = masterWasActive
          ? client.request('StopRecord').then((result) => {
            const error = masterResponseError(result, 'stop_record_failed');
            return { success: !error, outputPath: obsResponseData(result).outputPath || null, error };
          }).catch((e) => ({ success: false, outputPath: null, error: e && (e.message || String(e)) || 'stop_record_failed' }))
          : Promise.resolve(masterStop);
        // RTSP files are named after the master's, so they finish once it has stopped.
        const rtspStopCall = masterStopCall.then((m) => stopRtspTakes(rtspList, m && m.outputPath));
        [stopResults, masterStop, rtspStops] = await Promise.all([Promise.all(cameraStops), masterStopCall, rtspStopCall]);
      } catch (e) {
        stopResults = obsSources.map((source) => ({
          source,
          vendor: { success: false, error: e && (e.message || String(e)) || 'obs_stop_error' },
        }));
        masterStop = { success: !masterWasActive, outputPath: null, error: e && (e.message || String(e)) || 'obs_stop_error' };
      }
      // OBS unreachable must not leave ffmpeg recording.
      if (!rtspStops) rtspStops = await stopRtspTakes(rtspList, null);

      const filesStable = await waitForObsFiles(obsSources, masterWasActive, masterStop.outputPath);
      // The take's mic watch ends with the take; its last verdict and the master's start time stay.
      const takeAudio = audioMonitor ? await audioMonitor.endTake().catch(() => null) : null;

      const allStopsSucceeded = stopResults.every((entry) => entry.vendor.success) && rtspStops.every((entry) => entry.rtsp.ok);
      const recordingStartedAt = state.recordingStartedAt;
      const takeStartedAt = state.takeStartedAt || recordingStartedAt;
      const sessionRef = state.sessionRef;
      const capture = state.capture || {};
      const masterPath = masterWasActive && masterStop.success ? masterStop.outputPath : null;
      const masterBase = masterStop.outputPath ? path.basename(String(masterStop.outputPath)) : null;
      let uploadQueued = 0;

      // The take's files, one per camera; null filePath = the camera wrote nothing.
      const rtspBySource = new Map(rtspStops.map((entry) => [entry.source, entry.rtsp]));
      const takeFiles = sources.map((source) => {
        const rtsp = rtspBySource.get(source);
        if (rtsp) return { source, filePath: rtsp.filePath || null, captureError: rtsp.ok ? null : rtsp.reason, gapS: Number.isFinite(rtsp.gap_ms) ? rtsp.gap_ms / 1000 : null, resumeWaitS: Number.isFinite(rtsp.resume_wait_ms) ? rtsp.resume_wait_ms / 1000 : null, rtsp };
        return { source, filePath: OBS_RECORD_DIR && takeStartedAt ? sourceRecordFile(source, takeStartedAt) : null, captureError: null, gapS: null, resumeWaitS: null, rtsp: null };
      });

      // The master's mic tracks are checked alongside the camera files (A3). Stop waits
      // up to AUDIO_HEALTH_WAIT_MS for it; a longer take gets it in last_take and on
      // the master/mic webhooks once it is done.
      const analysis = masterPath && OBS_RECORD_DIR ? startMasterAudioAnalysis(masterPath, { ffmpegBin: () => resolveFfmpegBin().bin, ffprobeBin: resolveFfprobeBin }) : null;
      // File health, not capture state, decides what the kiosk and the booking thread say.
      let check = null;
      if (OBS_RECORD_DIR) {
        try {
          check = await checkTake({ cameras: takeFiles, masterPath }, { ffprobeBin: resolveFfprobeBin });
        } catch (e) {
          console.warn('[es-mini-agent] [take] WARN file check failed:', e && (e.message || e));
        }
      }
      let audioHealth = null;
      if (analysis) {
        let timer = null;
        const waited = await Promise.race([analysis.promise, new Promise((resolve) => { timer = setTimeout(() => resolve(null), AUDIO_HEALTH_WAIT_MS); })]);
        clearTimeout(timer);
        audioHealth = waited || { level: 'unknown', codes: [], tracks: [], identical_pairs: [], pending: true };
        if (!waited) audioAnalysis = analysis;
      }
      const timingBlock = buildTiming(state.timing, rtspBySource, takeAudio);
      const recordedAt = (timingBlock && timingBlock.obs_start_at) || (takeStartedAt ? new Date(takeStartedAt).toISOString() : null);
      const audioMeta = audioHealth && !audioHealth.pending ? { audio_health: audioHealth, audio_level: audioHealth.level, audio_codes: audioHealth.codes } : {};
      const verdicts = check ? check.cameras : {};
      const takeHealth = check ? check.health : 'unverified';
      const fellBack = fallbackSources(capture);
      const failedSources = Object.keys(verdicts).filter((source) => verdicts[source].health === 'failed' || verdicts[source].health === 'missing');
      const saved = allStopsSucceeded && masterStop.success && filesStable && takeHealth !== 'failed' && takeHealth !== 'degraded';

      const files = [];
      const failedFiles = [];
      const cameras = {};
      for (const f of takeFiles) {
        const v = verdicts[f.source] || { health: 'unverified', size_bytes: f.filePath ? (getFileSample(f.filePath) || { size: 0 }).size : 0 };
        const c = capture[f.source] || { capture_mode: 'source_record', fallback: false };
        const usable = v.health !== 'failed' && v.health !== 'missing';
        const entry = { capture_mode: c.capture_mode, fallback: !!c.fallback, health: v.health, size_bytes: v.size_bytes || 0 };
        if (c.fallback) entry.fallback_reason = c.fallback_reason;
        if (v.reason) entry.reason = v.reason;
        for (const k of ['duration_s', 'master_duration_s', 'short_by_s']) if (v[k] !== undefined && v[k] !== null) entry[k] = v[k];
        if (f.rtsp) {
          entry.reconnects = f.rtsp.restarts || 0;
          entry.lost_s = Math.round((f.rtsp.gap_ms || 0) / 100) / 10;
          entry.resume_wait_s = Math.round((f.rtsp.resume_wait_ms || 0) / 100) / 10;
        }
        cameras[f.source] = entry;
        if (f.filePath) files.push({ source: f.source, size_bytes: entry.size_bytes, ok: usable, health: v.health });
        if (!usable) failedFiles.push({ source: f.source, size_bytes: entry.size_bytes, reason: v.reason || 'no_file' });
      }

      const takeName = masterBase ? path.basename(masterBase, path.extname(masterBase)) : 'take';
      const audioBad = !!(audioHealth && (audioHealth.level === 'fail' || audioHealth.level === 'warn'));
      const summary = '[es-mini-agent] [take] ' + takeName + ' health=' + takeHealth + ' saved=' + saved
        + (fellBack.length ? ' FALLBACK=' + fellBack.join(',') : '') + (failedSources.length ? ' FAILED=' + failedSources.join(',') : '')
        + ' | ' + takeFiles.map((f) => cameraSummary(f.source, capture, verdicts[f.source] || { health: 'unverified' }, f.rtsp)).join(' | ')
        + (check && check.master ? ' | master ' + check.master.health + (Number.isFinite(check.master.duration_s) ? ' ' + check.master.duration_s + 's' : '') : '')
        + (audioHealth ? ' | ' + (audioHealth.pending ? 'audio check still running' : describeAudioHealth(audioHealth)) : '')
        + (timingBlock ? ' | offsets ' + Object.entries(timingBlock.cameras).map(([src, c]) => src + '=' + (c.offset_s === null ? '?' : c.offset_s + 's')).join(' ') : '');
      if (takeHealth === 'ok' && !fellBack.length && !audioBad) console.log(summary);
      else console.warn(summary.replace('[take] ', '[take] WARN '));

      const takeMeta = { take_health: takeHealth, fallback_sources: fellBack, failed_sources: failedSources, rendition: 'original' };
      if (recordedAt) takeMeta.recorded_at = recordedAt;
      if (uploadQueue && OBS_RECORD_DIR) {
        if (!recordingStartedAt) {
          console.warn('[es-mini-agent] upload skipped: unknown recording start');
        } else {
          const watchMaster = masterWasActive && masterStop.success && masterStop.outputPath ? masterStop.outputPath : null;
          for (const f of takeFiles) {
            const entry = cameras[f.source];
            const meta = Object.assign({}, takeMeta, entry, { health_reason: entry.reason || null });
            const camTiming = timingBlock && timingBlock.cameras[f.source];
            // What this camera's watch copy needs: the master (mic tracks) and its offset.
            const watch = { masterPath: watchMaster, offsetS: camTiming && Number.isFinite(camTiming.offset_s) ? camTiming.offset_s : null, recordedAt };
            if (!f.filePath) {
              console.warn('[es-mini-agent] ' + f.source + ' has no file to upload: ' + (entry.reason || 'unknown'));
              uploadQueue.reportMissingCamera({ source: f.source, sessionRef, fileName: masterBase || (f.source + '.mp4'), meta }).catch(() => {});
              continue;
            }
            try {
              // A failed RTSP join keeps every part; filePath is the first, and each later one is footage too.
              const extraParts = f.rtsp && Array.isArray(f.rtsp.keptParts) ? f.rtsp.keptParts.filter((p) => p !== f.filePath) : [];
              for (const filePath of [f.filePath, ...extraParts]) {
                // Extra parts of a failed join have their own timeline: no watch copy alignment for them.
                const out = uploadQueue.enqueue({ filePath, source: f.source, sessionRef, meta, watch: filePath === f.filePath ? watch : { masterPath: watchMaster, offsetS: null, recordedAt } });
                if (out && out.queued) uploadQueued += 1;
                else console.warn('[es-mini-agent] upload enqueue skipped source=' + f.source + ' reason=' + (out && out.reason));
              }
            } catch (e) {
              console.warn('[es-mini-agent] upload enqueue failed source=' + f.source + ':', e && (e.stack || e.message || e));
            }
          }
          if (masterWasActive && masterStop.success && masterStop.outputPath) {
            try {
              const masterMeta = Object.assign({}, takeMeta, audioMeta, { timing: timingBlock || undefined });
              if (check && check.master && Number.isFinite(check.master.duration_s)) masterMeta.duration_s = check.master.duration_s;
              const out = uploadQueue.enqueue({ filePath: masterStop.outputPath, source: MASTER_SOURCE, sessionRef, meta: masterMeta });
              if (out && out.queued) uploadQueued += 1;
            } catch (e) {
              console.warn('[es-mini-agent] upload enqueue failed source=' + MASTER_SOURCE + ':', e && (e.stack || e.message || e));
            }
          }
        }
      }

      response = { ok: true, saved, health: takeHealth, files, failed_files: failedFiles, cameras, fallback_sources: fellBack };
      if (check && check.master) response.master = check.master;
      if (uploadQueue) response.upload_queued = uploadQueued;
      // Build 42 additions: the mic tracks' file check (warn only: never changes
      // saved/health), the take's capture timing, and the last in-take mic alert.
      if (audioHealth) response.audio_health = audioHealth;
      if (timingBlock) response.timing = timingBlock;
      if (recordedAt) response.recorded_at = recordedAt;
      if (takeAudio && takeAudio.alert) response.audio_alert = compactAudio(takeAudio.alert);
      // Preserve the take id after Stop so a phone that lost the Stop answer can
      // confirm this exact save without confusing it with a previous room take.
      const lastTake = { finished_at: new Date().toISOString(), session_ref: sessionRef, saved, health: takeHealth, files, failed_files: failedFiles, fallback_sources: fellBack };
      if (audioHealth) lastTake.audio_health = audioHealth;
      if (recordedAt) lastTake.recorded_at = recordedAt;
      state.lastTake = lastTake;
      if (audioHealth && audioHealth.pending && analysis) {
        const masterFile = masterPath;
        analysis.promise.then((result) => {
          if (audioAnalysis === analysis) audioAnalysis = null;
          if (state.lastTake === lastTake) lastTake.audio_health = result;
          const line = '[es-mini-agent] [take] ' + takeName + ' ' + describeAudioHealth(result) + ' (after stop)';
          if (result.level === 'fail' || result.level === 'warn') console.warn(line.replace('[take] ', '[take] WARN ')); else console.log(line);
          if (uploadQueue && result.level !== 'unknown') uploadQueue.annotate(masterFile, { audio_health: result, audio_level: result.level, audio_codes: result.codes });
        }).catch(() => {});
      }
    } finally {
      state.recording = false;
      state.paused = false;
      state.recordingStartedAt = null;
      state.sources = null;
      state.rtspSources = [];
      state.capture = {};
      state.timing = null;
      state.takeStartedAt = null;
      state.masterActive = false;
      state.sessionRef = null;
      state.clientCode = null;
      if (pendingSources) {
        applySources(pendingSources);
      }
    }
    return response;
  }
  if (op === 'cancel') {
    const sources = sessionSources();
    const masterWasActive = state.masterActive;
    const rtspList = sources.filter(isRtspSession);
    const obsSources = sources.filter((source) => !rtspList.includes(source));
    try {
      let stopResults;
      let masterStop = { success: !masterWasActive, outputPath: null };
      // A cancelled take's RTSP files are kept on the Mini like OBS's, never uploaded.
      const rtspStopCall = stopRtspTakes(rtspList, null);
      try {
        const client = await getObsClient();
        const cameraStops = obsSources.map(async (source) => {
          const vendor = await callVendor(client, 'record_stop', source);
          return { source, vendor };
        });
        const masterStopCall = masterWasActive
          ? client.request('StopRecord').then((result) => ({
            success: !masterResponseError(result, 'stop_record_failed'),
            outputPath: obsResponseData(result).outputPath || null,
          })).catch(() => ({ success: false, outputPath: null }))
          : Promise.resolve(masterStop);
        [stopResults, masterStop] = await Promise.all([Promise.all(cameraStops), masterStopCall]);
      } catch (e) {
        stopResults = obsSources.map((source) => ({
          source,
          vendor: { success: false, error: e && (e.message || String(e)) || 'obs_stop_error' },
        }));
        masterStop = { success: !masterWasActive, outputPath: null };
      }
      await rtspStopCall;
      if (audioMonitor) await audioMonitor.endTake().catch(() => null);

      await waitForObsFiles(obsSources, masterWasActive, masterStop.outputPath);

      const allStopsSucceeded = stopResults.every((entry) => entry.vendor.success);
      if (!allStopsSucceeded) {
        const failed = stopResults.find((entry) => !entry.vendor.success);
        const detail = failed ? (failed.source + ': ' + (failed.vendor.error || 'unknown_error')) : 'obs_stop_failed';
        console.warn('[es-mini-agent] WARN: OBS cancel vendor call failed:', truncateDetail(detail));
      }
      return { ok: true, cancelled: true, saved: false };
    } finally {
      state.recording = false;
      state.paused = false;
      state.recordingStartedAt = null;
      state.sources = null;
      state.rtspSources = [];
      state.capture = {};
      state.timing = null;
      state.takeStartedAt = null;
      state.masterActive = false;
      state.sessionRef = null;
      state.clientCode = null;
      if (pendingSources) {
        applySources(pendingSources);
      }
    }
  }
  if (op === 'status') {
    const sources = sessionSources();
    const masterActive = await getMasterActiveSafe();
    if (!state.recording) {
      const out = { ok: true, recording: false, feeds_writing: 0, preview: previewActive(), preview_camera: previewCameraNumber(), sources: sources.slice(), master_active: masterActive, master_enabled: MASTER_RECORD };
      if (state.lastTake) out.last_take = state.lastTake;
      if (uploadQueue) out.uploads = uploadQueue.status();
      if (audioMonitor) out.audio = compactAudio(audioMonitor.latest());
      return out;
    }
    // RTSP cameras write "<stamp> rtsp-partN.mp4", which the Source Record sampler
    // skips on purpose; counting them there made a healthy RTSP camera look dead
    // on the kiosk ("Camera failed") while a fallen-back one looked fine (Sep 29).
    const obsSources = sources.filter((source) => !isRtspSession(source));
    const sampled = sampleFeedsWriting(obsSources, OBS_RECORD_DIR, feedsPrevSamples);
    feedsPrevSamples = sampled.samples;
    const rtspState = state.rtspSources.length ? rtspCapture.describe() : {};
    const cameras = captureBlock(state.capture);
    for (const source of sources) {
      if (!cameras[source]) cameras[source] = { capture_mode: 'source_record', fallback: false };
      cameras[source].writing = isRtspSession(source) ? !!(rtspState[source] && rtspState[source].writing) : sampled.writing.has(source);
    }
    const feedsWriting = sampled.count + sources.filter((source) => isRtspSession(source) && rtspState[source] && rtspState[source].writing).length;
    const out = Object.assign({ ok: true, recording: true, feeds_writing: feedsWriting, preview: previewActive(), preview_camera: previewCameraNumber(), sources: sources.slice(), master_active: masterActive, master_enabled: MASTER_RECORD }, activeSessionResponse());
    out.cameras = cameras;
    out.fallback_sources = fallbackSources(state.capture);
    if (state.rtspSources.length) out.rtsp = rtspState;
    if (uploadQueue) out.uploads = uploadQueue.status();
    if (audioMonitor) {
      // The latest in-take mic verdict (every AUDIO_TAKE_EVAL_MS): warn only.
      out.audio_alert = compactAudio(audioMonitor.takeAlert());
      out.audio = compactAudio(currentAudio());
    }
    return out;
  }
  if (op === 'audio_check') {
    // A fresh mic check now (idle: its own OBS client; recording: the take's). Warn only.
    if (!audioMonitor) return { ok: false, reason: 'audio_check_disabled' };
    const block = await audioMonitor.check('op');
    const out = { ok: block.level !== 'unknown', recording: !!state.recording, audio: compactAudio(block) };
    if (block.level === 'unknown') out.reason = block.error || 'audio_check_failed';
    if (block.identical_pairs) out.identical_pairs = block.identical_pairs;
    return out;
  }
  if (op === 'mic_check') {
    // Contract C2: ~3 s of the four mic meters while people speak into them. Read-only: its own
    // OBS client, no OBS setting, scene or recording call. Refused whenever a take is, or is
    // about to be, recording (the take's own meters and OBS requests are never shared with it).
    if (state.recording || state.paused || startInFlight || (audioMonitor && audioMonitor.takeActive())) return { ok: false, reason: 'recording_active', recording: true };
    if (!audioMonitor) return { ok: false, reason: 'audio_check_disabled' };
    const out = await audioMonitor.micCheck();
    return Object.assign(out, { recording: false });
  }
  if (op === 'diag') {
    const out = Object.assign({ ok: true, demo: false, recording: state.recording, stats: null, filters: null, master_active: false, master_enabled: MASTER_RECORD }, activeSessionResponse());
    out.storage = {
      bucket: STORAGE_BUCKET,
      region: STORAGE_REGION,
      endpointHost: endpointHostnameOnly(STORAGE_ENDPOINT),
      credentials: storageCredentialsProvider.describeCredentials(),
    };
    out.ffmpeg = resolveFfmpegBin();
    out.rtsp = {
      enabled: RTSP_CAPTURE_ENABLED,
      cameras: (state.cameras || []).filter(isRtspCamera).map((c) => c.name),
      recording: rtspCapture.describe(),
    };
    out.ptz_auth = PTZ_CREDENTIALS ? 'configured' : 'none';
    { const golden = readGolden(__dirname); out.cam_golden = golden ? { taken_at: golden.taken_at, cameras: Object.keys(golden.cameras || {}) } : null; }
    out.power = { ...describePower(POWER_CONFIG), health: powerHealth };
    // Sits alongside storage/ffmpeg deliberately: all three are assigned before
    // the OBS call below, so they still come back on a machine whose OBS is down.
    out.version = getVersionBlock({ projectDir: __dirname, agentVersion: AGENT_VERSION });
    if (audioMonitor) out.audio = currentAudio();

    let client;
    try {
      client = await getObsClient();
    } catch (e) {
      out.error = 'obs_unreachable';
      return out;
    }

    try {
      const statsRes = await client.request('GetStats', {});
      const responseData = statsRes && statsRes.responseData;
      if (responseData && typeof responseData === 'object') {
        out.stats = {
          activeFps: typeof responseData.activeFps === 'undefined' ? null : responseData.activeFps,
          averageFrameRenderTime: typeof responseData.averageFrameRenderTime === 'undefined' ? null : responseData.averageFrameRenderTime,
          renderSkippedFrames: typeof responseData.renderSkippedFrames === 'undefined' ? null : responseData.renderSkippedFrames,
          renderTotalFrames: typeof responseData.renderTotalFrames === 'undefined' ? null : responseData.renderTotalFrames,
          outputSkippedFrames: typeof responseData.outputSkippedFrames === 'undefined' ? null : responseData.outputSkippedFrames,
          outputTotalFrames: typeof responseData.outputTotalFrames === 'undefined' ? null : responseData.outputTotalFrames,
          cpuUsage: typeof responseData.cpuUsage === 'undefined' ? null : responseData.cpuUsage,
          memoryUsage: typeof responseData.memoryUsage === 'undefined' ? null : responseData.memoryUsage,
          availableDiskSpace: typeof responseData.availableDiskSpace === 'undefined' ? null : responseData.availableDiskSpace,
        };
      }
    } catch (_) { /* stats are best-effort — a failed GetStats must still return the filter data */ }

    if (MASTER_RECORD) {
      try {
        out.master_active = !!(await getMasterRecordStatus(client)).outputActive;
      } catch (_) { /* master status is additive diagnostic context */ }
    }

    const filters = [];
    for (const source of sessionSources()) {
      try {
        const filterRes = await client.request('GetSourceFilterList', { sourceName: source });
        const responseData = filterRes && filterRes.responseData;
        const list = responseData && responseData.filters;
        if (!Array.isArray(list)) {
          filters.push({ source: source, error: 'no_filter_list' });
          continue;
        }
        let sawRecordFilter = false;
        for (const f of list) {
          const entry = {
            source: source,
            filter: (f && typeof f.filterName !== 'undefined') ? f.filterName : null,
            kind: (f && typeof f.filterKind !== 'undefined') ? f.filterKind : null,
            enabled: !!(f && f.filterEnabled),
          };
          if (entry.kind === 'source_record_filter') {
            entry.settings = (f && f.filterSettings) ? f.filterSettings : {};
            sawRecordFilter = true;
          }
          filters.push(entry);
        }
        // A camera with no Source Record filter records NOTHING. Say so loudly:
        // without this the source would just be absent from the list, and an
        // absence is the one thing an operator reading a diagnostic won't notice.
        if (!sawRecordFilter) {
          filters.push({ source: source, error: 'no_source_record_filter' });
        }
      } catch (e) {
        filters.push({ source: source, error: 'filter_query_failed' });
      }
    }
    out.filters = filters;
    // A fresh mic check when idle (the full block, with volume and identical pairs).
    if (audioMonitor && !state.recording) out.audio = await audioMonitor.check('diag');
    return out;
  }
  // audio_bind and audio_lavalier are permanently disabled (2026-08-18): both
  // write one shared audio_source + track 1 onto every camera's Source Record
  // filter, which silently reverts the per-camera EVO 8 routing that audio_evo
  // establishes. Revert-to-lavalier, if ever wanted, is a deliberate new
  // release, not a queued op. Old implementations live in git history.
  if (op === 'audio_lavalier' || op === 'audio_bind') {
    return { ok: false, disabled: true, reason: 'disabled_would_revert_evo_routing', use: 'audio_evo' };
  }
  if (op === 'audio_evo') {
    if (state.recording) return { ok: false, reason: 'busy_recording' };
    let client;
    try {
      client = await getObsClient();
    } catch (e) {
      return { ok: false, reason: 'obs_unreachable', detail: truncateDetail(e && (e.message || e)) };
    }
    try {
      return await runAudioEvo(client, activeSources, body || {});
    } catch (e) {
      return { ok: false, reason: 'audio_evo_exception', detail: truncateDetail(e && (e.message || e)) };
    }
  }
  if (op === 'pause') {
    if (!state.recording) {
      console.warn(`[es-mini-agent] WARN: pause called while not recording (demo-safe: returning ok).`);
    }

    const pauseSources = sessionSources();
    for (const r of await Promise.all(pauseSources.filter(isRtspSession).map((source) => rtspCapture.pause(source)))) {
      if (!r.ok) console.warn('[es-mini-agent] WARN: rtsp pause failed:', r.reason || 'unknown');
    }
    try {
      const client = await getObsClient();
      const pauseResults = await Promise.all(pauseSources.filter((source) => !isRtspSession(source)).map((source) => callVendor(client, 'record_pause', source)));
      const failed = pauseResults.find((result) => !result.success);
      if (failed) {
        console.warn('[es-mini-agent] WARN: OBS pause vendor call failed:', failed.error || 'vendor_error');
      }
      if (state.masterActive) {
        const paused = await client.request('PauseRecord');
        const masterError = masterResponseError(paused, 'pause_record_failed');
        if (masterError) console.warn('[es-mini-agent] WARN: OBS master pause failed:', masterError);
      }
    } catch (e) {
      console.warn('[es-mini-agent] WARN: OBS pause connect/request failed:', e && (e.message || e));
    }

    state.paused = true;
    return { ok: true, paused: true };
  }
  if (op === 'resume') {
    // Post-TF48 audit: resume used to set recording=true even with no take, so a stray
    // resume (now possible while a look moves the cameras) faked a recording.
    if (!state.recording && !state.paused) {
      console.warn('[es-mini-agent] WARN: resume called with no take (demo-safe: returning ok, nothing started).');
      return { ok: true, recording: false, feeds_writing: null };
    }
    const resumeSources = sessionSources();
    for (const r of await Promise.all(resumeSources.filter(isRtspSession).map((source) => rtspCapture.resume(source)))) {
      if (!r.ok) console.warn('[es-mini-agent] WARN: rtsp resume failed:', r.reason || 'unknown');
    }
    try {
      const client = await getObsClient();
      const resumeResults = await Promise.all(resumeSources.filter((source) => !isRtspSession(source)).map((source) => callVendor(client, 'record_unpause', source)));
      const failed = resumeResults.find((result) => !result.success);
      if (failed) {
        console.warn('[es-mini-agent] WARN: OBS resume vendor call failed:', failed.error || 'vendor_error');
      }
      if (state.masterActive) {
        const resumed = await client.request('ResumeRecord');
        const masterError = masterResponseError(resumed, 'resume_record_failed');
        if (masterError) console.warn('[es-mini-agent] WARN: OBS master resume failed:', masterError);
      }
    } catch (e) {
      console.warn('[es-mini-agent] WARN: OBS resume connect/request failed:', e && (e.message || e));
    }

    state.paused = false;
    state.recording = true;
    return { ok: true, recording: true, feeds_writing: null };
  }
  const previewCameraIndex = cameraIndexForPreviewOp(op);
  if (previewCameraIndex !== null) {
    return await withPreviewLock(() => selectCloudflarePreviewCamera(previewCameraIndex));
  }
  if (op === 'preview_start') {
    const startedAt = Date.now();
    const viewer = previewViewerId(body);
    // The kiosk sends this every 25 s while it shows the studio: keep its mic check fresh.
    // Logged when it fires, so a drop can be lined up with it (it opens its own OBS
    // websocket, with the input-meter events, for about AUDIO_METER_WINDOW_MS).
    if (audioMonitor && !state.recording && !startInFlight && !audioMonitor.takeActive()) {
      const lastAudio = audioMonitor.latest();
      const audioAge = lastAudio && lastAudio.checked_at ? Date.now() - Date.parse(lastAudio.checked_at) : Infinity;
      if (!(audioAge < AUDIO_PREVIEW_MIN_MS)) previewLog('audio_check_due', { viewer });
    }
    maybeAudioCheck('preview', AUDIO_PREVIEW_MIN_MS);
    const joined = !previewLeases.has(viewer);
    previewLeases.set(viewer, Date.now() + PREVIEW_TTL_MS);
    refreshPreviewUntil();
    if (joined) previewLog('viewer_join', { viewer, viewers: previewLeases.size, route: previewRoute(), camera: previewCameraNumber() });
    const realtime = await withPreviewLock(() => startCloudflarePreview(body && body.cloudflare, body && body.local));
    const tookMs = Date.now() - startedAt;
    if (tookMs > 2000 || realtime.restarted || !realtime.stream) {
      previewLog('keepalive', { viewer, ms: tookMs, stream: realtime.stream ? 'yes' : 'no', restarted: realtime.restarted ? 'yes' : null, reuse_unavailable: realtime.reuseUnavailable ? 'yes' : null, error: realtime.error ? 'start_failed' : null });
    }
    // Only when the Worker offered a relay: flag off leaves the result unchanged.
    const relayFields = body && body.local
      ? Object.assign({ local_relay: !!realtime.localRelay }, realtime.localError ? { local_error: realtime.localError } : {})
      : {};
    if (realtime.stream) {
      if (previewTimer) {
        clearInterval(previewTimer);
        previewTimer = null;
      }
      return Object.assign({
        ok: true,
        preview: true,
        stream_mode: 'cloudflare',
        stream: realtime.stream,
        cleanup_input_uid: realtime.cleanupInputUid,
        sources: activeSources.slice(),
        camera: previewCameraNumber(),
      }, relayFields, audioMonitor ? { audio: compactAudio(currentAudio()) } : {});
    }
    if (!isStorageConfigured()) {
      return { ok: false, reason: 'r2_unconfigured', cleanup_input_uid: realtime.cleanupInputUid, camera: previewCameraNumber() };
    }
    if (!previewTimer) {
      previewTimer = setInterval(pushPreviewFrames, PREVIEW_INTERVAL_MS);
      console.log('[es-mini-agent] [preview] started');
      previewLog('jpeg_fallback_start', { viewer, reason: realtime.reuseUnavailable ? 'reuse_unavailable' : (realtime.error ? 'stream_start_failed' : 'no_stream_offered') });
    }
    return Object.assign({
      ok: true,
      preview: true,
      cleanup_input_uid: realtime.cleanupInputUid,
      stream_error: realtime.error || (realtime.reuseUnavailable ? 'reuse_unavailable' : null),
      sources: activeSources.slice(),
      camera: previewCameraNumber(),
    }, relayFields, audioMonitor ? { audio: compactAudio(currentAudio()) } : {});
  }
  if (op === 'preview_stop') {
    const viewer = previewViewerId(body);
    const held = previewLeases.delete(viewer);
    if (viewer !== PREVIEW_SHARED_VIEWER && refreshPreviewUntil() > Date.now()) {
      // Another viewer is still watching: release only this one.
      previewLog('viewer_leave', { viewer, held: held ? 'yes' : 'no', viewers: previewLeases.size, kept_stream: 'yes', route: previewRoute(), camera: previewCameraNumber() });
      return { ok: true, preview: true, viewers: previewLeases.size, camera: previewCameraNumber() };
    }
    const reason = viewer === PREVIEW_SHARED_VIEWER ? 'legacy_stop' : 'last_viewer_left';
    previewLog('viewer_leave', { viewer, held: held ? 'yes' : 'no', viewers: 0, kept_stream: 'no' });
    previewLeases.clear();
    previewUntil = 0;
    const cleanupInputUid = await withPreviewLock(async () => {
      // A viewer may have joined while this waited for the lock: then it is not the last.
      if (previewLeases.size > 0) return undefined;
      const uid = await stopCloudflarePreview(reason);
      cloudflarePreviewCameraIndex = 0;
      if (previewTimer) {
        clearInterval(previewTimer);
        previewTimer = null;
        console.log('[es-mini-agent] [preview] stopped');
      }
      return uid;
    });
    if (cleanupInputUid === undefined) {
      refreshPreviewUntil();
      return { ok: true, preview: true, viewers: previewLeases.size, camera: previewCameraNumber() };
    }
    return { ok: true, preview: false, cleanup_input_uid: cleanupInputUid, camera: null };
  }
  if (op === 'update') {
    return await performUpdate();
  }
  if (op === 'fetch_docs') {
    return await fetchDocs();
  }
  return null;
}

const VALID_OPS = new Set(['start', 'stop', 'cancel', 'status', 'pause', 'resume', 'preview_start', 'preview_stop', 'preview_cam1', 'preview_cam2', 'preview_cam3', 'diag', 'audio_bind', 'audio_lavalier', 'audio_evo', 'audio_check', 'mic_check', 'update', 'fetch_docs', 'look', 'cam_snapshot', 'cam_restore', 'power']);

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

    if (method === 'POST' && url === '/r2test/start') {
      if (!authOk(req)) {
        sendJson(res, 401, { ok: false, reason: 'unauthorized' });
        log(method, url, 401, 'unauthorized');
        return;
      }

      if (!isStorageConfigured()) {
        sendJson(res, 200, { ok: false, reason: 'r2_unconfigured' });
        log(method, url, 200, 'r2_unconfigured');
        return;
      }

      const raw = await readBody(req);
      const body = parseJsonSafe(raw);
      const sizeBytes = parseSizeBytesOrDefault(body.sizeBytes);
      if (!sizeBytes) {
        sendJson(res, 200, { ok: false, reason: 'bad_size_bytes' });
        log(method, url, 200, 'bad_size_bytes');
        return;
      }

      const resume = !!body.resume;
      const explicitKey = typeof body.key === 'string' ? body.key.trim() : '';
      if (resume && !explicitKey) {
        sendJson(res, 200, { ok: false, reason: 'resume_requires_key' });
        log(method, url, 200, 'resume_requires_key');
        return;
      }

      // To prove real resume-after-restart behavior, call start with resume:true and
      // the same explicit key used by the original run.
      const key = resume
        ? explicitKey
        : `bench-r2-test/${BUILDING_ID}_${Date.now()}.bin`;
      const testId = crypto.randomUUID();
      const totalParts = Math.ceil(sizeBytes / R2_PART_SIZE_BYTES);
      const startedAt = new Date().toISOString();
      r2Tests.set(testId, {
        status: 'running',
        partsCompleted: 0,
        totalParts,
        bytesUploaded: 0,
        sizeBytes,
        startedAt,
        finishedAt: null,
        error: null,
        key,
        pausedForRecordingMs: 0,
        elapsedMs: null,
        shouldAbort: false,
      });

      runMultipartUploadTest({
        r2Config: storageR2Config,
        testId,
        sizeBytes,
        key,
        isRecording: () => state.recording,
        shouldAbort: () => {
          const current = r2Tests.get(testId);
          return !!(current && current.shouldAbort);
        },
        stateFilePath: stateFilePathForKey(key),
        webhookUrl: activeWebhookUrl,
        onProgress: (partial) => {
          const current = r2Tests.get(testId);
          if (!current) return;
          const next = Object.assign({}, current, {
            partsCompleted: Number(partial && partial.partsCompleted) || current.partsCompleted,
            totalParts: Number(partial && partial.totalParts) || current.totalParts,
            bytesUploaded: Number(partial && partial.bytesUploaded) || current.bytesUploaded,
          });
          r2Tests.set(testId, next);
        },
      }).then((summary) => {
        const current = r2Tests.get(testId);
        if (!current) return;
        const finishedAt = new Date().toISOString();
        const wasAborted = current.status === 'aborted';
        const next = Object.assign({}, current, {
          status: wasAborted ? 'aborted' : 'done',
          partsCompleted: summary && Number(summary.partsUploaded) || current.partsCompleted,
          totalParts: summary && Number(summary.partsUploaded) || current.totalParts,
          bytesUploaded: summary && Number(summary.sizeBytes) || current.bytesUploaded,
          sizeBytes: summary && Number(summary.sizeBytes) || current.sizeBytes,
          key: summary && summary.key || current.key,
          pausedForRecordingMs: summary && Number(summary.pausedForRecordingMs) || current.pausedForRecordingMs,
          elapsedMs: summary && Number(summary.elapsedMs) || current.elapsedMs,
          finishedAt,
          error: wasAborted ? (current.error || 'aborted_by_request') : null,
        });
        r2Tests.set(testId, next);
      }).catch((err) => {
        const current = r2Tests.get(testId);
        if (!current) return;
        const detail = truncateDetail(err && (err.message || err.stack || err));
        const aborted = current.status === 'aborted' || (err && err.code === 'aborted');
        const next = Object.assign({}, current, {
          status: aborted ? 'aborted' : 'error',
          finishedAt: new Date().toISOString(),
          error: detail || (aborted ? 'aborted_by_request' : 'upload_failed'),
        });
        r2Tests.set(testId, next);
      });

      sendJson(res, 200, { ok: true, testId, key });
      log(method, url, 200, 'r2test_start');
      return;
    }

    const r2StatusMatch = url.match(/^\/r2test\/status(?:\?(.*))?$/);
    if (method === 'GET' && r2StatusMatch) {
      if (!authOk(req)) {
        sendJson(res, 401, { ok: false, reason: 'unauthorized' });
        log(method, url, 401, 'unauthorized');
        return;
      }
      const qs = new URLSearchParams(r2StatusMatch[1] || '');
      const testId = (qs.get('testId') || '').trim();
      if (!testId) {
        sendJson(res, 200, { ok: false, reason: 'bad_test_id' });
        log(method, url, 200, 'bad_test_id');
        return;
      }
      const entry = r2Tests.get(testId);
      if (!entry) {
        sendJson(res, 200, { ok: false, reason: 'not_found' });
        log(method, url, 200, 'r2test_not_found');
        return;
      }
      sendJson(res, 200, Object.assign({ ok: true, testId }, publicR2TestState(entry)));
      log(method, url, 200, 'r2test_status');
      return;
    }

    if (method === 'POST' && url === '/r2test/abort') {
      if (!authOk(req)) {
        sendJson(res, 401, { ok: false, reason: 'unauthorized' });
        log(method, url, 401, 'unauthorized');
        return;
      }
      const raw = await readBody(req);
      const body = parseJsonSafe(raw);
      const testId = typeof body.testId === 'string' ? body.testId.trim() : '';
      if (!testId) {
        sendJson(res, 200, { ok: false, reason: 'bad_test_id' });
        log(method, url, 200, 'bad_test_id');
        return;
      }
      const entry = r2Tests.get(testId);
      if (!entry) {
        sendJson(res, 200, { ok: false, reason: 'not_found' });
        log(method, url, 200, 'r2test_not_found');
        return;
      }
      const next = Object.assign({}, entry, {
        status: 'aborted',
        shouldAbort: true,
        finishedAt: entry.finishedAt || new Date().toISOString(),
        error: entry.error || 'aborted_by_request',
      });
      r2Tests.set(testId, next);
      sendJson(res, 200, { ok: true, testId });
      log(method, url, 200, 'r2test_abort');
      return;
    }

    const m = url.match(/^\/record\/([a-z_]+)\/?$/);
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

      const out = await handleOp(op, body);
      if (out == null) {
        sendJson(res, 404, { ok: false, reason: 'not_found' });
        log(method, url, 404, 'bad_op');
        return;
      }
      sendJson(res, 200, out);
      const refused = out && out.ok === false;
      log(method, url, 200, refused && out.reason ? `${op} ${out.reason}` : op, refused);
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

// ---------- outbound poll loop ----------
// Reach OUT to the Cloudflare Worker every POLL_INTERVAL_MS (POLL_IDLE_INTERVAL_MS
// when the room is idle) to claim any pending command, run it locally via
// handleOp(), and POST the result back. This
// replaces the old inbound cloudflared quick-tunnel path — no inbound port
// exposure needed from this Mac. The inbound handler above is left intact
// (harmless without a tunnel) so nothing that used to work is broken.
let polling = false;
let pollTimer = null;
let pollStopped = false;
let pollFailures = 0;
let lastCommandAt = 0;
let sourcesTimer = null;
let camReachTimer = null;
let diskUsageTimer = null;
// The heartbeat rides on the command poll, once a minute, and only counts as sent once the relay
// answered that poll (heartbeat-state.js createHeartbeatSlot): a failed or hung poll used to burn the
// slot, so two bad polls left the Worker without one for 3 min and the kiosk said "Studio offline".
const heartbeatSlot = createHeartbeatSlot();
// A poll that gets no answer is abandoned after this long (undici's own wait is 5 min, so one
// stalled connection silenced the heartbeat for the whole time).
const POLL_TIMEOUT_MS = Math.max(1000, Number(process.env.POLL_TIMEOUT_MS) || 20000);
let cameraReachability = null;
let cameraReachabilityBusy = false;
let diskUsage = null;
let diskUsageBusy = false;
let powerCheckTimer = null;
let audioCheckTimer = null;
let powerHealth = null;
let powerHealthBusy = false;

async function refreshCameraReachability() {
  if (cameraReachabilityBusy) return;
  if (state.recording) {
    cameraReachability = { ...(cameraReachability || {}), skipped: 'recording' };
    return;
  }
  if (!Array.isArray(state.cameras) || state.cameras.length === 0) return;
  cameraReachabilityBusy = true;
  try {
    cameraReachability = await probeCameras(state.cameras);
  } finally {
    cameraReachabilityBusy = false;
  }
}

async function refreshDiskUsage() {
  if (diskUsageBusy) return;
  diskUsageBusy = true;
  try {
    const homeDir = os.homedir();
    const dirs = [OBS_RECORD_DIR, homeDir && path.join(homeDir, 'es-mini-recordings'), homeDir]
      .filter((dir, index, all) => dir && all.indexOf(dir) === index);
    diskUsage = null;
    for (const dir of dirs) {
      diskUsage = await sampleDiskUsage(dir);
      if (diskUsage) break;
    }
  } finally {
    diskUsageBusy = false;
  }
}

// Read-only (status is a GET, never a write). fail_count counts consecutive
// failures so the cloud can ignore a single blip.
async function refreshPowerHealth() {
  if (powerHealthBusy || !POWER_CONFIG.baseUrl) return;
  powerHealthBusy = true;
  try {
    const res = await runPower(POWER_CONFIG, { action: 'status' }, {});
    const lights = res && res.ok && res.outlets && res.outlets.lights;
    powerHealth = {
      ok: !!(res && res.ok),
      reason: res && res.ok ? null : String((res && res.reason) || 'unknown'),
      lights_on: lights && typeof lights.on === 'boolean' ? lights.on : null,
      fail_count: res && res.ok ? 0 : ((powerHealth && powerHealth.fail_count) || 0) + 1,
      checked_at: new Date().toISOString(),
    };
  } finally {
    powerHealthBusy = false;
  }
}

function heartbeatQuery(now = Date.now()) {
  if (!heartbeatSlot.due(now)) return '';
  try {
    const version = getVersionBlock({ projectDir: __dirname, agentVersion: AGENT_VERSION });
    const queue = uploadQueue ? uploadQueue.status() : null;
    const heartbeatJson = heartbeatStateJson({
      recording: state.recording,
      paused: state.paused,
      uploadsQueued: queue && queue.queued,
      masterActive: state.masterActive,
      cameraReachability,
      diskUsage,
      powerHealth,
      audio: currentAudio(),
      // The angle in the shared preview stream (contract C1), null with no overlay.
      previewCamera: previewCameraNumber(),
      // Undelivered upload_confirmed posts (A8; in memory, no I/O).
      webhookPending: uploadQueue ? uploadQueue.webhookPending() : null,
    });
    return '&hb=1&v=' + encodeURIComponent(AGENT_VERSION)
      + '&c=' + encodeURIComponent(version.commit || 'unknown')
      + '&state=' + encodeURIComponent(Buffer.from(heartbeatJson).toString('base64url'));
  } catch (e) {
    // Heartbeat observability is strictly additive: a local encoding failure
    // must never block or alter the command-poll path.
    heartbeatSlot.abandoned();
    console.warn('[es-mini-agent] relay: heartbeat build failed:', e && (e.message || e));
    return '';
  }
}

async function refreshSources() {
  try {
    const url = `${RECORD_POLL_URL}/api/record?building_id=${encodeURIComponent(BUILDING_ID)}&want_sources=1`;
    const getRes = await fetch(url, {
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + RECORD_CONTROL_KEY },
    });
    if (!getRes.ok) {
      console.warn(`[es-mini-agent] relay: sources GET ${getRes.status} from ${RECORD_POLL_URL}`);
      return;
    }

    const data = await getRes.json().catch(() => ({}));
    applyPtzConfig(data);
    const remoteSources = data && data.sources;
    if (Array.isArray(remoteSources) && remoteSources.length) {
      const next = [];
      let invalid = false;
      for (const value of remoteSources) {
        if (typeof value !== 'string') {
          invalid = true;
          break;
        }
        const trimmed = value.trim();
        if (!trimmed) {
          invalid = true;
          break;
        }
        next.push(trimmed);
      }
      if (!invalid && next.length) {
        const current = pendingSources || activeSources;
        if (!sameSources(next, current)) applySources(next);
      }
    }

    const remoteWebhookUrl = data && data.upload_webhook_url;
    if (typeof remoteWebhookUrl !== 'string') return;
    const trimmedWebhookUrl = remoteWebhookUrl.trim();
    if (!trimmedWebhookUrl) return;
    if (!trimmedWebhookUrl.startsWith('https://')) {
      console.warn('[es-mini-agent] relay: ignoring non-https upload webhook');
      return;
    }
    applyWebhookUrl(trimmedWebhookUrl);
  } catch (e) {
    console.error('[es-mini-agent] relay: sources refresh error:', e && (e.stack || e.message || e));
  }
}

// Posts an op's result back to the relay. Resolves 'command' (or 'error' never: the
// caller's catch covers a throw).
async function postCommandResult(cmd, result, opStartedAt) {
  if (result == null) {
    console.warn(`[es-mini-agent] relay: unknown op '${cmd.op}' (id=${cmd.id}) — skipping result post`);
    return 'command';
  }
  const postRes = await fetch(`${RECORD_POLL_URL}/api/record`, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + RECORD_CONTROL_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ mini_result: true, id: cmd.id, ok: !!result.ok, result }),
    // Post-TF48 audit P2: a result POST the relay never answers would hold the one
    // command loop (and the heartbeat riding on it) for undici's 5 min. Same cap as the poll.
    signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
  });
  if (!postRes.ok) {
    console.warn(`[es-mini-agent] relay: result POST ${postRes.status} for ${cmd.op} (${cmd.id})`);
    return 'command';
  }
  // How long the op itself took, so a slow tap can be split into poll wait and agent work.
  console.log(`[es-mini-agent] relay: claimed ${cmd.op} (${cmd.id}) -> posted result (op took ${((Date.now() - opStartedAt) / 1000).toFixed(1)} s)`);
  return 'command';
}

// Looks run one at a time, in the order they were claimed, but off the poll loop.
// `lookPending` counts claimed looks not yet answered; `lookTail` settles when the last one has.
let lookTail = Promise.resolve();
let lookPending = 0;
// Ops that may run while a look is still waiting on the cameras.
const LOOK_CONCURRENT_OPS = new Set(['status', 'preview_start', 'preview_stop', 'preview_cam1', 'preview_cam2', 'preview_cam3', 'diag', 'audio_check', 'mic_check', 'stop', 'cancel', 'pause', 'resume']);
function dispatchLookOffLoop(cmd, payload) {
  const claimedAt = Date.now();
  lookPending += 1;
  lookTail = lookTail.then(async () => {
    const startedAt = Date.now();
    try {
      const result = await handleOp(cmd.op, payload);
      await postCommandResult(cmd, result, startedAt);
      if (previewActive()) previewLog('look', { queued_ms: startedAt - claimedAt, ms: Date.now() - startedAt, ok: result && result.ok ? 'yes' : 'no', preview: 'active' });
    } catch (e) {
      console.error('[es-mini-agent] relay: look error:', e && (e.stack || e.message || e));
    } finally {
      lookPending -= 1;
    }
  });
}

// Resolves 'command', 'idle' or 'error' so the loop can pick the next interval.
async function pollOnce() {
  if (polling) return 'idle'; // network calls are async — belt-and-suspenders reentry guard
  polling = true;
  try {
    const url = `${RECORD_POLL_URL}/api/record?building_id=${encodeURIComponent(BUILDING_ID)}${heartbeatQuery()}`;
    const getRes = await fetch(url, {
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + RECORD_CONTROL_KEY },
      signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
    });
    if (!getRes.ok) {
      // 401/5xx from the relay — log once per tick and move on. Do not crash.
      console.warn(`[es-mini-agent] relay: poll GET ${getRes.status} from ${RECORD_POLL_URL}`);
      return 'error';
    }
    const data = await getRes.json().catch(() => ({}));
    // The Worker answers 200 { ok: false, reason: 'exception' } when Supabase fails:
    // back off like a 5xx, but stay quiet in the log as before. The heartbeat on that poll was
    // probably not stored either, so it rides on the retry.
    if (data && data.ok === false) return 'error';
    // The relay answered properly: the heartbeat riding on this poll counts as delivered (the Worker
    // records it without awaiting it, so this is as sure as the agent can be).
    heartbeatSlot.delivered();
    const cmd = data && data.command;
    if (!cmd || !cmd.id || !cmd.op) return 'idle'; // nothing to do — stay quiet to keep agent.log readable

    lastCommandAt = Date.now();
    const payload = (cmd.payload && typeof cmd.payload === 'object') ? cmd.payload : {};
    if (cmd.op === 'look') {
      // A look waits on the cameras' HTTP answers (up to 3 s each). Run on the poll loop
      // it holds every command behind it, including the viewers' preview keepalives and
      // camera picks, for that long per tap (Robbie Nov 4: rapid preset taps blacked out
      // the preview). Looks still run one at a time, in order, just not on the loop.
      dispatchLookOffLoop(cmd, payload);
      return 'command';
    }
    // Nothing else may overlap a look: a Start must not begin with cameras still moving.
    if (lookPending > 0 && !LOOK_CONCURRENT_OPS.has(cmd.op)) await lookTail;
    const opStartedAt = Date.now();
    const result = await handleOp(cmd.op, payload);
    return await postCommandResult(cmd, result, opStartedAt);
  } catch (e) {
    // Network hiccup, DNS blip, JSON parse — never crash the process.
    console.error('[es-mini-agent] relay: poll error:', e && (e.stack || e.message || e));
    return 'error';
  } finally {
    polling = false;
  }
}

function nextPollDelay(outcome, now = Date.now()) {
  const active = state.recording || state.paused || now - lastCommandAt < POLL_ACTIVE_WINDOW_MS;
  const interval = active ? POLL_INTERVAL_MS : POLL_IDLE_INTERVAL_MS;
  if (outcome !== 'error') {
    pollFailures = 0;
    return interval;
  }
  pollFailures += 1;
  return Math.max(interval, POLL_ERROR_BACKOFF_MS[Math.min(pollFailures, POLL_ERROR_BACKOFF_MS.length) - 1]);
}

// One poll at a time, never overlapping. A normal interval counts from the start of
// the previous poll (as setInterval did), so the round trip to the Worker is not
// added on top; a failed poll waits its backoff in full before the next attempt.
async function pollLoop() {
  const startedAt = Date.now();
  const outcome = await pollOnce();
  if (pollStopped) return;
  const delay = nextPollDelay(outcome);
  pollTimer = setTimeout(pollLoop, outcome === 'error' ? delay : Math.max(0, delay - (Date.now() - startedAt)));
}

autoStop = createAutoStop({
  file: process.env.AUTO_STOP_STATE_FILE || path.join(UPLOAD_STATE_DIR, 'auto-stop.json'),
  relayUrl: RECORD_POLL_URL,
  key: RECORD_CONTROL_KEY,
  buildingId: BUILDING_ID,
  isTakeLive: (ref) => !!(state.recording || state.paused) && state.sessionRef === ref,
  localStop: (ref) => handleOp('stop', { auto_stop_for: ref, local: true }),
  requestRetryMs: Number(process.env.AUTO_STOP_RETRY_MS) || undefined,
  localAfterMs: Number(process.env.AUTO_STOP_LOCAL_AFTER_MS) || undefined,
  log: (level, line) => (level === 'warn' ? console.warn : console.log)('[es-mini-agent] ' + line),
});

server.listen(PORT, () => {
  console.log(`[es-mini-agent] listening on :${PORT} building_id=${BUILDING_ID}`);
  setInterval(() => { autoStop.tick().catch(() => {}); }, 1000).unref();
  console.log(`[es-mini-agent] relay: polling ${RECORD_POLL_URL}/api/record every ${POLL_INTERVAL_MS}ms while the room is in use, ${POLL_IDLE_INTERVAL_MS}ms when idle`);
  console.log('[es-mini-agent] sources (env): ' + activeSources.join(','));
  // First poll after one idle interval, as before: its heartbeat carries the disk and
  // camera samples taken just below, which are not there yet at boot.
  pollTimer = setTimeout(pollLoop, POLL_IDLE_INTERVAL_MS);
  sourcesTimer = setInterval(refreshSources, SOURCES_REFRESH_MS);
  camReachTimer = setInterval(refreshCameraReachability, CAM_REACH_MS);
  diskUsageTimer = setInterval(refreshDiskUsage, DISK_USAGE_MS);
  diskUsageTimer.unref();
  if (POWER_CONFIG.baseUrl) {
    powerCheckTimer = setInterval(() => {
      refreshPowerHealth().catch((e) => console.warn('[es-mini-agent] power check failed:', e && (e.message || e)));
    }, POWER_CHECK_MS);
    powerCheckTimer.unref();
    refreshPowerHealth().catch((e) => console.warn('[es-mini-agent] power check failed:', e && (e.message || e)));
  }
  if (audioMonitor) {
    // Idle mic check every AUDIO_CHECK_MS (the take keeps its own), the first shortly after boot.
    audioCheckTimer = setInterval(() => maybeAudioCheck('idle', AUDIO_CHECK_MS / 2), AUDIO_CHECK_MS);
    audioCheckTimer.unref();
    setTimeout(() => maybeAudioCheck('boot', 0), 500).unref();
  }
  refreshSources().catch(() => {});
  refreshCameraReachability().catch((e) => {
    console.warn('[es-mini-agent] camera reachability refresh failed:', e && (e.message || e));
  });
  refreshDiskUsage().catch((e) => {
    console.warn('[es-mini-agent] disk usage refresh failed:', e && (e.message || e));
  });
  if (uploadQueue) {
    uploadQueue.sweep().catch((e) => {
      console.warn('[es-mini-agent] upload queue sweep failed:', e && (e.stack || e.message || e));
    });
  }
});

function shutdown(signal) {
  console.log(`[es-mini-agent] ${signal} received, closing server...`);
  pollStopped = true;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  if (sourcesTimer) {
    clearInterval(sourcesTimer);
    sourcesTimer = null;
  }
  if (camReachTimer) {
    clearInterval(camReachTimer);
    camReachTimer = null;
  }
  if (diskUsageTimer) {
    clearInterval(diskUsageTimer);
    diskUsageTimer = null;
  }
  if (powerCheckTimer) {
    clearInterval(powerCheckTimer);
    powerCheckTimer = null;
  }
  if (audioCheckTimer) {
    clearInterval(audioCheckTimer);
    audioCheckTimer = null;
  }
  if (previewTimer) {
    clearInterval(previewTimer);
    previewTimer = null;
  }
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
