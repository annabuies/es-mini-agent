'use strict';

// Robbie Nov 4: loss of the preview (the phone's airplane mode, the stream dropping)
// "seemingly didn't mess with the recording". This pins it: while a take is recording,
// every way the preview can stop, fail or restart leaves the take alone. The recorder is
// OBS Source Record (vendor requests) and the master (StartRecord/StopRecord): none of
// the preview paths may send a stop, cancel, pause or another start, and the agent's own
// recording state must stay exactly as the take left it.

const assert = require('node:assert/strict');
const test = require('node:test');
const { CF, CF2, VIEWER_KIOSK, VIEWER_PHONE, count, startAgent, waitFor } = require('./preview-harness');

const RECORDER_TYPES = ['StartRecord', 'StopRecord', 'PauseRecord', 'ResumeRecord', 'SplitRecordFile', 'CancelRecord'];
const vendorCalls = (requests) => requests.filter((r) => r.type === 'CallVendorRequest').map((r) => r.data.requestType + ':' + (r.data.requestData && r.data.requestData.source));

async function assertTakeUntouched(agent, baselineVendor) {
  const status = await agent.op('status');
  assert.equal(status.recording, true);
  assert.equal(status.session_ref, 'take-iso-1');
  const health = await agent.health();
  assert.deepEqual(health.state, { recording: true, paused: false });
  assert.deepEqual(vendorCalls(agent.obsRequests), baselineVendor, 'Source Record got no new request');
  for (const type of RECORDER_TYPES) assert.equal(count(agent.obsRequests, type), 0, type + ' never sent');
}

test('preview stop, viewer loss, stream failure and restarts during a take leave the take and Source Record untouched', { timeout: 60000 }, async (t) => {
  const agent = await startAgent(t, { env: { PREVIEW_SWEEP_MS: '100', PREVIEW_RESTART_MIN_MS: '0', PREVIEW_TTL_MS: '3000' } });
  await agent.op('preview_start', { viewer: VIEWER_KIOSK, cloudflare: CF });
  await agent.op('preview_start', { viewer: VIEWER_PHONE, cloudflare: { ...CF, reuse: true } });
  const started = await agent.op('start', { session_ref: 'take-iso-1' });
  assert.equal(started.ok, true);
  assert.equal(started.recording, true);
  const baseline = vendorCalls(agent.obsRequests);
  assert.deepEqual(baseline.map((c) => c.split(':')[0]), ['record_start', 'record_start', 'record_start']);
  await assertTakeUntouched(agent, baseline);

  // 1. A viewer leaves (airplane mode ends in a stop), then the other.
  await agent.op('preview_stop', { viewer: VIEWER_PHONE });
  await assertTakeUntouched(agent, baseline);

  // 2. The output drops mid-take: the watchdog re-publishes it, the take does not notice.
  agent.obsControl.streaming = false;
  await waitFor(() => count(agent.obsRequests, 'StartStream') === 2, 5000, 'watchdog restart during the take');
  await assertTakeUntouched(agent, baseline);

  // 3. OBS refuses the stream outright (a failing preview start) and the output stays down.
  agent.obsControl.streaming = false;
  agent.obsControl.rejectStart = true;
  await waitFor(() => /ev=stream_restart ok=false/.test(agent.output()) || /ev=stream_gave_up/.test(agent.output()), 8000, 'failing restarts');
  await agent.op('preview_start', { viewer: VIEWER_KIOSK, cloudflare: CF2 });
  await assertTakeUntouched(agent, baseline);
  // Pinned (audit): here the keepalive's own fresh start fails and drops the stream before the
  // watchdog's third failure, so the give-up path is pinned in preview-recovery.test.js instead.
  await waitFor(() => /ev=stream_start_failed reason=new_input/.test(agent.output()), 8000, 'the failing keepalive start');
  assert.match(agent.output(), /ev=keepalive viewer=\w+ ms=\d+ stream=no error=start_failed/);
  await assertTakeUntouched(agent, baseline);

  // 4. The last viewer stops the preview altogether, and a lapsed lease does the same.
  await agent.op('preview_stop', { viewer: VIEWER_KIOSK });
  await assertTakeUntouched(agent, baseline);
  agent.obsControl.rejectStart = false;
  await agent.op('preview_start', { viewer: VIEWER_PHONE, cloudflare: CF2 });
  await waitFor(() => /ev=stream_stop reason=ttl_expired/.test(agent.output()), 10000, 'the lease lapsing');
  await assertTakeUntouched(agent, baseline);

  // The take is still stoppable normally afterwards, and stopping it is what ends the take.
  const stopped = await agent.op('stop', {});
  assert.equal(stopped.ok, true);
  assert.equal(count(agent.obsRequests, 'StopRecord'), 0);
  assert.deepEqual(vendorCalls(agent.obsRequests).slice(baseline.length).map((c) => c.split(':')[0]), ['record_stop', 'record_stop', 'record_stop'], 'only the explicit Stop stopped Source Record');
});
