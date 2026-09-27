'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { sampleDiskUsage } = require('../disk-usage');

test('sampleDiskUsage returns filesystem capacity for a real directory', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'es-mini-disk-usage-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const sample = await sampleDiskUsage(dir);

  assert.equal(typeof sample.free_bytes, 'number');
  assert.equal(typeof sample.total_bytes, 'number');
  assert.ok(sample.free_bytes >= 0);
  assert.ok(sample.total_bytes > 0);
  assert.ok(sample.free_bytes <= sample.total_bytes);
  assert.match(sample.checked_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('sampleDiskUsage returns null for a missing directory', async () => {
  const missing = path.join(os.tmpdir(), `es-mini-disk-usage-missing-${process.pid}-${Date.now()}`);
  assert.equal(await sampleDiskUsage(missing), null);
});
