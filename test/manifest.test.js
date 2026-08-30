'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { _test } = require('../self-update');

test('self-update manifest requires both room self-check runtime modules', () => {
  const manifest = _test.parseManifest(fs.readFileSync(path.join(__dirname, '..', 'modules.txt'), 'utf8'));
  assert.equal(manifest.includes('visca.js'), true);
  assert.equal(manifest.includes('room-check.js'), true);
  assert.equal(_test.validateManifest(manifest), null);
  assert.equal(_test.validateManifest(manifest.filter((name) => name !== 'visca.js')), 'modules.txt does not list visca.js');
  assert.equal(_test.validateManifest(manifest.filter((name) => name !== 'room-check.js')), 'modules.txt does not list room-check.js');
});
