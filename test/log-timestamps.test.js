'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { installConsoleTimestamps } = require('../log-timestamps');

test('console timestamp installer prefixes every line once and is idempotent', () => {
  const calls = [];
  const fakeConsole = {};
  for (const method of ['log', 'info', 'warn', 'error']) {
    fakeConsole[method] = (line) => calls.push([method, line]);
  }
  const now = () => new Date('2026-09-27T14:07:02.123Z');

  assert.equal(installConsoleTimestamps({ console: fakeConsole, now }), true);
  assert.equal(installConsoleTimestamps({ console: fakeConsole, now }), false);

  fakeConsole.log('[es-mini-agent] listening');
  fakeConsole.info('relay: claimed %s', 'look');
  fakeConsole.warn('first line\nsecond line');
  fakeConsole.error('2026-09-27T14:07:02.123Z [es-mini-agent] already prefixed');

  assert.deepEqual(calls, [
    ['log', '2026-09-27T14:07:02.123Z [es-mini-agent] listening'],
    ['info', '2026-09-27T14:07:02.123Z [es-mini-agent] relay: claimed look'],
    ['warn', '2026-09-27T14:07:02.123Z [es-mini-agent] first line'],
    ['warn', '2026-09-27T14:07:02.123Z [es-mini-agent] second line'],
    ['error', '2026-09-27T14:07:02.123Z [es-mini-agent] already prefixed'],
  ]);
});
