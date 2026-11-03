'use strict';

// Build 46 / S3 04-2, 04-3: the Mini owns the booked-session deadline. Fake clock and fake
// Worker; the server.js wiring is covered by test/agent-auto-stop.test.js.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createAutoStop, parseDeadline } = require('../auto-stop');

const T0 = Date.parse('2026-10-31T16:40:00.000Z'); // 12:40 ET: Robbie's booking end + 10 min

function rig(t, over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-stop-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const world = { now: T0 - 60 * 1000, live: new Set(), posts: [], replies: [], localStops: [], offline: false };
  const make = () => createAutoStop({
    file: path.join(dir, 'auto-stop.json'),
    relayUrl: 'http://relay.test',
    buildingId: 'bench-1',
    key: 'k',
    now: () => world.now,
    isTakeLive: (ref) => world.live.has(ref),
    localStop: async (ref) => { world.localStops.push(ref); world.live.delete(ref); return { ok: true, saved: true }; },
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      world.posts.push(body);
      if (world.offline) throw new Error('ECONNREFUSED');
      const reply = world.replies.length ? world.replies.shift() : { ok: true, queued: true };
      return { ok: true, status: 200, json: async () => reply };
    },
    requestRetryMs: 5000,
    localAfterMs: 60000,
    ...over,
  });
  return { world, make, file: path.join(dir, 'auto-stop.json') };
}

test('parseDeadline: ISO within 12 h only', () => {
  assert.equal(parseDeadline('2026-10-31T16:40:00.000Z', T0), T0);
  assert.equal(parseDeadline('2026-11-01T06:00:00.000Z', T0), null);
  assert.equal(parseDeadline('soon', T0), null);
  assert.equal(parseDeadline(undefined, T0), null);
});

test('04-2: before the deadline nothing happens; at it exactly one Stop request for that take', async (t) => {
  const { world, make } = rig(t);
  const a = make();
  world.live.add('take-a');
  assert.equal(a.arm('take-a', new Date(T0).toISOString()), true);
  world.now = T0 - 1000;
  await a.tick();
  assert.equal(world.posts.length, 0, 'end+10m minus 1 s: nothing');
  world.now = T0;
  await a.tick();
  assert.deepEqual(world.posts, [{ auto_stop: true, building_id: 'bench-1', mode: 'request', session_ref: 'take-a' }]);
  // Queued: further ticks wait for the Stop to arrive through the poll, never re-ask.
  for (const dt of [1000, 6000, 30000]) { world.now = T0 + dt; await a.tick(); }
  assert.equal(world.posts.length, 1);
  assert.equal(a.status().phase, 'requested');
  // The Stop ran (server.js disarms on a successful stop).
  a.disarm('take-a');
  assert.equal(a.status(), null);
});

test('04-3: the deadline survives an agent restart; a restart after the take ended forgets it', async (t) => {
  const { world, make } = rig(t);
  world.live.add('take-a');
  make().arm('take-a', new Date(T0).toISOString());
  const reborn = make(); // new process, same file
  assert.equal(reborn.status().session_ref, 'take-a');
  world.now = T0 + 2000;
  await reborn.tick();
  assert.equal(world.posts.at(-1).session_ref, 'take-a');
  // Restart again, but the take is no longer recording: nothing is stopped, the entry goes.
  world.live.clear();
  const third = make();
  await third.tick();
  assert.equal(third.status(), null);
  assert.equal(world.posts.length, 1);
});

test('04-3: a manual Stop at the boundary, or a newer take, is never stopped by the old deadline', async (t) => {
  const { world, make } = rig(t);
  const a = make();
  world.live.add('take-a');
  a.arm('take-a', new Date(T0).toISOString());
  // Manual Stop 1 s before the deadline, then a new take with no deadline (on demand).
  a.disarm('take-a');
  world.live.delete('take-a');
  world.live.add('take-b');
  a.arm('take-b', undefined);
  world.now = T0 + 5000;
  await a.tick();
  assert.equal(world.posts.length, 0);
  // Worker says the take already has a Stop (manual Stop landed first): drop it, no retries.
  const b = make();
  world.live.add('take-c');
  b.arm('take-c', new Date(T0).toISOString());
  world.replies.push({ ok: false, reason: 'stop_already_sent' });
  await b.tick();
  world.now = T0 + 60000;
  await b.tick();
  assert.equal(world.posts.filter((p) => p.session_ref === 'take-c').length, 1);
  assert.equal(b.status(), null);
});

test('04-2: clock skew (Worker says too_early) retries every 5 s, then succeeds once', async (t) => {
  const { world, make } = rig(t);
  const a = make();
  world.live.add('take-a');
  a.arm('take-a', new Date(T0).toISOString());
  world.now = T0;
  world.replies.push({ ok: false, reason: 'too_early' }, { ok: true, queued: true });
  await a.tick();
  world.now = T0 + 3000; await a.tick();
  assert.equal(world.posts.length, 1, 'no retry before 5 s');
  world.now = T0 + 5000; await a.tick();
  assert.equal(world.posts.length, 2);
  assert.equal(a.status().phase, 'requested');
});

test('04-2: Worker unreachable for 60 s after the deadline: the Mini stops that take itself, then reports until recorded', async (t) => {
  const { world, make } = rig(t);
  const a = make();
  world.live.add('take-a');
  a.arm('take-a', new Date(T0).toISOString());
  world.offline = true;
  for (let s = 0; s < 60; s += 5) { world.now = T0 + s * 1000; await a.tick(); }
  assert.deepEqual(world.localStops, [], 'not before 60 s');
  world.now = T0 + 60000; await a.tick();
  assert.deepEqual(world.localStops, ['take-a']);
  assert.equal(a.status().phase, 'local_stopped');
  // Restart while still offline: the report is not lost.
  const reborn = make();
  assert.equal(reborn.status().phase, 'local_stopped');
  world.now = T0 + 70000; await reborn.tick();
  world.offline = false;
  world.replies.push({ ok: true, recorded: true });
  world.now = T0 + 80000; await reborn.tick();
  const report = world.posts.at(-1);
  assert.equal(report.mode, 'report');
  assert.equal(report.session_ref, 'take-a');
  assert.equal(report.result.saved, true);
  assert.equal(reborn.status(), null);
  // A new take is not touched by the finished report.
  assert.deepEqual(world.localStops, ['take-a']);
});

test('04-3: a take paused past the deadline still counts as running', async (t) => {
  const { world, make } = rig(t, {});
  const a = make();
  world.live.add('take-p'); // isTakeLive covers recording || paused in server.js
  a.arm('take-p', new Date(T0).toISOString());
  world.now = T0 + 1;
  await a.tick();
  assert.equal(world.posts.length, 1);
});
