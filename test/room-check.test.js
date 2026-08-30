'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const { resolveFfmpegBin } = require('../upload-queue');
const {
  calibrate,
  captureReference,
  compareFrames,
  roomCheck,
  scheduleDecision,
  shouldBootCalibrate,
  updateCameraHealth,
} = require('../room-check');

function baseContext(overrides) {
  const state = {
    recording: false,
    paused: false,
    cameras: [
      { name: 'cam1', host: 'cam1.test' },
      { name: 'cam2', host: 'cam2.test' },
    ],
    looks: { '2': { cam1: 1 } },
    check_look: '2',
    camera_profiles: {
      cam1: { cgi: { bright: 7 }, visca: { wbmode: 5, rgain: 128, bgain: 96, aemode: 0 } },
      cam2: { cgi: { bright: 7 } },
    },
    reference_frames: {},
    upcoming: null,
  };
  return {
    state,
    buildingId: 'bench-1',
    obs_sources: ['cam1', 'cam2'],
    sleep: async () => {},
    resetSettleMs: 0,
    resetSettleCapMs: 5,
    resetPollMs: 1,
    recallSettleMs: 0,
    ssimMin: 0.80,
    storage: {
      upload: async () => ({ ok: true }),
      download: async () => Buffer.from('reference-frame'),
    },
    getObsClient: async () => ({ request() {} }),
    getSourceScreenshot: async () => Buffer.from('obs-frame'),
    ...overrides,
  };
}

test('calibrate resets and profiles every camera but recalls only mapped cameras last', async () => {
  const events = { 'cam1.test': [], 'cam2.test': [] };
  const positions = new Map();
  const ptz = {
    probe: async (host) => { events[host].push('probe'); return 'ok'; },
    panTiltReset: async (host) => { events[host].push('reset'); return 'ok'; },
    applyCgiProfile: async (host) => { events[host].push('cgi_profile'); return { status: 'ok', failures: [] }; },
    recall: async (host, preset) => { events[host].push(`recall:${preset}`); return 'ok'; },
  };
  const visca = {
    getPanTilt: async (host) => {
      events[host].push('position');
      const count = positions.get(host) || 0;
      positions.set(host, count + 1);
      return count === 0 ? { pan: 0, tilt: 0 } : { pan: 1, tilt: 1 };
    },
    applyProfile: async (host, profile) => {
      events[host].push('visca_profile');
      return profile ? { status: 'ok', failures: [] } : { status: 'skipped', failures: [] };
    },
    readState: async (host) => { events[host].push('readback'); return { pan: 1, tilt: 1, zoom: 2, wbmode: 5 }; },
  };
  const result = await calibrate(baseContext({ ptz, visca }), { trigger: 'boot' });

  assert.equal(result.ok, true);
  assert.equal(result.trigger, 'boot');
  assert.equal(result.cameras.cam1.recall, 'ok');
  assert.equal(result.cameras.cam2.recall, 'skipped');
  for (const host of Object.keys(events)) {
    assert.ok(events[host].indexOf('reset') > events[host].indexOf('probe'));
    assert.ok(events[host].indexOf('cgi_profile') > events[host].indexOf('reset'));
    assert.ok(events[host].indexOf('visca_profile') > events[host].indexOf('cgi_profile'));
    assert.ok(events[host].indexOf('readback') > events[host].indexOf('visca_profile'));
  }
  assert.ok(events['cam1.test'].indexOf('recall:1') > events['cam1.test'].indexOf('visca_profile'));
});

test('calibrate and room_check return every required refusal reason', async () => {
  const contexts = [
    [baseContext({ state: { ...baseContext().state, recording: true } }), 'busy_recording'],
    [baseContext({ state: { ...baseContext().state, paused: true } }), 'busy_recording'],
    [baseContext({ state: { ...baseContext().state, cameras: [] } }), 'no_cameras'],
    [baseContext({ state: { ...baseContext().state, check_look: null } }), 'no_check_look'],
    [baseContext({ state: { ...baseContext().state, check_look: '9' } }), 'unknown_look'],
    [baseContext({
      state: {
        ...baseContext().state,
        upcoming: {
          access_from: '2026-08-30T10:00:00.000Z',
          access_until: '2026-08-30T11:00:00.000Z',
        },
      },
      now: () => new Date('2026-08-30T10:30:00.000Z'),
    }), 'booking_active'],
  ];
  for (const [ctx, reason] of contexts) {
    assert.equal((await calibrate(ctx, {})).reason, reason);
    assert.equal((await roomCheck(ctx, {})).reason, reason);
  }
});

test('room_check passes CGI-only cameras when VISCA is silent and warns on a missing reference', async () => {
  const uploads = [];
  const ctx = baseContext({
    state: {
      ...baseContext().state,
      reference_frames: { cam1: { '2': { key: 'reference/bench-1/cam1/2.jpg' } } },
    },
    ptz: {
      probe: async () => 'ok',
      recall: async () => 'ok',
      snapshot: async (host) => Buffer.from(`jpeg:${host}`),
    },
    visca: { readState: async () => 'unavailable' },
    storage: {
      upload: async (key) => { uploads.push(key); },
      download: async () => Buffer.from('reference-frame'),
    },
    compareFrames: async () => 0.91,
    ffmpegBin: '/fake/ffmpeg',
  });
  const result = await roomCheck(ctx, { trigger: 'schedule', booking_id: 'booking-1' });

  assert.equal(result.ok, true);
  assert.equal(result.booking_id, 'booking-1');
  assert.equal(result.cameras.cam1.ssim, 0.91);
  assert.equal(result.cameras.cam1.frame_ok, true);
  assert.equal(result.cameras.cam1.readback_match, null);
  assert.equal(result.cameras.cam2.frame_ok, null);
  assert.equal(result.cameras.cam2.ok, true);
  assert.deepEqual(result.warnings.sort(), [
    'cam1:readback_unavailable',
    'cam2:no_readback_profile',
    'cam2:no_reference',
  ]);
  assert.deepEqual(uploads.sort(), [
    'roomcheck/bench-1/cam1/2.jpg',
    'roomcheck/bench-1/cam2/2.jpg',
  ]);
});

test('room_check queries stored OBS names and maps their ordered verdicts to cameras', async () => {
  const queriedSources = [];
  const ctx = baseContext({
    obs_sources: ['PTZOPTICS', 'Camera Two'],
    ptz: {
      probe: async () => 'ok',
      recall: async () => 'ok',
      snapshot: async () => Buffer.from('jpeg'),
    },
    visca: { readState: async () => 'unavailable' },
    getSourceScreenshot: async (_client, source) => {
      queriedSources.push(source);
      return Buffer.from('obs-frame');
    },
  });
  const result = await roomCheck(ctx, {});

  assert.equal(result.ok, true);
  assert.deepEqual(queriedSources.sort(), ['Camera Two', 'PTZOPTICS']);
  assert.deepEqual(result.obs_sources, { PTZOPTICS: 'ok', 'Camera Two': 'ok' });
  assert.equal(result.cameras.cam1.obs_feed, 'ok');
  assert.equal(result.cameras.cam2.obs_feed, 'ok');
});

test('room_check fails honestly when framing or VISCA profile differs', async () => {
  const ctx = baseContext({
    state: {
      ...baseContext().state,
      cameras: [{ name: 'cam1', host: 'cam1.test' }],
      reference_frames: { cam1: { '2': { key: 'reference/bench-1/cam1/2.jpg' } } },
    },
    ptz: { probe: async () => 'ok', recall: async () => 'ok', snapshot: async () => Buffer.from('jpeg') },
    visca: { readState: async () => ({ wbmode: 5, rgain: 100, bgain: 96, aemode: 0 }) },
    compareFrames: async () => 0.50,
    ffmpegBin: '/fake/ffmpeg',
  });
  const result = await roomCheck(ctx, {});
  assert.equal(result.ok, false);
  assert.equal(result.cameras.cam1.frame_ok, false);
  assert.equal(result.cameras.cam1.readback_match, false);
  assert.deepEqual(result.cameras.cam1.diffs, { rgain: { expected: 128, actual: 100 } });
});

test('capture_reference returns storage and camera-profile fragments for every look', async () => {
  const uploads = [];
  const ctx = baseContext({
    state: {
      ...baseContext().state,
      cameras: [{ name: 'cam1', host: 'cam1.test' }],
      looks: { '1': { cam1: 4 }, '2': { cam1: 1 } },
      camera_profiles: { cam1: { cgi: { bright: 7 } } },
    },
    now: () => new Date('2026-08-30T12:00:00.000Z'),
    ptz: {
      probe: async () => 'ok',
      recall: async () => 'ok',
      snapshot: async () => Buffer.from('jpeg'),
    },
    visca: {
      readState: async () => ({ pan: 1234, tilt: -56, zoom: 2048, wbmode: 5, rgain: 128, bgain: 96 }),
    },
    storage: { upload: async (key) => { uploads.push(key); } },
  });
  const result = await captureReference(ctx, { trigger: 'queued' });

  assert.equal(result.ok, true);
  assert.deepEqual(result.looks, ['1', '2']);
  assert.deepEqual(uploads, [
    'reference/bench-1/cam1/1.jpg',
    'reference/bench-1/cam1/2.jpg',
  ]);
  assert.deepEqual(result.reference_frames.cam1['2'], {
    key: 'reference/bench-1/cam1/2.jpg',
    captured_at: '2026-08-30T12:00:00.000Z',
    pan: 1234,
    tilt: -56,
    zoom: 2048,
  });
  assert.deepEqual(result.camera_profiles.cam1, {
    cgi: { bright: 7 },
    visca: { wbmode: 5, rgain: 128, bgain: 96 },
    captured_at: '2026-08-30T12:00:00.000Z',
    source: 'capture_reference',
  });
});

test('boot, reboot, and T-20 policies are deterministic and once-per-booking', () => {
  assert.equal(shouldBootCalibrate({ uptimeS: 30, thresholdS: 600 }), true);
  assert.equal(shouldBootCalibrate({ uptimeS: 90000, thresholdS: 600 }), false);
  const done = new Set();
  const upcoming = {
    id: 'booking-1',
    starts_at: '2026-08-30T12:20:00.000Z',
    access_from: '2026-08-30T12:05:00.000Z',
    access_until: '2026-08-30T13:30:00.000Z',
  };
  assert.equal(scheduleDecision({ now: '2026-08-30T12:01:00.000Z', upcoming, done }).action, 'run');
  done.add('booking-1');
  assert.equal(scheduleDecision({ now: '2026-08-30T12:02:00.000Z', upcoming, done }).action, 'done');
  assert.equal(scheduleDecision({
    now: '2026-08-30T12:10:00.000Z',
    upcoming: { ...upcoming, id: 'booking-2' },
    done,
  }).action, 'skip_inside_access');

  const first = updateCameraHealth(null, 'timeout', '2026-08-30T12:00:00.000Z');
  const second = updateCameraHealth(first.health, 'timeout', '2026-08-30T12:01:00.000Z');
  const recovered = updateCameraHealth(second.health, 'ok', '2026-08-30T12:02:00.000Z');
  assert.equal(first.recovered, false);
  assert.equal(second.health.failures, 2);
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.health.failures, 0);
});

test('real ffmpeg computes identical and shifted JPEG SSIM', async (t) => {
  const ffmpeg = resolveFfmpegBin().bin;
  try {
    if (!ffmpeg) throw new Error('no_ffmpeg');
    execFileSync(ffmpeg, ['-version'], { stdio: 'ignore' });
  } catch (_) {
    t.skip('skipped:no_ffmpeg');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-ssim-proof-'));
  const reference = path.join(dir, 'reference.jpg');
  const identical = path.join(dir, 'identical.jpg');
  const shifted = path.join(dir, 'shifted.jpg');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const render = (target, x) => execFileSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=0.1',
    '-vf', `drawbox=x=${x}:y=16:w=16:h=16:color=white:t=fill`, '-frames:v', '1', '-update', '1', target,
  ]);
  render(reference, 8);
  fs.copyFileSync(reference, identical);
  render(shifted, 32);

  const sameScore = await compareFrames(ffmpeg, reference, identical);
  const shiftedScore = await compareFrames(ffmpeg, reference, shifted);
  assert.ok(sameScore > 0.999);
  assert.ok(shiftedScore < sameScore);
});
