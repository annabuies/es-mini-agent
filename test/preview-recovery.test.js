'use strict';

// Nov 4 field report, solo kiosk: the preview dropped about four times in seven minutes,
// 7-8 s each, and after a phone loss the kiosk fell back and did not recover. Traced to
// the agent's own recovery: (1) an OBS status request that fails was treated as "the
// output stopped" (state cleared, the live Cloudflare input deleted while OBS kept
// publishing to it); (2) a dropped output with a `reuse` keepalive answered with no stream
// (JPEG fallback) and deleted the input, so recovery waited for the next 25 s keepalive and
// a stale-output reclaim; (3) nothing watched the output between keepalives.

const assert = require('node:assert/strict');
const test = require('node:test');
const { CF, CF2, VIEWER_KIOSK, count, startAgent, waitFor } = require('./preview-harness');

test('a failed OBS status read keeps the stream: no state cleared, no input deleted, no restart', { timeout: 30000 }, async (t) => {
  const agent = await startAgent(t);
  const first = await agent.op('preview_start', { viewer: VIEWER_KIOSK, cloudflare: CF });
  assert.equal(first.stream_mode, 'cloudflare');
  agent.obsControl.failStatus = 1; // the next GetStreamStatus is refused by OBS
  const keepalive = await agent.op('preview_start', { viewer: VIEWER_KIOSK, cloudflare: { ...CF, reuse: true } });
  assert.equal(keepalive.ok, true);
  assert.equal(keepalive.stream_mode, 'cloudflare', 'still the real-time stream, not the JPEG fallback');
  assert.equal(keepalive.stream.playbackUrl, CF.playbackUrl);
  assert.equal(count(agent.obsRequests, 'StartStream'), 1, 'no restart');
  assert.equal(count(agent.obsRequests, 'StopStream'), 0, 'OBS was never told to stop');
  assert.deepEqual(agent.worker.cleanups, [], 'the live input was not deleted');
});

test('a dropped output is re-published to the same input on the next keepalive (reuse): no JPEG fallback, no deleted input', { timeout: 30000 }, async (t) => {
  const agent = await startAgent(t);
  await agent.op('preview_start', { viewer: VIEWER_KIOSK, cloudflare: CF });
  agent.obsControl.streaming = false; // Cloudflare or the network dropped the WHIP output
  const keepalive = await agent.op('preview_start', { viewer: VIEWER_KIOSK, cloudflare: { ...CF, reuse: true } });
  assert.equal(keepalive.ok, true);
  assert.equal(keepalive.stream_mode, 'cloudflare');
  assert.equal(keepalive.stream.playbackUrl, CF.playbackUrl, 'viewers keep the same playback URL');
  assert.equal(count(agent.obsRequests, 'StartStream'), 2, 'published again');
  assert.equal(agent.obsControl.streaming, true);
  assert.deepEqual(agent.worker.cleanups, [], 'the input being reused was not deleted');
  assert.equal(agent.obsControl.lastServer, CF.publishUrl);
  assert.match(agent.output(), /ev=stream_lost reason=keepalive/);
  assert.match(agent.output(), /ev=stream_restart ok=true reason=keepalive route=cloudflare camera=1/);
  assert.equal(agent.output().includes('SECRETKEY'), false, 'the publish secret is never logged');
});

test('the watchdog re-publishes a dropped output without any keepalive or viewer action', { timeout: 30000 }, async (t) => {
  const agent = await startAgent(t, { env: { PREVIEW_SWEEP_MS: '100', PREVIEW_RESTART_MIN_MS: '0' } });
  await agent.op('preview_start', { viewer: VIEWER_KIOSK, cloudflare: CF });
  assert.equal(count(agent.obsRequests, 'StartStream'), 1);
  agent.obsControl.streaming = false;
  await waitFor(() => count(agent.obsRequests, 'StartStream') === 2, 5000, 'the watchdog restart');
  assert.equal(agent.obsControl.streaming, true);
  await waitFor(() => /ev=stream_restart ok=true reason=watchdog/.test(agent.output()), 3000, 'restart log');
  // The viewer's next keepalive finds a healthy stream: nothing more to do.
  const keepalive = await agent.op('preview_start', { viewer: VIEWER_KIOSK, cloudflare: { ...CF, reuse: true } });
  assert.equal(keepalive.stream_mode, 'cloudflare');
  assert.equal(count(agent.obsRequests, 'StartStream'), 2);
  assert.deepEqual(agent.worker.cleanups, []);
});

test('the watchdog gives up after three failed restarts and the next keepalive starts from scratch', { timeout: 30000 }, async (t) => {
  const agent = await startAgent(t, { env: { PREVIEW_SWEEP_MS: '100', PREVIEW_RESTART_MIN_MS: '0' } });
  await agent.op('preview_start', { viewer: VIEWER_KIOSK, cloudflare: CF });
  // OBS refuses to start the stream again (StartStream answers ok but the output stays down).
  agent.obsControl.streaming = false;
  agent.obsControl.refuseStart = true;
  await waitFor(() => /ev=stream_gave_up/.test(agent.output()), 8000, 'watchdog giving up');
  assert.equal(count(agent.obsRequests, 'StartStream'), 4, 'the first start plus exactly three failed restarts');
  await waitFor(() => /ev=stream_stop reason=restart_failed/.test(agent.output()), 5000, 'stream_stop log');
  // The next keepalive (the Worker hands out a fresh input) starts the preview from scratch.
  agent.obsControl.refuseStart = false;
  const fresh = await agent.op('preview_start', { viewer: VIEWER_KIOSK, cloudflare: CF2 });
  assert.equal(fresh.stream_mode, 'cloudflare');
  assert.equal(fresh.stream.inputUid, CF2.inputUid);
  assert.equal(agent.obsControl.lastServer, CF2.publishUrl);
  assert.equal(agent.obsControl.streaming, true);
});

test('a status op reports the live angle', { timeout: 30000 }, async (t) => {
  const agent = await startAgent(t);
  await agent.op('preview_start', { viewer: VIEWER_KIOSK, cloudflare: CF });
  const cam2 = await agent.poll('preview_cam2');
  assert.equal(cam2.camera, 2);
  const status = await agent.op('status');
  assert.equal(status.preview_camera, 2);
});
