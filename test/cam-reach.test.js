'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { probeCameras } = require('../cam-reach');

const cameras = [
  { name: 'cam1', host: 'camera-one' },
  { name: 'cam2', host: 'camera-two' },
  { name: 'cam3', host: 'camera-three' },
];

test('probeCameras treats any HTTP response as reachable', async () => {
  const result = await probeCameras([cameras[0]], {
    fetchImpl: async (url, options) => {
      assert.equal(url, 'http://camera-one/');
      assert.equal(options.method, 'GET');
      return { status: 401 };
    },
  });
  assert.deepEqual(result.down, []);
  assert.deepEqual(result.up, ['cam1']);
  assert.equal(typeof result.checked_at, 'string');
  assert.equal(typeof result.ms.cam1, 'number');
});

test('probeCameras classifies a rejected fetch as down', async () => {
  const result = await probeCameras([cameras[1]], {
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  });
  assert.deepEqual(result.down, ['cam2']);
  assert.deepEqual(result.up, []);
});

test('probeCameras classifies an aborted request as down', async () => {
  const result = await probeCameras([cameras[2]], {
    timeoutMs: 5,
    fetchImpl: (_, options) => new Promise((_, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('AbortError')));
    }),
  });
  assert.deepEqual(result.down, ['cam3']);
  assert.deepEqual(result.up, []);
});

test('probeCameras runs mixed cameras in parallel and never throws', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const result = await probeCameras(cameras, {
    fetchImpl: async (url) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      if (url.includes('camera-two')) throw new Error('EHOSTUNREACH');
      return { status: 200 };
    },
  });
  assert.equal(maxInFlight, 3);
  assert.deepEqual(result.up, ['cam1', 'cam3']);
  assert.deepEqual(result.down, ['cam2']);
  const failed = await probeCameras(cameras, { fetchImpl: null });
  assert.deepEqual(failed.down, ['cam1', 'cam2', 'cam3']);
  assert.ok(failed.error);
});
