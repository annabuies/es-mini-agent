'use strict';

const fs = require('fs');
const path = require('path');
const { requestWithDigest } = require('./digest-auth');
const { normalizeCameras } = require('./ptz');

const GOLDEN_FILE = '.cam-golden.json';
// PTZOptics HTTP API v1.0 Color, Exposure, and Image sections. Only documented
// post_image_value parameters appear here; every other read key remains unmapped.
const RESTORE_KEY_MAP = {
  wbmode: { param: 'wbmode', kind: 'enum', doc: 'Color / White balance mode' },
  aemode: { param: 'aemode', kind: 'enum', doc: 'Exposure / Exposure mode' },
  bgain: { param: 'bgain', kind: 'int', range: [0, 255], doc: 'Color / Blue gain' },
  rgain: { param: 'rgain', kind: 'int', range: [0, 255], doc: 'Color / Red gain' },
  colortemp: { param: 'colortemp', kind: 'int', range: [0, 10000], doc: 'Color / Temperature' },
  gain: { param: 'gain', kind: 'int', range: [0, 255], doc: 'Exposure / Gain' },
  shutter: { param: 'shutter', kind: 'int', range: [0, 100000], doc: 'Exposure / Shutter' },
  iris: { param: 'iris', kind: 'int', range: [0, 255], doc: 'Exposure / Iris' },
  backlight: { param: 'backlight', kind: 'enum', doc: 'Exposure / Backlight' },
  expcomp_level: { param: 'expcomp_level', kind: 'int', range: [-20, 20], doc: 'Exposure / Compensation' },
  bright: { param: 'bright', kind: 'int', range: [0, 255], doc: 'Image / Brightness' },
  saturation: { param: 'saturation', kind: 'int', range: [0, 255], doc: 'Image / Saturation' },
  hue: { param: 'hue', kind: 'int', range: [0, 255], doc: 'Image / Hue' },
  sharpness: { param: 'sharpness', kind: 'int', range: [0, 255], doc: 'Image / Sharpness' },
  contrast: { param: 'contrast', kind: 'int', range: [0, 255], doc: 'Image / Contrast' },
  luminance: { param: 'luminance', kind: 'int', range: [0, 255], doc: 'Image / Luminance' },
};

function parseConf(text) {
  if (text && typeof text === 'object') return text;
  const raw = String(text || '').trim();
  try { const parsed = JSON.parse(raw); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed; } catch (_) {}
  const out = {};
  const re = /([A-Za-z0-9_-]+)\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^\s]+))/g;
  let match;
  while ((match = re.exec(raw))) out[match[1]] = (typeof match[2] === 'string' ? match[2].replace(/\\(.)/g, '$1') : match[3]);
  return out;
}

function validValue(value, rule) {
  if (typeof value !== 'string' && typeof value !== 'number') return false;
  if (rule.kind !== 'int') return true;
  const number = Number(value);
  return Number.isInteger(number) && (!rule.range || (number >= rule.range[0] && number <= rule.range[1]));
}

function cameraUrl(camera, suffix) { return `http://${camera.host}${suffix}`; }
function defaultRequest(url, options) {
  return requestWithDigest({ url, username: options.credentials && options.credentials.username,
    password: options.credentials && options.credentials.password, timeoutMs: options.timeoutMs, includeBody: true });
}

async function snapshotCameras(cameras, { credentials, timeoutMs = 15000, requestFn = defaultRequest } = {}) {
  const normalized = normalizeCameras(cameras) || [];
  const taken_at = new Date().toISOString();
  const entries = await Promise.all(normalized.map(async (camera) => {
    const errors = [];
    const imageRes = await requestFn(cameraUrl(camera, '/param.cgi?get_image_conf'), { credentials, timeoutMs });
    const image = imageRes.statusCode >= 200 && imageRes.statusCode < 300 ? parseConf(imageRes.body) : {};
    if (!(imageRes.statusCode >= 200 && imageRes.statusCode < 300)) errors.push(`image_${imageRes.statusCode || 'error'}`);
    const advanceRes = await requestFn(cameraUrl(camera, '/param.cgi?get_advance_image_conf'), { credentials, timeoutMs });
    let advance = null;
    if (advanceRes.statusCode >= 200 && advanceRes.statusCode < 300) advance = parseConf(advanceRes.body);
    else errors.push(`advance_${advanceRes.statusCode || 'error'}`);
    return [camera.name, { ok: errors.length === 0 || (errors.length === 1 && errors[0] === 'advance_404'), image, advance, errors }];
  }));
  return { taken_at, cameras: Object.fromEntries(entries) };
}

function writeGolden(projectDir, snapshot) {
  const target = path.join(projectDir, GOLDEN_FILE);
  const data = JSON.stringify(snapshot, null, 2) + '\n';
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, data, { mode: 0o600 });
  fs.renameSync(temp, target);
  return { path: target, bytes: Buffer.byteLength(data) };
}
function readGolden(projectDir) { try { return JSON.parse(fs.readFileSync(path.join(projectDir, GOLDEN_FILE), 'utf8')); } catch (_) { return null; } }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function restoreCameras(cameras, golden, { credentials, timeoutMs = 60000, requestFn = defaultRequest, keys, only, delayMs = 500 } = {}) {
  const wanted = new Set(Array.isArray(only) ? only : []);
  const filter = Array.isArray(keys) ? new Set(keys) : null;
  const selected = (normalizeCameras(cameras) || []).filter((camera) => !wanted.size || wanted.has(camera.name));
  const results = {};
  for (const camera of selected) {
    const source = golden && golden.cameras && golden.cameras[camera.name];
    if (!source) { results[camera.name] = { ok: false, applied: 0, verified: 0, failed: ['no_golden_camera'], unmapped: [] }; continue; }
    const combined = { ...(source.image || {}), ...(source.advance || {}) };
    const unmapped = Object.keys(combined).filter((key) => !RESTORE_KEY_MAP[key]);
    const entries = Object.entries(combined).filter(([key, value]) => RESTORE_KEY_MAP[key] && (!filter || filter.has(key)) && validValue(value, RESTORE_KEY_MAP[key]));
    entries.sort(([a], [b]) => Number(!['wbmode', 'aemode'].includes(a)) - Number(!['wbmode', 'aemode'].includes(b)));
    const failed = []; let applied = 0;
    for (const [key, value] of entries) {
      const rule = RESTORE_KEY_MAP[key];
      const res = await requestFn(cameraUrl(camera, `/ptzctrl.cgi?post_image_value&${encodeURIComponent(rule.param)}&${encodeURIComponent(value)}`), { credentials, timeoutMs });
      if (res.statusCode >= 200 && res.statusCode < 300) applied += 1; else failed.push(key);
      if (delayMs) await sleep(delayMs);
    }
    const read = await requestFn(cameraUrl(camera, '/param.cgi?get_image_conf'), { credentials, timeoutMs });
    const after = parseConf(read.body); let verified = 0;
    for (const [key, value] of entries) if (String(after[key]) === String(value)) verified += 1;
    results[camera.name] = { ok: failed.length === 0 && verified === applied, applied, verified, failed, unmapped };
  }
  return { ok: Object.values(results).every((item) => item.ok), cameras: results };
}
module.exports = { GOLDEN_FILE, RESTORE_KEY_MAP, parseConf, readGolden, restoreCameras, snapshotCameras, writeGolden };
