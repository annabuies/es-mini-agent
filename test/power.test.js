'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  DEFAULT_SWITCHABLE, OUTLET_MAP, createStripClient, describePower, isDeniedName,
  parseSwitchable, readPowerConfig, runPower,
} = require('../power');
const { createFakeDli } = require('./fake-dli');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

// Records every request power.js would send and answers like a healthy strip.
function fakeRequest(overrides) {
  const calls = [];
  const states = [true, true, true, true, false, false, false, false];
  const request = async (options) => {
    calls.push(options);
    const custom = overrides && overrides(options);
    if (custom) return custom;
    const path = new URL(options.url).pathname;
    if (path === '/restapi/relay/outlets/all;/physical_state/') return { statusCode: 207, body: JSON.stringify(states) };
    if (path === '/restapi/relay/outlets/all;/name/') return { statusCode: 207, body: JSON.stringify(['R', 'P', 'M', 'Lights', '5', '6', '7', '8']) };
    const one = /\/outlets\/(\d)\/(physical_state|transient_state)\/$/.exec(path);
    if (one && options.method === 'PUT') {
      states[Number(one[1])] = options.body === 'value=true';
      return { statusCode: 204, body: '' };
    }
    if (one) return { statusCode: 200, body: JSON.stringify(states[Number(one[1])]) };
    return { statusCode: 404, body: '' };
  };
  return { calls, request, writes: () => calls.filter((c) => c.method !== 'GET') };
}

const CONFIGURED = { baseUrl: 'http://127.0.0.1:9', credentials: { username: 'u', password: 'p' }, switchable: ['lights'], rejected: [] };
const IDLE = { recording: false, uploading: false };

test('POWER_OUTLETS_SWITCHABLE defaults to lights and never admits router/poe/mini/nas or aliases', () => {
  assert.deepEqual(DEFAULT_SWITCHABLE, ['lights']);
  assert.deepEqual(parseSwitchable(undefined), { switchable: ['lights'], rejected: [] });
  assert.deepEqual(parseSwitchable('  '), { switchable: ['lights'], rejected: [] });
  assert.deepEqual(parseSwitchable('Lights, evo,lights'), { switchable: ['lights', 'evo'], rejected: [] });
  assert.deepEqual(parseSwitchable('mini,router,poe,nas,lights'), {
    switchable: ['lights'], rejected: ['mini', 'router', 'poe', 'nas'],
  });
  assert.deepEqual(parseSwitchable('Mac Mini,mac-mini,outlet3,3,poe-switch,internet,spare5'), {
    switchable: [], rejected: ['mac mini', 'mac-mini', 'outlet3', '3', 'poe-switch', 'internet', 'spare5'],
  });
  // An env that names only denied outlets switches nothing; it does not fall back to lights.
  assert.deepEqual(parseSwitchable('mini'), { switchable: [], rejected: ['mini'] });
  for (const name of ['mini', 'MINI', 'Mac_Mini', 'router', 'PoE', 'nas', 'outlet1', '2']) {
    assert.equal(isDeniedName(name), true, name);
  }
  assert.equal(isDeniedName('lights'), false);
  assert.deepEqual(OUTLET_MAP, { router: 1, poe: 2, mini: 3, lights: 4, evo: null, nas: null });
});

test('never switches mini/router/poe/nas even when a config lists them as switchable', async () => {
  const fake = fakeRequest();
  const forced = { ...CONFIGURED, switchable: ['mini', 'router', 'poe', 'nas', 'lights'] };
  for (const action of ['on', 'off']) {
    for (const name of ['mini', 'router', 'poe', 'nas', 'Mac Mini', 'outlet3', '3']) {
      const result = await runPower(forced, { action, outlets: [name] }, IDLE, { request: fake.request });
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'outlet_denied', `${action} ${name}`);
    }
    // A denied name anywhere in the list refuses the whole request before any write.
    const mixed = await runPower(forced, { action, outlets: ['lights', 'mini'] }, IDLE, { request: fake.request });
    assert.deepEqual(mixed, { ok: false, action, reason: 'outlet_denied', outlet: 'mini' });
  }
  assert.equal(fake.calls.length, 0);
});

test('the strip client refuses to write outlets 1-3 whatever asks it to', async () => {
  const fake = fakeRequest();
  const client = createStripClient(CONFIGURED, { request: fake.request });
  for (const outlet of [1, 2, 3, 0, 9, '4', null]) {
    assert.equal(await client.write(outlet, false), 'outlet_denied', String(outlet));
  }
  assert.equal(fake.calls.length, 0);
});

test('unset POWER_STRIP_URL answers power_unconfigured without any request', async () => {
  const config = readPowerConfig({});
  assert.equal(config.baseUrl, null);
  assert.equal(readPowerConfig({ POWER_STRIP_URL: 'https://172.16.1.40' }).baseUrl, null);
  assert.equal(readPowerConfig({ POWER_STRIP_URL: 'not a url' }).baseUrl, null);
  assert.equal(readPowerConfig({ POWER_STRIP_URL: 'http://172.16.1.40/' }).baseUrl, 'http://172.16.1.40');
  const fake = fakeRequest();
  assert.deepEqual(await runPower(config, {}, IDLE, { request: fake.request }), { ok: false, action: 'status', reason: 'power_unconfigured' });
  assert.deepEqual(await runPower(config, { action: 'on', outlets: ['lights'] }, IDLE, { request: fake.request }), { ok: false, action: 'on', reason: 'power_unconfigured' });
  assert.deepEqual(await runPower(config, { action: 'off', outlets: 'all' }, IDLE, { request: fake.request }), { ok: false, action: 'off', reason: 'power_unconfigured' });
  assert.deepEqual(await runPower(undefined, undefined, undefined), { ok: false, action: 'status', reason: 'power_unconfigured' });
  assert.equal(fake.calls.length, 0);
});

test('refuses off while recording or uploading; on is still allowed', async () => {
  const fake = fakeRequest();
  assert.deepEqual(await runPower(CONFIGURED, { action: 'off', outlets: ['lights'] }, { recording: true, uploading: false }, { request: fake.request }),
    { ok: false, action: 'off', reason: 'busy_recording' });
  assert.deepEqual(await runPower(CONFIGURED, { action: 'off', outlets: 'all' }, { recording: false, uploading: true }, { request: fake.request }),
    { ok: false, action: 'off', reason: 'busy_uploading' });
  assert.equal(fake.calls.length, 0);
  const on = await runPower(CONFIGURED, { action: 'on', outlets: ['lights'] }, { recording: true, uploading: true }, { request: fake.request });
  assert.equal(on.ok, true);
});

test('allowlist: only env-switchable, mapped outlets can be switched; on/off need an explicit list', async () => {
  const fake = fakeRequest();
  const evoOnly = { ...CONFIGURED, switchable: ['evo'] };
  assert.deepEqual(await runPower(evoOnly, { action: 'on', outlets: ['lights'] }, IDLE, { request: fake.request }),
    { ok: false, action: 'on', reason: 'outlet_not_switchable', outlet: 'lights' });
  assert.deepEqual(await runPower(evoOnly, { action: 'on', outlets: ['evo'] }, IDLE, { request: fake.request }),
    { ok: false, action: 'on', reason: 'outlet_unmapped', outlet: 'evo' });
  assert.deepEqual(await runPower(CONFIGURED, { action: 'on', outlets: ['spare5'] }, IDLE, { request: fake.request }),
    { ok: false, action: 'on', reason: 'unknown_outlet', outlet: 'spare5' });
  assert.deepEqual(await runPower(CONFIGURED, { action: 'off' }, IDLE, { request: fake.request }),
    { ok: false, action: 'off', reason: 'outlets_required' });
  assert.deepEqual(await runPower(CONFIGURED, { action: 'off', outlets: [] }, IDLE, { request: fake.request }),
    { ok: false, action: 'off', reason: 'outlets_required' });
  assert.deepEqual(await runPower(CONFIGURED, { action: 'on', outlets: 'lights' }, IDLE, { request: fake.request }),
    { ok: false, action: 'on', reason: 'outlets_invalid' });
  assert.deepEqual(await runPower({ ...CONFIGURED, switchable: [] }, { action: 'on', outlets: 'all' }, IDLE, { request: fake.request }),
    { ok: false, action: 'on', reason: 'no_switchable_outlets' });
  assert.deepEqual(await runPower(CONFIGURED, { action: 'cycle', outlets: ['lights'] }, IDLE, { request: fake.request }),
    { ok: false, reason: 'unknown_action', action: 'cycle' });
  assert.equal(fake.calls.length, 0);
});

test('on/off write the zero-based transient_state with X-CSRF and digest creds, then read back', async () => {
  const fake = fakeRequest();
  const off = await runPower(CONFIGURED, { action: 'off', outlets: 'all' }, IDLE, { request: fake.request });
  assert.deepEqual(off, { ok: true, action: 'off', outlets: { lights: { outlet: 4, result: 'ok', on: false } } });
  const [write, readBack] = fake.calls;
  assert.equal(write.url, 'http://127.0.0.1:9/restapi/relay/outlets/3/transient_state/');
  assert.equal(write.method, 'PUT');
  assert.equal(write.body, 'value=false');
  assert.equal(write.headers['X-CSRF'], 'x');
  assert.equal(write.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(write.username, 'u');
  assert.equal(write.password, 'p');
  assert.equal(readBack.method, 'GET');
  assert.equal(readBack.url, 'http://127.0.0.1:9/restapi/relay/outlets/3/physical_state/');
  assert.equal(readBack.headers['X-CSRF'], undefined);

  const on = await runPower(CONFIGURED, { action: 'on', outlets: ['Lights'] }, IDLE, { request: fake.request });
  assert.deepEqual(on, { ok: true, action: 'on', outlets: { lights: { outlet: 4, result: 'ok', on: true } } });
  assert.deepEqual(fake.writes().map((c) => c.body), ['value=false', 'value=true']);
});

test('status is a GET health check that defaults to switchable outlets and can read (not write) denied ones', async () => {
  const fake = fakeRequest();
  assert.deepEqual(await runPower(CONFIGURED, { action: 'status' }, IDLE, { request: fake.request }), {
    ok: true, action: 'status', outlets: { lights: { outlet: 4, on: true, label: 'Lights' } },
  });
  const wide = await runPower({ ...CONFIGURED, switchable: ['lights', 'evo'] }, { action: 'status', outlets: ['mini', 'router', 'evo', 'nas'] }, IDLE, { request: fake.request });
  assert.deepEqual(wide.outlets, {
    mini: { outlet: 3, on: true, label: 'M' },
    router: { outlet: 1, on: true, label: 'R' },
    evo: { outlet: null, on: null, note: 'not_on_strip' },
    nas: { outlet: null, on: null, note: 'not_on_strip' },
  });
  assert.deepEqual(await runPower({ ...CONFIGURED, switchable: [] }, {}, IDLE, { request: fake.request }), { ok: true, action: 'status', outlets: {} });
  assert.deepEqual(await runPower(CONFIGURED, { outlets: ['spare5'] }, IDLE, { request: fake.request }),
    { ok: false, action: 'status', reason: 'unknown_outlet', outlet: 'spare5' });
  assert.equal(fake.calls.every((c) => c.method === 'GET'), true);
});

test('strip failures surface as reasons, not exceptions', async () => {
  const cases = [
    [{ statusCode: 401, attempted: false, body: '' }, 'auth_required'],
    [{ statusCode: 401, attempted: true, body: '' }, 'auth_failed'],
    [{ statusCode: null, timedOut: true }, 'timeout'],
    [{ statusCode: null, error: true }, 'unreachable'],
    [{ statusCode: 500, body: '' }, 'http_500'],
    [{ statusCode: 207, body: 'not json' }, 'bad_response'],
  ];
  for (const [response, reason] of cases) {
    const fake = fakeRequest(() => response);
    assert.deepEqual(await runPower(CONFIGURED, {}, IDLE, { request: fake.request }), { ok: false, action: 'status', reason });
  }
  const throwing = fakeRequest(() => { throw new Error('boom'); });
  assert.deepEqual(await runPower(CONFIGURED, { action: 'on', outlets: ['lights'] }, IDLE, { request: throwing.request }),
    { ok: false, action: 'on', outlets: { lights: { outlet: 4, result: 'error', on: null } } });
});

test('describePower reports config without secrets', () => {
  const config = readPowerConfig({
    POWER_STRIP_URL: 'http://172.16.1.40', POWER_STRIP_USER: 'secret-user-value', POWER_STRIP_PASS: 'secret-pass-value',
    POWER_OUTLETS_SWITCHABLE: 'lights,mini',
  });
  const described = describePower(config);
  assert.deepEqual(described, {
    configured: true,
    auth: 'configured',
    outlets: { router: 1, poe: 2, mini: 3, lights: 4, evo: null, nas: null },
    switchable: ['lights'],
    rejected: ['mini'],
  });
  assert.doesNotMatch(JSON.stringify(described), /secret-/);
  assert.deepEqual(describePower(readPowerConfig({})), {
    configured: false, auth: 'none', outlets: { ...OUTLET_MAP }, switchable: ['lights'], rejected: [],
  });
});

test('end to end against a fake Pro 10: digest auth, CSRF-gated PUT, outlet 4 = relay index 3', async (t) => {
  const dli = createFakeDli();
  const port = await listen(dli.server);
  t.after(() => close(dli.server));
  const config = readPowerConfig({
    POWER_STRIP_URL: `http://127.0.0.1:${port}`, POWER_STRIP_USER: dli.username, POWER_STRIP_PASS: dli.password,
  });

  const status = await runPower(config, { action: 'status' }, IDLE);
  assert.deepEqual(status, { ok: true, action: 'status', outlets: { lights: { outlet: 4, on: true, label: 'Lights' } } });

  const off = await runPower(config, { action: 'off', outlets: ['lights'] }, IDLE);
  assert.deepEqual(off, { ok: true, action: 'off', outlets: { lights: { outlet: 4, result: 'ok', on: false } } });
  assert.deepEqual(dli.strip.writes, [{ index: 3, value: false }]);
  assert.deepEqual(dli.strip.states, [true, true, true, false, false, false, false, false]);
  const authedPut = dli.strip.requests.find((r) => r.method === 'PUT' && r.authed);
  assert.equal(authedPut.csrf, 'x');
  assert.equal(authedPut.body, 'value=false');

  await runPower(config, { action: 'off', outlets: ['mini'] }, IDLE);
  assert.equal(dli.strip.writes.length, 1);

  const wrong = readPowerConfig({ POWER_STRIP_URL: `http://127.0.0.1:${port}`, POWER_STRIP_USER: dli.username, POWER_STRIP_PASS: 'wrong' });
  assert.deepEqual(await runPower(wrong, { action: 'on', outlets: ['lights'] }, IDLE),
    { ok: false, action: 'on', outlets: { lights: { outlet: 4, result: 'auth_failed', on: null } } });
  assert.deepEqual(await runPower(readPowerConfig({ POWER_STRIP_URL: `http://127.0.0.1:${port}` }), {}, IDLE),
    { ok: false, action: 'status', reason: 'auth_required' });
  assert.equal(dli.strip.writes.length, 1);
});
