'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { parseConf, readGolden, restoreCameras, snapshotCameras, writeGolden } = require('../cam-settings');

test('parses documented, unquoted, JSON, and garbage camera bodies', () => {
  assert.deepEqual(parseConf('bright="1" style="x y"'), { bright: '1', style: 'x y' });
  assert.deepEqual(parseConf('bright=1 saturation=2'), { bright: '1', saturation: '2' });
  assert.deepEqual(parseConf('{"bright":"1"}'), { bright: '1' });
  assert.deepEqual(parseConf('not camera data'), {});
});

test('snapshot writes golden atomically and restore is mapped-only, mode-first, spaced, and verified', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cam-settings-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const requestFn = async (url) => {
    calls.push({ url, at: Date.now() });
    if (url.includes('get_advance')) return { statusCode: 404, body: '' };
    if (url.includes('get_image')) return { statusCode: 200, body: 'aemode="3" gain="7" bright="20" unknown="keep"' };
    return { statusCode: 200, body: '' };
  };
  const cameras = [{ name: 'cam1', host: '127.0.0.1:1' }];
  const snapshot = await snapshotCameras(cameras, { requestFn });
  assert.deepEqual(snapshot.cameras.cam1.errors, ['advance_404']);
  const written = writeGolden(dir, snapshot);
  assert.ok(written.bytes > 0);
  assert.deepEqual(readGolden(dir), snapshot);
  calls.length = 0;
  const restored = await restoreCameras(cameras, snapshot, { requestFn, delayMs: 2 });
  const writes = calls.filter((call) => call.url.includes('post_image_value'));
  assert.equal(writes.length, 3);
  assert.match(writes[0].url, /aemode/);
  assert.ok(writes[1].at - writes[0].at >= 1);
  assert.deepEqual(restored.cameras.cam1.unmapped, ['unknown']);
  assert.equal(restored.cameras.cam1.verified, 3);
});
