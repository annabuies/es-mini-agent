'use strict';

// Mic check (Build 42, A1): each fault the check reports, and its recovery, on
// the pure verdict and on the monitor driven by a scripted OBS client.

const assert = require('node:assert/strict');
const test = require('node:test');
const { analyzeMeters, createAudioMonitor, evaluateAudio, meterFrame, readAudioSettings, signalFromFrames } = require('../audio-check');

const MICS = ['Mic 1', 'Mic 2', 'Mic 3', 'Mic 4'];

/** n meter frames; mode per mic: ok | zero | low | frozen | absent | copy:<mic>. */
function frames(n, modes = {}) {
  const out = [];
  for (let k = 0; k < n; k += 1) {
    const base = {};
    MICS.forEach((m, i) => {
      const mag = Math.pow(10, (-50 + 10 * Math.sin(k * (0.7 + i * 0.37) + i)) / 20);
      base[m] = [[mag, mag * 1.8, mag * 1.8], [mag, mag * 1.7, mag * 1.7]];
    });
    const levels = {};
    for (const m of MICS) {
      const mode = modes[m] || 'ok';
      if (mode === 'absent') continue;
      if (mode === 'zero') levels[m] = [[0, 0, 0], [0, 0, 0]];
      else if (mode === 'low') levels[m] = base[m].map((ch) => ch.map((v) => v * 1e-3));
      else if (mode === 'frozen') levels[m] = [[0.01, 0.02, 0.02], [0.01, 0.02, 0.02]];
      else if (mode.startsWith('copy:')) levels[m] = base[mode.slice(5)].map((ch) => ch.map((v) => v * 0.5));
      else levels[m] = base[m];
    }
    out.push({ at: k * 50, levels });
  }
  return out;
}

function settings(over = {}) {
  const mics = {};
  MICS.forEach((m, i) => {
    const tracks = {};
    for (let t = 1; t <= 6; t += 1) tracks[String(t)] = t === i + 1;
    mics[m] = { exists: true, muted: false, volume_mul: 1, volume_db: 0, tracks };
  });
  return Object.assign({ mics, recTracks: 15, evoPresent: true }, over);
}

function verdict(meterModes, over) {
  return evaluateAudio(analyzeMeters(frames(30, meterModes), MICS), settings(over), '2026-10-20T10:00:00.000Z', MICS);
}

test('a healthy studio is ok: every mic heard, unmuted, recorded on its own track, EVO present', () => {
  const v = verdict({});
  assert.equal(v.level, 'ok');
  assert.deepEqual(v.codes, []);
  assert.equal(v.evo_present, true);
  assert.equal(v.checked_at, '2026-10-20T10:00:00.000Z');
  for (const m of MICS) {
    assert.deepEqual(Object.keys(v.mics[m]).sort(), ['codes', 'frozen', 'muted', 'peak_db', 'recorded', 'route', 'volume_db']);
    assert.equal(v.mics[m].recorded, true);
    assert.equal(v.mics[m].frozen, false);
    assert.equal(v.mics[m].muted, false);
    assert.ok(v.mics[m].peak_db > -60 && v.mics[m].peak_db < -20, m + ' peak ' + v.mics[m].peak_db);
  }
});

// Each fault (and the healthy studio as its recovery) as the contract codes.
const FAULTS = [
  ['EVO 8 unplugged', {}, { evoPresent: false }, 'fail', ['evo_missing'], null],
  ['Mic 2 muted', {}, { mute: 'Mic 2' }, 'fail', ['mic_muted'], 'Mic 2'],
  ['Mic 2 fader at -inf', {}, { fader0: 'Mic 2' }, 'fail', ['mic_muted'], 'Mic 2'],
  ['Mic 1 digital zero', { 'Mic 1': 'zero' }, {}, 'fail', ['mic_silent'], 'Mic 1'],
  ['Mic 1 under -90 dBFS (Take 1)', { 'Mic 1': 'low' }, {}, 'warn', ['mic_silent'], 'Mic 1'],
  ['Mic 3 meter frozen', { 'Mic 3': 'frozen' }, {}, 'fail', ['mics_frozen'], 'Mic 3'],
  ['Mic 4 sends no meter updates', { 'Mic 4': 'absent' }, {}, 'fail', ['mics_frozen'], 'Mic 4'],
  ['Mic 2 carries Mic 1 (08-18 routing)', { 'Mic 2': 'copy:Mic 1' }, {}, 'fail', ['mics_identical'], 'Mic 2'],
  ['Mic 3 not on its track', {}, { trackOff: 'Mic 3' }, 'fail', ['mic_not_recorded'], 'Mic 3'],
  ['track 4 not recorded', {}, { recTracks: 7 }, 'fail', ['mic_not_recorded'], 'Mic 4'],
  ['Mic 4 input deleted', { 'Mic 4': 'absent' }, { missing: 'Mic 4' }, 'fail', ['mic_not_recorded'], 'Mic 4'],
  ['Mic 2 muted (its meter reads zero)', { 'Mic 2': 'zero' }, { mute: 'Mic 2' }, 'fail', ['mic_muted'], 'Mic 2'],
];

for (const [name, modes, overRaw, level, codes, mic] of FAULTS) {
  test('mic check fault: ' + name + ' -> ' + level + ' ' + codes.join(',') + ', then recovers to ok', () => {
    const over = Object.assign({}, overRaw);
    const s = settings();
    if (over.mute) { s.mics[over.mute].muted = true; delete over.mute; }
    if (over.fader0) { s.mics[over.fader0].volume_mul = 0; s.mics[over.fader0].volume_db = -100; delete over.fader0; }
    if (over.trackOff) { s.mics[over.trackOff].tracks[over.trackOff.slice(-1)] = false; delete over.trackOff; }
    if (over.missing) { s.mics[over.missing] = { exists: false }; delete over.missing; }
    const v = evaluateAudio(analyzeMeters(frames(30, modes), MICS), Object.assign(s, over), null, MICS);
    assert.equal(v.level, level, JSON.stringify(v));
    assert.deepEqual(v.codes, codes);
    if (mic) for (const c of codes) assert.ok(v.mics[mic].codes.includes(c), mic + ' carries ' + c);
    for (const other of MICS.filter((m) => m !== mic && !(name.includes('identical') || name.includes('carries')))) {
      assert.deepEqual(v.mics[other].codes, [], other + ' is unaffected');
    }
    // Recovery: the same studio fixed.
    assert.equal(verdict({}).level, 'ok');
  });
}

test('identical mics are flagged in pairs, and the pair is reported', () => {
  const v = verdict({ 'Mic 2': 'copy:Mic 1' });
  assert.deepEqual(v.identical_pairs, [['Mic 1', 'Mic 2']]);
  assert.deepEqual(v.mics['Mic 1'].codes, ['mics_identical']);
  assert.deepEqual(v.mics['Mic 2'].codes, ['mics_identical']);
});

test('no meter events at all is meters_unavailable (warn), not a pile of per-mic faults', () => {
  const v = evaluateAudio(analyzeMeters([], MICS), settings(), null, MICS);
  assert.equal(v.level, 'warn');
  assert.deepEqual(v.codes, ['meters_unavailable']);
  for (const m of MICS) assert.equal(v.mics[m].frozen, null);
});

test('a digital-zero mic is not also called frozen or identical to another silent one', () => {
  const v = verdict({ 'Mic 1': 'zero', 'Mic 2': 'zero' });
  assert.deepEqual(v.codes, ['mic_silent']);
  assert.equal(v.mics['Mic 1'].frozen, false);
  assert.equal(v.identical_pairs, undefined);
  assert.equal(v.mics['Mic 1'].peak_db, null);
});

test('meterFrame keeps each input\'s channel levels and drops malformed entries', () => {
  const f = meterFrame({ inputs: [{ inputName: 'Mic 1', inputLevelsMul: [[0.1, 0.2, 0.3]] }, { inputName: 5 }, { inputName: 'Mic 2', inputLevelsMul: 'x' }] }, 7);
  assert.deepEqual(f, { at: 7, levels: { 'Mic 1': [[0.1, 0.2, 0.3]] } });
});

/** A scripted OBS for the monitor: answers settings, streams meters while connected. */
function scriptedObs(state) {
  const clients = [];
  const createClient = (onEvent, subs) => {
    const client = {
      subs,
      closed: false,
      requests: [],
      async ensureConnected() {
        if (state.down) throw new Error('obs_connect_failed');
        if (!this.timer) {
          let k = 0;
          this.timer = setInterval(() => {
            k += 1;
            if (!state.metersOff) onEvent('InputVolumeMeters', { inputs: Object.entries(frames(k + 1, state.modes || {})[k].levels).map(([inputName, inputLevelsMul]) => ({ inputName, inputLevelsMul })) });
          }, 20);
        }
      },
      async request(type, data) {
        this.requests.push(type);
        const ok = (responseData) => ({ requestStatus: { result: true }, responseData });
        const n = data && data.inputName ? Number(String(data.inputName).slice(-1)) : 0;
        if (type === 'GetInputList') return ok({ inputs: MICS.map((inputName) => ({ inputName })) });
        if (type === 'GetInputMute') return ok({ inputMuted: !!(state.muted && state.muted[data.inputName]) });
        if (type === 'GetInputVolume') return ok({ inputVolumeMul: 1, inputVolumeDb: 0 });
        if (type === 'GetInputAudioTracks') { const t = {}; for (let i = 1; i <= 6; i += 1) t[String(i)] = i === n; return ok({ inputAudioTracks: t }); }
        if (type === 'GetProfileParameter') return ok({ parameterValue: data.parameterName === 'Mode' ? 'Advanced' : '15' });
        if (type === 'GetInputSettings') return ok({ inputKind: 'coreaudio_input_capture', inputSettings: {} });
        if (type === 'GetInputPropertiesListPropertyItems') return ok({ propertyItems: [{ itemName: 'EVO Ch1', itemValue: 'loopback-1' }].concat(state.evo === false ? [] : [{ itemName: 'EVO8', itemValue: 'AppleUSBAudioEngine:Audient:EVO8:1' }]) });
        return ok({});
      },
      close() { this.closed = true; clearInterval(this.timer); },
      emit: (type, data) => onEvent(type, data),
    };
    clients.push(client);
    return client;
  };
  return { createClient, clients };
}

test('monitor: an idle check uses a short-lived meters client, closes it, and caches the verdict', async () => {
  const obs = scriptedObs({});
  const logs = [];
  const mon = createAudioMonitor({ createClient: obs.createClient, windowMs: 200, log: (m) => logs.push(m), warn: (m) => logs.push('WARN ' + m) });
  const v = await mon.check('idle');
  assert.equal(v.level, 'ok');
  assert.equal(mon.latest(), v);
  assert.equal(obs.clients.length, 1);
  assert.equal(obs.clients[0].subs, 1 << 16, 'subscribes to InputVolumeMeters only');
  assert.equal(obs.clients[0].closed, true);
  assert.match(logs.join('\n'), /mic check \(idle\) ok/);
});

test('monitor: a fault is logged once as WARN, and the recovery once as ok', async () => {
  const state = { modes: { 'Mic 1': 'zero' } };
  const obs = scriptedObs(state);
  const logs = [];
  const mon = createAudioMonitor({ createClient: obs.createClient, windowMs: 150, log: (m) => logs.push(m), warn: (m) => logs.push('WARN ' + m) });
  assert.equal((await mon.check('idle')).level, 'fail');
  assert.equal((await mon.check('idle')).level, 'fail');
  state.modes = {};
  assert.equal((await mon.check('idle')).level, 'ok');
  assert.deepEqual(logs.map((l) => l.replace(/ \|.*/, '')), ['WARN mic check (idle) fail: mic_silent', 'mic check (idle) ok']);
});

test('monitor: OBS down is level unknown with the reason, never a throw', async () => {
  const obs = scriptedObs({ down: true });
  const mon = createAudioMonitor({ createClient: obs.createClient, windowMs: 100, log: () => {}, warn: () => {} });
  const v = await mon.check('idle');
  assert.equal(v.level, 'unknown');
  assert.equal(v.error, 'obs_unreachable');
});

test('monitor: a take keeps one client open; pre-start verdict, in-take alert, master start event, recovery', async () => {
  const state = { evo: false };
  const obs = scriptedObs(state);
  const mon = createAudioMonitor({ createClient: obs.createClient, windowMs: 150, takeWindowMs: 300, takeEvalMs: 200, log: () => {}, warn: () => {} });
  const take = mon.beginTake();
  assert.equal(mon.takeActive(), true);
  const pre = await take.preStart;
  assert.equal(pre.level, 'fail');
  assert.deepEqual(pre.codes, ['evo_missing']);
  const client = obs.clients[0];
  assert.equal(client.subs, (1 << 16) | (1 << 6), 'meters and outputs');
  client.emit('RecordStateChanged', { outputActive: true, outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED' });
  state.evo = true; // plugged back in mid-take
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(mon.takeAlert().level, 'ok', 'the in-take alert clears once fixed');
  const end = await mon.endTake();
  assert.equal(end.alert.level, 'ok');
  assert.ok(Number.isFinite(end.recordStartedAtMs));
  assert.match(end.recordStartedAt, /^\d{4}-\d\d-\d\dT/);
  assert.equal(client.closed, true);
  assert.equal(mon.takeActive(), false);
  assert.equal(obs.clients.length, 1, 'no extra clients during the take');
});

// Build 45 A6: mic routing. bench-1 since 10-20 said mic_not_recorded on all four
// mics while the master held four healthy mic tracks. The check now follows each
// mic's ENABLED tracks, whichever they are, into the recording's RecTracks.

/** Settings where Mic N is routed to `route(N)` (an array of track numbers). */
function routed(route, recTracks) {
  const s = settings({ recTracks });
  MICS.forEach((m, i) => {
    const on = route(i + 1);
    for (let t = 1; t <= 6; t += 1) s.mics[m].tracks[String(t)] = on.includes(t);
  });
  return s;
}

test('A6 routing: bench-1 shape (Mic N on track N+1, RecTracks 2-5) is recorded on every mic', () => {
  const v = evaluateAudio(analyzeMeters(frames(30), MICS), routed((n) => [n + 1], 0b11110), null, MICS);
  for (const m of MICS) {
    assert.equal(v.mics[m].recorded, true, m + ' recorded');
    assert.ok(!v.mics[m].codes.includes('mic_not_recorded'), m + ' has no mic_not_recorded');
  }
  assert.ok(!v.codes.includes('mic_not_recorded'));
  assert.equal(v.level, 'ok');
});

test('A6 routing: a mic only on a track the recording leaves out is still mic_not_recorded', () => {
  const v = evaluateAudio(analyzeMeters(frames(30), MICS), routed((n) => (n === 2 ? [6] : [n + 1]), 0b11110), null, MICS);
  assert.equal(v.mics['Mic 2'].recorded, false);
  assert.deepEqual(v.mics['Mic 2'].codes, ['mic_not_recorded']);
  for (const m of ['Mic 1', 'Mic 3', 'Mic 4']) assert.equal(v.mics[m].recorded, true, m);
  assert.equal(v.level, 'fail');
  assert.deepEqual(v.codes, ['mic_not_recorded']);
});

test('A6 routing: a mic on no track at all is mic_not_recorded', () => {
  const v = evaluateAudio(analyzeMeters(frames(30), MICS), routed((n) => (n === 3 ? [] : [n + 1]), 0b11110), null, MICS);
  assert.equal(v.mics['Mic 3'].recorded, false);
  assert.deepEqual(v.codes, ['mic_not_recorded']);
});

test('A6 routing: unknown RecTracks or a failed track read is recorded null, never mic_not_recorded', () => {
  const unknownRec = evaluateAudio(analyzeMeters(frames(30), MICS), routed((n) => [n + 1], null), null, MICS);
  for (const m of MICS) assert.equal(unknownRec.mics[m].recorded, null, m);
  assert.equal(unknownRec.level, 'ok');
  assert.deepEqual(unknownRec.codes, []);
  const s = routed((n) => [n + 1], 0b11110);
  delete s.mics['Mic 4'].tracks;
  const unknownTracks = evaluateAudio(analyzeMeters(frames(30), MICS), s, null, MICS);
  assert.equal(unknownTracks.mics['Mic 4'].recorded, null);
  assert.deepEqual(unknownTracks.codes, []);
});

test('A6 routing: each mic carries its route (enabled tracks and the recorded tracks, sorted)', () => {
  const v = evaluateAudio(analyzeMeters(frames(30), MICS), routed((n) => (n === 1 ? [3, 2] : [n + 1]), 0b11110), null, MICS);
  assert.deepEqual(v.mics['Mic 1'].route, { tracks: [2, 3], rec_tracks: [2, 3, 4, 5] });
  assert.deepEqual(v.mics['Mic 4'].route, { tracks: [5], rec_tracks: [2, 3, 4, 5] });
  const unknown = evaluateAudio(analyzeMeters(frames(30), MICS), routed((n) => [n + 1], null), null, MICS);
  assert.deepEqual(unknown.mics['Mic 2'].route, { tracks: [3], rec_tracks: null });
});

/** A fake OBS client answering only the settings reads, with scripted profile parameters. */
function settingsObs(profile, opts = {}) {
  return {
    async request(type, data) {
      const ok = (responseData) => ({ requestStatus: { result: true }, responseData });
      if (type === 'GetInputList') return ok({ inputs: MICS.map((inputName) => ({ inputName })) });
      if (type === 'GetInputMute') return ok({ inputMuted: false });
      if (type === 'GetInputVolume') return ok({ inputVolumeMul: 1, inputVolumeDb: 0 });
      if (type === 'GetInputAudioTracks') {
        if (opts.tracksFail) return { requestStatus: { result: false, code: 600 } };
        const n = Number(String(data.inputName).slice(-1));
        const t = {};
        for (let i = 1; i <= 6; i += 1) t[String(i)] = i === n + 1;
        return ok({ inputAudioTracks: t });
      }
      if (type === 'GetProfileParameter') {
        const p = profile[data.parameterCategory + '/' + data.parameterName];
        if (p === 'fail') return { requestStatus: { result: false, code: 600 } };
        return ok(p || { parameterValue: null, defaultParameterValue: null });
      }
      return ok({});
    },
  };
}

test('A6 RecTracks read: an empty parameterValue falls back to defaultParameterValue', async () => {
  const s = await readAudioSettings(settingsObs({
    'Output/Mode': { parameterValue: 'Advanced', defaultParameterValue: 'Simple' },
    'AdvOut/RecTracks': { parameterValue: '', defaultParameterValue: '30' },
  }), MICS, { evo: false });
  assert.equal(s.recTracks, 30);
  const v = evaluateAudio(analyzeMeters(frames(30), MICS), Object.assign(s, { evoPresent: true }), null, MICS);
  for (const m of MICS) assert.equal(v.mics[m].recorded, true, m);
});

test('A6 RecTracks read: an unset Mode uses its default (Simple -> SimpleOutput/RecTracks)', async () => {
  const s = await readAudioSettings(settingsObs({
    'Output/Mode': { parameterValue: null, defaultParameterValue: 'Simple' },
    'SimpleOutput/RecTracks': { parameterValue: '30', defaultParameterValue: '1' },
    'AdvOut/RecTracks': { parameterValue: '1', defaultParameterValue: '1' },
  }), MICS, { evo: false });
  assert.equal(s.recTracks, 30);
});

test('A6 RecTracks read: both values empty, or the read failing, is unknown (recorded null, no mic_not_recorded)', async () => {
  for (const profile of [
    { 'Output/Mode': { parameterValue: 'Advanced' }, 'AdvOut/RecTracks': { parameterValue: '', defaultParameterValue: null } },
    { 'Output/Mode': { parameterValue: 'Advanced' }, 'AdvOut/RecTracks': 'fail' },
    { 'Output/Mode': 'fail', 'AdvOut/RecTracks': { parameterValue: '30' } },
  ]) {
    const s = await readAudioSettings(settingsObs(profile), MICS, { evo: false });
    assert.equal(s.recTracks, null, JSON.stringify(profile));
    const v = evaluateAudio(analyzeMeters(frames(30), MICS), Object.assign(s, { evoPresent: true }), null, MICS);
    for (const m of MICS) assert.equal(v.mics[m].recorded, null, m);
    assert.ok(!v.codes.includes('mic_not_recorded'));
  }
  const failedTracks = await readAudioSettings(settingsObs({ 'Output/Mode': { parameterValue: 'Advanced' }, 'AdvOut/RecTracks': { parameterValue: '30' } }, { tracksFail: true }), MICS, { evo: false });
  const v = evaluateAudio(analyzeMeters(frames(30), MICS), Object.assign(failedTracks, { evoPresent: true }), null, MICS);
  for (const m of MICS) assert.equal(v.mics[m].recorded, null, m);
  assert.deepEqual(v.codes, []);
});

// Post-TF48 slice 6 / contract C2: the interface is not a mic. interface_present is reported apart
// from per-channel signal, and "active" means speech over the channel's own floor.

/** Meter frames, 50 ms apart: per mic a floor (dBFS RMS) and, when speaking, a burst pattern. */
function signalFrames(spec, n = 60) {
  const out = [];
  for (let k = 0; k < n; k += 1) {
    const levels = {};
    MICS.forEach((m, i) => {
      const s = spec[m] || { floor: -78 };
      // Speech-like level: swings 20 dB around s.speech between syllables; else the floor with a little noise.
      const db = s.speech === undefined ? s.floor + 2 * Math.sin(k * 1.3 + i) : (k % 6 < 4 ? s.speech + 6 * Math.sin(k) : s.floor);
      const mag = Math.pow(10, db / 20);
      levels[m] = [[mag, mag * 2.2, mag * 2.2], [mag, mag * 2.0, mag * 2.0]];
    });
    out.push({ at: k * 50, levels });
  }
  return out;
}

test('C2 signal: no mic speaking (interface plugged, empty XLR inputs) is 0 of 4 active, whatever the floor', () => {
  for (const floor of [-95, -78, -60]) {
    const spec = Object.fromEntries(MICS.map((m) => [m, { floor }]));
    const sig = signalFromFrames(signalFrames(spec), MICS, { source: 'mic_check', checkedAt: 'T' });
    assert.equal(sig.expected_count, 4);
    assert.equal(sig.active_count, 0, 'floor ' + floor);
    assert.equal(sig.source, 'mic_check');
    assert.equal(sig.window_ms, 59 * 50);
    assert.deepEqual(sig.channels.map((c) => [c.ch, c.label, c.active]), MICS.map((m, i) => [i + 1, m, false]));
    for (const c of sig.channels) assert.ok(Number.isFinite(c.peak_dbfs) && Number.isFinite(c.rms_dbfs));
  }
});

test('C2 signal: one, then four speakers are counted per channel; bleed under the margin is not a mic', () => {
  const speak = { speech: -28, floor: -78 };
  const one = signalFromFrames(signalFrames({ 'Mic 2': speak, 'Mic 1': { floor: -78 }, 'Mic 3': { floor: -78 }, 'Mic 4': { floor: -78 } }), MICS);
  assert.deepEqual(one.channels.map((c) => c.active), [false, true, false, false]);
  assert.equal(one.active_count, 1);
  const four = signalFromFrames(signalFrames(Object.fromEntries(MICS.map((m) => [m, speak]))), MICS);
  assert.equal(four.active_count, 4);
  // Mic 2 speaks; the other three hear it 25 dB down (still above their floor, under the speech threshold).
  const bleed = signalFromFrames(signalFrames({ 'Mic 2': speak, 'Mic 1': { speech: -55, floor: -78 }, 'Mic 3': { speech: -55, floor: -78 }, 'Mic 4': { speech: -55, floor: -78 } }), MICS);
  assert.deepEqual(bleed.channels.map((c) => c.active), [false, true, false, false]);
});

test('C2 signal: a hot noise floor needs a clear speech margin; a frozen or absent meter is never active', () => {
  const hotNoise = Object.fromEntries(MICS.map((m) => [m, { floor: -38 }]));
  assert.equal(signalFromFrames(signalFrames(hotNoise), MICS).active_count, 0, 'noise at -38 is not speech');
  const f = frames(30, { 'Mic 1': 'frozen', 'Mic 2': 'absent' });
  const frozen = signalFromFrames(f.map((x) => ({ at: x.at, levels: Object.assign({}, x.levels, { 'Mic 1': [[0.2, 0.4, 0.4]] }) })), MICS);
  assert.equal(frozen.channels[0].active, false);
  assert.deepEqual([frozen.channels[1].peak_dbfs, frozen.channels[1].active], [null, false]);
  assert.equal(signalFromFrames([], MICS).active_count, 0);
});

test('C2: the verdict carries interface_present (the EVO) apart from the signal; "ok" never implies a mic', async () => {
  const unplugged = evaluateAudio(analyzeMeters(frames(30), MICS), settings({ evoPresent: false }), 'T', MICS);
  assert.equal(unplugged.interface_present, false);
  const plugged = evaluateAudio(analyzeMeters(frames(30), MICS), settings({ evoPresent: true }), 'T', MICS);
  assert.equal(plugged.interface_present, true);
  assert.equal(plugged.level, 'ok', 'the verdict is unchanged: the app must not read ok as Mics ready');
  assert.equal(evaluateAudio(analyzeMeters(frames(30), MICS), settings({ evoPresent: null }), 'T', MICS).interface_present, null);
  // The idle check attaches its own signal (source idle), and mic_check's replaces it for a while.
  const obs = scriptedObs({});
  const mon = createAudioMonitor({ createClient: obs.createClient, windowMs: 200, micCheckMs: 300, log: () => {}, warn: () => {} });
  const idle = await mon.check('idle');
  assert.equal(idle.signal.source, 'idle');
  assert.equal(idle.signal.expected_count, 4);
  assert.equal(idle.interface_present, true);
  const out = await mon.micCheck();
  assert.equal(out.ok, true);
  assert.equal(out.interface_present, true);
  assert.equal(out.signal.source, 'mic_check');
  assert.equal(mon.latest().signal.source, 'mic_check', 'the cached verdict carries the explicit check');
  assert.equal((await mon.check('idle')).signal.source, 'mic_check', 'and an idle check a moment later does not overwrite it with an empty one');
});

test('C2 mic_check: read-only on its own client, closed after; refused while a take owns the meters; OBS down and no meters are reasons', async () => {
  const obs = scriptedObs({});
  const mon = createAudioMonitor({ createClient: obs.createClient, windowMs: 100, micCheckMs: 250, log: () => {}, warn: () => {} });
  const out = await mon.micCheck();
  assert.equal(out.ok, true);
  assert.equal(obs.clients.length, 1);
  assert.equal(obs.clients[0].subs, 1 << 16, 'meters only');
  assert.equal(obs.clients[0].closed, true);
  const writes = obs.clients[0].requests.filter((r) => !/^Get/.test(r));
  assert.deepEqual(writes, [], 'never writes to OBS (no Set*/Start*/Stop*)');
  assert.ok(!obs.clients[0].requests.some((r) => /Record|Stream|Scene/.test(r)));
  // A take open in this monitor: refused, and no client is opened for it.
  const take = mon.beginTake();
  await take.connected;
  const before = obs.clients.length;
  assert.deepEqual(await mon.micCheck(), { ok: false, reason: 'recording_active' });
  assert.equal(obs.clients.length, before);
  await mon.endTake();
  assert.equal((await createAudioMonitor({ createClient: scriptedObs({ down: true }).createClient, micCheckMs: 50, log: () => {}, warn: () => {} }).micCheck()).reason, 'obs_unreachable');
  const noMeters = await createAudioMonitor({ createClient: scriptedObs({ metersOff: true }).createClient, micCheckMs: 100, log: () => {}, warn: () => {} }).micCheck();
  assert.deepEqual([noMeters.ok, noMeters.reason], [false, 'meters_unavailable']);
});
