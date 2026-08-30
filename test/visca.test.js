'use strict';

const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const test = require('node:test');
const visca = require('../visca');

function listen(socket) {
  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(0, '127.0.0.1', () => resolve(socket.address().port));
  });
}

function close(socket) {
  return new Promise((resolve) => socket.close(resolve));
}

function hex(buffer) {
  return Buffer.from(buffer).toString('hex');
}

test('VISCA UDP parses ACK/completion and reads position plus image values', async (t) => {
  const commands = [];
  const replies = new Map([
    ['81090612ff', [0x90, 0x50, 0x00, 0x04, 0x0d, 0x02, 0x0f, 0x0f, 0x0c, 0x08, 0xff]],
    ['81090447ff', [0x90, 0x50, 0x00, 0x08, 0x00, 0x00, 0xff]],
    ['81090435ff', [0x90, 0x50, 0x05, 0xff]],
    ['81090443ff', [0x90, 0x50, 0x00, 0x00, 0x08, 0x00, 0xff]],
    ['81090444ff', [0x90, 0x50, 0x00, 0x00, 0x06, 0x00, 0xff]],
    ['81090420ff', [0x90, 0x50, 0x02, 0x08, 0xff]],
    ['81090439ff', [0x90, 0x50, 0x00, 0xff]],
    ['8109044aff', [0x90, 0x50, 0x00, 0x00, 0x00, 0x05, 0xff]],
    ['8109044bff', [0x90, 0x50, 0x00, 0x00, 0x00, 0x06, 0xff]],
    ['8109044dff', [0x90, 0x50, 0x00, 0x00, 0x00, 0x07, 0xff]],
    ['810904a1ff', [0x90, 0x50, 0x00, 0x00, 0x00, 0x07, 0xff]],
    ['810904a2ff', [0x90, 0x50, 0x00, 0x00, 0x00, 0x08, 0xff]],
    ['810904a4ff', [0x90, 0x50, 0x00, 0xff]],
    ['8109044fff', [0x90, 0x50, 0x07, 0xff]],
  ]);
  const server = dgram.createSocket('udp4');
  server.on('message', (message, rinfo) => {
    const key = hex(message);
    commands.push(key);
    const inquiry = replies.get(key);
    if (inquiry) {
      server.send(Buffer.from(inquiry), rinfo.port, rinfo.address);
      return;
    }
    server.send(Buffer.from([0x90, 0x41, 0xff]), rinfo.port, rinfo.address);
    setTimeout(() => server.send(Buffer.from([0x90, 0x51, 0xff]), rinfo.port, rinfo.address), 2);
  });
  const port = await listen(server);
  t.after(() => close(server));
  const options = { port, timeoutMs: 100, tcpFallback: false };

  assert.equal(await visca.probe('127.0.0.1', options), 'ok');
  assert.deepEqual(await visca.getPanTilt('127.0.0.1', options), { pan: 1234, tilt: -56 });
  const state = await visca.readState('127.0.0.1', options);
  assert.deepEqual(state, {
    pan: 1234,
    tilt: -56,
    zoom: 2048,
    wbmode: 5,
    rgain: 128,
    bgain: 96,
    color_temperature: 40,
    aemode: 0,
    shutter: 5,
    iris: 6,
    bright: 7,
    brightness: 7,
    contrast: 8,
    flip: 0,
    hue: 7,
  });
  const applied = await visca.applyProfile('127.0.0.1', {
    wbmode: 5,
    rgain: 128,
    bgain: 96,
    aemode: 0,
  }, options);
  assert.equal(applied.status, 'ok');
  assert.deepEqual(applied.failures, []);
  assert.equal(commands.includes('8101043505ff'), true);
  assert.equal(commands.includes('8101044300000800ff'), true);
  assert.equal(commands.includes('8101044400000600ff'), true);
  assert.equal(commands.includes('8101043900ff'), true);
});

test('silent VISCA degrades to unavailable without throwing', async () => {
  const socket = dgram.createSocket('udp4');
  const port = await listen(socket);
  await close(socket);
  const options = { port, timeoutMs: 20, tcpFallback: false };
  assert.equal(await visca.probe('127.0.0.1', options), 'unavailable');
  assert.equal(await visca.readState('127.0.0.1', options), 'unavailable');
});

test('VISCA error replies are classified explicitly', () => {
  assert.equal(visca.classifyReply(Buffer.from([0x90, 0x60, 0x02, 0xff])).status, 'syntax_error');
  assert.equal(visca.classifyReply(Buffer.from([0x90, 0x60, 0x03, 0xff])).status, 'buffer_full');
  assert.equal(visca.classifyReply(Buffer.from([0x90, 0x61, 0x41, 0xff])).status, 'not_executable');
});
