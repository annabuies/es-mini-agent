'use strict';
const fs = require('fs');
const path = require('path');
const { requestWithDigest } = require('./digest-auth');
const { normalizeCameras } = require('./ptz');
const GOLDEN_FILE = '.cam-golden.json';

// API v1 documents textual modes but not VX61AS numeric equivalents. Never guess
// them: only explicit documented tokens unlock manual-only settings.
const MANUAL_WB_MODES = new Set(['manual']);
const COLOR_TEMPERATURE_WB_MODES = new Set(['var']);
const MANUAL_OR_PRIORITY_EXPOSURE_MODES = new Set(['manual', 'sae', 'aae']);
const REPORT_ONLY_KEYS = new Set(['tallymode', 'focus_mode', 'imageOrientation', 'flip', 'mirror', 'autotrack', 'trackswitch', 'nr3d', 'nr2d', 'devname', 'serial_num', 'versioninfo', 'device_model', 'bgain_tuning', 'rgain_tuning']);
// advance.bright is intentionally excluded: it is not image.bright.
const RESTORE_KEY_MAP = {
  'advance.wb_mode': { ns: 'advance', key: 'wb_mode', param: 'wbmode', kind: 'enum', requires: null, doc: 'Color / White Balance Mode' },
  'advance.exposure_mode': { ns: 'advance', key: 'exposure_mode', param: 'aemode', kind: 'enum', requires: null, doc: 'Exposure / Exposure Mode' },
  'advance.rgain': { ns: 'advance', key: 'rgain', param: 'rgain', kind: 'int', range: [0,255], requires: { key: 'wb_mode', oneOf: [...MANUAL_WB_MODES] }, doc: 'Color / Red Gain' },
  'advance.bgain': { ns: 'advance', key: 'bgain', param: 'bgain', kind: 'int', range: [0,255], requires: { key: 'wb_mode', oneOf: [...MANUAL_WB_MODES] }, doc: 'Color / Blue Gain' },
  'advance.temperature': { ns: 'advance', key: 'temperature', param: 'colortemp', kind: 'int', range: [2500,8000], requires: { key: 'wb_mode', oneOf: [...COLOR_TEMPERATURE_WB_MODES] }, doc: 'Color / Color Temperature' },
  'advance.manual_gain': { ns: 'advance', key: 'manual_gain', param: 'gain', kind: 'int', range: [0,7], requires: { key: 'exposure_mode', oneOf: [...MANUAL_OR_PRIORITY_EXPOSURE_MODES] }, doc: 'Exposure / Gain' },
  'advance.shutter': { ns: 'advance', key: 'shutter', param: 'shutter', kind: 'int', range: [1,17], requires: { key: 'exposure_mode', oneOf: [...MANUAL_OR_PRIORITY_EXPOSURE_MODES] }, doc: 'Exposure / Shutter Control' },
  'advance.iris': { ns: 'advance', key: 'iris', param: 'iris', kind: 'int', range: [0,12], requires: { key: 'exposure_mode', oneOf: [...MANUAL_OR_PRIORITY_EXPOSURE_MODES] }, doc: 'Exposure / Iris Control' },
  'advance.expcomp_level': { ns: 'advance', key: 'expcomp_level', param: 'expcomp_level', kind: 'int', range: [-20,20], requires: null, doc: 'Exposure / Exp Comp' },
  'advance.backlight': { ns: 'advance', key: 'backlight', param: 'backlight', kind: 'enum', requires: null, doc: 'Exposure / Backlight' },
  'advance.drc': { ns: 'advance', key: 'drc', param: 'drc', kind: 'int', range: [0,8], requires: null, doc: 'Exposure / Dynamic Range Control' },
  ...Object.fromEntries(['bright','saturation','hue','sharpness','contrast','luminance'].map((key) => ['image.' + key, { ns: 'image', key, param: key, kind: 'int', range: [0,14], requires: null, doc: 'Image / ' + key }])),
};
function parseConf(text) {
  if (text && typeof text === 'object') return text;
  const raw = String(text || '').trim(); try { const p = JSON.parse(raw); if (p && typeof p === 'object' && !Array.isArray(p)) return p; } catch (_) {}
  const out = {}, re = /([A-Za-z0-9_-]+)\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^\s]+))/g; let m;
  while ((m = re.exec(raw))) out[m[1]] = typeof m[2] === 'string' ? m[2].replace(/\\(.)/g, '$1') : m[3]; return out;
}
function validValue(value, rule) { if (!['string','number'].includes(typeof value)) return false; const n = Number(value); return rule.kind !== 'int' || (Number.isInteger(n) && (!rule.range || (n >= rule.range[0] && n <= rule.range[1]))); }
function cameraUrl(camera, suffix) { return `http://${camera.host}${suffix}`; }
function defaultRequest(url, o) { return requestWithDigest({ url, username: o.credentials && o.credentials.username, password: o.credentials && o.credentials.password, timeoutMs: o.timeoutMs, includeBody: true }); }
function isOk(res) { return res.statusCode >= 200 && res.statusCode < 300; }
async function readNamespace(camera, ns, o) { const res = await o.requestFn(cameraUrl(camera, ns === 'image' ? '/param.cgi?get_image_conf' : '/param.cgi?get_advance_image_conf'), o); return { res, values: isOk(res) ? parseConf(res.body) : {} }; }
async function snapshotCameras(cameras, { credentials, timeoutMs = 15000, requestFn = defaultRequest } = {}) {
  const entries = await Promise.all((normalizeCameras(cameras) || []).map(async (camera) => {
    const o = { credentials, timeoutMs, requestFn }, errors = [], image = await readNamespace(camera, 'image', o), advance = await readNamespace(camera, 'advance', o);
    if (!isOk(image.res)) errors.push(`image_${image.res.statusCode || 'error'}`); if (!isOk(advance.res)) errors.push(`advance_${advance.res.statusCode || 'error'}`);
    const deviceRes = await requestFn(cameraUrl(camera, '/param.cgi?get_device_conf'), o), device = isOk(deviceRes) ? parseConf(deviceRes.body) : null;
    if (!isOk(deviceRes)) errors.push(`device_${deviceRes.statusCode || 'error'}`);
    return [camera.name, { ok: errors.length === 0 || (errors.length === 1 && ['advance_404','device_404'].includes(errors[0])), image: image.values, advance: isOk(advance.res) ? advance.values : null, device, errors }];
  })); return { taken_at: new Date().toISOString(), cameras: Object.fromEntries(entries) };
}
function writeGolden(projectDir, snapshot) { const target = path.join(projectDir, GOLDEN_FILE), data = JSON.stringify(snapshot, null, 2) + '\n', temp = `${target}.tmp-${process.pid}-${Date.now()}`; fs.writeFileSync(temp, data, { mode: 0o600 }); fs.renameSync(temp, target); return { path: target, bytes: Buffer.byteLength(data) }; }
function readGolden(projectDir) { try { return JSON.parse(fs.readFileSync(path.join(projectDir, GOLDEN_FILE), 'utf8')); } catch (_) { return null; } }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function restoreCameras(cameras, golden, { credentials, timeoutMs = 60000, requestFn = defaultRequest, keys, only, delayMs = 500 } = {}) {
  const wanted = new Set(Array.isArray(only) ? only : []), filter = Array.isArray(keys) ? new Set(keys) : null, results = {};
  for (const camera of (normalizeCameras(cameras) || []).filter((c) => !wanted.size || wanted.has(c.name))) {
    const source = golden && golden.cameras && golden.cameras[camera.name]; if (!source) { results[camera.name] = { ok:false, applied:0, verified:0, failed:['no_golden_camera'], skipped:[], unmapped:[] }; continue; }
    const values = { image: source.image || {}, advance: source.advance || {} }, skipped = [];
    const unmapped = Object.entries(values).flatMap(([ns, v]) => Object.keys(v).filter((key) => !RESTORE_KEY_MAP[ns + '.' + key] && !REPORT_ONLY_KEYS.has(key)).map((key) => ns + '.' + key));
    const entries = Object.values(RESTORE_KEY_MAP).filter((e) => { const value = values[e.ns][e.key]; if ((filter && !filter.has(e.key) && !filter.has(e.ns + '.' + e.key)) || !validValue(value, e)) return false; if (e.requires && !e.requires.oneOf.includes(String(values[e.ns][e.requires.key]).toLowerCase())) { skipped.push({ key:e.ns + '.' + e.key, reason:'auto_mode' }); return false; } return true; }).sort((a,b) => Number(!['wb_mode','exposure_mode'].includes(a.key)) - Number(!['wb_mode','exposure_mode'].includes(b.key)));
    const o = { credentials, timeoutMs, requestFn }, before = { image:(await readNamespace(camera,'image',o)).values, advance:(await readNamespace(camera,'advance',o)).values };
    const changed = entries.filter((e) => String(before[e.ns][e.key]) !== String(values[e.ns][e.key])); let applied = 0; const failed = [];
    for (const e of changed) { const res = await requestFn(cameraUrl(camera, `/ptzctrl.cgi?post_image_value&${encodeURIComponent(e.param)}&${encodeURIComponent(values[e.ns][e.key])}`), o); if (isOk(res)) applied++; else failed.push(e.ns + '.' + e.key); if (delayMs) await sleep(delayMs); }
    const after = { image:(await readNamespace(camera,'image',o)).values, advance:(await readNamespace(camera,'advance',o)).values }; let verified = 0; for (const e of changed) if (String(after[e.ns][e.key]) === String(values[e.ns][e.key])) verified++;
    results[camera.name] = { ok: failed.length === 0 && verified === applied, applied, verified, failed, skipped, unmapped };
  } return { ok: Object.values(results).every((item) => item.ok), cameras:results };
}
module.exports = { GOLDEN_FILE, RESTORE_KEY_MAP, REPORT_ONLY_KEYS, parseConf, readGolden, restoreCameras, snapshotCameras, writeGolden };
