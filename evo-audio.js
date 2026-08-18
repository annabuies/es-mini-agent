'use strict';

// audio_evo — EVO 8 per-mic audio routing for the studio Mini, driven remotely.
//
// The 08-18 audit found two layered faults: every camera's Source Record filter
// records the shared `Mic/Aux` (USB lavalier), and the three OBS `Mic 1/2/3`
// inputs all point at the same EVO 8 device/channel pair — so even a repoint
// would capture identical audio. This op fixes both from the queue, one
// verifiable step at a time, without anyone at the studio keyboard.
//
// Two actions, chosen by the command payload:
//   (none) / { action: 'inspect' } — READ-ONLY. Returns the Mic inputs'
//     settings, their available device_id choices, the coreaudio input kind's
//     default setting keys, and each camera's Source Record filter settings.
//     This is the evidence Anna's side needs to pick the exact channel fix.
//   { action: 'apply', mics: {...}, cameras: {...} } — guarded writes.
//     mics:    { "Mic 1": { device_id: "...", ... } }  — input settings,
//              names restricted to Mic 1/2/3, flat scalar values only.
//     cameras: { "cam1": { audio_source: "Mic 1", audio_track: 1 } } — Source
//              Record filter audio keys only; source must be an active camera.
//     Everything is validated before ANY write, then written, then read back —
//     the read-back in the result is the proof the change stuck.
//
// This module never touches scenes, video settings, or Source Record output
// paths, and the caller (server.js) refuses to run it while recording.

const MIC_NAME_RE = /^Mic [1-3]$/;
const CAMERA_FILTER_KEYS = ['audio_source', 'audio_track', 'different_audio'];
const MAX_MIC_SETTING_KEYS = 8;

function ok(response) {
  const status = response && response.requestStatus;
  return !!(status && status.result);
}

function data(response) {
  return (response && response.responseData && typeof response.responseData === 'object')
    ? response.responseData
    : {};
}

function isFlatScalarObject(value, maxKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.length > maxKeys) return false;
  return keys.every((key) => {
    const t = typeof value[key];
    return t === 'string' || t === 'number' || t === 'boolean';
  });
}

async function readMicInput(client, inputName) {
  const out = { name: inputName, settings: null, devices: null };
  const settingsRes = await client.request('GetInputSettings', { inputName });
  if (ok(settingsRes)) {
    const d = data(settingsRes);
    out.kind = typeof d.inputKind === 'string' ? d.inputKind : null;
    out.settings = (d.inputSettings && typeof d.inputSettings === 'object') ? d.inputSettings : null;
  } else {
    out.error = 'input_settings_read_failed';
    return out;
  }
  const devicesRes = await client.request('GetInputPropertiesListPropertyItems', {
    inputName,
    propertyName: 'device_id',
  });
  if (ok(devicesRes)) {
    const items = data(devicesRes).propertyItems;
    out.devices = Array.isArray(items) ? items.map((item) => ({
      name: item && typeof item.itemName !== 'undefined' ? item.itemName : null,
      value: item && typeof item.itemValue !== 'undefined' ? item.itemValue : null,
      enabled: !!(item && item.itemEnabled),
    })) : null;
  }
  return out;
}

async function findSourceRecordFilter(client, sourceName) {
  const listRes = await client.request('GetSourceFilterList', { sourceName });
  if (!ok(listRes)) return { error: 'filter_list_failed' };
  const filters = data(listRes).filters;
  if (!Array.isArray(filters)) return { error: 'no_filter_list' };
  const filter = filters.find((f) => f && f.filterKind === 'source_record_filter');
  if (!filter || typeof filter.filterName !== 'string') return { error: 'no_source_record_filter' };
  return { filterName: filter.filterName, settings: filter.filterSettings || {} };
}

async function inspect(client, activeSources) {
  const out = { ok: true, action: 'inspect' };

  const inputListRes = await client.request('GetInputList');
  const inputs = data(inputListRes).inputs;
  out.inputs = Array.isArray(inputs) ? inputs.map((i) => ({
    name: i && typeof i.inputName !== 'undefined' ? i.inputName : null,
    kind: i && typeof i.inputKind !== 'undefined' ? i.inputKind : null,
  })) : null;

  const specialRes = await client.request('GetSpecialInputs');
  out.specialInputs = ok(specialRes) ? data(specialRes) : null;

  // The default settings for the coreaudio input kind reveal every settings
  // key OBS supports on this platform/version — including whatever key (if
  // any) selects channels. We ask OBS instead of assuming.
  const defaultsRes = await client.request('GetInputDefaultSettings', {
    inputKind: 'coreaudio_input_capture',
  });
  out.coreaudioDefaults = ok(defaultsRes) ? (data(defaultsRes).defaultInputSettings || null) : null;

  out.mics = {};
  const micNames = (out.inputs || [])
    .map((i) => i.name)
    .filter((name) => typeof name === 'string' && (MIC_NAME_RE.test(name) || name === 'Mic/Aux'));
  for (const name of micNames) {
    out.mics[name] = await readMicInput(client, name);
  }

  out.cameras = {};
  for (const source of activeSources) {
    const filter = await findSourceRecordFilter(client, source);
    out.cameras[source] = filter.error
      ? { error: filter.error }
      : { filter: filter.filterName, settings: filter.settings };
  }

  return out;
}

async function apply(client, activeSources, payload) {
  const micEntries = Object.entries((payload && typeof payload.mics === 'object' && payload.mics) || {});
  const cameraEntries = Object.entries((payload && typeof payload.cameras === 'object' && payload.cameras) || {});
  if (micEntries.length === 0 && cameraEntries.length === 0) {
    return { ok: false, action: 'apply', reason: 'empty_apply_payload' };
  }

  // Validate EVERYTHING before writing anything: a half-applied routing change
  // is worse than a refused one, because it looks fixed in a quick glance.
  for (const [name, settings] of micEntries) {
    if (!MIC_NAME_RE.test(name)) {
      return { ok: false, action: 'apply', reason: 'mic_name_not_allowed', name };
    }
    if (!isFlatScalarObject(settings, MAX_MIC_SETTING_KEYS)) {
      return { ok: false, action: 'apply', reason: 'mic_settings_invalid', name };
    }
  }

  const inputListRes = await client.request('GetInputList');
  const inputNames = new Set((data(inputListRes).inputs || [])
    .map((i) => i && i.inputName)
    .filter((name) => typeof name === 'string'));

  for (const [source, cfg] of cameraEntries) {
    if (!activeSources.includes(source)) {
      return { ok: false, action: 'apply', reason: 'camera_not_active', source };
    }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
      return { ok: false, action: 'apply', reason: 'camera_config_invalid', source };
    }
    const keys = Object.keys(cfg);
    if (keys.length === 0 || keys.some((key) => !CAMERA_FILTER_KEYS.includes(key))) {
      return { ok: false, action: 'apply', reason: 'camera_key_not_allowed', source, keys };
    }
    if ('audio_source' in cfg && (typeof cfg.audio_source !== 'string' || !inputNames.has(cfg.audio_source))) {
      return { ok: false, action: 'apply', reason: 'audio_source_not_an_input', source, value: cfg.audio_source };
    }
    if ('audio_track' in cfg && !(Number.isInteger(cfg.audio_track) && cfg.audio_track >= 1 && cfg.audio_track <= 8)) {
      return { ok: false, action: 'apply', reason: 'audio_track_invalid', source, value: cfg.audio_track };
    }
    if ('different_audio' in cfg && typeof cfg.different_audio !== 'boolean') {
      return { ok: false, action: 'apply', reason: 'different_audio_invalid', source };
    }
  }

  const result = { ok: true, action: 'apply', mics: {}, cameras: {} };

  for (const [name, settings] of micEntries) {
    const setRes = await client.request('SetInputSettings', {
      inputName: name,
      inputSettings: settings,
      overlay: true,
    });
    if (!ok(setRes)) {
      result.ok = false;
      result.mics[name] = { error: 'set_input_settings_rejected', wrote: settings };
      continue;
    }
    const readBack = await readMicInput(client, name);
    result.mics[name] = { wrote: settings, readBack };
  }

  for (const [source, cfg] of cameraEntries) {
    const filter = await findSourceRecordFilter(client, source);
    if (filter.error) {
      result.ok = false;
      result.cameras[source] = { error: filter.error };
      continue;
    }
    const setRes = await client.request('SetSourceFilterSettings', {
      sourceName: source,
      filterName: filter.filterName,
      filterSettings: cfg,
      overlay: true,
    });
    if (!ok(setRes)) {
      result.ok = false;
      result.cameras[source] = { error: 'set_filter_settings_rejected', wrote: cfg };
      continue;
    }
    const readRes = await client.request('GetSourceFilter', {
      sourceName: source,
      filterName: filter.filterName,
    });
    result.cameras[source] = {
      filter: filter.filterName,
      wrote: cfg,
      readBack: ok(readRes) ? (data(readRes).filterSettings || null) : null,
    };
  }

  return result;
}

async function runAudioEvo(client, activeSources, payload) {
  const action = (payload && typeof payload.action === 'string') ? payload.action : 'inspect';
  if (action === 'inspect') return await inspect(client, activeSources);
  if (action === 'apply') return await apply(client, activeSources, payload);
  return { ok: false, reason: 'unknown_action', action };
}

module.exports = { runAudioEvo };
