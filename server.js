'use strict';

// EVRYBDY Studios FLEET — Mini-side agent.
// Proves the app -> Vercel proxy -> Mini connection is real.
// Optional OBS Source Record control; in-memory demo mode remains the fallback.

const http = require('http');
const { ObsClient, callVendor, getNewestFileSample, getSourceScreenshot, sampleFeedsWriting } = require('./obs-control');
const crypto = require('crypto');
const path = require('path');
const { createUploadQueue, resolveFfmpegBin } = require('./upload-queue');
const { runMultipartUploadTest, signR2Request } = require('./r2-upload');
const { createCredentialsProvider } = require('./aws-creds');
const { runSelfUpdate, getVersionBlock } = require('./self-update');

// Bumped by hand per release. This is the fastest way to tell what a remote
// machine is actually running -- it comes back in `diag` even when OBS is
// unreachable and even on a machine that has never self-updated.
const AGENT_VERSION = '2026.08.05-5';
// Where self-update pulls new code from. Overridable for testing; the default is
// the public repo, fetched with no credentials on purpose (see modules.txt).
const REPO_RAW_BASE = process.env.REPO_RAW_BASE || 'https://raw.githubusercontent.com/annabuies/es-mini-agent/main';

const PORT = parseInt(process.env.PORT || '8787', 10);
const RECORD_CONTROL_KEY = process.env.RECORD_CONTROL_KEY;
const BUILDING_ID = process.env.BUILDING_ID;
// Optional: outbound poll target. Defaults to the app's stable public URL so
// Robbie's existing install command (which only sets BUILDING_ID and
// RECORD_CONTROL_KEY) keeps working unchanged after this update.
const RECORD_POLL_URL = process.env.RECORD_POLL_URL || 'https://es-os-app.vercel.app';
const POLL_INTERVAL_MS = 1000;
const SOURCES_REFRESH_MS = 60000;
const PREVIEW_INTERVAL_MS = 500;
const PREVIEW_TTL_MS = 60000;
const PREVIEW_WIDTH = 640;
const PREVIEW_JPEG_QUALITY = 60;
const OBS_WS_URL = process.env.OBS_WS_URL || 'ws://127.0.0.1:4455';
const OBS_WS_PASSWORD = process.env.OBS_WS_PASSWORD || '';
const OBS_SOURCES_RAW = process.env.OBS_SOURCES || '';
let activeSources = OBS_SOURCES_RAW.split(',').map((v) => v.trim()).filter(Boolean);
const OBS_RECORD_DIR = process.env.OBS_RECORD_DIR || '';
const OBS_ENABLED = !!(OBS_SOURCES_RAW && OBS_SOURCES_RAW.trim());
const OBS_MODE_ACTIVE = OBS_ENABLED && activeSources.length > 0;
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
const state = { recording: false, paused: false, recordingStartedAt: null, sources: null };
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
let pendingSources = null;

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
    stateDir: path.join(__dirname, '.r2-uploads'),
    isRecording: () => state.recording,
    webhookUrl: () => activeWebhookUrl,
    buildingId: BUILDING_ID,
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
        const signed = signR2Request({
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
  if (!Number.isInteger(index) || index < 0 || index >= activeSources.length) {
    return { ok: false, reason: 'camera_unavailable' };
  }
  if (!cloudflarePreviewOwnsStream || !cloudflarePreviewOverlay) {
    return { ok: false, reason: 'preview_not_active' };
  }

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
    return { ok: true, preview: true, source: activeSources[index], camera: index + 1 };
  } catch (e) {
    return { ok: false, reason: 'camera_switch_failed', detail: truncateDetail(e && (e.message || e)) };
  }
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

async function stopCloudflarePreview() {
  if (cloudflarePreviewTimer) {
    clearInterval(cloudflarePreviewTimer);
    cloudflarePreviewTimer = null;
  }
  const inputUid = cloudflarePreviewInputUid;
  const owned = cloudflarePreviewOwnsStream;
  cloudflarePreviewOwnsStream = false;
  cloudflarePreviewInputUid = null;
  cloudflarePreviewPlaybackUrl = null;
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

async function startCloudflarePreview(config) {
  const inputUid = config && typeof config.inputUid === 'string' ? config.inputUid.trim() : '';
  const publishUrl = config && typeof config.publishUrl === 'string' ? config.publishUrl.trim() : '';
  const playbackUrl = config && typeof config.playbackUrl === 'string' ? config.playbackUrl.trim() : '';
  const reuse = !!(config && config.reuse === true);
  const validIdentity = validCloudflareInputUid(inputUid)
    && validCloudflareWebRtcUrl(playbackUrl, '/webRTC/play');

  if (cloudflarePreviewOwnsStream) {
    try {
      const client = await getObsClient();
      const current = await client.request('GetStreamStatus');
      if (obsRequestSucceeded(current) && current.responseData && current.responseData.outputActive) {
        // A keepalive can race with creation of a replacement input. Keep the
        // stream we own and ask the relay to delete the unused candidate.
        return {
          stream: { inputUid: cloudflarePreviewInputUid, playbackUrl: cloudflarePreviewPlaybackUrl },
          cleanupInputUid: validIdentity && inputUid !== cloudflarePreviewInputUid ? inputUid : null,
        };
      }
    } catch (_) { /* clear the stale state and start again below */ }
    const staleInputUid = cloudflarePreviewInputUid;
    cloudflarePreviewOwnsStream = false;
    cloudflarePreviewInputUid = null;
    cloudflarePreviewPlaybackUrl = null;
    if (staleInputUid) await requestCloudflareCleanup(staleInputUid);
  }

  if (!validIdentity || reuse || !validCloudflareWebRtcUrl(publishUrl, '/webRTC/publish')) {
    return { stream: null, cleanupInputUid: !reuse && validIdentity ? inputUid : null };
  }

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
        && validCloudflareWebRtcUrl(server, '/webRTC/publish');
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
    }

    await removeStaleCloudflarePreviewScenes(client);
    cloudflarePreviewCameraIndex = Math.min(cloudflarePreviewCameraIndex, activeSources.length - 1);
    await createCloudflarePreviewOverlay(client);

    const configured = await client.request('SetStreamServiceSettings', {
      streamServiceType: 'whip_custom',
      streamServiceSettings: {
        server: publishUrl,
        // Cloudflare authenticates with the secret embedded in the WHIP URL.
        // Clear any bearer left by a previous IVS configuration.
        bearer_token: '',
      },
    });
    if (!obsRequestSucceeded(configured)) throw new Error('obs_whip_config_rejected');

    const started = await client.request('StartStream');
    if (!obsRequestSucceeded(started)) throw new Error('obs_stream_start_rejected');
    cloudflarePreviewOwnsStream = true;
    cloudflarePreviewInputUid = inputUid;
    cloudflarePreviewPlaybackUrl = playbackUrl;
    console.log('[es-mini-agent] [preview] Cloudflare WebRTC stream started');
    if (!cloudflarePreviewTimer) {
      cloudflarePreviewTimer = setInterval(() => {
        if (Date.now() > previewUntil) void stopCloudflarePreview();
      }, 5000);
    }
    return { stream: { inputUid, playbackUrl }, cleanupInputUid: null };
  } catch (e) {
    const error = truncateDetail(e && (e.message || e));
    if (cloudflarePreviewOverlay) {
      try {
        const client = await getObsClient();
        await removeCloudflarePreviewOverlay(client);
      } catch (_) {}
    }
    maybeWarnPreview('Cloudflare preview start failed: ' + error);
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

function sessionSources() {
  return (state.recording && Array.isArray(state.sources) && state.sources.length) ? state.sources : activeSources;
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

async function handleOp(op, body) {
  if (!OBS_MODE_ACTIVE) {
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
    if (op === 'cancel') {
      state.recording = false;
      state.paused = false;
      return { ok: true, cancelled: true, saved: false };
    }
    if (op === 'status') {
      return { ok: true, recording: state.recording, feeds_writing: null, preview: false };
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
      return { ok: true, preview: false };
    }
    if (op === 'diag') {
      return {
        ok: true,
        demo: true,
        recording: state.recording,
        stats: null,
        filters: null,
        version: getVersionBlock({ projectDir: __dirname, agentVersion: AGENT_VERSION }),
      };
    }
    if (op === 'audio_bind') {
      return { ok: true, demo: true, bound: false, reason: 'demo_mode' };
    }
    if (op === 'update') {
      return await performUpdate();
    }
    return null;
  }

  if (op === 'start') {
    if (state.recording) {
      return { ok: true, recording: true, feeds_writing: null, already: true };
    }
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

    const startResults = await Promise.all(startingSources.map(async (source) => {
      const vendor = await callVendor(client, 'record_start', source);
      return { source, vendor };
    }));
    const failed = startResults.find((entry) => !entry.vendor.success);
    if (failed) {
      const detail = failed.source + ': ' + (failed.vendor.error || 'unknown_error');
      return { ok: false, reason: 'obs_start_failed', detail: truncateDetail(detail) };
    }

    feedsPrevSamples = new Map();
    state.recording = true;
    state.paused = false;
    state.recordingStartedAt = Date.now();
    state.sources = startingSources;
    return { ok: true, recording: true, feeds_writing: null };
  }
  if (op === 'stop') {
    const sources = sessionSources();
    let response = { ok: true, saved: false };
    try {
      let stopResults;
      try {
        const client = await getObsClient();
        stopResults = await Promise.all(sources.map(async (source) => {
          const vendor = await callVendor(client, 'record_stop', source);
          return { source, vendor };
        }));
      } catch (e) {
        stopResults = sources.map((source) => ({
          source,
          vendor: { success: false, error: e && (e.message || String(e)) || 'obs_stop_error' },
        }));
      }

      let filesStable = false;
      if (OBS_RECORD_DIR) {
        let prevSample = sampleFeedsWriting(sources, OBS_RECORD_DIR, new Map()).samples;
        for (let i = 0; i < 4; i += 1) {
          await sleep(900);
          const newSample = sampleFeedsWriting(sources, OBS_RECORD_DIR, prevSample).samples;
          if (sources.every((source) => didSourceFileStabilize(prevSample, newSample, source))) {
            filesStable = true;
            prevSample = newSample;
            break;
          }
          prevSample = newSample;
        }
        feedsPrevSamples = prevSample;
      } else {
        await sleep(1200);
      }

      const allStopsSucceeded = stopResults.every((entry) => entry.vendor.success);
      const saved = allStopsSucceeded && filesStable;
      const recordingStartedAt = state.recordingStartedAt;
      let uploadQueued = 0;

      if (uploadQueue && OBS_RECORD_DIR) {
        if (!recordingStartedAt) {
          console.warn('[es-mini-agent] upload skipped: unknown recording start');
        } else {
          for (const source of sources) {
            try {
              const sourceDir = path.join(OBS_RECORD_DIR, source);
              const newest = getNewestFileSample(sourceDir);
              if (!newest || !newest.absPath) continue;
              if (newest.mtimeMs < (recordingStartedAt - 60000)) continue;
              const out = uploadQueue.enqueue({ filePath: newest.absPath, source });
              if (out && out.queued) uploadQueued += 1;
            } catch (e) {
              console.warn('[es-mini-agent] upload enqueue failed source=' + source + ':', e && (e.stack || e.message || e));
            }
          }
        }
      }

      response = { ok: true, saved };
      if (uploadQueue) response.upload_queued = uploadQueued;
    } finally {
      state.recording = false;
      state.paused = false;
      state.recordingStartedAt = null;
      state.sources = null;
      if (pendingSources) {
        applySources(pendingSources);
      }
    }
    return response;
  }
  if (op === 'cancel') {
    const sources = sessionSources();
    try {
      let stopResults;
      try {
        const client = await getObsClient();
        stopResults = await Promise.all(sources.map(async (source) => {
          const vendor = await callVendor(client, 'record_stop', source);
          return { source, vendor };
        }));
      } catch (e) {
        stopResults = sources.map((source) => ({
          source,
          vendor: { success: false, error: e && (e.message || String(e)) || 'obs_stop_error' },
        }));
      }

      if (OBS_RECORD_DIR) {
        let prevSample = sampleFeedsWriting(sources, OBS_RECORD_DIR, new Map()).samples;
        for (let i = 0; i < 4; i += 1) {
          await sleep(900);
          const newSample = sampleFeedsWriting(sources, OBS_RECORD_DIR, prevSample).samples;
          if (sources.every((source) => didSourceFileStabilize(prevSample, newSample, source))) {
            prevSample = newSample;
            break;
          }
          prevSample = newSample;
        }
        feedsPrevSamples = prevSample;
      } else {
        await sleep(1200);
      }

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
      if (pendingSources) {
        applySources(pendingSources);
      }
    }
  }
  if (op === 'status') {
    const sources = sessionSources();
    if (!state.recording) {
      const out = { ok: true, recording: false, feeds_writing: 0, preview: previewActive(), sources: sources.slice() };
      if (uploadQueue) out.uploads = uploadQueue.status();
      return out;
    }
    const sampled = sampleFeedsWriting(sources, OBS_RECORD_DIR, feedsPrevSamples);
    feedsPrevSamples = sampled.samples;
    const out = { ok: true, recording: true, feeds_writing: sampled.count, preview: previewActive(), sources: sources.slice() };
    if (uploadQueue) out.uploads = uploadQueue.status();
    return out;
  }
  if (op === 'diag') {
    const out = { ok: true, demo: false, recording: state.recording, stats: null, filters: null };
    out.storage = {
      bucket: STORAGE_BUCKET,
      region: STORAGE_REGION,
      endpointHost: endpointHostnameOnly(STORAGE_ENDPOINT),
      credentials: storageCredentialsProvider.describeCredentials(),
    };
    out.ffmpeg = resolveFfmpegBin();
    // Sits alongside storage/ffmpeg deliberately: all three are assigned before
    // the OBS call below, so they still come back on a machine whose OBS is down.
    out.version = getVersionBlock({ projectDir: __dirname, agentVersion: AGENT_VERSION });

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
    return out;
  }
  if (op === 'audio_bind') {
    let audioInput = null;
    try {
      if (state.recording) {
        return { ok: false, reason: 'busy_recording' };
      }

      let client;
      try {
        client = await getObsClient();
      } catch (e) {
        return { ok: true, bound: false, error: 'obs_unreachable' };
      }

      const inputRes = await client.request('GetInputList');
      const inputData = inputRes && inputRes.responseData;
      const inputs = inputData && inputData.inputs;
      if (!Array.isArray(inputs)) {
        return { ok: true, bound: false, error: 'input_list_failed' };
      }
      const allInputs = inputs.map((i) => ({
        name: i && typeof i.inputName !== 'undefined' ? i.inputName : null,
        kind: i && typeof i.inputKind !== 'undefined' ? i.inputKind : null,
      }));
      const inputNames = new Set(allInputs
        .map((i) => i.name)
        .filter((name) => typeof name === 'string'));

      let defaults = null;
      try {
        const defaultsRes = await client.request('GetSourceFilterDefaultSettings', { filterKind: 'source_record_filter' });
        const defaultsData = defaultsRes && defaultsRes.responseData;
        const maybeDefaults = defaultsData && defaultsData.defaultFilterSettings;
        if (maybeDefaults && typeof maybeDefaults === 'object') {
          defaults = maybeDefaults;
        }
      } catch (_) {
        defaults = null;
      }

      const candidates = allInputs.filter((i) => (
        !activeSources.includes(i.name)
        && typeof i.kind === 'string'
        && i.kind.includes('input_capture')
      ));
      if (candidates.length !== 1) {
        return {
          ok: true,
          bound: false,
          reason: candidates.length === 0 ? 'no_audio_input_found' : 'ambiguous_audio_input',
          candidates,
          inputs: allInputs,
          defaults,
        };
      }

      audioInput = { name: candidates[0].name, muted: null, volumeDb: null, settings: null, devices: null };
      try {
        const muteRes = await client.request('GetInputMute', { inputName: candidates[0].name });
        const m = muteRes && muteRes.responseData;
        if (m && typeof m.inputMuted === 'boolean') audioInput.muted = m.inputMuted;
      } catch (_) {}
      try {
        const volRes = await client.request('GetInputVolume', { inputName: candidates[0].name });
        const v = volRes && volRes.responseData;
        if (v && typeof v.inputVolumeDb === 'number') audioInput.volumeDb = v.inputVolumeDb;
      } catch (_) {}
      try {
        const settingsRes = await client.request('GetInputSettings', { inputName: candidates[0].name });
        const s = settingsRes && settingsRes.responseData;
        if (s && s.inputSettings && typeof s.inputSettings === 'object') {
          audioInput.settings = s.inputSettings;
        }
      } catch (_) {}
      try {
        const devicesRes = await client.request('GetInputPropertiesListPropertyItems', {
          inputName: candidates[0].name,
          propertyName: 'device_id',
        });
        const d = devicesRes && devicesRes.responseData;
        if (d && Array.isArray(d.propertyItems)) {
          audioInput.devices = d.propertyItems.map((item) => ({
            name: item && typeof item.itemName !== 'undefined' ? item.itemName : null,
            value: item && typeof item.itemValue !== 'undefined' ? item.itemValue : null,
            enabled: !!(item && item.itemEnabled),
          }));
        }
      } catch (_) {}
      // OBS can retain a CoreAudio device id after that interface has been
      // unplugged. It then exposes a nominal, unmuted Mic/Aux source carrying
      // only noise/silence. Repair only this provable stale-device case, and
      // only to the studio's explicitly named main RODECaster program feed.
      const selectedDeviceId = audioInput.settings && audioInput.settings.device_id;
      const selectedDeviceAvailable = typeof selectedDeviceId === 'string'
        && Array.isArray(audioInput.devices)
        && audioInput.devices.some((device) => device.enabled && device.value === selectedDeviceId);
      const preferredDevice = Array.isArray(audioInput.devices)
        ? audioInput.devices.find((device) => device.enabled && device.name === 'RODECaster Video Stereo')
        : null;
      if (selectedDeviceId && !selectedDeviceAvailable && preferredDevice && preferredDevice.value) {
        const setInputRes = await client.request('SetInputSettings', {
          inputName: candidates[0].name,
          inputSettings: { device_id: preferredDevice.value },
          overlay: true,
        });
        if (!obsRequestSucceeded(setInputRes)) {
          return { ok: false, bound: false, reason: 'audio_device_repair_rejected', audioInput };
        }
        audioInput.deviceRepaired = true;
        audioInput.previousDeviceId = selectedDeviceId;
        try {
          const readInputRes = await client.request('GetInputSettings', { inputName: candidates[0].name });
          const readInput = readInputRes && readInputRes.responseData;
          if (readInput && readInput.inputSettings && typeof readInput.inputSettings === 'object') {
            audioInput.settings = readInput.inputSettings;
          }
        } catch (_) {}
      } else {
        audioInput.deviceRepaired = false;
      }

      const keysWritten = { different_audio: true, audio_source: candidates[0].name, audio_track: 1 };

      const cameras = [];
      for (const source of activeSources) {
        try {
          const filterListRes = await client.request('GetSourceFilterList', { sourceName: source });
          const filterListData = filterListRes && filterListRes.responseData;
          const filters = filterListData && filterListData.filters;
          if (!Array.isArray(filters)) {
            cameras.push({ source, error: 'no_source_record_filter' });
            continue;
          }
          const sourceRecordFilter = filters.find((f) => f && f.filterKind === 'source_record_filter');
          const filterName = sourceRecordFilter && sourceRecordFilter.filterName;
          if (!filterName) {
            cameras.push({ source, error: 'no_source_record_filter' });
            continue;
          }

          const currentRes = await client.request('GetSourceFilter', { sourceName: source, filterName });
          const currentData = currentRes && currentRes.responseData;
          const currentSettings = currentData && currentData.filterSettings;
          const currentEncoder = currentSettings && currentSettings.audio_encoder;
          const repaired = (typeof currentEncoder === 'string') && inputNames.has(currentEncoder);

          const newSettings = Object.assign({}, keysWritten);
          if (repaired) {
            newSettings.audio_encoder = (defaults && typeof defaults.audio_encoder === 'string') ? defaults.audio_encoder : '';
          }

          await client.request('SetSourceFilterSettings', {
            sourceName: source,
            filterName,
            filterSettings: newSettings,
            overlay: true,
          });
          const readBackRes = await client.request('GetSourceFilter', { sourceName: source, filterName });
          const readBackData = readBackRes && readBackRes.responseData;
          const readBackSettings = readBackData && readBackData.filterSettings;
          cameras.push({ source, filter: filterName, wrote: newSettings, readBack: readBackSettings, repaired });
        } catch (e) {
          cameras.push({ source, error: 'set_failed', detail: truncateDetail(e && (e.message || e)) });
        }
      }

      return {
        ok: true,
        bound: true,
        audioSource: candidates[0].name,
        audioInput,
        keysWritten,
        inputs: allInputs,
        candidates,
        defaults,
        cameras,
      };
    } catch (e) {
      return { ok: false, reason: 'audio_bind_exception', detail: truncateDetail(e && (e.message || e)), audioInput };
    }
  }
  if (op === 'pause') {
    if (!state.recording) {
      console.warn(`[es-mini-agent] WARN: pause called while not recording (demo-safe: returning ok).`);
    }

    try {
      const client = await getObsClient();
      const pauseResults = await Promise.all(sessionSources().map((source) => callVendor(client, 'record_pause', source)));
      const failed = pauseResults.find((result) => !result.success);
      if (failed) {
        console.warn('[es-mini-agent] WARN: OBS pause vendor call failed:', failed.error || 'vendor_error');
      }
    } catch (e) {
      console.warn('[es-mini-agent] WARN: OBS pause connect/request failed:', e && (e.message || e));
    }

    state.paused = true;
    return { ok: true, paused: true };
  }
  if (op === 'resume') {
    try {
      const client = await getObsClient();
      const resumeResults = await Promise.all(sessionSources().map((source) => callVendor(client, 'record_unpause', source)));
      const failed = resumeResults.find((result) => !result.success);
      if (failed) {
        console.warn('[es-mini-agent] WARN: OBS resume vendor call failed:', failed.error || 'vendor_error');
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
    return await selectCloudflarePreviewCamera(previewCameraIndex);
  }
  if (op === 'preview_start') {
    previewUntil = Date.now() + PREVIEW_TTL_MS;
    const realtime = await startCloudflarePreview(body && body.cloudflare);
    if (realtime.stream) {
      if (previewTimer) {
        clearInterval(previewTimer);
        previewTimer = null;
      }
      return {
        ok: true,
        preview: true,
        stream_mode: 'cloudflare',
        stream: realtime.stream,
        cleanup_input_uid: realtime.cleanupInputUid,
        sources: activeSources.slice(),
      };
    }
    if (!isStorageConfigured()) {
      return { ok: false, reason: 'r2_unconfigured', cleanup_input_uid: realtime.cleanupInputUid };
    }
    if (!previewTimer) {
      previewTimer = setInterval(pushPreviewFrames, PREVIEW_INTERVAL_MS);
      console.log('[es-mini-agent] [preview] started');
    }
    return {
      ok: true,
      preview: true,
      cleanup_input_uid: realtime.cleanupInputUid,
      stream_error: realtime.error || null,
      sources: activeSources.slice(),
    };
  }
  if (op === 'preview_stop') {
    previewUntil = 0;
    const cleanupInputUid = await stopCloudflarePreview();
    cloudflarePreviewCameraIndex = 0;
    if (previewTimer) {
      clearInterval(previewTimer);
      previewTimer = null;
      console.log('[es-mini-agent] [preview] stopped');
    }
    return { ok: true, preview: false, cleanup_input_uid: cleanupInputUid };
  }
  if (op === 'update') {
    return await performUpdate();
  }
  return null;
}

const VALID_OPS = new Set(['start', 'stop', 'cancel', 'status', 'pause', 'resume', 'preview_start', 'preview_stop', 'preview_cam1', 'preview_cam2', 'preview_cam3', 'diag', 'audio_bind', 'update']);

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

// ---------- outbound poll loop ----------
// Reach OUT to the Vercel app every POLL_INTERVAL_MS to claim any pending
// command, run it locally via handleOp(), and POST the result back. This
// replaces the old inbound cloudflared quick-tunnel path — no inbound port
// exposure needed from this Mac. The inbound handler above is left intact
// (harmless without a tunnel) so nothing that used to work is broken.
let polling = false;
let pollTimer = null;
let sourcesTimer = null;

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

async function pollOnce() {
  if (polling) return; // network calls are async — belt-and-suspenders reentry guard
  polling = true;
  try {
    const url = `${RECORD_POLL_URL}/api/record?building_id=${encodeURIComponent(BUILDING_ID)}`;
    const getRes = await fetch(url, {
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + RECORD_CONTROL_KEY },
    });
    if (!getRes.ok) {
      // 401/5xx from Vercel — log once per tick and move on. Do not crash.
      console.warn(`[es-mini-agent] relay: poll GET ${getRes.status} from ${RECORD_POLL_URL}`);
      return;
    }
    const data = await getRes.json().catch(() => ({}));
    const cmd = data && data.command;
    if (!cmd || !cmd.id || !cmd.op) return; // nothing to do — stay quiet to keep agent.log readable

    const result = await handleOp(cmd.op, (cmd.payload && typeof cmd.payload === 'object') ? cmd.payload : {});
    if (result == null) {
      console.warn(`[es-mini-agent] relay: unknown op '${cmd.op}' (id=${cmd.id}) — skipping result post`);
      return;
    }

    const postRes = await fetch(`${RECORD_POLL_URL}/api/record`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + RECORD_CONTROL_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ mini_result: true, id: cmd.id, ok: !!result.ok, result }),
    });
    if (!postRes.ok) {
      console.warn(`[es-mini-agent] relay: result POST ${postRes.status} for ${cmd.op} (${cmd.id})`);
      return;
    }
    console.log(`[es-mini-agent] relay: claimed ${cmd.op} (${cmd.id}) -> posted result`);
  } catch (e) {
    // Network hiccup, DNS blip, JSON parse — never crash the process.
    console.error('[es-mini-agent] relay: poll error:', e && (e.stack || e.message || e));
  } finally {
    polling = false;
  }
}

server.listen(PORT, () => {
  console.log(`[es-mini-agent] listening on :${PORT} building_id=${BUILDING_ID}`);
  console.log(`[es-mini-agent] relay: polling ${RECORD_POLL_URL}/api/record every ${POLL_INTERVAL_MS}ms`);
  console.log('[es-mini-agent] sources (env): ' + activeSources.join(','));
  pollTimer = setInterval(pollOnce, POLL_INTERVAL_MS);
  if (OBS_MODE_ACTIVE) {
    sourcesTimer = setInterval(refreshSources, SOURCES_REFRESH_MS);
    refreshSources().catch(() => {});
  }
  if (uploadQueue) {
    uploadQueue.sweep().catch((e) => {
      console.warn('[es-mini-agent] upload queue sweep failed:', e && (e.stack || e.message || e));
    });
  }
});

function shutdown(signal) {
  console.log(`[es-mini-agent] ${signal} received, closing server...`);
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (sourcesTimer) {
    clearInterval(sourcesTimer);
    sourcesTimer = null;
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
