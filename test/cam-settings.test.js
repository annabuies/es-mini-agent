'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { parseConf, readGolden, restoreCameras, snapshotCameras, writeGolden } = require('../cam-settings');
const FIXTURES = path.join(__dirname, 'fixtures', 'vx61as-6.2.54');
const read = (folder, name, kind) => fs.readFileSync(path.join(FIXTURES, folder, `${name}_get_${kind}.txt`), 'utf8');

test('real VX61AS fixtures parse duplicate focus, separate bright, and tally JSON', () => {
  const advance = parseConf(read('01-baseline', 'cam1', 'advance_image_conf'));
  assert.equal(advance.focus_mode, '3');
  assert.equal(parseConf(read('01-baseline', 'cam1', 'image_conf')).bright, '10');
  assert.equal(advance.bright, '7');
  assert.equal(parseConf(read('01-baseline', 'cam1', 'tally_status')).data.tally, 'Off');
});

test('fixture snapshot keeps each camera namespace separate and stores device', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cam-settings-')); t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
  const requestFn = async (url) => {
    const cam = url.match(/127\.0\.0\.1:(\d+)/)[1], name = 'cam' + (Number(cam) - 1);
    const kind = url.includes('get_image_conf') ? 'image_conf' : url.includes('get_advance') ? 'advance_image_conf' : 'device_conf';
    return { statusCode:200, body:read('01-baseline', name, kind) };
  };
  const snapshot = await snapshotCameras([{name:'cam1',host:'127.0.0.1:2'},{name:'cam2',host:'127.0.0.1:3'},{name:'cam3',host:'127.0.0.1:4'}], { requestFn });
  assert.equal(snapshot.cameras.cam1.image.bright, '10'); assert.equal(snapshot.cameras.cam1.advance.bright, '7'); assert.equal(snapshot.cameras.cam1.device.devtype, 'VX61AS');
  writeGolden(dir, snapshot); assert.deepEqual(readGolden(dir), snapshot);
});

test('fixture restore writes only cam3 drift, skips auto-mode settings, and verifies namespaces', async () => {
  const baseline = { image:parseConf(read('01-baseline','cam3','image_conf')), advance:parseConf(read('01-baseline','cam3','advance_image_conf')) };
  const state = { image:parseConf(read('02-postreboot','cam3','image_conf')), advance:parseConf(read('02-postreboot','cam3','advance_image_conf')) }, writes = [];
  const requestFn = async (url) => {
    if (url.includes('get_image_conf')) return {statusCode:200,body:Object.entries(state.image).map(([k,v]) => `${k}="${v}"`).join('\n')};
    if (url.includes('get_advance')) return {statusCode:200,body:Object.entries(state.advance).map(([k,v]) => `${k}="${v}"`).join('\n')};
    const [, param, value] = url.match(/post_image_value&([^&]+)&([^&]+)/); writes.push([param, value]);
    const key = {drc:'drc',bright:'bright',luminance:'luminance'}[param]; if (key) state[param === 'bright' || param === 'luminance' ? 'image' : 'advance'][key] = value;
    return {statusCode:200,body:''};
  };
  const result = await restoreCameras([{name:'cam3',host:'127.0.0.1:4'}], { cameras:{cam3:baseline} }, { requestFn, only:['cam3'], delayMs:0 });
  assert.deepEqual(writes, [['drc','6'],['bright','10'],['luminance','10']]);
  assert.equal(result.cameras.cam3.applied, 3); assert.equal(result.cameras.cam3.verified, 3);
  assert.deepEqual(result.cameras.cam3.skipped.map((x) => x.key).sort(), ['advance.bgain','advance.manual_gain','advance.rgain','advance.shutter','advance.iris','advance.temperature'].sort());
  assert.ok(!writes.some(([p,v]) => p === 'bright' && v === '7'));
});

test('explicit manual white-balance token restores red and blue gain mode-first', async () => {
  const source = { image:{}, advance:{wb_mode:'manual', exposure_mode:'3', rgain:'45', bgain:'68'} }, state = { image:{}, advance:{wb_mode:'5', exposure_mode:'3', rgain:'41', bgain:'69'} }, writes = [];
  const body = (o) => Object.entries(o).map(([k,v]) => `${k}="${v}"`).join('\n');
  const requestFn = async (url) => { if (url.includes('get_image')) return {statusCode:200,body:''}; if (url.includes('get_advance')) return {statusCode:200,body:body(state.advance)}; const [,p,v] = url.match(/post_image_value&([^&]+)&([^&]+)/); writes.push(p); state.advance[{wbmode:'wb_mode',rgain:'rgain',bgain:'bgain'}[p]] = v; return {statusCode:200,body:''}; };
  const result = await restoreCameras([{name:'cam3',host:'127.0.0.1:4'}], {cameras:{cam3:source}}, {requestFn,delayMs:0});
  assert.deepEqual(writes, ['wbmode','rgain','bgain']); assert.equal(result.cameras.cam3.verified, 3);
});
