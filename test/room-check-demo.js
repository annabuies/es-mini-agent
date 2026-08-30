'use strict';

const { calibrate, captureReference, roomCheck } = require('../room-check');

async function main() {
  const uploads = [];
  let positionCalls = 0;
  const state = {
    recording: false,
    paused: false,
    cameras: [{ name: 'cam1', host: 'fake-camera' }],
    looks: { '2': { cam1: 1 } },
    check_look: '2',
    camera_profiles: {
      cam1: {
        cgi: { bright: 7, saturation: 7, contrast: 7, sharpness: 7, hue: 7, flip: 0, mirror: 0, aemode: 'auto', wbmode: 'manual' },
        visca: { wbmode: 5, rgain: 128, bgain: 96, aemode: 0 },
      },
    },
    reference_frames: { cam1: { '2': { key: 'reference/bench-1/cam1/2.jpg' } } },
    upcoming: null,
  };
  const readback = { pan: 1234, tilt: -56, zoom: 2048, wbmode: 5, rgain: 128, bgain: 96, aemode: 0 };
  const ctx = {
    state,
    buildingId: 'bench-1',
    obs_sources: ['cam1'],
    now: () => new Date('2026-08-30T12:00:00.000Z'),
    sleep: async () => {},
    resetSettleMs: 0,
    resetSettleCapMs: 10,
    resetPollMs: 1,
    recallSettleMs: 0,
    ffmpegBin: '/fake/ffmpeg',
    ssimMin: 0.80,
    ptz: {
      probe: async () => 'ok',
      panTiltReset: async () => 'ok',
      applyCgiProfile: async () => ({ status: 'ok', failures: [] }),
      recall: async () => 'ok',
      snapshot: async () => Buffer.from('fake-current-jpeg'),
    },
    visca: {
      getPanTilt: async () => {
        positionCalls += 1;
        return positionCalls === 1 ? { pan: 0, tilt: 0 } : { pan: 1234, tilt: -56 };
      },
      applyProfile: async () => ({ status: 'ok', failures: [] }),
      readState: async () => readback,
    },
    storage: {
      upload: async (key) => { uploads.push(key); },
      download: async () => Buffer.from('fake-reference-jpeg'),
    },
    compareFrames: async () => 0.93,
    getObsClient: async () => ({ request() {} }),
    getSourceScreenshot: async () => Buffer.from('fake-obs-jpeg'),
  };

  const calibration = await calibrate(ctx, { trigger: 'queued' });
  const check = await roomCheck(ctx, { trigger: 'queued' });
  const capture = await captureReference(ctx, { trigger: 'queued', look: '2' });
  process.stdout.write(JSON.stringify({
    mode: 'room_self_check_fakes',
    building_id: 'bench-1',
    calibrate: calibration,
    room_check: check,
    capture_reference: capture,
    uploads,
  }, null, 2) + '\n');
}

main().catch((error) => {
  console.error(error && (error.stack || error));
  process.exitCode = 1;
});
