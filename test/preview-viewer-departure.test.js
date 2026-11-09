'use strict';

// Robbie Nov 4, three viewers on one shared OBS stream: closing the phone's preview
// blacked out every viewer, and a 15 s airplane-mode loss on the phone stopped the stream
// for the kiosk too. With a lease per viewer: a departing or lapsed viewer cannot stop
// the stream while another lease is alive, a returning viewer re-joins without a restart,
// and only the last lease ending (or an old Worker's id-less stop) stops it.
// (preview-viewer-lease.test.js covers two viewers; this adds three, lease expiry and
// the phone-loss sequence. The same file run against the old runtime 9ba2f22 fails.)

const assert = require('node:assert/strict');
const test = require('node:test');
const { CF, VIEWER_KIOSK, VIEWER_PHONE, VIEWER_WEB, count, sleep, startAgent, waitFor } = require('./preview-harness');

const FAST = { PREVIEW_TTL_MS: '1500', PREVIEW_SWEEP_MS: '100' };

test('three viewers: the phone and then the web leaving never interrupt the kiosk, angle included', { timeout: 30000 }, async (t) => {
  const agent = await startAgent(t);
  await agent.op('preview_start', { viewer: VIEWER_KIOSK, cloudflare: CF });
  await agent.op('preview_start', { viewer: VIEWER_PHONE, cloudflare: { ...CF, reuse: true } });
  await agent.op('preview_start', { viewer: VIEWER_WEB, cloudflare: { ...CF, reuse: true } });
  const cam3 = await agent.poll('preview_cam3');
  assert.equal(cam3.camera, 3);
  assert.deepEqual(agent.obs.enabledSources(), ['cam3']);

  const phoneLeaves = await agent.op('preview_stop', { viewer: VIEWER_PHONE });
  assert.deepEqual({ ok: phoneLeaves.ok, preview: phoneLeaves.preview, viewers: phoneLeaves.viewers, camera: phoneLeaves.camera }, { ok: true, preview: true, viewers: 2, camera: 3 });
  const webLeaves = await agent.op('preview_stop', { viewer: VIEWER_WEB });
  assert.deepEqual({ preview: webLeaves.preview, viewers: webLeaves.viewers, camera: webLeaves.camera }, { preview: true, viewers: 1, camera: 3 });
  assert.equal(count(agent.obsRequests, 'StopStream'), 0, 'no stop for the kiosk');
  assert.equal(count(agent.obsRequests, 'StartStream'), 1, 'no restart either');
  assert.equal(agent.obsControl.streaming, true);
  assert.deepEqual(agent.obs.enabledSources(), ['cam3'], 'the picture the kiosk shows did not change');
  const keepalive = await agent.op('preview_start', { viewer: VIEWER_KIOSK, cloudflare: { ...CF, reuse: true } });
  assert.equal(keepalive.stream_mode, 'cloudflare');
  assert.equal(keepalive.camera, 3);

  const last = await agent.op('preview_stop', { viewer: VIEWER_KIOSK });
  assert.equal(last.preview, false);
  assert.equal(last.camera, null);
  assert.equal(count(agent.obsRequests, 'StopStream'), 1);
  assert.match(agent.output(), /ev=stream_stop reason=last_viewer_left route=cloudflare camera=3/);
});

test('an id-less stop (an older Worker) is the shared lease: it stops the stream for everyone, by design', { timeout: 30000 }, async (t) => {
  const agent = await startAgent(t);
  await agent.op('preview_start', { viewer: VIEWER_KIOSK, cloudflare: CF });
  await agent.op('preview_start', { viewer: VIEWER_PHONE, cloudflare: { ...CF, reuse: true } });
  const stopped = await agent.op('preview_stop', {});
  assert.equal(stopped.preview, false);
  assert.equal(count(agent.obsRequests, 'StopStream'), 1);
  assert.match(agent.output(), /ev=stream_stop reason=legacy_stop/);
  // The kiosk's next keepalive (the Worker hands out a new input) brings the preview back.
  const back = await agent.op('preview_start', { viewer: VIEWER_KIOSK, cloudflare: { ...CF, inputUid: 'c'.repeat(32), playbackUrl: CF.playbackUrl.replace(/a{32}/, 'c'.repeat(32)), publishUrl: CF.publishUrl.replace(/a{32}/, 'c'.repeat(32)) } });
  assert.equal(back.stream_mode, 'cloudflare');
});

test('phone loses the network for 15 s: its lapsed lease cannot stop the stream while the kiosk lease is alive; it re-joins with no restart', { timeout: 30000 }, async (t) => {
  const agent = await startAgent(t, { env: FAST });
  await agent.op('preview_start', { viewer: VIEWER_KIOSK, cloudflare: CF });
  await agent.op('preview_start', { viewer: VIEWER_PHONE, cloudflare: { ...CF, reuse: true } });
  // Airplane mode: no more keepalives and no preview_stop from the phone. The kiosk keeps renewing.
  const until = Date.now() + 2600; // well past the phone's 1.5 s lease
  while (Date.now() < until) {
    const keepalive = await agent.op('preview_start', { viewer: VIEWER_KIOSK, cloudflare: { ...CF, reuse: true } });
    assert.equal(keepalive.stream_mode, 'cloudflare');
    await sleep(400);
  }
  assert.match(agent.output(), new RegExp('ev=lease_expired viewer=' + VIEWER_PHONE));
  assert.equal(count(agent.obsRequests, 'StopStream'), 0, 'the lapsed phone lease did not stop the shared stream');
  assert.equal(agent.obsControl.streaming, true);
  // The phone is back: it re-joins the running stream. No new StartStream, no new input.
  const back = await agent.op('preview_start', { viewer: VIEWER_PHONE, cloudflare: { ...CF, reuse: true } });
  assert.equal(back.stream_mode, 'cloudflare');
  assert.equal(back.stream.playbackUrl, CF.playbackUrl);
  assert.equal(count(agent.obsRequests, 'StartStream'), 1);
  assert.equal(count(agent.obsRequests, 'StopStream'), 0);
  assert.deepEqual(agent.worker.cleanups, []);
  assert.equal((agent.output().match(new RegExp('ev=viewer_join viewer=' + VIEWER_PHONE, 'g')) || []).length, 2, 'joined twice: the second is the return');
});

test('lease expiry: the stream stops only when the LAST lease lapses, and says why', { timeout: 30000 }, async (t) => {
  const agent = await startAgent(t, { env: FAST });
  await agent.op('preview_start', { viewer: VIEWER_KIOSK, cloudflare: CF });
  await agent.op('preview_start', { viewer: VIEWER_PHONE, cloudflare: { ...CF, reuse: true } });
  await sleep(700);
  await agent.op('preview_start', { viewer: VIEWER_KIOSK, cloudflare: { ...CF, reuse: true } }); // the kiosk renews, the phone does not
  await sleep(1000); // the phone's lease is gone (1.5 s), the kiosk's is not (renewed 1 s ago)
  assert.equal(count(agent.obsRequests, 'StopStream'), 0);
  await waitFor(() => count(agent.obsRequests, 'StopStream') === 1, 6000, 'the stop after the last lease lapsed');
  assert.equal(agent.obsControl.streaming, false);
  await waitFor(() => /ev=stream_stop reason=ttl_expired/.test(agent.output()), 3000, 'ttl_expired log');
  assert.match(agent.output(), /ev=lease_expired viewer=0123456789abcdef/);
  assert.ok(agent.obsRequests.some((r) => r.type === 'RemoveScene'), 'the overlay scene is removed');
});

test('a keepalive arriving as the lease lapses is not undone by the watchdog', { timeout: 30000 }, async (t) => {
  const agent = await startAgent(t, { env: { PREVIEW_TTL_MS: '2000', PREVIEW_SWEEP_MS: '50' } });
  await agent.op('preview_start', { viewer: VIEWER_KIOSK, cloudflare: CF });
  for (let i = 0; i < 6; i += 1) {
    await sleep(1000); // renewed halfway through each 2 s lease
    const keepalive = await agent.op('preview_start', { viewer: VIEWER_KIOSK, cloudflare: { ...CF, reuse: true } });
    assert.equal(keepalive.stream_mode, 'cloudflare');
  }
  assert.equal(count(agent.obsRequests, 'StopStream'), 0);
  assert.equal(count(agent.obsRequests, 'StartStream'), 1);
});
