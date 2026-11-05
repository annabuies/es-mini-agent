'use strict';

// Robbie Nov 4: with three viewers on the preview, the third or fourth quick 1-4 preset
// tap blacked out every preview for 4-6 s. A look never touches OBS (executeLook only
// sends HTTP recalls to the cameras), so the stream, overlay and scene are not the cause.
// The mechanism on the Mini is head-of-line blocking: commands ran one at a time on the
// poll loop and a look waits on the cameras for up to 3 s, so each tap held every other
// command (the viewers' preview keepalives, camera picks) behind it, and the Worker gives
// a queued command only 6.5 s. Looks now run one at a time but off the poll loop.

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { CF, VIEWER_KIOSK, close, count, listen, sleep, startAgent, waitFor } = require('./preview-harness');

// A PTZ camera that answers a recall only after `control.delayMs`, like a camera busy
// with a rapid second preset.
async function startCameras(t, control) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const preset = Number((req.url.match(/poscall&(\d+)/) || [])[1]);
    const startedAt = Date.now();
    setTimeout(() => { calls.push({ preset, startedAt, answeredAt: Date.now() }); res.writeHead(204); res.end(); }, control.delayMs);
  });
  const port = await listen(server);
  t.after(() => close(server));
  return { port, calls };
}

function ptzConfig(port) {
  const looks = {};
  for (let i = 1; i <= 6; i += 1) looks[String(i)] = { cam1: i, cam2: i, cam3: i };
  return {
    sources: ['cam1', 'cam2', 'cam3'],
    cameras: ['cam1', 'cam2', 'cam3'].map((name) => ({ name, host: '127.0.0.1:' + port })),
    looks,
    default_look: null,
  };
}

async function roomWithCameras(t, delayMs, env) {
  const control = { delayMs: 0 }; // fast while the config loads
  const cameras = await startCameras(t, control);
  const agent = await startAgent(t, { worker: ptzConfig(cameras.port), env: { PREVIEW_SWEEP_MS: '600000', ...(env || {}) } });
  // The agent loads the PTZ config from the Worker shortly after boot.
  await waitFor(async () => {
    const id = agent.worker.enqueue('look', { look: '6' });
    await waitFor(() => agent.worker.resultFor(id), 5000, 'warm-up look');
    return agent.worker.resultFor(id).result.reason !== 'no_cameras';
  }, 8000, 'PTZ config').catch(() => {});
  cameras.calls.length = 0;
  control.delayMs = delayMs;
  return { agent, cameras, control };
}

test('rapid preset taps never delay the viewers\' preview commands, never touch OBS, and run in tap order', { timeout: 60000 }, async (t) => {
  const { agent, cameras } = await roomWithCameras(t, 1200);
  await agent.op('preview_start', { viewer: VIEWER_KIOSK, cloudflare: CF });
  const obsBefore = agent.obsRequests.length;

  const t0 = Date.now();
  const looks = [1, 2, 3, 4].map((n) => agent.worker.enqueue('look', { look: String(n) }));
  const keepalive = agent.worker.enqueue('preview_start', { viewer: VIEWER_KIOSK, cloudflare: { ...CF, reuse: true } });
  const camPick = agent.worker.enqueue('preview_cam2', {});
  await waitFor(() => agent.worker.resultFor(keepalive) && agent.worker.resultFor(camPick), 6000, 'preview commands');
  const previewDone = Math.max(agent.worker.resultFor(keepalive).receivedAt, agent.worker.resultFor(camPick).receivedAt) - t0;
  assert.ok(previewDone < 1200, 'the keepalive and the camera pick were answered while the first look was still waiting on the cameras (' + previewDone + ' ms)');
  assert.equal(agent.worker.resultFor(keepalive).result.stream_mode, 'cloudflare');
  assert.equal(agent.worker.resultFor(camPick).result.camera, 2);

  await waitFor(() => looks.every((id) => agent.worker.resultFor(id)), 20000, 'all four looks');
  for (const id of looks) assert.equal(agent.worker.resultFor(id).ok, true);
  // One look at a time, in tap order: cam1 saw presets 1,2,3,4 in that order.
  const order = cameras.calls.sort((a, b) => a.startedAt - b.startedAt).map((c) => c.preset);
  assert.deepEqual(order.filter((_, i) => i % 3 === 0), [1, 2, 3, 4]);
  const finished = looks.map((id) => agent.worker.resultFor(id).receivedAt);
  assert.deepEqual([...finished].sort((a, b) => a - b), finished, 'results come back in tap order');

  // The look path sent OBS nothing except the one camera pick and the keepalive's status read.
  const since = agent.obsRequests.slice(obsBefore).map((r) => r.type);
  assert.deepEqual([...new Set(since)].sort(), ['GetStreamStatus', 'SetSceneItemEnabled']);
  assert.equal(count(agent.obsRequests, 'StartStream'), 1);
  assert.equal(count(agent.obsRequests, 'StopStream'), 0);
  assert.equal(agent.obsControl.streaming, true);
  assert.ok(Date.now() - t0 > 4000, 'sanity: the four looks really took ~4.8 s of camera time');
});

test('a look is refused during a take and never runs over a Start', { timeout: 60000 }, async (t) => {
  const { agent, cameras } = await roomWithCameras(t, 800);
  const slowLook = agent.worker.enqueue('look', { look: '1' });
  await sleep(150); // the agent has claimed it and is waiting on the cameras
  const start = agent.worker.enqueue('start', { session_ref: 'take-1' });
  await waitFor(() => agent.worker.resultFor(start), 15000, 'start');
  const lookDone = agent.worker.resultFor(slowLook).receivedAt;
  const startDone = agent.worker.resultFor(start).receivedAt;
  assert.equal(agent.worker.resultFor(slowLook).ok, true);
  assert.equal(agent.worker.resultFor(start).result.recording, true);
  assert.ok(startDone >= lookDone, 'the take did not begin with the cameras still moving');
  const firstRecordStart = agent.obsRequests.find((r) => r.type === 'CallVendorRequest');
  assert.ok(firstRecordStart.at >= cameras.calls[0].answeredAt, 'Source Record started after the recall was answered');

  const during = agent.worker.enqueue('look', { look: '2' });
  await waitFor(() => agent.worker.resultFor(during), 5000, 'look during the take');
  assert.equal(agent.worker.resultFor(during).result.reason, 'busy_recording');
  assert.equal(agent.worker.resultFor(during).ok, false);
});
