'use strict';

// Contract C1 (Mini side): there is ONE shared OBS preview stream, so the angle is the
// room's. Every preview_start / preview_cam1..3 / preview_stop result carries `camera`
// (integer 1-3, the angle actually in the stream, or null with no overlay active); the
// status result and the heartbeat state carry `preview_camera` with the same meaning.

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildHeartbeatState } = require('../heartbeat-state');
const { CF, VIEWER_KIOSK, VIEWER_PHONE, startAgent, waitFor } = require('./preview-harness');

test('camera follows the angle really enabled in the stream, on every preview result', { timeout: 30000 }, async (t) => {
  const agent = await startAgent(t);
  const early = await agent.poll('preview_cam2');
  assert.deepEqual({ ok: early.ok, reason: early.reason, camera: early.camera }, { ok: false, reason: 'preview_not_active', camera: null });
  assert.equal((await agent.op('status')).preview_camera, null);

  const started = await agent.op('preview_start', { viewer: VIEWER_KIOSK, cloudflare: CF });
  assert.equal(started.camera, 1);
  assert.deepEqual(agent.obs.enabledSources(), ['cam1']);

  const cam2 = await agent.poll('preview_cam2');
  assert.equal(cam2.ok, true);
  assert.equal(cam2.camera, 2);
  assert.deepEqual(agent.obs.enabledSources(), ['cam2'], 'the label is the picture');
  assert.equal((await agent.op('status')).preview_camera, 2);

  const cam3 = await agent.poll('preview_cam3');
  assert.equal(cam3.camera, 3);
  // Another viewer's keepalive and a viewer leaving both report the room's angle.
  const phone = await agent.op('preview_start', { viewer: VIEWER_PHONE, cloudflare: { ...CF, reuse: true } });
  assert.equal(phone.camera, 3);
  const phoneLeaves = await agent.op('preview_stop', { viewer: VIEWER_PHONE });
  assert.equal(phoneLeaves.camera, 3);

  const last = await agent.op('preview_stop', { viewer: VIEWER_KIOSK });
  assert.equal(last.preview, false);
  assert.equal(last.camera, null);
  assert.equal((await agent.op('status')).preview_camera, null);
});

test('a refused camera switch keeps reporting the angle that is still in the stream', { timeout: 30000 }, async (t) => {
  const agent = await startAgent(t, { obsSources: 'cam1,cam2' });
  await agent.op('preview_start', { viewer: VIEWER_KIOSK, cloudflare: CF });
  await agent.poll('preview_cam2');
  const none = await agent.poll('preview_cam3'); // only two cameras in this room
  assert.deepEqual({ ok: none.ok, reason: none.reason, camera: none.camera }, { ok: false, reason: 'camera_unavailable', camera: 2 });
  assert.deepEqual(agent.obs.enabledSources(), ['cam2']);
});

test('a room with no OBS (demo mode) answers camera null', { timeout: 30000 }, async (t) => {
  const agent = await startAgent(t, { env: { OBS_SOURCES: '' } });
  assert.equal((await agent.op('preview_start', { viewer: VIEWER_KIOSK })).camera, null);
  assert.equal((await agent.op('preview_stop', { viewer: VIEWER_KIOSK })).camera, null);
  assert.equal((await agent.op('status')).preview_camera, null);
});

test('the heartbeat state carries preview_camera (1-3 or null), and nothing else invents a value', () => {
  assert.equal(buildHeartbeatState({ previewCamera: 2 }).preview_camera, 2);
  assert.equal(buildHeartbeatState({}).preview_camera, null);
  for (const bad of [0, 4, 1.5, '2', null, undefined, NaN]) assert.equal(buildHeartbeatState({ previewCamera: bad }).preview_camera, null, String(bad));
});

test('the agent\'s real heartbeat reports the live angle', { timeout: 30000 }, async (t) => {
  // The first poll (a heartbeat goes out with it) comes 2.5 s after boot.
  const agent = await startAgent(t, { env: { POLL_IDLE_INTERVAL_MS: '2500' } });
  await agent.op('preview_start', { viewer: VIEWER_KIOSK, cloudflare: CF });
  await waitFor(() => agent.worker.heartbeats.length > 0, 8000, 'the first heartbeat');
  assert.equal(agent.worker.heartbeats[0].preview_camera, 1);
});
