'use strict';

// PTZOptics raw VISCA-over-IP. UDP 1259 is the documented primary transport;
// TCP 5678 is tried only as a fallback when the UDP exchange is unavailable.
// Every public operation degrades to `unavailable` or another status string and
// never throws into the room-check orchestration.

const dgram = require('node:dgram');
const net = require('node:net');

const DEFAULT_PORT = 1259;
const DEFAULT_TCP_PORT = 5678;
const DEFAULT_TIMEOUT_MS = 1500;

function intEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}

function normalizeHost(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  const match = raw.match(/^([^:]+):[0-9]{1,5}$/);
  return match ? match[1] : raw;
}

function normalizeBytes(bytes) {
  if (Buffer.isBuffer(bytes)) return Buffer.from(bytes);
  if (Array.isArray(bytes) && bytes.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)) {
    return Buffer.from(bytes);
  }
  return null;
}

function classifyReply(message) {
  if (!Buffer.isBuffer(message) || message.length < 3 || message[0] !== 0x90 || message[message.length - 1] !== 0xff) {
    return { kind: 'ignore', status: 'error' };
  }
  const kind = message[1] & 0xf0;
  if (kind === 0x40) return { kind: 'ack', status: 'ok' };
  if (kind === 0x50) return { kind: 'completion', status: 'ok', reply: Buffer.from(message) };
  if (kind === 0x60) {
    const code = message[2];
    if (code === 0x02) return { kind: 'error', status: 'syntax_error' };
    if (code === 0x03) return { kind: 'error', status: 'buffer_full' };
    if (code === 0x41) return { kind: 'error', status: 'not_executable' };
    return { kind: 'error', status: 'visca_error' };
  }
  return { kind: 'ignore', status: 'error' };
}

function udpExchange(host, bytes, options) {
  const target = normalizeHost(host);
  const payload = normalizeBytes(bytes);
  if (!target || !payload) return Promise.resolve({ status: 'unavailable', ack: false, reply: null });
  const port = Number(options && options.port) || intEnv('PTZ_VISCA_PORT', DEFAULT_PORT);
  const timeoutMs = Number(options && options.timeoutMs) || DEFAULT_TIMEOUT_MS;

  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    let settled = false;
    let ack = false;
    const finish = (status, reply) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch (_) { /* already closed */ }
      resolve({ status, ack, reply: reply || null });
    };
    const timer = setTimeout(() => finish('unavailable', null), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    socket.on('message', (message) => {
      const parsed = classifyReply(message);
      if (parsed.kind === 'ack') {
        ack = true;
        return;
      }
      if (parsed.kind === 'completion') finish('ok', parsed.reply);
      else if (parsed.kind === 'error') finish(parsed.status, message);
    });
    socket.once('error', () => finish('unavailable', null));
    socket.send(payload, port, target, (error) => {
      if (error) finish('unavailable', null);
    });
  });
}

function tcpExchange(host, bytes, options) {
  const target = normalizeHost(host);
  const payload = normalizeBytes(bytes);
  if (!target || !payload) return Promise.resolve({ status: 'unavailable', ack: false, reply: null });
  const port = Number(options && options.tcpPort) || intEnv('PTZ_VISCA_TCP_PORT', DEFAULT_TCP_PORT);
  const timeoutMs = Number(options && options.timeoutMs) || DEFAULT_TIMEOUT_MS;

  return new Promise((resolve) => {
    const socket = net.createConnection({ host: target, port });
    let settled = false;
    let ack = false;
    let pending = Buffer.alloc(0);
    const finish = (status, reply) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ status, ack, reply: reply || null });
    };
    const timer = setTimeout(() => finish('unavailable', null), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    socket.once('connect', () => socket.write(payload));
    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, Buffer.from(chunk)]);
      let end;
      while ((end = pending.indexOf(0xff)) >= 0) {
        const frame = pending.subarray(0, end + 1);
        pending = pending.subarray(end + 1);
        const parsed = classifyReply(frame);
        if (parsed.kind === 'ack') ack = true;
        else if (parsed.kind === 'completion') { finish('ok', parsed.reply); return; }
        else if (parsed.kind === 'error') { finish(parsed.status, frame); return; }
      }
    });
    socket.once('error', () => finish('unavailable', null));
    socket.once('end', () => finish('unavailable', null));
  });
}

async function exchange(host, bytes, options) {
  try {
    const udp = await udpExchange(host, bytes, options);
    if (udp.status !== 'unavailable' || (options && options.tcpFallback === false)) return udp;
    return await tcpExchange(host, bytes, options);
  } catch (_) {
    return { status: 'unavailable', ack: false, reply: null };
  }
}

async function send(host, bytes, options) {
  const result = await exchange(host, bytes, options || {});
  return result.status === 'ok' ? result : result.status;
}

async function inquire(host, bytes, options) {
  const result = await exchange(host, bytes, options || {});
  if (result.status !== 'ok' || !result.reply) return result.status;
  return Buffer.from(result.reply);
}

function payloadFromReply(reply) {
  return Buffer.isBuffer(reply) && reply.length >= 4 ? reply.subarray(2, reply.length - 1) : null;
}

function nibblesToNumber(values, signed) {
  if (!values || values.length === 0 || [...values].some((value) => (value & 0xf0) !== 0)) return null;
  let number = 0;
  for (const value of values) number = (number << 4) | value;
  const bits = values.length * 4;
  if (signed && bits > 0 && (number & (1 << (bits - 1)))) number -= 2 ** bits;
  return number;
}

function numberToNibbles(value, count) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number >= 2 ** (count * 4)) return null;
  const out = new Array(count);
  let remaining = number;
  for (let index = count - 1; index >= 0; index -= 1) {
    out[index] = remaining & 0x0f;
    remaining >>= 4;
  }
  return out;
}

function statusOf(result) {
  return result && typeof result === 'object' && result.status === 'ok' ? 'ok' : String(result || 'unavailable');
}

async function command(host, bytes, options) {
  return statusOf(await send(host, bytes, options));
}

async function oneByteInquiry(host, bytes, options) {
  const reply = await inquire(host, bytes, options);
  if (!Buffer.isBuffer(reply)) return reply;
  const payload = payloadFromReply(reply);
  return payload && payload.length === 1 ? payload[0] : 'unavailable';
}

async function nibbleInquiry(host, bytes, count, signed, options) {
  const reply = await inquire(host, bytes, options);
  if (!Buffer.isBuffer(reply)) return reply;
  const payload = payloadFromReply(reply);
  if (!payload || payload.length < count) return 'unavailable';
  const value = nibblesToNumber(payload.subarray(payload.length - count), signed);
  return value === null ? 'unavailable' : value;
}

async function resetPanTilt(host, options) {
  return command(host, [0x81, 0x01, 0x06, 0x05, 0xff], options);
}

async function getPanTilt(host, options) {
  const reply = await inquire(host, [0x81, 0x09, 0x06, 0x12, 0xff], options);
  if (!Buffer.isBuffer(reply)) return reply;
  const payload = payloadFromReply(reply);
  if (!payload || payload.length !== 8) return 'unavailable';
  const pan = nibblesToNumber(payload.subarray(0, 4), true);
  const tilt = nibblesToNumber(payload.subarray(4, 8), true);
  return pan === null || tilt === null ? 'unavailable' : { pan, tilt };
}

async function getZoom(host, options) {
  return nibbleInquiry(host, [0x81, 0x09, 0x04, 0x47, 0xff], 4, false, options);
}

async function getWbMode(host, options) {
  return oneByteInquiry(host, [0x81, 0x09, 0x04, 0x35, 0xff], options);
}

async function getRGain(host, options) {
  return nibbleInquiry(host, [0x81, 0x09, 0x04, 0x43, 0xff], 2, false, options);
}

async function getBGain(host, options) {
  return nibbleInquiry(host, [0x81, 0x09, 0x04, 0x44, 0xff], 2, false, options);
}

async function getColorTemperature(host, options) {
  return nibbleInquiry(host, [0x81, 0x09, 0x04, 0x20, 0xff], 2, false, options);
}

async function getAeMode(host, options) {
  return oneByteInquiry(host, [0x81, 0x09, 0x04, 0x39, 0xff], options);
}

async function getShutter(host, options) {
  return nibbleInquiry(host, [0x81, 0x09, 0x04, 0x4a, 0xff], 2, false, options);
}

async function getIris(host, options) {
  return nibbleInquiry(host, [0x81, 0x09, 0x04, 0x4b, 0xff], 2, false, options);
}

async function getBright(host, options) {
  return nibbleInquiry(host, [0x81, 0x09, 0x04, 0x4d, 0xff], 2, false, options);
}

async function getBrightness(host, options) {
  return nibbleInquiry(host, [0x81, 0x09, 0x04, 0xa1, 0xff], 2, false, options);
}

async function getContrast(host, options) {
  return nibbleInquiry(host, [0x81, 0x09, 0x04, 0xa2, 0xff], 2, false, options);
}

async function getFlip(host, options) {
  return oneByteInquiry(host, [0x81, 0x09, 0x04, 0xa4, 0xff], options);
}

async function getHue(host, options) {
  return nibbleInquiry(host, [0x81, 0x09, 0x04, 0x4f, 0xff], 1, false, options);
}

async function setOneByte(host, prefix, value, options) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 255) return 'error';
  return command(host, [...prefix, number, 0xff], options);
}

async function setNibbles(host, prefix, value, count, options) {
  const nibbles = numberToNibbles(value, count);
  if (!nibbles) return 'error';
  return command(host, [...prefix, ...nibbles, 0xff], options);
}

const setWbMode = (host, value, options) => setOneByte(host, [0x81, 0x01, 0x04, 0x35], value, options);
const setRGain = (host, value, options) => setNibbles(host, [0x81, 0x01, 0x04, 0x43, 0x00, 0x00], value, 2, options);
const setBGain = (host, value, options) => setNibbles(host, [0x81, 0x01, 0x04, 0x44, 0x00, 0x00], value, 2, options);
const setColorTemperature = (host, value, options) => setNibbles(host, [0x81, 0x01, 0x04, 0x20], value, 2, options);
const setAeMode = (host, value, options) => setOneByte(host, [0x81, 0x01, 0x04, 0x39], value, options);
const setBrightness = (host, value, options) => setNibbles(host, [0x81, 0x01, 0x04, 0xa1, 0x00, 0x00], value, 2, options);
const setContrast = (host, value, options) => setNibbles(host, [0x81, 0x01, 0x04, 0xa2, 0x00, 0x00], value, 2, options);
const setFlip = (host, value, options) => setOneByte(host, [0x81, 0x01, 0x04, 0xa4], value, options);
const setHue = (host, value, options) => setNibbles(host, [0x81, 0x01, 0x04, 0x4f, 0x00, 0x00, 0x00], value, 1, options);

async function probe(host, options) {
  return typeof (await getWbMode(host, options)) === 'number' ? 'ok' : 'unavailable';
}

async function readState(host, options) {
  const entries = await Promise.all([
    getPanTilt(host, options).then((value) => ['position', value]),
    getZoom(host, options).then((value) => ['zoom', value]),
    getWbMode(host, options).then((value) => ['wbmode', value]),
    getRGain(host, options).then((value) => ['rgain', value]),
    getBGain(host, options).then((value) => ['bgain', value]),
    getColorTemperature(host, options).then((value) => ['color_temperature', value]),
    getAeMode(host, options).then((value) => ['aemode', value]),
    getShutter(host, options).then((value) => ['shutter', value]),
    getIris(host, options).then((value) => ['iris', value]),
    getBright(host, options).then((value) => ['bright', value]),
    getBrightness(host, options).then((value) => ['brightness', value]),
    getContrast(host, options).then((value) => ['contrast', value]),
    getFlip(host, options).then((value) => ['flip', value]),
    getHue(host, options).then((value) => ['hue', value]),
  ]);
  const out = {};
  for (const [key, value] of entries) {
    if (key === 'position' && value && typeof value === 'object') {
      out.pan = value.pan;
      out.tilt = value.tilt;
    } else if (typeof value === 'number') {
      out[key] = value;
    }
  }
  return Object.keys(out).length ? out : 'unavailable';
}

const PROFILE_SETTERS = {
  wbmode: setWbMode,
  rgain: setRGain,
  bgain: setBGain,
  color_temperature: setColorTemperature,
  aemode: setAeMode,
  brightness: setBrightness,
  contrast: setContrast,
  flip: setFlip,
  hue: setHue,
};

async function applyProfile(host, profile, options) {
  if (profile == null) return { status: 'skipped', failures: [], results: {} };
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    return { status: 'error', failures: ['profile'], results: {} };
  }
  const keys = Object.keys(PROFILE_SETTERS).filter((key) => Object.prototype.hasOwnProperty.call(profile, key));
  if (!keys.length) return { status: 'skipped', failures: [], results: {} };
  const results = {};
  const failures = [];
  for (const key of keys) {
    const status = await PROFILE_SETTERS[key](host, profile[key], options);
    results[key] = status;
    if (status !== 'ok') failures.push(key);
  }
  return {
    status: failures.length === 0 ? 'ok' : (failures.length === keys.length ? 'error' : 'partial'),
    failures,
    results,
  };
}

module.exports = {
  DEFAULT_PORT,
  DEFAULT_TCP_PORT,
  DEFAULT_TIMEOUT_MS,
  applyProfile,
  classifyReply,
  getAeMode,
  getBGain,
  getBright,
  getBrightness,
  getColorTemperature,
  getContrast,
  getFlip,
  getHue,
  getIris,
  getPanTilt,
  getRGain,
  getShutter,
  getWbMode,
  getZoom,
  inquire,
  nibblesToNumber,
  probe,
  readState,
  resetPanTilt,
  send,
  setAeMode,
  setBGain,
  setBrightness,
  setColorTemperature,
  setContrast,
  setFlip,
  setHue,
  setRGain,
  setWbMode,
};
